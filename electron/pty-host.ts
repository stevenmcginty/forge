import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { CreateSessionRequest, CreateSessionResult, PtyGeometryEvent } from '@shared/types'
import { installCommandFor, toolSpecForCommand } from '@shared/tools'
import { DESK_VIEWER, GridOwners } from './pty/grid-owner'
import { PtySessionManager } from './pty/session-manager'
import { withoutQuestions } from './pty/replay'
import { checkableExe, whichCommand } from './which'
import { getSettings } from './store'
import { applyMcpBridge } from './bridge/mcp-config'
import { applyShareBridge, shareEnvFor } from './bridge/share-mcp'
import { applyRemoteControl } from './bridge/remote-control'
import { applyClaudeSession } from './bridge/claude-session'
import { presenceFile } from './presence'
import { gitRemoteOrigin } from './git-remote'

/**
 * The PTY host: owns one PtySessionManager and bridges it to the renderer.
 *
 * Output is coalesced on a short timer (see FLUSH_MS) so a chatty build log
 * becomes ~60 IPC messages a second instead of thousands.
 *
 * ## Sinks
 *
 * The renderer window is the primary consumer, but it is no longer the only
 * one: Forge Mobile registers a second sink so a phone sees the same bytes
 * (see electron/mobile-host.ts). Sinks are notified from the same coalesced
 * flush the window gets, so a phone cannot make the desktop chattier — it
 * rides the batching that already exists rather than adding a second timer.
 *
 * A sink that throws is isolated: one bad consumer must not stop the window
 * receiving output.
 */

const FLUSH_MS = 12
/** Safety valve: if a session dumps more than this between flushes, send early. */
const FLUSH_BYTES = 64 * 1024
/** Per-session replay buffer, so a renderer reload doesn't lose the screen. */

/** Gemini's personal OAuth/Code Assist route is retired; API-key panes use the API. */
const GEMINI_CLI_MODEL = 'gemini-3.6-flash'
const REPLAY_LIMIT = 192 * 1024

let manager: PtySessionManager | null = null
let target: BrowserWindow | null = null

const pending = new Map<string, string[]>()
const replay = new Map<string, string>()
let flushTimer: NodeJS.Timeout | null = null

/**
 * What a running pane *is*, in words, for the one caller that has to describe
 * panes to a person rather than pipe bytes to them: the "are you sure" on
 * closing Forge (see electron/main.ts).
 *
 * The session manager knows every session's id, pid and command; it does not
 * know that session 3 is "forge — Claude Code" and will pick its conversation
 * back up next launch. That is decided here, at create time, so it is recorded
 * here too.
 */
export interface LiveSession {
  id: string
  projectName: string
  paneTitle: string
  /** False for a plain shell — nothing was bootstrapped into it. */
  agent: boolean
  /** True when Forge is managing this pane's Claude session id. */
  resumes: boolean
}

const live = new Map<string, LiveSession>()

/**
 * Every pane with a process behind it, right now.
 *
 * Filtered against the manager rather than trusted: `live` is bookkeeping, and
 * the sessions are the truth.
 */
export function liveSessions(): LiveSession[] {
  // `manager` rather than getManager(): asking what is running must not be the
  // thing that brings a session manager into existence, since the caller that
  // asks most often is the close handler of a Forge that opened no panes.
  if (!manager) return []
  const running = new Set(manager.list().map((s) => s.id))
  return [...live.values()].filter((s) => running.has(s.id))
}

/**
 * A second consumer of PTY output — today, the phone link.
 *
 * Deliberately narrower than the IPC channels: a sink sees data and exits and
 * nothing else, because that is all a remote consumer has any business with.
 */
export interface PtySink {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
  /**
   * A session just came into existence. Optional, because a sink that only
   * relays bytes has no use for it.
   *
   * The phone needs it: its pane list greys out any pane it cannot find in the
   * session list, and the only pushes that carried a fresh list were the
   * workspace save (which races the spawn — it is debounced by 250ms in the
   * renderer, the spawn is not) and the *exit* of a pane. So a tab opened from
   * the phone could arrive in the list already dead-looking, and stay that way
   * until something else moved. A spawn is a change to the picture exactly as
   * much as an exit is.
   */
  onSpawn?: (id: string) => void
  /**
   * A session's grid changed, whoever moved it. Optional for the same reason
   * `onSpawn` is: a sink that only relays bytes has no use for it.
   *
   * Every remote link needs it, because the width follows the typist (see
   * ./pty/grid-owner.ts) and so every viewer that is not the current owner is
   * drawing a grid it did not choose: the moment the owner moves it, everybody
   * else is drawing the wrong shape until they are told, and nothing else on
   * these links would tell them.
   */
  onResize?: (id: string, cols: number, rows: number) => void
}

const sinks = new Set<PtySink>()

/** Register a sink. Returns the unsubscribe, in the repo's usual shape. */
export function addPtySink(sink: PtySink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/**
 * The catch-up buffer for a session — what a late consumer needs to paint a
 * screen instead of a blank window onto a live shell.
 *
 * Already used for renderer reloads; exported so a phone connecting from a
 * train gets the identical answer rather than a second mechanism that can
 * disagree with this one.
 *
 * Everything that would provoke a reply is stripped on the way out — see
 * electron/pty/replay.ts. A repaint must not re-ask a live program's startup
 * questions on its behalf.
 */
export function getReplay(id: string): string {
  return withoutQuestions(replay.get(id) ?? '')
}

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

function toSinks(run: (sink: PtySink) => void): void {
  for (const sink of sinks) {
    try {
      run(sink)
    } catch (err) {
      console.error('[pty] sink failed:', err)
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
}

function flush(): void {
  flushTimer = null
  if (pending.size === 0) return
  for (const [id, chunks] of pending) {
    const data = chunks.join('')
    send(IPC.ptyData, { id, data })
    toSinks((sink) => sink.onData(id, data))
  }
  pending.clear()
}

function remember(id: string, data: string): void {
  const next = (replay.get(id) ?? '') + data
  replay.set(id, next.length > REPLAY_LIMIT ? next.slice(next.length - REPLAY_LIMIT) : next)
}

function queue(id: string, data: string): void {
  remember(id, data)
  const chunks = pending.get(id)
  if (chunks) {
    chunks.push(data)
    let size = 0
    for (const c of chunks) size += c.length
    if (size >= FLUSH_BYTES) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flush()
      return
    }
  } else {
    pending.set(id, [data])
  }
  scheduleFlush()
}

/* ------------------------------------------------ who owns which pane's grid
 *
 * The registry itself is ./pty/grid-owner.ts, which is where the policy and its
 * two rejected predecessors are written down. What lives here is the plumbing
 * around it: how a granted wish reaches ConPTY, and how the desktop renderer
 * hears that a pane it is drawing now belongs to somebody else.
 */

/**
 * Gap between the short size and the true one when a *remote* wish is granted —
 * the same repaint jiggle `resizePty` does in the renderer, and for the same
 * reason: an Ink TUI (Claude Code, Codex) only rewrites the rows it thinks
 * changed, and ConPTY's reflow leaves fragments of the old frame behind. No
 * program is obliged to honour a "please repaint" sequence, but every one of
 * them redraws for a size change.
 */
const REDRAW_JIGGLE_MS = 60

/** Pending second halves, keyed by session id. */
const jiggles = new Map<string, NodeJS.Timeout>()

function clearJiggle(id: string): void {
  const timer = jiggles.get(id)
  if (timer) {
    clearTimeout(timer)
    jiggles.delete(id)
  }
}

/**
 * Put a granted wish on the real PTY.
 *
 * The desk's own wishes arrive already jiggled — `resizePty` in
 * src/lib/terminals.ts sends the short size and the true one itself — so
 * jiggling them again here would be four resizes for one drag. A phone's and a
 * browser's arrive as one number, so this is where theirs happens. (It used to
 * live in electron/mobile-host.ts as `resizeForPhone`; a browser needs it for
 * exactly the same reason a phone does, and now that both links reach the PTY
 * through one gate there is one place for it.)
 */
function resizeForViewer(id: string, cols: number, rows: number, viewer: string): boolean {
  clearJiggle(id)
  if (viewer === DESK_VIEWER || rows < 3) return getManager().resize(id, cols, rows)
  const ok = getManager().resize(id, cols, rows - 1)
  jiggles.set(
    id,
    setTimeout(() => {
      jiggles.delete(id)
      getManager().resize(id, cols, rows)
    }, REDRAW_JIGGLE_MS)
  )
  return ok
}

/**
 * How long an ownership or geometry change waits before the renderer is told.
 *
 * The same number, for the same reason, as `GEOMETRY_PUSH_MS` in the two remote
 * hosts: the desk refits in bursts — a window drag, a split, a tab switch move
 * several panes at once — and the repaint jiggle above is itself two resizes
 * 60ms apart, of which only the second is a shape anybody should draw.
 */
const GEOMETRY_PUSH_MS = 80
const geometryDirty = new Set<string>()
let geometryTimer: NodeJS.Timeout | null = null

function flushGeometry(): void {
  geometryTimer = null
  const ids = [...geometryDirty]
  geometryDirty.clear()
  const sessions = manager?.list() ?? []
  for (const id of ids) {
    const session = sessions.find((s) => s.id === id)
    if (!session) continue
    send(IPC.ptyGeometry, {
      id,
      cols: session.cols,
      rows: session.rows,
      deskOwns: owners.deskOwns(id)
    } satisfies PtyGeometryEvent)
  }
}

function noteGeometry(id: string): void {
  geometryDirty.add(id)
  if (geometryTimer) return
  geometryTimer = setTimeout(flushGeometry, GEOMETRY_PUSH_MS)
}

const owners = new GridOwners({ apply: resizeForViewer, onOwner: noteGeometry })

/**
 * A remote viewer typed into a pane. Ownership moves to it if this was really
 * typing rather than the terminal answering a question — see shared/typing.ts,
 * which is the difference between "somebody is working on their phone" and
 * "somebody has a busy pane open in a tab".
 */
export function viewerWrite(id: string, data: string, viewer: string): boolean {
  owners.noteWrite(id, viewer, data)
  return getManager().write(id, data)
}

/** A remote viewer said what size it is reading a pane at. Granted only if it owns it. */
export function viewerResize(id: string, cols: number, rows: number, viewer: string): boolean {
  return owners.noteWish(id, viewer, cols, rows)
}

/**
 * A remote viewer stopped reading one pane, or went away entirely. Anything it
 * owned goes back to unclaimed, and the next wish — very often this desk's own
 * next fit — takes it.
 */
export function viewerGone(viewer: string, id?: string): void {
  owners.release(viewer, id)
}

export function getManager(): PtySessionManager {
  if (!manager) {
    const settings = getSettings()
    manager = new PtySessionManager({
      shell: settings.shell,
      // While this file exists — i.e. while a Forge window has focus — Claude
      // holds back the phone pushes. See electron/presence.ts.
      env: { CLAUDE_CLIENT_PRESENCE_FILE: presenceFile() },
      maxSessions: MAX_SESSIONS,
      onData: queue,
      onResize: (id, cols, rows) => {
        toSinks((sink) => sink.onResize?.(id, cols, rows))
        // And this desktop's own renderer, which is a follower like any other
        // whenever a phone or a browser is the one holding this pane's grid.
        noteGeometry(id)
      },
      onExit: (id, exitCode, signal) => {
        // Flush whatever the process said on its way out before the exit event.
        if (pending.has(id)) {
          const chunks = pending.get(id)!
          pending.delete(id)
          const data = chunks.join('')
          send(IPC.ptyData, { id, data })
          toSinks((sink) => sink.onData(id, data))
        }
        live.delete(id)
        clearJiggle(id)
        // Nothing in the registry outlives the session it describes — and a
        // reused pane id must not inherit a dead pane's owner.
        owners.forget(id)
        send(IPC.ptyExit, { id, exitCode, signal })
        toSinks((sink) => sink.onExit(id, exitCode))
      }
    })
  }
  return manager
}

export function setPtyTarget(win: BrowserWindow | null): void {
  target = win
  // A destroyed window is a viewer that has gone, exactly as a browser hanging
  // up is (electron/main.ts calls this from `closed`, which a Forge merely
  // hidden to the tray never reaches). Every pane the desk was holding goes back
  // to unclaimed, so the phone or browser still reading one takes it with its
  // next wish rather than being letterboxed by a window nobody can see.
  if (!win) owners.release(DESK_VIEWER)
}

/* ------------------------------------------------- the CLI that isn't there */

/**
 * What a pane says when the agent it was opened for is not installed.
 *
 * The alternative — and what Forge did until this existed — is to type `codex`
 * into PowerShell and let it answer:
 *
 *   codex : The term 'codex' is not recognized as the name of a cmdlet…
 *
 * which is red, six lines long, mentions a spelling check, and reads as *Forge*
 * having failed. It is also the first thing a new copy of Forge does on a
 * machine that has only ever had Claude Code installed, which makes it the
 * single most expensive six lines in the app.
 *
 * So: the command is not run at all, and the pane explains itself instead. The
 * shell underneath is untouched and still yours — including for pasting the
 * install line, which is why the install line is right there.
 */
function missingCommandNotice(exe: string, install: string | null): string {
  const dim = '\x1b[2m'
  const amber = '\x1b[33m'
  const green = '\x1b[32m'
  const off = '\x1b[0m'
  const line = (text = ''): string => `  ${text}\r\n`

  const out = [
    '\r\n',
    line(`${amber}${exe} is not installed on this machine.${off}`),
    line(`${dim}Forge did not run it — this pane is a working PowerShell, nothing has failed.${off}`),
    line()
  ]
  if (install) {
    out.push(line(`Install it:  ${green}${install}${off}`))
    out.push(line(`${dim}Then type ${exe} here, or open a new pane.${off}`))
  } else {
    out.push(line(`${dim}Forge has no install command for it — see the tool's own docs.${off}`))
  }
  out.push(line(`${dim}Settings › Updates & tools lists every CLI Forge can launch, and installs them.${off}`))
  out.push('\r\n')
  return out.join('')
}

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.ptyCreate, (_e, req: CreateSessionRequest): CreateSessionResult => {
    // The one place every pane's launch command passes through, and therefore
    // where all three bootstrap transforms live. Order matters: Remote Control
    // adds `--remote-control '<name>'`, then the session flag names the
    // conversation, then the bridge appends `--mcp-config`, whose value is
    // variadic and so has to stay last.
    const projectName = String(req?.projectName ?? '')
    const paneTitle = String(req?.paneTitle ?? '')
    const cwd = String(req?.cwd ?? '')
    const plan = applyClaudeSession(
      applyRemoteControl(req?.bootstrapCommand ?? '', {
        projectName,
        paneTitle,
        ...(req?.remoteControl === false ? { remoteControl: false as const } : {})
      }),
      {
        sessionId: typeof req?.sessionId === 'string' ? req.sessionId : undefined,
        cwd
      }
    )
    // Two transforms, in this order: `--mcp-config` is variadic and has to stay
    // last on Claude's command line, and only Codex ever matches the second one.
    const bootstrapCommand = applyShareBridge(applyMcpBridge(plan.command))
    const settings = getSettings()

    // The pane is about to type a command into a shell. If the program behind
    // it is not on this machine, typing it produces PowerShell's "not
    // recognized" — so it is not typed, and the pane says why instead.
    // `checkableExe` returns null for anything PATH cannot settle (a quoted
    // path, a pipeline), and those launch exactly as before.
    const exe = checkableExe(bootstrapCommand)
    const missingExe = exe !== null && whichCommand(exe) === null ? exe : null
    // A CLI Forge has a catalogue row for gets its install command quoted in
    // the notice; one it has never heard of gets the rest of the notice anyway.
    const tool = missingExe ? toolSpecForCommand(bootstrapCommand, getSettings().customTools) : null
    const notice = missingExe ? missingCommandNotice(missingExe, tool ? installCommandFor(tool) : null) : null

    // Gemini CLI's individual-account OAuth route now returns UNSUPPORTED_CLIENT.
    // If Forge has a Gemini API key, pass it only to Gemini panes and select the
    // current stable Flash model. Other panes never receive the key.
    const geminiEnv =
      exe?.toLowerCase() === 'gemini' && settings.geminiKey.trim()
        ? { GEMINI_API_KEY: settings.geminiKey.trim(), GEMINI_MODEL: GEMINI_CLI_MODEL }
        : undefined

    // Where this project pushes, in every pane — Claude, Antigravity, Codex, or
    // a bare PowerShell, because any of them can read an environment variable
    // and none of them should have to be told. It is how the second agent
    // learns where the first one pushed. The project's own answer wins; a pane
    // whose renderer has none (or whose project predates the field) falls back
    // to asking git in the pane's own cwd, so a remote created five minutes ago
    // still shows up. Nothing is set when there is no repo at all.
    const repoUrl = String(req?.repoUrl ?? '').trim() || gitRemoteOrigin(cwd) || ''

    /*
     * The shared scratchpad's two variables. `FORGE_SHARE_AGENT` is the pane's
     * name, and it goes to every pane rather than only the four that get the MCP
     * tools: an agent that writes `.forge/share/slot-2.md` with its own Write
     * tool can read this and sign its work, and writing the file is the path
     * every vendor has. `OPENCODE_CONFIG_CONTENT` is how OpenCode is told about
     * the share server at all — verified to merge with the user's own config
     * rather than replace it. See electron/bridge/share-mcp.ts.
     */
    const shareEnv = shareEnvFor(bootstrapCommand, paneTitle || projectName)

    const env = {
      ...(geminiEnv ?? {}),
      ...(repoUrl ? { FORGE_REPO_URL: repoUrl } : {}),
      ...shareEnv
    }

    const spec = {
      id: String(req?.id ?? ''),
      cwd,
      cols: Number(req?.cols ?? 80),
      rows: Number(req?.rows ?? 24),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      bootstrapCommand: notice ? '' : bootstrapCommand,
      ...(notice ? { bootstrapNotice: notice } : {})
    }

    // Remembered for the quit confirmation, which needs to say what is running
    // and which of it will still be there tomorrow. Recorded before create() so
    // a failed spawn's entry is cleaned up by the exit path either way.
    live.set(spec.id, {
      id: spec.id,
      projectName,
      paneTitle,
      // A pane whose agent is not installed is a plain shell, and the quit
      // confirmation must not claim an agent is running in it.
      agent: Boolean(plan.command.trim()) && !notice,
      resumes: plan.managed && !notice
    })

    // A session can already exist when the renderer reloads (dev HMR) or after
    // a renderer crash. Re-adopt it, resize it to the new geometry, and replay
    // what it printed so the pane isn't a blank window onto a live shell.
    const existed = getManager().has(spec.id)
    const result = getManager().create(spec)
    if (!result.ok) {
      console.error(`[pty] create ${spec.id} failed: ${result.error}`)
      return result
    }

    // A pane is born to whoever opened it, and every pane is opened here — the
    // renderer owns the split tree, so a tab a browser asks for is still created
    // by this desk. It changes hands the moment somebody types somewhere else.
    // Only a genuinely new one, though: re-adoption below is this renderer
    // *reconnecting* to a shell that was already running, which is arriving
    // rather than opening, and arriving must not take a grid off a phone
    // somebody has been working on.
    if (!existed) owners.created(spec.id, DESK_VIEWER)

    // Announced for both branches below: a re-adopted session is new to
    // anything that was not watching when it first started.
    toSinks((sink) => sink.onSpawn?.(spec.id))

    if (existed) {
      // A wish, like every other size this desk asks for: granted when nothing
      // remote is holding this pane, stored when something is.
      owners.noteWish(spec.id, DESK_VIEWER, spec.cols, spec.rows)
      // Through getReplay rather than the raw map: the questions in it have to
      // come out, or the reload answers them into a program that has long since
      // stopped listening and reads the answers as typing.
      const buffered = getReplay(spec.id)
      if (buffered) setImmediate(() => send(IPC.ptyData, { id: spec.id, data: buffered }))
      return { ...result, restored: true }
    }

    replay.delete(spec.id)
    return result
  })

  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => {
    // Typing at the desk takes the pane back, instantly and with no ceremony —
    // that is the whole of "sit down and it is native again". Everything xterm
    // sends that nobody pressed is filtered out by `noteWrite`; see
    // shared/typing.ts.
    owners.noteWrite(String(id), DESK_VIEWER, String(data))
    getManager().write(String(id), String(data))
  })

  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => {
    // A wish, not an instruction. The renderer fits its container and says what
    // it would like; whether the PTY moves depends on who owns the pane, which
    // is the same rule a phone's and a browser's frames go through.
    owners.noteWish(String(id), DESK_VIEWER, Number(cols), Number(rows))
  })

  ipcMain.handle(IPC.ptyKill, (_e, id: string) => {
    replay.delete(String(id))
    pending.delete(String(id))
    live.delete(String(id))
    clearJiggle(String(id))
    owners.forget(String(id))
    return getManager().kill(String(id))
  })

  ipcMain.handle(IPC.ptyList, () => getManager().list())
}

export function disposePtyHost(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (geometryTimer) {
    clearTimeout(geometryTimer)
    geometryTimer = null
  }
  geometryDirty.clear()
  for (const id of [...jiggles.keys()]) clearJiggle(id)
  owners.clear()
  pending.clear()
  replay.clear()
  live.clear()
  sinks.clear()
  manager?.killAll()
}

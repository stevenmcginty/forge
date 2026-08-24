import { ipcMain, type BrowserWindow } from 'electron'
import { resolve as resolvePath, sep } from 'node:path'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { CreateSessionRequest, CreateSessionResult, PtyGeometryEvent } from '@shared/types'
import { commandExe, isGlmClaudeCommand, ZAI_ANTHROPIC_BASE_URL } from '@shared/agents'
import { SHARE_DIR_ENV, SHARE_LINK_ENV } from '@shared/share'
import { installCommandFor, toolSpecForCommand } from '@shared/tools'
import { DESK_VIEWER, GridOwners } from './pty/grid-owner'
import { PtySessionManager } from './pty/session-manager'
import { withoutQuestions } from './pty/replay'
import { checkableExe, whichCommand } from './which'
import { getProjects, getSettings } from './store'
import { ShareLink } from './share-link'
import { ShareStore } from './share-store'
import { applyMcpBridge } from './bridge/mcp-config'
import { applyShareBridge, shareEnvFor, shareToolsEnabled } from './bridge/share-mcp'
import { applyRemoteControl } from './bridge/remote-control'
import { applyClaudeSession } from './bridge/claude-session'
import { presenceFile } from './presence'
import { gitRemoteOrigin, stripRemoteCredentials } from './git-remote'

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

/**
 * Home, erase the screen, erase the scrollback. What a replay buffer is reset
 * to when the grid it was recorded at stops existing — see `noteWidth`.
 */
const CLEAR_SCREEN = '\x1b[H\x1b[2J\x1b[3J'

let manager: PtySessionManager | null = null
let target: BrowserWindow | null = null

const pending = new Map<string, string[]>()
const replay = new Map<string, string>()
/**
 * The width each session's replay buffer was recorded at. See `noteWidth` — the
 * buffer is only meaningful at this number, so this is kept beside it.
 */
const widths = new Map<string, number>()
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
 *
 * The coalescing timer is flushed first, and that is not a detail: `remember`
 * runs the instant a chunk arrives, but the same chunk is not *sent* until the
 * next flush up to FLUSH_MS later. Anything sitting in `pending` is therefore
 * already inside the buffer this function returns and is also about to be
 * delivered as ordinary `data` — so a consumer that repaints from a replay and
 * appends what follows would draw those bytes twice. Flushing here collapses
 * that window to nothing: everything in the buffer has already been sent, and
 * nothing else is in flight behind it.
 */
export function getReplay(id: string): string {
  flush()
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

/**
 * The bytes a remote sink sees of a live chunk, which are the chunk itself
 * with one exception: the questions come out while a desk is listening.
 *
 * A live program probes its terminal — Device Attributes, colour queries,
 * DECRQM — and every emulator shown the probe answers, down the PTY, as
 * though somebody typed it. The desk's xterm was always shown the probe and
 * always answered; wiring a browser or a phone beside it meant each probe got
 * two answers, and the remote one landed in a composer as stray characters.
 * So while a desktop window is attached it is the *only* emulator the
 * questions reach — the replay copy has had the same rule since the same
 * failure was found in repaints (see electron/pty/replay.ts).
 *
 * With no window at all — tray, headless — the remote is the only listener
 * left, and it must see the questions unstripped, because a ConPTY whose
 * probes go unanswered stalls outright; web/src/lib/term.ts wires the
 * browser's answers for exactly that case.
 */
function sinkCopy(data: string): string {
  return target && !target.isDestroyed() ? withoutQuestions(data) : data
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
}

function flush(): void {
  // Cancelled rather than merely forgotten, because `flush` is no longer only
  // ever called *by* that timer: `getReplay` calls it directly, and leaving the
  // old timer armed would let it fire a beat later against a map somebody else
  // has since refilled, sending a half-batch early for no reason.
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (pending.size === 0) return
  for (const [id, chunks] of pending) {
    const data = chunks.join('')
    send(IPC.ptyData, { id, data })
    toSinks((sink) => sink.onData(id, sinkCopy(data)))
  }
  pending.clear()
}

function remember(id: string, data: string): void {
  const next = (replay.get(id) ?? '') + data
  replay.set(id, next.length > REPLAY_LIMIT ? next.slice(next.length - REPLAY_LIMIT) : next)
  // The same bytes, counted rather than kept: this is the only place in main
  // that sees every chunk a pane prints, and "has this pane been quiet" is what
  // decides whether another agent may type into it. See electron/share-link.ts.
  link?.noteOutput(id)
}

/**
 * The replay buffer belongs to one width, and this is where it finds out the
 * width has moved.
 *
 * A terminal's output is not a picture. A TUI redraws by rewinding (`ESC[nA`),
 * erasing (`ESC[J`, `ESC[2K`) and re-emitting its frame, and those instructions
 * only collapse back into a single screen when they are replayed at the number
 * of columns they were emitted at. Replay 192KB of a 150-column redraw stream
 * into a 44-column terminal and every recorded line wraps onto four rows, so
 * every rewind travels a quarter of the distance it meant to and every erase
 * clears a quarter of what it meant to: each frame lands *below* its
 * predecessor instead of on top of it. An agent redrawing once a second fills
 * this buffer with tens to hundreds of frames, and a phone attaching to a pane
 * that has been running at the desk's grid sees every one of them stacked up
 * the scrollback. That is the endlessly repeating text.
 *
 * So the buffer is single-grid by construction: the moment the *width* changes
 * it is thrown away and replaced with a clean screen, and the redraw that the
 * SIGWINCH provokes refills it a few milliseconds later at the new width.
 *
 * **Width only, never height.** Rows moving does not reflow a single recorded
 * line, so a rows-only change leaves the buffer perfectly replayable — and
 * resetting on rows would destroy the scrollback every time a phone keyboard
 * opened, which is several times a minute.
 *
 * The cost is real and worth stating: terminal scrollback recorded before a
 * width change is gone, and a pane whose contents are *static* (a plain shell's
 * prompt, the "not installed" notice) has nothing that will redraw it, so it
 * comes back as a clean screen rather than as what was on it. That is the price
 * of the buffer not being corrupt, and it is the cheaper half of the trade: the
 * conversation feed keeps its own cached transcript, so the history a person
 * actually reads back survives this untouched.
 */
function noteWidth(id: string, cols: number): void {
  const previous = widths.get(id)
  widths.set(id, cols)
  // No previous width means this session has only just been recorded — there is
  // nothing in the buffer that was written at a different one.
  if (previous === undefined || previous === cols) return
  replay.set(id, CLEAR_SCREEN)
}

/** A session's real grid, or null. `manager` rather than getManager(): asking must not create one. */
function sessionGrid(id: string): { cols: number; rows: number } | null {
  const session = manager?.list().find((s) => s.id === id)
  return session ? { cols: session.cols, rows: session.rows } : null
}

/* ------------------------------------------------- one pane, another's inbox
 *
 * The link is started here and disposed here rather than from electron/main.ts,
 * because everything it needs is in this file: the session manager it writes
 * through, the replay buffer it reads from, and the create/exit pair that tells
 * it which panes exist. main.ts already owns this module's lifecycle through
 * registerPtyHandlers/disposePtyHost, and a second lifecycle beside it would be
 * a second thing to forget.
 */

let link: ShareLink | null = null

function getLink(): ShareLink {
  if (!link) {
    link = new ShareLink({
      // Deliberately the same two calls IPC.ptyWrite makes below: a message from
      // another agent arrives at the PTY exactly as the person's own typing does,
      // grid ownership and all. A second write path would be a second answer to
      // "who owns this pane's width".
      write: (id, data) => {
        owners.noteWrite(id, DESK_VIEWER, data)
        return getManager().write(id, data)
      },
      replay: getReplay
    })
  }
  return link
}

/**
 * The project folder a pane's cwd sits in, according to main's own project list.
 *
 * Never a path from the renderer, and never a guess: the longest registered
 * project path that contains the pane's cwd, or null. A pane opened somewhere
 * Forge does not know about gets no scratchpad created for it, which is the same
 * refusal-to-litter rule bridge/share-bridge.mjs has.
 */
function projectRootFor(cwd: string): string | null {
  const here = resolvePath(cwd || '.').toLowerCase()
  let best: string | null = null
  for (const project of getProjects()) {
    const root = resolvePath(project.path)
    const key = root.toLowerCase()
    if (here !== key && !(here + sep).startsWith(key + sep)) continue
    if (!best || root.length > best.length) best = root
  }
  return best
}

/**
 * Make sure `.forge/share` exists before the agent CLI in this pane starts, and
 * say where it is.
 *
 * Until this existed the folder was created in exactly one place — the moment
 * somebody opened the rail's SHARE section — so in every project where nobody
 * ever had, all five MCP tools answered "No shared scratchpad found" and the
 * feature looked broken rather than unopened. `ensure()` is idempotent and
 * leaves a de-marked README alone, so running it per pane costs one `existsSync`.
 *
 * Gated on the same setting the tools themselves are: a machine that never asked
 * for this still gets no directory made in its repository.
 */
function shareDirFor(cwd: string): string | null {
  if (!shareToolsEnabled()) return null
  const root = projectRootFor(cwd)
  if (!root) return null
  const store = new ShareStore(root)
  const ensured = store.ensure()
  if (!ensured.ok) {
    console.error(`[share] could not open the scratchpad for ${root}: ${ensured.error}`)
    return null
  }
  return store.root
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
 *
 * ## When the jiggle is actually earned
 *
 * A repaint is not free. On the alternate screen it overwrites and costs
 * nothing anybody sees; on the normal buffer — Claude Code's — every repaint
 * lands *below* its predecessor, in the scrollback and in the replay buffer,
 * which is the duplicated text on the phone. So the jiggle has to be spent only
 * where the thing it was written for can actually happen, and that thing is
 * narrower than "a resize":
 *
 *  - **Columns moved.** ConPTY re-wraps every line in its buffer, and an Ink TUI
 *    only rewrites the rows it believes changed, so fragments of the pre-reflow
 *    frame are left on screen with nothing to clear them. This is the case the
 *    jiggle exists for, and it still gets one.
 *  - **Only rows moved.** Nothing re-wraps — a row change moves the viewport,
 *    it does not reflow a single line — so there are no fragments to clear, and
 *    the row change is itself a SIGWINCH the TUI redraws for. One repaint, and
 *    it is a clean one. This is also the common case by a wide margin: a phone
 *    keyboard opening and closing is a rows-only change several times a minute,
 *    and it used to cost two full repaints each way.
 *
 * The jiggle's own second half is the proof of that split: it moves rows and
 * never columns, precisely so that it provokes a redraw without provoking
 * another reflow. If a rows-only change could not be trusted to repaint, the
 * jiggle would not work either.
 *
 * A wish for the grid the pane already has is not a resize at all and returns
 * before any of this — see the guard below.
 */
function resizeForViewer(id: string, cols: number, rows: number, viewer: string): boolean {
  clearJiggle(id)
  // Nothing to do, and it has to be said *here*.
  //
  // The equality guard downstream in PtySessionManager only sees the size it is
  // handed, and the jiggle below never hands it the size it asked for: the first
  // half is deliberately `rows - 1`, which is never a no-op against a PTY that
  // is already at `rows`. So a viewer re-attaching with the size it was already
  // reading at — every idle reconnect on a flaky phone link — used to shrink the
  // real ConPTY by a row and grow it back 60ms later. That is two SIGWINCHes and
  // two full agent repaints for a wish that asked for nothing, and on a link
  // that reconnects every few seconds it is the pump that fills the replay
  // buffer with duplicate frames.
  //
  // An attaching viewer still gets a painted screen, and never got one from
  // here: the replay buffer is what paints it, sent unconditionally and *before*
  // the attach's wish is applied (see the `attach` case in electron/web/server.ts
  // and `replay` in electron/mobile-host.ts). Forcing a repaint to fill a screen
  // that is already being filled is how the screen ends up filled twice.
  const grid = sessionGrid(id)
  if (grid && grid.cols === cols && grid.rows === rows) return true
  // Three panes with no row to spare between them: the desk jiggles its own
  // wishes in the renderer, a two-row terminal has no row to borrow, and a
  // session this process cannot find is one there is nothing to compare against
  // — and nothing to schedule a second half for either, since the resize below
  // is about to fail.
  if (viewer === DESK_VIEWER || rows < 3 || !grid) return getManager().resize(id, cols, rows)
  // Rows moved and columns did not: nothing reflowed, so there is no debris for
  // a second repaint to clear, and the SIGWINCH this one resize sends is already
  // the redraw event. Half the repaints, for the change that happens most.
  if (grid.cols === cols) return getManager().resize(id, cols, rows)
  const ok = getManager().resize(id, cols, rows - 1)
  jiggles.set(
    id,
    setTimeout(() => {
      jiggles.delete(id)
      // The buffer is thrown away a second time, and only on this path.
      //
      // `noteWidth` already blanked it 60ms ago when the width moved, so what is
      // in it now is at most one jiggle's worth of output — and on a pane that
      // redraws, that output *is* the first half's frame, which the resize on
      // the next line is about to draw again. Keeping it would mean a viewer
      // attaching a moment later replays both copies, stacked, which on the
      // normal buffer is exactly the bug this whole path is being narrowed for.
      // The price is anything else the pane happened to print inside those 60ms;
      // that is a real loss and a small one, and it is bounded by the reset that
      // has already happened rather than eating any scrollback that survived it.
      replay.set(id, CLEAR_SCREEN)
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

/** A remote viewer asked for a pane's grid outright. See GridOwners.claim. */
export function viewerClaim(id: string, viewer: string): boolean {
  return owners.claim(id, viewer)
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

/**
 * Kill one pane and forget everything this host was holding for it.
 *
 * Lifted out of the `IPC.ptyKill` handler when the layout stopped being the
 * renderer's alone: a phone that closes a pane now has its op performed in main
 * (electron/layout-engine.ts), so the PTY behind the leaf that just vanished
 * has to be reaped from main too — and by the *same* code the renderer's kill
 * takes, or a pane closed from away would leave a replay buffer, an ownership
 * row and a share-link registration behind that a pane closed at the desk does
 * not.
 *
 * Idempotent, which the two callers rely on: the renderer follows the new
 * layout and disposes its own handles, so this is very often called twice for
 * one pane. `PtySessionManager.kill` answers false for an id it does not have,
 * and every map below is a delete.
 */
export function killPane(id: string): boolean {
  replay.delete(id)
  widths.delete(id)
  pending.delete(id)
  live.delete(id)
  clearJiggle(id)
  owners.forget(id)
  link?.unregister(id)
  return getManager().kill(id)
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
        // First, and before anybody is told: the replay buffer stops being
        // replayable the instant the width moves, and a sink that reacts to this
        // by asking for one must get the clean screen rather than a screenful of
        // stacked frames. This is the right hook because it is the *only* place
        // in Forge that hears about a grid actually taking — it fires from
        // `applyResize` after ConPTY has accepted it and after the record has
        // been updated, so it is never called for a resize that was clamped away
        // or that asked for the size the pane already had.
        noteWidth(id, cols)
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
          toSinks((sink) => sink.onData(id, sinkCopy(data)))
        }
        live.delete(id)
        widths.delete(id)
        clearJiggle(id)
        // Nothing in the registry outlives the session it describes — and a
        // reused pane id must not inherit a dead pane's owner.
        owners.forget(id)
        link?.unregister(id)
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

/**
 * Same shape as missingCommandNotice: the shell is fine, Claude is not run,
 * and the next step is sitting in Settings. Only shown when the GLM 5.3
 * selector would otherwise launch a claude that has nowhere to send tokens.
 */
function missingZaiKeyNotice(): string {
  const dim = '\x1b[2m'
  const amber = '\x1b[33m'
  const off = '\x1b[0m'
  const line = (text = ''): string => `  ${text}\r\n`
  return [
    '\r\n',
    line(`${amber}GLM 5.3 needs a Z.AI Coding Plan key.${off}`),
    line(`${dim}Forge did not run Claude Code — this pane is a working PowerShell, nothing has failed.${off}`),
    line(),
    line('Sign up at  https://z.ai/subscribe'),
    line('Copy a key from  https://z.ai/manage-apikey/apikey-list'),
    line('Paste it in  Settings › Models & APIs › Z.AI'),
    line(`${dim}Then open a new GLM 5.3 pane.${off}`),
    '\r\n'
  ].join('')
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

    // GLM 5.3 is Claude Code on Z.ai's Coding Plan gateway. Injected after
    // ENV_DENYLIST (buildEnv applies extra last), and only for this command —
    // a regular Claude pane never sees the token or the base URL, so it keeps
    // the claude.ai login. ~/.claude/settings.json is not touched.
    const glm = isGlmClaudeCommand(bootstrapCommand)
    const zaiKey = settings.zaiKey.trim()
    const glmEnv =
      glm && zaiKey
        ? {
            ANTHROPIC_AUTH_TOKEN: zaiKey,
            ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            API_TIMEOUT_MS: '3000000'
          }
        : undefined
    const glmNotice = glm && !zaiKey && !notice ? missingZaiKeyNotice() : null

    // Where this project pushes, in every pane — Claude, Antigravity, Codex, or
    // a bare PowerShell, because any of them can read an environment variable
    // and none of them should have to be told. It is how the second agent
    // learns where the first one pushed. The project's own answer wins; a pane
    // whose renderer has none (or whose project predates the field) falls back
    // to asking git in the pane's own cwd, so a remote created five minutes ago
    // still shows up. Nothing is set when there is no repo at all.
    // Stripped even when the renderer supplied it: a URL typed into project
    // settings before this rule existed can still be carrying a PAT, and the
    // pane environment is the one copy every agent in the project can read.
    const repoUrl = stripRemoteCredentials(String(req?.repoUrl ?? '').trim()) || gitRemoteOrigin(cwd) || ''

    /*
     * The shared scratchpad's two variables. `FORGE_SHARE_AGENT` is the pane's
     * name, and it goes to every pane rather than only the ones that get the MCP
     * tools: an agent that writes `.forge/share/slot-2.md` with its own Write
     * tool can read this and sign its work, and writing the file is the path
     * every vendor has. `OPENCODE_CONFIG_CONTENT` is how OpenCode is told about
     * the share server at all — verified to merge with the user's own config
     * rather than replace it. See electron/bridge/share-mcp.ts.
     */
    const shareEnv = shareEnvFor(bootstrapCommand, paneTitle || projectName)

    /*
     * And the link's two. `FORGE_SHARE_LINK` is the path of the pipe main is
     * listening on, which is what turns `pane_send`/`pane_read` from an error
     * message into a feature; it goes to every pane for the same reason
     * `FORGE_SHARE_AGENT` does — the pane's environment is what the MCP server
     * the CLI spawns inherits, and Forge does not know in advance which panes
     * will end up with an agent in them. `FORGE_SHARE_DIR` saves the server a
     * walk up from its own cwd, and is set only when the scratchpad is actually
     * open for this project. See electron/share-link.ts.
     */
    const linkPath = getLink().listen()
    const shareDir = shareDirFor(cwd)

    const env = {
      ...(geminiEnv ?? {}),
      ...(glmEnv ?? {}),
      ...(repoUrl ? { FORGE_REPO_URL: repoUrl } : {}),
      ...shareEnv,
      ...(linkPath ? { [SHARE_LINK_ENV]: linkPath } : {}),
      ...(shareDir ? { [SHARE_DIR_ENV]: shareDir } : {})
    }

    const blocked = notice ?? glmNotice
    const spec = {
      id: String(req?.id ?? ''),
      cwd,
      cols: Number(req?.cols ?? 80),
      rows: Number(req?.rows ?? 24),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      bootstrapCommand: blocked ? '' : bootstrapCommand,
      ...(blocked ? { bootstrapNotice: blocked } : {})
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

    // Addressable by another agent from this moment. Registered after the spawn
    // succeeded, so a pane that failed to start is never a pane somebody can be
    // told to talk to. Re-registering a re-adopted session is deliberate and
    // harmless: it refreshes the title without resetting the quiet clock.
    getLink().register({
      id: spec.id,
      title: paneTitle || projectName,
      agent: commandExe(bootstrapCommand),
      cwd,
      projectName
    })

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

    // The width the buffer below is being recorded at, from the manager rather
    // than from the request: `create` clamps, and a seed that disagreed with the
    // real grid would make the very next resize look like a width change and
    // throw away a screen nothing had moved. A re-adopted session keeps whatever
    // it was already running at.
    const spawned = sessionGrid(spec.id)
    if (spawned) widths.set(spec.id, spawned.cols)

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
    // The person is at this pane. That counts as the pane being busy, so an
    // agent elsewhere cannot type into the middle of somebody's sentence.
    link?.noteWrite(String(id))
    getManager().write(String(id), String(data))
  })

  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => {
    // A wish, not an instruction. The renderer fits its container and says what
    // it would like; whether the PTY moves depends on who owns the pane, which
    // is the same rule a phone's and a browser's frames go through.
    owners.noteWish(String(id), DESK_VIEWER, Number(cols), Number(rows))
  })

  ipcMain.on(IPC.ptyRename, (_e, id: string, title: string) => {
    // Keeps the share link's registry current so share_panes/pane_send/pane_read
    // resolve a pane by the title it has now, not the one it launched with.
    link?.rename(String(id), String(title))
  })

  ipcMain.handle(IPC.ptyKill, (_e, id: string) => killPane(String(id)))

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
  link?.close()
  link = null
  owners.clear()
  pending.clear()
  replay.clear()
  widths.clear()
  live.clear()
  sinks.clear()
  manager?.killAll()
}

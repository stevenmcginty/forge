import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { CreateSessionRequest, CreateSessionResult } from '@shared/types'
import { PtySessionManager } from './pty/session-manager'
import { getSettings } from './store'
import { applyMcpBridge } from './bridge/mcp-config'
import { applyRemoteControl } from './bridge/remote-control'
import { applyClaudeSession } from './bridge/claude-session'
import { presenceFile } from './presence'

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
 */
export function getReplay(id: string): string {
  return replay.get(id) ?? ''
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
        send(IPC.ptyExit, { id, exitCode, signal })
        toSinks((sink) => sink.onExit(id, exitCode))
      }
    })
  }
  return manager
}

export function setPtyTarget(win: BrowserWindow | null): void {
  target = win
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
    const plan = applyClaudeSession(applyRemoteControl(req?.bootstrapCommand ?? '', { projectName, paneTitle }), {
      sessionId: typeof req?.sessionId === 'string' ? req.sessionId : undefined,
      cwd
    })
    const bootstrapCommand = applyMcpBridge(plan.command)

    const spec = {
      id: String(req?.id ?? ''),
      cwd,
      cols: Number(req?.cols ?? 80),
      rows: Number(req?.rows ?? 24),
      bootstrapCommand
    }

    // Remembered for the quit confirmation, which needs to say what is running
    // and which of it will still be there tomorrow. Recorded before create() so
    // a failed spawn's entry is cleaned up by the exit path either way.
    live.set(spec.id, {
      id: spec.id,
      projectName,
      paneTitle,
      agent: Boolean(plan.command.trim()),
      resumes: plan.managed
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

    if (existed) {
      getManager().resize(spec.id, spec.cols, spec.rows)
      const buffered = replay.get(spec.id)
      if (buffered) setImmediate(() => send(IPC.ptyData, { id: spec.id, data: buffered }))
      return { ...result, restored: true }
    }

    replay.delete(spec.id)
    return result
  })

  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => {
    getManager().write(String(id), String(data))
  })

  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => {
    getManager().resize(String(id), Number(cols), Number(rows))
  })

  ipcMain.handle(IPC.ptyKill, (_e, id: string) => {
    replay.delete(String(id))
    pending.delete(String(id))
    live.delete(String(id))
    return getManager().kill(String(id))
  })

  ipcMain.handle(IPC.ptyList, () => getManager().list())
}

export function disposePtyHost(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.clear()
  replay.clear()
  live.clear()
  sinks.clear()
  manager?.killAll()
}

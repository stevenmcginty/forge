import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { CreateSessionRequest, CreateSessionResult } from '@shared/types'
import { PtySessionManager } from './pty/session-manager'
import { getSettings } from './store'
import { applyMcpBridge } from './bridge/mcp-config'
import { applyRemoteControl } from './bridge/remote-control'
import { presenceFile } from './presence'

/**
 * The PTY host: owns one PtySessionManager and bridges it to the renderer.
 *
 * Output is coalesced on a short timer (see FLUSH_MS) so a chatty build log
 * becomes ~60 IPC messages a second instead of thousands.
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

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
}

function flush(): void {
  flushTimer = null
  if (pending.size === 0) return
  for (const [id, chunks] of pending) {
    send(IPC.ptyData, { id, data: chunks.join('') })
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
          send(IPC.ptyData, { id, data: chunks.join('') })
        }
        send(IPC.ptyExit, { id, exitCode, signal })
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
    // where both bootstrap transforms live. Order matters: Remote Control adds
    // `--remote-control '<name>'`, then the bridge appends `--mcp-config`,
    // whose value is variadic and so has to stay last.
    const bootstrapCommand = applyMcpBridge(
      applyRemoteControl(req?.bootstrapCommand ?? '', {
        projectName: String(req?.projectName ?? ''),
        paneTitle: String(req?.paneTitle ?? '')
      })
    )

    const spec = {
      id: String(req?.id ?? ''),
      cwd: String(req?.cwd ?? ''),
      cols: Number(req?.cols ?? 80),
      rows: Number(req?.rows ?? 24),
      bootstrapCommand
    }

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
  manager?.killAll()
}

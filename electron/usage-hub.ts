import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { WebUsageFrame } from '@shared/web'
import { addPtySink } from './pty-host'
import { defaultStatusDir, startAgentUsage, type AgentUsage } from './web/agent-usage'
import { defaultCodexSessionsDir, startCodexUsage, type CodexPane, type CodexUsage } from './web/codex-usage'

/**
 * Each agent pane's usage — model, effort, context, session cost and the
 * account's plan-limit windows — for the desktop window and Forge Web alike.
 *
 * The two readers (electron/web/agent-usage.ts for Claude's status files,
 * electron/web/codex-usage.ts for Codex's rollouts) used to run only while the
 * Forge Web link was up, feeding the phone. The desktop agent bar wants the
 * same numbers with the link off, so they run here, once: the first renderer
 * that asks for a snapshot starts them, and so does the link. One copy of each
 * watcher, however many listeners — the phone's server and the window both
 * listen through `onUsageFrame` / IPC.
 *
 * Which pane owns which session is web-host's to say (`paneSessions`,
 * `codexPanes`) — both read the layout and the PTY manager, not the link — so
 * web-host hands them over in `registerUsageHandlers`.
 *
 * The window is told on a short settle, not per frame: a Claude redraw moves
 * the cost and the context together, and a pane that opens rescans both readers.
 */

export interface UsageSources {
  /** Live panes by the Claude session each owns: Claude session id → pane id. */
  claudePanes: () => Map<string, string>
  /** The live Codex panes. */
  codexPanes: () => CodexPane[]
}

/** Coalesce what one redraw or one spawn produces before the window is told. */
const WINDOW_SETTLE_MS = 200

let sources: UsageSources | null = null
let claude: AgentUsage | null = null
let codex: CodexUsage | null = null
let unsubscribePty: (() => void) | null = null
/** The latest frame per pane, for a snapshot and for a link that starts late. */
const latest = new Map<string, WebUsageFrame>()
const listeners = new Set<(frame: WebUsageFrame) => void>()
/** Frames waiting for the window's settle. */
const pending = new Map<string, WebUsageFrame>()
let flushTimer: NodeJS.Timeout | null = null

/** Once, at startup. Nothing is watched until someone asks. */
export function registerUsageHandlers(from: UsageSources): void {
  sources = from
  ipcMain.handle(IPC.usageSnapshot, (): WebUsageFrame[] => {
    ensureUsageHub()
    return usageFrames()
  })
}

/** Start the readers if they are not running. Safe to call any number of times. */
export function ensureUsageHub(): void {
  if (!sources || (claude && codex)) return
  const { claudePanes, codexPanes } = sources
  // Before the readers, so a pane that spawns during their first scan is
  // rescanned rather than missed.
  unsubscribePty ??= addPtySink({
    onData: () => {},
    onExit: (id) => {
      latest.delete(id)
      pending.delete(id)
    },
    // A resumed session's status file is already on disk; its numbers need not
    // wait for the next redraw or the poll.
    onSpawn: (id) => rescanUsage(id)
  })
  claude ??= startAgentUsage({ dir: defaultStatusDir(), panes: claudePanes, onUsage: publish })
  codex ??= startCodexUsage({ dir: defaultCodexSessionsDir(), panes: codexPanes, onUsage: publish })
}

/** The latest frame for every pane that has one. */
export function usageFrames(): WebUsageFrame[] {
  return [...latest.values()]
}

/** Every frame from now on. Returns the unsubscribe. */
export function onUsageFrame(listener: (frame: WebUsageFrame) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Look again now — naming a pane forgets what it was last told. */
export function rescanUsage(paneId?: string): void {
  claude?.rescan(paneId)
  codex?.rescan(paneId)
}

export function disposeUsageHub(): void {
  unsubscribePty?.()
  unsubscribePty = null
  claude?.stop()
  claude = null
  codex?.stop()
  codex = null
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  pending.clear()
  listeners.clear()
}

function publish(frame: WebUsageFrame): void {
  latest.set(frame.sessionId, frame)
  for (const listener of listeners) {
    try {
      listener(frame)
    } catch (err) {
      console.error('[usage] a listener failed:', err)
    }
  }
  pending.set(frame.sessionId, frame)
  flushTimer ??= setTimeout(flush, WINDOW_SETTLE_MS)
}

function flush(): void {
  flushTimer = null
  const frames = [...pending.values()]
  pending.clear()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const frame of frames) win.webContents.send(IPC.usageFrame, frame)
  }
}

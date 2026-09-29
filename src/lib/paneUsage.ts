import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { WebUsageFrame } from '@shared/web'
import type { UsageWindow } from '@shared/usage-windows'
import { richFromText, transcriptFromLines } from './feed'
import { terminalHost } from './terminals'

export { windowLabel } from '@shared/usage-windows'
export type { UsageWindow } from '@shared/usage-windows'

/**
 * One agent pane's live usage, for the desktop agent bar: the model and effort
 * the CLI says it is running, how full its context is, what the session has
 * cost, and the account's plan-limit windows by their true length.
 *
 * The numbers come from main (electron/usage-hub.ts), which reads what Claude
 * Code hands its statusLine command and what Codex writes to its rollouts —
 * the same frames Forge Web's phone gets, with or without the link.
 *
 * **The API may be missing.** A renderer can be newer than the preload it runs
 * under (a dev reload after a pull, before Forge restarts), and calling a
 * `window.forge` function that is not there throws and unmounts the whole
 * renderer — which Steve's phone runs its layout through. So every use is
 * feature-checked, and a missing API is simply `null`: no numbers yet.
 *
 * One IPC listener for the whole renderer, however many components read it,
 * and one snapshot, on first use.
 */

export interface PaneUsage {
  source: 'claude-statusline' | 'codex-session'
  /** As the CLI reports it, e.g. "Opus 5.5 (1M context)" or "gpt-6-luna". */
  model?: string
  /** e.g. "high", when the CLI reports it. */
  effort?: string
  /**
   * The permission mode the pane's own footer shows — `bypass`, `plan`,
   * `accept-edits`, `auto` or `default` (src/lib/rich.ts `PermissionMode`).
   * Absent when the footer names none, as Claude's does in its default mode.
   */
  mode?: string
  context?: { usedPct: number; usedTokens?: number; windowTokens?: number }
  /** This session's spend so far (Claude). */
  costUsd?: number
  /** Account plan limits, shortest window first; [] when none (API-key login). */
  windows: UsageWindow[]
  /** Epoch ms when these numbers were true. */
  at: number
}

type UsageApi = NonNullable<Window['forge']['usage']>

/** The preload's usage API, or null when this preload predates it. */
function usageApi(): UsageApi | null {
  try {
    const usage = typeof window === 'undefined' ? undefined : window.forge?.usage
    return usage && typeof usage.onFrame === 'function' && typeof usage.snapshot === 'function' ? usage : null
  } catch {
    return null
  }
}

const frames = new Map<string, WebUsageFrame>()
const modes = new Map<string, string | undefined>()
const listeners = new Set<() => void>()
let started = false

function emit(): void {
  for (const listener of listeners) listener()
}

function take(frame: WebUsageFrame): void {
  if (!frame || typeof frame.sessionId !== 'string' || !frame.sessionId) return
  const held = frames.get(frame.sessionId)
  if (held && held.at > frame.at) return
  frames.set(frame.sessionId, frame)
  // A redraw is also when a mode change shows; only a pane somebody reads is looked at.
  if (modeWatches.has(frame.sessionId)) refreshMode(frame.sessionId, false)
  emit()
}

/** The one subscription and the one snapshot, on first use. */
function start(): void {
  if (started) return
  const api = usageApi()
  if (!api) return
  started = true
  try {
    api.onFrame(take)
    void api
      .snapshot()
      .then((list) => {
        if (Array.isArray(list)) for (const frame of list) take(frame)
      })
      .catch(() => {
        /* the main side is older, or busy: frames arrive as they change */
      })
  } catch {
    /* a half-wired preload: no numbers, never a crash */
  }
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/* ------------------------------------------------------------- the mode */

/**
 * The permission mode off the pane's own footer, by the phone's reader
 * (src/lib/feed.ts). Only a mode printed in the footer counts: the reader
 * falls back to the scrollback, where "plan mode" can be something somebody
 * said an hour ago.
 */
function readMode(paneId: string): string | undefined {
  try {
    const text = terminalHost.snapshotText(paneId, 30)
    if (!text) return undefined
    const { status } = transcriptFromLines(richFromText(text))
    if (status.mode === 'unknown' || !status.modeLabel) return undefined
    const label = status.modeLabel.toLowerCase()
    return status.footer.some((line) => line.toLowerCase().includes(label)) ? status.mode : undefined
  } catch {
    return undefined
  }
}

function refreshMode(paneId: string, notify = true): void {
  const mode = readMode(paneId)
  if (modes.has(paneId) && modes.get(paneId) === mode) return
  modes.set(paneId, mode)
  if (notify) emit()
}

/** Let xterm finish parsing what just arrived before the footer is read. */
const MODE_SETTLE_MS = 300

/** Panes whose footer is being followed, with how many hooks want it. */
const modeWatches = new Map<string, { count: number; stop: () => void }>()

function watchMode(paneId: string): () => void {
  let watch = modeWatches.get(paneId)
  if (!watch) {
    let timer: number | null = null
    let unsubscribe: () => void = () => {}
    try {
      unsubscribe = terminalHost.subscribeActivity(paneId, () => {
        if (timer !== null) return
        timer = window.setTimeout(() => {
          timer = null
          if (frames.has(paneId)) refreshMode(paneId)
        }, MODE_SETTLE_MS)
      })
    } catch {
      /* no terminal for this pane: no mode */
    }
    watch = {
      count: 0,
      stop: () => {
        if (timer !== null) window.clearTimeout(timer)
        unsubscribe()
      }
    }
    modeWatches.set(paneId, watch)
  }
  watch.count++
  const held = watch
  return () => {
    held.count--
    if (held.count > 0) return
    held.stop()
    modeWatches.delete(paneId)
  }
}

/* ------------------------------------------------------------- the shape */

/** One stable object per (frame, mode), so the hook does not re-render on nothing. */
const shaped = new Map<string, { frame: WebUsageFrame; mode: string | undefined; usage: PaneUsage }>()

function usageFor(paneId: string | null): PaneUsage | null {
  if (!paneId) return null
  const frame = frames.get(paneId)
  if (!frame) return null
  const mode = modes.get(paneId)
  const held = shaped.get(paneId)
  if (held && held.frame === frame && held.mode === mode) return held.usage
  const usage: PaneUsage = {
    source: frame.source,
    ...(frame.model ? { model: frame.model } : {}),
    ...(frame.effort ? { effort: frame.effort } : {}),
    ...(mode ? { mode } : {}),
    ...(frame.context ? { context: frame.context } : {}),
    ...(typeof frame.costUsd === 'number' ? { costUsd: frame.costUsd } : {}),
    windows: Array.isArray(frame.windows) ? frame.windows : [],
    at: frame.at
  }
  shaped.set(paneId, { frame, mode, usage })
  return usage
}

/**
 * The pane's live usage, or null when the preload has no usage API or no frame
 * has arrived for this pane yet.
 */
export function usePaneUsage(paneId: string | null): PaneUsage | null {
  const read = useCallback(() => usageFor(paneId), [paneId])
  const usage = useSyncExternalStore(subscribe, read, read)
  const hasFrame = usage !== null
  useEffect(() => {
    if (!paneId || !hasFrame) return
    refreshMode(paneId)
    return watchMode(paneId)
  }, [paneId, hasFrame])
  return usage
}

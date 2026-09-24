import { useSyncExternalStore } from 'react'
import type { PaneStatus } from '@/lib/rich'

/**
 * The latest `PaneStatus` each pane has read off its own screen, published by
 * PaneView and read by the status strip that sits under the feed. The cards
 * vs terminal face travels the same way, so the composer can hide TUI keys
 * on a phone without the pane and the box sharing a tree.
 *
 * A module-level store rather than context, because the strip lives outside
 * the pane tree (one strip for the focused pane, under the whole grid) and the
 * pane that knows the status is several split levels away from it. Nothing
 * here survives a reload and nothing needs to: the next capture republishes.
 */

/**
 * The three faces a pane can wear: the session's own conversation, the cards
 * read off its screen, or the raw terminal. Only the last of them has TUI keys
 * worth showing a thumb.
 */
export type PaneFace = 'chat' | 'feed' | 'term'

const statuses = new Map<string, PaneStatus>()
const views = new Map<string, PaneFace>()
const replies = new Map<string, string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function publishPaneStatus(paneId: string, status: PaneStatus | undefined): void {
  const previous = statuses.get(paneId)
  if (previous === status) return
  if (status === undefined) statuses.delete(paneId)
  else statuses.set(paneId, status)
  trackDone(paneId, previous?.busy ?? false, status)
  emit()
}

/*
 * "Done": a long stretch of work that has just ended, held for a few seconds
 * before the pane settles back to Ready — the desktop's rule and its numbers
 * (src/lib/paneActivity.ts), run here on the busy flag each pane reads off its
 * own screen. Module-level for the same reason the statuses are: the Wall
 * tile, the Agents menu and the voice line must agree on the same pane.
 */

/** How long "Done" stays up before the pane settles back to Ready. */
const DONE_HOLD_MS = 6000
/** A stretch shorter than this finishing is not news. */
const DONE_MIN_WORK_MS = 8000

const busySince = new Map<string, number>()
const doneUntil = new Map<string, number>()
const doneTimers = new Map<string, number>()

function trackDone(paneId: string, wasBusy: boolean, status: PaneStatus | undefined): void {
  const busy = status?.busy ?? false
  const at = Date.now()
  if (busy && !wasBusy) {
    busySince.set(paneId, at)
    doneUntil.delete(paneId)
  }
  if (!busy && wasBusy) {
    const since = busySince.get(paneId)
    busySince.delete(paneId)
    if (status !== undefined && since !== undefined && at - since >= DONE_MIN_WORK_MS) {
      doneUntil.set(paneId, at + DONE_HOLD_MS)
      // "Done" ends by itself; nothing else would redraw the chips when it does.
      const old = doneTimers.get(paneId)
      if (old !== undefined) window.clearTimeout(old)
      doneTimers.set(
        paneId,
        window.setTimeout(() => {
          doneTimers.delete(paneId)
          doneUntil.delete(paneId)
          emit()
        }, DONE_HOLD_MS + 30)
      )
    }
  }
  if (status === undefined) {
    busySince.delete(paneId)
    doneUntil.delete(paneId)
  }
}

/** Which face — the composer reads this to hide TUI keys on a phone. */
export function publishPaneView(paneId: string, view: PaneFace | undefined): void {
  const previous = views.get(paneId)
  if (previous === view) return
  if (view === undefined) views.delete(paneId)
  else views.set(paneId, view)
  emit()
}

/**
 * The latest reply's words, as markdown (lib/speak.ts `replyText`), for the
 * strip's "Read aloud" button. Raw rather than cleaned for speech: the tap
 * does that, so a reply still streaming costs nothing per frame.
 */
export function publishPaneReply(paneId: string, text: string | undefined): void {
  const previous = replies.get(paneId)
  if (previous === text) return
  if (text === undefined) replies.delete(paneId)
  else replies.set(paneId, text)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The focused pane's status, or undefined while none has been read yet. */
export function usePaneStatus(paneId: string | null): PaneStatus | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? statuses.get(paneId) : undefined),
    () => undefined
  )
}

/** Whether this pane has just finished a long stretch of work ("Done"). */
export function usePaneDone(paneId: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? (doneUntil.get(paneId) ?? 0) > Date.now() : false),
    () => false
  )
}

/** The focused pane's face. */
export function usePaneView(paneId: string | null): PaneFace | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? views.get(paneId) : undefined),
    () => undefined
  )
}

/** The focused pane's latest reply, or undefined while it has none. */
export function usePaneReply(paneId: string | null): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? replies.get(paneId) : undefined),
    () => undefined
  )
}

const viewSetters = new Map<string, (view: PaneFace) => void>()

export function registerPaneViewSetter(paneId: string, setter: (view: PaneFace) => void): () => void {
  viewSetters.set(paneId, setter)
  return () => {
    if (viewSetters.get(paneId) === setter) viewSetters.delete(paneId)
  }
}

export function requestPaneView(paneId: string, view: PaneFace): void {
  const setter = viewSetters.get(paneId)
  if (setter) setter(view)
}

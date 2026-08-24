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
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function publishPaneStatus(paneId: string, status: PaneStatus | undefined): void {
  const previous = statuses.get(paneId)
  if (previous === status) return
  if (status === undefined) statuses.delete(paneId)
  else statuses.set(paneId, status)
  emit()
}

/** Which face — the composer reads this to hide TUI keys on a phone. */
export function publishPaneView(paneId: string, view: PaneFace | undefined): void {
  const previous = views.get(paneId)
  if (previous === view) return
  if (view === undefined) views.delete(paneId)
  else views.set(paneId, view)
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

/** The focused pane's face. */
export function usePaneView(paneId: string | null): PaneFace | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? views.get(paneId) : undefined),
    () => undefined
  )
}

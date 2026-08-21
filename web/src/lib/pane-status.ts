import { useSyncExternalStore } from 'react'
import type { PaneStatus } from './rich'

/**
 * The latest `PaneStatus` each pane has read off its own screen, published by
 * PaneView and read by the status strip that sits under the feed.
 *
 * A module-level store rather than context, because the strip lives outside
 * the pane tree (one strip for the focused pane, under the whole grid) and the
 * pane that knows the status is several split levels away from it. Nothing
 * here survives a reload and nothing needs to: the next capture republishes.
 */

const statuses = new Map<string, PaneStatus>()
const listeners = new Set<() => void>()

export function publishPaneStatus(paneId: string, status: PaneStatus | undefined): void {
  const previous = statuses.get(paneId)
  if (previous === status) return
  if (status === undefined) statuses.delete(paneId)
  else statuses.set(paneId, status)
  for (const listener of listeners) listener()
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

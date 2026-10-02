import { useSyncExternalStore } from 'react'

/**
 * The PowerDraw's pane slot: the place in the side drawer where the open
 * pane's controls (the view switch, the keys, its state and its model) are
 * drawn on the phone. The drawer owns the element and registers it while it
 * is open; the session composer portals its controls into it, so they keep
 * the composer's wiring and the bottom of the screen keeps only the box and
 * the two voice discs.
 */

interface Slot {
  el: HTMLElement
  close: () => void
}

let slot: Slot | null = null
const subs = new Set<() => void>()

export function setDrawerSlot(next: Slot | null): void {
  if (slot?.el === next?.el && slot?.close === next?.close) return
  slot = next
  for (const fn of subs) fn()
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** The drawer's pane slot while the drawer is out, or null. */
export function useDrawerSlot(): Slot | null {
  return useSyncExternalStore(
    subscribe,
    () => slot,
    () => null
  )
}

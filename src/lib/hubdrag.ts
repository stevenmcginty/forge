import type { Point } from './voicehub'

/**
 * The hub's position *while your finger is down*.
 *
 * Two components take part in one gesture: the status-bar pill starts the
 * drag-out, and the floating hub — which does not exist yet at that moment —
 * has to finish it. Routing that through React state would mean a re-render of
 * the whole app on every pointermove, and routing it through the store would
 * mean a settings write per frame.
 *
 * So the live position lives here, outside React, and the hub applies it
 * straight to its own transform. Only the final resting place is ever
 * dispatched. `null` means nothing is being dragged, which is also the signal
 * for the hub to go back to reading its position from the store.
 */

type Listener = (pos: Point | null) => void

const listeners = new Set<Listener>()
let current: Point | null = null

export const hubDrag = {
  /** The live position, or null when nothing is being dragged. */
  get(): Point | null {
    return current
  },
  set(pos: Point | null): void {
    current = pos
    for (const fn of [...listeners]) fn(pos)
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }
}

import { useEffect, useRef } from 'react'

/**
 * Android Back, for the layers the phone opens over itself.
 *
 * Every open layer — a bottom sheet, the project sheet, a page inside it —
 * calls `useBackClose(open, onClose)`. While it is open the browser history
 * holds one extra entry for it, at the same URL, so the system Back gesture
 * lands here as a `popstate` instead of leaving the app. That `popstate`
 * closes the newest layer and nothing else. With nothing open there are no
 * extra entries, and Back does exactly what it did before this file existed.
 *
 * A layer closed by the page itself (a scrim tap, a row, Esc) takes its entry
 * back out with `history.go(-n)`, and the `popstate` that answers is swallowed
 * rather than closing a second layer.
 *
 * **History is reconciled, not mirrored step by step.** Opens and closes only
 * mark the stack; one pass a tick later moves the history to match, pushing or
 * going back by the difference. That is what makes "close this sheet and open
 * that one" in one tap safe: a `history.back()` and a `pushState()` issued in
 * the same tick race each other (the traversal is asynchronous and lands on
 * whichever entry is current when it runs), whereas one reconcile sees a net
 * change of zero and touches nothing.
 *
 * **A Back that does not close.** A layer's `onClose` may step back inside it
 * instead (a confirm step returning to its list). Its entry was spent by the
 * Back, so it is marked spent; if the layer is still registered a moment later
 * it is re-armed and gets a fresh entry, and the next Back reaches it again.
 */

interface Layer {
  close: () => void
  /** Its history entry was used up by a Back; it is waiting to be unregistered or re-armed. */
  spent: boolean
}

const MARK = 'forgeLayer'

const layers: Layer[] = []
/** History entries this module has pushed and not yet seen popped. */
let owned = 0
/** A `history.go(-n)` of our own is in flight; its `popstate` is not a Back. */
let popping = false
let scheduled = 0
let rearmTimer = 0
let listening = false

function wanted(): number {
  let n = 0
  for (const layer of layers) if (!layer.spent) n += 1
  return n
}

function reconcile(): void {
  scheduled = 0
  if (popping) return
  const want = wanted()
  if (want > owned) {
    for (let i = owned; i < want; i += 1) history.pushState({ [MARK]: i + 1 }, '', location.href)
    owned = want
  } else if (want < owned) {
    const n = owned - want
    owned = want
    popping = true
    history.go(-n)
  }
}

function schedule(): void {
  if (scheduled) return
  scheduled = window.setTimeout(reconcile, 0)
}

function onPop(): void {
  if (popping) {
    popping = false
    schedule()
    return
  }
  // A Back the person pressed. With no entry of ours left, it was never ours.
  if (owned === 0) return
  owned -= 1
  const top = [...layers].reverse().find((layer) => !layer.spent)
  if (!top) return
  top.spent = true
  top.close()
  // Whatever did not actually close by now stepped back inside itself instead;
  // it gets a fresh entry so the next Back reaches it.
  window.clearTimeout(rearmTimer)
  rearmTimer = window.setTimeout(() => {
    for (const layer of layers) layer.spent = false
    schedule()
  }, 150)
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('popstate', onPop)
}

/**
 * While `open`, Back calls `onClose` (and only for the newest open layer).
 * Closing it any other way removes its history entry without a second close.
 */
export function useBackClose(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    listen()
    const layer: Layer = { close: () => closeRef.current(), spent: false }
    layers.push(layer)
    schedule()
    return () => {
      const at = layers.indexOf(layer)
      if (at >= 0) layers.splice(at, 1)
      schedule()
    }
  }, [open])
}

/** How many layers are open right now (for tests and the harness). */
export function openLayerCount(): number {
  return layers.length
}

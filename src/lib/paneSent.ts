/**
 * "It went there": a one-shot flash round a pane's edge the moment words are
 * sent into it — by the bar, by a dictation's Enter, or by the agent.
 *
 * terminalHost.submit calls `announcePaneSent` after its Enter, so every sender
 * is covered at the one place they all meet. This does nothing but put a data
 * attribute on the pane's element (the full-size pane and its Wall tile, when
 * shown) and take it off again when the CSS animation ends; DictationCue.css
 * draws the ring. No React, no state, no loop: between sends nothing runs.
 *
 *   data-sent       'agent' (the agent's lime) or 'dictation' (the violet)
 *   data-sent-beat  flips 0/1 each send, so a second send mid-flash restarts
 *                   the animation cleanly without forcing a layout
 */

export type SentBy = 'agent' | 'dictation'

/**
 * Who is sending now: set by the dictation cue host, which knows whether the
 * agent has the mic. Null holds the flash back — a dictation still listening
 * (Enter after each phrase) keeps the bar's edge as the one cue on screen.
 */
let senderNow: () => SentBy | null = () => 'dictation'

export function setPaneSentSender(fn: () => SentBy | null): () => void {
  senderNow = fn
  return () => {
    if (senderNow === fn) senderNow = () => 'dictation'
  }
}

/** Long enough for the animation; the attribute never outlives a missed animationend. */
const SAFETY_MS = 2700
const running = new WeakMap<HTMLElement, { timer: number; onEnd: (e: AnimationEvent) => void }>()

function clear(el: HTMLElement): void {
  const run = running.get(el)
  if (run) {
    window.clearTimeout(run.timer)
    el.removeEventListener('animationend', run.onEnd)
    running.delete(el)
  }
  delete el.dataset['sent']
  delete el.dataset['sentBeat']
}

function flash(el: HTMLElement, by: SentBy): void {
  const beat = el.dataset['sentBeat'] === '0' ? '1' : '0'
  clear(el)
  el.dataset['sentBeat'] = beat
  el.dataset['sent'] = by
  // The ring's own end (not a child's animation bubbling up) takes it off.
  const onEnd = (e: AnimationEvent): void => {
    if (e.target === el && e.pseudoElement === '::before' && e.animationName.startsWith('pane-sent')) clear(el)
  }
  el.addEventListener('animationend', onEnd)
  running.set(el, { timer: window.setTimeout(() => clear(el), SAFETY_MS), onEnd })
}

/** Words were just sent into this pane: flash its edge. Never throws, never blocks. */
export function announcePaneSent(paneId: string): void {
  if (typeof document === 'undefined') return
  try {
    const id = CSS.escape(paneId)
    const els = document.querySelectorAll<HTMLElement>(`.pane[data-pane-id="${id}"], .mtile[data-pane-id="${id}"]`)
    if (els.length === 0) return
    const by = senderNow()
    if (!by) return
    els.forEach((el) => flash(el, by))
  } catch {
    /* a flash is decoration: never let it break a send */
  }
}

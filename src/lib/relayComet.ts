import { fireComet } from './motion'

/**
 * The relay comet: a message just went into an agent pane, so a comet flies to
 * it — from the pane that sent it when another agent did, from the bar when you
 * (or the main agent on your behalf) did.
 *
 * Every path that puts words into a pane on someone's behalf calls this: the
 * bar aimed at a pane, the main agent typing into one (text or voice), a brief
 * landing in a newly opened agent pane, a handoff, and `pane_send` from one pane
 * to another. It used to fire only from the bar's own send, so once the bar
 * started asking the main agent by default (1322260) the relay itself had none.
 *
 * A pane is on screen as one of three things: its deck `.pane` (Full screen),
 * its Wall `.mtile`, or its `.wstrip__tile` in the live strip. Only one that is
 * actually laid out counts — a pane in a tab you are not looking at has no box,
 * and a comet flown at (0, 0) says nothing. No box anywhere: no comet.
 */

const PANE_SELECTORS = ['.pane', '.mtile', '.wstrip__tile']

function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
}

/** The element that stands for a pane on screen right now, or null. */
export function paneElement(paneId: string): HTMLElement | null {
  if (typeof document === 'undefined' || !paneId) return null
  const id = CSS.escape(paneId)
  const all = document.querySelectorAll<HTMLElement>(PANE_SELECTORS.map((s) => `${s}[data-pane-id="${id}"]`).join(', '))
  for (const el of all) if (onScreen(el)) return el
  return null
}

/** The bar: where a message you typed or said starts from. */
function barElement(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.dock__composer')) if (onScreen(el)) return el
  return null
}

/** The pane's own colour, from its deck `.pane` (the only one that carries it). */
function paneColor(paneId: string): string {
  const pane = document.querySelector<HTMLElement>(`.pane[data-pane-id="${CSS.escape(paneId)}"]`)
  const accent = pane ? getComputedStyle(pane).getPropertyValue('--pane-accent').trim() : ''
  return accent || 'var(--accent)'
}

/**
 * Fly a comet into `toPaneId`. `from` is the sending pane's id, or an element
 * (the bar that sent it); absent or not on screen, it starts at the bar.
 * Deferred a frame so a pane that was just revealed has its box.
 */
export function relayComet(toPaneId: string, from?: string | Element | null): void {
  if (typeof window === 'undefined') return
  requestAnimationFrame(() => {
    try {
      const to = paneElement(toPaneId)
      if (!to) return
      const source =
        (typeof from === 'string' && from !== toPaneId ? paneElement(from) : null) ??
        (from instanceof Element && from.isConnected ? from : null) ??
        barElement() ??
        to
      fireComet(source, to, paneColor(toPaneId))
    } catch {
      /* decoration only: a relay never fails over its comet */
    }
  })
}

/**
 * The phone's motion rules as code, for the few places JavaScript drives a
 * movement (a drag, a timed exit). The CSS side is the `--p-dur-*` / `--p-ease*`
 * tokens (phone-tokens.css) and the `.pu-in-*` / `.pu-out-*` classes
 * (phone-ui.css); the numbers here match them. See web/PHONE-DESIGN.md, "Motion".
 */

/** Milliseconds, matching the CSS tokens of the same name. */
export const DUR = {
  instant: 80,
  fast: 120,
  base: 180,
  exit: 200,
  snap: 220,
  sheet: 280,
  glide: 330
} as const

/** A drag down (or sideways, for a banner) past this many pixels dismisses. */
export const DISMISS_PX = 96
/** …or a flick faster than this, in pixels per millisecond. */
export const FLICK_PX_PER_MS = 0.55

/** True when the person or the page asked for less motion. */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  if (document.documentElement.dataset.reducedMotion === 'true') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** How long to wait before unmounting something that is playing a `.pu-out-*` exit. */
export function exitDelay(): number {
  return reducedMotion() ? 0 : DUR.exit
}

/**
 * Whether a drag that ended at `distance` px (in the dismiss direction) after
 * `elapsedMs` should dismiss. Short of it, the surface settles back on
 * `--p-ease-sheet`.
 */
export function shouldDismiss(distance: number, elapsedMs: number): boolean {
  if (distance <= 0) return false
  return distance >= DISMISS_PX || distance / Math.max(1, elapsedMs) >= FLICK_PX_PER_MS
}

/**
 * Drag past the edge it cannot go (up, for a bottom sheet): the surface
 * follows at a fraction, harder the further it goes, and never jumps.
 */
export function rubberband(overshoot: number, limit = 48): number {
  if (overshoot <= 0) return 0
  return limit * (1 - 1 / (overshoot / limit + 1))
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The shell's motion, in one place.
 *
 * No animation library: everything here is the Web Animations API driving
 * transform and opacity only, so every move runs on the compositor and none of
 * it touches layout. The two springs are damped harmonic oscillators sampled
 * into CSS `linear()` easings (the same curves as --spring-pop / --spring-glide
 * in tokens.css), which is how a spring gets into WAAPI without a physics loop
 * on the main thread.
 *
 * Every helper checks reduced motion first and does nothing — not a shorter
 * animation, nothing — when it is on, whether Windows asked for it or
 * Appearance forced it.
 */

/** k 420 / c 30: pops into place with a 3% overshoot, settles in ~370ms. */
export const SPRING_POP =
  'linear(0, 0.0321, 0.1119, 0.2191, 0.3381, 0.4581, 0.5714, 0.6734, 0.7617, 0.8354, 0.8949, 0.9412, 0.976, 1.0008, 1.0174, 1.0276, 1.0327, 1.0342, 1.0332, 1.0305, 1.0268, 1.0228, 1.0187, 1.0148, 1.0113, 1.0082, 1.0057, 1.0036, 1)'
export const SPRING_POP_MS = 370

/** k 520 / c 44: critically damped, glides without overshoot in ~330ms. */
export const SPRING_GLIDE =
  'linear(0, 0.056, 0.1775, 0.3183, 0.4545, 0.5748, 0.6753, 0.7564, 0.8198, 0.8685, 0.9051, 0.9323, 0.9522, 0.9666, 0.9769, 0.9841, 0.9892, 0.9928, 0.9952, 0.9969, 1)'
export const SPRING_GLIDE_MS = 330

export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true
  if (document.documentElement.dataset['reducedMotion'] === 'true') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/* ------------------------------------------------------------------ pop in */

/**
 * A new thing arriving: up from a hair below, a touch small, and transparent,
 * to exactly where layout already put it. The element is in its final place the
 * whole time — only its picture moves — so nothing else on the page reflows.
 */
export function popIn(el: HTMLElement, opts: { delay?: number; from?: number; lift?: number } = {}): void {
  if (reducedMotion()) return
  const scale = opts.from ?? 0.955
  const lift = opts.lift ?? 10
  el.animate(
    [
      { opacity: 0, transform: `translate3d(0, ${lift}px, 0) scale(${scale})` },
      { opacity: 1, transform: 'none' }
    ],
    { duration: SPRING_POP_MS, easing: SPRING_POP, delay: opts.delay ?? 0, fill: 'backwards' }
  )
}

/**
 * Pop a pane in the first time its id is ever mounted this session — and never
 * again, so switching tabs or views (which remounts every pane) does not replay
 * it. Panes that arrive in the same frame (a whole workspace at launch) are
 * staggered 45ms apart, which reads as the deck powering up rather than as a
 * jump cut.
 */
const entered = new Set<string>()
let burst = 0
let burstFrame = 0

export function enterOnce(id: string, el: HTMLElement): void {
  if (entered.has(id)) return
  entered.add(id)
  if (burstFrame === 0) {
    burstFrame = requestAnimationFrame(() => {
      burst = 0
      burstFrame = 0
    })
  }
  popIn(el, { delay: Math.min(8, burst++) * 45 })
}

/** Tab switches and mode changes: a short crossfade with a whisper of scale. */
export function fadeIn(el: HTMLElement, opts: { duration?: number; from?: number } = {}): void {
  if (reducedMotion()) return
  el.animate(
    [
      { opacity: 0, transform: `scale(${opts.from ?? 0.992})` },
      { opacity: 1, transform: 'none' }
    ],
    { duration: opts.duration ?? 220, easing: SPRING_GLIDE }
  )
}

/* -------------------------------------------------------------------- FLIP */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * First-Last-Invert-Play: the element has already been laid out at its new box;
 * paint it at the old one and let it glide home. Interruptible by construction —
 * starting a new glide cancels whatever the element was doing, and because the
 * inversion is measured from where it *is*, a glide cut off halfway continues
 * from halfway rather than jumping.
 */
export function glideFrom(el: HTMLElement, from: Box, opts: { duration?: number; easing?: string } = {}): void {
  if (reducedMotion()) return
  // Stop any glide still in flight first: the new box has to be measured
  // without its transform, and `from` was already taken where it visibly was.
  for (const a of el.getAnimations()) if (!('animationName' in a)) a.cancel()
  const to = boxOf(el)
  if (to.width < 1 || to.height < 1 || from.width < 1 || from.height < 1) return
  const dx = from.left - to.left
  const dy = from.top - to.top
  const sx = from.width / to.width
  const sy = from.height / to.height
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return
  el.animate(
    [
      { transformOrigin: 'top left', transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
      { transformOrigin: 'top left', transform: 'none' }
    ],
    { duration: opts.duration ?? SPRING_GLIDE_MS, easing: opts.easing ?? SPRING_GLIDE }
  )
}

/**
 * Remember where every `[data-flip]` (or `[data-flip-stage]`) child of `root`
 * was on the last commit, and
 * glide each one that moved or resized to its new box on this one. Keyed by the
 * attribute's value, so a pane that survives a re-layout — a sibling closed, a
 * split added — slides and stretches into its new space instead of snapping.
 * Anything new is left alone: it gets its own entrance.
 */
export function useFlipChildren(
  rootRef: React.RefObject<HTMLElement | null>,
  key: unknown,
  attr: 'flip' | 'flipStage' = 'flip'
): void {
  const last = useRef<Map<string, Box>>(new Map())
  const lastKey = useRef<unknown>(key)
  const selector = attr === 'flip' ? '[data-flip]' : '[data-flip-stage]'
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const next = new Map<string, Box>()
    const changed = lastKey.current !== key
    lastKey.current = key
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const id = el.dataset[attr]
      if (!id) continue
      const prev = last.current.get(id)
      if (changed && prev) glideFrom(el, prev)
      next.set(id, boxOf(el))
    }
    last.current = next
  })
}

/* ---------------------------------------------------------------- presence */

/**
 * Keep something mounted long enough to animate out.
 *
 * `closing` is true for `exitMs` after `open` goes false — long enough for a
 * CSS exit animation keyed off it — then the thing unmounts. Reopening during
 * the exit simply cancels it.
 */
export function usePresence(open: boolean, exitMs = 170): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return undefined
    }
    if (!mounted) return undefined
    const t = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : exitMs)
    return () => window.clearTimeout(t)
  }, [open, mounted, exitMs])
  return { mounted: open || mounted, closing: !open && mounted }
}

/* ------------------------------------------------------------------- comet */

/**
 * A dispatch comet: a glowing streak with a bright head that flies from the
 * composer to the pane an instruction just went to, in that pane's colour, and
 * lights the pane's edge as it lands.
 *
 * One absolutely-positioned element per flight, moved along a gentle arc by a
 * handful of transform keyframes and removed when it lands. Nothing in the page
 * is touched but the target's `data-hit` attribute. `onLand` runs as it lands
 * (at once when there is no flight to watch).
 */
export function fireComet(from: Element, to: Element, color: string, onLand?: () => void): void {
  const hit = (): void => {
    onLand?.()
    const target = to as HTMLElement
    target.dataset['hit'] = 'true'
    window.setTimeout(() => {
      if (target.dataset['hit'] === 'true') delete target.dataset['hit']
    }, 900)
  }
  if (reducedMotion()) {
    hit()
    return
  }
  const a = from.getBoundingClientRect()
  const b = to.getBoundingClientRect()
  const x0 = a.left + a.width / 2
  const y0 = a.top
  // Land on the target's header, where its name is.
  const x1 = b.left + b.width / 2
  const y1 = b.top + 16
  const dist = Math.hypot(x1 - x0, y1 - y0)
  if (dist < 24) {
    hit()
    return
  }
  // A quadratic arc bowed sideways by a fifth of the distance.
  const mx = (x0 + x1) / 2 + (y1 - y0) * 0.2
  const my = (y0 + y1) / 2 - (x1 - x0) * 0.2
  const point = (t: number): { x: number; y: number } => ({
    x: (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1,
    y: (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1
  })
  const tangent = (t: number): number => {
    const dx = 2 * (1 - t) * (mx - x0) + 2 * t * (x1 - mx)
    const dy = 2 * (1 - t) * (my - y0) + 2 * t * (y1 - my)
    return (Math.atan2(dy, dx) * 180) / Math.PI
  }

  const el = document.createElement('div')
  el.className = 'comet'
  el.style.setProperty('--comet', color)
  document.body.appendChild(el)

  const steps = 7
  const frames: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const p = point(t)
    const stretch = 0.55 + Math.sin(Math.PI * t) * 0.9
    frames.push({
      offset: t,
      opacity: t === 0 ? 0 : t > 0.92 ? 0 : 1,
      transform: `translate3d(${p.x}px, ${p.y}px, 0) rotate(${tangent(t)}deg) scaleX(${stretch})`
    })
  }
  const duration = Math.min(520, 300 + dist * 0.18)
  const run = el.animate(frames, { duration, easing: 'cubic-bezier(0.45, 0.05, 0.25, 1)' })
  run.onfinish = () => {
    el.remove()
    hit()
  }
  run.oncancel = () => el.remove()
}

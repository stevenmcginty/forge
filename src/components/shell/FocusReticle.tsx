import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import './FocusReticle.css'

/**
 * Focus, gliding. When the keyboard moves from one pane to another, four
 * corner marks fly from the old pane to the new one and frame it for a moment
 * before fading — the eye follows the move instead of hunting for which edge
 * just lit up.
 *
 * Four absolutely-positioned corners, each moved by transform alone, so the
 * glide never touches layout. Positions are read from offsets rather than
 * bounding rects: offsets ignore transforms, so a pane that is itself mid-glide
 * (a split just closed) is framed where it is going, not where it was.
 */
const CORNER = 14
const OUTSET = 5
const LINGER_MS = 900

export function FocusReticle({
  rootRef,
  selector,
  targetKey,
  enabled
}: {
  rootRef: RefObject<HTMLElement | null>
  /** Finds the focused element inside the root. */
  selector: string
  /** Changes whenever focus moves — the pane id. */
  targetKey: string | null
  /** Off with a single pane: there is nowhere for focus to go. */
  enabled: boolean
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const last = useRef<string | null>(null)
  const timer = useRef<number | null>(null)

  const place = (): boolean => {
    const root = rootRef.current
    const box = ref.current
    if (!root || !box) return false
    const target = root.querySelector<HTMLElement>(selector)
    if (!target || !enabled) {
      box.dataset['live'] = 'false'
      return false
    }
    let x = 0
    let y = 0
    let el: HTMLElement | null = target
    while (el && el !== root) {
      x += el.offsetLeft
      y += el.offsetTop
      el = el.offsetParent as HTMLElement | null
    }
    const w = target.offsetWidth
    const h = target.offsetHeight
    const set = (name: string, px: number, py: number): void => {
      const c = box.querySelector<HTMLElement>(`[data-c='${name}']`)
      if (c) c.style.transform = `translate3d(${px}px, ${py}px, 0)`
    }
    set('tl', x - OUTSET, y - OUTSET)
    set('tr', x + w + OUTSET - CORNER, y - OUTSET)
    set('bl', x - OUTSET, y + h + OUTSET - CORNER)
    set('br', x + w + OUTSET - CORNER, y + h + OUTSET - CORNER)
    return true
  }

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const first = last.current === null
    const moved = targetKey !== last.current
    last.current = targetKey
    if (!moved) return
    // The first placement is a jump, not a glide: nothing was framed before.
    box.dataset['glide'] = first ? 'false' : 'true'
    if (!place() || first) return
    box.dataset['live'] = 'true'
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (ref.current) ref.current.dataset['live'] = 'false'
    }, LINGER_MS)
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const ro = new ResizeObserver(() => {
      const box = ref.current
      if (!box) return
      box.dataset['glide'] = 'false'
      place()
    })
    ro.observe(root)
    return () => {
      ro.disconnect()
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
    // place reads refs only; the observer is set up once per root.
  }, [rootRef])

  return (
    <div ref={ref} className="reticle" data-live="false" aria-hidden="true">
      <span data-c="tl" />
      <span data-c="tr" />
      <span data-c="bl" />
      <span data-c="br" />
    </div>
  )
}

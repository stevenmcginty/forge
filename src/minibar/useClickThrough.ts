import { useEffect } from 'react'

/** Every surface of the mini bar: the bar, the tucked pill, a stage panel, a toast. */
export const MINIBAR_SOLID = '.mb-bar, .mb-pill, .mb-sheet, .mb-toast'
/** The shot card and the stack's ghosts under it. */
export const SHOTCARD_SOLID = '.shotpop__card, .shotpop__ghost'

/**
 * Clicks on a view window's see-through room fall through to the app below.
 *
 * The window is bigger than what it shows (room for the shadows, the stage,
 * the tallest shot card), and a transparent window still takes every click in
 * its bounds. So the pointer is hit-tested here: over `solid` the window takes
 * clicks, anywhere else main sets it to ignore them, with the moves still
 * forwarded so this hears the pointer come back. Only changes are sent.
 *
 * Never while a button is held: a text selection or an end drag that strays
 * off the bar must finish on it, not in the app below.
 */
export function useClickThrough(solid: string, set: ((on: boolean) => void) | undefined): void {
  useEffect(() => {
    if (typeof set !== 'function') return undefined
    let last: boolean | null = null
    const tell = (on: boolean): void => {
      if (on === last) return
      last = on
      set(on)
    }
    const move = (e: PointerEvent): void => {
      if (e.buttons !== 0) return
      const el = e.target instanceof Element ? e.target : null
      tell(!el?.closest(solid))
    }
    const leave = (e: PointerEvent): void => {
      if (e.buttons === 0) tell(true)
    }
    document.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerleave', leave)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerleave', leave)
    }
  }, [solid, set])
}

import { useMemo } from 'react'
import type { MiniBarMove } from '@shared/minibar'

/** Pressing one of these never moves the bar: each is pressed, typed in, scrolled or dragged itself. */
const NOT_A_HANDLE = [
  'button',
  'textarea',
  'input',
  'select',
  'a',
  'label',
  '[role="button"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '.mb-end',
  '.mb-well',
  '.mb-chips',
  '.mb-bar__notice',
  '.mb-stage'
].join(', ')

/** The press must travel this far (px) before the bar moves, so a plain click on the surface does nothing. */
const SLOP = 3

function isHandle(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  return !!el && (!!el.closest('.mb-grip') || !el.closest(NOT_A_HANDLE))
}

/**
 * Move the whole window by its grip or its bare surface: spread the handlers
 * on `.mb-bar` or `.mb-pill`.
 *
 * Not `-webkit-app-region: drag`. On Windows a drag region is non-client, so
 * the page never sees the pointer over it: useClickThrough could not tell the
 * pointer had reached the grip, the window stayed see-through, and the press
 * fell through to the app below. Drag regions also eat double-clicks. So the
 * page tracks the press itself, as the width ends do (Bar.tsx WidthEnd):
 * `screenX`/`screenY` from the press (DIP, as Electron's bounds are), sent to
 * main at most once a frame; main moves the window and saves at the end.
 *
 * A button is held throughout, so useClickThrough leaves the window taking
 * clicks until it is let go. Capture starts only once the press has moved, so
 * a double-click on the grip still reaches the grip.
 */
export function useWindowDrag(move: ((m: MiniBarMove) => void) | undefined): {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void
} {
  return useMemo(() => {
    const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
      // A preload older than this view has no `move`: then the bar just stays put.
      if (typeof move !== 'function' || e.button !== 0 || !e.isPrimary || !isHandle(e.target)) return
      const surface = e.currentTarget
      const id = e.pointerId
      const startX = e.screenX
      const startY = e.screenY
      let moving = false
      let frame = 0
      let dx = 0
      let dy = 0
      const send = (): void => {
        frame = 0
        move({ phase: 'move', dx, dy })
      }
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== id) return
        dx = ev.screenX - startX
        dy = ev.screenY - startY
        if (!moving) {
          if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
          moving = true
          try {
            surface.setPointerCapture(id)
          } catch {
            // The pointer has already gone: the window-level listeners still hear it out.
          }
          surface.dataset['moving'] = 'true'
          move({ phase: 'start' })
        }
        if (!frame) frame = requestAnimationFrame(send)
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== id) return
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (!moving) return
        if (frame) cancelAnimationFrame(frame)
        send()
        move({ phase: 'end' })
        delete surface.dataset['moving']
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
    // A press on a handle keeps the keyboard where it was and selects no text.
    // On mousedown, not pointerdown: cancelling pointerdown would also cancel
    // the clicks that make the grip's double-click.
    const onMouseDown = (e: React.MouseEvent<HTMLElement>): void => {
      if (e.button === 0 && isHandle(e.target)) e.preventDefault()
    }
    return { onPointerDown, onMouseDown }
  }, [move])
}

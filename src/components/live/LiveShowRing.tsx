import { useEffect, useRef, type ReactNode } from 'react'
import { Glyph } from './glyphs'
import type { LiveShowing } from './types'

/** Where a pane lives on the desktop: a deck pane, a Wall tile, a strip tile. */
function findPane(paneId: string): HTMLElement | null {
  const id = CSS.escape(paneId)
  const all = document.querySelectorAll<HTMLElement>(
    `.pane[data-pane-id="${id}"], .mtile[data-pane-id="${id}"], .wstrip__tile[data-pane-id="${id}"]`
  )
  let best: HTMLElement | null = null
  let area = 0
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width * r.height > area) {
      area = r.width * r.height
      best = el
    }
  }
  return area > 4 ? best : null
}

interface Props {
  showing: LiveShowing
  onDone: () => void
}

/**
 * "Show me": Forge lifts the pane it is showing — a lime ring on its edge,
 * everything else stepped back — and labels it FORGE IS SHOWING YOU, with
 * the note it is pointing out, if any. It follows the pane on a timer (the
 * renderer's frames stop while Forge is covered), transform only.
 */
export function LiveShowRing({ showing, onDone }: Props): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let lastKey = ''
    const place = (): void => {
      const el = ref.current
      if (!el) return
      const pane = findPane(showing.paneId)
      if (!pane) {
        el.dataset['on'] = 'false'
        return
      }
      const r = pane.getBoundingClientRect()
      // The rail floats over the canvas: keep the note on the part of the
      // pane it does not cover.
      const rail = el.parentElement?.querySelector('.live-rail, .live-pill')?.getBoundingClientRect()
      const over = rail && rail.left < r.right && rail.top < r.bottom && rail.bottom > r.top ? r.right - rail.left + 8 : 0
      const cover = Math.max(0, Math.min(over, r.width - 260))
      const key = `${r.left}|${r.top}|${r.width}|${r.height}|${cover}`
      if (key !== lastKey) {
        el.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`
        el.style.width = `${r.width}px`
        el.style.height = `${r.height}px`
        el.style.setProperty('--live-show-cover', `${cover}px`)
        // The note rides in the label only when there is room to read it.
        el.dataset['roomy'] = r.width - cover >= 400 ? 'true' : 'false'
        lastKey = key
      }
      el.dataset['on'] = 'true'
    }
    place()
    const t = window.setInterval(place, 150)
    return () => window.clearInterval(t)
  }, [showing.paneId])

  return (
    <div ref={ref} className="live-show" data-on="false" role="status" aria-label="Forge is showing you this pane">
      <span className="live-show__ring" aria-hidden="true" />
      <span className="live-show__tag">
        <i aria-hidden="true" />
        <span className="live-show__word">Forge is showing you</span>
        {showing.note ? <span className="live-show__note">{showing.note}</span> : null}
        <button type="button" className="live-show__done" onClick={onDone} aria-label="Done looking">
          <Glyph name="close" />
        </button>
      </span>
    </div>
  )
}

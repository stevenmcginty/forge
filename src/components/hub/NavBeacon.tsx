import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HUB_FOCUS_EVENT, type HubFocusDetail } from '@/lib/hubnav'
import { reducedMotion } from '@/lib/motion'
import './NavBeacon.css'

/**
 * "Go to Everest." The move itself is the shell's — the tab crossfades, the
 * canvas camera glides the tile into view, the focus reticle flies — and this
 * is the arrival: the pane's edge pulses once in its own colour and its
 * call-sign flies up on a flag, so the eye lands on the right pane by name
 * rather than by hunting for which border lit.
 *
 * One fixed layer over the stage, following the pane's box for the length of
 * the glide (transform only), gone in a little over a second. Under reduced
 * motion the flag simply appears and fades.
 */

interface Beacon {
  key: number
  paneId: string
  label: string
  number: number
}

const LIFE_MS = 1250

export function NavBeacon(): ReactNode {
  const [beacon, setBeacon] = useState<Beacon | null>(null)
  const seq = useRef(0)
  const ringRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<HubFocusDetail>).detail
      if (!d || d.kind !== 'pane') return
      setBeacon({ key: ++seq.current, paneId: d.paneId, label: d.callSign ?? `Panel ${d.number}`, number: d.number })
    }
    window.addEventListener(HUB_FOCUS_EVENT, on)
    return () => window.removeEventListener(HUB_FOCUS_EVENT, on)
  }, [])

  useEffect(() => {
    if (!beacon) return undefined
    let raf = 0
    let target: HTMLElement | null = null
    const started = performance.now()
    const still = reducedMotion()
    let lastW = -1
    let lastH = -1

    const place = (): boolean => {
      const ring = ringRef.current
      if (!ring) return false
      target ??= document.querySelector<HTMLElement>(
        `.pane[data-pane-id="${beacon.paneId}"], .mtile[data-pane-id="${beacon.paneId}"]`
      )
      if (!target) return false
      const r = target.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      ring.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`
      if (r.width !== lastW || r.height !== lastH) {
        ring.style.width = `${r.width}px`
        ring.style.height = `${r.height}px`
        lastW = r.width
        lastH = r.height
      }
      const accent = getComputedStyle(target).getPropertyValue('--pane-accent').trim()
      if (accent) ring.style.setProperty('--beacon', accent)
      return true
    }

    // The tab may be mounting and the camera gliding: follow the pane until
    // the glide has settled, then hold still for the rest of the beacon.
    const follow = (t: number): void => {
      const ok = place()
      if (ok && ringRef.current && !ringRef.current.dataset['on']) {
        ringRef.current.dataset['on'] = 'true'
        target!.dataset['hit'] = 'true'
      }
      if (t - started < 520 && (!still || !ok)) raf = requestAnimationFrame(follow)
    }
    raf = requestAnimationFrame(follow)

    const done = window.setTimeout(() => setBeacon(null), LIFE_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(done)
      if (target?.dataset['hit'] === 'true') delete target.dataset['hit']
    }
  }, [beacon])

  if (!beacon) return null
  return (
    <div key={beacon.key} ref={ringRef} className="beacon" aria-hidden="true">
      <span className="beacon__ring" />
      <span className="beacon__flag">
        <span className="beacon__arrow">→</span>
        <span className="beacon__name">{beacon.label}</span>
        <span className="beacon__num mono">panel {beacon.number}</span>
      </span>
    </div>
  )
}

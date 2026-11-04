import { useEffect, useRef, type ReactNode } from 'react'
import { useLive } from '@/state/live/LiveController'
import { useVoiceHubController } from '@/state/VoiceHubController'
import { LiveSurface } from './LiveSurface'
import './LiveMount.css'

/** How often the bar and the rail are measured while Live is up. Timers, not rAF: frames stop while Forge is covered. */
const MEASURE_MS = 400
/** Between the bar's top and the captions / the rail's foot. */
const BAR_GAP = 12
/** The rail's own inset from the window's right edge (live.css `--live-edge`) plus the gap to the panes. */
const RAIL_ROOM = 24

/**
 * Where the desktop mounts Claude Live's UI (App.tsx): only while Claude Live
 * is the picked brain, so no other brain pays for its captions re-rendering.
 */
export function LiveMount(): ReactNode {
  const hub = useVoiceHubController()
  return hub.brain === 'claude-live' ? <LiveMountOn /> : null
}

/**
 * The surface, fitted to the real shell: the captions and the rail's foot sit
 * on the bar as it is measured (never moving the bar), and while the rail is
 * up the stage keeps its width clear on the right, so no pane sits under it.
 */
function LiveMountOn(): ReactNode {
  const view = useLive()
  const ref = useRef<HTMLDivElement | null>(null)
  const up = view.phase !== 'off' || view.showing !== null

  useEffect(() => {
    const mount = ref.current
    const deck = mount?.closest<HTMLElement>('.deck') ?? null
    const clearRail = (): void => {
      if (!deck) return
      delete deck.dataset['liveRail']
      deck.style.removeProperty('--live-rail-reserve')
    }
    if (!mount || !up) {
      clearRail()
      return undefined
    }
    let last = ''
    const measure = (): void => {
      const bar = document.querySelector<HTMLElement>('.dock')?.getBoundingClientRect()
      const rail = mount.querySelector<HTMLElement>('.live-rail')
      const clear = bar && bar.height > 0 ? Math.round(window.innerHeight - bar.top + BAR_GAP) : null
      // offsetWidth, not the rect: the rail slides in with a transform.
      const reserve = rail ? rail.offsetWidth + RAIL_ROOM : null
      const key = `${clear}|${bar ? Math.round(bar.left) : ''}|${bar ? Math.round(bar.width) : ''}|${reserve}`
      if (key === last) return
      last = key
      if (bar && clear !== null) {
        mount.style.setProperty('--live-measured-clear', `${clear}px`)
        mount.style.setProperty('--live-measured-left', `${Math.round(bar.left)}px`)
        mount.style.setProperty('--live-measured-w', `${Math.round(bar.width)}px`)
      }
      if (!deck) return
      if (reserve !== null) {
        deck.dataset['liveRail'] = 'on'
        deck.style.setProperty('--live-rail-reserve', `${reserve}px`)
      } else clearRail()
    }
    measure()
    const t = window.setInterval(measure, MEASURE_MS)
    window.addEventListener('resize', measure)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('resize', measure)
      clearRail()
    }
  }, [up])

  return (
    <div ref={ref} className="live-mount">
      <LiveSurface view={view} showing={view.showing} />
    </div>
  )
}

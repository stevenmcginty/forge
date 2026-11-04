import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { LiveCaptions } from './LiveCaptions'
import { LiveRail } from './LiveRail'
import { LiveShowRing } from './LiveShowRing'
import { useNow } from './format'
import type { LiveJob, LiveShowing, LiveView } from './types'
import './live.css'

/** How long a pane stays ringed after Steve taps "show me" on a card. */
const SHOW_MS = 10_000

const showKey = (s: LiveShowing): string => `${s.paneId}|${s.note ?? ''}`

interface Props {
  view: LiveView
  /**
   * What Forge is showing (the contract's `show` event, for a pane). Optional:
   * a tap on a crew card's "show" rings that pane by itself for a while.
   */
  showing?: LiveShowing | null
}

/**
 * Claude Live on the desktop canvas (Design B, "Conductor Rail"): the rail on
 * the right, captions rising out of the bar, and the ring on whatever pane
 * Forge is showing. The single mount point; it draws nothing while Live is off.
 *
 * Placement reads CSS custom properties on `.live-surface`, so the shell can
 * tune them without touching this folder:
 *   --live-top        the rail's top edge (default: under the title bar)
 *   --live-bar-clear  distance from the window's bottom to the bar's top, plus a gap
 *   --live-rail-w     the rail's width
 */
export function LiveSurface({ view, showing }: Props): ReactNode {
  const on = view.phase !== 'off'
  const now = useNow(on)
  const [tapped, setTapped] = useState<{ show: LiveShowing; until: number } | null>(null)
  // "Done looking" on what Forge showed, by content: the provider may hand a fresh object each render.
  const [doneWith, setDoneWith] = useState('')

  useEffect(() => {
    if (!tapped) return undefined
    const t = window.setTimeout(() => setTapped(null), Math.max(0, tapped.until - Date.now()))
    return () => window.clearTimeout(t)
  }, [tapped])

  const onShow = useCallback(
    (job: LiveJob) => {
      view.showJob(job.id)
      if (job.paneId) setTapped({ show: { paneId: job.paneId }, until: Date.now() + SHOW_MS })
    },
    [view]
  )

  const fromForge = showing && showKey(showing) !== doneWith ? showing : null
  const ring = fromForge ?? tapped?.show ?? null
  const ringEl = ring ? (
    <LiveShowRing
      key={ring.paneId}
      showing={ring}
      onDone={() => {
        if (fromForge) setDoneWith(showKey(fromForge))
        setTapped(null)
      }}
    />
  ) : null
  // Off, only a pane Forge was asked to show (the desktop card's "Show me") is drawn: its ring, no rail.
  if (!on) return ringEl ? <div className="live-surface" data-phase="off">{ringEl}</div> : null
  const phase = view.phase === 'off' ? 'listening' : view.phase

  return (
    <div className="live-surface" data-phase={phase}>
      {ringEl}
      <LiveCaptions caption={view.caption} phase={phase} />
      <LiveRail view={view} phase={phase} now={now} onShow={onShow} />
    </div>
  )
}

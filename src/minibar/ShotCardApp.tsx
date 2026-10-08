import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Shot } from '@shared/types'
import { ShotCard } from '@/components/ShotPop'
import { reducedMotion } from '@/lib/motion'
import { applyTheme, findTheme } from '@/theme/themes'
import { SHOTCARD_SOLID, useClickThrough } from './useClickThrough'
import '@/components/shell/deck-tokens.css'
import '@/components/ShotPop.css'
import './ShotCardApp.css'

/** The same timing as ShotPop. */
const SHOW_MS = 10_000
const COPIED_MS = 1600
/** ✕ gets out of the way quickly; running out of time fades a little slower. */
const AWAY_MS = 160
const FADE_MS = 320

/**
 * The #shotcard window's whole tree (src/main.tsx), no providers: a new
 * screen capture, shown on the desktop while Forge is minimised
 * (docs/MINI-BAR.md, 4.7).
 *
 * The main window's ShotPop card, with its timing — ten seconds, hover holds
 * it, ✕ closes it, a new shot replaces the picture and stacks the card — but
 * no cog to tuck into, so it fades. Then main hides the window (`done`).
 *
 * Click copies the image and its quoted path, as ever, and puts the path in
 * the mini bar's box (the host decides; a pane Steve cannot see is never
 * typed into). Drag is the real file drag. The window never takes focus.
 */
export function ShotCardApp(): ReactNode {
  const api = window.forge.shotCard
  const [shot, setShot] = useState<Shot | null>(null)
  const [count, setCount] = useState(0)
  const [run, setRun] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const showing = useRef<Shot | null>(null)
  showing.current = shot
  const cardRef = useRef<HTMLDivElement | null>(null)
  const remaining = useRef(SHOW_MS)
  const lastRun = useRef(-1)
  const exit = useRef<Animation | null>(null)
  const gen = useRef(0)

  // Transparent page, and Forge's theme rather than the default one.
  useLayoutEffect(() => {
    document.documentElement.dataset['shotcardView'] = 'true'
  }, [])
  // The window is the tallest card's size: clicks beside a shorter one go to the app underneath.
  useClickThrough(SHOTCARD_SOLID, api?.setClickThrough)
  useEffect(() => {
    void window.forge.store
      .snapshot()
      .then((s) => applyTheme(findTheme(s.settings.themeId, s.settings.customThemes)))
      .catch(() => undefined)
  }, [])

  /* ---- arrivals ---- */

  useEffect(() => {
    if (typeof api?.onShow !== 'function') return undefined
    return api.onShow((next) => {
      gen.current++
      exit.current?.cancel()
      exit.current = null
      setShot(next)
      setCount((n) => (showing.current ? n : 0) + 1)
      setRun((r) => r + 1)
      setCopied(false)
      setLeaving(false)
    })
  }, [api])

  useEffect(() => {
    if (!shot) setHovered(false)
  }, [shot])

  /* ---- clock ---- */

  useEffect(() => {
    if (!shot || leaving) return undefined
    if (lastRun.current !== run) {
      lastRun.current = run
      remaining.current = SHOW_MS
    }
    if (hovered) return undefined
    const started = Date.now()
    const t = window.setTimeout(() => leave(FADE_MS), remaining.current)
    return () => {
      window.clearTimeout(t)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
    // leave only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot, run, hovered, leaving])

  useEffect(() => {
    if (!copied) return undefined
    const t = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(t)
  }, [copied])

  /* ---- the exit: a fade, then main hides the window ---- */

  function leave(ms: number): void {
    const card = cardRef.current
    const g = gen.current
    const done = (): void => {
      exit.current = null
      if (gen.current !== g) return // a new shot took the card over mid-fade
      setShot(null)
      setLeaving(false)
      api?.done()
    }
    if (!card || reducedMotion()) return done()
    setLeaving(true)
    exit.current = card.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate3d(0, -4px, 0) scale(0.98)' }], {
      duration: ms,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards'
    })
    exit.current.finished.then(done, done)
  }

  const copy = (s: Shot): void => {
    void window.forge.shots.copy(s.path).then((ok) => {
      if (!ok) return
      setCopied(true)
      api?.toMiniBar([s.path])
    })
  }

  if (!api || !shot) return null

  return (
    <ShotCard
      shot={shot}
      count={count}
      run={run}
      held={hovered}
      copied={copied}
      leaving={leaving}
      cardRef={cardRef}
      onHover={setHovered}
      onClose={() => leave(AWAY_MS)}
      onCopy={() => copy(shot)}
    />
  )
}

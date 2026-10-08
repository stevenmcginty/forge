import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { Shot } from '@shared/types'
import { reducedMotion } from '@/lib/motion'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { Icon } from './Icon'
import { dragShotOut, useCopyShot } from './ScreenshotTray'
import './ShotPop.css'

/** How long a fresh shot stays up before it tucks itself into the menu. */
const SHOW_MS = 10_000
const COPIED_MS = 1600
const TUCK_MS = 460
const AWAY_MS = 160

/** The cog button that holds the shelf — where a timed-out shot travels to. */
const SHELF_BUTTON = '.deckmenu > .deckbar__btn'

/**
 * A screenshot the moment you take it: a proof card at the top right, under
 * the menu that holds the shelf, big enough to recognise and a real object —
 * drag it into a pane, a chat or a browser tab as the file itself, or click to
 * copy, exactly as the tray does (the same gestures, shared from it).
 *
 * It never takes the keyboard (the talk key must keep working mid-dictation):
 * nothing in it is focused on appear, and ✕ swallows its own mousedown so
 * dismissing it leaves focus where it was. Hovering holds it. After ten seconds
 * it shrinks into the cog button it lives under, so you learn where it went.
 *
 * Shots in a row replace the picture with the newest and stack the card, with a
 * count; each one restarts the clock. Nothing here touches the tray's "new"
 * state — a shot that popped up is still new in the menu until you open it.
 */
export function ShotPop(): ReactNode {
  const [shot, setShot] = useState<Shot | null>(null)
  /** Shots that have arrived while this card has been up. */
  const [count, setCount] = useState(0)
  /** Bumped by every arrival, to restart the clock and the drain bar. */
  const [run, setRun] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const [copied, setCopied] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const known = useRef<Set<string> | null>(null)
  const showing = useRef<Shot | null>(null)
  showing.current = shot
  const cardRef = useRef<HTMLDivElement | null>(null)
  const remaining = useRef(SHOW_MS)
  const lastRun = useRef(-1)
  /** The exit in flight, and a generation so an arrival can call it off. */
  const exit = useRef<Animation | null>(null)
  const gen = useRef(0)
  const copy = useCopyShot()
  const sheet = useShellSheet()

  /* -------------------------------------------------------------- arrivals */

  useEffect(() => {
    const receive = (next: Shot[]): void => {
      const ids = new Set(next.map((s) => s.id))
      if (known.current === null) {
        // The first payload is the shelf as it was on disk — not news.
        known.current = ids
        return
      }
      // A shot that already popped on the desktop (the main window was minimised) is not news here.
      const fresh = next.filter((s) => !known.current!.has(s.id) && !s.shownOnDesktop)
      known.current = ids
      // Deleted from the tray (or pruned) while it was up: nothing left to hold.
      if (showing.current && !ids.has(showing.current.id)) setShot(null)
      // With the shelf open the tray is on screen, and that is the announcement.
      if (fresh.length === 0 || shellSheet.get() === 'shelf') return
      gen.current++
      exit.current?.cancel()
      setShot(fresh[0]!) // the shelf lists newest first
      setCount((n) => (showing.current ? n : 0) + fresh.length)
      setRun((r) => r + 1)
      setCopied(false)
      setLeaving(false)
    }
    const off = window.forge.shots.onUpdated(receive)
    void window.forge.shots.list().then(receive)
    return off
  }, [])

  useEffect(() => {
    const onVis = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Opening the menu shows the shelf itself — the card has done its job.
  useEffect(() => {
    if (sheet === 'shelf') setShot(null)
  }, [sheet])

  // A card that leaves from under the pointer never hears pointerleave.
  useEffect(() => {
    if (!shot) setHovered(false)
  }, [shot])

  /* ----------------------------------------------------------------- clock */

  const held = hovered || hidden

  useEffect(() => {
    if (!shot || leaving) return undefined
    if (lastRun.current !== run) {
      lastRun.current = run
      remaining.current = SHOW_MS
    }
    if (held) return undefined
    const started = Date.now()
    const t = window.setTimeout(() => leave('tuck'), remaining.current)
    return () => {
      window.clearTimeout(t)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
    // leave is stable in effect: it only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot, run, held, leaving])

  useEffect(() => {
    if (!copied) return undefined
    const t = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(t)
  }, [copied])

  /* ----------------------------------------------------------------- exits */

  /**
   * 'tuck' flies the card into the cog button and gives the button a nudge as
   * it lands; 'away' (✕) just gets out of the way. Reduced motion skips both.
   */
  function leave(kind: 'tuck' | 'away'): void {
    const card = cardRef.current
    const target = document.querySelector<HTMLElement>(SHELF_BUTTON)
    const g = gen.current
    const done = (): void => {
      exit.current = null
      if (gen.current !== g) return // a new shot took the card over mid-exit
      setShot(null)
      setLeaving(false)
    }
    if (!card || reducedMotion()) return done()
    setLeaving(true)

    if (kind === 'away' || !target) {
      exit.current = card.animate(
        [{ opacity: 1 }, { opacity: 0, transform: 'translate3d(10px, -4px, 0) scale(0.97)' }],
        {
          duration: AWAY_MS,
          easing: 'cubic-bezier(0.4, 0, 1, 1)',
          fill: 'forwards'
        }
      )
      exit.current.finished.then(done, done)
      return
    }

    const from = card.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const dx = to.left + to.width / 2 - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - (from.top + from.height / 2)
    exit.current = card.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate3d(${dx * 0.55}px, ${dy * 0.45}px, 0) scale(0.42)`, opacity: 0.95, offset: 0.55 },
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.06)`, opacity: 0 }
      ],
      { duration: TUCK_MS, easing: 'cubic-bezier(0.55, 0, 0.6, 1)', fill: 'forwards' }
    )
    exit.current.finished.then(() => {
      if (gen.current === g) target.dataset['shotLanded'] = 'true'
      window.setTimeout(() => delete target.dataset['shotLanded'], 620)
      done()
    }, done)
  }

  if (!shot) return null

  return (
    <ShotCard
      shot={shot}
      count={count}
      run={run}
      held={held}
      copied={copied}
      leaving={leaving}
      cardRef={cardRef}
      onHover={setHovered}
      onClose={() => leave('away')}
      onCopy={() =>
        void copy(shot).then((r) => {
          if (r.ok) setCopied(true)
        })
      }
    />
  )
}

/**
 * The card itself, without its clock or its exits: the picture, the count, ✕,
 * click to copy, drag out as a file. ShotPop holds it up in the main window;
 * src/minibar/ShotCardApp.tsx holds the same card up on the desktop while
 * Forge is minimised.
 */
export function ShotCard({
  shot,
  count,
  run,
  held,
  copied,
  leaving,
  cardRef,
  onHover,
  onClose,
  onCopy
}: {
  shot: Shot
  /** Shots that have arrived while the card has been up. */
  count: number
  /** Bumped by every arrival: restarts the drain bar. */
  run: number
  held: boolean
  copied: boolean
  leaving: boolean
  cardRef: RefObject<HTMLDivElement | null>
  onHover: (on: boolean) => void
  onClose: () => void
  onCopy: () => void
}): ReactNode {
  const stamp = new Date(shot.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dims = shot.width > 0 ? `${shot.width} × ${shot.height}` : 'image'
  // The frame follows the picture's shape, within reason: very tall or very
  // wide shots are letterboxed rather than turning the card into a ribbon.
  const ratio = shot.width > 0 && shot.height > 0 ? Math.min(2.8, Math.max(1.42, shot.width / shot.height)) : 16 / 9
  const stack = Math.min(count, 3)

  return (
    <div className="shotpop" data-stack={stack > 1 ? stack : undefined} data-leaving={leaving ? 'true' : undefined}>
      {stack > 2 ? <span className="shotpop__ghost shotpop__ghost--2" aria-hidden="true" /> : null}
      {stack > 1 ? <span className="shotpop__ghost shotpop__ghost--1" aria-hidden="true" /> : null}
      <div
        ref={cardRef}
        className="shotpop__card"
        role="status"
        aria-live="polite"
        aria-label={count > 1 ? `${count} new screenshots` : 'New screenshot'}
        data-held={held ? 'true' : undefined}
        style={{ '--shotpop-ms': `${SHOW_MS}ms` } as CSSProperties}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
      >
        <header className="shotpop__head">
          <span className="shotpop__mark" aria-hidden="true" />
          <span className="shotpop__eyebrow">{count > 1 ? `${count} screenshots` : 'Screenshot'}</span>
          <span className="shotpop__meta mono">{stamp}</span>
          <button
            type="button"
            className="shotpop__x"
            title="Close — it stays in the menu's shelf"
            aria-label="Close"
            // Keep focus where it was: dismissing must not pull the keyboard off
            // the pane or the bar you were talking into.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            <Icon name="close" size={10} />
          </button>
        </header>

        <button
          type="button"
          className="shotpop__frame"
          style={{ '--shot-ratio': ratio } as CSSProperties}
          title={`${shot.name}\nClick to copy · drag out as a file`}
          draggable
          onDragStart={(e) => dragShotOut(e, shot)}
          onClick={onCopy}
          data-copied={copied ? 'true' : undefined}
        >
          {shot.thumb ? (
            <img key={shot.id} className="shotpop__img" src={shot.thumb} alt={shot.name} draggable={false} />
          ) : (
            <span className="shotpop__noimg" aria-hidden="true">
              <Icon name="camera" size={22} />
            </span>
          )}
          <span className="shotpop__copied" aria-hidden={!copied}>
            <Icon name="check" size={13} />
            Copied
          </span>
        </button>

        <footer className="shotpop__foot">
          <span className="shotpop__hint">
            <Icon name="grip" size={11} />
            Drag out
            <span className="shotpop__dot" aria-hidden="true">
              ·
            </span>
            Click to copy
          </span>
          <span className="shotpop__meta mono">{dims}</span>
        </footer>

        <span className="shotpop__clock" aria-hidden="true">
          <span key={run} className="shotpop__drain" />
        </span>
      </div>
    </div>
  )
}

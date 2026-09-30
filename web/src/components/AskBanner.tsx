import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { paneLabel } from '../lib/notify'
import { useForge } from '../state'
import './AskBanner.css'

/**
 * The phone's heads-up: "another pane is asking", while Forge is open.
 *
 * The OS notification only fires while the tab is hidden, and the "! 2
 * waiting" pill is easy to miss while you are reading a different pane. So when
 * a pane that is *not* the one on screen starts asking, this slides down over
 * the top of the terminal, WhatsApp-style: the "!" in its filled circle (the
 * pill's shape, so it reads without colour), "project — pane", and the
 * question. A tap goes there — the same jump a notification tap makes — and
 * the × puts it away; so does a swipe up, its own fuse, a newer ask (which
 * replaces it), and the pane stopping asking (state.tsx clears it).
 *
 * Mounted once, on the phone face, inside the display — so it sits under the
 * top bar and the tabs and over the terminal, and every sheet still covers it.
 */
export function AskBanner(): ReactNode {
  const { state, actions } = useForge()
  const banner = state.askBanner
  const picture = state.picture
  if (!banner || !picture) return null
  return (
    <AskBannerView
      key={banner.seq}
      label={paneLabel(picture.projects, picture.workspaces, banner.sessionId)}
      prompt={state.prompts[banner.sessionId] ?? ''}
      onOpen={actions.openAskBanner}
      onDismiss={actions.dismissAskBanner}
    />
  )
}

/** How long the banner stays when nobody touches it. */
const FUSE_MS = 6000
/** How far up (px) a swipe has to travel to put it away. */
const SWIPE_AWAY_PX = 24
/** Movement (px) past which a touch is a swipe rather than a tap. */
const TAP_SLOP_PX = 8

interface ViewProps {
  label: string
  prompt: string
  onOpen: () => void
  onDismiss: () => void
  /** 0 holds it on screen — the dev preview's. */
  fuseMs?: number
}

/** The banner itself, fed its words — split out so `?preview=askbanner` can draw it without a desktop. */
export function AskBannerView({ label, prompt, onOpen, onDismiss, fuseMs = FUSE_MS }: ViewProps): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; y: number; dy: number; moved: boolean } | null>(null)
  /** A swipe that ended over the body must not also count as a tap on it. */
  const swallowClick = useRef(false)

  // Keyed by the ask upstream, so a newer ask is a fresh mount and a fresh fuse.
  // Read through a ref so a re-built `actions` does not re-light the fuse.
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    if (!fuseMs) return
    const timer = window.setTimeout(() => dismiss.current(), fuseMs)
    return () => clearTimeout(timer)
  }, [fuseMs])

  const place = (dy: number, settle: boolean): void => {
    const el = card.current
    if (!el) return
    el.style.transition = settle ? '' : 'none'
    el.style.transform = dy ? `translateY(${dy}px)` : ''
    el.style.opacity = dy ? String(Math.max(0.2, 1 + dy / 80)) : ''
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    drag.current = { id: event.pointerId, y: event.clientY, dy: 0, moved: false }
    swallowClick.current = false
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    const raw = event.clientY - d.y
    if (!d.moved && Math.abs(raw) < TAP_SLOP_PX) return
    if (!d.moved) {
      d.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    // Up only, and a little give downward so it does not feel nailed on.
    d.dy = raw < 0 ? raw : Math.min(raw / 4, 8)
    place(d.dy, false)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    drag.current = null
    if (!d.moved) return
    swallowClick.current = true
    if (d.dy <= -SWIPE_AWAY_PX) onDismiss()
    else place(0, true)
  }

  const open = (): void => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    onOpen()
  }

  const line = prompt.trim()
  return (
    <div
      ref={card}
      className="askbanner"
      role="status"
      aria-live="polite"
      data-testid="ask-banner"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <button type="button" className="askbanner__body" onClick={open}>
        <span className="askbanner__bang" aria-hidden="true">
          !
        </span>
        <span className="askbanner__text">
          <span className="askbanner__title">{label}</span>
          <span className="askbanner__prompt">{line || 'Waiting for your answer.'}</span>
        </span>
      </button>
      <button type="button" className="askbanner__close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

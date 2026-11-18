import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { resolveProfile } from '@shared/agents'
import type { AgentProfile, Project, Workspace } from '@shared/types'
import { AgentBadge } from '@/components/AgentBadge'
import { collectLeaves } from '@/lib/splitTree'
import { exitDelay } from '../lib/motion'
import { paneLabel } from '../lib/notify'
import { useForge } from '../state'
import { PhoneIcon } from './PhoneIcon'
import './AskBanner.css'

/**
 * The phone's heads-up: "another pane is asking", while Forge is open.
 *
 * The OS notification only fires while the tab is hidden, and the waiting pill
 * is easy to miss while you are reading a different pane. So when a pane that
 * is *not* the one on screen starts asking, this drops from under the tab
 * strip: who is asking (the agent's logo with the "!" on it, then project ·
 * pane), and one line of the question. A tap goes there — the same jump a
 * notification tap makes — and the × puts it away; so does a flick up, its own
 * fuse, a newer ask (which replaces it), and the pane stopping asking
 * (state.tsx clears it).
 *
 * Mounted once, on the phone face, inside the display — so it sits under the
 * top bar and the tabs and over the conversation, and every sheet still covers it.
 */
export function AskBanner(): ReactNode {
  const { state, actions } = useForge()
  const banner = state.askBanner
  const picture = state.picture
  if (!banner || !picture) return null
  const who = findAsker(picture.projects, picture.workspaces, picture.profiles, banner.sessionId)
  return (
    <AskBannerView
      key={banner.seq}
      label={paneLabel(picture.projects, picture.workspaces, banner.sessionId)}
      profile={who?.profile}
      prompt={state.prompts[banner.sessionId] ?? ''}
      onOpen={actions.openAskBanner}
      onDismiss={actions.dismissAskBanner}
    />
  )
}

/**
 * The project and the agent behind a pane, read off the picture this page
 * already holds — for the logo on a notice. Null for a pane in no workspace.
 */
export function findAsker(
  projects: Project[],
  workspaces: Record<string, Workspace>,
  profiles: AgentProfile[],
  paneId: string
): { project: Project; profile: AgentProfile } | null {
  for (const project of projects) {
    for (const tab of workspaces[project.id]?.tabs ?? []) {
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      if (leaf) return { project, profile: resolveProfile(profiles, leaf.profileId) }
    }
  }
  return null
}

/** How long the banner stays when nobody touches it. */
const FUSE_MS = 6000
/** How far up (px) a swipe has to travel to put it away. */
const SWIPE_AWAY_PX = 24
/** Movement (px) past which a touch is a swipe rather than a tap. */
const TAP_SLOP_PX = 8
/** "project — pane", as `remoteControlName` joins them. */
const LABEL_JOIN = ' — '

interface ViewProps {
  label: string
  prompt: string
  onOpen: () => void
  onDismiss: () => void
  /** The asking pane's agent, for its logo. Without it the "!" stands alone. */
  profile?: AgentProfile
  /** 0 holds it on screen — the dev preview's. */
  fuseMs?: number
}

/** The banner itself, fed its words — split out so `?preview=askbanner` can draw it without a desktop. */
export function AskBannerView({ label, prompt, onOpen, onDismiss, profile, fuseMs = FUSE_MS }: ViewProps): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; y: number; dy: number; moved: boolean } | null>(null)
  /** A swipe that ended over the body must not also count as a tap on it. */
  const swallowClick = useRef(false)
  /** Lifting away: the dismissal lands once the card has left. */
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  // Keyed by the ask upstream, so a newer ask is a fresh mount and a fresh fuse.
  // Read through a ref so a re-built `actions` does not re-light the fuse.
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])

  /** Put it away: lift it off the top, then tell the owner. Once. */
  const leave = useRef<() => void>(() => undefined)
  leave.current = () => {
    if (leaving) return
    setLeaving(true)
    const el = card.current
    if (el) {
      el.style.transition = ''
      el.style.transform = ''
      el.style.opacity = ''
    }
    leaveTimer.current = window.setTimeout(() => dismiss.current(), exitDelay())
  }

  useEffect(() => {
    if (!fuseMs) return
    const timer = window.setTimeout(() => leave.current(), fuseMs)
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
    if (d.dy <= -SWIPE_AWAY_PX) {
      // Carry on from where the finger let go: the exit starts there.
      const el = card.current
      if (el) el.style.setProperty('--askbanner-from', `${d.dy}px`)
      leave.current()
    } else place(0, true)
  }

  const open = (): void => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    onOpen()
  }

  const line = prompt.trim()
  const cut = label.indexOf(LABEL_JOIN)
  const project = cut > 0 ? label.slice(0, cut) : label
  const pane = cut > 0 ? label.slice(cut + LABEL_JOIN.length) : ''
  return (
    <div
      ref={card}
      className="askbanner"
      role="status"
      aria-live="polite"
      data-testid="ask-banner"
      data-leaving={leaving ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <button type="button" className="askbanner__body" onClick={open}>
        <span className="askbanner__who" aria-hidden="true">
          {profile ? <AgentBadge profile={profile} size="sm" /> : null}
          <span className="askbanner__bang pu-bang">!</span>
        </span>
        <span className="askbanner__text">
          <span className="askbanner__title">
            <span className="askbanner__project">{project}</span>
            {pane ? (
              <>
                <span className="askbanner__sep"> · </span>
                <span className="askbanner__pane">{pane}</span>
              </>
            ) : null}
          </span>
          <span className="askbanner__prompt">{line || 'Waiting for your answer.'}</span>
        </span>
      </button>
      <button type="button" className="askbanner__close" aria-label="Dismiss" onClick={() => leave.current()}>
        <PhoneIcon name="close" size={20} />
      </button>
      <span className="askbanner__grip" aria-hidden="true" />
    </div>
  )
}

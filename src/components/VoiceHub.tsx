import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { hubDrag } from '@/lib/hubdrag'
import {
  clampHubPos,
  defaultHubPos,
  dockPoint,
  hubBounds,
  hubSize,
  HUB_DRAG_THRESHOLD,
  HUB_SNAP_MS,
  isFloatingHub,
  isNearDock,
  nextHubMode,
  type Point
} from '@/lib/voicehub'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { useVoiceAgent } from '@/state/VoiceAgent'
import { DictationGlyph } from './DictationPill'
import { Icon } from './Icon'
import {
  BrainChip,
  DegradedLink,
  LastLine,
  ReplyModeToggle,
  VoiceComposer,
  VoiceDial,
  VoiceLog,
  VoiceOnlyNote
} from './VoiceSurface'
import './VoiceHub.css'

/**
 * The floating Voice Hub.
 *
 * Steve's ask, in his words: drag the pill out of its corner, have it grow into
 * something you can put anywhere, open it up into a proper voice surface when
 * you want to talk properly, and throw it back at its corner when you are done.
 * DictationMic's floating pill, living inside Forge rather than over Windows.
 *
 * Three states, and `src/lib/voicehub.ts` owns the arithmetic behind all of
 * them (the transition table, the clamping, the dock magnet), so what is left
 * here is the gesture and the paint:
 *
 *   docked     nothing rendered — the status-bar pill is the hub
 *   floating   a 180×56 pill: dictation on its body, the agent on the circle
 *   expanded   a 380×520 card: the same conversation the right-hand panel shows
 *
 * BOTH microphones live on the floating pill on purpose. Tapping its body
 * toggles dictation into the pane behind it; tapping the circle beside that
 * arms the agent. They have always been two different things in Forge and the
 * pill is the first place they have been side by side, so the meter and the
 * ring are the two halves of the same object.
 *
 * Nothing in this file subscribes to the transcript bus, the sidecar or the
 * speaker. It renders `useVoiceAgent()` and `useDictation()`, both of which are
 * single shared engines — which is why having the hub *and* the panel open at
 * once cannot answer twice or speak twice. `npm run hub:check` enforces it.
 */

/** Where the hub is drawn, as a transform. */
function applyPos(el: HTMLElement | null, pos: Point): void {
  if (el) el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`
}

/** The live dock, measured — the socket the status-bar pill leaves behind. */
function measureDock(): { point: Point; el: HTMLElement | null } {
  const el = document.querySelector<HTMLElement>('[data-dock="voice-hub"]')
  if (!el) {
    const bounds = hubBounds({ w: window.innerWidth, h: window.innerHeight }, { top: 0, bottom: 26 })
    return { point: dockPoint(bounds), el: null }
  }
  const r = el.getBoundingClientRect()
  return { point: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, el }
}

export function VoiceHub(): ReactNode {
  const { state, actions } = useApp()
  const { status, listening, toggle, needsSetup } = useDictation()
  const { replyMode, armed, phase } = useVoiceAgent()

  const hub = state.settings.voiceHub
  const mode = hub.mode
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Set while a release right now would send it home. */
  const [magnet, setMagnet] = useState(false)
  /** The 200ms flight back to the corner. */
  const [snapping, setSnapping] = useState(false)
  const draggedRef = useRef(false)

  const bounds = (): ReturnType<typeof hubBounds> =>
    hubBounds({ w: window.innerWidth, h: window.innerHeight }, { top: 0, bottom: 0 })

  /* ------------------------------------------------------------ position
   *
   * The store's position is the resting one; `hubDrag` is the live one. Both
   * are written straight to the element's transform rather than through React,
   * because a pointermove is 120 events a second and this app has terminals in
   * it.
   */

  useEffect(() => {
    if (!isFloatingHub(mode) || snapping) return
    const live = hubDrag.get()
    // 0,0 is "floating but never placed" — a settings.json carrying a mode and
    // no position. Anywhere is better than the top-left corner.
    const resting =
      hub.x === 0 && hub.y === 0
        ? defaultHubPos(hubSize(mode), bounds())
        : clampHubPos({ x: hub.x, y: hub.y }, hubSize(mode), bounds())
    applyPos(rootRef.current, live ?? resting)
  }, [mode, hub.x, hub.y, snapping])

  useEffect(() => {
    return hubDrag.subscribe((pos) => {
      if (pos) applyPos(rootRef.current, pos)
    })
  }, [])

  // A window that got smaller must not leave the hub off the edge of it.
  useEffect(() => {
    if (!isFloatingHub(mode)) return undefined
    const onResize = (): void => {
      const clamped = clampHubPos({ x: hub.x, y: hub.y }, hubSize(mode), bounds())
      applyPos(rootRef.current, clamped)
      if (clamped.x !== hub.x || clamped.y !== hub.y) actions.setVoiceHub(clamped)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode, hub.x, hub.y, actions])

  /* --------------------------------------------------------------- drag */

  /**
   * One gesture for both shapes.
   *
   * A press that never moves `HUB_DRAG_THRESHOLD` is a click and is handed
   * back — that is what makes "tap the pill body to dictate" and "drag the pill
   * body anywhere" the same control. While a pill (never a card) is over its
   * dock, the socket lights up and letting go sends it home.
   */
  const onDragDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const el = rootRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const grabX = e.clientX - rect.left
      const grabY = e.clientY - rect.top
      const startX = e.clientX
      const startY = e.clientY
      const currentSize = hubSize(mode)
      const dock = measureDock()
      let moved = false
      let latest: Point = { x: rect.left, y: rect.top }
      draggedRef.current = false

      const onMove = (ev: PointerEvent): void => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < HUB_DRAG_THRESHOLD) return
        if (!moved) {
          moved = true
          draggedRef.current = true
          setDragging(true)
          document.body.classList.add('is-hub-dragging')
        }
        latest = clampHubPos({ x: ev.clientX - grabX, y: ev.clientY - grabY }, currentSize, bounds())
        hubDrag.set(latest)
        // Only a pill goes home; a card is dragged by its header and dropping
        // one on a 50px socket by accident would lose the conversation.
        const near = mode === 'floating' && isNearDock(latest, currentSize, dock.point)
        setMagnet(near)
        if (dock.el) {
          if (near) dock.el.setAttribute('data-magnet', 'true')
          else dock.el.removeAttribute('data-magnet')
        }
      }

      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (!moved) return
        document.body.classList.remove('is-hub-dragging')
        dock.el?.removeAttribute('data-magnet')
        setDragging(false)
        hubDrag.set(null)
        const home = mode === 'floating' && isNearDock(latest, currentSize, dock.point)
        if (!home) {
          setMagnet(false)
          actions.setVoiceHub(latest)
          return
        }
        // Home: fly to the corner and shrink into it, then hand the state over
        // to the status bar. The position is still written, so picking it up
        // again puts it back where he had it.
        setSnapping(true)
        applyPos(rootRef.current, {
          x: dock.point.x - currentSize.w / 2,
          y: dock.point.y - currentSize.h / 2
        })
        window.setTimeout(() => {
          setSnapping(false)
          setMagnet(false)
          actions.setVoiceHub({ mode: nextHubMode(mode, 'dock'), ...latest })
        }, HUB_SNAP_MS)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [mode, actions]
  )

  /** A click that was really the end of a drag is not a click. */
  const swallowedClick = (): boolean => {
    if (!draggedRef.current) return false
    draggedRef.current = false
    return true
  }

  /* ------------------------------------------------------------ keyboard */

  // Esc collapses the card back to the pill. It never dismisses the hub
  // outright — losing a floating thing to a keypress is how you end up hunting
  // for it — and while the card is open the agent's own Esc handler stands
  // down, so a second press disarms the way it always did.
  useEffect(() => {
    if (mode !== 'expanded') return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      actions.setVoiceHub({ mode: nextHubMode('expanded', 'escape') })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, actions])

  if (!isFloatingHub(mode)) return null

  const setMode = (event: Parameters<typeof nextHubMode>[1]): void =>
    actions.setVoiceHub({ mode: nextHubMode(mode, event) })

  const dictateTitle = needsSetup
    ? `Dictation needs setting up — ${status.error?.msg ?? ''}`
    : listening
      ? 'Listening — tap to stop'
      : `Dictate into the pane behind — ${hotkeyLabel(state.settings.sttHotkey)}`

  /* --------------------------------------------------------- the pill */

  if (mode === 'floating') {
    return (
      <div
        ref={rootRef}
        className="vhub vhub--pill"
        data-dragging={dragging ? 'true' : undefined}
        data-magnet={magnet ? 'true' : undefined}
        data-snapping={snapping ? 'true' : undefined}
        data-phase={status.phase}
        data-agent={armed ? 'true' : undefined}
        role="group"
        aria-label="Voice hub"
        onDoubleClick={() => setMode('expand')}
      >
        <button
          type="button"
          className="vhub__grip"
          title={dictateTitle}
          aria-label={dictateTitle}
          aria-pressed={listening}
          onPointerDown={onDragDown}
          onClick={() => {
            if (swallowedClick()) return
            toggle()
          }}
        >
          <DictationGlyph listening={listening} level={status.level} />
          <span className="vhub__word">{listening ? 'listening' : armed ? 'agent' : 'dictate'}</span>
        </button>

        {/* The agent's own circle — the same one the panel shows, at 34px. */}
        <VoiceDial compact />

        <button
          type="button"
          className="vhub__chev"
          title="Open the voice hub (or double-click the pill)"
          aria-label="Expand the voice hub"
          onClick={() => setMode('expand')}
        >
          <Icon name="expand" size={12} />
        </button>
      </div>
    )
  }

  /* --------------------------------------------------------- the card */

  return (
    <div
      ref={rootRef}
      className="vhub vhub--card"
      data-dragging={dragging ? 'true' : undefined}
      data-snapping={snapping ? 'true' : undefined}
      data-phase={phase}
      role="dialog"
      aria-label="Voice hub"
    >
      <header className="vhub__head" onPointerDown={onDragDown} onDoubleClick={() => setMode('minimise')}>
        <span className="vhub__mark" aria-hidden="true">
          <Icon name="mic" size={13} />
        </span>
        <h2 className="vhub__title">Voice Hub</h2>
        <BrainChip />
        <span className="vhub__spacer" />
        <ReplyModeToggle />
        <button
          type="button"
          className="ghost-btn vhub__icon-btn"
          title="Voice settings — brain, keys, voice"
          aria-label="Voice settings"
          onClick={() => actions.openSettings('models')}
        >
          <Icon name="gear" size={13} />
        </button>
        <button
          type="button"
          className="ghost-btn vhub__icon-btn"
          title="Minimise to the floating pill (Esc)"
          aria-label="Minimise the voice hub"
          onClick={() => setMode('minimise')}
        >
          <Icon name="chevronDown" size={13} />
        </button>
        <button
          type="button"
          className="ghost-btn vhub__icon-btn"
          title="Send it back to the status bar"
          aria-label="Dock the voice hub"
          onClick={() => setMode('dock')}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <DegradedLink />

      <VoiceDial />

      {replyMode === 'voice' ? (
        <>
          <LastLine />
          <VoiceOnlyNote />
        </>
      ) : (
        <>
          <VoiceLog />
          <VoiceComposer autoFocus />
        </>
      )}

      <footer className="vhub__foot">
        <button
          type="button"
          className="vhub__dictate"
          data-on={listening ? 'true' : undefined}
          title={dictateTitle}
          onClick={toggle}
        >
          <DictationGlyph listening={listening} level={status.level} />
          <span>{listening ? 'dictating into the pane' : 'dictate into the pane'}</span>
        </button>
        <span className="vhub__hotkey mono">{hotkeyLabel(state.settings.sttHotkey)}</span>
      </footer>
    </div>
  )
}

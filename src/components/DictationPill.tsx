import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { hubDrag } from '@/lib/hubdrag'
import {
  agentSurfaceOpen,
  clampHubPos,
  HUB_DRAG_THRESHOLD,
  HUB_PILL_SIZE,
  hubBounds,
  isFloatingHub
} from '@/lib/voicehub'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { DictationSetup } from './DictationSetup'
import { Popover } from './Popover'
import './DictationPill.css'

/**
 * The dictation pill — DictationMic's visual language, sized for Forge's status
 * bar rather than floating over the desktop.
 *
 *   sleeping dots   idle, ready when you are
 *   volt bars       listening; the meter moves with your voice
 *   pulsing dots    finishing off the last phrase
 *   amber           something is missing — click to fix the paths
 *
 * The meter is written straight to the DOM inside a rAF loop. Levels arrive
 * 10×/s and the breathe animation wants 60 — routing either through React state
 * would re-render the status bar continuously for a decoration.
 *
 * This is also the pill's *dock*. Press and drag it and it lifts out into the
 * floating Voice Hub (src/components/VoiceHub.tsx), leaving an empty socket
 * behind so the status bar does not reflow — and so it is obvious where the
 * thing came from and where it goes back to.
 */

/** Six, not DictationMic's eleven — see the note in DictationPill.css. */
const BARS = 6
/** Radians per second for the idle breathe — DictationMic's 0.16/frame at 30fps. */
const BREATHE_RATE = 4.8

/**
 * The state, as a picture: three sleeping dots, or a live meter.
 *
 * Shared with the floating pill, which shows the same thing at a bigger scale —
 * one rAF loop's worth of code, written once, so the two sizes cannot drift
 * apart the next time the meter is tuned.
 */
export function DictationGlyph({ listening, level }: { listening: boolean; level: number }): ReactNode {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const levelRef = useRef(0)
  levelRef.current = level

  useEffect(() => {
    const bars = barsRef.current
    if (!listening) {
      for (const el of bars) if (el) el.style.transform = ''
      return
    }
    const history = new Array<number>(BARS).fill(0)
    let raf = 0
    let lastShift = 0
    const frame = (t: number): void => {
      if (t - lastShift >= 100) {
        lastShift = t
        history.shift()
        history.push(levelRef.current)
      }
      const phase = (t / 1000) * BREATHE_RATE
      for (let i = 0; i < BARS; i++) {
        const breathe = 0.05 + 0.04 * Math.sin(phase * 1.7 + i * 0.7)
        const v = Math.max(breathe, Math.min(1, history[i]! * 1.8))
        const el = bars[i]
        if (el) el.style.transform = `scaleY(${v.toFixed(3)})`
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [listening])

  if (!listening) {
    return (
      <span className="dpill__dots" aria-hidden="true">
        <span className="dpill__dot" />
        <span className="dpill__dot" />
        <span className="dpill__dot" />
      </span>
    )
  }

  return (
    <span className="dpill__meter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className="dpill__bar"
          ref={(el) => {
            barsRef.current[i] = el
          }}
        />
      ))}
    </span>
  )
}

export function DictationPill(): ReactNode {
  const { state, actions } = useApp()
  const { status, needsSetup, listening, toggle } = useDictation()
  const [cardOpen, setCardOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  /** Set by a drag, read by the click that follows it, cleared straight after. */
  const draggedRef = useRef(false)

  // A setup problem that appears while you are trying to use it should show its
  // own explanation rather than make you go hunting for it.
  useEffect(() => {
    if (!needsSetup) setCardOpen(false)
  }, [needsSetup])

  const key = hotkeyLabel(state.settings.sttHotkey)
  const hub = state.settings.voiceHub

  /**
   * Two microphones in one app is the confusion Steve ran into: he could not
   * tell whether his words were being typed into a terminal or handed to the
   * agent. Same rule as useDictation's routing, shown as a word — while an
   * agent surface is open with agent mode on, the pill says so.
   */
  const toAgent = agentSurfaceOpen(state.settings) && state.agentListening

  /**
   * Lift it out.
   *
   * A press that never moves is a click, so the threshold decides which gesture
   * this was; anything past it becomes a drag and the click is swallowed. The
   * live position goes through `hubDrag` rather than the store, because the
   * hub — which does not exist yet at the moment the drag starts — has to pick
   * the gesture up mid-flight without a settings write per frame.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let lifted = false
    draggedRef.current = false

    const posFor = (ev: PointerEvent | React.PointerEvent): { x: number; y: number } =>
      clampHubPos(
        { x: ev.clientX - HUB_PILL_SIZE.w / 2, y: ev.clientY - HUB_PILL_SIZE.h / 2 },
        HUB_PILL_SIZE,
        hubBounds({ w: window.innerWidth, h: window.innerHeight }, { top: 0, bottom: 0 })
      )

    const onMove = (ev: PointerEvent): void => {
      if (!lifted && Math.hypot(ev.clientX - startX, ev.clientY - startY) < HUB_DRAG_THRESHOLD) return
      if (!lifted) {
        lifted = true
        draggedRef.current = true
        document.body.classList.add('is-hub-dragging')
        const pos = posFor(ev)
        hubDrag.set(pos)
        actions.setVoiceHub({ mode: 'floating', ...pos })
        return
      }
      hubDrag.set(posFor(ev))
    }

    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (!lifted) return
      document.body.classList.remove('is-hub-dragging')
      const pos = posFor(ev)
      actions.setVoiceHub({ mode: 'floating', ...pos })
      hubDrag.set(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /**
   * The empty socket.
   *
   * While the hub floats, the status bar keeps the same 50px of space it always
   * had — reflowing the whole right-hand end of the bar every time he picks the
   * pill up would be a worse tell than a dotted outline. Clicking it sends the
   * hub home, which is the escape hatch for a hub dragged somewhere silly.
   */
  if (isFloatingHub(hub.mode)) {
    return (
      <button
        type="button"
        className="dpill dpill--socket"
        data-dock="voice-hub"
        title="The voice hub is floating — click to send it back here"
        aria-label="Send the floating voice hub back to the status bar"
        onClick={() => actions.setVoiceHub({ mode: 'docked' })}
      >
        <span className="dpill__socket-mark" aria-hidden="true" />
      </button>
    )
  }

  const title = needsSetup
    ? `Dictation needs setting up — ${status.error?.msg ?? ''}`
    : toAgent
      ? `Agent mode — what you say goes to the voice agent, not this pane (${key})`
      : status.phase === 'listening'
        ? `Listening — ${key} to stop`
        : status.phase === 'finishing'
          ? 'Finishing the last phrase…'
          : status.phase === 'starting'
            ? 'Loading the speech model…'
            : `Dictate — ${key} · drag me out`

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="dpill"
        data-dock="voice-hub"
        data-phase={status.phase}
        data-setup={needsSetup ? 'true' : undefined}
        data-agent={toAgent ? 'true' : undefined}
        aria-label={title}
        aria-pressed={listening}
        title={title}
        onPointerDown={onPointerDown}
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false
            return
          }
          if (needsSetup) setCardOpen((v) => !v)
          else toggle()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCardOpen((v) => !v)
        }}
      >
        {toAgent ? <span className="dpill__tag">agent</span> : null}
        <DictationGlyph listening={listening} level={status.level} />
      </button>

      <Popover
        anchor={anchorRef.current}
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        align="end"
        side="top"
        width={330}
        label="Dictation setup"
      >
        {/* DictationSetup owns the save + respawn; we just get out of the way.
            The new status arrives on the push channel. */}
        <DictationSetup
          problem={needsSetup ? (status.error?.msg ?? null) : null}
          onRetry={() => setCardOpen(false)}
          compact
        />
      </Popover>
    </>
  )
}

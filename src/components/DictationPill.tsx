import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hotkeyLabel, useDictation } from '@/hooks/useDictation'
import { useApp } from '@/state/AppState'
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
 */

/** Six, not DictationMic's eleven — see the note in DictationPill.css. */
const BARS = 6
/** Radians per second for the idle breathe — DictationMic's 0.16/frame at 30fps. */
const BREATHE_RATE = 4.8

export function DictationPill(): ReactNode {
  const { state } = useApp()
  const { status, needsSetup, listening, toggle } = useDictation()
  const [cardOpen, setCardOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const levelRef = useRef(0)
  levelRef.current = status.level

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

  // A setup problem that appears while you are trying to use it should show its
  // own explanation rather than make you go hunting for it.
  useEffect(() => {
    if (!needsSetup) setCardOpen(false)
  }, [needsSetup])

  const key = hotkeyLabel(state.settings.sttHotkey)
  const title = needsSetup
    ? `Dictation needs setting up — ${status.error?.msg ?? ''}`
    : status.phase === 'listening'
      ? `Listening — ${key} to stop`
      : status.phase === 'finishing'
        ? 'Finishing the last phrase…'
        : status.phase === 'starting'
          ? 'Loading the speech model…'
          : `Dictate — ${key}`

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="dpill"
        data-phase={status.phase}
        data-setup={needsSetup ? 'true' : undefined}
        aria-label={title}
        aria-pressed={listening}
        title={title}
        onClick={() => (needsSetup ? setCardOpen((v) => !v) : toggle())}
        onContextMenu={(e) => {
          e.preventDefault()
          setCardOpen((v) => !v)
        }}
      >
        {listening ? (
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
        ) : (
          <span className="dpill__dots" aria-hidden="true">
            <span className="dpill__dot" />
            <span className="dpill__dot" />
            <span className="dpill__dot" />
          </span>
        )}
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

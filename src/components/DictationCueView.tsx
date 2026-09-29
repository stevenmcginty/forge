import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { reducedMotion } from '@/lib/motion'
import { SynthesizerIndicator } from './hub/SynthesizerIndicator'
import './DictationCue.css'

/**
 * What the Dictate key's dictation looks like where its words are going — the
 * picture only. DictationCue.tsx decides which pane (or the bar, or the window)
 * and when; this draws it, and knows nothing about the app.
 *
 * Every state is a word and a shape, never a colour alone (Steve is red-green
 * colourblind), and the words are big enough to read from arm's length:
 *
 *   starting   an arc turning — round the glyph and round the pane's edge
 *   listening  the voice pill's synthesizer bars, moving with the mic; a solid ring
 *   finishing  three dots settling; the ring goes to dashes
 *   sending    a ring running down with the clock; a bar draining under the words
 */

export type CuePhase = 'starting' | 'listening' | 'finishing' | 'sending'

export interface CueModel {
  phase: CuePhase
  /** The Dictate key, as the settings row names it ("Right Shift"). */
  keyLabel: string
  /** Stopping sends (the countdown, then Enter). Off when Enter already follows every phrase. */
  sends: boolean
  /** When the send countdown ends (sending only). */
  endsAt: number | null
  /** Where the words go, for the strips that are not on the pane itself. */
  into: string | null
}

export type ReadLevels = () => { mic: number; out: number }

/* --------------------------------------------------------------------- glyphs */

const GLYPH_W = 46
const GLYPH_H = 28
const RING_R = 10.5
const RING_C = 2 * Math.PI * RING_R

function Glyph({ cue, readLevels }: { cue: CueModel; readLevels: ReadLevels }): ReactNode {
  return <CueGlyph phase={cue.phase} endsAt={cue.endsAt} readLevels={readLevels} />
}

/**
 * The state as a shape. `small` is the voice bar's size (the chip in the bar);
 * the default is the pane strip's.
 */
export function CueGlyph({
  phase,
  endsAt = null,
  readLevels,
  small = false
}: {
  phase: CuePhase
  endsAt?: number | null
  readLevels: ReadLevels
  small?: boolean
}): ReactNode {
  if (phase === 'listening') {
    return (
      <SynthesizerIndicator
        look="listening"
        readLevels={readLevels}
        width={small ? 30 : GLYPH_W}
        height={small ? 18 : GLYPH_H}
        barWidth={small ? 3 : 4.5}
        barGap={small ? 2.5 : 4}
        className="dcue__synth"
      />
    )
  }
  if (phase === 'finishing') {
    return (
      <span className="dcue__dots" data-small={small ? 'true' : undefined} aria-hidden="true">
        <span className="dcue__dot" />
        <span className="dcue__dot" />
        <span className="dcue__dot" />
      </span>
    )
  }
  const sending = phase === 'sending'
  const size = small ? 18 : GLYPH_H
  return (
    <svg className="dcue__ring" viewBox="0 0 28 28" width={size} height={size} aria-hidden="true">
      <circle className="dcue__ring-track" cx="14" cy="14" r={RING_R} />
      {sending ? (
        <RingDrain key={endsAt ?? 0} endsAt={endsAt} />
      ) : (
        <circle className="dcue__ring-arc" cx="14" cy="14" r={RING_R} strokeDasharray={`${RING_C * 0.28} ${RING_C}`} />
      )}
      {sending ? <path className="dcue__ring-enter" d="M17.5 10.5v4.2h-7m0 0 2.6-2.5m-2.6 2.5 2.6 2.5" /> : null}
    </svg>
  )
}

/**
 * The time left, measured once when the countdown first shows: a re-render
 * must not hand a running CSS animation a new duration, or it jumps.
 */
function useLeftAtMount(endsAt: number | null): number {
  const [left] = useState(() => (endsAt === null ? 0 : Math.max(0, endsAt - Date.now())))
  return left
}

function RingDrain({ endsAt }: { endsAt: number | null }): ReactNode {
  const left = useLeftAtMount(endsAt)
  return (
    <circle
      className="dcue__ring-drain"
      cx="14"
      cy="14"
      r={RING_R}
      strokeDasharray={RING_C}
      style={{ animationDuration: `${left}ms`, ['--dcue-ring-c' as string]: `${RING_C}` }}
    />
  )
}

function Drain({ endsAt }: { endsAt: number | null }): ReactNode {
  const left = useLeftAtMount(endsAt)
  return <span className="dcue__drain" aria-hidden="true" style={{ animationDuration: `${left}ms` }} />
}

/** "1.2 s": what is left of the send countdown. */
function Clock({ to }: { to: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [to])
  return <span className="dcue__clock">{(Math.max(0, to - now) / 1000).toFixed(1)} s</span>
}

function Key({ label }: { label: string }): ReactNode {
  return <kbd className="dcue__key">{label}</kbd>
}

/* ---------------------------------------------------------------------- words */

function Words({ cue }: { cue: CueModel }): ReactNode {
  const key = cue.keyLabel || 'the Dictate key'
  switch (cue.phase) {
    case 'starting':
      return (
        <>
          <span className="dcue__word">Getting the mic ready…</span>
          <span className="dcue__hint dcue__hint--long">talk after the beep</span>
        </>
      )
    case 'listening':
      return (
        <>
          <span className="dcue__word">Listening</span>
          <span className="dcue__hint dcue__hint--long">
            <span className="dcue__dash" aria-hidden="true">
              —
            </span>{' '}
            press <Key label={key} /> to {cue.sends ? 'stop and send' : 'stop'}
          </span>
          <span className="dcue__hint dcue__hint--short">
            <Key label={key} /> {cue.sends ? 'sends' : 'stops'}
          </span>
        </>
      )
    case 'finishing':
      return <span className="dcue__word">Finishing the last words…</span>
    case 'sending':
      return (
        <>
          <span className="dcue__word">
            Sending<span className="dcue__in"> in</span> {cue.endsAt !== null ? <Clock to={cue.endsAt} /> : null}
          </span>
          <span className="dcue__hint dcue__hint--long">
            <span className="dcue__dash" aria-hidden="true">
              —
            </span>{' '}
            <Key label="Esc" /> to undo
          </span>
          <span className="dcue__hint dcue__hint--short">
            <Key label="Esc" /> undoes
          </span>
        </>
      )
  }
}

/**
 * The strip: glyph, the state in words, the way out. Placed by its wrapper —
 * docked under a pane's header, floated by the bar, or across the window.
 */
export const CueStrip = memo(function CueStrip({
  cue,
  readLevels
}: {
  cue: CueModel
  readLevels: ReadLevels
}): ReactNode {
  return (
    <div className="dcue__strip" data-phase={cue.phase} role="status" aria-live="polite">
      <span key={cue.phase} className="dcue__glyph">
        <Glyph cue={cue} readLevels={readLevels} />
      </span>
      <span key={`w:${cue.phase}`} className="dcue__words">
        <Words cue={cue} />
      </span>
      {cue.into ? <span className="dcue__into">{cue.into}</span> : null}
      {cue.phase === 'sending' ? <Drain key={cue.endsAt ?? 0} endsAt={cue.endsAt} /> : null}
    </div>
  )
})

/**
 * The whole pane, dictating: a ring round its edge, a wash over the terminal
 * and the strip under its header. `closing` plays it out.
 *
 * While listening, the ring's inner glow swells with the voice — written to a
 * custom property from a rAF loop, never through React state.
 */
export function PaneCue({
  cue,
  closing,
  readLevels
}: {
  cue: CueModel
  closing: boolean
  readLevels: ReadLevels
}): ReactNode {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const readRef = useRef(readLevels)
  readRef.current = readLevels
  const live = cue.phase === 'listening' && !closing

  useEffect(() => {
    const el = frameRef.current
    if (!el || !live || reducedMotion()) return undefined
    let v = 0
    let raf = 0
    const frame = (): void => {
      v += (Math.min(1, readRef.current().mic * 1.6) - v) * 0.16
      el.style.setProperty('--dcue-lvl', v.toFixed(3))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      el.style.removeProperty('--dcue-lvl')
    }
  }, [live])

  return (
    <div className="dcue" data-phase={cue.phase} data-closing={closing ? 'true' : undefined}>
      <div ref={frameRef} className="dcue__frame" aria-hidden="true" />
      <CueStrip cue={cue} readLevels={readLevels} />
    </div>
  )
}

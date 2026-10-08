import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { DictationEdge } from '@/components/DictationEdge'
import type { CuePhase } from '@/components/DictationCueView'
import { flash, type SentBy } from '@/lib/paneSent'

/**
 * The big bar's live cues, on the mini bar (docs/MINI-BAR.md, 4.4): the same
 * DictationEdge synthesizer round the bar's outline and the same "sent" flash
 * (src/lib/paneSent.ts, DictationCue.css), so talking to an agent from the
 * desktop looks the way it does inside Forge.
 *
 * One cue at a time, as in Composer: the agent's lime while Listen is on, else
 * dictation's violet from Listening through Writing to the send countdown.
 * The levels are the host's, at its ~10 Hz publish rate — the rate the edge
 * eases its level reports over anyway.
 */

export interface BarEdge {
  variant: 'agent' | 'dictation'
  phase: CuePhase
  feed: 'mic' | 'out'
}

/** Which voice the bar's edge carries now, as Composer picks it (agent wins). */
export function barEdge(state: MiniBarState): BarEdge | null {
  const { listen, dictation: d } = state
  if (listen.on) {
    if (listen.muted) return { variant: 'agent', phase: 'finishing', feed: 'mic' }
    return { variant: 'agent', phase: 'listening', feed: listen.speaking ? 'out' : 'mic' }
  }
  if (d.phase === 'listening') return { variant: 'dictation', phase: 'listening', feed: 'mic' }
  if (d.phase === 'writing') return { variant: 'dictation', phase: 'finishing', feed: 'mic' }
  if (d.phase === 'sending') return { variant: 'dictation', phase: 'sending', feed: 'mic' }
  return null
}

/** Leaving the countdown this close to its end is the send, not an Undo (publishes are ~100 ms apart). */
const SEND_SLACK_MS = 300

/** Flash the bar's edge: words just went from it. `from` is any element inside the bar. */
export function flashBarSent(from: Element | null, by: SentBy = 'dictation'): void {
  const ring = from?.closest('.mb-bar')?.querySelector<HTMLElement>(':scope > .mb-sent')
  if (!ring) return
  try {
    flash(ring, by)
  } catch {
    /* a flash is decoration: never let it break a send */
  }
}

/** Laid inside `.mb-bar` (the edge measures its parent): the edge canvas and the sent ring. */
export function BarCues({ state, edge }: { state: MiniBarState; edge: BarEdge | null }): ReactNode {
  const d = state.dictation
  const level = useRef({ mic: 0, out: 0 })
  level.current = { mic: d.phase === 'listening' ? Math.max(0, Math.min(1, d.level ?? 0)) : 0, out: 0 }
  const readLevels = useCallback(() => level.current, [])

  // The countdown's end, fixed when Sending starts; later publishes do not move it.
  const sendEnd = useRef<number | null>(null)
  if (d.phase === 'sending' && sendEnd.current === null) sendEnd.current = Date.now() + Math.max(0, d.sendInMs ?? 0)

  // Dictated words that leave the countdown at its end were sent: the same flash as a typed send.
  const ring = useRef<HTMLSpanElement | null>(null)
  const was = useRef(d.phase)
  useEffect(() => {
    const before = was.current
    was.current = d.phase
    if (before !== 'sending' || d.phase === 'sending') return
    const end = sendEnd.current
    sendEnd.current = null
    if (end !== null && Date.now() >= end - SEND_SLACK_MS && ring.current) flash(ring.current, 'dictation')
  }, [d.phase])

  return (
    <>
      {edge?.variant === 'agent' ? (
        <DictationEdge key="agent" variant="agent" phase={edge.phase} feed={edge.feed} readLevels={readLevels} />
      ) : (
        <DictationEdge
          key="dictation"
          phase={edge?.phase ?? null}
          endsAt={edge?.phase === 'sending' ? sendEnd.current : null}
          readLevels={readLevels}
        />
      )}
      <span ref={ring} className="mb-sent" aria-hidden="true" />
    </>
  )
}

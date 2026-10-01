import type { ReactNode } from 'react'
import type { VoiceState } from '../lib/dictate'
import { DictationEdge, type CuePhase } from './DictationEdge'
import { useDeckDictation } from './dictation'
import { readWebVoiceLevels, useWebVoiceCore } from './voiceAgent'

/**
 * The deck bar's one moving cue, as the desktop bar has it (src/components/hub/
 * Composer.tsx): the bar's outline becomes a live ribbon, and where the words
 * go a bold "Listening" says the state.
 *
 *   dictation  (D, or the bar's mic) violet, from the press through the words
 *              to the send countdown draining it away, fed by this browser's
 *              own microphone
 *   agent      (Listen) the lesser edge: lime, half the height, slower, fed
 *              by the voice agent's microphone while it hears you and by its
 *              voice while it speaks
 *
 * One at a time. Dictation wins: while D records, Listen's microphone is held
 * shut (DeckKeys), so the agent is not the one being heard. The agent's edge
 * only goes on the docked bar (`docked`); the floating card up top is hidden
 * most of the time, and a hidden edge would still be drawing.
 *
 * Nothing here runs at rest: with no phase the canvas fades out and its loop
 * stops, and the word is not in the page.
 *
 * Rendered inside the bar's card (Composer's `edge`), so the canvas is placed
 * against the card and the word takes the words' own grid cell.
 */
export function DeckBarCue({
  voice,
  readMic,
  docked,
  keyName
}: {
  /** The box's own dictation (SessionComposer), which D runs. */
  voice: VoiceState
  /** The open microphone's level, 0..1 — lib/voice-level.ts. */
  readMic: () => number
  docked: boolean
  /** D's key, named in the hint ("Right Alt"). */
  keyName?: string
}): ReactNode {
  const opening = useDeckDictation() === 'starting'
  // The phase only: a caption growing word by word does not redraw the edge's host.
  const agent = useWebVoiceCore()

  const dictation: CuePhase | null =
    voice.phase === 'recording'
      ? 'listening'
      : voice.phase === 'transcribing'
        ? 'finishing'
        : voice.phase === 'review'
          ? 'sending'
          : opening
            ? 'starting'
            : null

  const agentCue: { phase: CuePhase; feed: 'mic' | 'out' } | null =
    dictation || !docked
      ? null
      : agent.phase === 'connecting'
        ? { phase: 'starting', feed: 'mic' }
        : agent.phase === 'listening' && !agent.muted
          ? { phase: 'listening', feed: 'mic' }
          : agent.phase === 'speaking'
            ? { phase: 'listening', feed: 'out' }
            : agent.phase === 'thinking' || agent.phase === 'listening'
              ? { phase: 'finishing', feed: 'mic' }
              : null

  const word =
    dictation === 'starting'
      ? 'Opening the mic'
      : dictation === 'listening'
        ? 'Listening'
        : dictation === 'finishing'
          ? 'Writing it down'
          : null

  return (
    <>
      {agentCue ? (
        <DictationEdge key="agent" variant="agent" phase={agentCue.phase} feed={agentCue.feed} readLevels={readWebVoiceLevels} />
      ) : (
        <DictationEdge
          key="dictation"
          phase={dictation}
          endsAt={voice.phase === 'review' ? voice.endsAt : null}
          readLevels={() => ({ mic: readMic(), out: 0 })}
        />
      )}
      {word ? (
        // Where the placeholder was, while the box is empty (voicebar.css hides
        // it once there are words). The screen reader has the panel's status.
        <span className="dk-micword" data-phase={dictation ?? undefined} aria-hidden="true">
          <span className="dk-micword__word">{word}</span>
          {dictation === 'listening' ? (
            <span className="dk-micword__hint">
              <span aria-hidden="true">—</span>
              {keyName ? <kbd className="dk-micword__key">{keyName}</kbd> : null}
              {keyName ? 'or the mic to stop and send' : 'the mic to stop and send'}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

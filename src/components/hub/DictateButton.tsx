import type { ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { useDictation } from '@/state/Dictation'
import { useApp } from '@/state/AppState'
import { listenState, useHubPreview, useHubView } from './hubView'
import './DictateButton.css'

/**
 * D: raw dictation, one press. It is the Dictate key (Right Ctrl by default)
 * as a button — `dictation.toggle` is the same intent the key sends
 * (useDictation's applyIntent('toggle')), so the words land wherever the key
 * would put them: the focused pane, or the text field that had focus. The press
 * never takes focus itself (mousedown is prevented), so "wherever had focus"
 * is still wherever you were.
 *
 * Its state is a word and a shape, never only a colour: "D" idle, "● Rec"
 * while recording, "◌ Transcribing" while the last phrase is being written.
 */
export function DictateButton(): ReactNode {
  const { state } = useApp()
  const dictation = useDictation()
  const hub = useHubView()
  const preview = useHubPreview()
  const ls = listenState(hub)
  const key = hotkeyLabel(state.settings.sttHotkey || 'ControlRight')

  // The Dictate key's own session — the agent shares the sidecar (as in Composer).
  const own = !state.agentListening && !ls.on
  const phase = dictation.status.phase
  const recording = (preview?.dictating ?? dictation.listening) && own
  const transcribing = !recording && own && phase === 'finishing'
  const starting = !recording && own && phase === 'starting'
  const failed = phase === 'error'

  const look = recording ? 'rec' : transcribing ? 'busy' : starting ? 'starting' : failed ? 'error' : 'idle'
  const title = recording
    ? `Recording — press again or ${key} to stop; the words go where you were typing`
    : transcribing
      ? 'Transcribing the last phrase…'
      : failed
        ? `Dictation hit a problem: ${dictation.status.error?.msg ?? 'see Settings → Voice'}. Press to try again (${key})`
        : starting
          ? `Dictate (${key}) — the speech engine is warming up`
          : `Dictate (${key}) — raw words into whatever has focus, no agent`

  return (
    <button
      type="button"
      className="dict"
      data-look={look}
      aria-pressed={recording}
      aria-label={recording ? 'Stop dictating' : 'Dictate'}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => dictation.toggle()}
    >
      {recording ? (
        <>
          <span className="dict__dot" aria-hidden="true">
            ●
          </span>
          Rec
        </>
      ) : transcribing ? (
        <>
          <span className="dict__spin" aria-hidden="true">
            ◌
          </span>
          Transcribing
        </>
      ) : failed ? (
        <>
          D<span className="dict__bang" aria-hidden="true">!</span>
        </>
      ) : (
        <>D{starting ? <span aria-hidden="true">…</span> : null}</>
      )}
    </button>
  )
}

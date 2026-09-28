import type { ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { useBarDictationPhase } from '@/lib/barDictation'
import { useDictation } from '@/state/Dictation'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { listenState, useHubPreview, useHubView } from './hubView'
import './DictateButton.css'

/** What the button does once there are words in the bar: the bar's Enter. */
export type DictateSend = { label: string; title: string; onSend: () => void }

/**
 * The bar's end button: dictation while the bar is empty, Send once it has
 * words — as on Forge Web and Forge Mobile.
 *
 * As the mic it is the phone's mic (src/lib/barDictation.ts): press, talk,
 * press again. The words land in the bar's own box, wait "Sending… 1.5 s"
 * with Undo (Esc undoes too), then send as the bar's Enter would — to Forge or
 * to the pane the bar aims at. The speech engine is the desktop's own, the one
 * Settings picks. The Dictate key (Right Alt by default) is not this: it types
 * raw words into whatever has focus. The press never takes focus itself
 * (mousedown is prevented). While a dictation runs it stays the mic, whatever
 * the bar holds, so it can always stop it.
 *
 * The press that stops decides. A key dictation stopped here is sent — the
 * same countdown and Undo, then Enter where its words went; stopped with the
 * key it stays raw.
 *
 * Every state is its own shape, never only a colour: a mic to start, a stop
 * square while it records, an arc turning while it transcribes, a mic with a
 * "!" when dictation failed, an arrow to send.
 */
export function DictateButton({ send = null }: { send?: DictateSend | null }): ReactNode {
  const { state } = useApp()
  const dictation = useDictation()
  const hub = useHubView()
  const preview = useHubPreview()
  const intoBar = useBarDictationPhase() !== 'off'
  const ls = listenState(hub)
  const key = hotkeyLabel(state.settings.sttHotkey || 'AltRight')

  // The Dictate key's own session — the agent shares the sidecar (as in Composer).
  const own = !state.agentListening && !ls.on
  const phase = dictation.status.phase
  const recording = (preview?.dictating ?? dictation.listening) && own
  const transcribing = !recording && own && phase === 'finishing'
  const starting = !recording && own && phase === 'starting'
  const failed = phase === 'error'
  const sending = send !== null && !recording && !transcribing

  const look = sending
    ? 'send'
    : recording
      ? 'rec'
      : transcribing
        ? 'busy'
        : failed
          ? 'error'
          : starting
            ? 'starting'
            : 'idle'
  // The glyph remounts (and pops in) only when its shape changes.
  const shape = look === 'error' || look === 'starting' ? 'idle' : look

  const title = sending
    ? send.title
    : recording
      ? intoBar
        ? 'Recording — press again to stop; the words go into the bar, then send'
        : `Recording — press to stop and send; ${key} stops without sending`
      : transcribing
        ? 'Transcribing the last phrase…'
        : failed
          ? `Dictation hit a problem: ${dictation.status.error?.msg ?? 'see Settings → Voice'}. Press to try again`
          : starting
            ? 'Dictate — the speech engine is warming up'
            : `Dictate — press, talk, press again; the words go into the bar and send after a moment. ${key} types raw words into whatever has focus`

  const label = sending
    ? send.label
    : recording
      ? intoBar
        ? 'Stop dictating'
        : 'Stop and send'
      : transcribing
        ? 'Transcribing'
        : 'Dictate'

  return (
    <button
      type="button"
      className="dict"
      data-look={look}
      aria-pressed={sending ? undefined : recording}
      aria-label={label}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (sending ? send.onSend() : dictation.dictateIntoBar())}
    >
      <span key={shape} className="dict__glyph" aria-hidden="true">
        {look === 'send' ? (
          <Icon name="send" size={17} />
        ) : look === 'rec' ? (
          <span className="dict__stop" />
        ) : look === 'busy' ? (
          <svg className="dict__turn" width="16" height="16" viewBox="0 0 18 18">
            <path d="M9 2.5A6.5 6.5 0 1 1 2.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <Icon name="mic" size={18} />
        )}
      </span>
      {look === 'error' ? (
        <span className="dict__bang" aria-hidden="true">
          !
        </span>
      ) : null}
    </button>
  )
}

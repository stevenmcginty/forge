import type { ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
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
 * As the mic it is the Dictate key (Right Alt by default) as a button —
 * `dictation.toggle` is the same intent the key sends (useDictation's
 * applyIntent('toggle')), so the words land wherever the key would put them:
 * the focused pane, or the text field that had focus. The press never takes
 * focus itself (mousedown is prevented), so "wherever had focus" is still
 * wherever you were. While a dictation runs it stays the mic, whatever the bar
 * holds, so the press that started it is the press that stops it.
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
      ? `Recording — press again or ${key} to stop; the words go where you were typing`
      : transcribing
        ? 'Transcribing the last phrase…'
        : failed
          ? `Dictation hit a problem: ${dictation.status.error?.msg ?? 'see Settings → Voice'}. Press to try again (${key})`
          : starting
            ? `Dictate (${key}) — the speech engine is warming up`
            : `Dictate (${key}) — raw words into whatever has focus, no agent`

  const label = sending
    ? send.label
    : recording
      ? `Stop dictating (${key})`
      : transcribing
        ? 'Transcribing'
        : `Dictate (${key})`

  return (
    <button
      type="button"
      className="dict"
      data-look={look}
      aria-pressed={sending ? undefined : recording}
      aria-label={label}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (sending ? send.onSend() : dictation.toggle())}
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

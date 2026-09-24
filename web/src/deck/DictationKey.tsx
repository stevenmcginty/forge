import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { TALK_KEY_RULE } from '@/lib/keymap'
import { recordKeyDown, recordKeyUp, type HeldKey } from '../lib/talk-key'
import {
  DEFAULT_DICTATION_KEY,
  dictationKeyName,
  setDictationKey,
  suspendDictationKey,
  useDictationKey
} from './dictation-key'

/**
 * "Dictation key: Right Alt [Change]" — D's key in this browser, in the "…"
 * menu. Change opens a field that records ONE key on its own, the desktop's
 * rule for a voice key: a Ctrl, Shift, Alt or Win key (left and right are
 * different), F1–F24, Scroll Lock or Pause. Right Alt on a UK layout records
 * as Right Alt, not as the Left Ctrl Windows sends first. Esc gives up.
 */
export function DictationKeySetting(): ReactNode {
  const key = useDictationKey()
  const [recording, setRecording] = useState(false)
  const changeRef = useRef<HTMLButtonElement | null>(null)

  const finish = (next: string | null): void => {
    if (next) setDictationKey(next)
    setRecording(false)
    // Back to the button, so the keyboard is where it was.
    window.requestAnimationFrame(() => changeRef.current?.focus())
  }

  return (
    <div className="dk-menu__section dk-dkey">
      <span className="dk-menu__eyebrow">Dictation · this browser</span>
      {recording ? (
        <DictationKeyRecorder was={key} onRecord={(code) => finish(code)} onCancel={() => finish(null)} />
      ) : (
        <div className="dk-dkey__row">
          <span className="dk-dkey__label">Dictation key:</span>
          <kbd className="dk-dkey__cap">{dictationKeyName(key)}</kbd>
          <span className="dk-dkey__acts">
            {key !== DEFAULT_DICTATION_KEY ? (
              <button
                type="button"
                className="dk-dkey__btn"
                title={`Back to ${dictationKeyName(DEFAULT_DICTATION_KEY)}`}
                onClick={() => setDictationKey(DEFAULT_DICTATION_KEY)}
              >
                Reset
              </button>
            ) : null}
            <button
              ref={changeRef}
              type="button"
              className="dk-dkey__btn"
              aria-label={`Change the dictation key, now ${dictationKeyName(key)}`}
              onClick={() => setRecording(true)}
            >
              Change
            </button>
          </span>
        </div>
      )}
      {recording ? null : <span className="dk-dkey__hint">Tap to start or stop · hold to talk · Esc cancels</span>}
    </div>
  )
}

/** The field that listens for the new key. D's key and the deck's other keys stand down while it is up. */
function DictationKeyRecorder({
  was,
  onRecord,
  onCancel
}: {
  was: string
  onRecord: (code: string) => void
  onCancel: () => void
}): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null)
  const held = useRef<HeldKey | null>(null)
  const [showing, setShowing] = useState('')
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    const release = suspendDictationKey()
    ref.current?.focus()
    return release
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      onCancel()
      return
    }
    const step = recordKeyDown(held.current, e)
    held.current = step.held
    if (step.key) {
      setRefused(false)
      onRecord(step.key)
      return
    }
    if (step.refused) {
      setRefused(true)
      return
    }
    if (step.held) setShowing(dictationKeyName(step.held.code))
  }

  const onKeyUp = (e: ReactKeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const step = recordKeyUp(held.current, e.code)
    if (step.ignored) return
    held.current = step.held
    if (!step.held) setShowing('')
    if (step.key) {
      setRefused(false)
      onRecord(step.key)
    }
  }

  return (
    <span className="dk-dkey__rec">
      <button
        ref={ref}
        type="button"
        className="dk-dkey__field"
        data-refused={refused ? 'true' : undefined}
        aria-label={`Press the new dictation key. Now ${dictationKeyName(was)}. Esc cancels.`}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onCancel}
      >
        {showing ? (
          <kbd className="dk-dkey__cap">{showing}</kbd>
        ) : (
          <span className="dk-dkey__prompt">Press the new key…</span>
        )}
        {!showing ? <span className="dk-dkey__was">was {dictationKeyName(was)}</span> : null}
      </button>
      {refused ? (
        <span className="dk-dkey__refusal" role="alert">
          <span aria-hidden="true">✕</span> {TALK_KEY_RULE}
        </span>
      ) : (
        <span className="dk-dkey__hint">Esc cancels</span>
      )}
    </span>
  )
}

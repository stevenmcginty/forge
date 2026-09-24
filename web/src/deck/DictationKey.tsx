import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { TALK_KEY_RULE } from '@/lib/keymap'
import { recordKeyDown, recordKeyUp, type HeldKey } from '../lib/talk-key'
import {
  DEFAULT_DICTATION_KEY,
  dictationKeyName,
  setDictationKey,
  suspendDictationKey,
  useDictationKey
} from './dictation-key'
import { COMPOSER_SHORTCUT, LISTEN_KEY, LISTEN_KEY_NAME } from './VoiceBar'

/**
 * "Shortcut keys" — the top of the "…" menu: every key the deck answers to
 * and what it does, one short line each, since the bar's buttons are symbols
 * now. The keys are ./VoiceBar.tsx's DeckKeys; this only names them.
 *
 * D's key is this browser's own, and can be changed here. Change opens a
 * field that records ONE key on its own, the desktop's rule for a voice key: a
 * Ctrl, Shift, Alt or Win key (left and right are different), F1–F24, Scroll
 * Lock or Pause. Right Alt on a UK layout records as Right Alt, not as the
 * Left Ctrl Windows sends first. Esc gives up.
 */
export function ShortcutKeys(): ReactNode {
  const key = useDictationKey()
  const [recording, setRecording] = useState(false)
  const changeRef = useRef<HTMLButtonElement | null>(null)

  const finish = (next: string | null): void => {
    if (next) setDictationKey(next)
    setRecording(false)
    // Back to the button, so the keyboard is where it was.
    window.requestAnimationFrame(() => changeRef.current?.focus())
  }

  // D's key can be Right Shift; then Listen's key stands down (DeckKeys).
  const listenTaken = key === LISTEN_KEY

  return (
    <div className="dk-menu__section dk-keys" role="group" aria-labelledby="dk-keys-title">
      <span className="dk-menu__eyebrow" id="dk-keys-title">
        Shortcut keys · this browser
      </span>
      <dl className="dk-keys__list">
        <KeyRow keys={LISTEN_KEY_NAME}>
          {listenTaken ? 'Voice agent: off — dictation has this key' : 'Voice agent: start or stop talking'}
        </KeyRow>
        {recording ? (
          <div className="dk-keys__rec">
            <dt className="dk-sr">Dictation key</dt>
            <dd>
              <DictationKeyRecorder was={key} onRecord={(code) => finish(code)} onCancel={() => finish(null)} />
            </dd>
          </div>
        ) : (
          <KeyRow keys={dictationKeyName(key)} kind="d">
            Dictate into the pane on screen: tap, or hold to talk
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
                Change key
              </button>
            </span>
          </KeyRow>
        )}
        <KeyRow keys="Esc">Throw a dictation away, or Undo its send</KeyRow>
        <KeyRow keys="Ctrl+G">Wall or full screen</KeyRow>
        <KeyRow keys={COMPOSER_SHORTCUT}>Type box: open, caret in</KeyRow>
      </dl>
    </div>
  )
}

/** One key and its line. A combo is a cap per key, joined by a plus. */
function KeyRow({ keys, kind, children }: { keys: string; kind?: 'd'; children: ReactNode }): ReactNode {
  const parts = keys.split('+')
  return (
    <div className="dk-keys__row" data-kind={kind}>
      <dt className="dk-keys__keys">
        {parts.map((part, i) => (
          <Fragment key={part}>
            {i > 0 ? (
              <span className="dk-keys__plus" aria-hidden="true">
                +
              </span>
            ) : null}
            <kbd className="dk-keys__cap">{part}</kbd>
          </Fragment>
        ))}
      </dt>
      <dd className="dk-keys__what">{children}</dd>
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

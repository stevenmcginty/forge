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
import { DEFAULT_LISTEN_KEY, listenKeyName, setListenKey, useListenKey } from './listen-key'
import { COMPOSER_SHORTCUT } from './VoiceBar'

/**
 * "Shortcut keys" — the top of the "…" menu: every key the deck answers to
 * and what it does, one short line each, since the bar's buttons are symbols
 * now. The keys are ./VoiceBar.tsx's DeckKeys; this only names them.
 *
 * The two voice keys — the voice agent's (Right Alt) and D's (Right Shift) —
 * are this browser's own, and each can be changed here. Change opens a field
 * that records ONE key on its own, the desktop's rule for a voice key: a Ctrl,
 * Shift, Alt or Win key (left and right are different), F1–F24, Scroll Lock or
 * Pause. Right Alt on a UK layout records as Right Alt, not as the Left Ctrl
 * Windows sends first. Esc gives up. The other voice key's key is refused in
 * words, and the field stays up for another: one key does one job.
 */

type Which = 'dictation' | 'listen'

const KEYS: Record<
  Which,
  { label: string; name: (code: string) => string; set: (code: string) => string | null; fallback: string }
> = {
  dictation: { label: 'dictation key', name: dictationKeyName, set: setDictationKey, fallback: DEFAULT_DICTATION_KEY },
  listen: { label: 'voice agent key', name: listenKeyName, set: setListenKey, fallback: DEFAULT_LISTEN_KEY }
}

export function ShortcutKeys(): ReactNode {
  const dKey = useDictationKey()
  const lKey = useListenKey()
  const [recording, setRecording] = useState<Which | null>(null)
  // A Reset the other key refused, in words, under its row.
  const [notice, setNotice] = useState<{ which: Which; text: string } | null>(null)
  const changeRefs = useRef<Record<Which, HTMLButtonElement | null>>({ dictation: null, listen: null })

  /** The recorder's answer: null closes it; a refusal keeps it up and is shown there. */
  const finish = (which: Which, next: string | null): string | null => {
    if (next) {
      const refusal = KEYS[which].set(next)
      if (refusal) return refusal
    }
    setRecording(null)
    setNotice(null)
    // Back to the button, so the keyboard is where it was.
    window.requestAnimationFrame(() => changeRefs.current[which]?.focus())
    return null
  }

  const reset = (which: Which): void => {
    const refusal = KEYS[which].set(KEYS[which].fallback)
    setNotice(refusal ? { which, text: refusal } : null)
  }

  const row = (which: Which, code: string, line: string, kind?: 'd'): ReactNode => {
    const k = KEYS[which]
    if (recording === which) {
      return (
        <div className="dk-keys__rec">
          <dt className="dk-sr">{k.label}</dt>
          <dd>
            <VoiceKeyRecorder
              which={which}
              was={code}
              onRecord={(next) => finish(which, next)}
              onCancel={() => void finish(which, null)}
            />
          </dd>
        </div>
      )
    }
    return (
      <KeyRow keys={k.name(code)} kind={kind}>
        {line}
        <span className="dk-dkey__acts">
          {code !== k.fallback ? (
            <button
              type="button"
              className="dk-dkey__btn"
              title={`Back to ${k.name(k.fallback)}`}
              onClick={() => reset(which)}
            >
              Reset
            </button>
          ) : null}
          <button
            ref={(el) => {
              changeRefs.current[which] = el
            }}
            type="button"
            className="dk-dkey__btn"
            aria-label={`Change the ${k.label}, now ${k.name(code)}`}
            onClick={() => {
              setNotice(null)
              setRecording(which)
            }}
          >
            Change key
          </button>
        </span>
        {notice?.which === which ? (
          <span className="dk-dkey__refusal" role="alert">
            <span aria-hidden="true">✕</span> {notice.text}
          </span>
        ) : null}
      </KeyRow>
    )
  }

  return (
    <div className="dk-menu__section dk-keys" role="group" aria-labelledby="dk-keys-title">
      <span className="dk-menu__eyebrow" id="dk-keys-title">
        Shortcut keys · this browser
      </span>
      <dl className="dk-keys__list">
        {row('listen', lKey, 'Voice agent: start or stop talking')}
        {row('dictation', dKey, 'Dictate into the pane on screen: tap, or hold to talk', 'd')}
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

/**
 * The field that listens for a voice key — D's or the voice agent's. Every
 * deck key stands down while it is up. `onRecord` answers with a refusal (the
 * other voice key's key) to show here, the field staying up; null closes it.
 */
function VoiceKeyRecorder({
  which,
  was,
  onRecord,
  onCancel
}: {
  which: Which
  was: string
  onRecord: (code: string) => string | null
  onCancel: () => void
}): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null)
  const held = useRef<HeldKey | null>(null)
  const [showing, setShowing] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const { label, name } = KEYS[which]

  useEffect(() => {
    const release = suspendDictationKey()
    ref.current?.focus()
    return release
  }, [])

  const record = (code: string): void => {
    setRefusal(onRecord(code))
  }

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
      record(step.key)
      return
    }
    if (step.refused) {
      setRefusal(TALK_KEY_RULE)
      return
    }
    if (step.held) setShowing(name(step.held.code))
  }

  const onKeyUp = (e: ReactKeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const step = recordKeyUp(held.current, e.code)
    if (step.ignored) return
    held.current = step.held
    if (!step.held) setShowing('')
    if (step.key) record(step.key)
  }

  return (
    <span className="dk-dkey__rec">
      <button
        ref={ref}
        type="button"
        className="dk-dkey__field"
        data-refused={refusal ? 'true' : undefined}
        aria-label={`Press the new ${label}. Now ${name(was)}. Esc cancels.`}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onCancel}
      >
        {showing ? (
          <kbd className="dk-dkey__cap">{showing}</kbd>
        ) : (
          <span className="dk-dkey__prompt">Press the new key…</span>
        )}
        {!showing ? <span className="dk-dkey__was">was {name(was)}</span> : null}
      </button>
      {refusal ? (
        <span className="dk-dkey__refusal" role="alert">
          <span aria-hidden="true">✕</span> {refusal}
        </span>
      ) : (
        <span className="dk-dkey__hint">Esc cancels</span>
      )}
    </span>
  )
}

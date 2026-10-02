import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { MAX_SPEECH_KEY_CHARS, WEB_FEATURE_SPEECH_KEY } from '@shared/web'
import { Icon } from '@/components/Icon'
import { useDeskFeature } from '../lib/features'
import { useForge } from '../state'
import './SpeechKeyCard.css'

/**
 * "Turn on dictation": the connected desktop has no speech-to-text key, so the
 * green mic cannot turn speech into words. The card says so and takes a free
 * Groq key pasted on the phone (`speech-key-set`, shared/web.ts); the desktop
 * checks it with Groq before it keeps it.
 *
 * Shown at every open while the desktop says `ready: false`. × closes it until
 * the page loads again; "Don't remind me again" closes it for good on this
 * phone. A dictation that fails for want of a key opens it either way — the
 * person just tried to dictate. A desktop without WEB_FEATURE_SPEECH_KEY never
 * shows it.
 *
 * The key is never kept on the phone: no storage, no draft. It goes to the
 * desktop and the box is cleared.
 */

/** "Don't remind me again" on this phone. */
const OFF_KEY = 'forge.speechKeyReminderOff'

/** Where a free Groq key is made. */
const GROQ_KEYS_URL = 'https://console.groq.com/keys'

/** How long "Saved. Dictation is ready." stays before the card goes. */
const SAVED_MS = 1500

function readOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === '1'
  } catch {
    return false
  }
}

function writeOff(): void {
  try {
    localStorage.setItem(OFF_KEY, '1')
  } catch {
    // Private mode or a full quota: the card is closed for this page load all the same.
  }
}

/*
 * × for this page load, and the "open it now" a failed dictation sends, as
 * module-level facts: the card unmounts with every offline blink, and neither
 * should be forgotten when it comes back.
 */
let closedThisLoad = false
let forced = false
let cardSeq = 0
const cardListeners = new Set<() => void>()

function bump(): void {
  cardSeq += 1
  for (const listener of cardListeners) listener()
}

function subscribeCard(listener: () => void): () => void {
  cardListeners.add(listener)
  return () => cardListeners.delete(listener)
}

function cardSnapshot(): number {
  return cardSeq
}

/**
 * A dictation just failed because the desktop has no speech-to-text key: show
 * the card, even if it was closed or switched off.
 */
export function openSpeechKeyCard(): void {
  forced = true
  bump()
}

/** The card, wired to the connected desktop. Phone only; Workspace mounts it. */
export function SpeechKeyCard(): ReactNode {
  const { state, actions } = useForge()
  const live = state.connection.state === 'live'
  const supported = useDeskFeature(WEB_FEATURE_SPEECH_KEY)
  useSyncExternalStore(subscribeCard, cardSnapshot, cardSnapshot)
  const [ready, setReady] = useState<boolean | null>(null)
  const [off, setOff] = useState(readOff)
  const request = actions.request

  // Ask on each connect. A refusal (an old desktop, a dropped link) shows nothing.
  useEffect(() => {
    if (!live || !supported) return
    let stale = false
    void request({ kind: 'speech-key-status' })
      .then((result) => {
        if (!stale && result.kind === 'speech-key') setReady(result.ready)
      })
      .catch(() => {
        // No answer: no card.
      })
    return () => {
      stale = true
    }
  }, [live, supported, request])

  if (!live || !supported) return null
  if (!forced && (ready !== false || off || closedThisLoad)) return null

  const close = (): void => {
    closedThisLoad = true
    forced = false
    bump()
  }

  return (
    <SpeechKeyCardView
      onSave={async (key) => {
        try {
          const result = await request({ kind: 'speech-key-set', key })
          if (result.kind === 'speech-key' && result.ready) return null
          if (result.kind === 'failed') return result.message
          return 'The desktop did not keep the key. Try again.'
        } catch (err) {
          return err instanceof Error && err.message ? err.message : 'The desktop did not answer. Try again.'
        }
      }}
      onSaved={() => {
        forced = false
        setReady(true)
      }}
      onClose={close}
      onNeverAgain={() => {
        writeOff()
        setOff(true)
        close()
      }}
    />
  )
}

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'saved' } | { kind: 'failed'; why: string }

/**
 * The card itself, with no wire: `onSave` resolves null when the desktop kept
 * the key, or the words to show when it did not. `onSaved` runs once
 * "Saved. Dictation is ready." has been on screen for a moment.
 */
export function SpeechKeyCardView({
  onSave,
  onSaved,
  onClose,
  onNeverAgain
}: {
  onSave: (key: string) => Promise<string | null>
  onSaved: () => void
  onClose: () => void
  onNeverAgain: () => void
}): ReactNode {
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // Through a ref, so a re-built `onSaved` does not restart the moment.
  const savedRef = useRef(onSaved)
  useEffect(() => {
    savedRef.current = onSaved
  }, [onSaved])

  useEffect(() => {
    if (phase.kind !== 'saved') return
    const timer = window.setTimeout(() => savedRef.current(), SAVED_MS)
    return () => window.clearTimeout(timer)
  }, [phase.kind])

  const busy = phase.kind === 'checking' || phase.kind === 'saved'
  const save = (): void => {
    const sent = key.trim()
    if (!sent || busy) return
    // Out of the box the moment it is sent: the key is never kept on this phone.
    setKey('')
    setPhase({ kind: 'checking' })
    void onSave(sent).then((why) => setPhase(why === null ? { kind: 'saved' } : { kind: 'failed', why }))
  }

  return (
    <section className="speechkey" role="dialog" aria-labelledby="speechkey-title" data-testid="speech-key-card">
      <div className="speechkey__head">
        <span className="speechkey__mark" aria-hidden="true">
          <Icon name="mic" size={20} />
        </span>
        <h2 className="speechkey__title" id="speechkey-title">
          Turn on dictation
        </h2>
        <button type="button" className="speechkey__close" aria-label="Close for now" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <p className="speechkey__text">
        The green mic turns your voice into text. It needs a free Groq key. No card needed — sign in with Google.
      </p>
      <a className="speechkey__get" href={GROQ_KEYS_URL} target="_blank" rel="noopener noreferrer">
        Get a free key
        <span aria-hidden="true">↗</span>
      </a>
      <form
        className="speechkey__form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="speechkey__label" htmlFor="speechkey-input">
          Copy the key, come back, paste it here:
        </label>
        <div className="speechkey__row">
          <input
            id="speechkey-input"
            className="speechkey__input"
            type="text"
            value={key}
            maxLength={MAX_SPEECH_KEY_CHARS}
            placeholder="gsk_…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-lpignore="true"
            disabled={busy}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="speechkey__save" disabled={busy || !key.trim()}>
            Save
          </button>
        </div>
      </form>
      {phase.kind === 'idle' ? null : (
        <p className="speechkey__status" data-state={phase.kind} role="status" aria-live="polite">
          {phase.kind === 'checking'
            ? 'Checking the key…'
            : phase.kind === 'saved'
              ? '✓ Saved. Dictation is ready.'
              : `× ${phase.why}`}
        </p>
      )}
      <button type="button" className="speechkey__never" onClick={onNeverAgain}>
        Don&apos;t remind me again
      </button>
    </section>
  )
}

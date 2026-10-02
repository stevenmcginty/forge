import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { WebStatus } from '@shared/types'
import { shouldOpenWhatsNew, whatsNew } from '@/lib/whatsnew'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './Onboarding.css'
import './SpeechKeyPrompt.css'

const GROQ_KEYS_URL = 'https://console.groq.com/keys'
/** How long "Saved. Dictation is ready." stays up before the card goes. */
const SAVED_HOLD_MS = 1500

type Phase = 'idle' | 'checking' | 'saved' | 'error'

/**
 * "Turn on dictation": the phone's green mic needs a speech-to-text key on
 * this computer, and a fresh install has none. Back at every launch until a
 * Groq or Gemini key is set, or until "Don't remind me again".
 *
 * Waits its turn behind the other first-run cards (Onboarding, AccountPrompt,
 * WhatsNew) rather than stacking on top of them. X closes it for this launch
 * only. It closes by itself once a key is saved — here, or from the phone,
 * which reaches state through `voice.onSpeechKeySaved` in AppState.
 *
 * The key goes to main through `voice.saveSpeechKey`, which asks Groq first;
 * nothing here logs it or shows it anywhere but the box it was pasted into.
 */
export function SpeechKeyPrompt(): ReactNode {
  const { state, actions } = useApp()
  const [closed, setClosed] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')
  const [key, setKey] = useState('')
  const [shown, setShown] = useState(false)
  const [web, setWeb] = useState<WebStatus | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // AccountPrompt's own test, so this card can wait until that one is gone.
  useEffect(() => {
    if (!state.ready) return
    void window.forge.web.status().then(setWeb)
    return window.forge.web.onStatus(setWeb)
  }, [state.ready])

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current)
    },
    []
  )

  const s = state.settings
  const notes = whatsNew()
  const notesVersion = notes?.version || state.info?.version || ''
  const accountPromptUp = !s.webAccountPromptDismissed && (web === null || !web.session.signedIn)
  const whatsNewUp = state.whatsNewOpen || shouldOpenWhatsNew(notesVersion, s.lastNotesVersion)
  // A Forge still on an older preload has no way to save from here.
  const canSave = typeof window.forge?.voice?.saveSpeechKey === 'function'
  const needed = !s.speechKeyReminderOff && !s.groqKey?.trim() && !s.geminiKey?.trim()

  const open =
    !closed &&
    canSave &&
    state.ready &&
    s.onboarded &&
    !accountPromptUp &&
    !whatsNewUp &&
    (needed || phase === 'saved')

  const save = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const trimmed = key.trim()
      if (!trimmed || phase === 'checking') return
      setPhase('checking')
      setMessage('Checking the key…')
      let result: { ok: true } | { ok: false; error: string } | undefined
      try {
        result = await window.forge.voice?.saveSpeechKey?.(trimmed)
      } catch {
        result = { ok: false, error: 'Could not check the key. Try again.' }
      }
      if (!result) result = { ok: false, error: 'Could not check the key. Restart Forge and try again.' }
      if (!result.ok) {
        setPhase('error')
        setMessage(result.error)
        return
      }
      setPhase('saved')
      setMessage('Saved. Dictation is ready.')
      setKey('')
      holdTimer.current = setTimeout(() => setClosed(true), SAVED_HOLD_MS)
    },
    [key, phase]
  )

  const stopReminding = useCallback(() => {
    actions.patchSettings({ speechKeyReminderOff: true })
    setClosed(true)
  }, [actions])

  if (!open) return null

  const busy = phase === 'checking' || phase === 'saved'

  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-label="Turn on dictation">
      <div className="onboard__card speechkey">
        <button
          type="button"
          className="ghost-btn onboard__dismiss"
          aria-label="Close for now"
          title="Close for now"
          onClick={() => setClosed(true)}
        >
          <Icon name="close" size={12} />
        </button>
        <header className="onboard__head">
          <div className="onboard__mark">
            <Icon name="mic" size={20} />
          </div>
          <div>
            <div className="eyebrow onboard__eyebrow">Phone dictation</div>
            <h1 className="onboard__title">Turn on dictation</h1>
          </div>
        </header>
        <p className="onboard__lede">
          The green mic on your phone turns your voice into text. It needs a free Groq key on this computer. No card
          needed.
        </p>

        <ol className="onboard__steps">
          <li className="onboard__step">
            <div className="onboard__step-num mono" aria-hidden="true">
              1
            </div>
            <div className="onboard__step-body">
              <h2 className="onboard__step-title">Get a free key</h2>
              <p className="onboard__body">Sign in to Groq with Google or email, then create a key and copy it.</p>
              <button
                type="button"
                className="cta-btn onboard__action"
                onClick={() => void window.forge.openExternal(GROQ_KEYS_URL)}
              >
                Get a free key
              </button>
            </div>
          </li>
          <li className="onboard__step" data-state={phase === 'saved' ? 'done' : undefined}>
            <div className="onboard__step-num mono" aria-hidden="true">
              {phase === 'saved' ? <Icon name="check" size={11} /> : 2}
            </div>
            <div className="onboard__step-body">
              <h2 className="onboard__step-title">Paste it here</h2>
              <form className="onboard__row" onSubmit={(e) => void save(e)}>
                <input
                  className="onboard__input mono"
                  type={shown ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value)
                    if (phase === 'error') setPhase('idle')
                  }}
                  placeholder="gsk_…"
                  aria-label="Groq key"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="ghost-btn onboard__ghost speechkey__show"
                  aria-pressed={shown}
                  onClick={() => setShown((v) => !v)}
                >
                  {shown ? 'Hide' : 'Show'}
                </button>
                <button type="submit" className="cta-btn onboard__action" disabled={busy || !key.trim()}>
                  Save
                </button>
              </form>
              {phase !== 'idle' ? (
                <p className="onboard__note speechkey__status" data-tone={phase} role="status" aria-live="polite">
                  {phase === 'saved' ? <Icon name="check" size={11} /> : null}
                  {message}
                </p>
              ) : null}
            </div>
          </li>
        </ol>

        <footer className="onboard__foot">
          <button type="button" className="onboard__foot-hint" onClick={stopReminding}>
            Don&apos;t remind me again
          </button>
        </footer>
      </div>
    </div>
  )
}

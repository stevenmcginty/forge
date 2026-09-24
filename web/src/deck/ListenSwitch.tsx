import { useRef, useState, type ReactNode } from 'react'
import { Popover } from '@/components/Popover'
import type { VoiceControls } from '../components/Composer'
import type { VoiceState } from '../lib/dictate'
import '@/components/hub/VoicePill.css'

/**
 * Listen, drawn the deck's way — src/components/hub/VoicePill.tsx's markup on
 * VoicePill.css itself, imported rather than copied, so the switch changes when
 * the deck's does. scripts/web-deck-check.mjs fails if a class used here
 * leaves that stylesheet.
 *
 * What it drives is this page's existing dictation and nothing more: record
 * here, the desktop transcribes (`dictate` / `dictate-stream`), the words land
 * in the bar and send after the review beat, exactly as the mic did. The deck's
 * "brain" slot says "Dictation" until the voice agent reaches the browser.
 *
 * Every state is a shape on the knob and a word, colour only agreeing:
 *
 *   off           hollow knob, left        "off"
 *   listening     ● with a ping, lit track "listening"
 *   transcribing  ◆ turning                "transcribing"
 *   sending       ◐ on a hatched track     "sending" — the review beat; a click keeps the words
 *   failed        ! in warn, knob left     "failed" — "Why?" shows the reason
 */
const BRAIN = 'Dictation'

type Look = 'offline' | 'listening' | 'thinking' | 'muted' | 'error'

function lookOf(state: VoiceState, fault: string | null): { look: Look; mark: string; word: string; on: boolean } {
  switch (state.phase) {
    case 'recording':
      return { look: 'listening', mark: 'listening', word: 'listening', on: true }
    case 'transcribing':
      return { look: 'thinking', mark: 'thinking', word: 'transcribing', on: true }
    case 'review':
      return { look: 'muted', mark: 'idle', word: 'sending', on: true }
    case 'idle':
      return fault ? { look: 'error', mark: 'error', word: 'failed', on: false } : { look: 'offline', mark: 'offline', word: 'off', on: false }
  }
}

export function ListenSwitch({
  state,
  controls,
  fault,
  disabled
}: {
  state: VoiceState
  controls: VoiceControls | undefined
  /** Why the last dictation came to nothing, until the next one starts. */
  fault: string | null
  disabled: boolean
}): ReactNode {
  const whyRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const ls = lookOf(state, fault)
  const failed = ls.look === 'error'
  const unavailable = !controls
  const said = `${BRAIN} · ${ls.word}`

  const flip = (): void => {
    if (!controls) return
    if (state.phase === 'recording') controls.stop()
    else if (state.phase === 'transcribing') controls.cancel()
    else if (state.phase === 'review') controls.undo()
    else controls.start()
  }

  const title = unavailable
    ? 'This browser cannot record audio here (it needs a secure page and a microphone).'
    : state.phase === 'recording'
      ? `${said}. Click to stop — the desktop turns it into words in the bar.`
      : state.phase === 'transcribing'
        ? `${said}. Click to cancel — nothing is sent.`
        : state.phase === 'review'
          ? `${said}. The words send in a moment; click to keep them in the bar instead.`
          : failed
            ? `${said}: ${fault}. Click to try again.`
            : `${said}. Click to listen — talk, click again, and the desktop writes it into the bar.`

  // It never takes focus: the bar or the pane you were typing in keeps the keys.
  const noFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <span
      className="listen dk-listen"
      data-on={ls.on ? 'true' : undefined}
      data-look={ls.look}
      data-mark={ls.mark}
      data-recording={state.phase === 'recording' ? 'true' : undefined}
    >
      <button
        type="button"
        role="switch"
        aria-checked={ls.on}
        className="listen__btn"
        title={title}
        aria-label={`Listen: ${ls.on ? 'on' : 'off'} — ${said}`}
        disabled={disabled || unavailable}
        onMouseDown={noFocus}
        onClick={flip}
      >
        <span className="listen__track" aria-hidden="true">
          <span className="listen__knob" />
        </span>
        <span className="listen__text">
          <span className="listen__brain">{BRAIN}</span>
          <span className="listen__word">
            <span className="listen__word-text">{ls.word}</span>
          </span>
        </span>
      </button>

      {failed ? (
        <button
          ref={whyRef}
          type="button"
          className="listen__why"
          aria-expanded={open}
          title="The full reason"
          onMouseDown={noFocus}
          onClick={() => setOpen((v) => !v)}
        >
          Why?
        </button>
      ) : null}

      <Popover
        anchor={whyRef.current}
        open={open && failed}
        onClose={() => setOpen(false)}
        align="start"
        side="top"
        width={340}
        label="Why dictation stopped"
      >
        <div className="vcard" data-look="error">
          <header className="vcard__head">
            <span className="vcard__eyebrow">Forge Web · dictation</span>
            <span className="vcard__brain">{BRAIN}</span>
          </header>
          <p className="vcard__state">
            <span className="vcard__glyph" aria-hidden="true">
              !
            </span>
            failed
          </p>
          <pre className="vcard__raw">{fault ?? 'No more detail than that.'}</pre>
          <div className="vcard__row">
            <button
              type="button"
              className="ghost-btn vcard__btn"
              onMouseDown={noFocus}
              onClick={() => {
                setOpen(false)
                controls?.start()
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </Popover>
    </span>
  )
}

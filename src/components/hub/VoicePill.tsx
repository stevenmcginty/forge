import { useRef, useState, type ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { Popover } from '../Popover'
import { useBarMode } from './barMode'
import { brainWord, errorReason, isLive, useHubPreview, useHubView, voiceState, type DictationLike } from './hubView'
import { Waveform } from './Waveform'
import './VoicePill.css'

/**
 * The dock's voice socket: the main agent's state, in a waveform and words.
 *
 * The eyebrow says who is listening — "Agent · Gemini Live", "Agent · Claude
 * (text)", "Dictate · Parakeet" — and the word says what it is doing, honestly:
 * "listening" only while something is really recording, "mic on · not
 * recording" when the mic is open and nothing is, "starting…" while the
 * recogniser warms up, and on a failure the reason itself ("Gemini: key
 * refused"). Clicking it opens the details: the full error text with Copy,
 * Try again, and the way to Settings.
 *
 * The mode switch itself lives in the bar (Dictate / Agent beside the mic).
 * While the agent is live two chips sit here:
 *
 *   Quiet     the mic off for a moment; the session stays up.
 *   Discuss   talk it through, change nothing — tools that would change Forge
 *             are held as a plan until you say (or press) Go. Realtime only.
 *
 * Nothing here takes focus: every control prevents the mousedown focus move.
 */
export function VoicePill(): ReactNode {
  const { state, actions } = useApp()
  const hub = useHubView()
  const preview = useHubPreview()
  const dictation = useDictation()
  const mode = useBarMode()
  const mainRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const dictating = preview?.dictating ?? dictation.listening
  const d: DictationLike = {
    phase: preview?.dictating ? 'listening' : dictation.status.phase,
    listening: dictating,
    needsSetup: dictation.needsSetup,
    wake: dictation.status.mode === 'wake',
    capturing: dictation.status.capturing
  }
  const vs = voiceState(mode, hub, d)
  const agentLive = mode === 'agent' && isLive(hub.phase) && hub.phase !== 'error'
  const brain = brainWord(hub)
  const planned = hub.actions.filter((a) => a.status === 'planned').length
  const failed = mode === 'agent' && hub.phase === 'error'
  const fullError = failed ? (hub.error ?? '') : mode === 'dictate' && dictation.needsSetup ? (dictation.status.error?.msg ?? '') : ''

  const dictLevel = useRef(0)
  dictLevel.current = preview?.dictating ? (preview.dictationLevel ?? 0.5) : dictation.status.level
  const useHubMeter = mode === 'agent' && isLive(hub.phase) && !dictating

  const key = hotkeyLabel(state.settings.sttHotkey || 'ControlRight')
  const eyebrow = mode === 'agent' ? `Agent · ${brain}` : 'Dictate · Parakeet'
  const title = fullError
    ? `${vs.word} — ${fullError}. Click for details.`
    : mode === 'agent'
      ? `Forge, the main agent (${brain}) — ${vs.word}. Click for details. The mic beside the bar talks to it (or ${key}).`
      : `Dictation (${key}) — ${vs.word}. Click for details. Flip the mic to Agent to talk to Forge (Ctrl+Shift+L).`

  const noFocus = (e: React.MouseEvent): void => e.preventDefault()

  const copy = (): void => {
    void navigator.clipboard?.writeText(fullError).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => undefined
    )
  }

  return (
    <div
      className="vpill"
      data-mode={agentLive ? 'live' : mode}
      data-look={vs.look}
      data-recording={vs.recording ? 'true' : undefined}
    >
      <button
        ref={mainRef}
        type="button"
        className="vpill__main"
        title={title}
        aria-label={title}
        aria-expanded={open}
        onMouseDown={noFocus}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="vpill__wave">
          {useHubMeter ? (
            <Waveform look={vs.look} read={hub.readLevels} width={46} height={22} />
          ) : (
            <Waveform
              look={vs.look}
              read={() => ({ mic: dictLevel.current, out: 0 })}
              width={46}
              height={22}
              strands={2}
            />
          )}
        </span>
        <span className="vpill__text">
          <span className="vpill__eyebrow">{eyebrow}</span>
          <span className="vpill__word">
            <span className="vpill__glyph" aria-hidden="true">
              {vs.glyph}
            </span>
            <span className="vpill__word-text">{vs.word}</span>
          </span>
        </span>
      </button>

      {agentLive ? (
        <span className="vpill__chips">
          <button
            type="button"
            className="vpill__chip"
            data-on={hub.muted ? 'true' : undefined}
            aria-pressed={hub.muted}
            title={hub.muted ? 'Quiet is on — the mic is off. Click to listen again (Ctrl+Shift+M)' : 'Quiet — mic off for a moment, the session stays up (Ctrl+Shift+M)'}
            onMouseDown={noFocus}
            onClick={() => hub.setMuted(!hub.muted)}
          >
            Quiet
          </button>
          {hub.discussionAvailable ? (
            <button
              type="button"
              className="vpill__chip"
              data-on={hub.discussionMode ? 'true' : undefined}
              aria-pressed={hub.discussionMode}
              title={
                hub.discussionMode
                  ? 'Discussing — nothing that changes Forge runs until you say "go"'
                  : 'Discuss — talk it through; actions are held as a plan until you say "go"'
              }
              onMouseDown={noFocus}
              onClick={() => hub.setDiscussionMode(!hub.discussionMode)}
            >
              Discuss
              {hub.discussionMode && planned ? <span className="vpill__count">{planned}</span> : null}
            </button>
          ) : null}
          {hub.discussionMode && planned ? (
            <button
              type="button"
              className="vpill__go"
              title={`Run the ${planned} planned step${planned === 1 ? '' : 's'} now — the same as saying "go"`}
              onMouseDown={noFocus}
              onClick={() => hub.go()}
            >
              Go
            </button>
          ) : null}
        </span>
      ) : null}

      <Popover anchor={mainRef.current} open={open} onClose={() => setOpen(false)} align="end" side="top" width={360} label="Forge voice details">
        <div className="vcard" data-look={vs.look}>
          <header className="vcard__head">
            <span className="vcard__eyebrow">{mode === 'agent' ? 'Forge · the main agent' : 'Dictation'}</span>
            <span className="vcard__brain">{mode === 'agent' ? brain : `Parakeet · ${key}`}</span>
          </header>
          <p className="vcard__state">
            <span className="vcard__glyph" aria-hidden="true">
              {vs.glyph}
            </span>
            {failed ? (hub.errorReason ?? errorReason(hub.provider, hub.error, hub.brainLabel)) : vs.word}
          </p>
          {fullError ? (
            <div className="vcard__error" role="alert">
              <pre className="vcard__raw">{fullError}</pre>
              <div className="vcard__row">
                <button type="button" className="ghost-btn vcard__btn" onMouseDown={noFocus} onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {failed ? (
                  <button
                    type="button"
                    className="ghost-btn vcard__btn"
                    onMouseDown={noFocus}
                    onClick={() => {
                      setOpen(false)
                      hub.start()
                    }}
                  >
                    Try again
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost-btn vcard__btn"
                  onMouseDown={noFocus}
                  onClick={() => {
                    setOpen(false)
                    actions.openSettings('voice')
                  }}
                >
                  Settings
                </button>
              </div>
            </div>
          ) : null}
          {mode === 'agent' && !fullError && (hub.fallbackReason || hub.notice) ? (
            <p className="vcard__note">
              <span aria-hidden="true">◆</span> {hub.fallbackReason ?? hub.notice}
            </p>
          ) : null}
          <p className="vcard__hint">
            {mode === 'agent'
              ? `The mic in the bar talks to Forge; it can open panes, type into them and help with a prompt. Ctrl+Shift+L flips the mic to Dictate.`
              : `The mic in the bar types your words straight in. Ctrl+Shift+L flips it to Agent, so Forge hears you instead.`}
          </p>
          {mode === 'agent' && !fullError ? (
            <div className="vcard__row">
              <button
                type="button"
                className="ghost-btn vcard__btn"
                onMouseDown={noFocus}
                onClick={() => {
                  setOpen(false)
                  hub.toggle()
                }}
              >
                {agentLive ? 'Stop listening' : 'Start listening'}
              </button>
              <button
                type="button"
                className="ghost-btn vcard__btn"
                onMouseDown={noFocus}
                onClick={() => {
                  setOpen(false)
                  actions.openSettings('voice')
                }}
              >
                Settings
              </button>
            </div>
          ) : null}
        </div>
      </Popover>
    </div>
  )
}

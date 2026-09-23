import { useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { formatCombo } from '@/lib/keymap'
import { TALK_AGENT_ID } from '@/lib/shortcutCommands'
import { useApp } from '@/state/AppState'
import { Popover } from '../Popover'
import { listenState, useHubView } from './hubView'
import { Waveform } from './Waveform'
import './VoicePill.css'

/**
 * Listen — the one voice control, inside the bar.
 *
 * Off or on, nothing else. On is a hands-free conversation with the main
 * agent: it hears you, sends when you pause, answers, and listens again. The
 * switch says so by shape (the knob moves across) as well as by words: the
 * brain's name ("Gemini Live") and what it is doing ("listening", "thinking…",
 * "mic on · not recording", "key refused"), read live from the hub. Right
 * Shift flips the same switch, so the knob follows a start made from the key.
 *
 * A failure keeps its reason in the word; "Why?" beside it opens the full
 * text with Copy, Try again and Settings.
 *
 * It never takes focus: the pane or the bar you were typing in keeps the keys.
 */
export function ListenToggle(): ReactNode {
  const { actions } = useApp()
  const hub = useHubView()
  const km = useKeymap()
  const ls = listenState(hub)
  const whyRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const failed = hub.phase === 'error'
  const brain = hub.brainLabel
  const agentKey = km.commands.find((c) => c.id === TALK_AGENT_ID)?.keys[0] ?? null
  const keyWord = agentKey ? ` (${formatCombo(agentKey)})` : ''
  const said = `${brain} · ${ls.word}`
  const title = failed
    ? `${said}. Click to try again${keyWord}; "Why?" shows the full reason.`
    : ls.on
      ? `${said}. Click to stop listening${keyWord}.`
      : `${said}. Click to listen — talk to Forge hands-free: it sends when you pause and answers${keyWord}.`

  const noFocus = (e: React.MouseEvent): void => e.preventDefault()

  const copy = (): void => {
    void navigator.clipboard?.writeText(hub.error ?? '').then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => undefined
    )
  }

  return (
    <span className="listen" data-on={ls.on ? 'true' : undefined} data-look={ls.look} data-recording={ls.recording ? 'true' : undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={ls.on}
        className="listen__btn"
        title={title}
        aria-label={`Listen: ${ls.on ? 'on' : 'off'} — ${said}`}
        onMouseDown={noFocus}
        onClick={() => (ls.on ? hub.stop() : hub.start())}
      >
        <span className="listen__track" aria-hidden="true">
          <span className="listen__knob" />
        </span>
        <span className="listen__text">
          <span className="listen__brain">{brain}</span>
          <span className="listen__word">
            <span className="listen__glyph" aria-hidden="true">
              {ls.glyph}
            </span>
            <span className="listen__word-text">{ls.word}</span>
          </span>
        </span>
        {ls.on ? (
          <span className="listen__wave" aria-hidden="true">
            <Waveform look={ls.look} read={hub.readLevels} width={30} height={18} strands={2} />
          </span>
        ) : null}
      </button>

      {failed ? (
        <button
          ref={whyRef}
          type="button"
          className="listen__why"
          aria-expanded={open}
          title="The full reason, with Copy"
          onMouseDown={noFocus}
          onClick={() => setOpen((v) => !v)}
        >
          Why?
        </button>
      ) : null}

      <Popover anchor={whyRef.current} open={open && failed} onClose={() => setOpen(false)} align="start" side="top" width={360} label="Why the main agent stopped">
        <div className="vcard" data-look="error">
          <header className="vcard__head">
            <span className="vcard__eyebrow">Forge · the main agent</span>
            <span className="vcard__brain">{brain}</span>
          </header>
          <p className="vcard__state">
            <span className="vcard__glyph" aria-hidden="true">
              !
            </span>
            {ls.word}
          </p>
          <pre className="vcard__raw">{hub.error ?? 'No more detail than that.'}</pre>
          <div className="vcard__row">
            <button type="button" className="ghost-btn vcard__btn" onMouseDown={noFocus} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
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
      </Popover>
    </span>
  )
}

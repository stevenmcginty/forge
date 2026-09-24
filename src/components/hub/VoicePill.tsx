import { useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { formatCombo } from '@/lib/keymap'
import { TALK_AGENT_ID } from '@/lib/shortcutCommands'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Popover } from '../Popover'
import { listenState, useHubView } from './hubView'
import { SynthesizerIndicator } from './SynthesizerIndicator'
import './VoicePill.css'

/**
 * ListenToggle — the microphone half of the cohesive on/off microphone button.
 *
 * Toggles hands-free listening on/off for Forge's voice agent. Features a built-in
 * synthesizer indicator showing live audio levels and state dynamics in real time.
 *
 * Click toggles listening (Right Shift shortcut).
 * The button never steals focus from the active pane or typing box.
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
    ? `${said}. Click to try again${keyWord}; click "!" for details.`
    : ls.on
      ? `${said}. Click to stop listening${keyWord}.`
      : `${said}. Click to listen — talk to Forge hands-free${keyWord}.`

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
    <span
      className="listen"
      data-on={ls.on ? 'true' : undefined}
      data-look={ls.look}
      data-recording={ls.recording ? 'true' : undefined}
    >
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
        <span className="listen__mic-wrap" aria-hidden="true">
          <Icon name="mic" size={15} className="listen__mic-icon" />
        </span>
        <SynthesizerIndicator
          look={ls.look}
          readLevels={hub.readLevels}
          width={24}
          height={14}
          className="listen__synth"
        />
      </button>

      {failed ? (
        <button
          ref={whyRef}
          type="button"
          className="listen__why"
          aria-expanded={open}
          title="The full reason, with Copy"
          aria-label="Why listening stopped — view details"
          onMouseDown={noFocus}
          onClick={() => setOpen((v) => !v)}
        >
          !
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

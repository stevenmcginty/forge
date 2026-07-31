import { useEffect, useRef, useState } from 'react'
import type { MobileSession } from '@shared/mobile'
import type { Link } from '../lib/link'
import { mountTerm, onViewportSettled, type TermHost } from '../lib/term'
import { KeyBar } from './KeyBar'

/**
 * One terminal, full screen.
 *
 * The pane owns its xterm and its subscription, and tears both down when it
 * unmounts — so switching panes is genuinely switching, not stacking hidden
 * terminals up until the phone runs out of memory.
 *
 * Replay is why this works away from the desk: the desktop answers every `sub`
 * with its 192KB catch-up buffer, so the first thing painted is the screen as
 * it actually is, not an empty box waiting for the next keystroke.
 *
 * The key bar is raised from the header rather than always present — see
 * KEYBAR_PREF below. The compose row still lives inside it, so opening the keys
 * is also how you reach "type a line and send it".
 */

export interface PaneViewProps {
  link: Link
  session: MobileSession
  title: string
  fontSize: number
  onBack: () => void
}

/**
 * Whether the key bar is up, remembered across screens and launches.
 *
 * Off by default. The bar exists because a phone keyboard has no Esc, Tab, Ctrl
 * or arrows — but most of the time you are reading an agent's output, not
 * sending control codes, and two rows of keys is a third of a phone screen spent
 * on something you are not using. So it is a thing you raise when you need it.
 */
const KEYBAR_PREF = 'forge.keybar'

function keybarWanted(): boolean {
  try {
    return localStorage.getItem(KEYBAR_PREF) === 'on'
  } catch {
    // Private mode / storage disabled. The default is the honest answer.
    return false
  }
}

export function PaneView({ link, session, title, fontSize, onBack }: PaneViewProps): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const host = useRef<TermHost | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [keys, setKeys] = useState(keybarWanted)

  useEffect(() => {
    const container = holder.current
    if (!container) return

    const term = mountTerm(container, {
      fontSize,
      onData: (data) => link.write(session.id, data),
      onResize: (cols, rows) => link.resize(session.id, cols, rows)
    })
    host.current = term
    term.fit()

    // A replay frame is the whole screen, so the terminal is cleared before it
    // is painted. Without the reset, a reconnect stacks a second copy of the
    // scrollback underneath the first.
    const off = linkSubscribe(link, session.id, (data, replay) => {
      if (replay) term.reset()
      term.write(data)
    })

    // The soft keyboard is the most common resize this app will ever see.
    const offViewport = onViewportSettled(() => term.fit())

    return () => {
      off()
      offViewport()
      term.dispose()
      host.current = null
    }
  }, [link, session.id, fontSize])

  // Raising or dropping the bar changes the terminal's height by two rows'
  // worth, so the PTY has to be told — otherwise the shell keeps drawing to a
  // geometry that is no longer on screen.
  useEffect(() => {
    host.current?.fit()
  }, [keys, composing])

  const toggleKeys = (): void => {
    setKeys((on) => {
      const next = !on
      try {
        localStorage.setItem(KEYBAR_PREF, next ? 'on' : 'off')
      } catch {
        /* the preference is a convenience, not a requirement */
      }
      return next
    })
  }

  const send = (data: string): void => {
    link.write(session.id, data)
    host.current?.focus()
  }

  const sendDraft = (): void => {
    if (!draft) return
    link.write(session.id, `${draft}\r`)
    setDraft('')
  }

  return (
    <div className="pane">
      <header className="bar">
        <button type="button" className="bar-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="bar-title">
          <strong>{title}</strong>
          <span className="bar-sub">
            {session.cols}×{session.rows}
          </span>
        </div>
        <button
          type="button"
          className="bar-keys"
          aria-pressed={keys}
          title={keys ? 'Hide the terminal keys' : 'Show Ctrl, Esc, Tab and arrows'}
          onClick={toggleKeys}
        >
          ⌨︎
        </button>
      </header>

      <div className="term-holder" ref={holder} onClick={() => host.current?.focus()} />

      {composing ? (
        <div className="compose">
          <input
            className="compose-input"
            value={draft}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Type a line, then send"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                sendDraft()
              }
            }}
          />
          <button type="button" className="compose-send" onClick={sendDraft}>
            Send
          </button>
          <button type="button" className="compose-close" onClick={() => setComposing(false)} aria-label="Close">
            ✕
          </button>
        </div>
      ) : keys ? (
        <KeyBar onSend={send} onCompose={() => setComposing(true)} />
      ) : null}
    </div>
  )
}

/**
 * Subscribe to one session's output for as long as this component lives.
 *
 * A tiny adapter rather than a method on Link, because Link is shared by every
 * screen and must not know which one is currently on top.
 */
function linkSubscribe(
  link: Link,
  id: string,
  onChunk: (data: string, replay: boolean) => void
): () => void {
  paneListeners.set(id, onChunk)
  link.subscribe(id)
  return () => {
    paneListeners.delete(id)
    link.unsubscribe(id)
  }
}

/**
 * Live pane listeners, keyed by session id.
 *
 * Module-level because App wires Link's single `onData` callback once, at
 * construction, and routes here — a phone shows one terminal at a time, so a
 * map with at most one entry is the honest shape rather than a subscription
 * system pretending otherwise.
 */
export const paneListeners = new Map<string, (data: string, replay: boolean) => void>()

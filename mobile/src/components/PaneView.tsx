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
 */

export interface PaneViewProps {
  link: Link
  session: MobileSession
  title: string
  fontSize: number
  onBack: () => void
}

export function PaneView({ link, session, title, fontSize, onBack }: PaneViewProps): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const host = useRef<TermHost | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')

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
      ) : (
        <KeyBar onSend={send} onCompose={() => setComposing(true)} />
      )}
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

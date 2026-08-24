import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ChatTurn } from '@shared/chat'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import { applyTheme, findTheme } from '@/theme/themes'
import { ChatView } from './ChatView'
import { MOCK_APPENDS, MOCK_TURNS } from './chat-preview-data'
import './ChatPreview.css'

/**
 * `?preview=chat` on the dev server: ChatView fed fixture turns, so the chat
 * transcript can be looked at without a desktop on the other end. Compiled out
 * of every `vite build` by the `__DEV_SERVER__` gate in main.tsx, exactly like
 * the feed preview.
 *
 * The bar on top is harness chrome, not product: it flips the two built-in
 * themes through the real theme engine (`applyTheme`, so Paper is Paper, not a
 * hand-copied palette), toggles the busy dot, and appends a turn — which is
 * how stick-to-bottom and the jump pill get exercised. One append also fires
 * on its own a few seconds after load, the way a live transcript would.
 */

const CLAUDE = BUILTIN_AGENT_PROFILES.find((p) => p.id === 'claude')!

export function ChatPreview(): ReactNode {
  const [turns, setTurns] = useState<ChatTurn[]>(MOCK_TURNS)
  const [busy, setBusy] = useState(true)
  const [theme, setTheme] = useState<'volt' | 'paper'>('volt')
  const appended = useRef(0)

  useEffect(() => {
    applyTheme(findTheme(theme, []))
  }, [theme])

  const append = (): void => {
    const count = appended.current
    appended.current += 1
    const next =
      MOCK_APPENDS[count] ??
      ({
        id: `mock-extra-${count}`,
        role: 'assistant',
        at: Date.now(),
        blocks: [{ kind: 'text', text: `A later reply, number ${count + 1}, appended while you were reading.` }]
      } satisfies ChatTurn)
    setTurns((current) => [...current, { ...next, at: Date.now() }])
  }

  // A late turn on its own, so stick-to-bottom and the pill can be seen
  // without touching the harness bar.
  useEffect(() => {
    const id = window.setTimeout(append, 3400)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="chatpreview" style={{ '--pane-accent': CLAUDE.accent } as CSSProperties}>
      <div className="chatpreview__bar">
        <span className="chatpreview__label">ChatView preview</span>
        <div className="chatpreview__controls">
          <button type="button" data-active={theme === 'volt'} onClick={() => setTheme('volt')}>
            Volt
          </button>
          <button type="button" data-active={theme === 'paper'} onClick={() => setTheme('paper')}>
            Paper
          </button>
          <button type="button" data-active={busy} onClick={() => setBusy((v) => !v)}>
            busy
          </button>
          <button type="button" onClick={append}>
            append turn
          </button>
        </div>
      </div>
      <div className="chatpreview__stage">
        <ChatView turns={turns} truncated busy={busy} />
      </div>
    </div>
  )
}

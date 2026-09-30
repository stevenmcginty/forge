import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ChatTurn } from '@shared/chat'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import { useDeckTheme } from '../deck/theme'
import type { WebVoiceState } from '../deck/voiceAgent'
import { ChatView } from './ChatView'
import { ListenUnit } from './PhoneListen'
import { MOCK_APPENDS, MOCK_TURNS } from './chat-preview-data'
import './ChatPreview.css'

/**
 * `?preview=chat` on the dev server: ChatView fed fixture turns, so the chat
 * transcript can be looked at without a desktop on the other end. Compiled out
 * of every `vite build` by the `__DEV_SERVER__` gate in main.tsx, exactly like
 * the feed preview.
 *
 * The bar on top is harness chrome, not product: it flips Volt, Paper and
 * the phone's WhatsApp through the Forge browser's own theme path
 * (`useDeckTheme`, so each is the real palette and WhatsApp's bubble tokens
 * come off again), toggles the busy dot, and appends a turn — which is how
 * stick-to-bottom and the jump pill get exercised. One append also fires on
 * its own a few seconds after load, the way a live transcript would.
 *
 * `&sheet=listen` shows the phone's Listen capsule in every phase instead,
 * side by side, so its states can be compared at a glance.
 */

const CLAUDE = BUILTIN_AGENT_PROFILES.find((p) => p.id === 'claude')!

export function ChatPreview(): ReactNode {
  const [turns, setTurns] = useState<ChatTurn[]>(MOCK_TURNS)
  const [busy, setBusy] = useState(true)
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const sheet = new URLSearchParams(location.search).get('sheet')
  const appended = useRef(0)

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
          <button type="button" data-active={theme === 'whatsapp'} onClick={() => setTheme('whatsapp')}>
            WhatsApp
          </button>
          <button type="button" data-active={busy} onClick={() => setBusy((v) => !v)}>
            busy
          </button>
          <button type="button" onClick={append}>
            append turn
          </button>
        </div>
      </div>
      {sheet === 'listen' ? (
        <ListenSheet />
      ) : (
        <div className="chatpreview__stage">
          <ChatView turns={turns} truncated busy={busy} agentName={CLAUDE.name} paneId="preview" />
        </div>
      )}
    </div>
  )
}

const QUIET: WebVoiceState = {
  phase: 'off',
  error: null,
  ended: null,
  muted: false,
  agent: 'gemini-live',
  caption: null,
  lastAction: null
}

const PHASES: { name: string; voice: WebVoiceState; live?: boolean }[] = [
  { name: 'off', voice: QUIET },
  { name: 'connecting', voice: { ...QUIET, phase: 'connecting' } },
  { name: 'listening', voice: { ...QUIET, phase: 'listening' } },
  { name: 'thinking', voice: { ...QUIET, phase: 'thinking' } },
  { name: 'speaking', voice: { ...QUIET, phase: 'speaking', agent: 'claude' } },
  { name: 'muted', voice: { ...QUIET, phase: 'listening', muted: true } },
  { name: 'error', voice: { ...QUIET, phase: 'error', error: 'The voice agent stopped.' } },
  { name: 'no link', voice: QUIET, live: false }
]

/** Every Listen phase on the phone's own tokens (`.app[data-mobile]`), each over its harness name. */
function ListenSheet(): ReactNode {
  return (
    <div className="app chatpreview__listen" data-mobile="true" data-ready="true">
      {PHASES.map(({ name, voice, live }) => (
        <div key={name} className="chatpreview__listen-cell">
          <ListenUnit
            voice={voice}
            live={live ?? true}
            supported
            onToggle={() => undefined}
            onOpenPicker={() => undefined}
            onRefused={() => undefined}
          />
          <span className="chatpreview__label">{name}</span>
        </div>
      ))}
    </div>
  )
}

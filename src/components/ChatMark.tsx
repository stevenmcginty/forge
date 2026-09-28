import type { CSSProperties, ReactNode } from 'react'
import { AGENT_LOGOS } from '@shared/agent-logos'
import { CHATBOTS, type ChatBotId } from '@shared/chatbots'
import './ChatPane.css'

/**
 * A chatbot's mark: the maker's logo (shared/agent-logos.ts) on a plate in the
 * chat tab's own paint (CHATBOTS[bot].tab), with a small speech bubble beside
 * it — the shape that says "chat", not "terminal", for anyone who cannot tell
 * the plate colours apart.
 *
 * `bare` draws the logo alone in the tab's ink, for a surface that is already
 * painted in the bot's colours (the chat bar, a Wall tile's header).
 */
export function ChatMark({
  bot,
  size = 'md',
  bare = false,
  bubble = true
}: {
  bot: ChatBotId
  size?: 'sm' | 'md'
  bare?: boolean
  bubble?: boolean
}): ReactNode {
  const entry = CHATBOTS[bot]
  const logo = AGENT_LOGOS[entry.logo]
  const style = {
    '--chat-bg': entry.tab.background,
    '--chat-ink': entry.tab.ink,
    '--chat-border': entry.tab.border ?? 'transparent'
  } as CSSProperties
  return (
    <span className="chat-mark" data-size={size} data-bare={bare ? 'true' : undefined} style={style} role="img" aria-label={`${entry.name} chat`} title={`${entry.name} — chatbot website`}>
      <span className="chat-mark__plate" aria-hidden="true">
        <svg className="chat-mark__logo" viewBox={logo.viewBox} focusable="false">
          {logo.paths.map((path, i) => (
            <path key={i} d={path.d} fillRule={logo.evenOdd ? 'evenodd' : undefined} />
          ))}
        </svg>
      </span>
      {bubble ? <ChatBubble /> : null}
    </span>
  )
}

/** A small speech bubble: the "this is a chat" shape. Drawn in currentColor. */
export function ChatBubble({ className = 'chat-mark__bubble' }: { className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 11.5H7.2L4 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z" />
    </svg>
  )
}

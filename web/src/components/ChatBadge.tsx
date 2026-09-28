import type { CSSProperties, ReactNode } from 'react'
import { AGENT_LOGOS } from '@shared/agent-logos'
import { CHATBOTS, type ChatBotId } from '@shared/chatbots'
import './ChatMirror.css'

/*
 * How a chat tab (shared/chatbots.ts) wears its bot wherever the web lists or
 * switches tabs: the bot's own paint (orange for Claude, Gemini's gradient,
 * white for ChatGPT), its maker's mark, its name and the word "Chat". The mark
 * and the words say which bot and what kind of tab; the colour only agrees
 * (Steve is red-green colourblind).
 */

/** The tab paint as CSS custom properties, read by `.chat-chip` and friends. */
export function chatTabStyle(bot: ChatBotId): CSSProperties {
  const { tab } = CHATBOTS[bot]
  return {
    '--chat-bg': tab.background,
    '--chat-ink': tab.ink,
    '--chat-border': tab.border ?? 'transparent'
  } as CSSProperties
}

/** The bot's maker's mark, drawn in the current ink. */
export function ChatBotMark({ bot, size = 16 }: { bot: ChatBotId; size?: number }): ReactNode {
  const logo = AGENT_LOGOS[CHATBOTS[bot].logo]
  return (
    <svg
      className="chat-mark"
      width={size}
      height={size}
      viewBox={logo.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      {logo.paths.map((path, i) => (
        <path key={i} d={path.d} fill="currentColor" fillRule={logo.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  )
}

/** Mark, name and "Chat" on the bot's paint: a chat tab's one label. */
export function ChatTabChip({ bot, size = 'md' }: { bot: ChatBotId; size?: 'sm' | 'md' }): ReactNode {
  return (
    <span className="chat-chip" data-size={size} style={chatTabStyle(bot)}>
      <ChatBotMark bot={bot} size={size === 'sm' ? 12 : 14} />
      <span className="chat-chip__name truncate">{CHATBOTS[bot].name}</span>
      <span className="chat-chip__kind">Chat</span>
    </span>
  )
}

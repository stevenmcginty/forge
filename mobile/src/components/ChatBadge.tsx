import type { CSSProperties } from 'react'
import { AGENT_LOGOS } from '@shared/agent-logos'
import { CHATBOTS, type ChatBotId } from '@shared/chatbots'
import './ChatMirror.css'

/*
 * How a chat tab (shared/chatbots.ts) wears its bot on the phone: the bot's own
 * paint (orange for Claude, Gemini's gradient, white for ChatGPT), its maker's
 * mark, its name and the word "Chat". The mark and the words say which bot and
 * what kind of tab; the colour only agrees (Steve is red-green colourblind).
 * The phone's copy of web/src/components/ChatBadge.tsx, which this app cannot
 * import.
 */

/** The tab paint as CSS custom properties, read by `.chat-*` in ChatMirror.css. */
export function chatTabStyle(bot: ChatBotId): CSSProperties {
  const { tab } = CHATBOTS[bot]
  return {
    '--chat-bg': tab.background,
    '--chat-ink': tab.ink,
    '--chat-border': tab.border ?? 'transparent'
  } as CSSProperties
}

/** The bot's maker's mark, drawn in the current ink. */
export function ChatBotMark({ bot, size = 16 }: { bot: ChatBotId; size?: number }): React.JSX.Element {
  const logo = AGENT_LOGOS[CHATBOTS[bot].logo]
  return (
    <svg className="chat-mark" width={size} height={size} viewBox={logo.viewBox} aria-hidden="true" focusable="false">
      {logo.paths.map((path, i) => (
        <path key={i} d={path.d} fill="currentColor" fillRule={logo.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  )
}

/** The mark on the bot's paint, in a square the size of a pane badge. */
export function ChatBotTile({ bot }: { bot: ChatBotId }): React.JSX.Element {
  return (
    <span className="chat-tile-mark" style={chatTabStyle(bot)}>
      <ChatBotMark bot={bot} size={16} />
    </span>
  )
}

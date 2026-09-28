import type { AgentLogoKey } from './agent-logos'
import type { ChatBotId } from './types'

export type { ChatBotId }

/**
 * The chatbot websites a chat tab can hold: ChatGPT, Gemini and Claude, each
 * the real site, signed in once and shown in a tab beside the CLI tabs.
 *
 * A chat tab is an ordinary TerminalTab whose root is one `ChatLeaf` (see
 * shared/types.ts), so it counts toward MAX_TABS_PER_PROJECT like any other.
 * This file is only the data every face needs to draw and drive one: the name,
 * where it starts, which maker's mark it wears, the tab's colours, and how to
 * tell whether the user is signed in.
 *
 * No React, no Electron, no DOM — main, the desktop renderer, Forge Web and the
 * checks all import it.
 *
 * The cookie names and the composer selectors below are best-known values, not
 * verified live against the sites. The sites change them without notice, which
 * is exactly why they are data here rather than logic somewhere else: when one
 * breaks, the fix is one line in this file.
 */

/** The order the bots are offered in, wherever they are listed. */
export const CHATBOT_ORDER: ChatBotId[] = ['chatgpt', 'gemini', 'claude']

/** A cookie whose presence means "signed in". `name` is exact; `prefix` matches the start. */
export interface ChatBotCookie {
  domain: string
  name?: string
  prefix?: string
}

export interface ChatBot {
  name: string
  /** Where a new chat tab opens. */
  homeUrl: string
  /** The maker's mark, from shared/agent-logos.ts. */
  logo: AgentLogoKey
  /**
   * The tab's own paint. `background` is any CSS background (Gemini's is a
   * gradient); `ink` is the text and mark drawn on it; `border` only where the
   * background would otherwise vanish into a light theme.
   */
  tab: { background: string; ink: string; border?: string }
  /** Any one of these cookies present means the user is signed in. */
  signIn: { cookies: ChatBotCookie[] }
  /** The cookie domains cleared to sign out. */
  signOutDomains: string[]
  /** The page's message box, which the phone focuses. */
  composerSelector: string
  /**
   * What an agent's chat_send / chat_read looks for on the page
   * (electron/chat-panes/agent-ops.ts). Each is a list: the first selector that
   * matches anything wins, so a newer name goes first and an older one stays as
   * the fallback. Best-known values, like the rest of this file.
   */
  drive: ChatBotDrive
}

export interface ChatBotDrive {
  /** The message box. */
  composer: string[]
  /** The send button. Enter in the box is the fallback. */
  send: string[]
  /** Present only while a reply is being written (the Stop button). */
  busy: string[]
  /** One element per reply from the bot, in page order. */
  reply: string[]
  /** One element per message from the user, in page order. */
  user: string[]
}

/** Any Stop button, whichever site: the last resort of every `busy` list. */
const ANY_STOP = 'button[aria-label^="Stop" i]'

export const CHATBOTS: Record<ChatBotId, ChatBot> = {
  chatgpt: {
    name: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    logo: 'openai',
    tab: { background: '#FFFFFF', ink: '#0D0D0D', border: 'rgba(13,13,13,0.18)' },
    signIn: { cookies: [{ domain: 'chatgpt.com', prefix: '__Secure-next-auth.session-token' }] },
    signOutDomains: ['chatgpt.com', 'openai.com'],
    composerSelector: '#prompt-textarea',
    drive: {
      composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'form textarea'],
      send: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt"]'],
      busy: ['button[data-testid="stop-button"]', ANY_STOP],
      reply: ['[data-message-author-role="assistant"]'],
      user: ['[data-message-author-role="user"]']
    }
  },
  gemini: {
    name: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    logo: 'gemini',
    // Gemini's blue → violet → rose, each stop darkened until white text on it
    // clears 4.5:1 (the brand's own #4285F4 / #9B72CB / #D96570 give ~3.5:1).
    tab: { background: 'linear-gradient(90deg, #1967D2 0%, #7B55B5 50%, #B5485A 100%)', ink: '#FFFFFF' },
    signIn: {
      cookies: [
        { domain: '.google.com', name: '__Secure-1PSID' },
        { domain: '.google.com', name: 'SID' }
      ]
    },
    signOutDomains: ['google.com'],
    composerSelector: 'rich-textarea [contenteditable="true"]',
    drive: {
      composer: ['rich-textarea [contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
      send: ['button.send-button', 'button[aria-label="Send message"]'],
      busy: ['button.send-button.stop', 'button[aria-label="Stop response"]', ANY_STOP],
      reply: ['model-response message-content', 'model-response'],
      user: ['user-query .query-text', 'user-query']
    }
  },
  claude: {
    name: 'Claude',
    homeUrl: 'https://claude.ai/new',
    logo: 'claude',
    tab: { background: '#D97757', ink: '#1A1410' },
    signIn: { cookies: [{ domain: 'claude.ai', name: 'sessionKey' }] },
    signOutDomains: ['claude.ai'],
    composerSelector: 'div.ProseMirror[contenteditable="true"]',
    drive: {
      composer: ['div.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
      busy: ['[data-is-streaming="true"]', 'button[aria-label="Stop response"]', ANY_STOP],
      reply: ['.font-claude-response', '.font-claude-message', '[data-is-streaming]'],
      user: ['[data-testid="user-message"]']
    }
  }
}

/**
 * A bot from an agent's words: an id ("gemini"), its name ("ChatGPT"), or what
 * people call it ("gpt", "openai", "bard", "claude.ai"). Null when it is none.
 */
export function chatBotFromWords(words: string): ChatBotId | null {
  const w = String(words ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, '')
  if (!w) return null
  if (w === 'chatgpt' || w === 'gpt' || w === 'openai' || w === 'chatgptcom') return 'chatgpt'
  if (w === 'gemini' || w === 'bard' || w === 'googlegemini' || w === 'geminigooglecom') return 'gemini'
  if (w === 'claude' || w === 'claudeai' || w === 'anthropic') return 'claude'
  return null
}

/** Wire and disk data: checked, never cast. */
export function isChatBotId(value: unknown): value is ChatBotId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHATBOTS, value)
}

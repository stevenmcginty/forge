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
}

export const CHATBOTS: Record<ChatBotId, ChatBot> = {
  chatgpt: {
    name: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    logo: 'openai',
    tab: { background: '#FFFFFF', ink: '#0D0D0D', border: 'rgba(13,13,13,0.18)' },
    signIn: { cookies: [{ domain: 'chatgpt.com', prefix: '__Secure-next-auth.session-token' }] },
    signOutDomains: ['chatgpt.com', 'openai.com'],
    composerSelector: '#prompt-textarea'
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
    composerSelector: 'rich-textarea [contenteditable="true"]'
  },
  claude: {
    name: 'Claude',
    homeUrl: 'https://claude.ai/new',
    logo: 'claude',
    tab: { background: '#D97757', ink: '#1A1410' },
    signIn: { cookies: [{ domain: 'claude.ai', name: 'sessionKey' }] },
    signOutDomains: ['claude.ai'],
    composerSelector: 'div.ProseMirror[contenteditable="true"]'
  }
}

/** Wire and disk data: checked, never cast. */
export function isChatBotId(value: unknown): value is ChatBotId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHATBOTS, value)
}

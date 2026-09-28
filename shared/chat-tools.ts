import type { BrainToolSpec } from './brain-tools'

/**
 * The chat tabs, as tools: an agent hands something to ChatGPT, Gemini or
 * Claude — the real websites in Forge's chat tabs, signed in as Steve — and
 * reads what comes back. ONE definition for every caller:
 *
 *  - pane agents get them from forge-bridge / forge-share
 *    (bridge/chat-tools.mjs, a word-for-word copy that
 *    scripts/chat-tools-check.mjs holds to this file);
 *  - the brain gets them as MCP tools (electron/browser-panes/brain.ts) and,
 *    on a realtime voice model, as function tools
 *    (src/lib/realtime/tools-chat.ts);
 *  - Foreman gets them beside its own (electron/foreman/host.ts).
 *
 * Every call is answered in main by electron/chat-panes/agent-ops.ts, reached
 * over the browser's authenticated pipe (electron/browser-panes/service.ts
 * routes `CHAT_TOOL_NAMES`), so each caller is resolved to its project the
 * same way a browser_open is.
 *
 * Why a chat tab and not an API: the conversation lands in Steve's own account,
 * so it is on his phone's ChatGPT / Gemini / Claude app too — a hand-off he
 * can pick up away from the desk.
 */

export const CHAT_TOOL_NAMES = ['chat_list', 'chat_send', 'chat_read'] as const

export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number]

export function isChatTool(name: string): name is ChatToolName {
  return (CHAT_TOOL_NAMES as readonly string[]).includes(name)
}

/** The one line an agent's instructions carry about the chat tabs. */
export const CHAT_INSTRUCTION_LINE =
  "To hand something to ChatGPT, Gemini or Claude, use chat_send — it types into the user's own chat tab inside Forge, so the conversation is on their phone app too."

const CHAT_PARAM =
  'Which chat: a chat id from chat_list, or a bot by name — "gemini", "chatgpt" or "claude". By name it is that bot\'s tab in your project, else in any project.'

export const CHAT_TOOL_SPECS: BrainToolSpec[] = [
  {
    name: 'chat_list',
    description:
      "List the chatbot tabs inside Forge — ChatGPT, Gemini and Claude, on their real websites, signed in as the user. One line per chat: its id, the bot, the project it is in, the page it is on, and whether Forge sees that bot signed in. Takes no arguments.",
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'chat_send',
    description: [
      "Hand something to a chatbot tab inside Forge (ChatGPT, Gemini or Claude, the real website, signed in as the user): the text is typed into its message box and sent, as if the user had typed it. The conversation is saved in the user's own account, so it is on their phone app too.",
      'By bot name it uses that bot\'s tab — in your project first, then any project — and opens one in your project if there is none. new_chat true starts a fresh conversation first.',
      'It waits for the reply (up to 90 seconds) and returns it; wait false returns as soon as it is sent. A reply still being written can be collected later with chat_read.',
      'Send only what the user asked you to hand over. Never passwords, keys or other secrets.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: CHAT_PARAM },
        text: { type: 'string', description: 'The whole message, exactly as it should be sent. Line breaks are kept.' },
        new_chat: { type: 'boolean', description: 'Optional: start a new conversation first. Default false: carry on the one on the tab.' },
        wait: { type: 'boolean', description: 'Optional: wait for the reply and return it. Default true.' }
      },
      required: ['chat', 'text']
    }
  },
  {
    name: 'chat_read',
    description:
      "Read a chatbot tab inside Forge: its latest reply, or with messages the last few messages from both sides. For collecting a reply that was still being written, or seeing what the user and the bot have said. Changes nothing on the page.",
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: CHAT_PARAM },
        messages: { type: 'integer', description: 'Optional: how many of the latest messages to read, both sides, 1 to 20. Omit for just the latest reply.' }
      },
      required: ['chat']
    }
  }
]

/* --------------------------------------------------------------- the limits */

/** How long chat_send waits for a reply before handing back what there is. */
export const CHAT_REPLY_WAIT_MS = 90_000
/** A reply is finished when nothing is writing and its text has not moved for this long. */
export const CHAT_REPLY_QUIET_MS = 2_500
/** The longest reply or read handed back, in characters. The head is kept. */
export const CHAT_TEXT_MAX = 12_000
/** The longest message chat_send will type. */
export const CHAT_SEND_MAX = 30_000
/** chat_read's `messages` ceiling. */
export const CHAT_READ_MAX_MESSAGES = 20

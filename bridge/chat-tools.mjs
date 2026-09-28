/**
 * The chat tabs, as MCP tools for pane agents — chat_list, chat_send and
 * chat_read: hand something to ChatGPT, Gemini or Claude, the real websites in
 * Forge's chat tabs, signed in as the user, and read what comes back.
 *
 * Spread into forge-bridge's tool list (and forge-share's, for the CLIs whose
 * only server that is) like the browser tools, and carried the same way: over
 * the browser's authenticated pipe (./browser-tools.mjs `browserAsk`), tagged
 * with the calling pane so main works in that pane's project. Main answers in
 * electron/chat-panes/agent-ops.ts. Plain Node, no MCP SDK import.
 *
 * ⚠ The words and schemas are DUPLICATED from shared/chat-tools.ts, which is
 * canonical (this file cannot import TypeScript). scripts/chat-tools-check.mjs
 * asserts the two agree word for word.
 */

import { browserAsk, readLinkFile } from './browser-tools.mjs'

export const CHAT_INSTRUCTION_LINE =
  'To hand something to ChatGPT, Gemini or Claude, use chat_send — it types into the user\'s own chat tab inside Forge, so the conversation is on their phone app too.'

const CHAT_PARAM =
  'Which chat: a chat id from chat_list, or a bot by name — "gemini", "chatgpt" or "claude". By name it is that bot\'s tab in your project, else in any project.'

export const CHAT_DESCRIPTIONS = {
  chat_list:
    'List the chatbot tabs inside Forge — ChatGPT, Gemini and Claude, on their real websites, signed in as the user. One line per chat: its id, the bot, the project it is in, the page it is on, and whether Forge sees that bot signed in. Takes no arguments.',
  chat_send:
    'Hand something to a chatbot tab inside Forge (ChatGPT, Gemini or Claude, the real website, signed in as the user): the text is typed into its message box and sent, as if the user had typed it. The conversation is saved in the user\'s own account, so it is on their phone app too. By bot name it uses that bot\'s tab — in your project first, then any project — and opens one in your project if there is none. new_chat true starts a fresh conversation first. It waits for the reply (up to 90 seconds) and returns it; wait false returns as soon as it is sent. A reply still being written can be collected later with chat_read. Send only what the user asked you to hand over. Never passwords, keys or other secrets.',
  chat_read:
    'Read a chatbot tab inside Forge: its latest reply, or with messages the last few messages from both sides. For collecting a reply that was still being written, or seeing what the user and the bot have said. Changes nothing on the page.'
}

export const CHAT_TOOLS = [
  {
    name: 'chat_list',
    description: CHAT_DESCRIPTIONS.chat_list,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'chat_send',
    description: CHAT_DESCRIPTIONS.chat_send,
    inputSchema: {
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
    description: CHAT_DESCRIPTIONS.chat_read,
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: CHAT_PARAM },
        messages: { type: 'integer', description: 'Optional: how many of the latest messages to read, both sides, 1 to 20. Omit for just the latest reply.' }
      },
      required: ['chat']
    }
  }
]

/**
 * chat_send can wait 90 s for a reply after up to 25 s for the page to load and
 * a few more to type and send: longer than the browser ops' link timeout.
 */
const CHAT_LINK_TIMEOUT_MS = 180_000

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function run(op, args) {
  const link = readLinkFile()
  if (link.error) {
    return fail(
      link.error === 'no-env'
        ? "Forge's chat tabs are not reachable from here: FORGE_BROWSER_LINK_FILE is not set, so this agent was probably not started from a Forge pane. Nothing was sent."
        : `Forge's chat tabs are not reachable: the link file ${link.path} is ${link.error === 'no-file' ? 'missing' : 'unreadable'}. Forge is probably not running, or is still starting — try again in a moment. Nothing was sent.`
    )
  }
  let reply
  try {
    reply = await browserAsk(op, args, link, CHAT_LINK_TIMEOUT_MS)
  } catch (err) {
    return fail(`${op} did not complete: ${err?.message ?? err}`)
  }
  const text = String(reply?.text ?? 'Forge sent an empty answer.')
  return reply?.ok ? { content: [{ type: 'text', text }] } : fail(text)
}

export const CHAT_HANDLERS = Object.fromEntries(CHAT_TOOLS.map((t) => [t.name, (args) => run(t.name, args ?? {})]))

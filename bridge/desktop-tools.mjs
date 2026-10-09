/**
 * Steve's own desktop, as MCP tools for pane agents: screen_look, window_list,
 * window_read, window_click, window_type and window_key.
 *
 * The browser_* tools drive Forge's own tabs. These drive everything else on
 * the screen — Steve's own Chrome, a program he has open, a dialog — through
 * UI Automation: read a window as a numbered list of its controls, then click
 * or type by number. They ride the same authenticated pipe as the browser
 * tools (./browser-tools.mjs `browserAsk`) and are answered in main by
 * electron/desktop-hands.ts, without the renderer.
 *
 * Spread into forge-bridge's tool list like the browser and app tools. Plain
 * Node, no MCP SDK import.
 */

import { existsSync, readFileSync } from 'node:fs'
import { browserAsk } from './browser-tools.mjs'

const SCOPE =
  "Acts on Steve's own desktop apps and his own Chrome, not Forge. For Forge's own browser tabs use the browser_* tools instead. For a web page in Steve's Chrome, use the claude-in-chrome tools if you have them; use window_* for other desktop apps, or when those tools are missing."
const CONFIRM =
  'Ask Steve before submitting a form, buying anything or sending a message. Never type passwords or card details — ask Steve to type them himself.'

export const DESKTOP_INSTRUCTION_LINE =
  "Steve's own desktop (his Chrome, other programs): screen_look to see it, window_read for a numbered list of a window's controls, then window_click / window_type / window_key by number. For a web page in Steve's Chrome, use the claude-in-chrome tools if you have them; use window_* for other desktop apps, or when those tools are missing. Use browser_* for Forge's own tabs. " +
  CONFIRM

const windowParam = {
  type: 'string',
  description: 'Which window: its number from window_list, or words from its title or app name, e.g. "chrome" or "Notepad". Omit for the window in front.'
}

export const DESKTOP_TOOLS = [
  {
    name: 'screen_look',
    description: [
      `Takes a picture of Steve's whole screen now and returns it, with the PNG's file path, the app in front and every open window. ${SCOPE}`,
      'Use it first when Steve says "this page", "this form" or "this app". Read-only. Then window_read the front window for its controls; window_click x,y is in this picture.'
    ].join('\n'),
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'window_list',
    description: `Lists every open window on Steve's desktop, front first: number, app and title. Forge's own windows are left out. Read-only. ${SCOPE}`,
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'window_read',
    description: [
      `Reads one window's on-screen controls as a numbered list: [n] type "name" = "value" (ticked, disabled, password). Read-only — it brings nothing forward. ${SCOPE}`,
      'The numbers are what window_click and window_type take. They last until the window changes: read again after every click or form step, and never act on a number you did not just receive. A browser window shows its page only when it is not minimised.'
    ].join('\n'),
    inputSchema: { type: 'object', properties: { window: windowParam }, required: [] }
  },
  {
    name: 'window_click',
    description: [
      `Clicks a control by its number from your last window_read (the window is brought forward first), or a point by x and y in the picture from your last screen_look. It says what happened, with the tick state when there is one. ${SCOPE}`,
      CONFIRM
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'The number in square brackets from your last window_read.' },
        x: { type: 'number', description: 'Instead of ref: left-to-right pixel in the last screen_look picture.' },
        y: { type: 'number', description: 'Instead of ref: top-to-bottom pixel in the last screen_look picture.' }
      },
      required: []
    }
  },
  {
    name: 'window_type',
    description: [
      `Types text. With ref (a number from your last window_read) that box's text is replaced; without it the keys go where the cursor is in the window you last read (or the front window). enter: true presses Enter after. A password box is refused. ${SCOPE}`,
      CONFIRM
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Optional: the number in square brackets from your last window_read.' },
        text: { type: 'string', description: 'The text to type, exactly as it should appear.' },
        enter: { type: 'boolean', description: 'Optional: press Enter after typing (usually submits).' }
      },
      required: ['text']
    }
  },
  {
    name: 'window_key',
    description: [
      `Presses keys in a window (brought forward first): e.g. "Tab", "Shift+Tab", "Enter", "Escape", "Down Down Enter", "Ctrl+A". Ctrl, Shift and Alt can be held; up to 30 keys. ${SCOPE}`,
      CONFIRM
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The keys, separated by spaces, e.g. "Tab Tab Enter" or "Ctrl+A".' },
        window: {
          type: 'string',
          description: 'Which window: its number from window_list, or words from its title or app name. Omit for the window you last read, or the one in front.'
        }
      },
      required: ['keys']
    }
  }
]

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function run(op, args) {
  let reply
  try {
    reply = await browserAsk(op, args ?? {})
  } catch (err) {
    if (err?.link) return fail('Forge is not reachable from here (no FORGE_BROWSER_LINK_FILE, or Forge is not running), so the desktop tools cannot run.')
    return fail(`Nothing happened on the desktop: ${err?.message ?? err}`)
  }
  const text = String(reply?.text ?? 'Forge sent an empty answer.')
  if (!reply?.ok) return fail(text)
  const content = [{ type: 'text', text }]
  if (typeof reply.imagePath === 'string' && existsSync(reply.imagePath)) {
    try {
      content.push({ type: 'image', data: readFileSync(reply.imagePath).toString('base64'), mimeType: 'image/png' })
    } catch {
      /* the path in the text is still the answer */
    }
  }
  return { content }
}

export const DESKTOP_HANDLERS = Object.fromEntries(DESKTOP_TOOLS.map((t) => [t.name, (args) => run(t.name, args ?? {})]))

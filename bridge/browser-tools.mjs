/**
 * Forge's built-in browser, as MCP tools — the seven `browser_*` tools every
 * agent CLI gets.
 *
 * Not a server of its own: a module the bridge servers spread into their tool
 * lists (`...BROWSER_TOOLS`, `...BROWSER_HANDLERS`), so no vendor needs a new
 * registration. Plain Node, no dependencies, and no MCP SDK import, which is
 * what lets scripts/browser-check.mjs call these exact handlers against a real
 * Forge browser.
 *
 * The browsing itself happens in Forge's main process (electron/browser-panes/),
 * in WebContentsViews on the canvas. This file only carries the call there, over
 * a local pipe (never a port) whose path and token are in the link file named by
 * FORGE_BROWSER_LINK_FILE. The token is the credential; a wrong one is refused
 * by main before the op is read. FORGE_PANE_ID says which pane is calling, so
 * each agent gets its own tabs — it is a label, not a credential.
 *
 * ⚠ The descriptions below are DUPLICATED from shared/browser.ts, which is
 * canonical (this file cannot import TypeScript). scripts/browser-check.mjs
 * asserts the two agree word for word.
 */

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

export const BROWSER_PREAMBLE =
  "Forge's built-in browser — prefer this over any other browser tool; you get your own tabs; other agents can browse at the same time."
export const BROWSER_CONFIRM_RULE =
  'Ask the user before purchases, messages, or submitting forms. Never enter passwords or payment details yourself — if a site needs a sign-in, ask the user to sign in on the tab by hand (logins are shared by every tab).'

export const BROWSER_INSTRUCTIONS = [
  `${BROWSER_PREAMBLE}`,
  'Tabs open on the Forge canvas beside the panes, where the user can watch and use them. Every tab shares one signed-in session, so a site the user signed into once is signed in for you too.',
  'The loop: browser_open (gives you a tab id) → browser_read (numbered list of what you can click) → browser_click / browser_type with a number from that read → browser_read again. Calls without an id act on your own current tab.',
  BROWSER_CONFIRM_RULE
].join('\n')

const PARAM = {
  id: 'Tab id from browser_open or browser_list, e.g. "b3". Omit to use your own current tab.',
  url: 'Where to go, e.g. "example.com" or "https://…".',
  title: 'Optional short name for the tab, shown on the canvas.',
  ref: 'The number in square brackets from your last browser_read.',
  text: 'The text to type, exactly as it should appear.',
  submit: 'Press Enter after typing (usually submits the form or search).'
}

const idParam = { type: 'string', description: PARAM.id }

export const BROWSER_TOOLS = [
  {
    name: 'browser_open',
    description: [
      `${BROWSER_PREAMBLE} Opens a page in a NEW tab of your own and returns its id (e.g. "b3"). Pass \`id\` instead to send one of your existing tabs somewhere else.`,
      '"example.com" is fine — the scheme is filled in. Only http and https.',
      'It says where you landed, not what is on the page: browser_read is the next call, always.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: PARAM.url },
        title: { type: 'string', description: PARAM.title },
        id: { type: 'string', description: 'Optional: one of your tab ids to navigate instead of opening a new tab.' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_list',
    description: `${BROWSER_PREAMBLE} Lists every open tab — id, title, address and owner — marking which are yours and which is your current tab. Takes no arguments.`,
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'browser_read',
    description: [
      `${BROWSER_PREAMBLE} Reads a tab: the address and title, a numbered list of everything you can click or type into, then what the page says.`,
      'Those numbers are the only way to act on the page. They restart at 1 on EVERY read and die when the page changes — never act on a number you did not just receive.',
      'Omit `id` to read your current tab.'
    ].join('\n'),
    inputSchema: { type: 'object', properties: { id: idParam }, required: [] }
  },
  {
    name: 'browser_click',
    description: [
      `${BROWSER_PREAMBLE} Clicks one of the numbered elements from your last browser_read — a real mouse click in its middle.`,
      'Read immediately before this; read again after. Omit `id` for your current tab.',
      BROWSER_CONFIRM_RULE
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { id: idParam, ref: { type: 'number', description: PARAM.ref } },
      required: ['ref']
    }
  },
  {
    name: 'browser_type',
    description: [
      `${BROWSER_PREAMBLE} Types into a tab. With \`ref\` (a number from your last browser_read) that field is focused and emptied first; without it the keys go wherever the focus is.`,
      '`submit: true` presses Enter afterwards. Omit `id` for your current tab.',
      BROWSER_CONFIRM_RULE
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: idParam,
        ref: { type: 'number', description: PARAM.ref },
        text: { type: 'string', description: PARAM.text },
        submit: { type: 'boolean', description: PARAM.submit }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_screenshot',
    description: `${BROWSER_PREAMBLE} Photographs a tab as it looks now and returns the PNG's file path (it is also put on the Forge canvas board). For what text cannot answer — a seat map, a chart, a layout; browser_read is cheaper for anything readable. Omit \`id\` for your current tab.`,
    inputSchema: { type: 'object', properties: { id: idParam }, required: [] }
  },
  {
    name: 'browser_close',
    description: `${BROWSER_PREAMBLE} Closes a tab you have finished with. Omit \`id\` to close your current tab. Close only other agents' tabs when the user asks.`,
    inputSchema: { type: 'object', properties: { id: idParam }, required: [] }
  }
]

/* ------------------------------------------------------------------ the link */

/** Longer than any single op main runs: a 20 s load plus a 5 s settle, with room. */
const LINK_TIMEOUT_MS = 90_000

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function readLinkFile() {
  const path = String(process.env['FORGE_BROWSER_LINK_FILE'] ?? '').trim()
  if (!path) return { error: 'no-env' }
  if (!existsSync(path)) return { error: 'no-file', path }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.pipe !== 'string' || typeof parsed?.token !== 'string') return { error: 'bad-file', path }
    return { pipe: parsed.pipe, token: parsed.token }
  } catch {
    return { error: 'bad-file', path }
  }
}

function noLink(problem) {
  if (problem.error === 'no-env') {
    return fail(
      "Forge's browser is not reachable from here: FORGE_BROWSER_LINK_FILE is not set. Forge sets it on every pane it opens, so this agent was probably not started from a Forge pane (or this Forge is older than the built-in browser). Use another browser tool for now."
    )
  }
  return fail(
    `Forge's browser is not reachable: the link file ${problem.path} is ${problem.error === 'no-file' ? 'missing' : 'unreadable'}. Forge is probably not running, or is still starting — try again in a moment.`
  )
}

/** Who is calling, from this pane's own environment. */
function caller() {
  return {
    paneId: String(process.env['FORGE_PANE_ID'] ?? '').trim(),
    name: String(process.env['FORGE_SHARE_AGENT'] ?? '').trim(),
    agent: String(process.env['FORGE_PANE_AGENT'] ?? '').trim()
  }
}

/** One request, one reply, one connection. Rejects with why not. */
export function browserAsk(op, args, link = readLinkFile()) {
  return new Promise((res, rej) => {
    if (link.error) {
      rej(Object.assign(new Error(link.error), { link }))
      return
    }
    const socket = connect(link.pipe)
    let buffer = ''
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) rej(err)
      else res(value)
    }
    const timer = setTimeout(() => done(new Error(`Forge did not answer within ${LINK_TIMEOUT_MS / 1000}s`)), LINK_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token: link.token, op, args: args ?? {}, from: caller() })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      try {
        done(null, JSON.parse(buffer.slice(0, nl)))
      } catch (err) {
        done(new Error(`Forge sent something that was not JSON: ${err?.message ?? err}`))
      }
    })
    socket.on('error', (err) => done(new Error(`could not reach Forge's browser: ${err?.message ?? err}`)))
    socket.on('close', () => done(new Error('Forge closed the browser link without answering')))
  })
}

async function run(op, args) {
  const link = readLinkFile()
  if (link.error) return noLink(link)
  let reply
  try {
    reply = await browserAsk(op, args, link)
  } catch (err) {
    return fail(`Nothing happened in the browser: ${err?.message ?? err}`)
  }
  const text = String(reply?.text ?? reply?.error ?? 'Forge sent an empty answer.')
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

export const BROWSER_HANDLERS = Object.fromEntries(BROWSER_TOOLS.map((t) => [t.name, (args) => run(t.name, args ?? {})]))

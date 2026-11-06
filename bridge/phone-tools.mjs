/**
 * Steve's phone, as MCP tools for pane agents: phone_status, phone_look,
 * phone_read, phone_tap, phone_type, phone_scroll, phone_key, phone_open_app,
 * phone_open_link, phone_apps, phone_notifications, phone_reply and
 * phone_find_contact — one per op of the phone-hands contract
 * (docs/PHONE-HANDS.md).
 *
 * Every name, description and argument comes from shared/phone-hands-spec.mjs,
 * the one copy the Claude brains' forgeToolDefs() is built from too. They ride
 * the same authenticated pipe as the desktop tools (./browser-tools.mjs
 * `browserAsk`) and are answered in main by electron/phone-hands.ts, which
 * sends them down the phone's hands socket.
 *
 * Spread into forge-bridge's tool list like the desktop tools. Plain Node, no
 * MCP SDK import.
 */

import { existsSync, readFileSync } from 'node:fs'
import { PHONE_INSTRUCTION_LINE, PHONE_TOOL_SPECS } from '../shared/phone-hands-spec.mjs'
import { browserAsk } from './browser-tools.mjs'

export { PHONE_INSTRUCTION_LINE }

export const PHONE_TOOLS = PHONE_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(spec.params).map(([key, param]) => [
        key,
        { type: param.type, description: param.description, ...(param.enum ? { enum: [...param.enum] } : {}) }
      ])
    ),
    required: [...spec.required]
  }
}))

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function run(name, args) {
  let reply
  try {
    reply = await browserAsk(name, args ?? {})
  } catch (err) {
    if (err?.link) return fail('Forge is not reachable from here (no FORGE_BROWSER_LINK_FILE, or Forge is not running), so the phone tools cannot run.')
    return fail(`Nothing happened on the phone: ${err?.message ?? err}`)
  }
  const text = String(reply?.text ?? 'Forge sent an empty answer.')
  if (!reply?.ok) return fail(text)
  const content = [{ type: 'text', text }]
  if (typeof reply.imagePath === 'string' && existsSync(reply.imagePath)) {
    try {
      const mimeType = /\.png$/i.test(reply.imagePath) ? 'image/png' : 'image/jpeg'
      content.push({ type: 'image', data: readFileSync(reply.imagePath).toString('base64'), mimeType })
    } catch {
      /* the text is still the answer */
    }
  }
  return { content }
}

export const PHONE_HANDLERS = Object.fromEntries(PHONE_TOOLS.map((t) => [t.name, (args) => run(t.name, args ?? {})]))

/**
 * Forge's app, as MCP tools for pane agents — today one: open_agent_pane.
 *
 * A Claude or Codex pane asked to "spawn a new agent" used to Start-Process a
 * Windows Terminal outside Forge. This tool opens the agent INSIDE Forge
 * instead, as a new tab, through the same authenticated pipe the browser tools
 * use (./browser-tools.mjs `browserAsk`): main relays it to the renderer, which
 * runs the one open_agent_pane implementation every brain shares
 * (src/lib/realtime/tools-main.ts).
 *
 * Spread into forge-bridge's tool list like the browser tools. Plain Node, no
 * MCP SDK import.
 *
 * ⚠ The description is DUPLICATED from shared/brain-tools.ts (canonical — this
 * file cannot import TypeScript). scripts/launch-guard-check.mjs asserts they
 * agree word for word.
 */

import { browserAsk } from './browser-tools.mjs'

export const OPEN_AGENT_PANE_DESCRIPTION =
  'Open a new coding-agent pane INSIDE Forge — the only way to start an agent. agent is who, in words: "claude", "codex", "gemini", "antigravity", "glm", "kimi", "opencode", "qwen", "grok", or a plain "shell". prompt is typed into the new pane once the agent is up (sent only when submit is true). Never start an agent CLI any other way — no run_command, no open_desktop_app, no new console or terminal window. The answer says which pane opened, or why none did.'

export const APP_INSTRUCTION_LINE = 'To start another agent, call open_agent_pane — never launch a CLI in a new window.'

export const APP_TOOLS = [
  {
    name: 'open_agent_pane',
    description: OPEN_AGENT_PANE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which agent, in words: "codex", "claude", "gemini"…' },
        prompt: { type: 'string', description: 'Optional: the first prompt to type into it' },
        submit: { type: 'boolean', description: 'Optional: press Enter after the prompt. Default false.' }
      },
      required: ['agent']
    }
  }
]

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function openAgentPane(args) {
  let reply
  try {
    reply = await browserAsk('open_agent_pane', args ?? {})
  } catch (err) {
    if (err?.link) {
      return fail(
        'Forge is not reachable from here (no FORGE_BROWSER_LINK_FILE, or Forge is not running), so no pane was opened. Do NOT start the CLI yourself in a new window — tell the user to open the agent from Forge instead.'
      )
    }
    return fail(`No pane was opened: ${err?.message ?? err}`)
  }
  const text = String(reply?.text ?? 'Forge sent an empty answer.')
  return reply?.ok ? { content: [{ type: 'text', text }] } : fail(text)
}

export const APP_HANDLERS = { open_agent_pane: openAgentPane }

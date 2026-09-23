#!/usr/bin/env node
/**
 * forge-brain — the main agent's Forge tools, for a brain that is a CLI.
 *
 * The bottom bar's main agent can run on Claude (an in-process Agent SDK
 * session), or on the Codex CLI or the Gemini CLI as a hidden headless session
 * (electron/voice-agent/cli-brains.ts). The Claude session gets Forge's tools
 * as an in-process MCP server. A CLI can only spawn one, so this is that
 * server, as a stdio child of the CLI.
 *
 * It holds no tool of its own. `tools/list` and `tools/call` are relayed, as
 * they are, to Forge's main process over the authenticated local pipe in the
 * link file named by FORGE_BRAIN_LINK_FILE (electron/voice-agent/ipc.ts), and
 * main answers from the SAME tool definitions the Claude session uses
 * (electron/voice-agent/host.ts `forgeToolDefs`). So every brain has the same
 * tools, the same words and the same guards (launch-guard.ts), and adding a
 * tool there adds it here on the same day.
 *
 * Run standalone for testing: it speaks JSON-RPC on stdin/stdout, and every
 * diagnostic goes to stderr.
 */

import { existsSync, readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { browserAsk } from './browser-tools.mjs'

export const BRAIN_LINK_ENV = 'FORGE_BRAIN_LINK_FILE'

function readLink() {
  const path = String(process.env[BRAIN_LINK_ENV] ?? '').trim()
  if (!path) return { error: `${BRAIN_LINK_ENV} is not set` }
  if (!existsSync(path)) return { error: `the link file ${path} is missing — Forge is not running` }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.pipe !== 'string' || typeof parsed?.token !== 'string') return { error: `the link file ${path} is unreadable` }
    return { pipe: parsed.pipe, token: parsed.token }
  } catch {
    return { error: `the link file ${path} is unreadable` }
  }
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** One relayed request. Resolves with the parsed JSON main put in `text`, or rejects with why not. */
async function ask(op, args) {
  const link = readLink()
  if (link.error) throw new Error(`Forge is not reachable: ${link.error}`)
  const reply = await browserAsk(op, args, link)
  if (!reply?.ok) throw new Error(String(reply?.text ?? 'Forge refused the request'))
  return JSON.parse(String(reply.text ?? 'null'))
}

const server = new Server({ name: 'forge', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const tools = await ask('tools/list', {})
    return { tools: Array.isArray(tools) ? tools : [] }
  } catch (err) {
    console.error(`[forge-brain] tools/list failed: ${err?.message ?? err}`)
    return { tools: [] }
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params?.name ?? '')
  try {
    const result = await ask('tools/call', { name, args: request.params?.arguments ?? {} })
    if (!result || !Array.isArray(result.content)) return fail(`Forge sent no answer for ${name}.`)
    return result
  } catch (err) {
    return fail(`${name} did not run: ${err?.message ?? err}`)
  }
})

await server.connect(new StdioServerTransport())

#!/usr/bin/env node
/**
 * forge-share — five markdown slots, a tap on the shoulder, and no key.
 *
 * A standalone MCP server (stdio) that Forge registers into Claude Code, Codex,
 * Qwen and OpenCode panes so an agent in one pane can leave something where an
 * agent in another pane will find it. It reads and writes one folder, resolves
 * that folder from its own working directory, and refuses rather than creating
 * one.
 *
 * `pane_send` and `pane_read` are the other half, and the only part of this file
 * that is not a file: they reach Forge's main process over a **local pipe** whose
 * path arrives in FORGE_SHARE_LINK, so one agent can type into another agent's
 * terminal and read the answer back. The transport is a Windows named pipe (a
 * unix socket elsewhere) and never a port — see electron/share-link.ts, which
 * owns the listening end and every rule about who may address whom. Without that
 * variable the two tools say so and the other five carry on; this server never
 * connects to anything it was not handed the path to.
 *
 * **Separate from bridge/gemini-bridge.mjs on purpose**, and the first reason
 * decides it: that server's environment carries GEMINI_API_KEY, and registering
 * it into three more vendors' configs would copy a key into three more config
 * files and three more processes. A scratchpad must not be a reason to widen a
 * key's blast radius. Beyond that: these tools need no key at all, so they cannot
 * live behind a header that says "one key, one road"; scripts/bridge-smoke.mjs
 * asserts that server offers *exactly* its five Gemini tools, a guard worth
 * keeping undiluted; and "it holds no credential and touches the network zero
 * times" is the sentence that makes this one safe to hand to four vendors, which
 * a shared server could never say.
 *
 * Run standalone (for testing):  node bridge/share-bridge.mjs
 * It speaks JSON-RPC over stdin/stdout, so stdout stays clean — every diagnostic
 * goes to stderr.
 *
 * ⚠ The slot format below is DUPLICATED from shared/share.ts, which is canonical.
 * This file has to run under bare `node` with no build step and so cannot import
 * a `.ts` module — the same deliberate duplication gemini-bridge.mjs has with
 * electron/gemini-media.ts, and with the same guard: scripts/share-check.mjs
 * reads both files and asserts the caps, the truncation marker and the
 * front-matter keys still match, so the two cannot drift silently.
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const SERVER_NAME = 'forge-share'
const SERVER_VERSION = '1.0.0'

/* ---------------------------------------------------------------- the format
 *
 * Mirrors shared/share.ts. Change one, change both — share-check.mjs compares
 * them and fails if they disagree.
 */

const SHARE_SLOTS = 5
const SHARE_MAX_BYTES = 64 * 1024
const SHARE_MAX_TITLE = 60
const SHARE_PREVIEW_CHARS = 240
/**
 * Declared, and used only by the drift guard: scripts/share-check.mjs reads this
 * line out of both files and asserts the two agree. `formatSlot` below writes
 * these keys in this order, and `parseSlot` reads them — the list is here so the
 * agreement is checkable rather than a thing somebody has to notice.
 */
const SHARE_KEYS = ['slot', 'title', 'updatedAt', 'author', 'via']
const VIA_VALUES = ['rail', 'mcp', 'capture', 'agent']

/** The link's caps, mirrored from the same file. See `pane_send` and `pane_read`. */
const SHARE_SEND_MAX_BYTES = 8 * 1024
const SHARE_READ_DEFAULT_LINES = 60
const SHARE_CAPTURE_MAX_LINES = 400

function slotFileName(index) {
  return `slot-${index}.md`
}

function isSlotIndex(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SHARE_SLOTS
}

function shareBytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

function truncationMarker(dropped) {
  return `\n\n<!-- forge: truncated at ${SHARE_MAX_BYTES} bytes; ${dropped} bytes were dropped -->\n`
}

function isTruncatedBody(body) {
  return /<!-- forge: truncated at \d+ bytes; \d+ bytes were dropped -->/.test(body)
}

/** Head-keeping, never silent. See shared/share.ts for why the head wins. */
function capBody(body) {
  const text = String(body ?? '')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= SHARE_MAX_BYTES) return { body: text, truncated: false, dropped: 0 }

  const budget = SHARE_MAX_BYTES - shareBytes(truncationMarker(bytes.length))
  let end = Math.min(Math.max(0, budget), bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  let kept = bytes.subarray(0, end).toString('utf8')
  const lastBreak = kept.lastIndexOf('\n')
  if (lastBreak > 0) kept = kept.slice(0, lastBreak)

  const dropped = bytes.length - shareBytes(kept)
  return { body: `${kept}${truncationMarker(dropped)}`, truncated: true, dropped }
}

function tidyTitle(title) {
  const flat = String(title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= SHARE_MAX_TITLE) return flat
  return `${flat.slice(0, SHARE_MAX_TITLE - 1).trim()}…`
}

function previewOf(body) {
  const flat = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= SHARE_PREVIEW_CHARS) return flat
  return `${flat.slice(0, SHARE_PREVIEW_CHARS).trim()}…`
}

function shareStamp(at) {
  return new Date(Number.isFinite(at) && at > 0 ? at : 0).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function formatSlot(slot) {
  const head = [
    '---',
    `slot: ${slot.index}`,
    `title: ${tidyTitle(slot.title)}`,
    `updatedAt: ${shareStamp(slot.updatedAt)}`,
    `author: ${String(slot.author ?? '').replace(/[\r\n]+/g, ' ').trim()}`,
    `via: ${VIA_VALUES.includes(slot.via) ? slot.via : 'agent'}`,
    '---'
  ].join('\n')
  return `${head}\n\n${slot.body}`
}

function firstHeading(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s+/g, ''))) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) return tidyTitle(heading[1] ?? '')
    return tidyTitle(line)
  }
  return ''
}

/** Tolerant by design: a file with no front matter is an agent's, not a fault. */
function parseSlot(index, text, mtimeMs = 0) {
  const raw = String(text ?? '').replace(/^﻿/, '')
  let body = raw
  const front = new Map()

  if (/^---\r?\n/.test(raw)) {
    const lines = raw.split(/\r?\n/)
    let end = -1
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '---') {
        end = i
        break
      }
    }
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const line = lines[i] ?? ''
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        front.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
      }
      const after = new RegExp(`^(?:[^\\n]*\\n){${end + 1}}`).exec(raw)
      body = after ? raw.slice(after[0].length) : ''
      if (body.startsWith('\r\n')) body = body.slice(2)
      else if (body.startsWith('\n')) body = body.slice(1)
    }
  }

  const stamped = Date.parse(front.get('updatedat') ?? '')
  const via = front.get('via') ?? ''
  return {
    index,
    title: tidyTitle(front.get('title') ?? '') || firstHeading(body) || `Slot ${index}`,
    body,
    bytes: shareBytes(body),
    updatedAt: Number.isFinite(stamped) ? stamped : mtimeMs,
    author: front.get('author') ?? '',
    via: VIA_VALUES.includes(via) ? via : 'agent',
    truncated: isTruncatedBody(body)
  }
}

/* ------------------------------------------------------------- the project */

/**
 * Which project's scratchpad this server is talking to.
 *
 * `process.cwd()`, walked upward looking for an existing `.forge/share`. The
 * config Forge writes is one line with no project in it — it is written once at
 * app start, and the active project changes all day — so the cwd is what makes
 * each spawned server project-correct. Every vendor starts an MCP server in the
 * workspace it is working in, which is exactly the folder we want.
 *
 * **It never creates the folder.** A server that makes directories in whatever
 * path it happens to be started in is a server that litters. If nothing is found
 * it says how to fix it: switch the section on in Forge, which is the one gesture
 * that is allowed to write inside somebody's repository.
 *
 * FORGE_SHARE_ROOT overrides the walk. It exists for scripts/share-check.mjs and
 * for the odd pane started somewhere strange; it is deliberately *not* the
 * primary route, and nothing in Forge sets it per-project, because a value baked
 * into a config at app start would be wrong the moment the project changed.
 *
 * FORGE_SHARE_DIR is the same override arriving from the other direction, and it
 * *is* set by Forge: not in a config file written once at app start, but on the
 * environment of each pane as that pane is created, by which time the project is
 * known for certain. It also carries the fix for the oldest bug in this feature
 * — the folder now exists before the agent starts, because the PTY host makes it
 * (electron/pty-host.ts `shareDirFor`), rather than only when somebody happens to
 * open the rail's SHARE section. The walk stays as the fallback for a server
 * started by hand.
 */
const MAX_WALK = 12

function shareRoot() {
  const override = String(process.env['FORGE_SHARE_ROOT'] ?? '').trim()
  if (override) return existsSync(override) ? resolve(override) : null

  const told = String(process.env['FORGE_SHARE_DIR'] ?? '').trim()
  if (told && existsSync(told)) return resolve(told)

  let dir = resolve(process.cwd())
  for (let i = 0; i < MAX_WALK; i++) {
    const candidate = join(dir, '.forge', 'share')
    if (existsSync(candidate)) return candidate
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function noRoot() {
  return fail(
    `No shared scratchpad found from ${process.cwd()}.\n\n` +
      'Forge has not opened one for this project yet. Switch the Share section on in the left rail ' +
      '(Settings → Appearance → Left rail → Share) and it will create .forge/share in the project folder. ' +
      'This server will not create it — it does not know which folder is the project.'
  )
}

/** Who wrote it, when the tool did not say. Set per-pane by Forge. */
function defaultAuthor() {
  return String(process.env['FORGE_SHARE_AGENT'] ?? '').trim()
}

/* --------------------------------------------------------------- the link */

/**
 * The one channel out of this process, and the whole of it.
 *
 * A path from FORGE_SHARE_LINK — a Windows named pipe, or a unix socket file —
 * that Forge's main process is listening on. No host, no port, no DNS and no
 * credential: if the variable is absent there is nothing to connect to and the
 * two tools that need it say so plainly. Every other tool in this file works
 * exactly as it did before.
 *
 * One request per connection, newline-terminated JSON both ways. Short-lived on
 * purpose: an MCP tool call is a round trip, there is no server-initiated
 * traffic to keep a socket open for, and a dropped connection is then a thing
 * that cannot happen between calls.
 */
const LINK_TIMEOUT_MS = 5000

function linkPath() {
  return String(process.env['FORGE_SHARE_LINK'] ?? '').trim()
}

function noLink() {
  return fail(
    'This pane has no link to Forge, so it cannot reach other panes.\n\n' +
      'FORGE_SHARE_LINK is set by Forge on every pane it launches. It is missing here, which means either this ' +
      'server was started by hand rather than by a Forge pane, or this copy of Forge is older than the link. ' +
      'The share_* tools still work — leave a note in a slot instead.'
  )
}

/** Ask main one question. Resolves to a reply object, or rejects with why not. */
function linkAsk(request) {
  const path = linkPath()
  return new Promise((res, rej) => {
    const socket = connect(path)
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
    const timer = setTimeout(() => done(new Error(`Forge did not answer within ${LINK_TIMEOUT_MS}ms`)), LINK_TIMEOUT_MS)

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ ...request, from: defaultAuthor(), cwd: process.cwd() })}\n`)
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
    socket.on('error', (err) => done(new Error(`could not reach Forge on ${path}: ${err?.message ?? err}`)))
    socket.on('close', () => done(new Error('Forge closed the link without answering')))
  })
}

/** A refusal from main, turned into the sentence the calling model reads. */
function linkRefusal(reply) {
  const lines = [String(reply?.error ?? 'Forge refused the request.')]
  if (Array.isArray(reply?.candidates) && reply.candidates.length > 0) {
    lines.push('', 'Candidates:', ...reply.candidates.map((c) => `  • ${c}`))
  }
  if (Array.isArray(reply?.panes) && reply.panes.length > 0) {
    lines.push('', 'Panes open in this project:', ...reply.panes.map(paneLine))
  }
  return fail(lines.join('\n'))
}

function paneLine(pane) {
  const state = pane?.idle ? `idle for ${Math.round(Number(pane.quietForMs ?? 0) / 1000)}s` : 'busy'
  return `  • ${String(pane?.title ?? '?')} — ${String(pane?.agent || 'shell')}, ${state}`
}

function slotPath(root, index) {
  return join(root, slotFileName(index))
}

function readSlot(root, index) {
  const path = slotPath(root, index)
  if (!existsSync(path)) return parseSlot(index, '', 0)
  const stat = statSync(path)
  if (!stat.isFile()) return null
  return parseSlot(index, readFileSync(path, 'utf8'), stat.mtimeMs)
}

/* ------------------------------------------------------------------ replies */

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function wantSlot(args) {
  const raw = args?.slot
  const index = typeof raw === 'number' ? raw : Number.NaN
  if (!isSlotIndex(index)) {
    throw new Error(`\`slot\` must be a whole number from 1 to ${SHARE_SLOTS} — got ${JSON.stringify(raw)}`)
  }
  return index
}

function ageLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/* -------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'share_list',
    description:
      'List the five shared scratchpad slots for this project: which are filled, their titles, who wrote them, ' +
      'when, and how big they are. Every agent working in this project — Claude Code, Codex, Antigravity, Qwen, ' +
      'OpenCode — reads and writes the same five slots, so this is how you find out what somebody else has left ' +
      'for you. Returns a short preview of each body, never the whole thing; use share_read for that.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'share_read',
    description:
      'Read one shared scratchpad slot in full — the body exactly as written, plus who wrote it and when. Use it ' +
      'when you have been asked to look at, review or continue something another pane left in a slot. Slots are ' +
      'numbered 1 to 5. Reading is free and changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: SHARE_SLOTS, description: 'Which slot to read, 1 to 5.' }
      },
      required: ['slot']
    }
  },
  {
    name: 'share_write',
    description:
      'Write a shared scratchpad slot so every other agent in this project can read it — a plan, a review, an API ' +
      'contract, a set of findings. Give it a short `title` so it is recognisable in Forge\'s rail, and set ' +
      '`author` to your pane\'s name so whoever reads it knows whose opinion it is. Pass `append: true` to add to ' +
      'what is there instead of replacing it. IMPORTANT: another agent may have changed the slot since you read ' +
      'it — pass the `updated_at` you got from share_read as `expect_updated_at` and this will refuse rather than ' +
      'overwrite their work. Bodies over 64 KiB keep their beginning and lose their end, and the reply says so.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: SHARE_SLOTS, description: 'Which slot to write, 1 to 5.' },
        body: { type: 'string', description: 'The markdown to put in the slot.' },
        title: { type: 'string', description: 'A short name for it, shown in Forge\'s rail. Falls back to the first heading.' },
        author: { type: 'string', description: 'Who is writing — your pane\'s name. Defaults to what Forge told this server.' },
        append: { type: 'boolean', description: 'Add to the slot rather than replace it.' },
        expect_updated_at: {
          type: 'integer',
          description: 'The `updated_at` you last read for this slot. If it has moved since, the write is refused instead of clobbering.'
        }
      },
      required: ['slot', 'body']
    }
  },
  {
    name: 'share_clear',
    description:
      'Empty one shared scratchpad slot, deleting its file. Use it when a note has been acted on and is no longer ' +
      'worth the space, and prefer asking the person first if you did not write it — another pane may still be ' +
      'working from it.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: SHARE_SLOTS, description: 'Which slot to empty, 1 to 5.' }
      },
      required: ['slot']
    }
  },
  {
    name: 'share_panes',
    description:
      'List the panes currently open in this project in Forge — their names and which agent each one is running. ' +
      'Use it to find out who else is working here before you address a note to somebody, or when the person says ' +
      'something like "hand this to the Codex tab" and you need to know what it is called.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'pane_send',
    description:
      'Say something to another agent right now, by typing it into that agent\'s terminal exactly as if the person ' +
      'at the keyboard had typed it and pressed Enter. The receiving agent sees a normal message prefixed with ' +
      '"[from <your pane name>]" and will answer in its own pane, not to you — use pane_read to see what it said. ' +
      'Pane names come from share_panes. This REFUSES while the target is busy working, and refuses rather than ' +
      'queueing, so a refusal means nothing was sent: wait, poll with pane_read, and try again. Prefer a share slot ' +
      'for anything long — this is a sentence or two of instruction, not a document. Use it when the person asks ' +
      'you to tell, ask or hand something to another pane, or when you need something another agent is holding.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: {
          type: 'string',
          description: 'Which pane to type into: its name, or its agent (e.g. "OpenCode") if only one pane runs that agent.'
        },
        text: { type: 'string', description: 'What to say. One or two sentences; the cap is 8 KiB and it is refused, not cut.' },
        force: {
          type: 'boolean',
          description: 'Send even though the pane is busy. Interrupts whatever it is doing — only when the person asked for that.'
        },
        multiline: {
          type: 'boolean',
          description:
            'Keep the line breaks. Off by default because most agent CLIs submit on Enter, so a three-line message ' +
            'would arrive as three separate prompts.'
        }
      },
      required: ['pane', 'text']
    }
  },
  {
    name: 'pane_read',
    description:
      'Read what is currently on another pane\'s screen — the last lines of its terminal, with the colours and ' +
      'cursor codes stripped. This is how you see another agent\'s reply after a pane_send, how you check whether it ' +
      'is still working, and how you find out what went wrong in a pane the person is asking you about. Also reports ' +
      'whether the pane is idle, so you can poll here rather than retrying a refused pane_send blindly. Reading ' +
      'changes nothing and never interrupts the other agent.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: 'Which pane to read: its name, or its agent if only one pane runs that agent.' },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: SHARE_CAPTURE_MAX_LINES,
          description: `How many lines from the end of its screen. Default ${SHARE_READ_DEFAULT_LINES}, most ${SHARE_CAPTURE_MAX_LINES}.`
        }
      },
      required: ['pane']
    }
  }
]

/* ----------------------------------------------------------------- handlers */

async function shareList() {
  const root = shareRoot()
  if (!root) return noRoot()

  const lines = []
  for (let index = 1; index <= SHARE_SLOTS; index++) {
    const slot = readSlot(root, index)
    if (!slot) {
      lines.push(`${index}. [unreadable] ${slotFileName(index)} is not a file`)
      continue
    }
    if (!slot.body.trim()) {
      lines.push(`${index}. (empty)`)
      continue
    }
    const who = slot.author.trim() || 'unattributed'
    const age = slot.updatedAt > 0 ? ageLabel(Date.now() - slot.updatedAt) : 'unknown'
    lines.push(
      `${index}. ${slot.title} — ${who}, ${age}, ${slot.bytes} bytes, via ${slot.via}` +
        `${slot.truncated ? ' [truncated]' : ''}\n     ${previewOf(slot.body)}`
    )
  }

  return ok(
    [
      `Shared scratchpad for ${dirname(dirname(root))}`,
      '',
      ...lines,
      '',
      'Use share_read for a whole body, share_write to leave one.'
    ].join('\n')
  )
}

async function shareRead(args) {
  const root = shareRoot()
  if (!root) return noRoot()
  const index = wantSlot(args)

  const slot = readSlot(root, index)
  if (!slot) return fail(`${slotFileName(index)} exists but is not a file, so slot ${index} cannot be read.`)
  if (!slot.body.trim()) return ok(`Slot ${index} is empty.`)

  const who = slot.author.trim() || 'unattributed'
  return ok(
    [
      `Slot ${index}: ${slot.title}`,
      `Written by ${who}, updated_at ${slot.updatedAt} (${shareStamp(slot.updatedAt)}), via ${slot.via}` +
        `${slot.truncated ? ', truncated — the end of this was dropped' : ''}.`,
      'Pass that updated_at back as `expect_updated_at` if you write to this slot.',
      '',
      slot.body
    ].join('\n')
  )
}

async function shareWrite(args) {
  const root = shareRoot()
  if (!root) return noRoot()
  const index = wantSlot(args)

  if (typeof args?.body !== 'string') return fail('`body` is required and must be a string.')

  const current = readSlot(root, index)
  if (!current) return fail(`${slotFileName(index)} exists but is not a file, so slot ${index} cannot be written.`)

  const expect = args?.expect_updated_at
  if (typeof expect === 'number' && current.body.trim() && current.updatedAt !== expect) {
    const who = current.author.trim() || 'Somebody'
    return fail(
      `Refused: slot ${index} changed since you read it — ${who} wrote it ` +
        `${ageLabel(Date.now() - current.updatedAt)} (updated_at is now ${current.updatedAt}, you expected ${expect}). ` +
        'Read it again and decide: merge your text into theirs, use a different slot, or write without ' +
        '`expect_updated_at` if you genuinely mean to replace their work.'
    )
  }

  const append = args?.append === true
  const joined = append && current.body.trim()
    ? `${current.body.replace(/\s+$/, '')}\n\n${String(args.body).replace(/^\s+/, '')}`
    : String(args.body)
  const capped = capBody(joined)
  const title = tidyTitle(args?.title ?? '') || (append ? current.title : '') || `Slot ${index}`
  const author = String(args?.author ?? '').trim() || defaultAuthor()
  const at = Date.now()

  const path = slotPath(root, index)
  const text = formatSlot({ index, title, body: capped.body, updatedAt: at, author, via: 'mcp' })
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    // Named rather than swallowed: a read-only sandbox is the likely cause, and
    // "it worked" would be a lie the agent would build on.
    return fail(`Slot ${index} could not be written: ${err?.message ?? err}. Nothing was changed.`)
  }

  const lines = [
    `${append ? 'Appended to' : 'Wrote'} slot ${index}: ${title}`,
    `${capped.body.length} characters, ${shareBytes(capped.body)} bytes. updated_at ${at}.`,
    'Every pane in this project can read it now, at ' + `.forge/share/${slotFileName(index)}.`
  ]
  if (capped.truncated) {
    lines.push(
      `⚠ It was longer than ${SHARE_MAX_BYTES} bytes, so ${capped.dropped} bytes were dropped from the END. ` +
        'The beginning is intact and the slot says so in a comment. Split the rest across another slot if it mattered.'
    )
  }
  return ok(lines.join('\n'))
}

async function shareClear(args) {
  const root = shareRoot()
  if (!root) return noRoot()
  const index = wantSlot(args)
  const path = slotPath(root, index)
  try {
    if (!existsSync(path)) return ok(`Slot ${index} was already empty.`)
    unlinkSync(path)
  } catch (err) {
    return fail(`Slot ${index} could not be emptied: ${err?.message ?? err}.`)
  }
  return ok(`Slot ${index} is now empty.`)
}

async function sharePanes() {
  /*
   * The link first, the file second. `panes.json` is written by the renderer's
   * roster push, which only happens while the rail's SHARE section is open — so
   * in most projects the file is stale or absent, while main always knows what
   * is running. A failure to reach the link is not reported here: falling back
   * to the file silently is right, because the file is a perfectly good answer
   * and the two tools that genuinely need the link say so themselves.
   */
  if (linkPath()) {
    try {
      const reply = await linkAsk({ op: 'panes' })
      if (reply?.ok && Array.isArray(reply.panes) && reply.panes.length > 0) {
        return ok(
          [
            `${reply.panes.length} pane${reply.panes.length === 1 ? '' : 's'} open in this project:`,
            ...reply.panes.map(paneLine),
            '',
            'Names come from Forge, and are what the person calls each pane. Use pane_send to say something to one.'
          ].join('\n')
        )
      }
    } catch {
      /* the file below is a perfectly good answer */
    }
  }

  const root = shareRoot()
  if (!root) return noRoot()
  const path = join(root, 'panes.json')
  if (!existsSync(path)) return ok('Forge has not written a pane roster for this project yet.')
  let panes = []
  try {
    panes = JSON.parse(readFileSync(path, 'utf8'))?.panes ?? []
  } catch (err) {
    return fail(`The pane roster could not be read: ${err?.message ?? err}.`)
  }
  if (!Array.isArray(panes) || panes.length === 0) return ok('No panes are open in this project.')
  return ok(
    [
      `${panes.length} pane${panes.length === 1 ? '' : 's'} open in this project:`,
      ...panes.map((p) => `  • ${String(p?.title ?? '?')} — ${String(p?.agent ?? 'unknown agent')}`),
      '',
      'Names come from Forge, and are what the person calls each pane.'
    ].join('\n')
  )
}

async function paneSend(args) {
  if (!linkPath()) return noLink()
  if (typeof args?.text !== 'string') return fail('`text` is required and must be a string.')
  if (typeof args?.pane !== 'string' || !args.pane.trim()) {
    return fail('`pane` is required — name the pane to type into. share_panes lists them.')
  }
  if (shareBytes(args.text) > SHARE_SEND_MAX_BYTES) {
    // Caught here as well as in main so the round trip is not spent on a message
    // that was always going to be refused.
    return fail(
      `That message is ${shareBytes(args.text)} bytes and the limit is ${SHARE_SEND_MAX_BYTES}. It is refused rather ` +
        'than cut in half. Put the long version in a share slot with share_write and send the slot number instead.'
    )
  }

  let reply
  try {
    reply = await linkAsk({
      op: 'send',
      pane: args.pane,
      text: args.text,
      ...(args?.force === true ? { force: true } : {}),
      ...(args?.multiline === true ? { multiline: true } : {})
    })
  } catch (err) {
    return fail(`Nothing was sent: ${err?.message ?? err}`)
  }
  if (!reply?.ok) return linkRefusal(reply)

  return ok(
    [
      `Typed into ${reply.pane}: it now has your message, prefixed with your pane's name.` +
        (reply.forced ? ' It was busy and you forced it, so you may have interrupted a turn.' : ''),
      `${reply.bytes} bytes. It will answer in its own pane — use pane_read on ${reply.pane} to see what it says.`
    ].join('\n')
  )
}

async function paneRead(args) {
  if (!linkPath()) return noLink()
  if (typeof args?.pane !== 'string' || !args.pane.trim()) {
    return fail('`pane` is required — name the pane to read. share_panes lists them.')
  }

  let reply
  try {
    reply = await linkAsk({
      op: 'read',
      pane: args.pane,
      ...(typeof args?.lines === 'number' ? { lines: args.lines } : {})
    })
  } catch (err) {
    return fail(`That pane could not be read: ${err?.message ?? err}`)
  }
  if (!reply?.ok) return linkRefusal(reply)

  if (!reply.text) {
    return ok(`${reply.pane} has printed nothing yet. It is ${reply.idle ? 'idle' : 'busy'}.`)
  }
  return ok(
    [
      `${reply.pane} — last ${reply.lines} line${reply.lines === 1 ? '' : 's'}, ` +
        `${reply.idle ? `idle for ${Math.round(reply.quietForMs / 1000)}s` : 'still working'}.`,
      '',
      '```text',
      reply.text,
      '```'
    ].join('\n')
  )
}

/* -------------------------------------------------------------------- serve */

const HANDLERS = {
  share_list: shareList,
  share_read: shareRead,
  share_write: shareWrite,
  share_clear: shareClear,
  share_panes: sharePanes,
  pane_send: paneSend,
  pane_read: paneRead
}

const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const handler = HANDLERS[name]
  if (!handler) return fail(`Unknown tool: ${name}. This server offers: ${Object.keys(HANDLERS).join(', ')}.`)
  try {
    return await handler(args ?? {})
  } catch (err) {
    // Bad arguments and unexpected throws both come back as tool errors so the
    // agent can correct itself instead of the connection dropping.
    return fail(`${name} failed: ${err?.message ?? String(err)}`)
  }
})

async function main() {
  await server.connect(new StdioServerTransport())
  const root = shareRoot()
  process.stderr.write(
    `[${SERVER_NAME}] ready (cwd: ${process.cwd()}, scratchpad: ${root ?? 'NONE FOUND — every tool will say so'}` +
      `, author: ${defaultAuthor() || 'unset'}, link: ${linkPath() || 'none — pane_send/pane_read will say so'})\n`
  )
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}\n`)
  process.exit(1)
})

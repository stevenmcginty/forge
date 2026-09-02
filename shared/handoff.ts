import { capBody, shareBytes, shareStamp, tidyTitle, SHARE_MAX_BYTES } from './share'
import type { HandoffBody, HandoffRecord, HandoffStatus } from './types'

/**
 * The *format* of a handoff pack: one markdown file per handoff, and the same
 * rule the shared scratchpad is built on — **the files are the truth, and Forge
 * keeps no index.**
 *
 * A handoff is one agent writing down what it was doing so another agent, from
 * any vendor, can pick the work up. Forge creates the file with a header and a
 * template, types a prompt into the source pane, and watches the file fill; the
 * agent fills it with the file tools it already has. An index alongside would be
 * invalidated by exactly the thing the feature exists for, so there is none —
 * `.forge/handoff/*.md` is the whole state.
 *
 * Its corollary is the second rule, also inherited: **the reader never refuses.**
 * Missing front matter, corrupt front matter, CRLF, a BOM — every one of them
 * still yields a usable record, because a pack an agent hand-wrote is a supported
 * way to fill one rather than a corruption to repair.
 *
 * No file I/O, no Electron, no DOM — which is what lets the main process
 * (electron/handoff-store.ts, which owns the files) and the renderer (the pane's
 * Handoff control) agree on the shape without either owning the other. The same
 * arrangement shared/share.ts has with electron/share-store.ts, and the byte
 * rules are literally that module's: `capBody`, `shareBytes`, `tidyTitle` and
 * `shareStamp` are imported rather than restated, so a handoff and a slot can
 * never disagree about what 64 KiB means.
 */

/* -------------------------------------------------------------------- caps */

/** Where the packs live, relative to the project. Beside `.forge/share`. */
export const HANDOFF_DIR_REL = '.forge/handoff'

/**
 * The same cap as a slot, and deliberately the same number: a handoff pack and a
 * scratchpad slot are the same kind of object — a document one agent writes for
 * another to read — and two caps would be two rules to remember.
 */
export const HANDOFF_MAX_BYTES = SHARE_MAX_BYTES

/**
 * Under this, the take-over prompt inlines the pack as well as naming the path —
 * the target agent can start reading now, saves a tool round trip, and cannot end
 * up holding a stale copy. Over it, the path only. Same rule, same number as
 * SHARE_HANDOFF_INLINE_MAX.
 */
export const HANDOFF_INLINE_MAX = 4000

/** The front-matter keys Forge writes, in the order it writes them. */
export const HANDOFF_KEYS = [
  'id',
  'title',
  'status',
  'from',
  'fromAgent',
  'fromTitle',
  'to',
  'toAgent',
  'toTitle',
  'origin',
  'createdAt',
  'updatedAt',
  'transcript'
] as const

const STATUS_VALUES: readonly HandoffStatus[] = ['open', 'ready', 'taken']

/* ---------------------------------------------------------------- identity */

/** `20260902-141233-9f0a.md`. The only place a handoff filename is built. */
export function handoffFileName(id: string): string {
  return `${id}.md`
}

/** `.forge/handoff/<id>.md` — what a prompt tells an agent to open. */
export function handoffRelPath(id: string): string {
  return `${HANDOFF_DIR_REL}/${handoffFileName(id)}`
}

/**
 * `YYYYMMDD-HHMMSS-xxxx`, and nothing else.
 *
 * The id *is* the filename, so this is the whole of the traversal argument: no
 * caller ever supplies a path, the renderer passes an id, and an id that does not
 * match this shape never reaches `join()`. Sortable by construction, which is why
 * the list needs no index to be in order.
 */
export function isHandoffId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(value)
}

function pad(n: number | string, width: number): string {
  return String(n).padStart(width, '0')
}

/**
 * A fresh id for right now.
 *
 * Local time rather than UTC, because the id is what a person reads in Explorer
 * and "the one from this morning" should say so. The four hex digits break the
 * tie between two handoffs started in the same second, which two panes can do.
 */
export function newHandoffId(now: number = Date.now()): string {
  const d = new Date(Number.isFinite(now) && now > 0 ? now : 0)
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}-${pad(d.getHours(), 2)}${pad(
    d.getMinutes(),
    2
  )}${pad(d.getSeconds(), 2)}`
  const rand = Math.floor(Math.random() * 0x10000)
  return `${stamp}-${pad(rand.toString(16), 4)}`
}

/* ----------------------------------------------------------- the template */

/**
 * The body Forge writes at creation, and the shape every pack has.
 *
 * Seven headings, each with one parenthesised line saying what belongs under it.
 * The parentheses are load-bearing: they are how `isFilled` tells a template
 * nobody has touched from a pack somebody wrote, without Forge having to diff
 * against a remembered copy of this string.
 *
 * `<title>` is substituted by `handoffTemplate`. It is left in the constant so
 * the constant is the file, and so a check can assert `isFilled(HANDOFF_TEMPLATE)`
 * is false without inventing a title first.
 */
export const HANDOFF_TEMPLATE = `# Handoff: <title>

## Goal
(what we are building, in two or three sentences)

## Done
(what already works, with the evidence)

## Left to do
(the next steps, in order)

## Files touched
(paths, one per line, with a few words on each)

## Decisions
(choices made and why — the ones a newcomer would otherwise re-open)

## How to test
(the exact commands and what passing looks like)

## Gotchas
(anything that bit us)
`

/** The template with the handoff's title in its heading. */
export function handoffTemplate(title: string): string {
  return HANDOFF_TEMPLATE.replace('<title>', tidyTitle(title) || 'Untitled')
}

/**
 * Is this one of the template's own prompts?
 *
 * A whole line in parentheses, which is what every line of the template that is
 * not a heading is. Exported so scripts/handoff-check.mjs can pin the rule rather
 * than re-deriving it — the rule *is* the open→ready transition, and a change to
 * it that nothing noticed would leave a pane waiting forever.
 */
export function isPlaceholderLine(line: string): boolean {
  const flat = String(line ?? '').trim()
  // `> 2`, so a bare `()` is content rather than a prompt: a placeholder is a
  // parenthesised *instruction*, and an empty pair is something somebody typed.
  return flat.startsWith('(') && flat.endsWith(')') && flat.length > 2
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(String(line ?? '').trim())
}

/**
 * Has the source agent actually written the pack?
 *
 * Two conditions, and both are needed. The first — that the text differs from the
 * template beyond whitespace — catches an agent that saved the file without
 * changing it. The second — that at least one line is neither a heading nor a
 * placeholder — is the one that does the work: an agent that reorders, renames or
 * adds headings has still written nothing, and an agent that deleted the
 * placeholders without replacing them has written nothing either.
 *
 * This is the whole of `open → ready`. It is deliberately conservative: a pack
 * that stays `open` a moment too long is a button that lights up late, and a pack
 * that goes `ready` early is an agent handed an empty template.
 */
export function isFilled(body: string): boolean {
  const text = String(body ?? '')
  const flatten = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (flatten(text) === flatten(HANDOFF_TEMPLATE)) return false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (isHeadingLine(line)) continue
    if (isPlaceholderLine(line)) continue
    return true
  }
  return false
}

/* --------------------------------------------------------------- rendering */

function flatten(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/** An empty record, for a caller that has to name every field. */
export function emptyHandoff(id: string, now = 0): HandoffRecord {
  return {
    id,
    title: 'Untitled',
    status: 'open',
    from: '',
    fromAgent: '',
    fromTitle: '',
    to: '',
    toAgent: '',
    toTitle: '',
    origin: '',
    createdAt: now,
    updatedAt: now,
    transcript: '',
    bytes: 0,
    filled: false
  }
}

/**
 * A pack as a file. Front matter, a blank line, then the body verbatim.
 *
 * `bytes` and `filled` are not written: they are functions of the body, and a
 * header carrying a number the body contradicts is a header nobody can trust.
 */
export function formatHandoff(record: HandoffRecord, body: string): string {
  const head = [
    '---',
    `id: ${record.id}`,
    `title: ${tidyTitle(record.title)}`,
    `status: ${STATUS_VALUES.includes(record.status) ? record.status : 'open'}`,
    `from: ${flatten(record.from)}`,
    `fromAgent: ${flatten(record.fromAgent)}`,
    `fromTitle: ${flatten(record.fromTitle)}`,
    `to: ${flatten(record.to)}`,
    `toAgent: ${flatten(record.toAgent)}`,
    `toTitle: ${flatten(record.toTitle)}`,
    `origin: ${flatten(record.origin)}`,
    `createdAt: ${shareStamp(record.createdAt)}`,
    `updatedAt: ${shareStamp(record.updatedAt)}`,
    `transcript: ${flatten(record.transcript)}`,
    '---'
  ].join('\n')
  return `${head}\n\n${body}`
}

/* ----------------------------------------------------------------- parsing */

/**
 * Read a pack back.
 *
 * The id comes from the caller — which in practice means from the filename —
 * rather than from the front matter, exactly as `parseSlot` takes its index: the
 * file's name is its identity, and a header claiming a different id is a header
 * that is wrong about which file it is in.
 *
 * `mtimeMs` is passed in rather than stat'ed here, both to keep this pure and
 * because it is the honest fallback for a pack whose header never said when it
 * was written. Nothing in here throws and nothing is rejected.
 */
export function parseHandoff(id: string, text: string, mtimeMs = 0): HandoffBody {
  const raw = String(text ?? '').replace(/^﻿/, '')

  let body = raw
  const front = new Map<string, string>()

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
      // Everything after the terminator, less the one blank line formatHandoff
      // puts there. An unterminated header leaves body === raw, which is the
      // tolerant answer: better a pack with a visible header in it than a pack
      // that reads as empty and never goes ready.
      const terminator = new RegExp(`^(?:[^\\n]*\\n){${end + 1}}`)
      const after = terminator.exec(raw)
      body = after ? raw.slice(after[0].length) : ''
      if (body.startsWith('\r\n')) body = body.slice(2)
      else if (body.startsWith('\n')) body = body.slice(1)
    }
  }

  const created = Date.parse(front.get('createdat') ?? '')
  const updated = Date.parse(front.get('updatedat') ?? '')
  const statusRaw = (front.get('status') ?? '') as HandoffStatus

  return {
    record: {
      id,
      title: tidyTitle(front.get('title') ?? '') || 'Untitled',
      status: STATUS_VALUES.includes(statusRaw) ? statusRaw : 'open',
      from: front.get('from') ?? '',
      fromAgent: front.get('fromagent') ?? '',
      fromTitle: front.get('fromtitle') ?? '',
      to: front.get('to') ?? '',
      toAgent: front.get('toagent') ?? '',
      toTitle: front.get('totitle') ?? '',
      origin: front.get('origin') ?? '',
      createdAt: Number.isFinite(created) ? created : mtimeMs,
      updatedAt: Number.isFinite(updated) ? updated : mtimeMs,
      transcript: front.get('transcript') ?? '',
      bytes: shareBytes(body),
      filled: isFilled(body)
    },
    body
  }
}

/** A body as it is shown, never as it is stored. Never truncates the file. */
export function capHandoffBody(body: string): string {
  return capBody(body).body
}

/* ----------------------------------------------------------------- prompts */

/**
 * What Forge types into the *source* pane.
 *
 * One paragraph and the template, in that order, because that is the order the
 * agent needs them: what it is doing, where, what the rules are, and what "done"
 * sounds like. The last sentence matters most — the pane's status only leaves
 * `open` when the file fills, so an agent that writes the pack and says nothing
 * is still a handoff that worked; the line is there so a *person* watching the
 * pane can see it happen.
 *
 * Forge never presses Enter. Delivery is the renderer's, exactly as it is for
 * every other prompt Forge composes.
 */
export function handoffAskPrompt(record: HandoffRecord): string {
  const who = flatten(record.toAgent) || 'another agent'
  const parts = [
    `Write a handoff pack so that ${who} can take over this work.`,
    `Open \`${handoffRelPath(record.id)}\` — it already has a front-matter header and a template.`,
    'Keep the header exactly as it is.',
    'Replace every placeholder line in parentheses with real content.',
    'Be concrete: real paths, real commands, real decisions.',
    'When the file is saved, reply with the single line HANDOFF READY.'
  ]
  const transcript = flatten(record.transcript)
  if (transcript) parts.push(`Your transcript is at ${transcript} if you need to check details.`)

  return `${parts.join(' ')}\n\n${handoffTemplate(record.title)}`
}

/**
 * What Forge types into the *target* pane.
 *
 * "Do not edit the pack" is the load-bearing line. The pack is the record of what
 * the first agent decided, and an agent that helpfully rewrites it as it works has
 * destroyed the one thing that makes handing the work *back* possible.
 *
 * The body is inlined under HANDOFF_INLINE_MAX characters, same rule and same
 * reasoning as sharePrompt: the agent can start now, and cannot end up holding a
 * copy that has since moved.
 */
export function handoffTakePrompt(record: HandoffRecord, body: string | null): string {
  const from = flatten(record.fromAgent) || 'the other agent'
  const pane = flatten(record.fromTitle)
  const head = [
    `Take over from ${from}${pane ? ` (pane "${pane}")` : ''} in this same folder.`,
    `Read \`${handoffRelPath(record.id)}\` — the handoff pack — then continue from "Left to do".`,
    'Do not edit the pack.',
    'When you are done or stuck, say so and I will hand it back.'
  ].join(' ')

  if (!body || body.length > HANDOFF_INLINE_MAX) return `${head}\n`
  return `${head}\n\n${body.replace(/\s+$/, '')}\n`
}

import type { ShareSlot, ShareSlotBody, ShareVia } from './types'

/**
 * The *format* of a project's shared scratchpad: five markdown files, and the
 * one rule that makes them safe to hand to five agents at once — **the files
 * are the truth, and Forge keeps no index of its own.**
 *
 * That rule is the whole design. The point of the feature is that a Codex pane
 * can fill a slot by writing the file with its own tools, so any index Forge
 * kept alongside would be invalidated by exactly the thing the feature exists
 * for, and reconciling "the index says X, the file says Y" has no correct
 * answer. So there is no index. Reading five files of at most 64 KiB behind a
 * settle timer is cheaper than the `git status` the rail already runs.
 *
 * Its corollary is the second rule: **the reader never refuses.** Missing front
 * matter, corrupt front matter, CRLF, a BOM, a raw paste with no header at all —
 * every one of them still produces a usable slot, because a file an agent wrote
 * by hand is a supported way to fill a slot rather than a corruption to repair.
 *
 * No file I/O, no Electron, no DOM — which is what lets the main process
 * (electron/share-store.ts, which owns the files) and the renderer (the rail's
 * SHARE section) agree on the shape without either owning the other. The same
 * arrangement shared/memory.ts has with electron/memory-store.ts.
 *
 * ⚠ Deliberately duplicated in bridge/share-bridge.mjs, which must run under
 * bare `node` with no build step and so cannot import a `.ts` module. This file
 * is canonical; scripts/share-check.mjs reads both and asserts the caps, the
 * truncation marker and the front-matter keys still match, so the two cannot
 * drift silently.
 */

/* -------------------------------------------------------------------- caps */

/**
 * Five, and not a number the user can raise.
 *
 * Five is small enough to address without listing first — "put it in slot 2" is
 * a thing you can say to an agent — and small enough that reading all of them is
 * a reasonable thing for an agent to do. A scratchpad with forty slots is a
 * folder, and a folder is what the project already is.
 */
export const SHARE_SLOTS = 5

/**
 * Per slot. 64 KiB is roughly 16k tokens: long enough for a real specification,
 * short enough that an agent told to read every slot spends under 100k
 * characters doing it.
 *
 * There is deliberately no *total* cap. The total is bounded by construction at
 * SHARE_SLOTS × SHARE_MAX_BYTES, and a second cap would need a rule for whose
 * slot to sacrifice when the total was hit — a question with no honest answer.
 */
export const SHARE_MAX_BYTES = 64 * 1024

/** A title is a row in a 240px rail, not a sentence. */
export const SHARE_MAX_TITLE = 60

/** How much of a pane's screen "Capture pane" takes, and the most it will. */
export const SHARE_CAPTURE_DEFAULT_LINES = 120
export const SHARE_CAPTURE_MAX_LINES = 400

/** What a row shows of a body it is not displaying. */
export const SHARE_PREVIEW_CHARS = 240

/**
 * Under this, "send to pane" inlines the body in the prompt as well as naming
 * the path — an agent that can read it now saves a tool round trip and cannot
 * end up holding a stale copy. Over it, the path only.
 */
export const SHARE_HANDOFF_INLINE_MAX = 4000

/** panes.json is a roster, not a log. */
export const SHARE_MAX_PANES = 32

/** The front-matter keys Forge writes, in the order it writes them. */
export const SHARE_KEYS = ['slot', 'title', 'updatedAt', 'author', 'via'] as const

const VIA_VALUES: readonly ShareVia[] = ['rail', 'mcp', 'capture', 'agent']

/* ---------------------------------------------------------------- identity */

/**
 * `slot-2.md`. Fixed filenames rather than slugs, because the *index* is the
 * slot's identity: the title is metadata that can change without renaming
 * anything, and — the part that matters — no caller ever supplies a path. The
 * renderer and the MCP tools pass an integer, this function is the only place a
 * filename is built, and traversal is impossible by construction rather than
 * sanitised after the fact.
 */
export function slotFileName(index: number): string {
  return `slot-${index}.md`
}

/** 1..SHARE_SLOTS, and an integer. Everything else is refused. */
export function isSlotIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SHARE_SLOTS
}

/** Every slot index, in order. What `list()` iterates. */
export function slotIndexes(): number[] {
  return Array.from({ length: SHARE_SLOTS }, (_, i) => i + 1)
}

/* ------------------------------------------------------------------- bytes */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function shareBytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * The byte index at or below `limit` that does not sit inside a character.
 *
 * UTF-8 continuation bytes are `10xxxxxx`, so a boundary is any byte that is not
 * one. Cutting without this check is how a slot ends in U+FFFD.
 */
function cutAt(bytes: Uint8Array, limit: number): number {
  let end = Math.min(Math.max(0, limit), bytes.length)
  while (end > 0 && end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end--
  return end
}

/** The comment a truncated body ends with. Also how `truncated` is detected. */
export function truncationMarker(dropped: number): string {
  return `\n\n<!-- forge: truncated at ${SHARE_MAX_BYTES} bytes; ${dropped} bytes were dropped -->\n`
}

/** Does this body carry the marker above? */
export function isTruncatedBody(body: string): boolean {
  return /<!-- forge: truncated at \d+ bytes; \d+ bytes were dropped -->/.test(body)
}

/**
 * Bring a body under SHARE_MAX_BYTES, and say so in the body itself.
 *
 * **Head-keeping.** The top of a scratchpad is the brief; the tail is the part
 * that was still being written. Callers who care about the other end — pane
 * capture, which wants the *last* 120 lines — tail-limit their input before
 * calling this, so there is exactly one truncation rule in the codebase rather
 * than two that disagree.
 *
 * Never silent: `share_write` reports the loss in its *success* text so the
 * agent knows its tail is gone, and the rail shows a chip on the row.
 *
 * The marker's own length is budgeted using `total` rather than `dropped`, which
 * is the same number of digits or more — so the result is always at or under the
 * cap, never one digit over it.
 */
export function capBody(body: string): { body: string; truncated: boolean; dropped: number } {
  const text = String(body ?? '')
  const bytes = encoder.encode(text)
  if (bytes.length <= SHARE_MAX_BYTES) return { body: text, truncated: false, dropped: 0 }

  const budget = SHARE_MAX_BYTES - shareBytes(truncationMarker(bytes.length))
  let kept = decoder.decode(bytes.slice(0, cutAt(bytes, budget)))

  // Back to the last line break, so a slot never ends mid-sentence — unless
  // there is no line break at all, in which case a blunt cut is the only cut.
  const lastBreak = kept.lastIndexOf('\n')
  if (lastBreak > 0) kept = kept.slice(0, lastBreak)

  const dropped = bytes.length - shareBytes(kept)
  return { body: `${kept}${truncationMarker(dropped)}`, truncated: true, dropped }
}

/* -------------------------------------------------------------- title, body */

/** One line, bounded, and never a newline — a newline breaks the front matter. */
export function tidyTitle(title: string): string {
  const flat = String(title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= SHARE_MAX_TITLE) return flat
  return `${flat.slice(0, SHARE_MAX_TITLE - 1).trim()}…`
}

/** What a row shows. Newlines collapsed, never split through a surrogate pair. */
export function previewOf(body: string): string {
  const flat = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= SHARE_PREVIEW_CHARS) return flat
  let end = SHARE_PREVIEW_CHARS
  const code = flat.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${flat.slice(0, end).trim()}…`
}

export function shareLines(body: string): number {
  if (!body) return 0
  return body.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length
}

/* ---------------------------------------------------------------- rendering */

/** `2026-08-08T10:22:41Z` — sortable, and readable in a file people open. */
export function shareStamp(at: number): string {
  const ms = Number.isFinite(at) && at > 0 ? at : 0
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * A slot as a file. Front matter, a blank line, then the body verbatim.
 *
 * The body is written exactly as handed over — including a body whose first line
 * is `---`, which the parser handles because it stops at the *first* terminator
 * after the header rather than the last one in the file.
 */
export function formatSlot(slot: {
  index: number
  title: string
  body: string
  updatedAt: number
  author: string
  via: ShareVia
}): string {
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

/* ------------------------------------------------------------------ parsing */

/**
 * A title for a body that never gave one.
 *
 * The first heading if there is one, otherwise the first line of prose — which
 * beats "Slot 3" for a file an agent wrote itself, and is the common case for
 * exactly those files. A rule (`---`, `***`) is skipped rather than used: it is
 * what the leftovers of an unterminated front matter block look like, and
 * "`---`" is a worse title than the number.
 */
function firstHeading(body: string): string {
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

/**
 * Read a slot file back.
 *
 * `mtimeMs` is passed in rather than stat'ed here, both to keep this pure and
 * because it is the honest fallback for a file whose front matter never said
 * when it was written — which is every file an agent wrote itself.
 *
 * Nothing in here throws and nothing is rejected. A file that is not in Forge's
 * format is read as `via: 'agent'` with its title taken from the first heading,
 * because that is exactly what it is.
 */
export function parseSlot(index: number, text: string, mtimeMs = 0): ShareSlotBody {
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
      // Everything after the terminator line, less the one blank line
      // formatSlot puts there. An unterminated header leaves body === raw,
      // which is the tolerant answer: better a slot with a visible header in it
      // than a slot that reads as empty.
      const terminator = new RegExp(`^(?:[^\\n]*\\n){${end + 1}}`)
      const after = terminator.exec(raw)
      body = after ? raw.slice(after[0].length) : ''
      if (body.startsWith('\r\n')) body = body.slice(2)
      else if (body.startsWith('\n')) body = body.slice(1)
    }
  }

  const stamped = Date.parse(front.get('updatedat') ?? '')
  const viaRaw = (front.get('via') ?? '') as ShareVia
  const title = tidyTitle(front.get('title') ?? '') || firstHeading(body) || `Slot ${index}`

  return {
    index,
    title,
    body,
    bytes: shareBytes(body),
    updatedAt: Number.isFinite(stamped) ? stamped : mtimeMs,
    author: front.get('author') ?? '',
    via: VIA_VALUES.includes(viaRaw) ? viaRaw : 'agent',
    truncated: isTruncatedBody(body)
  }
}

/* -------------------------------------------------------------- the row view */

/** A parsed slot as the rail sees it: preview instead of body. */
export function slotOf(parsed: ShareSlotBody): ShareSlot {
  return {
    index: parsed.index,
    filled: parsed.body.trim().length > 0,
    title: parsed.title,
    preview: previewOf(parsed.body),
    bytes: parsed.bytes,
    lines: shareLines(parsed.body),
    updatedAt: parsed.updatedAt,
    author: parsed.author,
    via: parsed.via,
    truncated: parsed.truncated
  }
}

/* --------------------------------------------------------------- the link
 *
 * The second half of the feature, and the one that is not a file: a pane can
 * *type into* another pane. The slots above are a noticeboard — you leave
 * something and hope somebody looks. The link is a tap on the shoulder.
 *
 * Everything below is protocol rather than format: the names of the two
 * environment variables, the timings the idle gate uses, and the shape of a
 * request and a reply. It lives here for the same reason the format does —
 * electron/share-link.ts owns the server, bridge/share-bridge.mjs owns the
 * client, and neither may own the other's idea of what a request looks like.
 */

/** The pipe (or unix socket) path. Set per-pane by Forge; the client's only way in. */
export const SHARE_LINK_ENV = 'FORGE_SHARE_LINK'

/**
 * The exact share directory for this pane's project.
 *
 * Forge knows which project a pane belongs to; the server would otherwise have
 * to guess by walking up from its cwd. The walk stays as the fallback for a
 * server started by hand, but a pane Forge launched is told outright.
 */
export const SHARE_DIR_ENV = 'FORGE_SHARE_DIR'

/**
 * The most one pane may type into another in a single message.
 *
 * 8 KiB is a long paragraph of instruction and nowhere near a document — a
 * document belongs in a slot, which is what the slots are for. Over it the send
 * is *refused* rather than truncated: half an instruction typed into somebody
 * else's agent is worse than none, and the caller can split it.
 */
export const SHARE_SEND_MAX_BYTES = 8 * 1024

/** How much of a pane's screen `pane_read` returns by default. Capped by SHARE_CAPTURE_MAX_LINES. */
export const SHARE_READ_DEFAULT_LINES = 60

/**
 * The idle gate, mirrored from the renderer's own busy heuristic
 * (src/lib/terminals.ts) so the two cannot disagree about what "working" means.
 *
 * A keystroke echo is one chunk and then silence; an agent thinking is a spinner
 * repainting for as long as it takes. So a pane is idle when it has been quiet
 * for QUIET *and* nothing in the last WINDOW looked like a run of work: a run is
 * output whose gaps stay under GAP, and it counts as work once it has lasted
 * ONSET.
 *
 * Requiring both is the point. Quiet alone is satisfied by the 1.2s pause an
 * agent takes between two tool calls, and typing into that pause is typing over
 * somebody's shoulder.
 */
export const SHARE_BUSY_ONSET_MS = 600
export const SHARE_BUSY_GAP_MS = 400
export const SHARE_BUSY_QUIET_MS = 1200
export const SHARE_BUSY_WINDOW_MS = 3000

/** A request line longer than this is a client that has lost its mind, not a message. */
export const SHARE_LINK_MAX_REQUEST_BYTES = 64 * 1024

/** What a caller says. One JSON object, one line, one reply. */
export interface ShareLinkRequest {
  op: 'send' | 'read' | 'panes'
  /** The calling pane's name — `FORGE_SHARE_AGENT`. Unknown names are refused. */
  from?: string
  /** The calling process's cwd, used only to break a tie between same-named panes. */
  cwd?: string
  /** Which pane to act on: its name, its id, or its agent if only one pane runs that agent. */
  pane?: string
  text?: string
  force?: boolean
  multiline?: boolean
  lines?: number
}

/** One pane, as the link describes it to a caller. */
export interface ShareLinkPaneView {
  id: string
  title: string
  agent: string
  idle: boolean
  quietForMs: number
}

export type ShareLinkResponse =
  | { ok: true; op: 'send'; pane: string; id: string; bytes: number; quietForMs: number; forced: boolean }
  | { ok: true; op: 'read'; pane: string; id: string; text: string; idle: boolean; quietForMs: number; lines: number }
  | { ok: true; op: 'panes'; panes: ShareLinkPaneView[] }
  | { ok: false; error: string; candidates?: string[]; panes?: ShareLinkPaneView[]; quietForMs?: number }

/** The empty pigeonhole, for a slot with no file. */
export function emptySlot(index: number): ShareSlot {
  return {
    index,
    filled: false,
    title: `Slot ${index}`,
    preview: '',
    bytes: 0,
    lines: 0,
    updatedAt: 0,
    author: '',
    via: 'agent',
    truncated: false
  }
}

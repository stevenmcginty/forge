import { statSync } from 'node:fs'
import type { ChatBlock, ChatTurn, ChatUpdate } from '@shared/chat'
import { createTail, type Tail } from '../jsonl-tail'

/**
 * A Claude pane's conversation, read off disk and distilled for a browser.
 *
 * Forge Web already mirrors a pane's *screen*, and that is the wrong surface
 * for reading back what was said: a TUI redraws, wraps to the desk's grid, and
 * throws its scrollback away every time the width changes (`noteWidth` in
 * electron/pty-host.ts). The conversation itself is not on the screen at all —
 * it is on disk, in the transcript Claude Code writes for every session at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, which is the same file
 * resume-on-restore, the tasks panel and the activity tracker already depend on.
 *
 * So this module tails that file and turns it into `ChatTurn`s. What comes out
 * is deliberately much smaller than what goes in — see the header of
 * shared/chat.ts — and this file is the only thing on the desktop that knows
 * the JSONL's shape. electron/web/server.ts never learns there is a file.
 *
 * **The tailing lives elsewhere.** Byte offsets, the carry buffer, the read
 * ceiling, the folder watch and the poll backstop are all in
 * electron/jsonl-tail.ts, which the planner watcher and the activity tracker
 * already share. What is left here is the parsing and the batching.
 *
 * ## Three things worth knowing before changing anything here
 *
 * **One tail per pane, however many browsers.** Two phones and a laptop reading
 * one conversation are three subscribers on one file handle and one parse. A
 * subscriber that arrives late is seeded from the turns already held rather than
 * by re-reading the file, so the second reader costs a `JSON.stringify` and
 * nothing else. The refcount is here rather than in the server because the
 * thing being counted is a file handle, and the server does not know there is
 * one.
 *
 * **A tool's result arrives after the turn that called it.** Claude writes the
 * `tool_use` in an assistant record and the `tool_result` in a *later* user
 * record, often many seconds later. The result is not a turn of its own — no
 * reader wants "Bash said this" as a paragraph — so it is folded back into the
 * tool block that asked for it, and that block's turn is said again on the wire
 * with the same `id`. `ChatTurn.id` exists precisely so an append can be
 * matched against what the client already holds; a turn arriving twice is the
 * same turn, not a second one.
 *
 * **Nothing here writes.** The transcript belongs to Claude Code. This module
 * opens it read-only, through a tailer that closes the handle after every read.
 */

/**
 * How far back from the end of a transcript a fresh watch starts reading.
 *
 * A pane that has been going all week has a transcript hundreds of megabytes
 * long, and reading it whole would cost that much memory and parse time before
 * the first frame — for a view whose top-most turn nobody is going to scroll to.
 * The activity tracker seeds the same way and for the same reason
 * (ACTIVITY_TAIL_BYTES in shared/activity.ts); this number is larger than that
 * one because this reader wants a *conversation* to scroll back through rather
 * than the last few minutes of file touches, and 400KB of JSONL is on the order
 * of a hundred turns once the tool inputs and the usage bookkeeping are dropped.
 *
 * Seeding mid-file is the reason `ChatUpdate.truncated` exists: the turns before
 * the first one sent are on disk and were not read, and the view draws a rule
 * saying so rather than implying the conversation began there.
 */
const SEED_TAIL_BYTES = 400 * 1024

/**
 * Most turns held for one pane. Older ones fall off the front and bump
 * `truncated`, exactly as seeding mid-file does — from the reader's side the two
 * are the same fact, which is that the conversation goes back further than what
 * is on screen.
 *
 * 500 rather than a size in bytes because the cost this bounds is the *reset*:
 * a new subscriber is sent everything held, in one frame, and a thousand turns
 * of a talkative session is a frame nobody wants on a phone.
 */
const MAX_TURNS = 500

/**
 * How long appended lines are collected before they are sent.
 *
 * Claude writes a reply as several records in quick succession — a thinking
 * block, some words, three tool calls — and the file watcher fires on each
 * write. Without this, one reply is a dozen frames and a dozen React renders.
 * 150ms is below what anybody reads as lag and above the gap between the writes
 * of a single reply.
 */
const FLUSH_MS = 150

/** Longest `thinking` carried. A long think is a summary here, not a payload. */
const MAX_THINKING_CHARS = 2000

/** Longest one-line gist of a tool's input — a path, a command, a pattern. */
const MAX_GIST_CHARS = 120

/** Longest one-line note taken off a tool's result. */
const MAX_NOTE_CHARS = 200

/**
 * The tool input fields worth showing, best first.
 *
 * The reader is skimming: what they want off a `Read` is the path, off a `Bash`
 * the command, off a `Grep` the pattern. The order is the order those answers
 * are most telling in, and the first field a call actually carries wins — which
 * is why `description` and `prompt` are last rather than absent. They are a
 * model's own prose about what it is doing, which is better than nothing and
 * worse than the thing itself.
 */
const GIST_FIELDS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'] as const

/* -------------------------------------------------------------------- state */

/** One browser reading one pane. */
type Sub = (update: ChatUpdate) => void

type ToolRef = {
  /** The block itself, mutated in place when its result turns up. */
  block: Extract<ChatBlock, { kind: 'tool' }>
  /** The turn holding it, so it can be said again once the block changed. */
  turn: ChatTurn
}

type Watch = {
  /** The pane id, for the log line. */
  paneId: string
  file: string
  tail: Tail
  /** Every reader, and whether it has had its opening picture yet. */
  subs: Map<Sub, { seeded: boolean }>
  /** Newest last, capped at MAX_TURNS. */
  turns: ChatTurn[]
  byId: Map<string, ChatTurn>
  /** `tool_use.id` → the block waiting for its result. */
  tools: Map<string, ToolRef>
  truncated: boolean
  /** Turns to send on the next flush: new ones, and ones a result changed. */
  pending: ChatTurn[]
  pendingIds: Set<string>
  flush: NodeJS.Timeout | null
}

/** Keyed by pane id — one file, one parse, however many browsers. */
const watches = new Map<string, Watch>()

/* ---------------------------------------------------------------- lifecycle */

/**
 * Start reading `file` for `paneId`, or join the read already happening.
 *
 * The caller has already decided that this pane has a transcript and where it
 * is; this module does not know what a pane is beyond a key to file the watch
 * under. Returns nothing, because there is nothing that can fail here that the
 * caller could act on — a file that goes away is a tail that finds nothing,
 * which is also what a session that has not spoken yet looks like.
 *
 * The opening `reset` is not sent from inside this call. It goes out on the
 * flush timer like everything else, so the request that provoked the watch is
 * answered before the first frame of it arrives.
 */
export function watchTranscript(paneId: string, file: string, onUpdate: Sub): void {
  const open = watches.get(paneId)
  if (open) {
    // The same pane, a different file: the pane was given a new Claude session
    // (a fresh `--session-id`, a resumed conversation forked). The old tail is
    // following a conversation nobody is in any more, so it goes.
    if (open.file !== file) stopAll(paneId)
    else {
      open.subs.set(onUpdate, { seeded: false })
      schedule(open)
      return
    }
  }

  const w: Watch = {
    paneId,
    file,
    tail: createTail({
      file,
      label: 'transcript',
      initialTailBytes: SEED_TAIL_BYTES,
      // Looked up rather than closed over, the same shape the activity tracker
      // uses: a tail that outlives its watch by a tick — stopped mid-drain, or
      // replaced because the pane was given a new session — then finds nothing
      // to deliver to instead of feeding a map nobody holds any more.
      onLine: (line) => {
        const current = watches.get(paneId)
        if (current) onLine(current, line)
      }
    }),
    subs: new Map([[onUpdate, { seeded: false }]]),
    turns: [],
    byId: new Map(),
    tools: new Map(),
    // Decided before a byte is read, because it is a fact about the file rather
    // than about the parse: a transcript longer than the seed is one the tail
    // will start part-way into, and every turn before that point is on disk and
    // will not be read. `createTail` makes the same comparison internally; it is
    // repeated here rather than reported back because the tailer is shared with
    // two other callers that have no use for the answer.
    truncated: sizeOf(file) > SEED_TAIL_BYTES,
    pending: [],
    pendingIds: new Set(),
    flush: null
  }
  watches.set(paneId, w)
  // Reads what is already on disk before it returns, synchronously, so the
  // opening picture is complete by the time the first flush fires.
  w.tail.start()
  schedule(w)
}

/**
 * One browser has stopped reading. The file is let go when the last one does.
 *
 * Takes the subscriber back rather than just the pane id, because two tabs
 * reading one pane are two subscriptions and a `transcript-stop` from one of
 * them must not blind the other.
 */
export function stopTranscript(paneId: string, onUpdate: Sub): void {
  const w = watches.get(paneId)
  if (!w) return
  w.subs.delete(onUpdate)
  if (w.subs.size === 0) stopAll(paneId)
}

/** Every reader of this pane is gone (it exited, or Forge is shutting down). */
export function stopAll(paneId: string): void {
  const w = watches.get(paneId)
  if (!w) return
  watches.delete(paneId)
  w.tail.stop()
  if (w.flush) clearTimeout(w.flush)
  w.flush = null
}

/** Every watch, everywhere — the way out of `disposeWebHost`. */
export function disposeTranscriptWatchers(): void {
  for (const paneId of [...watches.keys()]) stopAll(paneId)
}

/* ------------------------------------------------------------------ pushing */

function schedule(w: Watch): void {
  if (w.flush) return
  w.flush = setTimeout(() => {
    w.flush = null
    if (watches.get(w.paneId) !== w) return
    flush(w)
  }, FLUSH_MS)
}

/**
 * Send each reader what it is owed: everything, if it has not been seeded, and
 * otherwise whatever changed since the last flush.
 *
 * The two updates are built once and shared, which is safe because nothing on
 * the far side of a `send` mutates them — they are about to become JSON.
 */
function flush(w: Watch): void {
  const appends = w.pending
  w.pending = []
  w.pendingIds.clear()

  // A copy, not the live array. It is about to become JSON on a socket and so
  // the difference is invisible today — but a subscriber that holds what it was
  // handed would otherwise watch its own snapshot grow and re-order underneath
  // it, which is the kind of shared mutable state that is only ever found later.
  const reset: ChatUpdate = { reset: true, truncated: w.truncated, turns: [...w.turns] }
  // `truncated` is false on every append by construction: it is a claim about
  // the *start* of what the client holds, and an append does not move that.
  const update: ChatUpdate | null = appends.length ? { reset: false, truncated: false, turns: appends } : null

  for (const [sub, state] of w.subs) {
    if (!state.seeded) {
      state.seeded = true
      deliver(w, sub, reset)
      continue
    }
    if (update) deliver(w, sub, update)
  }
}

/**
 * One update, to one reader, with the throw caught.
 *
 * A subscriber is a socket send in the end, and a socket that dies between the
 * flush being scheduled and it running must not take the other readers of the
 * same pane down with it.
 */
function deliver(w: Watch, sub: Sub, update: ChatUpdate): void {
  try {
    sub(update)
  } catch (err) {
    console.error(`[transcript] a reader of ${w.paneId} threw:`, err)
  }
}

/* ------------------------------------------------------------------ reading */

/**
 * One transcript line.
 *
 * Every failure is swallowed, on purpose and for the reason the planner watcher
 * gives: this file is appended to by another process while we read it, and it
 * carries a dozen record types this feature knows nothing about — `system`,
 * `attachment`, `mode`, `ai-title`, `file-history-snapshot` and the rest. A line
 * we cannot use is not an error, it is the normal case.
 */
function onLine(w: Watch, line: string): void {
  const text = line.trim()
  if (!text) return

  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return
  const entry = record as {
    type?: unknown
    uuid?: unknown
    timestamp?: unknown
    isSidechain?: unknown
    message?: { content?: unknown }
  }

  // A sub-agent's own conversation, threaded into its parent's transcript. It is
  // a different conversation with a different reader, and folding it into this
  // one would interleave two people talking.
  if (entry.isSidechain === true) return
  if (entry.type !== 'user' && entry.type !== 'assistant') return

  const uuid = typeof entry.uuid === 'string' ? entry.uuid : ''
  // No uuid, no identity: an append the client cannot match against what it
  // holds is a turn that would be drawn twice on the next reset.
  if (!uuid) return

  // The tail has gone back over ground it already covered — the file was
  // truncated or rewritten under it, and `createTail` answered by starting again
  // from zero (see its header). Carrying on would stack a second copy of the
  // conversation under the first, so the picture is started again instead.
  if (w.byId.has(uuid)) {
    reseed(w)
    return
  }

  const content = entry.message?.content

  if (entry.type === 'user') {
    // A string is somebody typing. An array is very often *not* a person at all:
    // Claude files each tool's result as a user record, because that is what it
    // is to the model. Those are folded back into the call that asked for them
    // rather than shown as turns — see `foldResults`.
    if (typeof content === 'string') {
      add(w, turnOf(uuid, 'user', entry.timestamp, content.trim() ? [{ kind: 'text', text: content }] : []))
      return
    }
    if (!Array.isArray(content)) return
    if (content.some((part) => partType(part) === 'tool_result')) {
      foldResults(w, content)
      return
    }
    add(w, turnOf(uuid, 'user', entry.timestamp, userBlocks(content)))
    return
  }

  if (!Array.isArray(content)) return
  const said = assistantBlocks(content)
  const turn = turnOf(uuid, 'assistant', entry.timestamp, said.blocks)
  if (!turn) return
  // The reservations are made here rather than inside `assistantBlocks`, because
  // the turn a block belongs to is built out of what that function returns and
  // so does not exist until now. A call whose turn was dropped as empty is a
  // call whose result has nowhere to go, which is why this is past the guard.
  for (const call of said.calls) w.tools.set(call.id, { block: call.block, turn })
  add(w, turn)
}

/**
 * Start the picture over: everything held is dropped, every reader is unseeded,
 * and the lines the tail is about to hand over rebuild it.
 *
 * `truncated` goes true rather than false. Whatever the tail is re-reading, this
 * watch has demonstrably lost turns it was holding a moment ago, and the honest
 * thing to tell a reader is that the conversation goes back further than what
 * they can see.
 */
function reseed(w: Watch): void {
  w.turns = []
  w.byId.clear()
  w.tools.clear()
  w.pending = []
  w.pendingIds.clear()
  w.truncated = true
  for (const state of w.subs.values()) state.seeded = false
  schedule(w)
}

/** File it, drop the oldest if the window is full, and queue it to be sent. */
function add(w: Watch, turn: ChatTurn | null): void {
  if (!turn) return
  w.turns.push(turn)
  w.byId.set(turn.id, turn)

  while (w.turns.length > MAX_TURNS) {
    const dropped = w.turns.shift()
    if (!dropped) break
    w.byId.delete(dropped.id)
    // The blocks going with it are no longer anywhere a result could be folded
    // into, so their reservations go too — otherwise `tools` grows for the life
    // of the pane.
    for (const [id, ref] of w.tools) if (ref.turn === dropped) w.tools.delete(id)
    // The window has closed over the front of the conversation, which is the
    // same fact as having seeded mid-file: there is more on disk than is here.
    w.truncated = true
  }

  queue(w, turn)
  schedule(w)
}

/**
 * Queue a turn for the next flush, once.
 *
 * Called both for a brand-new turn and for one an arriving tool result changed,
 * which is why it is idempotent: a reply with three tool calls whose results all
 * land in the same 150ms must be said once, not three times.
 *
 * Nothing is queued while no reader has been seeded — during the opening read,
 * and while a reseed is being rebuilt — because every one of those turns is
 * about to travel in the `reset` anyway.
 */
function queue(w: Watch, turn: ChatTurn): void {
  let seeded = false
  for (const state of w.subs.values()) if (state.seeded) seeded = true
  if (!seeded) return
  if (w.pendingIds.has(turn.id)) return
  w.pendingIds.add(turn.id)
  w.pending.push(turn)
}

/* ------------------------------------------------------------------ parsing */

function turnOf(id: string, role: 'user' | 'assistant', timestamp: unknown, blocks: ChatBlock[]): ChatTurn | null {
  // A record whose every block was empty or unreadable is not a turn. An empty
  // bubble is worse than no bubble: it reads as something the model said and
  // this desktop lost.
  if (!blocks.length) return null
  return { id, role, at: atOf(timestamp), blocks }
}

/**
 * The record's own timestamp, in milliseconds — and 0 when it has none this
 * side can read.
 *
 * Zero rather than `Date.now()`, which is what shared/activity.ts substitutes:
 * there the number is compared against a TTL and "now" is the safe guess, here
 * it is *drawn beside the words*, and a turn from last Tuesday labelled with
 * this second is a lie the reader has no way to catch. Zero is a value the view
 * can recognise and simply not label.
 */
function atOf(value: unknown): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function partType(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  const type = (part as { type?: unknown }).type
  return typeof type === 'string' ? type : ''
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The first line of something, clamped — what a one-line summary can hold. */
function oneLine(value: unknown, max: number): string {
  const text = str(value).trim()
  if (!text) return ''
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A person's prompt that arrived as blocks rather than as a string. */
function userBlocks(parts: unknown[]): ChatBlock[] {
  const out: ChatBlock[] = []
  for (const part of parts) {
    if (partType(part) !== 'text') continue
    const text = str((part as { text?: unknown }).text)
    if (text.trim()) out.push({ kind: 'text', text })
  }
  return out
}

/**
 * One assistant record's blocks, in the order they were said.
 *
 * Consecutive assistant records that continue a single reply stay separate
 * turns; they are not merged here. The view groups them visually, and merging
 * would mean rewriting a turn's identity every time the reply grew — which is
 * exactly the identity an append relies on.
 */
function assistantBlocks(parts: unknown[]): {
  blocks: ChatBlock[]
  /** The tool calls in it, paired with the id their result will name. */
  calls: { id: string; block: Extract<ChatBlock, { kind: 'tool' }> }[]
} {
  const out: ChatBlock[] = []
  const calls: { id: string; block: Extract<ChatBlock, { kind: 'tool' }> }[] = []
  for (const part of parts) {
    const type = partType(part)
    if (type === 'text') {
      const text = str((part as { text?: unknown }).text)
      if (text.trim()) out.push({ kind: 'text', text })
      continue
    }
    if (type === 'thinking') {
      // Real transcripts carry plenty of thinking blocks whose text is empty and
      // whose signature is not — reasoning the model produced and the API did
      // not return. There is nothing behind that disclosure to open, so it is
      // not offered.
      const text = str((part as { thinking?: unknown }).thinking).trim()
      if (text) out.push({ kind: 'thinking', text: clamp(text, MAX_THINKING_CHARS) })
      continue
    }
    if (type !== 'tool_use') continue
    const call = part as { id?: unknown; name?: unknown; input?: unknown }
    const name = str(call.name)
    if (!name) continue
    const block: Extract<ChatBlock, { kind: 'tool' }> = { kind: 'tool', name, gist: gistOf(call.input) }
    out.push(block)
    const id = str(call.id)
    if (id) calls.push({ id, block })
  }
  return { blocks: out, calls }
}

/**
 * The most telling thing a tool was asked, in one line.
 *
 * Never the whole input: an `Edit`'s `new_string` is a file, a `Write`'s
 * `content` is a file, and a reader skimming a conversation wants to know that
 * something was edited and which file — the diff is in the pane. So the fields
 * are an allow-list in priority order and everything else is dropped, which also
 * means a tool this desktop has never heard of degrades to a name and a blank
 * rather than to a paragraph of somebody's source code on a public wire.
 */
function gistOf(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const fields = input as Record<string, unknown>
  for (const field of GIST_FIELDS) {
    const gist = oneLine(fields[field], MAX_GIST_CHARS)
    if (gist) return gist
  }
  return ''
}

/**
 * Fold each `tool_result` in this record back into the call it answers.
 *
 * A result whose call is not held — it fell off the front of the window, or it
 * was made before this watch started reading — is dropped in silence. There is
 * nothing to attach it to and nothing a reader could do with it on its own.
 */
function foldResults(w: Watch, parts: unknown[]): void {
  for (const part of parts) {
    if (partType(part) !== 'tool_result') continue
    const result = part as { tool_use_id?: unknown; content?: unknown; is_error?: unknown }
    const ref = w.tools.get(str(result.tool_use_id))
    if (!ref) continue
    const note = noteOf(result.content)
    if (note) ref.block.note = note
    if (result.is_error === true) ref.block.failed = true
    if (!note && result.is_error !== true) continue
    // The block changed, so the turn holding it is said again — same id, so the
    // client replaces the turn it holds rather than drawing a second one. See
    // the note on `ChatTurn.id` in shared/chat.ts.
    queue(w, ref.turn)
    schedule(w)
  }
}

/**
 * A tool result's own one-liner, when there is one worth carrying.
 *
 * Three shapes turn up in real transcripts: a plain string, an array of `text`
 * blocks, and an array of something else entirely — an image, a list of tool
 * references. Only the first line of the first text is taken; the rest is the
 * output itself, which is what the terminal is for.
 */
function noteOf(content: unknown): string {
  if (typeof content === 'string') return oneLine(content, MAX_NOTE_CHARS)
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (partType(part) !== 'text') continue
    const note = oneLine((part as { text?: unknown }).text, MAX_NOTE_CHARS)
    if (note) return note
  }
  return ''
}

/* ----------------------------------------------------------------- the disk */

/** The transcript's size, or 0 when it is not there yet. Never throws. */
function sizeOf(file: string): number {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

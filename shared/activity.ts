import type { ActivityEntry, ActivityKind } from './types'

/**
 * The facts about file activity that both sides of the preload boundary need.
 *
 * Main watches the folder and reads the transcripts; the renderer draws the
 * tree. Neither can import the other, and almost every number here is one they
 * have to agree about — the renderer cannot honestly say "and 40 more" without
 * knowing the cap main evicted at, and it cannot say "N ignored" without the
 * same ignore list main filtered with. So the list, the constants, the parsers
 * and the merge rules live here once, the way shared/rail.ts holds the rail's
 * numbers, and there is no duplicated literal for a check script to police.
 *
 * Everything in this file is pure. No Node, no Electron, no DOM: it is driven
 * head-less by scripts/activity-check.mjs, which is the only way the attribution
 * rules ever get looked at directly — they are otherwise invisible behind a
 * folder watcher and a timing window that only exists while an agent is working.
 */

/* ------------------------------------------------------------------ the list */

/**
 * Folders whose contents are never worth a row.
 *
 * Two kinds are in here and it is worth knowing which is which. `node_modules`,
 * `.git` and `__pycache__` are noise an agent never means to edit. `dist`,
 * `out`, `build`, `release`, `bridge-dist` and `stt-dist` are output — an agent
 * genuinely did cause those writes, but showing them would bury the source file
 * it actually edited under two hundred build artefacts, which is the same as
 * showing nothing.
 */
export const ACTIVITY_IGNORE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  'bridge-dist',
  'stt-dist'
]

/** Files that are a side effect of work rather than the work. */
export const ACTIVITY_IGNORE_EXTS: readonly string[] = ['.log', '.tmp', '.lock', '.swp', '.pyc', '.map']

/**
 * The longest project-relative path worth attributing.
 *
 * Not a stylistic limit: Windows truncates or silently drops change events for
 * paths past MAX_PATH, so what arrives for a very deep file is as likely to be
 * half a path as a whole one. A row naming the wrong file is worse than no row,
 * so those events are dropped rather than guessed at.
 */
export const ACTIVITY_MAX_PATH = 260

const IGNORE_DIRS = new Set(ACTIVITY_IGNORE_DIRS)

/**
 * Is this project-relative path one the tree should never show?
 *
 * Takes forward slashes, because that is the form both halves normalise to
 * before they get here — git prints them, the tree is built from them, and
 * comparing a `path.join` result against a watcher's `filename` without picking
 * one form first is how you get two rows for one file.
 */
export function shouldIgnorePath(rel: string): boolean {
  const path = (rel ?? '').trim()
  if (!path) return true
  if (path.length > ACTIVITY_MAX_PATH) return true

  const segments = path.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (IGNORE_DIRS.has(segment)) return true
    // Every dotted segment, not just the leaf: `.vscode/settings.json` and
    // `src/.cache/x` are both housekeeping, and listing every dot-folder by name
    // is a list that goes stale the first time a tool invents a new one.
    if (segment.startsWith('.')) return true
  }

  const name = segments[segments.length - 1] ?? ''
  const lower = name.toLowerCase()
  // `endsWith`, so `package-lock.json` survives and `yarn.lock` does not — the
  // rule is about the extension, not about the word appearing in the name.
  return ACTIVITY_IGNORE_EXTS.some((ext) => lower.endsWith(ext))
}

/* ------------------------------------------------------------------- numbers */

/** How much of a transcript is read when a tail first opens. */
export const ACTIVITY_TAIL_BYTES = 512 * 1024

/** Coalesce the two or three events one save produces, per path. */
export const ACTIVITY_SETTLE_MS = 400

/** One snapshot at most this often, carrying the whole tree. */
export const ACTIVITY_PUSH_MS = 500

/** Entries kept per project before the oldest start falling off the end. */
export const ACTIVITY_MAX_ENTRIES = 400

/** How long a touch stays interesting. */
export const ACTIVITY_TTL_MS = 30 * 60 * 1000

/** The rolling window the burst brake counts events in. */
export const ACTIVITY_BURST_WINDOW_MS = 1000

/** Events in one window past which the folder is having a storm, not a save. */
export const ACTIVITY_BURST_MAX = 300

/** How long the watcher stays deaf after a storm. */
export const ACTIVITY_BURST_COOLDOWN_MS = 10_000

/**
 * How long after a pane stops working a file change still counts as its doing.
 *
 * A write lands after the spinner stops: the agent prints its answer, Forge sees
 * the output go quiet, and the editor's flush arrives a beat later. Without a
 * grace window the last edit of every turn is credited to nobody.
 */
export const ATTRIB_GRACE_MS = 1500

/* --------------------------------------------------------------- attribution */

/**
 * When a pane was working. `until` is null while it still is.
 *
 * Main cannot see a terminal's output, so these spans arrive from the renderer
 * over `activity:busy` — one message per edge, which is why that channel is a
 * send rather than an invoke.
 */
export interface ActivityBusySpan {
  since: number
  until: number | null
}

/**
 * Who to credit for a change at `at`.
 *
 * Three answers, and the last two are the ones that make this worth trusting:
 *
 *   a pane id  exactly one pane was working — credit it, marked inferred;
 *   `''`       more than one was — credit *nobody*, and say so in the tree under
 *              "Unattributed". An ambiguous guess is worse than a blank, because
 *              on screen it looks exactly like a certain one;
 *   `null`     none was — drop the event entirely. That is Steve saving a file
 *              in VS Code, and it is not agent activity.
 */
export function attribute(busy: ReadonlyMap<string, ActivityBusySpan>, at: number): string | null {
  let only = ''
  let count = 0
  for (const [paneId, span] of busy) {
    if (span.since > at) continue
    if (span.until !== null && at - span.until > ATTRIB_GRACE_MS) continue
    count += 1
    if (count > 1) return ''
    only = paneId
  }
  return count === 1 ? only : null
}

/* -------------------------------------------------------------- burst brake */

/**
 * The load defence, as opposed to the ignore list's row defence.
 *
 * Both are needed and they are not the same thing. The ignore list stops
 * `node_modules` becoming four hundred rows; it does nothing about the cost of
 * being *told* about fifty thousand files, which is fifty thousand callbacks
 * into this process whether they end in a row or not. A checkout, an `npm
 * install` or a build does exactly that, and the honest answer is to stop
 * listening for ten seconds and admit it in the snapshot.
 */
export interface BurstBrake {
  bucketStart: number
  count: number
  /** Deaf until this instant. */
  until: number
}

export function newBurstBrake(): BurstBrake {
  return { bucketStart: 0, count: 0, until: 0 }
}

/** True when this event should be thrown away. Mutates the brake. */
export function brakeDrops(brake: BurstBrake, now: number): boolean {
  if (now < brake.until) return true
  if (now - brake.bucketStart >= ACTIVITY_BURST_WINDOW_MS) {
    brake.bucketStart = now
    brake.count = 0
  }
  brake.count += 1
  if (brake.count > ACTIVITY_BURST_MAX) {
    brake.until = now + ACTIVITY_BURST_COOLDOWN_MS
    return true
  }
  return false
}

/* ------------------------------------------------------------------- paths */

/**
 * A path under `root`, as the tree wants it: relative, forward slashes.
 *
 * Null when the file is not in the project at all — an agent editing its own
 * config in `~/.claude` is a real thing that happens and is not this project's
 * activity.
 *
 * Compared lower-cased because NTFS is case-insensitive and the two sides
 * genuinely disagree: a folder picked from a dialog comes back `C:\Users\Steve`
 * and the same folder out of a transcript comes back `c:\users\steve`. The
 * returned path keeps the casing the file was given, so what is shown is what is
 * on disk.
 */
export function relativeTo(root: string, abs: string): string | null {
  const base = (root ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const full = (abs ?? '').replace(/\\/g, '/')
  if (!base || !full) return null
  if (full.length <= base.length) return null
  if (full.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return null
  if (full[base.length] !== '/') return null
  const rel = full.slice(base.length + 1)
  return rel || null
}

/** The map key an entry is stored under. One row per pane per file. */
export function activityKey(paneId: string, path: string): string {
  return `${paneId}\u0000${path.toLowerCase()}`
}

/* -------------------------------------------------- reading a Claude transcript */

/** One file a `tool_use` block named, and what it did to it. */
export interface ActivityTouch {
  path: string
  kind: ActivityKind
  at: number
}

/**
 * The four tools that name a file Forge can believe in.
 *
 * Everything else is ignored on purpose, and the omission is honest rather than
 * lazy. `Bash` is the interesting one: an agent running `sed -i` or `npx prettier
 * --write` really did edit files, and the transcript says only that it ran a
 * command. Those edits are caught by the inferred half, which is precisely what
 * the inferred half is for — so the two halves are complementary, not redundant.
 * `Glob`, `Grep`, `Task` and `WebFetch` touch nothing at all.
 */
const TOOL_KINDS: Record<string, ActivityKind> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Read: 'read'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The files one assistant message touched.
 *
 * Takes a parsed transcript record and returns nothing at all for the dozen
 * record types this feature knows nothing about. A record it cannot use is the
 * normal case, not an error — the file is appended to by another process and
 * carries a whole conversation, of which tool calls are a small part.
 */
export function toolUseEntries(record: unknown): ActivityTouch[] {
  if (!record || typeof record !== 'object') return []
  const entry = record as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
  if (entry.type !== 'assistant') return []

  const parts = entry.message?.content
  if (!Array.isArray(parts)) return []

  const at = transcriptAt(entry.timestamp)
  const out: ActivityTouch[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: unknown; name?: unknown; input?: Record<string, unknown> }
    if (p.type !== 'tool_use' || typeof p.name !== 'string') continue
    const kind = TOOL_KINDS[p.name]
    if (!kind) continue
    const input = p.input && typeof p.input === 'object' ? p.input : {}
    // NotebookEdit names its target `notebook_path`; `file_path` is accepted as
    // well because older transcripts used it and a missing row is not worth the
    // purity.
    const path = p.name === 'NotebookEdit' ? str(input['notebook_path']) || str(input['file_path']) : str(input['file_path'])
    if (!path) continue
    out.push({ path, kind, at })
  }
  return out
}

/** A transcript's ISO timestamp, or now when it has none we can read. */
export function transcriptAt(value: unknown, now = Date.now()): number {
  if (typeof value !== 'string') return now
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : now
}

/**
 * One transcript line, deduped.
 *
 * `seen` is the caller's set of message uuids. A tail re-reads from its offset
 * after a truncation, and a file the CLI rewrote can hand the same assistant
 * message over twice; without the set that shows up as a file with twice the
 * hits it earned. Every failure is swallowed for the reason given on
 * toolUseEntries: a line we cannot use is the normal case.
 */
export function transcriptTouches(line: string, seen: Set<string>): ActivityTouch[] {
  const text = (line ?? '').trim()
  if (!text) return []

  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return []
  }
  if (!record || typeof record !== 'object') return []

  const uuid = str((record as { uuid?: unknown }).uuid)
  if (uuid) {
    if (seen.has(uuid)) return []
    seen.add(uuid)
  }
  return toolUseEntries(record)
}

/* ------------------------------------------------------------------- merge */

/**
 * Everything one project has been seen to touch.
 *
 * `exact` holds the lower-cased paths a transcript has claimed, and it is what
 * makes the two halves add up rather than double-count. A file Claude's own
 * transcript named is also a file the folder watcher saw change, and without
 * this the same edit appears twice — once certain, once as a guess, in whichever
 * order the two mechanisms happened to fire.
 */
export interface ActivityStore {
  entries: Map<string, ActivityEntry>
  exact: Set<string>
  truncated: boolean
}

export function newActivityStore(): ActivityStore {
  return { entries: new Map(), exact: new Set(), truncated: false }
}

/**
 * Fold one touch in.
 *
 * **Exact beats inferred, permanently.** Writing an exact entry for a path
 * deletes every inferred entry for that path whichever pane held it, and the
 * path is remembered so a later guess about the same file is refused rather than
 * added beside the truth. This is the rule the whole panel's credibility rests
 * on: a `◆` and a `◇` on the same file, disagreeing about who did it, would make
 * a reader stop believing either glyph.
 */
export function recordActivity(store: ActivityStore, touch: ActivityEntry): void {
  const lower = touch.path.toLowerCase()

  if (touch.exactness === 'exact') {
    if (!store.exact.has(lower)) {
      store.exact.add(lower)
      for (const [key, entry] of store.entries) {
        if (entry.exactness === 'inferred' && entry.path.toLowerCase() === lower) store.entries.delete(key)
      }
    }
  } else if (store.exact.has(lower)) {
    return
  }

  const key = activityKey(touch.paneId, touch.path)
  const existing = store.entries.get(key)
  if (!existing) {
    store.entries.set(key, { ...touch, hits: Math.max(1, touch.hits) })
    return
  }
  existing.hits += 1
  existing.at = Math.max(existing.at, touch.at)
  existing.kind = touch.kind
  existing.profileId = touch.profileId || existing.profileId
}

/**
 * Forget what has gone stale, and what will not fit.
 *
 * TTL first, then the cap: an hour-old entry should go before a fresh one is
 * evicted for space, or a project left open overnight arrives in the morning
 * full of yesterday and unable to record today.
 */
export function sweepActivity(store: ActivityStore, now: number): void {
  for (const [key, entry] of store.entries) {
    if (now - entry.at > ACTIVITY_TTL_MS) store.entries.delete(key)
  }
  if (store.entries.size <= ACTIVITY_MAX_ENTRIES) return

  const oldestFirst = [...store.entries.entries()].sort((a, b) => a[1].at - b[1].at)
  const excess = store.entries.size - ACTIVITY_MAX_ENTRIES
  for (let i = 0; i < excess; i++) {
    const row = oldestFirst[i]
    if (row) store.entries.delete(row[0])
  }
  // Stays true once set. The tree really is missing something from here on, and
  // saying so only while the eviction was happening would be a note nobody ever
  // sees.
  store.truncated = true
}

/** Newest first — the order the tree and every group are built in. */
export function activityEntries(store: ActivityStore): ActivityEntry[] {
  return [...store.entries.values()].sort((a, b) => b.at - a.at)
}

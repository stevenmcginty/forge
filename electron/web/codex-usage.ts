import { closeSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebUsageFrame } from '@shared/web'
import { sortWindows, windowLabel } from '@shared/usage-windows'

/**
 * Each Codex pane's context window, read off Codex's own session files for
 * Forge Web's phone — the Codex half of electron/web/agent-usage.ts.
 *
 * Codex CLI 0.155 on Windows no longer draws its "% context left" footer
 * (openai/codex#17618), so the phone's footer scrape has nothing to read. The
 * numbers are on disk anyway: every Codex session writes a rollout,
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<local start time>-<session id>.jsonl
 *
 * whose first line is `session_meta` (with the `cwd` Codex was started in and
 * the session's start `timestamp`), and which gains an `event_msg` of type
 * `token_count` after every turn:
 *
 *   { info: { last_token_usage: { total_tokens, … }, model_context_window } }
 *
 * The same line carries the account's plan limits beside `info`:
 *
 *   rate_limits: { primary: { used_percent, window_minutes, resets_at }, secondary | null, plan_type }
 *
 * The slots are not fixed lengths — on a `go` plan `primary` is a 30-day
 * window and `secondary` is null — so each is labelled by `window_minutes`
 * (shared/usage-windows.ts) and never put in the phone's 5-hour or weekly slot.
 * The model and reasoning effort come from the newest `turn_context` line.
 *
 * The ring is Codex's own sum (codex-rs/tui/src/token_usage.rs,
 * `percent_of_context_window_remaining`): `last_token_usage.total_tokens` is
 * what is in context now, and a fixed 12k baseline — system prompt and tool
 * instructions nobody can shed — is taken off both it and the window, so a
 * fresh session reads 0% used rather than 5%. The phone gets 100 minus the
 * figure Codex's footer would have printed.
 *
 * **Which pane owns which file.** Forge records no Codex session id, so a
 * rollout is matched to a pane by folder and time, and only where that is not
 * a guess. A rollout can belong to a Codex pane that was open in its folder
 * when it was last written. Among those:
 *
 *  - started before every one of them: a `codex resume` of an older session.
 *    Any of them could have resumed it, so it is theirs only if there is one.
 *  - started within a minute of a pane's own start, and that pane has no
 *    earlier such file: the session the pane launched with (Codex stamps the
 *    session when the process starts, not at the first message). Two panes
 *    that opened in the same minute — a restored workspace — are both
 *    claimants, and neither gets it.
 *  - otherwise: a `/new` in one of the panes that were already open. Theirs
 *    only if there is one.
 *
 * A pane is shown the newest-written file that is its alone — unless a file
 * that might be its is newer still, because then the pane may have moved on
 * and the one it is sure of is out of date. A wrong ring is worse than none.
 * Panes that have closed are remembered for the matching, never told anything:
 * a sibling's finished session must not light up the pane that outlived it.
 *
 * The hole left open: `/resume` inside one of two Codex panes in the same
 * folder, onto a session the other started, is taken as the other's.
 *
 * Nothing here throws. A file that is missing, half-written, or not JSON is
 * skipped until the next look.
 */

/** Where Codex keeps its rollouts: `$CODEX_HOME/sessions`, `~/.codex/sessions` by default. */
export function defaultCodexSessionsDir(): string {
  const home = process.env.CODEX_HOME?.trim()
  return join(home || join(homedir(), '.codex'), 'sessions')
}

/** A live Codex pane, as the reader needs it. */
export interface CodexPane {
  id: string
  /** The folder the pane launched in — Codex's `session_meta.cwd`. */
  cwd: string
  /** Epoch ms. */
  startedAt: number
}

/** The backstop tick, as agent-usage's. */
const POLL_MS = 5000

/** Coalesce the burst of events one append produces. */
const SETTLE_MS = 150

/** A file not written for this long is a session nobody is in, as agent-usage's. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000

/** How long after a pane opens its Codex may stamp the session it launched with. */
const BIRTH_MS = 60 * 1000

/** Codex's fixed baseline — codex-rs/tui/src/token_usage.rs `BASELINE_TOKENS`. */
const BASELINE_TOKENS = 12_000

/** The first read of a file's tail; grown by four each time no turn is found in it. */
const TAIL_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 4 * 1024 * 1024

/** The `session_meta` line carries Codex's whole system prompt, so it can be long. */
const HEAD_BYTES = 64 * 1024
const MAX_HEAD_BYTES = 1024 * 1024

export interface CodexUsageOptions {
  /** Codex's sessions folder. */
  dir: string
  /** The live Codex panes. */
  panes: () => CodexPane[]
  /** A pane's numbers changed. Called only on a change, never twice with the same numbers. */
  onUsage: (frame: WebUsageFrame) => void
  pollMs?: number
  maxAgeMs?: number
  birthMs?: number
}

export interface CodexUsage {
  /** Look again now. Naming a pane forgets what it was last told, as agent-usage's. */
  rescan: (paneId?: string) => void
  stop: () => void
}

type Meta = { folder: string; start: number }
type Turn = {
  context: NonNullable<WebUsageFrame['context']>
  windows: NonNullable<WebUsageFrame['windows']>
  at: number
}
/** What the newest `turn_context` says the session is running. */
type Settings = { model?: string; effort?: string }
type Rollout = { file: string; folder: string; start: number; written: number; turn?: Turn; settings?: Settings }
type Known = CodexPane & { folder: string; goneAt?: number }

export function startCodexUsage(options: CodexUsageOptions): CodexUsage {
  const { dir, panes, onUsage } = options
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS
  const birthMs = options.birthMs ?? BIRTH_MS
  let watcher: FSWatcher | null = null
  let settle: NodeJS.Timeout | null = null
  let stopped = false
  /** Every Codex pane seen while running, closed ones included until they age out. */
  const known = new Map<string, Known>()
  /** `session_meta` never changes, so a file's is read once. null = not a rollout. */
  const metas = new Map<string, Meta | null>()
  /**
   * The latest turn, reused while the file's size holds, and the newest
   * `turn_context`, found by reading only what was appended since `scanned`.
   */
  const turns = new Map<string, { size: number; turn?: Turn; settings?: Settings; scanned: number }>()
  /** What each pane was last told, as a comparable string. */
  const lastKey = new Map<string, string>()

  const attach = (): void => {
    if (watcher || stopped) return
    try {
      watcher = watch(dir, { recursive: true }, () => {
        if (settle || stopped) return
        settle = setTimeout(() => {
          settle = null
          scan()
        }, SETTLE_MS)
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      // No folder yet — Codex has never run here. The poll tries again.
      watcher = null
    }
  }

  const detach = (): void => {
    watcher?.close()
    watcher = null
  }

  const scan = (): void => {
    if (stopped) return
    let live: CodexPane[]
    try {
      live = panes()
    } catch {
      return
    }
    const now = Date.now()
    const liveIds = new Set(live.map((p) => p.id))
    for (const pane of live) known.set(pane.id, { ...pane, folder: folderKey(pane.cwd) })
    for (const [id, pane] of known) {
      if (liveIds.has(id)) continue
      if (pane.goneAt === undefined) pane.goneAt = now
      else if (now - pane.goneAt > maxAgeMs) known.delete(id)
    }
    for (const paneId of [...lastKey.keys()]) if (!liveIds.has(paneId)) lastKey.delete(paneId)
    // No Codex pane, nothing to say: the disk is not even looked at.
    if (live.length === 0) {
      detach()
      return
    }
    attach()

    const folders = new Set([...known.values()].map((p) => p.folder))
    const earliest = Math.min(...[...known.values()].map((p) => p.startedAt))
    const rollouts: Rollout[] = []
    const seen = new Set<string>()
    for (const file of rolloutFiles(dir)) {
      let written: number
      let size: number
      try {
        const stat = statSync(file)
        if (!stat.isFile()) continue
        // Codex holds its rollout open, and Windows does not move a file's
        // mtime until the handle closes — ctime moves with every append.
        written = Math.max(stat.mtimeMs, stat.ctimeMs)
        size = stat.size
      } catch {
        continue
      }
      if (now - written > maxAgeMs || written < earliest) continue
      seen.add(file)
      let meta = metas.get(file)
      if (meta === undefined) {
        const read = readMeta(file, size)
        if (read === 'pending') continue
        meta = read
        metas.set(file, meta)
      }
      if (!meta || !folders.has(meta.folder)) continue
      let held = turns.get(file)
      if (!held || held.size !== size) {
        // A file that grew is read on from where the last look stopped; one
        // that shrank, or is new, from its tail.
        const grew = held && size > held.size ? held : undefined
        const found = readSettings(file, grew?.scanned, size)
        held = {
          size,
          turn: readLastTurn(file, size, written),
          settings: found.settings ?? grew?.settings,
          scanned: found.scanned
        }
        turns.set(file, held)
      }
      rollouts.push({ file, folder: meta.folder, start: meta.start, written, turn: held.turn, settings: held.settings })
    }
    for (const file of [...turns.keys()]) if (!seen.has(file)) turns.delete(file)
    for (const file of [...metas.keys()]) if (!seen.has(file)) metas.delete(file)

    // Who could own each file, folder by folder, oldest session first so a
    // pane's launch session is known before its later ones are weighed.
    const owners = new Map<Rollout, Known[]>()
    const born = new Set<string>()
    rollouts.sort((a, b) => a.start - b.start)
    for (const rollout of rollouts) {
      const eligible = [...known.values()].filter(
        (p) => p.folder === rollout.folder && p.startedAt <= rollout.written && (p.goneAt ?? Infinity) >= rollout.start
      )
      if (eligible.length === 0) continue
      const creators = eligible.filter((p) => p.startedAt <= rollout.start)
      if (creators.length === 0) {
        owners.set(rollout, eligible)
        continue
      }
      const claimants = creators.filter((p) => !born.has(p.id) && rollout.start - p.startedAt <= birthMs)
      if (claimants.length === 1) {
        born.add(claimants[0].id)
        owners.set(rollout, claimants)
      } else if (claimants.length > 1) {
        owners.set(rollout, claimants)
      } else owners.set(rollout, creators)
    }

    const told = new Set<string>()
    for (const pane of live) {
      let mine: Rollout | undefined
      let doubt = 0
      for (const [rollout, who] of owners) {
        if (!who.some((p) => p.id === pane.id)) continue
        if (who.length === 1) {
          if (!mine || rollout.written > mine.written) mine = rollout
        } else doubt = Math.max(doubt, rollout.written)
      }
      if (!mine?.turn || doubt > mine.written) continue
      told.add(pane.id)
      const frame: WebUsageFrame = {
        type: 'usage',
        sessionId: pane.id,
        context: mine.turn.context,
        source: 'codex-session',
        at: mine.turn.at,
        windows: mine.turn.windows,
        ...(mine.settings?.model ? { model: mine.settings.model } : {}),
        ...(mine.settings?.effort ? { effort: mine.settings.effort } : {})
      }
      const key = JSON.stringify([frame.context, frame.windows, frame.model ?? null, frame.effort ?? null])
      if (lastKey.get(pane.id) === key) continue
      lastKey.set(pane.id, key)
      try {
        onUsage(frame)
      } catch (err) {
        console.error('[usage] a Codex frame could not be handed on:', err)
      }
    }
    // A pane that lost its match is told afresh if it gets one back.
    for (const paneId of [...lastKey.keys()]) if (!told.has(paneId)) lastKey.delete(paneId)
  }

  const poll = setInterval(scan, options.pollMs ?? POLL_MS)
  poll.unref?.()
  scan()

  return {
    rescan: (paneId) => {
      if (paneId) lastKey.delete(paneId)
      scan()
    },
    stop: () => {
      stopped = true
      clearInterval(poll)
      if (settle) clearTimeout(settle)
      settle = null
      detach()
    }
  }
}

/* ------------------------------------------------------------------ reading */

/** The same folder, however it was spelled: slashes, a trailing one, and case on Windows. */
function folderKey(cwd: string): string {
  const key = cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

/** Every `YYYY/MM/DD/rollout-*.jsonl` under the sessions folder. */
function rolloutFiles(dir: string): string[] {
  const out: string[] = []
  const list = (path: string): string[] => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  }
  for (const year of list(dir)) {
    if (!/^\d{4}$/.test(year)) continue
    for (const month of list(join(dir, year))) {
      if (!/^\d{2}$/.test(month)) continue
      for (const day of list(join(dir, year, month))) {
        if (!/^\d{2}$/.test(day)) continue
        const folder = join(dir, year, month, day)
        for (const name of list(folder)) {
          if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(join(folder, name))
        }
      }
    }
  }
  return out
}

/** Bytes `[start, end)` of a file as text, or null when it cannot be read. */
function readRange(file: string, start: number, end: number): string | null {
  return readBytes(file, start, end)?.toString('utf8') ?? null
}

/** Bytes `[start, end)` of a file, or null when it cannot be read. */
function readBytes(file: string, start: number, end: number): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(end - start)
    const got = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, got)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/** The first line's folder and session start, null if it is not a rollout, 'pending' while it is still being written. */
function readMeta(file: string, size: number): Meta | null | 'pending' {
  for (let bytes = HEAD_BYTES; ; bytes *= 4) {
    const text = readRange(file, 0, Math.min(size, bytes))
    if (text === null) return 'pending'
    const end = text.indexOf('\n')
    if (end < 0) {
      if (size <= bytes) return 'pending'
      if (bytes >= MAX_HEAD_BYTES) return null
      continue
    }
    let line: { timestamp?: unknown; type?: unknown; payload?: { cwd?: unknown; timestamp?: unknown } }
    try {
      line = JSON.parse(text.slice(0, end))
    } catch {
      return null
    }
    if (line?.type !== 'session_meta' || typeof line.payload?.cwd !== 'string' || !line.payload.cwd) return null
    const start = time(line.payload.timestamp) ?? time(line.timestamp)
    return start === undefined ? null : { folder: folderKey(line.payload.cwd), start }
  }
}

/**
 * The newest `token_count` that carries a context reading, from the end of the
 * file backwards. The last line is skipped unless it is finished — Codex may be
 * halfway through writing it.
 */
function readLastTurn(file: string, size: number, written: number): Turn | undefined {
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    const start = Math.max(0, size - bytes)
    const text = readRange(file, start, size)
    if (text === null) return undefined
    const end = text.lastIndexOf('\n')
    const lines = end < 0 ? [] : text.slice(0, end).split('\n')
    // A read that starts mid-file starts mid-line.
    if (start > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue
      const turn = turnOf(lines[i], written)
      if (turn) return turn
    }
    if (start === 0 || bytes >= MAX_TAIL_BYTES) return undefined
  }
}

/**
 * The newest `turn_context`'s model and effort in bytes `[from, size)`, and how
 * far the complete lines went. Without `from`, the file's tail is read and its
 * first, partial line dropped. A turn_context carries the turn's whole
 * instructions, so it is found by reading on from where the last look stopped
 * rather than backwards from the end every time.
 */
function readSettings(file: string, from: number | undefined, size: number): { settings?: Settings; scanned: number } {
  const start = from ?? Math.max(0, size - MAX_TAIL_BYTES)
  if (start >= size) return { scanned: start }
  const buf = readBytes(file, start, size)
  if (!buf) return { scanned: start }
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) return { scanned: start }
  const lines = buf.subarray(0, end).toString('utf8').split('\n')
  if (from === undefined && start > 0) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"turn_context"')) continue
    const settings = settingsOf(lines[i])
    if (settings) return { settings, scanned: start + end + 1 }
  }
  return { scanned: start + end + 1 }
}

function settingsOf(text: string): Settings | undefined {
  let line: {
    type?: unknown
    payload?: { model?: unknown; effort?: unknown; collaboration_mode?: { settings?: { reasoning_effort?: unknown } } }
  }
  try {
    line = JSON.parse(text)
  } catch {
    return undefined
  }
  if (line?.type !== 'turn_context' || !line.payload) return undefined
  const model = str(line.payload.model)
  const effort = str(line.payload.effort) ?? str(line.payload.collaboration_mode?.settings?.reasoning_effort)
  if (!model && !effort) return undefined
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

function turnOf(text: string, written: number): Turn | undefined {
  let line: { timestamp?: unknown; payload?: { type?: unknown; info?: unknown; rate_limits?: unknown } }
  try {
    line = JSON.parse(text)
  } catch {
    return undefined
  }
  if (line?.payload?.type !== 'token_count') return undefined
  const info = line.payload.info as { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } | null
  if (!info || typeof info !== 'object') return undefined
  const windowTokens = num(info.model_context_window)
  const usedTokens = num(info.last_token_usage?.total_tokens)
  if (!windowTokens || windowTokens <= 0 || usedTokens === undefined || usedTokens < 0) return undefined
  const usedPct =
    windowTokens <= BASELINE_TOKENS
      ? 100
      : (Math.max(0, usedTokens - BASELINE_TOKENS) / (windowTokens - BASELINE_TOKENS)) * 100
  return {
    context: { usedPct: Math.min(100, Math.max(0, usedPct)), usedTokens, windowTokens },
    windows: windowsOf(line.payload.rate_limits),
    at: time(line.timestamp) ?? written
  }
}

/** `rate_limits.{primary, secondary}`, each labelled by its own length. [] for an API-key login. */
function windowsOf(value: unknown): Turn['windows'] {
  if (!value || typeof value !== 'object') return []
  const rl = value as { primary?: unknown; secondary?: unknown }
  const out: Turn['windows'] = []
  for (const slot of [rl.primary, rl.secondary]) {
    if (!slot || typeof slot !== 'object') continue
    const w = slot as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }
    const minutes = num(w.window_minutes)
    const used = num(w.used_percent)
    if (!minutes || minutes <= 0 || used === undefined) continue
    const resetsAt = num(w.resets_at)
    out.push({
      minutes,
      label: windowLabel(minutes),
      usedPct: Math.min(100, Math.max(0, used)),
      ...(resetsAt && resetsAt > 0 ? { resetsAt } : {})
    })
  }
  return sortWindows(out)
}

function time(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

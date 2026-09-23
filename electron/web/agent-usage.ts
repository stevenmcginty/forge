import { readdirSync, readFileSync, statSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSessionId } from '@shared/session'
import type { WebUsageFrame } from '@shared/web'

/**
 * Each Claude pane's context window, and the account's 5-hour and weekly
 * limits, read off disk for Forge Web's phone.
 *
 * The terminal footer already prints these numbers, and scraping it is what
 * `status.context` does (src/lib/feed.ts). That fails on a phone: the phone owns
 * a narrow grid, and Claude Code truncates its status line to fit. So the
 * numbers are taken one step earlier, from the JSON Claude Code pipes to the
 * user's statusLine command on every redraw. Steve's command
 * (`~/.claude/statusline.js`) leaves a copy of the relevant half in
 * `~/.claude/forge-status/<claude-session-id>.json`, written to a temp name and
 * renamed so a read never sees half a file:
 *
 *   { session_id, context_window, rate_limits, model, at }
 *
 * This module watches that folder, turns each file into a `WebUsageFrame` for
 * the pane that owns the session, and hands it over when the numbers changed.
 * Pacing and replay are electron/web/server.ts's; which pane owns which session
 * is web-host's (`paneSessionId`, the same mapping the chat view uses).
 *
 * **Limits are the account's, not the pane's.** Every session reports the same
 * two windows, so the newest file that carries them speaks for every Claude
 * pane — a pane that has been quiet for an hour would otherwise show the
 * numbers from an hour ago.
 *
 * **Codex is not here.** Codex writes the same kind of numbers into its rollout
 * JSONL, but Forge records no Codex session id, and matching a pane to a
 * rollout by folder and start time is a guess the moment two Codex panes share
 * a folder. A wrong ring is worse than none.
 *
 * Nothing here throws. A file that is missing, half-written, or not JSON is
 * skipped until the next look.
 */

/** Where statusline.js writes. Only the real host uses it; a check passes its own. */
export function defaultStatusDir(): string {
  return join(homedir(), '.claude', 'forge-status')
}

/** The backstop tick. `fs.watch` on Windows drops events, and sometimes its handle. */
const POLL_MS = 5000

/** Coalesce the burst of events one rename produces. */
const SETTLE_MS = 150

/** A file this old is a session nobody is in; its numbers are not shown. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * A file this old is deleted. One file per Claude session ever run would
 * otherwise grow the folder, and the stat of every file, without bound. A
 * session resumed later writes its file again on its first redraw.
 */
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface AgentUsageOptions {
  /** The folder statusline.js writes into. */
  dir: string
  /** Live panes by the Claude session each owns: Claude session id → pane id. */
  panes: () => Map<string, string>
  /** A pane's numbers changed. Called only on a change, never twice with the same numbers. */
  onUsage: (frame: WebUsageFrame) => void
  pollMs?: number
  maxAgeMs?: number
}

export interface AgentUsage {
  /**
   * Look again now — for a pane that has just opened on a session whose file
   * is already there. Naming the pane forgets what it was last told, so a pane
   * restarted under the same id is told again rather than taken as unchanged.
   */
  rescan: (paneId?: string) => void
  stop: () => void
}

type Status = {
  sessionId: string
  at: number
  context?: WebUsageFrame['context']
  limits?: WebUsageFrame['limits']
}

export function startAgentUsage(options: AgentUsageOptions): AgentUsage {
  const { dir, panes, onUsage } = options
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS
  let watcher: FSWatcher | null = null
  let settle: NodeJS.Timeout | null = null
  let stopped = false
  /** Parsed files, keyed by session, reused while the file's mtime and size hold. */
  const cache = new Map<string, { mtimeMs: number; size: number; status: Status | null }>()
  /** What each pane was last told, as a comparable string. */
  const lastKey = new Map<string, string>()

  const attach = (): void => {
    if (watcher || stopped) return
    try {
      watcher = watch(dir, () => {
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
      // The folder is not there yet — no Claude session has drawn a status line
      // since statusline.js learned to write. The poll tries again.
      watcher = null
    }
  }

  const scan = (): void => {
    if (stopped) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    attach()

    const now = Date.now()
    const fresh: Status[] = []
    const present = new Set<string>()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      if (!isSessionId(sessionId)) continue
      const file = join(dir, name)
      let mtimeMs: number
      let size: number
      try {
        const stat = statSync(file)
        if (!stat.isFile()) continue
        mtimeMs = stat.mtimeMs
        size = stat.size
      } catch {
        continue
      }
      const age = now - mtimeMs
      if (age > PRUNE_AGE_MS) {
        try {
          unlinkSync(file)
        } catch {
          /* in use, or already gone: the next look tries again */
        }
        continue
      }
      if (age > maxAgeMs) continue
      present.add(sessionId)
      const held = cache.get(sessionId)
      let status: Status | null
      if (held && held.mtimeMs === mtimeMs && held.size === size) status = held.status
      else {
        status = readStatus(file, sessionId, mtimeMs)
        cache.set(sessionId, { mtimeMs, size, status })
      }
      if (status) fresh.push(status)
    }
    for (const sessionId of [...cache.keys()]) if (!present.has(sessionId)) cache.delete(sessionId)

    // The account's limits, from whichever session spoke last.
    let limits: Status['limits']
    let limitsAt = 0
    for (const status of fresh) {
      if (status.limits && status.at > limitsAt) {
        limits = status.limits
        limitsAt = status.at
      }
    }

    let owners: Map<string, string>
    try {
      owners = panes()
    } catch {
      return
    }
    const told = new Set<string>()
    for (const status of fresh) {
      const paneId = owners.get(status.sessionId)
      if (!paneId) continue
      if (!status.context && !limits) continue
      told.add(paneId)
      const frame: WebUsageFrame = {
        type: 'usage',
        sessionId: paneId,
        ...(status.context ? { context: status.context } : {}),
        ...(limits ? { limits } : {}),
        source: 'claude-statusline',
        at: Math.max(status.at, limitsAt)
      }
      const key = JSON.stringify([frame.context ?? null, frame.limits ?? null])
      if (lastKey.get(paneId) === key) continue
      lastKey.set(paneId, key)
      try {
        onUsage(frame)
      } catch (err) {
        console.error('[usage] a frame could not be handed on:', err)
      }
    }
    // A pane that has gone, or whose file went stale, is told afresh if it
    // comes back — a new socket may have joined in between.
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
      watcher?.close()
      watcher = null
    }
  }
}

/* ------------------------------------------------------------------ reading */

function readStatus(file: string, sessionId: string, mtimeMs: number): Status | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const json = raw as { session_id?: unknown; context_window?: unknown; rate_limits?: unknown; at?: unknown }
  // The name is the key; a body that names another session is not trusted.
  if (json.session_id !== undefined && json.session_id !== sessionId) return null
  const context = contextOf(json.context_window)
  const limits = limitsOf(json.rate_limits)
  return {
    sessionId,
    at: num(json.at) ?? mtimeMs,
    ...(context ? { context } : {}),
    ...(limits ? { limits } : {})
  }
}

/**
 * `used_percentage` as Claude Code reports it, with the tokens in context the
 * same way statusline.js counts them: the four kinds of input and output on the
 * latest turn. `current_usage` is null before the first reply.
 */
function contextOf(value: unknown): WebUsageFrame['context'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const cw = value as { used_percentage?: unknown; context_window_size?: unknown; current_usage?: unknown }
  const size = num(cw.context_window_size)
  const windowTokens = size && size > 0 ? size : undefined
  let usedTokens: number | undefined
  if (cw.current_usage && typeof cw.current_usage === 'object') {
    const u = cw.current_usage as Record<string, unknown>
    usedTokens =
      (num(u.input_tokens) ?? 0) +
      (num(u.output_tokens) ?? 0) +
      (num(u.cache_creation_input_tokens) ?? 0) +
      (num(u.cache_read_input_tokens) ?? 0)
  }
  let usedPct = num(cw.used_percentage)
  if (usedPct === undefined && usedTokens !== undefined && windowTokens) usedPct = (usedTokens / windowTokens) * 100
  if (usedPct === undefined) return undefined
  return {
    usedPct: pct(usedPct),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(windowTokens ? { windowTokens } : {})
  }
}

/** `rate_limits.{five_hour, seven_day}`. Absent for an API-key session. */
function limitsOf(value: unknown): WebUsageFrame['limits'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rl = value as { five_hour?: unknown; seven_day?: unknown }
  const fiveHour = windowOf(rl.five_hour)
  const week = windowOf(rl.seven_day)
  if (!fiveHour && !week) return undefined
  return { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) }
}

function windowOf(value: unknown): { usedPct: number; resetsAt?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const w = value as { used_percentage?: unknown; resets_at?: unknown }
  const used = num(w.used_percentage)
  if (used === undefined) return undefined
  // Epoch seconds, as statusline.js reads it. A string is taken as a date.
  let resetsAt = num(w.resets_at)
  if (resetsAt === undefined && typeof w.resets_at === 'string') {
    const ms = Date.parse(w.resets_at)
    if (Number.isFinite(ms)) resetsAt = Math.floor(ms / 1000)
  }
  return { usedPct: pct(used), ...(resetsAt && resetsAt > 0 ? { resetsAt } : {}) }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

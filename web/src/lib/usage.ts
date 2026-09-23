import { useSyncExternalStore } from 'react'
import type { WebUsageFrame } from '@shared/web'
import type { PaneStatus } from '@/lib/rich'

/**
 * How full each pane's context window is, and how much of the account's
 * 5-hour and weekly limits are gone — the status line's ring and the sheet
 * behind it.
 *
 * Two sources, in this order:
 *
 *  1. The desktop's `usage` frame (WEB_FEATURE_USAGE). Read off disk by the
 *     desktop, so it is exact, and it has tokens and limits. The latest frame
 *     per pane is kept here; the desktop replays them after every `hello-ok`.
 *  2. The agent's own footer, as this pane's screen shows it
 *     (`status.footer`). Only when no frame has arrived for the pane — an older
 *     desktop, or a pane that has not drawn its status line yet. Approximate,
 *     and often missing on a phone-width grid, where the CLI truncates its
 *     footer to fit. Missing reads as nothing: no ring is better than a wrong
 *     number.
 *
 * Module-level like lib/pane-status.ts, for the same reason: the frame arrives
 * at the socket and the ring is drawn in the status line, which share no tree.
 *
 * The seam: the client's frame switch hands a `usage` frame to `publishUsage`
 * (see the note at the foot of this file); until it does, only the footer's
 * reading reaches the ring.
 */

export interface PaneContext {
  /** 0–100, how much of the window is used. */
  usedPct: number
  usedTokens?: number
  windowTokens?: number
  /** `frame` is the desktop's exact reading; `footer` is read off the screen. */
  from: 'frame' | 'footer'
}

export interface UsageLimit {
  usedPct: number
  /** Epoch seconds, as Claude Code reports it. */
  resetsAt?: number
}

export interface UsageLimits {
  fiveHour?: UsageLimit
  week?: UsageLimit
}

export interface PaneUsage {
  context: PaneContext | null
  limits: UsageLimits | null
}

const frames = new Map<string, WebUsageFrame>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function pct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

/**
 * A `usage` frame from the desktop. Coerced rather than trusted — the frame is
 * typed and the wire is not — and a frame with nothing usable in it is dropped
 * rather than stored, so it cannot hide the footer's reading behind an empty one.
 */
export function publishUsage(frame: WebUsageFrame): void {
  if (!frame || typeof frame.sessionId !== 'string' || !frame.sessionId) return
  const context = frame.context && pct(frame.context.usedPct) !== null ? frame.context : undefined
  const fiveHour = frame.limits?.fiveHour && pct(frame.limits.fiveHour.usedPct) !== null ? frame.limits.fiveHour : undefined
  const week = frame.limits?.week && pct(frame.limits.week.usedPct) !== null ? frame.limits.week : undefined
  if (!context && !fiveHour && !week) return
  frames.set(frame.sessionId, {
    ...frame,
    context,
    limits: fiveHour || week ? { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) } : undefined
  })
  emit()
}

/** A pane that has gone: its numbers go with it. */
export function forgetUsage(paneId: string): void {
  if (frames.delete(paneId)) emit()
}

/**
 * "Context left" off the agent's footer, turned into "used".
 *
 * Only phrasings whose direction is certain are read: Claude Code's "Context
 * left until auto-compact: 12%", Codex's "72% context left", and an explicit
 * "context used: 40%". Grok's `7.8K / 500K` is used-over-budget, so it is a
 * division. Anything else — "128k tokens left", a bare "context: 30%" — has no
 * direction or no window, and is not guessed at.
 */
export function contextFromFooter(footer: readonly string[] | undefined): number | null {
  if (!footer?.length) return null
  for (const line of footer) {
    const left =
      /context left until auto-compact\s*:\s*(\d{1,3})\s*%/i.exec(line) ??
      /(\d{1,3})\s*%\s*context (?:left|remaining)/i.exec(line) ??
      /context (?:left|remaining)\s*:\s*(\d{1,3})\s*%/i.exec(line)
    if (left) return pct(100 - Number(left[1]))
    const used = /context used\s*:\s*(\d{1,3})\s*%/i.exec(line) ?? /(\d{1,3})\s*%\s*context used/i.exec(line)
    if (used) return pct(Number(used[1]))
    const ratio = /(\d+(?:\.\d+)?)\s*([KM])\s*\/\s*(\d+(?:\.\d+)?)\s*([KM])\b/.exec(line)
    if (ratio) {
      const scale = (unit: string): number => (unit.toUpperCase() === 'M' ? 1_000_000 : 1_000)
      const usedTokens = Number(ratio[1]) * scale(ratio[2]!)
      const windowTokens = Number(ratio[3]) * scale(ratio[4]!)
      if (windowTokens > 0 && usedTokens <= windowTokens) return pct(Math.round((usedTokens / windowTokens) * 100))
    }
  }
  return null
}

const NONE: PaneUsage = { context: null, limits: null }
/** One object per frame, so a hook reading the same frame twice sees the same answer. */
const shaped = new WeakMap<WebUsageFrame, PaneUsage>()

function fromFrame(frame: WebUsageFrame): PaneUsage {
  const cached = shaped.get(frame)
  if (cached) return cached
  const usage: PaneUsage = {
    context: frame.context
      ? {
          usedPct: Math.round(pct(frame.context.usedPct) ?? 0),
          usedTokens: frame.context.usedTokens,
          windowTokens: frame.context.windowTokens,
          from: 'frame'
        }
      : null,
    limits: frame.limits ?? null
  }
  shaped.set(frame, usage)
  return usage
}

/**
 * The pane's usage: the desktop's frame when there is one, the footer's
 * reading otherwise, nothing at all when neither says. `status` is the pane's
 * own screen reading (lib/pane-status.ts), for the fallback.
 */
export function usePaneUsage(paneId: string | null, status: PaneStatus | undefined): PaneUsage {
  const frame = useSyncExternalStore(
    subscribe,
    () => (paneId ? frames.get(paneId) : undefined),
    () => undefined
  )
  if (frame) {
    const usage = fromFrame(frame)
    if (usage.context) return usage
    // Limits from the desktop, context from the screen: a pane that has not
    // drawn its status line yet can still have a footer.
    const footer = contextFromFooter(status?.footer)
    return footer === null ? usage : { ...usage, context: { usedPct: footer, from: 'footer' } }
  }
  const footer = contextFromFooter(status?.footer)
  return footer === null ? NONE : { context: { usedPct: footer, from: 'footer' }, limits: null }
}

/** How loud a percentage is: neutral, then amber from 80, then red from 92. */
export function usageLevel(usedPct: number): 'calm' | 'warn' | 'full' {
  return usedPct >= 92 ? 'full' : usedPct >= 80 ? 'warn' : 'calm'
}

/** `84k` / `1.2M` — tokens at a glance. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

/**
 * "at 14:20" today, "Thu 09:00" this week, a date beyond that. Epoch seconds
 * in, the phone's own clock and locale out.
 */
export function fmtReset(resetsAt: number | undefined, now = Date.now()): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return ''
  const at = new Date(resetsAt * 1000)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (at.toDateString() === today.toDateString()) return `Resets at ${time}`
  if (at.getTime() - now < 6 * 86_400_000 && at.getTime() > now) {
    return `Resets ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
  }
  return `Resets ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/*
 * The seam, for whoever wires the socket (client.ts is not this file's): in
 * `ForgeClient`'s frame switch,
 *
 *     case 'usage':
 *       publishUsage(frame)
 *       return
 *
 * with `import { publishUsage } from './usage'`. Nothing else: the desktop
 * replays the latest frame per pane after every `hello-ok`, and a desktop
 * without WEB_FEATURE_USAGE sends none, which leaves the footer's reading.
 */

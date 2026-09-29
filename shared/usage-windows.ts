/**
 * One plan-limit window an agent CLI reports, named by its true length.
 *
 * Claude Code reports a 5-hour and a 7-day window; Codex reports a primary and
 * an optional secondary window with their length in minutes — on some plans a
 * single 30-day one. A window is therefore labelled by how long it is, never by
 * which slot it arrived in, so a monthly allowance is never called "5-hour".
 *
 * Shared by the main process (electron/web/agent-usage.ts, codex-usage.ts) and
 * the renderer (src/lib/paneUsage.ts), so both spell a window the same way.
 */
export interface UsageWindow {
  /** The window's length. */
  minutes: number
  /** `windowLabel(minutes)`. */
  label: string
  usedPct: number
  /** Epoch seconds. */
  resetsAt?: number
}

/**
 * A window's length as a person says it: 300 → "5-hour", 1440 → "Daily",
 * 10080 → "Weekly", anything from 40000 to 46000 minutes (28 to 31.9 days) →
 * "Monthly", otherwise "<n>-day" or "<n>-hour".
 */
export function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Limit'
  const m = Math.round(minutes)
  if (m === 1440) return 'Daily'
  if (m === 10080) return 'Weekly'
  if (m >= 40000 && m <= 46000) return 'Monthly'
  if (m % 1440 === 0) return `${m / 1440}-day`
  if (m % 60 === 0) return `${m / 60}-hour`
  if (m < 60) return `${m}-minute`
  if (m >= 2880) return `${Math.round(m / 1440)}-day`
  return `${Math.round(m / 60)}-hour`
}

/** Shortest window first. */
export function sortWindows<T extends { minutes: number }>(windows: T[]): T[] {
  return [...windows].sort((a, b) => a.minutes - b.minutes)
}

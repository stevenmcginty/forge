import { useEffect, useState } from 'react'
import { terminalHost, type PaneRuntime } from '@/lib/terminals'

/**
 * What a pane is doing, as one word — and for how long.
 *
 * terminalHost already knows the two hard facts (busy: printing steadily;
 * attention: went quiet on a question). This folds them, with the pane's
 * process status, into the state the shell shows on a pane's edge and in its
 * header, and remembers when each state began so the header can say "Working
 * 12m" the way a CLI says "Cooked for 24m".
 *
 * Every state has a word and a glyph shape as well as a colour — Steve is
 * red-green colourblind, and a border that only changes hue tells him nothing.
 *
 *   working    printing steadily          ● filled dot   agent colour, bright edge
 *   attention  stopped on a question      ◆ diamond      amber edge
 *   done       finished a long stretch    ✓ tick         brief bright flash, then idle
 *   idle       quiet at a prompt          ○ ring         dim edge
 *   starting   the shell is coming up     ◌ dotted ring
 *   dormant    not opened this session    – a dash (a tab never visited yet)
 *   exited     the process ended          ■ square
 *   failed     it never started           ■ square
 */

export type ActivityState = 'working' | 'attention' | 'done' | 'idle' | 'starting' | 'dormant' | 'exited' | 'failed'

export interface PaneActivity {
  state: ActivityState
  /** Epoch ms the current state began. */
  since: number
}

/** How long "Done" stays up before the pane settles back to idle. */
const DONE_HOLD_MS = 6000
/** A stretch shorter than this finishing is not news. */
const DONE_MIN_WORK_MS = 8000

interface Track {
  busy: boolean
  attention: boolean
  busySince: number
  quietSince: number
  doneUntil: number
}

const tracks = new Map<string, Track>()
const listeners = new Set<() => void>()
let wired = false

function now(): number {
  return Date.now()
}

function sample(paneId: string): void {
  const busy = terminalHost.isBusy(paneId)
  const attention = terminalHost.isAttention(paneId)
  const t = tracks.get(paneId)
  const at = now()
  if (!t) {
    tracks.set(paneId, { busy, attention, busySince: busy ? at : 0, quietSince: at, doneUntil: 0 })
    return
  }
  if (busy && !t.busy) t.busySince = at
  if (!busy && t.busy) {
    t.quietSince = at
    if (!attention && at - t.busySince >= DONE_MIN_WORK_MS) t.doneUntil = at + DONE_HOLD_MS
  }
  if (attention && !t.attention) t.quietSince = at
  t.busy = busy
  t.attention = attention
}

function wire(): void {
  if (wired) return
  wired = true
  const resample = (): void => {
    for (const id of tracks.keys()) sample(id)
    for (const cb of listeners) cb()
  }
  terminalHost.subscribeBusy(resample)
  terminalHost.subscribeAttention(resample)
}

export function activityOf(paneId: string, runtime: PaneRuntime): PaneActivity {
  if (!tracks.has(paneId)) sample(paneId)
  const t = tracks.get(paneId)!
  const at = now()
  if (runtime.status === 'error') return { state: 'failed', since: t.quietSince }
  if (runtime.status === 'exited') return { state: 'exited', since: t.quietSince }
  if (runtime.status === 'idle') return { state: 'dormant', since: t.quietSince }
  if (runtime.status === 'starting') return { state: 'starting', since: t.quietSince }
  if (t.busy) return { state: 'working', since: t.busySince }
  if (t.attention) return { state: 'attention', since: t.quietSince }
  if (t.doneUntil > at) return { state: 'done', since: t.quietSince }
  return { state: 'idle', since: t.quietSince }
}

/**
 * One ticker for every header on screen: a 15-second heartbeat is plenty for a
 * minutes-resolution timer, and one interval for eight panes is one wake-up,
 * not eight.
 */
const tickers = new Set<() => void>()
let tickTimer: number | null = null

function startTicker(cb: () => void): () => void {
  tickers.add(cb)
  if (tickTimer === null) {
    tickTimer = window.setInterval(() => {
      if (document.hidden) return
      for (const fn of tickers) fn()
    }, 15_000)
  }
  return () => {
    tickers.delete(cb)
    if (tickers.size === 0 && tickTimer !== null) {
      window.clearInterval(tickTimer)
      tickTimer = null
    }
  }
}

export function usePaneActivity(paneId: string, runtime: PaneRuntime): PaneActivity {
  const [, bump] = useState(0)
  useEffect(() => {
    wire()
    if (!tracks.has(paneId)) sample(paneId)
    const cb = (): void => bump((n) => n + 1)
    listeners.add(cb)
    const untick = startTicker(cb)
    return () => {
      listeners.delete(cb)
      untick()
    }
  }, [paneId])

  const activity = activityOf(paneId, runtime)

  // "Done" ends by itself; nothing else would re-render the header when it does.
  useEffect(() => {
    if (activity.state !== 'done') return undefined
    const t = tracks.get(paneId)
    const left = Math.max(50, (t?.doneUntil ?? 0) - now() + 30)
    const timer = window.setTimeout(() => bump((n) => n + 1), left)
    return () => window.clearTimeout(timer)
  }, [activity.state, paneId])

  return activity
}

export const ACTIVITY_WORD: Record<ActivityState, string> = {
  working: 'Working',
  attention: 'Needs you',
  done: 'Done',
  idle: 'Ready',
  starting: 'Starting',
  dormant: 'Not open',
  exited: 'Exited',
  failed: 'Failed'
}

/** "40s", "12m", "1h 04m". Empty under five seconds — a fresh state needs no clock. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 5) return ''
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** Only the states where the clock means something get one. */
export function activityClock(activity: PaneActivity): string {
  if (activity.state !== 'working' && activity.state !== 'attention') return ''
  return formatElapsed(now() - activity.since)
}

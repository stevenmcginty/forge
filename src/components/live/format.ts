import { useEffect, useState } from 'react'
import { isLiveJobFinished, liveJobStateWord } from '@shared/live'
import type { GlyphName } from './glyphs'
import type { LiveJob, LivePhase } from './types'

/* ------------------------------------------------------------------ time */

/**
 * A clock that ticks once a second while something on screen counts. Timers,
 * not animation frames: the renderer's frames stop while Forge is covered.
 */
export function useNow(on = true, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return undefined
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [on, everyMs])
  return now
}

/** 16:53 */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 38s · 2m 14s · 1h 05m */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** just now · 4 min ago · 16:53 */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return clock(at)
}

/** "for 6 s" beside NOW */
export function forHowLong(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `for ${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `for ${m} min` : `for ${Math.floor(m / 60)} h`
}

/* ----------------------------------------------------------------- people */

/** The name on a crew card: the pane's name, else who owns the job. */
export function crewName(job: LiveJob): string {
  if (job.paneName) return job.paneName
  if (job.owner === 'operator') return 'Operator'
  if (job.owner === 'conductor') return 'Forge'
  return job.title
}

/**
 * A crew member's tile colour: stable per name, from the terminal palette the
 * comp drew from. Decoration only — the name and the letter carry who it is.
 */
const AVATAR_HUES = ['#ff9b7a', '#7fd1ff', '#c08bff', '#c6ff4a', '#6fe3d2', '#f2e56b', '#7fb6ff', '#ffb3d1']
export function avatarHue(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_HUES[h % AVATAR_HUES.length]
}

export function initial(name: string): string {
  const ch = name.trim().match(/[\p{L}\p{N}]/u)
  return ch ? ch[0].toUpperCase() : '•'
}

/* ------------------------------------------------------------------ states */

export type BadgeKind = 'working' | 'reading' | 'needs' | 'waiting' | 'done' | 'stopped' | 'failed'

export interface Badge {
  kind: BadgeKind
  word: string
  glyph: GlyphName
  spin?: boolean
}

const READING = /^(read|reading|grep|glob|search|searching|looking|look|web ?fetch|web ?search|open(ed|ing)? (the )?(file|page))\b/i

/** The badge for a job: the shared state word, and a shape for every state. */
export function badgeFor(job: LiveJob): Badge {
  switch (job.state) {
    case 'running': {
      const last = job.steps[job.steps.length - 1]?.text ?? ''
      if (READING.test(last.trim())) return { kind: 'reading', word: 'Reading', glyph: 'eye' }
      return { kind: 'working', word: liveJobStateWord('running'), glyph: 'arc', spin: true }
    }
    case 'needs-you':
      return { kind: 'needs', word: liveJobStateWord('needs-you'), glyph: 'diamond' }
    case 'queued':
      return { kind: 'waiting', word: liveJobStateWord('queued'), glyph: 'dashed' }
    case 'done':
      return { kind: 'done', word: liveJobStateWord('done'), glyph: 'check' }
    case 'stopped':
      return { kind: 'stopped', word: liveJobStateWord('stopped'), glyph: 'square' }
    case 'failed':
      return { kind: 'failed', word: liveJobStateWord('failed'), glyph: 'cross' }
  }
}

const ORDER: Record<LiveJob['state'], number> = { 'needs-you': 0, failed: 1, running: 2, queued: 3, done: 4, stopped: 5 }

/**
 * The crew: everyone but the job Forge itself is on. The Conductor's own
 * queued jobs show as NOW's "then …" line instead, unless one needs Steve or
 * went wrong. Needs-you first, then trouble, then work, then the finished,
 * newest first within each.
 */
export function crewOf(jobs: LiveJob[], now: LiveJob | undefined): LiveJob[] {
  return jobs
    .filter((j) => j.id !== now?.id && (j.owner !== 'conductor' || j.state === 'needs-you' || j.state === 'failed'))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAt - a.updatedAt)
}

/** Forge's own next job, for NOW's dashed "then …" line. */
export function nextOf(jobs: LiveJob[], now: LiveJob | undefined): LiveJob | undefined {
  return jobs
    .filter((j) => j.owner === 'conductor' && j.state === 'queued' && j.id !== now?.id)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

export { isLiveJobFinished }

/* ------------------------------------------------------------------ phase */

export interface PhaseLook {
  word: string
  hint: string
}

export const PHASE: Record<Exclude<LivePhase, 'off'>, PhaseLook> = {
  starting: { word: 'Starting', hint: 'Getting ready to listen' },
  listening: { word: 'Listening', hint: 'Just talk, any time' },
  hearing: { word: 'Hearing', hint: 'Keep going' },
  thinking: { word: 'Thinking', hint: 'Working out what to say' },
  speaking: { word: 'Speaking', hint: 'Just talk to cut in' }
}

/* ---------------------------------------------------------------- captions */

const CAPTION_MAX = 230

/**
 * What Forge is saying, split at the spoken point. A long reply keeps only the
 * stretch around where the voice is: whole sentences already said drop off the
 * front, so the bright words never scroll out of the caption.
 */
export function splitSpoken(text: string, spokenChars: number | undefined): { lead: boolean; said: string; rest: string } {
  const cut = spokenChars === undefined ? text.length : Math.max(0, Math.min(text.length, spokenChars))
  let start = 0
  if (text.length > CAPTION_MAX) {
    const re = /[.!?…]["”’)]?\s+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const end = m.index + m[0].length
      if (end > cut) break
      if (text.length - end < 80) break
      start = end
      if (text.length - start <= CAPTION_MAX) break
    }
  }
  return { lead: start > 0, said: text.slice(start, cut), rest: text.slice(cut) }
}

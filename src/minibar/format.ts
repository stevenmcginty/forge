import type { AgentStatus, MiniBarAgent, MiniBarState } from '@shared/minibar'

/**
 * Small words for the mini bar: how long, what time, what state. Pure, so the
 * fixtures and the preview can use them too.
 */

/** "45 s", "4 min", "1 h 5 min". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

/** "now", "40 s ago", "4 min ago". */
export function fmtAgo(at: number, now: number): string {
  const ms = now - at
  if (ms < 5000) return 'now'
  return `${fmtDuration(ms)} ago`
}

/** 24-hour clock, the way Steve's taskbar shows it: "14:07". */
export function fmtClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The word for each state. Always shown beside its shape (glyphs.tsx). */
export const STATUS_WORD: Record<AgentStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  asking: 'Asking',
  idle: 'Idle',
  done: 'Done',
  stopped: 'Stopped'
}

/** Event headlines: "Ruth is done", "Ruth is asking", "Ruth stopped". */
export function eventHeadline(kind: 'done' | 'asking' | 'stopped', name: string): string {
  if (kind === 'done') return `${name} is done`
  if (kind === 'asking') return `${name} is asking`
  return `${name} stopped`
}

/** The status an event leaves its agent in, for the shape beside it. */
export function eventStatus(kind: 'done' | 'asking' | 'stopped'): AgentStatus {
  return kind === 'done' ? 'done' : kind === 'asking' ? 'asking' : 'stopped'
}

export function agentById(state: MiniBarState, paneId: string): MiniBarAgent | undefined {
  return state.agents.find((a) => a.paneId === paneId)
}

export function projectName(state: MiniBarState, id: string): string {
  return state.projects.find((p) => p.id === id)?.name ?? ''
}

/** Who the box speaks to, for the placeholder and the tooltips. */
export function targetName(state: MiniBarState): string | null {
  if (state.target.kind === 'forge') return null
  return agentById(state, state.target.paneId)?.name ?? null
}

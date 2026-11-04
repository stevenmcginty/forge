import type { LiveJob, LiveLatencySample, LiveNewsUrgency } from '@shared/live'
import type { LivePhase, LiveTurn } from '../../components/live/types'
import { echoOverlap, ECHO_WINDOW_MS } from '../speech'

/**
 * Claude Live's voice shell, as pure decisions — captions, the echo guard,
 * when news may be spoken, when to say "One sec.", and the per-turn latency
 * sample — so scripts/live-voice-check.mjs can drive them without a
 * microphone, a speaker or React. src/state/live/LiveController.tsx is the
 * only caller that does anything with them.
 */

/* ---------------------------------------------------------------- numbers */

/** Turns the view keeps, newest last. */
export const LIVE_TURNS_KEPT = 30
/** News waits this long after Steve stops talking: a gap, not his breath. */
export const NEWS_GAP_MS = 1000
/** No sound this long after he stops: play a spoken ack (plan: 600 ms). */
export const ACK_AFTER_MS = 600
/** Barge-in: duck at once, stop this long after (brief: within ~150 ms). */
export const BARGE_STOP_MS = 150
/** The ducked level while barge-in decides. */
export const BARGE_DUCK_LEVEL = 0.15
/** News lines said in one go; the rest wait for the next gap. */
export const NEWS_BATCH_MAX = 3

/* --------------------------------------------------------------- captions */

/**
 * A streamed piece onto a caption. Pieces arrive as written ("Sure", ", I'll",
 * " check"), so they join as they are; only a run of spaces where two pieces
 * meet is folded to one.
 */
export function appendCaption(prev: string | undefined, delta: string): string {
  const head = prev ?? ''
  const piece = String(delta ?? '')
  if (!head) return piece.replace(/^\s+/, '')
  if (/\s$/.test(head) && /^\s/.test(piece)) return head + piece.replace(/^\s+/, '')
  return head + piece
}

/** Phrases of one thought, joined into one turn: one space, no doubled ones. */
export function joinPhrases(parts: readonly string[]): string {
  return parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/** Put a turn into the list (replacing one with the same id), newest last, at most `cap`. */
export function upsertTurn(turns: readonly LiveTurn[], turn: LiveTurn, cap: number = LIVE_TURNS_KEPT): LiveTurn[] {
  const at = turns.findIndex((t) => t.id === turn.id)
  const next = at >= 0 ? [...turns.slice(0, at), turn, ...turns.slice(at + 1)] : [...turns, turn]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/* ------------------------------------------------------------- echo guard */

/** A line Forge said: `endedAt` null while it is still coming out of the speakers. */
export interface SpokenLine {
  text: string
  endedAt: number | null
}

/** Lines remembered for the echo guard. */
const SPOKEN_KEPT = 8
const ECHO_MIN_WORDS = 3
const ECHO_RATIO = 0.7

/** Remember a line as it starts playing. */
export function rememberLine(lines: readonly SpokenLine[], text: string): SpokenLine[] {
  const next = [...lines, { text, endedAt: null }]
  return next.length > SPOKEN_KEPT ? next.slice(next.length - SPOKEN_KEPT) : next
}

/** Mark every line still playing as ended at `now`. */
export function endLines(lines: readonly SpokenLine[], now: number): SpokenLine[] {
  return lines.map((l) => (l.endedAt === null ? { ...l, endedAt: now } : l))
}

/**
 * Is this transcript Forge's own voice coming back through the microphone?
 * The same test as speech.ts `heardItself` (three words or more, mostly words
 * Forge used) but against every line still playing or ended in the last
 * `ECHO_WINDOW_MS`, not only the last one — a streamed reply is many lines,
 * and the echo of the second can arrive while the third plays.
 */
export function isEcho(heard: string, lines: readonly SpokenLine[], now: number, windowMs: number = ECHO_WINDOW_MS): boolean {
  const words = String(heard ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length < ECHO_MIN_WORDS) return false
  const recent = lines.filter((l) => l.endedAt === null || (now - l.endedAt >= 0 && now - l.endedAt <= windowMs))
  if (!recent.length) return false
  return echoOverlap(heard, recent.map((l) => l.text).join(' ')) >= ECHO_RATIO
}

/* ------------------------------------------------------------------- news */

export interface QueuedNews {
  id: string
  jobId?: string
  text: string
  urgency: LiveNewsUrgency
  at: number
}

/**
 * Add news to the queue. The same id twice is one item; a newer item about
 * the same job replaces the older one (a job that needed him and is now done
 * says "done", not both).
 */
export function queueNews(queue: readonly QueuedNews[], item: QueuedNews): QueuedNews[] {
  if (!item.text.trim() || queue.some((q) => q.id === item.id)) return [...queue]
  const kept = item.jobId ? queue.filter((q) => q.jobId !== item.jobId) : [...queue]
  return [...kept, item]
}

export interface GapState {
  now: number
  /** He is talking (the ears heard speech start and no turn has come of it yet). */
  hearing: boolean
  /** When he last stopped talking, or null when he has not spoken. */
  heardEndAt: number | null
  /** Forge is saying something, or has something queued to say. */
  speaking: boolean
  /** A turn of his is out and not answered yet: the answer goes first. */
  turnBusy: boolean
}

/** May news be spoken now? Never over him, never within `NEWS_GAP_MS` of him stopping, never over a reply. */
export function newsGapOpen(g: GapState): boolean {
  if (g.hearing || g.speaking || g.turnBusy) return false
  return g.heardEndAt === null || g.now - g.heardEndAt >= NEWS_GAP_MS
}

/**
 * What to say from the queue at a gap: the oldest "needs you" alone, first;
 * otherwise up to `NEWS_BATCH_MAX` of the rest, oldest first, as one line.
 */
export function takeNews(queue: readonly QueuedNews[]): { say: string; ids: string[]; rest: QueuedNews[] } | null {
  if (!queue.length) return null
  const urgent = queue.find((q) => q.urgency === 'needs-you')
  const picked = urgent ? [urgent] : queue.slice(0, NEWS_BATCH_MAX)
  const ids = picked.map((q) => q.id)
  return {
    say: joinPhrases(picked.map((q) => q.text)),
    ids,
    rest: queue.filter((q) => !ids.includes(q.id))
  }
}

/* -------------------------------------------------------------------- ack */

export interface AckState {
  now: number
  /** When the ears said he stopped. */
  eosAt: number
  /** Any sound for this turn has started (reply or ack). */
  audioStarted: boolean
  /** Ack clips ready to play at once. */
  ready: number
  /** An ack has already been played for this turn. */
  acked: boolean
}

/** Play a spoken ack now? Once per turn, only while nothing has been heard for `ACK_AFTER_MS`. */
export function shouldAck(a: AckState): boolean {
  return !a.acked && !a.audioStarted && a.ready > 0 && a.now - a.eosAt >= ACK_AFTER_MS
}

/* ---------------------------------------------------------------- latency */

/** One turn's clock, filled in as it happens (Date.now() milliseconds). */
export interface TurnClock {
  turnId: string
  /** End of his speech as the ears reported it. Absent for a typed turn. */
  eosAt?: number
  sentAt: number
  firstTextAt?: number
  /** First sample of the reply itself. */
  firstReplyAudioAt?: number
  /** First sample of anything for this turn: the ack or the reply. */
  firstAudioAt?: number
  ack: boolean
}

function gap(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined
  return Math.max(0, Math.round(to - from))
}

/** The contract's latency sample, or null for a typed turn (there is no end of speech to measure from). */
export function buildLatencySample(c: TurnClock): LiveLatencySample | null {
  if (c.eosAt === undefined) return null
  const sample: LiveLatencySample = { turnId: c.turnId, eosToSendMs: gap(c.eosAt, c.sentAt) ?? 0, ack: c.ack }
  const sendToFirstText = gap(c.sentAt, c.firstTextAt)
  const firstTextToAudio = gap(c.firstTextAt, c.firstReplyAudioAt)
  const eosToAudio = gap(c.eosAt, c.firstAudioAt)
  if (sendToFirstText !== undefined) sample.sendToFirstTextMs = sendToFirstText
  if (firstTextToAudio !== undefined) sample.firstTextToAudioMs = firstTextToAudio
  if (eosToAudio !== undefined) sample.eosToAudioMs = eosToAudio
  return sample
}

/* ------------------------------------------------------------ phase, jobs */

export interface PhaseState {
  running: boolean
  starting: boolean
  speaking: boolean
  hearing: boolean
  thinking: boolean
}

/** One word for the shell. Speaking wins (that is what he hears), then hearing him, then thinking. */
export function livePhase(p: PhaseState): LivePhase {
  if (p.starting) return 'starting'
  if (!p.running) return 'off'
  if (p.speaking) return 'speaking'
  if (p.hearing) return 'hearing'
  if (p.thinking) return 'thinking'
  return 'listening'
}

/** The ledger as the view reads it: running count, the job most recently moving, and those waiting on him. */
export function jobsView(jobs: readonly LiveJob[]): { working: number; now?: LiveJob; needsYou: LiveJob[] } {
  const running = jobs.filter((j) => j.state === 'running')
  const needsYou = jobs.filter((j) => j.state === 'needs-you').sort((a, b) => b.updatedAt - a.updatedAt)
  const now = [...running].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return now ? { working: running.length, now, needsYou } : { working: running.length, needsYou }
}

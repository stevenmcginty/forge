import type { LiveConductorModel, LiveEars, LiveVoiceModel } from './types'

/**
 * Claude Live (agentBrain `claude-live`, docs/live-agent-plan.md architecture
 * C): a quick Claude voice brain talks with Steve while a deep Claude
 * Conductor does the work, and both share one job ledger held in main
 * (electron/live/ledger.ts) that the UI and the spoken news read.
 *
 * This file is the seam between main (electron/live/), the preload's
 * `window.forge.live` and the renderer's voice shell and job UI. The first
 * block is THE CONTRACT: change it only additively. Nothing here imports
 * Electron or the DOM.
 */

/* --------------------------------------------------------------- contract */

export type LiveJobState = 'queued' | 'running' | 'needs-you' | 'done' | 'failed' | 'stopped'
export interface LiveJobStep { at: number; text: string } // text <= 200 chars
export interface LiveJob {
  id: string; title: string; project?: string; paneId?: string; paneName?: string
  owner: 'conductor' | 'pane' | 'operator'
  state: LiveJobState; steps: LiveJobStep[]; createdAt: number; updatedAt: number
  summary?: string // last one-line status
}
export interface LiveLedgerSnapshot { jobs: LiveJob[]; seq: number }
export type LiveNewsUrgency = 'needs-you' | 'done' | 'info'
export type LiveEvent =
  | { type: 'say'; turnId: string; text: string; final: boolean } // voice-brain text, streamed in pieces; final=true on the last piece
  | { type: 'turn-end'; turnId: string; ok: boolean; error?: string }
  | { type: 'news'; id: string; jobId?: string; text: string; urgency: LiveNewsUrgency } // to be spoken at the next gap, never over Steve
  | { type: 'ledger'; snapshot: LiveLedgerSnapshot }
  | { type: 'show'; target: { kind: 'pane'; paneId: string } | { kind: 'view'; view: string }; note?: string }
  | { type: 'status'; status: LiveStatus }
export interface LiveStatus {
  ready: boolean; voiceModel: string; conductorModel: string
  voiceRoute: 'api' | 'subscription'; hasApiKey: boolean; conductorBusy: boolean; error?: string
}
export interface LiveLatencySample { turnId: string; eosToSendMs: number; sendToFirstTextMs?: number; firstTextToAudioMs?: number; eosToAudioMs?: number; ack: boolean }

/* ----------------------------------------------------------- helpers (L0) */

/** The settings unions live in shared/types.ts (dependency-free); re-exported here. */
export type { LiveConductorModel, LiveEars, LiveVoiceModel }

export type LiveJobOwner = LiveJob['owner']
export type LiveJobAction = 'stop' | 'show'
export interface LiveAskOpts { typed?: boolean }
export interface LiveActionResult { ok: boolean; error?: string }

/** The IPC channels behind `window.forge.live`. `event` is main → renderer. */
export const LIVE_IPC = {
  ask: 'live:ask',
  cancel: 'live:cancel',
  jobAction: 'live:job-action',
  ledger: 'live:ledger',
  status: 'live:status',
  start: 'live:start',
  stop: 'live:stop',
  latency: 'live:latency',
  event: 'live:event'
} as const

/** A step's text is cut to this many characters. */
export const LIVE_STEP_MAX = 200
/** Steps kept per job, newest last. */
export const LIVE_STEPS_PER_JOB = 50
/** Jobs kept in the ledger; finished ones go first when it is full. */
export const LIVE_JOB_CAP = 200
/** A job last touched longer ago than this is not loaded back on start. */
export const LIVE_KEEP_MS = 24 * 60 * 60 * 1000

/** The voice brain's models, smartest first; the default is Opus. */
export const LIVE_VOICE_MODELS: readonly LiveVoiceModel[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
export const DEFAULT_LIVE_VOICE_MODEL: LiveVoiceModel = 'claude-opus-5-5'
export const LIVE_CONDUCTOR_MODELS: readonly LiveConductorModel[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']
export const DEFAULT_LIVE_CONDUCTOR_MODEL: LiveConductorModel = 'claude-opus-5-5'
export const LIVE_EARS_OPTIONS: readonly LiveEars[] = ['openai', 'parakeet']
export const DEFAULT_LIVE_EARS: LiveEars = 'openai'

export function isLiveVoiceModel(value: unknown): value is LiveVoiceModel {
  return typeof value === 'string' && (LIVE_VOICE_MODELS as readonly string[]).includes(value)
}
export function isLiveConductorModel(value: unknown): value is LiveConductorModel {
  return typeof value === 'string' && (LIVE_CONDUCTOR_MODELS as readonly string[]).includes(value)
}
export function isLiveEars(value: unknown): value is LiveEars {
  return typeof value === 'string' && (LIVE_EARS_OPTIONS as readonly string[]).includes(value)
}

export const LIVE_JOB_STATES: readonly LiveJobState[] = ['queued', 'running', 'needs-you', 'done', 'failed', 'stopped']
/** Finished: nothing more will happen to the job by itself. */
export function isLiveJobFinished(state: LiveJobState): boolean {
  return state === 'done' || state === 'failed' || state === 'stopped'
}

/** Words for a state, for the UI and the digest. Never colour alone. */
export function liveJobStateWord(state: LiveJobState): string {
  switch (state) {
    case 'queued':
      return 'Waiting'
    case 'running':
      return 'Working'
    case 'needs-you':
      return 'Needs you'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
  }
}

/** One line, whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clipLiveText(text: unknown, max = LIVE_STEP_MAX): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/* ------------------------------------------------------ Forge Web (L5) */

/** Jobs a phone is handed at most, newest first. */
export const LIVE_PHONE_JOBS_MAX = 12
/** A finished job stays on the phone's list this long after it last moved. */
export const LIVE_PHONE_KEEP_DONE_MS = 2 * 60 * 60 * 1000

/**
 * The ledger as Forge Web carries it to a phone: every job still open, and the
 * finished ones of the last `LIVE_PHONE_KEEP_DONE_MS`, newest first, at most
 * `LIVE_PHONE_JOBS_MAX`, each with its newest step only. The whole ledger
 * (200 jobs × 50 steps) on every change is too much for mobile data; the
 * phone draws cards, not the step history.
 */
export function liveLedgerForPhone(snapshot: LiveLedgerSnapshot, now: number = Date.now()): LiveLedgerSnapshot {
  const jobs = (snapshot?.jobs ?? [])
    .filter((j) => !isLiveJobFinished(j.state) || now - j.updatedAt <= LIVE_PHONE_KEEP_DONE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LIVE_PHONE_JOBS_MAX)
    .map((j) => ({ ...j, steps: j.steps.slice(-1) }))
  return { jobs, seq: snapshot?.seq ?? 0 }
}

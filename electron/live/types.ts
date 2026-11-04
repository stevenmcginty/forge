import type { LiveActionResult, LiveAskOpts, LiveEvent, LiveJobOwner } from '@shared/live'
import type { Settings } from '@shared/types'
import type { LiveLedger } from './ledger'

/**
 * The two brains behind Claude Live, as main sees them. electron/live/index.ts
 * owns the IPC, the ledger and the status; it calls these and nothing else.
 * L0 ships stubs (./stubs.ts); the real ones replace them by being handed to
 * `initLive` (or by changing its defaults).
 */

/** What both brains get from the host. */
export interface LiveBrainContext {
  /** Push an event to the renderer (`live:event`). */
  emit(event: LiveEvent): void
  /** The one job ledger. */
  ledger: LiveLedger
  /** Current settings — read per call, never cached. */
  settings(): Settings
  /** The Conductor, for the voice brain's delegate / steer / cancel. Absent or null = none. */
  conductor?: () => LiveConductor | null
  /** Something in LiveStatus changed (the Conductor got busy or idle): push it. */
  statusChanged?: () => void
}

/** The quick voice brain: one user turn in, streamed `say` pieces and one `turn-end` out. */
export interface LiveVoiceBrain {
  /** Warm up (open the stream, cache the prefix). Safe to call again. */
  start(): Promise<void>
  stop(): Promise<void>
  /** A finished user turn. Must end with exactly one `turn-end` for `turnId`. */
  ask(turnId: string, text: string, opts: LiveAskOpts): Promise<void>
  /** Barge-in: stop this turn's reply only. Jobs keep running. */
  cancel(turnId: string): void | Promise<void>
}

/** What the voice brain hands the Conductor. */
export interface LiveJobSpec {
  title: string
  /** What to do, in words — the Conductor's brief. */
  brief: string
  project?: string
  paneId?: string
  paneName?: string
  owner?: LiveJobOwner
}

/** The deep worker: takes jobs, reports them in the ledger. */
export interface LiveConductor {
  start(): Promise<void>
  stop(): Promise<void>
  /** Take a job. On success the job is in the ledger under `jobId`. */
  delegate(spec: LiveJobSpec): Promise<LiveActionResult & { jobId?: string }>
  steer(jobId: string, text: string): Promise<LiveActionResult>
  cancel(jobId: string): Promise<LiveActionResult>
  /** True while it is working on anything (LiveStatus.conductorBusy). */
  busy(): boolean
}

export type LiveVoiceBrainFactory = (ctx: LiveBrainContext) => LiveVoiceBrain
export type LiveConductorFactory = (ctx: LiveBrainContext) => LiveConductor

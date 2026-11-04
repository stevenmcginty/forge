import type { LiveJob, LiveStatus } from '@shared/live'

/**
 * What the Claude Live UI reads: one view, built by the live provider (L2's
 * useLive()). The components here only read it and call its functions; they
 * never touch window.forge.
 */

export type { LiveJob, LiveJobState, LiveStatus } from '@shared/live'

export type LivePhase = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking'

export interface LiveTurn {
  id: string
  who: 'you' | 'forge'
  text: string
  at: number
  spokenChars?: number
  final: boolean
}

export interface LiveView {
  phase: LivePhase
  working: number
  turns: LiveTurn[]
  caption: { you?: string; forge?: string; forgeSpokenChars?: number }
  jobs: LiveJob[]
  now?: LiveJob
  needsYou: LiveJob[]
  status?: LiveStatus
  error?: string
  start(): void
  stop(): void
  toggle(): void
  sendTyped(text: string): void
  stopJob(id: string): void
  showJob(id: string): void
}

/** "Forge is showing you" — the contract's `show` event, for a pane. */
export interface LiveShowing {
  paneId: string
  note?: string
}

import type { LivePhase } from '@/components/live/types'

/**
 * Claude Live as the voice bar sees it (src/state/VoiceHubController.tsx):
 * the hub's phase and its honest mic words, from Live's own view. Pure, so
 * scripts/live-voice-check.mjs holds the mapping.
 *
 * Live is always hands-free and has no idle close: its mic stays open while
 * Listen is on (docs/live-agent-plan.md §1), because the news from the crew
 * needs an open conversation to be spoken into. Listen off closes it.
 */

/** The hub's phases (VoiceHubController `HubPhase`), spelt out so this file needs nothing from React. */
export type LiveHubPhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface LiveHubInput {
  phase: LivePhase
  /** Why the last Listen-on failed (LiveController `startError`). */
  startError?: string
}

export function liveHubPhase(v: LiveHubInput): LiveHubPhase {
  switch (v.phase) {
    case 'off':
      return v.startError ? 'error' : 'off'
    case 'starting':
      return 'connecting'
    case 'hearing':
    case 'listening':
      return 'listening'
    case 'thinking':
      return 'thinking'
    case 'speaking':
      return 'speaking'
  }
}

export interface LiveMicState {
  capturing: boolean
  starting: boolean
  listenNote: string
}

/**
 * The words the bar shows for Live. The mic is open from the moment it is
 * running — through Forge's own speech too (barge-in) — so every running
 * phase is capturing. `ended` is why the last conversation closed, shown while off.
 */
export function liveMicState(v: LiveHubInput, ended: string | null): LiveMicState {
  switch (v.phase) {
    case 'off':
      return { capturing: false, starting: false, listenNote: v.startError ? `Claude Live: ${v.startError}` : (ended ?? 'Off') }
    case 'starting':
      return { capturing: false, starting: true, listenNote: 'Starting…' }
    case 'hearing':
      return { capturing: true, starting: false, listenNote: 'Hearing you' }
    case 'listening':
      return { capturing: true, starting: false, listenNote: 'Listening' }
    case 'thinking':
      return { capturing: true, starting: false, listenNote: 'Thinking…' }
    case 'speaking':
      return { capturing: true, starting: false, listenNote: 'Speaking' }
  }
}

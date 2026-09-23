/**
 * The Agent bar's mic, as pure decisions — so the "first press always works"
 * and "Listening only when really recording" rules are testable without React
 * (scripts/agent-bar-check.mjs) and the hook and the check cannot drift.
 *
 * Used by src/state/VoiceAgent.tsx (listenStep: what to do after the mic was
 * pressed, on every sidecar status) and src/state/VoiceHubController.tsx
 * (micState: the capturing / starting / listenNote the bar shows).
 */

export type SttPhaseWord = 'off' | 'starting' | 'idle' | 'listening' | 'finishing' | 'error'

export interface ListenInput {
  armed: boolean
  /** The mic was pressed and no capture has started since. */
  wanted: boolean
  speaking: boolean
  phase: SttPhaseWord | string
  mode?: 'phrase' | 'wake' | string
  capturing?: boolean
}

/**
 * - `clear`   — not armed: forget the press.
 * - `none`    — nothing pending.
 * - `done`    — really capturing now: the press is honoured.
 * - `capture` — a wake session is open but only monitoring: capture inside it.
 * - `wait`    — the sidecar is still loading / opening; main queued the start
 *               and capture, so the next status moves this on by itself.
 */
export type ListenStep = 'clear' | 'none' | 'done' | 'capture' | 'wait'

/** Phrase mode captures whenever it listens; wake mode only once told to. */
export function isCapturing(phase: string, mode: string | undefined, capturing: boolean | undefined): boolean {
  return phase === 'listening' && (capturing ?? mode !== 'wake')
}

export function listenStep(i: ListenInput): ListenStep {
  if (!i.armed) return i.wanted ? 'clear' : 'none'
  if (!i.wanted) return 'none'
  if (isCapturing(i.phase, i.mode, i.capturing)) return 'done'
  if (i.speaking) return 'wait'
  if (i.mode === 'wake' && i.phase === 'listening') return 'capture'
  return 'wait'
}

export interface MicInput {
  realtime: boolean
  /** Realtime session phase, or the agent's phase on a Parakeet brain. */
  phase: string
  muted: boolean
  armed: boolean
  recogniser?: { phase: string; ready: boolean; capturing: boolean; wake: boolean; wanted: boolean } | null
  errorReason: string | null
}

export interface MicState {
  capturing: boolean
  starting: boolean
  listenNote: string
}

export function micState(i: MicInput): MicState {
  let capturing = false
  let starting = false
  let listenNote = 'Off'
  if (i.realtime) {
    starting = i.phase === 'connecting'
    capturing = !i.muted && (i.phase === 'listening' || i.phase === 'thinking' || i.phase === 'speaking')
    listenNote = starting ? 'Starting…' : i.phase === 'off' ? 'Off' : i.muted ? 'Muted' : capturing ? 'Listening' : 'Off'
  } else if (i.armed && i.recogniser) {
    const rec = i.recogniser
    capturing = rec.capturing
    starting = !capturing && (rec.wanted || rec.phase === 'starting' || !rec.ready)
    listenNote = capturing
      ? 'Listening'
      : starting
        ? 'Starting…'
        : i.phase === 'thinking'
          ? 'Thinking…'
          : i.phase === 'speaking'
            ? 'Speaking'
            : rec.wake && rec.phase === 'listening'
              ? 'Waiting for "Hey Jarvis"'
              : 'Mic on · not recording'
  } else if (i.armed) {
    listenNote = 'Mic on · not recording'
  }
  if (i.errorReason && !capturing) listenNote = i.errorReason
  return { capturing, starting, listenNote }
}

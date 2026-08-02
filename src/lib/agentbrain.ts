import type {
  VoiceAgentEvent,
  VoiceAgentStartRequest,
  VoiceAgentStatus
} from '@shared/types'

/**
 * The renderer's side of the Claude voice brain.
 *
 * A thin, typed wrapper over the `voice-agent:*` channels and nothing more —
 * no React, no state machine, no opinions about speech. It exists so that the
 * component that eventually drives this (a later job) talks to a small named
 * surface instead of `window.forge.voiceAgent` scattered through a hook, and
 * so the shape can be read in one screen.
 *
 * The half that answers the brain's questions is its sibling,
 * `./agenttools.ts` — this module is only the outbound half plus the event
 * stream. They are separate because they are wired up at different times: the
 * tool bridge is registered once with the app's own state, whereas start/stop
 * follow the microphone.
 *
 * ## Ordering
 *
 * `delta` events arrive in generation order and must be consumed in that
 * order — that is what makes sentence-chunked speech possible. The `assistant`
 * event that follows carries the same text as one string, and is the
 * authoritative copy: prefer it for anything written down (a transcript, the
 * overlay) and use the deltas only for the mouth.
 */

/** Everything a listener can be told. One callback, one switch. */
export type AgentBrainEvent = VoiceAgentEvent

/** Undo a subscription. Safe to call twice. */
export type Unsubscribe = () => void

function api(): ForgeVoiceAgentApi {
  const forge = (window as unknown as { forge?: { voiceAgent?: ForgeVoiceAgentApi } }).forge
  const bridge = forge?.voiceAgent
  if (!bridge) {
    // Almost always a stale preload bundle rather than broken wiring — the
    // renderer is newer than out/preload. Say so, because "is not a function"
    // sends people looking in the wrong file.
    throw new Error(
      'window.forge.voiceAgent is missing — the preload bundle is stale. Rebuild (npm run build) and restart.'
    )
  }
  return bridge
}

/** The preload surface this module needs, named so the cast above is honest. */
interface ForgeVoiceAgentApi {
  start(req?: VoiceAgentStartRequest): Promise<VoiceAgentStatus>
  stop(): Promise<VoiceAgentStatus>
  utterance(text: string): Promise<VoiceAgentStatus>
  interrupt(): Promise<boolean>
  onEvent(cb: (event: VoiceAgentEvent) => void): Unsubscribe
}

/** True when the brain can be reached at all. Cheap; safe on every render. */
export function agentBrainAvailable(): boolean {
  const forge = (window as unknown as { forge?: { voiceAgent?: unknown } }).forge
  return Boolean(forge?.voiceAgent)
}

/**
 * Open the session.
 *
 * Idempotent, and also the way back from a crash-loop stop — the host only
 * clears that state on an explicit start, never on its own.
 *
 * `cwd` should be the active project's folder so the agent's `Read` and the
 * bridge's media tools resolve relative paths where Steve is working.
 */
export function startAgentBrain(cwd?: string): Promise<VoiceAgentStatus> {
  const request: VoiceAgentStartRequest = {}
  if (cwd && cwd.trim()) request.cwd = cwd.trim()
  return api().start(request)
}

/** Close the session. The next utterance opens a fresh one. */
export function stopAgentBrain(): Promise<VoiceAgentStatus> {
  return api().stop()
}

/**
 * Say something. Opens the session lazily if it is not already running, so a
 * caller that never called `startAgentBrain` still works — it just pays the
 * spawn on the first turn instead of ahead of time.
 */
export function sendUtterance(text: string): Promise<VoiceAgentStatus> {
  return api().utterance(text)
}

/**
 * Barge-in: stop the turn, keep the conversation.
 *
 * Resolves false when there was nothing to interrupt, which is not an error —
 * Steve talking over silence is the ordinary case.
 */
export function interruptAgentBrain(): Promise<boolean> {
  return api().interrupt()
}

/**
 * Listen to the brain.
 *
 * Returns the unsubscribe; call it on teardown or a second mount will speak
 * every reply twice.
 */
export function onAgentBrainEvent(cb: (event: AgentBrainEvent) => void): Unsubscribe {
  return api().onEvent(cb)
}

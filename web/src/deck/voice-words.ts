import { VISIBLE_AGENT_BRAINS } from '@shared/agent-brain'
import type { WebVoiceProvider } from '@shared/web'

/**
 * The words the deck's Listen switch says about the voice agent. Pure — no
 * React, no DOM — so scripts/realtime-check.mjs can hold them.
 */

export type WebVoicePhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/**
 * Who Listen talks to: a voice agent (`WebVoiceProvider`), or Forge Brain
 * itself — heard the way Claude is, answered by the brain pane (./voiceAgent.ts).
 */
export type WebVoiceAgent = WebVoiceProvider | 'forge-brain'

/** What an older desktop is told to do: it answers the voice requests `unsupported`. */
export const UPDATE_DESKTOP_WORDS = 'Update the desktop app to use voice here'

/**
 * The same, naming the agent the desktop is too old for: a desktop from before
 * ChatGPT and Claude runs Gemini alone, so "use voice here" would read as if
 * no voice worked. Gemini keeps the plain sentence.
 */
export function updateDesktopWords(agent?: WebVoiceAgent): string {
  return agent && agent !== 'gemini-live' ? `Update the desktop app to use ${voiceAgentWord(agent)} here` : UPDATE_DESKTOP_WORDS
}

export const NO_KEY_WORDS = 'No Gemini key on the desktop — add one in its Settings → Models & APIs'

export const NO_OPENAI_KEY_WORDS = 'Add an OpenAI key in Settings on the desktop'

/**
 * A failed voice request, in the sentence to show. An older desktop answers
 * `unsupported` with "This desktop does not understand a "voice-setup"
 * request." (or, for any agent but Gemini, "can only run Gemini Live") —
 * which means one thing to Steve: update the desktop app, for the agent he
 * picked. A current desktop says an agent it cannot run *yet* in so many
 * words, and that is shown as is.
 */
export function voiceFailureWords(failure: { code?: string; message?: string }, agent?: WebVoiceAgent): string {
  const message = failure.message ?? ''
  if (failure.code === 'unsupported' && /not yet/i.test(message)) return message
  if (failure.code === 'unsupported' || /does not understand/i.test(message)) return updateDesktopWords(agent)
  if (/no gemini key/i.test(message)) return NO_KEY_WORDS
  if (/no openai key/i.test(message)) return NO_OPENAI_KEY_WORDS
  return message || 'The desktop could not start the voice agent.'
}

function isWebVoiceAgent(id: string): id is WebVoiceAgent {
  return id === 'gemini-live' || id === 'gpt-realtime' || id === 'gpt-realtime-mini' || id === 'claude' || id === 'forge-brain'
}

/**
 * The agents the Listen chip offers, in its menu's order: the desktop's visible
 * list (shared/agent-brain.ts VISIBLE_AGENT_BRAINS) — Forge Brain, Gemini,
 * ChatGPT. ChatGPT is GPT Realtime, the full model. Claude and ChatGPT mini keep
 * their code here and come back when that list names them again.
 */
export const WEB_VOICE_AGENTS: readonly WebVoiceAgent[] = VISIBLE_AGENT_BRAINS.filter(isWebVoiceAgent)

export const DEFAULT_WEB_VOICE_AGENT: WebVoiceAgent = 'forge-brain'

/** An agent as the chip's one word. */
export function voiceAgentWord(agent: WebVoiceAgent): string {
  switch (agent) {
    case 'gemini-live':
      return 'Gemini'
    case 'gpt-realtime':
      return 'ChatGPT'
    case 'gpt-realtime-mini':
      return 'ChatGPT mini'
    case 'claude':
      return 'Claude'
    case 'forge-brain':
      return 'Forge Brain'
  }
}

/**
 * A remembered choice, or the default (Forge Brain) when it is missing, not an
 * agent, or one the chip no longer offers (a remembered Claude).
 */
export function readVoiceAgent(stored: string | null | undefined): WebVoiceAgent {
  return stored && (WEB_VOICE_AGENTS as readonly string[]).includes(stored) ? (stored as WebVoiceAgent) : DEFAULT_WEB_VOICE_AGENT
}

/** The phase as the switch's word. Muted is its own word: the mic is shut while D records. */
export function voicePhaseWord(phase: WebVoicePhase, muted: boolean): string {
  switch (phase) {
    case 'off':
      return 'Off'
    case 'connecting':
      return 'Connecting'
    case 'listening':
      return muted ? 'Muted' : 'Listening'
    case 'thinking':
      return 'Thinking'
    case 'speaking':
      return 'Speaking'
    case 'error':
      return 'Failed'
  }
}

/** The voice line's sentence while nobody has said anything yet: what is happening, and what to do. */
export function voiceHint(phase: WebVoicePhase, muted: boolean): string {
  switch (phase) {
    case 'connecting':
      return 'Opening a conversation with the voice agent…'
    case 'listening':
      return muted ? 'The mic is held while D records' : 'Talk; a pause sends it. Say "that\'s all" to stop.'
    case 'thinking':
      return 'Working on it…'
    case 'speaking':
      return 'Talk over it to interrupt'
    case 'off':
    case 'error':
      return ''
  }
}

/** A tool call's outcome, as the word beside its shape. */
export function actionStatusWord(status: 'running' | 'ok' | 'failed'): string {
  return status === 'running' ? 'Running' : status === 'ok' ? 'Done' : 'Failed'
}

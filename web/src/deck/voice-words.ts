import type { WebVoiceProvider } from '@shared/web'

/**
 * The words the deck's Listen switch says about the voice agent. Pure — no
 * React, no DOM — so scripts/realtime-check.mjs can hold them.
 */

export type WebVoicePhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/** What an older desktop is told to do: it answers the voice requests `unsupported`. */
export const UPDATE_DESKTOP_WORDS = 'Update the desktop app to use voice here'

export const NO_KEY_WORDS = 'No Gemini key on the desktop — add one in its Settings → Models & APIs'

export const NO_OPENAI_KEY_WORDS = 'Add an OpenAI key in Settings on the desktop'

/**
 * A failed voice request, in the sentence to show. An older desktop answers
 * `unsupported` with "This desktop does not understand a "voice-setup"
 * request." (or, for any agent but Gemini, "can only run Gemini Live") —
 * which means one thing to Steve: update the desktop app. A current desktop
 * says an agent it cannot run *yet* in so many words, and that is shown as is.
 */
export function voiceFailureWords(failure: { code?: string; message?: string }): string {
  const message = failure.message ?? ''
  if (failure.code === 'unsupported' && /not yet/i.test(message)) return message
  if (failure.code === 'unsupported' || /does not understand/i.test(message)) return UPDATE_DESKTOP_WORDS
  if (/no gemini key/i.test(message)) return NO_KEY_WORDS
  if (/no openai key/i.test(message)) return NO_OPENAI_KEY_WORDS
  return message || 'The desktop could not start the voice agent.'
}

/** The agents the Listen chip offers, in its menu's order. ChatGPT is GPT Realtime, the full model. */
export const WEB_VOICE_AGENTS: readonly WebVoiceProvider[] = ['gemini-live', 'gpt-realtime', 'claude']

export const DEFAULT_WEB_VOICE_AGENT: WebVoiceProvider = 'gemini-live'

/** An agent as the chip's one word. */
export function voiceAgentWord(agent: WebVoiceProvider): string {
  switch (agent) {
    case 'gemini-live':
      return 'Gemini'
    case 'gpt-realtime':
      return 'ChatGPT'
    case 'gpt-realtime-mini':
      return 'ChatGPT mini'
    case 'claude':
      return 'Claude'
  }
}

/** A remembered choice, or the default when it is missing or not an agent. */
export function readVoiceAgent(stored: string | null | undefined): WebVoiceProvider {
  return stored === 'gemini-live' || stored === 'gpt-realtime' || stored === 'gpt-realtime-mini' || stored === 'claude'
    ? stored
    : DEFAULT_WEB_VOICE_AGENT
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

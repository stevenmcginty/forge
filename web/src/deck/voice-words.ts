/**
 * The words the deck's Listen switch says about the voice agent. Pure — no
 * React, no DOM — so scripts/realtime-check.mjs can hold them.
 */

export type WebVoicePhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/** What an older desktop is told to do: it answers the voice requests `unsupported`. */
export const UPDATE_DESKTOP_WORDS = 'Update the desktop app to use voice here'

export const NO_KEY_WORDS = 'No Gemini key on the desktop — add one in its Settings → Models & APIs'

/**
 * A failed voice request, in the sentence to show. An older desktop answers
 * `unsupported` with "This desktop does not understand a "voice-setup"
 * request." — which means one thing to Steve: update the desktop app.
 */
export function voiceFailureWords(failure: { code?: string; message?: string }): string {
  const message = failure.message ?? ''
  if (failure.code === 'unsupported' || /does not understand/i.test(message)) return UPDATE_DESKTOP_WORDS
  if (/no gemini key/i.test(message)) return NO_KEY_WORDS
  return message || 'The desktop could not start the voice agent.'
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

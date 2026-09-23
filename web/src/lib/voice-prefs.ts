/**
 * Phone-local voice preferences. Kept in localStorage because they belong to
 * this phone, not the desktop, and every access is guarded: a private window or
 * blocked site data must read as "default", never as a thrown error.
 */

const AUTO_STOP_KEY = 'forge.voice.autoStop'
const READ_ALOUD_VOICE_KEY = 'forge.voice.readAloud'

/** Stop recording and send after a pause in speech. Off unless Steve turns it on. */
export function getVoiceAutoStop(): boolean {
  try {
    return localStorage.getItem(AUTO_STOP_KEY) === '1'
  } catch {
    return false
  }
}

export function setVoiceAutoStop(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_STOP_KEY, '1')
    else localStorage.removeItem(AUTO_STOP_KEY)
  } catch {
    // Storage refused: the setting simply does not persist.
  }
}

/**
 * The voice Read aloud speaks in, as the device's `voiceURI`. Empty means
 * Automatic — and so does a saved voice the phone no longer has.
 */
export function getReadAloudVoice(): string {
  try {
    return localStorage.getItem(READ_ALOUD_VOICE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setReadAloudVoice(voiceURI: string): void {
  try {
    if (voiceURI) localStorage.setItem(READ_ALOUD_VOICE_KEY, voiceURI)
    else localStorage.removeItem(READ_ALOUD_VOICE_KEY)
  } catch {
    // Storage refused: the choice simply does not persist.
  }
}

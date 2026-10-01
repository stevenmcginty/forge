/**
 * A buzz under the thumb, for the moments Steve is not looking at the phone.
 *
 * The same guarded `navigator.vibrate?.()` the long-press menu and Listen's
 * "your turn" use, with the dictation's four moments named: the microphone is
 * really open, the recording stopped, the words were sent, it failed. Short on
 * purpose — a cue, not an alarm.
 *
 * A no-op wherever there is no motor or the browser refuses (a desktop, iOS
 * Safari, a page nobody has touched yet): the screen still says it in words.
 */

export type Buzz = 'open' | 'stop' | 'sent' | 'failed'

const PATTERNS: Record<Buzz, number | number[]> = {
  /** One short: the microphone is open, talk. */
  open: 15,
  /** One short: the recording stopped. */
  stop: 10,
  /** Two short: the words went. */
  sent: [12, 70, 12],
  /** One long: nothing was sent. */
  failed: 70
}

export function buzz(kind: Buzz): void {
  try {
    if (typeof navigator !== 'undefined') navigator.vibrate?.(PATTERNS[kind])
  } catch {
    /* no vibration motor, or not allowed: the words on screen are the feedback */
  }
}

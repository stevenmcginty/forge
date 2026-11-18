/**
 * A buzz under the thumb, for the moments Steve is not looking at the phone.
 *
 * The one haptic map for the phone (web/PHONE-DESIGN.md, "Haptics"). Call
 * `buzz(kind)`; never `navigator.vibrate` directly, so every surface speaks
 * the same patterns. Short on purpose — a cue, not an alarm. Ordinary taps,
 * scrolling and opening a sheet by tap get no buzz: the screen answers those.
 *
 * A no-op wherever there is no motor or the browser refuses (a desktop, iOS
 * Safari, a page nobody has touched yet): the screen still says it in words.
 */

export type Buzz =
  /** A hold opened something (tab menu, bubble menu, the drum). */
  | 'hold'
  /** A choice landed in a picker that was moved by drag or swipe (the drum, a slider). */
  | 'select'
  /** A thing you asked for happened and you may not be looking: answered, closed, started. */
  | 'confirm'
  /** Something now needs you (a heads-up banner arriving). */
  | 'warn'
  /** It failed; nothing was done. */
  | 'error'
  /** Dictation: the microphone is open, talk. */
  | 'open'
  /** Dictation: the recording stopped. */
  | 'stop'
  /** Dictation: the words went. */
  | 'sent'
  /** Dictation: nothing was sent. */
  | 'failed'

const PATTERNS: Record<Buzz, number | number[]> = {
  hold: 12,
  select: 6,
  confirm: [12, 70, 12],
  warn: [30, 80, 30],
  error: 70,
  open: 15,
  stop: 10,
  sent: [12, 70, 12],
  failed: 70
}

export function buzz(kind: Buzz): void {
  try {
    if (typeof navigator !== 'undefined') navigator.vibrate?.(PATTERNS[kind])
  } catch {
    /* no vibration motor, or not allowed: the words on screen are the feedback */
  }
}

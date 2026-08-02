/**
 * The blips.
 *
 * Five of them now: the agent's "your turn" handover, the pair that brackets a
 * dictation session, and the pair a finished terminal plays — the last two at
 * the bottom. Everything below about *why* these are synthesised, and how quiet
 * they are, applies to all five.
 *
 * This replaces something worse. The agent used to *say* it was ready for the
 * next thing — a spoken sentence, word for word the same every time, which is
 * precisely the robotic sameness Steve complained about. Going back to
 * listening does not need announcing in English: the button already says
 * "Listening" and the ring is moving. It needs a full stop, and 120 ms of quiet
 * sine is a full stop.
 *
 * Deliberately synthesised rather than shipped as a file:
 *   • no asset, no bundler rule, no CSP question, nothing to go missing;
 *   • it can be quiet in a way a normalised sample cannot — the peak here is
 *     about −27 dBFS, which is under a keystroke;
 *   • the envelope has real attack and release, so it is a soft "tuh" rather
 *     than the click you get from starting and stopping a raw oscillator.
 *
 * Two notes a fifth apart, the second overlapping the first, reads as "over to
 * you" rather than as an alert. Nothing here ever blocks: an earcon that made a
 * caller wait would delay re-opening the microphone, which is the one thing it
 * is supposed to be marking.
 */

/** Total length. Short enough that it is punctuation, not a sound effect. */
export const EARCON_MS = 120

/** Peak gain — about −27 dBFS. Audible on laptop speakers, never startling. */
const PEAK = 0.045

let context: AudioContext | null = null

/**
 * Shared with the speech path in tts.ts by intent, not by accident: a second
 * AudioContext costs another hardware voice on Windows and another device
 * setup, for two sine waves.
 */
function audio(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null
  if (!context) {
    try {
      context = new AudioContext()
    } catch {
      return null
    }
  }
  if (context.state === 'suspended') void context.resume()
  return context
}

/** Whether an earcon could be played at all — no Web Audio means no. */
export function earconsAvailable(): boolean {
  return typeof window !== 'undefined' && typeof AudioContext !== 'undefined'
}

/**
 * One note, shaped.
 *
 * The gain ramp is the whole trick: a 12 ms attack and an exponential release
 * to silence. `exponentialRampToValueAtTime` cannot reach zero, hence the tiny
 * floor and the explicit `stop` after it.
 */
function note(ctx: AudioContext, freq: number, at: number, seconds: number, peak: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.linearRampToValueAtTime(peak, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(at)
  osc.stop(at + seconds + 0.02)
  osc.onended = () => {
    try {
      osc.disconnect()
      gain.disconnect()
    } catch {
      /* already gone */
    }
  }
}

/**
 * "Listening again." Two soft notes, ~120 ms in total.
 *
 * A5 then E6 — rising, because the turn is being handed back rather than taken
 * away. Returns immediately; nothing waits on this.
 */
export function earconListening(): void {
  const ctx = audio()
  if (!ctx) return
  const now = ctx.currentTime
  const half = EARCON_MS / 2000
  note(ctx, 880, now, half * 1.6, PEAK)
  note(ctx, 1318.5, now + half * 0.75, half * 1.6, PEAK * 0.8)
}

/* ------------------------------------------------------------- dictation
 *
 * The microphone opening and closing, as a sound.
 *
 * Steve's complaint was simple: he presses Right Ctrl and has to look at the
 * status bar to find out whether he is now dictating. A hotkey with no answer
 * is a hotkey you second-guess, and the pill is at the other end of the screen
 * from whatever he is actually looking at.
 *
 * So: a rising pair when the mic opens, the same two notes falling when it
 * closes. Rising/falling rather than two different tones because direction is
 * the one thing you can read without having learned the sound — up is on.
 *
 * A fourth below the agent's blip, and a fifth apart rather than the agent's
 * wider interval, so the two are not mistaken for each other: the agent handing
 * a turn back and dictation opening mean very different things about where your
 * next sentence is going to land.
 */

/** D5 and A5 — under the agent's blip, and out of the way of speech. */
const DICT_LOW = 587.3
const DICT_HIGH = 880

function pair(from: number, to: number): void {
  const ctx = audio()
  if (!ctx) return
  const now = ctx.currentTime
  const half = EARCON_MS / 2000
  note(ctx, from, now, half * 1.4, PEAK)
  note(ctx, to, now + half * 0.7, half * 1.4, PEAK * 0.85)
}

/** "The mic is open." Rising. */
export function earconDictationOn(): void {
  pair(DICT_LOW, DICT_HIGH)
}

/** "The mic is shut." The same two notes, the other way up. */
export function earconDictationOff(): void {
  pair(DICT_HIGH, DICT_LOW)
}

/* ------------------------------------------------------------- terminals
 *
 * A task finishing, as a sound. Steve asked for it directly: a terminal that
 * completes while he is looking at anything else should say so, or the first
 * he knows of a finished build is the moment he looks at it. The two shapes are
 * the same pair of notes — up when a session ends cleanly (exit 0), down when
 * it did not. Direction is the one thing you can read before learning a sound,
 * the rule the dictation pair already follows, so "done" and "broken" need no
 * second thought.
 *
 * The register is deliberately a fifth above the dictation pair: this is a
 * completion, not a toggle, and the two must never be mistaken for each other.
 */

/** C6 and G6 — a perfect fifth, a register above the dictation pair. */
const TASK_LOW = 1046.5
const TASK_HIGH = 1568

/** "A session ended cleanly." Rising, the way "finished" should sound. */
export function earconTaskDone(): void {
  pair(TASK_LOW, TASK_HIGH)
}

/** "A session ended badly." The same two notes, the other way up. */
export function earconTaskAttention(): void {
  pair(TASK_HIGH, TASK_LOW)
}

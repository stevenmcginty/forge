/**
 * How loud the microphone is while a dictation records — one AnalyserNode per
 * recording, shared by everything that needs to know.
 *
 * Three readers: the meter on the button (the frequency bands, drawn straight
 * from `analyser`), the silence check (was anything louder than a quiet room
 * heard at all, or is this the Bluetooth-routed "Thank you." recording), and
 * the opt-in auto-stop (a pause after speech ends the recording). The last
 * two read the loudness (RMS) of the raw waveform on a timer, not per frame:
 * a timer keeps sampling when the browser stops painting.
 */

/**
 * The loudness line between "someone spoke" and "nothing was heard", as the
 * RMS of the raw waveform (full scale = 1).
 *
 * 0.01 is -40 dBFS. The harness's oscillator stub (a tone at gain 0.4 under a
 * 3 Hz tremolo) reads 0.1–0.5; its silent stub reads exactly 0; a phone mic
 * routed away to a Bluetooth headset reads 0 or a hair above. Real speech at
 * arm's length peaks around -30 to -15 dBFS (0.03–0.18) and a quiet room with
 * the browser's noise suppression on sits near -60 to -50 dBFS (0.001–0.003),
 * so the line sits well under any spoken word — a recording is only called
 * silent when nothing in it came near speech. Conservative on purpose: a
 * false "I heard nothing" loses words, a missed one costs one transcription.
 */
export const SPEECH_RMS = 0.01

/** How often the loudness is sampled for the silence check and auto-stop. */
const SAMPLE_MS = 50
/** Auto-stop waits for at least this much speech before a pause counts. */
export const AUTO_STOP_AFTER_SPEECH_MS = 1000
/** …and then this much quiet after it. */
export const AUTO_STOP_QUIET_MS = 2000
/**
 * The silence check only judges a recording it actually listened to for most
 * of its length. A page the phone put in the background (screen lock, app
 * switch) stops sampling, and "no samples" must not read as "silence".
 */
const MIN_COVERAGE = 0.5

export interface LevelMonitor {
  /** The analyser on the open microphone — the meter draws its bands from it. */
  analyser: AnalyserNode
  /** The latest loudness, 0..1, eased — what a waveform draws. */
  level: () => number
  /**
   * True when the recording was listened to for most of its length and never
   * once came near speech. False whenever that cannot be said for sure.
   */
  silent: () => boolean
  /** The loudest moment heard, as RMS. For a status line or a debug read. */
  peak: () => number
  /** Stop listening and let the audio graph go. Safe to call twice. */
  close: () => void
}

/**
 * Start listening to `stream`. Null when this browser has no Web Audio — the
 * recording still works, it just has no meter, no silence check and no
 * auto-stop.
 *
 * `onPause` fires once, after at least a second of speech followed by two
 * seconds under `SPEECH_RMS` — the auto-stop. Pass nothing to leave it off.
 */
export function watchLevel(stream: MediaStream, onPause?: () => void): LevelMonitor | null {
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  let ctx: AudioContext
  let source: MediaStreamAudioSourceNode
  let analyser: AnalyserNode
  try {
    ctx = new Ctx()
    source = ctx.createMediaStreamSource(stream)
    analyser = ctx.createAnalyser()
  } catch {
    return null
  }
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.55
  source.connect(analyser)
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)

  const wave = new Float32Array(analyser.fftSize)
  const startedAt = performance.now()
  let sampledMs = 0
  let last = startedAt
  let peak = 0
  let shown = 0
  let speechMs = 0
  let quietMs = 0
  let paused = false
  let closed = false

  const sample = (): void => {
    const now = performance.now()
    // A gap far longer than the timer means the page was asleep: that stretch
    // was not listened to, so it counts toward neither speech nor coverage.
    const step = now - last
    last = now
    if (step > SAMPLE_MS * 4) return
    if (ctx.state !== 'running') return
    analyser.getFloatTimeDomainData(wave)
    let sum = 0
    for (let i = 0; i < wave.length; i++) sum += wave[i]! * wave[i]!
    const rms = Math.sqrt(sum / wave.length)
    sampledMs += step
    if (rms > peak) peak = rms
    // Rise at once, fall gently — the same feel the meter's bars have.
    const target = Math.min(1, rms * 4)
    shown = target > shown ? target : shown * 0.85
    if (rms >= SPEECH_RMS) {
      speechMs += step
      quietMs = 0
    } else {
      quietMs += step
    }
    if (
      onPause &&
      !paused &&
      speechMs >= AUTO_STOP_AFTER_SPEECH_MS &&
      quietMs >= AUTO_STOP_QUIET_MS
    ) {
      paused = true
      onPause()
    }
  }
  const timer = window.setInterval(sample, SAMPLE_MS)

  return {
    analyser,
    level: () => shown,
    peak: () => peak,
    silent: () => {
      const elapsed = performance.now() - startedAt
      if (elapsed <= 0 || sampledMs < elapsed * MIN_COVERAGE) return false
      return peak < SPEECH_RMS
    },
    close: () => {
      if (closed) return
      closed = true
      window.clearInterval(timer)
      try {
        source.disconnect()
      } catch {
        // already gone
      }
      void ctx.close().catch(() => undefined)
    }
  }
}

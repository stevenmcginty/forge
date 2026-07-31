/**
 * Talking over the agent, and being heard.
 *
 * The old rule was blunt and it is written into the state machine in
 * src/state/VoiceAgent.tsx: while the agent speaks, THE MICROPHONE IS SHUT. It
 * had to be. The sidecar hears whatever the speakers play, so an open mic meant
 * Forge transcribing its own reply, answering it, and talking to itself until
 * you closed the app.
 *
 * The cost of that rule is the thing Steve asked to fix: for the two or three
 * seconds the agent is talking you cannot interrupt it by talking, only by
 * clicking. ChatGPT's GPT-Live made the other choice — it is full duplex, it
 * listens while it speaks, and you cut in mid-sentence the way you would with a
 * person.
 *
 * This module is how Forge gets that without getting the feedback loop back.
 *
 * THE TRICK IS WHOSE MICROPHONE. The sidecar's capture is raw: a Python process
 * with a device handle and no idea what the speakers are doing. Chromium's is
 * not — `getUserMedia({ echoCancellation: true })` runs the same WebRTC AEC that
 * every video call on this machine uses, and it references the default render
 * device, which is where our own TTS is playing. So the agent's voice is
 * subtracted from the captured signal before we ever see it, and what is left
 * above the noise floor is a person in the room.
 *
 * So while the agent speaks there are two microphones in two different senses:
 * the sidecar is stopped, exactly as before, and this one is open — but this one
 * does not transcribe anything. It answers one question, ten times a second:
 * *is somebody talking right now?* That is a VAD, not an ASR, and a VAD cannot
 * put words in the agent's mouth.
 *
 * Two thresholds rather than one, because being right and being quick are
 * different problems:
 *
 *   DUCK      one loud frame. The reply drops to a murmur immediately. If it
 *             was a cough or a door, it comes back up and nothing was lost —
 *             and *because* nothing is lost, this can be hair-trigger.
 *   INTERRUPT ~120ms of continuous voice. Now it is a person, and the reply is
 *             cancelled outright.
 *
 * The ducking is what makes it feel instant. The honest interrupt latency is
 * still the 120ms of evidence plus the sidecar's restart, but the agent has
 * already got quiet within a frame of him opening his mouth, which is the part
 * you actually perceive as "it heard me".
 */

/** How often the level is sampled. 20ms is one frame of the WebRTC AEC. */
const FRAME_MS = 20

/**
 * Continuous voiced frames before it counts as an interruption.
 *
 * Six frames — 120ms. Below about 100ms a hand clap, a dropped mug or the
 * clack of a mechanical keyboard gets through; much above 200ms and you have
 * to shout the first word of your sentence twice.
 */
const INTERRUPT_FRAMES = 6

/**
 * Quiet frames before the ducked reply comes back up.
 *
 * Longer than the interrupt window on purpose: it is the gap *between words*.
 * Restoring the volume during the pause in "open — three — tabs" would make the
 * agent stutter back to full volume mid-interruption.
 */
const RELEASE_FRAMES = 12

/**
 * The floor, in RMS, below which nothing counts however quiet the room is.
 *
 * The AEC leaves a residue — it is very good, not perfect — and on a loud reply
 * that residue is a real signal. Without an absolute floor the adaptive
 * threshold below would eventually tune itself down onto it and the agent would
 * interrupt itself, which is the original feedback bug wearing a new hat.
 */
const ABSOLUTE_FLOOR = 0.012

/** Speech has to beat the measured noise floor by this much. */
const OVER_NOISE = 3.2

/** How fast the noise floor tracks the room. Slow: it is a floor, not a level. */
const FLOOR_RISE = 0.002
const FLOOR_FALL = 0.02

export interface BargeInHandlers {
  /** One suspicious frame — get quiet, but do not give up the turn yet. */
  onDuck(): void
  /** It was noise. Come back up. */
  onRelease(): void
  /** Somebody is talking. Stop. */
  onInterrupt(): void
}

/** Why the listener could not open. Distinguished so the UI can say something useful. */
export type BargeInFailure = 'denied' | 'no-device' | 'unsupported' | 'failed'

export interface BargeInResult {
  ok: boolean
  reason?: BargeInFailure
}

/* -------------------------------------------------------------------- seam */

/** The bits of the browser this needs, behind an interface so it can be tested. */
export interface BargeInAudio {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  context(): AudioContext
}

function realAudio(): BargeInAudio {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    context: () => new AudioContext()
  }
}

let audioSeam: BargeInAudio | null = null

/** Test seam. Passing null puts the real getUserMedia + Web Audio back. */
export function setBargeInAudio(next: BargeInAudio | null): void {
  audioSeam = next
}

function io(): BargeInAudio {
  if (!audioSeam) audioSeam = realAudio()
  return audioSeam
}

/* ----------------------------------------------------------------- the VAD */

/**
 * The decision, with no audio in it.
 *
 * Split out from the plumbing so the thresholds can be driven frame by frame
 * from a test with a made-up array of levels — you cannot tune a barge-in
 * detector by talking at it and remembering how it felt.
 */
export class VoiceDetector {
  private floor = ABSOLUTE_FLOOR
  private voiced = 0
  private quiet = 0
  private ducked = false
  private fired = false

  /** The current adaptive threshold. Exposed for tests and diagnostics. */
  get threshold(): number {
    return Math.max(ABSOLUTE_FLOOR, this.floor * OVER_NOISE)
  }

  /** Ready for another utterance. */
  reset(): void {
    this.voiced = 0
    this.quiet = 0
    this.ducked = false
    this.fired = false
    this.floor = ABSOLUTE_FLOOR
  }

  /**
   * One frame in, at most one event out.
   *
   * Returns null when nothing changed, which is almost every frame.
   */
  push(rms: number): 'duck' | 'release' | 'interrupt' | null {
    const loud = rms > this.threshold

    // Track the floor only while it is quiet, and let it fall faster than it
    // rises: a floor that climbed during speech would tune the detector out
    // mid-sentence, so the longer you talked the less it could hear you.
    if (!loud) {
      this.floor += (rms - this.floor) * (rms > this.floor ? FLOOR_RISE : FLOOR_FALL)
    }

    if (loud) {
      this.quiet = 0
      this.voiced++
      if (!this.ducked) {
        this.ducked = true
        return 'duck'
      }
      if (this.voiced >= INTERRUPT_FRAMES && !this.fired) {
        this.fired = true
        return 'interrupt'
      }
      return null
    }

    this.voiced = 0
    this.quiet++
    // Once it has fired there is nothing left to release — the reply is already
    // cancelled, and a 'release' here would turn a stopped clip back up.
    if (this.ducked && !this.fired && this.quiet >= RELEASE_FRAMES) {
      this.ducked = false
      return 'release'
    }
    return null
  }
}

/* ------------------------------------------------------------- the listener */

/**
 * The AEC'd microphone, open only while the agent is speaking.
 *
 * Deliberately not held open the rest of the time. It is a second handle on the
 * capture device, and leaving it open would mean Forge showing as "using your
 * microphone" in the Windows privacy indicator permanently — which is both a
 * fair thing for the OS to say and not a thing Steve asked for.
 */
class BargeInListener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private timer: number | null = null
  private buffer: Float32Array<ArrayBuffer> | null = null
  private readonly detector = new VoiceDetector()
  private failed: BargeInFailure | null = null

  get running(): boolean {
    return this.timer !== null
  }

  /** The last failure, so the caller can explain itself once and stop retrying. */
  get lastFailure(): BargeInFailure | null {
    return this.failed
  }

  async arm(handlers: BargeInHandlers): Promise<BargeInResult> {
    if (this.running) return { ok: true }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.failed = 'unsupported'
      return { ok: false, reason: 'unsupported' }
    }

    try {
      // Every one of these matters. Echo cancellation is the feature; noise
      // suppression stops a fan from ducking the reply forever; auto gain
      // control keeps the thresholds meaningful across a headset and a laptop
      // mic. Mono at 16k because this is a VAD — nothing downstream will ever
      // listen to it.
      this.stream = await io().getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16_000
        },
        video: false
      })
    } catch (err) {
      this.failed = classify(err)
      return { ok: false, reason: this.failed }
    }

    try {
      const ctx = io().context()
      if (ctx.state === 'suspended') await ctx.resume()
      const analyser = ctx.createAnalyser()
      // Small window: this is an energy measurement, not a spectrum, and a
      // large FFT would smear the onset we are trying to catch quickly.
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0
      const source = ctx.createMediaStreamSource(this.stream)
      source.connect(analyser)
      // Deliberately NOT connected to ctx.destination. Routing the microphone
      // to the speakers is a howl, and there is nothing to listen to anyway.

      this.ctx = ctx
      this.analyser = analyser
      this.source = source
      this.buffer = new Float32Array(analyser.fftSize)
      this.detector.reset()
      this.failed = null

      // setInterval, not requestAnimationFrame. The whole point of this feature
      // is that it works while Forge is minimised behind Chrome, and rAF does
      // not run in a window nobody can see.
      this.timer = window.setInterval(() => this.tick(handlers), FRAME_MS)
      return { ok: true }
    } catch (err) {
      this.disarm()
      this.failed = classify(err)
      return { ok: false, reason: this.failed }
    }
  }

  private tick(handlers: BargeInHandlers): void {
    const analyser = this.analyser
    const buffer = this.buffer
    if (!analyser || !buffer) return
    analyser.getFloatTimeDomainData(buffer)
    let sum = 0
    for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
    const rms = Math.sqrt(sum / buffer.length)

    switch (this.detector.push(rms)) {
      case 'duck':
        handlers.onDuck()
        return
      case 'release':
        handlers.onRelease()
        return
      case 'interrupt':
        handlers.onInterrupt()
        return
      default:
        return
    }
  }

  /**
   * Close the microphone. Idempotent, and it really does close it — stopping
   * the tracks is what turns off the Windows "in use" indicator, and a stream
   * merely disconnected from the graph keeps the device open.
   */
  disarm(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.source?.disconnect()
    } catch {
      /* already gone */
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    // The AudioContext is closed rather than kept: unlike the playback context
    // in tts.ts this one is opened for a couple of seconds at a time, and a
    // context per utterance that was never closed would leak hardware voices.
    void this.ctx?.close().catch(() => {})
    this.stream = null
    this.source = null
    this.analyser = null
    this.buffer = null
    this.ctx = null
  }
}

function classify(err: unknown): BargeInFailure {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  return 'failed'
}

/** One listener for the app — there is one microphone and one mouth. */
export const bargeIn = new BargeInListener()

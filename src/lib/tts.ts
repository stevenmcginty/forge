import type { VoiceEngine, VoiceSpeakRequest, VoiceSpeakResult } from '@shared/types'
import { speakable, speaker } from './speech'

/**
 * The agent's voice, for real this time.
 *
 * Steve's verdict on v1 — Chromium `speechSynthesis`, i.e. Windows SAPI — was
 * "honestly, the voice agent is just garbage. It sounds robotic." He was right,
 * and no amount of voice-picking fixes a formant synthesiser. So the agent now
 * speaks with a Gemini TTS model and keeps SAPI purely as the thing that talks
 * when the good one cannot.
 *
 * This module is the *chain*, not the engine:
 *
 *   1. the LRU cache — a confirmation he has heard before is instant and free,
 *      which matters twice over because the free-tier TTS quota is roughly six
 *      sentences a minute;
 *   2. Gemini, over `voice:speak` in the main process (the key never reaches
 *      page script, and the renderer's CSP allows no external host anyway);
 *   3. the local engine, whenever step 2 cannot run or fails.
 *
 * Three rules it exists to keep:
 *
 *   • NEVER DEAD AIR. Every failure path ends in the local voice saying the
 *     words, plus one notice explaining why it sounds worse. An agent that
 *     silently says nothing is indistinguishable from one that has crashed.
 *   • ONE MOUTH. `speakOnce` is keyed by turn id, so a React re-render cannot
 *     say the same sentence twice — the bug Steve heard as "he keeps going on
 *     and on, over and over again".
 *   • BARGE-IN IS INSTANT. `cancel()` aborts the in-flight request in the main
 *     process *and* stops the AudioBufferSource. Talking over it must work
 *     whether the audio has started or not.
 *
 * The two side-effectful halves — IPC and Web Audio — are behind `TtsBackend`
 * so the whole chain can be driven in a headless test. See voice:check.
 */

/* ------------------------------------------------------------------ backend */

/** A handle on a sound that has started. `stop` is idempotent. */
export interface Playing {
  /** Resolves when the audio finishes or is stopped. Never rejects. */
  done: Promise<void>
  stop(): void
  /**
   * Ride the volume, 0…1, without stopping.
   *
   * For barge-in. The instant somebody starts talking over the reply it drops
   * to a murmur; if the noise turns out to have been a door rather than a
   * person it comes back up and nothing was lost. Only a confirmed
   * interruption calls `stop`.
   *
   * That two-stage shape is what makes interrupting feel immediate even though
   * deciding takes ~120ms of evidence — the agent is already quiet within a
   * frame of Steve opening his mouth, which is the part you actually notice.
   * See src/lib/bargein.ts.
   */
  duck(level: number): void
}

export interface TtsBackend {
  speak(req: VoiceSpeakRequest): Promise<VoiceSpeakResult>
  cancelSpeak(requestId: string): Promise<boolean>
  /** Play raw PCM. Returns as soon as playback has *started*. */
  play(pcm: Int16Array, sampleRate: number, channels: number): Playing
  /**
   * Decode a compressed clip (the edge engine returns MP3) to the same raw PCM
   * shape everything downstream — the cache, `play`, ducking — already speaks.
   * Decoding once at arrival rather than at each replay is what keeps a cached
   * confirmation instant.
   */
  decode(bytes: ArrayBuffer): Promise<{ pcm: Int16Array; sampleRate: number; channels: number }>
}

/* --------------------------------------------------------------- Web Audio */

let audioContext: AudioContext | null = null

/**
 * One AudioContext for the life of the app.
 *
 * Making a new one per utterance leaks hardware voices on Windows and adds a
 * few tens of milliseconds of device setup to every reply. It is created lazily
 * because constructing one before any user gesture leaves it `suspended`, and a
 * suspended context plays nothing at all — hence the resume below, which is a
 * no-op once it is running.
 */
function context(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext
}

/**
 * Signed 16-bit little-endian → the −1…1 floats Web Audio wants.
 *
 * Gemini returns *raw* PCM with no WAV header, so `decodeAudioData` cannot be
 * used: it sniffs container formats and rejects headerless samples. Dividing by
 * 32768 rather than 32767 is deliberate — it makes the negative extreme map to
 * exactly −1 and cannot overflow, and the half-bit of asymmetry is inaudible.
 */
export function pcmToFloat32(pcm: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768
  return out
}

/** base64 → bytes, in one pass, without a Buffer polyfill. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** base64 → Int16Array. */
export function base64ToPcm(b64: string): Int16Array {
  const bytes = base64ToBytes(b64)
  // Little-endian is what the API sends and what every x86 machine reads
  // natively, so the underlying buffer can be reinterpreted rather than copied —
  // but only when it happens to be 2-byte aligned, which a fresh Uint8Array is.
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
}

function webAudioPlay(pcm: Int16Array, sampleRate: number, channels: number): Playing {
  const ctx = context()
  const frames = Math.floor(pcm.length / channels)
  const buffer = ctx.createBuffer(channels, Math.max(1, frames), sampleRate)
  if (channels === 1) {
    buffer.copyToChannel(pcmToFloat32(pcm), 0)
  } else {
    // Interleaved in, planar out.
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames)
      for (let i = 0; i < frames; i++) plane[i] = pcm[i * channels + c]! / 32768
      buffer.copyToChannel(plane, c)
    }
  }
  const source = ctx.createBufferSource()
  source.buffer = buffer
  // A gain stage between the clip and the speakers, purely so barge-in has
  // something to turn down. It costs nothing at unity and it is the only way
  // to get quiet *without* giving up the clip — stopping an AudioBufferSource
  // is final, there is no resume.
  const gain = ctx.createGain()
  gain.gain.value = 1
  source.connect(gain)
  gain.connect(ctx.destination)

  let settled = false
  let resolve: () => void = () => {}
  const done = new Promise<void>((r) => {
    resolve = r
  })
  const finish = (): void => {
    if (settled) return
    settled = true
    try {
      source.disconnect()
      gain.disconnect()
    } catch {
      /* already gone */
    }
    resolve()
  }
  source.onended = finish
  source.start()
  return {
    done,
    stop: () => {
      try {
        source.stop()
      } catch {
        /* never started, or already stopped */
      }
      finish()
    },
    // A short ramp rather than a step: an instantaneous gain change on a
    // playing buffer is a click, and a click every time somebody clears their
    // throat would be worse than not ducking at all.
    duck: (level: number) => {
      if (settled) return
      const target = Math.max(0, Math.min(1, level))
      try {
        gain.gain.setTargetAtTime(target, ctx.currentTime, 0.015)
      } catch {
        /* context went away mid-utterance */
      }
    }
  }
}

/**
 * MP3 → raw PCM, through the browser's own decoder.
 *
 * `decodeAudioData` hands back planar Float32; downstream wants interleaved
 * Int16 because that is the one shape the cache and `play` already handle for
 * Gemini's raw clips. One conversion here beats two code paths everywhere else.
 */
async function webAudioDecode(bytes: ArrayBuffer): Promise<{ pcm: Int16Array; sampleRate: number; channels: number }> {
  const decoded = await context().decodeAudioData(bytes)
  const channels = Math.max(1, Math.min(2, decoded.numberOfChannels))
  const frames = decoded.length
  const pcm = new Int16Array(frames * channels)
  for (let c = 0; c < channels; c++) {
    const plane = decoded.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      const sample = Math.max(-1, Math.min(1, plane[i] ?? 0))
      pcm[i * channels + c] = Math.round(sample * 32767)
    }
  }
  return { pcm, sampleRate: decoded.sampleRate, channels }
}

function rendererBackend(): TtsBackend {
  return {
    speak: (req) => window.forge.voice.speak(req),
    cancelSpeak: (id) => window.forge.voice.cancelSpeak(id),
    play: webAudioPlay,
    decode: webAudioDecode
  }
}

let backend: TtsBackend | null = null

function io(): TtsBackend {
  if (!backend) backend = rendererBackend()
  return backend
}

/** Test seam. Passing null puts the real IPC + Web Audio backend back. */
export function setTtsBackend(next: TtsBackend | null): void {
  backend = next
}

/* -------------------------------------------------------------------- cache */

/** How many clips are kept. Twenty covers a session's worth of confirmations. */
export const TTS_CACHE_SIZE = 20

export interface CachedClip {
  pcm: Int16Array
  sampleRate: number
  channels: number
  voice: string
  model: string
}

/**
 * A cache key must include the voice and the model, not just the words.
 *
 * "Opened three Claude Code tabs." in Sulafat and the same sentence in Puck are
 * two different sounds, and a cache that confused them would make the sample
 * button in Settings play the wrong voice — which is the one place the whole
 * point is hearing the difference.
 */
export function ttsCacheKey(text: string, voice: string, model: string): string {
  return `${model} ${voice} ${text.trim()}`
}

/**
 * Insertion-ordered LRU. Small enough that a Map is the whole implementation.
 *
 * The limit is assigned in the body rather than declared as a parameter
 * property: voice:check runs these modules through Node's strip-only TypeScript
 * loader, which refuses `constructor(private x)` because it would have to emit
 * code rather than delete types.
 */
export class LruCache<T> {
  private readonly map = new Map<string, T>()
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get size(): number {
    return this.map.size
  }

  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    // Re-inserting moves it to the young end: Maps iterate in insertion order.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
  }
}

/* ------------------------------------------------------------------ filler */

/**
 * Canned sign-offs, stripped before anything is spoken.
 *
 * The brain is told not to write these (see the VOICE rules in appmanifest.ts)
 * but a rule in a prompt is a request, not a guarantee, and "Ready for your
 * next instruction." is the exact sentence Steve was hearing when he said the
 * voice agent was garbage. So it is also removed on the way out: two lines of
 * regex are cheaper than another round of prompt engineering, and they hold
 * even when the model is having an off day.
 *
 * Only *trailing* filler goes. A sentence that happens to contain the word
 * "ready" in the middle of real information is left alone.
 */
const FILLER_TAIL =
  /(?:^|[.!?]\s*)(?:i(?:'m| am)\s+)?(?:ready|standing by|awaiting|listening|waiting)\b[^.!?]*?\b(?:instruction|command|order|request|input|prompt|next)s?\b[^.!?]*[.!?]?\s*$/i

/** Standalone filler sentences with no information in them at all. */
const FILLER_WHOLE =
  /^(?:(?:i(?:'m| am)\s+)?(?:ready|listening|standing by|awaiting|here)\b[^.!?]*|(?:how (?:can|may) i help[^.!?]*)|(?:what(?:'s| is) next[^.!?]*)|(?:anything else[^.!?]*))[.!?]?$/i

/**
 * Take the canned sign-off off a reply. Returns '' when that was all there was —
 * and '' is a perfectly good reply. Going back to listening needs no
 * announcement; the button already says "Listening", and there is an earcon.
 */
export function stripFiller(text: string): string {
  let out = (text ?? '').trim()
  if (!out) return ''
  if (FILLER_WHOLE.test(out)) return ''
  // Loop: a model that appends one sign-off will happily append two.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(FILLER_TAIL, (match, offset: number) => (offset === 0 ? '' : match.slice(0, 1)))
    if (next.trim() === out) break
    out = next.trim()
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Pick something other than what was picked last time.
 *
 * Used for the handful of lines Forge itself has to say (a brain that failed,
 * for one). One fixed sentence repeated on every error is exactly the robotic
 * sameness this whole change is about, and varying it costs a array index.
 */
export function pickVaried(options: readonly string[], previous?: string): string {
  const pool = options.filter((o) => o && o !== previous)
  const list = pool.length ? pool : options
  return list[Math.floor(Math.random() * list.length)] ?? options[0] ?? ''
}

/* ------------------------------------------------------------- streaming */

/**
 * Longest chunk that is allowed to wait for a full stop.
 *
 * A model writing a list, or a paragraph with no terminal punctuation in it,
 * would otherwise hold the mouth shut until the whole turn was finished — which
 * is exactly the several-second silence streaming exists to remove. Cut at the
 * last comma or space before this instead, so the break still lands between
 * words rather than inside one.
 */
export const SPEAK_CHUNK_MAX = 220

/**
 * A sentence end: `.`, `!` or `?` (plus any closing quote) followed by
 * whitespace. The whitespace has to be *there*, not merely possible — a buffer
 * ending in "3." might be the start of "3.14", and the next delta decides.
 */
const SENTENCE_END = /[.!?]["')\]]?(?=\s)/

/**
 * Split a growing reply into the parts that can already be spoken.
 *
 * The contract is what makes sentence-by-sentence speech safe: everything
 * returned in `chunks` is finished — no later delta can change it — and `rest`
 * is what the caller must hold onto and pass back in with the next delta
 * appended. Nothing is ever dropped, and nothing is ever said twice.
 *
 * Deliberately *not* a full sentence tokeniser. "e.g." and "Dr." will
 * occasionally cut a chunk early; the cost of that is a comma-length pause in
 * the middle of a sentence, and the cost of the alternative is a page of
 * abbreviation tables. Wrong pauses are cheap here in a way wrong words are not.
 */
export function takeSpeechChunks(buffer: string, max: number = SPEAK_CHUNK_MAX): {
  chunks: string[]
  rest: string
} {
  const chunks: string[] = []
  let rest = buffer

  for (;;) {
    const hit = SENTENCE_END.exec(rest)
    let cut = hit ? hit.index + hit[0].length : -1
    // No sentence end yet — but an over-long run still has to be let out.
    if (cut < 0) {
      if (rest.length <= max) break
      const window = rest.slice(0, max)
      const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '))
      cut = soft > 0 ? soft + 1 : max
    }
    const head = rest.slice(0, cut).trim()
    rest = rest.slice(cut)
    if (head) chunks.push(head)
  }

  return { chunks, rest }
}

/* ---------------------------------------------------------------- the chain */

export interface VoiceConfig {
  engine: VoiceEngine
  /** Whether a Gemini key exists. Gemini without one means `local` (or edge). */
  hasKey: boolean
  /** Edge neural voice short name. Empty means the main process's default. */
  edgeVoice: string
  /** Prebuilt Gemini voice name. Empty means the main process's default. */
  geminiVoice: string
  /** Gemini TTS model id. Empty means the main process's default. */
  ttsModel: string
  /** `SpeechSynthesisVoice.name` for the local engine. Empty means best-available. */
  localVoice: string
}

export interface SpokenResult {
  /** Did any sound come out. */
  spoke: boolean
  engine: VoiceEngine | 'none'
  /** Was it already in the cache — time to first audio was effectively zero. */
  cached: boolean
  /** Milliseconds from asking to the first sample. */
  latencyMs: number
  /** Present when Gemini was wanted but the local voice had to do it. */
  fellBackBecause?: string
}

/** Which engine a config resolves to before anything is attempted. */
export function chooseEngine(config: VoiceConfig): VoiceEngine {
  if (config.engine === 'edge') return 'edge'
  return config.engine === 'gemini' && config.hasKey ? 'gemini' : 'local'
}

/**
 * The neural engines to try, in order, before the local voice is allowed near
 * the microphone.
 *
 * The second entry is the point: a neural engine that fails must fall to the
 * OTHER neural engine, not to SAPI. The old chain went Gemini → SAPI, and on a
 * free key Gemini's quota dies about six sentences in — so a streamed reply
 * would open in a warm neural voice and finish in a robot, which Steve heard
 * as "it keeps swapping voices". Neural → neural keeps the reply in a real
 * voice; the local engine speaks only when the network itself is gone.
 */
export function neuralChain(config: VoiceConfig): Array<'edge' | 'gemini'> {
  const chosen = chooseEngine(config)
  if (chosen === 'edge') return config.hasKey ? ['edge', 'gemini'] : ['edge']
  if (chosen === 'gemini') return ['gemini', 'edge']
  return []
}

let requestSeq = 0

/**
 * One mouth for the whole app, with a real voice in it.
 *
 * Mirrors the shape of `speaker` in speech.ts on purpose — `speakOnce`,
 * `cancel`, `speaking`, `onChange` — so VoicePanel's speaking/mic-pause logic
 * did not have to change to gain a better voice.
 */
class VoiceSpeaker {
  private readonly cache = new LruCache<CachedClip>(TTS_CACHE_SIZE)
  /** Turn ids already spoken. Bounded, because a session can run all day. */
  private readonly spoken = new Set<string>()
  private readonly listeners = new Set<(speaking: boolean) => void>()

  private playing: Playing | null = null
  /** The main-process request id currently in flight, if any. */
  private inFlight: string | null = null
  /** Bumped by `cancel()`, so a reply that lands after barge-in is discarded. */
  private generation = 0
  private active = false
  /** So the fallback notice is shown once per session, not once per sentence. */
  private warned = false

  get speaking(): boolean {
    return this.active
  }

  /** Clips held. Exposed so a test can prove the cache is doing something. */
  get cacheSize(): number {
    return this.cache.size
  }

  onChange(cb: (speaking: boolean) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Say something once, keyed by turn id.
   *
   * Returns without a sound if that key has already been spoken — belt over the
   * braces of calling this from one place per turn, because a component
   * re-renders for any number of reasons and anything that speaks from a render
   * path can speak twice.
   */
  async speakOnce(key: string, text: string, config: VoiceConfig, onNotice?: (msg: string) => void): Promise<SpokenResult> {
    if (this.spoken.has(key)) return { spoke: false, engine: 'none', cached: false, latencyMs: 0 }
    this.spoken.add(key)
    if (this.spoken.size > 400) {
      const oldest = this.spoken.values().next().value
      if (oldest !== undefined) this.spoken.delete(oldest)
    }
    return this.speak(text, config, onNotice)
  }

  /**
   * Say something. The settings page's sample button uses this directly; every
   * conversational turn goes through `speakOnce`.
   */
  async speak(text: string, config: VoiceConfig, onNotice?: (msg: string) => void): Promise<SpokenResult> {
    const body = stripFiller(speakable(text))
    if (!body) return { spoke: false, engine: 'none', cached: false, latencyMs: 0 }

    // Whatever was talking stops first: the queue is never a queue.
    this.stopSound()
    const generation = ++this.generation
    const started = Date.now()

    // Neural first — and on failure, the OTHER neural engine, so a quota or a
    // refused key changes which datacentre is talking, not whether the reply
    // sounds human. See neuralChain for why that ordering is the whole fix.
    let lastFailureKind: string | null = null
    let lastFailureError = ''
    for (const engine of neuralChain(config)) {
      const key =
        engine === 'edge'
          ? ttsCacheKey(body, config.edgeVoice || 'default', 'edge-neural')
          : ttsCacheKey(body, config.geminiVoice, config.ttsModel)
      const hit = this.cache.get(key)
      if (hit) {
        const played = await this.playClip(hit, body, generation)
        return { spoke: played, engine, cached: true, latencyMs: Date.now() - started }
      }

      const requestId = `say_${++requestSeq}`
      this.inFlight = requestId
      let result: VoiceSpeakResult
      try {
        result = await io().speak({
          text: body,
          engine,
          voice: engine === 'edge' ? config.edgeVoice : config.geminiVoice,
          model: engine === 'gemini' ? config.ttsModel : '',
          requestId
        })
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'network' }
      } finally {
        if (this.inFlight === requestId) this.inFlight = null
      }

      // Barge-in while the request was out: he is talking, so nothing is said.
      if (generation !== this.generation) {
        return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
      }

      if (result.ok) {
        let clip: CachedClip
        if (result.format === 'mp3') {
          try {
            const decoded = await io().decode(base64ToBytes(result.audio).buffer)
            clip = { ...decoded, voice: result.voice, model: result.model }
          } catch {
            // A clip that will not decode is this engine failing, not the end
            // of the chain.
            lastFailureKind = 'no-audio'
            lastFailureError = 'The audio clip could not be decoded'
            continue
          }
          // Decoding awaited too — he may have started talking during it.
          if (generation !== this.generation) {
            return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
          }
        } else {
          clip = {
            pcm: base64ToPcm(result.audio),
            sampleRate: result.sampleRate,
            channels: result.channels,
            voice: result.voice,
            model: result.model
          }
        }
        this.cache.set(key, clip)
        const played = await this.playClip(clip, body, generation)
        return { spoke: played, engine, cached: false, latencyMs: Date.now() - started }
      }

      // A cancellation is not a failure and must not drag him onto SAPI.
      if (result.kind === 'cancelled') {
        return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
      }

      lastFailureKind = result.kind
      lastFailureError = result.error
    }

    // Every neural engine failed (or none was configured). The local voice
    // rather than dead air — and once per session it explains itself.
    if (lastFailureKind && !this.warned) {
      this.warned = true
      onNotice?.(`Neural voice unavailable — using the built-in one. ${firstSentence(lastFailureError)}`)
    }
    const spoke = await this.speakLocal(body, config, generation)
    const out: SpokenResult = { spoke, engine: 'local', cached: false, latencyMs: Date.now() - started }
    if (lastFailureKind) out.fellBackBecause = lastFailureKind
    return out
  }

  /**
   * Shut up now.
   *
   * Three things, and all three are needed: stop the sound that is playing,
   * abort the request that has not come back yet, and bump the generation so a
   * reply already in the air is thrown away rather than played a beat later.
   */
  cancel(): void {
    this.generation++
    this.stopSound()
    const id = this.inFlight
    if (id) {
      this.inFlight = null
      void io().cancelSpeak(id)
    }
    speaker.cancel()
  }

  /**
   * Get quiet without giving up the turn.
   *
   * Barge-in's first move. `cancel()` is its second, and only if the noise
   * turns out to have been a person — see src/lib/bargein.ts.
   *
   * A no-op on the local engine, and that is not a bug worth fixing: SAPI has
   * no volume ride, only stop. The consequence is that ducking is a neural-
   * voice nicety and interrupting works on both, which is the right way round.
   */
  duck(level: number): void {
    this.playing?.duck(level)
  }

  /** Forget every cached clip — for a voice or model change in Settings. */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Play a clip, with the echo guard told what is coming out of the speakers.
   *
   * `speaker.rememberSpoken` is not an afterthought: the microphone is a foot
   * from the speakers, the sidecar cuts a phrase on silence — so Forge's own
   * words land a beat *after* the audio stops — and the guard that catches that
   * lives in speech.ts and would otherwise never hear about a neural clip.
   * Without this pair, the default engine would talk to itself.
   */
  private async playClip(clip: CachedClip, text: string, generation: number): Promise<boolean> {
    if (generation !== this.generation) return false
    this.announce(true)
    let handle: Playing
    try {
      speaker.rememberSpoken(text)
      handle = io().play(clip.pcm, clip.sampleRate, clip.channels)
    } catch {
      speaker.finishedSpeaking()
      this.announce(false)
      return false
    }
    this.playing = handle
    try {
      await handle.done
    } finally {
      if (this.playing === handle) this.playing = null
      speaker.finishedSpeaking()
      this.announce(false)
    }
    return true
  }

  private async speakLocal(body: string, config: VoiceConfig, generation: number): Promise<boolean> {
    if (generation !== this.generation || !speaker.available) return false
    this.announce(true)
    try {
      return await speaker.speak(body, { voiceName: config.localVoice })
    } finally {
      this.announce(false)
    }
  }

  private stopSound(): void {
    const handle = this.playing
    this.playing = null
    handle?.stop()
    if (this.active) this.announce(false)
  }

  private announce(next: boolean): void {
    if (this.active === next) return
    this.active = next
    for (const cb of [...this.listeners]) cb(next)
  }
}

/** A provider's error is a paragraph; a notice is one line. */
function firstSentence(error: string): string {
  const first = (error ?? '').split('\n')[0]?.trim() ?? ''
  return first.length > 140 ? `${first.slice(0, 137)}…` : first
}

export const voiceSpeaker = new VoiceSpeaker()

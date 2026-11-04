import { OPENAI_TTS_MODEL } from '@shared/tts'
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
  /** On the backend's clock (`TtsBackend.now`, seconds): when the sound starts. Absent = unknown. */
  startsAt?: number
  /** When the sound ends, on the same clock — known for a clip, and for a stream once it has ended. */
  endsAt?: number
}

/** A sound fed piece by piece (streamed speech): `push` in order, then `end`. */
export interface StreamPlaying extends Playing {
  push(pcm: Int16Array): void
  /** No more pieces: `endsAt` is known from here, and `done` resolves when the last one has played. */
  end(): void
}

export interface TtsBackend {
  speak(req: VoiceSpeakRequest): Promise<VoiceSpeakResult>
  cancelSpeak(requestId: string): Promise<boolean>
  /**
   * Play raw PCM. Returns as soon as playback has *started* — or, with
   * `startAt` (on the `now` clock, seconds), as soon as it is scheduled to
   * start then: how a Claude voice's next clip joins the one playing with no
   * gap (`seamless`).
   */
  play(pcm: Int16Array, sampleRate: number, channels: number, startAt?: number): Playing
  /** The audio clock, seconds. Absent: clips are not scheduled ahead, each waits for the last to end. */
  now?(): number
  /**
   * `speak` with the audio handed to `onChunk` as it arrives (OpenAI only).
   * Absent on a stale preload, which has no chunk channel: the whole clip is
   * played instead.
   */
  speakStream?(req: VoiceSpeakRequest, onChunk: (pcm: Int16Array) => void): Promise<VoiceSpeakResult>
  /** A player fed piece by piece, for `speakStream`. */
  playStream?(sampleRate: number, channels: number, startAt?: number): StreamPlaying
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

function audioBuffer(ctx: AudioContext, pcm: Int16Array, sampleRate: number, channels: number): AudioBuffer {
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
  return buffer
}

function webAudioPlay(pcm: Int16Array, sampleRate: number, channels: number, startAt?: number): Playing {
  const ctx = context()
  const buffer = audioBuffer(ctx, pcm, sampleRate, channels)
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
  // On the clock when asked (the clip before it ends then), else now.
  const startsAt = startAt !== undefined && startAt > ctx.currentTime ? startAt : ctx.currentTime
  source.start(startsAt > ctx.currentTime ? startsAt : 0)
  return {
    done,
    startsAt,
    endsAt: startsAt + buffer.duration,
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
 * Streamed speech: each piece is its own AudioBufferSource, started on the
 * clock exactly where the last one ends, all through one gain stage so
 * ducking rides the whole sentence. A piece that arrives late (the network
 * slower than speech) starts at once: a short gap, never an overlap.
 */
function webAudioStream(sampleRate: number, channels: number, startAt?: number): StreamPlaying {
  const ctx = context()
  const gain = ctx.createGain()
  gain.gain.value = 1
  gain.connect(ctx.destination)
  const sources = new Set<AudioBufferSourceNode>()
  let cursor = startAt !== undefined && startAt > ctx.currentTime ? startAt : ctx.currentTime
  let ended = false
  let settled = false
  let resolve: () => void = () => {}
  const done = new Promise<void>((r) => {
    resolve = r
  })
  const finish = (): void => {
    if (settled) return
    settled = true
    try {
      gain.disconnect()
    } catch {
      /* already gone */
    }
    resolve()
  }
  const playing: StreamPlaying = {
    done,
    startsAt: cursor,
    push: (pcm: Int16Array) => {
      if (settled || ended || pcm.length < channels) return
      const buffer = audioBuffer(ctx, pcm, sampleRate, channels)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      const at = Math.max(cursor, ctx.currentTime)
      source.start(at)
      cursor = at + buffer.duration
      sources.add(source)
      source.onended = () => {
        sources.delete(source)
        try {
          source.disconnect()
        } catch {
          /* already gone */
        }
        if (ended && !sources.size) finish()
      }
    },
    end: () => {
      if (ended) return
      ended = true
      playing.endsAt = cursor
      if (!sources.size) finish()
    },
    stop: () => {
      ended = true
      for (const source of sources) {
        try {
          source.stop()
        } catch {
          /* never started, or already stopped */
        }
      }
      sources.clear()
      finish()
    },
    duck: (level: number) => {
      if (settled) return
      try {
        gain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)), ctx.currentTime, 0.015)
      } catch {
        /* context went away mid-utterance */
      }
    }
  }
  return playing
}

/** `voice:speak` with its streamed pieces (`IPC.voiceSpeakChunk`) handed to `onChunk` as they arrive. */
async function ipcSpeakStream(req: VoiceSpeakRequest, onChunk: (pcm: Int16Array) => void): Promise<VoiceSpeakResult> {
  const id = req.requestId ?? ''
  // The pieces and the answer share one IPC pipe, in order: every piece lands before the answer.
  const off = window.forge.voice.onSpeakChunk?.((chunk) => {
    if (chunk?.requestId === id && typeof chunk.pcm === 'string') onChunk(base64ToPcm(chunk.pcm))
  })
  try {
    return await window.forge.voice.speak({ ...req, stream: true })
  } finally {
    off?.()
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
    now: () => context().currentTime,
    // A preload from before the chunk channel (Forge not restarted yet) has
    // no `onSpeakChunk`: no streaming, the whole clip plays instead.
    ...(typeof window.forge.voice.onSpeakChunk === 'function' ? { speakStream: ipcSpeakStream, playStream: webAudioStream } : {}),
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
 * A clause end — a comma, semicolon or colon, or a spaced dash — followed by
 * whitespace that is already there, for the same reason as `SENTENCE_END`.
 */
const CLAUSE_END = /(?:[,;:]|\s[—–-])(?=\s)/g

/** A first chunk cut at a clause has at least this many words, so it sounds like a phrase, not a stammer. */
export const FIRST_CLAUSE_MIN_WORDS = 4

/**
 * The cloud voices (OpenAI, Forge Brain's Edge voice): a first sentence that
 * runs past this many words with no end yet is let out at a clause…
 */
export const FLUENT_FIRST_MAX_WORDS = 14
/** …but only at a clause after at least this many words: a phrase, never a four-word stammer. */
export const FLUENT_FIRST_CLAUSE_WORDS = 8

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /\w/.test(w)).length
}

/** Where the first clause of ≥ `minWords` words ends, before `limit` (-1 = anywhere). -1 when there is none. */
function clauseCut(text: string, limit: number, minWords: number = FIRST_CLAUSE_MIN_WORDS): number {
  CLAUSE_END.lastIndex = 0
  for (let m = CLAUSE_END.exec(text); m; m = CLAUSE_END.exec(text)) {
    const end = m.index + m[0].length
    if (limit >= 0 && end >= limit) return -1
    if (wordCount(text.slice(0, end)) >= minWords) return end
  }
  return -1
}

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
 *
 * `firstClause` (Claude Voice, the first chunk of a reply only): the first
 * chunk may end at a clause — "Sure, I'll check the Forge project," — once it
 * has `FIRST_CLAUSE_MIN_WORDS` words, so Kokoro starts on it before the full
 * stop is written. Every later chunk is still a sentence.
 *
 * `fluent` (Claude Voice and Claude Live in a cloud voice — OpenAI or Forge
 * Brain's Edge voice, `speaksFluently`): every chunk is a falling end and a
 * pause, so there are fewer and longer ones. `'first'` (the reply's first
 * chunk is in this buffer): it is the whole first sentence — only one that
 * runs past `FLUENT_FIRST_MAX_WORDS` with no end yet is cut, at a clause after
 * `FLUENT_FIRST_CLAUSE_WORDS` words. After it, and for all of `'rest'`, the
 * whole sentences at hand are merged up to `max`.
 */
export function takeSpeechChunks(
  buffer: string,
  max: number = SPEAK_CHUNK_MAX,
  opts: { firstClause?: boolean; fluent?: 'first' | 'rest' } = {}
): {
  chunks: string[]
  rest: string
} {
  const chunks: string[] = []
  let rest = buffer

  for (;;) {
    const hit = SENTENCE_END.exec(rest)
    let cut = hit ? hit.index + hit[0].length : -1
    if (opts.firstClause && chunks.length === 0) {
      const clause = clauseCut(rest, cut)
      if (clause > 0 && clause <= max) cut = clause
    }
    if (opts.fluent === 'first' && chunks.length === 0 && cut < 0 && wordCount(rest) > FLUENT_FIRST_MAX_WORDS) {
      const clause = clauseCut(rest, -1, FLUENT_FIRST_CLAUSE_WORDS)
      if (clause > 0 && clause <= max) cut = clause
    }
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

  if (!opts.fluent) return { chunks, rest }
  // The reply's first chunk stays on its own, so its voice starts soonest; the rest merge.
  const keep = opts.fluent === 'first' ? 1 : 0
  const merged = chunks.slice(0, keep)
  for (const chunk of chunks.slice(keep)) {
    const last = merged.length > keep ? merged[merged.length - 1]! : null
    if (last !== null && last.length + 1 + chunk.length <= max) merged[merged.length - 1] = `${last} ${chunk}`
    else merged.push(chunk)
  }
  return { chunks: merged, rest }
}

/**
 * Cut a clip's silence at both ends down to `keepMs` (Claude voices,
 * `seamless`): the pause between two sentences is then the voice's own, not
 * the engine's lead-in plus its tail. Anything quieter than `SILENCE_LEVEL`
 * counts as silence; a clip with nothing louder is left as it is.
 */
export const SILENCE_LEVEL = 160
export const CLIP_EDGE_MS = 40

export function trimSilence(pcm: Int16Array, sampleRate: number, channels: number, keepMs: number = CLIP_EDGE_MS): Int16Array {
  const frames = Math.floor(pcm.length / Math.max(1, channels))
  const loud = (frame: number): boolean => {
    for (let c = 0; c < channels; c++) if (Math.abs(pcm[frame * channels + c]!) > SILENCE_LEVEL) return true
    return false
  }
  let first = 0
  while (first < frames && !loud(first)) first++
  if (first >= frames) return pcm
  let last = frames - 1
  while (last > first && !loud(last)) last--
  const keep = Math.round((keepMs / 1000) * sampleRate)
  const from = Math.max(0, first - keep)
  const to = Math.min(frames, last + 1 + keep)
  if (from === 0 && to === frames) return pcm
  return pcm.slice(from * channels, to * channels)
}

/**
 * `trimSilence` for a clip that arrives in pieces (streamed speech): drops
 * the lead-in until the voice starts (keeping `keepMs` before it), and holds
 * the newest `holdMs` back so the tail's silence can be cut at the end.
 * `feed` returns what can be played now; `finish` the rest, trimmed.
 */
export class StreamTrimmer {
  private readonly channels: number
  private readonly keep: number
  private readonly hold: number
  private started = false
  /** Samples not handed out yet: the lead-in so far, or the held tail. */
  private pending: Int16Array = new Int16Array(0)

  constructor(sampleRate: number, channels: number, keepMs: number = CLIP_EDGE_MS, holdMs = 300) {
    this.channels = Math.max(1, channels)
    this.keep = Math.round((keepMs / 1000) * sampleRate) * this.channels
    this.hold = Math.round((holdMs / 1000) * sampleRate) * this.channels
  }

  feed(pcm: Int16Array): Int16Array {
    const all = new Int16Array(this.pending.length + pcm.length)
    all.set(this.pending, 0)
    all.set(pcm, this.pending.length)
    let from = 0
    if (!this.started) {
      let at = 0
      while (at < all.length && Math.abs(all[at]!) <= SILENCE_LEVEL) at++
      if (at >= all.length) {
        // Still silence: keep only the last `keep` of it, the pad before the voice.
        this.pending = all.slice(Math.max(0, all.length - this.keep))
        return new Int16Array(0)
      }
      this.started = true
      from = Math.max(0, at - (at % this.channels) - this.keep)
    }
    const cut = Math.max(from, all.length - this.hold)
    const out = all.slice(from, cut - ((cut - from) % this.channels))
    this.pending = all.slice(from + out.length)
    return out
  }

  finish(): Int16Array {
    const rest = this.pending
    this.pending = new Int16Array(0)
    if (!this.started) return new Int16Array(0)
    let last = rest.length - 1
    while (last >= 0 && Math.abs(rest[last]!) <= SILENCE_LEVEL) last--
    const end = Math.min(rest.length, last + 1 + this.keep)
    return rest.slice(0, end - (end % this.channels))
  }
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
  /**
   * Edge voices only, in order, instead of the engine chain: the first is
   * tried twice (one retry), then each of the rest once. Forge Brain's voice.
   */
  edgeVoices?: readonly string[]
  /** Never the local (SAPI) voice: when every neural try fails, say nothing (`engine: 'none'`). */
  neuralOnly?: boolean
  /**
   * Claude Voice: a Kokoro voice id (`bf_emma`), asked first. Main answers
   * with Edge by itself while Kokoro loads or when it cannot run
   * (electron/voice-bridge.ts), so this is a voice in front of the chain, not
   * a replacement for it.
   */
  kokoroVoice?: string
  /**
   * Claude Voice / Claude Live: an OpenAI voice (`cedar`, `marin`), asked
   * first, with `edgeVoices` (Forge Brain's voice) behind it. Main answers a
   * failure when OpenAI cannot (no key, a refused key, the network), and the
   * chain moves on to Ryan. Set only when there is an OpenAI key.
   */
  openaiVoice?: string
  /**
   * Claude Voice / Claude Live: each clip's silence is cut to ~40 ms at both
   * ends (`trimSilence`), and with `speak`'s `follow` the next clip starts on
   * the audio clock where this one ends — no `onended` gap between sentences.
   */
  seamless?: boolean
}

/** `speak`'s options for a queue of sentences (Claude Voice's and Claude Live's mouths). */
export interface SayOptions {
  /**
   * Part of a run of sentences: what is playing is not stopped — this clip is
   * scheduled to start where it ends — and `speak` resolves just before this
   * clip's own end (`HANDOFF_S`), so the caller's next sentence can be
   * scheduled behind it in turn. `cancel` still stops all of them at once.
   * Without a clock on the backend it simply waits for the last one.
   */
  follow?: boolean
  /** Called when this clip's first sample actually plays (later than `speak` was called, when it was scheduled). */
  onStart?: () => void
  /** An ack line: main may keep it on disk (OpenAI), so a restart does not pay for it again. */
  keep?: boolean
}

export interface SpokenResult {
  /** Did any sound come out. */
  spoke: boolean
  engine: VoiceEngine | 'kokoro' | 'openai' | 'none'
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

/**
 * Each neural request `speak` makes, in order: `edgeVoices` when a config has
 * them (the first voice twice — one retry — then the others), otherwise the
 * engine chain, each engine in its configured voice.
 */
export function neuralTries(config: VoiceConfig): Array<{ engine: NeuralEngine; voice: string }> {
  const openai = config.openaiVoice?.trim() ? [{ engine: 'openai' as const, voice: config.openaiVoice.trim() }] : []
  const kokoro = config.kokoroVoice?.trim() ? [{ engine: 'kokoro' as const, voice: config.kokoroVoice.trim() }] : []
  const first = [...openai, ...kokoro]
  const voices = (config.edgeVoices ?? []).filter((v) => v.trim())
  if (voices.length) return [...first, ...[voices[0]!, ...voices].map((voice) => ({ engine: 'edge' as const, voice }))]
  return [...first, ...neuralChain(config).map((engine) => ({ engine, voice: engine === 'edge' ? config.edgeVoice : config.geminiVoice }))]
}

type NeuralEngine = 'edge' | 'gemini' | 'kokoro' | 'openai'

/** The clip cache key for one neural try. */
function tryCacheKey(body: string, engine: NeuralEngine, voice: string, config: VoiceConfig): string {
  if (engine === 'openai') return ttsCacheKey(body, voice, OPENAI_TTS_MODEL)
  if (engine === 'kokoro') return ttsCacheKey(body, voice, 'kokoro')
  return engine === 'edge' ? ttsCacheKey(body, voice || 'default', 'edge-neural') : ttsCacheKey(body, config.geminiVoice, config.ttsModel)
}

/**
 * The voice a Claude voice config leads with, for `prefetch` and the acks:
 * OpenAI when `openaiVoice` is set, Kokoro when `kokoroVoice` is, otherwise
 * the first of `edgeVoices` (Forge Brain's voice). Null when the config has
 * none of them — not a Claude voice.
 */
export function leadVoice(config: VoiceConfig): { engine: 'openai' | 'kokoro' | 'edge'; voice: string } | null {
  const openai = config.openaiVoice?.trim()
  if (openai) return { engine: 'openai', voice: openai }
  const kokoro = config.kokoroVoice?.trim()
  if (kokoro) return { engine: 'kokoro', voice: kokoro }
  const edge = (config.edgeVoices ?? []).map((v) => v.trim()).find(Boolean)
  return edge ? { engine: 'edge', voice: edge } : null
}

/**
 * The engine that really made a clip, from its model id — not the one asked:
 * main answers a Kokoro request with Edge (`edge-neural`) while Kokoro loads.
 */
export function clipEngine(model: string, asked: NeuralEngine): NeuralEngine {
  if (model === 'edge-neural') return 'edge'
  if (/^kokoro/i.test(model)) return 'kokoro'
  if (model === OPENAI_TTS_MODEL) return 'openai'
  return asked
}

/**
 * Does this config speak in a cloud voice (OpenAI, or Forge Brain's Edge
 * voice) as a Claude voice — so its replies are cut by whole sentences
 * (`takeSpeechChunks` `fluent`)? Kokoro keeps its four-word first clause.
 */
export function speaksFluently(config: VoiceConfig): boolean {
  return !!config.seamless && !config.kokoroVoice?.trim() && leadVoice(config) !== null
}

/**
 * What `prefetch` asks for, in order: the lead voice, and behind an OpenAI
 * lead the first Edge voice too, so a sentence OpenAI could not make is
 * already being made in Ryan rather than asked for when its turn comes.
 */
function aheadTries(config: VoiceConfig): Array<{ engine: 'openai' | 'kokoro' | 'edge'; voice: string }> {
  const lead = leadVoice(config)
  if (!lead) return []
  const edge = (config.edgeVoices ?? []).map((v) => v.trim()).find(Boolean)
  return lead.engine === 'openai' && edge ? [lead, { engine: 'edge', voice: edge }] : [lead]
}

/**
 * Is this answer really from the engine asked? A main process from before
 * the OpenAI engine (Forge not restarted) answers an `openai` ask with
 * Gemini's default voice — that is a wrong voice, so it counts as a failure
 * and the chain moves on to Forge Brain's.
 */
function answeredBy(engine: NeuralEngine, result: VoiceSpeakResult): boolean {
  return engine !== 'openai' || !result.ok || result.model === OPENAI_TTS_MODEL
}

/** Sentences Claude Voice may have in synthesis ahead of the one playing. */
const PREFETCH_MAX = 4

/**
 * A `follow` clip's `speak` resolves this long before the clip ends, so the
 * next sentence — usually already made (`prefetch`) — is scheduled on the
 * clock behind it before it runs out.
 */
export const HANDOFF_S = 0.25

/** OpenAI's PCM: 24 kHz mono (electron/openai-tts.ts). */
const OPENAI_PCM_RATE = 24_000

/** What an `openai` answer from a main process that predates the engine counts as (`answeredBy`). */
const STALE_MAIN = { kind: 'stale-main', error: 'The desktop needs a Forge restart for the OpenAI voice' }

/**
 * Claude Voice's instant acknowledgements: made in Kokoro once it is warm
 * (`primeAcks`) and held, so one can play the moment a turn is slow to start.
 * Words, never a tone — Steve had the per-turn earcon removed.
 */
export const ACK_LINES: readonly string[] = ['Okay.', 'Sure.', 'One sec.', 'Let me check.']

/**
 * The acknowledgement to play after `previous`: the next of `ACK_LINES`, in
 * order, that is `ready` — never `previous` again, so null when it is the only
 * one ready (or none is).
 */
export function nextAck(ready: readonly string[], previous?: string): string | null {
  const at = previous ? ACK_LINES.indexOf(previous) : -1
  for (let i = 1; i <= ACK_LINES.length; i++) {
    const line = ACK_LINES[(at + i + ACK_LINES.length) % ACK_LINES.length]!
    if (line !== previous && ready.includes(line)) return line
  }
  return null
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

  /**
   * Every sound out or scheduled: one, normally; with `follow`, the clip
   * playing and the one scheduled to start where it ends. `cancel` and
   * `duck` reach all of them.
   */
  private readonly playing = new Set<Playing>()
  /** The last clip of a run, and its words: the next `follow` clip starts where it ends. */
  private tail: { handle: Playing; text: string } | null = null
  /** The main-process request ids in flight. */
  private readonly inFlight = new Set<string>()
  /**
   * Bumped by every `speak` and by `cancel()`, so a reply that lands after a
   * newer one — or after barge-in — is discarded.
   */
  private generation = 0
  /**
   * Bumped by `cancel()` only. A prefetched clip is kept against this, never
   * `generation`: `speak` reaching its sentence must not throw away the clip
   * being made for it (it did, and every prefetched sentence was made twice,
   * with a gap the length of the second synthesis).
   */
  private epoch = 0
  private active = false
  /** So the fallback notice is shown once per session, not once per sentence. */
  private warned = false
  /**
   * Claude Voice's sentences already asked for, ahead of the mouth
   * (`prefetch`): the request id, and the clip-to-be by cache key. `speak`
   * waits on one of these instead of asking again.
   */
  private readonly ahead = new Map<string, { requestId: string; done: Promise<void> }>()
  /**
   * Prefetches that failed with another voice behind them (OpenAI, with Ryan
   * already being asked), by cache key: `speak` skips that try instead of
   * asking it a second time.
   */
  private readonly missed = new Map<string, { kind: string; error: string }>()
  /**
   * Claude Voice's acknowledgement clips (`ACK_LINES`), by cache key. Kept out
   * of the LRU so a long reply cannot push them out; `speak` plays from here.
   */
  private readonly acks = new Map<string, CachedClip>()
  /** The `primeAcks` run in flight, so two callers share one. */
  private priming: Promise<boolean> | null = null
  /** `quiet` callers, told when the last sound ends. */
  private quietWaiters: Array<() => void> = []

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

  /** Resolves once nothing is playing or scheduled: the true end of a `follow` run. */
  quiet(): Promise<void> {
    if (!this.playing.size) return Promise.resolve()
    return new Promise((resolve) => this.quietWaiters.push(resolve))
  }

  /**
   * Say something once, keyed by turn id.
   *
   * Returns without a sound if that key has already been spoken — belt over the
   * braces of calling this from one place per turn, because a component
   * re-renders for any number of reasons and anything that speaks from a render
   * path can speak twice.
   */
  async speakOnce(
    key: string,
    text: string,
    config: VoiceConfig,
    onNotice?: (msg: string) => void,
    opts: SayOptions = {}
  ): Promise<SpokenResult> {
    if (this.spoken.has(key)) return { spoke: false, engine: 'none', cached: false, latencyMs: 0 }
    this.spoken.add(key)
    if (this.spoken.size > 400) {
      const oldest = this.spoken.values().next().value
      if (oldest !== undefined) this.spoken.delete(oldest)
    }
    return this.speak(text, config, onNotice, opts)
  }

  /**
   * Say something. The settings page's sample button uses this directly; every
   * conversational turn goes through `speakOnce`.
   */
  async speak(text: string, config: VoiceConfig, onNotice?: (msg: string) => void, opts: SayOptions = {}): Promise<SpokenResult> {
    const body = stripFiller(speakable(text))
    if (!body) return { spoke: false, engine: 'none', cached: false, latencyMs: 0 }

    // Whatever was talking stops first: the queue is never a queue — except
    // the next sentence of a run (`follow`), which goes on behind it.
    if (!opts.follow) this.stopSound()
    const generation = ++this.generation
    const started = Date.now()

    // Neural first — and on failure, the OTHER neural engine, so a quota or a
    // refused key changes which datacentre is talking, not whether the reply
    // sounds human. See neuralChain for why that ordering is the whole fix.
    let lastFailureKind: string | null = null
    let lastFailureError = ''
    for (const { engine, voice } of neuralTries(config)) {
      const key = tryCacheKey(body, engine, voice, config)
      // Asked for ahead of time (Claude Voice): wait for that answer rather than asking twice.
      const pending = this.ahead.get(key)
      if (pending) {
        await pending.done
        if (generation !== this.generation) {
          return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
        }
      }
      // Asked ahead and refused: the next voice is already on it.
      const miss = this.missed.get(key)
      if (miss) {
        this.missed.delete(key)
        lastFailureKind = miss.kind
        lastFailureError = miss.error
        continue
      }
      const hit = this.cache.get(key) ?? this.acks.get(key)
      if (hit) {
        const played = await this.playClip(hit, body, generation, opts)
        // The engine that made the clip: a Kokoro ask may hold an Edge clip.
        return { spoke: played, engine: clipEngine(hit.model, engine), cached: true, latencyMs: Date.now() - started }
      }

      const requestId = `say_${++requestSeq}`
      const backend = io()
      // OpenAI streams: the first piece plays while the rest is still being made.
      if (engine === 'openai' && backend.speakStream && backend.playStream) {
        const streamed = await this.speakStreamed(body, key, voice, config, generation, opts, requestId, started)
        if ('spoke' in streamed) return streamed
        lastFailureKind = streamed.kind
        lastFailureError = streamed.error
        continue
      }

      this.inFlight.add(requestId)
      let result: VoiceSpeakResult
      try {
        result = await backend.speak({
          text: body,
          engine,
          voice,
          model: engine === 'gemini' ? config.ttsModel : '',
          requestId
        })
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'network' }
      } finally {
        this.inFlight.delete(requestId)
      }

      // Barge-in while the request was out: he is talking, so nothing is said.
      if (generation !== this.generation) {
        return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
      }

      if (!answeredBy(engine, result)) {
        lastFailureKind = STALE_MAIN.kind
        lastFailureError = STALE_MAIN.error
        continue
      }

      if (result.ok) {
        let clip: CachedClip
        try {
          clip = await this.clipOf(result, config)
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
        this.cache.set(key, clip)
        const played = await this.playClip(clip, body, generation, opts)
        return { spoke: played, engine: clipEngine(clip.model, engine), cached: false, latencyMs: Date.now() - started }
      }

      // A cancellation is not a failure and must not drag him onto SAPI.
      if (result.kind === 'cancelled') {
        return { spoke: false, engine, cached: false, latencyMs: Date.now() - started }
      }

      lastFailureKind = result.kind
      lastFailureError = result.error
    }

    // Neural only (Forge Brain): silence, never the robot. The caller says so in words.
    if (config.neuralOnly) {
      return { spoke: false, engine: 'none', cached: false, latencyMs: Date.now() - started, fellBackBecause: lastFailureKind ?? 'no-voice' }
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
   * Three things, and all three are needed: stop every sound playing or
   * scheduled, abort the requests that have not come back yet, and bump the
   * generation so a reply already in the air is thrown away rather than
   * played a beat later.
   */
  cancel(): void {
    this.generation++
    this.epoch++
    this.stopSound()
    for (const id of this.inFlight) void io().cancelSpeak(id)
    this.inFlight.clear()
    // The sentences fetched ahead were for the reply he just talked over.
    for (const { requestId } of this.ahead.values()) void io().cancelSpeak(requestId)
    this.ahead.clear()
    this.missed.clear()
    speaker.cancel()
  }

  /**
   * Claude Voice: start making a sentence's audio now, while the one before it
   * plays, so the gap between sentences is not a whole synthesis long. Only
   * for a Claude voice config, in its lead voice (`leadVoice`: OpenAI, Kokoro,
   * or Forge Brain's Edge voice — and behind OpenAI, Ryan if OpenAI cannot);
   * the clip lands in the cache under the key `speak` looks for, and `speak`
   * waits on it if it is still coming. Only `cancel` throws it away. Main's
   * Kokoro queue is serial, so sentences are made in the order they were pushed.
   */
  prefetch(text: string, config: VoiceConfig): void {
    const tries = aheadTries(config)
    if (!tries.length) return
    const body = stripFiller(speakable(text))
    if (!body) return
    const epoch = this.epoch
    const ask = (i: number): void => {
      const { engine, voice } = tries[i]!
      const key = tryCacheKey(body, engine, voice, config)
      if (this.cache.get(key) || this.acks.has(key) || this.ahead.has(key)) return
      // The fallback for a sentence already counted is not a new one.
      if (i === 0 && this.ahead.size >= PREFETCH_MAX) return
      const requestId = `say_${++requestSeq}`
      const done = (async (): Promise<void> => {
        try {
          const result = await io().speak({ text: body, engine, voice, requestId })
          if (epoch !== this.epoch) return
          if (!result.ok || !answeredBy(engine, result)) {
            if (!result.ok && result.kind === 'cancelled') return
            // The lead could not: the next voice starts on it now, and
            // `speak` skips this try rather than asking it again.
            if (i + 1 < tries.length) {
              this.miss(key, result.ok ? STALE_MAIN : { kind: result.kind, error: result.error })
              ask(i + 1)
            }
            return
          }
          const clip = await this.clipOf(result, config)
          if (epoch === this.epoch) this.cache.set(key, clip)
        } catch {
          // `speak` asks again for itself.
        } finally {
          if (this.ahead.get(key)?.requestId === requestId) this.ahead.delete(key)
        }
      })()
      this.ahead.set(key, { requestId, done })
    }
    ask(0)
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
    for (const handle of this.playing) handle.duck(level)
  }

  /**
   * Claude Voice: make each `ACK_LINES` clip in the config's lead voice
   * (`leadVoice`), one at a time, and keep it. With a Kokoro lead it stops at
   * the first answer that is not Kokoro's — Edge (MP3) speaking while Kokoro
   * loads — because an acknowledgement in another voice is worse than none; a
   * later call carries on. With an Edge lead (Forge Brain's voice) the MP3 is
   * the voice itself, decoded once here. With an OpenAI lead main keeps each
   * clip on disk (`keep`), so a restart does not pay for them again. Resolves
   * true once every line is held. Main's Kokoro queue is serial, so call it
   * while nothing is being said.
   */
  primeAcks(config: VoiceConfig): Promise<boolean> {
    const lead = leadVoice(config)
    if (!lead) return Promise.resolve(false)
    const { engine, voice } = lead
    if (this.priming) return this.priming
    const run = (async (): Promise<boolean> => {
      try {
        for (const line of ACK_LINES) {
          const body = stripFiller(speakable(line))
          const key = tryCacheKey(body, engine, voice, config)
          if (!body || this.acks.has(key)) continue
          const result = await io().speak({
            text: body,
            engine,
            voice,
            requestId: `ack_${++requestSeq}`,
            ...(engine === 'openai' ? { keep: true } : {})
          })
          if (!result.ok || !answeredBy(engine, result)) return false
          if (result.format === 'mp3' && engine === 'kokoro') return false
          this.acks.set(key, await this.clipOf(result, config))
        }
        return true
      } catch {
        return false
      }
    })()
    this.priming = run
    void run.finally(() => {
      if (this.priming === run) this.priming = null
    })
    return run
  }

  /** The `ACK_LINES` whose clip is held in `config`'s lead voice — the ones that would play at once. */
  readyAcks(config: VoiceConfig): string[] {
    const lead = leadVoice(config)
    if (!lead) return []
    return ACK_LINES.filter((line) => this.acks.has(tryCacheKey(stripFiller(speakable(line)), lead.engine, lead.voice, config)))
  }

  /** Forget every cached clip — for a voice or model change in Settings. */
  clearCache(): void {
    this.cache.clear()
    this.acks.clear()
    this.missed.clear()
  }

  /** A clip from a good answer: MP3 decoded, PCM as it is, and for a Claude voice (`seamless`) its silence trimmed. */
  private async clipOf(result: Extract<VoiceSpeakResult, { ok: true }>, config: VoiceConfig): Promise<CachedClip> {
    const clip: CachedClip =
      result.format === 'mp3'
        ? { ...(await io().decode(base64ToBytes(result.audio).buffer)), voice: result.voice, model: result.model }
        : {
            pcm: base64ToPcm(result.audio),
            sampleRate: result.sampleRate,
            channels: result.channels,
            voice: result.voice,
            model: result.model
          }
    return config.seamless ? { ...clip, pcm: trimSilence(clip.pcm, clip.sampleRate, clip.channels) } : clip
  }

  private miss(key: string, why: { kind: string; error: string }): void {
    this.missed.set(key, why)
    while (this.missed.size > PREFETCH_MAX * 4) {
      const oldest = this.missed.keys().next().value
      if (oldest === undefined) break
      this.missed.delete(oldest)
    }
  }

  /**
   * One OpenAI sentence, played as it arrives: the first piece starts the
   * sound (behind the clip before it, for `follow`), the rest are appended on
   * the clock, and the whole clip lands in the cache when the answer does.
   * A failure stops whatever of it played and hands the sentence on to the
   * next voice, whole.
   */
  private async speakStreamed(
    body: string,
    key: string,
    voice: string,
    config: VoiceConfig,
    generation: number,
    opts: SayOptions,
    requestId: string,
    started: number
  ): Promise<SpokenResult | { kind: string; error: string }> {
    const backend = io()
    const trimmer = config.seamless ? new StreamTrimmer(OPENAI_PCM_RATE, 1) : null
    // A holder, not a `let`: the player is made inside the chunk callback.
    const out: { player: StreamPlaying | null } = { player: null }
    const onChunk = (pcm: Int16Array): void => {
      if (generation !== this.generation) return
      const ready = trimmer ? trimmer.feed(pcm) : pcm
      if (!ready.length) return
      if (!out.player) {
        const { startAt, joinText } = this.followFrom(opts)
        const player = backend.playStream!(OPENAI_PCM_RATE, 1, startAt)
        this.adopt(player, joinText ? `${joinText} ${body}` : body, body, opts)
        out.player = player
      }
      out.player.push(ready)
    }
    this.inFlight.add(requestId)
    let result: VoiceSpeakResult
    try {
      result = await backend.speakStream!({ text: body, engine: 'openai', voice, requestId, ...(opts.keep ? { keep: true } : {}) }, onChunk)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'network' }
    } finally {
      this.inFlight.delete(requestId)
    }
    const player = out.player
    if (generation !== this.generation) {
      player?.stop()
      return { spoke: false, engine: 'openai', cached: false, latencyMs: Date.now() - started }
    }
    if (!result.ok || !answeredBy('openai', result)) {
      player?.stop()
      if (!result.ok && result.kind === 'cancelled') return { spoke: false, engine: 'openai', cached: false, latencyMs: Date.now() - started }
      return result.ok ? STALE_MAIN : { kind: result.kind, error: result.error }
    }
    const clip = await this.clipOf(result, config)
    this.cache.set(key, clip)
    // No piece came (a main that does not stream): the whole clip, as before.
    if (!player) {
      const played = await this.playClip(clip, body, generation, opts)
      return { spoke: played, engine: 'openai', cached: false, latencyMs: Date.now() - started }
    }
    const tail = trimmer?.finish()
    if (tail?.length) player.push(tail)
    player.end()
    await this.until(player, opts)
    return { spoke: true, engine: 'openai', cached: false, latencyMs: Date.now() - started }
  }

  /**
   * Where a `follow` clip starts: on the clock where the run's last clip ends,
   * while that one is still playing; and that clip's words, so the echo
   * guard hears both.
   */
  private followFrom(opts: SayOptions): { startAt?: number; joinText: string } {
    const tail = opts.follow ? this.tail : null
    if (!tail || !this.playing.has(tail.handle)) return { joinText: '' }
    const end = tail.handle.endsAt
    return end !== undefined && io().now ? { startAt: end, joinText: tail.text } : { joinText: tail.text }
  }

  /**
   * A sound has started (or is scheduled): it joins `playing`, the echo
   * guard is told what is coming out of the speakers, and when the last
   * sound ends the guard's echo window starts and `speaking` goes false.
   */
  private adopt(handle: Playing, echo: string, text: string, opts: SayOptions): void {
    this.announce(true)
    speaker.rememberSpoken(echo)
    this.playing.add(handle)
    this.tail = { handle, text }
    if (opts.onStart) {
      const epoch = this.epoch
      const now = io().now?.()
      const wait = handle.startsAt !== undefined && now !== undefined ? handle.startsAt - now : 0
      const fire = (): void => {
        if (epoch === this.epoch && this.playing.has(handle)) opts.onStart?.()
      }
      if (wait > 0.005) setTimeout(fire, wait * 1000)
      else fire()
    }
    void handle.done.then(() => {
      this.playing.delete(handle)
      if (this.tail?.handle === handle) this.tail = null
      if (this.playing.size) return
      speaker.finishedSpeaking()
      this.announce(false)
      for (const wake of this.quietWaiters.splice(0)) wake()
    })
  }

  /**
   * Until `handle` ends — or, for a `follow` clip on a clock, until
   * `HANDOFF_S` before it ends, so the next sentence is scheduled behind it.
   */
  private async until(handle: Playing, opts: SayOptions): Promise<void> {
    const now = io().now?.()
    if (!opts.follow || handle.endsAt === undefined || now === undefined) return handle.done
    const wait = (handle.endsAt - HANDOFF_S - now) * 1000
    if (wait <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      handle.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait)
      })
    ])
    clearTimeout(timer)
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
  private async playClip(clip: CachedClip, text: string, generation: number, opts: SayOptions = {}): Promise<boolean> {
    if (generation !== this.generation) return false
    const backend = io()
    // No clock to schedule on: a `follow` clip waits for the one before it to end.
    const before = opts.follow ? this.tail : null
    if (before && this.playing.has(before.handle) && (before.handle.endsAt === undefined || !backend.now)) {
      await before.handle.done
      if (generation !== this.generation) return false
    }
    const { startAt, joinText } = this.followFrom(opts)
    let handle: Playing
    try {
      handle = backend.play(clip.pcm, clip.sampleRate, clip.channels, startAt)
    } catch {
      if (!this.playing.size) {
        speaker.finishedSpeaking()
        this.announce(false)
      }
      return false
    }
    this.adopt(handle, joinText ? `${joinText} ${text}` : text, text, opts)
    await this.until(handle, opts)
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
    const handles = [...this.playing]
    this.playing.clear()
    this.tail = null
    for (const handle of handles) handle.stop()
    if (this.active) this.announce(false)
    for (const wake of this.quietWaiters.splice(0)) wake()
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

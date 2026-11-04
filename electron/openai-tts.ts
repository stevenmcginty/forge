import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENAI_TTS_MODEL } from '@shared/tts'
import type { OpenAiTtsVoice } from '@shared/types'

/**
 * Claude Voice's and Claude Live's voice: OpenAI's gpt-4o-mini-tts, in Cedar
 * (a man) or Marin (a woman). Steve found Kokoro and Edge robotic, slow and
 * choppy; these two are the voices OpenAI recommends "for best quality".
 *
 * NOTE: OpenAI shuts gpt-4o-mini-tts down on 2027-01-06 — move OPENAI_TTS_MODEL on before then.
 *
 * Plain Node, like electron/edge-tts.ts and electron/gemini-tts.ts: fetch is
 * injected, so scripts/voice-check.mjs drives it with a fake and no request
 * ever leaves the machine in a check. The key is read by the caller from
 * `getSettings().openaiKey` (decrypted there), the same accessor
 * electron/realtime/ipc.ts hands to electron/realtime/tokens.ts.
 *
 * REQUEST (developers.openai.com/api/docs/guides/text-to-speech, read 2026-11-04)
 *   POST https://api.openai.com/v1/audio/speech
 *   { model: 'gpt-4o-mini-tts', voice: 'cedar', input, instructions, response_format: 'pcm' }
 *   `instructions` steers tone and pace. No `speed`: it is not documented for
 *   this model, so pace is asked for in the instructions instead.
 *
 * RESPONSE  200, chunked: raw PCM, 24 kHz, signed 16-bit little-endian, mono,
 *   no header — Kokoro's shape, so the renderer plays it the same way. The
 *   body streams, so `onChunk` gets audio before the sentence is finished.
 *
 * Failures are answers, never silence and never SAPI: no key, a refused key
 * (401, remembered per key so a bad key costs one round trip, not one per
 * sentence), the network — each comes back `ok: false`, and the renderer's
 * chain says the sentence in Forge Brain's Edge voice (Ryan).
 */

export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
export { OPENAI_TTS_MODEL }
export const OPENAI_TTS_SAMPLE_RATE = 24_000
export const DEFAULT_OPENAI_TTS_VOICE: OpenAiTtsVoice = 'cedar'
/** One sentence or a few; the API takes 4096, a spoken chunk is never near that. */
export const MAX_OPENAI_TTS_CHARS = 1500
export const DEFAULT_OPENAI_TTS_TIMEOUT_MS = 20_000

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type OpenAiTtsErrorKind = 'no-key' | 'auth' | 'quota' | 'network' | 'http' | 'no-audio' | 'bad-input' | 'cancelled'

export interface OpenAiTtsOk {
  ok: true
  /** Raw PCM16 LE mono at `sampleRate`. */
  audio: Buffer
  sampleRate: number
  voice: OpenAiTtsVoice
  model: string
  /** Request to the first audio byte. */
  firstByteMs: number
  /** Request to the last byte. */
  ms: number
  /** Served from the disk ack cache (`cacheDir`). */
  cached?: boolean
}

export interface OpenAiTtsErr {
  ok: false
  error: string
  kind: OpenAiTtsErrorKind
}

export type OpenAiTtsResult = OpenAiTtsOk | OpenAiTtsErr

export interface OpenAiTtsOptions {
  key: string
  text: string
  voice?: string
  signal?: AbortSignal
  /** Who asked (`desk`, `web`), so `cancelOpenAiTts(lane)` can stop that caller's requests. */
  lane?: string
  /** Audio as it arrives: whole samples, in order. */
  onChunk?: (pcm: Buffer) => void
  /** Keep (and reuse) the clip under this folder — for the acks, so a restart does not pay again. */
  cacheDir?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export function openAiTtsVoice(name?: string): OpenAiTtsVoice {
  return name === 'marin' ? 'marin' : name === 'cedar' ? 'cedar' : DEFAULT_OPENAI_TTS_VOICE
}

/** How it should sound: a person talking to a colleague, quick and warm, never an announcer. */
export function openAiTtsInstructions(voice: OpenAiTtsVoice): string {
  const who = voice === 'marin' ? 'woman' : 'man'
  return (
    `A relaxed, friendly ${who} talking with a colleague. Brisk, natural conversational pace. ` +
    'Warm and clear, never an announcer or narrator. Read the text exactly as written.'
  )
}

/** The request body, exactly — scripts/voice-check.mjs holds its shape. */
export function openAiTtsBody(text: string, voice: OpenAiTtsVoice): Record<string, unknown> {
  return {
    model: OPENAI_TTS_MODEL,
    voice,
    input: text,
    instructions: openAiTtsInstructions(voice),
    response_format: 'pcm'
  }
}

/** Keys OpenAI has refused (401), by fingerprint: asked again only once the key changes. */
const refusedKeys = new Set<string>()
/** In-flight requests by lane, for `cancelOpenAiTts`. */
const lanes = new Map<string, Set<AbortController>>()

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Abort every request a lane has in flight (barge-in on the phone). */
export function cancelOpenAiTts(lane: string): void {
  for (const c of lanes.get(lane) ?? []) c.abort()
  lanes.delete(lane)
}

/** Forget refused keys — for scripts/voice-check.mjs. */
export function resetOpenAiTts(): void {
  refusedKeys.clear()
  lanes.clear()
  fallbackSaid = ''
}

let fallbackSaid = ''

/** One log line per change of reason, not per sentence: why Forge Brain's voice is speaking instead. */
export function noteOpenAiFallback(reason: string): void {
  const key = reason.replace(/\d+/g, '#')
  if (key === fallbackSaid) return
  fallbackSaid = key
  console.warn(`[tts] openai unavailable, Forge Brain's voice speaks instead: ${reason}`)
}

/** OpenAI answered with audio again: the next failure is news, so it is logged. */
function noteOpenAiBack(): void {
  fallbackSaid = ''
}

function cachePath(dir: string, voice: OpenAiTtsVoice, text: string): string {
  const id = createHash('sha256').update(`${OPENAI_TTS_MODEL}\n${voice}\n${openAiTtsInstructions(voice)}\n${text}`).digest('hex').slice(0, 24)
  return join(dir, `${voice}-${id}.pcm`)
}

function readCached(dir: string | undefined, voice: OpenAiTtsVoice, text: string): Buffer | null {
  if (!dir) return null
  try {
    const file = cachePath(dir, voice, text)
    if (!existsSync(file)) return null
    const pcm = readFileSync(file)
    return pcm.length >= 2 ? pcm : null
  } catch {
    return null
  }
}

function writeCached(dir: string | undefined, voice: OpenAiTtsVoice, text: string, pcm: Buffer): void {
  if (!dir || pcm.length < 2) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath(dir, voice, text), pcm)
  } catch {
    /* a cache that cannot be written is a cache miss next time, nothing more */
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function failure(res: Response): Promise<OpenAiTtsErr> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    if (typeof body?.error?.message === 'string') detail = body.error.message
  } catch {
    /* no JSON body */
  }
  const said = detail ? `: ${detail.split('\n')[0]!.slice(0, 160)}` : ''
  if (res.status === 401) return { ok: false, kind: 'auth', error: `OpenAI refused the key (401)${said}` }
  if (res.status === 429) return { ok: false, kind: 'quota', error: `OpenAI rate limit or quota (429)${said}` }
  return { ok: false, kind: 'http', error: `OpenAI speech failed (${res.status})${said}` }
}

/**
 * Say `text` in an OpenAI voice. Resolves, never rejects. Logs one line per
 * request: `[tts] openai voice=… chars=… first-byte=…ms total=…ms`.
 */
export async function speakOpenAi(opts: OpenAiTtsOptions): Promise<OpenAiTtsResult> {
  const key = (opts.key ?? '').trim()
  const text = (opts.text ?? '').replace(/\s+/g, ' ').trim()
  const voice = openAiTtsVoice(opts.voice)
  if (!key) return { ok: false, kind: 'no-key', error: 'No OpenAI key is set — add one in Settings → Models & APIs' }
  if (!text || text.length > MAX_OPENAI_TTS_CHARS) return { ok: false, kind: 'bad-input', error: `Nothing to say, or over ${MAX_OPENAI_TTS_CHARS} characters` }
  if (opts.signal?.aborted) return { ok: false, kind: 'cancelled', error: 'Cancelled' }
  const print = fingerprint(key)
  if (refusedKeys.has(print)) return { ok: false, kind: 'auth', error: 'OpenAI refused this key (401) — paste a new one in Settings → Models & APIs' }

  const started = Date.now()
  const kept = readCached(opts.cacheDir, voice, text)
  if (kept) {
    opts.onChunk?.(kept)
    return { ok: true, audio: kept, sampleRate: OPENAI_TTS_SAMPLE_RATE, voice, model: OPENAI_TTS_MODEL, firstByteMs: 0, ms: 0, cached: true }
  }

  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_OPENAI_TTS_TIMEOUT_MS)
  const lane = opts.lane ?? ''
  if (lane) {
    const set = lanes.get(lane) ?? new Set<AbortController>()
    set.add(controller)
    lanes.set(lane, set)
  }
  const cancelled = (): boolean => !!opts.signal?.aborted || (lane !== '' && !lanes.get(lane)?.has(controller))
  try {
    const res = await (opts.fetchImpl ?? fetch)(OPENAI_TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(openAiTtsBody(text, voice)),
      signal: controller.signal
    })
    if (!res.ok) {
      const err = await failure(res)
      if (err.kind === 'auth') refusedKeys.add(print)
      return err
    }
    const parts: Buffer[] = []
    let firstByteMs = -1
    let carry: Buffer | null = null
    const take = (bytes: Uint8Array): void => {
      if (!bytes.length) return
      if (firstByteMs < 0) firstByteMs = Date.now() - started
      let buf = Buffer.from(bytes)
      parts.push(buf)
      if (!opts.onChunk) return
      // Whole samples only: a chunk boundary may split one.
      if (carry) buf = Buffer.concat([carry, buf])
      const even = buf.length & ~1
      carry = even < buf.length ? buf.subarray(even) : null
      if (even) opts.onChunk(buf.subarray(0, even))
    }
    const body = res.body as ReadableStream<Uint8Array> | null
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) take(value)
      }
    } else {
      take(new Uint8Array(await res.arrayBuffer()))
    }
    const whole = Buffer.concat(parts)
    const audio = whole.subarray(0, whole.length & ~1)
    const ms = Date.now() - started
    console.info(`[tts] openai voice=${voice} chars=${text.length} first-byte=${Math.max(0, firstByteMs)}ms total=${ms}ms`)
    if (audio.length < 2) return { ok: false, kind: 'no-audio', error: 'OpenAI answered with no audio' }
    noteOpenAiBack()
    writeCached(opts.cacheDir, voice, text, audio)
    return { ok: true, audio, sampleRate: OPENAI_TTS_SAMPLE_RATE, voice, model: OPENAI_TTS_MODEL, firstByteMs: Math.max(0, firstByteMs), ms }
  } catch (err) {
    if (cancelled()) return { ok: false, kind: 'cancelled', error: 'Cancelled' }
    if (controller.signal.aborted) return { ok: false, kind: 'network', error: 'OpenAI speech timed out' }
    return { ok: false, kind: 'network', error: `Could not reach OpenAI: ${errText(err)}` }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    if (lane) {
      const set = lanes.get(lane)
      set?.delete(controller)
      if (set && !set.size) lanes.delete(lane)
    }
  }
}

import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, FALLBACK_TTS_MODEL, isTtsVoice } from '@shared/tts'
import type { MediaErrorKind } from './gemini-media'

/**
 * Neural speech, straight at Google's REST API.
 *
 * Why this file exists: Forge's first voice was `speechSynthesis`, which on
 * Windows means SAPI, which means George — and Steve's verdict on it was
 * "honestly, the voice agent is just garbage. It sounds robotic." No amount of
 * voice-picking fixes a 1998 formant synthesiser, so the agent now speaks with
 * a real model and keeps SAPI only as the thing that talks when the network,
 * the key or the quota is not there.
 *
 * Like electron/gemini-media.ts this is plain Node — fetch and Buffer, no
 * Electron import — so the main process can call it and a head-less script can
 * drive it. It writes nothing to disk: audio bytes go back to the renderer,
 * which plays them through Web Audio.
 *
 * The model ids and the thirty voice names live in `shared/tts.ts`, because the
 * Settings page has to offer exactly what this file is willing to send.
 *
 * ─── Everything below was verified live against Steve's key on 2026-07-30,
 * not taken from documentation (the docs page renders a request shape the API
 * rejects outright — see SHAPES REFUSED).
 *
 * REQUEST
 *   POST /v1beta/models/<model>:generateContent
 *   x-goog-api-key: <key>
 *   {
 *     "contents": [{ "parts": [{ "text": "Opened three Claude Code tabs." }] }],
 *     "generationConfig": {
 *       "responseModalities": ["AUDIO"],
 *       "speechConfig": {
 *         "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Sulafat" } }
 *       }
 *     }
 *   }
 *
 * RESPONSE  200
 *   candidates[0].content.parts[0].inlineData = { mimeType, data }
 *   data is base64 raw PCM — signed 16-bit little-endian, mono, 24 kHz. There
 *   is NO WAV header, which is why the renderer builds an AudioBuffer by hand
 *   rather than calling decodeAudioData.
 *
 *   The mime type is spelled differently by each generation and both are real:
 *     gemini-3.1-flash-tts-preview  → "audio/l16; rate=24000; channels=1"
 *     gemini-2.5-*-preview-tts      → "audio/L16;codec=pcm;rate=24000"
 *   so `parsePcmMime` parses rather than compares, and defaults to 24 kHz mono.
 *
 * SHAPES REFUSED (so nobody tries them again)
 *   • `speechConfig: [{ voice: "Sulafat" }]` — the array form printed on
 *     ai.google.dev — is a 400: "Unknown name \"speechConfig\" at
 *     'generation_config': Proto field is not repeating, cannot start list."
 *   • An unknown voice name is a **404 "Requested entity was not found."**,
 *     not a 400. That is why `classify` treats 404 as `model` and the caller
 *     falls back rather than believing the model itself has gone.
 *
 * ACCEPTED AND HARMLESS: `speechConfig.languageCode` ("en-GB") and
 * `generationConfig.temperature`. Neither is sent — the voice already has an
 * accent and this is not a creative task.
 *
 * MEASURED, one to two sentences, warm start:
 *   gemini-3.1-flash-tts-preview   2.1–3.2 s
 *   gemini-2.5-flash-preview-tts   ~3.2 s
 *   gemini-2.5-pro-preview-tts     ~5.0 s
 * so 3.1 flash is the default and 2.5 flash the fallback.
 *
 * QUOTA IS THE REAL CONSTRAINT: on a free AI Studio key this model 429s after
 * roughly half a dozen requests in a minute ("You exceeded your current quota").
 * Hence two things that are not decoration — the renderer's LRU cache, and
 * `speak()` retrying a 429 on the *other* model, whose bucket is separate.
 */

const HOST = 'https://generativelanguage.googleapis.com'

/**
 * A spoken line is short. Ten seconds is a generous ceiling for one, and a
 * ceiling matters: the microphone is shut for the whole utterance.
 */
export const DEFAULT_TTS_TIMEOUT_MS = 20_000

/** Beyond this the model is being asked to read a document, not answer. */
export const MAX_TTS_CHARS = 900

/* -------------------------------------------------------------------- types */

/**
 * The image/video taxonomy, plus the two cases only speech has: the model
 * answered with no audio part, and Steve talked over it. Sharing the base means
 * the renderer classifies a TTS failure with the same code it already uses for
 * a failed image.
 */
export type TtsErrorKind = MediaErrorKind | 'no-audio' | 'cancelled'

export interface TtsOk {
  ok: true
  /** Raw PCM. Signed 16-bit little-endian, `channels` interleaved. */
  audio: Buffer
  mime: string
  sampleRate: number
  channels: number
  model: string
  voice: string
  ms: number
  /** Samples of digital silence removed from the front. Diagnostics only. */
  trimmed: number
  /** Set when the requested model could not answer and another one did. */
  note?: string
}

export interface TtsErr {
  ok: false
  /** One sentence each, so the panel can say what actually went wrong. */
  kind: TtsErrorKind
  error: string
}

export type TtsResult = TtsOk | TtsErr

export interface SpeakOptions {
  key: string
  text: string
  voice?: string
  model?: string
  timeoutMs?: number
  /** Abort the in-flight request — barge-in. */
  signal?: AbortSignal
}

/* ------------------------------------------------------------------ helpers */

function fail(kind: TtsErrorKind, error: string): TtsErr {
  return { ok: false, kind, error }
}

/** Never let a key reach a log, an error string or a stack trace. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join('«key»') : text
}

export function ttsModel(override?: string): string {
  const env = (process.env['FORGE_GEMINI_TTS_MODEL'] ?? '').trim()
  const chosen = (override ?? '').trim() || env || DEFAULT_TTS_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_TTS_MODEL
}

/**
 * A voice name we are willing to send. Unknown names are a 404 rather than a
 * useful error, so they are caught here instead of costing a round trip.
 */
export function ttsVoice(override?: string): string {
  const chosen = (override ?? '').trim()
  return isTtsVoice(chosen) ? chosen : DEFAULT_TTS_VOICE
}

/**
 * Read the sample rate and channel count out of whichever spelling of the L16
 * mime type arrived. Both observed forms parse; anything unrecognised falls
 * back to what every Gemini TTS model has actually returned — 24 kHz mono.
 */
export function parsePcmMime(mime: string): { sampleRate: number; channels: number } {
  const m = (mime ?? '').toLowerCase()
  const rate = /rate=(\d+)/.exec(m)
  const channels = /channels=(\d+)/.exec(m)
  const sampleRate = rate ? Number(rate[1]) : 24_000
  const chan = channels ? Number(channels[1]) : 1
  return {
    sampleRate: Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96_000 ? sampleRate : 24_000,
    channels: chan === 2 ? 2 : 1
  }
}

/**
 * Drop the digital silence the model puts in front of the first syllable.
 *
 * `gemini-3.1-flash-tts-preview` opens with a run of exact-zero samples. It is
 * dead air between Steve finishing his sentence and hearing an answer, and it
 * is free to remove: the samples are literally zero, so nothing is clipped.
 * Only leading silence goes — a trailing tail is part of the delivery, and
 * cutting into a word would be far worse than waiting a beat.
 *
 * Frame-aligned, so a stereo stream cannot be knocked out of phase.
 */
export function trimLeadingSilence(
  pcm: Buffer,
  channels = 1,
  /** Below this absolute sample value counts as silence. |4| of 32768 is nothing. */
  threshold = 4,
  /** Frames of run-up kept so the first consonant does not start on a cliff edge. */
  runUp = 240
): { audio: Buffer; trimmed: number } {
  const frame = 2 * channels
  const frames = Math.floor(pcm.length / frame)
  let quiet = 0
  outer: for (; quiet < frames; quiet++) {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(pcm.readInt16LE(quiet * frame + c * 2)) > threshold) break outer
    }
  }
  // Never trim a buffer that is silence all the way down: that is a bug
  // upstream, and returning nothing would look like success.
  if (quiet >= frames) return { audio: pcm, trimmed: 0 }
  const start = Math.max(0, quiet - runUp)
  if (start <= 0) return { audio: pcm, trimmed: 0 }
  return { audio: pcm.subarray(start * frame), trimmed: start }
}

/* ------------------------------------------------------------------ the call */

function classify(status: number, message: string, model: string): TtsErr {
  if (/billed users|billing|FAILED_PRECONDITION|paid tier|free tier/i.test(message)) {
    return fail('tier', `That voice model needs billing enabled on the key's Google Cloud project (${status}): ${message}`)
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return fail('quota', `Gemini is out of quota for this key (${status}): ${message}`)
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return fail('auth', `Gemini refused the key (${status}): ${message}`)
  }
  if (status === 404) {
    // Both "no such model" and "no such voice" arrive as 404, so say both.
    return fail('model', `The voice model “${model}” or that voice name is not available to this key (404): ${message}`)
  }
  if (/safety|blocked|prohibited|policy/i.test(message)) {
    return fail('safety', `Gemini refused to say that (${status}): ${message}`)
  }
  return fail('model', `Gemini rejected the speech request (${status}): ${message}`)
}

/** One round trip against one model. No retries, no fallback — that is `speak`. */
async function postSpeech(model: string, voice: string, opts: SpeakOptions): Promise<TtsResult> {
  const key = opts.key
  const timeout = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS
  const started = Date.now()

  // The caller's abort and our own timeout are one signal, so barge-in cancels
  // a slow request rather than waiting for it to time out on its own.
  const signals: AbortSignal[] = [AbortSignal.timeout(timeout)]
  if (opts.signal) signals.push(opts.signal)

  let res: Response
  try {
    res = await fetch(`${HOST}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: opts.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      }),
      signal: AbortSignal.any(signals)
    })
  } catch (err) {
    const e = err as Error
    if (opts.signal?.aborted) return fail('cancelled', 'Cancelled — he started talking again')
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return fail('network', `Gemini did not answer within ${Math.round(timeout / 1000)}s`)
    }
    return fail('network', `Could not reach Gemini: ${scrub(e.message, key)}`)
  }

  const raw = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; status?: string } } | null)?.error
    const message = scrub(err?.message ?? raw.slice(0, 400) ?? res.statusText, key)
    return classify(res.status, `${err?.status ?? ''} ${message}`.trim(), model)
  }

  const data = parsed as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }
      finishReason?: string
    }>
    promptFeedback?: { blockReason?: string }
  } | null

  if (data?.promptFeedback?.blockReason) {
    return fail('safety', `Gemini blocked the text (${data.promptFeedback.blockReason}) and said nothing.`)
  }

  const candidate = data?.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    if (!part.inlineData?.data) continue
    const mime = part.inlineData.mimeType ?? 'audio/L16;codec=pcm;rate=24000'
    const { sampleRate, channels } = parsePcmMime(mime)
    const bytes = Buffer.from(part.inlineData.data, 'base64')
    if (bytes.length < frameBytes(channels)) {
      return fail('no-audio', 'Gemini returned an empty audio part.')
    }
    const { audio, trimmed } = trimLeadingSilence(bytes, channels)
    return {
      ok: true,
      audio,
      mime,
      sampleRate,
      channels,
      model,
      voice,
      ms: Date.now() - started,
      trimmed
    }
  }

  const why = candidate?.finishReason ?? 'no reason given'
  return fail('no-audio', `Gemini returned no audio (${why}).`)
}

function frameBytes(channels: number): number {
  return 2 * channels
}

/**
 * Text → speech bytes, with one automatic retry on a *different* model.
 *
 * The retry is not belt-and-braces: on a free AI Studio key the 3.1 preview
 * runs out of per-minute quota after a handful of sentences, and its bucket is
 * not the 2.5 bucket. Falling across saves the reply instead of dropping Steve
 * back to SAPI mid-conversation. Auth, safety and cancellation are not retried —
 * the second model would fail identically, and it would cost another second.
 */
export async function speak(opts: SpeakOptions): Promise<TtsResult> {
  const key = (opts.key ?? '').trim()
  if (!key) {
    return fail('no-key', 'No Gemini API key. Set one in Forge’s voice settings (or import it) and retry.')
  }
  const text = (opts.text ?? '').trim()
  if (!text) return fail('bad-input', '`text` is required and must be a non-empty string')
  if (text.length > MAX_TTS_CHARS) {
    return fail('bad-input', `That is ${text.length} characters — a spoken line must be under ${MAX_TTS_CHARS}`)
  }
  if (opts.signal?.aborted) return fail('cancelled', 'Cancelled before it started')

  const voice = ttsVoice(opts.voice)
  const first = ttsModel(opts.model)
  const attempt = await postSpeech(first, voice, { ...opts, key, text })
  if (attempt.ok) return attempt
  if (attempt.kind !== 'quota' && attempt.kind !== 'model') return attempt

  const second = first === FALLBACK_TTS_MODEL ? DEFAULT_TTS_MODEL : FALLBACK_TTS_MODEL
  const retry = await postSpeech(second, voice, { ...opts, key, text })
  if (!retry.ok) return attempt // report the first failure — it is the one he asked for
  return { ...retry, note: `${first} was unavailable (${attempt.kind}), so ${second} said it` }
}

import { DEFAULT_TTS_VOICE, TTS_VOICES } from './tts'
import type { VoiceHubProvider } from './types'

/**
 * The realtime voice brains: live two-way talk, bring-your-own-key.
 *
 * One file for every fact both processes need — model ids, endpoints, voices,
 * the wire types of the three IPC calls — so main (which mints the tokens) and
 * the renderer (which holds the audio) cannot disagree about which model a
 * session is for. Nothing here imports Electron or the DOM.
 *
 * Model ids were checked against the providers' own pages on 2026-09-23:
 *   - https://ai.google.dev/gemini-api/docs/models lists `gemini-3.8-live`
 *     ("the default option for most low-latency voice agent experiences").
 *   - https://developers.openai.com/api/docs/pricing lists `gpt-realtime-2.1`
 *     and `gpt-realtime-2.1-mini`.
 * If one of them is retired, change it here and nowhere else.
 */

/** The one Gemini Live model id. */
export const GEMINI_LIVE_MODEL = 'gemini-3.8-live'
export const OPENAI_REALTIME_MODEL = 'gpt-realtime-2.1'
export const OPENAI_REALTIME_MINI_MODEL = 'gpt-realtime-2.1-mini'

/**
 * Ephemeral tokens only work on v1alpha, and a token (as opposed to a key)
 * connects to the `...Constrained` method with `access_token=`. Both facts are
 * from ai.google.dev/gemini-api/docs/ephemeral-tokens and the js-genai SDK's
 * own live.ts.
 */
export const GEMINI_API_HOST = 'https://generativelanguage.googleapis.com'
export const GEMINI_TOKEN_URL = `${GEMINI_API_HOST}/v1alpha/auth_tokens`
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'

export const OPENAI_API_HOST = 'https://api.openai.com'
export const OPENAI_CLIENT_SECRETS_URL = `${OPENAI_API_HOST}/v1/realtime/client_secrets`
export const OPENAI_CALLS_URL = `${OPENAI_API_HOST}/v1/realtime/calls`
/** The transcription model for his half of the conversation (captions only). */
export const OPENAI_TRANSCRIBE_MODEL = 'whisper-1'

/**
 * OpenAI force-closes a session at 60 minutes. Roll over a little before, so
 * the new session is up before the old one is cut mid-sentence.
 */
export const OPENAI_SESSION_LIMIT_MS = 60 * 60_000
export const OPENAI_ROLLOVER_AT_MS = 55 * 60_000

export type RealtimeVendor = 'gemini' | 'openai'

export interface RealtimeProviderSpec {
  id: VoiceHubProvider
  label: string
  /** null for the Claude fallback, which needs no key. */
  vendor: RealtimeVendor | null
  model: string
  /** One line for Settings. Rough, from the 2026-09 pricing pages. */
  costNote: string
}

export const REALTIME_PROVIDERS: readonly RealtimeProviderSpec[] = [
  {
    id: 'claude',
    label: 'Claude (Parakeet in, spoken replies out)',
    vendor: null,
    model: '',
    costNote: 'Free — your claude login, local Parakeet, Edge voice'
  },
  {
    id: 'gemini-live',
    label: 'Gemini Live',
    vendor: 'gemini',
    model: GEMINI_LIVE_MODEL,
    costNote: 'About $3–4 for a heavy day'
  },
  {
    id: 'gpt-realtime-mini',
    label: 'GPT Realtime mini',
    vendor: 'openai',
    model: OPENAI_REALTIME_MINI_MODEL,
    costNote: 'About $3–8 for a heavy day (silence is free)'
  },
  {
    id: 'gpt-realtime',
    label: 'GPT Realtime',
    vendor: 'openai',
    model: OPENAI_REALTIME_MODEL,
    costNote: 'About $10–20 for a heavy day (silence is free)'
  }
]

export function providerSpec(id: VoiceHubProvider): RealtimeProviderSpec {
  return REALTIME_PROVIDERS.find((p) => p.id === id) ?? REALTIME_PROVIDERS[0]
}

/** OpenAI's voices; marin and cedar are the two its guide recommends. */
export const OPENAI_VOICES: readonly string[] = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse'
]
export const DEFAULT_OPENAI_VOICE = 'marin'

/** Gemini Live speaks with the same prebuilt voices as Gemini TTS. */
export const GEMINI_VOICES: readonly string[] = TTS_VOICES.map((v) => v.name)
export const DEFAULT_GEMINI_VOICE = DEFAULT_TTS_VOICE

/** A stored voice, or the vendor's default when it is blank or not that vendor's. */
export function resolveVoice(vendor: RealtimeVendor, stored: string | undefined): string {
  const name = (stored ?? '').trim()
  if (vendor === 'openai') return OPENAI_VOICES.includes(name) ? name : DEFAULT_OPENAI_VOICE
  return GEMINI_VOICES.includes(name) ? name : DEFAULT_GEMINI_VOICE
}

/* ------------------------------------------------------------ wire types */

/** A function the realtime model may call, in plain JSON Schema. */
export interface RealtimeToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Open an OpenAI WebRTC call. The renderer makes the SDP offer; main mints an
 * ephemeral client secret with the stored key and posts the offer with it, so
 * neither the key nor the secret ever reaches page script.
 */
export interface RealtimeOpenAIConnectRequest {
  model: string
  voice: string
  instructions: string
  tools: RealtimeToolSpec[]
  sdp: string
}

export type RealtimeOpenAIConnectResult =
  | { ok: true; sdp: string; expiresAt: number | null }
  | { ok: false; error: string }

/** A Gemini ephemeral token. Only the token crosses to the renderer. */
export type RealtimeGeminiTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string }

export type RealtimeScreenshotResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; error: string }

import {
  GEMINI_TOKEN_URL,
  OPENAI_CALLS_URL,
  OPENAI_CLIENT_SECRETS_URL,
  OPENAI_TRANSCRIBE_MODEL,
  type RealtimeGeminiTokenResult,
  type RealtimeOpenAIConnectRequest,
  type RealtimeOpenAIConnectResult,
  type RealtimeToolSpec
} from '@shared/realtime'

/**
 * Short-lived credentials for the realtime voice brains, minted in main.
 *
 * The stored keys never leave this process. For OpenAI main does the whole
 * handshake — mint a client secret, post the renderer's SDP offer with it,
 * hand back the SDP answer — so page script sees neither the key nor the
 * secret. Gemini's Live API is a WebSocket the renderer opens itself (the CSP
 * allows `wss:`), so it gets an ephemeral token: single use, one minute to
 * start a session, thirty to use it.
 *
 * No Electron import, and `fetch` is injected, so scripts/realtime-check.mjs
 * can hold the request shapes to the documented ones without a network.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Every call is bounded: a hung handshake is a hub stuck on "connecting". */
const TIMEOUT_MS = 15_000

/** OpenAI's client secret lives this long; the session outlives it once open. */
const OPENAI_SECRET_TTL_S = 600

/**
 * How much of the conversation OpenAI keeps when the context fills up. Without
 * a truncation setting every turn re-sends everything said so far; with it the
 * oldest fifth is dropped in one go, which also keeps the cached prefix stable.
 */
const OPENAI_RETENTION_RATIO = 0.8

function signal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The first useful line of a provider error, never the key. */
async function failure(res: Response, what: string): Promise<string> {
  let detail = ''
  try {
    const body = await res.text()
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string }
      detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '')
    } catch {
      detail = body
    }
  } catch {
    /* no body */
  }
  const line = detail.split('\n')[0]?.trim().slice(0, 200)
  if (res.status === 401 || res.status === 403) return `${what}: the key was refused (${res.status})${line ? ` — ${line}` : ''}`
  return `${what} failed (${res.status})${line ? ` — ${line}` : ''}`
}

/* ------------------------------------------------------------------ OpenAI */

/**
 * The `session` object of a client-secret request.
 *
 * Semantic VAD with create/interrupt on: the server decides when he has
 * finished a thought, answers, and stops talking the moment he talks over it.
 * Transcription is on only so the hub can caption what he said.
 */
export function buildOpenAISession(req: Omit<RealtimeOpenAIConnectRequest, 'sdp'>): Record<string, unknown> {
  return {
    type: 'realtime',
    model: req.model,
    instructions: req.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: OPENAI_TRANSCRIBE_MODEL },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'auto',
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: req.voice }
    },
    tools: req.tools.map((t: RealtimeToolSpec) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    })),
    tool_choice: 'auto',
    truncation: { type: 'retention_ratio', retention_ratio: OPENAI_RETENTION_RATIO }
  }
}

export async function mintOpenAIClientSecret(
  key: string,
  session: Record<string, unknown>,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: true; value: string; expiresAt: number | null } | { ok: false; error: string }> {
  const apiKey = (key ?? '').trim()
  if (!apiKey) return { ok: false, error: 'No OpenAI key is set — add one in Settings → Models & APIs' }
  try {
    const res = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: OPENAI_SECRET_TTL_S }, session }),
      signal: signal()
    })
    if (!res.ok) return { ok: false, error: await failure(res, 'OpenAI client secret') }
    const body = (await res.json()) as { value?: unknown; expires_at?: unknown }
    const value = typeof body.value === 'string' ? body.value : ''
    if (!value) return { ok: false, error: 'OpenAI answered without a client secret' }
    return { ok: true, value, expiresAt: typeof body.expires_at === 'number' ? body.expires_at * 1000 : null }
  } catch (err) {
    return { ok: false, error: `Could not reach OpenAI: ${errText(err)}` }
  }
}

/** Post the renderer's SDP offer with the ephemeral secret; answer is SDP text. */
export async function exchangeOpenAISdp(
  secret: string,
  sdp: string,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: true; sdp: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(OPENAI_CALLS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
      body: sdp,
      signal: signal()
    })
    if (!res.ok) return { ok: false, error: await failure(res, 'OpenAI call') }
    const answer = await res.text()
    if (!answer.trim().startsWith('v=')) return { ok: false, error: 'OpenAI did not answer with SDP' }
    return { ok: true, sdp: answer }
  } catch (err) {
    return { ok: false, error: `Could not reach OpenAI: ${errText(err)}` }
  }
}

/** The whole OpenAI handshake, as the IPC handler runs it. */
export async function connectOpenAI(
  key: string,
  req: RealtimeOpenAIConnectRequest,
  fetchImpl: FetchLike = fetch
): Promise<RealtimeOpenAIConnectResult> {
  if (!req || typeof req.sdp !== 'string' || !req.sdp.trim()) return { ok: false, error: 'No SDP offer to send' }
  const { sdp, ...rest } = req
  const secret = await mintOpenAIClientSecret(key, buildOpenAISession(rest), fetchImpl)
  if (!secret.ok) return secret
  const answer = await exchangeOpenAISdp(secret.value, sdp, fetchImpl)
  if (!answer.ok) return answer
  return { ok: true, sdp: answer.sdp, expiresAt: secret.expiresAt }
}

/* ------------------------------------------------------------------ Gemini */

/** Thirty minutes to use it, one to open the session — Google's own defaults. */
const GEMINI_TOKEN_TTL_MS = 30 * 60_000
const GEMINI_NEW_SESSION_MS = 60_000

export function buildGeminiTokenRequest(now: number): Record<string, unknown> {
  return {
    uses: 1,
    expireTime: new Date(now + GEMINI_TOKEN_TTL_MS).toISOString(),
    newSessionExpireTime: new Date(now + GEMINI_NEW_SESSION_MS).toISOString()
  }
}

export async function mintGeminiToken(
  key: string,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now()
): Promise<RealtimeGeminiTokenResult> {
  const apiKey = (key ?? '').trim()
  if (!apiKey) return { ok: false, error: 'No Gemini key is set — add one in Settings → Models & APIs' }
  try {
    const res = await fetchImpl(GEMINI_TOKEN_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGeminiTokenRequest(now)),
      signal: signal()
    })
    if (!res.ok) return { ok: false, error: await failure(res, 'Gemini token') }
    const body = (await res.json()) as { name?: unknown }
    const token = typeof body.name === 'string' ? body.name : ''
    if (!token) return { ok: false, error: 'Gemini answered without a token' }
    return { ok: true, token, expiresAt: now + GEMINI_TOKEN_TTL_MS }
  } catch (err) {
    return { ok: false, error: `Could not reach Gemini: ${errText(err)}` }
  }
}

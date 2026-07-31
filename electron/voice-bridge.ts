import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type {
  EditImageRequest,
  GeminiCallRequest,
  GeminiCallResult,
  ImportedKeyResult,
  KeySource,
  MakeImageRequest,
  MakeVideoRequest,
  MediaCallResult,
  GroqCallRequest,
  GroqCallResult,
  OpenRouterCallRequest,
  OpenRouterCallResult,
  VoiceSpeakRequest,
  VoiceSpeakResult
} from '@shared/types'
import { editImage, makeImage, makeVideo, type MediaResult } from './gemini-media'
import { speak as speakGemini } from './gemini-tts'
import { adoptShotFiles } from './shots-watcher'
import { getDataDir, getSettings } from './store'

/**
 * The voice agent's only door to the outside world.
 *
 * Four jobs, all deliberately in the main process, because the renderer's CSP
 * allows no external hosts (and should not be widened) and because an API key is
 * better off never touching page script:
 *
 *  1. `voice:gemini` — one POST to generativelanguage.googleapis.com.
 *  2. `voice:openrouter` — one POST to openrouter.ai, for OpenRouterBrain.
 *  3. `voice:make-image` / `voice:edit-image` / `voice:make-video` — real media
 *     generation through electron/gemini-media.ts, the very same REST logic the
 *     MCP bridge uses. Output lands in the current project's
 *     `assets/generated/`. Images are also adopted into the screenshot shelf so
 *     they show up in the tray instantly; videos are not, because that shelf
 *     holds still images only.
 *  4. `voice:import-key` — find a key already saved on this machine, so nobody
 *     has to type one twice. Read-only: never writes to, moves or deletes the
 *     source file. See keyCandidates() for where it looks.
 *
 * These are the only outbound requests Forge makes; there is no telemetry and no
 * update check. Keys are never logged, and errors are passed back verbatim
 * (minus the key) so the panel can be honest about what the provider said.
 */

const HOST = 'https://generativelanguage.googleapis.com'
const OPENROUTER_HOST = 'https://openrouter.ai/api/v1'
const GROQ_HOST = 'https://api.groq.com/openai/v1'
// A drafted prompt is a page of prose: 30s was not enough for a real answer.
const DEFAULT_TIMEOUT_MS = 75_000
const MAX_TIMEOUT_MS = 150_000

/** Loose enough for every provider's format, tight enough to reject prose. */
const KEY_SHAPE = /^[A-Za-z0-9_\-.]{20,200}$/

/**
 * Where a key might already be sitting. First hit wins; nothing is ever
 * written, moved or deleted.
 *
 * Forge's own data directory comes first, because it is the one place a *new*
 * user could reasonably be told to drop a file. The rest are conveniences for
 * the machine Forge was written on — an existing DictationMic install, the
 * `~/.kimi-key` that `kimi` runs Claude Code on — and simply do not exist
 * anywhere else. That is why the failure message lists every path it tried
 * instead of naming one that means nothing to the person reading it.
 */
function keyCandidates(which: KeySource): string[] {
  const desktop = join(homedir(), 'Desktop')
  if (which === 'openrouter') {
    return [join(getDataDir(), 'openrouter.key'), join(homedir(), '.kimi-key'), join(homedir(), '.openrouter-key')]
  }
  if (which === 'groq') {
    return [join(getDataDir(), 'groq.key'), join(homedir(), '.groq-key')]
  }
  return [
    join(getDataDir(), 'gemini.key'),
    join(homedir(), '.gemini-key'),
    join(desktop, 'DictationMic', 'gemini.key'),
    join(desktop, 'DictationMic', 'gemini_key.txt')
  ]
}

function importKey(which: KeySource): ImportedKeyResult {
  const candidates = keyCandidates(which)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const key = readFileSync(path, 'utf8').trim()
      if (!key) return { ok: false, error: `${path} is empty` }
      if (!KEY_SHAPE.test(key)) {
        return { ok: false, error: `${path} does not look like an API key` }
      }
      return { ok: true, key, last4: key.slice(-4), source: path }
    } catch (err) {
      return { ok: false, error: `Could not read ${path}: ${(err as Error).message}` }
    }
  }
  return { ok: false, error: `No saved key found. Looked in:\n${candidates.join('\n')}` }
}

/* ----------------------------------------------------------------- gemini */

function isSafeModel(model: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(model)
}

/** Never let a key reach a log, an error string or a stack trace. */
function scrub(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('«key»')
}

async function listFlashModels(key: string): Promise<string> {
  try {
    const res = await fetch(`${HOST}/v1beta/models`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return ''
    const body = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }
    const names = (body.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter((n) => n.includes('flash'))
    return names.slice(0, 6).join(', ')
  } catch {
    return ''
  }
}

async function callGemini(req: GeminiCallRequest): Promise<GeminiCallResult> {
  const key = typeof req?.key === 'string' ? req.key.trim() : ''
  const model = typeof req?.model === 'string' ? req.model.trim() : ''
  if (!key) return { ok: false, error: 'No Gemini API key set' }
  if (!isSafeModel(model)) return { ok: false, error: `Not a usable model id: “${model}”` }

  const turns = Array.isArray(req.turns) ? req.turns.slice(-40) : []
  const contents = turns
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({ role: t.role === 'model' ? 'model' : 'user', parts: [{ text: t.text }] }))
  if (contents.length === 0) return { ok: false, error: 'Nothing to send' }

  const generationConfig: Record<string, unknown> = {
    // Low: this is a structured task, and higher values invited repetition loops.
    temperature: 0.2,
    // A drafted prompt plus prose runs long; 2k truncated real answers mid-JSON.
    maxOutputTokens: 8192,
    responseMimeType: 'application/json'
  }
  if (req.schema) generationConfig['responseSchema'] = req.schema

  const body = {
    systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
    contents,
    generationConfig
  }

  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(2_000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS))

  try {
    const res = await fetch(`${HOST}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    })

    const raw = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* keep raw */
    }

    if (!res.ok) {
      const err = (parsed as { error?: { message?: string; status?: string } } | null)?.error
      let message = err?.message ?? scrub(raw.slice(0, 400), key) ?? res.statusText
      if (res.status === 404) {
        const flash = await listFlashModels(key)
        if (flash) message += ` — models available here: ${flash}`
      }
      return { ok: false, error: `${res.status} ${err?.status ?? res.statusText}: ${scrub(message, key)}`, status: res.status }
    }

    const data = parsed as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
      promptFeedback?: { blockReason?: string }
      modelVersion?: string
    } | null

    if (data?.promptFeedback?.blockReason) {
      return { ok: false, error: `Gemini blocked the prompt (${data.promptFeedback.blockReason})` }
    }
    const candidate = data?.candidates?.[0]
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    if (!text) {
      return {
        ok: false,
        error: `Gemini returned no text${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}`
      }
    }
    const result: GeminiCallResult = { ok: true, text }
    if (candidate?.finishReason) result.finishReason = candidate.finishReason
    if (data?.modelVersion) result.model = data.modelVersion
    return result
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: `Gemini did not answer within ${Math.round(timeout / 1000)}s` }
    }
    return { ok: false, error: `Could not reach Gemini: ${scrub(e.message, key)}` }
  }
}

/* ------------------------------------------------- openai-shaped providers */

/**
 * Who we are talking to. Everything else about the call is identical.
 *
 * OpenRouter and Groq both serve the OpenAI chat-completions API verbatim, so
 * there is one implementation below and a provider record per host. Copying the
 * function would have been fewer lines today and two subtly different retry,
 * scrub and error-mapping paths by the end of the month — the same reasoning as
 * the shared `GroqCallRequest = OpenRouterCallRequest` alias in shared/types.ts.
 */
interface ChatProvider {
  /** Used in every error message the panel shows, so it must be the brand name. */
  name: string
  host: string
  /** Anything the provider wants beyond auth. Never carries anything about Steve. */
  headers?: Record<string, string>
}

const OPENROUTER: ChatProvider = {
  name: 'OpenRouter',
  host: OPENROUTER_HOST,
  // OpenRouter's own convention for attributing traffic to an app.
  headers: { 'HTTP-Referer': 'https://forge.local', 'X-Title': 'Forge' }
}

const GROQ: ChatProvider = { name: 'Groq', host: GROQ_HOST }

/**
 * One POST to an OpenAI-shaped chat-completions endpoint: system prompt as the
 * first message, JSON asked for with `response_format`, answer at
 * `choices[0].message.content`. Much plainer than Gemini's call.
 */
async function callChat(req: OpenRouterCallRequest, provider: ChatProvider): Promise<OpenRouterCallResult> {
  const key = typeof req?.key === 'string' ? req.key.trim() : ''
  const model = typeof req?.model === 'string' ? req.model.trim() : ''
  if (!key) return { ok: false, error: `No ${provider.name} API key set` }
  // Model ids look like `vendor/model:variant`, so this is looser than Gemini's.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./\-_:]{1,96}$/.test(model)) {
    return { ok: false, error: `Not a usable model id: “${model}”` }
  }

  const turns = Array.isArray(req.turns) ? req.turns.slice(-40) : []
  const messages: Array<{ role: string; content: string }> = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const t of turns) {
    if (!t || typeof t.text !== 'string' || !t.text.trim()) continue
    messages.push({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text })
  }
  if (messages.filter((m) => m.role !== 'system').length === 0) {
    return { ok: false, error: 'Nothing to send' }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: Math.min(16_384, Math.max(256, req.maxTokens ?? 8192))
  }
  if (req.json !== false) body['response_format'] = { type: 'json_object' }

  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(2_000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS))

  try {
    const res = await fetch(`${provider.host}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...(provider.headers ?? {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    })

    const raw = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* keep raw */
    }

    if (!res.ok) {
      const err = (parsed as { error?: { message?: string; code?: number } } | null)?.error
      const message = err?.message ?? scrub(raw.slice(0, 400), key) ?? res.statusText
      return { ok: false, error: `${res.status}: ${scrub(message, key)}`, status: res.status }
    }

    const data = parsed as {
      // OpenRouter reports upstream failures with HTTP 200 and an error body.
      error?: { message?: string; code?: number }
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      model?: string
    } | null

    if (data?.error?.message) {
      return { ok: false, error: `${provider.name}: ${scrub(data.error.message, key)}`, status: data.error.code }
    }

    const choice = data?.choices?.[0]
    const text = (choice?.message?.content ?? '').trim()
    if (!text) {
      return {
        ok: false,
        error: `${provider.name} returned no text${choice?.finish_reason ? ` (${choice.finish_reason})` : ''}`
      }
    }
    const result: OpenRouterCallResult = { ok: true, text }
    if (choice?.finish_reason) result.finishReason = choice.finish_reason
    if (data?.model) result.model = data.model
    return result
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: `${provider.name} did not answer within ${Math.round(timeout / 1000)}s` }
    }
    return { ok: false, error: `Could not reach ${provider.name}: ${scrub(e.message, key)}` }
  }
}

/* ------------------------------------------------------------------ media */

/**
 * Generated images belong with the work, not in a temp folder: they land in the
 * open project's `assets/generated/`. With no project open there is nowhere
 * obvious, so they go where the MCP bridge puts its own output.
 */
function mediaOutDir(projectPath: string | undefined): string {
  const p = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (p && existsSync(p)) return join(p, 'assets', 'generated')
  return join(getDataDir(), 'bridge-out')
}

/** Shared tail: adopt what was written into the tray, then answer the renderer. */
function finishMedia(result: MediaResult): MediaCallResult {
  if (!result.ok) return { ok: false, error: result.error, kind: result.kind }
  const adopted = adoptShotFiles(result.paths)
  const out: MediaCallResult = {
    ok: true,
    paths: result.paths,
    model: result.model,
    ms: result.ms,
    adopted
  }
  if (result.note) out.note = result.note
  return out
}

/* ------------------------------------------------------------------ speech */

/**
 * In-flight speech requests, so barge-in can abort one.
 *
 * Steve talking over the agent has to stop the *request*, not just the sound:
 * on a free key the TTS quota is a handful of sentences a minute, and spending
 * one on words he has already interrupted is how the next real reply ends up
 * being read by SAPI. Entries are removed in a `finally`, so nothing leaks even
 * when the fetch throws.
 */
const speaking = new Map<string, AbortController>()

export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.voiceImportKey, (_e, which: KeySource): ImportedKeyResult =>
    importKey(which === 'openrouter' || which === 'groq' ? which : 'gemini')
  )
  ipcMain.handle(IPC.voiceGemini, async (_e, req: GeminiCallRequest): Promise<GeminiCallResult> => callGemini(req))
  ipcMain.handle(
    IPC.voiceOpenRouter,
    async (_e, req: OpenRouterCallRequest): Promise<OpenRouterCallResult> => callChat(req, OPENROUTER)
  )
  ipcMain.handle(IPC.voiceGroq, async (_e, req: GroqCallRequest): Promise<GroqCallResult> => callChat(req, GROQ))

  ipcMain.handle(IPC.voiceMakeImage, async (_e, req: MakeImageRequest): Promise<MediaCallResult> => {
    const settings = getSettings()
    return finishMedia(
      await makeImage({
        // The key is read here, not passed from the renderer.
        key: settings.geminiKey,
        description: String(req?.description ?? ''),
        outDir: mediaOutDir(req?.projectPath),
        count: req?.count,
        aspect: req?.aspect,
        model: settings.geminiImageModel
      })
    )
  })

  ipcMain.handle(IPC.voiceEditImage, async (_e, req: EditImageRequest): Promise<MediaCallResult> => {
    const settings = getSettings()
    return finishMedia(
      await editImage({
        key: settings.geminiKey,
        path: String(req?.path ?? ''),
        instruction: String(req?.instruction ?? ''),
        outDir: mediaOutDir(req?.projectPath),
        model: settings.geminiImageModel
      })
    )
  })

  ipcMain.handle(IPC.voiceMakeVideo, async (_e, req: MakeVideoRequest): Promise<MediaCallResult> => {
    const settings = getSettings()
    const opts: Parameters<typeof makeVideo>[0] = {
      key: settings.geminiKey,
      description: String(req?.description ?? ''),
      outDir: mediaOutDir(req?.projectPath)
    }
    if (req?.aspect) opts.aspect = String(req.aspect)
    if (req?.duration !== undefined && req.duration !== null) opts.duration = Number(req.duration)
    // Deliberately NOT finishMedia(): the screenshot shelf is images-only
    // (SHOT_EXTS in electron/shots/shelf.ts) and its tray thumbnails come from
    // nativeImage, which cannot render a video frame. Adopting an .mp4 would be
    // rejected anyway; claiming `adopted` for it would be a lie.
    const result = await makeVideo(opts)
    if (!result.ok) return { ok: false, error: result.error, kind: result.kind }
    const out: MediaCallResult = {
      ok: true,
      paths: result.paths,
      model: result.model,
      ms: result.ms,
      adopted: 0
    }
    if (result.note) out.note = result.note
    return out
  })

  ipcMain.handle(IPC.voiceSpeak, async (_e, req: VoiceSpeakRequest): Promise<VoiceSpeakResult> => {
    const settings = getSettings()
    const id = typeof req?.requestId === 'string' ? req.requestId : ''
    const controller = new AbortController()
    if (id) {
      // A second request under a live id replaces it: the panel only ever has
      // one mouth, so the older one is by definition stale.
      speaking.get(id)?.abort()
      speaking.set(id, controller)
    }
    try {
      const result = await speakGemini({
        // Read here, not passed from the renderer — same rule as the media calls.
        key: settings.geminiKey,
        text: String(req?.text ?? ''),
        voice: req?.voice || settings.voiceTtsVoice,
        model: req?.model || settings.voiceTtsModel,
        signal: controller.signal
      })
      if (!result.ok) return { ok: false, error: result.error, kind: result.kind }
      const out: VoiceSpeakResult = {
        ok: true,
        audio: result.audio.toString('base64'),
        mime: result.mime,
        sampleRate: result.sampleRate,
        channels: result.channels,
        model: result.model,
        voice: result.voice,
        ms: result.ms
      }
      if (result.note) out.note = result.note
      return out
    } finally {
      if (id && speaking.get(id) === controller) speaking.delete(id)
    }
  })

  ipcMain.handle(IPC.voiceSpeakCancel, (_e, requestId: string): boolean => {
    const id = typeof requestId === 'string' ? requestId : ''
    const controller = id ? speaking.get(id) : undefined
    if (!controller) return false
    controller.abort()
    speaking.delete(id)
    return true
  })
}

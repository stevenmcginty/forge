import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { GeminiCallRequest, GeminiCallResult, ImportedKeyResult } from '@shared/types'

/**
 * The voice agent's only door to the outside world.
 *
 * Two jobs, both deliberately in the main process:
 *
 *  1. `voice:gemini` — one POST to generativelanguage.googleapis.com. It lives
 *     here because the renderer's CSP allows no external hosts (and should not
 *     be widened), and because an API key is better off never touching page
 *     script. This is the *only* outbound request Forge makes; there is no
 *     telemetry, no update check, nothing else.
 *
 *  2. `voice:import-key` — read Steve's existing Gemini key from DictationMic so
 *     he does not have to type it again. Read-only: this never writes to, moves
 *     or deletes the source file.
 *
 * The key is never logged. Errors are passed back verbatim (minus the key) so
 * the panel can be honest about what Google said.
 */

const HOST = 'https://generativelanguage.googleapis.com'
// A drafted prompt is a page of prose: 30s was not enough for a real answer.
const DEFAULT_TIMEOUT_MS = 75_000
const MAX_TIMEOUT_MS = 150_000

/** Where DictationMic keeps the key. First hit wins; nothing is written. */
function keyCandidates(): string[] {
  const desktop = join(homedir(), 'Desktop')
  return [
    join(desktop, 'DictationMic', 'gemini.key'),
    join(desktop, 'DictationMic', 'gemini_key.txt'),
    join(homedir(), '.gemini-key')
  ]
}

function importKey(): ImportedKeyResult {
  for (const path of keyCandidates()) {
    if (!existsSync(path)) continue
    try {
      const key = readFileSync(path, 'utf8').trim()
      if (!key) return { ok: false, error: `${path} is empty` }
      if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(key)) {
        return { ok: false, error: `${path} does not look like an API key` }
      }
      return { ok: true, key, last4: key.slice(-4), source: path }
    } catch (err) {
      return { ok: false, error: `Could not read ${path}: ${(err as Error).message}` }
    }
  }
  return { ok: false, error: `No key file found (looked in ${keyCandidates()[0]})` }
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

export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.voiceImportKey, (): ImportedKeyResult => importKey())
  ipcMain.handle(IPC.voiceGemini, async (_e, req: GeminiCallRequest): Promise<GeminiCallResult> => callGemini(req))
}

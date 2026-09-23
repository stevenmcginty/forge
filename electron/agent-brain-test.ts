import { execFile } from 'node:child_process'
import { agentBrainSpec, type BrainTestResult, type BrainTestTarget } from '@shared/agent-brain'
import { GEMINI_API_HOST, GEMINI_LIVE_MODEL, OPENAI_API_HOST, OPENAI_REALTIME_MINI_MODEL, OPENAI_REALTIME_MODEL } from '@shared/realtime'
import type { Settings } from '@shared/types'
import { whichCommand } from './which'
import { resolveCliLaunch, type CliLaunch } from './cli-launch'
import { codexUserModel, geminiAuthFor, geminiGoogleLogin } from './voice-agent/cli-brains'

/**
 * The Settings "Test" buttons: one honest sentence per key and per Agent
 * brain. "Gemini key OK · gemini-3.8-live available", "key refused", "429
 * free-tier limit", "Claude logged in · 2.1.220".
 *
 * Every probe is read-only: a model list with the key (Gemini, OpenAI, Groq),
 * OpenRouter's key endpoint, or a CLI's version plus its own auth status. No
 * tokens are spent and nothing is written. Electron-free except for what the
 * caller hands in, so a script can drive it with a fake fetch.
 */

type Fetch = typeof fetch

const TIMEOUT_MS = 12_000
const GROQ_HOST = 'https://api.groq.com/openai/v1'
const OPENROUTER_HOST = 'https://openrouter.ai/api/v1'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function bodyLine(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string }
      const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      return (msg ?? text).split('\n')[0]!.trim().slice(0, 160)
    } catch {
      return text.split('\n')[0]!.trim().slice(0, 160)
    }
  } catch {
    return ''
  }
}

/** A failed HTTP answer, in the words the row shows. */
async function httpReason(vendor: string, res: Response): Promise<BrainTestResult> {
  const detail = await bodyLine(res)
  if (res.status === 429) return { ok: false, reason: `${vendor}: 429 free-tier limit`, detail }
  if (res.status === 400 && /api key not valid|invalid api key/i.test(detail)) return { ok: false, reason: `${vendor}: key refused`, detail }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: `${vendor}: key refused`, detail }
  return { ok: false, reason: `${vendor}: failed (${res.status})`, detail }
}

async function get(fetchImpl: Fetch, url: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    return await fetchImpl(url, { headers, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function testGeminiKey(key: string, extraModel: string | null, fetchImpl: Fetch = fetch): Promise<BrainTestResult> {
  const k = key.trim()
  if (!k) return { ok: false, reason: 'Gemini: no key set' }
  if (k.startsWith('enc:')) return { ok: false, reason: 'Gemini: key is still encrypted — restart Forge' }
  try {
    const ids = new Set<string>()
    let page = ''
    for (let i = 0; i < 5; i++) {
      const res = await get(fetchImpl, `${GEMINI_API_HOST}/v1beta/models?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, {
        'x-goog-api-key': k
      })
      if (!res.ok) return httpReason('Gemini', res)
      const body = (await res.json()) as { models?: Array<{ name?: string }>; nextPageToken?: string }
      for (const m of body.models ?? []) ids.add(String(m.name ?? '').replace(/^models\//, ''))
      page = body.nextPageToken ?? ''
      if (!page) break
    }
    const live = ids.has(GEMINI_LIVE_MODEL)
    const extra = extraModel && extraModel.trim() ? extraModel.trim() : null
    const bits = [`Gemini key OK · ${GEMINI_LIVE_MODEL} ${live ? 'available' : 'NOT listed'}`]
    if (extra) bits.push(`${extra} ${ids.has(extra) ? 'available' : 'NOT listed'}`)
    return { ok: live, reason: bits.join(' · '), detail: `${ids.size} models listed` }
  } catch (err) {
    return { ok: false, reason: "Gemini: can't reach it", detail: errText(err) }
  }
}

export async function testOpenAIKey(key: string, fetchImpl: Fetch = fetch): Promise<BrainTestResult> {
  const k = key.trim()
  if (!k) return { ok: false, reason: 'OpenAI: no key set' }
  if (k.startsWith('enc:')) return { ok: false, reason: 'OpenAI: key is still encrypted — restart Forge' }
  try {
    const res = await get(fetchImpl, `${OPENAI_API_HOST}/v1/models`, { authorization: `Bearer ${k}` })
    if (!res.ok) return httpReason('OpenAI', res)
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = new Set((body.data ?? []).map((m) => String(m.id ?? '')))
    const full = ids.has(OPENAI_REALTIME_MODEL)
    const mini = ids.has(OPENAI_REALTIME_MINI_MODEL)
    return {
      ok: full || mini,
      reason: `OpenAI key OK · ${OPENAI_REALTIME_MODEL} ${full ? 'available' : 'NOT listed'} · mini ${mini ? 'available' : 'NOT listed'}`,
      detail: `${ids.size} models listed`
    }
  } catch (err) {
    return { ok: false, reason: "OpenAI: can't reach it", detail: errText(err) }
  }
}

export async function testGroqKey(key: string, fetchImpl: Fetch = fetch): Promise<BrainTestResult> {
  const k = key.trim()
  if (!k) return { ok: false, reason: 'Groq: no key set' }
  try {
    const res = await get(fetchImpl, `${GROQ_HOST}/models`, { authorization: `Bearer ${k}` })
    if (!res.ok) return httpReason('Groq', res)
    const body = (await res.json()) as { data?: unknown[] }
    return { ok: true, reason: `Groq key OK · ${(body.data ?? []).length} models` }
  } catch (err) {
    return { ok: false, reason: "Groq: can't reach it", detail: errText(err) }
  }
}

export async function testOpenRouterKey(key: string, fetchImpl: Fetch = fetch): Promise<BrainTestResult> {
  const k = key.trim()
  if (!k) return { ok: false, reason: 'OpenRouter: no key set' }
  try {
    const res = await get(fetchImpl, `${OPENROUTER_HOST}/key`, { authorization: `Bearer ${k}` })
    if (!res.ok) return httpReason('OpenRouter', res)
    const body = (await res.json()) as { data?: { is_free_tier?: boolean; limit_remaining?: number | null } }
    const free = body.data?.is_free_tier ? ' · free tier' : ''
    return { ok: true, reason: `OpenRouter key OK${free}` }
  } catch (err) {
    return { ok: false, reason: "OpenRouter: can't reach it", detail: errText(err) }
  }
}

/** Run one CLI with args, through cmd.exe for a .cmd shim (never a joined string). */
function runCli(exe: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const viaCmd = /\.(cmd|bat)$/i.test(exe)
  const file = viaCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : exe
  const argv = viaCmd ? ['/d', '/s', '/c', exe, ...args] : args
  return runFile(file, argv)
}

/** Run a resolved CLI launch (./cli-launch.ts) with fixed, shell-safe args. */
function runLaunch(launch: CliLaunch, args: string[]): Promise<{ ok: boolean; out: string }> {
  return runFile(launch.file, [...launch.prefix, ...args])
}

function runFile(file: string, argv: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim() })
    })
  })
}

export async function testClaudeCli(model: string): Promise<BrainTestResult> {
  const exe = whichCommand('claude')
  if (!exe) return { ok: false, reason: 'Claude: claude CLI not found on PATH' }
  const version = await runCli(exe, ['--version'])
  const v = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(version.out)?.[1] ?? '?'
  const auth = await runCli(exe, ['auth', 'status'])
  let loggedIn: boolean | null = null
  let method = ''
  try {
    const parsed = JSON.parse(auth.out.slice(auth.out.indexOf('{'))) as { loggedIn?: boolean; authMethod?: string }
    loggedIn = parsed.loggedIn === true
    method = parsed.authMethod ?? ''
  } catch {
    loggedIn = null
  }
  const luna = /^gpt-/i.test(model)
  const note = luna ? ` · model ${model} runs on the Codex brain` : ` · model ${model}`
  if (loggedIn === false) return { ok: false, reason: `Claude: not logged in (run claude and /login) · ${v}` }
  if (loggedIn === null) return { ok: version.ok, reason: `Claude ${v} found · login state unknown${note}`, detail: auth.out.slice(0, 200) }
  return { ok: !luna, reason: `Claude logged in${method ? ` (${method})` : ''} · ${v}${note}` }
}

/** "Codex logged in (ChatGPT) · 0.156.1 · gpt-6-luna", or why not, in words. */
export async function testCodexCli(): Promise<BrainTestResult> {
  const launch = resolveCliLaunch('codex')
  if (!launch) return { ok: false, reason: 'Codex: not installed — npm i -g @openai/codex' }
  const version = await runLaunch(launch, ['--version'])
  const v = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(version.out)?.[1] ?? '?'
  if (!version.ok) return { ok: false, reason: `Codex: found but it did not start (${launch.found})`, detail: version.out.slice(0, 200) }
  const status = await runLaunch(launch, ['login', 'status'])
  const model = codexUserModel().model
  const tail = ` · ${v}${model ? ` · ${model}` : ''}`
  if (/not logged in/i.test(status.out) || !status.ok) {
    return { ok: false, reason: `Codex: not logged in — run codex login${tail}`, detail: status.out.slice(0, 200) }
  }
  if (/chatgpt/i.test(status.out)) return { ok: true, reason: `Codex logged in (ChatGPT)${tail}` }
  if (/api key/i.test(status.out)) return { ok: true, reason: `Codex logged in with an API key, not ChatGPT${tail}` }
  return { ok: true, reason: `Codex: ${status.out.split('\n')[0]!.trim().slice(0, 60)}${tail}` }
}

/** "Gemini CLI 0.56.0 · Google login", or that it falls back to the Gemini key, or why not. */
export async function testGeminiCli(settingsKey: string): Promise<BrainTestResult> {
  const launch = resolveCliLaunch('gemini')
  if (!launch) return { ok: false, reason: 'Gemini CLI: not installed — npm i -g @google/gemini-cli' }
  const version = await runLaunch(launch, ['--version'])
  const v = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(version.out)?.[1] ?? '?'
  if (!version.ok) return { ok: false, reason: `Gemini CLI: found but it did not start (${launch.found})`, detail: version.out.slice(0, 200) }
  const key = settingsKey.trim() && !settingsKey.trim().startsWith('enc:') ? settingsKey : String(process.env['GEMINI_API_KEY'] ?? '')
  switch (geminiAuthFor(geminiGoogleLogin(), key)) {
    case 'google':
      return { ok: true, reason: `Gemini CLI ${v} · Google login` }
    case 'key':
      return { ok: true, reason: `Gemini CLI ${v} · no Google login on this PC — using your Gemini key (free-tier limits)` }
    default:
      return { ok: false, reason: `Gemini CLI: not logged in — run gemini and sign in with Google · ${v}` }
  }
}

export async function testBrain(target: BrainTestTarget, settings: Settings, fetchImpl: Fetch = fetch): Promise<BrainTestResult> {
  if (target.kind === 'key') {
    switch (target.vendor) {
      case 'gemini':
        return testGeminiKey(settings.geminiKey, settings.geminiModel, fetchImpl)
      case 'openai':
        return testOpenAIKey(settings.openaiKey, fetchImpl)
      case 'groq':
        return testGroqKey(settings.groqKey, fetchImpl)
      case 'openrouter':
        return testOpenRouterKey(settings.openrouterKey, fetchImpl)
    }
    return { ok: false, reason: 'Unknown key' }
  }
  const spec = agentBrainSpec(target.id)
  switch (target.id) {
    case 'claude':
      return testClaudeCli(settings.voiceClaudeModel || 'opus')
    case 'gemini-live':
      return testGeminiKey(settings.geminiKey, null, fetchImpl)
    case 'gemini-flash':
      return testGeminiKey(settings.geminiKey, settings.geminiModel, fetchImpl)
    case 'gpt-realtime':
    case 'gpt-realtime-mini':
      return testOpenAIKey(settings.openaiKey, fetchImpl)
    case 'groq':
      return testGroqKey(settings.groqKey, fetchImpl)
    case 'openrouter':
      return testOpenRouterKey(settings.openrouterKey, fetchImpl)
    case 'codex-cli':
      return testCodexCli()
    case 'gemini-cli':
      return testGeminiCli(settings.geminiKey)
  }
  return { ok: false, reason: `${spec.label}: no test yet` }
}

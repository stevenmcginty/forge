/**
 * The Agent brain: the ONE setting that picks who answers the bottom bar.
 *
 * There used to be two — `voiceHubProvider` (Claude / Gemini Live / GPT) and the
 * older `voiceBrain` (Gemini Flash / Groq / OpenRouter / Claude) — and they could
 * disagree: Steve's profile had the hub on "claude" and voiceBrain on "gemini",
 * so "Claude + Parakeet" really answered through the Gemini API. Now every brain
 * is one adapter in one list, and `settings.agentBrain` is the only thing any
 * code reads to route a turn. The two old fields stay in settings.json untouched
 * (nothing is lost) but are read exactly once, by `migrateAgentBrain`.
 *
 * Every adapter gets the same three things: the same Forge tools
 * (shared/brain-tools.ts + shared/hub-tools.ts + the browser tools), the same
 * persona (shared/brain-persona.ts) and the same live app manifest. `kind` says
 * which engine runs it:
 *
 *  - `realtime` — a live two-way audio session held in the renderer
 *    (src/lib/realtime/). Tools are function tools.
 *  - `session`  — a hidden agent session in the main process, Parakeet in and
 *    Edge TTS out (electron/voice-agent/host.ts). Tools are an MCP server. B8's
 *    `gemini-cli` and `codex-cli` are this kind.
 *  - `json`     — a per-turn HTTP brain in the renderer (src/lib/voicebrain.ts)
 *    that answers with JSON actions from the manifest.
 *
 * No Electron and no DOM here: both processes import it.
 */

import type { AgentBrainId, VoiceMenuEntry } from './types'

/** The union itself lives in shared/types.ts (dependency-free). */
export type { AgentBrainId, VoiceMenuEntry }

export type AgentBrainKind = 'realtime' | 'session' | 'json'

/** The settings key an adapter needs, or null for subscription/login auth. */
export type AgentBrainKey = 'geminiKey' | 'openaiKey' | 'groqKey' | 'openrouterKey'

export interface AgentBrainSpec {
  id: AgentBrainId
  /** The row title in Settings, and the brain's name in the bar ("Agent · Claude"). */
  label: string
  kind: AgentBrainKind
  key: AgentBrainKey | null
  /** How it signs in, in words. */
  auth: string
  /** One line for Settings. */
  note: string
}

export const AGENT_BRAINS: readonly AgentBrainSpec[] = [
  {
    id: 'claude',
    label: 'Claude',
    kind: 'session',
    key: null,
    auth: 'your claude login',
    note: 'Free with your subscription — Parakeet hears, a hidden Claude session thinks, Edge speaks'
  },
  {
    id: 'codex-cli',
    label: 'Codex',
    kind: 'session',
    key: null,
    auth: 'your ChatGPT login (codex login)',
    note: 'Free with your ChatGPT plan — Parakeet hears, a hidden Codex session thinks, Edge speaks'
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    kind: 'session',
    key: null,
    auth: 'your Google login (gemini)',
    note: 'Parakeet hears, a hidden Gemini CLI session thinks, Edge speaks — Google login, or your Gemini key if the CLI has none'
  },
  { id: 'gemini-live', label: 'Gemini Live', kind: 'realtime', key: 'geminiKey', auth: 'Gemini key', note: 'Live two-way talk — about $3–4 for a heavy day' },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime mini', kind: 'realtime', key: 'openaiKey', auth: 'OpenAI key', note: 'Live two-way talk — about $3–8 for a heavy day' },
  { id: 'gpt-realtime', label: 'GPT Realtime', kind: 'realtime', key: 'openaiKey', auth: 'OpenAI key', note: 'Live two-way talk — about $10–20 for a heavy day' },
  { id: 'gemini-flash', label: 'Gemini Flash (text)', kind: 'json', key: 'geminiKey', auth: 'Gemini key', note: 'Parakeet in, one Gemini call per turn, Edge voice out' },
  { id: 'groq', label: 'Groq (text)', kind: 'json', key: 'groqKey', auth: 'Groq key', note: 'Parakeet in, one Groq call per turn — fast, free tier' },
  { id: 'openrouter', label: 'OpenRouter (text)', kind: 'json', key: 'openrouterKey', auth: 'OpenRouter key', note: 'Parakeet in, one OpenRouter call per turn' }
]

export const AGENT_BRAIN_IDS: readonly AgentBrainId[] = AGENT_BRAINS.map((b) => b.id)

export const DEFAULT_AGENT_BRAIN: AgentBrainId = 'claude'

export function isAgentBrainId(value: unknown): value is AgentBrainId {
  return typeof value === 'string' && (AGENT_BRAIN_IDS as readonly string[]).includes(value)
}

/** Short list first. "GPT Live" is `gpt-realtime` (label "GPT Realtime"), not the mini model. */
const VOICE_MENU_SHOWN_FIRST: readonly AgentBrainId[] = ['gpt-realtime', 'gemini-live', 'claude']

/** The picker order when Settings has never stored one. */
export function defaultVoiceMenu(): VoiceMenuEntry[] {
  const shown = new Set<string>(VOICE_MENU_SHOWN_FIRST)
  const head = VOICE_MENU_SHOWN_FIRST.filter((id) => isAgentBrainId(id))
  const rest = AGENT_BRAIN_IDS.filter((id) => !shown.has(id))
  return [...head, ...rest].map((id) => ({ id, shown: shown.has(id) }))
}

/**
 * A non-array (an old settings.json has no field) becomes the default three.
 * An array is kept: unknown ids and later duplicates drop, and any brain the
 * list forgot is appended behind More (`shown: false`). `[]` stays all hidden.
 */
export function normaliseVoiceMenu(raw: unknown): VoiceMenuEntry[] {
  if (!Array.isArray(raw)) return defaultVoiceMenu()
  const seen = new Set<string>()
  const out: VoiceMenuEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (!isAgentBrainId(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, shown: Boolean((item as { shown?: unknown }).shown) })
  }
  for (const id of AGENT_BRAIN_IDS) {
    if (!seen.has(id)) out.push({ id, shown: false })
  }
  return out
}

/**
 * `first` is the short list, in saved order. The brain in use is always in
 * `first` (at its saved position) and never also in `rest`.
 */
export function voiceMenuRows(
  menu: VoiceMenuEntry[],
  current: AgentBrainId
): { first: AgentBrainSpec[]; rest: AgentBrainSpec[] } {
  const first: AgentBrainSpec[] = []
  const rest: AgentBrainSpec[] = []
  for (const entry of normaliseVoiceMenu(menu)) {
    const spec = AGENT_BRAINS.find((b) => b.id === entry.id)
    if (!spec) continue
    if (entry.shown || entry.id === current) first.push(spec)
    else rest.push(spec)
  }
  return { first, rest }
}

/** Swap with the neighbour. Out of range returns `menu` unchanged. */
export function moveVoiceMenu(menu: VoiceMenuEntry[], index: number, dir: -1 | 1): VoiceMenuEntry[] {
  const j = index + dir
  if (index < 0 || j < 0 || index >= menu.length || j >= menu.length) return menu
  const next = menu.slice()
  const tmp = next[index]!
  next[index] = next[j]!
  next[j] = tmp
  return next
}

/** Flip one brain's short-list flag. Other rows stay as they are. */
export function setVoiceMenuShown(menu: VoiceMenuEntry[], id: AgentBrainId, shown: boolean): VoiceMenuEntry[] {
  return menu.map((entry) => (entry.id === id ? { ...entry, shown } : entry))
}

export function agentBrainSpec(id: AgentBrainId | string | undefined | null): AgentBrainSpec {
  return AGENT_BRAINS.find((b) => b.id === id) ?? AGENT_BRAINS[0]!
}

/** Does this adapter run as a live realtime session (renderer audio)? */
export function isRealtimeBrain(id: AgentBrainId): id is 'gemini-live' | 'gpt-realtime-mini' | 'gpt-realtime' {
  return agentBrainSpec(id).kind === 'realtime'
}

/**
 * One-time migration from the two old fields.
 *
 *  1. A realtime `voiceHubProvider` was always a deliberate pick (its default
 *     is 'claude'), so it wins.
 *  2. A `voiceBrain` of groq or openrouter was a deliberate pick too (the
 *     default was gemini), so those become their text adapters.
 *  3. Everything else — voiceBrain 'gemini' (the old default, and Steve's case:
 *     he chose Claude in the hub), 'claude', 'stub', 'openai' — becomes Claude,
 *     which is what the hub said it was using.
 */
export function migrateAgentBrain(voiceHubProvider: unknown, voiceBrain: unknown): AgentBrainId {
  if (voiceHubProvider === 'gemini-live' || voiceHubProvider === 'gpt-realtime' || voiceHubProvider === 'gpt-realtime-mini') {
    return voiceHubProvider
  }
  if (voiceBrain === 'groq' || voiceBrain === 'openrouter') return voiceBrain
  return DEFAULT_AGENT_BRAIN
}

/**
 * Models the Claude brain used to hand to the Codex CLI ("GPT-5.6 Luna via
 * Codex"), with no Forge tools. That brain is the `codex-cli` adapter now.
 */
export const CODEX_CLAUDE_MODELS: readonly string[] = ['gpt-5.6-luna']

export function isCodexClaudeModel(model: unknown): boolean {
  return typeof model === 'string' && (CODEX_CLAUDE_MODELS.includes(model.trim()) || /^gpt-/i.test(model.trim()))
}

/**
 * One-time move off "Claude running a GPT model through Codex" (B8).
 *
 * A Codex model in `voiceClaudeModel` meant the Claude brain was really Codex
 * with no Forge tools. Now: the brain becomes `codex-cli` (Codex, with every
 * Forge tool) when Claude was the pick, and `voiceClaudeModel` goes back to the
 * Claude default either way, so choosing Claude later means Claude. It runs
 * once by construction: after it, the model is no longer a Codex one.
 */
export function migrateCodexClaudeModel(
  agentBrain: AgentBrainId,
  voiceClaudeModel: unknown,
  claudeDefault: string
): { agentBrain: AgentBrainId; voiceClaudeModel: string } | null {
  if (!isCodexClaudeModel(voiceClaudeModel)) return null
  return { agentBrain: agentBrain === 'claude' ? 'codex-cli' : agentBrain, voiceClaudeModel: claudeDefault }
}

/* ------------------------------------------------------------------- tests */

/** What the Settings "Test" buttons ask main to check. */
export type BrainTestTarget =
  | { kind: 'key'; vendor: 'gemini' | 'openai' | 'groq' | 'openrouter' }
  | { kind: 'brain'; id: AgentBrainId }

/** `reason` is words for the row: "Gemini key OK · gemini-3.8-live available", "key refused", "429 free-tier limit". */
export interface BrainTestResult {
  ok: boolean
  reason: string
  detail?: string
}

/** The one IPC call behind every Test button: `window.forge.agentBrain.test(target)`. */
export const AGENT_BRAIN_TEST_CHANNEL = 'agent-brain:test'

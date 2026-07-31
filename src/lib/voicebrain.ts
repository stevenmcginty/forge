import type { VoiceBrainId } from '@shared/types'
import type { AppAction } from './appactions'
import { GeminiBrain } from './geminibrain'
import { GroqBrain } from './groqbrain'
import { OpenRouterBrain } from './openrouterbrain'

/**
 * The voice agent's *brain* seam.
 *
 * A brain takes what Steve said, plus a snapshot of Forge, and returns either
 * actions to run, a drafted prompt, or a question. `GeminiBrain` is the real
 * one; `StubBrain` is what you get with no key — it echoes, and says so.
 *
 * Note what a brain is NOT for: app commands like "open three Kimi tabs" are
 * matched by the deterministic grammar in `voicecommands.ts` before any brain is
 * consulted, so the common case costs nothing and works offline.
 *
 * Rules for whoever adds a brain:
 *   • This module must stay free of side effects at import time.
 *   • `ready()` is synchronous and cheap — it is called on every render.
 *   • `interpret()` never throws for "not configured"; that is what `ready()`
 *     is for. It may reject on a genuine failure, and the panel shows why.
 */

/* ------------------------------------------------------------------ types */

export type BrainConfidence = 'low' | 'medium' | 'high'

/** Why a brain cannot be used. Extend as real engines land. */
export type BrainNotReadyReason = 'no-key' | 'not-implemented' | 'offline' | 'unknown'

export interface BrainStatus {
  ok: boolean
  reason?: BrainNotReadyReason
  /** One short human line, shown as the status chip's tooltip. */
  detail?: string
  /** Overrides the chip's text when ok — e.g. the model id. */
  label?: string
}

/** One side of the conversation so far. */
export interface BrainTurn {
  role: 'user' | 'agent'
  text: string
}

export interface BrainContext {
  projectName?: string
  projectPath?: string
  /** Everything said this session, oldest first, including the current phrase. */
  recentTranscript: string[]
  /** The capability manifest — what Forge is, what may be done, current state. */
  manifest?: string
  /** Both sides of this panel session, oldest first, excluding the new phrase. */
  history?: BrainTurn[]
  /**
   * What Forge has learned about *this project* across every past session —
   * the markdown from `%APPDATA%\Forge\memory\<projectId>.md`, verbatim.
   *
   * Every live brain folds this into its system text under
   * `# WHAT YOU REMEMBER ABOUT THIS PROJECT`. Absent or empty means a project
   * with no history yet, and the heading is left out entirely rather than
   * teaching the model that it remembers nothing.
   */
  projectMemory?: string
}

export interface BrainReply {
  /** One line: "what I think you want". */
  understood: string
  /** The conversational reply, text only — the panel never speaks. */
  say?: string
  /** Clarifying questions, text only. */
  questions?: string[]
  /** Actions to run through the executor. Same schema the grammar produces. */
  actions?: AppAction[]
  /** The crafted prompt, markdown. Editable by the user before it is sent. */
  draftPrompt?: string
  confidence: BrainConfidence
}

export interface VoiceBrain {
  name: string
  ready(): BrainStatus
  interpret(transcript: string, context: BrainContext): Promise<BrainReply>
}

/** The slice of settings a brain is allowed to see. */
export interface BrainSettings {
  voiceBrain?: VoiceBrainId
  anthropicKey?: string
  geminiKey?: string
  geminiModel?: string
  openrouterKey?: string
  openrouterModel?: string
  groqKey?: string
  groqModel?: string
  /** Not a setting yet — reserved for OpenAIBrain. */
  openaiKey?: string
}

/* ------------------------------------------------------------------ stub */

export const NOT_CONNECTED = '(engine not connected)'

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

/**
 * Cheap, fast, and it honours `response_format` — verified against OpenRouter's
 * public /models endpoint (2026-07-30): $0.10/M in, $0.40/M out, 1M context,
 * `structured_outputs` supported. Mirrored in electron/store.ts's defaults,
 * which cannot import this module; voice-check asserts the two agree.
 */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite'

/**
 * Groq's default, chosen on the constraint that actually bites.
 *
 * Groq's free tier is capped on tokens-per-minute, not requests, and Forge's
 * capability manifest is ~3,000 tokens of every single turn. `llama-3.1-8b-instant`
 * is quicker and cheaper but gets 6,000 TPM, which leaves room for roughly one
 * exchange a minute — unusable for talking. `llama-3.3-70b-versatile` gets
 * 12,000, and is markedly better at returning the JSON this app requires.
 *
 * Both are Groq production models as of 2026-07-31, and `openai/gpt-oss-20b` is
 * the one to try for raw speed. Mirrored in electron/store.ts's defaults, which
 * cannot import this module.
 */
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'

/**
 * The offline fallback. Understands nothing, admits it, and hands the transcript
 * straight back so the draft-prompt box, Copy and Send-to-pane still work with
 * no key set. App commands keep working regardless — those never reach a brain.
 */
export class StubBrain implements VoiceBrain {
  readonly name = 'Stub'

  private readonly reason: BrainNotReadyReason

  constructor(reason: BrainNotReadyReason = 'not-implemented') {
    this.reason = reason
  }

  ready(): BrainStatus {
    if (this.reason === 'no-key') {
      return {
        ok: false,
        reason: 'no-key',
        detail: 'No API key yet — commands still work; your words come back verbatim as a draft prompt.'
      }
    }
    return {
      ok: false,
      reason: this.reason,
      detail: 'No interpreter is wired up — your words come back exactly as you said them.'
    }
  }

  async interpret(transcript: string, _context: BrainContext): Promise<BrainReply> {
    return {
      understood: NOT_CONNECTED,
      draftPrompt: transcript,
      confidence: 'low'
    }
  }
}

/* --------------------------------------------------------------- scaffolds */

/**
 * Anthropic-backed brain. Scaffold only: it holds the key from settings and
 * reports itself as not implemented.
 *
 * When this is built, `interpret()` is the only body that needs writing — one
 * Messages API call with `context.manifest` as the system prompt, returning
 * `understood`, `say`, `questions`, `actions` and `draftPrompt` exactly as
 * `GeminiBrain` already does (copy its request/parse shape). Nothing else in
 * Forge changes. The key must be read from settings here and nowhere else.
 */
export class ClaudeBrain implements VoiceBrain {
  readonly name = 'Claude'

  /** Read from settings and kept here. It leaves this object never. */
  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  ready(): BrainStatus {
    if (!this.apiKey) {
      return { ok: false, reason: 'no-key', detail: 'Add an Anthropic key — and the engine still has to be built.' }
    }
    return { ok: false, reason: 'not-implemented', detail: 'Key stored. The interpreter itself is not built yet.' }
  }

  async interpret(_transcript: string, _context: BrainContext): Promise<BrainReply> {
    // ▸ Real interpretation goes here. Deliberately empty in v1 — no network
    //   code ships until the brain is actually designed.
    throw new Error('ClaudeBrain.interpret() is not implemented yet')
  }
}

/**
 * OpenAI-backed brain. Same deal as ClaudeBrain — scaffold, no network. It too
 * may return `actions` alongside `draftPrompt` once implemented.
 */
export class OpenAIBrain implements VoiceBrain {
  readonly name = 'OpenAI'

  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  ready(): BrainStatus {
    if (!this.apiKey) {
      return { ok: false, reason: 'no-key', detail: 'No OpenAI key — and the engine still has to be built.' }
    }
    return { ok: false, reason: 'not-implemented', detail: 'Key stored. The interpreter itself is not built yet.' }
  }

  async interpret(_transcript: string, _context: BrainContext): Promise<BrainReply> {
    // ▸ Real interpretation goes here.
    throw new Error('OpenAIBrain.interpret() is not implemented yet')
  }
}

/* ---------------------------------------------------------------- selector */

function geminiBrain(s: BrainSettings): VoiceBrain | null {
  const key = (s.geminiKey ?? '').trim()
  return key ? new GeminiBrain(key, s.geminiModel?.trim() || DEFAULT_GEMINI_MODEL) : null
}

function openRouterBrain(s: BrainSettings): VoiceBrain | null {
  const key = (s.openrouterKey ?? '').trim()
  return key ? new OpenRouterBrain(key, s.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL) : null
}

function groqBrain(s: BrainSettings): VoiceBrain | null {
  const key = (s.groqKey ?? '').trim()
  return key ? new GroqBrain(key, s.groqModel?.trim() || DEFAULT_GROQ_MODEL) : null
}

/**
 * The brain named in settings. Never returns null, and never returns a brain
 * that cannot be used: a live engine without a key degrades to the stub, so the
 * panel keeps working (and says why) instead of erroring on every phrase.
 *
 * An explicit choice always wins — picking OpenRouter with no OpenRouter key
 * gets you the stub complaining about the missing key, *not* a silent fall back
 * onto Gemini, because a brain quietly swapping itself out is the kind of thing
 * you only notice from the bill. Only the unset/unknown case falls through the
 * preference order gemini > openrouter > stub.
 */
export function getActiveBrain(settings: BrainSettings | null | undefined): VoiceBrain {
  const s = settings ?? {}
  switch (s.voiceBrain) {
    case 'gemini':
      return geminiBrain(s) ?? new StubBrain('no-key')
    case 'openrouter':
      return openRouterBrain(s) ?? new StubBrain('no-key')
    case 'groq':
      return groqBrain(s) ?? new StubBrain('no-key')
    case 'claude':
      return new ClaudeBrain(s.anthropicKey ?? '')
    case 'openai':
      return new OpenAIBrain(s.openaiKey ?? '')
    case 'stub':
      return new StubBrain()
    default:
      // Nothing chosen, or nonsense from a hand-edited settings.json: use
      // whichever live brain has a key, Gemini first.
      return geminiBrain(s) ?? openRouterBrain(s) ?? groqBrain(s) ?? new StubBrain('no-key')
  }
}

/** What the panel's status chip says. Short enough for a 380px panel. */
export function brainStatusLabel(status: BrainStatus): string {
  if (status.ok) return status.label ?? 'engine ready'
  switch (status.reason) {
    case 'no-key':
      return 'no API key'
    case 'not-implemented':
      return 'engine not connected'
    case 'offline':
      return 'offline'
    default:
      return 'unavailable'
  }
}

/** Mask a key for display: never render the middle of a secret. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (k.length <= 12) return `${k.slice(0, 3)}••••`
  return `${k.slice(0, 7)}••••••••${k.slice(-4)}`
}

import type { Settings } from '@shared/types'
import { agentBrainSpec, isRealtimeBrain, type AgentBrainId, type AgentBrainKey, type AgentBrainSpec, type BrainTestResult } from '@shared/agent-brain'

/**
 * Each Agent brain's status, in words — the one reading shared by Settings'
 * Main agent card (components/settings/MainAgent.tsx) and the voice bar's
 * brain picker (components/hub/BrainPicker.tsx), so the two never disagree.
 * The probe that feeds it lives in hooks/useBrainStatus.ts; this file is pure
 * (no React, no window) so scripts/agent-bar-check.mjs can run it offline.
 *
 * Status is a word first and a shape second, never a colour alone:
 *   ● Ready   ◇ Needs key   ✕ Not installed   ! Not logged in   ! Not ready   ◌ Checking…
 */

/** What the Test IPC last said about one brain, and whether a Test is running. */
export interface Probe {
  busy: boolean
  result: BrainTestResult | null
}

export type Tone = 'ok' | 'need' | 'bad' | 'wait'
export interface BrainStatus {
  word: string
  glyph: string
  tone: Tone
}

export const READY: BrainStatus = { word: 'Ready', glyph: '●', tone: 'ok' }
export const NEEDS_KEY: BrainStatus = { word: 'Needs key', glyph: '◇', tone: 'need' }
export const CHECKING: BrainStatus = { word: 'Checking…', glyph: '◌', tone: 'wait' }

export function keyOf(s: Settings, key: AgentBrainKey | null): string {
  return key ? String(s[key] ?? '').trim() : ''
}

/** The status word, from the Test result — or from the key alone when there is nothing to test yet. */
export function statusOf(spec: AgentBrainSpec, s: Settings, probe: Probe | undefined): BrainStatus {
  if (spec.key && !keyOf(s, spec.key)) return NEEDS_KEY
  const r = probe?.result
  if (!r) return CHECKING
  if (r.ok) return READY
  const why = `${r.reason} ${r.detail ?? ''}`.toLowerCase()
  if (/not found|not installed|isn.t installed|no such file|enoent|cannot find|missing cli/.test(why)) {
    return { word: 'Not installed', glyph: '✕', tone: 'bad' }
  }
  if (/not logged in|not signed in|log ?in first|sign ?in first|unauthenticated|run .*\/?login/.test(why)) {
    return { word: 'Not logged in', glyph: '!', tone: 'need' }
  }
  if (/no key|key refused|still encrypted|invalid api key|api key not valid/.test(why)) return NEEDS_KEY
  return { word: 'Not ready', glyph: '!', tone: 'bad' }
}

/** The probe cache key: the inputs that change a brain's answer — its key, and Claude's model. */
export function probeSig(spec: AgentBrainSpec, s: Settings): string {
  return `${keyOf(s, spec.key)}|${spec.id === 'claude' ? s.voiceClaudeModel : ''}`
}

/** A brain the picker will not switch to until it is fixed in Settings. */
const UNAVAILABLE = new Set(['Needs key', 'Not installed', 'Not logged in'])
export function brainUnavailable(status: BrainStatus): boolean {
  return UNAVAILABLE.has(status.word)
}

/**
 * The bar's name for the brain: the one that will actually answer, and — when
 * the pick fell back for want of a key — the pick and why, in words
 * ("Claude · Gemini Live: no key").
 */
export function barBrainLabel(chosen: AgentBrainId, resolved: { brain: AgentBrainId; fallbackReason: string | null }): string {
  const answering = agentBrainSpec(resolved.brain).label
  if (!resolved.fallbackReason || chosen === resolved.brain) return answering
  return `${answering} · ${agentBrainSpec(chosen).label}: no key`
}

/**
 * Picked while Listen is on, does the new brain answer the next turn, or only
 * from the next press of Listen?
 *
 *  - A Parakeet conversation (session and json brains) to another Parakeet
 *    brain: the next turn. VoiceAgent and the host (electron/voice-agent/
 *    host.ts `route()`) read the setting again at every turn boundary.
 *  - A live realtime session to anything else: the session ends ("Conversation
 *    ended — brain changed", VoiceHubController V6) and the next press opens
 *    the new brain.
 *  - A Parakeet conversation to a realtime brain: the conversation carries on
 *    until it ends (B11); the next press opens the live session.
 */
export function brainSwitchWaits(opts: { listening: boolean; liveRealtime: boolean; current: AgentBrainId; target: AgentBrainId }): boolean {
  if (!opts.listening || opts.target === opts.current) return false
  return opts.liveRealtime || isRealtimeBrain(opts.target)
}

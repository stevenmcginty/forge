import { useSyncExternalStore } from 'react'
import type { GestureIntent } from '@/lib/stt-gesture'

/**
 * The bottom bar's two switches, and the one place anything reads them.
 *
 *   mode     what the mic (and the Right Ctrl talk key) is for.
 *              dictate  Parakeet words, raw, into wherever they are aimed —
 *                       exactly what the talk key has always done.
 *              agent    the main agent hears it: Gemini Live or GPT on their
 *                       own live session, or Claude through Parakeet (each
 *                       finished phrase is asked of the brain, not typed).
 *            Remembered across launches. Ctrl+Shift+L flips it.
 *
 *   target   where a typed line goes when you press Enter.
 *              forge    the main agent — the default, "Ask Forge…".
 *              pane     straight into the pane you are in, as keystrokes.
 *            Not remembered: every launch starts on Forge. Esc in the bar
 *            comes back to Forge.
 *
 * The voice hooks outside the hub UI (useDictation) read the mode through
 * `barMode()` and hand Agent-mode input to the handlers HubLayer registers
 * here, so nothing below src/components needs to import the hub controller.
 */

export type BarMode = 'dictate' | 'agent'
export type BarTarget = 'forge' | 'pane'

const MODE_KEY = 'forge.bar.mode'

function readMode(): BarMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'agent' ? 'agent' : 'dictate'
  } catch {
    return 'dictate'
  }
}

let mode: BarMode = typeof window === 'undefined' ? 'dictate' : readMode()
let target: BarTarget = 'forge'
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function barMode(): BarMode {
  return mode
}

export function setBarMode(next: BarMode): void {
  if (next === mode) return
  mode = next
  try {
    localStorage.setItem(MODE_KEY, next)
  } catch {
    /* remembered for this run only */
  }
  emit()
}

export function useBarMode(): BarMode {
  return useSyncExternalStore(subscribe, () => mode)
}

export function barTarget(): BarTarget {
  return target
}

export function setBarTarget(next: BarTarget): void {
  if (next === target) return
  target = next
  emit()
}

export function useBarTarget(): BarTarget {
  return useSyncExternalStore(subscribe, () => target)
}

/* ------------------------------------------------------ agent-mode voice */

export interface AgentVoice {
  /**
   * The talk key (or the bar's mic) in Agent mode. True when the agent took
   * it — a live provider opens or closes its own session. False hands it back
   * to Parakeet, whose phrases then come to `phrase` instead of being typed.
   */
  key(intent: GestureIntent): boolean
  /** A finished Parakeet phrase in Agent mode. True when the agent took it. */
  phrase(text: string): boolean
}

let agentVoice: AgentVoice | null = null

export function setAgentVoice(next: AgentVoice | null): void {
  agentVoice = next
}

/** The registered Agent-mode handlers, or null while Dictate is on (or none are mounted). */
export function agentVoiceNow(): AgentVoice | null {
  return mode === 'agent' ? agentVoice : null
}

/** The registered handlers whatever the mode — the Agent talk key uses these, so it works in Dictate mode too. */
export function agentVoiceAlways(): AgentVoice | null {
  return agentVoice
}

import { useSyncExternalStore } from 'react'
import type { GestureIntent } from '@/lib/stt-gesture'

/**
 * The bottom bar's target, and the legacy mic mode.
 *
 *   target   where a typed line goes when you press Enter.
 *              forge    the main agent — the default, "Ask Forge…".
 *              pane     straight into the pane you are in, as keystrokes.
 *            Not remembered: every launch starts on Forge. Esc in the bar
 *            comes back to Forge.
 *
 *   mode     LEGACY, pinned to 'dictate'. The bar no longer has a Dictate ⇄
 *            Agent switch: it has one Listen toggle (hub.start / hub.stop),
 *            and the Dictate key (Right Alt) is raw dictation into the
 *            focused pane. Pinned, `agentVoiceNow()` is always null, so that
 *            key and its phrases can never be taken for the agent by a stale
 *            'agent' left in localStorage by the old switch. The Listen key
 *            (Right Shift) and the toggle reach the agent through
 *            `agentVoiceAlways()` / the hub.
 *
 * The voice hooks outside the hub UI (useDictation) read these through
 * `barMode()`, `agentVoiceNow()` and `agentVoiceAlways()`, and hand agent
 * input to the handlers HubLayer registers here, so nothing below
 * src/components needs to import the hub controller.
 */

export type BarMode = 'dictate' | 'agent'
export type BarTarget = 'forge' | 'pane'

const MODE_KEY = 'forge.bar.mode'

/** The old switch's remembered 'agent' is dropped, once, so it cannot come back. */
function forgetStoredMode(): void {
  try {
    localStorage.removeItem(MODE_KEY)
  } catch {
    /* nothing stored, or no storage */
  }
}

if (typeof window !== 'undefined') forgetStoredMode()

const mode = 'dictate' as BarMode
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

/** Legacy: the mode is pinned to 'dictate'; any other value is ignored. */
export function setBarMode(next: BarMode): void {
  if (next !== mode) return
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

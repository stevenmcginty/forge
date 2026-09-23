import { useMemo, useSyncExternalStore } from 'react'
import type { VoiceHubProvider } from '@shared/types'
import { useVoiceHubController, type HubAction, type HubCaption, type HubPhase, type VoiceHubController } from '@/state/VoiceHubController'

/**
 * The hub UI's one view of the voice engine.
 *
 * Every surface here (the dock pill, the composer, the Talk surface) reads
 * `useHubView()` instead of the controller directly, for two reasons:
 *
 *   - the words. Each phase has one word and one glyph, used everywhere, so a
 *     state never reads "listening" in the dock and "ready" on the Talk page;
 *   - the preview. `window.__forgeHubPreview(patch)` paints any state onto the
 *     hub UI without a live session — the screenshot driver and a designer
 *     with no API key need it. It changes what the UI *shows* only; nothing
 *     here can start, stop or send anything. `__forgeHubPreview(null)` clears it.
 */

export interface HubPreview {
  phase?: HubPhase
  provider?: VoiceHubProvider
  muted?: boolean
  captions?: HubCaption[]
  actions?: HubAction[]
  discussionMode?: boolean
  discussionAvailable?: boolean
  sessionStartedAt?: number | null
  fallbackReason?: string | null
  /** Paint the composer as dictating (the Parakeet path), with this mic level. */
  dictating?: boolean
  dictationLevel?: number
}

let preview: HubPreview | null = null
const listeners = new Set<() => void>()

function setPreview(next: HubPreview | null): void {
  preview = next ? { ...(preview ?? {}), ...next } : null
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __forgeHubPreview?: (p: HubPreview | null) => void }).__forgeHubPreview = setPreview
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useHubPreview(): HubPreview | null {
  return useSyncExternalStore(subscribe, () => preview)
}

/** A believable voice for the preview: slow swells with a flutter on top. */
function previewLevels(phase: HubPhase): { mic: number; out: number } {
  const t = performance.now() / 1000
  const swell = 0.35 + 0.3 * Math.sin(t * 1.7) + 0.18 * Math.sin(t * 4.3 + 1) + 0.1 * Math.sin(t * 9.1)
  const v = Math.max(0.05, Math.min(1, swell))
  return phase === 'speaking' ? { mic: 0.04, out: v } : phase === 'listening' ? { mic: v, out: 0 } : { mic: 0, out: 0 }
}

export function useHubView(): VoiceHubController {
  const hub = useVoiceHubController()
  const p = useHubPreview()
  return useMemo(() => {
    if (!p) return hub
    const phase = p.phase ?? hub.phase
    const provider = p.provider ?? hub.provider
    return {
      ...hub,
      phase,
      provider,
      realtime: provider !== 'claude',
      muted: p.muted ?? hub.muted,
      handsFree: p.provider ? provider !== 'claude' || hub.handsFree : hub.handsFree,
      captions: p.captions ?? hub.captions,
      actions: p.actions ?? hub.actions,
      discussionMode: p.discussionMode ?? hub.discussionMode,
      discussionAvailable: p.discussionAvailable ?? (p.provider ? provider !== 'claude' : hub.discussionAvailable),
      sessionStartedAt: p.sessionStartedAt !== undefined ? p.sessionStartedAt : hub.sessionStartedAt,
      fallbackReason: p.fallbackReason !== undefined ? p.fallbackReason : hub.fallbackReason,
      readLevels: () => (p.phase ? previewLevels(phase) : hub.readLevels())
    }
  }, [hub, p])
}

/* --------------------------------------------------------- composer target */

/**
 * While live talk is on, where a typed line goes: to the voice brain (the
 * default — you are in a conversation) or, one click on the composer's target
 * chip, to the pane as always. Off-live it is ignored: the pane gets it.
 */
export type ComposerAim = 'hub' | 'pane'
let aim: ComposerAim = 'hub'
const aimListeners = new Set<() => void>()

export function composerAim(): ComposerAim {
  return aim
}

export function setComposerAim(next: ComposerAim): void {
  if (next === aim) return
  aim = next
  for (const l of aimListeners) l()
}

export function useComposerAim(): ComposerAim {
  return useSyncExternalStore(
    (cb) => {
      aimListeners.add(cb)
      return () => {
        aimListeners.delete(cb)
      }
    },
    () => aim
  )
}

/* ------------------------------------------------------------------ words */

/**
 * What the UI calls a state. `muted` and `offline` are not phases of their
 * own in the engine — muted is a flag over any live phase, offline is `off` —
 * but to the eye they are states, so they get their own word and glyph.
 */
export type HubLook = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error'

export function hubLook(phase: HubPhase, muted: boolean): HubLook {
  if (phase === 'off') return 'offline'
  if (phase === 'error') return 'error'
  if (muted && phase !== 'speaking' && phase !== 'thinking') return 'muted'
  return phase
}

export const LOOK_WORD: Record<HubLook, string> = {
  offline: 'offline',
  connecting: 'connecting',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  muted: 'muted',
  error: 'error'
}

/** A glyph per state, so the word is never the only non-colour signal either. */
export const LOOK_GLYPH: Record<HubLook, string> = {
  offline: '○',
  connecting: '◌',
  listening: '●',
  thinking: '◆',
  speaking: '▶',
  muted: '⊘',
  error: '!'
}

export const PROVIDER_SHORT: Record<VoiceHubProvider, string> = {
  claude: 'Claude',
  'gemini-live': 'Gemini Live',
  'gpt-realtime': 'GPT Realtime',
  'gpt-realtime-mini': 'GPT mini'
}

/** "Opened 2 Claude panes" etc. — the outcome glyph for an action. */
export const ACTION_GLYPH: Record<HubAction['status'], string> = {
  running: '⟳',
  ok: '✓',
  failed: '✕',
  planned: '◇'
}

export function isLive(phase: HubPhase): boolean {
  return phase !== 'off'
}

/** mm:ss (or h:mm:ss) since a session began. */
export function elapsed(since: number | null, now: number): string {
  if (!since) return ''
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

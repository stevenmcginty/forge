import { useMemo, useSyncExternalStore } from 'react'
import type { VoiceHubProvider } from '@shared/types'
import { useVoiceHubController, type HubAction, type HubCaption, type HubPhase, type VoiceHubController } from '@/state/VoiceHubController'

/**
 * The hub UI's one view of the voice engine.
 *
 * Every surface here (the dock pill, the composer) reads `useHubView()`
 * instead of the controller directly, for two reasons:
 *
 *   - the words. Each phase has one word and one glyph, used everywhere, so a
 *     state never reads "listening" in the pill and "ready" in the bar;
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
  /** The recogniser's honest state on the Claude path (see HubExtras). */
  capturing?: boolean
  starting?: boolean
  error?: string | null
}

/**
 * Fields the engine may grow (B7's routing API) that the UI reads when they
 * are there and does without when they are not.
 */
export interface HubExtras {
  /** Ask the main agent. Falls back to `askText`. */
  ask?: (text: string, opts?: { via?: 'typed' | 'voice' }) => void
  /** Raw text into a pane, no brain. Falls back to typing it by hand. */
  dictateTo?: (paneId: string, text: string, opts?: { submit?: boolean }) => boolean
  /**
   * The Claude path only: is the recogniser really recording? A moving mic
   * level is not proof — undefined counts as "no".
   */
  capturing?: boolean
  /** The recogniser is still warming up; capture begins by itself. */
  starting?: boolean
  /** A short reason in words, when the engine already has one. */
  errorReason?: string | null
  /** The mic state in words, from the engine ("Mic on · not recording"). */
  listenNote?: string
  /** The one Agent brain, in words ("Claude (text)"). */
  brainLabel?: string
}

export type HubView = VoiceHubController & HubExtras

/** Ask the main agent, through whichever call the engine has. */
export function hubAsk(hub: HubView, text: string, via: 'typed' | 'voice' = 'typed'): void {
  if (hub.ask) hub.ask(text, { via })
  else hub.askText(text)
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

export function useHubView(): HubView {
  const hub = useVoiceHubController() as HubView
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
      capturing: p.capturing ?? hub.capturing,
      starting: p.starting ?? hub.starting,
      error: p.error !== undefined ? p.error : hub.error,
      errorReason: p.error !== undefined ? null : hub.errorReason,
      // A previewed brain is named by the preview, not by the setting.
      brainLabel: p.provider ? PROVIDER_SHORT[provider] : hub.brainLabel,
      listenNote: p.phase ? '' : hub.listenNote,
      readLevels: () => (p.phase ? previewLevels(phase) : hub.readLevels())
    }
  }, [hub, p])
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

/* ---------------------------------------------------------- error reasons */

/**
 * A provider error in a few words — "Gemini: key refused", "Gemini: free-tier
 * limit (429)" — for the pill. The full text stays one click away.
 */
export function errorReason(provider: VoiceHubProvider, raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  const who = /gemini/i.test(text)
    ? 'Gemini'
    : /openai|gpt/i.test(text)
      ? 'OpenAI'
      : provider === 'gemini-live'
        ? 'Gemini'
        : provider === 'claude'
          ? 'Claude'
          : 'OpenAI'
  if (!text) return `${who}: stopped`
  const why = /no .*key is set|no key/i.test(text)
    ? 'no key set'
    : /\b40[13]\b|refused|api key not valid|invalid.{0,12}key|unauthori[sz]ed|permission denied/i.test(text)
      ? 'key refused'
      : /\b429\b|quota|rate.?limit|resource.?exhausted|too many requests/i.test(text)
        ? who === 'Gemini'
          ? 'free-tier limit (429)'
          : 'rate limit (429)'
        : /\b100[78]\b|setup|invalid argument|not supported|unsupported|model .{0,40}not found|\b400\b/i.test(text)
          ? 'setup rejected'
          : /could not reach|could not open|network|enotfound|econn|timed? ?out|offline/i.test(text)
            ? "can't connect"
            : /microphone|getusermedia|notallowederror|\bmic\b/i.test(text)
              ? 'mic blocked'
              : /closed the connection|disconnected/i.test(text)
                ? 'connection closed'
                : text.replace(/^(gemini|openai)[^:]*:\s*/i, '').split(/[.—\n]/)[0]!.slice(0, 36).trim() || 'failed'
  return `${who}: ${why}`
}

/* ---------------------------------------------------------- the one state */

/** The brain in words, as the bar and the pill name it. */
export function brainWord(hub: Pick<HubView, 'provider' | 'availability' | 'brainLabel'>): string {
  if (hub.brainLabel) return hub.brainLabel
  if (hub.provider !== 'claude') return PROVIDER_SHORT[hub.provider]
  const anyLive = hub.availability['gemini-live'] || hub.availability['gpt-realtime'] || hub.availability['gpt-realtime-mini']
  return anyLive ? 'Claude' : 'Claude (text)'
}

export interface DictationLike {
  phase: string
  listening: boolean
  needsSetup: boolean
  /** Wake mode: listening for the wake word is not recording. */
  wake?: boolean
  capturing?: boolean
}

export interface VoiceState {
  look: HubLook
  glyph: string
  word: string
  /** The mic is open (the bars move, the rim lights). */
  micOn: boolean
  /** Really recording — the only case the word may say "listening". */
  recording: boolean
}

const NOT_RECORDING = 'mic on · not recording'

/**
 * Agent mode is hands-free: the end of a sentence sends it, and the mic stays
 * open for the next turn. The engine's own words win when it has them.
 */
function agentListening(hub: HubView): string {
  const note = hub.listenNote
  return note && /^listening/i.test(note) ? note.charAt(0).toLowerCase() + note.slice(1) : 'listening · next turn'
}

function dictationState(d: DictationLike): VoiceState {
  if (d.needsSetup) return { look: 'error', glyph: '!', word: 'set up', micOn: false, recording: false }
  if (d.phase === 'starting') return { look: 'connecting', glyph: LOOK_GLYPH.connecting, word: 'starting…', micOn: false, recording: false }
  if (d.listening) {
    if (d.wake && !d.capturing) return { look: 'muted', glyph: '◐', word: NOT_RECORDING, micOn: true, recording: false }
    return { look: 'listening', glyph: LOOK_GLYPH.listening, word: 'listening', micOn: true, recording: true }
  }
  if (d.phase === 'finishing') return { look: 'thinking', glyph: LOOK_GLYPH.thinking, word: 'writing', micOn: false, recording: false }
  return { look: 'offline', glyph: LOOK_GLYPH.offline, word: 'ready', micOn: false, recording: false }
}

/**
 * What the voice side is doing, in one word — honest about recording. On the
 * Claude path a moving mic level with no capture reads "mic on · not
 * recording", never "listening".
 */
export function voiceState(mode: 'dictate' | 'agent', hub: HubView, d: DictationLike): VoiceState {
  if (mode === 'dictate') return dictationState(d)
  const phase = hub.phase
  if (phase === 'error') {
    return { look: 'error', glyph: '!', word: hub.errorReason ?? errorReason(hub.provider, hub.error), micOn: false, recording: false }
  }
  if (phase === 'thinking' || phase === 'speaking') {
    return { look: phase, glyph: LOOK_GLYPH[phase], word: LOOK_WORD[phase], micOn: phase === 'speaking' ? false : !hub.muted, recording: false }
  }
  if (hub.realtime) {
    if (phase === 'off') return { look: 'offline', glyph: LOOK_GLYPH.offline, word: 'ready', micOn: false, recording: false }
    if (phase === 'connecting') return { look: 'connecting', glyph: LOOK_GLYPH.connecting, word: 'connecting…', micOn: false, recording: false }
    if (hub.muted) return { look: 'muted', glyph: LOOK_GLYPH.muted, word: 'muted', micOn: false, recording: false }
    return { look: 'listening', glyph: LOOK_GLYPH.listening, word: agentListening(hub), micOn: true, recording: true }
  }
  // Claude: the armed agent's own session, or Parakeet phrases asked of it.
  if (hub.starting || phase === 'connecting') {
    return { look: 'connecting', glyph: LOOK_GLYPH.connecting, word: 'starting…', micOn: false, recording: false }
  }
  if (phase === 'listening') {
    if (hub.muted) return { look: 'muted', glyph: LOOK_GLYPH.muted, word: 'muted', micOn: false, recording: false }
    // The engine's own words win when it has them ('Waiting for "Hey Jarvis"').
    const note = hub.listenNote?.toLowerCase()
    return hub.capturing === true
      ? { look: 'listening', glyph: LOOK_GLYPH.listening, word: agentListening(hub), micOn: true, recording: true }
      : { look: 'muted', glyph: '◐', word: note && note !== 'listening' && note !== 'off' ? hub.listenNote! : NOT_RECORDING, micOn: true, recording: false }
  }
  return dictationState(d)
}

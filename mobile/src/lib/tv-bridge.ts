/**
 * The seam between this WebView and the TV's native layer.
 *
 * On the Fire TV build, YouTube lives in a second, natively-managed WebView —
 * signed in, and impossible to host in here (youtube.com refuses to be
 * framed, and an embed cannot be signed in). But this WebView holds the only
 * authenticated socket to the desktop, so it is the side that *learns*
 * things: a `tv-play` frame arriving, a session exiting. This module is how
 * those facts leave the web layer.
 *
 * The transport is a `CustomEvent` named `forge:tv` dispatched on `window`,
 * with the event object in `detail`. Chosen over a callback registry because
 * it is reachable from a Capacitor plugin without this module in scope: the
 * native side (or its tiny injected JS shim) runs
 *
 *     window.addEventListener('forge:tv', (e) => Plugin.notify(e.detail))
 *
 * and needs nothing else from us — no import, no init call, no ordering
 * dance at startup. `tvBridge.onNative` wraps the same listener for callers
 * that *are* in scope (and for tests), with unsubscription included.
 *
 * Dependency-free on purpose, like shared/mobile.ts: it must be callable
 * from anywhere in the web layer and hookable from a plugin that knows only
 * the event name. On the phone routes nothing listens and emits are inert —
 * an event nobody hears costs nothing.
 */

/** The custom event's stable name. The native layer hard-codes this string. */
export const TV_BRIDGE_EVENT = 'forge:tv'

/**
 * What crosses the seam. Additions must be additive — the native layer and
 * this bundle do not update in lockstep, so an old listener must be able to
 * ignore a new `kind` unharmed.
 */
export type TvBridgeEvent =
  /** The desktop relayed a video id (already validated by the Link). */
  | { kind: 'tv-play'; video: string }
  /**
   * A pane's shell exited. Sparse by design — exits are the one wall event
   * worth interrupting a fullscreen video for; starts, output and layout
   * changes stay on the wall. `session` is the human name ("Project · pane"),
   * because the native layer has no picture to resolve an id against.
   */
  | { kind: 'session-exit'; session: string; exitCode: number }
  /**
   * The mirror has picked up a pointer, or put it down.
   *
   * The one event that changes what the *remote* means rather than what the
   * screen shows. While a pointer is running the arrows belong to it, and the
   * native layer must stop claiming a held Left or Right for its own panel
   * crossing — that press is "keep moving left" now. Menu goes the other way:
   * useless to a page in every other state, it becomes the scroll toggle and is
   * forwarded here instead of cycling the layout.
   *
   * Sent on every change rather than assumed, because the two layers can
   * disagree — a WebView that reloads with the pointer up would otherwise leave
   * the native side holding a grammar this page has forgotten.
   */
  | { kind: 'control'; on: boolean }

/**
 * The other direction: the native layer answering a question this one asked.
 *
 * Only one question exists — "which Forge is on this wifi?" — and it has to be
 * asked natively, because a WebView cannot send a UDP broadcast and a broadcast
 * is the only way to find an address nobody has typed. The reply arrives as the
 * raw strings the desktops sent, parsed here rather than there: shared/mobile.ts
 * already knows that shape and a second implementation in Kotlin would be one
 * that could drift.
 */
export const TV_FOUND_EVENT = 'forge:tv-found'


/**
 * The third seam, native → page: words a shell heard.
 *
 * River Hub, the home screen that hosts this page on Steve's Fire TV, turns a
 * held remote button and a spoken sentence into text, and hands it over as
 *
 *     window.dispatchEvent(new CustomEvent('forge:voice-text', { detail }))
 *
 * with `detail` a `VoiceText`. The page puts the words into whichever typing
 * box is open — never presses Enter, never sends: what was heard is a draft,
 * and Steve submits it himself with the Enter cap — and answers each event
 * exactly once through `ForgeTvNative.voiceTextUsed(id, seq, used)`, so the
 * shell can say "nowhere to put that" rather than let the words vanish.
 *
 * The contract belongs to the shell; this side only reads it.
 */
export const VOICE_TEXT_EVENT = 'forge:voice-text'

/** One heard phrase, as the shell sends it. */
export interface VoiceText {
  id: string
  seq: number
  text: string
  final: boolean
}

/** What the native side exposes. Absent in a browser, and that is a normal
 *  state — the address field is the fallback and always has been. */
interface TvNative {
  discover?: () => void
  /** River Hub's half of the voice seam. Older shells and Forge's own APK lack it. */
  voiceTextUsed?: (id: string, seq: number, used: boolean) => void
}

function native(): TvNative | null {
  const found = (window as unknown as { ForgeTvNative?: TvNative }).ForgeTvNative
  return found && typeof found.discover === 'function' ? found : null
}

export const tvBridge = {
  /** Hand an event to whoever is listening — natively or in a test. */
  emit(event: TvBridgeEvent): void {
    window.dispatchEvent(new CustomEvent(TV_BRIDGE_EVENT, { detail: event }))
  },

  /** Is there a native layer able to search the network at all? */
  canFindDesktops(): boolean {
    return native() !== null
  },

  /**
   * Ask the network who is out there. Returns false when nothing can ask —
   * a browser preview, or an APK older than this seam — so the caller can say
   * "type the address" instead of spinning over a question nobody heard.
   */
  findDesktops(): boolean {
    const layer = native()
    if (!layer?.discover) return false
    layer.discover()
    return true
  },

  /** The replies to `findDesktops`, verbatim. Parsing is the caller's. */
  onDesktopsFound(handler: (replies: string[]) => void): () => void {
    const listen = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      handler(Array.isArray(detail) ? detail.filter((item): item is string => typeof item === 'string') : [])
    }
    window.addEventListener(TV_FOUND_EVENT, listen)
    return () => window.removeEventListener(TV_FOUND_EVENT, listen)
  },

  /**
   * Listen from the JS side. Returns the unsubscribe, in the same
   * function-returning-cleanup shape every effect in this app uses.
   */
  onNative(handler: (event: TvBridgeEvent) => void): () => void {
    const listen = (event: Event): void => handler((event as CustomEvent<TvBridgeEvent>).detail)
    window.addEventListener(TV_BRIDGE_EVENT, listen)
    return () => window.removeEventListener(TV_BRIDGE_EVENT, listen)
  }
}

/**
 * A typing box that will take heard words. Returns whether it did — false is
 * "I am here but closed", which lets the next one down be asked.
 */
export type VoiceTarget = (text: string) => boolean

/** Registered boxes, oldest first. Asked newest first. */
const voiceTargets: VoiceTarget[] = []

/**
 * Offer heard words to the typing boxes on screen. The most recently
 * registered box that takes them wins; the cleanup takes the box back out, in
 * the same function-returning-cleanup shape every effect in this app uses.
 */
export function registerVoiceTarget(fn: VoiceTarget): () => void {
  voiceTargets.push(fn)
  return () => {
    const at = voiceTargets.lastIndexOf(fn)
    if (at >= 0) voiceTargets.splice(at, 1)
  }
}

/**
 * The draft with heard words added on the end: trimmed, and one space between
 * when the draft has words of its own that do not already end in whitespace.
 */
export function appendVoiceText(draft: string, text: string): string {
  const words = text.trim()
  if (!words) return draft
  return draft && !/\s$/.test(draft) ? `${draft} ${words}` : `${draft}${words}`
}

/** Hand words to the first box that takes them. Answers whether one did. */
export function deliverVoiceText(text: string): boolean {
  const words = text.trim()
  if (!words) return false
  for (let i = voiceTargets.length - 1; i >= 0; i--) {
    try {
      if (voiceTargets[i](words)) return true
    } catch {
      /* a box that throws is a box that did not take them; ask the next */
    }
  }
  return false
}

/**
 * The one listener, bound at load so an event that arrives while no box is on
 * screen — the wall, the menu — is still answered, with `used: false`.
 * A detail without an id and a seq cannot be answered at all and is ignored.
 */
function onVoiceText(event: Event): void {
  const detail = (event as CustomEvent<Partial<VoiceText> | null>).detail
  if (!detail || typeof detail.id !== 'string' || typeof detail.seq !== 'number') return
  const used = typeof detail.text === 'string' && deliverVoiceText(detail.text)
  const layer = (window as unknown as { ForgeTvNative?: TvNative }).ForgeTvNative
  if (layer && typeof layer.voiceTextUsed === 'function') {
    try {
      layer.voiceTextUsed(detail.id, detail.seq, used)
    } catch {
      /* the shell went away mid-answer; nothing here can do better */
    }
  }
}

if (typeof window !== 'undefined') window.addEventListener(VOICE_TEXT_EVENT, onVoiceText)

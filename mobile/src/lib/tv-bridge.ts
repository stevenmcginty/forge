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

export const tvBridge = {
  /** Hand an event to whoever is listening — natively or in a test. */
  emit(event: TvBridgeEvent): void {
    window.dispatchEvent(new CustomEvent(TV_BRIDGE_EVENT, { detail: event }))
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

/**
 * Pane attention, published once and heard by anyone who cares.
 *
 * The renderer is the only thing in Forge that can tell a pane asking a
 * question from a pane that has gone quiet: it watches the screen text and
 * reports the transition on `IPC.webAttention` with a one-line prompt. Until
 * now Forge Web was the only listener, so that handler lived in
 * electron/web-host.ts and returned early whenever the link was switched off.
 *
 * Foreman needs the same signal — it *is* Foreman's trigger, the thing that
 * says "the terminal is waiting for an answer" — and it needs it whether or not
 * anybody has ever turned Forge Web on. Hence this: web-host publishes here
 * before it does anything of its own, and every subscriber gets the event.
 *
 * Deliberately tiny and Electron-free. A bus with a policy in it is a second
 * place for the attention rules to disagree with the renderer.
 */

/** What the renderer says a pane just became. */
export type AttentionState = 'asking' | 'done' | 'idle'

export interface AttentionEvent {
  /** The PTY session id — the same id the layout and the pty host use. */
  paneId: string
  state: AttentionState
  /** The one-line question, when there is one. Already capped by the sender. */
  prompt: string
}

type Listener = (event: AttentionEvent) => void

const listeners = new Set<Listener>()

/** Subscribe. Returns the unsubscribe, in the repo's usual shape. */
export function onAttention(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Tell everyone. One bad subscriber must not stop the next one hearing it —
 * the same isolation the PTY sinks get, and for the same reason: Foreman
 * throwing must not cost Forge Web its push notification.
 */
export function publishAttention(event: AttentionEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[attention] listener failed:', err)
    }
  }
}

/** Tests and teardown only. */
export function clearAttentionListeners(): void {
  listeners.clear()
}

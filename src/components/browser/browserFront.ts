/**
 * Which browser tab is in front, outside React — and a way to ask for one.
 *
 * BrowserSurfaces owns the front tab (its `activeId`); it publishes it here, so
 * show_view (src/lib/showView.ts) can say what is on screen, and it honours a
 * tab asked for here once that tab is in its list — on mount (the surface
 * unmounts with its mode) or while it is up. A request that never lands (the
 * tab closed first) lapses after a few seconds instead of jumping later.
 */

const REQUEST_TTL_MS = 5000

let front: string | null = null
let requested: { id: string; at: number } | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of listeners) cb()
}

export const browserFront = {
  /** The tab last in front (kept while the browser is off stage). */
  front: (): string | null => front,

  /** BrowserSurfaces: this tab is in front now. */
  publish(id: string | null): void {
    if (id === front) return
    front = id
    emit()
  },

  /** Ask for a tab to come to the front. */
  request(id: string): void {
    requested = { id, at: Date.now() }
    emit()
  },

  /** The tab asked for, fresh or not — a stable snapshot for useSyncExternalStore. */
  pending: (): string | null => requested?.id ?? null,

  /** The tab asked for, while the ask is fresh; null otherwise. */
  requested: (): string | null => (requested && Date.now() - requested.at < REQUEST_TTL_MS ? requested.id : null),

  /** BrowserSurfaces: the ask is done (or `id` is no longer the one asked for). */
  settle(id: string): void {
    if (requested?.id !== id) return
    requested = null
    emit()
  },

  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }
}

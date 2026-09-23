import type { BrowserApi } from '@shared/browser'

/**
 * `window.forgeBrowser` (exposed by electron/preload.ts beside `forgeHub`), or
 * null on a preload that predates it.
 *
 * Always reached through here, never directly: the desktop hot-reloads the
 * renderer but not the preload, and an unguarded call to a method the running
 * preload lacks throws in an effect and unmounts the whole renderer (which also
 * strands the phone). A null here means "restart Forge", and says so once.
 */
let warned = false

export function browserBridge(): BrowserApi | null {
  const api = (window as unknown as { forgeBrowser?: BrowserApi }).forgeBrowser ?? null
  if (!api && !warned) {
    warned = true
    console.error('[browser] window.forgeBrowser is missing — the preload is older than the built-in browser. Restart Forge.')
  }
  return api
}

import type { HubApi } from '@shared/hub'

/**
 * `window.forgeHub`, or null.
 *
 * Null whenever the preload that is running predates the hub (a stale out/
 * bundle, the web client, a test page). Every caller must handle that: an
 * unguarded `window.forgeHub.x()` on a stale preload throws during render and
 * takes the whole renderer — and the phone's layout ops with it — down.
 */
export function hubApi(): HubApi | null {
  const hub = (window as unknown as { forgeHub?: Partial<HubApi> }).forgeHub
  return hub && hub.canvas && hub.prompts && hub.keymap ? (hub as HubApi) : null
}

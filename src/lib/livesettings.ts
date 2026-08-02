import type { Settings } from '@shared/types'

/**
 * The current Settings, reachable outside React.
 *
 * AppState owns the settings and keeps this in step — see the effect that calls
 * `setLiveSettings(state.settings)` in AppState.tsx. The terminal host needs
 * the exit-chime toggle but deliberately lives outside the React tree (panes
 * keep running with no component mounted), so this is the bridge: any renderer
 * module that cannot use hooks reads the latest settings back through
 * `getLiveSettings`, and gets null only before the app has ever held any.
 */
let current: Settings | null = null

export function setLiveSettings(settings: Settings): void {
  current = settings
}

export function getLiveSettings(): Settings | null {
  return current
}

import { useSyncExternalStore } from 'react'

/**
 * Where the voice bar lives: in the top bar (the default — the stage keeps the
 * whole height, which is what a laptop screen needs) or clipped to the bottom
 * edge, as the dock it used to be.
 *
 * Kept in this window's localStorage like the backdrop (lib/backdrop.ts): it is
 * a per-machine layout choice — a laptop and a big monitor want different
 * answers — and it needs no settings.json field. Every reader goes through
 * `useVoiceBarPlace`, so moving it into Settings later is a change here only.
 */

export type VoiceBarPlace = 'top' | 'bottom'

const KEY = 'forge:voice-bar-place'

function load(): VoiceBarPlace {
  try {
    return localStorage.getItem(KEY) === 'bottom' ? 'bottom' : 'top'
  } catch {
    return 'top'
  }
}

let current: VoiceBarPlace = load()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setVoiceBarPlace(place: VoiceBarPlace): void {
  if (place === current) return
  current = place
  try {
    localStorage.setItem(KEY, place)
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
  for (const cb of listeners) cb()
}

export function useVoiceBarPlace(): VoiceBarPlace {
  return useSyncExternalStore(subscribe, () => current)
}

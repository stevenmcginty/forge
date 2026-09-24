import { useSyncExternalStore } from 'react'

/**
 * Where the voice bar lives: clipped to the bottom edge (the default — Steve
 * finds it reads cleaner there, and accepts the height it costs) or in the top
 * bar, where the stage keeps the whole height.
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
    return localStorage.getItem(KEY) === 'top' ? 'top' : 'bottom'
  } catch {
    return 'bottom'
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

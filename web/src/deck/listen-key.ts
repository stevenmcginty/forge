import { useSyncExternalStore } from 'react'
import { formatCombo, normaliseTalkKey } from '@/lib/keymap'
import { dictationKey } from './dictation-key'

/**
 * Listen's key in this browser — the voice agent: a tap turns it on or off, a
 * hold turns it on and leaves it listening. Right Alt by default — the swap
 * Steve made on the desktop on 2026-09-28 (Right Shift is the Dictate key
 * there, and here: ./dictation-key.ts). On a UK layout Right Alt is AltGr; ../lib/talk-key.ts
 * reads it as itself, not as the Left Ctrl Windows sends first.
 *
 * Remembered per browser (localStorage), never sent to the desktop, like D's
 * key. A stored value that is not a talk key (see `normaliseTalkKey`) reads as
 * the default. D's key is refused here, with words to show, never swapped in
 * silently: one key does one job.
 */
export const DEFAULT_LISTEN_KEY = 'AltRight'

const KEY = 'forge-web-listen-key'

function stored(): string {
  try {
    const raw = window.localStorage.getItem(KEY)
    return (raw && normaliseTalkKey(raw)) || DEFAULT_LISTEN_KEY
  } catch {
    return DEFAULT_LISTEN_KEY
  }
}

let current = stored()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab of this page changed it.
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== KEY) return
    const next = stored()
    if (next === current) return
    current = next
    notify()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export function listenKey(): string {
  return current
}

export function useListenKey(): string {
  return useSyncExternalStore(subscribe, listenKey, listenKey)
}

/** The key as words: "Right Alt". */
export function listenKeyName(code: string): string {
  return formatCombo(code)
}

/**
 * Store a new key (a KeyboardEvent.code). Anything that is not a talk key is
 * ignored. D's key is refused: the sentence that says so comes back, for the …
 * menu to show. Null when stored (or nothing to do).
 */
export function setListenKey(code: string): string | null {
  const next = normaliseTalkKey(code)
  if (!next || next === current) return null
  if (next === dictationKey()) return `${formatCombo(next)} is already the dictation key. One key can only do one job.`
  current = next
  try {
    if (next === DEFAULT_LISTEN_KEY) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, next)
  } catch {
    /* this page still uses it */
  }
  notify()
  return null
}

import { useSyncExternalStore } from 'react'
import { formatCombo, normaliseTalkKey } from '@/lib/keymap'

/**
 * D's key in this browser: tap to start or stop, hold to talk while it is
 * down. Right Alt by default, as on the desktop (5debc87) — and some
 * keyboards (Chromebooks) have no Right Ctrl at all.
 *
 * Remembered per browser (localStorage), never sent to the desktop, like the
 * theme: the desktop's own Dictate key is its own setting. A stored value that
 * is not a talk key (see `normaliseTalkKey`) reads as the default.
 */
export const DEFAULT_DICTATION_KEY = 'AltRight'

const KEY = 'forge-web-dictation-key'

function stored(): string {
  try {
    const raw = window.localStorage.getItem(KEY)
    return (raw && normaliseTalkKey(raw)) || DEFAULT_DICTATION_KEY
  } catch {
    return DEFAULT_DICTATION_KEY
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

export function dictationKey(): string {
  return current
}

export function useDictationKey(): string {
  return useSyncExternalStore(subscribe, dictationKey, dictationKey)
}

/** The key as words: "Right Alt". */
export function dictationKeyName(code: string): string {
  return formatCombo(code)
}

/** Store a new key (a KeyboardEvent.code). Anything that is not a talk key is ignored. */
export function setDictationKey(code: string): void {
  const next = normaliseTalkKey(code)
  if (!next || next === current) return
  current = next
  try {
    if (next === DEFAULT_DICTATION_KEY) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, next)
  } catch {
    /* this page still uses it */
  }
  notify()
}

/* A "press the new key" field is recording: D's key, Esc and the deck's other keys stand down. */
let suspensions = 0

export function dictationKeySuspended(): boolean {
  return suspensions > 0
}

/** Hold the deck's keys off while a key is recorded. Returns the release. */
export function suspendDictationKey(): () => void {
  suspensions++
  let released = false
  return () => {
    if (released) return
    released = true
    suspensions--
  }
}

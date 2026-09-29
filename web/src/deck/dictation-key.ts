import { useSyncExternalStore } from 'react'
import { formatCombo, normaliseTalkKey } from '@/lib/keymap'
import { listenKey } from './listen-key'

/**
 * D's key in this browser: tap to start or stop, hold to talk while it is
 * down. Right Shift by default — the swap Steve made on the desktop on
 * 2026-09-28 (Right Alt is the voice agent's key there, and here:
 * ./listen-key.ts).
 *
 * Remembered per browser (localStorage), never sent to the desktop, like the
 * theme: the desktop's own Dictate key is its own setting. A stored value that
 * is not a talk key (see `normaliseTalkKey`) reads as the default; a browser
 * that stored its own key keeps it.
 *
 * One key does one job: the voice agent's key is refused here, with words to
 * show, never swapped in silently (the desktop's VoiceKeys rule).
 */
export const DEFAULT_DICTATION_KEY = 'ShiftRight'

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

/** The key as words: "Right Shift". */
export function dictationKeyName(code: string): string {
  return formatCombo(code)
}

/**
 * Store a new key (a KeyboardEvent.code). Anything that is not a talk key is
 * ignored. The voice agent's key is refused: the sentence that says so comes
 * back, for the … menu to show. Null when stored (or nothing to do).
 */
export function setDictationKey(code: string): string | null {
  const next = normaliseTalkKey(code)
  if (!next || next === current) return null
  if (next === listenKey()) return `${formatCombo(next)} is already the voice agent key. One key can only do one job.`
  current = next
  try {
    if (next === DEFAULT_DICTATION_KEY) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, next)
  } catch {
    /* this page still uses it */
  }
  notify()
  return null
}

/* A "press the new key" field is recording: D's key, Listen's key, Esc and the deck's other keys stand down. */
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

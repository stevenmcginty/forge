import { useSyncExternalStore } from 'react'

/**
 * The big bar's words: what is in Composer's text box, held here rather than
 * in the component, so the mini bar can take them when Forge is minimised and
 * hand them back when it is restored (docs/MINI-BAR.md, 5.4).
 *
 * The same small store as barMode.ts and barDictation.ts. Composer reads it
 * with `useBarDraft()` and writes it with `setBarDraft()`, exactly as it used
 * its own state: an updater function works too. In memory only, so nothing
 * typed here is written to disk.
 */

let draft = ''
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function barDraft(): string {
  return draft
}

export function setBarDraft(next: string | ((prev: string) => string)): void {
  const value = typeof next === 'function' ? next(draft) : next
  if (value === draft) return
  draft = value
  for (const l of listeners) l()
}

export function useBarDraft(): string {
  return useSyncExternalStore(subscribe, () => draft)
}

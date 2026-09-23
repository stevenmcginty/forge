import { useSyncExternalStore } from 'react'
import { desktopFacts, subscribeDesktopFacts, type DeskFacts } from './client'

/**
 * The React side of `desktopFacts` in lib/client.ts: what the desktop this page
 * last reached announced in `hello-ok.features`, and how its socket was let in.
 * Re-renders on the next `hello-ok` that changes either.
 */
export function useDeskFacts(): DeskFacts {
  return useSyncExternalStore(subscribeDesktopFacts, desktopFacts, desktopFacts)
}

/** Does the desktop announce `feature`? False until the first `hello-ok`, and from an old desktop. */
export function useDeskFeature(feature: string): boolean {
  return useDeskFacts().features.includes(feature)
}

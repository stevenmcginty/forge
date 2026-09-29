import { useSyncExternalStore } from 'react'

/**
 * The theme this browser wears, and how to change it, for the phone's More
 * sheet. The truth stays in deck/theme.ts `useDeckTheme`, which Workspace
 * holds; this only hands its value and setter to a sheet that sits under the
 * top bar, several components away, without threading props through them.
 */

export interface ThemeChoice {
  themeId: string
  setTheme: (id: string) => void
}

let current: ThemeChoice | null = null
const listeners = new Set<() => void>()

export function publishThemeChoice(next: ThemeChoice): void {
  if (current?.themeId === next.themeId && current.setTheme === next.setTheme) return
  current = next
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useThemeChoice(): ThemeChoice | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

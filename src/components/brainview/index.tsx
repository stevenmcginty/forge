import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { usePresence } from '@/lib/motion'
import { BrainMap } from './BrainMap'

/**
 * Forge Brain's expanded view (the map): open state and its host.
 *
 *  - `<BrainMapHost />` is mounted once in App.tsx and renders nothing while
 *    closed — no canvas, no loop, no listeners beyond one window event.
 *  - `openBrainMap()` / `closeBrainMap()` / `toggleBrainMap()` drive it from
 *    anywhere (the brain drop-down's Expand, a shortcut).
 *  - The same three are reachable as a window event, `forge:brain-map` with
 *    detail `'open' | 'close' | 'toggle'`, for code that cannot import this
 *    module (and for driving it from a test harness).
 */

let open = false
const listeners = new Set<() => void>()

function setOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const BRAIN_MAP_EVENT = 'forge:brain-map'

export function openBrainMap(): void {
  setOpen(true)
}

export function closeBrainMap(): void {
  setOpen(false)
}

export function toggleBrainMap(): void {
  setOpen(!open)
}

/** Is the map up right now? */
export function isBrainMapOpen(): boolean {
  return open
}

export function BrainMapHost(): ReactNode {
  const isOpen = useSyncExternalStore(subscribe, () => open)
  const { mounted, closing } = usePresence(isOpen, 200)

  useEffect(() => {
    const onEvent = (e: Event): void => {
      const what = (e as CustomEvent<unknown>).detail
      if (what === 'open') openBrainMap()
      else if (what === 'close') closeBrainMap()
      else if (what === 'toggle') toggleBrainMap()
    }
    window.addEventListener(BRAIN_MAP_EVENT, onEvent)
    return () => window.removeEventListener(BRAIN_MAP_EVENT, onEvent)
  }, [])

  if (!mounted) return null
  return <BrainMap closing={closing} onClose={closeBrainMap} />
}

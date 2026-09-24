import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { usePresence } from '@/lib/motion'

/**
 * The deck face's sheets and its "…" menu: one open at a time, the rule
 * src/components/shell/Sheet.tsx keeps on the desktop. A store rather than
 * state in the shell because the triggers (the dock's project pill, the top
 * bar's Agents button, the menu button, the voice agent chip) and the sheets
 * live in different components.
 */
export type DeckSheetId = 'projects' | 'agents' | 'menu' | 'voice'

let open: DeckSheetId | null = null
const listeners = new Set<() => void>()

export const deckSheet = {
  get: (): DeckSheetId | null => open,
  set: (next: DeckSheetId | null): void => {
    if (next === open) return
    open = next
    listeners.forEach((fn) => fn())
  },
  toggle: (id: DeckSheetId): void => deckSheet.set(open === id ? null : id)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDeckSheet(): DeckSheetId | null {
  return useSyncExternalStore(subscribe, deckSheet.get, deckSheet.get)
}

/**
 * One sheet. Opaque (a sheet can cover a live terminal, and a blur over
 * streaming output would be recomputed every frame), rises with the deck's pop
 * spring, and goes on Esc or a click anywhere outside — except inside a
 * popover it opened (the agent chooser, the folder picker, a tab's confirm) or
 * on the button that toggles it, which toggles it itself.
 */
export function DeckSheet({
  id,
  className,
  label,
  children
}: {
  id: DeckSheetId
  className: string
  label: string
  children: ReactNode
}): ReactNode {
  const isOpen = useDeckSheet() === id
  const { mounted, closing } = usePresence(isOpen, 160)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // A popover the sheet opened takes its own Esc first.
      if (document.querySelector('.popover')) return
      e.preventDefault()
      deckSheet.set(null)
    }
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t)) return
      if (t.closest(`[data-sheet-toggle='${id}']`)) return
      if (t.closest('.popover, .bsheet-layer')) return
      deckSheet.set(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [id, isOpen])

  if (!mounted) return null
  return (
    <div
      ref={ref}
      className={`dk-sheet ${className}`}
      data-state={closing ? 'closing' : 'open'}
      role="dialog"
      aria-label={label}
    >
      {children}
    </div>
  )
}

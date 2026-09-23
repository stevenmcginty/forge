import { useEffect, useRef, type ReactNode } from 'react'
import { usePresence } from '@/lib/motion'
import { shellSheet, useShellSheet, type ShellSheet } from '@/lib/shellSlots'

/**
 * A sheet that rises out of the dock (or drops from the top bar): one of the
 * shell's three, only one open at a time.
 *
 * Opaque rather than glass — a sheet can cover a live terminal, and a
 * backdrop blur over streaming output would be recomputed every frame. Esc or a
 * click anywhere outside closes it, except a click inside a popover or panel
 * the sheet itself opened (the rail's expanded Git panel, a menu).
 */
export function Sheet({
  id,
  className,
  label,
  keepOpen = false,
  children
}: {
  id: Exclude<ShellSheet, null>
  className: string
  label: string
  /** Something the sheet opened is on screen; do not close under it. */
  keepOpen?: boolean
  children: ReactNode
}): ReactNode {
  const open = useShellSheet() === id
  const { mounted, closing } = usePresence(open, 160)
  const ref = useRef<HTMLDivElement | null>(null)
  const keepRef = useRef(keepOpen)
  keepRef.current = keepOpen

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || keepRef.current) return
      e.preventDefault()
      shellSheet.set(null)
    }
    const onDown = (e: PointerEvent): void => {
      if (keepRef.current) return
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t)) return
      // The button that opens a sheet toggles it itself.
      if (t.closest(`[data-sheet-toggle='${id}']`)) return
      if (t.closest('.popover, .rexp, .comet')) return
      shellSheet.set(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [id, open])

  if (!mounted) return null
  return (
    <div
      ref={ref}
      className={`sheet ${className}`}
      data-state={closing ? 'closing' : 'open'}
      data-shell-overlay=""
      role="dialog"
      aria-label={label}
    >
      {children}
    </div>
  )
}

export function toggleSheet(id: Exclude<ShellSheet, null>): void {
  shellSheet.set(shellSheet.get() === id ? null : id)
}

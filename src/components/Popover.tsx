import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './Popover.css'

export type PopoverAlign = 'start' | 'end' | 'center'

interface Props {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  align?: PopoverAlign
  /** Preferred side. Flips automatically when there is no room. */
  side?: 'bottom' | 'top'
  width?: number
  children: ReactNode
  label?: string
}

const GAP = 6
const MARGIN = 8

/**
 * A single anchored floating panel primitive: portalled to <body>, positioned
 * against its anchor, closed by Escape / outside pointerdown / window resize.
 * Every menu in Forge is one of these so the motion and elevation match.
 */
export function Popover({
  anchor,
  open,
  onClose,
  align = 'start',
  side = 'bottom',
  width,
  children,
  label
}: Props): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const box = ref.current.getBoundingClientRect()
    const w = width ?? box.width

    let left = a.left
    if (align === 'end') left = a.right - w
    else if (align === 'center') left = a.left + a.width / 2 - w / 2
    left = Math.min(window.innerWidth - w - MARGIN, Math.max(MARGIN, left))

    let top = side === 'bottom' ? a.bottom + GAP : a.top - box.height - GAP
    if (top + box.height > window.innerHeight - MARGIN) {
      const flipped = a.top - box.height - GAP
      top = flipped >= MARGIN ? flipped : Math.max(MARGIN, window.innerHeight - box.height - MARGIN)
    }
    top = Math.max(MARGIN, top)

    setPos({ top, left })
  }, [open, anchor, align, side, width, children])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (anchor?.contains(t)) return
      onClose()
    }
    const onScrollOrResize = (): void => onClose()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, onClose, anchor])

  if (!open) return null

  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={label}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: width ? `${width}px` : undefined,
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>,
    document.body
  )
}

/** Shared bits so every popover's internals look identical. */
export function PopoverSection({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  return (
    <div className="popover__section">
      {title ? <div className="eyebrow popover__eyebrow">{title}</div> : null}
      {children}
    </div>
  )
}

export function PopoverRow({
  onClick,
  children,
  danger,
  selected,
  disabled
}: {
  onClick?: () => void
  children: ReactNode
  danger?: boolean
  selected?: boolean
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      className="popover__row"
      data-danger={danger ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function PopoverDivider(): ReactNode {
  return <div className="popover__divider" />
}

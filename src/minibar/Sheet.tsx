import type { ReactNode } from 'react'
import { Icon } from '@/components/Icon'

/**
 * One surface for every stage panel: the dock's sheet (Dock.css `.sheet`) —
 * opaque, a hairline rim, 16px corners with 10px rows inside — with the mini
 * bar's floating edge added, because there is no Forge behind it, only
 * somebody else's window.
 */
export function Sheet({
  className,
  label,
  head,
  children,
  onClose,
  onPointerEnter,
  onPointerLeave
}: {
  className?: string
  label: string
  head: ReactNode
  children: ReactNode
  onClose?: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}): ReactNode {
  return (
    <section
      className={`mb-sheet${className ? ` ${className}` : ''}`}
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="mb-sheet__head">
        {head}
        {onClose ? (
          <button type="button" className="mb-ibtn mb-ibtn--sm mb-sheet__close" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </header>
      {children}
    </section>
  )
}

/** The small caps word at the top left of a sheet: "ACTIVITY", "PROJECTS". */
export function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return <span className="mb-eyebrow">{children}</span>
}

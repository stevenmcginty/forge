import type { ReactNode } from 'react'
import { attentionCount, statusOf } from '@shared/dates'
import { useDates, useToday } from './datesStore'
import './dates.css'

/**
 * A wall calendar, drawn like the rest of the icon set: 16×16, 1.4px stroke,
 * currentColor. Used by the mode switcher, the page head and the empty state.
 */
export function CalendarIcon({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.2" y="3.2" width="11.6" height="10.6" rx="2" />
      <path d="M2.2 6.8h11.6" />
      <path d="M5.4 1.9v2.6M10.6 1.9v2.6" />
      <path d="M5.2 9.6h1.2M7.4 9.6h1.2M9.6 9.6h1.2M5.2 11.7h1.2" />
    </svg>
  )
}

/**
 * The Dates mode's glyph in the top bar's switcher, with a small count beside
 * it when anything is overdue, today or within 7 days (`attentionCount`). The
 * count turns red only when something is already overdue.
 */
export function DatesGlyph(): ReactNode {
  const { items } = useDates()
  const today = useToday()
  const count = items ? attentionCount(items, today) : 0
  const late = items ? items.some((i) => statusOf(i, today) === 'overdue') : false
  return (
    <span className="dmode">
      <CalendarIcon size={13} />
      {count > 0 ? (
        <span className="dmode__count" data-late={late ? 'true' : undefined}>
          <span className="dates-sr">{`${count} need you soon: `}</span>
          <span aria-hidden="true">{count > 9 ? '9+' : count}</span>
        </span>
      ) : null}
    </span>
  )
}

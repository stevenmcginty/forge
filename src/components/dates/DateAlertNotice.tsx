import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { urgencyOf, type DateNotice, type DateUrgency } from '@shared/dates'
import { onDatesAlert } from '@/lib/datesApi'
import { usePresence } from '@/lib/motion'
import { uiCommands } from '@/lib/uiCommands'
import { CalendarIcon } from './DatesGlyph'
import { requestReveal, useDates, useToday } from './datesStore'

/** An alert nobody acts on goes by itself after this long; the list and the count still show it. */
const NOTICE_MS = 20_000

/** The small word over the title: where the alert stands, in words as well as colour. */
const EYEBROW: Record<DateUrgency | 'summary', string> = {
  summary: 'Dates',
  late: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'Coming up',
  calm: 'Coming up',
  done: 'Dates'
}

/**
 * The latest date alert while Forge is open (docs/DATES.md, "In-app notices"),
 * or null. A newer alert replaces the one showing; `dismiss` puts it away.
 */
export function useDateAlert(): { notice: (DateNotice & { seq: number }) | null; dismiss: () => void } {
  const [notice, setNotice] = useState<(DateNotice & { seq: number }) | null>(null)
  useEffect(() => onDatesAlert((next) => setNotice((current) => ({ ...next, seq: (current?.seq ?? 0) + 1 }))), [])
  useEffect(() => {
    if (!notice) return undefined
    const t = window.setTimeout(() => setNotice((n) => (n?.seq === notice.seq ? null : n)), NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [notice])
  return { notice, dismiss: () => setNotice(null) }
}

/**
 * A date alert inside the app, as the app's own notice tile (DeckToast's
 * `.dtoast`, Shell.css), bottom right over the dock: what and when, in the
 * alert's own words, and Open. Open (or a click on the words) brings up Dates
 * and, for one line, that line, opened. The diamond warms like the line does
 * (`urgencyOf`); the words carry it without the colour.
 *
 * Mounted once, beside the mode switcher's Dates glyph (registerDates.tsx; as
 * BrainContextNotice is by the Brain's icon), so it hears alerts whichever
 * mode is on screen.
 */
export function DateAlertNotice(): ReactNode {
  const { notice, dismiss } = useDateAlert()
  const { items } = useDates()
  const today = useToday()
  const { mounted, closing } = usePresence(notice !== null, 200)
  const [shown, setShown] = useState(notice)
  useEffect(() => {
    if (notice) setShown(notice)
  }, [notice])

  if (!mounted || !shown) return null
  const line = shown.id ? (items?.find((i) => i.id === shown.id) ?? null) : null
  const urgency: DateUrgency | 'summary' = line ? urgencyOf(line, today) : 'summary'

  const open = (): void => {
    uiCommands.run('set-mode', 'dates')
    if (shown.id) requestReveal(shown.id)
    dismiss()
  }

  // To the body, like the other tiles in this corner: the bar's glass would otherwise hold a fixed tile inside it.
  // React still bubbles a portal's events up its own tree, into the switcher's
  // Dates button: stop them here, so × does not also switch modes.
  return createPortal(
    <div
      className="dtoast dalert"
      data-state={closing ? 'closing' : 'open'}
      data-urgency={urgency}
      role="status"
      aria-live="polite"
      key={shown.seq}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="dalert__mark" aria-hidden="true">
        <CalendarIcon size={16} />
      </span>
      <button type="button" className="dalert__body" onClick={open} disabled={closing}>
        <span className="dalert__eyebrow">{EYEBROW[urgency]}</span>
        <span className="dalert__title">{shown.title}</span>
        {shown.body ? <span className="dalert__text">{shown.body}</span> : null}
      </button>
      <button type="button" className="dalert__open" onClick={open} disabled={closing}>
        Open
      </button>
      <button type="button" className="dalert__close" aria-label="Dismiss" title="Dismiss" onClick={dismiss} disabled={closing}>
        ×
      </button>
    </div>,
    document.body
  )
}

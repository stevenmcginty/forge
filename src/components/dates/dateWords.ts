import {
  addDays,
  addMonths,
  DATE_KINDS,
  dayLabel,
  daysLeft,
  humanWhen,
  statusOf,
  todayOf,
  type DateItem,
  type DateMonthBlock,
  type DateRepeat,
  type DatesWeeklyView
} from '@shared/dates'

/**
 * Small pieces of wording for the Dates page. All the date maths is in
 * shared/dates.ts; this only turns its answers into the page's words.
 */

export const REPEAT_WORDS: Record<DateRepeat, string> = {
  none: 'Does not repeat',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  yearly: 'Every year'
}

/** The three reminder presets the form offers, plus "custom". */
export const REMIND_PRESETS: readonly { id: 'big' | 'normal' | 'small'; label: string; hint: string; days: number[] }[] = [
  { id: 'big', label: 'Big contract', hint: '6 months, 3 months, a month, a week, a day, on the day', days: [180, 90, 30, 7, 1, 0] },
  { id: 'normal', label: 'Normal', hint: 'A month, a week, a day, on the day', days: [30, 7, 1, 0] },
  { id: 'small', label: 'Small', hint: 'A week, a day, on the day', days: [7, 1, 0] }
]

export function kindLabel(kind: string): string {
  return DATE_KINDS.find((k) => k.id === kind)?.label ?? 'Other'
}

/** "Thu 6 Aug 2026" in its parts, for the date stub. */
export function stubOf(day: string): { weekday: string; day: string; month: string; year: string } {
  const [weekday = '', d = '', month = '', year = ''] = dayLabel(day).split(' ')
  return { weekday, day: d, month, year }
}

/** A month block's heading: "December", or "January 2027" when it is not this year's. */
export function monthHeading(block: DateMonthBlock, today: string): { month: string; year: string | null } {
  const [month = block.label, year = ''] = block.label.split(' ')
  return { month, year: year && year !== today.slice(0, 4) ? year : null }
}

/* ---------------------------------------------------------- weekly check */

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** An hour of the day as the page writes it: "7:00", "19:00". */
export function hourWords(hour: number): string {
  return `${hour}:00`
}

/** An ISO time as its local day, "Mon 23 Nov" (with the year when it is not this year). */
export function shortDay(iso: string, today: string): string {
  const day = todayOf(new Date(iso))
  const label = dayLabel(day)
  return day.slice(0, 4) === today.slice(0, 4) ? label.slice(0, label.lastIndexOf(' ')) : label
}

/**
 * The weekly check in plain words, for the small status line on both faces:
 * "Checked Mon 23 Nov. Next check Mon 30 Nov at 7:00." `tone` says which of
 * the four states it is; `error` is the reason a failed run gave, when it gave one.
 */
export function weeklyWords(
  weekly: DatesWeeklyView,
  now: Date
): { tone: 'off' | 'never' | 'ran' | 'failed'; text: string; next: string | null; error?: string } {
  const today = todayOf(now)
  if (!weekly.enabled) return { tone: 'off', text: 'Off. Forge does not check your accounts each week.', next: null }
  const at = weekly.nextRunAt
  const next = !at
    ? null
    : Date.parse(at) <= now.getTime()
      ? 'Due now: it starts within 15 minutes.'
      : `${weekly.lastRunAt ? 'Next check' : 'First check'} ${shortDay(at, today)} at ${hourWords(new Date(at).getHours())}.`
  if (!weekly.lastRunAt) return { tone: 'never', text: 'Not run yet.', next }
  const when = shortDay(weekly.lastRunAt, today)
  if (weekly.lastResult === 'failed') {
    return { tone: 'failed', text: `Last check failed on ${when}.`, next, ...(weekly.lastError ? { error: weekly.lastError } : {}) }
  }
  return { tone: 'ran', text: `Checked ${when}.`, next }
}

/** The "when" words on a line: "in 12 days", "about in 5 months" reads badly, so "in about 5 months". */
export function whenWords(item: DateItem, today: string): string {
  const status = statusOf(item, today)
  if (status === 'done') return item.done ? 'done' : humanWhen(item, today)
  if (item.endDate && daysLeft(item, today) < 0) return `on now, until ${dayLabel(item.endDate)}`
  const words = humanWhen(item, today)
  if (!item.estimated) return words
  return words.startsWith('in ') ? `in about ${words.slice(3)}` : `about ${words}`
}

/** [30, 7, 1, 0] as "30 days, 7 days and 1 day before, and on the day". */
export function remindWords(days: readonly number[]): string {
  if (days.length === 0) return 'No reminders'
  const before = days.filter((d) => d > 0).map((d) => `${d} day${d === 1 ? '' : 's'}`)
  const onDay = days.includes(0)
  const list = before.length <= 1 ? before.join('') : `${before.slice(0, -1).join(', ')} and ${before[before.length - 1]}`
  if (!list) return onDay ? 'On the day' : 'No reminders'
  return onDay ? `${list} before, and on the day` : `${list} before`
}

/**
 * The day to snooze to: tomorrow (the picker's earliest), a week or a month
 * from today. The calendar maths is shared/dates.ts's: a month from the 31st
 * lands on the next month's last day, as repeats do.
 */
export function snoozeDay(today: string, by: 'day' | 'week' | 'month'): string {
  return by === 'month' ? addMonths(today, 1) : addDays(today, by === 'week' ? 7 : 1)
}

/** An IPC rejection's message without Electron's "Error invoking remote method" wrapper. */
export function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') || 'That did not work.'
}

import { addDays, addMonths, DATE_KINDS, dayLabel, daysLeft, humanWhen, statusOf, type DateItem, type DateRepeat } from '@shared/dates'

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

/** How close a line is, for its colour: late, today, this week, or neither. */
export type Nearness = 'late' | 'today' | 'week' | 'calm' | 'done'

export function nearnessOf(item: DateItem, today: string): Nearness {
  const status = statusOf(item, today)
  if (status === 'done') return 'done'
  if (status === 'overdue') return 'late'
  if (status === 'today') return 'today'
  if (status === 'soon' && daysLeft(item, today) <= 7) return 'week'
  return 'calm'
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

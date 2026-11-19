/**
 * Dates: one global list of renewals and deadlines (a lease ends, a policy
 * renews, a domain expires). docs/DATES.md is the contract; the names and rules
 * here come from it.
 *
 * Everything in this file is data and pure functions — no Node APIs, no DOM —
 * so electron/dates-store.ts, the desktop renderer, Forge Web and
 * scripts/dates-check.mjs all run the same rules.
 *
 * Day arithmetic is done on the calendar parts of a `YYYY-MM-DD` string (as a
 * UTC day number), never on milliseconds of local time, so a clock change can
 * never move a date by a day.
 */

/* ------------------------------------------------------------------ IPC */

/** Channel names. Kept here rather than in shared/ipc.ts so this feature is one import. */
export const DATES_IPC = {
  list: 'dates:list',
  add: 'dates:add',
  update: 'dates:update',
  complete: 'dates:complete',
  snooze: 'dates:snooze',
  remove: 'dates:remove',
  /** Main → renderer: the whole list, after every change. */
  changed: 'dates:changed',
  /** Main → renderer: a date notification was clicked; open the Dates surface. */
  open: 'dates:open',
  /** Main → renderer: an alert fired, as a `DateNotice`, for an in-app notice. */
  alert: 'dates:alert',
  /** The weekly check's state (`DatesWeeklyView`), a change to it, a run now. */
  weeklyGet: 'dates:weekly-get',
  weeklySet: 'dates:weekly-set',
  weeklyRun: 'dates:weekly-run',
  /** Main → renderer: the weekly check's state after every change. */
  weeklyChanged: 'dates:weekly-changed',
  /** Run one Dates tool (dates_list, dates_add, dates_update) in main, for the realtime voice agent. */
  tool: 'dates:tool'
} as const

/* ---------------------------------------------------------------- types */

export type DateKind =
  | 'contract'
  | 'insurance'
  | 'domain'
  | 'payment'
  | 'subscription'
  | 'licence'
  | 'holiday'
  | 'task'
  | 'other'

/** The kinds, in display order, each with its plain label. */
export const DATE_KINDS: readonly { id: DateKind; label: string }[] = [
  { id: 'contract', label: 'Contract' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'domain', label: 'Web domain' },
  { id: 'payment', label: 'Payment' },
  { id: 'subscription', label: 'Subscription' },
  { id: 'licence', label: 'Licence' },
  { id: 'holiday', label: 'Holiday' },
  { id: 'task', label: 'To do' },
  { id: 'other', label: 'Other' }
]

export type DateRepeat = 'none' | 'monthly' | 'quarterly' | 'yearly'

export type DateStatus = 'done' | 'overdue' | 'today' | 'soon' | 'upcoming' | 'later'

export interface DateItem {
  id: string
  title: string
  /** `YYYY-MM-DD`: a calendar day, no time, no time zone. */
  date: string
  group: string
  kind: DateKind
  amount: string
  /** The last day, for something that spans days. Never before `date`. */
  endDate?: string
  note: string
  action: string
  estimated: boolean
  /** Days before `date` an alert fires on. Unique, high to low, each 0 to 730. */
  remindDays: number[]
  repeat: DateRepeat
  done: boolean
  doneAt?: string
  /** No alerts before this day. */
  snoozedUntil?: string
  /** Keys of the alerts already sent (see `dueAlert`). */
  alerted: string[]
  /** Who made it: 'steve', 'agent' or 'seed'. */
  source: string
  createdAt: string
  updatedAt: string
}

/** A new line: title and date required, the rest optional. */
export interface DateInput {
  title: string
  date: string
  group?: string
  kind?: string
  amount?: string
  endDate?: string
  note?: string
  action?: string
  estimated?: boolean
  remindDays?: number[]
  repeat?: DateRepeat
}

/** A checked change to a line. `null` clears `endDate` or `snoozedUntil`. */
export interface DatePatch {
  title?: string
  date?: string
  group?: string
  kind?: string
  amount?: string
  endDate?: string | null
  note?: string
  action?: string
  estimated?: boolean
  remindDays?: number[]
  repeat?: DateRepeat
  done?: boolean
  snoozedUntil?: string | null
}

/**
 * One alert, as the store hands it to its listeners. When one pass finds 3 or
 * more, listeners hear one summary instead (`summary: true`): `items` holds
 * every line in it, soonest first, and `item` and `daysLeft` are the soonest
 * line's.
 */
export interface DateAlert {
  item: DateItem
  daysLeft: number
  title: string
  body: string
  summary?: true
  items?: DateItem[]
}

/**
 * An alert as the faces get it for an in-app notice: `DATES_IPC.alert` on the
 * desktop, the `date-alert` frame on the phone. A summary has no `id`; a tap
 * on it opens Dates.
 */
export interface DateNotice {
  id?: string
  title: string
  body: string
  summary?: true
}

/** A month block's key and colour index; see `monthBlocksOf`. */
export interface DateMonthBlock {
  /** `overdue`, `done`, or the month as `YYYY-MM`. */
  key: string
  label: string
  /** The calendar month's year and number (1 to 12). Only on a month block. */
  year?: number
  month?: number
  /** The month's index, 0 to 11, so a month has the same colour on every face. Only on a month block. */
  tone?: number
  items: DateItem[]
}

/** How close a line is, for its colour: see `urgencyOf`. */
export type DateUrgency = 'done' | 'late' | 'today' | 'week' | 'month' | 'calm'

/**
 * The weekly check (docs/DATES.md, "Weekly check"): once a week an agent pane
 * opens to check every mailbox and account it can reach and update the list.
 * Kept in `dates.json` as the top-level `weekly` block.
 */
export interface DatesWeekly {
  enabled: boolean
  /** 0 = Sunday, 1 = Monday … 6 = Saturday. */
  weekday: number
  /** The hour of the day it runs, 0 to 23, local time. */
  hour: number
  /** ISO time the block was first made. No slot at or before it runs. */
  since: string
  /** ISO time of the last run, started or failed. */
  lastRunAt?: string
  lastResult?: 'started' | 'failed'
  /** Why the last run failed. Only with `lastResult: 'failed'`. */
  lastError?: string
}

/** The weekly state as the faces get it: plus when it runs next (ISO), or null when it is off. */
export interface DatesWeeklyView extends DatesWeekly {
  nextRunAt: string | null
}

/** The parts of the weekly check a face may change. */
export interface DatesWeeklyPatch {
  enabled?: boolean
  weekday?: number
  hour?: number
}

/**
 * What `dueAlert` finds. `threshold` is the `remindDays` entry for an alert
 * before the date; for an overdue alert it is negative: -1 for the first 7-day
 * block after the date, -2 for the second, and so on.
 */
export interface DueAlert {
  key: string
  daysLeft: number
  threshold: number
}

/** `window.forgeDates` — see electron/dates-preload.ts. */
export interface DatesApi {
  list(): Promise<DateItem[]>
  add(input: DateInput): Promise<DateItem>
  update(id: string, patch: DatePatch): Promise<DateItem | null>
  complete(id: string): Promise<DateItem | null>
  snooze(id: string, until: string): Promise<DateItem | null>
  remove(id: string): Promise<boolean>
  /** The whole list after every change. Returns the unsubscribe. */
  onChange(cb: (items: DateItem[]) => void): () => void
  /** A date notification was clicked. Returns the unsubscribe. */
  onOpen(cb: () => void): () => void
  /** An alert fired (one line, or a summary of several). Returns the unsubscribe. */
  onAlert(cb: (notice: DateNotice) => void): () => void
  /** The weekly check. */
  weekly: DatesWeeklyApi
  /** Run one Dates tool in main by the same runDatesTool the other agents use (shared/dates-tools.ts). */
  tool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>
}

/** `window.forgeDates.weekly`. */
export interface DatesWeeklyApi {
  get(): Promise<DatesWeeklyView>
  /** Throws (a rejected promise, with a plain sentence) on a bad value. */
  set(patch: DatesWeeklyPatch): Promise<DatesWeeklyView>
  /** Open the weekly check's agent pane now. */
  runNow(): Promise<{ ok: boolean; error?: string }>
  /** The weekly state after every change. Returns the unsubscribe. */
  onChange(cb: (weekly: DatesWeeklyView) => void): () => void
}

/* ------------------------------------------------------------ constants */

export const DATE_TITLE_MAX = 120
export const DEFAULT_REMIND_DAYS: readonly number[] = [30, 7, 1, 0]
const REMIND_MAX = 730
const KIND_IDS = new Set<string>(DATE_KINDS.map((k) => k.id))
const REPEATS = new Set<string>(['none', 'monthly', 'quarterly', 'yearly'])
/** Months between occurrences of a repeating line. */
const REPEAT_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 }

/* ------------------------------------------------------- calendar days */

const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(day: string): [number, number, number] | null {
  const m = DAY_RE.exec(day)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > lastDayOf(y, mo)) return null
  return [y, mo, d]
}

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function dayString(y: number, mo: number, d: number): string {
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`
}

/** True for a real calendar day written `YYYY-MM-DD` (so not 2026-02-30). */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && parts(value) !== null
}

/** The UTC day number of a valid day. Only ever compared with another one. */
function dayNumber(day: string): number {
  const p = parts(day)
  if (!p) return NaN
  return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / DAY_MS)
}

/** A day in words: "Thu 6 Aug 2026". Same in every locale. */
export function dayLabel(day: string): string {
  const p = parts(day)
  if (!p) return day
  const weekday = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()]
  return `${weekday} ${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}`
}

/** The local calendar day of `now`. */
export function todayOf(now: Date): string {
  return dayString(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** `date` minus `today` in whole days. Negative means overdue. */
export function daysLeft(item: Pick<DateItem, 'date'>, today: string): number {
  return dayNumber(item.date) - dayNumber(today)
}

/** `day` moved on by whole months, clamped to the new month's last day. */
export function addMonths(day: string, months: number): string {
  const p = parts(day)
  if (!p) return day
  const index = p[0] * 12 + (p[1] - 1) + months
  const y = Math.floor(index / 12)
  const mo = (index % 12) + 1
  return dayString(y, mo, Math.min(p[2], lastDayOf(y, mo)))
}

/** `day` moved on by whole calendar days. */
export function addDays(day: string, days: number): string {
  const p = parts(day)
  if (!p) return day
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days))
  return dayString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/* ------------------------------------------------------------- normalise */

/** A short random id. Not a secret, only unique enough for one person's list. */
export function newDateId(): string {
  let id = ''
  for (let i = 0; i < 10; i++) id += Math.floor(Math.random() * 36).toString(36)
  return id
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function kindOf(value: unknown): DateKind {
  const v = text(value).toLowerCase()
  return KIND_IDS.has(v) ? (v as DateKind) : 'other'
}

function repeatOf(value: unknown): DateRepeat {
  return typeof value === 'string' && REPEATS.has(value) ? (value as DateRepeat) : 'none'
}

/** Unique whole days 0 to 730, high to low. Not an array at all: the default. */
function remindOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_REMIND_DAYS]
  const days = new Set<number>()
  for (const v of value) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (Number.isInteger(n) && n >= 0 && n <= REMIND_MAX) days.add(n)
  }
  return [...days].sort((a, b) => b - a)
}

function isoOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value)) ? value.trim() : undefined
}

/**
 * Any object (a hand-written file line, an old version) as a clean DateItem,
 * or null when it has no title or no valid date. Missing optional fields get
 * their defaults; unknown fields are dropped; an unknown kind becomes 'other';
 * an `endDate` before `date` is dropped (the line itself is kept). A missing
 * id gets a new one.
 */
export function normaliseItem(raw: unknown, now: Date = new Date()): DateItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const title = text(r['title']).slice(0, DATE_TITLE_MAX)
  const date = text(r['date'])
  if (!title || !isDay(date)) return null
  const stamp = now.toISOString()
  const item: DateItem = {
    id: text(r['id']) || newDateId(),
    title,
    date,
    group: text(r['group']),
    kind: kindOf(r['kind']),
    amount: text(r['amount']),
    note: text(r['note']),
    action: text(r['action']),
    estimated: r['estimated'] === true,
    remindDays: remindOf(r['remindDays']),
    repeat: repeatOf(r['repeat']),
    done: r['done'] === true,
    alerted: Array.isArray(r['alerted'])
      ? [...new Set(r['alerted'].filter((k): k is string => typeof k === 'string' && k !== ''))]
      : [],
    source: text(r['source']) || 'steve',
    createdAt: isoOf(r['createdAt']) ?? stamp,
    updatedAt: isoOf(r['updatedAt']) ?? stamp
  }
  const endDate = text(r['endDate'])
  if (isDay(endDate) && endDate >= date) item.endDate = endDate
  const doneAt = isoOf(r['doneAt'])
  if (item.done && doneAt) item.doneAt = doneAt
  const snoozedUntil = text(r['snoozedUntil'])
  if (isDay(snoozedUntil)) item.snoozedUntil = snoozedUntil
  return item
}

/**
 * Why this new line or change cannot be saved, in a plain sentence, or null
 * when it can. Only the fields present are checked; `date` is the line's date
 * after the change (for the `endDate` rule).
 */
export function inputError(input: Partial<DatePatch>, date?: string): string | null {
  if ('title' in input && input.title !== undefined && !text(input.title)) return 'A date needs a title.'
  if ('date' in input && input.date !== undefined && !isDay(input.date)) {
    return `"${String(input.date)}" is not a real day. Write it as YYYY-MM-DD.`
  }
  if (input.endDate !== undefined && input.endDate !== null && input.endDate !== '') {
    if (!isDay(input.endDate)) return `"${String(input.endDate)}" is not a real end day. Write it as YYYY-MM-DD.`
    const start = date ?? input.date
    if (start && isDay(start) && input.endDate < start) return 'The end day cannot be before the date.'
  }
  if (input.snoozedUntil !== undefined && input.snoozedUntil !== null && input.snoozedUntil !== '' && !isDay(input.snoozedUntil)) {
    return `"${String(input.snoozedUntil)}" is not a real day to snooze to. Write it as YYYY-MM-DD.`
  }
  if (input.repeat !== undefined && !REPEATS.has(input.repeat)) return 'Repeat must be none, monthly, quarterly or yearly.'
  if (input.remindDays !== undefined && !Array.isArray(input.remindDays)) return 'Reminders must be a list of days.'
  return null
}

/* ---------------------------------------------------------- status, sort */

/** Where a line stands today. See docs/DATES.md for the bands. */
export function statusOf(item: DateItem, today: string): DateStatus {
  if (item.done) return 'done'
  const d = daysLeft(item, today)
  if (item.endDate) {
    if (today > item.endDate) return 'done'
    if (d <= 0) return 'today'
  }
  if (d < 0) return 'overdue'
  if (d === 0) return 'today'
  if (d <= 30) return 'soon'
  if (d <= 180) return 'upcoming'
  return 'later'
}

/** The moment a finished line finished, for sorting the done ones. */
function finishedAt(item: DateItem): string {
  return item.doneAt ?? item.endDate ?? item.date
}

/** Open lines soonest first; then done lines, the newest finished first. */
export function sortItems(items: readonly DateItem[], today: string): DateItem[] {
  const open: DateItem[] = []
  const done: DateItem[] = []
  for (const item of items) (statusOf(item, today) === 'done' ? done : open).push(item)
  open.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : a.date < b.date ? -1 : 1))
  done.sort((a, b) => {
    const fa = finishedAt(a)
    const fb = finishedAt(b)
    return fa === fb ? a.title.localeCompare(b.title) : fa < fb ? 1 : -1
  })
  return [...open, ...done]
}

export interface DateBucket {
  key: 'overdue' | 'today' | 'soon' | 'upcoming' | 'later' | 'done'
  label: string
  items: DateItem[]
}

const BUCKETS: readonly { key: DateBucket['key']; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'soon', label: 'Next 30 days' },
  { key: 'upcoming', label: 'Next 6 months' },
  { key: 'later', label: 'Later' },
  { key: 'done', label: 'Done' }
]

/** The list cut into the UI's buckets, in order, empty buckets left out. */
export function bucketsOf(items: readonly DateItem[], today: string): DateBucket[] {
  const sorted = sortItems(items, today)
  return BUCKETS.map((b) => ({ ...b, items: sorted.filter((i) => statusOf(i, today) === b.key) })).filter(
    (b) => b.items.length > 0
  )
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/**
 * The list cut into calendar months, for a UI that shows each month as a
 * block in its own colour: `Overdue` first (when any open line is overdue),
 * then one block per month that holds open lines, in date order, then `Done`
 * (when any). A line with an `endDate` that is running now sits in today's
 * month. `tone` is the month's index (0 to 11), so November is the same
 * colour on every face and in every year.
 */
export function monthBlocksOf(items: readonly DateItem[], today: string): DateMonthBlock[] {
  const sorted = sortItems(items, today)
  const overdue: DateItem[] = []
  const done: DateItem[] = []
  const months = new Map<string, DateItem[]>()
  for (const item of sorted) {
    const status = statusOf(item, today)
    if (status === 'done') done.push(item)
    else if (status === 'overdue') overdue.push(item)
    else {
      const key = (status === 'today' && item.date < today ? today : item.date).slice(0, 7)
      const block = months.get(key)
      if (block) block.push(item)
      else months.set(key, [item])
    }
  }
  const blocks: DateMonthBlock[] = []
  if (overdue.length > 0) blocks.push({ key: 'overdue', label: 'Overdue', items: overdue })
  for (const key of [...months.keys()].sort()) {
    const year = Number(key.slice(0, 4))
    const month = Number(key.slice(5, 7))
    blocks.push({ key, year, month, label: `${MONTH_NAMES[month - 1]} ${year}`, tone: month - 1, items: months.get(key)! })
  }
  if (done.length > 0) blocks.push({ key: 'done', label: 'Done', items: done })
  return blocks
}

/**
 * How close a line is, for its colour: `late` (overdue), `today`, `week` (1
 * to 7 days), `month` (8 to 30 days), `calm` (more than 30), or `done`.
 */
export function urgencyOf(item: DateItem, today: string): DateUrgency {
  const status = statusOf(item, today)
  if (status === 'done') return 'done'
  if (status === 'overdue') return 'late'
  if (status === 'today') return 'today'
  const d = daysLeft(item, today)
  if (d <= 7) return 'week'
  if (d <= 30) return 'month'
  return 'calm'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** When, in plain words: "today", "tomorrow", "in 12 days", "in 5 months", "3 days overdue". */
export function humanWhen(item: DateItem, today: string): string {
  const d = daysLeft(item, today)
  if (item.endDate && d <= 0) {
    const past = dayNumber(today) - dayNumber(item.endDate)
    return past > 0 ? `ended ${plural(past, 'day')} ago` : 'today'
  }
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  if (d < 0) return `${plural(-d, 'day')} overdue`
  if (d <= 45) return `in ${d} days`
  if (d < 548) return `in ${Math.round(d / 30.4375)} months`
  return `in ${Math.round(d / 365.25)} years`
}

/** Open lines that are overdue, today, or within 7 days: the badge number. */
export function attentionCount(items: readonly DateItem[], today: string): number {
  let n = 0
  for (const item of items) {
    const status = statusOf(item, today)
    if (status === 'overdue' || status === 'today' || (status === 'soon' && daysLeft(item, today) <= 7)) n++
  }
  return n
}

/* --------------------------------------------------------------- alerts */

/** Every line except a monthly one alerts when it enters its last 30 days (docs/DATES.md, "Alerts"). */
export const LAST_DAYS_ALERT = 30

/**
 * The thresholds the alerts use: `remindDays` plus 30, unless the line repeats
 * every month (a monthly bill would otherwise alert all the time). High to low.
 */
export function effectiveRemindDays(item: Pick<DateItem, 'remindDays' | 'repeat'>): number[] {
  if (item.repeat === 'monthly' || item.remindDays.includes(LAST_DAYS_ALERT)) return [...item.remindDays]
  return [...item.remindDays, LAST_DAYS_ALERT].sort((a, b) => b - a)
}

/**
 * The one alert due for a line today, or null. Rules in docs/DATES.md
 * ("Alerts"): before the date, the smallest threshold of `effectiveRemindDays`
 * not below the days left, once; after the date (no `endDate`), once per
 * 7-day block.
 */
export function dueAlert(item: DateItem, today: string): DueAlert | null {
  if (item.done) return null
  if (item.snoozedUntil && today < item.snoozedUntil) return null
  const d = daysLeft(item, today)
  if (Number.isNaN(d)) return null
  if (d >= 0) {
    let threshold: number | null = null
    for (const t of effectiveRemindDays(item)) if (t >= d && (threshold === null || t < threshold)) threshold = t
    if (threshold === null) return null
    const key = `${item.date}:${threshold}`
    return item.alerted.includes(key) ? null : { key, daysLeft: d, threshold }
  }
  if (item.endDate) return null
  const block = Math.floor((-d - 1) / 7)
  const key = `${item.date}:late${block}`
  return item.alerted.includes(key) ? null : { key, daysLeft: d, threshold: -(block + 1) }
}

/**
 * The line with this alert recorded. Before the date it also records every
 * larger threshold, so a line added already inside three of them alerts once.
 */
export function markAlerted(item: DateItem, alert: DueAlert): DateItem {
  const keys = new Set(item.alerted)
  keys.add(alert.key)
  if (alert.threshold >= 0) {
    for (const t of effectiveRemindDays(item)) if (t >= alert.threshold) keys.add(`${item.date}:${t}`)
  }
  return { ...item, alerted: [...keys] }
}

/** From this many alerts in one pass, listeners hear one summary instead. */
export const ALERT_SUMMARY_FROM = 3
/** How many lines a summary's body names before "and N more". */
const SUMMARY_NAMES = 3

/**
 * One alert for several (`ALERT_SUMMARY_FROM` or more) from the same pass:
 * "5 dates are coming up", the soonest three as "<title>: <when>", then
 * "and 2 more". `item` and `daysLeft` are the soonest line's.
 */
export function alertSummary(alerts: readonly DateAlert[], today: string): DateAlert {
  const items = sortItems(
    alerts.map((a) => a.item),
    today
  )
  const lines = items.slice(0, SUMMARY_NAMES).map((i) => `${i.title}: ${humanWhen(i, today)}`)
  const more = items.length - SUMMARY_NAMES
  if (more > 0) lines.push(`and ${more} more`)
  const first = items[0]!
  return {
    item: first,
    daysLeft: daysLeft(first, today),
    title: `${items.length} dates are coming up`,
    body: lines.join('\n'),
    summary: true,
    items
  }
}

/** An alert as an in-app notice: see `DateNotice`. */
export function dateNoticeOf(alert: DateAlert): DateNotice {
  return alert.summary
    ? { title: alert.title, body: alert.body, summary: true }
    : { id: alert.item.id, title: alert.title, body: alert.body }
}

/** The words of a notification. The title names the line; the body says exactly when. */
export function alertText(item: DateItem, today: string): { title: string; body: string } {
  const d = daysLeft(item, today)
  const when = humanWhen(item, today)
  const left =
    d === 0 ? 'Today.' : d === 1 ? 'Tomorrow, 1 day left.' : d > 0 ? `${d} days left.` : `${plural(-d, 'day')} overdue.`
  const about = item.estimated ? 'about ' : ''
  const lines = [`${about}${dayLabel(item.date)}. ${left}`]
  const facts = [item.group, item.amount].filter(Boolean).join(' · ')
  if (facts) lines.push(facts)
  if (item.action) lines.push(item.action)
  else if (item.note) lines.push(item.note)
  return { title: `${item.title} — ${when}`, body: lines.join('\n') }
}

/* ------------------------------------------------------- change a line */

/**
 * A checked update. Throws an Error with a plain sentence when a field is not
 * valid. A new `date` drops every `alerted` key that does not start with it.
 */
export function applyPatch(item: DateItem, patch: DatePatch, now: Date = new Date()): DateItem {
  const p = patch ?? {}
  const date = p.date !== undefined ? text(p.date) : item.date
  const endDate = p.endDate === undefined ? item.endDate : p.endDate === null || p.endDate === '' ? undefined : text(p.endDate)
  const error = inputError({ ...p, endDate: endDate ?? null, ...(p.date !== undefined ? { date } : {}) }, date)
  if (error) throw new Error(error)
  const next: DateItem = { ...item }
  if (p.title !== undefined) next.title = text(p.title).slice(0, DATE_TITLE_MAX)
  if (p.date !== undefined && date !== item.date) {
    next.date = date
    next.alerted = item.alerted.filter((k) => k.startsWith(`${date}:`))
  }
  if (p.group !== undefined) next.group = text(p.group)
  if (p.kind !== undefined) next.kind = kindOf(p.kind)
  if (p.amount !== undefined) next.amount = text(p.amount)
  if (p.note !== undefined) next.note = text(p.note)
  if (p.action !== undefined) next.action = text(p.action)
  if (p.estimated !== undefined) next.estimated = p.estimated === true
  if (p.remindDays !== undefined) next.remindDays = remindOf(p.remindDays)
  if (p.repeat !== undefined) next.repeat = repeatOf(p.repeat)
  if (endDate) next.endDate = endDate
  else delete next.endDate
  if (p.snoozedUntil !== undefined) {
    if (p.snoozedUntil) next.snoozedUntil = text(p.snoozedUntil)
    else delete next.snoozedUntil
  }
  if (p.done !== undefined) {
    next.done = p.done === true
    if (next.done) next.doneAt = item.doneAt ?? now.toISOString()
    else delete next.doneAt
  }
  next.updatedAt = now.toISOString()
  return next
}

/**
 * Mark a line done. A repeating line stays open instead: its date moves on 1,
 * 3 or 12 months at a time to the next occurrence after today (a day the new month lacks becomes its last
 * day), and its alerts and snooze are cleared.
 */
export function completeItem(item: DateItem, now: Date = new Date()): DateItem {
  const stamp = now.toISOString()
  const step = REPEAT_MONTHS[item.repeat]
  if (!step) return { ...item, done: true, doneAt: stamp, updatedAt: stamp }
  const today = todayOf(now)
  let k = 1
  let date = addMonths(item.date, step)
  while (date <= today) date = addMonths(item.date, step * ++k)
  const next: DateItem = { ...item, date, alerted: [], done: false, updatedAt: stamp }
  delete next.doneAt
  delete next.snoozedUntil
  if (item.endDate) next.endDate = addDays(date, dayNumber(item.endDate) - dayNumber(item.date))
  return next
}

/* ---------------------------------------------------------- agent prompt */

function kindLabel(kind: DateKind): string {
  return DATE_KINDS.find((k) => k.id === kind)?.label ?? 'Other'
}

/** The first prompt for an agent put on this line. Useful with no other context. */
export function agentPrompt(item: DateItem, today: string): string {
  const d = daysLeft(item, today)
  const left =
    d === 0 ? 'It is today.' : d === 1 ? 'It is tomorrow (1 day left).' : d > 0 ? `${d} days left.` : `It is ${plural(-d, 'day')} overdue.`
  const when = `${item.estimated ? 'about ' : ''}${dayLabel(item.date)} (${item.date})${
    item.endDate ? `, until ${dayLabel(item.endDate)} (${item.endDate})` : ''
  }${item.estimated ? ' — this date is not confirmed' : ''}`
  const lines = [
    "You are working on one line of Steve's Dates list in Forge: his renewals and deadlines.",
    '',
    `What: ${item.title}`,
    `When: ${when}. Today is ${dayLabel(today)}. ${left}`,
    `Kind: ${kindLabel(item.kind)}`
  ]
  if (item.group) lines.push(`Group: ${item.group}`)
  if (item.amount) lines.push(`Amount: ${item.amount}`)
  if (item.repeat !== 'none') lines.push(`Repeats: ${item.repeat}`)
  if (item.note) lines.push(`Note: ${item.note}`)
  if (item.action) lines.push(`What to do: ${item.action}`)
  lines.push(
    `Line id: ${item.id} (use it with the dates_update tool to change this line).`,
    '',
    'Your job:',
    '1. Work out what must be done before this date, and by when: notice periods, renewal windows, papers or details needed.',
    '2. Do the research.',
    '3. Report the options with your recommendation, in short plain sentences.',
    'Ask Steve before you send any message, pay anything, or submit any form.'
  )
  return lines.join('\n')
}

/* ---------------------------------------------------------- weekly check */

/** The weekly check's defaults: on, Mondays at 07:00. `since` is the moment the block is made. */
export const WEEKLY_DEFAULTS: Readonly<Omit<DatesWeekly, 'since'>> = { enabled: true, weekday: 1, hour: 7 }

/**
 * The weekly agent's job, when `<dataDir>/dates-weekly-prompt.md` does not
 * replace it. `WEEKLY_HARD_RULES` always follows, whichever prompt is used.
 */
export const DEFAULT_WEEKLY_PROMPT = [
  'This is the weekly check of the Dates list in Forge: the renewals, expiries and deadlines that matter.',
  '',
  'Your job:',
  '1. First call dates_list with include_done set to true, so you know every line already on the list.',
  '2. Check every mailbox and account you can reach for renewals, expiries, contract ends, payment-plan ends, licences, tax and filing dates, and booked holidays. Read the mail from the last 14 days, and anything older that the list does not have yet.',
  '3. For each thing you find: when a line for it is already on the list and its date or amount changed, update that line with dates_update. When there is no line for it, add one with dates_add, with a kind, a group, the amount, a note that names the source (the sender and the date of the mail) and an action. Set estimated to true when you worked the date out and did not read it.',
  '4. For lines marked as estimated, correct the date when the real date is now known, and set estimated to false.',
  '5. End with a short plain report in three parts: what you added, what you changed, and what you could not check.'
].join('\n')

/** Always the last words of the weekly agent's prompt. */
export const WEEKLY_HARD_RULES = [
  'Hard rules:',
  '- Never delete a line.',
  '- Never mark a line done unless a mail proves it is finished. When you do, say so in its note.',
  '- Read only everywhere else: do not send, reply, delete, archive, pay, book or submit any form.',
  '- Do not add the same thing twice. Check dates_list before you add a line.'
].join('\n')

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Any value (a hand-written block, nothing at all) as a clean weekly block.
 * A bad or missing field gets its default; `since` defaults to `now`. Never throws.
 */
export function normaliseWeekly(raw: unknown, now: Date = new Date()): DatesWeekly {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: DatesWeekly = {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : WEEKLY_DEFAULTS.enabled,
    weekday: isInt(r['weekday'], 0, 6) ? r['weekday'] : WEEKLY_DEFAULTS.weekday,
    hour: isInt(r['hour'], 0, 23) ? r['hour'] : WEEKLY_DEFAULTS.hour,
    since: isoOf(r['since']) ?? now.toISOString()
  }
  const lastRunAt = isoOf(r['lastRunAt'])
  if (lastRunAt) out.lastRunAt = lastRunAt
  if (r['lastResult'] === 'started' || r['lastResult'] === 'failed') out.lastResult = r['lastResult']
  const lastError = text(r['lastError'])
  if (out.lastResult === 'failed' && lastError) out.lastError = lastError
  return out
}

/** Why this change to the weekly check cannot be saved, in a plain sentence, or null when it can. */
export function weeklyPatchError(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'That is not a change to the weekly check.'
  const p = patch as Record<string, unknown>
  if (p['enabled'] !== undefined && typeof p['enabled'] !== 'boolean') return 'On or off must be true or false.'
  if (p['weekday'] !== undefined && !isInt(p['weekday'], 0, 6)) return 'The day must be a whole number from 0 (Sunday) to 6 (Saturday).'
  if (p['hour'] !== undefined && !isInt(p['hour'], 0, 23)) return 'The hour must be a whole number from 0 to 23.'
  return null
}

/** The weekday (0 = Sunday) of a calendar day. */
function weekdayOf(day: string): number {
  const p = parts(day)
  return p ? new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() : NaN
}

/** `hour`:00 local time on a calendar day. */
function slotOn(day: string, hour: number): Date {
  const p = parts(day)!
  return new Date(p[0], p[1] - 1, p[2], hour, 0, 0, 0)
}

/** The latest slot (the weekday at hour:00 local time) at or before `now`. */
function latestSlot(weekly: DatesWeekly, now: Date): Date {
  const today = todayOf(now)
  for (let k = 0; k <= 7; k++) {
    const day = addDays(today, -k)
    if (weekdayOf(day) !== weekly.weekday) continue
    const slot = slotOn(day, weekly.hour)
    if (slot.getTime() <= now.getTime()) return slot
  }
  // Unreachable: one of eight days back is the weekday, and at most one of them is still to come.
  return slotOn(addDays(today, -14), weekly.hour)
}

const timeOf = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN)

/**
 * Whether the weekly check should run now: it is on, and the latest slot at
 * or before `now` is later than both `since` and `lastRunAt`. So nothing runs
 * on the day the block is made until its first slot, and a PC that was off for
 * three weeks runs it once, not three times.
 */
export function weeklyDue(weekly: DatesWeekly, now: Date): boolean {
  if (!weekly.enabled) return false
  const slot = latestSlot(weekly, now).getTime()
  const since = timeOf(weekly.since)
  const last = timeOf(weekly.lastRunAt)
  return (Number.isNaN(since) || slot > since) && (Number.isNaN(last) || slot > last)
}

/**
 * When the weekly check runs next, as an ISO time, or null when it is off.
 * When it is due now, that is `now` (it runs at the next pass); else the first
 * slot after `now`, `since` and `lastRunAt`.
 */
export function nextWeeklyRun(weekly: DatesWeekly, now: Date): string | null {
  if (!weekly.enabled) return null
  if (weeklyDue(weekly, now)) return now.toISOString()
  const floor = Math.max(now.getTime(), timeOf(weekly.since) || 0, timeOf(weekly.lastRunAt) || 0)
  const start = todayOf(new Date(floor))
  for (let k = 0; k <= 8; k++) {
    const day = addDays(start, k)
    if (weekdayOf(day) !== weekly.weekday) continue
    const slot = slotOn(day, weekly.hour)
    if (slot.getTime() > floor) return slot.toISOString()
  }
  return null
}

/** The weekly state with `nextRunAt`, as the faces get it. */
export function weeklyView(weekly: DatesWeekly, now: Date): DatesWeeklyView {
  return { ...weekly, nextRunAt: nextWeeklyRun(weekly, now) }
}

/**
 * The weekly agent's whole first prompt: the custom prompt (the text of
 * `dates-weekly-prompt.md`) when it is not empty, else
 * `DEFAULT_WEEKLY_PROMPT`; then today's date and the number of open lines;
 * then `WEEKLY_HARD_RULES`, always last.
 */
export function weeklyPrompt(custom: string | null | undefined, today: string, openLines: number): string {
  const job = typeof custom === 'string' && custom.trim() ? custom.trim() : DEFAULT_WEEKLY_PROMPT
  return [job, '', `Today is ${dayLabel(today)} (${today}). The list has ${plural(openLines, 'open line')}.`, '', WEEKLY_HARD_RULES].join('\n')
}

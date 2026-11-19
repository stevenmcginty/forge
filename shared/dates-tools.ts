/**
 * The Dates agent tools' one route in: dates_list, dates_add and dates_update
 * (docs/DATES.md, "Agent tools"), for every tool set that offers them.
 *
 *  - Forge's own agents: electron/voice-agent/host.ts `forgeToolDefs`.
 *  - Pane agents: bridge/dates-tools.mjs relays the call down the browser pipe
 *    and electron/browser-panes/ipc.ts answers it here.
 *
 * Both call `runDatesTool` on the main process's list, so the words an agent
 * reads cannot drift between them. The schemas are in shared/brain-tools.ts
 * (`DATES_TOOL_SPECS`).
 *
 * Pure: no Node APIs, no `electron`. The store is passed in, so
 * scripts/dates-tools-check.mjs drives it against a temp folder.
 * `datesInputOf` and `datesUpdateRequest` (tool fields, snake_case, to store
 * fields, camelCase) are exported for Forge Web's `dates-add` / `dates-update`
 * requests, which take the same fields as the tools.
 */

import {
  DATE_KINDS,
  daysLeft,
  isDay,
  statusOf,
  todayOf,
  type DateInput,
  type DateItem,
  type DatePatch,
  type DateRepeat
} from './dates'

export const DATES_TOOL_NAMES = ['dates_list', 'dates_add', 'dates_update'] as const

export type DatesToolName = (typeof DATES_TOOL_NAMES)[number]

export function isDatesTool(name: string): name is DatesToolName {
  return (DATES_TOOL_NAMES as readonly string[]).includes(name)
}

/** The part of electron/dates-store.ts `DatesService` the tools use. */
export interface DatesToolStore {
  list(): DateItem[]
  add(input: DateInput, source?: string): DateItem
  update(id: string, patch: DatePatch): DateItem | null
  complete(id: string): DateItem | null
  snooze(id: string, until: string): DateItem | null
  remove(id: string): boolean
}

/** What a tool answers: the words, and whether it did what was asked. */
export interface DatesToolReply {
  ok: boolean
  text: string
}

/* ------------------------------------------------------------ the fields */

type Args = Record<string, unknown>

const argsOf = (value: unknown): Args => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : {})
const has = (a: Args, key: string): boolean => a[key] !== undefined
const str = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))

/** remind_days as given: the store cleans a list, and refuses anything else in words. */
const remindOf = (value: unknown): number[] => value as number[]

/** dates_add's fields as the store's `DateInput`. */
export function datesInputOf(args: unknown): DateInput {
  const a = argsOf(args)
  const input: DateInput = { title: str(a['title']), date: str(a['date']).trim() }
  if (has(a, 'kind')) input.kind = str(a['kind'])
  if (has(a, 'group')) input.group = str(a['group'])
  if (has(a, 'amount')) input.amount = str(a['amount'])
  if (has(a, 'end_date') && str(a['end_date']).trim()) input.endDate = str(a['end_date']).trim()
  if (has(a, 'note')) input.note = str(a['note'])
  if (has(a, 'action')) input.action = str(a['action'])
  if (has(a, 'estimated')) input.estimated = a['estimated'] === true
  if (has(a, 'remind_days')) input.remindDays = remindOf(a['remind_days'])
  if (has(a, 'repeat')) input.repeat = str(a['repeat']) as DateRepeat
  return input
}

/**
 * dates_update's fields, sorted into what the store does with them:
 * `remove` (delete: true), `patch` (every plain field, camelCase, for
 * `update`), `snoozeUntil` (snooze_until with a day, for `snooze`; "" clears
 * the snooze through the patch instead) and `complete` (done: true; done:
 * false re-opens through the patch).
 */
export interface DatesUpdateRequest {
  id: string
  remove: boolean
  patch: DatePatch
  snoozeUntil: string | null
  complete: boolean
}

export function datesUpdateRequest(args: unknown): DatesUpdateRequest {
  const a = argsOf(args)
  const patch: DatePatch = {}
  if (has(a, 'title')) patch.title = str(a['title'])
  if (has(a, 'date')) patch.date = str(a['date']).trim()
  if (has(a, 'kind')) patch.kind = str(a['kind'])
  if (has(a, 'group')) patch.group = str(a['group'])
  if (has(a, 'amount')) patch.amount = str(a['amount'])
  if (has(a, 'end_date')) patch.endDate = str(a['end_date']).trim() || null
  if (has(a, 'note')) patch.note = str(a['note'])
  if (has(a, 'action')) patch.action = str(a['action'])
  if (has(a, 'estimated')) patch.estimated = a['estimated'] === true
  if (has(a, 'remind_days')) patch.remindDays = remindOf(a['remind_days'])
  if (has(a, 'repeat')) patch.repeat = str(a['repeat']) as DateRepeat
  if (a['done'] === false) patch.done = false
  let snoozeUntil: string | null = null
  if (has(a, 'snooze_until')) {
    const until = str(a['snooze_until']).trim()
    if (until) snoozeUntil = until
    else patch.snoozedUntil = null
  }
  return { id: str(a['id']).trim(), remove: a['delete'] === true, patch, snoozeUntil, complete: a['done'] === true }
}

/* ------------------------------------------------------------ the words */

/** One field of a line: on one line, and never the column mark. */
const cell = (value: string): string => value.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()

function whenWords(item: DateItem, today: string): string {
  if (item.done) return 'done'
  const d = daysLeft(item, today)
  if (item.endDate && d <= 0) return today > item.endDate ? 'ended' : 'on now'
  if (d === 0) return 'today'
  if (d === 1) return 'in 1 day'
  if (d > 1) return `in ${d} days`
  return d === -1 ? '1 day overdue' : `${-d} days overdue`
}

/** `id | YYYY-MM-DD | in N days | kind | group | title | amount | note | action`; empty fields stay empty. */
export function datesToolLine(item: DateItem, today: string): string {
  const day = `${item.estimated ? 'about ' : ''}${item.date}${item.endDate ? ` to ${item.endDate}` : ''}`
  const repeat = item.repeat !== 'none' ? ` (repeats ${item.repeat})` : ''
  return [item.id, day, whenWords(item, today), item.kind, item.group, item.title + repeat, item.amount, item.note, item.action]
    .map(cell)
    .join(' | ')
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function kindMatches(item: DateItem, kind: string): boolean {
  const k = kind.toLowerCase()
  return item.kind === k || DATE_KINDS.some((d) => d.id === item.kind && d.label.toLowerCase() === k)
}

/** dates_list's answer: how many and today's date, then one line per item, soonest first. */
export function datesListText(items: readonly DateItem[], today: string, args: unknown = {}): string {
  const a = argsOf(args)
  const includeDone = a['include_done'] === true
  const kind = str(a['kind']).trim()
  const group = str(a['group']).trim().toLowerCase()
  const shown = items.filter(
    (item) =>
      (includeDone || statusOf(item, today) !== 'done') &&
      (!kind || kindMatches(item, kind)) &&
      (!group || item.group.toLowerCase().includes(group))
  )
  const what = includeDone ? 'date' : 'open date'
  const narrowed = [kind ? `kind ${kind}` : '', group ? `group "${str(a['group']).trim()}"` : ''].filter(Boolean).join(', ')
  const head = `${shown.length ? plural(shown.length, what) : `No ${what}s`}${narrowed ? ` (${narrowed})` : ''}. Today is ${today}.`
  if (!shown.length) return head
  return [head, 'id | date | when | kind | group | title | amount | note | action', ...shown.map((item) => datesToolLine(item, today))].join('\n')
}

/* ------------------------------------------------------------ the runner */

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const noSuchId = (id: string): string => `No date has the id "${id}". dates_list shows the ids.`

/** The result of a dates_update, for a caller that wants the line rather than the words. */
export type DatesUpdateResult =
  | { ok: true; item: DateItem | null; removed: boolean; completed: boolean }
  | { ok: false; error: string }

/**
 * Apply one dates_update to the store. Checks the whole change before writing
 * any of it, so a bad snooze day does not leave the other fields half-saved.
 * Never throws.
 */
export function applyDatesUpdate(store: DatesToolStore, args: unknown): DatesUpdateResult {
  try {
    const req = datesUpdateRequest(args)
    if (!req.id) return { ok: false, error: 'An id is needed. dates_list shows the ids.' }
    const before = store.list().find((i) => i.id === req.id)
    if (!before) return { ok: false, error: noSuchId(req.id) }
    if (req.remove) {
      return store.remove(req.id) ? { ok: true, item: before, removed: true, completed: false } : { ok: false, error: noSuchId(req.id) }
    }
    // The store's own snooze check, first, so nothing else is saved when it fails.
    if (req.snoozeUntil !== null && !isDay(req.snoozeUntil)) {
      return { ok: false, error: `"${req.snoozeUntil}" is not a real day to snooze to. Write it as YYYY-MM-DD.` }
    }
    const changes = Object.keys(req.patch).length > 0
    if (!changes && req.snoozeUntil === null && !req.complete) {
      return { ok: false, error: 'Nothing to change: give at least one field, or done, snooze_until or delete.' }
    }
    let item: DateItem | null = before
    if (changes) item = store.update(req.id, req.patch)
    if (item && req.snoozeUntil !== null) item = store.snooze(req.id, req.snoozeUntil)
    if (item && req.complete) item = store.complete(req.id)
    if (!item) return { ok: false, error: noSuchId(req.id) }
    return { ok: true, item, removed: false, completed: req.complete }
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
}

/** One Dates tool call, in words. `now` is for checks; the day is the local calendar day. Never throws. */
export function runDatesTool(store: DatesToolStore, name: string, args: unknown, now: Date = new Date()): DatesToolReply {
  const today = todayOf(now)
  try {
    if (name === 'dates_list') return { ok: true, text: datesListText(store.list(), today, args) }

    if (name === 'dates_add') {
      try {
        const item = store.add(datesInputOf(args), 'agent')
        return { ok: true, text: `Added: ${datesToolLine(item, today)}` }
      } catch (err) {
        return { ok: false, text: `No date was added: ${errText(err)}` }
      }
    }

    if (name === 'dates_update') {
      const result = applyDatesUpdate(store, args)
      if (!result.ok) return { ok: false, text: `No date was changed: ${result.error}` }
      const line = result.item ? datesToolLine(result.item, today) : ''
      if (result.removed) return { ok: true, text: `Deleted: ${line}` }
      if (result.completed && result.item && !result.item.done) {
        return { ok: true, text: `Done, and it repeats: the next one is ${result.item.date}. ${line}` }
      }
      return { ok: true, text: `${result.completed ? 'Marked done' : 'Updated'}: ${line}` }
    }

    return { ok: false, text: `There is no Dates tool called ${name}.` }
  } catch (err) {
    return { ok: false, text: `${name} failed: ${errText(err)}` }
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALERT_SUMMARY_FROM,
  alertSummary,
  alertText,
  applyPatch,
  completeItem,
  daysLeft,
  dueAlert,
  inputError,
  isDay,
  markAlerted,
  newDateId,
  normaliseItem,
  normaliseWeekly,
  sortItems,
  todayOf,
  weeklyPatchError,
  weeklyView,
  type DateAlert,
  type DateInput,
  type DateItem,
  type DatePatch,
  type DatesWeekly,
  type DatesWeeklyPatch,
  type DatesWeeklyView
} from '@shared/dates'
import { getDataDir } from './store'

/**
 * The Dates list on disk: `<dataDir>/dates.json`, `{ version: 1, items, weekly }`.
 * The rules live in shared/dates.ts; this file only loads, keeps, saves and
 * tells listeners. docs/DATES.md is the contract.
 *
 * Loaded once, held in memory, written atomically (tmp file + rename) on every
 * change. A hand-written file is cleaned line by line; a file that is not JSON
 * (or has no list in it) is moved aside to `dates.json.bad-<timestamp>` and the
 * list starts empty. A file with no `weekly` block (or a bad one) gets the
 * defaults, and is saved at once so the block's `since` holds. Loading never
 * throws.
 *
 * No `electron` import, so scripts/dates-check.mjs can drive it against a temp
 * folder through `createDatesService`.
 */

export interface DatesService {
  /** The folder `dates.json` is in (the weekly check reads `dates-weekly-prompt.md` there). */
  readonly dir: string
  list(): DateItem[]
  add(input: DateInput, source?: string): DateItem
  update(id: string, patch: DatePatch): DateItem | null
  complete(id: string): DateItem | null
  snooze(id: string, until: string): DateItem | null
  remove(id: string): boolean
  onChange(cb: (items: DateItem[]) => void): () => void
  onAlert(cb: (alert: DateAlert) => void): () => void
  /**
   * The alert pass. Outside 08:00 to 21:00 local time it does nothing unless
   * `force`. Returns one alert per line it fired; listeners hear the same, or
   * one summary in their place when there are `ALERT_SUMMARY_FROM` or more.
   */
  checkNow(now?: Date, opts?: { force?: boolean }): DateAlert[]
  /** The weekly check's state, with when it runs next. */
  getWeekly(): DatesWeeklyView
  /** Change on/off, the day or the hour. Throws a plain sentence on a bad value. */
  setWeekly(patch: DatesWeeklyPatch): DatesWeeklyView
  /** Record a run of the weekly check: it started, or it failed with `error`. */
  markWeeklyRun(result: 'started' | 'failed', error?: string): DatesWeeklyView
  /** The weekly state after every change to it. Returns the unsubscribe. */
  onWeekly(cb: (weekly: DatesWeeklyView) => void): () => void
}

const FILE = 'dates.json'
/** The alert pass acts from 08:00 up to 21:00 local time. */
const ALERT_FROM_HOUR = 8
const ALERT_UNTIL_HOUR = 21

export function createDatesService(opts: { dir: string; now?: () => Date }): DatesService {
  const file = join(opts.dir, FILE)
  const clock = opts.now ?? (() => new Date())
  const changeListeners = new Set<(items: DateItem[]) => void>()
  const alertListeners = new Set<(alert: DateAlert) => void>()
  const weeklyListeners = new Set<(weekly: DatesWeeklyView) => void>()
  /** The raw `weekly` block from the file, read by `load`; undefined when there was none. */
  let rawWeekly: unknown
  let items: DateItem[] = load()
  let weekly: DatesWeekly = normaliseWeekly(rawWeekly, clock())
  // A file without a sound `since` (no file at all, an older file, a hand
  // edit) is saved now, so the weekly check counts from this moment and not
  // from every start of the app.
  if (!isSince(rawWeekly)) save()

  function isSince(raw: unknown): boolean {
    const since = raw && typeof raw === 'object' ? (raw as { since?: unknown }).since : undefined
    return typeof since === 'string' && !Number.isNaN(Date.parse(since))
  }

  function load(): DateItem[] {
    if (!existsSync(file)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      moveAside(`it is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
      return []
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rawWeekly = (parsed as { weekly?: unknown }).weekly
    const rawItems = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
        ? ((parsed as { items: unknown[] }).items)
        : null
    if (!rawItems) {
      moveAside('it holds no list of items')
      return []
    }
    const now = clock()
    const seen = new Set<string>()
    const out: DateItem[] = []
    rawItems.forEach((raw, index) => {
      const item = normaliseItem(raw, now)
      if (!item) {
        console.warn(`[dates] dropped item ${index} of ${FILE}: it has no title or no valid date`)
        return
      }
      if (seen.has(item.id)) item.id = uniqueId(seen)
      seen.add(item.id)
      out.push(item)
    })
    return out
  }

  function moveAside(why: string): void {
    const bad = `${file}.bad-${clock().getTime()}`
    try {
      renameSync(file, bad)
      console.error(`[dates] ${FILE} could not be read: ${why}. Moved it to ${bad} and started an empty list.`)
    } catch (err) {
      console.error(`[dates] ${FILE} could not be read (${why}) and could not be moved aside:`, err)
    }
  }

  function save(): void {
    const tmp = `${file}.tmp`
    try {
      mkdirSync(opts.dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, items, weekly }, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.error(`[dates] failed to write ${FILE}:`, err)
    }
  }

  function uniqueId(taken: Set<string>): string {
    let id = newDateId()
    while (taken.has(id)) id = newDateId()
    return id
  }

  function list(): DateItem[] {
    return sortItems(items, todayOf(clock()))
  }

  function changed(): void {
    save()
    const snapshot = list()
    for (const cb of changeListeners) {
      try {
        cb(snapshot)
      } catch (err) {
        console.error('[dates] change listener failed:', err)
      }
    }
  }

  function weeklyNow(): DatesWeeklyView {
    return weeklyView(weekly, clock())
  }

  /** Save the weekly block and tell its listeners. */
  function weeklyChanged(): DatesWeeklyView {
    save()
    const view = weeklyNow()
    for (const cb of weeklyListeners) {
      try {
        cb(view)
      } catch (err) {
        console.error('[dates] weekly listener failed:', err)
      }
    }
    return view
  }

  /** Swap one line for its changed self, save and tell. Null when the id is unknown. */
  function replace(id: string, change: (item: DateItem) => DateItem): DateItem | null {
    const index = items.findIndex((i) => i.id === id)
    if (index < 0) return null
    const next = change(items[index]!)
    items = items.map((i, n) => (n === index ? next : i))
    changed()
    return next
  }

  return {
    dir: opts.dir,
    list,

    add(input, source = 'steve') {
      const i = (input ?? {}) as Partial<DateInput>
      const error = inputError({ title: i.title ?? '', date: i.date ?? '', endDate: i.endDate, repeat: i.repeat, remindDays: i.remindDays })
      if (error) throw new Error(error)
      const now = clock()
      const stamp = now.toISOString()
      const item = normaliseItem(
        {
          id: uniqueId(new Set(items.map((x) => x.id))),
          title: i.title,
          date: i.date,
          group: i.group,
          kind: i.kind,
          amount: i.amount,
          endDate: i.endDate,
          note: i.note,
          action: i.action,
          estimated: i.estimated,
          remindDays: i.remindDays,
          repeat: i.repeat,
          source,
          createdAt: stamp,
          updatedAt: stamp
        },
        now
      )
      if (!item) throw new Error('A date needs a title and a real day (YYYY-MM-DD).')
      items = [...items, item]
      changed()
      return item
    },

    update(id, patch) {
      return replace(String(id), (item) => applyPatch(item, patch ?? {}, clock()))
    },

    complete(id) {
      return replace(String(id), (item) => completeItem(item, clock()))
    },

    snooze(id, until) {
      if (!isDay(until)) throw new Error(`"${String(until)}" is not a real day to snooze to. Write it as YYYY-MM-DD.`)
      return replace(String(id), (item) => applyPatch(item, { snoozedUntil: until }, clock()))
    },

    remove(id) {
      const next = items.filter((i) => i.id !== String(id))
      if (next.length === items.length) return false
      items = next
      changed()
      return true
    },

    onChange(cb) {
      changeListeners.add(cb)
      return () => {
        changeListeners.delete(cb)
      }
    },

    onAlert(cb) {
      alertListeners.add(cb)
      return () => {
        alertListeners.delete(cb)
      }
    },

    checkNow(now = clock(), checkOpts = {}) {
      const hour = now.getHours()
      if (!checkOpts.force && (hour < ALERT_FROM_HOUR || hour >= ALERT_UNTIL_HOUR)) return []
      const today = todayOf(now)
      const alerts: DateAlert[] = []
      items = items.map((item) => {
        const due = dueAlert(item, today)
        if (!due) return item
        const marked = markAlerted(item, due)
        alerts.push({ item: marked, daysLeft: daysLeft(marked, today), ...alertText(marked, today) })
        return marked
      })
      if (alerts.length === 0) return []
      changed()
      const heard = alerts.length >= ALERT_SUMMARY_FROM ? [alertSummary(alerts, today)] : alerts
      for (const alert of heard) {
        for (const cb of alertListeners) {
          try {
            cb(alert)
          } catch (err) {
            console.error('[dates] alert listener failed:', err)
          }
        }
      }
      return alerts
    },

    getWeekly: weeklyNow,

    setWeekly(patch) {
      const error = weeklyPatchError(patch)
      if (error) throw new Error(error)
      const p = patch as DatesWeeklyPatch
      weekly = {
        ...weekly,
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        ...(p.weekday !== undefined ? { weekday: p.weekday } : {}),
        ...(p.hour !== undefined ? { hour: p.hour } : {})
      }
      return weeklyChanged()
    },

    markWeeklyRun(result, error) {
      const next: DatesWeekly = { ...weekly, lastRunAt: clock().toISOString(), lastResult: result }
      delete next.lastError
      const why = typeof error === 'string' ? error.trim() : ''
      if (result === 'failed') next.lastError = why || 'The weekly check did not start.'
      weekly = next
      return weeklyChanged()
    },

    onWeekly(cb) {
      weeklyListeners.add(cb)
      return () => {
        weeklyListeners.delete(cb)
      }
    }
  }
}

let service: DatesService | null = null

/** The one Dates list, on the live data dir. Made on first use. */
export function getDates(): DatesService {
  service ??= createDatesService({ dir: getDataDir() })
  return service
}

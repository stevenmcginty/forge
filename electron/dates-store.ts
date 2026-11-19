import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
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
  sortItems,
  todayOf,
  type DateAlert,
  type DateInput,
  type DateItem,
  type DatePatch
} from '@shared/dates'
import { getDataDir } from './store'

/**
 * The Dates list on disk: `<dataDir>/dates.json`, `{ version: 1, items }`.
 * The rules live in shared/dates.ts; this file only loads, keeps, saves and
 * tells listeners. docs/DATES.md is the contract.
 *
 * Loaded once, held in memory, written atomically (tmp file + rename) on every
 * change. A hand-written file is cleaned line by line; a file that is not JSON
 * (or has no list in it) is moved aside to `dates.json.bad-<timestamp>` and the
 * list starts empty. Loading never throws.
 *
 * No `electron` import, so scripts/dates-check.mjs can drive it against a temp
 * folder through `createDatesService`.
 */

export interface DatesService {
  list(): DateItem[]
  add(input: DateInput, source?: string): DateItem
  update(id: string, patch: DatePatch): DateItem | null
  complete(id: string): DateItem | null
  snooze(id: string, until: string): DateItem | null
  remove(id: string): boolean
  onChange(cb: (items: DateItem[]) => void): () => void
  onAlert(cb: (alert: DateAlert) => void): () => void
  /** The alert pass. Outside 08:00 to 21:00 local time it does nothing unless `force`. */
  checkNow(now?: Date, opts?: { force?: boolean }): DateAlert[]
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
  let items: DateItem[] = load()

  function load(): DateItem[] {
    if (!existsSync(file)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      moveAside(`it is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
      return []
    }
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
      writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
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
      for (const alert of alerts) {
        for (const cb of alertListeners) {
          try {
            cb(alert)
          } catch (err) {
            console.error('[dates] alert listener failed:', err)
          }
        }
      }
      return alerts
    }
  }
}

let service: DatesService | null = null

/** The one Dates list, on the live data dir. Made on first use. */
export function getDates(): DatesService {
  service ??= createDatesService({ dir: getDataDir() })
  return service
}

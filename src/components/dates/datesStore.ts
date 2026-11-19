import { useEffect, useState, useSyncExternalStore } from 'react'
import { todayOf, type DateItem, type DatesWeeklyView } from '@shared/dates'
import { datesApi, datesWeeklyApi } from '@/lib/datesApi'

/**
 * The Dates list, held once for the whole window.
 *
 * Two readers want it at the same time — the mode switcher's count and the
 * Dates surface itself — so it is one tiny external store rather than a fetch
 * in each. The first subscriber starts it: one `list()`, then `onChange` for
 * the life of the window (main sends the whole list after every change, from
 * any route: this page, an agent's tool, the phone).
 *
 * `null` means still loading. `missing` means the running preload predates
 * Dates (see src/lib/datesApi.ts): the page says "restart Forge".
 */

export interface DatesSnapshot {
  items: DateItem[] | null
  missing: boolean
}

let snapshot: DatesSnapshot = { items: null, missing: false }
let started = false
const listeners = new Set<() => void>()

function publish(next: DatesSnapshot): void {
  snapshot = next
  for (const cb of listeners) cb()
}

function start(): void {
  if (started) return
  started = true
  const api = datesApi()
  if (!api) {
    publish({ items: [], missing: true })
    return
  }
  api.onChange((items) => publish({ items, missing: false }))
  api.list().then(
    (items) => {
      // A change that arrived first is newer than this answer.
      if (snapshot.items === null) publish({ items, missing: false })
    },
    () => {
      if (snapshot.items === null) publish({ items: [], missing: false })
    }
  )
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  start()
  return () => {
    listeners.delete(cb)
  }
}

export function useDates(): DatesSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/* ---------------------------------------------------------- weekly check */

/**
 * The weekly check's state (docs/DATES.md, "Weekly check"), held the same way:
 * one `get()` for the first subscriber, then `onChange`. `null` while loading,
 * and for good on a preload from before the weekly check.
 */
let weekly: DatesWeeklyView | null = null
let weeklyStarted = false
const weeklyListeners = new Set<() => void>()

function publishWeekly(next: DatesWeeklyView): void {
  weekly = next
  for (const cb of weeklyListeners) cb()
}

function subscribeWeekly(cb: () => void): () => void {
  weeklyListeners.add(cb)
  if (!weeklyStarted) {
    weeklyStarted = true
    const api = datesWeeklyApi()
    if (api) {
      api.onChange(publishWeekly)
      api.get().then(
        (view) => {
          if (weekly === null) publishWeekly(view)
        },
        () => undefined
      )
    }
  }
  return () => {
    weeklyListeners.delete(cb)
  }
}

export function useWeekly(): DatesWeeklyView | null {
  return useSyncExternalStore(subscribeWeekly, () => weekly)
}

/* --------------------------------------------------------------- reveal */

/**
 * A line to bring into view the next time the Dates page is up: set by a click
 * on an alert's in-app notice (which also switches to the page), taken by the
 * page once its list has loaded.
 */
let reveal: { id: string; seq: number } | null = null
const revealListeners = new Set<() => void>()

export function requestReveal(id: string): void {
  reveal = { id, seq: (reveal?.seq ?? 0) + 1 }
  for (const cb of revealListeners) cb()
}

/** Forget the request once it has been acted on. */
export function takeReveal(seq: number): void {
  if (reveal?.seq !== seq) return
  reveal = null
  for (const cb of revealListeners) cb()
}

export function useRevealRequest(): { id: string; seq: number } | null {
  return useSyncExternalStore(
    (cb) => {
      revealListeners.add(cb)
      return () => {
        revealListeners.delete(cb)
      }
    },
    () => reveal
  )
}

/**
 * Today's calendar day, kept current: checked every minute and whenever the
 * window comes back to the front, so a Forge left open overnight does not go on
 * saying "tomorrow" about today.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => todayOf(new Date()))
  useEffect(() => {
    const check = (): void => setToday(todayOf(new Date()))
    const timer = setInterval(check, 60_000)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [])
  return today
}

import type { DateAlert, DateInput, DateItem, DatePatch } from '@shared/dates'
import { applyDatesUpdate, datesInputOf } from '@shared/dates-tools'
import type { WebDatePushPayload } from '@shared/web'

/**
 * The Dates list on the phone link (docs/DATES.md, "Phone"): a request's
 * fields into store calls, and an alert into a push payload.
 *
 * `dates-add` and `dates-update` take the agent tools' fields, so they go
 * through the tools' own mapper (shared/dates-tools.ts) — one place where
 * snake_case becomes the store's camelCase, for agents and phones alike.
 *
 * No `electron` import and no store of its own, so scripts/dates-web-check.mjs
 * drives it against a temp-folder service from `createDatesService`. The
 * store throws a plain sentence on bad input; everything here hands that back
 * as a value, so nothing a phone sends can escape the request handler.
 */

/** What the phone link needs of the Dates service. `DatesService` in electron/dates-store.ts is one. */
export interface WebDatesService {
  list(): DateItem[]
  add(input: DateInput, source?: string): DateItem
  update(id: string, patch: DatePatch): DateItem | null
  complete(id: string): DateItem | null
  snooze(id: string, until: string): DateItem | null
  remove(id: string): boolean
  onChange(cb: (items: DateItem[]) => void): () => void
  onAlert(cb: (alert: DateAlert) => void): () => void
}

export type DatesOutcome = { ok: true; item?: DateItem } | { ok: false; error: string }

/** `dates-add`: a new line from the phone, made by Steve. */
export function addDate(service: WebDatesService, input: unknown): DatesOutcome {
  try {
    return { ok: true, item: service.add(datesInputOf(input), 'steve') }
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : 'That date could not be saved.' }
  }
}

/**
 * `dates-update`: one change to one line, exactly as `dates_update` applies
 * it. A removed line has no `item` in the answer.
 */
export function updateDate(service: WebDatesService, id: unknown, patch: unknown): DatesOutcome {
  const fields = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const result = applyDatesUpdate(service, { ...fields, id })
  if (!result.ok) return result
  return result.removed || !result.item ? { ok: true } : { ok: true, item: result.item }
}

/** The push for one alert, in `alertText`'s words. */
export function datePushPayload(alert: DateAlert): WebDatePushPayload {
  return { kind: 'date', id: alert.item.id, title: alert.title, body: alert.body }
}

/**
 * Every alert the service fires, as a push payload. Returns the unsubscribe.
 * A sender that throws is the sender's problem, never the alert pass's.
 */
export function linkDateAlerts(service: WebDatesService, send: (payload: WebDatePushPayload) => void): () => void {
  return service.onAlert((alert) => {
    try {
      send(datePushPayload(alert))
    } catch (err) {
      console.error('[web] date push failed:', err)
    }
  })
}

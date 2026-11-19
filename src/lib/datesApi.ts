import type { DatesApi } from '@shared/dates'

/**
 * `window.forgeDates`, or null.
 *
 * Null whenever the preload that is running predates Dates (a stale out/
 * bundle, the web client, a test page). Every caller must handle that, as with
 * src/lib/hubApi.ts: an unguarded call on a stale preload throws during render.
 */
export function datesApi(): DatesApi | null {
  const dates = (window as unknown as { forgeDates?: Partial<DatesApi> }).forgeDates
  return dates && typeof dates.list === 'function' && typeof dates.onChange === 'function' ? (dates as DatesApi) : null
}

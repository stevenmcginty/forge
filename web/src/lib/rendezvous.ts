import { isHostLive, parseHostRecord, webHostPath, type WebHostRecord } from '@shared/web'
import type { WebClientConfig } from '../config'

/**
 * How the browser finds the PC — and how it learns the PC is not there.
 *
 * One REST GET against the Realtime Database, at the path `webHostPath` builds.
 * No SDK, no realtime subscription: the record changes when a desktop starts or
 * stops, which is a handful of times a day, and a `.json` GET on a reconnect
 * costs less than a websocket to Google held open for the life of the tab.
 *
 * Nothing here interprets the record. `parseHostRecord` and `isHostLive` in
 * shared/web.ts are the whole of the fall-back decision, and they are shared
 * with the desktop that writes it precisely so the two ends cannot disagree
 * about what "the desktop is available" means.
 */

export type HostLookup =
  /** A record that parses and is fresh enough to dial. */
  | { state: 'live'; record: WebHostRecord }
  /**
   * No record, a stale one, or a protocol number this build cannot speak — all
   * three mean the same thing to the client, which is why they are one value.
   * `record` is present when there was one, so the header can still say which
   * desktop is asleep.
   */
  | { state: 'absent'; record: WebHostRecord | null }
  /**
   * The database could not be read at all — offline, or the rules refused. Not
   * the same as "the desktop is off": there is nothing to say about the desktop
   * either way, and the page must not claim there is.
   */
  | { state: 'unreadable'; error: string }

export async function readHost(config: WebClientConfig, uid: string, idToken: string): Promise<HostLookup> {
  const path = webHostPath(uid)
  if (!path) return { state: 'unreadable', error: 'Signed in without an account id — sign in again.' }

  let response: Response
  try {
    response = await fetch(`${config.databaseUrl}/${path}.json?auth=${encodeURIComponent(idToken)}`, {
      cache: 'no-store'
    })
  } catch (err) {
    return { state: 'unreadable', error: `Could not reach Firebase (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!response.ok) {
    return {
      state: 'unreadable',
      error:
        response.status === 401 || response.status === 403
          ? 'Firebase would not let this account read where the desktop publishes itself. The database rules may not be deployed.'
          : `Firebase answered ${response.status} when asked where the desktop is.`
    }
  }

  let value: unknown
  try {
    value = await response.json()
  } catch {
    return { state: 'unreadable', error: 'Firebase answered with something that is not JSON.' }
  }

  const record = parseHostRecord(value)
  return isHostLive(record, Date.now()) ? { state: 'live', record: record! } : { state: 'absent', record }
}

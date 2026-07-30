/**
 * The Realtime Database, over REST for writes and EventSource for reads.
 *
 * Mirror of electron/companion/rest.ts's database half, and of the path
 * builders in electron/companion/protocol.ts. The paths are duplicated here
 * rather than imported because there is no build step: this file is served
 * verbatim to the phone.
 */

import { idToken, uid } from './auth.js'

let config = null

export function initDb(cfg) {
  config = cfg
}

/* ------------------------------------------------------------------ paths */

export const paths = {
  projects: (u, id) => (id ? `users/${u}/projects/${id}` : `users/${u}/projects`),
  inbox: (u, projectId, itemId) =>
    itemId ? `users/${u}/inbox/${projectId}/${itemId}` : `users/${u}/inbox/${projectId}`,
  outbox: (u, projectId, itemId) =>
    itemId ? `users/${u}/outbox/${projectId}/${itemId}` : `users/${u}/outbox/${projectId}`
}

export const SERVER_TIMESTAMP = { '.sv': 'timestamp' }

/**
 * RTDB keys may not contain `. $ # [ ] /` or control characters. Character-by
 * character rather than a regex, and identical to `safeKey()` in
 * electron/companion/protocol.ts — see the note there about the class that
 * looked right and matched the wrong thing. `-` and space are legal keys and
 * are left alone.
 */
const FORBIDDEN_KEY_CHARS = '.$#/[]'

export function safeKey(id) {
  let out = ''
  for (const ch of String(id).slice(0, 200)) {
    const code = ch.charCodeAt(0)
    out += FORBIDDEN_KEY_CHARS.includes(ch) || code < 0x20 || code === 0x7f ? '_' : ch
  }
  return out || '_'
}

/**
 * A time-ordered id, matching `sortableId()` in protocol.ts.
 *
 * Client-generated rather than an RTDB push id so that a queued write is
 * idempotent: the offline outbox can retry the same PATCH forever without ever
 * producing a second copy of the message.
 */
export function sortableId(now = Date.now()) {
  const stamp = Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')
  let tail = ''
  for (let i = 0; i < 8; i++) tail += Math.floor(Math.random() * 36).toString(36)
  return `${stamp}-${tail}`
}

/**
 * `<databaseURL>/<path>.json`, carrying the base URL's own query string.
 *
 * That last clause is the whole emulator story: the RTDB emulator addresses
 * databases with `?ns=<name>` instead of by hostname, and dropping it turns
 * every request into a 404 that looks like a permissions problem.
 */
export function dbUrl(path, params = {}) {
  const base = new URL(config.databaseURL)
  const clean = String(path).replace(/^\/+/, '').replace(/\/+$/, '')
  const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/${clean}.json`)
  for (const [k, v] of base.searchParams) url.searchParams.set(k, v)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/* ------------------------------------------------------------------ write */

/** Field-merge. Every write from the phone is a PATCH — see the README. */
export async function patch(path, value) {
  const url = dbUrl(path, { auth: await idToken() })
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  })
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

export async function get(path) {
  const url = dbUrl(path, { auth: await idToken() })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}

/* ------------------------------------------------------------------- live */

/**
 * Live-subscribe to a node, reconnecting with a *fresh token* every time.
 *
 * The browser retries a dropped EventSource on its own — but always with the
 * original URL, whose auth token has since expired. So it can loop forever,
 * silently, never re-authenticating, and the only symptom is that new data
 * appears after a page reload and not before. DictationMic learned this the
 * hard way; the fix is to never let the browser retry: tear the stream down on
 * the first error and rebuild it with a token we just minted.
 *
 * The watchdog covers the other half. RTDB sends a keep-alive roughly every
 * 30s, and a TCP connection that has quietly died looks exactly like an idle
 * one, so three missed beats forces a rebuild too.
 *
 * Returns a `stop()` function.
 */
export function live(path, { onEvent, onState }) {
  let stopped = false
  let es = null
  let watchdog = null
  let lastBeat = Date.now()
  let backoff = 1000
  let retryTimer = null

  const teardown = () => {
    if (es) es.close()
    es = null
    if (watchdog) clearInterval(watchdog)
    watchdog = null
  }

  const retry = () => {
    teardown()
    if (stopped) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 60_000)
  }

  const connect = async () => {
    if (stopped) return
    onState?.('connecting')
    let token
    try {
      token = await idToken()
    } catch (err) {
      onState?.(String(err?.message) === 'signed-out' ? 'signed-out' : 'offline')
      if (String(err?.message) === 'signed-out') return
      retry()
      return
    }

    es = new EventSource(dbUrl(path, { auth: token }))
    lastBeat = Date.now()
    watchdog = setInterval(() => {
      if (Date.now() - lastBeat > 95_000) retry()
    }, 30_000)

    const beat = () => {
      lastBeat = Date.now()
    }

    es.addEventListener('open', () => {
      backoff = 1000
      onState?.('live')
    })
    es.addEventListener('keep-alive', beat)
    es.addEventListener('put', (e) => {
      beat()
      dispatch('put', e.data)
    })
    es.addEventListener('patch', (e) => {
      beat()
      dispatch('patch', e.data)
    })
    es.addEventListener('auth_revoked', () => {
      // The token expired mid-stream. Reconnecting mints a new one; if the
      // credentials are genuinely gone, idToken() will say so next time round.
      retry()
    })
    es.addEventListener('cancel', retry)
    es.addEventListener('error', () => {
      onState?.('offline')
      retry()
    })

    const dispatch = (kind, raw) => {
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      try {
        onEvent({ event: kind, path: String(payload?.path ?? '/'), data: payload?.data ?? null })
      } catch (err) {
        // A bad record must never kill the stream. Log and carry on.
        console.warn('[rtdb] handler threw', err)
      }
    }
  }

  void connect()

  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    teardown()
  }
}

/**
 * Fold an RTDB event into a plain object mirror.
 *
 * Handles the five shapes RTDB actually emits — root put/patch, child put/patch,
 * and a single field moving — and returns the new tree. Shared by the project
 * list and each project's feed.
 */
export function applyEvent(tree, kind, path, data) {
  const parts = String(path).split('/').filter(Boolean)
  if (parts.length === 0) {
    if (kind === 'put') return data ?? {}
    return Object.assign(tree ?? {}, data ?? {})
  }
  let node = (tree ??= {})
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key]
  }
  const last = parts[parts.length - 1]
  if (kind === 'put') {
    if (data === null) delete node[last]
    else node[last] = data
  } else {
    node[last] = { ...(node[last] ?? {}), ...(data ?? {}) }
  }
  return tree
}

export { uid }

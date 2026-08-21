import type { WebPushSubscription } from '@shared/web'

/**
 * Web Push: the half of "tell me when a pane needs me" that survives the tab
 * being closed.
 *
 * `state.tsx` already raises a `new Notification` when a pane starts asking
 * while this tab is hidden, and that is the better path whenever it applies —
 * it is instant, it costs nothing, and no third party is involved. But it only
 * exists while the page does. Close the tab, lock the phone, let iOS evict the
 * browser out of memory, and the one moment the notification was for is the one
 * moment nothing is listening. Push is what covers that: the desktop encrypts a
 * payload to this browser's subscription and posts it to the vendor's push
 * service, which wakes `public/sw.js` whether or not Forge is open.
 *
 * ## The one hard requirement: a secure context
 *
 * `serviceWorker` and `PushManager` are secure-context APIs, exactly as
 * `mobile/src/lib/pwa.ts` records for the phone bundle. The deployed client is
 * served by Firebase Hosting over HTTPS and `npm run web:dev` serves it from
 * `localhost`, both of which qualify — but the same dev server answered on a
 * LAN address (`http://192.168.x.x:5174`, which is how this bundle gets looked
 * at on a phone) does not, and there every call below is simply absent. So
 * every entry point here checks and returns nothing rather than throwing: no
 * push is a degraded client, not a broken one, and the tab-local path still
 * works.
 *
 * ## And on an iPhone, an installed one
 *
 * Safari has supported Web Push since 16.4 and only for a web app added to the
 * home screen — a tab in Safari has no `PushManager` at all. That is why
 * `web/public/manifest.webmanifest` and the `apple-mobile-web-app-*` tags in
 * index.html exist: they are not decoration, they are the precondition. See the
 * push section in docs/forge-web.md.
 */

/** Stamped into the registration URL so a deploy re-fetches the worker. */
const VERSION = __WEB_BUILD_ID__

/** Can this browser, in this context, do any of it at all? */
function supported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'PushManager' in window
  )
}

/**
 * The registration, minted at most once per page.
 *
 * Held rather than re-registered because everything below wants it and
 * `register()` on a URL that is already registered resolves to the same
 * registration anyway — the promise is cached to keep the *waiting* to once,
 * not to save the call.
 */
let registering: Promise<ServiceWorkerRegistration | null> | null = null

/**
 * Install `sw.js`, or say honestly that this browser will not have one.
 *
 * Deliberately impossible to fail loudly: this runs during startup and nothing
 * about Forge Web needs a worker to work. A rejected registration means no push
 * and nothing else, so it resolves to `null` rather than rejecting, and every
 * caller treats `null` as "this browser does not do push".
 */
export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return Promise.resolve(null)
  if (registering) return registering
  registering = (async () => {
    try {
      // `?v=` is what makes the browser re-fetch this file. It byte-compares the
      // worker at the *same URL* and would otherwise keep the installed one for
      // up to a day; `updateViaCache: 'none'` stops the HTTP cache answering
      // that check on its behalf. Same reasoning as mobile/src/lib/pwa.ts.
      const registration = await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(VERSION)}`, {
        scope: '/',
        updateViaCache: 'none'
      })
      // `register()` resolves as soon as the worker is *installing*, and a
      // brand-new one has no `pushManager` to subscribe through until it is
      // active. `ready` is the wait for that, and it is the registration this
      // module hands out for exactly that reason.
      return await navigator.serviceWorker.ready.catch(() => registration)
    } catch {
      /* insecure origin, a blocked worker, a 404 — all the same answer */
      return null
    }
  })()
  return registering
}

/**
 * This browser's subscription for the desktop's key, minting one if needed.
 *
 * The reuse check is the interesting part. A subscription is tied to the VAPID
 * key it was created with, and the desktop's key is generated once and kept in
 * its data dir — so it normally never changes, and re-subscribing on every
 * connect would be a new endpoint and a new row in the desktop's device list
 * every time. But it *can* change: a wiped data dir, a second machine, a key
 * rotated by hand. When it has, the held subscription is dead — the desktop can
 * no longer encrypt to it — and the only fix is to drop it and ask for another.
 * So the existing one is compared key-for-key and kept or replaced accordingly.
 *
 * `userVisibleOnly: true` is not optional: Chrome refuses any other value, and
 * it is the promise `sw.js` keeps by always calling `showNotification`.
 */
export async function subscribe(pushKey: string): Promise<WebPushSubscription | null> {
  const key = pushKey.trim()
  if (!key) return null
  const registration = await registerWorker()
  if (!registration) return null

  let applicationServerKey: Uint8Array<ArrayBuffer>
  try {
    applicationServerKey = decodeKey(key)
  } catch {
    /* the desktop sent something that is not a base64url key; nothing to do */
    return null
  }

  try {
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      if (sameKey(existing.options.applicationServerKey, applicationServerKey)) return narrow(existing)
      await existing.unsubscribe().catch(() => false)
    }
    const minted = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
    return narrow(minted)
  } catch {
    // Permission refused after the fact, a push service that would not answer,
    // a browser with the feature switched off in settings. The bell already
    // says where this browser stands; there is nothing useful to add.
    return null
  }
}

/** What this browser is subscribed with right now, or null. Never throws. */
export async function currentSubscription(): Promise<WebPushSubscription | null> {
  const registration = await registerWorker()
  if (!registration) return null
  try {
    const existing = await registration.pushManager.getSubscription()
    return existing ? narrow(existing) : null
  } catch {
    return null
  }
}

/**
 * Stop this browser being pushed to, and say which endpoint stopped.
 *
 * The desktop has to be told separately — `push-unsubscribe` carries the
 * endpoint — because a subscription dropped here leaves the desktop posting to
 * a dead URL until the push service gets round to rejecting it. Returns '' when
 * there was nothing to drop.
 */
export async function unsubscribe(): Promise<string> {
  const registration = await registerWorker()
  if (!registration) return ''
  try {
    const existing = await registration.pushManager.getSubscription()
    if (!existing) return ''
    const { endpoint } = existing
    await existing.unsubscribe()
    return endpoint
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ narrow */

/**
 * `PushSubscription.toJSON()`, checked rather than trusted.
 *
 * The shape is standard, but this object is on its way onto the wire and into
 * the desktop's store, where a missing key means a crash in the encryption
 * rather than a notification that did not arrive. `WebPushSubscription` in
 * shared/web.ts says the two keys are required; this is where that becomes true.
 */
function narrow(subscription: PushSubscription): WebPushSubscription | null {
  const json = subscription.toJSON()
  const endpoint = typeof json.endpoint === 'string' ? json.endpoint : ''
  const p256dh = json.keys?.p256dh ?? ''
  const auth = json.keys?.auth ?? ''
  if (!endpoint || !p256dh || !auth) return null
  return {
    endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth }
  }
}

/* --------------------------------------------------------------- the key */

/**
 * base64url → bytes, because `applicationServerKey` takes a `BufferSource` and
 * the desktop sends the key as the string VAPID libraries print. `atob` wants
 * ordinary base64 with its padding, so the two url-safe substitutions are undone
 * and the '=' put back.
 */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  // Backed by a plain ArrayBuffer explicitly: `applicationServerKey` refuses
  // a view that might sit over a SharedArrayBuffer, and TS 5.7+ says so.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/**
 * Was this subscription minted for the same key the desktop is offering?
 *
 * `options.applicationServerKey` comes back as the raw `ArrayBuffer` the
 * browser kept, so the comparison is byte-for-byte rather than string-for-
 * string — there is no encoding to disagree about. A browser old enough not to
 * report the option at all is treated as a mismatch, which costs one needless
 * re-subscribe and never leaves a dead subscription in place.
 */
function sameKey(held: ArrayBuffer | null | undefined, offered: Uint8Array): boolean {
  if (!held) return false
  const bytes = new Uint8Array(held)
  if (bytes.length !== offered.length) return false
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== offered[i]) return false
  return true
}

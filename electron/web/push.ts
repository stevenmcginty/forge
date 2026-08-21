import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as webpush from 'web-push'
import type { WebPushPayload, WebPushSubscription } from '@shared/web'
import { getDataDir, getSettings } from '../store'

/**
 * Web Push, so a browser that is not open still hears that a pane is waiting.
 *
 * The link Forge Web already has is a WebSocket, and a WebSocket is only worth
 * anything while a tab is alive. The whole point of this file is the other
 * case: the phone is in a pocket, the laptop lid is shut, and Claude has just
 * stopped to ask whether it may delete something. Web Push is the one channel
 * that reaches a browser with no page running — the payload goes to the
 * *vendor's* push service (Google's, Apple's, Mozilla's), encrypted to a key
 * only that browser holds, and the service worker in web/ wakes up and draws a
 * notification.
 *
 * Three things follow from that and are worth saying out loud:
 *
 * **This desktop is the sender, and it needs an identity.** VAPID is that
 * identity — a keypair generated here, once, on first use. The public half goes
 * to the browser in `hello-ok` so `pushManager.subscribe` can bind a
 * subscription to *this* Forge; the private half signs every send and never
 * leaves this disk. Rotating it silently would orphan every subscription
 * already out there, so the keys are generated exactly once and then only read.
 *
 * **A subscription is a credential somebody else issued.** It is not a device
 * this desktop paired with and there is nothing to verify about it: whoever
 * holds it can be sent notifications, and that is all it can ever do. What is
 * checked here is *shape* — an `https:` endpoint of sane length and two
 * base64url keys — because these strings are handed to a library that will make
 * an HTTPS request out of them, and a malformed one should be dropped in this
 * file rather than become a stack trace somewhere in the socket handler.
 *
 * **Nothing here throws.** Every public function is total. A corrupt
 * `web-push.json`, a push service returning 500, a subscription the browser
 * forgot about — all of them are ordinary and none of them is a reason for the
 * link to fall over. The one failure that is *acted* on is 404/410, which is
 * the push service saying "that subscription is dead": those are dropped,
 * because keeping them means posting to a wall forever.
 */

/** The store, beside settings.json and the browser inbox. */
function storeFile(): string {
  return join(getDataDir(), 'web-push.json')
}

/**
 * How long a push message may sit at the push service waiting for a browser
 * that is offline. Ten minutes: an attention notification is about a pane that
 * is waiting *now*, and one delivered an hour later is a lie about the present.
 */
const PUSH_TTL_SECONDS = 600

/**
 * At most one push per pane per this long.
 *
 * A pane can cross the attention line several times in a few seconds — an agent
 * prints, settles on a question, prints again, settles again — and every
 * crossing is real. Only the first is worth a buzz.
 */
const PUSH_THROTTLE_MS = 30_000

/** How often one endpoint's failures may be written to the log. */
const COMPLAIN_EVERY_MS = 60_000

/** Endpoints longer than this are not endpoints; the vendors' are ~200 chars. */
const MAX_ENDPOINT_CHARS = 2048
/** Both VAPID-era subscription keys are base64url and well under this. */
const MAX_KEY_CHARS = 256

/**
 * The VAPID `sub` claim, which the spec says must be a way to reach whoever is
 * sending — a push service with a complaint about this sender has somewhere to
 * take it. Forge Web's own sign-in email when there is one, and the project
 * otherwise; both are true statements, and inventing an address would not be.
 */
const FALLBACK_SUBJECT = 'https://github.com/stevenmcginty/forge'

export interface StoredSubscription extends WebPushSubscription {
  expirationTime: number | null
  /** What the browser called itself at `push-subscribe` time — for a device list. */
  deviceName: string
  /** The `hello` deviceId of the socket that subscribed, when it had one. */
  deviceId: string
  addedAt: number
}

interface PushStore {
  vapid: { publicKey: string; privateKey: string }
  subscriptions: StoredSubscription[]
}

/**
 * Read once and kept, because every send needs the private key and re-reading a
 * file per notification would be a syscall for nothing. `null` means "not read
 * yet", never "empty" — see `loaded`.
 */
let store: PushStore | null = null

/** sessionId → when it last pushed, and what it said. See `notify`. */
const lastPush = new Map<string, { at: number; key: string }>()

/** endpoint → when its last failure was logged. See `complain`. */
const complained = new Map<string, number>()

/**
 * The store, reading it from disk or minting a fresh one.
 *
 * A file that will not parse, or that has lost its keys, is *replaced* rather
 * than repaired — half a keypair signs nothing, and the recovery is one line in
 * the log plus every browser re-subscribing on its next connection, which is a
 * thing the client does anyway when the key it is handed is not the key it
 * subscribed under. Never throws: a data directory that cannot be read leaves
 * an in-memory store that works until the next launch.
 */
function loaded(): PushStore {
  if (store) return store

  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(storeFile(), 'utf8'))
  } catch {
    /* not there yet, or not readable — both mean "start one" */
  }

  const parsed = readStore(raw)
  if (parsed) {
    store = parsed
    return store
  }
  if (raw !== null) console.log('[web-push] web-push.json could not be read — starting a fresh keypair')

  const vapid = webpush.generateVAPIDKeys()
  store = { vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey }, subscriptions: [] }
  save()
  return store
}

function readStore(raw: unknown): PushStore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const vapid = record['vapid']
  if (!vapid || typeof vapid !== 'object') return null
  const keys = vapid as Record<string, unknown>
  const publicKey = typeof keys['publicKey'] === 'string' ? keys['publicKey'] : ''
  const privateKey = typeof keys['privateKey'] === 'string' ? keys['privateKey'] : ''
  if (!publicKey || !privateKey) return null

  const list = Array.isArray(record['subscriptions']) ? record['subscriptions'] : []
  const subscriptions: StoredSubscription[] = []
  for (const entry of list) {
    const stored = readStored(entry)
    if (stored) subscriptions.push(stored)
  }
  return { vapid: { publicKey, privateKey }, subscriptions }
}

function readStored(raw: unknown): StoredSubscription | null {
  const subscription = readSubscription(raw)
  if (!subscription) return null
  const record = raw as Record<string, unknown>
  const expiry = record['expirationTime']
  const addedAt = record['addedAt']
  return {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    expirationTime: typeof expiry === 'number' ? expiry : null,
    deviceName: typeof record['deviceName'] === 'string' ? record['deviceName'].slice(0, 64) : '',
    deviceId: typeof record['deviceId'] === 'string' ? record['deviceId'].slice(0, 128) : '',
    addedAt: typeof addedAt === 'number' && addedAt > 0 ? addedAt : Date.now()
  }
}

/**
 * Whether a thing off the wire is a subscription this file will keep.
 *
 * Shape and nothing more — there is no way to tell a real subscription from an
 * invented one short of posting to it, and posting to it is what this is for.
 * What the checks buy is that whatever reaches `webpush.sendNotification` is an
 * `https:` URL and two base64url strings, rather than something that turns into
 * a thrown error inside a library four frames below the socket handler.
 */
function readSubscription(raw: unknown): WebPushSubscription | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const endpoint = typeof record['endpoint'] === 'string' ? record['endpoint'].trim() : ''
  if (!endpoint || endpoint.length > MAX_ENDPOINT_CHARS) return null
  try {
    if (new URL(endpoint).protocol !== 'https:') return null
  } catch {
    return null
  }

  const keys = record['keys']
  if (!keys || typeof keys !== 'object') return null
  const pair = keys as Record<string, unknown>
  const p256dh = typeof pair['p256dh'] === 'string' ? pair['p256dh'] : ''
  const auth = typeof pair['auth'] === 'string' ? pair['auth'] : ''
  if (!isKey(p256dh) || !isKey(auth)) return null

  return { endpoint, keys: { p256dh, auth } }
}

function isKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEY_CHARS && /^[A-Za-z0-9_-]+=*$/.test(value)
}

/**
 * Write the store, temp file then rename.
 *
 * The same two-step electron/store.ts uses, for the same reason: this file
 * holds the only copy of a keypair every subscription out there is bound to,
 * and a truncated write during a power cut would take them all with it.
 */
function save(): void {
  if (!store) return
  const target = storeFile()
  const temp = `${target}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(temp, target)
  } catch (err) {
    console.log(`[web-push] could not write web-push.json: ${err instanceof Error ? err.message : String(err)}`)
    try {
      unlinkSync(temp)
    } catch {
      /* nothing to clean up */
    }
  }
}

/**
 * The VAPID public key, generating the pair on first ask.
 *
 * '' only when the data directory itself is unusable, which the caller reads as
 * "this desktop cannot send push" — `hello-ok` then carries no `pushKey` and
 * the browser shows no bell, which is the honest picture.
 */
export function publicKey(): string {
  try {
    return loaded().vapid.publicKey
  } catch {
    return ''
  }
}

/**
 * Remember a browser's subscription.
 *
 * Keyed on the endpoint, which is the identity a push service issues: a browser
 * re-subscribing — a new page load, a permission re-grant, a key rotation —
 * sends the same endpoint back and replaces its record rather than adding a
 * second one that would buzz the same phone twice. Malformed subscriptions are
 * dropped in silence; there is nobody to tell and nothing they could do.
 */
export function subscribe(sub: WebPushSubscription, meta: { deviceName?: string; deviceId?: string }): void {
  try {
    const valid = readSubscription(sub)
    if (!valid) return
    const state = loaded()
    const expiry = typeof sub.expirationTime === 'number' ? sub.expirationTime : null
    const record: StoredSubscription = {
      endpoint: valid.endpoint,
      keys: valid.keys,
      expirationTime: expiry,
      deviceName: (meta.deviceName ?? '').slice(0, 64),
      deviceId: (meta.deviceId ?? '').slice(0, 128),
      addedAt: Date.now()
    }
    const at = state.subscriptions.findIndex((s) => s.endpoint === record.endpoint)
    if (at >= 0) state.subscriptions[at] = record
    else state.subscriptions.push(record)
    save()
  } catch {
    /* a store that cannot be written is not a reason to drop the socket */
  }
}

/** Forget one endpoint. Silent whether or not it was known — the caller says `ok` either way. */
export function unsubscribe(endpoint: string): void {
  try {
    const state = loaded()
    const before = state.subscriptions.length
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint)
    if (state.subscriptions.length !== before) save()
  } catch {
    /* as above */
  }
}

/** What is subscribed right now. A copy, so a caller cannot edit the store by accident. */
export function list(): StoredSubscription[] {
  try {
    return loaded().subscriptions.map((s) => ({ ...s, keys: { ...s.keys } }))
  } catch {
    return []
  }
}

/**
 * Send one payload to every subscription.
 *
 * Two gates before anything goes out, both keyed on the pane rather than on the
 * subscription, because the thing being rate-limited is *the news*: a pane that
 * has already buzzed a phone in the last PUSH_THROTTLE_MS does not buzz it
 * again, and a pane repeating exactly what it last said — same state, same
 * question line, which is what a settle-print-settle cycle produces — says
 * nothing at all. Both are deliberately generous. The alternative to a missed
 * notification is a person who has switched notifications off.
 *
 * The sends themselves are concurrent and independently settled: one dead
 * endpoint must not stop the phone that is actually in somebody's hand from
 * being told. 404 and 410 are the push service saying the subscription is gone
 * for good, and those are the only failures that change the store; everything
 * else is transient by assumption and the subscription is kept.
 */
export async function notify(payload: WebPushPayload): Promise<void> {
  let state: PushStore
  try {
    state = loaded()
  } catch {
    return
  }
  if (state.subscriptions.length === 0) return

  const key = `${payload.state} ${payload.prompt ?? ''}`
  const now = Date.now()
  const last = lastPush.get(payload.sessionId)
  if (last && (last.key === key || now - last.at < PUSH_THROTTLE_MS)) return
  lastPush.set(payload.sessionId, { at: now, key })

  const body = JSON.stringify(payload)
  const options = {
    TTL: PUSH_TTL_SECONDS,
    urgency: 'high' as const,
    vapidDetails: {
      subject: subject(),
      publicKey: state.vapid.publicKey,
      privateKey: state.vapid.privateKey
    }
  }

  const dead: string[] = []
  await Promise.allSettled(
    state.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, options)
      } catch (err) {
        // `WebPushError` carries the push service's status code. 404/410 is the
        // one answer that is about the *subscription* rather than the moment.
        const status = Number((err as { statusCode?: unknown })?.statusCode)
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint)
          return
        }
        complain(sub.endpoint, err)
      }
    })
  )

  if (dead.length > 0) {
    state.subscriptions = state.subscriptions.filter((s) => !dead.includes(s.endpoint))
    save()
  }
}

function subject(): string {
  try {
    const email = getSettings().webEmail.trim()
    return email ? `mailto:${email}` : FALLBACK_SUBJECT
  } catch {
    return FALLBACK_SUBJECT
  }
}

/**
 * One line per endpoint per minute, and no more.
 *
 * A push service that is down is down for every send, and this runs once per
 * attention transition across every subscription — an unthrottled log would be
 * the loudest thing in the console for exactly as long as somebody's wifi is
 * bad, and would say the same sentence each time.
 */
function complain(endpoint: string, err: unknown): void {
  const now = Date.now()
  const previous = complained.get(endpoint) ?? 0
  if (now - previous < COMPLAIN_EVERY_MS) return
  complained.set(endpoint, now)
  const where = endpoint.slice(0, 60)
  console.log(`[web-push] send to ${where}… failed: ${err instanceof Error ? err.message : String(err)}`)
}

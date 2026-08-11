import { X509Certificate, createVerify, timingSafeEqual } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES } from '@shared/mobile'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS, type WebRefusal } from '@shared/web'
import type { WebDeviceRecord } from '@shared/types'
import { verifyPin } from './pin'

/**
 * Forge Web authentication — the lock on the door.
 *
 * Be honest about what this protects, and about what it costs to get wrong.
 * Forge Web puts a shell on a home PC behind a public web address, and the
 * protocol's `write` frame types into a live shell, so **a valid credential
 * here is a shell as Steve.** Constraining the frames bounds what an accident
 * does; it does nothing about somebody who holds a credential. Everything in
 * this file therefore defends the credential itself.
 *
 * ## The one difference from electron/mobile/auth.ts
 *
 * Forge Mobile mints its own device token, because a phone link has no identity
 * provider behind it; that is why its record holds a SHA-256 and why its header
 * leads with "only hashes are stored". Forge Web has an identity provider. The
 * credential is a Firebase ID token — a JWT the browser already holds — and it
 * is verified against Google's published keys on *every* connection, not once
 * at pairing (docs/forge-web.md, security posture; `WebHelloFrame` in
 * shared/web.ts). Minting a second credential beside a verified one would add a
 * thing to steal and prove nothing the first does not.
 *
 * So the hashing rule does not appear on the *device list*, and its absence is
 * not a relaxation. The rule underneath it is the one that carries over:
 * **nothing written to settings.json may be usable as a credential.** Mobile
 * satisfies that by storing a one-way image of its token. Forge Web satisfies
 * it by having no token to store — a `WebDeviceRecord` is an id, a name and
 * three timestamps, and a copy of the whole device list is a list of browser
 * names. It records where a token has been used; it is not a key.
 *
 * The one secret this feature does write down is the unlock PIN, and it obeys
 * that rule too: electron/web/pin.ts stores a scrypt image of it and never the
 * digits. What that does and does not buy is set out in full in that file's
 * header, honestly, because four digits are not entropy.
 *
 * ## The door is the account plus a PIN, and nothing else
 *
 * There is no prompt at the desk here, and there used to be. The word-pair
 * approval and the TOTP second factor are both gone, replaced by one thing a
 * person sets once in Settings: an unlock PIN, asked of every browser on every
 * connection.
 *
 * The reason is that a prompt at the desk can only be answered by somebody
 * standing at this machine, so a door that demanded one was a door that locked
 * Steve out of his own desktop from a hotel a hundred miles away — and a TOTP
 * enrolment is a phone, an app and ten recovery codes to keep, for a feature
 * used by exactly one person who is already signed into an account. What
 * survives being away from the desk is what actually defends this door:
 *
 *  - the token is verified against Google's keys on every connection;
 *  - the uid must match, and a token for another account is refused;
 *  - **a revoked browser is refused**, before the PIN is even asked for, and
 *    revoking drops its live socket (electron/web-host.ts);
 *  - the PIN, which is the one thing a stolen Firebase password does not come
 *    with, and which is asked afresh every time — a browser on the device list
 *    is excused nothing;
 *  - every browser is recorded, listed and revocable.
 *
 * With no PIN set the account alone gets in, which is the state this desktop
 * ships in and is deliberate rather than an oversight: shared/types.ts states
 * the trade beside `webPin`, once, and this file does not restate it. What that
 * state does *not* buy is the mouse — see `canControl` in
 * electron/web-host.ts, which refuses screen control outright without a PIN.
 *
 * The PIN is short, and electron/web/pin.ts is honest about what hashing four
 * digits does and does not buy. The part that belongs here is the other half of
 * that answer: **the per-source lockout below is what makes a four-digit secret
 * defensible at all.** Five wrong answers and that address is refused for a
 * minute, so ten thousand guesses are weeks of them rather than seconds.
 *
 * ## What is kept from the neighbour
 *
 *  1. **Constant-time comparison.** See `sameString`, and the honest note there
 *     about which of these comparisons is actually secret.
 *  2. **Failure lockout per source**, on `AUTH_MAX_FAILURES`/`AUTH_LOCKOUT_MS`
 *     from shared/mobile.ts rather than numbers invented here.
 *  3. **Everything injected**, including the clock and the JWKS fetcher, so a
 *     check script drives this exact class with no network and no Electron.
 *
 * ## What this does *not* protect against
 *
 *  - A browser profile that is signed in and whose person knows the PIN. A
 *    person at that machine is that browser.
 *  - Anything after the socket is authenticated. Rate limits, frame caps and
 *    the session vocabulary live in electron/web/server.ts; this file's job
 *    ends the moment it says yes.
 *
 * Electron-free and dependency-free (`node:crypto` only — no `jsonwebtoken`,
 * no `jose`, no `firebase-admin`), so the check script bundles and drives this
 * exact class. RS256 is a signature verification `node:crypto` has always been
 * able to do, and the JWKS is a plain HTTPS GET.
 */

/* ------------------------------------------------------------ Google's keys */

/**
 * Where Firebase ID tokens' signing keys live.
 *
 * Note what this endpoint serves: X.509 *certificates* keyed by `kid`, not a
 * JWK set. That is Google's published shape for the securetoken service, and it
 * is why the code below goes through `X509Certificate` rather than importing a
 * JWK — the constant is named for the job, not for the format.
 */
export const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

/** `iss` is this, with the project id appended. Built once, compared many times. */
const ISSUER_PREFIX = 'https://securetoken.google.com/'

/**
 * How far out of step this desktop's clock may be with Google's before a
 * perfectly good token starts being refused.
 *
 * A minute, deliberately small. The window applies in both directions — a token
 * is accepted for a minute past its `exp`, and one minted a minute in the
 * "future" is accepted rather than treated as forged — so every second of it is
 * a second of extra life for a token that should be dead. A minute covers a
 * machine whose NTP sync is late; it does not cover a machine whose clock is
 * wrong, and the right fix for that one is the clock.
 */
export const CLOCK_SKEW_MS = 60_000

/**
 * Bounds on how long a fetched key set is trusted, whatever `Cache-Control`
 * said.
 *
 * The header is honoured (Google sends a long `max-age`, and re-fetching per
 * connection would be a request to Google on every keystroke of a reconnect),
 * but it is not obeyed blindly: a response that arrives with `max-age=0`
 * because something between here and Google rewrote it would turn every
 * connection into a network round trip, and one with an absurd `max-age` would
 * pin a rotated-out key set for a week.
 */
const JWKS_MIN_TTL_MS = 5 * 60_000
const JWKS_MAX_TTL_MS = 24 * 60 * 60_000
/** When the response says nothing about caching at all. */
const JWKS_FALLBACK_TTL_MS = 60 * 60_000

/**
 * Floor between fetches forced by an unknown `kid`.
 *
 * Google rotates its signing keys, so a `kid` this desktop has never seen is
 * the ordinary way a rotation is noticed and must trigger a re-fetch. But the
 * `kid` comes off the wire, from anybody who can reach the address: without a
 * floor, a stranger sending a hundred tokens with a hundred invented `kid`s
 * turns this desktop into a hundred requests at Google. One a minute is far
 * faster than a rotation and far slower than an amplifier.
 */
const JWKS_MIN_REFETCH_MS = 60_000

/* ------------------------------------------------------------------- shapes */

/**
 * An admitted browser, as persisted in Settings. Note: no credential anywhere.
 *
 * An alias of the settings record rather than a second declaration, so the
 * thing this module writes and the thing `Settings.webDevices` holds cannot
 * drift apart. The import is type-only, so this file still carries no runtime
 * dependency beyond `node:crypto` and the check script can bundle it alone.
 */
export type WebDevice = WebDeviceRecord

/**
 * The one sentence a refused PIN ever gets, wherever it was presented.
 *
 * Written once because it must not drift: "wrong", "not digits" and "the wrong
 * number of them" are three different facts and one answer, since telling them
 * apart out loud tells somebody guessing which half of their guess was right.
 */
const BAD_PIN = 'That PIN was not accepted.'

/** The one sentence that *asks* for a PIN, so both doors word it identically. */
const ASK_PIN = `Enter the ${PIN_MIN_DIGITS}-to-${PIN_MAX_DIGITS} digit PIN set on the desktop.`

/** One JWKS response, as the injected fetcher hands it over. */
export interface JwksResponse {
  /** The body verbatim — Google's `{ "<kid>": "<PEM certificate>" }` JSON. */
  body: string
  /**
   * The `Cache-Control` header verbatim, or absent when there was none.
   *
   * Handed over unparsed on purpose: honouring `max-age` is a decision this
   * module makes and a check script can therefore exercise. A fetcher that
   * returned a TTL would be a fetcher that owned the caching policy, and the
   * policy would be the one thing about this module nobody tested.
   */
  cacheControl?: string
}

/**
 * Fetch Google's signing keys.
 *
 * **Injected, never imported, and the single most important testability
 * decision in this file.** An auth module that can only be exercised against
 * live Google is an auth module nobody exercises, and the refusal paths — the
 * ones that are the difference between a locked door and an open one — are
 * exactly the paths a live-Google test cannot reach. See `googleJwksFetcher`
 * for the one this desktop actually runs with.
 */
export type JwksFetcher = (url: string) => Promise<JwksResponse>

/**
 * The real fetcher, for the Electron host to pass in.
 *
 * Exported rather than defaulted, and that is the point: there is no fallback
 * to the network inside this class, so "did the check script exercise the
 * injected path" is never a question anybody has to reason about. The host
 * wires this in one line; a test wires in fixed keys.
 */
export function googleJwksFetcher(): JwksFetcher {
  return async (url: string): Promise<JwksResponse> => {
    // Bounded, because an unbounded one is a browser stuck on "Reconnecting"
    // with nothing to read. This fetch sits inside `hello`, and `hello` has a
    // HEARTBEAT_GRACE_MS deadline the desktop enforces by closing the socket
    // with no frame on it — so a cold key cache behind a slow or blocked path
    // to googleapis.com produced a silent hang-up and a retry loop, and every
    // retry started the same doomed fetch again. Failing at 8s instead lets the
    // rejection reach a caller that can say what happened.
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
    return { body: await res.text(), cacheControl: res.headers.get('cache-control') ?? '' }
  }
}

/**
 * How long Google's key endpoint gets before the connection it is holding up is
 * failed instead. Comfortably inside HEARTBEAT_GRACE_MS, which is the deadline
 * that actually matters — see the note in `googleJwksFetcher`.
 */
const JWKS_TIMEOUT_MS = 8_000

/**
 * Everything this class needs from the world, and nothing else.
 *
 * The house pattern, and the same one `AuthStoreHost` and `MobileServerHost`
 * follow: the consumer declares the narrow interface, and the Electron host
 * implements it by calling the existing modules. Nothing here is Electron, a
 * socket, or a file.
 */
export interface WebAuthHost {
  /** The admitted browsers as they stand in settings. */
  load: () => WebDevice[]
  /** Persist a changed device list. Called on admit, revoke and last-seen bumps. */
  save: (devices: WebDevice[]) => void
  /** Google's keys. Required, never defaulted — see `JwksFetcher`. */
  fetchJwks: JwksFetcher
  /**
   * The Firebase project whose tokens count, and the one uid admitted. Read per
   * connection rather than captured, so revoking an account's access at the
   * desk bites on the next hello rather than the next restart. Either being
   * blank means this desktop is not configured, and an unconfigured desktop
   * admits nobody.
   */
  projectId: () => string
  uid: () => string
  /**
   * The unlock PIN as it stands on disk — the `scrypt$1$…` string, or '' when
   * none is set. Never the digits: this class compares, and what a stored PIN
   * looks like is electron/web/pin.ts's business.
   *
   * Read per connection like everything else here, so setting or clearing a PIN
   * at the desk bites on the next hello rather than the next restart. A host
   * that omits it has no PIN, which is the account-only door and what makes a
   * test server safe to construct in one line.
   */
  pinHash?: () => string
  /** Injected so a check script can drive expiry and lockout on a fake clock. */
  now?: () => number
  log?: (line: string) => void
}

/** A verified token's claims, after every check below has passed. */
export interface WebTokenClaims {
  /** `sub` — the Firebase uid, already matched against the configured one. */
  uid: string
  aud: string
  iss: string
  /** Seconds, as they appear in the token. */
  exp: number
  iat: number
  authTime: number
}

/**
 * The answer to "does this credential get in".
 *
 * Every refusal carries a `WebRefusal` from shared/web.ts and a sentence
 * written for the person reading the browser tab. There is deliberately no
 * parallel error type: the protocol's vocabulary is the vocabulary, because the
 * whole reason those values are separate is that they are different sentences
 * on screen with different recoveries.
 */
export type WebTokenOutcome =
  | { ok: true; claims: WebTokenClaims }
  | { ok: false; reason: WebRefusal; message: string; retryAfterMs?: number }

export type WebAuthOutcome =
  | { ok: true; device: WebDevice; claims: WebTokenClaims }
  | { ok: false; reason: WebRefusal; message: string; retryAfterMs?: number }

export interface WebAuthInput {
  /** The remote address. The unit of lockout, exactly as in mobile/auth.ts. */
  source: string
  /** The Firebase ID token off the `hello` frame. */
  idToken: string
  /** The browser's per-profile id. Compared, never trusted. */
  deviceId: string
  /** Untrusted display text. */
  deviceName: string
  /**
   * The unlock PIN off the `hello` frame. Absent on the first attempt of every
   * sign-in — see `WebHelloFrame.pin`.
   */
  pin?: string
}

/* ------------------------------------------------------------------ helpers */

/**
 * Constant-time compare of two strings.
 *
 * Used for `uid`, `aud` and `iss`, and it is worth being honest about why: none
 * of those three is a secret. An attacker holding a token already knows its
 * `aud` and `iss`, and a uid is not a credential. The reason this exists anyway
 * is that a file which starts making case-by-case exceptions to "compare in
 * constant time" is a file that eventually makes the wrong one, and the cost of
 * the rule is a buffer allocation on a path that runs once per connection.
 *
 * The length guard is not a leak worth caring about for the same reason, and
 * `timingSafeEqual` throws on a length mismatch, so there has to be one.
 */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

/** One base64url segment as bytes, or null. Total: this arrives off the wire. */
function segmentBytes(segment: string): Buffer | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    return Buffer.from(segment, 'base64url')
  } catch {
    return null
  }
}

/** One base64url JSON segment as an object, or null. Never throws. */
function segmentJson(segment: string): Record<string, unknown> | null {
  const bytes = segmentBytes(segment)
  if (!bytes) return null
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A numeric claim, or null when it is not a finite number. */
function numberClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `max-age` out of a `Cache-Control` header, clamped. See JWKS_MIN_TTL_MS. */
function jwksTtlMs(cacheControl: string | undefined): number {
  const match = /(?:^|[\s,])max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '')
  if (!match) return JWKS_FALLBACK_TTL_MS
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds)) return JWKS_FALLBACK_TTL_MS
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, seconds * 1000))
}

interface Strike {
  count: number
  until: number
}

/* -------------------------------------------------------------------- class */

export class WebAuth {
  private readonly host: WebAuthHost
  private readonly now: () => number
  private strikes = new Map<string, Strike>()

  /** kid → public key, as last fetched. Null until the first fetch lands. */
  private keys: Record<string, KeyObject> | null = null
  private keysExpireAt = 0
  private keysFetchedAt = 0
  /** One in-flight fetch, shared: a burst of reconnects is one request, not ten. */
  private fetching: Promise<void> | null = null

  constructor(host: WebAuthHost) {
    this.host = host
    this.now = host.now ?? (() => Date.now())
  }

  /* ------------------------------------------------------------- the device list */

  devices(): WebDevice[] {
    return this.host.load()
  }

  /**
   * Revoke a browser: it keeps its row, marked. Its live socket is closed by the
   * server, separately.
   *
   * A tombstone rather than a deletion, because `revoked` and `not-approved` are
   * different answers with different recoveries — see `WebDeviceRecord.revokedAt`
   * — and a deleted row would make a revoked browser look like a stranger and
   * earn it a fresh prompt every time it reconnected.
   */
  revoke(deviceId: string): boolean {
    const devices = this.host.load()
    const found = devices.find((d) => d.id === deviceId && !d.revokedAt)
    if (!found) return false
    found.revokedAt = this.now()
    this.host.save(devices)
    return true
  }

  revokeAll(): void {
    const now = this.now()
    this.host.save(this.host.load().map((d) => (d.revokedAt ? d : { ...d, revokedAt: now })))
  }

  /**
   * Drop a row entirely, tombstone and all — the only way back for a revoked
   * browser, and a deliberate act at the desk rather than something the browser
   * can ask for. Forgotten, it is a stranger again, and a stranger needs a human
   * to press Allow.
   */
  forget(deviceId: string): boolean {
    const devices = this.host.load()
    const next = devices.filter((d) => d.id !== deviceId)
    if (next.length === devices.length) return false
    this.host.save(next)
    return true
  }

  /* ----------------------------------------------------------------- the door */

  /**
   * Authenticate a `hello`.
   *
   * Six gates, in this order, and the order is load-bearing:
   *
   *  1. **Lockout**, so a source that has been failing does not get to keep
   *     trying while the rest of this runs — and, since the PIN is short, so
   *     that the guessing is what runs out rather than the guesser's patience.
   *  2. **The token**, verified against Google's keys — signature *and* every
   *     claim. A token that does not verify is `bad-token` whatever uid it
   *     claims, which is why this runs before the uid is looked at: a token
   *     minted by somebody else's Firebase project whose `sub` happens to equal
   *     ours must not be able to reach the `wrong-account` branch and learn it
   *     guessed right.
   *  3. **The account**, which is `wrong-account` and a genuinely different
   *     outcome: a different sentence, a different recovery, and never a retry
   *     loop on a correct credential.
   *  4. **A device id at all**, because an admission is recorded against one
   *     and a revocation later names one.
   *  5. **Revocation.** A browser somebody ended at this desk stays ended, and
   *     it is turned away *before* being invited to type a PIN — there is
   *     nothing a correct one could have bought it, and a revoked browser being
   *     asked to guess is a revoked browser being given attempts.
   *  6. **The PIN**, when one is set. Asked of every browser on every
   *     connection; being on the device list excuses nothing.
   *
   * Then one admission path, not two: a known row is updated and an unknown one
   * is created. There is no prompt branch any more, so there is no way for the
   * two to drift.
   */
  async authenticate(input: WebAuthInput): Promise<WebAuthOutcome> {
    const locked = this.lockout(input.source)
    if (locked) return locked

    const verified = await this.checkToken(input.idToken)
    if (!verified.ok) return this.fail(input.source, verified)

    // Clamped to the same bounds `webDevices` in electron/store.ts enforces on
    // the way back off disk, because this is the end that writes them: a store
    // that trims what it reads and a writer that does not is a row that changes
    // shape on the next restart, and the id is what a device is matched by.
    const deviceId = input.deviceId.slice(0, 128)
    const deviceName = (input.deviceName || 'Browser').slice(0, 64)
    if (!deviceId) {
      return this.fail(input.source, {
        ok: false,
        reason: 'not-approved',
        message: 'This browser did not identify itself, so it cannot be admitted. Reload the page and try again.'
      })
    }

    const devices = this.host.load()
    const known = devices.find((d) => sameString(d.id, deviceId))

    if (known?.revokedAt) {
      return this.fail(input.source, {
        ok: false,
        reason: 'revoked',
        message: "This browser was removed from the desktop's device list. Sign in from one it still trusts."
      })
    }

    const pin = this.checkPin(input.pin)
    if (!pin.ok) {
      // `pin-required` is the first half of every ordinary sign-in on a desktop
      // with a PIN — not a failure, and striking for it would lock somebody out
      // on their fifth login. A wrong PIN is the other kind, and counts.
      if (pin.reason === 'pin-required') {
        this.host.log?.(`web auth: asking "${deviceName}" at ${input.source} for the PIN`)
        return pin
      }
      return this.fail(input.source, pin)
    }

    if (known) {
      known.name = deviceName
      known.lastSeenAt = this.now()
      this.host.save(devices)
      this.clearStrikes(input.source)
      return { ok: true, device: known, claims: verified.claims }
    }

    this.host.log?.(`"${deviceName}" admitted from ${input.source}, and recorded`)
    this.clearStrikes(input.source)
    return { ok: true, device: this.record(deviceId, deviceName), claims: verified.claims }
  }

  /**
   * Re-verify a token presented mid-connection — the `auth` frame, sent before
   * the old one lapses. See TOKEN_REFRESH_MS in shared/web.ts.
   *
   * The same check the `hello` took, because "this credential does not get in"
   * is one answer whether it is heard at the start of a connection or an hour
   * into it. Deliberately no device work and no PIN: the browser on the far end
   * of an open socket answered both when it opened it, and nothing about a
   * fresh token changes that. Asking again mid-connection would be asking
   * somebody to retype a PIN because Google rotated a token, which is a prompt
   * with no question behind it.
   */
  async verifyToken(idToken: string, source: string): Promise<WebTokenOutcome> {
    const locked = this.lockout(source)
    if (locked) return locked
    const verified = await this.checkToken(idToken)
    if (!verified.ok) return this.fail(source, verified)
    this.clearStrikes(source)
    return verified
  }

  /* --------------------------------------------------------------- the PIN */

  /**
   * Is the PIN satisfied for this connection?
   *
   * Three answers, and the ordering is what makes it usable rather than merely
   * correct:
   *
   *  1. **No PIN set** — nothing asked, and this is the state the desktop ships
   *     in. See `webPin` in shared/types.ts for what that costs.
   *  2. **Nothing presented** — `pin-required`, which is a question rather than
   *     a failure and is deliberately not struck by the caller.
   *  3. **Something presented** — `verifyPin` decides, and a no is one
   *     sentence for every cause.
   *
   * Note what is *not* here, and is not an oversight: no trust window, no
   * exemption for a browser already on the device list, and nothing persisted
   * on success. A PIN is not spent by being used, so unlike the TOTP counter
   * this replaces there is nothing to write down — which also means there is no
   * race between two sockets presenting it at once.
   */
  private checkPin(
    presented: string | undefined
  ): { ok: true } | { ok: false; reason: 'pin-required' | 'pin-invalid'; message: string } {
    const stored = this.host.pinHash?.() ?? ''
    if (!stored) return { ok: true }

    const pin = String(presented ?? '').trim()
    if (!pin) return { ok: false, reason: 'pin-required', message: ASK_PIN }
    if (!verifyPin(pin, stored)) return { ok: false, reason: 'pin-invalid', message: BAD_PIN }
    return { ok: true }
  }

  /**
   * The PIN again, for something that happens *inside* an already authenticated
   * session — today, starting a screen mirror.
   *
   * The distinction from the `hello` check is the whole reason this exists, and
   * it is deliberately not a shade of it: what this guards is not "is this the
   * browser signed in as the right account" — that was settled at `hello` — but
   * "is the person who typed the PIN still there, right now". A PIN typed at
   * the start of a working day, on a socket that has been open ever since, is
   * not an answer to that question.
   *
   * `needed` separates the two refusals for the caller, because they are a PIN
   * box and an apology respectively: true means one is set and none was
   * offered, which is the first half of every ordinary use and not a failure.
   *
   * A desktop with no PIN answers yes. That is not a hole: it is the shipped
   * state, and what stands behind it is the escalation guard in
   * electron/web-host.ts, which refuses *control* outright on a desktop with no
   * PIN to ask for.
   */
  checkFreshPin(pin: string): { ok: true } | { ok: false; needed: boolean; message: string } {
    const outcome = this.checkPin(pin)
    if (outcome.ok) return { ok: true }
    return { ok: false, needed: outcome.reason === 'pin-required', message: outcome.message }
  }

  /* ---------------------------------------------------------- token verification */

  /**
   * Verify one Firebase ID token: the signature, and then every claim.
   *
   * Side-effect-free, so both public doors above can share it and each decide
   * for itself whether a failure earns a strike. Every refusal is `bad-token`
   * except the uid mismatch, which is the whole point of `wrong-account`.
   *
   * What is checked, and why each one is not optional:
   *
   *  - `alg` is exactly RS256. This is where the algorithm-confusion family of
   *    attacks dies: `none` and a symmetric `HS256` signed with the public key
   *    are both refused before a key is even looked up.
   *  - The signature, against the certificate Google published for this `kid`.
   *  - `aud` is this desktop's project, and `iss` is
   *    `https://securetoken.google.com/<project>`. A verifier that checks the
   *    signature and forgets these two accepts every token Firebase has ever
   *    minted, for anybody's project, and passes every other test you could
   *    write for it. They are checked separately and refused separately.
   *  - `exp` and `iat`, with CLOCK_SKEW_MS of allowance, so an expired token is
   *    dead and one minted in the future is not trusted.
   *  - `auth_time` is in the past. Firebase always sets it; a token without one
   *    is not one of Google's, whatever else it looks like.
   *  - `sub` is a non-empty string, because a uid comparison against an empty
   *    string is a comparison that can be satisfied by an unconfigured desktop.
   */
  private async checkToken(idToken: string): Promise<WebTokenOutcome> {
    const projectId = this.host.projectId()
    const wantUid = this.host.uid()
    if (!projectId || !wantUid) {
      // Not the browser's fault and not something a fresh token would fix, so
      // not `bad-token`: that would put the page in a re-authenticate loop
      // against a desktop that will never say yes. `busy` is the refusal that
      // carries a back-off, which is the only useful thing to tell it.
      return {
        ok: false,
        reason: 'busy',
        message: 'This desktop is not set up for Forge Web yet.',
        retryAfterMs: 60_000
      }
    }

    const bad = (message: string): WebTokenOutcome => ({ ok: false, reason: 'bad-token', message })
    const stale = 'That sign-in could not be verified. Sign in again.'

    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 8192) return bad(stale)
    const parts = idToken.split('.')
    if (parts.length !== 3) return bad(stale)
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

    const header = segmentJson(rawHeader)
    if (!header) return bad(stale)
    if (header.alg !== 'RS256') return bad(stale)
    const kid = typeof header.kid === 'string' ? header.kid : ''
    if (!kid || kid.length > 128) return bad(stale)

    const certificate = await this.certificateFor(kid)
    if (!certificate) return bad(stale)

    const signature = segmentBytes(rawSignature)
    if (!signature) return bad(stale)
    let signed = false
    try {
      signed = createVerify('RSA-SHA256')
        .update(`${rawHeader}.${rawPayload}`)
        .verify(certificate, signature)
    } catch {
      signed = false
    }
    if (!signed) return bad(stale)

    const payload = segmentJson(rawPayload)
    if (!payload) return bad(stale)

    const now = this.now()
    const exp = numberClaim(payload.exp)
    const iat = numberClaim(payload.iat)
    const authTime = numberClaim(payload.auth_time)
    if (exp === null || iat === null || authTime === null) return bad(stale)
    if (now >= exp * 1000 + CLOCK_SKEW_MS) return bad('That sign-in has expired. Sign in again.')
    if (iat * 1000 > now + CLOCK_SKEW_MS) return bad(stale)
    if (authTime * 1000 > now + CLOCK_SKEW_MS) return bad(stale)

    const aud = typeof payload.aud === 'string' ? payload.aud : ''
    const iss = typeof payload.iss === 'string' ? payload.iss : ''
    if (!sameString(aud, projectId)) return bad(stale)
    if (!sameString(iss, `${ISSUER_PREFIX}${projectId}`)) return bad(stale)

    const sub = typeof payload.sub === 'string' ? payload.sub : ''
    if (!sub || sub.length > 128) return bad(stale)

    if (!sameString(sub, wantUid)) {
      return {
        ok: false,
        reason: 'wrong-account',
        message: 'This desktop belongs to a different Forge account. Sign out and sign in as its owner.'
      }
    }

    return { ok: true, claims: { uid: sub, aud, iss, exp, iat, authTime } }
  }

  /**
   * The certificate for one `kid`, fetching Google's set when the cache is cold,
   * stale, or does not know the key.
   *
   * The unknown-`kid` re-fetch is how a key rotation is noticed between cache
   * expiries; JWKS_MIN_REFETCH_MS is what stops it being an amplifier.
   */
  private async certificateFor(kid: string): Promise<KeyObject | null> {
    if (!this.keys || this.now() >= this.keysExpireAt) await this.refreshKeys()
    const hit = this.keys?.[kid]
    if (hit) return hit
    if (this.now() - this.keysFetchedAt < JWKS_MIN_REFETCH_MS) return null
    await this.refreshKeys()
    return this.keys?.[kid] ?? null
  }

  /**
   * Fetch and cache Google's key set.
   *
   * A failed fetch keeps whatever was already cached rather than emptying it:
   * signing keys do not become dangerous by getting old, they get *rotated out*,
   * and the worst a stale set can do is fail to verify a token minted under a
   * newer key. Throwing away the cache because Google's endpoint blipped would
   * instead refuse everybody, which is the bigger failure. The retry is pulled
   * in to JWKS_MIN_REFETCH_MS so a broken endpoint is not hammered either.
   */
  private async refreshKeys(): Promise<void> {
    if (this.fetching) return this.fetching
    this.fetching = (async () => {
      try {
        const response = await this.host.fetchJwks(GOOGLE_JWKS_URL)
        const parsed: unknown = JSON.parse(response.body)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JWKS is not an object')
        const keys: Record<string, KeyObject> = {}
        for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
          // Unwrapped from its certificate here rather than at verify time, so a
          // malformed one is a log line at fetch time instead of a refusal that
          // looks like a bad token.
          if (typeof value !== 'string') continue
          try {
            keys[kid] = new X509Certificate(value).publicKey
          } catch {
            this.host.log?.(`web auth: ignoring unreadable signing key ${kid}`)
          }
        }
        if (Object.keys(keys).length === 0) throw new Error('JWKS carried no usable keys')
        this.keys = keys
        this.keysFetchedAt = this.now()
        this.keysExpireAt = this.now() + jwksTtlMs(response.cacheControl)
      } catch (err) {
        this.host.log?.(`web auth: could not refresh Google's signing keys (${String(err)})`)
        this.keysFetchedAt = this.now()
        this.keysExpireAt = this.now() + JWKS_MIN_REFETCH_MS
      } finally {
        this.fetching = null
      }
    })()
    return this.fetching
  }

  /* ------------------------------------------------------------ the device list */

  /**
   * Record an admission. The one place a device row is created, and the reason
   * it is one place is the reason `mintDevice` is one place in mobile/auth.ts:
   * the authorisation happened before this was called, and what this guarantees
   * is the invariant the rest of the app leans on — what reaches `save` is an
   * id, a name and three timestamps, and never anything a browser could present
   * later as a credential.
   */
  private record(deviceId: string, deviceName: string): WebDevice {
    const device: WebDevice = {
      id: deviceId,
      name: deviceName,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      revokedAt: 0
    }
    // Recording a browser this desktop already has a row for replaces it, rather
    // than leaving a second row with the same id and a stale name.
    const devices = this.host.load().filter((d) => d.id !== device.id)
    devices.push(device)
    this.host.save(devices)
    return device
  }

  /* -------------------------------------------------------------------- lockout */

  /**
   * Is this source locked out right now?
   *
   * `busy` rather than a value of its own, because WEB_REFUSALS has no `locked`
   * and inventing one would be inventing a parallel vocabulary — the thing
   * shared/web.ts exists to prevent. It is also the honest answer: the desktop
   * is up and will not take this connection, `retryAfterMs` says when to come
   * back, and a brute-forcer learns nothing from the distinction anyway.
   */
  private lockout(source: string): { ok: false; reason: 'busy'; message: string; retryAfterMs: number } | null {
    const strike = this.strikes.get(source)
    if (!strike) return null
    if (this.now() >= strike.until) {
      this.strikes.delete(source)
      return null
    }
    if (strike.count < AUTH_MAX_FAILURES) return null
    const remaining = strike.until - this.now()
    return {
      ok: false,
      reason: 'busy',
      message: `Too many failed attempts — try again in ${Math.ceil(remaining / 1000)}s.`,
      retryAfterMs: remaining
    }
  }

  /**
   * Count one refusal against a source, and hand the refusal back unchanged.
   *
   * Every refusal counts, not only the credential ones. A wrong account, a
   * browser that names itself nothing and a wrong PIN are all things a stranger
   * with the address can generate on repeat, and the strike counter is what
   * turns a four-digit secret from ten thousand guesses into weeks of them. The
   * one refusal that does *not* come here is `pin-required`, which is a
   * question rather than a failure — see `authenticate`. Nor does success,
   * which clears the slate.
   */
  private fail<T extends { ok: false; reason: WebRefusal; message: string; retryAfterMs?: number }>(
    source: string,
    outcome: T
  ): T {
    this.host.log?.(`web auth refused from ${source}: ${outcome.reason} — ${outcome.message}`)
    const strike = this.strikes.get(source) ?? { count: 0, until: 0 }
    strike.count += 1
    strike.until = this.now() + AUTH_LOCKOUT_MS
    this.strikes.set(source, strike)
    return outcome
  }

  private clearStrikes(source: string): void {
    this.strikes.delete(source)
  }
}

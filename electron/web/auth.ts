import { X509Certificate, createVerify, timingSafeEqual } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES } from '@shared/mobile'
import {
  PIN_MAX_DIGITS,
  PIN_MIN_DIGITS,
  type WebPasskeyAssertion,
  type WebPasskeyCreationOptions,
  type WebPasskeyInfo,
  type WebPasskeyRequestOptions,
  type WebRefusal
} from '@shared/web'
import {
  PasskeyChallenges,
  PasskeyStore,
  creationOptions,
  passkeyInfo,
  passkeyUserId,
  pinDigest,
  readClientData,
  requestOptions,
  rpIdFor,
  verifyAssertion,
  verifyRegistration,
  type ChallengePurpose,
  type PasskeyStorage
} from './passkey'
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
 * So the hashing rule has nothing here to apply to, and its absence is not a
 * relaxation. The rule underneath it is the one that carries over: **nothing
 * written to settings.json may be usable as a credential.** Mobile satisfies
 * that by storing a one-way image of its token. Forge Web satisfies it by
 * having nothing to store at all — this module writes no record of any browser,
 * so there is no list of admissions to steal, to leak, or to go stale.
 *
 * The one secret this feature does write down is the unlock PIN, and it obeys
 * that rule too: electron/web/pin.ts stores a scrypt image of it and never the
 * digits. What that does and does not buy is set out in full in that file's
 * header, honestly, because four digits are not entropy.
 *
 * ## The door is the account plus a PIN, and nothing else
 *
 * There is no prompt at the desk here, and there used to be. The word-pair
 * approval, the TOTP second factor and the approved-browser list are all gone,
 * replaced by one thing a person sets once in Settings: an unlock PIN, asked of
 * every browser on every connection.
 *
 * The reason is that anything answered at the desk can only be answered by
 * somebody standing at this machine, so a door that demanded one was a door
 * that locked Steve out of his own desktop from a hotel a hundred miles away —
 * and a TOTP enrolment is a phone, an app and ten recovery codes to keep, for a
 * feature used by exactly one person who is already signed into an account. The
 * device list went the same way and for a related reason: it never was a gate
 * (an unknown browser holding a good token and the PIN was admitted anyway), so
 * all it did was accumulate rows whose Revoke button implied a lock that was
 * not there. What survives being away from the desk is what actually defends
 * this door:
 *
 *  - the token is verified against Google's keys on every connection;
 *  - the uid must match, and a token for another account is refused;
 *  - the PIN, which is the one thing a stolen Firebase password does not come
 *    with, and which is asked afresh of every browser on every connection —
 *    there is no list to be on and nothing that excuses it;
 *  - the per-bucket lockout below, which is what makes a short PIN defensible.
 *
 * With no PIN set the account alone gets in, which is the state this desktop
 * ships in and is deliberate rather than an oversight: shared/types.ts states
 * the trade beside `webPin`, once, and this file does not restate it. What that
 * state does *not* buy is the mouse — see `canControl` in
 * electron/web-host.ts, which refuses screen control outright without a PIN.
 *
 * The PIN is short, and electron/web/pin.ts is honest about what hashing four
 * digits does and does not buy. The part that belongs here is the other half of
 * that answer: **the lockout below is what makes a four-digit secret defensible
 * at all.** Five wrong answers and the bucket they were counted against is
 * refused for a minute — the account's bucket once the token has verified, the
 * address's before — so ten thousand guesses are weeks of them rather than
 * seconds.
 *
 * ## What is kept from the neighbour
 *
 *  1. **Constant-time comparison.** See `sameString`, and the honest note there
 *     about which of these comparisons is actually secret.
 *  2. **Failure lockout per bucket** — keyed on the address before the token
 *     verifies and on the verified uid after — on `AUTH_MAX_FAILURES`/
 *     `AUTH_LOCKOUT_MS` from shared/mobile.ts rather than numbers invented
 *     here.
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
 * The browser on the far end of one admitted connection.
 *
 * Nothing here is persisted and nothing here is a credential: it is the two
 * untrusted strings off the `hello` frame plus one verified fact, carried so
 * that electron/web/server.ts has something to log a connection under,
 * something to name a browser by in the presence line, and somewhere later in
 * the connection to hang a strike count on. It lives and dies with the socket —
 * this desktop keeps no record of which browsers have been admitted,
 * deliberately, because the list it used to keep was never a gate and its
 * Revoke button implied a lock that was not there.
 */
export interface WebDevice {
  /** The browser's own per-profile id, from `WebHelloFrame.deviceId`. */
  id: string
  /** What the browser called itself. Untrusted display text — show, never obey. */
  name: string
  /**
   * The uid the admitted token was verified against. Not a credential — the
   * token it came from has usually lapsed by now — but the honest name of the
   * account behind the socket, which is what later PIN checks key their
   * lockout on. See `uidKey`.
   */
  uid: string
  /**
   * How this socket answered the PIN question, and under which PIN — absent
   * when no PIN was set, so nothing was asked. Not a credential; what it gates
   * is enrolling or forgetting a passkey, which only a socket that answered
   * the *current* PIN may do. See `passkeyMayEnrol`.
   */
  unlock?: { by: 'pin' | 'passkey'; pinDigest: string }
}

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

/** Why a socket may not enrol or forget a passkey. See `passkeyMayEnrol`. */
const UNLOCK_FIRST = 'Unlock with the desktop PIN on this connection before changing passkeys.'

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

/** Blunt backstop on the strike map — see `pruneStrikes`. Same figure as electron/mobile/auth.ts. */
const MAX_STRIKE_BUCKETS = 10_000

/** Strip control characters before text off the socket reaches a log line. Same guard as shared/web.ts's, which is module-private. */
function printable(text: string): string {
  return [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 31 && code !== 127
    })
    .join('')
}

/**
 * Everything this class needs from the world, and nothing else.
 *
 * The house pattern, and the same one `AuthStoreHost` and `MobileServerHost`
 * follow: the consumer declares the narrow interface, and the Electron host
 * implements it by calling the existing modules. Nothing here is Electron, a
 * socket, or a file.
 */
export interface WebAuthHost {
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
  /**
   * Where enrolled passkeys live — electron/web/passkey.ts. Absent means this
   * desktop offers no passkeys: the door is PIN-only, exactly as before, and
   * `hello-ok` announces nothing.
   */
  passkeys?: PasskeyStorage
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
  | {
      ok: false
      reason: WebRefusal
      message: string
      retryAfterMs?: number
      /**
       * The token was Google's — signature, audience and issuer all verified —
       * and merely old. See `fail`: that is not a guess and is not counted as
       * one. Never set on a token that failed any other check.
       */
      expired?: true
    }

export type WebAuthOutcome =
  | { ok: true; device: WebDevice; claims: WebTokenClaims }
  | {
      ok: false
      reason: WebRefusal
      message: string
      retryAfterMs?: number
      /** `pin-required` only, when this account has passkeys. See `WebRefusedFrame.passkey`. */
      passkey?: WebPasskeyRequestOptions
    }

export interface WebAuthInput {
  /**
   * The remote address. The unit of lockout until the token verifies; from
   * there the verified uid is, because a tunnel funnels every caller onto one
   * loopback address. See `authenticate`.
   */
  source: string
  /** The Firebase ID token off the `hello` frame. */
  idToken: string
  /** The browser's per-profile id. Only ever checked for being there at all. */
  deviceId: string
  /** Untrusted display text. */
  deviceName: string
  /**
   * The unlock PIN off the `hello` frame. Absent on the first attempt of every
   * sign-in — see `WebHelloFrame.pin`.
   */
  pin?: string
  /**
   * The socket's `Origin` header. What a passkey is scoped to and checked
   * against; without one no passkey is offered or accepted.
   */
  origin?: string
  /** A passkey answer instead of `pin`. See `WebHelloFrame.passkey`. */
  passkey?: WebPasskeyAssertion
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
  /** Null when the host gave no storage — see `WebAuthHost.passkeys`. */
  private readonly passkeys: PasskeyStore | null
  private readonly challenges: PasskeyChallenges

  /** kid → public key, as last fetched. Null until the first fetch lands. */
  private keys: Record<string, KeyObject> | null = null
  private keysExpireAt = 0
  private keysFetchedAt = 0
  /** One in-flight fetch, shared: a burst of reconnects is one request, not ten. */
  private fetching: Promise<void> | null = null

  constructor(host: WebAuthHost) {
    this.host = host
    this.now = host.now ?? (() => Date.now())
    this.passkeys = host.passkeys ? new PasskeyStore(host.passkeys) : null
    this.challenges = new PasskeyChallenges(this.now)
  }

  /* ----------------------------------------------------------------- the door */

  /**
   * Authenticate a `hello`.
   *
   * Four gates, in this order, and the order is load-bearing:
   *
   *  1. **The token**, verified against Google's keys — signature *and* every
   *     claim. A token that does not verify is `bad-token` whatever uid it
   *     claims, which is why this runs before the uid is looked at: a token
   *     minted by somebody else's Firebase project whose `sub` happens to equal
   *     ours must not be able to reach the `wrong-account` branch and learn it
   *     guessed right.
   *  2. **The account**, which is `wrong-account` and a genuinely different
   *     outcome: a different sentence, a different recovery, and never a retry
   *     loop on a correct credential.
   *  3. **A device id at all.** Not an admission check — nothing is looked up
   *     and nothing is recorded — but a page that sent a blank one is a page
   *     whose storage is unavailable, and telling it so is the only way it ever
   *     finds out. See `not-approved` in shared/web.ts.
   *  4. **The PIN**, when one is set. Asked of every browser on every
   *     connection, with nothing that excuses it. A passkey enrolled under
   *     that PIN may answer instead (electron/web/passkey.ts): a yes is a
   *     correct PIN and every kind of no is a wrong one, in the same bucket —
   *     bar a correct answer over a stale challenge, which is asked again.
   *
   * ## Which failures count against which bucket
   *
   * Only the PIN's. Everything before it — the garbage token, the expired one,
   * the blank device id — counts against nothing at all, and that is deliberate
   * rather than lax. A JWT keyspace is unguessable, so repeated bad tokens are
   * noise rather than progress, and striking them buys no security; what they
   * would buy is a weapon, because behind the tunnel every caller on earth
   * arrives from this machine's own loopback, so an address-keyed bucket is one
   * bucket shared by the owner and every stranger — five garbage tokens from
   * anyone who could reach the hostname locked the owner out for a renewable
   * minute. The old address bucket is gone outright; the lockout now lives only
   * on the account (`uidKey`), where the identity is proven and the secret —
   * the short PIN — is actually worth guessing, and where a stranger cannot
   * spend somebody else's strikes because they cannot produce a token carrying
   * their uid in the first place. Nothing clears a bucket on success; the only
   * thing that empties one is time (see `fail`).
   *
   * Then one admission path and no bookkeeping: what comes back is the browser's
   * own two strings plus the uid they were admitted under, for the length of
   * this socket and no longer.
   */
  async authenticate(input: WebAuthInput): Promise<WebAuthOutcome> {
    const verified = await this.checkToken(input.idToken)
    if (!verified.ok) return verified

    // Bounded because both arrive off a public socket and both end up in log
    // lines and, in the case of the name, on the desktop's own screen. Neither
    // is stored, so the bound is about what an unbounded string can do on the
    // way past rather than about what a row on disk should look like.
    const deviceId = input.deviceId.slice(0, 128)
    // printable() before it reaches a log line: a control character arriving
    // off a public socket is at best a broken line and at worst something a
    // terminal has an opinion about. Same guard as shared/web.ts's, kept local
    // because that one is module-private to the wire file.
    const deviceName = printable((input.deviceName || 'Browser').slice(0, 64)) || 'Browser'
    if (!deviceId) {
      return {
        ok: false,
        reason: 'not-approved',
        message: 'This browser did not identify itself, so it cannot be admitted. Reload the page and try again.'
      }
    }

    // Verified from here on, so the PIN is judged against the account's bucket
    // — see "Which failures count against which bucket" above.
    const account = this.uidKey(verified.claims.uid)
    const pinLocked = this.lockout(account)
    if (pinLocked) return pinLocked
    const uid = verified.claims.uid
    const stored = this.host.pinHash?.() ?? ''
    let unlock: WebDevice['unlock']
    if (stored && !String(input.pin ?? '').trim() && input.passkey) {
      // A passkey instead of the PIN. Judged exactly as the PIN would be: a
      // yes is a correct PIN, and every kind of no is a wrong one, struck
      // against the same bucket — see electron/web/passkey.ts. The one
      // exception is a correct answer over a stale challenge (a retry after a
      // lost `hello-ok`, a slow fingerprint): asked again with a fresh
      // challenge, unstruck, and not admitted — the `expired: true` rule for
      // tokens, applied to challenges.
      const answer = this.passkeyAnswer(uid, input.origin ?? '', input.passkey, 'get')
      if (answer === 'retry') {
        const passkey = this.passkeyRequest(uid, input.origin ?? '', 'get')
        return { ok: false, reason: 'pin-required', message: ASK_PIN, ...(passkey ? { passkey } : {}) }
      }
      if (answer !== 'ok') return this.fail(account, { ok: false, reason: 'pin-invalid', message: BAD_PIN })
      unlock = { by: 'passkey', pinDigest: pinDigest(stored) }
    } else {
      const pin = this.checkPin(input.pin)
      if (!pin.ok) {
        // `pin-required` is the first half of every ordinary sign-in on a desktop
        // with a PIN — not a failure, and striking for it would lock somebody out
        // on their fifth login. A wrong PIN is the other kind, and counts.
        if (pin.reason === 'pin-required') {
          this.host.log?.(`web auth: asking "${deviceName}" at ${input.source} for the PIN`)
          const passkey = this.passkeyRequest(uid, input.origin ?? '', 'get')
          return passkey ? { ...pin, passkey } : pin
        }
        return this.fail(account, pin)
      }
      if (stored) unlock = { by: 'pin', pinDigest: pinDigest(stored) }
    }

    this.host.log?.(`"${deviceName}" admitted from ${input.source}${unlock?.by === 'passkey' ? ' with a passkey' : ''}`)
    return {
      ok: true,
      device: { id: deviceId, name: deviceName, uid, ...(unlock ? { unlock } : {}) },
      claims: verified.claims
    }
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
   *
   * `uid` is the socket's already-verified identity when the caller has one
   * (the `auth` frame always does). A bad token never strikes — here exactly as
   * in `authenticate`, a JWT is not a guessable secret — but an account that is
   * locked out for PIN guessing is refused a refresh too, so a lockout cannot be
   * ridden out on an open socket. `source` is unused since the address bucket
   * went away; it stays in the signature for the caller's sake.
   */
  async verifyToken(idToken: string, _source: string, uid?: string): Promise<WebTokenOutcome> {
    if (uid !== undefined) {
      const locked = this.lockout(this.uidKey(uid))
      if (locked) return locked
    }
    return this.checkToken(idToken)
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
   * browser this desktop has seen before and lets past, and nothing persisted
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
   *
   * `who` is the asking socket's verified identity, and it is what makes this
   * a check rather than a hole: a wrong PIN here counts against the account's
   * strike bucket exactly as a wrong PIN at `hello` does, so the five-then-wait
   * rule that makes four digits defensible applies on this door too. Without
   * it, wrong PINs on a mirror-start were unlimited. A caller that cannot vouch
   * for an identity gets the comparison and no counting — the honest thing
   * available, and why every real caller passes one.
   */
  checkFreshPin(
    pin: string,
    who?: { uid: string; source: string; origin?: string },
    passkey?: WebPasskeyAssertion
  ): { ok: true } | { ok: false; needed: boolean; message: string; passkey?: WebPasskeyRequestOptions } {
    const account = who ? this.uidKey(who.uid) : null
    if (account) {
      const locked = this.lockout(account)
      if (locked) return { ok: false, needed: false, message: locked.message }
    }
    // A passkey answers "is somebody still there" as well as digits do — with
    // its own fresh challenge, issued on the `needed` refusal below, and only
    // when the caller vouches for an identity to count a failure against. A
    // correct answer over a stale challenge is asked again, unstruck, exactly
    // as at `hello`.
    if (who && account && passkey && !String(pin ?? '').trim() && (this.host.pinHash?.() ?? '')) {
      const answer = this.passkeyAnswer(who.uid, who.origin ?? '', passkey, 'fresh')
      if (answer === 'ok') return { ok: true }
      if (answer === 'retry') {
        const options = this.passkeyRequest(who.uid, who.origin ?? '', 'fresh')
        return { ok: false, needed: true, message: ASK_PIN, ...(options ? { passkey: options } : {}) }
      }
      this.fail(account, { ok: false, reason: 'pin-invalid', message: BAD_PIN })
      return { ok: false, needed: false, message: BAD_PIN }
    }
    const outcome = this.checkPin(pin)
    if (outcome.ok) return { ok: true }
    if (outcome.reason === 'pin-required') {
      const options = who ? this.passkeyRequest(who.uid, who.origin ?? '', 'fresh') : undefined
      return { ok: false, needed: true, message: outcome.message, ...(options ? { passkey: options } : {}) }
    }
    if (account) {
      this.fail<{ ok: false; reason: 'pin-invalid'; message: string }>(account, {
        ok: false,
        reason: 'pin-invalid',
        message: outcome.message
      })
    }
    return { ok: false, needed: false, message: outcome.message }
  }

  /* ------------------------------------------------------------------ passkeys */

  /** Whether this desktop offers passkeys at all — the `hello-ok.features` answer. */
  passkeysSupported(): boolean {
    return this.passkeys !== null
  }

  /**
   * May this socket enrol or forget a passkey? Only one that typed the PIN
   * itself on this connection, under the PIN that is set *now*. A socket
   * admitted on the account alone (no PIN set) never may, nor may one that
   * unlocked under a PIN since changed at the desk — and nor may one that
   * unlocked with a passkey, so a passkey can never mint or remove another:
   * every change to the set goes back to the PIN it hangs from.
   */
  passkeyMayEnrol(device: WebDevice): boolean {
    const stored = this.host.pinHash?.() ?? ''
    return (
      !!this.passkeys &&
      !!stored &&
      !!device.unlock &&
      device.unlock.by === 'pin' &&
      device.unlock.pinDigest === pinDigest(stored)
    )
  }

  /** This account's passkeys as list rows, and whether this socket may change them. */
  passkeyList(device: WebDevice): { passkeys: WebPasskeyInfo[]; canRegister: boolean } {
    const list = this.passkeys ? this.passkeys.list(device.uid, this.host.pinHash?.() ?? '') : []
    return { passkeys: list.map(passkeyInfo), canRegister: this.passkeyMayEnrol(device) }
  }

  /** Enrolling, step one: creation options with a fresh challenge, or a sentence saying why not. */
  passkeyRegisterBegin(
    device: WebDevice,
    origin: string
  ): { ok: true; options: WebPasskeyCreationOptions } | { ok: false; message: string } {
    if (!this.passkeys) return { ok: false, message: 'This desktop does not offer passkeys.' }
    if (!this.passkeyMayEnrol(device)) return { ok: false, message: UNLOCK_FIRST }
    const rpId = rpIdFor(origin)
    if (!rpId) return { ok: false, message: 'This page has no origin a passkey can belong to.' }
    const existing = this.passkeys.list(device.uid, this.host.pinHash?.() ?? '')
    const challenge = this.challenges.issue(device.uid, 'create', origin, rpId)
    return { ok: true, options: creationOptions(challenge, rpId, device.uid, existing) }
  }

  /**
   * Enrolling, step two: verify what the authenticator made, and keep it.
   * Never strikes — only an unlocked socket gets this far, and nothing here is
   * a guess at a secret.
   */
  passkeyRegisterFinish(
    device: WebDevice,
    origin: string,
    body: { clientDataJSON: string; attestationObject: string; deviceName: string }
  ): { ok: true } | { ok: false; message: string } {
    if (!this.passkeys || !this.passkeyMayEnrol(device)) return { ok: false, message: UNLOCK_FIRST }
    const refused = { ok: false as const, message: 'That passkey could not be added. Try again.' }
    const clientData = readClientData(body.clientDataJSON)
    if (!clientData) return refused
    const taken = this.challenges.take(clientData.challenge, device.uid, 'create')
    if (!taken.ok || taken.entry.origin !== origin) {
      this.host.log?.('web auth: passkey enrolment with an unknown, expired or foreign challenge')
      return refused
    }
    const verdict = verifyRegistration({
      clientData,
      attestationObject: body.attestationObject,
      origin,
      rpId: taken.entry.rpId
    })
    if (!verdict.ok) {
      this.host.log?.(`web auth: passkey enrolment refused — ${verdict.why}`)
      return refused
    }
    const now = this.now()
    const added = this.passkeys.add(device.uid, this.host.pinHash?.() ?? '', {
      credentialId: verdict.credentialId,
      alg: verdict.alg,
      publicKey: verdict.publicKey,
      signCount: verdict.signCount,
      deviceName: printable(body.deviceName.slice(0, 64)) || device.name,
      createdAt: now,
      lastUsedAt: now
    })
    if (!added) return { ok: false, message: 'That passkey is already added, or this account has too many.' }
    this.host.log?.(`web auth: "${device.name}" enrolled a passkey`)
    return { ok: true }
  }

  /** Forget one of this account's passkeys. False when this socket may not. */
  passkeyForget(device: WebDevice, credentialId: string): boolean {
    if (!this.passkeys || !this.passkeyMayEnrol(device)) return false
    if (this.passkeys.remove(device.uid, this.host.pinHash?.() ?? '', credentialId)) {
      this.host.log?.(`web auth: "${device.name}" forgot a passkey`)
    }
    return true
  }

  /**
   * Request options, with a fresh challenge, for an account that has passkeys;
   * undefined when there is nothing to offer — no store, no PIN, no passkeys,
   * or no origin to scope them to.
   */
  private passkeyRequest(uid: string, origin: string, purpose: ChallengePurpose): WebPasskeyRequestOptions | undefined {
    const stored = this.host.pinHash?.() ?? ''
    if (!this.passkeys || !stored) return undefined
    const rpId = rpIdFor(origin)
    if (!rpId) return undefined
    const list = this.passkeys.list(uid, stored)
    if (!list.length) return undefined
    return requestOptions(this.challenges.issue(uid, purpose, origin, rpId), rpId, list)
  }

  /**
   * Does this assertion answer one of our challenges, for this account, from
   * this page, with one of this account's passkeys? Why a no is a no goes to
   * the desk's log and nowhere else: the browser hears `pin-invalid`, for the
   * reason BAD_PIN is one sentence.
   *
   * Three answers. `ok` admits. `no` is a wrong PIN and the caller strikes it.
   * `retry` is a correct assertion over a challenge that is no longer pending
   * — spent, expired or evicted — and the caller asks again with a fresh
   * challenge, unstruck and unadmitted: see "Failures are wrong PINs" in
   * electron/web/passkey.ts. A challenge that is pending but was issued for
   * another account, purpose or page is not stale; it is `no`.
   */
  private passkeyAnswer(
    uid: string,
    origin: string,
    assertion: WebPasskeyAssertion,
    purpose: ChallengePurpose
  ): 'ok' | 'retry' | 'no' {
    const no = (why: string): 'no' => {
      this.host.log?.(`web auth: passkey refused — ${why}`)
      return 'no'
    }
    const stored = this.host.pinHash?.() ?? ''
    if (!this.passkeys || !stored) return no('no passkeys on this desktop')
    if (!origin) return no('no origin')
    const clientData = readClientData(assertion.clientDataJSON)
    if (!clientData) return no('clientDataJSON does not parse')
    // Spent before anything else is judged, so a challenge is answerable once
    // whatever the answer turns out to be.
    const taken = this.challenges.take(clientData.challenge, uid, purpose)
    if (!taken.ok && !taken.stale) return no(taken.why)
    if (taken.ok && taken.entry.origin !== origin) return no(`challenge was issued to ${taken.entry.origin}, not ${origin}`)
    // A stale challenge still gets every other check, against this page's own
    // RP ID since there is no pending entry to say which one it was issued for.
    const stale = taken.ok ? '' : `${taken.why}; `
    const rpId = taken.ok ? taken.entry.rpId : rpIdFor(origin)
    if (!rpId) return no(`${stale}no RP ID for ${origin}`)
    const passkey = this.passkeys.list(uid, stored).find((p) => p.credentialId === assertion.credentialId)
    if (!passkey) return no(`${stale}unknown credential`)
    const verdict = verifyAssertion({
      assertion,
      clientData,
      stored: passkey,
      origin,
      rpId,
      userId: passkeyUserId(uid),
      ignoreCounter: !taken.ok
    })
    if (!verdict.ok) return no(`${stale}${verdict.why}`)
    if (!taken.ok) {
      // Right key, right person, right page — and a challenge that is gone.
      // Never admitted, never recorded, never struck.
      this.host.log?.(`web auth: passkey answered an ${taken.why} correctly — asking again with a fresh one`)
      return 'retry'
    }
    this.passkeys.touch(uid, stored, passkey.credentialId, verdict.signCount, this.now())
    return 'ok'
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
    if (iat * 1000 > now + CLOCK_SKEW_MS) return bad(stale)
    if (authTime * 1000 > now + CLOCK_SKEW_MS) return bad(stale)

    const aud = typeof payload.aud === 'string' ? payload.aud : ''
    const iss = typeof payload.iss === 'string' ? payload.iss : ''
    if (!sameString(aud, projectId)) return bad(stale)
    if (!sameString(iss, `${ISSUER_PREFIX}${projectId}`)) return bad(stale)

    // Checked after the signature, audience and issuer on purpose: only a token
    // that has passed all three is known to be one of Google's for this
    // project, and only then is "expired" a statement about the token rather
    // than about whoever sent it. The flag is what keeps a browser waking from
    // a night's sleep, and re-presenting the token it fell asleep holding, from
    // being counted as a brute-force attempt.
    if (now >= exp * 1000 + CLOCK_SKEW_MS) {
      return { ok: false, reason: 'bad-token', message: 'That sign-in has expired. Sign in again.', expired: true }
    }

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

  /* -------------------------------------------------------------------- lockout */

  /**
   * Is this bucket locked out right now?
   *
   * Every bucket is keyed by `uidKey` — see `authenticate` for why an address
   * is the wrong unit behind a tunnel, where every caller on earth shares one
   * loopback address with the owner, and why no bucket exists at all before the
   * token verifies.
   *
   * `busy` rather than a value of its own, because WEB_REFUSALS has no `locked`
   * and inventing one would be inventing a parallel vocabulary — the thing
   * shared/web.ts exists to prevent. It is also the honest answer: the desktop
   * is up and will not take this connection, `retryAfterMs` says when to come
   * back, and a brute-forcer learns nothing from the distinction anyway.
   */
  private lockout(key: string): { ok: false; reason: 'busy'; message: string; retryAfterMs: number } | null {
    const strike = this.strikes.get(key)
    if (!strike) return null
    if (this.now() >= strike.until) {
      this.strikes.delete(key)
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
   * Count one refusal against a bucket, and hand the refusal back unchanged.
   *
   * The only caller left is the wrong-PIN path — see `authenticate` for why
   * everything before the PIN verifies counts against nothing. A wrong PIN is
   * exactly what the strike counter exists for: it is the one secret here short
   * enough to guess, and five-then-wait is what turns ten thousand tries into
   * weeks of them.
   *
   * Success clears nothing, and that is deliberate. The bucket only ever decays
   * with time — `until` passes, the entry goes, the count starts again — so a
   * legitimate sign-in can neither unlock a guesser nor be locked out by one,
   * because since the address bucket went away they no longer share one.
   */
  private fail<T extends { ok: false; reason: WebRefusal; message: string; retryAfterMs?: number }>(
    key: string,
    outcome: T
  ): T {
    this.host.log?.(`web auth refused at ${key}: ${outcome.reason} — ${outcome.message}`)
    // A genuine token that has merely lapsed is not a wrong answer. The client
    // re-presents a fresh one on the next attempt; counting the lapse would mean
    // five ordinary reconnects after an hour away locked the owner out for a
    // minute, which is the opposite of what this counter is for.
    if ('expired' in outcome && outcome.expired) return outcome
    const strike = this.strikes.get(key) ?? { count: 0, until: 0 }
    strike.count += 1
    strike.until = this.now() + AUTH_LOCKOUT_MS
    this.strikes.set(key, strike)
    this.pruneStrikes()
    return outcome
  }

  /**
   * Drop buckets whose window has lapsed, so the map cannot grow without bound,
   * and clear it outright past a blunt backstop. Borrowed whole from
   * electron/mobile/auth.ts, for the same reason: the keys here derive from
   * material a client chose, and dropping a bucket can only *un*lock somebody —
   * never lock the owner out — so erring towards empty errs safely.
   */
  private pruneStrikes(): void {
    const now = this.now()
    for (const [key, strike] of this.strikes) {
      if (now >= strike.until) this.strikes.delete(key)
    }
    if (this.strikes.size > MAX_STRIKE_BUCKETS) this.strikes.clear()
  }

  /**
   * Post-verification bucket: one per account. There is exactly one account
   * admitted here (see `WebAuthHost.uid`), so in practice one entry — the point
   * of the key is that it is the owner's own, and not an address shared with
   * every stranger a tunnel funnels onto loopback.
   */
  private uidKey(uid: string): string {
    return `uid:${uid}`
  }
}

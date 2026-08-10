import { X509Certificate, createVerify, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES, wordPair } from '@shared/mobile'
import { APPROVAL_TIMEOUT_MS, TOTP_DIGITS, TRUST_WINDOW_MS, type WebRefusal } from '@shared/web'
import type { WebDeviceRecord } from '@shared/types'
import { checkTotp, hashRecoveryCode, newRecoveryCodes, newTotpSecret, totpUri } from './totp'

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
 * So the hashing rule does not appear here, and its absence is not a relaxation.
 * The rule underneath it is the one that carries over: **nothing written to
 * settings.json may be usable as a credential.** Mobile satisfies that by
 * storing a one-way image of its token. Forge Web satisfies it by having no
 * token to store — a `WebDeviceRecord` is an id, a name and three timestamps,
 * and a copy of the whole device list is a list of browser names. It records
 * that a human pressed Allow. It is an approval, not a key.
 *
 * ## Two modes, and the default is the permissive one
 *
 * The account is the credential. A verified token for the configured uid is
 * admitted, the browser it came from is recorded in the device list, and no
 * prompt goes up on the desktop. That is what `webRequireApproval: false` — the
 * shipped default — means, and it is deliberate: the word-pair prompt below can
 * only be answered by somebody standing at this machine, so a door that always
 * demanded one was a door that locked Steve out of his own desktop from a hotel
 * a hundred miles away. shared/types.ts states the trade beside the setting,
 * once, and this file does not restate it.
 *
 * What survives being away from the desk is what defends that mode, and none of
 * it is weakened by it:
 *
 *  - the token is verified against Google's keys on every connection;
 *  - the uid must match, and a token for another account is still refused;
 *  - **a revoked browser is still refused, in both modes**, and revoking still
 *    drops its live socket (electron/web-host.ts);
 *  - every browser is still recorded, listed and revocable — visibility without
 *    friction, which is the actual trade being made;
 *  - a TOTP second factor, when one is enrolled, is asked for in both modes.
 *
 * `webRequireApproval: true` restores the word-pair prompt exactly as it was,
 * for a desktop somebody is willing to be standing at.
 *
 * ## What is kept from the neighbour
 *
 *  1. **Constant-time comparison.** See `sameString`, and the honest note there
 *     about which of these comparisons is actually secret.
 *  2. **Failure lockout per source**, on `AUTH_MAX_FAILURES`/`AUTH_LOCKOUT_MS`
 *     from shared/mobile.ts rather than numbers invented here.
 *  3. **Approval by a human at the desk**, with the word pair from
 *     `wordPair` — the same list both screens draw from, because two lists is
 *     how the two screens end up showing different words. Optional now, and
 *     unchanged when it is switched on.
 *  4. **Everything injected**, including the clock and the JWKS fetcher, so a
 *     check script drives this exact class with no network and no Electron.
 *
 * ## What this does *not* protect against
 *
 *  - A browser profile that is already approved and already signed in. Approval
 *    is per browser profile, and a person at that machine is that browser.
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

/**
 * Floor between approval prompts, and it shares its rationale with the
 * one-pending rule in `beginApproval`: a script must not be able to queue a
 * thousand prompts so that somebody taps Allow on one by accident. Prompt
 * fatigue is how people get owned, and one prompt a minute is slower than
 * anyone fatigues. Same value and same reason as PROMPT_COOLDOWN_MS in
 * electron/mobile/server.ts.
 */
const PROMPT_COOLDOWN_MS = 60_000

/* ------------------------------------------------------------------- shapes */

/**
 * An approved browser, as persisted in Settings. Note: no credential anywhere.
 *
 * An alias of the settings record rather than a second declaration, so the
 * thing this module writes and the thing `Settings.webDevices` holds cannot
 * drift apart. The import is type-only, so this file still carries no runtime
 * dependency beyond `node:crypto` and the check script can bundle it alone.
 */
export type WebDevice = WebDeviceRecord

/**
 * The second factor, as this class needs it: the secret in the clear, the
 * hashes of the recovery codes nobody has spent, and the last counter that was.
 *
 * The secret is plaintext *here* and sealed on disk, and the seam is the point:
 * this class is arithmetic and has no business knowing about files or keys, and
 * a check script can drive every branch of it by handing over a secret it made
 * up. See `webTotpSecret` in shared/types.ts for what actually gets written.
 */
export interface WebTotpState {
  /** base32, or '' when nothing is enrolled — which means nothing is asked for. */
  secret: string
  /** SHA-256 of each unused recovery code. Spending one removes it. */
  recovery: string[]
  /** The highest counter already accepted. A code at or below it is a replay. */
  lastCounter: number
}

/** What the settings panel is handed when it starts an enrolment. */
export interface WebTotpEnrolment {
  /** base32, for somebody whose phone cannot scan. */
  secret: string
  /** The `otpauth://` URI the panel turns into a QR. */
  uri: string
}

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
    const res = await globalThis.fetch(url)
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
    return { body: await res.text(), cacheControl: res.headers.get('cache-control') ?? '' }
  }
}

/** What the desktop prompt needs to ask a human the question. */
export interface WebApprovalAsk {
  requestId: string
  deviceId: string
  /** What the browser calls itself. Untrusted text — display it, never obey it. */
  deviceName: string
  /** The pair both screens show, e.g. "OTTER RIVER". */
  words: string
  /** The account the token verified as, so the prompt can name who is asking. */
  uid: string
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
  /** The approved browsers as they stand in settings. */
  load: () => WebDevice[]
  /** Persist a changed device list. Called on approve, revoke and last-seen bumps. */
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
   * When "Accept new browsers" disarms itself (ms epoch), 0 when it is not
   * armed. Read on every unknown device, so disarming takes effect on the very
   * next connection rather than whenever a timer happens to fire.
   */
  acceptUntil?: () => number
  /**
   * Is the hardening toggle on? Read per connection, like everything else here,
   * so switching it at the desk bites on the next hello.
   *
   * A host that omits it gets `false`, which is the shipped default and the
   * account-only path: a browser holding a verified token for the configured
   * uid is admitted and recorded without a prompt. See the header.
   */
  requireApproval?: () => boolean
  /**
   * The second factor as it stands on disk, or undefined on a host that has
   * none. `secret` is the *unsealed* base32 — this class does arithmetic, and
   * the host is what knows about `electron/web/secret-box.ts`.
   */
  totp?: () => WebTotpState
  /**
   * Persist a changed second factor: a spent counter, a spent recovery code, an
   * enrolment, a removal. Called on every accepted code, because "single use"
   * that only holds until the next restart is not single use.
   */
  saveTotp?: (state: WebTotpState) => void
  /** How long "trust this browser" lasts. Defaults to TRUST_WINDOW_MS. */
  trustWindowMs?: number
  /**
   * Put the question to the human, and resolve with the verdict. A rejected
   * promise is treated exactly like a `false` — every path that is not an
   * explicit allow is a deny. A host that omits this hook has no approval door
   * at all, which is what makes a test server and any future host safe by
   * default.
   */
  requestApproval?: (ask: WebApprovalAsk) => Promise<boolean>
  /**
   * The question is moot — the browser hung up, or nobody answered. The host
   * takes the prompt down; a prompt that outlives its socket is one whose Allow
   * lands on nothing.
   */
  cancelApproval?: (requestId: string) => void
  /** Injected so a check script can drive expiry and lockout on a fake clock. */
  now?: () => number
  /**
   * How long a browser is left at the "showing OTTER RIVER" screen. Defaults to
   * APPROVAL_TIMEOUT_MS. Injectable so a check script can watch the wait
   * actually fire without sleeping through two minutes of it — the same
   * arrangement electron/mobile/server.ts makes, and for the same reason.
   */
  approvalTimeoutMs?: number
  /** Floor between prompts. Defaults to PROMPT_COOLDOWN_MS. */
  promptCooldownMs?: number
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

/** What the browser is shown while a human is being asked. See `WebPendingFrame`. */
export interface WebAuthPending {
  words: string
  /** ms epoch on this desktop's clock. */
  expiresAt: number
  /** Correlates with `WebApprovalAsk.requestId`, for `abandon`. */
  requestId: string
}

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
   * The second factor off the `hello` frame: six digits, or a recovery code.
   * Absent on the first attempt of every sign-in — see `WebHelloFrame.totp`.
   */
  totp?: string
  /**
   * "Trust this browser for 30 days". Honoured only alongside a code that was
   * actually accepted; on its own it grants nothing.
   */
  trust?: boolean
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

interface ApprovalWait {
  requestId: string
  words: string
  expiresAt: number
  /**
   * The wait has exactly one outcome, whichever of allow / deny / timeout /
   * hangup arrives first. Everything that can settle it checks this flag, so a
   * timeout racing a tap can never approve after a close — or close after an
   * approval.
   */
  settled: boolean
  settle: (outcome: WebAuthOutcome) => void
  timer: ReturnType<typeof setTimeout>
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

  /** At most one approval in flight, ever. See `beginApproval`. */
  private pending: ApprovalWait | null = null
  private lastPromptAt = 0

  /**
   * A second factor somebody has been offered and not yet proved. In memory
   * only, deliberately: see `beginEnrolment`.
   */
  private enrolment: { secret: string; recovery: string[] } | null = null

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
   * Five gates, in this order, and the order is load-bearing:
   *
   *  1. **Lockout**, so a source that has been failing does not get to keep
   *     trying while the rest of this runs.
   *  2. **The token**, verified against Google's keys — signature *and* every
   *     claim. A token that does not verify is `bad-token` whatever uid it
   *     claims, which is why this runs before the uid is looked at: a token
   *     minted by somebody else's Firebase project whose `sub` happens to equal
   *     ours must not be able to reach the `wrong-account` branch and learn it
   *     guessed right.
   *  3. **The account**, which is `wrong-account` and a genuinely different
   *     outcome: a different sentence, a different recovery, and never a retry
   *     loop on a correct credential.
   *  4. **Revocation**, which is the one answer that is identical in both
   *     modes. A browser somebody ended at this desk stays ended, and the
   *     permissive mode does not soften it by so much as a prompt.
   *  5. **The second factor** when one is enrolled, and then **the device** —
   *     recorded and admitted on the default path, or put to a human when
   *     `requireApproval` is on.
   *
   * The second factor is checked before the device is admitted and *after*
   * revocation, so a revoked browser is turned away without being invited to
   * type a code — there is nothing a correct code could have bought it.
   *
   * `onPending` fires exactly once, before any waiting, when a prompt has gone
   * up on the desktop — it is how the server knows to send `WebPendingFrame`
   * and what words to put in it. The returned promise settles later, with the
   * human's answer or with `timed-out`.
   */
  async authenticate(input: WebAuthInput, onPending?: (pending: WebAuthPending) => void): Promise<WebAuthOutcome> {
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
        message: 'This browser did not identify itself, so it cannot be approved. Reload the page and try again.'
      })
    }

    const devices = this.host.load()
    const known = devices.find((d) => sameString(d.id, deviceId))

    if (known?.revokedAt) {
      // No prompt, deliberately: a revoked browser that keeps knocking would
      // otherwise be a prompt storm on somebody's desk, which is the exact
      // failure `revoked` exists to prevent.
      return this.fail(input.source, {
        ok: false,
        reason: 'revoked',
        message: "This browser was removed from the desktop's device list. Sign in from one it still trusts."
      })
    }

    // Spends the code, if there was one to spend, before anything is written.
    const second = this.secondFactor(known ?? null, input)
    if (!second.ok) {
      // `totp-required` is the first half of every ordinary sign-in on a
      // desktop with 2FA — not a failure, and struck for as such would lock
      // somebody out on their fifth login. Every other refusal here counts.
      if (second.reason === 'totp-required') {
        this.host.log?.(`web auth: asking "${deviceName}" at ${input.source} for a code`)
        return second
      }
      return this.fail(input.source, second)
    }

    if (known) {
      known.name = deviceName
      known.lastSeenAt = this.now()
      if (second.trustedUntil) known.trustedUntil = second.trustedUntil
      this.host.save(devices)
      this.clearStrikes(input.source)
      return { ok: true, device: known, claims: verified.claims }
    }

    // A browser this desktop has never seen. Which of the two doors it goes
    // through is the whole of `webRequireApproval`, and the default is the one
    // that needs nobody at the desk.
    if (this.host.requireApproval?.() === true) {
      return this.beginApproval(input.source, deviceId, deviceName, verified.claims, onPending, second.trustedUntil)
    }

    this.host.log?.(`"${deviceName}" admitted from ${input.source} on the account alone, and recorded`)
    this.clearStrikes(input.source)
    return { ok: true, device: this.approve(deviceId, deviceName, second.trustedUntil), claims: verified.claims }
  }

  /**
   * Re-verify a token presented mid-connection — the `auth` frame, sent before
   * the old one lapses. See TOKEN_REFRESH_MS in shared/web.ts.
   *
   * The same check the `hello` took, because "this credential does not get in"
   * is one answer whether it is heard at the start of a connection or an hour
   * into it. Deliberately no device work: the browser on the far end of an open
   * socket was approved when it opened it, and nothing about a fresh token
   * changes that.
   */
  async verifyToken(idToken: string, source: string): Promise<WebTokenOutcome> {
    const locked = this.lockout(source)
    if (locked) return locked
    const verified = await this.checkToken(idToken)
    if (!verified.ok) return this.fail(source, verified)
    this.clearStrikes(source)
    return verified
  }

  /**
   * The browser hung up while a human was still being asked. Withdraw the
   * prompt and settle the wait; deny by default, as every non-allow does.
   */
  abandon(requestId: string): void {
    const wait = this.pending
    if (!wait || wait.requestId !== requestId) return
    this.settle(wait, {
      ok: false,
      reason: 'declined',
      message: 'The browser stopped waiting for an answer.'
    })
  }

  /* -------------------------------------------------------- the second factor */

  /**
   * Is the second factor satisfied for this connection?
   *
   * Four ways to be satisfied and two ways not, and the ordering is what makes
   * it usable rather than merely correct:
   *
   *  1. **Nothing enrolled** — no secret, nothing asked, and this is the state
   *     the desktop ships in.
   *  2. **This browser is trusted** and the window has not closed. See
   *     TRUST_WINDOW_MS; the whole point is that a code is a monthly event.
   *  3. **A correct TOTP code**, inside TOTP_DRIFT_STEPS, *and* on a counter
   *     that has not been spent. The replay guard is not decoration: without it
   *     the drift window is three chances at the same six digits, and somebody
   *     who reads a code over a shoulder has thirty seconds to use it.
   *  4. **An unspent recovery code**, which is burned as it is accepted.
   *
   * Every accepted code is written back through `saveTotp` *before* this
   * returns, so a code cannot be spent twice by two sockets racing, and a
   * restart between the two attempts does not hand it back.
   *
   * The two refusals are one sentence between them on purpose: telling "wrong
   * code" apart from "already used" out loud tells somebody holding a stolen
   * code which half of the guess was right.
   */
  private secondFactor(
    known: WebDevice | null,
    input: WebAuthInput
  ): { ok: true; trustedUntil: number } | { ok: false; reason: 'totp-required' | 'totp-invalid'; message: string } {
    const state = this.host.totp?.()
    if (!state?.secret) return { ok: true, trustedUntil: 0 }

    const now = this.now()
    if (known && known.trustedUntil > now) return { ok: true, trustedUntil: known.trustedUntil }

    const presented = String(input.totp ?? '').trim()
    if (!presented) {
      return {
        ok: false,
        reason: 'totp-required',
        message: `Enter the ${TOTP_DIGITS}-digit code from your authenticator app, or one of your recovery codes.`
      }
    }

    const wrong = {
      ok: false as const,
      reason: 'totp-invalid' as const,
      message: 'That code was not accepted. Codes last 30 seconds and each one works once.'
    }
    // The trust window is only granted alongside a code that was accepted; the
    // flag on its own is a browser asking to skip the factor.
    const granted = input.trust === true ? now + (this.host.trustWindowMs ?? TRUST_WINDOW_MS) : 0

    if (new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(presented)) {
      const counter = checkTotp(state.secret, presented, now)
      if (counter === null) return wrong
      // `<=`, not `<`: the counter that was spent is the one that is dead, and
      // this is the assertion the whole feature stands on.
      if (counter <= state.lastCounter) return wrong
      this.host.saveTotp?.({ ...state, lastCounter: counter })
      return { ok: true, trustedUntil: granted }
    }

    const hash = hashRecoveryCode(presented)
    const index = state.recovery.findIndex((held) => sameString(held, hash))
    if (index < 0) return wrong
    this.host.saveTotp?.({ ...state, recovery: state.recovery.filter((_, i) => i !== index) })
    this.host.log?.(`web auth: a recovery code was spent — ${state.recovery.length - 1} left`)
    return { ok: true, trustedUntil: granted }
  }

  /* ------------------------------------------------------------- enrolment */

  /**
   * Start enrolling a second factor: a fresh secret, and the URI a QR is made
   * of.
   *
   * Held in this object's memory and written nowhere. An unverified secret is
   * never persisted, and that is the rule the whole enrolment is shaped around:
   * a secret saved before somebody proved their app has it is a lockout with a
   * green tick on it. Starting again replaces any offer already outstanding —
   * two live secrets would mean two ways in and only one on screen.
   */
  beginEnrolment(account: string): WebTotpEnrolment {
    const secret = newTotpSecret()
    this.enrolment = { secret, recovery: newRecoveryCodes() }
    return { secret, uri: totpUri(secret, account) }
  }

  /** Abandon an outstanding offer — the panel was closed, or somebody said no. */
  cancelEnrolment(): void {
    this.enrolment = null
  }

  /**
   * Finish enrolling: prove the app holds the secret, and only then write it.
   *
   * The recovery codes come back here and nowhere else, ever. They are hashed
   * on the way to the host and there is no call that returns them a second
   * time, which is the same rule the ngrok authtoken field follows and the same
   * reason: a panel that can render spare keys on demand is a panel a
   * screen-share renders them on.
   *
   * `lastCounter` is seeded with the counter that verified, so the code somebody
   * just typed into the settings panel cannot immediately be typed into a
   * browser as well.
   */
  completeEnrolment(code: string): { ok: true; recovery: string[] } | { ok: false; error: string } {
    const pending = this.enrolment
    if (!pending) return { ok: false, error: 'Start the setup again — there is no code waiting to be confirmed.' }
    const counter = checkTotp(pending.secret, String(code ?? '').trim(), this.now())
    if (counter === null) {
      return { ok: false, error: 'That code did not match. Check the app has finished adding Forge, then try the next one.' }
    }
    if (!this.host.saveTotp) return { ok: false, error: 'This desktop cannot store a second factor.' }
    this.host.saveTotp({
      secret: pending.secret,
      recovery: pending.recovery.map(hashRecoveryCode),
      lastCounter: counter
    })
    this.enrolment = null
    return { ok: true, recovery: pending.recovery }
  }

  /** Remove the second factor entirely, along with every unspent recovery code. */
  disableTotp(): void {
    this.enrolment = null
    this.host.saveTotp?.({ secret: '', recovery: [], lastCounter: 0 })
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

  /* ------------------------------------------------------------ device approval */

  /**
   * A browser this desktop has never approved: mint the word pair, tell the
   * caller to show it, and hold on while a human is asked.
   *
   * Three ways this never even asks, and all three answer `not-approved` with
   * the same sentence — the protocol's own definition of that value is "no
   * prompt can be raised right now", and a caller must not be able to tell
   * which of the three it hit:
   *
   *  - the host has no approval door at all;
   *  - "Accept new browsers" is not armed;
   *  - another approval is already in flight, or the last prompt was too
   *    recently.
   */
  private async beginApproval(
    source: string,
    deviceId: string,
    deviceName: string,
    claims: WebTokenClaims,
    onPending?: (pending: WebAuthPending) => void,
    trustedUntil = 0
  ): Promise<WebAuthOutcome> {
    const shut = {
      ok: false as const,
      reason: 'not-approved' as const,
      message: 'This desktop has not approved this browser and is not accepting new ones right now.'
    }
    const cooldownMs = this.host.promptCooldownMs ?? PROMPT_COOLDOWN_MS
    if (!this.host.requestApproval) return this.fail(source, shut)
    if ((this.host.acceptUntil?.() ?? 0) <= this.now()) return this.fail(source, shut)
    if (this.pending || this.now() - this.lastPromptAt < cooldownMs) return this.fail(source, shut)

    // The pair is not a secret — 4096 possibilities is not entropy — but it has
    // to be unpredictable, or a stranger timing their ask to Steve's own could
    // show the matching words while he is looking at the prompt. So:
    // node:crypto, not Math.random.
    const words = wordPair(randomBytes(2))
    const requestId = randomUUID()
    const timeoutMs = this.host.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    const expiresAt = this.now() + timeoutMs

    const settled = new Promise<WebAuthOutcome>((resolve) => {
      const wait: ApprovalWait = {
        requestId,
        words,
        expiresAt,
        settled: false,
        settle: resolve,
        // The socket is held open and unauthenticated for the whole wait, so an
        // approval nobody is standing next to must not pin a connection open
        // until the process restarts. See APPROVAL_TIMEOUT_MS.
        timer: setTimeout(() => {
          this.settle(wait, {
            ok: false,
            reason: 'timed-out',
            message: 'Nobody answered on the desktop — open Forge there and try again.'
          })
        }, timeoutMs)
      }
      this.pending = wait
      this.lastPromptAt = this.now()

      // The words reach the browser before the human is asked, so the pair on
      // screen is on screen while somebody is comparing it to the prompt.
      onPending?.({ words, expiresAt, requestId })
      this.host.log?.(`"${deviceName}" is asking to connect from ${source}`)

      this.host
        .requestApproval!({ requestId, deviceId, deviceName, words, uid: claims.uid })
        .then((allowed) => {
          // The `settled` check is here as well as inside `settle`, and it has
          // to be: an Allow that arrives after the wait timed out must not
          // write an approval row for a connection that was already refused.
          if (wait.settled) return
          if (allowed === true) {
            this.settle(wait, { ok: true, device: this.approve(deviceId, deviceName, trustedUntil), claims })
            return
          }
          this.settle(wait, { ok: false, reason: 'declined', message: 'The desktop said no.' })
        })
        .catch(() => {
          this.settle(wait, { ok: false, reason: 'declined', message: 'The desktop could not ask.' })
        })
    })

    const outcome = await settled
    if (!outcome.ok) return this.fail(source, outcome)
    this.clearStrikes(source)
    return outcome
  }

  /**
   * The one exit from an approval wait. `settled` makes the outcomes race-proof:
   * whichever of allow / deny / timeout / hangup lands first wins, and the rest
   * are no-ops.
   */
  private settle(wait: ApprovalWait, outcome: WebAuthOutcome): void {
    if (wait.settled) return
    wait.settled = true
    clearTimeout(wait.timer)
    if (this.pending === wait) this.pending = null
    // Withdraw the desktop prompt whichever way this ended — a no-op when the
    // prompt itself is what answered.
    this.host.cancelApproval?.(wait.requestId)
    wait.settle(outcome)
  }

  /**
   * Record an approval. The one place a device row is created, and the reason
   * it is one place rather than two is the reason `mintDevice` is one place in
   * mobile/auth.ts: the authorisation happened before this was called, and what
   * this guarantees is the invariant the rest of the app leans on — what
   * reaches `save` is an id, a name and three timestamps, and never anything a
   * browser could present later as a credential.
   */
  private approve(deviceId: string, deviceName: string, trustedUntil = 0): WebDevice {
    const device: WebDevice = {
      id: deviceId,
      name: deviceName,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      revokedAt: 0,
      trustedUntil
    }
    // Approving a browser this desktop already has a row for replaces it, rather
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
   * Every refusal counts, not only the credential ones. A wrong account, an
   * unapproved device and a declined prompt are all things a stranger with the
   * address can generate on repeat, and the strike counter is what stops the
   * third one from being a prompt storm even when the per-prompt cooldown has
   * lapsed. The one thing that does not count is success, which clears the slate.
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

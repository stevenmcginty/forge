import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES } from '@shared/mobile'
import type { MobileDeviceRecord } from '@shared/types'

/**
 * Forge Mobile authentication.
 *
 * Be honest about what this protects. The protocol has no "run this command"
 * frame — `op` names a profile id the desktop resolves itself — but `write`
 * types into a live shell, so **a valid credential is a shell as Steve.**
 * Constraining the frames reduces the damage an accident does; it does nothing
 * about an attacker who holds a token. Everything here therefore defends the
 * credential itself, and the network posture (loopback + tailnet only, see
 * server.ts) defends the fact that the port exists at all.
 *
 * Three rules the rest of the app relies on:
 *
 *  1. **Only hashes are stored.** `settings.json` holds SHA-256 of each device
 *     token and never the token. `scripts/mobile-auth-check.mjs` reads the
 *     written file back and fails if a raw token appears in it — the same
 *     instinct as `scripts/secrets-audit.mjs`.
 *  2. **Pairing tokens are single-use and short-lived.** A QR photographed over
 *     Steve's shoulder is dead on first use, or in five minutes, whichever
 *     comes first. They live in memory only: a pending pairing should not
 *     survive a restart.
 *  3. **Comparisons are constant-time.** `timingSafeEqual` over fixed-width
 *     digests, so a wrong token leaks nothing about how wrong it was.
 *
 * Electron-free and dependency-free, so the smoke test drives this exact class.
 */

/** Bytes of entropy in a device token. 32 = 256 bits, base64url ≈ 43 chars. */
const TOKEN_BYTES = 32
/** Pairing tokens are typed/scanned by a human, so they are shorter — 128 bits. */
const PAIR_TOKEN_BYTES = 16
/** How long a QR stays good for. */
export const PAIR_TTL_MS = 5 * 60_000
/** Backstop on the strike map's size — see `pruneStrikes`. */
const MAX_STRIKE_BUCKETS = 10_000

/**
 * A paired phone, as persisted in Settings. Note: no raw token anywhere.
 *
 * An alias of the settings record rather than a second declaration, so the
 * thing this module writes and the thing `Settings.mobileDevices` holds cannot
 * drift apart. The import is type-only, so this file still carries no runtime
 * dependency and the smoke test can bundle it alone.
 */
export type MobileDevice = MobileDeviceRecord

export interface PairingOffer {
  token: string
  expiresAt: number
}

export type AuthResult =
  | { ok: true; device: MobileDevice; issuedToken?: string }
  | { ok: false; code: 'auth' | 'locked'; msg: string }

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Constant-time compare of two hex digests.
 *
 * Both sides are hashed before they get here, so they are always the same
 * length and `timingSafeEqual` can never throw on a length mismatch — which is
 * itself the reason to compare hashes rather than raw tokens.
 */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

function newToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

interface Strike {
  count: number
  until: number
}

export interface AuthStoreHost {
  /** The devices as they stand in settings. */
  load: () => MobileDevice[]
  /** Persist a changed device list. Called on pair, revoke and last-seen bumps. */
  save: (devices: MobileDevice[]) => void
  /** Injected so the smoke test can drive a fake clock. */
  now?: () => number
  /**
   * How long a pairing code stays good. Defaults to PAIR_TTL_MS.
   *
   * Injectable because five minutes is right for a code shown behind a settings
   * switch on a screen you are sitting at, and wrong for one printed into a
   * terminal you might walk away from. The window is still a window either way
   * — this exists to be *set*, not to be turned off, and a code remains
   * single-use whatever its life.
   */
  pairTtlMs?: number
}

export class MobileAuth {
  private readonly host: AuthStoreHost
  private readonly now: () => number
  private readonly pairTtlMs: number
  /** Pending pairings, in memory only — a restart cancels them by design. */
  private pending: PairingOffer | null = null
  private strikes = new Map<string, Strike>()

  constructor(host: AuthStoreHost) {
    this.host = host
    this.now = host.now ?? (() => Date.now())
    this.pairTtlMs = host.pairTtlMs && host.pairTtlMs > 0 ? host.pairTtlMs : PAIR_TTL_MS
  }

  /**
   * Mint a pairing token for the QR in Settings. Replaces any outstanding
   * offer: two live QRs would mean two ways in and only one of them on screen.
   */
  offerPairing(): PairingOffer {
    const offer: PairingOffer = {
      token: newToken(PAIR_TOKEN_BYTES),
      expiresAt: this.now() + this.pairTtlMs
    }
    this.pending = offer
    return offer
  }

  cancelPairing(): void {
    this.pending = null
  }

  /** The outstanding offer, or null if there is none or it has expired. */
  pendingOffer(): PairingOffer | null {
    if (!this.pending) return null
    if (this.now() >= this.pending.expiresAt) {
      this.pending = null
      return null
    }
    return this.pending
  }

  devices(): MobileDevice[] {
    return this.host.load()
  }

  /**
   * Authenticate a `hello`.
   *
   * Two doors. An existing device presents its token; a new one presents the
   * pairing token from the QR and is issued a device token in the `hello-ok`.
   *
   * ## Which bucket a failure counts against
   *
   * The key is chosen before anything is checked: a presented credential gets a
   * bucket of its own, keyed by that credential's digest, and only a
   * credential-less hello counts against its source address. The reason is the
   * tunnel: `cloudflared` and ngrok dial from loopback, so behind one every
   * caller on earth shares a single `127.0.0.1` with the owner — and on a
   * shared address-keyed bucket, a stranger's five guesses locked the owner's
   * own phone out, while the owner's next success wiped the stranger's tally.
   * Digest-keyed, a wrong guess lands in a bucket only the guesser can fill,
   * and the right token lands in one that is always empty. Guessing a bucket is
   * not a way in: the credentials themselves are 128 and 256 bits, and what the
   * shared address bucket still buys is a stop on credential-less hammering.
   */
  authenticate(input: {
    source: string
    deviceId: string
    deviceName: string
    token?: string
    pairToken?: string
  }): AuthResult {
    const key = this.strikeKey(input)
    const locked = this.lockout(key)
    if (locked) return locked

    if (input.pairToken) return this.pair(input)
    if (input.token) return this.resume(input)

    // Also the answer an unarmed desktop gives to `requestPair` (server.ts
    // ignores the flag when "Accept new phones" is off, so that hello lands
    // here). The sentence is therefore written for both readers: a phone with
    // no token learns the desktop is not accepting it right now, and a probe
    // learns nothing it could not learn by omitting the flag — the two
    // refusals are one refusal.
    return this.fail(key, 'This phone is not paired, and the desktop is not accepting new phones right now.')
  }

  /**
   * The strike bucket for one hello, as `authenticate` describes. The digest
   * rather than the raw credential so the key is fixed-width and never itself
   * something worth reading out of a heap dump.
   */
  private strikeKey(input: { source: string; token?: string; pairToken?: string }): string {
    if (input.token) return `token:${sha256(String(input.token))}`
    if (input.pairToken) return `pair:${sha256(String(input.pairToken))}`
    return `ip:${input.source}`
  }

  private pair(input: { source: string; deviceId: string; deviceName: string; pairToken?: string }): AuthResult {
    const key = this.strikeKey(input)
    const offer = this.pendingOffer()
    if (!offer) return this.fail(key, 'No pairing is open — start one in Settings')
    if (!sameDigest(sha256(offer.token), sha256(String(input.pairToken)))) {
      return this.fail(key, 'Pairing code is not valid')
    }

    // Single-use: burn it before issuing anything, so even a re-entrant caller
    // cannot spend the same offer twice. Nothing is cleared on success — a
    // bucket empties with time, not because its owner happened to succeed; see
    // `fail`.
    this.pending = null

    const { device, issuedToken } = this.mintDevice(input.deviceId, input.deviceName)
    return { ok: true, device, issuedToken }
  }

  /**
   * Mint a device credential and persist its hash — the one place a device
   * token is ever created.
   *
   * Both doors end here: the code path (`pair()` above, once the offer is
   * burned) and the approval path (server.ts, once Steve has tapped Allow).
   * One routine rather than two similar ones, because two nearly-identical
   * credential paths is how one of them quietly stops hashing — and because
   * the phone must not be able to tell afterwards which door it came through.
   *
   * The authorisation happened before this was called; nothing here checks
   * anything. What it guarantees is the invariant the rest of the app leans
   * on: the raw token goes to the return value, and only its SHA-256 goes to
   * `save`.
   */
  mintDevice(deviceId: string, deviceName: string): { device: MobileDevice; issuedToken: string } {
    const raw = newToken(TOKEN_BYTES)
    const device: MobileDevice = {
      id: deviceId || newToken(8),
      name: deviceName || 'Phone',
      tokenHash: sha256(raw),
      createdAt: this.now(),
      lastSeenAt: this.now()
    }
    // Re-pairing a device Steve already knows replaces it rather than adding a
    // second row with the same name and a stale hash.
    const devices = this.host.load().filter((d) => d.id !== device.id)
    devices.push(device)
    this.host.save(devices)
    return { device, issuedToken: raw }
  }

  private resume(input: { source: string; deviceId: string; token?: string }): AuthResult {
    const devices = this.host.load()
    const presented = sha256(String(input.token))
    // Matched on the token alone, not on deviceId: the token is the secret, and
    // trusting a client-supplied id to pick which hash to compare against would
    // let a caller choose its own oracle.
    const found = devices.find((d) => sameDigest(d.tokenHash, presented))
    if (!found) return this.fail(this.strikeKey(input), 'This device is not paired')

    found.lastSeenAt = this.now()
    this.host.save(devices)
    return { ok: true, device: found }
  }

  /** Drop a device. Its live socket is closed by the server, separately. */
  revoke(deviceId: string): boolean {
    const devices = this.host.load()
    const next = devices.filter((d) => d.id !== deviceId)
    if (next.length === devices.length) return false
    this.host.save(next)
    return true
  }

  revokeAll(): void {
    this.host.save([])
  }

  /* -------------------------------------------------------------- lockout */

  /**
   * Is this bucket locked out right now? The key it is handed is chosen by
   * `strikeKey` — see the note on `authenticate` for why that is not simply the
   * source address.
   */
  private lockout(key: string): { ok: false; code: 'locked'; msg: string } | null {
    const strike = this.strikes.get(key)
    if (!strike) return null
    if (this.now() >= strike.until) {
      this.strikes.delete(key)
      return null
    }
    if (strike.count < AUTH_MAX_FAILURES) return null
    const seconds = Math.ceil((strike.until - this.now()) / 1000)
    return { ok: false, code: 'locked', msg: `Too many attempts — try again in ${seconds}s` }
  }

  /**
   * Count one failure against a bucket, and hand the refusal back unchanged.
   *
   * Nothing a caller does — including succeeding — empties a bucket early. The
   * only mercy is time: `until` passes and the count goes with it. That is the
   * fix for the tunnel, where a success and a stranger's failures used to share
   * one address-keyed bucket and each could reset the other's.
   */
  private fail(key: string, msg: string): { ok: false; code: 'auth'; msg: string } {
    const strike = this.strikes.get(key) ?? { count: 0, until: 0 }
    strike.count += 1
    strike.until = this.now() + AUTH_LOCKOUT_MS
    this.strikes.set(key, strike)
    this.pruneStrikes()
    return { ok: false, code: 'auth', msg }
  }

  /**
   * Drop buckets whose window has lapsed, so a key derived from
   * attacker-chosen bytes cannot grow the map without bound — a wrong token a
   * second for a minute is six thousand live entries otherwise.
   *
   * The backstop clear is deliberately blunt and errs the safe way: dropping a
   * bucket can only *un*lock a guesser, never lock the owner out, and an
   * attacker fast enough to reach it has a fresh empty map to start over in,
   * which is no worse than the position they were already in.
   */
  private pruneStrikes(): void {
    const now = this.now()
    for (const [key, strike] of this.strikes) {
      if (now >= strike.until) this.strikes.delete(key)
    }
    if (this.strikes.size > MAX_STRIKE_BUCKETS) this.strikes.clear()
  }
}

/** Exported for the auth check, which asserts settings.json never holds a raw token. */
export { sha256 as hashToken }

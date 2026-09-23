import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  WebPasskeyAssertion,
  WebPasskeyCreationOptions,
  WebPasskeyInfo,
  WebPasskeyRequestOptions
} from '@shared/web'

/**
 * Passkeys for Forge Web — a phone's own fingerprint or face standing in for
 * the unlock PIN.
 *
 * ## What this is, and what it is not
 *
 * A passkey here is an *alternative answer to the PIN question*, never a way
 * round the door. Everything in front of the PIN still stands exactly as
 * electron/web/auth.ts describes it: a Firebase ID token verified against
 * Google's keys, for the one configured uid, from an allowed origin. What a
 * passkey replaces is only the four digits — and it replaces them with
 * something strictly stronger: a private key that never leaves the phone's
 * secure hardware, released only after the phone itself has checked a
 * fingerprint or a face (`userVerification: 'required'`, and the UV flag is
 * checked here rather than trusted).
 *
 * The PIN stays. It is the fallback when the biometric is cancelled, and it is
 * the root the passkeys hang from: every passkey is enrolled *under* the PIN
 * that was set when it was made, and changing or clearing that PIN voids every
 * one of them (see `PasskeyStore`). A person who changes the PIN because they
 * think it leaked must not find that a phone enrolled under the old one still
 * walks in.
 *
 * ## Failures are wrong PINs
 *
 * Any assertion that does not verify — an unknown credential, a challenge
 * issued for another account or purpose, the wrong origin, a missing UV flag,
 * a bad signature, a counter that went backwards — is answered exactly as a
 * wrong PIN is, and is struck against the same account bucket. There is no
 * second, laxer counter for passkeys; a door with two locks and one of them
 * unthrottled is a door with one lock.
 *
 * One answer is neither a yes nor a strike: a *correct* assertion over a
 * challenge that is no longer pending — already spent, expired, or evicted. A
 * phone whose `hello-ok` was lost and that retries, or whose owner took more
 * than two minutes over the fingerprint, holds exactly that, and it is the
 * right person with the right key. Striking it would be the "Try again"
 * lockout the expired-token path in electron/web/auth.ts already fixed for
 * tokens. So the assertion is still checked in full against the credential it
 * names — signature, origin, rpIdHash, UP/UV, type — and if all of that holds
 * the desktop asks again with a fresh challenge, unstruck. It never unlocks on
 * a stale challenge, and a stale one that does *not* verify is struck.
 *
 * ## Why hand-rolled
 *
 * The same reason electron/web/auth.ts gives for doing RS256 by hand: this
 * module is bundled with esbuild and driven by scripts/web-passkey-check.mjs,
 * so the thing that is tested is the thing that ships, and `node:crypto` has
 * always been able to verify both signature kinds used here. The only format
 * work is CBOR, and the shape a WebAuthn attestation object and a COSE key
 * take is small and fixed: unsigned and negative integers, byte and text
 * strings, arrays, maps, and three simple values. Everything else — tags,
 * floats, indefinite lengths — is refused, because none of it is legitimately
 * in the shape and all of it is a parser path nobody tested.
 *
 * Public keys are not secrets, so the store is plain JSON beside the other web
 * state in the data directory. What it must not do is outlive the PIN it was
 * enrolled under, and that rule is enforced on every read.
 *
 * Every public function is total: what arrives is attacker-controlled bytes
 * off a socket or a file a person may have edited.
 */

/* ---------------------------------------------------------------- constants */

/** How long a challenge may be answered in. Two minutes: a biometric prompt, not a coffee break. */
export const PASSKEY_CHALLENGE_MS = 2 * 60_000

/** Bytes of randomness in a challenge. WebAuthn asks for at least 16. */
const CHALLENGE_BYTES = 32

/**
 * Challenges held at once for one account and one purpose. Past this the
 * oldest of that same kind goes, so a burst of enrolment begins can never
 * evict the `get` a phone is halfway through answering.
 */
const MAX_PENDING_PER_PURPOSE = 8

/**
 * Challenges held at once, across every account and purpose. Only a socket
 * that has already verified a token for the owner's uid can mint one, so this
 * is a backstop against a reconnect loop rather than against a stranger.
 */
const MAX_PENDING = 64

/** Passkeys one account may hold. A person has a handful of devices, not hundreds. */
export const MAX_PASSKEYS_PER_ACCOUNT = 20

/** WebAuthn caps a credential id at 1023 bytes. */
const MAX_CREDENTIAL_ID_BYTES = 1023

/** COSE algorithm ids this desktop accepts: ES256 and RS256, in preference order. */
export const COSE_ES256 = -7
export const COSE_RS256 = -257

/** The authenticator-data flag bits this file reads. */
const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40
const FLAG_ED = 0x80

/* ---------------------------------------------------------------- base64url */

const B64URL = /^[A-Za-z0-9_-]*$/

/** base64url to bytes, or null. Tolerates trailing `=` padding, which some encoders add. */
function fromB64url(text: unknown, maxChars: number): Buffer | null {
  if (typeof text !== 'string') return null
  const trimmed = text.replace(/=+$/, '')
  if (!trimmed || trimmed.length > maxChars || !B64URL.test(trimmed)) return null
  try {
    return Buffer.from(trimmed, 'base64url')
  } catch {
    return null
  }
}

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Strip control characters and bound the length before attacker-supplied text
 * (a `clientData.origin`) reaches a log line. Same guard as electron/web/auth.ts's
 * `printable`, kept local because that module imports this one.
 */
function forLog(text: string): string {
  return [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 31 && code !== 127
    })
    .join('')
    .slice(0, 200)
}

/* --------------------------------------------------------------------- CBOR */

/** Nesting deeper than this is not a WebAuthn structure. The real ones are three deep. */
const CBOR_MAX_DEPTH = 6
/** Entries in one array or map. A COSE key has five; an attestation object three. */
const CBOR_MAX_ITEMS = 64

export type CborValue = number | string | boolean | null | undefined | Buffer | CborValue[] | Map<number | string, CborValue>

class CborError extends Error {}

interface Cursor {
  buf: Buffer
  pos: number
}

/** One initial byte plus its argument. Refuses indefinite lengths and the reserved values. */
function readHead(c: Cursor): { major: number; info: number; value: number } {
  if (c.pos >= c.buf.length) throw new CborError('truncated')
  const initial = c.buf[c.pos++]!
  const major = initial >> 5
  const info = initial & 31
  if (info < 24) return { major, info, value: info }
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
  if (!width) throw new CborError('indefinite or reserved length')
  if (c.pos + width > c.buf.length) throw new CborError('truncated')
  let value: number
  if (width === 8) {
    const big = c.buf.readBigUInt64BE(c.pos)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('integer too large')
    value = Number(big)
  } else {
    value = c.buf.readUIntBE(c.pos, width)
  }
  c.pos += width
  return { major, info, value }
}

function take(c: Cursor, length: number): Buffer {
  if (length > c.buf.length - c.pos) throw new CborError('truncated')
  const out = Buffer.from(c.buf.subarray(c.pos, c.pos + length))
  c.pos += length
  return out
}

function readItem(c: Cursor, depth: number): CborValue {
  if (depth > CBOR_MAX_DEPTH) throw new CborError('too deep')
  const { major, info, value } = readHead(c)
  switch (major) {
    case 0:
      return value
    case 1:
      return -1 - value
    case 2:
      return take(c, value)
    case 3:
      return take(c, value).toString('utf8')
    case 4: {
      if (value > CBOR_MAX_ITEMS) throw new CborError('array too long')
      const out: CborValue[] = []
      for (let i = 0; i < value; i++) out.push(readItem(c, depth + 1))
      return out
    }
    case 5: {
      if (value > CBOR_MAX_ITEMS) throw new CborError('map too long')
      const out = new Map<number | string, CborValue>()
      for (let i = 0; i < value; i++) {
        const key = readItem(c, depth + 1)
        if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('map key is not a number or text')
        if (out.has(key)) throw new CborError('duplicate map key')
        out.set(key, readItem(c, depth + 1))
      }
      return out
    }
    case 7:
      // Simple values only, and only the four that exist. A float (info 25–27)
      // lands here with an argument already read, and is refused like a tag.
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 23) return undefined
      throw new CborError('float or unknown simple value')
    default:
      // 6: tags. Nothing in a WebAuthn attestation or a COSE key is tagged.
      throw new CborError('tagged item')
  }
}

/**
 * Decode one CBOR item starting at `offset`, and say where it ended.
 *
 * Null for anything malformed or outside the subset described above. The end
 * offset matters because a COSE key sits in the middle of authenticator data
 * with (optionally) extensions after it, and nothing says how long it is but
 * the key itself.
 */
export function decodeCbor(buf: Buffer, offset = 0): { value: CborValue; end: number } | null {
  const c: Cursor = { buf, pos: offset }
  try {
    const value = readItem(c, 0)
    return { value, end: c.pos }
  } catch {
    return null
  }
}

/* ------------------------------------------------------ authenticator data */

export interface AuthenticatorData {
  rpIdHash: Buffer
  flags: number
  signCount: number
  /** Present only when the AT flag is set — i.e. on a registration. */
  credential?: { id: Buffer; publicKey: CborValue }
}

/**
 * Split authenticator data into its parts. Null when it does not parse, or
 * when anything is left over after the last part: trailing bytes are not in
 * the format, so a structure carrying them is not one this desktop signed off
 * on reading.
 */
export function parseAuthenticatorData(buf: Buffer): AuthenticatorData | null {
  if (buf.length < 37) return null
  const rpIdHash = Buffer.from(buf.subarray(0, 32))
  const flags = buf[32]!
  const signCount = buf.readUInt32BE(33)
  let pos = 37
  let credential: AuthenticatorData['credential']
  if (flags & FLAG_AT) {
    // aaguid (16) + credential id length (2)
    if (buf.length < pos + 18) return null
    pos += 16
    const idLength = buf.readUInt16BE(pos)
    pos += 2
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || buf.length < pos + idLength) return null
    const id = Buffer.from(buf.subarray(pos, pos + idLength))
    pos += idLength
    const key = decodeCbor(buf, pos)
    if (!key) return null
    pos = key.end
    credential = { id, publicKey: key.value }
  }
  if (flags & FLAG_ED) {
    const extensions = decodeCbor(buf, pos)
    if (!extensions) return null
    pos = extensions.end
  }
  if (pos !== buf.length) return null
  return { rpIdHash, flags, signCount, ...(credential ? { credential } : {}) }
}

/* ------------------------------------------------------------------ COSE keys */

/**
 * A COSE public key as a node KeyObject, for exactly the two algorithms this
 * desktop asked for. Anything else — another curve, another algorithm, an RSA
 * modulus under 2048 bits, an RSA exponent that is even or below 3, a point
 * that is not on P-256 — is null.
 *
 * Through JWK because that is the one import node:crypto offers for a raw
 * curve point or a raw modulus, and it validates the point on the way in.
 */
export function coseToKey(cose: CborValue): { alg: number; key: KeyObject } | null {
  if (!(cose instanceof Map)) return null
  const kty = cose.get(1)
  const alg = cose.get(3)
  try {
    if (alg === COSE_ES256 && kty === 2) {
      const crv = cose.get(-1)
      const x = cose.get(-2)
      const y = cose.get(-3)
      if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) return null
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') },
        format: 'jwk'
      })
      return { alg, key }
    }
    if (alg === COSE_RS256 && kty === 3) {
      const n = cose.get(-1)
      const e = cose.get(-2)
      if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length > 1024 || e.length === 0 || e.length > 8) return null
      // Counted in bits, not bytes, so a short modulus padded with leading
      // zeros to 256 bytes is still a short modulus.
      const start = n.findIndex((byte) => byte !== 0)
      if (start < 0) return null
      const modulus = n.subarray(start)
      const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]!))
      if (bits < 2048) return null
      // An odd exponent of at least 3: e = 1 makes every "signature" its own
      // message, and an even e is not an RSA key at all.
      const exponent = BigInt(`0x${e.toString('hex')}`)
      if (exponent < 3n || exponent % 2n === 0n) return null
      const key = createPublicKey({
        key: { kty: 'RSA', n: modulus.toString('base64url'), e: e.toString('base64url') },
        format: 'jwk'
      })
      return { alg, key }
    }
  } catch {
    return null
  }
  return null
}

/* --------------------------------------------------------------- clientData */

export interface ClientData {
  type: string
  challenge: string
  origin: string
  crossOrigin: boolean
  /** The exact bytes the browser sent, which is what gets hashed. */
  bytes: Buffer
}

/** Parse `clientDataJSON` (base64url). Null when it is not the shape a browser sends. */
export function readClientData(b64: string): ClientData | null {
  const bytes = fromB64url(b64, 4096)
  if (!bytes) return null
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.challenge !== 'string' || typeof record.origin !== 'string') {
    return null
  }
  return {
    type: record.type,
    // Browsers send the challenge base64url with no padding. Stripped anyway,
    // so a padded one still names the same challenge.
    challenge: record.challenge.replace(/=+$/, ''),
    origin: record.origin,
    crossOrigin: record.crossOrigin === true,
    bytes
  }
}

/**
 * The RP ID for a page: its origin's hostname. Passkeys are scoped to it, so a
 * page on `forge-web.web.app` and one on `forge-web.firebaseapp.com` hold
 * different passkeys — which is WebAuthn's rule, not this desktop's.
 */
export function rpIdFor(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.hostname
  } catch {
    return ''
  }
}

/* --------------------------------------------------------------- challenges */

export type ChallengePurpose = 'create' | 'get' | 'fresh'

export interface PendingChallenge {
  uid: string
  purpose: ChallengePurpose
  origin: string
  rpId: string
  expiresAt: number
}

/** What spending a challenge found. See `PasskeyChallenges.take`. */
export type ChallengeTake = { ok: true; entry: PendingChallenge } | { ok: false; stale: boolean; why: string }

/**
 * Challenges this desktop has handed out and not yet seen answered.
 *
 * Kept here rather than on a socket because the answer to a `hello`'s
 * challenge arrives on the *next* socket — a refused `hello` hangs up. A
 * challenge is bound to the account, the purpose and the page origin it was
 * issued to, expires in PASSKEY_CHALLENGE_MS, and is deleted the moment
 * anything presents it, right or wrong, so no challenge is ever answered twice.
 */
export class PasskeyChallenges {
  private pending = new Map<string, PendingChallenge>()

  constructor(private readonly now: () => number) {}

  issue(uid: string, purpose: ChallengePurpose, origin: string, rpId: string): string {
    // Expired ones first, so a cap below only ever costs a live challenge
    // when there are genuinely too many live ones.
    this.prune()
    const challenge = randomBytes(CHALLENGE_BYTES).toString('base64url')
    this.pending.set(challenge, { uid, purpose, origin, rpId, expiresAt: this.now() + PASSKEY_CHALLENGE_MS })
    // Oldest first, and Map keeps insertion order: dropping from the front
    // can only cost a phone its biometric prompt, never let anybody in. Per
    // account and purpose first, so one kind of ceremony cannot crowd out
    // another; the global cap is only the backstop.
    const same = [...this.pending].filter(([, entry]) => entry.uid === uid && entry.purpose === purpose)
    for (let i = 0; i < same.length - MAX_PENDING_PER_PURPOSE; i++) this.pending.delete(same[i]![0])
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    return challenge
  }

  /**
   * Spend a challenge. Always spent, whatever the answer.
   *
   * A refusal says whether the challenge was merely *stale* — unknown (never
   * issued, already spent, or evicted) or expired — or *foreign*: pending, but
   * issued to another account or for another purpose. The caller treats the
   * two differently; see "Failures are wrong PINs" at the top of this file.
   */
  take(challenge: string, uid: string, purpose: ChallengePurpose): ChallengeTake {
    const entry = this.pending.get(challenge)
    if (!entry) return { ok: false, stale: true, why: 'unknown, evicted or already-used challenge' }
    this.pending.delete(challenge)
    if (this.now() >= entry.expiresAt) return { ok: false, stale: true, why: 'expired challenge' }
    if (entry.uid !== uid || entry.purpose !== purpose) {
      return { ok: false, stale: false, why: `challenge was issued for another account or for ${entry.purpose}, not ${purpose}` }
    }
    return { ok: true, entry }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.pending) if (now >= entry.expiresAt) this.pending.delete(key)
  }
}

/* --------------------------------------------------------------------- store */

/** One enrolled passkey, as written to disk. Nothing here is secret. */
export interface StoredPasskey {
  /** base64url. */
  credentialId: string
  /** COSE algorithm: COSE_ES256 or COSE_RS256. */
  alg: number
  /** SPKI DER, base64url. */
  publicKey: string
  signCount: number
  /** What the enrolling browser called itself. Display text only. */
  deviceName: string
  createdAt: number
  lastUsedAt: number
}

/**
 * Where the store's bytes live. Injected so a check script can point it at a
 * scratch folder; the desktop points it at `web-passkeys.json` in its data
 * directory (see electron/web-host.ts).
 */
export interface PasskeyStorage {
  /** The file's text, or '' when there is none or it cannot be read. */
  read: () => string
  write: (text: string) => void
}

/** A PasskeyStorage on one file, written temp-then-rename like electron/web/push.ts. */
export function filePasskeyStorage(path: string): PasskeyStorage {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    },
    write: (text) => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const temp = `${path}.tmp`
        writeFileSync(temp, text, 'utf8')
        renameSync(temp, path)
      } catch (err) {
        console.warn(`[web] could not save passkeys: ${String(err)}`)
      }
    }
  }
}

interface PasskeyFile {
  version: 1
  /** Digest of the `webPin` string these passkeys were enrolled under. See `pinDigest`. */
  pinDigest: string
  /** uid → its passkeys. */
  accounts: Record<string, StoredPasskey[]>
}

/**
 * A one-way name for the stored PIN hash, so the store can tell whether the
 * PIN has changed since it was written without holding a copy of the hash.
 */
export function pinDigest(pinHash: string): string {
  return sha256(`forge-web-passkey-pin\0${pinHash}`).toString('base64url')
}

/**
 * The stable, opaque WebAuthn `user.id` for an account: a hash of the uid, never
 * the email. Stable so a phone that enrols again replaces its old passkey for
 * this desktop rather than piling up a second one.
 */
export function passkeyUserId(uid: string): string {
  return sha256(`forge-web-passkey-user\0${uid}`).toString('base64url')
}

function readStoredPasskey(raw: unknown): StoredPasskey | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  if (typeof r.credentialId !== 'string' || !r.credentialId || !B64URL.test(r.credentialId)) return null
  if (r.alg !== COSE_ES256 && r.alg !== COSE_RS256) return null
  if (typeof r.publicKey !== 'string' || !r.publicKey || !B64URL.test(r.publicKey)) return null
  const signCount = num(r.signCount)
  const createdAt = num(r.createdAt)
  const lastUsedAt = num(r.lastUsedAt)
  if (signCount === null || createdAt === null || lastUsedAt === null) return null
  return {
    credentialId: r.credentialId,
    alg: r.alg,
    publicKey: r.publicKey,
    signCount,
    deviceName: typeof r.deviceName === 'string' ? r.deviceName.slice(0, 64) : 'Browser',
    createdAt,
    lastUsedAt
  }
}

/**
 * The enrolled passkeys, keyed by account, voided by a PIN change.
 *
 * **The PIN rule is enforced on every read.** The file carries the digest of
 * the `webPin` it was written under; a read under any other `webPin` — a new
 * PIN, or none — treats the store as empty and wipes the file, so the next
 * look at it from anywhere finds nothing either. That is lazy on purpose: it
 * needs no hook in the settings path, and there is no window in which an old
 * passkey can be *used*, because using one is a read.
 *
 * Read from storage each time rather than cached: it is read a few times per
 * sign-in, and a cache is one more thing to be stale about the PIN.
 */
export class PasskeyStore {
  constructor(private readonly storage: PasskeyStorage) {}

  private load(pinHash: string): PasskeyFile {
    const digest = pinDigest(pinHash)
    const empty: PasskeyFile = { version: 1, pinDigest: digest, accounts: {} }
    const text = this.storage.read()
    if (!text) return empty
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return empty
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
    const file = raw as Record<string, unknown>
    const accountsRaw = file.accounts
    const hasAny =
      !!accountsRaw &&
      typeof accountsRaw === 'object' &&
      Object.values(accountsRaw as Record<string, unknown>).some((list) => Array.isArray(list) && list.length > 0)
    if (file.version !== 1 || file.pinDigest !== digest || !pinHash) {
      // Enrolled under another PIN, or the PIN is gone. Void, and say so once.
      if (hasAny) {
        this.storage.write(JSON.stringify(empty, null, 2))
        console.log('[web] the unlock PIN changed, so every passkey enrolled under the old one was forgotten')
      }
      return empty
    }
    const accounts: Record<string, StoredPasskey[]> = {}
    if (accountsRaw && typeof accountsRaw === 'object' && !Array.isArray(accountsRaw)) {
      for (const [uid, list] of Object.entries(accountsRaw as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue
        const kept = list.map(readStoredPasskey).filter((p): p is StoredPasskey => p !== null)
        if (kept.length) accounts[uid] = kept.slice(0, MAX_PASSKEYS_PER_ACCOUNT)
      }
    }
    return { version: 1, pinDigest: digest, accounts }
  }

  private save(file: PasskeyFile): void {
    this.storage.write(JSON.stringify(file, null, 2))
  }

  list(uid: string, pinHash: string): StoredPasskey[] {
    if (!pinHash) {
      this.load(pinHash) // wipes, when there is anything to wipe
      return []
    }
    return this.load(pinHash).accounts[uid] ?? []
  }

  /** Add one. False when the PIN is unset, the id is already enrolled, or the account is full. */
  add(uid: string, pinHash: string, passkey: StoredPasskey): boolean {
    if (!pinHash) return false
    const file = this.load(pinHash)
    const list = file.accounts[uid] ?? []
    if (list.some((p) => p.credentialId === passkey.credentialId)) return false
    if (list.length >= MAX_PASSKEYS_PER_ACCOUNT) return false
    file.accounts[uid] = [...list, passkey]
    this.save(file)
    return true
  }

  /** Forget one. True when it was there. */
  remove(uid: string, pinHash: string, credentialId: string): boolean {
    if (!pinHash) return false
    const file = this.load(pinHash)
    const list = file.accounts[uid] ?? []
    const kept = list.filter((p) => p.credentialId !== credentialId)
    if (kept.length === list.length) return false
    if (kept.length) file.accounts[uid] = kept
    else delete file.accounts[uid]
    this.save(file)
    return true
  }

  /** Record a successful use: the new counter and when. */
  touch(uid: string, pinHash: string, credentialId: string, signCount: number, at: number): void {
    if (!pinHash) return
    const file = this.load(pinHash)
    const hit = file.accounts[uid]?.find((p) => p.credentialId === credentialId)
    if (!hit) return
    hit.signCount = signCount
    hit.lastUsedAt = at
    this.save(file)
  }
}

/** The wire view of a stored passkey: no key material, just what a list row shows. */
export function passkeyInfo(p: StoredPasskey): WebPasskeyInfo {
  return {
    credentialId: p.credentialId,
    deviceName: p.deviceName,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt
  }
}

/* ------------------------------------------------------------------- options */

export function creationOptions(
  challenge: string,
  rpId: string,
  uid: string,
  exclude: StoredPasskey[]
): WebPasskeyCreationOptions {
  return {
    challenge,
    rp: { name: 'Forge', id: rpId },
    user: { id: passkeyUserId(uid), name: 'Forge Web', displayName: 'Forge Web unlock' },
    pubKeyCredParams: [
      { type: 'public-key', alg: COSE_ES256 },
      { type: 'public-key', alg: COSE_RS256 }
    ],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    attestation: 'none',
    excludeCredentials: exclude.map((p) => ({ type: 'public-key', id: p.credentialId })),
    timeout: PASSKEY_CHALLENGE_MS
  }
}

export function requestOptions(challenge: string, rpId: string, allow: StoredPasskey[]): WebPasskeyRequestOptions {
  return {
    challenge,
    rpId,
    allowCredentials: allow.map((p) => ({ type: 'public-key', id: p.credentialId })),
    userVerification: 'required',
    timeout: PASSKEY_CHALLENGE_MS
  }
}

/* -------------------------------------------------------------- the wire */

/**
 * A passkey assertion off the wire, or null. Every field is a bounded
 * base64url string; the bytes are only decoded by the verifier.
 */
export function readPasskeyAssertion(value: unknown): WebPasskeyAssertion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const field = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null
    const text = v.trim().replace(/=+$/, '')
    return text && text.length <= max && B64URL.test(text) ? text : null
  }
  const credentialId = field(r.credentialId, 1400)
  const authenticatorData = field(r.authenticatorData, 4096)
  const clientDataJSON = field(r.clientDataJSON, 4096)
  const signature = field(r.signature, 1400)
  if (!credentialId || !authenticatorData || !clientDataJSON || !signature) return null
  const userHandle = r.userHandle === undefined || r.userHandle === null || r.userHandle === '' ? undefined : field(r.userHandle, 128)
  if (userHandle === null) return null
  return { credentialId, authenticatorData, clientDataJSON, signature, ...(userHandle ? { userHandle } : {}) }
}

/* ---------------------------------------------------------------- ceremonies */

export type Verdict<T> = ({ ok: true } & T) | { ok: false; why: string }

/**
 * Check a registration against a challenge already spent by the caller.
 *
 * `origin` is the socket's `Origin` header and `rpId` its hostname — the page
 * that asked is the page whose passkey this becomes. The attestation
 * statement is not read: this desktop asked for `attestation: 'none'`, and
 * what it trusts is the account and PIN that opened the socket, not a
 * manufacturer's certificate.
 */
export function verifyRegistration(input: {
  clientData: ClientData
  attestationObject: string
  origin: string
  rpId: string
}): Verdict<{ credentialId: string; alg: number; publicKey: string; signCount: number }> {
  const { clientData, origin, rpId } = input
  if (clientData.type !== 'webauthn.create') return { ok: false, why: 'clientData type is not webauthn.create' }
  if (clientData.origin !== origin) return { ok: false, why: `clientData origin ${forLog(clientData.origin)} is not ${origin}` }
  if (clientData.crossOrigin) return { ok: false, why: 'cross-origin ceremony' }
  const bytes = fromB64url(input.attestationObject, 16_384)
  if (!bytes) return { ok: false, why: 'attestationObject is not base64url' }
  const decoded = decodeCbor(bytes)
  if (!decoded || decoded.end !== bytes.length || !(decoded.value instanceof Map)) {
    return { ok: false, why: 'attestationObject is not a CBOR map' }
  }
  const authDataBytes = decoded.value.get('authData')
  if (!Buffer.isBuffer(authDataBytes)) return { ok: false, why: 'attestationObject has no authData' }
  const authData = parseAuthenticatorData(authDataBytes)
  if (!authData) return { ok: false, why: 'authData does not parse' }
  if (!sameBytes(authData.rpIdHash, sha256(rpId))) return { ok: false, why: 'rpIdHash is not this page' }
  if (!(authData.flags & FLAG_UP)) return { ok: false, why: 'user presence flag missing' }
  if (!(authData.flags & FLAG_UV)) return { ok: false, why: 'user verification flag missing' }
  if (!authData.credential) return { ok: false, why: 'no attested credential' }
  const key = coseToKey(authData.credential.publicKey)
  if (!key) return { ok: false, why: 'credential public key is not ES256 or RS256' }
  return {
    ok: true,
    credentialId: authData.credential.id.toString('base64url'),
    alg: key.alg,
    publicKey: key.key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    signCount: authData.signCount
  }
}

/**
 * Check an assertion against a stored passkey and a challenge already spent by
 * the caller. The signature is over `authenticatorData || sha256(clientDataJSON)`;
 * ES256 signatures arrive DER-encoded, which is node's default for EC keys.
 */
export function verifyAssertion(input: {
  assertion: WebPasskeyAssertion
  clientData: ClientData
  stored: StoredPasskey
  origin: string
  rpId: string
  userId: string
  /**
   * Skip the counter check. Only for an assertion over a stale challenge,
   * which is never admitted and never recorded: a phone retrying the answer
   * whose `hello-ok` it lost presents a counter already written down, and
   * that is a retry, not a clone.
   */
  ignoreCounter?: boolean
}): Verdict<{ signCount: number }> {
  const { assertion, clientData, stored, origin, rpId } = input
  if (clientData.type !== 'webauthn.get') return { ok: false, why: 'clientData type is not webauthn.get' }
  if (clientData.origin !== origin) return { ok: false, why: `clientData origin ${forLog(clientData.origin)} is not ${origin}` }
  if (clientData.crossOrigin) return { ok: false, why: 'cross-origin ceremony' }
  if (assertion.userHandle && assertion.userHandle !== input.userId) return { ok: false, why: 'userHandle is not this account' }
  const authDataBytes = fromB64url(assertion.authenticatorData, 4096)
  if (!authDataBytes) return { ok: false, why: 'authenticatorData is not base64url' }
  const authData = parseAuthenticatorData(authDataBytes)
  if (!authData) return { ok: false, why: 'authenticatorData does not parse' }
  if (!sameBytes(authData.rpIdHash, sha256(rpId))) return { ok: false, why: 'rpIdHash is not this page' }
  if (!(authData.flags & FLAG_UP)) return { ok: false, why: 'user presence flag missing' }
  if (!(authData.flags & FLAG_UV)) return { ok: false, why: 'user verification flag missing' }
  const signature = fromB64url(assertion.signature, 1400)
  if (!signature) return { ok: false, why: 'signature is not base64url' }
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' })
  } catch {
    return { ok: false, why: 'stored public key is unreadable' }
  }
  const signed = Buffer.concat([authDataBytes, sha256(clientData.bytes)])
  let good = false
  try {
    good =
      stored.alg === COSE_ES256
        ? verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, signature)
        : verifySignature('sha256', signed, key, signature)
  } catch {
    good = false
  }
  if (!good) return { ok: false, why: 'signature does not verify' }
  // A counter of zero on both sides is an authenticator that does not count
  // (most synced passkeys). Otherwise it must move forward: one that goes
  // backwards or stands still is the signature of a cloned key.
  if (!input.ignoreCounter && (authData.signCount !== 0 || stored.signCount !== 0) && authData.signCount <= stored.signCount) {
    return { ok: false, why: `signCount ${authData.signCount} did not advance past ${stored.signCount}` }
  }
  return { ok: true, signCount: authData.signCount }
}

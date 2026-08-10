import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { TOTP_DIGITS, TOTP_DRIFT_STEPS, TOTP_STEP_MS } from '@shared/web'

/**
 * The second factor, as arithmetic — RFC 6238 over RFC 4226, in `node:crypto`.
 *
 * ## Why this is not a dependency
 *
 * TOTP is HMAC-SHA1 of a counter, four bytes of the digest chosen by its own
 * last nibble, modulo a million. That is the whole algorithm, and it is written
 * out below in about thirty lines. A package to do it would be a third-party
 * update path into the file that decides whether somebody gets a shell, bought
 * for thirty lines of arithmetic that has not changed since 2011.
 *
 * SHA-1 is the algorithm, and that is correct rather than a compromise: HOTP
 * uses HMAC-SHA1, every authenticator app assumes it, and HMAC-SHA1 is not
 * affected by the collision attacks that retired bare SHA-1. An app that
 * offered SHA-256 here would be an app whose QR most phones cannot read.
 *
 * ## What lives here and what does not
 *
 * Arithmetic and encodings only. Nothing in this file knows what a device is,
 * whether a code has been spent, or where a secret is stored — those are
 * decisions with state behind them and they live in `electron/web/auth.ts`
 * (spending, drift, trust) and `electron/web/secret-box.ts` (at rest). This
 * file is total and side-effect-free apart from `randomBytes`, which is what
 * lets the check script drive every branch of it with fixed inputs.
 *
 * Electron-free and dependency-free, so `scripts/web-auth-check.mjs` bundles it
 * alongside the class that uses it.
 */

/* ------------------------------------------------------------------ base32 */

/**
 * RFC 4648's alphabet, which is the one `otpauth://` URIs are written in and
 * the one every authenticator app decodes. Not base64, not hex: what goes on
 * screen next to the QR has to be typeable by somebody reading it aloud, and
 * this alphabet has no `0`/`O` and no `1`/`I` to mistake for each other.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Bytes of entropy in a TOTP secret. 20 = 160 bits, RFC 4226's recommendation. */
const SECRET_BYTES = 20

function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/**
 * Base32 back to bytes, or null when the text is not base32.
 *
 * Total, because what reaches it is a string out of settings.json that has been
 * through a seal and an unseal: a secret that came back mangled must be a
 * refusal with a sentence, not an exception halfway through a `hello`. Spaces
 * and padding are tolerated — a person typing a secret off a screen into a
 * phone puts spaces in it, and a person pasting one back gets the `=` too.
 */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/* -------------------------------------------------------------- the secret */

/** A fresh shared secret, base32, for a QR and for a human to read aloud. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES))
}

/**
 * The `otpauth://` URI an authenticator app expects behind a QR.
 *
 * Every parameter is spelled out rather than left to the app's defaults, and
 * that is worth the bytes: the defaults are only conventions, and an app that
 * assumed eight digits or a sixty-second step would produce codes this desktop
 * refuses forever with no way to tell why.
 *
 * `account` is the email this desktop is signed in as, so somebody with three
 * Forge entries in their authenticator can tell them apart. It is encoded, not
 * trusted: it ends up in a URI that goes into a QR.
 */
export function totpUri(secret: string, account: string, issuer = 'Forge Web'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account || 'desktop')}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_MS / 1000)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/* --------------------------------------------------------------- the codes */

/** Which 30-second step a moment falls in. The counter HOTP is computed over. */
export function totpCounter(now: number): number {
  return Math.floor(now / TOTP_STEP_MS)
}

/**
 * One code, for one counter. RFC 4226 §5.3, with RFC 6238's time counter.
 *
 * The dynamic truncation is the fiddly half and the reason it is written out:
 * the low nibble of the last byte picks a four-byte window into the digest, the
 * top bit of that window is masked off (so the result is positive on platforms
 * where it would otherwise be read as signed), and what is left is taken modulo
 * ten to the digits.
 */
export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret)
  if (!key || key.length === 0) return ''
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * Does this code belong to this secret, right now? Returns the counter it
 * matched — which the caller must remember, or the drift window below becomes
 * three chances at the same six digits — or null.
 *
 * TOTP_DRIFT_STEPS either side, so a code read off a phone and typed a few
 * seconds later still lands. Every candidate is compared in constant time and
 * *all* of them are compared even after one matches: an early return would make
 * "the code was one step early" measurable from the outside, which is a slow
 * leak of what the clock on the far end says.
 */
export function checkTotp(secret: string, code: string, now: number): number | null {
  const presented = code.trim()
  if (!/^\d+$/.test(presented) || presented.length !== TOTP_DIGITS) return null
  const centre = totpCounter(now)
  let matched: number | null = null
  for (let step = -TOTP_DRIFT_STEPS; step <= TOTP_DRIFT_STEPS; step++) {
    const counter = centre + step
    if (counter < 0) continue
    if (sameCode(totpCode(secret, counter), presented) && matched === null) matched = counter
  }
  return matched
}

/**
 * Constant-time compare of two codes.
 *
 * Six digits is a million possibilities and this door has a lockout in front of
 * it, so the timing channel is not the thing that would break first — but a
 * file that starts making exceptions to "compare secrets in constant time" is a
 * file that eventually makes the wrong one. Same reasoning as `sameString` in
 * electron/web/auth.ts.
 */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

/* ----------------------------------------------------------- recovery codes */

/**
 * Ten codes, minted with the secret and shown once.
 *
 * The one thing standing between a lost phone and a desktop nobody can reach
 * from anywhere. Grouped in two blocks of four with a dash because these are
 * copied by hand into a password manager or onto paper, and an unbroken run of
 * eight characters is where transcription errors live.
 *
 * The alphabet is base32's, for the reason it is base32 above: no character
 * here can be confused with another when it is read aloud or written down.
 */
export const RECOVERY_CODE_COUNT = 10

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(randomBytes(5)).slice(0, 8).toLowerCase()
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`)
  }
  return codes
}

/**
 * What a person typed, as the thing that gets hashed.
 *
 * Dashes, spaces and case are all noise: somebody reading a code off paper puts
 * the dash where they think it goes, and a code refused for a formatting reason
 * is a code that looks like it does not work.
 */
export function normaliseRecoveryCode(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * SHA-256 of a normalised recovery code — the only form that reaches disk.
 *
 * Deliberately the same one-way image `electron/mobile/auth.ts` writes for a
 * device token, and for the same reason its header gives: nothing written to
 * settings.json may be usable as a credential. `scripts/web-auth-check.mjs`
 * reads the written file back and fails if a raw code appears in it.
 */
export function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(raw), 'utf8').digest('hex')
}

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '@shared/web'

/**
 * The unlock PIN for Forge Web — set once at this desk, asked for by every
 * browser.
 *
 * ## Be honest about what this buys
 *
 * A four-digit PIN has ten thousand possibilities and a twelve-digit one has a
 * trillion; scrypt at the parameters below takes a fraction of a second per
 * guess on this machine and rather less on a graphics card. So **hashing this
 * is not protection against somebody who has the hash and time**. Anyone who
 * can read settings.json can brute-force a short PIN offline, and no choice of
 * parameters here changes that arithmetic — the entropy is in the secret, and
 * four digits do not have any.
 *
 * What the hash actually defends is the *read*: settings.json is the file that
 * gets backed up, screenshotted, pasted into an issue and read back by check
 * scripts, and a PIN sitting in it in the clear is a PIN somebody learns by
 * glancing at a screen. Storing a one-way image of it means a copy of the file
 * is not a copy of the PIN — the same rule electron/mobile/auth.ts states for
 * device tokens, and the same one electron/web/auth.ts's header restates.
 *
 * The defence against *guessing* is not here at all. It is the per-source
 * lockout in electron/web/auth.ts — AUTH_MAX_FAILURES wrong answers and that
 * address is refused for AUTH_LOCKOUT_MS — which turns ten thousand guesses
 * into weeks of them. And the whole door is behind a Firebase ID token verified
 * against Google's keys for one configured uid, so the PIN is a second factor
 * rather than a password: something to hold as well as the account, not
 * something to hold instead of it.
 *
 * Dependency-free (`node:crypto` only), for the same reason
 * electron/web/auth.ts is: `scripts/web-auth-check.mjs` bundles this exact
 * module with esbuild and drives it, so the thing that is tested is the thing
 * that ships.
 *
 * Every function here is total. What arrives is a string off the wire or a
 * string off a disk that a human may have edited, and neither is a reason to
 * throw in the middle of a `hello`.
 */

/**
 * The stored form: `scrypt$1$<salt>$<hash>`, both base64url.
 *
 * The `1` versions the parameters rather than the format. scrypt's cost is a
 * choice that ages — what is comfortable on this desktop today is cheap in five
 * years — so the day those numbers move, a stored `1` still says which numbers
 * verified the PIN somebody set under them, and a `2` can be written beside it
 * without either being mistaken for the other.
 */
const SCHEME = 'scrypt'
const VERSION = '1'

/**
 * scrypt's cost, r and p, and the length of what comes out.
 *
 * N=16384 is the reference "interactive" cost: about 16MB of memory
 * (128·N·r) and a fraction of a second here, which is the right side of the
 * trade for something typed once per browser connection rather than per
 * keystroke. Comfortably inside node's 32MB default `maxmem`, so this cannot
 * throw for want of a limit nobody set.
 */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 32
/** 16 bytes, so two desktops with the same PIN do not hold the same hash. */
const SALT_BYTES = 16

/**
 * Is this something a person may set as a PIN?
 *
 * Digits only, and between PIN_MIN_DIGITS and PIN_MAX_DIGITS of them. The
 * shape is the protocol's — shared/web.ts names both numbers, because the
 * browser draws the box this has to fit in — and it is checked here rather than
 * only in the settings panel, since a renderer is not the thing that decides
 * what opens this door.
 */
export function isValidPin(pin: unknown): boolean {
  if (typeof pin !== 'string') return false
  return new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`).test(pin)
}

/**
 * Hash a PIN for storage. Returns '' for anything that is not a valid PIN,
 * rather than hashing junk into a string that would look like a set PIN.
 */
export function hashPin(pin: string): string {
  if (!isValidPin(pin)) return ''
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(pin, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${SCHEME}$${VERSION}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/**
 * Does `pin` open `stored`?
 *
 * False for every kind of nonsense — a blank stored value, a scheme this build
 * does not know, a salt that is not base64url, a PIN that is not one — and
 * never an exception, because both arguments arrive from somewhere a person
 * could have got wrong: one off a socket, one off a settings.json that may have
 * been hand-edited or restored from a backup.
 *
 * The comparison is `timingSafeEqual` over the derived keys. A PIN is short
 * enough that timing is not the weak link, and that is exactly why the rule is
 * kept: a file that starts making case-by-case exceptions to "compare secrets
 * in constant time" is a file that eventually makes the wrong one.
 */
export function verifyPin(pin: string, stored: string): boolean {
  if (typeof stored !== 'string' || typeof pin !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const [scheme, version, saltText, hashText] = parts as [string, string, string, string]
  if (scheme !== SCHEME || version !== VERSION) return false
  if (!/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(hashText)) return false
  if (!isValidPin(pin)) return false
  try {
    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(hashText, 'base64url')
    if (salt.length === 0 || expected.length !== KEY_BYTES) return false
    const actual = scryptSync(pin, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

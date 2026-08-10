import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * The one secret Forge Web has to be able to read back, kept out of the one
 * file everybody copies.
 *
 * ## What this is for, and what it is not
 *
 * A recovery code can be hashed, because it is only ever *checked*. A TOTP
 * secret cannot: verifying a code means computing one, which means holding the
 * secret. So it is encrypted, and the only question worth arguing about is
 * where the key goes.
 *
 * It goes in a file of its own — `web-totp.key`, beside settings.json rather
 * than in it. Be honest about what that buys and what it does not:
 *
 *  - **It buys the realistic case.** settings.json is the file that gets backed
 *    up, synced, screenshotted, pasted into an issue, and read straight off
 *    disk by `scripts/mobile-auth-check.mjs` and `scripts/web-auth-check.mjs`.
 *    A copy of it is now not a copy of the second factor.
 *  - **It does not buy the whole-machine case.** Somebody who can read this
 *    entire data directory has both halves. They also have Steve's session, his
 *    ngrok authtoken and a shell — so that was never the boundary this defends,
 *    and pretending otherwise would be the kind of security theatre this
 *    codebase writes comments to avoid.
 *
 * ## Why not Electron's safeStorage
 *
 * It would bind the ciphertext to the Windows account through DPAPI, which is
 * strictly better at rest — and it would make this file un-runnable outside
 * Electron, which would take the enrolment path out of reach of the head-less
 * check that proves settings.json holds no plaintext. This whole feature exists
 * because the door had a path only a human at the desk could open; adding a
 * second path only Electron can open is the same mistake in a smaller room.
 * AES-256-GCM from `node:crypto`, no dependency, exercised by the real check.
 */

/** `v1:<iv>:<ciphertext>:<tag>`, all base64url. Versioned so a later scheme can coexist. */
const PREFIX = 'v1'
/** GCM's standard nonce length. 96 bits is what the mode is specified for. */
const IV_BYTES = 12
const KEY_BYTES = 32
/** The file the key lives in, beside settings.json. */
export const KEY_FILE = 'web-totp.key'

/**
 * Read the sealing key, minting one on first use.
 *
 * `0600` where the platform honours it. Windows does not, and saying so is
 * better than a comment implying it does: on Windows the protection is that the
 * file is in the user's own roaming profile, which is exactly the protection
 * settings.json already has — the point of the separate file is that the two
 * are not copied together, not that one is in a vault.
 */
export function sealingKey(dataDir: string): Buffer {
  const path = join(dataDir, KEY_FILE)
  if (existsSync(path)) {
    const existing = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    if (existing.length === KEY_BYTES) return existing
    // A key file that is not a key can only mean a truncated write or a hand
    // edit. Refusing loudly beats minting a new one, which would silently make
    // every enrolled secret unopenable and read as "2FA stopped working".
    throw new Error(`${KEY_FILE} is not a 32-byte key — move it aside to start over`)
  }
  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key.toString('base64'), 'utf8')
  try {
    chmodSync(path, 0o600)
  } catch {
    /* see above: not every platform has anything to say about this */
  }
  return key
}

/** Seal a secret for settings.json. Never returns anything that resembles its input. */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(
    ':'
  )
}

/**
 * Open a sealed secret, or '' when it cannot be opened.
 *
 * Total on purpose. What reaches this is a string off disk: a settings.json
 * restored from a backup taken before the key was rotated, a hand edit, a
 * truncated write. Every one of those is "there is no usable second factor
 * here", which is a sentence the panel can show, and none of them is an
 * exception thrown in the middle of a `hello`.
 */
export function open(sealed: string, key: Buffer): string {
  const parts = String(sealed ?? '').split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) return ''
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'))
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

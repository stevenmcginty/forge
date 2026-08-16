/**
 * Secrets at rest in settings.json, encoded through the platform keychain —
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux — by way of
 * Electron's safeStorage.
 *
 * The shape on disk is a marker plus base64 of safeStorage.encryptString's
 * raw output:
 *
 *   enc:v1:<base64>
 *
 * The marker is what makes migration free rather than a pass: a value that
 * carries it is decrypted on read, and any other value is yesterday's
 * plaintext, read as-is and quietly re-encrypted on the next save. No rewrite
 * pass, no flag file, no moment where an interrupted upgrade loses a key.
 *
 * This module is Electron-free on purpose — it takes safeStorage as a
 * structurally-typed argument rather than importing it, so electron/store.ts
 * (exercised head-less by check scripts and Forge Web's server) can pull the
 * marker and the codec type from here without dragging `electron` in. The
 * live codec is wired in electron/main.ts next to setStoreHost; a host that
 * injects nothing gets PASS_THROUGH_CODEC, and a head-less run therefore
 * keeps writing plaintext — which is exactly what scripts that read
 * settings.json back off disk expect.
 */

/** What an encrypted value starts with. v1 so a future format can be v2 beside it. */
export const ENC_MARKER = 'enc:v1:'

export interface SecretsCodec {
  /**
   * A value fit for disk. Empty stays empty (nothing is set, nothing to hide),
   * and anything the platform refuses to encrypt is handed back as plaintext
   * rather than dropped — an unencryptable settings.json is worse than an
   * unencrypted one.
   */
  encrypt(plain: string): string
  /**
   * The plaintext behind a marked value, '' when it will not decode, and the
   * value itself when it carries no marker. '' is the codebase's existing
   * spelling of "unset", so a blob from another machine or a corrupt file
   * reads as a field nobody ever filled in.
   */
  decrypt(stored: string): string
}

/** The head-less answer: everything in, everything back, nothing on the wire. */
export const PASS_THROUGH_CODEC: SecretsCodec = {
  encrypt: (plain) => plain,
  decrypt: (stored) => stored
}

/**
 * safeStorage's own surface, restated so this file does not import Electron.
 * Electron's module satisfies it structurally today.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Wrap a live safeStorage in the codec. Failures degrade, never throw:
 *
 *  - encryption unavailable: plaintext in, plaintext out, one console line
 *    (once, not once per field per save) saying so.
 *  - encryptString throwing (Linux before app ready, keychain locked): the
 *    plaintext survives this save and gets another chance on the next one.
 *  - decryptString throwing (corrupt blob, different machine's DPAPI): ''
 *    for that field, one line per value, and the settings file still loads.
 */
export function makeSafeStorageCodec(safeStorage: SafeStorageLike): SecretsCodec {
  let warnedUnavailable = false
  return {
    encrypt(plain: string): string {
      if (!plain) return ''
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          if (!warnedUnavailable) {
            warnedUnavailable = true
            console.warn('[secretbox] platform encryption unavailable; secrets stay in plaintext settings.json')
          }
          return plain
        }
        return ENC_MARKER + safeStorage.encryptString(plain).toString('base64')
      } catch (err) {
        console.error('[secretbox] encrypt failed; storing plaintext this save:', err)
        return plain
      }
    },
    decrypt(stored: string): string {
      if (!stored.startsWith(ENC_MARKER)) return stored
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENC_MARKER.length), 'base64'))
      } catch (err) {
        console.error('[secretbox] decrypt failed; treating the field as unset:', err)
        return ''
      }
    }
  }
}

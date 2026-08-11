/**
 * What this browser calls itself when it asks to be let in.
 *
 * The id is per browser *profile*, not per machine, and shared/web.ts says why
 * that is correct: two profiles on one machine are two devices, because the
 * thing being named is a place a token is being used from.
 *
 * It is not a credential and it is not a key to anything. `WebHelloFrame` is
 * explicit that Forge Web mints no device token — the Firebase ID token is the
 * credential, and a second one beside it would be a second thing to steal — and
 * the desktop keeps no list of the browsers it has admitted, so the only thing
 * this id has to do is be there. It lives in `localStorage` beside the session,
 * and losing it costs nothing: the next connection mints another and is admitted
 * on exactly the same terms.
 */

const DEVICE_KEY = 'forge-web-device'

export function deviceId(): string {
  let existing: string | null = null
  try {
    existing = localStorage.getItem(DEVICE_KEY)
  } catch {
    // Private mode. A fresh id per tab means a fresh device row per tab,
    // which is untidy and correct — there is nowhere to remember an identity.
    return randomId()
  }
  if (existing) return existing
  const minted = randomId()
  try {
    localStorage.setItem(DEVICE_KEY, minted)
  } catch {
    /* see above */
  }
  return minted
}

/**
 * "Chrome on Windows" — untrusted display text the desktop puts in its log and
 * beside a live connection.
 *
 * Derived from the user agent rather than asked for, because a text box on the
 * sign-in screen is a text box nobody fills in honestly, and this string's only
 * job is to let a human at the desk recognise which of their own browsers is
 * knocking.
 */
export function deviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const platform = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return platform ? `${browser} on ${platform}` : browser
}

/**
 * Not `crypto.randomUUID()`: it is a secure-context API, and while this bundle
 * is served over https in production, `npm run web:dev` serves it over plain
 * http on a LAN address where the call is simply `undefined`. Same reasoning,
 * and the same fallback, as `randomId` in mobile/src/lib/link.ts — and it is
 * acceptable here for the same reason, which is that this value is a label
 * rather than a secret.
 */
function randomId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

/**
 * Where the device token lives on the phone.
 *
 * In the APK: `@capacitor/preferences`, i.e. Android SharedPreferences in the
 * app's private data dir. That is the promised upgrade over a browser tab —
 * no other app on a non-rooted device can read it, and clearing Chrome's
 * site data no longer un-pairs the phone. **It is not the Android Keystore**:
 * a rooted device or an `adb backup`-era extraction could still surface it,
 * which is why the desktop's one-tap revoke stays the real kill switch. The
 * seam is intact — every caller goes through the functions below, so moving
 * to a Keystore-backed plugin later is still a two-function change.
 *
 * Preferences' API is async but every caller (App.tsx render paths) wants an
 * answer *now*, so the values are hydrated once into module memory before
 * React mounts — main.tsx awaits `hydrate()` — and every write goes through
 * to disk as it happens. Skipping the hydrate gate would mean the first paint
 * sees an empty token and flashes the pairing form at an already-paired
 * phone; that is the failure mode the await exists to prevent.
 *
 * In a plain browser (the debug route, and the desktop-served page) there is
 * no Capacitor, so `localStorage` remains the backing store, same as before.
 *
 * The distinction that matters: `deviceId` in link.ts is a *name* and stays
 * in localStorage forever. The token is a *credential* and lives here.
 */

const TOKEN_KEY = 'forge.deviceToken'
const ORIGIN_KEY = 'forge.origin'
/**
 * The paired desktop's own name, as it said it in `hello-ok`.
 *
 * Not a credential and not stored like one — it is here rather than in
 * localStorage only so that it is forgotten by the same "forget this desktop"
 * that clears the token, and never survives it. Its one job is on the
 * television: after the laptop comes home on a different DHCP address, this is
 * what tells "some Forge answered the broadcast" apart from "the desktop this
 * television belongs to has moved".
 */
const DESKTOP_KEY = 'forge.desktopName'

const native = Capacitor.isNativePlatform()
let token = ''
let origin = ''
let desktop = ''

/**
 * Load both values into memory. Must complete before the first render;
 * see main.tsx. Safe to call again (it just re-reads).
 */
export async function hydrate(): Promise<void> {
  if (!native) {
    token = localStorage.getItem(TOKEN_KEY) ?? ''
    origin = localStorage.getItem(ORIGIN_KEY) ?? ''
    desktop = localStorage.getItem(DESKTOP_KEY) ?? ''
    return
  }
  token = (await Preferences.get({ key: TOKEN_KEY })).value ?? ''
  origin = (await Preferences.get({ key: ORIGIN_KEY })).value ?? ''
  desktop = (await Preferences.get({ key: DESKTOP_KEY })).value ?? ''
}

/** Fire-and-forget persistence: the in-memory value is already the truth for
 *  this run, and a failed disk write costs a re-pair after restart, not a
 *  broken session now. */
function persist(key: string, value: string): void {
  if (native) {
    void (value ? Preferences.set({ key, value }) : Preferences.remove({ key })).catch(() => {})
  } else if (value) {
    localStorage.setItem(key, value)
  } else {
    localStorage.removeItem(key)
  }
}

export function readToken(): string {
  return token
}

export function writeToken(next: string): void {
  token = next
  persist(TOKEN_KEY, next)
}

/**
 * Drop the credential, and the desktop it belonged to.
 *
 * The name goes with it deliberately: a remembered "this belongs to STEVE-PC"
 * outliving the token it was learned on would have a television homing in on a
 * desktop it can no longer open, and saying so on screen.
 */
export function forgetToken(): void {
  token = ''
  persist(TOKEN_KEY, '')
  desktop = ''
  persist(DESKTOP_KEY, '')
}

/** The paired desktop's own name, or '' if it never said. */
export function readDesktopName(): string {
  return desktop
}

export function writeDesktopName(next: string): void {
  desktop = next
  persist(DESKTOP_KEY, next)
}

/** The last desktop we reached, so the app reconnects without being asked. */
export function readOrigin(): string {
  return origin
}

export function writeOrigin(next: string): void {
  origin = next
  persist(ORIGIN_KEY, next)
}

/**
 * Normalise whatever was typed into a WebSocket origin.
 *
 * Accepts `192.168.1.5`, `192.168.1.5:8420`, `http://…`, `ws://…`, a full
 * `https://something.trycloudflare.com`, and a `forge://pair?host=…&port=…`
 * link — all six are things that plausibly arrive from a human, a QR scanner or
 * a deep link.
 *
 * The rule that matters, and the one that was wrong first time round: **a
 * secure URL with no explicit port keeps having no port.** A tunnel is reached
 * at `wss://<name>.trycloudflare.com` on the implicit 443; appending the LAN
 * default would produce `wss://<name>.trycloudflare.com:8420`, which nothing is
 * listening on and which fails with a connection error that looks like the
 * desktop being down rather than the address being wrong.
 *
 * A bare host with no scheme is treated as LAN — `ws://host:<defaultPort>` —
 * because that is what someone typing an IP off the Settings panel means.
 * Reaching a tunnel means pasting its full `https://` URL, which is what you
 * have in your hand anyway.
 */
export function toOrigin(input: string, defaultPort: number): string {
  const raw = input.trim()
  if (!raw) return ''

  if (raw.startsWith('forge://')) {
    try {
      const url = new URL(raw)
      const host = url.searchParams.get('host') ?? ''
      if (!host) return ''
      const port = url.searchParams.get('port') ?? ''
      // A pairing link that names no port is a tunnel link.
      if (!port) return /^(wss|https)/i.test(url.searchParams.get('scheme') ?? '') ? `wss://${host}` : `ws://${host}:${defaultPort}`
      return `ws://${host}:${port}`
    } catch {
      return ''
    }
  }

  const hasScheme = /^(wss?|https?):\/\//i.test(raw)
  const secure = /^(wss|https):\/\//i.test(raw)
  const withoutScheme = raw.replace(/^(wss?|https?):\/\//i, '')
  const [host, port] = splitHostPort(withoutScheme.replace(/\/.*$/, ''))
  if (!host) return ''

  if (secure) return port ? `wss://${host}:${port}` : `wss://${host}`
  // Plain `ws://` or `http://` with an explicit port is honoured as typed; a
  // bare host falls back to the LAN default.
  if (hasScheme && port) return `ws://${host}:${port}`
  return `ws://${host}:${port || defaultPort}`
}

/** Splits `host:port`, leaving a bracketed IPv6 literal intact. */
function splitHostPort(value: string): [string, string] {
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) return [value, '']
    return [value.slice(0, close + 1), value.slice(close + 2)]
  }
  const colon = value.lastIndexOf(':')
  if (colon === -1) return [value, '']
  return [value.slice(0, colon), value.slice(colon + 1)]
}

/** The pairing code out of a `forge://pair?…` link, if there is one. */
export function pairTokenOf(input: string): string {
  const raw = input.trim()
  if (!raw.startsWith('forge://')) return ''
  try {
    return new URL(raw).searchParams.get('pt') ?? ''
  } catch {
    return ''
  }
}

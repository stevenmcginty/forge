/**
 * Which Firebase project this page talks to.
 *
 * Both values are public identifiers, not secrets: the API key names the
 * project, it does not authorise anything. `database.rules.json` is what
 * authorises, and it lets a signed-in user touch exactly `users/<their uid>`.
 * DictationMic ships the same two fields in the clear for the same reason.
 *
 * Fill these in from the Firebase console — companion/GO-LIVE.md has the exact
 * commands and where to copy each value from.
 */
export const FIREBASE = {
  apiKey: '',
  databaseURL: '',
  /**
   * Emulator escape hatches. Blank means Google's real endpoints. The emulator
   * serves the same REST APIs under a path prefix on one port, which is the
   * only difference between "talking to the emulator" and "talking to
   * production" anywhere in this app.
   *
   *   authBase : http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
   *   tokenBase: http://127.0.0.1:9099/securetoken.googleapis.com/v1
   */
  authBase: '',
  tokenBase: ''
}

const OVERRIDE_KEY = 'forge-companion-config'

/**
 * Resolve the live config: the baked-in values, overridden by anything held in
 * localStorage, overridden by query parameters.
 *
 * The query-parameter route is what lets the emulator test drive this page
 * without editing a file, and it is deliberately fenced to localhost. On a real
 * phone, opening `https://forge-sync.web.app/?db=...` must not be able to point
 * the app at somebody else's database — not because the rules would let them in
 * (they would not), but because a page that silently re-targets on a link click
 * is a phishing primitive, and this one has a password box on it.
 */
export function resolveConfig() {
  const cfg = { ...FIREBASE }

  let stored = null
  try {
    stored = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null')
  } catch {
    stored = null
  }
  if (stored && typeof stored === 'object') Object.assign(cfg, stored)

  if (isLocal()) {
    const q = new URLSearchParams(location.search)
    const fromQuery = {}
    for (const [param, key] of [
      ['apiKey', 'apiKey'],
      ['db', 'databaseURL'],
      ['authBase', 'authBase'],
      ['tokenBase', 'tokenBase']
    ]) {
      const v = q.get(param)
      if (v) fromQuery[key] = v
    }
    if (Object.keys(fromQuery).length > 0) {
      Object.assign(cfg, fromQuery)
      try {
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify(cfg))
      } catch {
        /* private mode — the query string still works for this session */
      }
    }
  }

  return cfg
}

export function isLocal() {
  return ['127.0.0.1', 'localhost', '::1', ''].includes(location.hostname)
}

/** True when the page is pointed at the emulator suite rather than production. */
export function isEmulated(cfg) {
  return Boolean(cfg.authBase) || /127\.0\.0\.1|localhost/.test(cfg.databaseURL || '')
}

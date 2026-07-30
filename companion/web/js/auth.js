/**
 * Email/password auth against Firebase Identity Toolkit, over plain REST.
 *
 * A hand-kept mirror of electron/companion/rest.ts's auth half — same
 * endpoints, same sign-up fallback, same 300-second expiry margin, same
 * three-outcome contract. When you change one, change the other; the two are
 * short enough that sharing a build step to keep them identical would cost more
 * than it saved (and this file has to run in a browser with no build step at
 * all).
 *
 * No Firebase SDK: it would mean a CDN script tag on a page whose whole
 * premise is that it is five small files served straight off Hosting.
 */

const SESSION_KEY = 'forge-companion-auth'
const EXPIRY_MARGIN_MS = 300_000

const DEFAULT_AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1'
const DEFAULT_TOKEN_BASE = 'https://securetoken.googleapis.com/v1'

/** `{refreshToken, idToken, expiresAt, uid, email}` or null. */
let session = null
let config = null

export function initAuth(cfg) {
  config = cfg
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
  } catch {
    session = null
  }
  return session
}

export function currentSession() {
  return session
}

export function uid() {
  return session?.uid || ''
}

export function signedIn() {
  return Boolean(session?.refreshToken && session?.uid)
}

function authBase() {
  return (config?.authBase || DEFAULT_AUTH_BASE).replace(/\/+$/, '')
}

function tokenBase() {
  return (config?.tokenBase || DEFAULT_TOKEN_BASE).replace(/\/+$/, '')
}

function save() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* private mode: the session lives for this tab only, which still works */
  }
}

/**
 * Sign in, creating the account if the email is new.
 *
 * The `EMAIL_EXISTS` branch is the one that matters: without it, a typo in the
 * password on an existing account produces "couldn't sign in, couldn't sign up"
 * and the user has no idea which half was wrong.
 */
export async function signIn(email, password) {
  const body = { email, password, returnSecureToken: true }
  let res = await postJson(`${authBase()}/accounts:signInWithPassword?key=${config.apiKey}`, body)

  if (!res.ok) {
    const code = errorCode(res.json)
    if (code.startsWith('EMAIL_NOT_FOUND') || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
      const up = await postJson(`${authBase()}/accounts:signUp?key=${config.apiKey}`, body)
      if (!up.ok) {
        const code2 = errorCode(up.json)
        if (code2.startsWith('EMAIL_EXISTS')) throw new Error('Wrong password for that account')
        throw new Error(friendly(code2))
      }
      res = up
    } else {
      throw new Error(friendly(code))
    }
  }

  const d = res.json
  session = {
    refreshToken: d.refreshToken,
    idToken: d.idToken,
    expiresAt: Date.now() + (Number(d.expiresIn || 3600) * 1000 - EXPIRY_MARGIN_MS),
    uid: d.localId,
    email: d.email || email
  }
  save()
  return session
}

export function signOut() {
  session = null
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing to do */
  }
}

/**
 * A valid ID token.
 *
 * Throws `'signed-out'` when the credentials are gone (caller shows the sign-in
 * pane) and anything else when the network is down (caller keeps its queue and
 * retries). Every call site branches on that distinction.
 */
export async function idToken() {
  if (!session?.refreshToken) throw new Error('signed-out')
  if (session.idToken && Date.now() < session.expiresAt) return session.idToken

  let res
  try {
    res = await fetch(`${tokenBase()}/token?key=${config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
    })
  } catch (err) {
    throw new Error(`offline: ${err?.message || err}`)
  }
  if (!res.ok) {
    signOut()
    throw new Error('signed-out')
  }
  const d = await res.json()
  session.idToken = d.id_token
  session.expiresAt = Date.now() + (Number(d.expires_in || 3600) * 1000 - EXPIRY_MARGIN_MS)
  // Refresh tokens rotate; missing the new one is how an app works for a month
  // and then quietly signs itself out.
  if (d.refresh_token && d.refresh_token !== session.refreshToken) session.refreshToken = d.refresh_token
  if (!session.uid && d.user_id) session.uid = d.user_id
  save()
  return session.idToken
}

/** True for the error `idToken()` throws when the session is gone for good. */
export function isSignedOutError(err) {
  return String(err?.message || err) === 'signed-out'
}

/* ---------------------------------------------------------------- helpers */

async function postJson(url, body) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err) {
    throw new Error("Can't reach Firebase — check your connection")
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json }
}

function errorCode(json) {
  return String(json?.error?.message || '')
}

function friendly(code) {
  if (code.startsWith('INVALID_PASSWORD') || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
    return 'Wrong password for that account'
  }
  if (code.startsWith('INVALID_EMAIL')) return "That doesn't look like an email address"
  if (code.startsWith('MISSING_PASSWORD')) return 'Enter a password'
  if (code.startsWith('WEAK_PASSWORD')) return 'Password needs to be at least 6 characters'
  if (code.startsWith('TOO_MANY_ATTEMPTS')) return 'Too many attempts — wait a few minutes'
  if (code.startsWith('USER_DISABLED')) return 'That account is disabled'
  if (code.startsWith('OPERATION_NOT_ALLOWED')) return 'Email sign-in is switched off for this Firebase project'
  return code || 'Sign-in failed'
}

import type { WebClientConfig } from '../config'

/**
 * Email/password auth against Firebase Identity Toolkit, over plain REST.
 *
 * The same approach, the same two endpoints and the same three-outcome contract
 * as `companion/web/js/auth.js` — which is itself a hand-kept mirror of
 * `electron/companion/rest.ts`'s auth half. Written again here rather than
 * imported because the Companion's copy is untyped JavaScript designed to run
 * with no build step at all, and this bundle has one; what is shared is the
 * shape, and the shape is short enough to read side by side.
 *
 * **No Firebase SDK.** The Companion refuses one because it is five files served
 * straight off Hosting; this bundle refuses one because the SDK is several
 * hundred kilobytes to do two `fetch` calls, and because every byte of auth code
 * that is not here is a byte that cannot be read when the door misbehaves.
 *
 * The one addition over the Companion's version is `EXPIRY_MARGIN_MS` doing
 * double duty: this link presents a *fresh* token mid-connection (see
 * TOKEN_REFRESH_MS in shared/web.ts), so `idToken()` is called on a timer as
 * well as on a reconnect, and the margin is what keeps a refresh from racing an
 * expiry it was supposed to be ahead of.
 */

const SESSION_KEY = 'forge-web-auth'

/**
 * How early a token is treated as spent. Five minutes, the same as the
 * Companion's — Firebase mints them with an hour's life, and a margin smaller
 * than the clock skew a desktop tolerates (CLOCK_SKEW_MS is a minute) would be
 * no margin at all.
 */
const EXPIRY_MARGIN_MS = 300_000

const DEFAULT_AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1'
const DEFAULT_TOKEN_BASE = 'https://securetoken.googleapis.com/v1'

export interface Session {
  refreshToken: string
  idToken: string
  /** ms epoch, already reduced by EXPIRY_MARGIN_MS. */
  expiresAt: number
  uid: string
  email: string
}

/** The error `idToken()` throws when the credentials are gone for good. */
export const SIGNED_OUT = 'signed-out'

export function isSignedOutError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err) === SIGNED_OUT
}

/**
 * One account, held for the life of the tab and mirrored into localStorage.
 *
 * A module-level singleton rather than React state, and deliberately: the socket
 * client asks for a token from a timer that has nothing to do with rendering,
 * and threading a credential through a component tree so a `setInterval` can
 * reach it is how a refresh ends up firing against a stale closure.
 */
export class Auth {
  private readonly config: WebClientConfig
  private session: Session | null = null

  constructor(config: WebClientConfig) {
    this.config = config
    this.session = readStored()
  }

  current(): Session | null {
    return this.session
  }

  signedIn(): boolean {
    return Boolean(this.session?.refreshToken && this.session.uid)
  }

  /**
   * Sign in, creating the account if the email is new.
   *
   * The `EMAIL_EXISTS` branch is the one that matters, and it is why this is not
   * two buttons: without it, a typo in the password on an existing account
   * produces "couldn't sign in, couldn't sign up" and the person has no idea
   * which half was wrong.
   */
  async signIn(email: string, password: string): Promise<Session> {
    const body = { email, password, returnSecureToken: true }
    let result = await postJson(`${this.authBase()}/accounts:signInWithPassword?key=${this.config.apiKey}`, body)

    if (!result.ok) {
      const code = errorCode(result.json)
      if (code.startsWith('EMAIL_NOT_FOUND') || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
        const signedUp = await postJson(`${this.authBase()}/accounts:signUp?key=${this.config.apiKey}`, body)
        if (!signedUp.ok) {
          const code2 = errorCode(signedUp.json)
          if (code2.startsWith('EMAIL_EXISTS')) throw new Error('Wrong password for that account')
          throw new Error(friendly(code2))
        }
        result = signedUp
      } else {
        throw new Error(friendly(code))
      }
    }

    const d = (result.json ?? {}) as Record<string, unknown>
    const session: Session = {
      refreshToken: String(d.refreshToken ?? ''),
      idToken: String(d.idToken ?? ''),
      expiresAt: Date.now() + (Number(d.expiresIn ?? 3600) * 1000 - EXPIRY_MARGIN_MS),
      uid: String(d.localId ?? ''),
      email: String(d.email ?? email)
    }
    if (!session.refreshToken || !session.idToken || !session.uid) {
      throw new Error('Firebase answered without a sign-in — try again')
    }
    this.session = session
    this.save()
    return session
  }

  signOut(): void {
    this.session = null
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* nothing to do */
    }
  }

  /**
   * A valid ID token.
   *
   * Throws `'signed-out'` when the credentials are gone — the caller shows the
   * sign-in pane — and anything else when the network is down, where the caller
   * keeps what it has and retries. Every call site branches on that distinction,
   * which is why they are two different failures rather than one `null`.
   */
  async idToken(force = false): Promise<string> {
    const session = this.session
    if (!session?.refreshToken) throw new Error(SIGNED_OUT)
    // `force` is the desktop having just said `bad-token` about the cached one:
    // whatever this clock thinks, that token is spent.
    if (!force && session.idToken && Date.now() < session.expiresAt) return session.idToken

    let response: Response
    try {
      response = await fetch(`${this.tokenBase()}/token?key=${this.config.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
        // Eight seconds, because a re-dial is serialized behind this refresh
        // and a hung one wedges the reconnect loop for as long as the browser
        // feels like waiting — minutes. Throwing here is not a failure state:
        // the caller keeps its credentials and tries again on the next dial.
        signal: AbortSignal.timeout(8_000)
      })
    } catch (err) {
      throw new Error(`offline: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!response.ok) {
      this.signOut()
      throw new Error(SIGNED_OUT)
    }
    const d = (await response.json()) as Record<string, unknown>
    session.idToken = String(d.id_token ?? '')
    session.expiresAt = Date.now() + (Number(d.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS)
    // Refresh tokens rotate; missing the new one is how an app works for a month
    // and then quietly signs itself out.
    const rotated = typeof d.refresh_token === 'string' ? d.refresh_token : ''
    if (rotated && rotated !== session.refreshToken) session.refreshToken = rotated
    if (!session.uid && typeof d.user_id === 'string') session.uid = d.user_id
    this.save()
    return session.idToken
  }

  private authBase(): string {
    return (this.config.authBase || DEFAULT_AUTH_BASE).replace(/\/+$/, '')
  }

  private tokenBase(): string {
    return (this.config.tokenBase || DEFAULT_TOKEN_BASE).replace(/\/+$/, '')
  }

  private save(): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.session))
    } catch {
      /* private mode: the session lives for this tab only, which still works */
    }
  }
}

/* ---------------------------------------------------------------- helpers */

function readStored(): Session | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const stored = value as Partial<Session>
  if (typeof stored.refreshToken !== 'string' || !stored.refreshToken) return null
  if (typeof stored.uid !== 'string' || !stored.uid) return null
  return {
    refreshToken: stored.refreshToken,
    idToken: typeof stored.idToken === 'string' ? stored.idToken : '',
    expiresAt: typeof stored.expiresAt === 'number' ? stored.expiresAt : 0,
    uid: stored.uid,
    email: typeof stored.email === 'string' ? stored.email : ''
  }
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error("Can't reach Firebase — check your connection")
  }
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ok: response.ok, status: response.status, json }
}

function errorCode(json: unknown): string {
  const value = json as { error?: { message?: unknown } } | null
  return String(value?.error?.message ?? '')
}

/**
 * Identity Toolkit's codes, as sentences.
 *
 * The same table as the Companion's, word for word where the situation is the
 * same. A refusal the person cannot act on is a refusal that reads as a bug.
 */
function friendly(code: string): string {
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

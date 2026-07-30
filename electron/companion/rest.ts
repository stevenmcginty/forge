/**
 * Firebase over plain REST — Identity Toolkit for accounts, the RTDB `.json`
 * endpoints for data, and RTDB's server-sent-event stream for live updates.
 *
 * Why not the `firebase` npm SDK
 * ------------------------------
 * Three reasons, in order of weight.
 *
 * 1. *Restoring a session from a refresh token is not a public API.* Forge is
 *    a desktop app that is closed and reopened; it stores a refresh token and
 *    must come back signed in without asking again. The modular SDK does that
 *    through a `Persistence` implementation whose interface is internal
 *    (`_get`/`_set`/`_addListener`), which is exactly the kind of thing that
 *    breaks on a minor bump. `securetoken.googleapis.com/v1/token` is a
 *    documented, stable, two-field POST.
 * 2. *This is the shape that is already proven on Steve's phone.* DictationMic
 *    has run REST + SSE against `dictationmic-sync` for months, including all
 *    the ugly parts — token rotation, `auth_revoked`, EventSource's refusal to
 *    re-authenticate on reconnect. Reimplementing those bugs in a different
 *    library would be a downgrade.
 * 3. *It costs nothing.* No dependency to bundle, nothing for the packaging
 *    milestone to unpack out of the asar, and the PWA can run the identical
 *    logic with no build step and no CDN script.
 *
 * The emulator suite serves these same REST APIs under a path prefix
 * (`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/...`), so pointing
 * this client at the emulator is a config change and nothing else — which is
 * what makes the end-to-end test in scripts/companion-smoke.mjs the real code
 * path rather than a mock of it.
 *
 * Free of Electron and of any dependency: `fetch` and `AbortController` are
 * both Node built-ins on the version Forge runs.
 */

/* ------------------------------------------------------------------ errors */

/**
 * The network is down, or the host is unreachable. Distinct from "the server
 * said no" because the two want opposite handling: retry forever vs. stop and
 * ask the user for a password. Every caller in companion-sync.ts branches on
 * this, so it is a class rather than a string.
 */
export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super(`offline: ${describe(cause)}`)
    this.name = 'OfflineError'
  }
}

/** The credentials are gone (revoked, deleted account, rotated out). */
export class RevokedError extends Error {
  constructor(message = 'credentials revoked') {
    super(message)
    this.name = 'RevokedError'
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/* ------------------------------------------------------------------ config */

export interface RestConfig {
  apiKey: string
  /** RTDB root. Any query string on it (the emulator's `?ns=`) rides every request. */
  databaseURL: string
  /** Identity Toolkit v1 base, without a trailing slash. */
  authBase?: string
  /** Secure Token v1 base, without a trailing slash. */
  tokenBase?: string
  /** Injectable for tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

const DEFAULT_AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1'
const DEFAULT_TOKEN_BASE = 'https://securetoken.googleapis.com/v1'

/**
 * Refresh this long before the ID token actually expires.
 *
 * Five minutes is DictationMic's number and it is not arbitrary: a long
 * PATCH over a slow phone tether can genuinely take tens of seconds, and a
 * token that expires *mid-request* produces a 401 that looks exactly like a
 * revoked credential. The margin buys the difference.
 */
const EXPIRY_MARGIN_MS = 300_000

export interface Session {
  uid: string
  email: string
  idToken: string
  refreshToken: string
  /** Epoch ms, already reduced by EXPIRY_MARGIN_MS. */
  expiresAt: number
}

/* -------------------------------------------------------------------- auth */

export interface AuthResult {
  uid: string
  email: string
  idToken: string
  refreshToken: string
  expiresAt: number
  /** True when this call created the account rather than signing into one. */
  created: boolean
}

/* ------------------------------------------------------------------ client */

export type StreamEventName = 'put' | 'patch' | 'keep-alive' | 'cancel' | 'auth_revoked'

export interface StreamEvent {
  event: StreamEventName
  /** Path relative to the streamed node. `/` for a whole snapshot. */
  path: string
  data: unknown
}

/**
 * What subscribers actually see. `keep-alive`, `cancel` and `auth_revoked` are
 * connection management and are swallowed by `stream()` — narrowing the type
 * here means a handler cannot forget to ignore them.
 */
export interface StreamDataEvent {
  event: 'put' | 'patch'
  path: string
  data: unknown
}

export interface StreamHandlers {
  onEvent(e: StreamDataEvent): void
  /** Called on every state change so the UI can show something honest. */
  onState?(state: 'connecting' | 'live' | 'offline' | 'revoked', detail?: string): void
}

export interface StreamHandle {
  stop(): void
  readonly stopped: boolean
}

export class FirebaseRest {
  private readonly cfg: RestConfig
  private readonly doFetch: typeof globalThis.fetch
  private readonly now: () => number

  private session: Session | null = null
  /** Called whenever a refresh rotates the token, so the caller can persist it. */
  onRefreshToken: ((refreshToken: string) => void) | null = null

  constructor(cfg: RestConfig) {
    this.cfg = cfg
    this.doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = cfg.now ?? Date.now
  }

  get authBase(): string {
    return (this.cfg.authBase || DEFAULT_AUTH_BASE).replace(/\/+$/, '')
  }

  get tokenBase(): string {
    return (this.cfg.tokenBase || DEFAULT_TOKEN_BASE).replace(/\/+$/, '')
  }

  get uid(): string {
    return this.session?.uid ?? ''
  }

  /** Adopt a session restored from disk. `expiresAt: 0` forces a refresh. */
  adopt(session: Session): void {
    this.session = session
  }

  forget(): void {
    this.session = null
  }

  /* ------------------------------------------------------------- accounts */

  /**
   * Sign in, creating the account if it does not exist.
   *
   * This is DictationMic's flow and it is the right one for a single-user
   * tool: Steve types an email and a password once, and it works whether or
   * not he has been here before. The `EMAIL_EXISTS` branch is what turns the
   * ambiguous "that didn't work" into "wrong password for that account" — the
   * only case where the fallback is genuinely wrong rather than merely new.
   */
  async signIn(email: string, password: string): Promise<AuthResult> {
    const body = { email, password, returnSecureToken: true }
    let res = await this.postJson(`${this.authBase}/accounts:signInWithPassword?key=${this.cfg.apiKey}`, body)
    let created = false

    if (!res.ok) {
      const code = errorCode(res.json)
      if (code.startsWith('EMAIL_NOT_FOUND') || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
        const signUp = await this.postJson(`${this.authBase}/accounts:signUp?key=${this.cfg.apiKey}`, body)
        if (!signUp.ok) {
          const code2 = errorCode(signUp.json)
          if (code2.startsWith('EMAIL_EXISTS')) throw new Error('Wrong password for that account')
          throw new Error(friendlyAuthError(code2))
        }
        res = signUp
        created = true
      } else {
        throw new Error(friendlyAuthError(code))
      }
    }

    const data = res.json as Record<string, unknown>
    const session: Session = {
      uid: String(data['localId'] ?? ''),
      email: String(data['email'] ?? email),
      idToken: String(data['idToken'] ?? ''),
      refreshToken: String(data['refreshToken'] ?? ''),
      expiresAt: this.now() + (Number(data['expiresIn'] ?? 3600) * 1000 - EXPIRY_MARGIN_MS)
    }
    if (!session.uid || !session.idToken || !session.refreshToken) {
      throw new Error('Sign-in succeeded but the response was missing a token')
    }
    this.session = session
    return { ...session, created }
  }

  /**
   * A valid ID token, refreshing if needed.
   *
   * The three outcomes are deliberately three different things, and every
   * caller depends on the distinction:
   *   - a string            → go
   *   - `RevokedError`      → stop, the user must sign in again
   *   - `OfflineError`      → keep the session, retry later
   */
  async token(): Promise<string> {
    const s = this.session
    if (!s) throw new RevokedError('not signed in')
    if (s.idToken && this.now() < s.expiresAt) return s.idToken
    if (!s.refreshToken) throw new RevokedError('no refresh token')

    let res: { ok: boolean; status: number; json: unknown }
    try {
      res = await this.postForm(`${this.tokenBase}/token?key=${this.cfg.apiKey}`, {
        grant_type: 'refresh_token',
        refresh_token: s.refreshToken
      })
    } catch (err) {
      throw new OfflineError(err)
    }
    if (!res.ok) throw new RevokedError(`refresh rejected (${res.status})`)

    const data = res.json as Record<string, unknown>
    const idToken = String(data['id_token'] ?? '')
    if (!idToken) throw new RevokedError('refresh returned no id_token')
    s.idToken = idToken
    s.expiresAt = this.now() + (Number(data['expires_in'] ?? 3600) * 1000 - EXPIRY_MARGIN_MS)
    if (s.uid === '') s.uid = String(data['user_id'] ?? '')

    // Refresh tokens rotate. Missing this is how an app works for a month and
    // then silently signs itself out.
    const rotated = String(data['refresh_token'] ?? '')
    if (rotated && rotated !== s.refreshToken) {
      s.refreshToken = rotated
      this.onRefreshToken?.(rotated)
    }
    return idToken
  }

  /* ------------------------------------------------------------ database */

  /**
   * `<databaseURL>/<path>.json`, carrying the base URL's own query string.
   *
   * That last part is the entire emulator story: the RTDB emulator addresses
   * databases by a `?ns=` parameter instead of by hostname, so a config of
   * `http://127.0.0.1:9000?ns=forge-sync-default-rtdb` has to reach every
   * request. Building URLs anywhere else in the codebase would drop it.
   */
  dbUrl(path: string, params: Record<string, string> = {}): string {
    const base = new URL(this.cfg.databaseURL)
    const clean = String(path).replace(/^\/+/, '').replace(/\/+$/, '')
    const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/${clean}.json`)
    for (const [k, v] of base.searchParams) url.searchParams.set(k, v)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return url.toString()
  }

  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T | null> {
    const url = this.dbUrl(path, { auth: await this.token(), ...(params ?? {}) })
    const res = await this.request(url, { method: 'GET' })
    if (!res.ok) throw dbError('GET', path, res)
    return res.json as T | null
  }

  /** Field-merge. Every write in Forge is a PATCH — see the README's schema notes. */
  async patch(path: string, value: unknown): Promise<unknown> {
    const url = this.dbUrl(path, { auth: await this.token() })
    const res = await this.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    })
    if (!res.ok) throw dbError('PATCH', path, res)
    return res.json
  }

  /** Whole-node replace. Used only where a node is authored in one go. */
  async put(path: string, value: unknown): Promise<unknown> {
    const url = this.dbUrl(path, { auth: await this.token() })
    const res = await this.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    })
    if (!res.ok) throw dbError('PUT', path, res)
    return res.json
  }

  async remove(path: string): Promise<void> {
    const url = this.dbUrl(path, { auth: await this.token() })
    const res = await this.request(url, { method: 'DELETE' })
    if (!res.ok) throw dbError('DELETE', path, res)
  }

  /* -------------------------------------------------------------- stream */

  /**
   * Live-subscribe to a node over RTDB's SSE endpoint, reconnecting forever.
   *
   * Two details that are easy to get wrong and expensive to debug:
   *
   *  - **A fresh token on every connect.** The token rides the query string
   *    (SSE cannot carry headers), so a reconnect that reuses the original URL
   *    re-presents an expired token and loops. `token()` is therefore called
   *    inside the retry loop, never outside it.
   *  - **A keep-alive watchdog.** RTDB sends `keep-alive` roughly every 30s. A
   *    TCP connection that has silently died looks identical to an idle one, so
   *    without a watchdog the stream can sit "connected" and deaf indefinitely.
   *    Three missed beats and we tear it down.
   */
  stream(path: string, handlers: StreamHandlers): StreamHandle {
    let stopped = false
    let controller: AbortController | null = null
    let watchdog: NodeJS.Timeout | null = null
    let lastBeat = this.now()

    const handle: StreamHandle = {
      stop: () => {
        stopped = true
        if (watchdog) clearInterval(watchdog)
        watchdog = null
        controller?.abort()
      },
      get stopped() {
        return stopped
      }
    }

    const run = async (): Promise<void> => {
      let backoff = 1000
      while (!stopped) {
        handlers.onState?.('connecting')
        let token: string
        try {
          token = await this.token()
        } catch (err) {
          if (err instanceof RevokedError) {
            handlers.onState?.('revoked', describe(err))
            return
          }
          handlers.onState?.('offline', describe(err))
          await sleep(backoff)
          backoff = Math.min(backoff * 2, 60_000)
          continue
        }

        controller = new AbortController()
        lastBeat = this.now()
        if (watchdog) clearInterval(watchdog)
        watchdog = setInterval(() => {
          if (this.now() - lastBeat > 95_000) controller?.abort()
        }, 30_000)

        try {
          const res = await this.doFetch(this.dbUrl(path, { auth: token }), {
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal
          })
          if (res.status === 401) {
            // Expired mid-flight. Drop the token and go straight round again
            // rather than sleeping — the next loop mints a fresh one.
            if (this.session) this.session.expiresAt = 0
            continue
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)

          handlers.onState?.('live')
          backoff = 1000

          for await (const evt of readSse(res.body)) {
            lastBeat = this.now()
            if (stopped) break
            if (evt.event === 'keep-alive') continue
            if (evt.event === 'auth_revoked') {
              if (this.session) this.session.expiresAt = 0
              break
            }
            if (evt.event === 'cancel') break
            handlers.onEvent({ event: evt.event, path: evt.path, data: evt.data })
          }
        } catch (err) {
          if (stopped) break
          handlers.onState?.('offline', describe(err))
        } finally {
          if (watchdog) clearInterval(watchdog)
          watchdog = null
        }

        if (stopped) break
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
      handlers.onState?.('offline', 'stopped')
    }

    void run()
    return handle
  }

  /* ------------------------------------------------------------ plumbing */

  private async request(
    url: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    let res: Response
    try {
      res = await this.doFetch(url, init)
    } catch (err) {
      throw new OfflineError(err)
    }
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  }

  private async postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  private async postForm(
    url: string,
    body: Record<string, string>
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    })
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * Parse RTDB's SSE framing out of a byte stream.
 *
 * Chunk-at-a-time into a string buffer, split on the blank line that ends an
 * event. DictationMic reads byte-at-a-time because Python's `iter_lines` is
 * quadratic; `TextDecoder` with `{stream:true}` has no such problem, so we can
 * take whole chunks and still not stall a small event behind a large one.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let split = buf.indexOf('\n\n')
    while (split !== -1) {
      const frame = buf.slice(0, split)
      buf = buf.slice(split + 2)
      const parsed = parseFrame(frame)
      if (parsed) yield parsed
      split = buf.indexOf('\n\n')
    }
  }
}

function parseFrame(frame: string): StreamEvent | null {
  let event = ''
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!event) return null
  if (event === 'keep-alive') return { event: 'keep-alive', path: '/', data: null }
  if (event === 'cancel' || event === 'auth_revoked') {
    return { event: event as StreamEventName, path: '/', data: dataLines.join('\n') }
  }
  if (event !== 'put' && event !== 'patch') return null
  try {
    const payload = JSON.parse(dataLines.join('\n')) as { path?: string; data?: unknown }
    return { event, path: String(payload?.path ?? '/'), data: payload?.data ?? null }
  } catch {
    return null
  }
}

function errorCode(json: unknown): string {
  const err = (json as { error?: { message?: string } } | null)?.error
  return String(err?.message ?? '')
}

/** Identity Toolkit's codes are SHOUTED enum names. Say them in English. */
function friendlyAuthError(code: string): string {
  if (code.startsWith('INVALID_PASSWORD') || code.startsWith('INVALID_LOGIN_CREDENTIALS')) {
    return 'Wrong password for that account'
  }
  if (code.startsWith('INVALID_EMAIL')) return "That doesn't look like an email address"
  if (code.startsWith('WEAK_PASSWORD')) return 'Password needs to be at least 6 characters'
  if (code.startsWith('TOO_MANY_ATTEMPTS')) return 'Too many attempts — wait a few minutes'
  if (code.startsWith('USER_DISABLED')) return 'That account is disabled'
  if (code.startsWith('OPERATION_NOT_ALLOWED')) {
    return 'Email/password sign-in is switched off for this Firebase project'
  }
  return code || 'Sign-in failed'
}

function dbError(method: string, path: string, res: { status: number; text: string }): Error {
  if (res.status === 401 || res.status === 403) {
    return new RevokedError(`${method} ${path} refused (${res.status}): ${res.text.slice(0, 200)}`)
  }
  return new Error(`${method} ${path} failed (${res.status}): ${res.text.slice(0, 200)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

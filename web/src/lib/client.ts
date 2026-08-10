import {
  HEARTBEAT_MS,
  MAX_WRITE_CHARS,
  TOKEN_REFRESH_MS,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  isWebRefusal,
  isWebShutdownReason,
  type WebApprovalState,
  type WebClientFrame,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebRefusal,
  type WebRequest,
  type WebResult,
  type WebServerFrame,
  type WebSession,
  type WebShutdownReason
} from '@shared/web'
import type { GitSnapshot, Project, Workspace } from '@shared/types'

/**
 * The browser's end of the Forge Web link — one socket, and everything the page
 * knows about the desktop.
 *
 * Every frame, limit and guard comes from `@shared/web`, which is the file both
 * ends compile against. Nothing here hand-rolls a frame, restates a ceiling or
 * invents a word: `WEB_PROTO`, `WEB_SUBPROTOCOL`, `MAX_WRITE_CHARS`,
 * `HEARTBEAT_MS`, `TOKEN_REFRESH_MS`, `isWebRefusal` and `isWebShutdownReason`
 * are all imported, and the three values this module *does* name for itself
 * (backoff, request patience, the warmth window) are client-side judgements that
 * do not appear on the wire.
 *
 * ## Connection state is the product, not a spinner
 *
 * `WebApprovalState` names the vocabulary — connecting, pending, live, declined,
 * timed-out, refused, offline — and shared/web.ts says why it is a vocabulary
 * rather than a boolean: each one is a different sentence with a different
 * recovery. So this class never collapses a refusal into "disconnected", and it
 * never retries one that a retry cannot fix. `retryPolicy` below is that
 * judgement written down once, per `WebRefusal`, instead of scattered through a
 * reconnect loop.
 *
 * ## Mirror, never a parallel world
 *
 * `layout()` sends a request and resolves with the desktop's answer. It does not
 * touch any local state, and there is deliberately no method that does: the
 * desktop renderer owns the split tree and persists it (docs/forge-web.md,
 * decision 5), and what redraws this page is the `workspace` push that comes
 * back. A client that mutated its own copy and hoped would be a second source of
 * truth for the one thing this protocol exists to keep singular.
 */

/** Reconnect schedule, in ms. Caps rather than growing forever — as mobile's does. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]

/**
 * How long a `request` waits before its promise is settled as failed.
 *
 * Not a protocol constant and deliberately not in shared/web.ts: the server
 * guarantees that every request settles, so this is not a correctness
 * mechanism — it is how long a *person* is willing to watch a spinner over a git
 * fetch on a slow machine. Thirty seconds is past any of them and short enough
 * that a wedged desktop shows a sentence rather than a permanent spinner.
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long after the last frame the link still counts as warm.
 *
 * Only the connection badge reads it. The socket's real liveness is the
 * server's native WebSocket ping (HEARTBEAT_MS), which a browser answers in its
 * network stack whether or not the tab is visible; the app-level `ping` this
 * class sends exists for exactly one thing, which shared/web.ts spells out —
 * telling the *page* the link is answering, so the badge is honest.
 */
const WARM_MS = HEARTBEAT_MS * 2

/* ------------------------------------------------------------------- state */

/**
 * Where this browser stands, as the one word the connection UI switches on plus
 * whatever that word needs to say.
 *
 * The tag is `WebApprovalState` itself rather than a parallel enum, so a state
 * the protocol names and this client forgot to handle is a compile error.
 */
export type Connection =
  | { state: Extract<WebApprovalState, 'connecting'>; attempt: number }
  | { state: Extract<WebApprovalState, 'pending'>; words: string; expiresAt: number }
  /**
   * The desktop wants a six-digit code. `invalid` distinguishes "you have not
   * been asked yet" from "that one did not work" — the same screen either way,
   * but only one of them owes the person a red line.
   */
  | { state: Extract<WebApprovalState, 'totp'>; message: string; invalid: boolean }
  | { state: Extract<WebApprovalState, 'live'>; desktopName: string; appVersion: string }
  | { state: Extract<WebApprovalState, 'declined'>; message: string }
  | { state: Extract<WebApprovalState, 'timed-out'>; message: string }
  | { state: Extract<WebApprovalState, 'refused'>; reason: WebRefusal; message: string; retryAfterMs?: number }
  | { state: Extract<WebApprovalState, 'offline'>; message: string; reason?: WebShutdownReason; retryAfterMs?: number }

export interface ForgeHandlers {
  /** The connection state changed. The whole of the connection UI is this. */
  onConnection: (connection: Connection) => void
  /** The opening picture, on every (re)connection. */
  onPicture: (picture: WebHelloOkFrame) => void
  /** Terminal bytes. `replay` marks the catch-up buffer, which must clear first. */
  onData: (sessionId: string, data: string, replay: boolean, truncated: boolean) => void
  onExit: (sessionId: string, exitCode: number) => void
  onSessions: (sessions: WebSession[]) => void
  onSessionStarted: (session: WebSession) => void
  onAttention: (sessionId: string, asking: boolean, prompt: string) => void
  onProjects: (projects: Project[]) => void
  onWorkspace: (projectId: string, workspace: Workspace) => void
  onGit: (snapshot: GitSnapshot) => void
  /** Something went wrong that no `rid` is waiting on. One sentence, for the user. */
  onNotice: (message: string) => void
  /**
   * The credential was refused. The page re-authenticates and this class
   * reconnects; the handler exists so a *second* failure signs the person out
   * rather than looping on a token that will never verify.
   */
  onTokenRejected: () => void
}

export interface ForgeCredentials {
  /** Already built by `webSocketUrl`. This class never composes an address. */
  url: string
  /**
   * A valid ID token. `force` means the last one was refused, so a cached one
   * must not be handed back.
   */
  getToken: (force: boolean) => Promise<string>
  deviceId: string
  deviceName: string
}

/**
 * What a refusal means for the reconnect loop.
 *
 * One table rather than a chain of ifs, because the whole value of `WebRefusal`
 * being seven words instead of one string is that each has a different recovery,
 * and a recovery that only exists in prose is one the code does not have.
 */
type Retry =
  /** Do not reconnect. A human has to do something. */
  | { kind: 'stop' }
  /** Get a fresh credential and try once more. */
  | { kind: 'reauth' }
  /** Wait the server's own `retryAfterMs`, then try again. */
  | { kind: 'after' }

function retryPolicy(reason: WebRefusal): Retry {
  switch (reason) {
    // A fresh token usually fixes it, and usually without the person noticing.
    case 'bad-token':
      return { kind: 'reauth' }
    // Retrying a correct credential against the wrong desktop loops forever.
    case 'wrong-account':
      return { kind: 'stop' }
    // Nobody has said no, and nobody has been asked. Retrying knocks again on a
    // door that is not being answered — the prompt storm `not-approved` exists
    // to prevent.
    case 'not-approved':
      return { kind: 'stop' }
    // "Asking again is a new prompt, not a retry."
    case 'declined':
      return { kind: 'stop' }
    // Retrying is reasonable, but by a human pressing the button: an automatic
    // one would mint fresh words every two minutes under the eyes of somebody
    // comparing the old pair.
    case 'timed-out':
      return { kind: 'stop' }
    // "The page should forget its device id and stop reconnecting."
    case 'revoked':
      return { kind: 'stop' }
    // Recovery is a reload; this bundle cannot become a different one.
    case 'proto':
      return { kind: 'stop' }
    case 'busy':
      return { kind: 'after' }
    // Both are answered by a human typing something, so neither is a reconnect
    // this loop can decide on its own. `submitTotp` is what starts the next
    // attempt, and it carries the thing that was missing.
    case 'totp-required':
    case 'totp-invalid':
      return { kind: 'stop' }
  }
}

/* ------------------------------------------------------------------- class */

export class ForgeClient {
  private readonly handlers: ForgeHandlers
  private credentials: ForgeCredentials | null = null
  private socket: WebSocket | null = null
  private attempt = 0
  private retryTimer: number | null = null
  private beatTimer: number | null = null
  private refreshTimer: number | null = null
  private closedByUs = false
  /** True once a `refused` frame has decided this link is not coming back. */
  private stopped = false
  /** Set when the last refusal was `bad-token`, so a second one signs out. */
  private reauthed = false
  private lastFrameAt = 0
  private rid = 0
  private waiting = new Map<string, { settle: (result: WebResult) => void; timer: number }>()
  /** sessionId → the geometry this browser is reading it at, re-sent on reconnect. */
  private subs = new Map<string, { cols: number; rows: number } | null>()
  /** The second factor for the *next* hello only. See `submitTotp`. */
  private totp = ''
  private trust = false

  constructor(handlers: ForgeHandlers) {
    this.handlers = handlers
  }

  /** Is the link answering? Drives the badge, and nothing else. See WARM_MS. */
  get warm(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastFrameAt < WARM_MS
  }

  connect(credentials: ForgeCredentials): void {
    this.credentials = credentials
    this.closedByUs = false
    this.stopped = false
    this.reauthed = false
    this.attempt = 0
    void this.open()
  }

  /** A human pressed "Try again" on a screen this class had stopped at. */
  retry(): void {
    if (!this.credentials) return
    this.stopped = false
    this.closedByUs = false
    this.reauthed = false
    this.attempt = 0
    this.clearRetry()
    void this.open()
  }

  /**
   * A human typed the second factor. Reconnect, carrying it.
   *
   * The code is held for exactly one `hello` and dropped in `open()`, whatever
   * the desktop makes of it. A client that kept it would retry a spent code on
   * every reconnect for the rest of the session, and every one of those retries
   * would be a strike against this address at the far end.
   */
  submitTotp(code: string, trust: boolean): void {
    if (!this.credentials) return
    this.totp = code.trim()
    this.trust = trust
    this.retry()
  }

  disconnect(): void {
    this.closedByUs = true
    this.clearRetry()
    this.dropSocket()
    this.subs.clear()
    this.failWaiting('The link to the desktop closed.')
  }

  /* ------------------------------------------------------------- terminals */

  /**
   * Watch a pane, at the size this browser is reading it.
   *
   * The geometry is remembered rather than sent and forgotten, because
   * `WebAttachFrame`'s optional `cols`/`rows` are how the desktop knows to stand
   * down and follow the browser — and a reconnect that re-attached without them
   * would hand the pane back to whatever width the desk last set, mid-sentence.
   */
  attach(sessionId: string, size: { cols: number; rows: number } | null): void {
    this.subs.set(sessionId, size)
    this.send({ type: 'attach', sessionId, ...(size ? { cols: size.cols, rows: size.rows } : {}) })
  }

  detach(sessionId: string): void {
    if (!this.subs.delete(sessionId)) return
    this.send({ type: 'detach', sessionId })
  }

  /**
   * Keystrokes.
   *
   * Held to MAX_WRITE_CHARS here as well as at the desktop, and refused with the
   * same sentence rather than sent to be refused: the client has already thrown
   * its draft away by the time this returns, so the person has to be told
   * nothing was typed, and a round trip to learn that is a round trip in which
   * they carried on typing.
   */
  write(sessionId: string, data: string): void {
    if (!data) return
    if (data.length > MAX_WRITE_CHARS) {
      this.handlers.onNotice(
        `That is longer than the ${MAX_WRITE_CHARS} characters one write may carry — nothing was typed.`
      )
      return
    }
    this.send({ type: 'write', sessionId, data })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (this.subs.has(sessionId)) this.subs.set(sessionId, { cols, rows })
    this.send({ type: 'resize', sessionId, cols, rows })
  }

  /* -------------------------------------------------------------- requests */

  /**
   * Everything that is a question rather than a stream, correlated by `rid`.
   *
   * Always settles: on the server's answer, on a socket that closed under it, or
   * on REQUEST_TIMEOUT_MS. A promise that can hang is a spinner that can hang.
   */
  request(body: WebRequest): Promise<WebResult> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ kind: 'failed', code: 'no-window', message: 'Not connected to the desktop.' })
    }
    this.rid += 1
    const rid = `r${this.rid}`
    return new Promise<WebResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(rid)
        resolve({ kind: 'failed', code: 'failed', message: 'The desktop did not answer in time.' })
      }, REQUEST_TIMEOUT_MS)
      this.waiting.set(rid, { settle: resolve, timer })
      this.send({ type: 'request', rid, body })
    })
  }

  /**
   * One layout gesture. Resolves with the desktop's error sentence, or null when
   * it worked — never with a local mutation. See the header.
   */
  async layout(op: WebLayoutOp): Promise<string | null> {
    const result = await this.request({ kind: 'layout', op })
    if (result.kind === 'ok') return null
    if (result.kind === 'failed') return result.message
    return 'The desktop answered that layout request with something this page does not understand.'
  }

  /* -------------------------------------------------------------- internals */

  private async open(): Promise<void> {
    const credentials = this.credentials
    if (!credentials || this.closedByUs || this.stopped) return

    this.dropSocket()
    this.handlers.onConnection({ state: 'connecting', attempt: this.attempt })

    let idToken: string
    try {
      idToken = await credentials.getToken(this.reauthed)
    } catch (err) {
      // A credential that is gone for good is the page's problem, not this
      // loop's: it hands back to sign-in rather than retrying against nothing.
      if (String(err instanceof Error ? err.message : err) === 'signed-out') {
        this.stopped = true
        this.handlers.onTokenRejected()
        return
      }
      this.scheduleRetry()
      return
    }
    // A token fetch is a network round trip, and the page may have moved on.
    if (this.closedByUs || this.stopped) return

    let socket: WebSocket
    try {
      // The subprotocol is the only field a browser's WebSocket constructor
      // controls, and it is how a version mismatch is refused during the
      // upgrade rather than after a hello round trip. See WEB_SUBPROTOCOL.
      socket = new WebSocket(credentials.url, WEB_SUBPROTOCOL)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket
    this.lastFrameAt = Date.now()

    // Spent on this attempt and this attempt only, whatever comes of it — read
    // before `onopen` so a socket that never opens still burns it rather than
    // leaving a stale code to be replayed by the reconnect loop.
    const totp = this.totp
    const trust = this.trust
    this.totp = ''
    this.trust = false

    socket.onopen = () => {
      this.lastFrameAt = Date.now()
      this.startBeating()
      this.sendFrame(socket, {
        type: 'hello',
        proto: WEB_PROTO,
        idToken,
        client: __WEB_CLIENT_VERSION__,
        deviceId: credentials.deviceId,
        deviceName: credentials.deviceName,
        // Omitted entirely rather than sent empty: the field is optional in the
        // protocol and a desktop with no second factor should see a `hello`
        // that looks exactly like it always did.
        ...(totp ? { totp, trust } : {})
      })
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onclose = () => {
      this.socket = null
      this.stopBeating()
      this.failWaiting('The link to the desktop dropped before that answered.')
      if (this.closedByUs || this.stopped) return
      this.scheduleRetry()
    }

    socket.onerror = () => {
      /* onclose always follows; retrying is decided there */
    }
  }

  private receive(raw: string): void {
    // Before parsing and whatever the frame turns out to be: bytes arriving
    // *are* the warmth signal, including the `pong` that exists for no other
    // reason.
    this.lastFrameAt = Date.now()

    let frame: WebServerFrame
    try {
      frame = JSON.parse(raw) as WebServerFrame
    } catch {
      return
    }

    switch (frame.type) {
      case 'hello-ok': {
        this.attempt = 0
        this.reauthed = false
        this.handlers.onPicture(frame)
        this.handlers.onConnection({ state: 'live', desktopName: frame.desktopName, appVersion: frame.appVersion })
        this.startRefreshing()
        // Re-arm every pane the UI still believes it is watching. Each answers
        // with a replay frame, which is what repaints the terminal.
        for (const [sessionId, size] of this.subs) {
          this.send({ type: 'attach', sessionId, ...(size ? { cols: size.cols, rows: size.rows } : {}) })
        }
        return
      }

      case 'pending':
        // Shown exactly as sent. The desktop minted the pair and this side only
        // displays it; both screens rendering the same string is the entire
        // anti-confusion property (see WebPendingFrame).
        this.handlers.onConnection({
          state: 'pending',
          words: typeof frame.words === 'string' ? frame.words : '',
          expiresAt: typeof frame.expiresAt === 'number' ? frame.expiresAt : 0
        })
        return

      case 'refused':
        this.onRefused(frame.reason, typeof frame.message === 'string' ? frame.message : '', frame.retryAfterMs)
        return

      case 'replay':
        this.handlers.onData(frame.sessionId, frame.data, true, frame.truncated === true)
        return

      case 'data':
        this.handlers.onData(frame.sessionId, frame.data, false, false)
        return

      case 'exit':
        this.subs.delete(frame.sessionId)
        this.handlers.onExit(frame.sessionId, typeof frame.exitCode === 'number' ? frame.exitCode : 0)
        return

      case 'sessions':
        this.handlers.onSessions(Array.isArray(frame.sessions) ? frame.sessions : [])
        return

      case 'session-started':
        this.handlers.onSessionStarted(frame.session)
        return

      case 'attention':
        this.handlers.onAttention(
          frame.sessionId,
          frame.asking === true,
          typeof frame.prompt === 'string' ? frame.prompt : ''
        )
        return

      case 'projects':
        this.handlers.onProjects(Array.isArray(frame.projects) ? frame.projects : [])
        return

      case 'workspace':
        this.handlers.onWorkspace(frame.projectId, frame.workspace)
        return

      case 'git':
        this.handlers.onGit(frame.snapshot)
        return

      case 'result': {
        const rid = typeof frame.rid === 'string' ? frame.rid : ''
        const waiting = this.waiting.get(rid)
        if (!waiting) return
        this.waiting.delete(rid)
        clearTimeout(waiting.timer)
        waiting.settle(frame.body)
        return
      }

      case 'shutdown': {
        // The cue to stop reconnecting rather than spend the next minute
        // retrying a machine that is off. Without this frame every shutdown
        // looks like a network fault.
        const reason = isWebShutdownReason(frame.reason) ? frame.reason : undefined
        this.stopped = true
        this.handlers.onConnection({
          state: 'offline',
          message: typeof frame.message === 'string' && frame.message ? frame.message : 'The desktop went away.',
          ...(reason ? { reason } : {}),
          ...(typeof frame.retryAfterMs === 'number' ? { retryAfterMs: frame.retryAfterMs } : {})
        })
        return
      }

      case 'error':
        // Only `message` is meant to be shown; the codes exist so a client can
        // decide whether to retry or re-sync, not so it can compose a sentence.
        if (typeof frame.message === 'string' && frame.message) this.handlers.onNotice(frame.message)
        return

      case 'pong':
        return
    }
  }

  /**
   * A refusal, routed by what it actually means. See `retryPolicy`.
   *
   * A value a newer desktop invented falls out here, at the edge, through
   * `isWebRefusal` — which is exactly the job shared/web.ts gives that guard.
   */
  private onRefused(rawReason: unknown, message: string, retryAfterMs?: number): void {
    if (!isWebRefusal(rawReason)) {
      this.stopped = true
      this.handlers.onConnection({
        state: 'refused',
        reason: 'proto',
        message: message || 'This desktop refused the connection for a reason this page is too old to understand.'
      })
      return
    }
    const reason = rawReason

    // Not a failure and not a shade of one: the desktop is asking a question,
    // and the screen it earns is a text box rather than an apology. Handled
    // ahead of the retry table because the answer comes from a person, so there
    // is nothing for the loop to schedule until `submitTotp` is called.
    if (reason === 'totp-required' || reason === 'totp-invalid') {
      this.stopped = true
      this.handlers.onConnection({ state: 'totp', message, invalid: reason === 'totp-invalid' })
      return
    }

    const policy = retryPolicy(reason)

    if (policy.kind === 'reauth' && !this.reauthed) {
      // One silent re-authentication. A second `bad-token` in a row means the
      // credential is not going to verify, and looping on it would be a page
      // that never says "sign in again".
      this.reauthed = true
      this.attempt = 0
      this.scheduleRetry(0)
      return
    }

    if (policy.kind === 'reauth') {
      this.stopped = true
      this.handlers.onTokenRejected()
      this.handlers.onConnection({ state: 'refused', reason, message })
      return
    }

    if (policy.kind === 'after') {
      this.handlers.onConnection({ state: 'refused', reason, message, ...(retryAfterMs ? { retryAfterMs } : {}) })
      this.scheduleRetry(retryAfterMs)
      return
    }

    this.stopped = true
    // `declined` and `timed-out` are their own states in `WebApprovalState`
    // rather than shades of `refused`, and they are surfaced as such: a human
    // said no, or nobody was there, and each screen says a different thing.
    if (reason === 'declined') {
      this.handlers.onConnection({ state: 'declined', message })
      return
    }
    if (reason === 'timed-out') {
      this.handlers.onConnection({ state: 'timed-out', message })
      return
    }
    this.handlers.onConnection({ state: 'refused', reason, message, ...(retryAfterMs ? { retryAfterMs } : {}) })
  }

  private scheduleRetry(waitMs?: number): void {
    if (this.closedByUs || this.stopped || this.retryTimer !== null) return
    const wait = waitMs ?? BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!
    this.attempt += 1
    this.handlers.onConnection({ state: 'connecting', attempt: this.attempt })
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.open()
    }, wait)
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /**
   * The page's own warmth ping. Not the heartbeat — that is the server's native
   * WebSocket ping, which this browser answers in its network stack. See
   * HEARTBEAT_MS and the note on WARM_MS.
   */
  private startBeating(): void {
    this.stopBeating()
    this.beatTimer = window.setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS)
  }

  private stopBeating(): void {
    if (this.beatTimer !== null) clearInterval(this.beatTimer)
    this.beatTimer = null
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  /**
   * Present a fresh ID token before the old one lapses.
   *
   * Firebase mints them with an hour's life and this link is meant to stay up
   * for a working day, so the credential is re-presented mid-connection rather
   * than only at `hello` (TOKEN_REFRESH_MS). A failure is not fatal here: the
   * desktop refuses a lapsed token with `bad-token` and the refusal path above
   * re-authenticates, which is one route rather than two.
   */
  private startRefreshing(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = window.setInterval(() => {
      const credentials = this.credentials
      if (!credentials) return
      void credentials
        .getToken(true)
        .then((idToken) => {
          this.rid += 1
          this.send({ type: 'auth', rid: `a${this.rid}`, idToken })
        })
        .catch(() => {
          /* the desktop will refuse the lapsed one, and that path re-authenticates */
        })
    }, TOKEN_REFRESH_MS)
  }

  private send(frame: WebClientFrame): void {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return
    this.sendFrame(socket, frame)
  }

  private sendFrame(socket: WebSocket, frame: WebClientFrame): void {
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      /* a dead socket is closed by its own close handler */
    }
  }

  /**
   * Finish with the current socket without letting it act on the way out.
   *
   * Handlers detached before `close()`, so a half-open socket cannot fire a late
   * `onclose` into a link that has already moved on and arm a second retry
   * behind it — the same care, for the same reason, as mobile's `dropSocket`.
   */
  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    this.stopBeating()
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close()
    } catch {
      /* already gone */
    }
  }

  /** Settle everything still waiting on a `rid`, because nothing is coming. */
  private failWaiting(message: string): void {
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.settle({ kind: 'failed', code: 'failed', message })
    }
    this.waiting.clear()
  }
}

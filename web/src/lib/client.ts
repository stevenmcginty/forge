import {
  HEARTBEAT_MS,
  MAX_WRITE_CHARS,
  PIN_GRACE_MS,
  TOKEN_REFRESH_MS,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  isWebRefusal,
  isWebShutdownReason,
  type WebClientFrame,
  type WebConnectionState,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebMirrorChunk,
  type WebMirrorInputFrame,
  type WebMirrorOkFrame,
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
 * `WebConnectionState` names the vocabulary — connecting, pin, live, refused,
 * offline — and shared/web.ts says why it is a vocabulary rather than a boolean:
 * each one is a different sentence with a different recovery. So this class never
 * collapses a refusal into "disconnected", and it never retries one that a retry
 * cannot fix. `retryPolicy` below is that judgement written down once, per
 * `WebRefusal`, instead of scattered through a reconnect loop.
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
 * The tag is `WebConnectionState` itself rather than a parallel enum, so a state
 * the protocol names and this client forgot to handle is a compile error.
 */
export type Connection =
  | { state: Extract<WebConnectionState, 'connecting'>; attempt: number }
  /**
   * The desktop wants its unlock PIN. `invalid` distinguishes "you have not been
   * asked yet" from "that one did not open the door" — the same screen either
   * way, but only one of them owes the person a red line.
   */
  | { state: Extract<WebConnectionState, 'pin'>; message: string; invalid: boolean; retryAfterMs?: number }
  | { state: Extract<WebConnectionState, 'live'>; desktopName: string; appVersion: string }
  | { state: Extract<WebConnectionState, 'refused'>; reason: WebRefusal; message: string; retryAfterMs?: number }
  | { state: Extract<WebConnectionState, 'offline'>; message: string; reason?: WebShutdownReason; retryAfterMs?: number }

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
  /**
   * Read the desktop's *current* address out of the rendezvous record, for a
   * retry that has already failed against the one this link was handed.
   *
   * Optional because the dev loop's loopback host is a constant and has nothing
   * to look up. Everywhere else it is the difference between working and not:
   * a cloudflared quick tunnel is a **new hostname every time it starts**, and
   * the desktop republishes within seconds — so a link that re-dials the string
   * it was constructed with re-dials a hostname that has been retired, forever,
   * against a desktop that is up and two seconds away. That is
   * indistinguishable on screen from a PC that is off: "Reconnecting to the
   * desktop (attempt 41)…".
   *
   * Only consulted on a *re*-connect (`attempt > 0`), so the first dial costs no
   * extra round trip, and an empty string means "no better answer than the one
   * you have" rather than "give up" — a failed lookup must not turn a retry loop
   * that might still succeed into one that cannot.
   */
  refindUrl?: () => Promise<string>
}

/**
 * What a refusal means for the reconnect loop.
 *
 * One table rather than a chain of ifs, because the whole value of `WebRefusal`
 * being several words instead of one string is that each has a different
 * recovery, and a recovery that only exists in prose is one the code does not
 * have.
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
    // This browser sent a blank `deviceId`, so its storage is unavailable.
    // Reconnecting would send the same blank one forever; recovery is a reload,
    // which mints one.
    case 'not-approved':
      return { kind: 'stop' }
    // Recovery is a reload; this bundle cannot become a different one.
    case 'proto':
      return { kind: 'stop' }
    case 'busy':
      return { kind: 'after' }
    // Both are answered by a human typing something, so neither is a reconnect
    // this loop can decide on its own. `submitPin` is what starts the next
    // attempt, and it carries the thing that was missing.
    case 'pin-required':
    case 'pin-invalid':
      return { kind: 'stop' }
  }
}

/* ------------------------------------------------------------ screen mirror
 *
 * The one part of this link that does not travel through `ForgeHandlers` and the
 * state provider, and the exception is deliberate.
 *
 * Everything else on this socket is *the workspace* — projects, panes, bytes,
 * git — which every screen reads and which `state.tsx` therefore owns. The
 * desktop's screen is not that. At most one surface on this page is ever
 * watching it, that surface owns a decoder and a canvas which must outlive
 * renders and must never be rebuilt by one (see web/src/lib/screen.ts), and
 * chunks arrive thirty times a second. Routing them through a React context
 * would mean either a re-render per frame or a ref that the provider holds for
 * one component's benefit — a second owner of a thing with one owner.
 *
 * So it is a pair of module-level slots instead: one for the surface that is
 * watching, and one for the live socket's own sender, filled in by the client's
 * constructor. There is exactly one `ForgeClient` per page (`state.tsx` builds it
 * once and keeps it in a ref) and exactly one viewer, which is what makes a slot
 * the honest shape rather than a shortcut — a list here would be pretending this
 * link can serve two watchers, which shared/web.ts says it cannot.
 */

/** What a surface watching the screen is told. Every one of these is a frame. */
export interface MirrorWatcher {
  /** The capture is up: configure a decoder from this and start painting. */
  onOk: (frame: WebMirrorOkFrame) => void
  onChunk: (chunk: WebMirrorChunk) => void
  /**
   * The watch is over, or is not going to happen. `needsPin` is a question
   * rather than a failure — show a PIN box and ask again with what was typed.
   */
  onStop: (reason: string, needsPin: boolean) => void
}

let watcher: MirrorWatcher | null = null
/**
 * How a frame gets *out*, without the viewer holding the client.
 *
 * A closure over the client's own private `send`, so the mirror does not add a
 * public method to this class for every frame it needs and cannot send anything
 * else through it. Rebuilt by each `ForgeClient` that is constructed, which in
 * this page is one.
 */
let sendUp: ((frame: WebClientFrame) => void) | null = null

/**
 * Take the screen slot. Returns the release, which the caller must run when its
 * surface goes away — a stale watcher would be handed the next watch's frames.
 */
export function watchMirror(next: MirrorWatcher): () => void {
  watcher = next
  return () => {
    if (watcher === next) watcher = null
  }
}

/**
 * "Show me that screen", with the unlock PIN when the desktop has asked for one.
 * An empty PIN is omitted rather than sent, so a desktop with none set sees the
 * frame it has always seen.
 */
export function askForScreen(pin: string): void {
  sendUp?.({ type: 'mirror-start', ...(pin ? { pin } : {}) })
}

/** The viewer closed. The desktop stops capturing on this frame. */
export function stopWatching(): void {
  sendUp?.({ type: 'mirror-stop' })
}

/**
 * One input, on its way to somebody's actual mouse and keyboard.
 *
 * Takes the frame's body rather than the frame, so the discriminant is written
 * in one place and a caller cannot send anything else up this path by accident.
 */
export function sendMirrorInput(input: Omit<WebMirrorInputFrame, 'type'>): void {
  sendUp?.({ type: 'mirror-input', ...input })
}

/* ------------------------------------------------------------------- class */

export class ForgeClient {
  private readonly handlers: ForgeHandlers
  private credentials: ForgeCredentials | null = null
  private socket: WebSocket | null = null
  /**
   * True from the first line of `open()` until it has either handed a socket
   * over or given up, which is the one window `this.socket` cannot describe.
   *
   * `open()` awaits a token and then, on a retry, a tunnel lookup — two network
   * round trips during which the old socket has been dropped and the new one
   * does not exist. A readyState test taken in that window reads `undefined`
   * and says "nothing here, dial", so anything that re-dials on an event opens
   * a *second* socket beside the one already being built. See `linkInHand`.
   */
  private opening = false
  /**
   * Which dial the live socket belongs to, so a socket from an older one can
   * recognise itself as superseded.
   *
   * The guard above is the fix; this is the belt to its braces. Every handler
   * captures the counter's value at the moment its socket was adopted and
   * stands down when it no longer matches, so a socket that somehow outlives
   * its dial is inert rather than a second voice on the link — and it matters
   * that it is inert rather than merely untidy, because two sockets both
   * delivering `data` write every byte into xterm twice, and a TUI redraw
   * applied twice repaints the frame down the screen instead of over itself.
   */
  private generation = 0
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
  /** The unlock PIN for the *next* hello only. See `submitPin`. */
  private pin = ''
  /**
   * A PIN that already opened the door, held in RAM so a reconnect after the
   * tab was hidden (a phone switching apps) can answer without a re-prompt.
   * Never written down; forgotten after PIN_GRACE_MS hidden, on a wrong PIN,
   * and on sign-out. See PIN_GRACE_MS in shared/web.ts.
   */
  private rememberedPin = ''
  /** The PIN this attempt is carrying, remembered on `hello-ok` only. */
  private sentPin = ''
  /** When the tab last went hidden, or 0 while it is visible. */
  private pinHiddenAt = 0

  constructor(handlers: ForgeHandlers) {
    this.handlers = handlers
    // The outbound half of the screen-mirror slot pair above. A closure rather
    // than the instance, so nothing outside this file can reach the rest of the
    // client through it.
    sendUp = (frame) => this.send(frame)
    this.watchPinGrace()
    this.watchWakeups()
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
    // A second press while the first is still crossing the network is the same
    // race the wake-ups make, so it stands down for the same reason — and it
    // loses nothing: every screen with this button on it is a screen the
    // desktop hung up on, so the socket is already gone by the time a person
    // can reach for it, and a dial in flight is the press being answered.
    if (this.linkInHand()) return
    void this.open()
  }

  /**
   * A human typed the unlock PIN. Reconnect, carrying it.
   *
   * Held for this `hello` and dropped in `open()`, whatever the desktop makes
   * of it. A *wrong* one is forgotten immediately so it cannot be replayed as
   * a lockout strike. A right one is remembered in RAM (see `rememberedPin`)
   * so a phone that drops its socket on an app switch does not re-prompt for
   * PIN_GRACE_MS. Never written to disk; a reload forgets it.
   */
  submitPin(pin: string): void {
    if (!this.credentials) return
    this.pin = pin.trim()
    this.retry()
  }

  disconnect(): void {
    this.closedByUs = true
    this.clearRetry()
    this.dropSocket()
    this.subs.clear()
    this.forgetPin()
    this.failWaiting('The link to the desktop closed.')
  }

  /**
   * The PIN this `hello` should carry: a just-typed one, or a successful one
   * still inside the grace window. Clears the one-shot either way.
   */
  private pinForHello(): string {
    const typed = this.pin
    this.pin = ''
    const pin = typed || this.liveRememberedPin()
    this.sentPin = pin
    return pin
  }

  private liveRememberedPin(): string {
    if (!this.rememberedPin) return ''
    if (this.pinHiddenAt && Date.now() - this.pinHiddenAt > PIN_GRACE_MS) {
      this.forgetPin()
      return ''
    }
    return this.rememberedPin
  }

  private forgetPin(): void {
    this.rememberedPin = ''
    this.sentPin = ''
    this.pin = ''
  }

  private watchPinGrace(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pinHiddenAt = Date.now()
        return
      }
      if (this.pinHiddenAt && Date.now() - this.pinHiddenAt > PIN_GRACE_MS) this.forgetPin()
      this.pinHiddenAt = 0
    })
  }

  /**
   * Come back the moment the machine does, rather than at the back-off's leisure.
   *
   * The retry loop exists to ride out a link that is down *somewhere between
   * here and the desktop*. Two events say the fault was on this side and is now
   * gone: `online` (the radio came back) and a return to visibility with a dead
   * or closing socket (a phone coming out of an app switch that dropped the
   * connection). Waiting out up to fifteen seconds of scheduled back-off after
   * either is time paid for nothing, so both clear the timer and dial now.
   *
   * A live or still-opening link stands down: those events also fire on a tab
   * merely being looked at again, and `open` would hang up on a working link to
   * open another one. Neither listener decides that for itself — both hand
   * straight to `wake`, which asks `linkInHand` once, because the version of
   * this that tested the socket here was the version that could not see a dial
   * already in flight and opened a second one.
   */
  private watchWakeups(): void {
    window.addEventListener('online', () => this.wake())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      this.wake()
    })
  }

  /** One immediate re-dial, if there is anything to dial and nothing live. */
  private wake(): void {
    if (this.closedByUs || this.stopped || !this.credentials) return
    if (this.linkInHand()) return
    this.clearRetry()
    void this.open()
  }

  /**
   * Is a link already in hand, or on its way?
   *
   * The one question every re-dial path asks, written once because the answer
   * has two halves and a caller that remembers only one of them opens a second
   * socket. The readyState covers a link that exists; `opening` covers the
   * stretch inside `open()` where it does not yet, which is where this went
   * wrong: a phone fires `online` and `visibilitychange` in bursts, each one
   * landing while the previous dial was still waiting on a token, each one
   * seeing a null socket and dialling again. The loser of that race was never
   * hung up on, so both sockets said `hello`, both were let in, both re-attached
   * every pane, and every byte the desktop pushed was written into the terminal
   * twice — which for a cursor-addressed redraw means the frame is repainted
   * below itself, forever.
   */
  private linkInHand(): boolean {
    if (this.opening) return true
    const ready = this.socket?.readyState
    return ready === WebSocket.OPEN || ready === WebSocket.CONNECTING
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

  /**
   * Dial the desktop. At most one of these is ever in flight; see `opening`.
   *
   * The whole body sits in a `try/finally` for that flag alone. There are five
   * ways out of here — signed out, a token that failed, a page that moved on
   * under either await, a constructor that threw, and the ordinary end — and a
   * flag cleared at each of them is a flag that will be left set the day a
   * sixth is added, which would wedge the reconnect loop shut for good.
   */
  private async open(): Promise<void> {
    const credentials = this.credentials
    if (!credentials || this.closedByUs || this.stopped) return

    this.opening = true
    try {
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

      // Ask where the desktop is *now* before re-dialling where it was. See
      // `refindUrl`: the address a tunnel publishes does not survive the tunnel
      // restarting, and this loop would otherwise never learn that.
      if (this.attempt > 0 && credentials.refindUrl) {
        let fresh = ''
        try {
          fresh = await credentials.refindUrl()
        } catch {
          // A lookup that failed says nothing about the address in hand.
        }
        if (this.closedByUs || this.stopped) return
        // Adopted without resetting `attempt`, which is not the obvious choice
        // and is the right one. A new address does look like a fresh start worth
        // a fresh backoff — but a cloudflared quick tunnel that is *flapping*
        // publishes a new hostname every time it comes up, so zeroing the counter
        // here meant every retry saw a new URL, took `BACKOFF[0]` again, and
        // strobed the page against a tunnel that was never up long enough to
        // reach. The backoff exists to survive exactly that, and a moving target
        // is not grounds to abandon it.
        if (fresh && fresh !== credentials.url) credentials.url = fresh
      }

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
      // Stamped on the socket the moment it is adopted, and captured by every
      // handler below. See `generation`.
      const generation = (this.generation += 1)
      this.lastFrameAt = Date.now()

      /**
       * Has this socket been replaced since it was adopted? Then it is not this
       * link's voice any more and must not act: not on the terminal, not on the
       * reconnect loop, not on the watcher. It hangs itself up on the way out,
       * because a socket left listening is a socket the desktop is still
       * pushing bytes down.
       */
      const superseded = (): boolean => {
        if (generation === this.generation) return false
        this.retire(socket)
        return true
      }

      // Spent on this attempt and this attempt only, whatever comes of it — read
      // before `onopen` so a socket that never opens still burns the one-shot
      // rather than leaving a stale typed PIN to be replayed by the reconnect
      // loop. A previously-successful PIN may still ride along; see `pinForHello`.
      const pin = this.pinForHello()

      socket.onopen = () => {
        if (superseded()) return
        this.lastFrameAt = Date.now()
        // No ping until `hello-ok`. The desktop honours *nothing* but `hello`
        // before a browser has been let in — it answers anything else with an
        // `error` frame and closes the socket (see `handle` in
        // electron/web/server.ts) — so a beat started here would hang up on this
        // desktop while its answer to the `hello` was still being decided, which
        // on a machine that has to verify a token against Google's keys and then
        // run a PIN through scrypt is not a moment. The pre-`hello-ok` socket does
        // not need one: the *real* heartbeat is the native WebSocket ping, which
        // the browser answers in its network stack whether or not the page has
        // been admitted.
        this.sendFrame(socket, {
          type: 'hello',
          proto: WEB_PROTO,
          idToken,
          client: __WEB_CLIENT_VERSION__,
          deviceId: credentials.deviceId,
          deviceName: credentials.deviceName,
          // Omitted entirely rather than sent empty: the field is optional in the
          // protocol, the first `hello` of every sign-in carries no PIN by design,
          // and a desktop with none set should see a frame that looks exactly like
          // it always did.
          ...(pin ? { pin } : {})
        })
      }

      socket.onmessage = (event) => {
        // A frame from a superseded socket is dropped rather than handled. It
        // would otherwise be a `data` frame written into a terminal that has
        // already had the same bytes from the live socket, or a `hello-ok` that
        // re-attaches every pane a second time.
        if (superseded()) return
        this.receive(String(event.data))
      }

      socket.onclose = () => {
        // A superseded socket closing is the sound of it being tidied away, not
        // of this link dropping, so it arms no retry and tells nobody.
        if (superseded()) return
        this.socket = null
        this.stopBeating()
        this.failWaiting('The link to the desktop dropped before that answered.')
        // A watcher hears about it here rather than working it out from a picture
        // that stopped moving: a decoder holding a last frame looks exactly like a
        // desktop that is sitting still, and the two want different sentences. A
        // reconnect does not resume a watch — the desktop tore its capture down
        // with the socket — so this is an ending, not a pause.
        watcher?.onStop('The link to the desktop dropped, so the picture stopped.', false)
        if (this.closedByUs || this.stopped) return
        this.scheduleRetry()
      }

      socket.onerror = () => {
        if (superseded()) return
        /* onclose always follows; retrying is decided there */
      }
    } finally {
      this.opening = false
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
        if (this.sentPin) this.rememberedPin = this.sentPin
        this.sentPin = ''
        this.handlers.onPicture(frame)
        this.handlers.onConnection({ state: 'live', desktopName: frame.desktopName, appVersion: frame.appVersion })
        // Both timers start here rather than at `onopen`, because this frame is
        // the first moment the desktop will accept a frame that is not `hello`.
        this.startBeating()
        this.startRefreshing()
        // Re-arm every pane the UI still believes it is watching. Each answers
        // with a replay frame, which is what repaints the terminal.
        for (const [sessionId, size] of this.subs) {
          this.send({ type: 'attach', sessionId, ...(size ? { cols: size.cols, rows: size.rows } : {}) })
        }
        return
      }

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
        // `unknown-session` about a named pane is the desktop saying that pane
        // no longer exists, which is the same news as `exit` arriving by another
        // road — a pane closed at the desk while this browser was away never
        // gets an `exit`, because there was no socket to send it down. So it is
        // forgotten here too. Leaving it in `subs` meant re-attaching a dead
        // pane on every single reconnect and re-earning this notice each time,
        // for as long as the tab stayed open.
        if (frame.code === 'unknown-session' && typeof frame.sessionId === 'string') {
          this.subs.delete(frame.sessionId)
        }
        // Only `message` is meant to be shown; the codes exist so a client can
        // decide whether to retry or re-sync, not so it can compose a sentence.
        if (typeof frame.message === 'string' && frame.message) this.handlers.onNotice(frame.message)
        return

      /* --------------------------------------------------- screen mirror
       *
       * Straight to the surface that is watching, without passing through the
       * page's state — see the slot pair above. A frame arriving with nobody
       * watching is dropped in silence: it is the ordinary shape of a viewer
       * that closed while a chunk was in flight, and the desktop has already
       * been told to stop by the `mirror-stop` that closing sent.
       */

      case 'mirror-ok':
        watcher?.onOk(frame)
        return

      case 'mirror-frame':
        watcher?.onChunk(frame)
        return

      case 'mirror-stop':
        watcher?.onStop(
          typeof frame.reason === 'string' && frame.reason ? frame.reason : 'The desktop stopped sharing its screen.',
          frame.needsPin === true
        )
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
    // is nothing for the loop to schedule until `submitPin` is called.
    if (reason === 'pin-required' || reason === 'pin-invalid') {
      this.stopped = true
      // A wrong PIN must not be replayed — each replay is a strike. A missing
      // PIN is the ordinary first ask and leaves `rememberedPin` empty anyway.
      if (reason === 'pin-invalid') this.forgetPin()
      // A lockout that arrives on the pin path still carries its window, and
      // the pin screen is where the countdown belongs — see PinPrompt.
      this.handlers.onConnection({
        state: 'pin',
        message,
        invalid: reason === 'pin-invalid',
        ...(retryAfterMs ? { retryAfterMs } : {})
      })
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
      // Silently, or the refusal is erased by the thing that acts on it:
      // `scheduleRetry` announces `connecting` the instant it is called, in the
      // same React batch, so the screen that carries the desktop's sentence and
      // the "worth trying again in 60s" line never rendered at all. What was
      // shown instead was a rising attempt count against a desktop that had
      // just said, in words, what was wrong with it. The `connecting` screen
      // still arrives — from `open`, when the wait is actually up.
      this.scheduleRetry(retryAfterMs, false)
      return
    }

    this.stopped = true
    this.handlers.onConnection({ state: 'refused', reason, message, ...(retryAfterMs ? { retryAfterMs } : {}) })
  }

  /**
   * `announce` is false only where the caller has just put a *better* screen up
   * — see the `after` branch of `onRefused`. It does not change what the loop
   * does, only whether it overwrites a sentence somebody needs to read.
   */
  private scheduleRetry(waitMs?: number, announce = true): void {
    if (this.closedByUs || this.stopped || this.retryTimer !== null) return
    const wait = waitMs ?? BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!
    this.attempt += 1
    if (announce) this.handlers.onConnection({ state: 'connecting', attempt: this.attempt })
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
        .getToken(false)
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
    this.retire(socket)
  }

  /**
   * Hang up on one socket and take its voice away, wherever it was found.
   *
   * The body of `dropSocket`, split out because a socket that discovers it has
   * been superseded needs exactly this and is by definition no longer
   * `this.socket`, so it cannot go through `dropSocket` to get it. One hang-up
   * in the file rather than two that have to be kept saying the same thing.
   */
  private retire(socket: WebSocket): void {
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

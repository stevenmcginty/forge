import {
  APPROVAL_TIMEOUT_MS,
  MAX_SIGNAL_CHARS,
  MOBILE_PROTO,
  MOBILE_WS_PATH,
  type ClientFrame,
  type HelloFrame,
  type HelloOkFrame,
  type MirrorInputFrame,
  type MobileSession,
  type ServerFrame
} from '@shared/mobile'
import type { AgentProfile, Project, Workspace } from '@shared/types'

/**
 * The phone's end of the Forge Mobile link.
 *
 * One socket, reconnected forever with backoff, because a phone's network is
 * not a desk's: it drops in lifts, changes cell on a train, and sleeps whenever
 * the screen does. Every design decision here follows from that.
 *
 *  - **Subscriptions survive a reconnect.** The set of session ids is kept on
 *    this side and re-sent after every `hello-ok`, so a dropped socket repaints
 *    itself instead of leaving a dead terminal on screen.
 *  - **Replay is the repaint.** The desktop answers every `sub` with its 192KB
 *    catch-up buffer before any live data, so the phone never has to ask "what
 *    did I miss" — see `getReplay` in electron/pty-host.ts.
 *  - **The token is held by the caller**, not by this class, so it can live in
 *    Android's Keystore rather than in a closure.
 *  - **A link that has been asleep is assumed broken until it says otherwise.**
 *    Android freezes a backgrounded WebView's timers — so a pending retry can
 *    still be pending an hour later — and tears down the TCP connection under
 *    a socket that goes on reporting `OPEN` and firing nothing. Neither failure
 *    announces itself, so this class carries its own heartbeat and treats every
 *    wake-shaped event as a reason to re-check (`nudge`).
 *  - **No token is itself a way to connect.** Credentials with an empty token
 *    send `requestPair` instead of failing: the desktop raises a prompt on its
 *    own screen and answers `awaiting-approval` with the word pair both screens
 *    show. That wait is bounded by APPROVAL_TIMEOUT_MS on this side too —
 *    a phone left face-up on the waiting screen must eventually say "nobody
 *    answered" rather than spin — and it ends in a deliberate, non-retrying
 *    stop, because fresh words should cost a tap, not appear on a loop.
 *
 * Deliberately not an EventEmitter or a store: a phone app with one socket
 * needs callbacks, not an architecture.
 */

export type LinkState = 'idle' | 'connecting' | 'live' | 'retrying' | 'refused' | 'awaiting' | 'expired'

export interface LinkPicture {
  appVersion: string
  deviceName: string
  projects: Project[]
  profiles: AgentProfile[]
  workspaces: Record<string, Workspace>
  sessions: MobileSession[]
  /**
   * Whether that desktop will act on `mirror-input` — the remote as a mouse.
   *
   * False for every desktop older than the feature and every desktop whose
   * owner has not switched it on, which are the same thing from here. The TV's
   * mirror hides the cursor entirely when this is false; offering one and
   * having it move on the television alone is the failure mode worth designing
   * out, because from a sofa it is indistinguishable from a broken desktop.
   */
  canControl: boolean
}

export interface LinkHandlers {
  /**
   * Connection state changed. `detail` carries the reason on 'refused' and
   * 'expired', and the word pair on 'awaiting' — the desktop minted the words
   * and this side only displays them, so the frame's string is passed through
   * untouched.
   */
  onState: (state: LinkState, detail: string) => void
  /** The desktop's picture — on connect, and again whenever it changes. */
  onPicture: (picture: LinkPicture) => void
  /** Terminal bytes. `replay` marks the catch-up buffer, which must clear first. */
  onData: (id: string, data: string, replay: boolean) => void
  /** A session's shell exited. The code rides along for the TV bridge. */
  onExit: (id: string, exitCode: number) => void
  /** Pairing succeeded and this token must be stored. Fires at most once. */
  onPaired: (token: string) => void
  /** Something the user should see — a refused op, a session that vanished. */
  onNotice: (message: string) => void
  /**
   * The desktop relayed a video for the TV (see TvPlayFrame). Already held to
   * the 11-character id shape by `receive` — what arrives here is playable,
   * not merely parseable. Only the TV route does anything with it.
   */
  onTvPlay: (video: string) => void
  /**
   * One WebRTC signaling payload for the screen mirror — an SDP or an ICE
   * candidate, as an opaque JSON string. Held to `MAX_SIGNAL_CHARS` and to
   * being a string by `receive`; its *meaning* is lib/mirror.ts's business,
   * and nothing between the two peers reads it.
   */
  onMirrorSignal: (data: string) => void
  /**
   * The mirror is over, and here is why — the desktop's sentence when it has
   * one ("no Forge window is open", "another screen is already watching"), and
   * '' when it does not.
   *
   * Also fired by this class when the socket dies under a live mirror. That is
   * not a reconnect concern this side can paper over: the peer connection was
   * negotiated *through* this link, so a link that drops takes the video with
   * it, and there is no arrangement in which frames keep arriving. Terminal
   * subscriptions are re-armed after a reconnect; a mirror is deliberately not,
   * because silently restarting a watch is not repair — it is a television
   * turning itself back on.
   */
  onMirrorStop: (reason: string) => void
}

export interface LinkCredentials {
  /** `ws://host:port` — no path; this class appends it. */
  origin: string
  /**
   * A device token, or a pairing code on the very first connection. Empty
   * means "ask to be let in": `hello` goes out with `requestPair` instead of
   * a token, and the desktop decides on its own screen.
   */
  token: string
  deviceId: string
  deviceName: string
}

/** Backoff schedule, in ms. Caps rather than growing forever. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]

/**
 * The client heartbeat. The desktop already pings an idle socket every 20s and
 * gives it 10s to answer (HEARTBEAT_MS in shared/mobile.ts); this is the same
 * arrangement pointing the other way, because the half of the link that goes
 * quiet without saying so is usually the phone's.
 *
 * `SILENCE_MS` is judged against a *timestamp*, never a count of ticks: Android
 * throttles a backgrounded WebView's timers to minutes apart, so "three ticks
 * with no answer" can mean three seconds or three minutes. A clock cannot be
 * throttled.
 */
const PING_MS = 15_000
const SILENCE_MS = 30_000

/** After a resume ping, how long the socket has to say anything at all. */
const VERDICT_MS = 4_000

/** A connect still unresolved this long after a resume was frozen mid-dial. */
const STUCK_MS = 10_000

export class Link {
  private socket: WebSocket | null = null
  private credentials: LinkCredentials | null = null
  private readonly handlers: LinkHandlers
  private subscriptions = new Set<string>()
  private attempt = 0
  private retryTimer: number | null = null
  private closedByUs = false
  private picture: LinkPicture | null = null
  /** When anything last arrived on this socket. The liveness clock. */
  private lastFrameAt = 0
  /**
   * How many frames have arrived, ever. Only its *changing* matters: "did
   * anything answer my ping" is a question about sequence, not about time, and
   * two frames inside the same millisecond would make a timestamp say no.
   */
  private received = 0
  private beatTimer: number | null = null
  private verdictTimer: number | null = null
  /** When the current socket started dialling, for the stuck-connect check. */
  private openedAt = 0
  /** The desktop said no (4001–4003). A wake nudge must not re-knock. */
  private refused = false
  private listening = false
  /**
   * An `awaiting-approval` frame is on screen. While set, the silence rule is
   * suspended — the socket is *supposed* to be quiet while Steve reads the
   * prompt, and hanging up on that quiet would re-dial, re-request, and mint
   * a fresh word pair every 30 seconds, right under the eyes of someone
   * comparing the old one. The wait is bounded by `approvalTimer` instead.
   */
  private awaiting = false
  private approvalTimer: number | null = null
  /**
   * A screen mirror is believed to be running. Kept here rather than in the UI
   * because the socket's death is this class's news to break: every route out
   * of a socket funnels through `endMirror`, so the watching screen is told
   * exactly once however the link ended.
   */
  private mirroring = false

  constructor(handlers: LinkHandlers) {
    this.handlers = handlers
  }

  get sessions(): MobileSession[] {
    return this.picture?.sessions ?? []
  }

  connect(credentials: LinkCredentials): void {
    this.credentials = credentials
    this.closedByUs = false
    this.refused = false
    this.attempt = 0
    this.listen()
    this.open()
  }

  disconnect(): void {
    this.closedByUs = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.unlisten()
    this.dropSocket()
    this.subscriptions.clear()
    this.handlers.onState('idle', '')
  }

  /**
   * "The phone is awake again — is this link real?"
   *
   * Called on every wake-shaped browser event (see `listen`), which on a real
   * resume all fire within milliseconds of each other. Each branch is therefore
   * written to collapse a storm into one attempt: a pending retry is claimed by
   * the first call and the rest find no timer; an open socket is pinged by the
   * first call and the rest find a verdict already armed; a fresh dial is young
   * enough that the rest leave it alone.
   */
  nudge(): void {
    // Unpaired, or told no by the desktop. Neither is a state a resume fixes,
    // and re-knocking on every focus event is how a revoked phone becomes a
    // battery complaint.
    if (this.closedByUs || this.refused || !this.credentials) return

    // A backoff timer that was frozen with the app has already waited long
    // enough — the wait it was measuring happened while the screen was off.
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.attempt = 0
      this.open()
      return
    }

    const socket = this.socket
    if (!socket) {
      this.attempt = 0
      this.open()
      return
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      // A dial frozen mid-handshake can sit in CONNECTING forever; a young one
      // is simply in progress and must be left alone.
      if (Date.now() - this.openedAt > STUCK_MS) {
        this.attempt = 0
        this.open()
      }
      return
    }

    if (socket.readyState === WebSocket.OPEN) {
      // An approval wait is not a stale link — reopening it would spend the
      // words on screen and mint different ones the moment the phone wakes.
      if (this.awaiting) return
      if (this.verdictTimer !== null) return
      const mark = this.received
      this.send({ t: 'ping' })
      this.verdictTimer = window.setTimeout(() => {
        this.verdictTimer = null
        // Not "is the last frame recent" but "did *anything* arrive since the
        // ping": a socket that was busy a second ago still looks recent.
        if (this.received === mark) {
          this.attempt = 0
          this.open()
        }
      }, VERDICT_MS)
      return
    }

    // CLOSING or CLOSED, and no retry armed: the `onclose` that would have
    // armed one never came, which is exactly the state this method exists for.
    this.attempt = 0
    this.open()
  }

  /** Watch a session. Idempotent, and remembered across reconnects. */
  subscribe(id: string): void {
    if (this.subscriptions.has(id)) return
    this.subscriptions.add(id)
    this.send({ t: 'sub', id })
  }

  unsubscribe(id: string): void {
    if (!this.subscriptions.delete(id)) return
    this.send({ t: 'unsub', id })
  }

  write(id: string, data: string): void {
    this.send({ t: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows })
  }

  op(op: Omit<Extract<ClientFrame, { t: 'op' }>, 't'>): void {
    this.send({ t: 'op', ...op })
  }

  /**
   * "Play this on the TV." The desktop relays it to every other paired device,
   * so what happens next is the television's business, not this phone's — there
   * is no acknowledgement to wait for and nothing here to render.
   */
  tvPlay(video: string): void {
    this.send({ t: 'tv-play', video })
  }

  /* --------------------------------------------------------- screen mirror */

  /**
   * "Show me the desktop's screen." The answer arrives as `mirror-signal`
   * frames, or as a `mirror-stop` carrying the reason it cannot.
   *
   * Not remembered across reconnects, unlike `subscribe` — see onMirrorStop.
   */
  startMirror(): void {
    this.mirroring = true
    this.send({ t: 'mirror-start' })
  }

  /** One SDP or candidate on its way up. Opaque to everything in between. */
  sendMirrorSignal(data: string): void {
    this.send({ t: 'mirror-signal', data })
  }

  /** This side has finished watching. Silent: the caller already knows. */
  stopMirror(): void {
    this.mirroring = false
    this.send({ t: 'mirror-stop' })
  }

  /**
   * One press, move or turn of the wheel, for the desktop being watched.
   *
   * Fire and forget, like `tvPlay`: there is no acknowledgement worth waiting
   * for at sixty frames a second, and the answer to "did it work" is the
   * picture on the television a moment later. A refusal — control switched off
   * at the desk — comes back as an ordinary `err`, on `onNotice`.
   *
   * Dropped on the floor when no mirror is running. A pointer event for a
   * picture that has ended is not something the desktop should be asked to
   * perform, and this class is the one place that knows the difference.
   */
  sendMirrorInput(input: MirrorInputFrame): void {
    if (!this.mirroring) return
    this.send(input)
  }

  /* -------------------------------------------------------------- internals */

  private open(): void {
    const credentials = this.credentials
    if (!credentials) return

    // Whatever was there is finished with: detached, closed, and unable to
    // schedule anything behind this new socket's back.
    this.dropSocket()
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'retrying', '')

    let socket: WebSocket
    try {
      socket = new WebSocket(`${credentials.origin}${MOBILE_WS_PATH}`)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket
    this.openedAt = Date.now()
    this.lastFrameAt = Date.now()

    socket.onopen = () => {
      this.lastFrameAt = Date.now()
      this.startBeating()
      // No token is not a malformed hello, it is a different request: ask
      // Steve. `requestPair` raises a prompt on the desktop's screen and the
      // answer comes back as `awaiting-approval` — or as a close with a
      // sentence, never as a silent auth failure against an empty string.
      const hello: HelloFrame = {
        t: 'hello',
        proto: MOBILE_PROTO,
        deviceId: credentials.deviceId,
        deviceName: credentials.deviceName,
        ...(credentials.token ? { token: credentials.token } : { requestPair: true })
      }
      socket.send(JSON.stringify(hello))
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onclose = (event) => {
      this.socket = null
      this.stopBeating()
      this.stopWaitingForApproval()
      this.endMirror('The link to the desktop dropped, so the picture stopped.')
      if (this.closedByUs) return
      // 4001/4002/4003 are the desktop saying no — retrying would be a loop
      // against a door that is not going to open, and would burn the phone's
      // battery doing it.
      if (event.code >= 4001 && event.code <= 4003) {
        this.refused = true
        this.handlers.onState('refused', event.reason || 'The desktop refused the connection.')
        return
      }
      this.scheduleRetry()
    }

    socket.onerror = () => {
      /* onclose always follows; retrying is decided there */
    }
  }

  private scheduleRetry(): void {
    if (this.closedByUs || this.retryTimer !== null) return
    const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!
    this.attempt += 1
    this.handlers.onState('retrying', `Reconnecting in ${Math.round(wait / 1000)}s…`)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, wait)
  }

  /* -------------------------------------------------------- staying alive */

  /**
   * Poke an idle socket, and hang up on one that has stopped answering.
   *
   * The hang-up is deliberate rather than hopeful: a WebSocket over a TCP
   * connection Android tore down while the screen was off can stay `OPEN`
   * forever, firing no `onclose` and delivering nothing. Silence past
   * `SILENCE_MS` — two missed pings plus grace — is the only evidence of that
   * there is, so it is treated as the close the socket never sent.
   */
  private startBeating(): void {
    this.stopBeating()
    this.beatTimer = window.setInterval(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      // Not while an approval is pending: that socket is quiet by design, and
      // its deadline is APPROVAL_TIMEOUT_MS, not the silence rule.
      if (!this.awaiting && Date.now() - this.lastFrameAt > SILENCE_MS) {
        this.dropSocket()
        this.scheduleRetry()
        return
      }
      this.send({ t: 'ping' })
    }, PING_MS)
  }

  private stopBeating(): void {
    if (this.beatTimer === null) return
    clearInterval(this.beatTimer)
    this.beatTimer = null
  }

  /**
   * The approval wait is over — approved, denied, hung up, or abandoned.
   * Every path off the waiting screen funnels through here so no orphaned
   * timer can fire "expired" over the top of a link that already moved on.
   */
  private stopWaitingForApproval(): void {
    this.awaiting = false
    if (this.approvalTimer === null) return
    clearTimeout(this.approvalTimer)
    this.approvalTimer = null
  }

  /**
   * The mirror is over. Told once, whichever way it ended.
   *
   * A peer connection cannot outlive the channel it was negotiated over, so
   * the socket going away *is* the end of the video — and a reconnect must not
   * quietly start a new one. Re-arming subscriptions repaints a terminal
   * nobody has to notice; re-arming a mirror would put a live picture of the
   * desk back on a television long after whoever pressed OK had walked away.
   */
  private endMirror(reason: string): void {
    if (!this.mirroring) return
    this.mirroring = false
    this.handlers.onMirrorStop(reason)
  }

  /**
   * Finish with the current socket, without letting it act on the way out.
   *
   * The handlers are detached before `close()` so a half-open socket cannot
   * fire a late `onclose` into a link that has already moved on and arm a
   * second retry behind it. Retrying is the caller's decision, made here in the
   * open, rather than a side effect arriving whenever the browser gives up.
   */
  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    this.stopBeating()
    this.stopWaitingForApproval()
    this.endMirror('The link to the desktop dropped, so the picture stopped.')
    if (this.verdictTimer !== null) {
      clearTimeout(this.verdictTimer)
      this.verdictTimer = null
    }
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close()
    } catch {
      /* already gone; there is nothing to close */
    }
  }

  /**
   * The wake signals, all four of them.
   *
   * No Capacitor plugin: `visibilitychange` is what the WebView actually fires
   * when Android brings the app back, `online` covers wifi returning without
   * the app ever having left the screen, and `focus`/`pageshow` catch the
   * browser route and a WebView restored from the back-forward cache. They
   * overlap heavily on purpose — `nudge` is built to be called four times.
   */
  private listen(): void {
    if (this.listening) return
    this.listening = true
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('online', this.onWake)
    window.addEventListener('focus', this.onWake)
    window.addEventListener('pageshow', this.onWake)
  }

  private unlisten(): void {
    if (!this.listening) return
    this.listening = false
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('online', this.onWake)
    window.removeEventListener('focus', this.onWake)
    window.removeEventListener('pageshow', this.onWake)
  }

  // Bound once, so removeEventListener can find the same function again.
  private readonly onWake = (): void => this.nudge()
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.nudge()
  }

  private receive(raw: string): void {
    // Before parsing, and whatever the frame turns out to be: bytes arriving
    // *are* the liveness signal. That includes the `pong` the desktop sends
    // back for no other reason than this.
    this.lastFrameAt = Date.now()
    this.received += 1

    let frame: ServerFrame
    try {
      frame = JSON.parse(raw) as ServerFrame
    } catch {
      return
    }

    switch (frame.t) {
      case 'hello-ok': {
        this.attempt = 0
        this.stopWaitingForApproval()
        // A token is issued exactly once, on the connection that paired. Store
        // it before anything else can go wrong, or the pairing is lost and the
        // single-use code is already spent.
        if (frame.deviceToken) {
          if (this.credentials) this.credentials.token = frame.deviceToken
          this.handlers.onPaired(frame.deviceToken)
        }
        this.picture = pictureOf(frame)
        this.handlers.onPicture(this.picture)
        this.handlers.onState('live', '')
        // Re-arm every subscription the UI still believes it has. Each answers
        // with a replay frame, which is what repaints the terminal.
        for (const id of this.subscriptions) this.send({ t: 'sub', id })
        return
      }

      case 'awaiting-approval': {
        // Steve is being asked. The words are shown exactly as sent — the
        // desktop minted them, and both screens rendering the same string is
        // the entire anti-confusion property (see AwaitingApprovalFrame).
        //
        // The wait gets a deadline because this socket is open and
        // unauthenticated for its whole duration: when nobody answers, the
        // phone must say so and stop, not spin until the battery decides.
        // The stop is deliberate (`closedByUs`) rather than a retry, so fresh
        // words cost a tap on Connect instead of appearing on a loop.
        this.stopWaitingForApproval()
        this.awaiting = true
        this.approvalTimer = window.setTimeout(() => {
          this.approvalTimer = null
          this.awaiting = false
          this.closedByUs = true
          this.dropSocket()
          this.handlers.onState('expired', 'Nobody answered on the desktop, so those words have expired.')
        }, APPROVAL_TIMEOUT_MS)
        this.handlers.onState('awaiting', frame.words)
        return
      }

      case 'replay':
        this.handlers.onData(frame.id, frame.data, true)
        return

      case 'data':
        this.handlers.onData(frame.id, frame.data, false)
        return

      case 'exit':
        this.subscriptions.delete(frame.id)
        // Coerced, not trusted: the frame is typed but the wire is not.
        this.handlers.onExit(frame.id, typeof frame.exitCode === 'number' ? frame.exitCode : 0)
        return

      case 'state': {
        if (!this.picture) return
        this.picture = {
          ...this.picture,
          ...(frame.projects ? { projects: frame.projects } : {}),
          ...(frame.sessions ? { sessions: frame.sessions } : {}),
          ...(frame.workspace
            ? {
                workspaces: {
                  ...this.picture.workspaces,
                  [frame.workspace.projectId]: frame.workspace.workspace
                }
              }
            : {})
        }
        this.handlers.onPicture(this.picture)
        return
      }

      case 'err':
        // `unknown-session` is normal churn — a pane closed at the desk while
        // the phone still had it on screen — so it drops the subscription
        // rather than shouting about it.
        if (frame.code === 'unknown-session') {
          this.handlers.onNotice('That pane is no longer open.')
          return
        }
        this.handlers.onNotice(frame.msg)
        return

      case 'tv-play':
        // The id came off the wire via a phone and a relay; only the exact
        // YouTube id shape is let through, and anything else is dropped here
        // rather than handed to an iframe src.
        if (typeof frame.video === 'string' && /^[A-Za-z0-9_-]{11}$/.test(frame.video)) {
          this.handlers.onTvPlay(frame.video)
        }
        return

      case 'mirror-signal':
        // Opaque the whole way: the desktop wrote it, the relay never read it,
        // and this side checks only that it is a string of a plausible size
        // before handing it to a parser (lib/mirror.ts) built to be total
        // against anything it cannot understand.
        if (typeof frame.data === 'string' && frame.data.length <= MAX_SIGNAL_CHARS) {
          this.handlers.onMirrorSignal(frame.data)
        }
        return

      case 'mirror-stop':
        // The desktop's own ending, so its sentence goes through untouched —
        // "no Forge window is open" is the whole answer, and this side has no
        // better one. `endMirror` would swallow it as a duplicate, hence the
        // flag is cleared here rather than by it.
        this.mirroring = false
        this.handlers.onMirrorStop(typeof frame.reason === 'string' ? frame.reason : '')
        return

      case 'pong':
        return
    }
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(frame))
  }
}

function pictureOf(frame: HelloOkFrame): LinkPicture {
  return {
    appVersion: frame.appVersion,
    deviceName: frame.deviceName,
    projects: frame.projects,
    profiles: frame.profiles,
    workspaces: frame.workspaces,
    sessions: frame.sessions,
    // `=== true` and nothing looser. This decides whether a screen offers to
    // drive somebody's desktop, and the only value that should reach it is a
    // desktop that said so in as many words.
    canControl: frame.canControl === true
  }
}

/**
 * A stable per-install id.
 *
 * `localStorage` rather than the secure store on purpose: this is not a
 * credential, it is a name the desktop shows in its device list, and losing it
 * costs a re-pair rather than a security property.
 *
 * **Not `crypto.randomUUID()`.** That is a secure-context API, and this app's
 * whole point is being served over plain `http://192.168.x.x:8420` from a
 * machine that has no certificate — so on the phone it is simply `undefined`
 * and throws. `crypto.getRandomValues` carries no such restriction and is
 * present everywhere; the `Math.random` branch is for the theoretical browser
 * that has neither, and is acceptable precisely because this value is a label
 * rather than a secret. (Anything that *is* secret is minted by the desktop —
 * see electron/mobile/auth.ts.)
 */
export function deviceId(): string {
  const KEY = 'forge.deviceId'
  const existing = localStorage.getItem(KEY)
  if (existing) return existing
  const minted = randomId()
  localStorage.setItem(KEY, minted)
  return minted
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

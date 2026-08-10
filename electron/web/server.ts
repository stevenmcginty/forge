import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  MAX_INPUT_PER_SECOND,
  MAX_REPLAY_BYTES,
  MAX_SESSIONS,
  MAX_WRITE_CHARS,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  WEB_WS_PATH,
  isWebLayoutOp,
  parseFrame,
  wireDim,
  wireString,
  type WebClientFrame,
  type WebErrorCode,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebRefusal,
  type WebResult,
  type WebServerFrame,
  type WebSession,
  type WebShutdownReason
} from '@shared/web'
import type {
  AgentPresence,
  CommandPresence,
  GitActionKind,
  GitActionResult,
  GitSnapshot,
  Project,
  Workspace
} from '@shared/types'
import type { SkillsList } from '@shared/skills'
import type { CommandsFeed } from '@shared/commands'
import type { WebAuth, WebDevice } from './auth'

/**
 * The Forge Web link server — the socket a browser tab mirrors this desktop
 * over.
 *
 * Electron-free with everything injected, the same shape as
 * `electron/mobile/server.ts` and `electron/companion-sync.ts`, and for the same
 * reason: `scripts/web-smoke.mjs` drives *this* class against a real
 * `PtySessionManager` over a real WebSocket with no Electron and no mocks. A
 * server only ever exercised inside Electron is a server nobody has tested.
 *
 * One HTTP server, one port, and — unlike Mobile — almost nothing on the HTTP
 * side: the web client is served by Firebase Hosting, not by this machine
 * (docs/forge-web.md, decision 12), so there is no bundle to host and no
 * single-page fallback to get wrong. What is left is the WebSocket upgrade at
 * WEB_WS_PATH and a bare liveness probe.
 *
 * ## The network posture, honestly
 *
 * Mobile's listener faces a LAN. **This one faces the internet**, through a
 * Cloudflare tunnel, and the protocol's `write` frame types into a live shell.
 * So a valid credential here is a shell as Steve, and every control below is
 * arranged around that sentence rather than around tidiness.
 *
 * In the order a connection meets them:
 *
 *  1. **The path and the source address.** `cloudflared` runs on this machine
 *     and dials the socket from loopback, so the public side never touches this
 *     port directly and `isAllowedSource` still sees 127.0.0.1. It is what stops
 *     an accidentally port-forwarded router from turning this into a public
 *     shell. Defence in depth, not the defence.
 *  2. **The subprotocol.** WEB_SUBPROTOCOL and nothing else. A browser cannot
 *     set a header on a `WebSocket`, so the subprotocol list is the only field
 *     the page controls and therefore the only way a version mismatch can be
 *     refused *during* the upgrade, before a socket exists and before a `hello`
 *     round trip has been spent. `hello.proto` stays the authority.
 *  3. **The `Origin` header.** See `originAllowed` — and read the note there
 *     about what it does and does not defend, because it is easy to
 *     over-believe.
 *  4. **MAX_FRAME_BYTES**, as `ws`'s own `maxPayload`, which is the one place
 *     the count is genuinely in bytes (see shared/web.ts).
 *  5. **`hello`, and nothing before it.** Not `attach`, not `ping`, nothing.
 *  6. **The Firebase ID token**, verified against Google's published keys by
 *     `electron/web/auth.ts` on every connection — including mid-connection, on
 *     the `auth` frame. That is the lock. Everything above it is a hinge.
 *
 * ## Mirror, never a parallel world
 *
 * Layout operations are *requests* forwarded to the desktop renderer, which
 * owns the split tree and persists it (docs/forge-web.md, decision 5). Nothing
 * here mutates a workspace, and a `write` goes to the same PTY the desktop
 * window is looking at. That is why `WebServerHost.layout` returns an error
 * sentence rather than a boolean: the answer comes back from the window, and
 * "there is no window" is a thing the browser has to be told.
 */

/* ------------------------------------------------------------------- limits */

/**
 * Most command lines one `agents` request may ask about.
 *
 * `WebRequest`'s `agents` member says the list is "capped by the server, not by
 * the type", and this is the cap. Each entry costs a PATH resolution on this
 * machine, and the chooser asks about the profiles a person actually has —
 * dozens, not thousands.
 */
const MAX_PROBE_COMMANDS = 64

/** The five verbs `GitActionKind` enumerates, as something the wire can be checked against. */
const GIT_ACTIONS: readonly GitActionKind[] = ['fetch', 'pull', 'push', 'switch', 'commit']

/**
 * Close codes, so a browser can tell one hang-up from another in its own
 * console. 4000-4999 is the range the WebSocket spec leaves to applications;
 * the values match electron/mobile/server.ts where the meaning is the same.
 */
const CLOSE_UNAUTHENTICATED = 4001
const CLOSE_PROTO = 4002
const CLOSE_REVOKED = 4003
const CLOSE_HEARTBEAT = 4008
const CLOSE_GOING_AWAY = 1001

/* --------------------------------------------------------------------- host */

/**
 * Everything this server needs from the world, and nothing else.
 *
 * The house pattern, the one `MobileServerHost`, `CompanionHost` and
 * `WebAuthHost` all follow, and the reason docs/forge-web.md rejected a
 * services facade: the consumer declares the narrow interface, and
 * `electron/web-host.ts` implements it by calling the existing modules. Nothing
 * here is Electron, a socket, a window or a file.
 */
export interface WebServerHost {
  auth: WebAuth
  appVersion: string
  /** This computer's name — the same string `WebHostRecord.name` carries. */
  desktopName: () => string

  /**
   * The origins a browser may open this socket from, e.g.
   * `https://forge-web.web.app`. Read per upgrade rather than captured, so
   * changing it at the desk bites on the next connection.
   *
   * Supplied by the host rather than written here because the deployment
   * decides it: the Firebase Hosting domain, the project's `.firebaseapp.com`
   * twin, and whatever `http://localhost:5173` the Phase 3 dev loop runs on.
   * An empty list admits no browser at all — see `originAllowed`.
   */
  allowedOrigins: () => string[]

  /**
   * A browser was turned away by `originAllowed`, with the `Origin` it sent.
   *
   * Optional, and the only refusal in this file that needs a channel of its
   * own. Every other one happens on an open socket and travels back as a
   * `refused` frame the page renders; this one happens mid-handshake, so the
   * browser is handed a bare failed upgrade it cannot tell from an unreachable
   * machine, and it retries forever. A host that implements this can say on the
   * *desktop* what the browser will never learn — see `WebStatus.refusal`.
   */
  onOriginRefused?: (origin: string, allowed: string[]) => void

  /** Live panes, as the wire sees them. */
  sessions: () => WebSession[]
  /** The catch-up buffer from pty-host, or '' when there is none. */
  replay: (id: string) => string
  write: (id: string, data: string) => boolean
  resize: (id: string, cols: number, rows: number) => boolean

  /** The opening picture: whatever the browser needs to draw the workspace. */
  snapshot: () => Pick<WebHelloOkFrame, 'projects' | 'profiles' | 'workspaces'>

  /**
   * Perform one layout operation. Implemented by web-host by forwarding to the
   * renderer, which owns tabs and panes — the same code path a local click
   * takes, never a second one that could disagree with the first. Resolves to
   * an error sentence written for the person reading the browser tab, or null
   * when it worked.
   */
  layout: (op: WebLayoutOp, deviceName: string) => Promise<string | null>

  /* ------------------------------------------------------- the read requests
   *
   * All optional, and a host that omits one answers `unsupported` rather than
   * hanging: `WebResult`'s contract is that every request settles, and "this
   * desktop cannot do that at all" is one of the answers `WebErrorCode` already
   * has a word for. It also means the smoke test's server, and any future host,
   * is safe by default rather than by remembering.
   */

  /** The git panel's opening read for one project. Null = no project by that id. */
  gitStatus?: (projectId: string) => Promise<GitSnapshot | null>
  /**
   * One of the five verbs, against a project id. Never a path: the desktop
   * resolves the folder itself, exactly as `GitActionRequest` promises, so the
   * browser cannot ask this machine to run git somewhere else.
   */
  gitAction?: (request: {
    projectId: string
    action: GitActionKind
    branch?: string
    message?: string
  }) => Promise<GitActionResult>
  skills?: () => Promise<SkillsList>
  commands?: () => Promise<CommandsFeed>
  /** The "is this actually installed" probe behind the agent chooser. */
  agents?: (commands: string[]) => Promise<{ agents: AgentPresence[]; commands: CommandPresence[] }>

  /**
   * The number of authenticated browsers changed. Drives the power-save blocker
   * in web-host: a machine that suspends mid-session drops every socket.
   */
  onPresence?: (connected: number) => void

  /**
   * Which sessions a browser currently has open, whenever that set changes.
   *
   * A PTY has one geometry and this link gives it two viewers. Without this,
   * both fit it to their own box and the last one to move wins: the desktop
   * pane refits on any layout change, so a browser reading a pane on a train
   * would have the width yanked back mid-sentence and every line after that
   * wrapped for a screen it is not on. Naming the watched sessions lets the
   * desktop stand down and follow the browser for as long as the browser is the
   * one reading — the same arrangement `onWatch` makes for a phone.
   *
   * Fired on attach, detach, exit and hangup, with the full set each time; a
   * diff the receiver has to reassemble is a diff that can be missed.
   */
  onWatch?: (ids: string[]) => void

  /**
   * Injected so the smoke test can drive the rate-limit buckets and a short
   * heartbeat without sleeping through the shipped values. Defaults are the
   * shipped ones.
   */
  now?: () => number
  heartbeatMs?: number
  heartbeatGraceMs?: number
  log?: (line: string) => void
}

export interface WebServerOptions {
  host: string
  port: number
}

/** What `stop` tells the connected browsers on the way out. See `WebShutdownFrame`. */
export interface WebShutdownNotice {
  reason: WebShutdownReason
  message: string
  retryAfterMs?: number
}

interface Client {
  socket: WebSocket
  source: string
  device: WebDevice | null
  /** Sessions this browser is reading. */
  subs: Set<string>
  /**
   * The `requestId` of an approval in flight for this socket, or ''. Held so a
   * hang-up mid-question can withdraw it: a prompt that outlives its socket is
   * one whose Allow lands on nothing — and, worse, primes the desk for the next
   * asker.
   */
  approval: string
  /** The second the input counter belongs to, and its tally. See `allowInput`. */
  inputSecond: number
  inputCount: number
  /** Whether this second's `limit` refusal has already been sent. */
  toldLimit: boolean
  /** Drops a socket that never says hello. Cleared once it has. */
  helloTimer: NodeJS.Timeout | null
  /** The next native ping, and the deadline for its pong. See `schedulePing`. */
  pingTimer: NodeJS.Timeout | null
  pongTimer: NodeJS.Timeout | null
}

/* -------------------------------------------------------------------- class */

export class WebServer {
  private readonly host: WebServerHost
  private readonly now: () => number
  private readonly beatMs: number
  private readonly graceMs: number
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private listening: { host: string; port: number } | null = null
  /** The last set handed to `onWatch`, so an unchanged set says nothing. */
  private announcedWatch = ''

  constructor(host: WebServerHost) {
    this.host = host
    this.now = host.now ?? ((): number => Date.now())
    this.beatMs = host.heartbeatMs ?? HEARTBEAT_MS
    this.graceMs = host.heartbeatGraceMs ?? HEARTBEAT_GRACE_MS
  }

  /** Authenticated browsers, right now. */
  get connectedCount(): number {
    return [...this.clients].filter((c) => c.device).length
  }

  address(): { host: string; port: number } | null {
    return this.listening
  }

  async start(options: WebServerOptions): Promise<{ host: string; port: number }> {
    if (this.listening) return this.listening

    const http = createServer((req, res) => this.serveHttp(req, res))
    // `noServer` so the upgrade is only accepted on WEB_WS_PATH, only from an
    // allowed source, only with the right subprotocol and only from an expected
    // origin — a WebSocketServer bound directly to the http server would answer
    // any path and check none of it. `maxPayload` is MAX_FRAME_BYTES enforced
    // where the count is genuinely in bytes, which is why `parseFrame` does not
    // repeat it.
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      handleProtocols: (protocols) => (protocols.has(WEB_SUBPROTOCOL) ? WEB_SUBPROTOCOL : false)
    })

    http.on('upgrade', (req, socket, head) => {
      const source = sourceOf(req)
      const path = (req.url ?? '').split('?')[0]
      if (path !== WEB_WS_PATH || !isAllowedSource(source)) {
        refuseUpgrade(socket, 403, 'Forbidden')
        return
      }
      if (!offersSubprotocol(req)) {
        // Refused here rather than after the handshake, because it costs no
        // round trip and because a client that cannot name the protocol is
        // either the wrong version or not a Forge client at all.
        this.log(`refusing an upgrade from ${source} that did not ask for ${WEB_SUBPROTOCOL}`)
        refuseUpgrade(socket, 400, 'Unsupported subprotocol')
        return
      }
      if (!this.originAllowed(req)) {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
        this.log(`refusing an upgrade from ${source} with origin ${origin || '(none)'}`)
        // Told to the desktop as well as the log, because this refusal is the
        // one the browser cannot be told about. See `onOriginRefused`.
        this.host.onOriginRefused?.(origin, this.host.allowedOrigins())
        refuseUpgrade(socket, 403, 'Origin not allowed')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, source))
    })

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(options.port, options.host, () => {
        http.removeListener('error', reject)
        resolve()
      })
    })

    this.http = http
    this.wss = wss
    this.listening = { host: options.host, port: options.port }
    this.log(`listening on ${options.host}:${options.port}${WEB_WS_PATH}`)
    return this.listening
  }

  /**
   * Stop listening, telling whoever is connected why first.
   *
   * The notice is not decoration: without it every shutdown looks like a
   * network fault, and the page spends the next minute retrying a machine that
   * is off instead of dropping to GitHub mode. See `WebShutdownFrame`.
   */
  async stop(notice?: WebShutdownNotice): Promise<void> {
    if (notice) this.pushShutdown(notice)
    for (const client of [...this.clients]) this.drop(client, CLOSE_GOING_AWAY, 'Server stopping')
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const http = this.http
    this.http = null
    this.listening = null
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  /* -------------------------------------------------------------- outbound */

  /** Terminal output from pty-host. Only reaches browsers that attached to it. */
  pushData(id: string, data: string): void {
    for (const client of this.clients) {
      if (client.device && client.subs.has(id)) this.send(client, { type: 'data', sessionId: id, data })
    }
  }

  pushExit(id: string, exitCode: number): void {
    for (const client of this.clients) {
      if (client.device && client.subs.has(id)) {
        client.subs.delete(id)
        this.send(client, { type: 'exit', sessionId: id, exitCode })
      }
    }
    this.announceWatch()
  }

  /** The whole live pane list, to everybody. Whole rather than a diff, per `WebSessionsFrame`. */
  pushSessions(): void {
    const sessions = this.wireSessions()
    this.broadcast({ type: 'sessions', sessions })
  }

  /**
   * One pane just opened. Redundant against `sessions` as data and not as an
   * event — this is the single moment a client has to construct an xterm and
   * attach, and every client that had to find it by diffing two lists would
   * implement the same diff.
   */
  pushSessionStarted(session: WebSession): void {
    this.broadcast({ type: 'session-started', session: toWireSession(session) })
  }

  /** A pane has settled on a question, or stopped waiting on one. */
  pushAttention(sessionId: string, asking: boolean, prompt?: string): void {
    this.broadcast({ type: 'attention', sessionId, asking, ...(prompt ? { prompt } : {}) })
  }

  pushProjects(projects: Project[]): void {
    this.broadcast({ type: 'projects', projects })
  }

  pushWorkspace(projectId: string, workspace: Workspace): void {
    this.broadcast({ type: 'workspace', projectId, workspace })
  }

  /** A git status the desktop's watcher produced, unbidden. */
  pushGit(snapshot: GitSnapshot): void {
    this.broadcast({ type: 'git', snapshot })
  }

  /**
   * "This desktop is going away." Sent to every socket, authenticated or not: a
   * browser sitting at the approval screen deserves to know the desk it is
   * waiting on is shutting down as much as a live one does.
   */
  pushShutdown(notice: WebShutdownNotice): void {
    for (const client of this.clients) {
      this.send(client, {
        type: 'shutdown',
        reason: notice.reason,
        message: notice.message,
        ...(notice.retryAfterMs ? { retryAfterMs: notice.retryAfterMs } : {})
      })
    }
  }

  /** Close any live socket belonging to a revoked browser, immediately. */
  disconnectDevice(deviceId: string): void {
    for (const client of [...this.clients]) {
      if (client.device?.id === deviceId) {
        this.send(client, {
          type: 'refused',
          reason: 'revoked',
          message: "This browser was removed from the desktop's device list."
        })
        this.drop(client, CLOSE_REVOKED, 'Device revoked')
      }
    }
  }

  private broadcast(frame: WebServerFrame): void {
    for (const client of this.clients) {
      if (client.device) this.send(client, frame)
    }
  }

  /**
   * Tell the host which sessions are being read from a browser, when that has
   * changed. The union across every socket, because two tabs on one pane is
   * still "a browser is reading this".
   */
  private announceWatch(): void {
    if (!this.host.onWatch) return
    const ids = new Set<string>()
    for (const client of this.clients) {
      if (!client.device) continue
      for (const id of client.subs) ids.add(id)
    }
    const list = [...ids].sort()
    const key = list.join(' ')
    if (key === this.announcedWatch) return
    this.announcedWatch = key
    this.host.onWatch(list)
  }

  /* --------------------------------------------------------------- inbound */

  private accept(socket: WebSocket, source: string): void {
    const client: Client = {
      socket,
      source,
      device: null,
      subs: new Set(),
      approval: '',
      inputSecond: 0,
      inputCount: 0,
      toldLimit: false,
      helloTimer: null,
      pingTimer: null,
      pongTimer: null
    }
    this.clients.add(client)

    // An unauthenticated socket is not allowed to sit there holding a slot —
    // with one exception: a socket *waiting on a human* has said its hello and
    // must not be cut off mid-question. It is not immortal either; that wait is
    // bounded by APPROVAL_TIMEOUT_MS inside auth.ts.
    //
    // The shipped HEARTBEAT_GRACE_MS rather than the injected one, on purpose:
    // this deadline is not part of the heartbeat, and a host that dials the
    // heartbeat down for a test must not accidentally leave a browser a
    // fraction of a second to say hello in.
    client.helloTimer = setTimeout(() => {
      if (!client.device && !client.approval) this.drop(client, CLOSE_UNAUTHENTICATED, 'No hello')
    }, HEARTBEAT_GRACE_MS)

    socket.on('message', (raw) => {
      const frame = parseFrame(String(raw))
      if (!frame) {
        this.send(client, { type: 'error', code: 'bad-frame', message: 'Unreadable frame' })
        // Garbage before the door has opened is not a client having a bad day;
        // nothing legitimate reaches this socket without saying hello first.
        if (!client.device) this.drop(client, CLOSE_UNAUTHENTICATED, 'Not authenticated')
        return
      }
      void this.handle(client, frame)
    })
    socket.on('pong', () => this.schedulePing(client))
    socket.on('close', () => {
      this.clients.delete(client)
      this.clearTimers(client)
      // A browser that hangs up mid-approval takes its question with it. Without
      // this the prompt outlives the tab that caused it, and Steve's Allow lands
      // on a socket that no longer exists.
      if (client.approval) {
        this.host.auth.abandon(client.approval)
        client.approval = ''
      }
      if (client.device) {
        this.log(`${client.device.name} disconnected`)
        this.host.onPresence?.(this.connectedCount)
        // A browser that hangs up is no longer reading anything, so the desktop
        // takes its panes back — including after a tunnel drops mid-pane.
        this.announceWatch()
      }
    })
    // A frame over MAX_FRAME_BYTES arrives here as an error from `ws`'s
    // receiver, which has already refused to buffer it. Closing is the whole
    // response: there is no partial frame to answer and nothing sensible to say
    // about one.
    socket.on('error', () => this.drop(client, CLOSE_GOING_AWAY, 'Socket error'))

    this.schedulePing(client)
  }

  private async handle(client: Client, frame: WebClientFrame): Promise<void> {
    if (frame.type === 'hello') return this.onHello(client, frame)

    // Everything below this line requires authentication, and there is no
    // carve-out: not `ping`, not `attach`, nothing. Mobile lets a socket waiting
    // on approval ping, because its phone would otherwise reconnect and mint
    // fresh words mid-comparison; this link has no such need, because its real
    // heartbeat is the *native* WebSocket ping, which a browser answers in its
    // network stack whether or not the page has been let in. The blanket drop
    // lives here rather than in each handler so a new frame type cannot arrive
    // without it.
    if (!client.device) {
      this.send(client, {
        type: 'error',
        code: 'bad-frame',
        message: 'Nothing but hello is honoured before this browser has been let in.'
      })
      this.drop(client, CLOSE_UNAUTHENTICATED, 'Not authenticated')
      return
    }

    if (!this.allowInput(client)) return

    switch (frame.type) {
      case 'ping':
        this.send(client, { type: 'pong' })
        return

      case 'auth':
        return this.onAuth(client, frame)

      case 'attach': {
        const id = wireString(frame.sessionId, 128)
        const current = this.host.sessions().find((s) => s.id === id)
        if (!current) {
          this.send(client, {
            type: 'error',
            code: 'unknown-session',
            message: 'That pane is gone',
            sessionId: id
          })
          return
        }
        client.subs.add(id)
        // Before the geometry and before the replay: the buffer about to be sent
        // was written at whatever width the pane is now, and the sooner the
        // desktop hands that width over the fewer lines the browser paints at a
        // size it is not.
        this.announceWatch()
        // `cols`/`rows` are optional and mean "and this is the size I am reading
        // it at". Omitting them means "I will take whatever size it is", which
        // is what a read-only or thumbnail view should send.
        if (frame.cols !== undefined || frame.rows !== undefined) {
          this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows))
        }
        const buffer = this.host.replay(id)
        // `truncated` is a claim about the *ceiling*, not about the session:
        // false means the transcript is whole, true means the buffer is at
        // MAX_REPLAY_BYTES and so probably begins mid-sentence. pty-host keeps a
        // rolling window and does not record what fell off the front, so this is
        // the strongest honest thing that can be said — and it is the thing the
        // client needs, which is whether to draw a rule above it.
        const data = buffer.length > MAX_REPLAY_BYTES ? buffer.slice(buffer.length - MAX_REPLAY_BYTES) : buffer
        this.send(client, {
          type: 'replay',
          sessionId: id,
          data,
          truncated: buffer.length >= MAX_REPLAY_BYTES
        })
        return
      }

      case 'detach':
        client.subs.delete(wireString(frame.sessionId, 128))
        this.announceWatch()
        return

      case 'write': {
        const id = wireString(frame.sessionId, 128)
        const data = typeof frame.data === 'string' ? frame.data : ''
        if (!data) return
        if (data.length > MAX_WRITE_CHARS) {
          this.send(client, {
            type: 'error',
            code: 'limit',
            message: `That is longer than the ${MAX_WRITE_CHARS} characters one write may carry — nothing was typed.`,
            sessionId: id
          })
          return
        }
        // The boolean matters. `write` is the one frame carrying something the
        // person composed, and the client throws its draft away the moment it
        // hands it over. A pane that exited while the tab was in the background
        // would otherwise swallow the words and answer exactly as a successful
        // write does, which is the worst thing a remote can do: look like it
        // worked.
        if (!this.host.write(id, data)) {
          this.send(client, {
            type: 'error',
            code: 'unknown-session',
            message: 'That pane is gone — nothing was typed',
            sessionId: id
          })
        }
        return
      }

      case 'resize': {
        const id = wireString(frame.sessionId, 128)
        const current = this.host.sessions().find((s) => s.id === id)
        // Unlike `write`, a resize for a pane that has gone is not worth a
        // sentence: it carries nothing the user composed, and an attached client
        // is about to be told the session ended by its own `exit` frame. The
        // same silence, and the same reasoning, as electron/mobile/server.ts.
        if (!current) return
        this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows))
        return
      }

      case 'request':
        return this.onRequest(client, wireString(frame.rid, 128), frame.body)
    }
  }

  /**
   * The input rate limit: a whole second's worth, then refusal until the next.
   *
   * Nobody meets MAX_INPUT_PER_SECOND by typing — see its comment in
   * shared/web.ts — so this is not about people. A browser tab is a scripting
   * environment, and a runaway `setInterval` should exhaust a counter rather
   * than a desktop.
   *
   * The refusal is sent once per exhausted second rather than once per dropped
   * frame, which is the same judgement mobile makes about a held button: a
   * client that has just been told to slow down will have a hundred more frames
   * already in flight, and answering each of them is the flood arriving twice.
   * It is still an answer rather than a silent drop, which is what
   * `WebErrorCode`'s `limit` is for.
   */
  private allowInput(client: Client): boolean {
    const second = Math.floor(this.now() / 1000)
    if (second !== client.inputSecond) {
      client.inputSecond = second
      client.inputCount = 0
      client.toldLimit = false
    }
    client.inputCount += 1
    if (client.inputCount <= MAX_INPUT_PER_SECOND) return true
    if (!client.toldLimit) {
      client.toldLimit = true
      this.send(client, {
        type: 'error',
        code: 'limit',
        message: `More than ${MAX_INPUT_PER_SECOND} frames in one second — slow down.`
      })
    }
    return false
  }

  /* ------------------------------------------------------------------ hello */

  private async onHello(client: Client, frame: Extract<WebClientFrame, { type: 'hello' }>): Promise<void> {
    if (client.device || client.approval) return // one hello per socket

    if (Number(frame.proto) !== WEB_PROTO) {
      // `proto` is the one refusal auth never returns: it is decided here,
      // before a credential is looked at, because a client that cannot read the
      // answer should not have its token verified to find that out.
      this.refuse(
        client,
        'proto',
        `This Forge speaks protocol ${WEB_PROTO}; the page speaks ${String(frame.proto)}. Reload the page, or update Forge.`,
        undefined,
        CLOSE_PROTO
      )
      return
    }

    const outcome = await this.host.auth.authenticate(
      {
        source: client.source,
        // The same 8192 ceiling auth.ts holds a token to; `wireString`'s default
        // 256 would truncate every real JWT into a broken one.
        idToken: wireString(frame.idToken, 8192),
        deviceId: wireString(frame.deviceId, 128),
        deviceName: wireString(frame.deviceName, 64) || 'Browser',
        // A six-digit code or a recovery code, so 32 is generous and a cap is
        // still the right thing: this string is hashed and pattern-matched, and
        // a megabyte of it would be a megabyte of hashing per hello.
        totp: wireString(frame.totp, 32),
        // `=== true`, the strictest form, because this is the field that skips
        // the second factor for a month — the same rule `webApprovalResult`
        // holds an Allow to.
        trust: frame.trust === true
      },
      (pending) => {
        // Fired once, before any waiting. Recorded first so a hang-up during the
        // wait can withdraw the prompt, then shown to the browser: the words are
        // on screen while somebody is comparing them to the desktop's.
        client.approval = pending.requestId
        this.send(client, { type: 'pending', words: pending.words, expiresAt: pending.expiresAt })
      }
    )
    client.approval = ''

    if (!outcome.ok) {
      this.refuse(client, outcome.reason, outcome.message, outcome.retryAfterMs)
      return
    }

    client.device = outcome.device
    if (client.helloTimer) {
      clearTimeout(client.helloTimer)
      client.helloTimer = null
    }
    const snapshot = this.host.snapshot()
    this.log(`${outcome.device.name} connected from ${client.source} (client ${wireString(frame.client, 32) || '?'})`)
    this.send(client, {
      type: 'hello-ok',
      proto: WEB_PROTO,
      appVersion: this.host.appVersion,
      desktopName: this.host.desktopName(),
      projects: snapshot.projects,
      profiles: snapshot.profiles,
      workspaces: snapshot.workspaces,
      sessions: this.wireSessions()
    })
    this.host.onPresence?.(this.connectedCount)
  }

  /**
   * A freshly minted ID token, presented before the old one lapses.
   *
   * Re-verified against Google's keys exactly as the `hello` was, because "this
   * credential does not get in" is one answer whether it is heard at the start
   * of a connection or an hour into it. A failure closes the socket: leaving it
   * open on a lapsed credential would be leaving a shell open on one.
   */
  private async onAuth(client: Client, frame: Extract<WebClientFrame, { type: 'auth' }>): Promise<void> {
    const rid = wireString(frame.rid, 128)
    const outcome = await this.host.auth.verifyToken(wireString(frame.idToken, 8192), client.source)
    if (!outcome.ok) {
      this.refuse(client, outcome.reason, outcome.message, outcome.retryAfterMs)
      return
    }
    this.send(client, { type: 'result', rid, body: { kind: 'ok' } })
  }

  /**
   * One refusal, said once and then hung up on.
   *
   * A `refused` frame rather than an `error` frame because these are the six
   * different recoveries — sign in again, sign in as somebody else, wait for a
   * human, ask a human, update the page, come back later — and a client that
   * collapses them into "connection failed" has thrown away the only thing that
   * tells the user what to do next.
   */
  private refuse(
    client: Client,
    reason: WebRefusal,
    message: string,
    retryAfterMs?: number,
    code = CLOSE_UNAUTHENTICATED
  ): void {
    this.log(`refused ${client.source}: ${reason} — ${message}`)
    this.send(client, {
      type: 'refused',
      reason,
      message,
      ...(retryAfterMs ? { retryAfterMs } : {})
    })
    this.drop(client, code, message)
  }

  /* ---------------------------------------------------------------- requests */

  /**
   * Everything that is a question rather than a stream, on one correlated
   * channel.
   *
   * `rid` is echoed verbatim and never interpreted, and every path answers on it
   * — including the failures, because a request that fails still has to settle
   * a promise the client is holding. That is why the whole body sits in a
   * try/catch: a host that throws must not leave a browser waiting forever for
   * an answer that is never coming.
   */
  private async onRequest(client: Client, rid: string, body: unknown): Promise<void> {
    const answer = (result: WebResult): void => this.send(client, { type: 'result', rid, body: result })
    const failed = (code: WebErrorCode, message: string): void => answer({ kind: 'failed', code, message })

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      failed('bad-frame', 'That request had no body this desktop could read.')
      return
    }
    const request = body as Record<string, unknown>

    try {
      switch (request.kind) {
        case 'layout': {
          const op = readLayoutOp(request.op)
          if (!op) {
            failed('bad-frame', 'That is not a layout operation this desktop understands.')
            return
          }
          // Forwarded, never performed here: the renderer owns the split tree
          // and is the one thing that persists a workspace.
          const error = await this.host.layout(op, client.device?.name ?? 'Browser')
          if (error) {
            failed('no-window', error)
            return
          }
          answer({ kind: 'ok' })
          return
        }

        case 'git-status': {
          if (!this.host.gitStatus) {
            failed('unsupported', 'This Forge cannot read git for a browser.')
            return
          }
          const projectId = wireString(request.projectId, 128)
          if (!projectId) {
            failed('unknown-project', 'That request named no project.')
            return
          }
          const snapshot = await this.host.gitStatus(projectId)
          if (!snapshot) {
            failed('unknown-project', 'No project by that id on this desktop.')
            return
          }
          answer({ kind: 'git', snapshot })
          return
        }

        case 'git-action': {
          if (!this.host.gitAction) {
            failed('unsupported', 'This Forge cannot run git for a browser.')
            return
          }
          const projectId = wireString(request.projectId, 128)
          const action = request.action
          if (!projectId) {
            failed('unknown-project', 'That request named no project.')
            return
          }
          if (!isGitAction(action)) {
            failed('bad-frame', 'That is not a git action this desktop performs.')
            return
          }
          const result = await this.host.gitAction({
            projectId,
            action,
            branch: wireString(request.branch, 256) || undefined,
            message: wireString(request.message, 4096) || undefined
          })
          // The snapshot is re-read *after* the action, exactly as
          // `GitActionResult` promises, so the panel can never show a
          // pre-action answer.
          if (result.ok && result.snapshot) {
            answer({ kind: 'git', snapshot: result.snapshot })
            return
          }
          failed('failed', result.error || 'That git action did not work.')
          return
        }

        case 'skills': {
          if (!this.host.skills) {
            failed('unsupported', 'This Forge cannot list skills for a browser.')
            return
          }
          answer({ kind: 'skills', skills: await this.host.skills() })
          return
        }

        case 'commands': {
          if (!this.host.commands) {
            failed('unsupported', 'This Forge cannot list commands for a browser.')
            return
          }
          answer({ kind: 'commands', feed: await this.host.commands() })
          return
        }

        case 'agents': {
          if (!this.host.agents) {
            failed('unsupported', 'This Forge cannot probe for agents on behalf of a browser.')
            return
          }
          // Capped by the server, not by the type. Each entry costs a PATH
          // resolution on this machine, so an unbounded list is an unbounded
          // amount of work asked for in one frame.
          const raw = Array.isArray(request.commands) ? request.commands : []
          const commands = raw
            .slice(0, MAX_PROBE_COMMANDS)
            .map((value) => wireString(value, 512))
            .filter((value) => value.length > 0)
          const probed = await this.host.agents(commands)
          answer({ kind: 'agents', agents: probed.agents, commands: probed.commands })
          return
        }

        default:
          // A newer client asking for something this build has never heard of.
          // `unsupported` is the honest answer and the one `WebErrorCode`
          // already has a word for; the alternative is a promise that never
          // settles.
          failed('unsupported', `This desktop does not understand a "${wireString(request.kind, 32)}" request.`)
          return
      }
    } catch (err) {
      failed('failed', describe(err))
    }
  }

  /* --------------------------------------------------------------- plumbing */

  /**
   * The live pane list, cut to MAX_SESSIONS and reduced to exactly the fields
   * `WebSession` declares.
   *
   * Rebuilt field by field rather than passed through, and that is the point:
   * `SessionInfo` structurally satisfies `WebSession` and carries `pid` and two
   * bootstrap fields besides, so handing `list()` straight to `JSON.stringify`
   * would put this machine's process ids on a public wire. shared/web.ts is
   * explicit that `pid` is absent on purpose; this is where that stays true.
   */
  private wireSessions(): WebSession[] {
    return this.host.sessions().slice(0, MAX_SESSIONS).map(toWireSession)
  }

  private send(client: Client, frame: WebServerFrame): void {
    if (client.socket.readyState !== client.socket.OPEN) return
    try {
      client.socket.send(JSON.stringify(frame))
    } catch {
      /* a dead socket is closed by its own close handler */
    }
  }

  private drop(client: Client, code: number, reason: string): void {
    this.clients.delete(client)
    this.clearTimers(client)
    if (client.approval) {
      this.host.auth.abandon(client.approval)
      client.approval = ''
    }
    try {
      client.socket.close(code, reason)
    } catch {
      /* already gone */
    }
  }

  /**
   * The heartbeat, on the *native* WebSocket ping.
   *
   * Per-socket timers rather than one sweep across all of them, because
   * HEARTBEAT_MS and HEARTBEAT_GRACE_MS mean two different things: a ping every
   * twenty seconds, and ten seconds to answer it. A single interval at
   * HEARTBEAT_MS would collapse them into one number and give a dead socket a
   * whole extra beat to be noticed in.
   *
   * Native, not the protocol's own `ping` frame, and shared/web.ts sets out at
   * length why: a browser answers a protocol ping in its network stack whether
   * or not the tab is visible, whereas a hidden tab's JavaScript timers are
   * clamped to roughly once a minute. An app-level heartbeat would time out
   * every backgrounded tab — which for this app means every tab somebody left
   * open on the machine they are working on.
   */
  private schedulePing(client: Client): void {
    if (client.pongTimer) clearTimeout(client.pongTimer)
    if (client.pingTimer) clearTimeout(client.pingTimer)
    client.pongTimer = null
    client.pingTimer = setTimeout(() => {
      try {
        client.socket.ping()
      } catch {
        this.drop(client, CLOSE_HEARTBEAT, 'Heartbeat failed')
        return
      }
      client.pongTimer = setTimeout(() => this.drop(client, CLOSE_HEARTBEAT, 'Heartbeat lost'), this.graceMs)
    }, this.beatMs)
  }

  private clearTimers(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer)
    if (client.pingTimer) clearTimeout(client.pingTimer)
    if (client.pongTimer) clearTimeout(client.pongTimer)
    client.helloTimer = null
    client.pingTimer = null
    client.pongTimer = null
  }

  private log(line: string): void {
    this.host.log?.(`[web] ${line}`)
  }

  /* ------------------------------------------------------------------- http */

  /**
   * The HTTP side, which is almost nothing.
   *
   * Firebase Hosting serves the client (docs/forge-web.md, decision 12), so
   * there is no bundle here and no single-page fallback. What is left is a
   * liveness probe for the tunnel, and it deliberately says nothing but "yes":
   * the public side of a Cloudflare tunnel forwards to this port, so anything
   * this endpoint reveals is revealed to anyone who guesses the hostname. A
   * version number here would be a free inventory of what is worth attacking.
   */
  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!isAllowedSource(sourceOf(req))) {
      res.writeHead(403).end('Forbidden')
      return
    }
    if ((req.url ?? '').split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Forge Web is served from the web, not from here.')
  }

  /**
   * Is this browser allowed to open a socket from the page it is on?
   *
   * **What it defends.** A browser sets `Origin` itself and a page cannot forge
   * it. So this is the one control that stops any site on the internet from
   * opening a socket to a tunnel hostname it guessed or scraped, and typing into
   * Steve's shell with his own signed-in Firebase session doing the
   * authenticating. Nothing else in this file stops that: the token would verify
   * and the device would be approved, because both of those are true — it is the
   * *page* that has no business being here.
   *
   * **What it does not defend.** A non-browser client sets any `Origin` it
   * likes, or none. This is a control on somebody's browser, not on this port.
   * The port is defended by the source allowlist and the token, in that order.
   *
   * An absent header is allowed through for exactly that reason: it means the
   * caller is not a browser, so there is no browser to protect and no page to
   * blame. An *empty* allowed list, on the other hand, refuses every browser —
   * fail closed, because a host that has not said which origins it serves has
   * not earned the right to accept all of them.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const raw = req.headers.origin
    if (typeof raw !== 'string' || raw.trim() === '') return true
    const origin = normaliseOrigin(raw)
    return this.host.allowedOrigins().some((allowed) => {
      const clean = normaliseOrigin(allowed)
      return clean.length > 0 && clean === origin
    })
  }
}

/* ----------------------------------------------------------------- helpers */

/** Exactly the fields `WebSession` declares, and nothing a host happened to carry. */
function toWireSession(session: WebSession): WebSession {
  return {
    id: session.id,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    bootstrapCommand: session.bootstrapCommand,
    startedAt: session.startedAt
  }
}

function isGitAction(value: unknown): value is GitActionKind {
  return typeof value === 'string' && (GIT_ACTIONS as readonly string[]).includes(value)
}

/**
 * One layout operation off the wire, or null.
 *
 * Total, and narrow on purpose: the op name goes through `isWebLayoutOp` — the
 * guard shared/web.ts provides precisely because this value is *switched on* by
 * the renderer rather than displayed — and every other field is a clamped
 * string. `permissionMode` stays a plain string all the way through, exactly as
 * `WebLayoutOp` says it should: the renderer decides what it means by running
 * it through `isPermissionMode` and dropping anything else.
 */
function readLayoutOp(value: unknown): WebLayoutOp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isWebLayoutOp(raw.op)) return null
  const projectId = wireString(raw.projectId, 128)
  // Every operation happens inside exactly one project, including
  // `select-project` — an op with no project is not an op this desktop can place.
  if (!projectId) return null

  const op: WebLayoutOp = { op: raw.op, projectId }
  const profileId = wireString(raw.profileId, 128)
  if (profileId) op.profileId = profileId
  const permissionMode = wireString(raw.permissionMode, 32)
  if (permissionMode) op.permissionMode = permissionMode
  const tabId = wireString(raw.tabId, 128)
  if (tabId) op.tabId = tabId
  const paneId = wireString(raw.paneId, 128)
  if (paneId) op.paneId = paneId
  if (raw.direction === 'row' || raw.direction === 'column') op.direction = raw.direction
  return op
}

/** Does this upgrade request ask for the one subprotocol this server speaks? */
function offersSubprotocol(req: IncomingMessage): boolean {
  const header = req.headers['sec-websocket-protocol']
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
  return raw
    .split(',')
    .map((value) => value.trim())
    .includes(WEB_SUBPROTOCOL)
}

/** An `Origin` header, lowercased and stripped of a trailing slash. '' if unusable. */
function normaliseOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Refuse an upgrade with an HTTP answer rather than a bare `destroy`.
 *
 * `electron/mobile/server.ts` destroys the socket, which is fine on a LAN where
 * the only thing that reaches the port is a phone somebody owns. Here the
 * refusals are ones a developer will hit — the wrong origin during Phase 3, a
 * stale bundle asking for the wrong subprotocol — and a status line is the
 * difference between reading the reason in the network panel and guessing at a
 * connection that "just fails".
 */
function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch {
    /* the peer has already gone */
  }
  socket.destroy()
}

function sourceOf(req: IncomingMessage): string {
  return normaliseAddress(req.socket.remoteAddress ?? '')
}

/** IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is the common Node shape. */
function normaliseAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Is this address one we are willing to talk to at all?
 *
 * Loopback, RFC1918 LAN, link-local, and 100.64.0.0/10 — the CGNAT range
 * Tailscale allocates from. The same rule as `isAllowedSource` in
 * electron/mobile/server.ts, restated rather than imported for the reason
 * shared/web.ts restates MAX_SESSIONS: importing it would drag Mobile's static
 * hosting, its APK route and its whole frame vocabulary into a bundle that
 * `scripts/web-smoke.mjs` builds stand-alone, to borrow nine lines of regex.
 *
 * It is deliberately *not* a substitute for the token. Its whole job is that a
 * mis-forwarded router port is not a public shell, and that a tunnel — which
 * dials from loopback on this very machine — is unaffected by it.
 */
export function isAllowedSource(address: string): boolean {
  const ip = normaliseAddress(address)
  if (!ip) return false
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  if (ip.startsWith('169.254.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  // 100.64.0.0/10 — Tailscale.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true
  // Unique-local IPv6 (fd00::/8), which is where a tailnet's v6 lives.
  if (/^f[cd]/i.test(ip)) return true
  return false
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

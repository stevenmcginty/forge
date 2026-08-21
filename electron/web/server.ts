import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BASE64,
  MAX_INPUT_PER_SECOND,
  MAX_MIRROR_CHUNK_BYTES,
  MAX_MIRROR_INPUT_PER_SECOND,
  MAX_REPLAY_BYTES,
  MAX_SESSIONS,
  MAX_WRITE_CHARS,
  PIN_MAX_DIGITS,
  isWebImageMime,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  WEB_WS_PATH,
  isWebLayoutOp,
  parseFrame,
  wireDim,
  wireString,
  type WebClientFrame,
  type WebErrorCode,
  type WebFolder,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebMirrorChunk,
  type WebMirrorConfig,
  type WebPushSubscription,
  type WebRefusal,
  type WebResult,
  type WebServerFrame,
  type WebSession,
  type WebShutdownReason
} from '@shared/web'
/*
 * The one validator, shared with the phone link. `readMirrorInput` never looks
 * at a frame's discriminant, so it reads a `WebMirrorInputFrame` exactly as it
 * reads a `MirrorInputFrame` — which is the whole reason shared/web.ts imports
 * the input vocabulary instead of restating it. See the note there.
 */
import { readMirrorInput, type MirrorInput } from '@shared/mobile'
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
import { extForMime, imagePasteIntoPane } from './inbox'

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

/**
 * Longest path, and longest entry name, one `fs-list` frame may carry.
 *
 * A clamp on the wire rather than a rule about the disk: Windows' own path
 * limit is 260 traditionally and 32767 on a long-path-enabled system, so
 * neither of these is the authority on what is a valid path — electron/web/
 * fs-browse.ts is, and it holds the same 2048 for the same reason. What they
 * are is a bound on how much string one frame can make this desktop think
 * about before anything has been decided about it. A megabyte of `\` is
 * refused here, cheaply, rather than becoming a syscall.
 */
const MAX_PATH_CHARS = 2048
const MAX_NAME_CHARS = 512

/** The five verbs `GitActionKind` enumerates, as something the wire can be checked against. */
const GIT_ACTIONS: readonly GitActionKind[] = ['fetch', 'pull', 'push', 'switch', 'commit']

/**
 * Wire bounds for a push subscription. The vendors' endpoints run to a couple
 * of hundred characters and the two keys to under a hundred; these are the
 * ceilings past which a string is not one of those things, and they exist so a
 * browser cannot post a megabyte into a file on this disk.
 */
const MAX_PUSH_ENDPOINT_CHARS = 2048
const MAX_PUSH_KEY_CHARS = 256

/**
 * Close codes, so a browser can tell one hang-up from another in its own
 * console. 4000-4999 is the range the WebSocket spec leaves to applications;
 * the values match electron/mobile/server.ts where the meaning is the same.
 */
const CLOSE_UNAUTHENTICATED = 4001
const CLOSE_PROTO = 4002
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

  /* ------------------------------------------------ one PTY, several viewers
   *
   * A PTY has one grid and this link gives it another viewer, so something has
   * to decide whose size wins. This server does not: it *names the viewer* on
   * every frame that could bear on the question and leaves the policy to
   * electron/pty/grid-owner.ts, which is the one place it is written down.
   *
   * The rule there, in a line: **the grid belongs to the device that last typed
   * into the pane.** Type in the browser and the browser's `cols`/`rows` are
   * honoured on the real PTY; type at the desk and the desk takes it back on the
   * first keystroke. Attaching, resizing a window, or simply reading a pane
   * moves nothing anywhere — which is why `attach` and `resize` below hand their
   * sizes over unconditionally rather than gating them. Two browsers are two
   * viewers, because `viewer` is minted per socket.
   *
   * A host that ignores the argument (scripts/web-e2e.mjs's does) gets the old
   * unconditional behaviour, which is also what an unowned pane does: yes.
   */

  /** `viewer` is this socket's identity — see the block above. */
  write: (id: string, data: string, viewer: string) => boolean
  resize: (id: string, cols: number, rows: number, viewer: string) => boolean

  /**
   * A browser stopped reading one pane (`id` given) or went away entirely.
   *
   * Optional, and the departure half of the ownership rule: a viewer that has
   * hung up cannot be the device somebody is typing on, so anything it held goes
   * back to unclaimed and the next wish — very often the desk's own next fit —
   * takes it. Without this a browser closed mid-pane would keep the grid it left
   * behind until somebody typed somewhere.
   */
  release?: (viewer: string, id?: string) => void

  /**
   * A browser asked for a pane's grid without typing into it — the phone
   * layout, when a pane comes on screen. Optional: a host without it (the e2e
   * fixture) answers as an unowned pane would, which is "yes" on the next wish.
   */
  claim?: (id: string, viewer: string) => void

  /** The opening picture: whatever the browser needs to draw the workspace. */
  snapshot: () => Pick<WebHelloOkFrame, 'projects' | 'profiles' | 'workspaces' | 'projectsRoot'>

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
   * One folder of this machine's disk, for the browser's project picker.
   *
   * The one request whose arguments name a place on this desktop, and the
   * paragraph on `WebRequest` in shared/web.ts is where that is reckoned with
   * rather than here. What this interface is for is the shape: a refusal is a
   * *value* (`{ ok: false }` with a sentence), never a throw, because the
   * things that go wrong here — a folder that has gone, a folder Windows will
   * not open — are ordinary events in a picker somebody is clicking around in,
   * and an exception would reach the browser as "the desktop failed while
   * handling that".
   */
  fsList?: (path: string, name: string) => Promise<{ ok: true; folder: WebFolder } | { ok: false; error: string }>

  /**
   * Add a folder to the project rail. Implemented by web-host by checking the
   * folder is really there and then asking the *renderer* to do it, so a
   * browser reaches `addProjectPath` — the same function the button at the desk
   * reaches — rather than a second route into the project list that could
   * disagree with it. Resolves to an error sentence, or null when it worked;
   * the same contract as `layout`, for the same reason.
   */
  projectAdd?: (path: string, deviceName: string) => Promise<string | null>

  /**
   * Make a brand-new project folder from a name and put it on the rail — the
   * browser's "New project" form. `parentDir` is an allow-list key, never a
   * path; the fence itself lives in electron/projectfolder.ts and the host
   * (web-host's `dispatchProjectCreate`) is what applies it, so this interface
   * carries strings and gets back a verdict. `existingPath` is set only for
   * "that name is already a folder there", so the server can answer with
   * `project-exists` rather than a dead-end failure.
   */
  projectCreate?: (
    name: string,
    parentDir: string,
    deviceName: string
  ) => Promise<{ ok: true } | { ok: false; error: string; existingPath?: string }>

  /**
   * Save a pasted image onto this machine so a pane can be handed its path.
   *
   * Optional: a host that omits it (the smoke fixture, until a phase wires
   * one) answers `unsupported`, which is what an older desktop would say to a
   * newer page. `ext` is a suffix this desktop will actually write — `.png`,
   * `.jpg` — already filtered from the mime by the caller.
   */
  saveInboxImage?: (
    bytes: Uint8Array,
    ext: string
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>

  /**
   * Put a pasted image on this machine's clipboard so an agent that reads
   * images from there (Grok, via Alt+V) can mint a chip. Optional: a host
   * that cannot touch a clipboard (the smoke fixture) omits it and the
   * server falls back to typing the saved path.
   */
  offerClipboardImage?: (bytes: Uint8Array) => boolean

  /* --------------------------------------------------------------- web push
   *
   * The other way of reaching a browser: not down this socket, which only
   * exists while a tab does, but through the vendor's push service, which
   * reaches a browser with no page running at all. All three optional and all
   * three answered by electron/web/push.ts in production — a host without them
   * sends no `pushKey`, so the client never asks to subscribe and the two
   * requests below are never sent.
   *
   * This server holds none of it. It does not know the private key, never
   * builds a payload and never posts to an endpoint; what it does is carry the
   * public key out in `hello-ok` and carry subscriptions back in. The sending
   * is a decision about *what is happening on this desktop* — which pane, how
   * long ago, is anybody already looking — and that lives in web-host.ts beside
   * the things that know.
   */

  /** This desktop's VAPID public key, or undefined when it cannot send push. */
  pushKey?: () => string | undefined
  /**
   * Remember a browser's subscription. Re-sending the same endpoint replaces
   * the record rather than adding a second — see `push-subscribe` in
   * shared/web.ts. `meta` is who said so, for the desktop's own device list.
   */
  pushSubscribe?: (sub: WebPushSubscription, meta: { deviceName?: string; deviceId?: string }) => void
  /** Forget one. Called whether or not the endpoint was ever known. */
  pushUnsubscribe?: (endpoint: string) => void

  /**
   * The number of authenticated browsers changed. Drives the power-save blocker
   * in web-host: a machine that suspends mid-session drops every socket.
   */
  onPresence?: (connected: number) => void

  /**
   * Which sessions a browser currently has open, whenever that set changes.
   *
   * Nothing on the desktop changes shape because of this: watching is not
   * typing, and only typing moves a grid (see the "one PTY, several viewers"
   * block above). So what it buys is a *label*: a pane on the desk that says a
   * browser is reading it, which is worth knowing and cheap to say. The phone's
   * identical hook says the same thing about the same panes.
   *
   * Fired on attach, detach, exit and hangup, with the full set each time; a
   * diff the receiver has to reassemble is a diff that can be missed.
   */
  onWatch?: (ids: string[]) => void

  /* --------------------------------------------------------- screen mirror
   *
   * A browser watching this desktop's own screen, and — behind the gates in
   * electron/web-host.ts — driving it. All four hooks are optional, and a host
   * that supplies none of them simply cannot be watched: a `mirror-start` is
   * refused outright rather than half-started, leaving a tab on a black
   * rectangle. That is what makes `scripts/web-smoke.mjs`'s server, and any
   * future host, safe by not remembering to be.
   *
   * This server relays, counts and gates. It never encodes, never decodes and
   * never looks inside a chunk — the capture and the encoder live in the
   * desktop *renderer*, because that is the half of Electron with a display to
   * capture and a `VideoEncoder` to hand it to. See src/lib/mirror.ts.
   */

  /**
   * Begin a mirror, or say why not.
   *
   * `pin` is whatever the browser presented, unread by this file: whether a PIN
   * is set at all and whether this one matches are decisions with persisted
   * state behind them, and they live beside that state in electron/web/auth.ts.
   *
   * `who` is the asking socket's verified identity — the uid off the token its
   * `hello` presented and the address it came from — so a wrong PIN is counted
   * against the *account* that guessed it rather than an address every tunnel
   * caller shares. See the strike-keying note in electron/web/auth.ts.
   *
   * Null means it has begun — the picture itself arrives later, as
   * `pushMirrorReady` and `pushMirrorFrame` calls. A refusal is a sentence the
   * browser tab shows, plus the one bit that changes what it shows it *in*: see
   * `needsPin` on `WebMirrorStopFrame`.
   */
  mirrorStart?: (
    pin: string,
    who: { uid: string; source: string }
  ) => { error: string; needsPin?: boolean } | null

  /**
   * A browser started or stopped watching this screen.
   *
   * `onPresence`'s twin, and one hook for both edges rather than Forge Mobile's
   * separate `mirrorStop`, because on this link the desk has something to do at
   * each end of a watch and they are not the same something: it says out loud
   * that the screen is being watched when one begins, and tears the capture and
   * the input helper down when one ends. Two hooks that always fire together
   * are two places to forget one.
   *
   * Fired on the *edges* and after the viewer is committed or cleared, so a
   * host that reports its own status from in here reports the truth rather than
   * the state a moment before. A browser restarting a watch it already holds is
   * not an edge and says nothing: the desk has already been told, and a tab
   * retrying in a loop must not be able to raise a notification a second.
   */
  onMirror?: (watching: boolean) => void

  /**
   * May the screen being watched also be *driven* right now?
   *
   * Asked when a picture starts, and answered by settings the desktop's owner
   * switched on deliberately — see `webControlEnabled` in shared/types.ts and
   * the escalation guard in electron/web-host.ts. A host that does not supply
   * this hook can never be controlled.
   */
  mirrorControl?: () => boolean

  /**
   * Perform one input on the desktop. `false` means it was refused — control is
   * off, the escalation guard says no, or this platform has no way to do it —
   * and the server turns that into one sentence per watch rather than a silence
   * the browser has to interpret.
   */
  mirrorInput?: (input: MirrorInput) => boolean

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

/**
 * Mints a viewer id per socket, which is what makes two browsers two viewers.
 *
 * Per *socket* rather than per `deviceId`, deliberately: two tabs on one machine
 * are two people's worth of screen as far as a grid is concerned, and the one
 * being typed into should be the one that gets it. A reconnect is a new viewer
 * with no wish stored, which is correct — the fresh `attach` carries the size it
 * is reading at, and by then the pane it left is unclaimed again.
 */
let viewerSeq = 0

interface Client {
  socket: WebSocket
  source: string
  device: WebDevice | null
  /** This socket's identity for the grid-ownership rule. See `viewerSeq`. */
  viewer: string
  /** Sessions this browser is reading. */
  subs: Set<string>
  /**
   * Whether this tab is on screen, as its last `visibility` request said.
   *
   * False until a browser says otherwise, which is the safe default in the one
   * place it is read: a socket whose visibility is unknown must not be able to
   * swallow a push somebody is waiting for. See `anyVisible`.
   */
  visible: boolean
  /** The second the input counter belongs to, and its tally. See `allowInput`. */
  inputSecond: number
  inputCount: number
  /**
   * The same pair again for `mirror-input`, and deliberately not the same
   * counter. A pointer moving smoothly is thirty frames a second and must not
   * spend the budget that answers this browser's keystrokes — see
   * MAX_MIRROR_INPUT_PER_SECOND in shared/web.ts.
   */
  mirrorSecond: number
  mirrorCount: number
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
  /**
   * The one socket watching this desktop's screen, if any.
   *
   * At most one, ever, and for a sharper reason than Forge Mobile's: there the
   * limit avoided turning a relay into a media server, and here the *desktop*
   * does the encoding, so a second viewer is a second encoder on the machine
   * somebody is trying to work on. A second browser asking is refused with a
   * sentence rather than queued.
   */
  private mirrorViewer: Client | null = null
  /**
   * Whether this watch has already been told its input is not wanted. Reset
   * with the viewer, so switching control on at the desk and watching again
   * gets an honest answer rather than the last watch's silence.
   */
  private refusedControl = false

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

  /**
   * Is anybody actually looking at a Forge Web page right now?
   *
   * The question a push has to ask before it is sent: a notification for a pane
   * on a screen somebody is already watching is noise, and one for the tab they
   * left open behind their laptop lid is the whole feature. Answered from what
   * the browsers themselves said in `visibility` — nothing else on this desktop
   * can know whether a tab in another town is on screen.
   *
   * A connected-but-silent socket counts as not visible. That errs towards
   * sending, which is the right way to be wrong: the cost is a notification
   * beside a page that was open, and the cost of the other mistake is a person
   * who never learns their agent is waiting.
   */
  anyVisible(): boolean {
    for (const client of this.clients) if (client.device && client.visible) return true
    return false
  }

  address(): { host: string; port: number } | null {
    return this.listening
  }

  async start(options: WebServerOptions): Promise<{ host: string; port: number }> {
    if (this.listening) return this.listening

    // Wrapped for the same reason mobile wraps its listener: a throw out of a
    // request handler is an uncaught exception, and nothing in Forge installs
    // a process-level net for one — the answer here is a 500, not a dead app.
    const http = createServer((req, res) => {
      try {
        this.serveHttp(req, res)
      } catch (err) {
        this.log(`http request failed: ${err instanceof Error ? err.message : String(err)}`)
        try {
          if (res.headersSent) res.destroy()
          else res.writeHead(500).end('Server error')
        } catch {
          /* the peer has already gone */
        }
      }
    })
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
      try {
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
        wss.handleUpgrade(req, socket, head, (ws) => {
          try {
            this.accept(ws, source)
          } catch (err) {
            this.log(`accepting a socket failed: ${err instanceof Error ? err.message : String(err)}`)
            try {
              ws.close(1011, 'Server error')
            } catch {
              /* already gone */
            }
          }
        })
      } catch (err) {
        this.log(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`)
        refuseUpgrade(socket, 500, 'Upgrade failed')
      }
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
    // Whoever was watching is not watching any more. Said explicitly rather
    // than left to the drops above, because a screen capture that outlives the
    // server relaying it is a desktop being encoded for nobody — and on this
    // link that is a real encoder burning a real core.
    this.dropViewer(this.mirrorViewer)
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
   * browser sitting at the PIN box deserves to know the desk it is typing into
   * is shutting down as much as a live one does.
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

  /* -------------------------------------------------------- screen mirror */

  /**
   * The capture is up: here is what a decoder needs to be configured with.
   *
   * To the viewer and nobody else, like everything else in this block — this
   * describes a stream of Steve's screen, and broadcasting it the way `pushData`
   * broadcasts terminal bytes would hand it to every connected tab. A no-op when
   * nobody is watching, which is the ordinary shape of a browser that hung up
   * while the renderer was still opening a display.
   *
   * `canControl` is added here rather than carried in by the caller, because the
   * server is the thing that knows a watch has begun and the host is the thing
   * that knows whether it may be driven; asking at the moment the two meet is
   * what keeps a stale yes off this frame.
   */
  pushMirrorReady(config: WebMirrorConfig): void {
    if (!this.mirrorViewer) return
    this.send(this.mirrorViewer, {
      type: 'mirror-ok',
      canControl: this.host.mirrorControl?.() === true,
      ...config
    })
  }

  /**
   * One encoded chunk, on its way to the viewer's decoder.
   *
   * The ceiling is enforced here and nowhere else, because this is the only
   * place an outbound frame can be large: `maxPayload` on the WebSocket server
   * is `ws`'s limit on what it will *read*. A chunk over it ends the watch
   * rather than being dropped — see MAX_MIRROR_CHUNK_BYTES, which sets out why
   * a silently missing keyframe is worse news than a stopped picture.
   *
   * The size is worked out from the base64 rather than by decoding it: three
   * bytes per four characters is exact enough for a ceiling, and decoding half a
   * megabyte to find out whether it is too big to send would be doing the
   * expensive half of the work anyway.
   */
  pushMirrorFrame(chunk: WebMirrorChunk): void {
    if (!this.mirrorViewer) return
    const bytes = Math.floor((chunk.data.length * 3) / 4)
    if (bytes > MAX_MIRROR_CHUNK_BYTES) {
      this.log(`a ${bytes}-byte chunk is over the ${MAX_MIRROR_CHUNK_BYTES}-byte ceiling — ending the watch`)
      this.pushMirrorStop(
        'The picture this desktop produced was too large to send, so the mirror stopped rather than showing a broken one.'
      )
      return
    }
    this.send(this.mirrorViewer, { type: 'mirror-frame', ...chunk })
  }

  /**
   * End the watch from this side, with a sentence the browser can show.
   *
   * The viewer is cleared whether or not the frame lands, so a socket that died
   * between the capture failing and this call cannot leave the server believing
   * it still has a viewer — and refusing the next `mirror-start` on the strength
   * of it.
   */
  pushMirrorStop(reason: string): void {
    const viewer = this.mirrorViewer
    if (viewer) this.send(viewer, { type: 'mirror-stop', reason })
    this.dropViewer(viewer)
  }

  /** Is a browser watching this screen right now? */
  get mirroring(): boolean {
    return this.mirrorViewer !== null
  }

  /**
   * This socket is no longer the viewer, if it ever was — and the host is told,
   * so the capture stops with it.
   *
   * Total against a client that is not the viewer and against null, because it
   * is called from four endings (a hang-up, a `mirror-stop` frame, `stop()`, an
   * oversized chunk) and three of them cannot know whether there is anything to
   * end.
   */
  private dropViewer(client: Client | null): void {
    if (!client || this.mirrorViewer !== client) return
    this.mirrorViewer = null
    this.host.onMirror?.(false)
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
      viewer: `web-${++viewerSeq}`,
      subs: new Set(),
      visible: false,
      inputSecond: 0,
      inputCount: 0,
      mirrorSecond: 0,
      mirrorCount: 0,
      toldLimit: false,
      helloTimer: null,
      pingTimer: null,
      pongTimer: null
    }
    this.clients.add(client)

    // An unauthenticated socket is not allowed to sit there holding a slot, and
    // there is no longer any exception: nothing waits on a human at the desk,
    // so a `hello` is answered — admitted or refused — inside one round trip.
    //
    // The shipped HEARTBEAT_GRACE_MS rather than the injected one, on purpose:
    // this deadline is not part of the heartbeat, and a host that dials the
    // heartbeat down for a test must not accidentally leave a browser a
    // fraction of a second to say hello in.
    client.helloTimer = setTimeout(() => {
      if (!client.device) this.drop(client, CLOSE_UNAUTHENTICATED, 'No hello')
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
      // A throw in here used to leave the socket open and mute: `onHello` is
      // async, it awaits token verification and several injected host
      // callbacks, and an unhandled rejection reaching nobody means the browser
      // waits out the hello deadline and is closed with no frame — which reads
      // on screen as a network fault and is retried forever. Whatever went
      // wrong, the page is told something it can act on, and the desk gets the
      // line that names it.
      void this.handle(client, frame).catch((err: unknown) => {
        this.log(`frame "${frame.type}" failed: ${err instanceof Error ? err.message : String(err)}`)
        this.send(client, {
          type: 'error',
          code: 'failed',
          message: 'The desktop failed while handling that. Nothing was changed by it.'
        })
        if (!client.device) this.drop(client, CLOSE_UNAUTHENTICATED, 'Failed before hello completed')
      })
    })
    socket.on('pong', () => this.schedulePing(client))
    socket.on('close', () => {
      this.clients.delete(client)
      this.clearTimers(client)
      // Redundant with the delete above and written anyway: a socket that has
      // gone is not a screen anybody is looking at, and `anyVisible` deciding
      // otherwise would mean a notification nobody ever sees.
      client.visible = false
      // A browser that hangs up stops the capture behind it. A mirror outliving
      // its viewer is a screen being encoded and sent to a socket that closed,
      // which nothing else in this file would ever notice.
      this.dropViewer(client)
      // A browser that has hung up is not a device anybody is typing on, so it
      // stops holding the grid of anything it held. Unconditional, because a
      // socket that never said hello never owned anything and this costs a walk
      // of an empty map.
      this.host.release?.(client.viewer)
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

    // Ahead of the general budget, and with a counter of its own. A pointer
    // moving smoothly over a mirrored screen is thirty frames a second, and
    // spending the terminal's budget on them would starve the keystrokes this
    // link exists to carry — see MAX_MIRROR_INPUT_PER_SECOND in shared/web.ts.
    if (frame.type === 'mirror-input') return this.onMirrorInput(client, frame)

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
        // Before the replay, so the desktop can label the pane as read from
        // elsewhere as early as possible.
        this.announceWatch()
        // `cols`/`rows` are optional and mean "and this is the size I am reading
        // it at". Omitting them means "I will take whatever size it is", which
        // is what a read-only or thumbnail view should send.
        //
        // Handed over as this viewer's wish and no more than that: opening a
        // pane is not typing into it, so a pane somebody is working on elsewhere
        // does not move because this tab looked at it. It is stored, and it is
        // what lands the instant somebody types here. Nothing is refused out
        // loud — the browser is about to be sent a `replay` at the pane's real
        // grid and has its cols/rows from `sessions`, so it has everything it
        // needs to draw this pane properly whichever way the wish went.
        if (frame.cols !== undefined || frame.rows !== undefined) {
          this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows), client.viewer)
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

      case 'detach': {
        const id = wireString(frame.sessionId, 128)
        client.subs.delete(id)
        // A pane this browser has closed is one it is certainly not typing into,
        // so it stops holding that pane's grid — the same thing a hang-up does,
        // for one pane rather than all of them.
        this.host.release?.(client.viewer, id)
        this.announceWatch()
        return
      }

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
        // Named, because this is the frame the whole geometry policy turns on:
        // typing is what hands a pane's grid to the device it was typed on. What
        // counts as typing is decided past this hook — a browser reading a busy
        // pane sends terminal *replies* down here too, and those are not
        // somebody working. See shared/typing.ts.
        if (!this.host.write(id, data, client.viewer)) {
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
        // A wish, handed over with the name of who wished it. The browser keeps
        // sending these on every box change on purpose: whether one lands
        // depends on whether this is the device somebody last typed on, which
        // can change between two frames, and a client that had to be told the
        // policy would be a client that could hold a stale copy of it.
        this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows), client.viewer)
        return
      }

      case 'request':
        return this.onRequest(client, wireString(frame.rid, 128), frame.body)

      /* --------------------------------------------------- screen mirror
       *
       * Below the authentication gate above, like everything else in this
       * switch: a stranger must not be able to make this desktop start
       * capturing its own screen, and the line that guarantees it is the
       * blanket `!client.device` drop, not anything written here.
       */

      case 'mirror-start': {
        if (!this.host.mirrorStart) {
          this.send(client, { type: 'mirror-stop', reason: 'This Forge cannot share its screen.' })
          return
        }
        // One screen at a time — but the *same* browser asking again is a
        // restart, not a second viewer. A tab whose first attempt died where
        // this side cannot see it (a decoder that would not configure, a
        // reload) leaves the server still believing it has a watcher, and
        // refusing the retry would tell the only browser in the room that it
        // was busy watching itself. The renderer replaces its capture on every
        // start, so a repeat is safe; two different sockets is the case worth
        // refusing.
        if (this.mirrorViewer && this.mirrorViewer !== client) {
          this.send(client, {
            type: 'mirror-stop',
            reason: 'Another browser is already watching this desktop.'
          })
          return
        }
        // The PIN is passed through unread: whether one is set and whether this
        // one matches are decisions with persisted state behind them, and they
        // belong beside that state. The identity travels with it, so the
        // counting a wrong PIN earns lands on the account that guessed rather
        // than on an address a tunnel lets everybody share.
        const refusal = this.host.mirrorStart(wireString(frame.pin, PIN_MAX_DIGITS), {
          uid: client.device.uid,
          source: client.source
        })
        if (refusal) {
          // Refused before it began, so this socket does not become the viewer
          // — it has to be able to ask again once the reason is fixed, and the
          // commonest reason is "type a code", which is a question rather than
          // a failure.
          this.dropViewer(client)
          this.send(client, {
            type: 'mirror-stop',
            reason: refusal.error,
            ...(refusal.needsPin ? { needsPin: true } : {})
          })
          return
        }
        const wasWatching = this.mirrorViewer === client
        this.mirrorViewer = client
        // A fresh watch, so a refusal from the last one is not carried into it.
        // Reset here rather than at every ending because this is the single
        // place a watch begins, and the endings are many.
        this.refusedControl = false
        this.log(`${client.device.name} is watching the screen`)
        // The *edge*, not every start. A restart is the same watch beginning
        // again, and the desk has already said so out loud — a tab retrying in
        // a loop would otherwise be a notification a second until somebody
        // muted the app, which is how a warning stops being one.
        if (!wasWatching) this.host.onMirror?.(true)
        return
      }

      case 'mirror-stop':
        this.dropViewer(client)
        return
    }
  }

  /**
   * The browser driving the desktop's pointer.
   *
   * Four gates, in the order that costs least to fail: it must come from the
   * socket that is currently watching the screen, it must survive a budget of
   * its own, it must parse into one of six exact shapes, and only then is the
   * host asked — whose answer is the last gate, because the settings behind it
   * can change between one frame and the next.
   *
   * "Watching" as the first test is deliberate, and it is the same judgement
   * electron/mobile/server.ts makes: a browser that cannot see the screen has no
   * business pointing at it. Every legitimate input frame is a response to a
   * picture, and a socket with no picture is asking to click on something it
   * cannot see.
   */
  private onMirrorInput(client: Client, frame: Extract<WebClientFrame, { type: 'mirror-input' }>): void {
    // A stranger's input is dropped in silence: a frame arriving from a socket
    // that has just stopped being the viewer is ordinary timing, not something
    // worth an error frame.
    if (this.mirrorViewer !== client) return
    if (!this.allowMirrorInput(client)) return
    const input = readMirrorInput(frame)
    if (!input) {
      this.send(client, {
        type: 'error',
        code: 'bad-frame',
        message: 'That is not an input this desktop understands.'
      })
      return
    }
    if (this.host.mirrorInput?.(input) === true) return
    // Refused. Said once per watch, not once per press: a held button or a
    // dragged pointer sends dozens more frames before anybody can read the
    // first sentence, and a screen full of the same refusal is not more honest
    // than one copy of it.
    if (this.refusedControl) return
    this.refusedControl = true
    // `unsupported` rather than a code of its own: `WebErrorCode` already
    // spells it "this desktop cannot do that at all — an older build, or a
    // disabled feature", which is exactly what a refused control is, and the
    // client's decision is the same either way — stop offering the cursor.
    this.send(client, {
      type: 'error',
      code: 'unsupported',
      message: 'This desktop is not accepting control from a browser. Turn it on in Settings › Forge Web.'
    })
  }

  /**
   * The `mirror-input` budget: a whole second's worth, then silence until the
   * next.
   *
   * A second counter beside `allowInput`, which is the entire point — see
   * MAX_MIRROR_INPUT_PER_SECOND. Silent rather than answered, unlike the
   * terminal's: a dropped pointer frame costs nothing a person notices, because
   * the next one carries the position too (every pointer event carries its own,
   * by design), whereas a dropped keystroke is a word that never got typed.
   */
  private allowMirrorInput(client: Client): boolean {
    const second = Math.floor(this.now() / 1000)
    if (second !== client.mirrorSecond) {
      client.mirrorSecond = second
      client.mirrorCount = 0
    }
    client.mirrorCount += 1
    return client.mirrorCount <= MAX_MIRROR_INPUT_PER_SECOND
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
    if (client.device) return // one hello per socket

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

    const outcome = await this.host.auth.authenticate({
      source: client.source,
      // The same 8192 ceiling auth.ts holds a token to; `wireString`'s default
      // 256 would truncate every real JWT into a broken one.
      idToken: wireString(frame.idToken, 8192),
      deviceId: wireString(frame.deviceId, 128),
      deviceName: wireString(frame.deviceName, 64) || 'Browser',
      // Clamped to the longest PIN there can be, so a megabyte of "PIN" is not
      // a megabyte fed to a key-derivation function once per hello.
      pin: wireString(frame.pin, PIN_MAX_DIGITS)
    })

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
    const pushKey = this.host.pushKey?.()
    this.log(`${outcome.device.name} connected from ${client.source} (client ${wireString(frame.client, 32) || '?'})`)
    this.send(client, {
      type: 'hello-ok',
      proto: WEB_PROTO,
      appVersion: this.host.appVersion,
      desktopName: this.host.desktopName(),
      projects: snapshot.projects,
      profiles: snapshot.profiles,
      workspaces: snapshot.workspaces,
      sessions: this.wireSessions(),
      // Optional on the frame and optional here: spread only when the host
      // named one, so a desktop with no nominated folder sends no field at all
      // rather than an empty string a client has to interpret.
      ...(snapshot.projectsRoot ? { projectsRoot: snapshot.projectsRoot } : {}),
      // The same rule for the push key, and it carries a meaning: a page that
      // is sent no key shows no bell, because a subscription minted against a
      // desktop that cannot send is a permission prompt for nothing.
      ...(pushKey ? { pushKey } : {})
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
    // The uid rides along so a failure counts against the account presenting
    // it, not an address every tunnel caller shares — see the strike-keying
    // note in electron/web/auth.ts.
    const outcome = await this.host.auth.verifyToken(
      wireString(frame.idToken, 8192),
      client.source,
      client.device?.uid
    )
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
        case 'claim': {
          const id = wireString(request.sessionId, 128)
          if (!this.host.sessions().some((s) => s.id === id)) {
            failed('unknown-session', 'That pane is gone.')
            return
          }
          this.host.claim?.(id, client.viewer)
          answer({ kind: 'ok' })
          return
        }
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

        case 'fs-list': {
          if (!this.host.fsList) {
            failed('unsupported', 'This Forge cannot show its folders to a browser.')
            return
          }
          // Both fields are clamped here and understood in
          // electron/web/fs-browse.ts: whether the path is absolute, whether
          // the name is a single segment and whether either exists are
          // questions about *this machine*, and answering them in one place
          // beside the syscalls is what stops two half-checks disagreeing.
          const listing = await this.host.fsList(
            wireString(request.path, MAX_PATH_CHARS),
            wireString(request.name, MAX_NAME_CHARS)
          )
          if (!listing.ok) {
            failed('failed', listing.error)
            return
          }
          answer({ kind: 'folder', folder: listing.folder })
          return
        }

        case 'project-add': {
          if (!this.host.projectAdd) {
            failed('unsupported', 'This Forge cannot add a project for a browser.')
            return
          }
          const path = wireString(request.path, MAX_PATH_CHARS)
          if (!path) {
            failed('bad-frame', 'That request named no folder.')
            return
          }
          const error = await this.host.projectAdd(path, client.device?.name ?? 'Browser')
          if (error) {
            // `failed` rather than `no-window`: unlike a layout op, most of the
            // ways this goes wrong are about the folder — renamed, unplugged,
            // not a folder at all — and only one of them is about the desktop
            // having no window. The sentence says which; the code would only
            // ever be guessing.
            failed('failed', error)
            return
          }
          answer({ kind: 'ok' })
          return
        }

        case 'paste-image': {
          if (!this.host.saveInboxImage) {
            failed('unsupported', 'This Forge cannot take an image from a browser.')
            return
          }
          const id = wireString(request.sessionId, 128)
          if (!id) {
            failed('unknown-session', 'That pane is gone.')
            return
          }
          if (!this.host.sessions().some((s) => s.id === id)) {
            failed('unknown-session', 'That pane is gone.')
            return
          }
          const mime = wireString(request.mime, 32)
          if (!isWebImageMime(mime)) {
            failed('bad-frame', 'That is not an image this desktop will take.')
            return
          }
          const data = typeof request.data === 'string' ? request.data.trim() : ''
          if (!data) {
            failed('bad-frame', 'That image was empty.')
            return
          }
          if (data.length > MAX_IMAGE_BASE64) {
            failed('limit', 'That image is too large to send.')
            return
          }
          if (!/^[A-Za-z0-9+/]+=*$/.test(data)) {
            failed('bad-frame', 'That image could not be read.')
            return
          }
          const bytes = Buffer.from(data, 'base64')
          if (!bytes.length) {
            failed('bad-frame', 'That image was empty.')
            return
          }
          const ext = extForMime(mime)
          if (!ext) {
            failed('bad-frame', 'That is not an image this desktop will take.')
            return
          }
          const saved = await this.host.saveInboxImage(bytes, ext)
          if (!saved.ok) {
            failed('failed', saved.error)
            return
          }
          const session = this.host.sessions().find((s) => s.id === id)
          const into = imagePasteIntoPane(session?.bootstrapCommand ?? '', saved.path)
          const useClipboard = into.wantClipboard && this.host.offerClipboardImage?.(bytes) === true
          const typed = useClipboard ? into.data : `"${saved.path}" `
          if (!this.host.write(id, typed, client.viewer)) {
            failed('unknown-session', 'That pane is gone — the image was saved but nothing was typed.')
            return
          }
          answer({ kind: 'ok' })
          return
        }

        case 'project-create': {
          if (!this.host.projectCreate) {
            failed('unsupported', 'This Forge cannot create a project folder for a browser.')
            return
          }
          // The clamp is the wire's; what a usable folder name is (length,
          // reserved device names, forbidden characters) is decided by the
          // fence in electron/projectfolder.ts, beside the mkdir.
          const name = wireString(request.name, MAX_NAME_CHARS)
          if (!name) {
            failed('bad-frame', 'That request named no folder name.')
            return
          }
          const made = await this.host.projectCreate(
            name,
            wireString(request.parentDir, MAX_NAME_CHARS),
            client.device?.name ?? 'Browser'
          )
          if (made.ok) {
            answer({ kind: 'ok' })
            return
          }
          if (made.existingPath) {
            // Not a dead end: the folder is there and opening it is one
            // explicit click away. See `project-exists` in shared/web.ts.
            answer({ kind: 'project-exists', path: made.existingPath, message: made.error })
            return
          }
          failed('failed', made.error)
          return
        }

        /* --------------------------------------------------------- web push
         *
         * Authenticated like everything else in here, and by the same line:
         * `handle` drops any socket without a `client.device` before a
         * `request` frame is ever unpacked, so there is no gate written here
         * and no second one to forget. What that buys is worth naming — a
         * subscription is a thing this desktop will later post to unbidden, so
         * a stranger being able to leave one would be a stranger arranging to
         * be notified about somebody else's panes.
         */

        case 'push-subscribe': {
          if (!this.host.pushSubscribe) {
            failed('unsupported', 'This Forge cannot send notifications to a browser.')
            return
          }
          const subscription = readPushSubscription(request.subscription)
          if (!subscription) {
            failed('bad-frame', 'That is not a push subscription this desktop can use.')
            return
          }
          this.host.pushSubscribe(subscription, {
            // The name off the subscribe frame when there is one, and the name
            // the socket signed in under otherwise — a device list wants a
            // label, and "Browser" is a better one than blank.
            deviceName: wireString(request.deviceName, 64) || client.device?.name || 'Browser',
            ...(client.device?.id ? { deviceId: client.device.id } : {})
          })
          answer({ kind: 'ok' })
          return
        }

        case 'push-unsubscribe': {
          if (!this.host.pushUnsubscribe) {
            failed('unsupported', 'This Forge cannot send notifications to a browser.')
            return
          }
          const endpoint = wireString(request.endpoint, MAX_PUSH_ENDPOINT_CHARS)
          if (!endpoint) {
            failed('bad-frame', 'That request named no subscription.')
            return
          }
          this.host.pushUnsubscribe(endpoint)
          answer({ kind: 'ok' })
          return
        }

        case 'visibility': {
          // No host hook, because there is nothing for a host to do with it:
          // this is a fact about one socket, it is stored on that socket, and
          // the only reader is `anyVisible`. It dies with the connection.
          client.visible = request.visible === true
          answer({ kind: 'ok' })
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
    // Here as well as in the close handler, and not instead of it. `close`
    // arrives on the next tick, so a browser hung up on for a protocol
    // mismatch or a missed heartbeat would otherwise keep its desktop encoding
    // for it after the drop had supposedly ended things; `dropViewer` is
    // idempotent, so the second call is free.
    this.dropViewer(client)
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

/**
 * A `PushSubscription.toJSON()` off the wire, bounded and rebuilt.
 *
 * Bounds only, and deliberately: whether an endpoint is a real push service and
 * whether the keys will encrypt anything are questions for the sender, and
 * electron/web/push.ts asks them beside the code that would suffer from a bad
 * answer. What this stops is a megabyte of "endpoint" being written to a JSON
 * file on this disk, and it rebuilds field by field so nothing else riding on
 * the object gets stored with it.
 */
function readPushSubscription(value: unknown): WebPushSubscription | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const endpoint = wireString(raw.endpoint, MAX_PUSH_ENDPOINT_CHARS)
  if (!endpoint) return null

  const keys = raw.keys
  if (!keys || typeof keys !== 'object') return null
  const pair = keys as Record<string, unknown>
  const p256dh = wireString(pair.p256dh, MAX_PUSH_KEY_CHARS)
  const auth = wireString(pair.auth, MAX_PUSH_KEY_CHARS)
  if (!p256dh || !auth) return null

  const subscription: WebPushSubscription = { endpoint, keys: { p256dh, auth } }
  // Kept when the browser gave one, because a subscription that expires is a
  // subscription this desktop should stop reasoning about; null is the normal
  // value and carrying it would say nothing.
  if (typeof raw.expirationTime === 'number') subscription.expirationTime = raw.expirationTime
  return subscription
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

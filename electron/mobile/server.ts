import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  APPROVAL_TIMEOUT_MS,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  MAX_INPUT_PER_SECOND,
  MAX_SIGNAL_CHARS,
  MAX_WRITE_CHARS,
  MOBILE_PROTO,
  MOBILE_WS_PATH,
  isVideoId,
  parseFrame,
  readMirrorInput,
  wireDim,
  wireString,
  wordPair,
  type ClientFrame,
  type MirrorInput,
  type MobileSession,
  type OpFrame,
  type ServerFrame
} from '@shared/mobile'
import type { MobileAuth, MobileDevice } from './auth'

/**
 * The Forge Mobile link server.
 *
 * Electron-free with everything injected — the same shape as
 * `electron/companion-sync.ts`, and for the same reason: `scripts/mobile-smoke.mjs`
 * drives *this* class against a real `PtySessionManager` over a real socket,
 * with no Electron and no mocks. A server only ever exercised inside Electron
 * is a server nobody has actually tested.
 *
 * One HTTP server carries both jobs on one port: static hosting for the phone
 * bundle (so Phase 1 is reachable from phone Chrome before any APK exists) and
 * the WebSocket upgrade at MOBILE_WS_PATH.
 *
 * ## The network posture
 *
 * The listener binds where the host tells it to, but every connection is
 * checked against `isAllowedSource` first: loopback, RFC1918 LAN, and the
 * 100.64.0.0/10 carrier-grade NAT range Tailscale hands out. A connection from
 * anywhere else is closed before a byte is read, which means an accidentally
 * port-forwarded router does not turn this into a public shell.
 *
 * A Cloudflare Tunnel is unaffected: `cloudflared` runs on this machine and
 * dials the socket from loopback, so the allowlist sees 127.0.0.1 and the
 * public side never touches this port directly.
 *
 * That check is defence in depth, not the defence. The defence is the token in
 * `auth.ts` — see the honesty note at the top of that file.
 */

export interface MobileServerHost {
  auth: MobileAuth
  appVersion: string
  /**
   * This computer's name, echoed in `hello-ok` so a paired television can
   * recognise this desktop again at a different address. Absent hosts simply
   * do not say, and the field is omitted. See `desktopName` in shared/mobile.ts.
   */
  desktopName?: () => string

  /** Live sessions, as the wire sees them. */
  sessions: () => MobileSession[]
  /** The 192KB catch-up buffer from pty-host, or '' if there is none. */
  replay: (id: string) => string
  /* ------------------------------------------------ one PTY, several viewers
   *
   * A PTY has one grid and this link gives it another viewer, so something has
   * to decide whose size wins. This server does not: it *names the viewer* on
   * every frame that could bear on the question and leaves the policy to
   * electron/pty/grid-owner.ts, which is the one place it is written down.
   *
   * The rule there, in a line: **the grid belongs to the device that last typed
   * into the pane.** Type on the phone and the phone's `cols`/`rows` are
   * honoured on the real PTY — native, at the width a handset can actually read
   * — and type at the desk and the desk takes it back on the first keystroke.
   * Taking the phone out of a pocket and looking at it moves nothing, which is
   * why the `resize` case below hands its size over unconditionally rather than
   * gating it.
   *
   * A host that ignores the argument gets the old unconditional behaviour, which
   * is also what an unowned pane does: yes.
   */

  /** `viewer` is this socket's identity — see the block above. */
  write: (id: string, data: string, viewer: string) => boolean
  resize: (id: string, cols: number, rows: number, viewer: string) => boolean

  /**
   * A phone stopped reading one pane (`id` given) or went away entirely.
   *
   * Optional, and the departure half of the ownership rule: a device that has
   * hung up is not one somebody is typing on, so anything it held goes back to
   * unclaimed and the next wish — very often the desk's own next fit — takes it.
   * Without this a phone put down mid-pane would keep the grid it left behind
   * until somebody typed somewhere.
   */
  release?: (viewer: string, id?: string) => void

  /** The opening picture: whatever the phone needs to draw a project list. */
  snapshot: () => Pick<import('@shared/mobile').HelloOkFrame, 'projects' | 'profiles' | 'workspaces'>

  /**
   * Run a layout operation. Implemented by mobile-host by forwarding to the
   * renderer, which owns tabs and panes. Resolves to an error sentence, or null
   * when it worked.
   */
  dispatchOp: (op: OpFrame, deviceName: string) => Promise<string | null>

  /**
   * The number of authenticated phones changed. Drives the power-save blocker
   * in mobile-host: a machine that suspends mid-session drops every socket.
   */
  onPresence?: (connected: number) => void

  /**
   * Which sessions a phone currently has open, whenever that set changes.
   *
   * Nothing on the desktop changes shape because of this: watching is not
   * typing, and only typing moves a grid (see the "one PTY, several viewers"
   * block above). So what it buys is a *label*: a pane on the desk that says a
   * phone is reading it, which is worth knowing and cheap to say.
   *
   * Fired on subscribe, unsubscribe, exit and hangup, with the full set each
   * time — a diff the receiver has to reassemble is a diff that can be missed.
   */
  onWatch?: (ids: string[]) => void

  /* ------------------------------------------------- pairing by approval
   *
   * The tap-to-pair flow: a phone with no credential asks, a prompt goes up
   * on the desktop, and Steve's tap replaces the typed code — it does not
   * replace the authorisation. All four hooks are optional; a host that
   * provides none of them simply has no approval door at all.
   */

  /**
   * When "Accept new phones" disarms itself (ms epoch), 0 when it is not
   * armed. Read on every `requestPair`, so disarming takes effect on the very
   * next hello rather than whenever a timer happens to fire.
   */
  acceptUntil?: () => number
  /**
   * Put the question to the human, and resolve with the verdict. The server
   * treats a rejection exactly like a false — every path that is not an
   * explicit allow is a deny.
   */
  requestApproval?: (ask: MobileApprovalAsk) => Promise<boolean>
  /**
   * The question is moot — the phone hung up or the wait timed out. The host
   * takes the prompt down; a prompt that outlives its socket is one whose
   * Allow lands on nothing.
   */
  cancelApproval?: (requestId: string) => void

  /**
   * Injected so the smoke test can drive a fake clock (arming expiry, the
   * prompt cooldown) and real-but-short timers (the approval wait) without
   * sleeping through the production values. Defaults are the shipped ones.
   */
  now?: () => number
  approvalTimeoutMs?: number
  promptCooldownMs?: number

  /* --------------------------------------------------------- screen mirror
   *
   * The television watching the desktop's own screen. All three hooks are
   * optional, and a host that supplies none of them simply cannot be watched:
   * the server refuses a `mirror-start` outright rather than half-starting
   * something and leaving a television on a black screen.
   *
   * This server relays and counts; it never looks inside a payload. WebRTC
   * belongs in a renderer — the main process has no peer connection to offer —
   * so mobile-host forwards these to the window. See src/lib/mirror.ts.
   */

  /**
   * Begin a mirror. Returns an error sentence when it cannot start at all, or
   * null; the picture itself arrives later, as `pushMirrorSignal` calls. The
   * sentence is shown on the television, so it is written for one.
   */
  mirrorStart?: () => string | null
  /** One signaling payload from the viewer, verbatim. Opaque to this server. */
  mirrorSignal?: (data: string) => void
  /** The viewer stopped watching, or went away. Tear the capture down. */
  mirrorStop?: () => void

  /**
   * May the screen being watched also be *driven* right now?
   *
   * Asked at every hello, and answered by a setting the desktop's owner
   * switched on deliberately — see `mobileControlEnabled` in shared/types.ts.
   * A host that does not supply this hook can never be controlled, which is
   * what makes the smoke test's server, and any future host, safe by default.
   */
  mirrorControl?: () => boolean
  /**
   * Perform one input on the desktop. `false` means it was refused — control is
   * off, or this platform has no way to do it — and the server turns that into
   * one sentence for the television rather than a silence.
   */
  mirrorInput?: (input: MirrorInput) => boolean

  /** Where the phone bundle lives on disk. Static hosting is off when absent. */
  webRoot?: string
  /**
   * The built Fire TV APK's path on disk, or '' when there is none.
   *
   * Read per request, never cached: the file appears the moment a build
   * finishes, and a path resolved at start-up would 404 until the next restart.
   * A television has no cable and no file manager — the only way onto one is a
   * URL typed into its Downloader app with a remote — so this is how the APK
   * gets from `dist-apk` to the TV. It rides the same `isAllowedSource` gate as
   * everything else on this port, which is what keeps it a LAN answer.
   */
  tvApk?: () => string
  log?: (line: string) => void
}

/** What the desktop prompt needs to ask a human the question. */
export interface MobileApprovalAsk {
  requestId: string
  deviceId: string
  /** What the phone calls itself. Untrusted text — display it, never obey it. */
  deviceName: string
  /** The pair both screens show, e.g. "OTTER RIVER". */
  words: string
  /**
   * This device id is already in the paired list — a returning device asking
   * again, not a stranger. Changes what the prompt *says*, never what Allow
   * does: the answer is still a human's, and Deny is still the default.
   */
  known: boolean
}

export interface MobileServerOptions {
  host: string
  port: number
}

/**
 * Mints a viewer id per socket, which is what makes a phone and a television two
 * viewers rather than one. Per *socket* rather than per paired device, on the
 * same reasoning electron/web/server.ts gives: a reconnect is a new viewer with
 * no wish stored, and by then the pane it left is unclaimed again.
 */
let viewerSeq = 0

interface Client {
  socket: WebSocket
  source: string
  device: MobileDevice | null
  /** This socket's identity for the grid-ownership rule. See `viewerSeq`. */
  viewer: string
  subs: Set<string>
  alive: boolean
  /** Set while a human is being asked about this socket. See beginApproval. */
  approval: ApprovalWait | null
}

interface ApprovalWait {
  requestId: string
  /** Captured at hello time, so the mint on Allow needs nothing off the wire. */
  deviceId: string
  deviceName: string
  /** Closes the socket if nobody answers. See APPROVAL_TIMEOUT_MS. */
  timer: NodeJS.Timeout
  /**
   * The wait has exactly one outcome, whichever of allow / deny / timeout /
   * hangup arrives first. Everything that can settle it checks this flag, so
   * a timeout racing a tap can never mint after a close — or close after a
   * mint.
   */
  settled: boolean
}

/**
 * Floor between approval prompts, sharing a rationale with the single-pending
 * rule below: a script must not be able to queue a thousand prompts so that
 * Steve taps Allow on one by accident. Prompt fatigue is how people get owned,
 * and one prompt a minute is slower than anyone fatigues.
 */
const PROMPT_COOLDOWN_MS = 60_000

/**
 * The Fire TV APK's name and its one URL on this server.
 *
 * Stable on purpose, and the reason is a remote control: installing onto a
 * television means typing this into the Downloader app's address box, one
 * character at a time, with a D-pad. A name that carried a version would have
 * to be retyped after every rebuild. `scripts/apk-tv-build.mjs` writes the same
 * name into `dist-apk/`.
 */
export const TV_APK_NAME = 'forge-tv.apk'
export const TV_APK_PATH = `/${TV_APK_NAME}`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
}

export class MobileServer {
  private readonly host: MobileServerHost
  private readonly now: () => number
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private heartbeat: NodeJS.Timeout | null = null
  private listening: { host: string; port: number } | null = null
  /**
   * At most one approval in flight, ever. The second phone to ask while one is
   * pending is refused before any prompt exists — see beginApproval.
   */
  private pendingApproval: Client | null = null
  /** When the last prompt was raised, for PROMPT_COOLDOWN_MS. */
  private lastPromptAt = 0
  /**
   * The one socket watching this desktop's screen, if any.
   *
   * At most one, ever. Relaying a single peer connection is a seam; fanning
   * one capture out to N of them is a media server, which is a different piece
   * of software with a different set of problems. A second `mirror-start` is
   * refused with a sentence rather than queued.
   */
  private mirrorViewer: Client | null = null
  /**
   * Whether this watch has already been told its input is not wanted. Reset
   * with the viewer, so switching control on at the desk and watching again
   * gets an honest answer rather than the last watch's silence.
   */
  private refusedInput = false
  /** The second the input counter belongs to, and its tally. See `allowInput`. */
  private inputSecond = 0
  private inputCount = 0
  /** The last set handed to `onWatch`, so an unchanged set says nothing. */
  private announcedWatch = ''

  constructor(host: MobileServerHost) {
    this.host = host
    this.now = host.now ?? ((): number => Date.now())
  }

  get connectedCount(): number {
    return [...this.clients].filter((c) => c.device).length
  }

  address(): { host: string; port: number } | null {
    return this.listening
  }

  async start(options: MobileServerOptions): Promise<{ host: string; port: number }> {
    if (this.listening) return this.listening

    const http = createServer((req, res) => this.serveStatic(req, res))
    // `noServer` so the upgrade is only accepted on MOBILE_WS_PATH and only
    // from an allowed source — a WebSocketServer bound directly to the http
    // server would answer any path.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

    http.on('upgrade', (req, socket, head) => {
      const source = sourceOf(req)
      const path = (req.url ?? '').split('?')[0]
      if (path !== MOBILE_WS_PATH || !isAllowedSource(source)) {
        socket.destroy()
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
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
    this.log(`listening on ${options.host}:${options.port}`)
    return this.listening
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const client of [...this.clients]) this.drop(client, 1001, 'Server stopping')
    this.clients.clear()
    // Whoever was watching is not watching any more. Said explicitly rather
    // than left to the close handlers above, because a screen capture that
    // outlives the server relaying it is a desktop being encoded for nobody.
    if (this.mirrorViewer) {
      this.mirrorViewer = null
      this.host.mirrorStop?.()
    }
    this.wss?.close()
    this.wss = null
    const http = this.http
    this.http = null
    this.listening = null
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  /* -------------------------------------------------------------- outbound */

  /** Terminal output from pty-host. Only reaches phones that subscribed to it. */
  pushData(id: string, data: string): void {
    for (const client of this.clients) {
      if (client.device && client.subs.has(id)) this.send(client, { t: 'data', id, data })
    }
  }

  pushExit(id: string, exitCode: number): void {
    for (const client of this.clients) {
      if (client.device && client.subs.has(id)) {
        client.subs.delete(id)
        this.send(client, { t: 'exit', id, exitCode })
      }
    }
    this.announceWatch()
  }

  /**
   * Tell the host which sessions are being read from a phone, when that has
   * changed. The union across every socket, because two phones on one pane is
   * still "a phone is reading this".
   */
  private announceWatch(): void {
    if (!this.host.onWatch) return
    const ids = new Set<string>()
    for (const client of this.clients) {
      if (!client.device) continue
      for (const id of client.subs) ids.add(id)
    }
    const list = [...ids].sort()
    const key = list.join(' ')
    if (key === this.announcedWatch) return
    this.announcedWatch = key
    this.host.onWatch(list)
  }

  /** Something changed on the desktop — broadcast to every authenticated phone. */
  pushState(state: Omit<import('@shared/mobile').StateFrame, 't'>): void {
    for (const client of this.clients) {
      if (client.device) this.send(client, { t: 'state', ...state })
    }
  }

  /** Close any live socket belonging to a revoked device, immediately. */
  disconnectDevice(deviceId: string): void {
    for (const client of [...this.clients]) {
      if (client.device?.id === deviceId) this.drop(client, 4003, 'Device revoked')
    }
  }

  /**
   * One signaling payload for the television, verbatim.
   *
   * To the viewer and nobody else: this string describes how to reach a stream
   * of Steve's screen, and broadcasting it the way `pushData` broadcasts
   * terminal bytes would hand that to every connected phone. A no-op when
   * nobody is watching, which is the ordinary shape of a viewer that hung up
   * mid-negotiation while the desktop was still answering.
   */
  pushMirrorSignal(data: string): void {
    if (!this.mirrorViewer) return
    this.send(this.mirrorViewer, { t: 'mirror-signal', data })
  }

  /**
   * End the watch from this side, with a sentence the television can show.
   *
   * The viewer is cleared whether or not the frame lands, so a socket that
   * died between the capture failing and this call cannot leave the server
   * believing it still has a viewer — and refusing the next `mirror-start`.
   */
  pushMirrorStop(reason: string): void {
    const viewer = this.mirrorViewer
    this.mirrorViewer = null
    if (viewer) this.send(viewer, { t: 'mirror-stop', reason })
  }

  /** Is a television watching this screen right now? */
  get mirroring(): boolean {
    return this.mirrorViewer !== null
  }

  /**
   * This socket is no longer the viewer, if it ever was — and the host is told,
   * so the capture stops with it.
   */
  private dropViewer(client: Client): void {
    if (this.mirrorViewer !== client) return
    this.mirrorViewer = null
    this.host.mirrorStop?.()
  }

  /* --------------------------------------------------------------- inbound */

  private accept(socket: WebSocket, source: string): void {
    const client: Client = {
      socket,
      source,
      device: null,
      viewer: `phone-${++viewerSeq}`,
      subs: new Set(),
      alive: true,
      approval: null
    }
    this.clients.add(client)

    // An unauthenticated socket is not allowed to sit there holding a slot —
    // with one exception: a socket *waiting on a human* has said its hello and
    // must not be cut off mid-question. It is not immortal either; its own
    // wait is bounded by APPROVAL_TIMEOUT_MS in beginApproval.
    const helloTimer = setTimeout(() => {
      if (!client.device && !client.approval) this.drop(client, 4001, 'No hello')
    }, HEARTBEAT_GRACE_MS)

    socket.on('message', (raw) => {
      const frame = parseFrame(String(raw))
      if (!frame) {
        this.send(client, { t: 'err', code: 'bad-frame', msg: 'Unreadable frame' })
        return
      }
      void this.handle(client, frame)
    })
    socket.on('pong', () => {
      client.alive = true
    })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      this.clients.delete(client)
      // A phone that hangs up mid-approval takes its question with it — the
      // desktop prompt is withdrawn, or Steve would be left approving a socket
      // that no longer exists (and priming an Allow for the next asker).
      this.abandonApproval(client)
      // A television that hangs up stops the capture behind it. A mirror
      // outliving its viewer is a screen being encoded and sent to a socket
      // that closed — which nothing else in this file would ever notice.
      this.dropViewer(client)
      // A phone that has hung up is not a device anybody is typing on, so it
      // stops holding the grid of anything it held. Unconditional, because a
      // socket that never said hello never owned anything and this costs a walk
      // of an empty map.
      this.host.release?.(client.viewer)
      if (client.device) {
        this.log(`${client.device.name} disconnected`)
        this.host.onPresence?.(this.connectedCount)
        // A phone that hangs up is no longer reading anything, so the desktop
        // takes its panes back — including after a tunnel drops mid-pane.
        this.announceWatch()
      }
    })
    socket.on('error', () => this.drop(client, 1011, 'Socket error'))
  }

  private async handle(client: Client, frame: ClientFrame): Promise<void> {
    if (frame.t === 'hello') return this.onHello(client, frame)

    // Everything below this line requires authentication — with one carve-out.
    // A socket waiting on approval is unauthenticated by definition, but the
    // phone pings every ~15 seconds through the wait to keep the link warm;
    // hanging up on that ping would make the phone reconnect and ask again,
    // minting *fresh words* while Steve is still comparing the old ones. So a
    // waiting socket may ping, and nothing else. The blanket drop stays here
    // rather than in each handler so a new frame type cannot arrive without it.
    if (!client.device) {
      if (frame.t === 'ping' && client.approval) {
        this.send(client, { t: 'pong' })
        return
      }
      this.drop(client, 4001, 'Not authenticated')
      return
    }

    switch (frame.t) {
      case 'ping':
        this.send(client, { t: 'pong' })
        return

      case 'sub': {
        const id = wireString(frame.id, 128)
        if (!this.host.sessions().some((s) => s.id === id)) {
          this.send(client, { t: 'err', code: 'unknown-session', msg: 'That pane is gone' })
          return
        }
        client.subs.add(id)
        // Before the replay, so the desktop can label the pane as read from
        // elsewhere as early as possible.
        this.announceWatch()
        // Catch-up first, then live data. Same buffer a reloading renderer gets.
        this.send(client, { t: 'replay', id, data: this.host.replay(id) })
        return
      }

      case 'unsub': {
        const id = wireString(frame.id, 128)
        client.subs.delete(id)
        // A pane this phone has closed is one it is certainly not typing into,
        // so it stops holding that pane's grid — the same thing a hang-up does,
        // for one pane rather than all of them.
        this.host.release?.(client.viewer, id)
        this.announceWatch()
        return
      }

      case 'write': {
        const id = wireString(frame.id, 128)
        const data = typeof frame.data === 'string' ? frame.data : ''
        if (!data) return
        if (data.length > MAX_WRITE_CHARS) {
          this.send(client, { t: 'err', code: 'bad-frame', msg: 'Write too large' })
          return
        }
        // The boolean matters. `write` is the one frame that carries something
        // the sender composed — a dictated prompt, a typed command — and the
        // client throws its draft away the moment it hands it over. A pane that
        // exited while the phone was in a pocket would otherwise swallow the
        // words and answer exactly as a successful write does, which is the
        // worst thing a remote can do: look like it worked.
        // Named, because this is the frame the whole geometry policy turns on:
        // typing is what hands a pane's grid to the device it was typed on. What
        // counts as typing is decided past this hook — a phone reading a busy
        // pane sends terminal *replies* down here too, and those are not
        // somebody working. See shared/typing.ts.
        if (!this.host.write(id, data, client.viewer)) {
          this.send(client, { t: 'err', code: 'unknown-session', msg: 'That pane is gone — nothing was typed' })
        }
        return
      }

      case 'resize': {
        const id = wireString(frame.id, 128)
        const current = this.host.sessions().find((s) => s.id === id)
        // Unlike `write`, a resize for a pane that has gone is not worth a
        // sentence: it carries nothing the user composed, and the client is
        // about to be told the session ended anyway. Silence here is the same
        // silence `sub` would break, one frame later.
        if (!current) return
        // A wish, handed over with the name of who wished it. The phone keeps
        // sending these on every keyboard slide on purpose: whether one lands
        // depends on whether this is the device somebody last typed on, which
        // can change between two frames, and a client that had to be told the
        // policy would be a client that could hold a stale copy of it.
        this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows), client.viewer)
        return
      }

      case 'op': {
        const error = await this.host.dispatchOp(frame, client.device.name)
        if (error) this.send(client, { t: 'err', code: 'no-window', msg: error })
        return
      }

      /**
       * "Play this on the TV" — the one frame this server relays rather than
       * acts on. A phone sends it up, every *other* authenticated client gets
       * it down, and in practice that is the television (see TvPlayFrame).
       *
       * Broadcast rather than addressed, because nothing on this wire names a
       * device: the desktop would have to know which socket is a TV, and the
       * only devices here are Steve's own paired ones. A phone that ignores
       * the frame it did not ask for costs nothing; a routing table the user
       * has to maintain costs a screen.
       *
       * The id is re-checked here rather than passed through, and against the
       * strict rule rather than the phone's forgiving one: what travels on this
       * wire is an id and never a URL (see TvPlayFrame), because "the sender
       * checked" is not something this side can observe, and what leaves this
       * method ends up in an address a television opens.
       */
      case 'tv-play': {
        const video = frame.video
        if (!isVideoId(video)) {
          this.send(client, { t: 'err', code: 'bad-frame', msg: 'That is not a YouTube video id' })
          return
        }
        let sent = 0
        for (const other of this.clients) {
          if (other === client || !other.device) continue
          this.send(other, { t: 'tv-play', video })
          sent += 1
        }
        this.log(`${client.device.name} sent ${video} to ${sent} other device${sent === 1 ? '' : 's'}`)
        if (sent === 0) this.send(client, { t: 'err', code: 'no-window', msg: 'Nothing else is connected to play it.' })
        return
      }

      /* --------------------------------------------------- screen mirror
       *
       * Below the authentication gate above, like everything else in this
       * switch: a stranger must not be able to make this desktop start
       * capturing its own screen, and the one line that guarantees that is
       * the blanket `!client.device` drop, not anything written here.
       */

      case 'mirror-start': {
        if (!this.host.mirrorStart) {
          this.send(client, { t: 'mirror-stop', reason: 'This Forge cannot share its screen.' })
          return
        }
        // One screen at a time still — but the *same* screen asking again is a
        // restart, not a second viewer. A television whose first attempt died
        // on its own end (its no-answer deadline, a peer that never connected)
        // leaves this side still believing it has a watcher, and refusing the
        // retry told the one screen in the room that it was busy watching
        // itself. The renderer replaces its capture on every start, so a repeat
        // is safe here; two different sockets is the case worth refusing.
        if (this.mirrorViewer && this.mirrorViewer !== client) {
          this.send(client, {
            t: 'mirror-stop',
            reason: 'Another screen is already watching this desktop.'
          })
          return
        }
        const error = this.host.mirrorStart()
        if (error) {
          // Refused before it began, so this socket does not become the
          // viewer — it must be able to ask again once the reason is fixed.
          this.mirrorViewer = null
          this.send(client, { t: 'mirror-stop', reason: error })
          return
        }
        this.mirrorViewer = client
        // A fresh watch, so a refusal from the last one is not carried into it.
        // Reset here rather than at every ending because this is the single
        // place a watch begins, and the endings are many.
        this.refusedInput = false
        this.log(`${client.device.name} is watching the screen`)
        return
      }

      case 'mirror-signal': {
        // Only the viewer's signaling counts, and a stranger's is dropped in
        // silence: a frame arriving from a socket that has just stopped being
        // the viewer is ordinary timing, not something worth an error.
        if (this.mirrorViewer !== client) return
        const data = frame.data
        if (typeof data !== 'string' || data.length > MAX_SIGNAL_CHARS) {
          this.send(client, { t: 'err', code: 'bad-frame', msg: 'Signalling payload rejected' })
          return
        }
        // Verbatim, and unread. This server has no WebRTC stack and must not
        // grow one — see the screen-mirror block in shared/mobile.ts.
        this.host.mirrorSignal?.(data)
        return
      }

      case 'mirror-stop':
        this.dropViewer(client)
        return

      /**
       * The remote driving the desktop's pointer.
       *
       * Three gates, in the order that costs the least to fail: it must come
       * from the socket that is currently watching the screen, it must survive
       * a rate limit, and it must parse into one of five exact shapes. Only
       * then is the host asked — and the host's own answer is the fourth gate,
       * because the setting behind it can change between one frame and the
       * next.
       *
       * "Watching" as the first test is deliberate. A device that cannot see
       * the screen has no business pointing at it: every legitimate input frame
       * is a response to a picture, and a socket with no picture is asking to
       * click on something it cannot see.
       */
      case 'mirror-input': {
        if (this.mirrorViewer !== client) return
        if (!this.allowInput()) return
        const input = readMirrorInput(frame)
        if (!input) {
          this.send(client, { t: 'err', code: 'bad-frame', msg: 'That is not an input this desktop understands' })
          return
        }
        if (this.host.mirrorInput?.(input)) return
        // Refused. Said once per watch, not once per press: a remote that has
        // just been told no will send a dozen more frames from the same held
        // button, and a screen full of the same sentence is not more honest
        // than one copy of it.
        if (this.refusedInput) return
        this.refusedInput = true
        this.send(client, {
          t: 'err',
          code: 'locked',
          msg: 'This desktop is not accepting a remote control. Turn it on in Settings › Forge Mobile.'
        })
        return
      }
    }
  }

  /**
   * The input rate limit: a whole second's worth, then silence until the next.
   *
   * A pointer moving smoothly sends well under this, because the television
   * coalesces its own movement and reports where the cursor *is* rather than
   * every step it took. The ceiling exists because this is the one frame on
   * this wire that ends in a synthetic event at the operating system, and a
   * paired device gone wrong should run out of budget rather than run the
   * desktop.
   *
   * Whole-second buckets rather than a sliding window: the failure it guards
   * against is a flood, not a burst, and a counter and a timestamp are
   * something anybody reading this can verify at a glance.
   */
  private allowInput(): boolean {
    const second = Math.floor(this.now() / 1000)
    if (second !== this.inputSecond) {
      this.inputSecond = second
      this.inputCount = 0
    }
    this.inputCount += 1
    return this.inputCount <= MAX_INPUT_PER_SECOND
  }

  private onHello(client: Client, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    if (client.device || client.approval) return // one hello per socket

    if (Number(frame.proto) !== MOBILE_PROTO) {
      this.send(client, {
        t: 'err',
        code: 'proto',
        msg: `This Forge speaks protocol ${MOBILE_PROTO}; the app speaks ${frame.proto}. Update one of them.`
      })
      this.drop(client, 4002, 'Protocol mismatch')
      return
    }

    const token = wireString(frame.token, 512)

    // Pairing by approval — only for a hello with no credential at all, and
    // only while the door is open for this particular caller (see
    // `acceptingPairs`). When it is not, the flag is *ignored* rather than
    // answered: the hello falls through to the ordinary no-credential refusal
    // below, indistinguishable from one that never carried the flag. Anyone
    // probing the tunnel hostname learns nothing about whether this door
    // exists, and — the point — cannot make prompts appear on Steve's screen.
    const helloDeviceId = wireString(frame.deviceId, 128)
    if (frame.requestPair === true && !token && this.acceptingPairs(helloDeviceId)) {
      this.beginApproval(client, frame)
      return
    }

    const result = this.host.auth.authenticate({
      source: client.source,
      deviceId: wireString(frame.deviceId, 128),
      deviceName: wireString(frame.deviceName, 64) || 'Phone',
      // A pairing token is presented in the same field; the two are told apart
      // by length, since a device token is 32 bytes base64url (43 chars) and a
      // pairing token is 16 (22 chars).
      token: token.length > 30 ? token : undefined,
      pairToken: token.length > 0 && token.length <= 30 ? token : undefined
    })

    if (!result.ok) {
      this.log(`auth refused from ${client.source}: ${result.msg}`)
      this.send(client, { t: 'err', code: result.code, msg: result.msg })
      this.drop(client, 4001, result.msg)
      return
    }

    this.welcome(client, result.device, result.issuedToken)
  }

  /**
   * The single successful ending to a hello, whichever door it came through —
   * a stored token, the QR code, or a tapped Allow. One routine on purpose:
   * the phone must not be able to tell the routes apart afterwards, and a
   * shared ending is what makes that a structural fact rather than a hope.
   */
  private welcome(client: Client, device: MobileDevice, issuedToken?: string): void {
    client.device = device
    const snapshot = this.host.snapshot()
    this.log(`${device.name} connected from ${client.source}`)
    this.send(client, {
      t: 'hello-ok',
      proto: MOBILE_PROTO,
      appVersion: this.host.appVersion,
      deviceName: device.name,
      // Sent only when the host knows it, so an older Forge and a host that
      // declines to say are the same thing on the wire.
      ...(this.host.desktopName?.() ? { desktopName: this.host.desktopName() } : {}),
      sessions: this.host.sessions(),
      ...snapshot,
      // What this desktop will let a remote control do, as it stands right now.
      // Sent only when it is true: absent is what an older desktop says, and a
      // television reads both the same way — no cursor. See `mirrorInput`.
      ...(this.host.mirrorControl?.() ? { canControl: true } : {}),
      // Present exactly once, on the connection that paired.
      ...(issuedToken ? { deviceToken: issuedToken } : {})
    })
    this.host.onPresence?.(this.connectedCount)
  }

  /* ------------------------------------------------- pairing by approval */

  /**
   * Is the tap-to-pair door open for this caller right now? Read per-hello,
   * never cached.
   *
   * Two ways in, and the second one is a deliberate loosening.
   *
   *  - **Armed.** "Accept new phones" is on, and anybody may ask. This is the
   *    door for a device the desktop has never met.
   *  - **Already known.** The hello names a `deviceId` that is in the paired
   *    list, and the desktop lets it ask without being armed first.
   *
   * The second exists because of one real situation: a television is paired,
   * the laptop leaves the house and comes back on a different DHCP address, and
   * its token — which the television will not send to an address it has not
   * confirmed — is useless until somebody walks to the desk and arms a window.
   * Requiring that turns "press Allow" into "find the setting, arm it, then
   * press Allow", for a device already sitting in the list.
   *
   * What it does *not* loosen: nothing is issued without a human pressing Allow
   * on this machine, the one-pending and one-prompt-a-minute rules still bound
   * how often a prompt can appear at all, and a device id is 128 bits of the
   * phone's own randomness — it is not guessable, so this is not a door a
   * stranger on the network can knock on. A revoked device is gone from the
   * list and gets the ordinary refusal, which is the property revoke exists for.
   */
  private acceptingPairs(deviceId: string): boolean {
    if (!this.host.requestApproval) return false
    if ((this.host.acceptUntil?.() ?? 0) > this.now()) return true
    return this.knows(deviceId)
  }

  /** Is this device id already in the paired list? '' is never known. */
  private knows(deviceId: string): boolean {
    if (!deviceId) return false
    return this.host.auth.devices().some((device) => device.id === deviceId)
  }

  /**
   * A credential-less phone asked to pair while the desktop is armed: mint the
   * word pair, tell the phone to show it, and hold the socket open —
   * unauthenticated — while a human is asked.
   */
  private beginApproval(client: Client, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    // At most one pending approval, and no more than one prompt a minute.
    // Both rules exist for the same reason (see PROMPT_COOLDOWN_MS), and both
    // refuse with the same sentence, so a caller cannot tell which one it hit.
    const cooldownMs = this.host.promptCooldownMs ?? PROMPT_COOLDOWN_MS
    if (this.pendingApproval || this.now() - this.lastPromptAt < cooldownMs) {
      const msg = 'The desktop is already handling a pairing — try again in a minute.'
      this.send(client, { t: 'err', code: 'limit', msg })
      this.drop(client, 4001, msg)
      return
    }

    const deviceId = wireString(frame.deviceId, 128)
    const deviceName = wireString(frame.deviceName, 64) || 'Phone'
    // The pair is not a secret (4096 possibilities is not entropy), but it
    // must be unpredictable, or a stranger timing their ask to Steve's real
    // pairing could show the matching words. So: node:crypto, not Math.random.
    const words = wordPair(randomBytes(2))
    const requestId = randomUUID()

    const wait: ApprovalWait = {
      requestId,
      deviceId,
      deviceName,
      settled: false,
      // A socket waiting on a human escaped the 10-second no-hello drop in
      // accept(), so this is its bound instead: nobody standing at the desktop
      // must not mean a connection pinned open until the process restarts.
      timer: setTimeout(
        () => this.settleApproval(client, false, 'Nobody answered on the desktop — open Forge and try again.'),
        this.host.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
      )
    }
    client.approval = wait
    this.pendingApproval = client
    this.lastPromptAt = this.now()

    this.send(client, { t: 'awaiting-approval', words })
    this.log(`"${deviceName}" is asking to pair from ${client.source}`)

    this.host.requestApproval!({ requestId, deviceId, deviceName, words, known: this.knows(deviceId) })
      .then((allowed) => this.settleApproval(client, allowed === true, 'The desktop said no.'))
      .catch(() => this.settleApproval(client, false, 'The desktop could not ask.'))
  }

  /**
   * The one exit from an approval wait. Allow mints and welcomes; everything
   * else — deny, timeout, a host that threw — closes 4001 with a sentence the
   * phone can show. `settled` makes the outcomes race-proof: whichever of
   * tap / timeout / hangup lands first wins, and the rest are no-ops.
   */
  private settleApproval(client: Client, allowed: boolean, refusal: string): void {
    const wait = client.approval
    if (!wait || wait.settled) return
    wait.settled = true
    clearTimeout(wait.timer)
    if (this.pendingApproval === client) this.pendingApproval = null
    // Withdraw the desktop prompt whichever way this ended — a no-op when the
    // prompt itself is what answered.
    this.host.cancelApproval?.(wait.requestId)

    if (!allowed || client.socket.readyState !== client.socket.OPEN) {
      this.send(client, { t: 'err', code: 'auth', msg: refusal })
      this.drop(client, 4001, refusal)
      return
    }

    // Steve said yes: mint through the same routine the code path uses, and
    // answer with the same hello-ok. From here the phone is any paired phone.
    const { device, issuedToken } = this.host.auth.mintDevice(wait.deviceId, wait.deviceName)
    client.approval = null
    this.welcome(client, device, issuedToken)
  }

  /** The phone hung up mid-question. Withdraw the prompt; deny by default. */
  private abandonApproval(client: Client): void {
    const wait = client.approval
    if (!wait || wait.settled) return
    wait.settled = true
    clearTimeout(wait.timer)
    if (this.pendingApproval === client) this.pendingApproval = null
    this.host.cancelApproval?.(wait.requestId)
    client.approval = null
  }

  /* --------------------------------------------------------------- plumbing */

  private send(client: Client, frame: ServerFrame): void {
    if (client.socket.readyState !== client.socket.OPEN) return
    try {
      client.socket.send(JSON.stringify(frame))
    } catch {
      /* a dead socket is closed by its own close handler */
    }
  }

  private drop(client: Client, code: number, reason: string): void {
    this.clients.delete(client)
    try {
      client.socket.close(code, reason)
    } catch {
      /* already gone */
    }
  }

  private sweep(): void {
    for (const client of [...this.clients]) {
      if (!client.alive) {
        this.drop(client, 4008, 'Heartbeat lost')
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        this.drop(client, 4008, 'Heartbeat failed')
      }
    }
  }

  private log(line: string): void {
    this.host.log?.(`[mobile] ${line}`)
  }

  /* ----------------------------------------------------------------- static */

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (!isAllowedSource(sourceOf(req))) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const requested = decodeURIComponent((req.url ?? '/').split('?')[0])

    // Before the web root, and before the single-page fallback: this path must
    // answer with an APK or with a 404, never with index.html. A Downloader app
    // handed 200 OK and a page of HTML saves it as `forge-tv.apk` and then
    // fails to install it, which reads as a broken build rather than a missing
    // one.
    if (requested === TV_APK_PATH) {
      this.serveTvApk(res)
      return
    }

    const root = this.host.webRoot
    if (!root || !existsSync(root)) {
      res.writeHead(404).end('Forge Mobile bundle is not built')
      return
    }

    const file = resolveWithin(root, requested === '/' ? '/index.html' : requested)
    // A single-page app: unknown paths fall back to index.html rather than 404.
    const target = file && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html')
    if (!existsSync(target)) {
      res.writeHead(404).end('Not found')
      return
    }

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // The bundle is served off a home machine to one phone; caching it just
      // makes a rebuilt bundle look broken.
      'cache-control': 'no-store'
    })
    createReadStream(target).pipe(res)
  }

  /**
   * The Fire TV APK, or a 404 that says why.
   *
   * The 404 body is a sentence rather than "Not found": what is on the other
   * end of this request is a television showing whatever text it was given, and
   * "build it in Settings first" is the entire content of the fix.
   */
  private serveTvApk(res: ServerResponse): void {
    const apk = this.host.tvApk?.() ?? ''
    if (!apk || !existsSync(apk)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end('No Forge TV app has been built yet — build it on the desktop under Settings, Forge Mobile.')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': statSync(apk).size,
      // Named, so the Downloader app's own file list says what it downloaded.
      'content-disposition': `attachment; filename="${TV_APK_NAME}"`,
      // A rebuilt APK at the same URL must not be answered from a cache — that
      // is the whole update mechanism for the television.
      'cache-control': 'no-store'
    })
    createReadStream(apk).pipe(res)
  }
}

/* ----------------------------------------------------------------- helpers */

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
 * Tailscale allocates from. Deliberately *not* a substitute for the token: it
 * is the rule that stops a mis-forwarded router port from being a public shell.
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

/**
 * Join a request path onto the web root, refusing anything that escapes it.
 * `..` in a URL is the oldest trick there is and this server sits on a home
 * machine holding source code.
 *
 * Two independent gates, deliberately:
 *
 *  1. **Reject any `..` segment outright**, before normalising. Normalising
 *     first would also be safe — `..` past the root collapses, so the result
 *     stays contained — but "safe because of how normalize() happens to
 *     collapse a rooted path" is a property a reader has to derive. No
 *     legitimate asset path contains `..`, so refusing it is both correct and
 *     obvious at a glance.
 *  2. **Prove containment anyway**, after joining. Belt and braces: gate 1 is
 *     an argument, gate 2 is a check.
 *
 * Both `/` and `\` count as separators because this runs on Windows, where a
 * URL carrying backslashes still reaches the filesystem as a path.
 */
export function resolveWithin(root: string, requested: string): string | null {
  if (requested.split(/[/\\]+/).some((segment) => segment === '..')) return null
  const cleaned = normalize(requested).replace(/^([/\\])+/, '')
  const target = normalize(join(root, cleaned))
  const bounded = normalize(root).endsWith(sep) ? normalize(root) : normalize(root) + sep
  return target.startsWith(bounded) ? target : null
}

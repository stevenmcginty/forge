import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  MAX_WRITE_CHARS,
  MOBILE_PROTO,
  MOBILE_WS_PATH,
  parseFrame,
  wireDim,
  wireString,
  type ClientFrame,
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

  /** Live sessions, as the wire sees them. */
  sessions: () => MobileSession[]
  /** The 192KB catch-up buffer from pty-host, or '' if there is none. */
  replay: (id: string) => string
  write: (id: string, data: string) => boolean
  resize: (id: string, cols: number, rows: number) => boolean

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

  /** Where the phone bundle lives on disk. Static hosting is off when absent. */
  webRoot?: string
  log?: (line: string) => void
}

export interface MobileServerOptions {
  host: string
  port: number
}

interface Client {
  socket: WebSocket
  source: string
  device: MobileDevice | null
  subs: Set<string>
  alive: boolean
}

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
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private heartbeat: NodeJS.Timeout | null = null
  private listening: { host: string; port: number } | null = null

  constructor(host: MobileServerHost) {
    this.host = host
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

  /* --------------------------------------------------------------- inbound */

  private accept(socket: WebSocket, source: string): void {
    const client: Client = { socket, source, device: null, subs: new Set(), alive: true }
    this.clients.add(client)

    // An unauthenticated socket is not allowed to sit there holding a slot.
    const helloTimer = setTimeout(() => {
      if (!client.device) this.drop(client, 4001, 'No hello')
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
      if (client.device) {
        this.log(`${client.device.name} disconnected`)
        this.host.onPresence?.(this.connectedCount)
      }
    })
    socket.on('error', () => this.drop(client, 1011, 'Socket error'))
  }

  private async handle(client: Client, frame: ClientFrame): Promise<void> {
    if (frame.t === 'hello') return this.onHello(client, frame)

    // Everything below this line requires authentication. No exceptions, and
    // the check is here rather than in each handler so a new frame type cannot
    // be added without one.
    if (!client.device) {
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
        // Catch-up first, then live data. Same buffer a reloading renderer gets.
        this.send(client, { t: 'replay', id, data: this.host.replay(id) })
        return
      }

      case 'unsub':
        client.subs.delete(wireString(frame.id, 128))
        return

      case 'write': {
        const id = wireString(frame.id, 128)
        const data = typeof frame.data === 'string' ? frame.data : ''
        if (!data) return
        if (data.length > MAX_WRITE_CHARS) {
          this.send(client, { t: 'err', code: 'bad-frame', msg: 'Write too large' })
          return
        }
        this.host.write(id, data)
        return
      }

      case 'resize': {
        const id = wireString(frame.id, 128)
        const current = this.host.sessions().find((s) => s.id === id)
        if (!current) return
        this.host.resize(id, wireDim(frame.cols, current.cols), wireDim(frame.rows, current.rows))
        return
      }

      case 'op': {
        const error = await this.host.dispatchOp(frame, client.device.name)
        if (error) this.send(client, { t: 'err', code: 'no-window', msg: error })
        return
      }
    }
  }

  private onHello(client: Client, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    if (client.device) return // one hello per socket

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

    client.device = result.device
    const snapshot = this.host.snapshot()
    this.log(`${result.device.name} connected from ${client.source}`)
    this.send(client, {
      t: 'hello-ok',
      proto: MOBILE_PROTO,
      appVersion: this.host.appVersion,
      deviceName: result.device.name,
      sessions: this.host.sessions(),
      ...snapshot,
      // Present exactly once, on the connection that paired.
      ...(result.issuedToken ? { deviceToken: result.issuedToken } : {})
    })
    this.host.onPresence?.(this.connectedCount)
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
    const root = this.host.webRoot
    if (!root || !existsSync(root)) {
      res.writeHead(404).end('Forge Mobile bundle is not built')
      return
    }

    const requested = decodeURIComponent((req.url ?? '/').split('?')[0])
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

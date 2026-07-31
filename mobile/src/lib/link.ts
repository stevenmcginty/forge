import {
  MOBILE_PROTO,
  MOBILE_WS_PATH,
  type ClientFrame,
  type HelloOkFrame,
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
 *
 * Deliberately not an EventEmitter or a store: a phone app with one socket
 * needs callbacks, not an architecture.
 */

export type LinkState = 'idle' | 'connecting' | 'live' | 'retrying' | 'refused'

export interface LinkPicture {
  appVersion: string
  deviceName: string
  projects: Project[]
  profiles: AgentProfile[]
  workspaces: Record<string, Workspace>
  sessions: MobileSession[]
}

export interface LinkHandlers {
  /** Connection state changed. `detail` carries the reason on 'refused'. */
  onState: (state: LinkState, detail: string) => void
  /** The desktop's picture — on connect, and again whenever it changes. */
  onPicture: (picture: LinkPicture) => void
  /** Terminal bytes. `replay` marks the catch-up buffer, which must clear first. */
  onData: (id: string, data: string, replay: boolean) => void
  onExit: (id: string) => void
  /** Pairing succeeded and this token must be stored. Fires at most once. */
  onPaired: (token: string) => void
  /** Something the user should see — a refused op, a session that vanished. */
  onNotice: (message: string) => void
}

export interface LinkCredentials {
  /** `ws://host:port` — no path; this class appends it. */
  origin: string
  /** A device token, or a pairing code on the very first connection. */
  token: string
  deviceId: string
  deviceName: string
}

/** Backoff schedule, in ms. Caps rather than growing forever. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]

export class Link {
  private socket: WebSocket | null = null
  private credentials: LinkCredentials | null = null
  private readonly handlers: LinkHandlers
  private subscriptions = new Set<string>()
  private attempt = 0
  private retryTimer: number | null = null
  private closedByUs = false
  private picture: LinkPicture | null = null

  constructor(handlers: LinkHandlers) {
    this.handlers = handlers
  }

  get sessions(): MobileSession[] {
    return this.picture?.sessions ?? []
  }

  connect(credentials: LinkCredentials): void {
    this.credentials = credentials
    this.closedByUs = false
    this.attempt = 0
    this.open()
  }

  disconnect(): void {
    this.closedByUs = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.subscriptions.clear()
    this.handlers.onState('idle', '')
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

  /* -------------------------------------------------------------- internals */

  private open(): void {
    const credentials = this.credentials
    if (!credentials) return

    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'retrying', '')

    let socket: WebSocket
    try {
      socket = new WebSocket(`${credentials.origin}${MOBILE_WS_PATH}`)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          t: 'hello',
          proto: MOBILE_PROTO,
          deviceId: credentials.deviceId,
          deviceName: credentials.deviceName,
          token: credentials.token
        })
      )
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onclose = (event) => {
      this.socket = null
      if (this.closedByUs) return
      // 4001/4002/4003 are the desktop saying no — retrying would be a loop
      // against a door that is not going to open, and would burn the phone's
      // battery doing it.
      if (event.code >= 4001 && event.code <= 4003) {
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

  private receive(raw: string): void {
    let frame: ServerFrame
    try {
      frame = JSON.parse(raw) as ServerFrame
    } catch {
      return
    }

    switch (frame.t) {
      case 'hello-ok': {
        this.attempt = 0
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

      case 'replay':
        this.handlers.onData(frame.id, frame.data, true)
        return

      case 'data':
        this.handlers.onData(frame.id, frame.data, false)
        return

      case 'exit':
        this.subscriptions.delete(frame.id)
        this.handlers.onExit(frame.id)
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
    sessions: frame.sessions
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

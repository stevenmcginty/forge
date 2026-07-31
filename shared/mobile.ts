/**
 * Forge Mobile — the wire protocol between the phone and this desktop.
 *
 * One file, imported by all three sides: the main process (which serves it),
 * the renderer (which shows link status in Settings), and `mobile/` (the phone
 * app, which has a build step and therefore compiles against this exact file).
 *
 * That last part is the whole point. The Companion PWA hand-mirrors its
 * protocol in `companion/web/js/rtdb.js` because it has no build step, and
 * `companion/README.md` lists that as known gap #7 — a field only one side
 * reads is a bug nothing catches. Forge Mobile does not repeat it.
 *
 * Deliberately dependency-free: no Electron, no Node, no `ws`. It is types and
 * pure functions, so `scripts/mobile-smoke.mjs` can drive the real server
 * head-less the way `pty-smoke.mjs` drives the real PtySessionManager.
 *
 * ## Why a socket and not the Companion's Firebase channel
 *
 * The Companion (RTDB over REST + SSE) is right for what it carries: discrete
 * messages, images, presence. Both ends dial *out* to Firebase, so neither has
 * to be reachable — which is what makes it work from a car park on mobile data.
 *
 * A terminal is a different animal. `electron/pty-host.ts` flushes every 12ms,
 * so a redrawing TUI is tens of writes a second, and every keystroke would need
 * two full round-trips through Google's servers before the character appeared.
 * That is a few hundred milliseconds of echo lag on every key, plus a database
 * bill measured in build logs.
 *
 * So Forge Mobile splits the job the way it should be split: the socket below
 * carries terminal bytes, and the Companion channel carries *rendezvous* — the
 * desktop publishes where it can be reached right now, the phone reads it. The
 * no-NAT property is kept; the lag is not. See docs/MOBILE.md.
 */
import type { AgentProfile, Project, Workspace } from './types'

/**
 * A live pane, as the phone sees it.
 *
 * Declared structurally rather than importing `SessionInfo` from
 * `electron/pty/session-manager.ts`, for two reasons: this file must stay free
 * of any Electron-side import, and that module deliberately avoids imports
 * altogether so `scripts/pty-smoke.mjs` can bundle it stand-alone (see the
 * ENV_DENYLIST note there).
 *
 * `SessionInfo` structurally satisfies this, so the server can hand its
 * `list()` straight to the wire and the compiler still checks the overlap.
 * Note what is absent: `pid`, and anything about the desktop's disk beyond the
 * cwd the phone needs to tell two panes apart.
 */
export interface MobileSession {
  id: string
  cwd: string
  cols: number
  rows: number
  bootstrapCommand: string
  startedAt: number
}

/**
 * Protocol version. Bumped when a frame changes shape in a way an older phone
 * would misread. The server refuses a mismatch at `hello` with a sentence the
 * phone can show, rather than failing later in a way that looks like a bug.
 */
export const MOBILE_PROTO = 1

/** Default listen port. Nothing else on Steve's machine wants 8420. */
export const MOBILE_PORT = 8420

/** Longest single `write` payload accepted from a phone, in characters. */
export const MAX_WRITE_CHARS = 8192

/** How often the server pings an idle socket, and how long it waits to give up. */
export const HEARTBEAT_MS = 20_000
export const HEARTBEAT_GRACE_MS = 10_000

/**
 * Authentication failures from one source before it is locked out, and for how
 * long. A phone that types its token wrong does not get to brute-force it.
 */
export const AUTH_MAX_FAILURES = 5
export const AUTH_LOCKOUT_MS = 60_000

/* ------------------------------------------------------------ client frames */

/** First frame on every connection. No frame before it is honoured. */
export interface HelloFrame {
  t: 'hello'
  proto: number
  /** Stable per-install id, so the desktop can name and revoke a device. */
  deviceId: string
  /** The device token from a previous pairing. Absent on the very first run. */
  token?: string
  /** Human name shown in Settings' device list. */
  deviceName?: string
}

/** Subscribe to a session's output. Answered with `replay`, then live `data`. */
export interface SubFrame {
  t: 'sub'
  id: string
}

export interface UnsubFrame {
  t: 'unsub'
  id: string
}

/** Keystrokes. Goes straight to PtySessionManager.write. */
export interface WriteFrame {
  t: 'write'
  id: string
  data: string
}

/**
 * The phone's viewport changed — usually the soft keyboard opening, which is
 * the single most common resize in this app's life.
 */
export interface ResizeFrame {
  t: 'resize'
  id: string
  cols: number
  rows: number
}

/**
 * A layout operation. Deliberately *not* "run this command": the phone names a
 * profile id, which the desktop resolves against its own settings, and a
 * project id, whose folder the desktop already knows. Nothing on this wire
 * chooses a cwd or an executable.
 *
 * Forwarded to the renderer, which owns tabs/panes and persists them — the same
 * code path a local click takes. See electron/mobile-host.ts.
 */
export interface OpFrame {
  t: 'op'
  op: 'create-tab' | 'create-pane' | 'close-pane' | 'select-tab'
  projectId: string
  profileId?: string
  tabId?: string
  paneId?: string
}

export interface PingFrame {
  t: 'ping'
}

export type ClientFrame =
  | HelloFrame
  | SubFrame
  | UnsubFrame
  | WriteFrame
  | ResizeFrame
  | OpFrame
  | PingFrame

/* ------------------------------------------------------------ server frames */

/**
 * The answer to `hello`, and the phone's entire opening picture: what projects
 * exist, what profiles can be launched, how the tabs are laid out, and which
 * sessions are alive right now.
 */
export interface HelloOkFrame {
  t: 'hello-ok'
  proto: number
  appVersion: string
  deviceName: string
  projects: Project[]
  profiles: AgentProfile[]
  workspaces: Record<string, Workspace>
  sessions: MobileSession[]
  /** Issued only when this connection paired. Stored once, never re-sent. */
  deviceToken?: string
}

/**
 * The scrollback catch-up, sent once per `sub` before any live data.
 *
 * This is `electron/pty-host.ts`'s existing 192KB replay buffer — the same
 * mechanism that stops a reloading renderer from staring at a blank window onto
 * a live shell. A phone connecting from a train is exactly that case, so it
 * gets exactly that answer rather than a new one.
 */
export interface ReplayFrame {
  t: 'replay'
  id: string
  data: string
}

/** Live output. Mirrors PtyDataEvent. */
export interface DataFrame {
  t: 'data'
  id: string
  data: string
}

/** Mirrors PtyExitEvent. */
export interface ExitFrame {
  t: 'exit'
  id: string
  exitCode: number
}

/** Something changed on the desktop: projects renamed, a tab opened, a pane died. */
export interface StateFrame {
  t: 'state'
  projects?: Project[]
  sessions?: MobileSession[]
  workspace?: { projectId: string; workspace: Workspace }
}

export interface PongFrame {
  t: 'pong'
}

export type MobileErrorCode =
  | 'proto'
  | 'auth'
  | 'locked'
  | 'unknown-session'
  | 'limit'
  | 'no-window'
  | 'bad-frame'

export interface ErrFrame {
  t: 'err'
  code: MobileErrorCode
  msg: string
}

export type ServerFrame =
  | HelloOkFrame
  | ReplayFrame
  | DataFrame
  | ExitFrame
  | StateFrame
  | PongFrame
  | ErrFrame

/* ----------------------------------------------------------------- decoding */

/**
 * Parse one text frame off the wire.
 *
 * Everything arriving here is attacker-controlled until proven otherwise, so
 * this is total: it returns null rather than throwing, and the caller answers
 * `bad-frame`. No field is trusted for its type — that is each handler's job,
 * via the coercers below.
 */
export function parseFrame(raw: string): ClientFrame | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const t = (value as { t?: unknown }).t
  if (typeof t !== 'string') return null
  switch (t) {
    case 'hello':
    case 'sub':
    case 'unsub':
    case 'write':
    case 'resize':
    case 'op':
    case 'ping':
      return value as ClientFrame
    default:
      return null
  }
}

/** A string field off the wire, clamped. Never throws, never returns undefined. */
export function wireString(value: unknown, max = 256): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** A terminal dimension off the wire, held inside what a ConPTY will accept. */
export function wireDim(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.floor(n)))
}

/** The path the phone app is served from, and the socket's path on the same port. */
export const MOBILE_WS_PATH = '/link'

/**
 * The pairing link — the whole handshake in one string, built for a QR.
 *
 * The consumer is `toOrigin`/`pairTokenOf` in mobile/src/lib/secure.ts, and
 * this function exists so the two sides can never drift: the desktop builds
 * the link here, the phone parses it there, and both compile against this
 * file. `scripts/tunnel-check.mjs` round-trips the real builder through the
 * real parser, because a QR that encodes an address the phone reads
 * differently pairs against nothing — silently.
 *
 * Two shapes, and the difference is load-bearing:
 *
 *  - tunnel: `forge://pair?host=<domain>&scheme=wss&pt=<token>` — **no port**.
 *    `toOrigin` treats a port-less secure link as "the scheme's default 443";
 *    a `port` param would win over `scheme` and turn the link into
 *    `ws://<domain>:<port>`, an address nothing listens on. So when `secure`
 *    is set, any port passed in is deliberately dropped, not encoded.
 *  - LAN: `forge://pair?host=<ip>&port=<port>&pt=<token>`, which `toOrigin`
 *    reads back as `ws://<ip>:<port>`, exactly what typing the address would
 *    have produced.
 *
 * Returns '' rather than a half-link when the host or token is missing — a QR
 * of a broken link scans fine and then fails in the phone's hands, which is
 * worse than no QR at all.
 */
export function pairLink(host: string, port: number, secure: boolean, token: string): string {
  if (!host || !token) return ''
  const h = encodeURIComponent(host)
  const pt = encodeURIComponent(token)
  if (secure) return `forge://pair?host=${h}&scheme=wss&pt=${pt}`
  return `forge://pair?host=${h}&port=${encodeURIComponent(String(port))}&pt=${pt}`
}

/**
 * The ngrok domain as a human supplies it, made safe — or '' when it cannot be.
 *
 * Lives here rather than in the store because two sides need the same answer:
 * the store normalising settings.json, and the Settings panel deciding what to
 * keep in the renderer's copy. Splitting the rule between them is how the two
 * drift (the exact bug the Companion's hand-mirrored protocol had).
 *
 * What arrives is a paste off the ngrok dashboard, which plausibly carries a
 * scheme, a trailing slash or a stray capital. What leaves is a bare lowercase
 * hostname or nothing — the value ends up on ngrok's command line, so "it came
 * out of our own settings file" is not a good enough reason to trust it.
 */
export function normaliseNgrokDomain(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
  return /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$/.test(host) ? host : ''
}

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

/**
 * How long "Accept new phones" stays armed before disarming itself.
 *
 * A switch that stays on is a switch that is on forever, because nobody
 * remembers to turn it off — and left on, the desktop will raise a prompt for
 * anyone on the internet who finds the tunnel. Ten minutes is longer than
 * setting up a phone takes and shorter than an afternoon.
 */
export const ACCEPT_WINDOW_MS = 10 * 60_000

/**
 * How long a phone waits at the "showing OTTER RIVER" screen before giving up.
 *
 * Bounded because the socket is held open and unauthenticated for the whole
 * duration: an approval nobody is standing next to must not pin a connection
 * open until the process restarts.
 */
export const APPROVAL_TIMEOUT_MS = 2 * 60_000

/**
 * The word pair shown on both screens during approval.
 *
 * Short, concrete, unambiguous when read aloud, and deliberately free of words
 * that look alike on a phone screen at arm's length. 64 words is 4096 pairs —
 * not a secret, and not trying to be. Its job is to make "the prompt in front
 * of me belongs to the phone in my hand" checkable at a glance, which is a
 * comparison a human will actually perform. A 6-digit code is not.
 */
export const PAIR_WORDS = [
  'otter', 'river', 'copper', 'lantern', 'meadow', 'anchor', 'velvet', 'cobalt',
  'harbour', 'thistle', 'ember', 'quarry', 'saffron', 'walnut', 'beacon', 'marble',
  'cinder', 'gallop', 'pewter', 'orchard', 'tundra', 'basalt', 'nectar', 'plover',
  'sable', 'trellis', 'juniper', 'kettle', 'lagoon', 'mantle', 'nutmeg', 'oyster',
  'pelican', 'quiver', 'rafter', 'sorrel', 'tinder', 'umber', 'vellum', 'willow',
  'zephyr', 'bramble', 'cedar', 'dapple', 'elder', 'fathom', 'granite', 'hollow',
  'indigo', 'jasper', 'kelp', 'linnet', 'mallow', 'nimbus', 'onyx', 'pumice',
  'quince', 'rowan', 'sienna', 'teasel', 'upland', 'verbena', 'wicker', 'yarrow'
] as const

/**
 * Pick a word pair from bytes.
 *
 * Takes the randomness rather than making it, so the caller stays the one
 * place that decides where entropy comes from — `node:crypto` on the desktop,
 * `crypto.getRandomValues` on the phone — and so this file stays free of both.
 * Needs two bytes; anything shorter is padded rather than throwing, because a
 * frame this is rendering into is not a place to fail.
 */
export function wordPair(bytes: ArrayLike<number>): string {
  const first = PAIR_WORDS[(bytes[0] ?? 0) % PAIR_WORDS.length]
  const second = PAIR_WORDS[(bytes[1] ?? 1) % PAIR_WORDS.length]
  return `${first} ${second}`.toUpperCase()
}

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
  /**
   * "I have no credential — ask Steve whether to let me in."
   *
   * The alternative to reading a code off one screen and typing it into
   * another. A phone that knows where the desktop is (the APK is stamped with
   * it at build time) but holds no token sets this, and the desktop answers
   * with `awaiting-approval` while a prompt goes up on its own screen.
   *
   * **This is not a way in.** The desktop refuses it outright unless Steve has
   * armed it, and even armed it mints nothing until he taps Allow. What the
   * flag removes is the typing, not the authorisation — possession of the
   * desktop is still the whole trust root, exactly as it is for a pairing
   * code. See ACCEPT_WINDOW_MS.
   */
  requestPair?: boolean
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
  /**
   * Per-open Claude permission mode, the same override the desktop's
   * AgentChooser sets. Typed as a plain string on purpose: this arrives off the
   * wire, so the renderer decides what it means by running it through
   * `isPermissionMode` and dropping anything else. Optional, and an older
   * desktop simply ignores it — which is why MOBILE_PROTO does not move.
   */
  permissionMode?: string
  tabId?: string
  paneId?: string
}

export interface PingFrame {
  t: 'ping'
}

/**
 * "Play this on the TV."
 *
 * One frame, same shape both directions: a phone sends it up, the desktop
 * relays it down to the TV build of this same app, whose web layer hands it
 * across the native bridge (mobile/src/lib/tv-bridge.ts) to the YouTube
 * WebView beside it. `video` is a YouTube video id — never a URL — and each
 * end holds it to the exact 11-character id shape rather than trusting the
 * other side to have checked.
 */
export interface TvPlayFrame {
  t: 'tv-play'
  video: string
}

/**
 * Is this exactly a YouTube video id, and nothing else?
 *
 * The rule the *wire* is held to, at both ends — see TvPlayFrame above: what
 * travels is an id, never a URL, and each side checks rather than trusting the
 * other to have. Deliberately strict: a URL that happens to contain an id is
 * refused as a frame, because "the field usually contains an id" is how a field
 * ends up containing something else on the day it matters, and what is on the
 * far end of this one is a string being put into an address a television opens.
 */
export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value)
}

/**
 * A YouTube video id out of whatever a human had on the clipboard, or '' when
 * there is not one in there.
 *
 * The counterpart to `isVideoId`, and the division between them is the point:
 * this one is for the *input* on a phone, where a paste is a share link and
 * being fussy about it would be a form that rejects the only thing anyone
 * actually has. `isVideoId` is for the wire, where leniency would be a hole.
 * A phone extracts here, sends an id, and the desktop checks with the strict
 * one — so a tampered client cannot widen what the television will open.
 *
 * Accepted: a bare id, a `v=` query parameter, a `youtu.be/<id>` link, and the
 * `/shorts/`, `/embed/` and `/live/` path forms — which is every shape the
 * share sheet on a phone actually produces. The negative lookahead matters:
 * without it a 12-character id would match its own first 11 characters and be
 * silently truncated into a different video.
 */
export function videoIdOf(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (isVideoId(text)) return text
  const query = /[?&]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(text)
  if (query) return query[1]!
  const path = /(?:youtu\.be|\/(?:shorts|embed|live))\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(text)
  if (path) return path[1]!
  return ''
}

/* ---------------------------------------------------------- screen mirror
 *
 * The TV watching the desktop's actual screen — a WebRTC stream from the
 * Forge window's renderer to a <video> on the Fire Stick. Three frames carry
 * the whole feature, and the server stays a relay: `data` is an opaque JSON
 * string (an SDP or an ICE candidate) that it forwards without reading,
 * because the server has no WebRTC stack and must not grow one.
 *
 * One viewer at a time, enforced by the server. The Fire Stick is the only
 * intended client; relaying one peer connection is a seam, fanning out N of
 * them is a media server.
 */

/** The TV asks to watch. The desktop answers with `mirror-signal` frames. */
export interface MirrorStartFrame {
  t: 'mirror-start'
}

/** WebRTC signaling, both directions. Opaque to the relay by design. */
export interface MirrorSignalFrame {
  t: 'mirror-signal'
  data: string
}

/**
 * Either side ends the watch. The server also synthesises one downward when
 * the desktop cannot mirror, and upward when the viewer disconnects.
 */
export interface MirrorStopFrame {
  t: 'mirror-stop'
  /** Why it ended, when the desktop knows — a sentence the TV can show. */
  reason?: string
}

/**
 * Longest accepted `mirror-signal` payload. An SDP is a few kilobytes;
 * anything approaching this bound is not signaling.
 */
export const MAX_SIGNAL_CHARS = 65536

export type ClientFrame =
  | HelloFrame
  | SubFrame
  | UnsubFrame
  | WriteFrame
  | ResizeFrame
  | OpFrame
  | PingFrame
  | TvPlayFrame
  | MirrorStartFrame
  | MirrorSignalFrame
  | MirrorStopFrame

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

/**
 * "Steve is being asked about you. Hold on."
 *
 * Sent instead of `hello-ok` when a phone asks to pair by approval. The socket
 * stays open and unauthenticated until he answers — so the ten-second
 * drop-if-no-hello rule in the server must not apply to a connection that is
 * already waiting on a human.
 *
 * `words` is the anti-confusion device, and it is the only reason this is
 * safe to leave facing the internet at all. The phone shows the pair in large
 * type, the desktop shows the same pair in its prompt, and Steve is told to
 * compare them. Without it, a stranger who guessed the ngrok hostname could
 * make a prompt appear at the moment Steve happened to be pairing his own
 * phone, and "Allow" would go to the wrong device. With it, that attack
 * requires guessing the pair too.
 */
export interface AwaitingApprovalFrame {
  t: 'awaiting-approval'
  words: string
}

export type ServerFrame =
  | HelloOkFrame
  | AwaitingApprovalFrame
  | ReplayFrame
  | DataFrame
  | ExitFrame
  | StateFrame
  | PongFrame
  | ErrFrame
  | TvPlayFrame
  | MirrorSignalFrame
  | MirrorStopFrame

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
    // Admitted, not trusted: the id is held to its shape by `isVideoId` in the
    // server's handler, the same way `write` is held to MAX_WRITE_CHARS there.
    case 'tv-play':
    case 'mirror-start':
    case 'mirror-signal':
    case 'mirror-stop':
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

/**
 * Forge Web — the wire protocol between a browser tab and this desktop.
 *
 * One file, imported by all three sides: the main process (which serves it),
 * the web client in `web/` (which has a build step and compiles against this
 * exact file), and `scripts/web-smoke.mjs` (which drives the real server over a
 * real socket with no Electron in the process). Same rule as shared/mobile.ts,
 * for the same reason: `companion/web/js/rtdb.js` hand-mirrors its protocol
 * because it has no build step, and a field only one side reads is a bug
 * nothing catches. This is the file that stops that happening again.
 *
 * Deliberately dependency-free, and deliberately free of anything
 * environment-specific — no Electron, no `node:*`, no `window`, no `ws`. It is
 * typechecked three times, under three different lib sets (tsconfig.node,
 * tsconfig.web, tsconfig.mobile all include `shared/**`), which is the actual
 * proof rather than the intention.
 *
 * ## What travels where
 *
 * Firebase carries *identity* and *one hostname*. This socket carries
 * everything else. See docs/forge-web.md:
 *
 *   browser ──sign in──▶ Firebase ──users/<uid>/host──▶ a tunnel hostname
 *   browser ──wss://<that hostname>/web──▶ cloudflared ──▶ this desktop
 *
 * Terminal bytes never pass through Firebase, for the reason set out at the top
 * of shared/mobile.ts: `electron/pty-host.ts` flushes every 12ms, so a
 * redrawing TUI is tens of writes a second, and a round trip through Google's
 * servers per keystroke is a few hundred milliseconds of echo lag plus a
 * database bill measured in build logs.
 *
 * ## What this protocol is *for*
 *
 * The browser **mirrors** the desktop. It does not spawn a parallel world:
 * opening a tab here opens it on the desk, and the desktop renderer stays the
 * one owner of the split tree and the one thing that persists a workspace
 * (docs/forge-web.md, decision 5). So every layout frame below is a *request*
 * that comes back with a result, never a local mutation announced afterwards.
 *
 * Out of scope on purpose, and modelled nowhere in this file: voice and
 * dictation, screenshots, desktop control and the overlay, Forge Mobile, Forge
 * TV (docs/forge-web.md, decision 7). A public URL that moves the real mouse is
 * a different risk class, and this file must not grow the vocabulary for one.
 *
 * Also out of scope: the GitHub-only fallback the client drops to when the PC
 * is off. That is a different transport with a different API, and nothing here
 * describes it. What *is* here is the two things this protocol owes it — the
 * signal to fall back (`WebHostRecord` plus `WebShutdownFrame`), and enough
 * cached state for the frozen, badged, read-only view: `WebHelloOkFrame` and
 * the `WebReplayFrame` of every attached session, which the client is expected
 * to persist. There is no separate "cache" frame, because a cache the server
 * has to build is a second source of truth for a picture the client already
 * received.
 *
 * ## Naming
 *
 * The discriminant is spelled `type`, not shared/mobile.ts's `t`. `t` is the
 * older file counting bytes on a phone link; `type` is what every other
 * discriminated union in this codebase uses (`LayoutNode`, `PaneLeaf`,
 * `PaneSplit` in shared/types.ts), and the web client is read by more people
 * than it is metered by.
 *
 * A few constant and helper names below (`HEARTBEAT_MS`, `MAX_WRITE_CHARS`,
 * `MAX_SESSIONS`, `wireString`, `wireDim`) also exist in shared/mobile.ts or
 * shared/ipc.ts. That is intentional — they are the same idea, and where the
 * value differs the comment says why. A file that needs both links imports one
 * of them under an alias; the duplicate identifier is a compile error, which is
 * a loud failure rather than a silent one.
 */
import type {
  AgentPresence,
  AgentProfile,
  CommandPresence,
  GitActionKind,
  GitSnapshot,
  Project,
  SplitDirection,
  Workspace
} from './types'
import type { SkillsList } from './skills'
import type { CommandsFeed } from './commands'

/* --------------------------------------------------------- protocol identity */

/**
 * Protocol version. Bumped when a frame changes shape in a way an older client
 * would misread. The server refuses a mismatch at `hello` with a sentence the
 * browser can show, rather than failing later in a way that looks like a bug.
 *
 * Adding an *optional* field is not a bump — an older client ignores it and a
 * newer one falls back — exactly as `permissionMode` was added to
 * shared/mobile.ts's `OpFrame` without moving MOBILE_PROTO.
 */
export const WEB_PROTO = 1

/** Where the WebSocket upgrade lands, on whatever port the desktop listens on. */
export const WEB_WS_PATH = '/web'

/**
 * The WebSocket subprotocol the browser asks for, and the only one the server
 * accepts.
 *
 * It carries the version a second time, on purpose. A browser's `WebSocket`
 * constructor cannot set a header — the subprotocol list is the one field the
 * page controls — so this is the only way a version mismatch can be refused
 * *during* the upgrade, before a socket exists and before a `hello` round trip
 * has been spent. `hello.proto` stays the authority; this is the cheap gate in
 * front of it, and the two must be moved together.
 */
export const WEB_SUBPROTOCOL = 'forge-web.v1'

/* -------------------------------------------------------------- rendezvous
 *
 * How the browser finds the PC, and how it learns the PC is not there.
 *
 * The desktop publishes one small record to Firebase RTDB, refreshes it on a
 * heartbeat, and clears it on the way out. The browser reads it before it dials
 * anything. No record, a stale record, or a protocol number it cannot speak all
 * mean the same thing to the client: this desktop is not available, go to
 * GitHub mode.
 *
 * Nothing secret is in it. It is a hostname that resolves publicly anyway, and
 * everything behind that hostname is gated by a Firebase ID token the server
 * verifies against Google's keys on every connection.
 */

/**
 * The key under the account's own subtree. `electron/companion/protocol.ts`
 * owns the other four paths and its header sets the rule that nothing else in
 * the codebase builds one by concatenation — the rule that keeps
 * `database.rules.json` reviewable. This one lives here instead, because it is
 * the first path *both ends* need: the desktop writes it and the browser reads
 * it, and a fifth entry in a file the browser cannot import would recreate the
 * hand-mirroring this protocol exists to avoid. `webHostPath` is the single
 * builder; the desktop should call it rather than growing a fifth `paths` entry.
 */
export const WEB_HOST_KEY = 'host'

/** `users/<uid>/host`, or '' when there is no uid to build one from. */
export function webHostPath(uid: string): string {
  if (!uid) return ''
  return `users/${uid}/${WEB_HOST_KEY}`
}

/** How often the desktop refreshes `at` on its published record. */
export const HOST_HEARTBEAT_MS = 60_000

/**
 * How old a record may be before the browser treats the desktop as absent.
 *
 * Three heartbeats — and for an ungraceful death this is the *only* mechanism,
 * not a backstop.
 *
 * An earlier draft of this comment said RTDB's `onDisconnect` was the primary
 * mechanism and that three minutes merely covered the case where it did not
 * fire. That is not true and could not be made true here. `onDisconnect` is a
 * feature of RTDB's realtime wire protocol: the server arms it against a live
 * socket and runs it when that socket dies. `electron/companion/rest.ts` is
 * REST plus SSE by design — no SDK, no dependency — so there is no socket for
 * the server to hang a handler on, and the `.json` endpoints expose no
 * equivalent. `electron/web/rendezvous.ts` clears the record on a clean
 * shutdown; a power cut is covered by this number and nothing else.
 *
 * So it is chosen as a sole mechanism rather than a safety net: short enough
 * that a browser opened after a shutdown does not sit dialling a machine that
 * is off, and long enough that a laptop's wifi blinking does not throw a live
 * session into GitHub mode. The cost of the missing `onDisconnect` is a couple
 * of minutes in which the page offers to connect to a desktop that is already
 * gone; the lever, if that ever matters, is a shorter HOST_HEARTBEAT_MS rather
 * than a different database client.
 *
 * The Companion's equivalent (`STALE_MS` in electron/companion/protocol.ts) is
 * ten minutes because it is judging a *message queue*, where being early is
 * worse than being late; here it is the other way round.
 */
export const HOST_STALE_MS = 3 * HOST_HEARTBEAT_MS

/**
 * What the desktop publishes about itself.
 *
 * Deliberately thin, and deliberately not a status page: a hostname to dial,
 * the protocol number so the browser can say "these two do not speak the same
 * Forge" instead of failing at `hello`, a version for the line under the name,
 * and a timestamp so absence is detectable. No project names, no device list,
 * no session count — none of which the client needs before it has authenticated,
 * and all of which would be readable by anything that could read this node.
 */
export interface WebHostRecord {
  /** Bare hostname of the tunnel, no scheme and no path. See `normaliseHost`. */
  host: string
  proto: number
  /** Forge's version on that desktop. */
  app: string
  /** The computer's own name, for "connected to STEVE-PC". */
  name: string
  /** ms epoch, refreshed every HOST_HEARTBEAT_MS. */
  at: number
}

/**
 * A hostname as a human or an API hands it over, made safe — or '' when it
 * cannot be.
 *
 * Same rule as `normaliseNgrokDomain` in shared/mobile.ts, and here for the same
 * reason: what arrives is a paste off a dashboard or a value read out of a
 * database, which plausibly carries a scheme, a trailing slash, a port or a
 * stray capital. What leaves is a bare lowercase hostname or nothing. "It came
 * out of our own record" is not a good enough reason to trust a string that is
 * about to become the address a browser opens a socket to.
 */
export function normaliseHost(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^wss?:\/\//, '')
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
  return /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$/.test(host) ? host : ''
}

/**
 * `localhost` or `127.0.0.1`, each optionally with a port. Nothing else counts
 * as loopback, and in particular no name that merely resolves to it.
 */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/

/**
 * The address to dial, built in one place so the two ends cannot disagree about
 * it. Returns '' rather than a half-URL when the host is not a hostname — a
 * client that dials '' fails immediately and visibly, where one that dials
 * `wss://undefined/web` fails in a way that reads like a network fault.
 *
 * `wss:` always, with exactly one exception. The tunnel terminates TLS, the
 * page is served over https from Firebase Hosting, and a browser refuses a
 * plaintext socket from a secure page anyway — so a free scheme parameter here
 * could only ever be a way to get it wrong.
 *
 * ## The exception, and why it cannot be reached by accident
 *
 * The exception is development. `npm run dev` in `web/` serves the client from
 * Vite on http://localhost, and the Forge it talks to is on this machine — so
 * there is no tunnel, no certificate, and `wss://localhost` cannot be honoured
 * by anything. Without a way to say so, the dev loop for the whole of Phase 3
 * would have to hand-build its own URL beside this function, which is precisely
 * the drift this file exists to prevent.
 *
 * It is opt-in rather than inferred, and that is the load-bearing part.
 * `normaliseHost` rejects `localhost` outright (it demands a dot), but it
 * *accepts* `127.0.0.1`, so a `host` sniffed out of the published record could
 * otherwise steer a real session onto a plaintext socket. Requiring the caller
 * to pass `allowLoopback` means the production path — which reads its host from
 * `parseHostRecord` and never sets the flag — cannot take this branch whatever
 * the database says. A hostile record can at worst name a loopback address that
 * is then dialled over TLS and fails.
 */
export function webSocketUrl(host: unknown, allowLoopback = false): string {
  if (allowLoopback && typeof host === 'string') {
    const bare = host
      .trim()
      .toLowerCase()
      .replace(/^wss?:\/\//, '')
      .replace(/^https?:\/\//, '')
      .replace(/[/?#].*$/, '')
    const loop = LOOPBACK.exec(bare)
    // The port is the only part worth re-checking: everything else the regex
    // already spelled out in full.
    if (loop) return Number(loop[1] ?? 0) > 65535 ? '' : `ws://${bare}${WEB_WS_PATH}`
  }
  const clean = normaliseHost(host)
  return clean ? `wss://${clean}${WEB_WS_PATH}` : ''
}

/**
 * Read a published record, or null. Total: this arrives out of a database that
 * the desktop is *supposed* to be the only writer of, which is not the same as
 * knowing that it was.
 *
 * Takes `unknown` rather than a string, unlike `parseDiscoveryReply` in
 * shared/mobile.ts, because the value arrives already parsed — RTDB's REST
 * endpoint returns JSON and the browser's SDK returns an object. A string
 * overload would only invite somebody to `JSON.parse` twice.
 */
export function parseHostRecord(value: unknown): WebHostRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<WebHostRecord>
  const host = normaliseHost(record.host)
  if (!host) return null
  if (!Number.isInteger(record.proto)) return null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0
  return {
    host,
    proto: record.proto as number,
    // Both of these are drawn in the browser's header. Clamped and stripped of
    // anything unprintable for the same reason `parseDiscoveryReply` does it:
    // a control character in a name is at best a broken line, and at worst
    // something the renderer has to have an opinion about.
    app: wireString(record.app, 24),
    name: printable(wireString(record.name, 64)),
    at
  }
}

/**
 * Is this desktop worth dialling right now?
 *
 * The whole of the fall-back decision, in one function both ends can agree on:
 * false means the client goes to GitHub mode without opening a socket. A
 * protocol number this build cannot speak counts as absent rather than as an
 * error, because the honest answer to "the desktop is running something I
 * cannot talk to" is the same read-only picture as "the desktop is off".
 */
export function isHostLive(record: WebHostRecord | null, now: number): boolean {
  if (!record) return false
  if (record.proto !== WEB_PROTO) return false
  return now - record.at < HOST_STALE_MS
}

/* ------------------------------------------------------------------- limits
 *
 * Every number here has a sentence. Reviewers in this codebase read them, and a
 * limit whose reason is not written down is a limit somebody raises in six
 * months because it was in the way.
 */

/**
 * Longest single `write` payload accepted from a browser, in characters.
 *
 * The same 8192 as shared/mobile.ts, and the same reasoning: it is far above
 * any keystroke or dictated phrase and comfortably above a pasted command, and
 * far below anything that could be used to feed a shell a file. xterm.js emits
 * one `onData` per keystroke and one per paste, so the only thing that comes
 * near this is a paste — which is exactly the thing that should be capped.
 */
export const MAX_WRITE_CHARS = 8192

/**
 * How many frames a second the server will act on from one connection.
 *
 * A human at 120 words a minute is about twelve keystrokes a second, and a held
 * key on Windows repeats at roughly thirty. 120 is ten times the first and four
 * times the second, so nobody meets it by typing; it is there because a browser
 * tab is a scripting environment and a runaway `setInterval` should exhaust a
 * counter rather than a desktop. Deliberately the same number as
 * `MAX_INPUT_PER_SECOND` in shared/mobile.ts so a host serving both links can
 * hold them to one rule.
 */
export const MAX_INPUT_PER_SECOND = 120

/**
 * Largest inbound frame the server will read, in bytes.
 *
 * Enforced at the socket, before a string exists — that is the only place the
 * count is genuinely in bytes, which is why `parseFrame` below does not repeat
 * it (a JS string's `length` is UTF-16 code units and is neither an upper nor a
 * lower bound on the UTF-8 byte count).
 *
 * The biggest frame a browser legitimately sends is a `write` at
 * MAX_WRITE_CHARS, which JSON-escapes to at most a few times its length. 64KB
 * clears that with room to spare and is small enough that a thousand of them
 * cannot be a memory attack. It bounds the *inbound* direction only: a `replay`
 * travelling the other way is deliberately larger than this, see
 * MAX_REPLAY_BYTES.
 */
export const MAX_FRAME_BYTES = 64 * 1024

/**
 * Most sessions this link will describe.
 *
 * The same 128 as `MAX_SESSIONS` in shared/ipc.ts — it is the same ceiling seen
 * from the wire, because every pane is a real ConPTY with a real console host
 * behind it and a link that advertised more would be describing a machine that
 * does not exist. Restated rather than imported so the browser bundle does not
 * carry the desktop's whole IPC channel table for one integer; the two numbers
 * must match.
 */
export const MAX_SESSIONS = 128

/**
 * Longest catch-up buffer sent on attach.
 *
 * This is not a new number and not a new buffer: it is `REPLAY_LIMIT` in
 * electron/pty-host.ts, the same 192KB scrollback that stops a reloading
 * renderer from staring at a blank window onto a live shell. A browser opening
 * a tab is exactly that case, so it gets exactly that answer. Stated here so
 * the client can size its own offline cache against the real figure rather than
 * guessing, and so a change on the desktop shows up as a disagreement between
 * two files rather than as a silently truncated transcript.
 */
export const MAX_REPLAY_BYTES = 192 * 1024

/* ----------------------------------------------------------------- liveness */

/**
 * How often the server pings an idle socket, and how long it waits to give up.
 *
 * The same 20s/10s as shared/mobile.ts, but the mechanism is not the same and
 * the difference is load-bearing: these govern the server's **native WebSocket
 * ping**, not the app-level `ping` frame below. A browser answers a protocol
 * ping in its network stack, unthrottled, whether or not the tab is visible —
 * whereas a hidden tab's JavaScript timers are clamped to roughly once a
 * minute. An app-level heartbeat would therefore time out every backgrounded
 * tab, which for this app means every tab somebody left open on the machine
 * they are working on.
 *
 * The client's own `ping` still exists, for the one thing a native ping cannot
 * do: tell the *page* that the link is warm, so the connection badge is honest.
 */
export const HEARTBEAT_MS = 20_000
export const HEARTBEAT_GRACE_MS = 10_000

/**
 * How long a browser waits at the "showing OTTER RIVER" screen before the
 * desktop gives up on it.
 *
 * The same two minutes as shared/mobile.ts, and bounded for the same reason:
 * the socket is held open and unauthenticated for the whole duration, so an
 * approval nobody is standing next to must not pin a connection open until the
 * process restarts.
 */
export const APPROVAL_TIMEOUT_MS = 2 * 60_000

/**
 * Firebase ID tokens are minted with a one-hour life, and this link is meant to
 * stay up for a working day. So the credential is re-presented mid-connection
 * rather than only at `hello` — see `WebAuthFrame`. Ten minutes of margin
 * covers a laptop that slept through its own refresh and a clock that is a
 * little out; the server re-verifies against Google's keys either way and
 * refuses a lapsed one with `bad-token`.
 */
export const TOKEN_LIFETIME_MS = 60 * 60_000
export const TOKEN_REFRESH_MS = 50 * 60_000

/* ------------------------------------------------------- the second factor
 *
 * RFC 6238, and every number below is that document's rather than one invented
 * here. They live in this file because both ends read them: the desktop
 * computes codes against them and the browser tells the person what it is
 * asking for ("a six-digit code", "it changes every thirty seconds").
 *
 * The second factor is optional and off until somebody enrols one. What it
 * guards is the case account-only admission deliberately allows: a browser
 * nobody at the desk has ever seen. See `webRequireApproval` in
 * shared/types.ts for the other half of that trade.
 */

/** RFC 6238's default time step. Every authenticator app assumes it. */
export const TOTP_STEP_MS = 30_000

/** Six digits, which is what every authenticator app shows. */
export const TOTP_DIGITS = 6

/**
 * How many steps either side of now are accepted.
 *
 * One, which is RFC 6238's own recommendation and the smallest window that is
 * usable: a person reading six digits off a phone and typing them takes a few
 * seconds, and a code that turned over mid-typing would otherwise be refused.
 * Two steps would be a minute and a half of life for a code that is supposed to
 * live thirty seconds, and the replay guard below is what stops even this
 * window being three chances at the same code.
 */
export const TOTP_DRIFT_STEPS = 1

/**
 * How long "trust this browser" lasts.
 *
 * Thirty days, so a code is a monthly event rather than a daily one — the
 * difference between a second factor somebody keeps and one they turn off. The
 * trust is per device and dies with the device: revoking a browser in Settings
 * revokes its trust in the same act, because it is a field on the same row.
 */
export const TRUST_WINDOW_MS = 30 * 24 * 60 * 60_000

/* ------------------------------------------------------------------ records */

/**
 * A live pane, as the browser sees it.
 *
 * Declared structurally rather than importing `SessionInfo` from
 * `electron/pty/session-manager.ts`, for the same two reasons shared/mobile.ts
 * gives: this file must stay free of any Electron-side import, and that module
 * deliberately avoids imports altogether so `scripts/pty-smoke.mjs` can bundle
 * it stand-alone.
 *
 * `SessionInfo` structurally satisfies this, so a server can hand its `list()`
 * straight to the wire and the compiler still checks the overlap. Note what is
 * absent: `pid`, and anything about the desktop's disk beyond the cwd the
 * browser needs to tell two panes apart in a list. The rule from
 * shared/mobile.ts holds here unchanged — never model a filesystem path in a
 * frame the client does not already need.
 */
export interface WebSession {
  id: string
  cwd: string
  cols: number
  rows: number
  bootstrapCommand: string
  startedAt: number
}

/**
 * Where a browser stands with this desktop, as one word the connection UI can
 * switch on.
 *
 * Named here rather than invented in the client because both ends use the
 * vocabulary: the desktop decides which of these a connection is in, and the
 * browser draws it. `connecting` and `live` are the socket's own states;
 * everything from `pending` down is about the device.
 *
 *   connecting  the socket is opening, or `hello` is in flight
 *   pending     a prompt is up on the desktop; `WebPendingFrame` has the words
 *   totp        the desktop wants a six-digit code before it will say more
 *   live        authenticated and mirroring — `WebHelloOkFrame` has arrived
 *   declined    a human said no. Asking again is a new prompt, not a retry
 *   timed-out   nobody answered within APPROVAL_TIMEOUT_MS
 *   refused     any other refusal; `WebRefusedFrame.reason` says which
 *   offline     no desktop to talk to. This is the GitHub-mode state
 *
 * `totp` is its own state rather than a shade of `refused` for the same reason
 * `pending` is: nothing has gone wrong and there is nothing to recover from —
 * the page is being asked a question, and the screen it draws is a text box
 * rather than an apology.
 */
export type WebApprovalState =
  | 'connecting'
  | 'pending'
  | 'totp'
  | 'live'
  | 'declined'
  | 'timed-out'
  | 'refused'
  | 'offline'

/* ------------------------------------------------------------ client frames */

/**
 * First frame on every connection. No frame before it is honoured.
 *
 * Note what is *not* here: a device token. Forge Mobile mints one because it
 * has no identity provider and needs something to remember a phone by; Forge
 * Web has a verified Firebase ID token in hand, and minting a second credential
 * beside it would add a thing to steal and prove nothing the first does not.
 * The device record on the desktop records an approval; it is not a key.
 */
export interface WebHelloFrame {
  type: 'hello'
  proto: number
  /**
   * A Firebase ID token — a JWT. Verified against Google's published keys on
   * every connection, not just the first, and matched against the one uid this
   * desktop is configured for. An unverified socket never reaches a PTY.
   */
  idToken: string
  /** The web client's build, for the desktop's device list and for support. */
  client: string
  /**
   * Stable per-browser-profile id, minted once and kept in the browser's own
   * storage. Two profiles on one machine are two devices, which is correct: the
   * thing being approved is a place a token can be used from.
   */
  deviceId: string
  /**
   * What the browser calls itself in the approval prompt — "Chrome on
   * Windows", typically. Untrusted display text: show it, never obey it.
   */
  deviceName?: string
  /**
   * The second factor, when the desktop has asked for one: six digits from an
   * authenticator app, or one of the recovery codes minted at enrolment.
   *
   * Optional, so adding it is not a protocol bump — an older desktop ignores
   * the field, and a desktop with no second factor enrolled never asks for one.
   * The browser does not send this unprompted: the first `hello` carries no
   * code, the desktop answers `totp-required`, and the second carries what the
   * person typed. That costs a round trip and buys the property that a page
   * only ever holds a code it was just asked for.
   */
  totp?: string
  /**
   * "Trust this browser for 30 days" — see TRUST_WINDOW_MS.
   *
   * Only honoured alongside a `totp` the desktop actually accepted, because a
   * flag that granted trust on its own would be a second factor a browser could
   * skip by asking nicely.
   */
  trust?: boolean
}

/**
 * A freshly minted ID token, presented before the old one lapses. See
 * TOKEN_REFRESH_MS.
 *
 * Answered on `rid` with `WebResultFrame` carrying `{ kind: 'ok' }`. A token
 * that does not verify is answered with `WebRefusedFrame` and the socket is
 * closed — the same frame `hello` would have been refused with, because "this
 * credential does not get in" is one answer whether it is heard at the start of
 * a connection or an hour into it.
 */
export interface WebAuthFrame {
  type: 'auth'
  rid: string
  idToken: string
}

/**
 * Subscribe to a session's output. Answered with `replay`, then live `data`.
 *
 * `cols`/`rows` are optional and mean "and this is the size I am reading it
 * at". A PTY has one geometry and this link gives it two viewers, so the
 * desktop stands down and follows the browser for as long as the browser is
 * the one reading — the same arrangement `onWatch` makes for a phone in
 * electron/mobile/server.ts. Omitting them means "I will take whatever size it
 * is", which is what a read-only or thumbnail view should send.
 */
export interface WebAttachFrame {
  type: 'attach'
  sessionId: string
  cols?: number
  rows?: number
}

export interface WebDetachFrame {
  type: 'detach'
  sessionId: string
}

/**
 * Keystrokes, and the only frame that carries something the person composed.
 *
 * Held to MAX_WRITE_CHARS, and answered with an `error` frame when the pane has
 * gone — never with silence. The client throws its draft away the moment it
 * hands it over, so a pane that exited while the tab was in the background
 * would otherwise swallow the words and look exactly like a successful write,
 * which is the worst thing a remote can do.
 *
 * This is also how an agent's own approval prompt gets answered; see
 * `WebAttentionFrame`.
 */
export interface WebWriteFrame {
  type: 'write'
  sessionId: string
  data: string
}

/** The browser's terminal viewport changed — a window resize, or a font change. */
export interface WebResizeFrame {
  type: 'resize'
  sessionId: string
  cols: number
  rows: number
}

/**
 * Everything that is a question rather than a stream, on one correlated
 * channel: layout operations, git, skills, commands, the agent chooser.
 *
 * One request frame and one result frame rather than a pair per feature, so
 * there is exactly one reply path, one place a timeout is implemented and one
 * place a client matches an answer to a question. `rid` is the correlation id;
 * the server echoes it verbatim and never interprets it.
 *
 * The pairing between `WebRequest` and `WebResult` is by `rid`, not by type —
 * any request may be answered with `{ kind: 'failed' }`, and a client must
 * tolerate a result kind it does not recognise from a newer desktop. That is
 * why failure is a *result* and not only an `error` frame: a request that
 * fails still has to settle its promise.
 */
export interface WebRequestFrame {
  type: 'request'
  rid: string
  body: WebRequest
}

/**
 * Warmth, not liveness. The socket's real heartbeat is the server's native
 * WebSocket ping (see HEARTBEAT_MS); this exists so the *page* can tell whether
 * the link is answering, and colour its connection badge honestly.
 */
export interface WebPingFrame {
  type: 'ping'
}

export type WebClientFrame =
  | WebHelloFrame
  | WebAuthFrame
  | WebAttachFrame
  | WebDetachFrame
  | WebWriteFrame
  | WebResizeFrame
  | WebRequestFrame
  | WebPingFrame

/* --------------------------------------------------------- layout operations
 *
 * The operations that mutate the workspace. Deliberately *not* "run this
 * command": the browser names a profile id, which the desktop resolves against
 * its own settings, and a project id, whose folder the desktop already knows.
 * Nothing on this wire chooses a cwd or an executable.
 *
 * Forwarded to the desktop renderer, which owns tabs and panes and persists
 * them — the same code path a local click takes, never a second one that could
 * disagree with the first.
 */

export const WEB_LAYOUT_OPS = [
  /** A new tab in a project, with a pane in it. `profileId` picks the agent. */
  'create-tab',
  /** Close a tab and every pane in it. `tabId`. */
  'close-tab',
  /** Bring a tab to the front. `tabId`. */
  'select-tab',
  /** Split `paneId` and open a new pane beside it. `direction` says which way. */
  'create-pane',
  /** Close one pane. `paneId`. */
  'close-pane',
  /** Move the focus ring, without opening or closing anything. `paneId`. */
  'focus-pane',
  /** Switch which project the workspace is showing. `projectId` alone. */
  'select-project'
] as const

export type WebLayoutOpName = (typeof WEB_LAYOUT_OPS)[number]

export interface WebLayoutOp {
  op: WebLayoutOpName
  /** Always required: every operation happens inside exactly one project. */
  projectId: string
  profileId?: string
  /**
   * Per-open permission override, the same one the desktop's AgentChooser sets.
   * Typed as a plain string on purpose: this arrives off the wire, so the
   * renderer decides what it means by running it through `isPermissionMode` and
   * dropping anything else. Same treatment as `OpFrame.permissionMode` in
   * shared/mobile.ts.
   */
  permissionMode?: string
  tabId?: string
  paneId?: string
  /** `create-pane` only: `row` puts the new pane beside, `column` below. */
  direction?: SplitDirection
}

/**
 * What a browser can ask for.
 *
 * Read-mostly by design. The only two members that can change anything are
 * `layout`, which the renderer performs, and `git-action`, whose five verbs are
 * enumerated by `GitActionKind` in shared/types.ts and implemented in
 * electron/git/git-actions.ts. Nothing here names a path: `git-action` carries a
 * project id exactly as `GitActionRequest` does, so the browser cannot ask this
 * desktop to run git in an arbitrary folder.
 */
export type WebRequest =
  | { kind: 'layout'; op: WebLayoutOp }
  /** The git panel's opening read for one project. Pushes follow on `git`. */
  | { kind: 'git-status'; projectId: string }
  | {
      kind: 'git-action'
      projectId: string
      action: GitActionKind
      /** `switch` only. Must match a branch in the live snapshot. */
      branch?: string
      /** `commit` only. */
      message?: string
    }
  /** The skills flyout. Answered with the same `SkillsList` the rail draws. */
  | { kind: 'skills' }
  /** The commands flyout — the slash-command reference and the changelog. */
  | { kind: 'commands' }
  /**
   * The agent chooser's "is this actually installed" column.
   *
   * `commands` asks about arbitrary profile command lines, because a custom
   * profile is the case the built-in probe cannot answer; omit it for the
   * built-ins alone. Capped by the server, not by the type — a list is a list.
   */
  | { kind: 'agents'; commands?: string[] }

/* ------------------------------------------------------------ server frames */

/**
 * The answer to `hello`, and the browser's entire opening picture: which
 * desktop this is, what projects exist, what profiles can be launched, how the
 * tabs are laid out, and which panes are alive right now.
 *
 * This frame plus one `replay` per attached session is also the whole of the
 * offline snapshot. The client persists them, and when the PC is off it draws
 * the same picture frozen and badged rather than an empty app — Forge asleep
 * should not look like Forge broken (docs/forge-web.md, decision 10).
 */
export interface WebHelloOkFrame {
  type: 'hello-ok'
  proto: number
  appVersion: string
  /** The computer's own name — the same string `WebHostRecord.name` carries. */
  desktopName: string
  projects: Project[]
  /**
   * Launchable agent profiles.
   *
   * In the opening picture rather than behind a request because every pane
   * header draws a badge and an accent off one of these, so a client without
   * them cannot render the workspace it was just handed. Whether each profile's
   * command is *installed* is a separate, slower question — a PATH probe — and
   * that one is a request; see `WebRequest`'s `agents`.
   */
  profiles: AgentProfile[]
  /** projectId → layout. The split trees the desktop is persisting right now. */
  workspaces: Record<string, Workspace>
  sessions: WebSession[]
}

/**
 * "Steve is being asked about you. Hold on."
 *
 * Sent instead of `hello-ok` when a browser this desktop has not approved
 * connects. The socket stays open and unauthenticated until he answers.
 *
 * `words` is the anti-confusion device, and it is the only reason this is safe
 * to leave facing the internet at all: the browser shows the pair in large
 * type, the desktop shows the same pair in its prompt, and the human is told to
 * compare them. Without it, a stranger who guessed the hostname could make a
 * prompt appear at the moment Steve happened to be approving his own laptop,
 * and Allow would go to the wrong device.
 *
 * The pair is generated on the desktop by `wordPair` in shared/mobile.ts. There
 * is deliberately no second word list here — two lists is how the two screens
 * end up showing different words.
 */
export interface WebPendingFrame {
  type: 'pending'
  words: string
  /** ms epoch on the desktop's clock. See APPROVAL_TIMEOUT_MS. */
  expiresAt: number
}

/**
 * Why a connection is not going to happen.
 *
 * These are different sentences on screen and different recovery paths — sign
 * in again, sign in as somebody else, wait for a human, ask a human, update the
 * page, come back later — so they are different values rather than one
 * `error: string`. A client that collapses them into "connection failed" has
 * thrown away the only thing that tells the user what to do next.
 */
export const WEB_REFUSALS = [
  /**
   * The JWT did not verify, or it has expired. Recovery is a fresh token: the
   * page re-authenticates with Firebase and reconnects, usually without the
   * person noticing.
   */
  'bad-token',
  /**
   * A perfectly valid token, for a uid this desktop is not configured for.
   * Recovery is signing out and in as the right account — never a retry, which
   * would loop forever on a correct credential.
   */
  'wrong-account',
  /**
   * This device has never been approved, and no prompt can be raised right now
   * — the desktop is not accepting new devices, or another approval is already
   * in flight. Distinct from `declined`: nobody has said no, nobody has been
   * asked.
   */
  'not-approved',
  /** A human was asked and said no. Asking again is a new prompt, not a retry. */
  'declined',
  /** Nobody answered within APPROVAL_TIMEOUT_MS. Retrying is reasonable. */
  'timed-out',
  /**
   * This device was approved once and has since been revoked in settings. The
   * page should forget its device id and stop reconnecting; a revoked device
   * that keeps knocking is a prompt storm.
   */
  'revoked',
  /**
   * Protocol mismatch — the client is too old, or too new. Recovery is a reload
   * (Firebase Hosting will serve the current bundle) or updating the desktop.
   */
  'proto',
  /**
   * The desktop is up but cannot take this connection: too many sockets, or it
   * is still starting. `retryAfterMs` says when to try again.
   */
  'busy',
  /**
   * A second factor is enrolled and this browser has not presented one. Nothing
   * has gone wrong: the recovery is to show a text box and send the `hello`
   * again with `totp` filled in.
   *
   * Deliberately not counted as a failed attempt by the desktop's lockout — it
   * is the first half of every ordinary sign-in on a machine with 2FA, and a
   * door that struck for it would lock somebody out on their fifth login.
   */
  'totp-required',
  /**
   * A code was presented and did not open the door: wrong, expired, already
   * spent, or a recovery code that has been used. One value rather than four,
   * because telling them apart out loud tells an attacker which half of the
   * guess was right. This one *does* count against the lockout.
   */
  'totp-invalid'
] as const

export type WebRefusal = (typeof WEB_REFUSALS)[number]

export interface WebRefusedFrame {
  type: 'refused'
  reason: WebRefusal
  /** One sentence, written for the person reading the browser tab. */
  message: string
  /** `busy` only: roughly how long before asking again is worth it. */
  retryAfterMs?: number
}

/**
 * The scrollback catch-up, sent once per `attach` before any live `data`.
 *
 * The same 192KB buffer `electron/pty-host.ts` already keeps for a reloading
 * renderer; see MAX_REPLAY_BYTES. `truncated` says the buffer was cut at that
 * ceiling, so the client can draw a rule above it rather than implying the
 * session began there — a transcript that silently starts mid-sentence is a
 * transcript somebody will quote from.
 */
export interface WebReplayFrame {
  type: 'replay'
  sessionId: string
  data: string
  truncated: boolean
}

/**
 * Live PTY output.
 *
 * Already batched when it gets here, and the batching is not this protocol's:
 * `electron/pty-host.ts` coalesces every session's output on a 12ms flush, with
 * an early flush at 64KB so a `cat` of a large file does not sit in a buffer.
 * That is one frame per session per 12ms at worst — about 80 a second for a
 * redrawing TUI, against the thousands of individual ConPTY reads underneath —
 * and it is deliberately the *desktop's* timer rather than something the client
 * asks for, so a browser cannot make this desktop chattier than it already is.
 *
 * The corollary matters for anyone tempted to add a per-frame acknowledgement:
 * there is none, and there must not be. This is a stream, and xterm.js on the
 * far end is a terminal, not a message queue.
 */
export interface WebDataFrame {
  type: 'data'
  sessionId: string
  data: string
}

/** A pane's process ended. Mirrors `PtyExitEvent` in shared/types.ts. */
export interface WebExitFrame {
  type: 'exit'
  sessionId: string
  exitCode: number
}

/**
 * The live pane list, whole, on every change.
 *
 * The full set each time rather than a diff, for the reason `onWatch` gives in
 * electron/mobile/server.ts: a diff the receiver has to reassemble is a diff
 * that can be missed, and a missed one leaves a dead terminal on screen that
 * looks alive.
 */
export interface WebSessionsFrame {
  type: 'sessions'
  sessions: WebSession[]
}

/**
 * One pane just opened.
 *
 * Redundant against `sessions` as data, and not redundant as an *event*: this
 * is the single moment a client has to do something — construct an xterm
 * instance and attach — and every client that had to find it by diffing two
 * lists would implement the same diff, with the failure mode being a pane that
 * renders as a dead box. It carries the record so that work can start before
 * the list arrives.
 */
export interface WebSessionStartedFrame {
  type: 'session-started'
  session: WebSession
}

/**
 * A pane has settled on a question — an agent asking permission to run
 * something, or a prompt waiting on an answer.
 *
 * Be precise about what this is, because it is easy to mistake for something
 * richer. Forge has no structured agent-permission channel: Claude Code and
 * every agent like it ask *inside the TUI*, and the desktop learns about it by
 * watching settled output (`attention` in src/lib/terminals.ts). So this frame
 * is a badge, not a dialog — it says which pane is waiting, so a client can
 * mark a tab it is not looking at.
 *
 * The answer is an ordinary `write`: the same bytes a keystroke at the desk
 * would send. There is deliberately no `approve` frame, because a structured
 * grant is a thing this desktop cannot deliver, and a frame that implied
 * otherwise would be a promise the server would have to fake.
 */
export interface WebAttentionFrame {
  type: 'attention'
  sessionId: string
  /** True when the pane started waiting, false when it stopped. */
  asking: boolean
  /**
   * The settled question, when the desktop has it — a courtesy for a client
   * that is not attached to this pane and so has none of its bytes. Truncated
   * to a line; the pane itself is the real answer to "what is it asking".
   */
  prompt?: string
}

/** The project list changed — renamed, reordered, added, removed. */
export interface WebProjectsFrame {
  type: 'projects'
  projects: Project[]
}

/** One project's split tree changed, at the desk or from another browser. */
export interface WebWorkspaceFrame {
  type: 'workspace'
  projectId: string
  workspace: Workspace
}

/**
 * A git status the desktop's watcher produced, unbidden.
 *
 * `GitSnapshot` carries absolute paths (`repoRoot`, and `absPath` on every
 * changed file) because the desktop's git panel is reused wholesale in the
 * browser — decision 4 in docs/forge-web.md — and the component reads them.
 * That is the one place this protocol carries desktop paths it did not strictly
 * have to, and it is worth being awake about: they travel *down* only. Nothing
 * the browser sends back names a path. `git-action` carries a project id, and
 * the desktop resolves the folder itself.
 */
export interface WebGitFrame {
  type: 'git'
  snapshot: GitSnapshot
}

/** The answer to a `request`, correlated by `rid`. */
export interface WebResultFrame {
  type: 'result'
  rid: string
  body: WebResult
}

export type WebResult =
  /** It worked and there is nothing to say — a layout op, an `auth` refresh. */
  | { kind: 'ok' }
  /**
   * It was attempted and did not work. A result rather than an `error` frame
   * because it has to settle a promise the client is holding on `rid`.
   */
  | { kind: 'failed'; code: WebErrorCode; message: string }
  /**
   * A git snapshot — the answer to both `git-status` and a successful
   * `git-action`. The action's snapshot is re-read *after* the action, exactly
   * as `GitActionResult` promises, so the panel can never show a pre-action
   * answer.
   */
  | { kind: 'git'; snapshot: GitSnapshot }
  | { kind: 'skills'; skills: SkillsList }
  | { kind: 'commands'; feed: CommandsFeed }
  /** The built-in agents, and whatever arbitrary command lines were asked about. */
  | { kind: 'agents'; agents: AgentPresence[]; commands: CommandPresence[] }

/**
 * "This desktop is going away."
 *
 * The client's cue to stop reconnecting and drop to GitHub mode, sent before
 * the socket closes so the reason is known rather than inferred from a silence.
 * Without it every shutdown looks like a network fault and the page spends the
 * next minute retrying a machine that is off.
 */
export const WEB_SHUTDOWN_REASONS = [
  /** Forge is exiting, or the machine is shutting down. */
  'quit',
  /** The machine is suspending. It will very likely be back. */
  'sleep',
  /** Restarting — an update, or a settings change that needs the server back. */
  'restart',
  /** Forge Web was switched off in settings. Reconnecting will not help. */
  'disabled'
] as const

export type WebShutdownReason = (typeof WEB_SHUTDOWN_REASONS)[number]

export interface WebShutdownFrame {
  type: 'shutdown'
  reason: WebShutdownReason
  /** One sentence for the offline banner. */
  message: string
  /** Roughly when it is worth dialling again, when the desktop can guess. */
  retryAfterMs?: number
}

/**
 * Something went wrong that no `rid` is waiting on — a malformed frame, a write
 * to a pane that has gone, a client over MAX_INPUT_PER_SECOND.
 *
 * Only `message` is meant to be shown; the codes exist so a client can decide
 * whether to retry, re-sync or give up, not so it can compose a sentence. That
 * is why there is no runtime list and no guard for them, unlike `WebRefusal`
 * and `WebShutdownReason`, which a client genuinely switches on.
 */
export type WebErrorCode =
  /** Not JSON, not an object, or a `type` this server does not know. */
  | 'bad-frame'
  /** That pane is gone. After a `write`, it also means nothing was typed. */
  | 'unknown-session'
  /** No project by that id — the client's list is stale; expect `projects`. */
  | 'unknown-project'
  /** Over MAX_INPUT_PER_SECOND, or over MAX_WRITE_CHARS. Slow down. */
  | 'limit'
  /**
   * The desktop renderer that owns tabs and panes is not there, so a layout
   * request cannot be performed by anything. Same code, same meaning, as
   * shared/mobile.ts's `no-window`.
   */
  | 'no-window'
  /** This desktop cannot do that at all — an older build, or a disabled feature. */
  | 'unsupported'
  /** It was attempted and failed. `message` says how. */
  | 'failed'

export interface WebErrorFrame {
  type: 'error'
  code: WebErrorCode
  message: string
  /** The session it is about, when it is about one. */
  sessionId?: string
}

export interface WebPongFrame {
  type: 'pong'
}

export type WebServerFrame =
  | WebHelloOkFrame
  | WebPendingFrame
  | WebRefusedFrame
  | WebReplayFrame
  | WebDataFrame
  | WebExitFrame
  | WebSessionsFrame
  | WebSessionStartedFrame
  | WebAttentionFrame
  | WebProjectsFrame
  | WebWorkspaceFrame
  | WebGitFrame
  | WebResultFrame
  | WebShutdownFrame
  | WebErrorFrame
  | WebPongFrame

/* ----------------------------------------------------------------- decoding */

/**
 * Parse one text frame off the wire.
 *
 * Everything arriving here is attacker-controlled until proven otherwise, so
 * this is total: it returns null rather than throwing, and the caller answers
 * `bad-frame`. No field is trusted for its type — that is each handler's job,
 * via the coercers below. The frame is *admitted*, not believed.
 *
 * The size ceiling is not checked here; see MAX_FRAME_BYTES for why it belongs
 * at the socket, where the count is genuinely in bytes.
 */
export function parseFrame(raw: string): WebClientFrame | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string') return null
  switch (type) {
    case 'hello':
    case 'auth':
    case 'attach':
    case 'detach':
    case 'write':
    case 'resize':
    // Admitted here and understood nowhere else until the handler has run its
    // `body.kind` through the guards below. A request is a shape at this
    // boundary and becomes an action later, in one place.
    case 'request':
    case 'ping':
      return value as WebClientFrame
    default:
      return null
  }
}

/** A string field off the wire, trimmed and clamped. Never throws. */
export function wireString(value: unknown, max = 256): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * A terminal dimension off the wire, held inside what a ConPTY will accept.
 * Same bounds as shared/mobile.ts: two columns is the smallest thing that is
 * still a terminal, and a thousand is past any real window.
 */
export function wireDim(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.floor(n)))
}

/**
 * Printable characters only, by code point rather than by regex.
 *
 * Same guard, and the same reasoning, as shared/mobile.ts: the strings it
 * protects are drawn in a browser out of a database record, and a control
 * character in a name is at best a broken line and at worst something the
 * renderer has to have an opinion about.
 */
function printable(text: string): string {
  return [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 31 && code !== 127
    })
    .join('')
}

/* ------------------------------------------------------------- type guards
 *
 * Three, and only three. Each one exists because a value crosses a boundary and
 * is then *switched on* rather than displayed: a refusal decides what the page
 * tells the user to do, a shutdown reason decides whether to reconnect, and a
 * layout op decides what the desktop renderer performs. A value a newer peer
 * invented must fall out of the switch here, at the edge, rather than three
 * frames later at a `default` case somebody forgot to write.
 */

export function isWebRefusal(value: unknown): value is WebRefusal {
  return typeof value === 'string' && (WEB_REFUSALS as readonly string[]).includes(value)
}

export function isWebShutdownReason(value: unknown): value is WebShutdownReason {
  return typeof value === 'string' && (WEB_SHUTDOWN_REASONS as readonly string[]).includes(value)
}

export function isWebLayoutOp(value: unknown): value is WebLayoutOpName {
  return typeof value === 'string' && (WEB_LAYOUT_OPS as readonly string[]).includes(value)
}

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
 * opening a tab here opens it on the desk, and there is exactly one owner of
 * the split tree and one thing that persists a workspace (docs/forge-web.md,
 * decision 5) — the desktop's *main process*, since electron/layout-engine.ts.
 * So every layout frame below is a *request* that comes back with a result,
 * never a local mutation announced afterwards.
 *
 * Out of scope on purpose, and modelled nowhere in this file: voice and
 * dictation, the screenshot *tray*, the overlay, Forge Mobile, Forge TV
 * (docs/forge-web.md, decision 7). A pasted image is in — it lands as a file
 * on this desktop and a quoted path in a pane, which is the same gesture as
 * dropping a screenshot on an agent at the desk. The tray that catches the
 * clipboard is still a desktop-only thing.
 *
 * The desktop's *screen* used to be on that list, under a sentence saying that
 * "a public URL that moves the real mouse is a different risk class, and this
 * file must not grow the vocabulary for one". The vocabulary is now here — see
 * the screen-mirror block at the bottom — because Steve decided it should be,
 * not because anybody stopped believing that sentence. It is still true, and it
 * is answered by the escalation guard in electron/web-host.ts rather than by an
 * absence of frames: a browser that may drive this desk has had to type the
 * desktop's unlock PIN seconds earlier, on a desktop that has one set at all.
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
  HandoffRecord,
  Project,
  SplitDirection,
  VoiceAgentEvent,
  Workspace
} from './types'
import type { SkillsList } from './skills'
import type { CommandsFeed } from './commands'
/*
 * Foreman's state, imported whole rather than restated. `ForemanState` is
 * already plain JSON built for exactly this crossing (see shared/foreman.ts),
 * so a second copy here would be the thing this file exists to prevent: two
 * descriptions of one driven pane that disagree about a field. The seed cap
 * that travels with it, FOREMAN_SEED_MAX, is imported by the servers from
 * shared/foreman.ts directly — this file carries the shape, not the rule.
 */
import type { ForemanState } from './foreman'
/*
 * How a client names the pane or profile a handoff should go to, imported from
 * the file that owns the whole Handoff vocabulary rather than restated here —
 * the same bargain this file strikes with `ForemanState`. `readHandoffTarget`
 * lives beside it and is imported by the servers directly, so this file carries
 * the shape and shared/handoffview.ts carries the rule.
 */
import type { HandoffTargetWire } from './handoffview'
/*
 * The chat transcript's own vocabulary, kept in a file of its own rather than
 * spelled out here. It is read by the desktop's transcript reader and by the
 * browser's chat view and by nothing in between — this protocol only carries
 * it — so it earns a file the way `SkillsList` and `CommandsFeed` do, and for
 * the same reason: this one describes the *wire*, not what travels on it.
 */
import type { ChatUpdate } from './chat'
/*
 * The input vocabulary, borrowed whole from the phone link rather than restated
 * here. The rule this file usually follows is the opposite one — MAX_SESSIONS
 * is restated so the browser bundle does not carry the desktop's IPC table for
 * one integer — and it is deliberately broken for these three, because they are
 * not a *value* both files happen to agree on but the exact grammar that
 * `readMirrorInput` validates against. Two copies of a closed key list is how
 * one link ends up able to press a key the other cannot, in a frame that ends
 * at the operating system. Type-only, so nothing is bundled by it.
 */
import type { MirrorButton, MirrorInputAction, MirrorKey, RemoteYesInfo } from './mobile'

/* --------------------------------------------------------- protocol identity */

/**
 * Protocol version. Bumped when a frame changes shape in a way an older client
 * would misread. The server refuses a mismatch at `hello` with a sentence the
 * browser can show, rather than failing later in a way that looks like a bug.
 *
 * Adding an *optional* field is not a bump — an older client ignores it and a
 * newer one falls back — exactly as `permissionMode` was added to
 * shared/mobile.ts's `OpFrame` without moving MOBILE_PROTO.
 *
 * Nor is adding a whole *frame type*, which is why the screen mirror at the
 * bottom of this file did not move either this number or WEB_SUBPROTOCOL. An
 * older client never sends `mirror-start`, so a newer desktop never has to
 * answer one; an older desktop sends the frame through `parseFrame`, which does
 * not know it, and answers `bad-frame` — a code the client has tolerated since
 * the first release. Bumping would have refused every existing tab at the
 * upgrade to gain nothing either end could use.
 *
 * **2** is the unlock PIN replacing the TOTP second factor and the word-pair
 * approval, and it is a bump by every one of the tests above: `pending` is gone
 * as a frame type, four refusals a client switches on are gone with it, and
 * `hello` answers a different question. A page built against 1 would sit at a
 * "showing OTTER RIVER" screen that can never arrive; refusing it at the
 * upgrade and telling it to reload is the honest failure.
 */
export const WEB_PROTO = 2

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
export const WEB_SUBPROTOCOL = 'forge-web.v2'

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
 * Two frames compete for the biggest a browser legitimately sends: a
 * `paste-image` whose base64 payload is MAX_IMAGE_BASE64, and a
 * `foreman-start` carrying a seed up to FOREMAN_SEED_MAX characters. The seed
 * is the bigger of the two once it is not ASCII — `wireString` clamps by
 * character count, not bytes, so 40,000 characters of pasted prose can be
 * ~120KB of UTF-8 before it ever reaches that clamp. 192KB clears both with
 * room to spare and is still small enough that a thousand of them cannot be a
 * memory attack. It bounds the *inbound* direction only: a `replay` travelling
 * the other way is deliberately larger than this, see MAX_REPLAY_BYTES.
 */
export const MAX_FRAME_BYTES = 192 * 1024

/**
 * Biggest base64 payload a `paste-image` request may carry.
 *
 * Sized to leave a few kilobytes for the JSON envelope inside MAX_FRAME_BYTES,
 * so a well-formed image request is admitted by `ws`'s `maxPayload` and then
 * judged here rather than hanging up the socket. ~36 KB of JPEG, which is a
 * readable screenshot once the page has run it down the size ladder in
 * web/src/lib/image.ts. A phone photo that will not shrink that far is
 * refused in a sentence, not half-uploaded.
 */
export const MAX_IMAGE_BASE64 = 48 * 1024

/**
 * Maximum total bytes for a file uploaded from the browser (50 MB).
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Raw byte size of each file upload chunk (64 KB).
 * In base64 this is ~86 KB, which fits comfortably inside MAX_FRAME_BYTES (192 KB).
 */
export const MAX_FILE_CHUNK_BYTES = 64 * 1024

/**
 * Maximum base64 payload length of a single file chunk frame (~96 KB).
 */
export const MAX_FILE_CHUNK_BASE64 = 96 * 1024

/**
 * The most audio one `dictate` recording may carry, reassembled. Opus at
 * MediaRecorder's default bitrate is ~4 KB/s, so this is a quarter of an hour
 * of talking — far past what anyone dictates into one prompt, and small next
 * to MAX_FILE_BYTES.
 */
export const MAX_DICTATION_BYTES = 4 * 1024 * 1024

/**
 * How long a streamed dictation (`dictate-stream`) may sit with nothing
 * appended before the desktop forgets it. A phone that lost its signal
 * mid-sentence, or a tab closed while recording, leaves a half-assembled
 * recording behind; two minutes is far past any pause between MediaRecorder
 * slices and short enough that four megabytes of somebody's voice does not
 * linger. An `append` or `done` after that is answered `failed`, and the page
 * should fall back to sending the recording it still holds as `dictate`.
 */
export const DICTATION_STREAM_IDLE_MS = 2 * 60 * 1000

/**
 * The most of one text file a `project-file` answer carries. Past it the
 * answer is the first MAX_PROJECT_FILE_BYTES, cut on a character boundary,
 * with `truncated` set — a phone reading a file wants the top of it, not a
 * refusal, and not a megabyte of JSON down a tunnel.
 */
export const MAX_PROJECT_FILE_BYTES = 512 * 1024

/** Image types a `paste-image` request may name. Anything else is `bad-frame`. */
export const WEB_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type WebImageMime = (typeof WEB_IMAGE_MIMES)[number]

export function isWebImageMime(value: unknown): value is WebImageMime {
  return typeof value === 'string' && (WEB_IMAGE_MIMES as readonly string[]).includes(value)
}

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
 * Firebase ID tokens are minted with a one-hour life, and this link is meant to
 * stay up for a working day. So the credential is re-presented mid-connection
 * rather than only at `hello` — see `WebAuthFrame`. Ten minutes of margin
 * covers a laptop that slept through its own refresh and a clock that is a
 * little out; the server re-verifies against Google's keys either way and
 * refuses a lapsed one with `bad-token`.
 */
export const TOKEN_LIFETIME_MS = 60 * 60_000
export const TOKEN_REFRESH_MS = 50 * 60_000

/* ------------------------------------------------------------- the unlock PIN
 *
 * The second half of the door, and the whole of the second factor: a run of
 * digits set once at the desk, asked of every browser on every connection.
 *
 * The two numbers live here because both ends read them — the desktop refuses
 * anything outside them and the browser draws a box that will not accept
 * anything else — and they are the *only* thing about the PIN this file knows.
 * How it is stored is electron/web/pin.ts's business and is deliberately not
 * described on this wire: what travels is what somebody typed, once, over a
 * socket already inside TLS and already past a verified Firebase ID token.
 *
 * There is no "trust this browser for thirty days", and the only thing that
 * excuses the question *at the door* is having just answered it. The PIN is
 * not a device credential — it is the thing that says the person holding the
 * account is the person who set it up — so the desktop still asks on every
 * connection, and nothing on disk remembers a yes. What PIN_GRACE_MS buys is
 * narrower: the *page* may replay digits it already typed, from memory and
 * never from disk, so a phone that dropped its socket when the tab was hidden
 * does not make somebody retype four digits they typed thirty seconds ago. A
 * reload, a discarded tab, or a longer absence sends no PIN and is asked
 * again. A passkey answer cannot be replayed that way, so its equivalent is
 * the desktop's own single-use ticket — see PASSKEY_RESUME_MS.
 */

/**
 * Four, which is what a person will actually set and remember, and which is
 * only defensible because of what stands either side of it: a verified token
 * for one configured account in front, and the per-source lockout in
 * electron/web/auth.ts behind. Ten thousand possibilities are nothing offline
 * and are weeks of work through a door that stops answering after five wrong
 * ones.
 */
export const PIN_MIN_DIGITS = 4

/**
 * Twelve, so a longer one is possible for somebody who wants it, and bounded so
 * a `hello` cannot carry a megabyte of "PIN" into a key-derivation function.
 */
export const PIN_MAX_DIGITS = 12

/**
 * How long a page may replay a PIN it already typed, from memory.
 *
 * Not a trust window on the door — electron/web/auth.ts still requires the
 * digits on every `hello`. The client holds them in RAM after a successful
 * unlock and includes them on the next hello while the tab has been hidden
 * for less than this. Never written to disk; a reload forgets them.
 */
export const PIN_GRACE_MS = 10 * 60 * 1000

/**
 * How long after a passkey-unlocked socket closes its page may come back
 * without a second fingerprint.
 *
 * PIN_GRACE_MS for passkeys, and narrower on purpose. An assertion is signed
 * over a single-use challenge, so the page has nothing of its own to replay;
 * instead the desktop hands a passkey-admitted socket a `resume` ticket on
 * `hello-ok` — 32 random bytes, held by the page in RAM only and by the
 * desktop as a SHA-256 in memory only. A `hello` carrying it, and no PIN and
 * no passkey, is admitted with a passkey's rights (never a PIN's) while its
 * socket is still open or until this long after it closed, from the same
 * browser, page and PIN — once: every use spends it and the `hello-ok` brings
 * a fresh one. Anything else about it is answered as a `hello` with no
 * credential at all, `pin-required`, and never struck: 256 random bits are
 * not a secret anybody guesses. Never issued after a PIN unlock, which has
 * PIN_GRACE_MS, nor when no PIN is set. An older desktop sends none, and the
 * page simply asks as it always did.
 */
export const PASSKEY_RESUME_MS = 30_000

/* ----------------------------------------------------------------- passkeys
 *
 * A phone's own fingerprint or face as an alternative answer to the PIN
 * question — WebAuthn, with the key held in the phone's platform
 * authenticator. The PIN stays the fallback and the root: every passkey is
 * enrolled under the current PIN and changing or clearing the PIN voids them
 * all. electron/web/passkey.ts holds the verifier and says why.
 *
 * Everything binary travels as base64url, because this wire is JSON. The
 * options below are `PublicKeyCredentialCreationOptions` and
 * `PublicKeyCredentialRequestOptions` with every BufferSource turned into
 * that: the page decodes `challenge`, `user.id` and each credential `id` into
 * bytes before handing them to `navigator.credentials`.
 *
 * Optional everywhere, and announced: a desktop that can do this puts
 * WEB_FEATURE_PASSKEY in `hello-ok.features`, and a page uses none of it
 * otherwise. Added without a WEB_PROTO bump on the rule at the top of this
 * file — an older desktop ignores the fields and answers the requests
 * `unsupported`.
 */

/** The `hello-ok.features` entry that says this desktop understands passkeys. */
export const WEB_FEATURE_PASSKEY = 'passkey'

/**
 * The `hello-ok.features` entry that says this desktop takes `dictate-stream`:
 * audio appended while Steve is still talking, so only the last slice is left
 * to upload when he stops. Absent (an older desktop) → record, then send the
 * whole recording as `dictate`, which every desktop still takes.
 */
export const WEB_FEATURE_DICTATE_STREAM = 'dictate-stream'

/**
 * The `hello-ok.features` entry that says this desktop answers `project-files`
 * and `project-file` — a read-only look inside a project's folder. Absent → the
 * page browses files in GitHub mode only, as it always has.
 */
export const WEB_FEATURE_FILES = 'files'

/**
 * The `hello-ok.features` entry that says this desktop answers
 * `project-remove-preview` and `project-remove` — taking a project off the
 * rail from a browser, the folder left alone. Absent (an older desktop) → the
 * page shows the control disabled rather than sending a request it knows will
 * come back `unsupported`.
 */
export const WEB_FEATURE_PROJECT_REMOVE = 'project-remove'

/**
 * The `hello-ok.features` entry that says this desktop sends `usage` frames — a
 * pane's context window and the account's 5-hour and weekly limits. Absent (an
 * older desktop) → the page draws no ring and no limits, and falls back to
 * whatever the footer scrape in `status.context` says.
 */
export const WEB_FEATURE_USAGE = 'usage'

/**
 * A browser asking for a project to come off the rail, on its way from main to
 * the renderer over `IPC.webProjectRemove`. An IPC event rather than a wire
 * frame, declared here beside the request it carries so the two cannot drift.
 * Main has already checked the project is on its list; the renderer checks
 * again against its own and answers on `webCommandResult`.
 */
export interface WebProjectRemoveEvent {
  requestId: string
  /** The browser's own name, for a "removed from Chrome on Windows" toast. */
  deviceName: string
  projectId: string
}

/** `navigator.credentials.create({ publicKey })`, base64url where WebAuthn wants bytes. */
export interface WebPasskeyCreationOptions {
  challenge: string
  rp: { name: string; id: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  authenticatorSelection: {
    authenticatorAttachment: 'platform'
    userVerification: 'required'
    residentKey: 'preferred'
  }
  attestation: 'none'
  excludeCredentials: { type: 'public-key'; id: string }[]
  /** Milliseconds. The challenge dies at the same moment. */
  timeout: number
}

/** `navigator.credentials.get({ publicKey })`, base64url where WebAuthn wants bytes. */
export interface WebPasskeyRequestOptions {
  challenge: string
  rpId: string
  allowCredentials: { type: 'public-key'; id: string }[]
  userVerification: 'required'
  /** Milliseconds. The challenge dies at the same moment. */
  timeout: number
}

/**
 * A `PublicKeyCredential` from `navigator.credentials.get`, flattened: `rawId`
 * and the four `AuthenticatorAssertionResponse` buffers, each base64url.
 * `userHandle` is optional because an authenticator may return null.
 */
export interface WebPasskeyAssertion {
  credentialId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
  userHandle?: string
}

/** One enrolled passkey as a list row. No key material. */
export interface WebPasskeyInfo {
  credentialId: string
  /** What the enrolling browser called itself. Display text only. */
  deviceName: string
  createdAt: number
  lastUsedAt: number
}

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
 * browser draws it.
 *
 *   connecting  the socket is opening, or `hello` is in flight
 *   pin         the desktop wants its unlock PIN before it will say more
 *   live        authenticated and mirroring — `WebHelloOkFrame` has arrived
 *   refused     any refusal; `WebRefusedFrame.reason` says which
 *   offline     no desktop to talk to. This is the GitHub-mode state
 *
 * `pin` is its own state rather than a shade of `refused` because nothing has
 * gone wrong and there is nothing to recover from — the page is being asked a
 * question, and the screen it draws is a text box rather than an apology. It is
 * the only state on this list that a browser reaches on an ordinary sign-in.
 */
export type WebConnectionState = 'connecting' | 'pin' | 'live' | 'refused' | 'offline'

/* ------------------------------------------------------------ client frames */

/**
 * First frame on every connection. No frame before it is honoured.
 *
 * Note what is *not* here: a device token. Forge Mobile mints one because it
 * has no identity provider and needs something to remember a phone by; Forge
 * Web has a verified Firebase ID token in hand, and minting a second credential
 * beside it would add a thing to steal and prove nothing the first does not.
 * The desktop keeps no record of the browsers it has admitted either: `deviceId`
 * and `deviceName` below live for the length of one socket and are written
 * nowhere.
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
  /** The web client's build, for the desktop's log and for support. */
  client: string
  /**
   * Stable per-browser-profile id, minted once and kept in the browser's own
   * storage. Two profiles on one machine are two devices, which is correct: the
   * thing being named is a place a token is being used from.
   *
   * Not a credential and not a gate — the desktop only checks that it is there
   * at all, because a page that cannot produce one has no storage and should be
   * told so rather than left guessing. See `not-approved` below.
   */
  deviceId: string
  /**
   * What the browser calls itself in the desktop's log — "Chrome on Windows",
   * typically. Untrusted display text: show it, never obey it.
   */
  deviceName?: string
  /**
   * The desktop's unlock PIN, when it has one set: PIN_MIN_DIGITS to
   * PIN_MAX_DIGITS digits, as somebody typed them.
   *
   * The first `hello` of a fresh page load carries no PIN, the desktop answers
   * `pin-required`, and the next carries what the person typed — a round trip,
   * bought so a desktop with no PIN set never causes one to be typed at all.
   *
   * Asked on **every** connection at the door. There is no "remember this
   * browser" and nothing on the desktop that could remember one. After a
   * successful unlock the *page* may replay the same digits from memory for
   * PIN_GRACE_MS after it was last visible, so a phone that hid the tab does
   * not re-prompt immediately. A reload forgets them; they are never written
   * down. (After a *passkey* unlock the equivalent is `resume`, below.)
   */
  pin?: string
  /**
   * A passkey answer to the PIN question, instead of `pin` — sent only in
   * reply to a `pin-required` refusal that carried `passkey` options, signed
   * over that refusal's challenge. When both are present `pin` is judged and
   * this is ignored. A failure is struck exactly like a wrong PIN, and is
   * answered `pin-invalid`.
   */
  passkey?: WebPasskeyAssertion
  /**
   * The single-use ticket the last passkey-unlocked `hello-ok` carried, sent
   * in place of a fresh fingerprint — see PASSKEY_RESUME_MS. Only when there
   * is neither `pin` nor `passkey`: either of those is judged and this is
   * ignored. Optional field, added without a WEB_PROTO bump on the rule at the
   * top of this file; an older desktop never reads it and asks as before.
   */
  resume?: string
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
 * at". They are a *wish*, not an instruction: a PTY has one grid and this link
 * gives it several viewers, and **the grid belongs to the device somebody last
 * typed into the pane on** (electron/pty/grid-owner.ts). Attaching is not
 * typing, so an attach never moves a pane on its own — the size is stored, and
 * it lands the moment somebody types in this tab.
 *
 * Two earlier rules are recorded there and worth not resurrecting: "last mover
 * wins", which meant connecting a device reshaped the desktop, and "the desk
 * owns it while it has a window", which meant a large browser wasted its screen
 * letterboxing a laptop's pane.
 *
 * So a browser sends these and then draws whatever the `sessions` list says the
 * grid actually is, at a font small enough to fit its own box (`follow` in
 * web/src/lib/term.ts) — which is nothing to do when it is the browser's own
 * grid the desktop granted. Omitting them means "I will take whatever size it
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

/**
 * The browser's terminal viewport changed — a window resize, or a font change.
 *
 * The same wish `WebAttachFrame` carries, and under the same rule: granted when
 * this desktop has no window open, dropped in silence when it has. A client
 * keeps sending them regardless rather than tracking the policy, because the
 * desk's window can close between one frame and the next and a client holding a
 * stale copy of the rule would keep quiet through exactly the moment its size
 * started to matter.
 */
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
  | WebMirrorStartFrame
  | WebMirrorStopFrame
  | WebMirrorInputFrame

/* --------------------------------------------------------- layout operations
 *
 * The operations that mutate the workspace. Deliberately *not* "run this
 * command": the browser names a profile id, which the desktop resolves against
 * its own settings, and a project id, whose folder the desktop already knows.
 * Nothing in *this* block chooses a cwd or an executable — and that is still
 * true of every operation in it now that `fs-list` and `project-add` exist
 * elsewhere in `WebRequest`. Opening a pane picks neither; adding a project
 * names a folder and launches nothing.
 *
 * Performed by the desktop's main process, which owns tabs and panes and
 * persists them (electron/layout-engine.ts) — running the same pure functions
 * a local click runs, never a second implementation that could disagree with
 * the first. The renderer is told the result and follows it.
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
 * A folder on the desktop's disk, as the browser is shown it.
 *
 * Everything a picker needs to draw one screen and ask for the next, composed
 * *on the desktop* — which is the whole shape of it. A browser has no idea
 * whether the machine it is looking at spells a path with `\` or `/`, where a
 * drive root ends, or what `..` means there; so it never builds one. It sends
 * back a `path` this desktop handed it, or an entry `name` for this desktop to
 * append. See `fs-list`.
 */
export interface WebFolder {
  /**
   * The absolute path that was actually listed, spelled the way this desktop
   * spells it, or '' for the list of drive roots.
   *
   * Resolved rather than echoed: what comes back is what the desktop opened,
   * so a client that displays it is displaying the truth about where it is.
   */
  path: string
  /** This desktop's own separator — `\` on Windows, `/` elsewhere. */
  sep: string
  /**
   * This folder and every folder above it, root first, so the breadcrumb has a
   * path to send back for each crumb instead of rebuilding one by slicing
   * `path` — which is precisely the string-surgery a browser cannot do
   * correctly for a machine it is not on. Empty at the drive roots.
   */
  crumbs: WebCrumb[]
  /**
   * What is in it: folders first, then files, each case-insensitively by name.
   *
   * The order is part of the contract rather than a detail of the sort, because
   * it is the order `truncated` cuts in — a cap that buried the folders under
   * ten thousand files would leave a picker with nothing to click.
   */
  entries: WebDirEntry[]
  /**
   * The folder holds more than one answer may carry, so what is here is the
   * first page of it in that order and not the whole folder. Said out loud
   * because a list silently cut at a ceiling is a folder somebody will swear no
   * longer contains their project.
   */
  truncated: boolean
}

/** One step of the breadcrumb: what to draw, and what to ask for. */
export interface WebCrumb {
  /** The segment as it is shown — `C:\`, then `Users`, then `steve`. */
  name: string
  /** The absolute path of that step, to send straight back as `fs-list.path`. */
  path: string
}

/**
 * One thing inside a folder. A *name*, and two facts about it.
 *
 * Never a path, and never any content: this is `readdir` with the type bit that
 * came free with it, plus one `.git` probe. A file's bytes never travel with a
 * listing; the one request that reads contents is `project-file`, and it is
 * confined to a project's own folder (electron/web/project-files.ts).
 */
export interface WebDirEntry {
  name: string
  /** A folder, and therefore something the picker may open. */
  dir: boolean
  /**
   * It holds a `.git`, so it is very probably a project rather than somewhere
   * on the way to one. The one adornment worth the stat: it is what makes a
   * list of forty folders readable at a glance.
   */
  repo: boolean
}

/**
 * One thing inside a project's folder — a row of the read-only file browser,
 * the answer to `project-files`. A name and the facts a file list draws; the
 * path to ask for next is the listed folder's `path` plus `/` plus `name`.
 */
export interface WebProjectEntry {
  name: string
  /** A folder, and therefore something to list rather than read. */
  dir: boolean
  /** Bytes. 0 for a folder. */
  size: number
  /** Last modified, ms epoch. */
  mtime: number
}

/**
 * What a browser can ask for.
 *
 * Read-mostly by design. The members that can change anything are `layout`,
 * which the renderer performs, `git-action`, whose five verbs are enumerated by
 * `GitActionKind` in shared/types.ts and implemented in
 * electron/git/git-actions.ts, `project-add`, which the renderer performs
 * through the same `addProjectPath` a click at the desk reaches, and
 * `project-create`, which makes one new fenced folder and then takes the
 * `project-add` path with it.
 *
 * ## Two members here do name a path, and that is a deliberate change
 *
 * This paragraph used to say "Nothing here names a path", and offered
 * `git-action`'s project id as the proof — it still carries one, and still
 * cannot ask this desktop to run git in an arbitrary folder. But `fs-list` and
 * `project-add` name folders outright, so the old sentence would now be a
 * comforting lie, and a lie in this file is worse than the thing it describes.
 *
 * The honest reckoning is that the no-paths rule was never a containment
 * boundary. A browser that is in already types into a live shell — that is what
 * `write` *is* — and a shell can `cd` anywhere on this PC and read anything the
 * account can read. A protocol with no path in it therefore bought no
 * confinement whatsoever; what it bought was a smaller vocabulary, which is
 * worth something and is not worth being unable to add a project from a
 * hotel room three hundred miles away.
 *
 * The lock is, and has always been, the account plus the second factor: a
 * Firebase ID token verified against Google's keys on every connection, matched
 * to the one uid this desktop is configured for, behind the desktop's unlock
 * PIN when one is set, from a page served by an origin this desktop names.
 * Everything in this union is
 * behind all of that. What these two members must therefore be careful about is
 * not confinement but *behaviour*: they read names and never contents, they
 * answer a refusal in a sentence rather than throwing, and they cap what one
 * answer may carry — see `WebFolder` above, and the note on each of the two
 * members below.
 */
export type WebRequest =
  | { kind: 'layout'; op: WebLayoutOp }
  /**
   * "Make this pane's grid mine." The one deliberate way to take a pane's
   * geometry without typing into it — see electron/pty/grid-owner.ts, where
   * ownership otherwise follows the typist. A phone's layout sends it when a
   * pane comes on screen, because a 150-column grid font-fitted to 390px is
   * unreadable and the person holding the phone is the one using the pane.
   * The desk takes the grid back the moment somebody types there. Answered
   * `{ kind: 'ok' }`; a pane that has gone is `{ kind: 'failed' }`.
   */
  | { kind: 'claim'; sessionId: string }
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
  /**
   * One folder on the desktop's disk, so a browser can find a project to add.
   *
   * Answered with `WebFolder`, or with `{ kind: 'failed' }` carrying a sentence
   * — a path that is not absolute, a folder that has gone, a folder this
   * account may not read. None of those is exceptional enough to throw over,
   * and all of them are things a person navigating with the mouse will do.
   *
   * `path` is '' for the drive roots and otherwise a path *this desktop
   * handed over*: `WebFolder.path`, or one of its `crumbs`. `name` is one entry
   * from the folder just listed, which the desktop appends itself — the browser
   * never joins two strings and calls the result a Windows path. A `name` that
   * is not a single plain segment is refused rather than resolved, so `..` is
   * not a way of walking anywhere the sender could not have named outright
   * (which, being past the token, it could have).
   *
   * How many entries one answer carries is capped by the desktop and not by
   * this type, the same arrangement `agents` has: the number is MAX_FS_ENTRIES
   * in electron/web/fs-browse.ts, beside the code that does the reading.
   */
  | { kind: 'fs-list'; path: string; name?: string }
  /**
   * Add a folder to the project rail — the browser's half of "Add project".
   *
   * `path` is a folder this desktop named in an `fs-list` answer, and the
   * desktop checks again that it exists and is a directory before doing
   * anything with it: the folder may have been renamed between the listing and
   * the click, and "the browser was told so a moment ago" is not a fact about
   * the disk now.
   *
   * Performed by the desktop *renderer*, through the same `addProjectPath` the
   * button at the desk reaches, for decision 5's reason — the renderer owns the
   * project list and persists it, and a browser must not be able to reach a
   * code path a local click cannot. Answered `{ kind: 'ok' }`.
   */
  | { kind: 'project-add'; path: string }
  /**
   * Make a brand-new project folder from a name — the browser's half of the
   * desktop's "New project" form, and deliberately *not* a third way of naming
   * a path. `name` is a leaf the desktop sanitises, and `parentDir` is a key
   * from a closed allow-list (`desktop`, `documents`, `projectsroot`), never a
   * folder: the same fence the desk's own form and the voice agent's
   * `create_project` go through (electron/projectfolder.ts), so a browser
   * cannot ask for a folder anywhere those two could not already put one.
   *
   * Answered `{ kind: 'ok' }` once the folder exists *and* is on the rail —
   * creation and adding are one act here, because a folder made and then not
   * added is exactly the half-done state nobody at the desk would be around to
   * notice. A name that already exists in that parent is answered with
   * `project-exists` rather than adopted silently, carrying the path so the
   * browser can offer "open it instead" as its own explicit act.
   */
  | { kind: 'project-create'; name: string; parentDir?: string }
  /**
   * An image pasted (or picked) in the browser, saved on this desktop and
   * typed as a quoted path into a pane — the same gesture as dropping a
   * screenshot on an agent at the desk.
   *
   * `data` is raw base64, not a data URL, capped at MAX_IMAGE_BASE64 so the
   * whole frame fits inside MAX_FRAME_BYTES. `mime` is one of WEB_IMAGE_MIMES.
   * The page shrinks a phone photo to fit before sending; anything still too
   * large is refused here with `limit` rather than hanging up the socket.
   *
   * Answered `{ kind: 'ok' }` once the path has been typed. A pane that has
   * gone is `unknown-session`. Bytes never travel back: the agent reads the
   * file off this disk, the way it already does for a dropped shot.
   */
  | { kind: 'paste-image'; sessionId: string; mime: string; data: string }
  /**
   * A chunk of a file uploaded from the browser (e.g. PDF, doc, source code, data).
   * Files are sent in chunks up to MAX_FILE_CHUNK_BYTES so any file up to
   * MAX_FILE_BYTES fits across MAX_FRAME_BYTES without WebSocket payload errors.
   *
   * On the final chunk (index === totalChunks - 1), the desktop reassembles the file,
   * saves it to the web-inbox folder, and types the quoted path into the pane.
   */
  | {
      kind: 'upload-file'
      uploadId: string
      sessionId: string
      name: string
      mime?: string
      index: number
      totalChunks: number
      data: string
    }
  /**
   * A chunk of speech recorded on the browser's microphone, for the desktop
   * to turn into words. The phone is miles from the desk, so the CLI's own
   * dictation (which hears the desktop's microphone) cannot help; the
   * browser records with MediaRecorder (`mime` is whatever it produced —
   * `audio/webm;codecs=opus` on Chrome, `audio/mp4` on Safari) and the
   * desktop asks its speech-to-text provider, the same key the voice agent
   * uses, sent to that provider and nowhere else.
   *
   * Chunked exactly as `upload-file` is, for the same MAX_FRAME_BYTES reason.
   * On the final chunk the desktop transcribes and answers `dictation`; the
   * browser then types the words into the pane itself, so what was heard is
   * seen before it is sent and the pane's typing path is the one path.
   */
  | {
      kind: 'dictate'
      uploadId: string
      sessionId: string
      mime: string
      index: number
      totalChunks: number
      data: string
    }
  /**
   * The same recording, streamed while it is still being made — only when
   * `hello-ok.features` carries WEB_FEATURE_DICTATE_STREAM.
   *
   * `start` names the pane and the recorder's mime once. Each `append` is one
   * MediaRecorder slice, base64, at most MAX_FILE_CHUNK_BYTES raw, numbered
   * from 0 by `seq`; they may arrive out of order, and an `append` repeated
   * with the same `seq` replaces the earlier one. `done` says how many slices
   * there were (`chunks`, so seqs 0..chunks-1), and the desktop assembles them
   * in order, transcribes once, and answers `dictation`. `cancel` throws the
   * lot away.
   *
   * `start`, `append` and `cancel` are answered `{ kind: 'ok' }`. Over
   * MAX_DICTATION_BYTES in total is `limit` and drops the recording; a missing
   * slice at `done` is `bad-frame` and drops it; an `append` or `done` for an
   * id the desktop does not hold (never started, cancelled, finished, or idle
   * past DICTATION_STREAM_IDLE_MS) is `failed`.
   */
  | { kind: 'dictate-stream'; op: 'start'; dictationId: string; sessionId: string; mime: string }
  | { kind: 'dictate-stream'; op: 'append'; dictationId: string; seq: number; data: string }
  | { kind: 'dictate-stream'; op: 'done'; dictationId: string; chunks: number }
  | { kind: 'dictate-stream'; op: 'cancel'; dictationId: string }
  /**
   * One folder inside a project, read-only — only when `hello-ok.features`
   * carries WEB_FEATURE_FILES.
   *
   * `path` is relative to the project's folder, `/`-separated, '' (or absent)
   * for the folder itself. It is never absolute and never climbs: an absolute
   * path, a `..` segment, and anything whose real path (symlinks and junctions
   * resolved) lands outside the project's folder are refused `failed` with a
   * sentence. An unknown `projectId` is `unknown-project`. Answered
   * `project-files`: folders first, then files, case-insensitively by name,
   * cut at the desktop's cap with `truncated` set. An entry that is a link
   * pointing outside the project is left out of the list.
   */
  | { kind: 'project-files'; projectId: string; path?: string }
  /**
   * One text file inside a project, read-only — the same feature flag and the
   * same confinement as `project-files`. Answered `project-file` with the
   * first MAX_PROJECT_FILE_BYTES as UTF-8 and `truncated` when there was more;
   * a binary file is refused `failed` with a sentence.
   *
   * `git: true` means `path` is a changed file exactly as the git status list
   * printed it (`GitFileChange.path`, relative to the repository root, which
   * may sit above the project's folder). The desktop maps it onto the disk
   * itself, and the file must still resolve inside the project's folder.
   */
  | { kind: 'project-file'; projectId: string; path: string; git?: boolean }
  /**
   * What removing a project would close — only when `hello-ok.features`
   * carries WEB_FEATURE_PROJECT_REMOVE. Read-only; answered
   * `project-remove-preview` so the page can say "3 open panes will close"
   * before Steve confirms. An unknown `projectId` is `unknown-project`.
   */
  | { kind: 'project-remove-preview'; projectId: string }
  /**
   * Take a project off the rail — the browser's "Remove project…", under the
   * same feature flag. Performed by the desktop renderer through
   * `removeProject`, the function the rail's own menu item reaches: it closes
   * the project's panes (its tabs' panes and its planner pane) and forgets its
   * layout. The folder on disk is never touched.
   *
   * Answered `{ kind: 'ok' }`, after which a `projects` frame without it
   * follows. An unknown `projectId` is `unknown-project`; a desktop with no
   * window to perform it (or one that did not answer in time) is `no-window`.
   */
  | { kind: 'project-remove'; projectId: string }
  /**
   * "Notify this browser when a pane needs me." The subscription is the object
   * `PushSubscription.toJSON()` returns; the desktop stores it beside its VAPID
   * keys and posts to `endpoint` on the next attention transition that no
   * visible browser is already looking at. `deviceName` labels it in the
   * desktop's device list. Answered `{ kind: 'ok' }`. Re-sending the same
   * endpoint replaces the record rather than duplicating it.
   */
  | { kind: 'push-subscribe'; subscription: WebPushSubscription; deviceName?: string }
  /** Forget a subscription. Answered `{ kind: 'ok' }` whether or not it was known. */
  | { kind: 'push-unsubscribe'; endpoint: string }
  /**
   * "I am (not) on screen." Sent on every `visibilitychange` once authenticated,
   * so the desktop can skip the push when somebody is already watching a live
   * page. A socket that never says is treated as not visible. Answered
   * `{ kind: 'ok' }`.
   */
  | { kind: 'visibility'; visible: boolean }
  /**
   * "Read me this pane's conversation, not its screen."
   *
   * `sessionId` is the **pane** id, the same one `attach` names, because that
   * is the only id a browser has: which Claude session a pane owns, and where
   * on this disk its transcript is filed, are facts about the desktop's own
   * layout and its `~/.claude`, and neither has ever been on this wire. The
   * desktop resolves the pane to a file and tails it; see
   * electron/web/transcript-watcher.ts.
   *
   * Answered `{ kind: 'ok' }`, after which `transcript` frames arrive for that
   * pane — the first of them a `reset` carrying everything already parsed.
   * A pane with no transcript to read (not a Claude pane, or one that has
   * never spoken) is `{ kind: 'failed', code: 'failed' }` with a sentence, and
   * a pane that has gone is `unknown-session`; a desktop too old to do this at
   * all answers `unsupported`, like every other optional request here.
   *
   * Independent of `attach`, deliberately: reading the conversation and
   * reading the terminal are two views of one pane and a client may want
   * either, both, or one after the other. Watching a pane twice is not an
   * error — the second ask is answered `ok` and changes nothing.
   */
  | { kind: 'transcript-watch'; sessionId: string }
  /**
   * Stop reading it. Answered `{ kind: 'ok' }` whether or not this browser was
   * watching, the same courtesy `push-unsubscribe` extends: a client tidying up
   * should not have to know what the desktop believes.
   *
   * Not the only way a watch ends. Detaching from the pane, the pane exiting,
   * and the socket closing all end it too, because each of them is a browser
   * that has stopped reading — and a tail left running on a `~/.claude` file
   * for a tab that closed is a watch nobody will ever stop.
   */
  | { kind: 'transcript-stop'; sessionId: string }
  /**
   * Switch Foreman on for a pane — the browser's half of the toggle in a pane
   * header, and the same act the desktop's switch performs.
   *
   * `paneId` is the PTY session id, exactly as `attach` names it. `seed` is
   * Steve's one line, capped to FOREMAN_SEED_MAX at the boundary; it may be
   * empty, which means "take over the session this pane is already holding"
   * and is only meaningful for a pane that has one.
   *
   * Answered `{ kind: 'ok' }` — the state itself arrives as a `foreman` frame
   * to every connected browser, this one included, so there is nothing for the
   * result to carry. Performed by *main*, not forwarded to the renderer: the
   * Foreman host and its loop live in the main process, and this is the one
   * request a browser sends that the desktop's own window never handles.
   */
  | { kind: 'foreman-start'; paneId: string; seed: string }
  /**
   * Switch it off. The keyboard goes straight back to the human, on every
   * surface at once. Answered `{ kind: 'ok' }`; the `foreman` frame that
   * follows says `off`.
   */
  | { kind: 'foreman-stop'; paneId: string }
  /**
   * A word in Foreman's ear while it drives: goes to Foreman's session as its
   * next turn, never into the pane as keystrokes. Answered `{ kind: 'ok' }`;
   * a pane nobody is driving answers `failed` so the browser can offer a start
   * instead. Capped at FOREMAN_SEED_MAX like a seed.
   */
  | { kind: 'foreman-say'; paneId: string; text: string }
  /**
   * Hand one pane's work to another agent — the browser's half of the Handoff
   * menu in a pane header, and the same act the desktop's own menu performs.
   *
   * The one request on this link that is neither performed in main nor a layout
   * op: it is forwarded to the desktop's renderer, because the flow it starts
   * (write the pack, ask this pane's agent to fill it, watch the file, paste the
   * take-over prompt into the target) lives there in one piece and a second copy
   * of it in main would be a second thing to be wrong about what a handoff is.
   *
   * `paneId` is the pane doing the handing off, exactly as `attach` names it.
   * `target` is one of the three kinds in `HandoffTargetWire`; anything else is
   * `bad-frame`. Answered `{ kind: 'ok' }` once the pack is written and the ask
   * is in the source pane — not once the handoff completes, which is minutes
   * later and arrives as `handoff` frames.
   */
  | { kind: 'handoff-start'; paneId: string; target: HandoffTargetWire }
  /**
   * The desktop's main voice agent, run in a desktop browser (the deck face).
   *
   * The audio never passes through the desktop: the browser opens the
   * provider's socket itself, exactly as the Electron renderer does. What the
   * desktop supplies is everything that makes it the SAME agent — the persona,
   * the tool list, the app context — built by the renderer with the functions
   * the voice hub uses, and a single-use ephemeral token minted in main. The
   * raw key never leaves main.
   *
   * `voice-setup` is answered `{ kind: 'voice-setup' }`; `carryover` is the
   * short account of a session that is being rolled over, or absent. Gemini
   * Live, GPT Realtime and Claude are built (Claude's setup carries no persona
   * or tools — its session lives on the desktop; see `voice-claude`).
   * `voice-token` (Gemini Live only) is answered `{ kind: 'voice-token' }` —
   * one token per connect, since a resume after `goAway` needs a fresh one.
   * `voice-connect` (GPT Realtime only) carries the browser's WebRTC SDP
   * offer; main mints a client secret with the stored key, posts the offer
   * with it (electron/realtime/tokens.ts's `connectOpenAI`) and answers
   * `{ kind: 'voice-connect' }` with OpenAI's SDP answer — neither the key nor
   * the secret reaches the browser. The model comes from `provider`, never
   * from the browser.
   * `voice-tool` runs one tool call through the renderer's `runRealtimeTool`,
   * and is answered `{ kind: 'voice-tool' }` even when the tool failed (a
   * failure is an answer the model says out loud).
   * `voice-context` is answered `{ kind: 'voice-context' }` with the app
   * context as it is now; the browser polls it and sends only changes.
   *
   * A desktop that predates these answers `unsupported` ("does not
   * understand"), and the browser says to update the desktop app.
   */
  | { kind: 'voice-setup'; provider: WebVoiceProvider; carryover?: string }
  | { kind: 'voice-token'; provider: WebVoiceProvider }
  | ({ kind: 'voice-connect' } & WebVoiceConnectRequest)
  | { kind: 'voice-tool'; name: string; args: Record<string, unknown> }
  | { kind: 'voice-context' }
  /**
   * Claude as a browser's voice agent. Not a realtime audio session: the
   * browser hears (its own end-of-speech detection), the desktop transcribes
   * and thinks (the same `transcribeAudio` dictation uses, and a Claude Agent
   * SDK session of its own — electron/voice-agent/ipc.ts's
   * `openWebVoiceAgent`, never the desk's voice bar's), and the browser speaks
   * the reply with audio the desktop's Edge voice made. Tools run on the
   * desktop, as they do for the desk's Claude.
   *
   *   open       this socket owns the browser Claude session from now (one
   *              browser at a time: another browser's `open` closes this one
   *              with a `closed` event). Answered `ok`.
   *   append     one slice of a turn's audio: raw PCM, 16-bit little-endian,
   *              16 kHz mono, base64, at most MAX_FILE_CHUNK_BYTES raw. `seq`
   *              from 0; a new `turnId` drops any turn not yet `done`.
   *              Answered `ok`.
   *   done       the turn ended (`chunks` slices). The desktop transcribes it
   *              and answers `{ kind: 'voice-heard' }` — it does NOT send the
   *              words to Claude, so the browser can end on a stop phrase or
   *              drop its own echo first.
   *   cancel     drop the turn. Answered `ok`.
   *   say        one turn to Claude (the desktop adds the app context when it
   *              changed). Answered `ok`; the reply arrives through `events`.
   *   events     held until there is something to say, or up to
   *              VOICE_CLAUDE_POLL_MS; answered `{ kind: 'voice-claude-events' }`.
   *   speak      one sentence of the reply as the desktop's Edge voice, MP3;
   *              answered `{ kind: 'voice-speech' }`.
   *   interrupt  barge-in: stop the turn, keep the conversation. Answered `ok`.
   *   close      end the session. Answered `ok`, also when there was none.
   *
   * Every op but `open` and `close` on a socket that holds no session is
   * `failed`. The socket closing closes the session.
   */
  | { kind: 'voice-claude'; op: 'open' }
  | { kind: 'voice-claude'; op: 'append'; turnId: string; seq: number; data: string }
  | { kind: 'voice-claude'; op: 'done'; turnId: string; chunks: number }
  | { kind: 'voice-claude'; op: 'cancel'; turnId: string }
  | { kind: 'voice-claude'; op: 'say'; text: string }
  | { kind: 'voice-claude'; op: 'events' }
  | { kind: 'voice-claude'; op: 'speak'; text: string }
  | { kind: 'voice-claude'; op: 'interrupt' }
  | { kind: 'voice-claude'; op: 'close' }
  /**
   * Begin enrolling this browser's passkey. Only on a socket that opened with
   * the PIN (or a passkey) on a desktop that still has that same PIN set; any
   * other socket is answered `failed` with code `unsupported`. Answered
   * `{ kind: 'passkey-options' }`: hand `options` to
   * `navigator.credentials.create`, then send `passkey-register-finish`
   * within `options.timeout`.
   */
  | { kind: 'passkey-register-begin' }
  /**
   * The `AuthenticatorAttestationResponse`, base64url. `deviceName` labels
   * the row. Answered `{ kind: 'passkeys' }` with the new list, or `failed`.
   */
  | { kind: 'passkey-register-finish'; clientDataJSON: string; attestationObject: string; deviceName?: string }
  /** This account's passkeys, and whether this socket may enrol another. Answered `{ kind: 'passkeys' }`. */
  | { kind: 'passkey-list' }
  /**
   * Forget one passkey; it stops unlocking at once. Same socket rule as
   * `passkey-register-begin`. Answered `{ kind: 'passkeys' }` with what is
   * left, whether or not the id was known.
   */
  | { kind: 'passkey-forget'; credentialId: string }

/**
 * What `PushSubscription.toJSON()` yields, narrowed to the fields the desktop
 * needs to encrypt a payload for it. Endpoints are `https:` URLs at the
 * browser vendor's push service; the two keys are base64url.
 */
export interface WebPushSubscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

/** The body of a push message the desktop sends; the service worker shows it. */
export interface WebPushPayload {
  kind: 'attention'
  sessionId: string
  /** 'asking' — a question is waiting; 'done' — the pane went quiet with no question. */
  state: 'asking' | 'done'
  /** Pane title, for the notification heading. */
  title: string
  /** The extracted question line, when asking. */
  prompt?: string
  desktopName: string
}

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
  /**
   * The folder nominated in Settings as where new projects go, when there is
   * one. Display and defaulting only — the browser's "New project" form shows
   * it as a choice and picks it first, exactly as the desk's form does — and
   * never sent back: `project-create` names parents by allow-list *key*, so
   * this string stays something to draw, not something to say. Optional field,
   * added without a WEB_PROTO bump on the rule at the top of this file.
   */
  projectsRoot?: string
  /**
   * The desktop's VAPID public key (base64url), when it can send Web Push.
   * The browser hands it to `pushManager.subscribe` and sends the resulting
   * subscription back with `push-subscribe`. Absent when push is off on the
   * desktop — the client then shows no bell. See `WebPushSubscription`.
   */
  pushKey?: string
  /**
   * Every pane Foreman is holding state for, driven or finished, as it stands
   * right now. The snapshot half of the `foreman` push: a browser that
   * reconnects mid-job learns the switch is on from here rather than waiting
   * for the next state change to arrive. Absent from an older desktop, which
   * a client reads as "no panes are driven" — the same answer an empty array
   * gives, and the only safe one.
   */
  foreman?: ForemanState[]
  /**
   * Every project's handoff packs as they stand right now, project by project.
   *
   * The snapshot half of the `handoff` push, and it covers every project on the
   * rail rather than the one the desk happens to be looking at: the desktop
   * watches one project's folder at a time (electron/handoff-watcher.ts), but a
   * browser may be reading any of them, and a client that saw chips only for the
   * desk's current project would be a client whose Handoff menu emptied because
   * somebody at the desk clicked elsewhere.
   *
   * An empty `records` is a real answer — that project has no packs. Absent from
   * an older desktop, which a client reads as "no handoffs anywhere", the only
   * safe reading.
   */
  handoff?: { projectId: string; records: HandoffRecord[] }[]
  /**
   * Optional capabilities this desktop has, by name — WEB_FEATURE_PASSKEY,
   * WEB_FEATURE_DICTATE_STREAM, WEB_FEATURE_FILES, WEB_FEATURE_PROJECT_REMOVE,
   * WEB_FEATURE_USAGE. A page uses a feature only when its name is here; absent (an older
   * desktop) means none.
   */
  features?: string[]
  /**
   * A fresh single-use ticket this page may present as `WebHelloFrame.resume`
   * on its next `hello`, instead of asking for the fingerprint again — see
   * PASSKEY_RESUME_MS. Sent only to a socket that was admitted by a passkey or
   * by a ticket; absent after a PIN unlock, with no PIN set, and from an older
   * desktop. The ticket itself is the announcement, so no features entry.
   * Held in RAM only. Optional field, added without a WEB_PROTO bump on the
   * rule at the top of this file.
   */
  resume?: string
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
   * This browser did not identify itself — `hello` carried a blank `deviceId`,
   * which is a page whose storage was unavailable rather than a browser
   * anybody has judged. Recovery is a reload, which mints one.
   *
   * The name is a fossil and is kept deliberately rather than churned: it is on
   * the wire, and the deployed bundle at `https://forge-web…web.app` knows this
   * word. It used to mean "no prompt can be raised for you right now", back
   * when an unknown browser had to be allowed by a human at the desk, and then
   * "you are not on the desktop's list". There is no prompt and no list any
   * more — a browser holding a verified token for the configured uid and the
   * desktop's PIN is admitted, from anywhere, whether or not this desktop has
   * ever seen it. All that is left of the old meaning is the one fact the
   * desktop genuinely cannot check without an id: which browser it is talking
   * to for the length of the socket.
   */
  'not-approved',
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
   * This desktop has an unlock PIN set and this browser has not presented one.
   * Nothing has gone wrong: the recovery is to show a PIN box and send the
   * `hello` again with `pin` filled in.
   *
   * Deliberately not counted as a failed attempt by the desktop's lockout — it
   * is the first half of every ordinary sign-in, and a door that struck for it
   * would lock somebody out on their fifth login.
   */
  'pin-required',
  /**
   * A PIN was presented and did not open the door. One value and one sentence
   * for every cause, because telling "wrong" apart from "not a PIN at all" out
   * loud tells somebody guessing which half of their guess was right. This one
   * *does* count against the lockout, which is the whole defence of a secret
   * only four digits long.
   */
  'pin-invalid'
] as const

export type WebRefusal = (typeof WEB_REFUSALS)[number]

export interface WebRefusedFrame {
  type: 'refused'
  reason: WebRefusal
  /** One sentence, written for the person reading the browser tab. */
  message: string
  /** `busy` only: roughly how long before asking again is worth it. */
  retryAfterMs?: number
  /**
   * `pin-required` only, and only when this account has passkeys enrolled
   * under the current PIN: hand these to `navigator.credentials.get` and send
   * the next `hello` with `passkey` instead of `pin`. A cancelled biometric
   * sends nothing and falls back to the PIN box. The challenge is single-use
   * and dies after `timeout`.
   */
  passkey?: WebPasskeyRequestOptions
  /**
   * `proto` only: the desktop's Forge version and the protocol it speaks, so
   * the page can say which side is old — a desktop `proto` below the page's
   * means "restart Forge on the desktop", above it means "reload this page".
   * Absent from an older desktop.
   */
  appVersion?: string
  proto?: number
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

/**
 * One agent pane's usage: how full its context window is, and how much of the
 * account's 5-hour and weekly limits are gone.
 *
 * Read off disk rather than off the screen. The terminal footer prints the
 * same numbers, but a phone owns a narrow grid and Claude Code truncates its
 * status line to fit — so the desktop reads what Claude Code hands its
 * statusLine command instead (electron/web/agent-usage.ts says how).
 *
 * Broadcast when a pane's numbers change, at most once per pane per two
 * seconds, and to hidden tabs too, like `foreman`. The latest per live pane is
 * said again after every `hello-ok`, like `attention`, so a phone back from the
 * lock screen draws a true ring at once. Announced as WEB_FEATURE_USAGE.
 *
 * `limits` belong to the account, not the pane: every Claude pane carries the
 * same newest pair. Either half may be absent — a pane that has not drawn its
 * status line yet has no context, and an API-key session has no limits.
 */
export interface WebUsageFrame {
  type: 'usage'
  /** The pane id. */
  sessionId: string
  context?: { usedPct: number; usedTokens?: number; windowTokens?: number }
  limits?: {
    /** `resetsAt` is epoch seconds, as Claude Code reports it. */
    fiveHour?: { usedPct: number; resetsAt?: number }
    week?: { usedPct: number; resetsAt?: number }
  }
  source: 'claude-statusline' | 'codex-session'
  /** When these numbers were true, epoch ms. */
  at: number
}

/**
 * One pane's Foreman state moved — the whole `ForemanState`, every time, for
 * the same reason `sessions` is the whole list: a diff the receiver has to
 * reassemble is a diff that can be missed, and a missed one is a switch that
 * says "on" about a pane nobody is driving.
 *
 * Broadcast, not addressed: Foreman is per-pane but its consequences are not.
 * A browser that did not switch it on still wants the footer — the pane it is
 * reading is being driven from somewhere, and a surface that hid that would be
 * showing a terminal somebody else is typing into as though it were quiet.
 *
 * Sent to hidden tabs as well as visible ones, like `transcript` and unlike
 * `data`: a handful of small objects is nothing an xterm has to parse, and a
 * phone coming back from the lock screen should read a footer that is true.
 */
export interface WebForemanFrame {
  type: 'foreman'
  state: ForemanState
}

/**
 * "The desktop's window is being rebuilt. Your taps land in a moment."
 *
 * The one frame on this wire that is about the *desktop* rather than about
 * anything on it, and it exists because of what a browser cannot see. Every
 * command this tab sends — switch tab, close pane, open a split — is executed
 * by the desktop's renderer, and terminal output is not: that comes straight
 * from the main process. So when the renderer dies or hangs, the socket stays
 * up, the panes keep scrolling, and every button silently stops working. It
 * looks exactly like a bug in this page.
 *
 * `recovering` is sent the moment the watchdog decides to reload, `ready` on
 * the first healthy heartbeat after it — see electron/renderer-watchdog.ts.
 * `reason` is for the log and the tooltip, never for a decision; a client shows
 * the same band whatever it says.
 *
 * Broadcast to every authenticated browser, hidden tabs included, for the same
 * reason `foreman` is: it is one small object, and a tab coming back from the
 * lock screen should read a banner that is true.
 */
/**
 * One project's handoff packs changed — the whole list for that project, every
 * time, for the same reason `sessions` is the whole list: a delta the receiver
 * reassembles is a delta that can be missed, and a project has a handful of
 * packs, not thousands.
 *
 * Broadcast rather than addressed, and sent to hidden tabs as well as visible
 * ones, exactly as `foreman` is: a handoff is started on one surface and its
 * chip belongs on all of them, and a phone coming back from the lock screen
 * should read a header that is true.
 */
export interface WebHandoffFrame {
  type: 'handoff'
  projectId: string
  records: HandoffRecord[]
}

export interface WebDesktopFrame {
  type: 'desktop'
  state: 'recovering' | 'ready'
  reason?: string
}

/**
 * "Windows is asking for admin, and nobody is at the desk."
 *
 * The browser's copy of the phone's `RemoteYesFrame` — the same four fields,
 * because it is the same fact: the PC's UAC prompt is on the secure desktop,
 * where nothing this link carries can press it, and the one thing that can is
 * RustDesk, opened by a finger on the phone. Steve's phone is more often a
 * Chrome tab than the APK, so the tab is told too.
 *
 * Remembered by the server and replayed after every `hello-ok`, for the reason
 * shared/mobile.ts gives: the prompt drops whatever was watching the screen,
 * so the browser that has to answer is very often reconnecting as it is told.
 */
export interface WebRemoteYesFrame extends RemoteYesInfo {
  type: 'remote-yes'
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
 *
 * This used to be the one place the protocol carried desktop paths, and the
 * note here said they travel *down* only. They no longer do: `fs-list` and
 * `project-add` send paths back up, and the paragraph on `WebRequest` sets out
 * why that costs nothing this protocol was ever protecting. What is still true,
 * and is the part worth keeping, is that **git** is never told a path — a
 * `git-action` carries a project id and the desktop resolves the folder itself,
 * so no frame can point this machine's git at somewhere it was not already
 * watching.
 */
export interface WebGitFrame {
  type: 'git'
  snapshot: GitSnapshot
}

/**
 * A Claude pane's conversation, as something to read rather than to watch
 * being typed.
 *
 * The counterpart to `replay`/`data`, and the whole of what `transcript-watch`
 * buys: those two carry the *screen* — escape codes, redraws, a TUI's frame —
 * and this carries what was said. The desktop tails the session's JSONL and
 * distils it (electron/web/transcript-watcher.ts); the browser renders it as a
 * chat.
 *
 * Sent only to the sockets that asked for this pane, never broadcast: a
 * conversation is the most private thing on this link and a tab that did not
 * ask for one has no business receiving it. `ChatUpdate` says how the two
 * kinds of frame relate — a `reset` replaces what the client holds, an append
 * adds to it, and a turn whose `id` the client already has is that same turn
 * said again (a tool's result arriving after its call), not a second one.
 *
 * Unlike `data`, this is sent to a hidden tab as well as a visible one. The
 * reason `pushData` withholds bytes is xterm's parser, which a background tab
 * stops draining until it throws; a handful of small JSON objects is not that,
 * and withholding them would leave a phone that came back from the lock screen
 * reading a conversation that stopped mid-sentence.
 */
export interface WebTranscriptFrame {
  type: 'transcript'
  /** The pane, exactly as `transcript-watch` named it. */
  sessionId: string
  update: ChatUpdate
}

/** The answer to a `request`, correlated by `rid`. */
export interface WebResultFrame {
  type: 'result'
  rid: string
  body: WebResult
}

export type WebResult =
  /**
   * It worked and there is nothing to say — a layout op, an `auth` refresh.
   *
   * `sessions` rides on the answer to `visibility` only: the ids the desktop
   * is actually streaming to this socket. The one list the client cannot see
   * for itself, said back on the beat it already pays for, so a subscription
   * the desktop never registered — an eaten attach, a refused frame, an older
   * build — is noticed and re-asked within a beat instead of never. Absent
   * from every other answer, and from desktops that predate it, which a
   * client must treat as "no news" rather than "no sessions".
   */
  | { kind: 'ok'; sessions?: string[] }
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
   * One folder of the desktop's disk — the answer to `fs-list`. Named after
   * what it carries rather than after the request, exactly as `git-status` is
   * answered with `git`.
   */
  | { kind: 'folder'; folder: WebFolder }
  /** The words the desktop heard in a `dictate` recording — empty when it heard nothing. */
  | { kind: 'dictation'; text: string }
  /** One folder inside a project — the answer to `project-files`. `path` is the folder as listed, '' for the top. */
  | { kind: 'project-files'; projectId: string; path: string; entries: WebProjectEntry[]; truncated: boolean }
  /**
   * One text file inside a project — the answer to `project-file`. `path` is
   * relative to the project's folder, `/`-separated (a `git: true` ask is
   * answered with the project-relative spelling). `size` is the whole file's
   * size on disk; `content` stops short of it when `truncated`.
   */
  | {
      kind: 'project-file'
      projectId: string
      path: string
      content: string
      size: number
      mtime: number
      truncated: boolean
    }
  /**
   * `project-create` asked for a name that is already a folder in that parent.
   *
   * Its own result rather than a `failed`, because it is not a dead end: the
   * desktop refuses to adopt an existing folder *silently* (the same rule the
   * desk's form and the voice agent live under), but opening it is one explicit
   * click away, and that click needs the path — which is a path this desktop
   * composed, exactly as `fs-list`'s are. `message` is the sentence to show
   * beside the offer.
   */
  | { kind: 'project-exists'; path: string; message: string }
  /**
   * The answer to `project-remove-preview`. `panes` is how many panes are
   * running in that project right now and would close with it — its tabs'
   * panes plus its planner pane, counting only the live ones. `name` is the
   * project's name as the rail shows it.
   */
  | { kind: 'project-remove-preview'; projectId: string; name: string; panes: number }
  /** The answer to `passkey-register-begin`: what to hand `navigator.credentials.create`. */
  | { kind: 'passkey-options'; options: WebPasskeyCreationOptions }
  /**
   * The answer to `passkey-list`, `passkey-register-finish` and
   * `passkey-forget`: this account's passkeys, and whether this socket may
   * enrol or forget one (it opened with the PIN or a passkey, and that PIN is
   * still the one set).
   */
  | { kind: 'passkeys'; passkeys: WebPasskeyInfo[]; canRegister: boolean }
  /** The answer to `voice-setup`. */
  | { kind: 'voice-setup'; setup: WebVoiceSetup }
  /** The answer to `voice-token`: single-use, for one connect. Never the key. */
  | { kind: 'voice-token'; token: string; expiresAt: number }
  /** The answer to `voice-connect`: OpenAI's SDP answer. Never the key or the client secret. */
  | { kind: 'voice-connect'; sdp: string; expiresAt: number | null }
  /** The answer to `voice-tool`. */
  | { kind: 'voice-tool'; answer: WebVoiceToolAnswer }
  /** The answer to `voice-context`. Empty when the desktop has nothing to say yet. */
  | { kind: 'voice-context'; text: string }
  /** The answer to `voice-claude` `done`: what was heard ('' for nothing). */
  | { kind: 'voice-heard'; text: string }
  /**
   * The answer to `voice-claude` `events`: everything since the last answer,
   * in order (empty when the wait ran out). `open` false: this socket holds no
   * session any more.
   */
  | { kind: 'voice-claude-events'; events: WebVoiceClaudeEvent[]; open: boolean }
  /** The answer to `voice-claude` `speak`: one sentence, base64. */
  | { kind: 'voice-speech'; audio: string; mime: string }

/* ------------------------------------------------------ the voice agent
 *
 * See `voice-setup` in `WebRequest`. Gemini Live and GPT Realtime run in a
 * browser; Claude is heard in the browser and runs on the desktop
 * (`voice-claude`). A desktop that predates Claude answers `unsupported`.
 */

/**
 * What the browser Claude session says, in order: the voice brain's own
 * events (shared/types.ts `VoiceAgentEvent`), plus `closed` when the session
 * ended under the browser (another browser took it, or the desktop let go).
 */
export type WebVoiceClaudeEvent = VoiceAgentEvent | { type: 'closed'; reason: string }

/**
 * How long a `voice-claude` `events` request is held open with nothing to
 * say. Under the browser's 30 s request deadline, with room for the tunnel.
 */
export const VOICE_CLAUDE_POLL_MS = 20_000

export type WebVoiceProvider = 'gemini-live' | 'gpt-realtime' | 'gpt-realtime-mini' | 'claude'

/** The providers whose connect is a WebRTC SDP exchange (`voice-connect`). */
export type WebVoiceOpenAIProvider = 'gpt-realtime' | 'gpt-realtime-mini'

export function isWebVoiceOpenAIProvider(value: unknown): value is WebVoiceOpenAIProvider {
  return value === 'gpt-realtime' || value === 'gpt-realtime-mini'
}

/**
 * `voice-connect`'s body: the browser's SDP offer, and the session it is for —
 * the voice, persona and tools `voice-setup` handed it, sent back because the
 * OpenAI session is configured on the client secret main mints for this one
 * connect. The model is `provider`'s, looked up in main.
 */
export interface WebVoiceConnectRequest {
  provider: WebVoiceOpenAIProvider
  voice: string
  instructions: string
  tools: WebVoiceToolSpec[]
  sdp: string
}

/** A tool the voice model may call — shared/realtime.ts's `RealtimeToolSpec`, restated for the wire. */
export interface WebVoiceToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Everything a browser needs to run the desktop's voice agent, bar the token. */
export interface WebVoiceSetup {
  provider: WebVoiceProvider
  model: string
  voice: string
  instructions: string
  tools: WebVoiceToolSpec[]
  /** The app context at this moment ('' when the agent's deps are not up yet). */
  context: string
  /** Send a changed context at most this often (src/lib/realtime/context.ts). */
  contextMinGapMs: number
  /** The conversation closes after this long listening to quiet (`agentIdleTimeoutMs`). */
  idleTimeoutMs: number
}

/** src/lib/realtime/session.ts's `RealtimeToolAnswer`, restated for the wire. */
export interface WebVoiceToolAnswer {
  ok: boolean
  text: string
  image?: { mime: string; base64: string }
}

/**
 * Main asking the renderer for its half of a voice request, over
 * `IPC.webVoiceAsk`; answered on `IPC.webVoiceResult` with a
 * `WebVoiceAskReply` carrying the same `requestId`. An IPC event rather than a
 * wire frame, declared here beside the requests it serves.
 */
export type WebVoiceAskEvent =
  | { requestId: string; op: 'setup'; provider: WebVoiceProvider; carryover: string | null }
  | { requestId: string; op: 'tool'; name: string; args: Record<string, unknown> }
  | { requestId: string; op: 'context' }

/** The renderer's answer. `error` set means it could not; otherwise the op's field is filled. */
export interface WebVoiceAskReply {
  requestId: string
  error?: string
  setup?: WebVoiceSetup
  answer?: WebVoiceToolAnswer
  context?: string
}

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
  /** Over MAX_INPUT_PER_SECOND, MAX_WRITE_CHARS, or MAX_IMAGE_BASE64. Slow down. */
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
  | WebRefusedFrame
  | WebReplayFrame
  | WebDataFrame
  | WebExitFrame
  | WebSessionsFrame
  | WebSessionStartedFrame
  | WebAttentionFrame
  | WebUsageFrame
  | WebForemanFrame
  | WebHandoffFrame
  | WebDesktopFrame
  | WebRemoteYesFrame
  | WebProjectsFrame
  | WebWorkspaceFrame
  | WebGitFrame
  | WebTranscriptFrame
  | WebResultFrame
  | WebShutdownFrame
  | WebErrorFrame
  | WebPongFrame
  | WebMirrorOkFrame
  | WebMirrorChunkFrame
  | WebMirrorStopFrame

/* ------------------------------------------------------------ screen mirror
 *
 * The browser watching this desktop's actual screen — and, behind two further
 * locks, driving it.
 *
 * Everything above this line ends inside Forge: a pane, a tab, a project, a
 * folder listing. Everything in this block ends at a display or at the
 * operating system, so it is the part of the protocol worth reading twice.
 *
 * ## Why this is not WebRTC
 *
 * Forge Mobile and Forge TV already mirror this desktop, over a peer connection
 * the server merely relays signalling for (`MirrorStartFrame` in
 * shared/mobile.ts). Copying that here was the obvious move and it does not
 * work, for a reason that has nothing to do with taste: WebRTC media is
 * peer-to-peer over UDP, so it never enters the Cloudflare tunnel this link is
 * reached through. On a LAN the two peers find each other and everything looks
 * fine. From a hotel three hundred miles away they do not, and the fix is a
 * TURN relay — a server somebody runs, pays for, and through which every pixel
 * of Steve's screen would pass. The television is on the sofa; the browser is
 * anywhere. That difference is the whole argument.
 *
 * So the picture travels on the socket that is already open. Same tunnel, same
 * origin check, same Firebase token, same unlock PIN — one transport with one
 * set of locks, and nothing new to reason about at the network layer. There is deliberately no ICE, no STUN, no TURN and no
 * signalling frame anywhere in this file.
 *
 * ## How the chunk bytes travel, and what that costs
 *
 * `mirror-frame` carries one encoded chunk as **base64 inside the JSON frame**,
 * and the third it adds is spent on purpose.
 *
 * A binary WebSocket message would be cheaper and it would also be a second
 * wire format. `parseFrame` below is string-based; `electron/web/server.ts`
 * reads every message as `String(raw)`; every other frame on this link is JSON.
 * A binary path therefore means a second decoder at both ends *and* somewhere
 * to put the two facts a decoder needs per chunk — whether it is a keyframe and
 * what time it belongs at. Those either ride in a hand-rolled header that only
 * two files in the repository understand, or in a companion JSON frame that can
 * be separated from its bytes by an ordering nobody has to think about today.
 * base64 keeps one frame, one parser, and one description of this protocol in
 * this file, which is the property the whole file exists for.
 *
 * The cost is a third of a video bitrate that is already chosen to fit a home
 * upload. If it ever stops paying, the honest replacement is a binary message
 * with a fixed header in its first bytes — not a JSON frame beside one.
 */

/**
 * The largest encoded chunk this desktop will put on the wire, before base64.
 *
 * MAX_FRAME_BYTES is `ws`'s own `maxPayload` and bounds the *inbound* direction
 * only, so until this constant nothing bounded a frame travelling the other
 * way. That was harmless while the largest outbound frame was a 192KB replay
 * written by this desktop's own PTY buffer; a video encoder is the first thing
 * on this link that can produce something bigger, and can do it thirty times a
 * second.
 *
 * Half a megabyte is chosen against what an encoder actually emits rather than
 * as a round number: a keyframe at the resolutions a desktop capture runs at is
 * tens to low hundreds of kilobytes, and the delta frames between them are an
 * order of magnitude smaller again. So this sits several times above the worst
 * legitimate chunk and well below the point where one frame is a memory event —
 * 512KB becomes about 700KB of base64, once, rather than a megabyte per frame
 * for as long as somebody is watching.
 *
 * A chunk over it **ends the watch** rather than being quietly dropped. A
 * decoder that loses a keyframe paints a smear that never resolves, and
 * somebody staring at one cannot tell it from a tunnel that has died; a
 * sentence saying the picture was too big to send is worse news and better
 * information.
 */
export const MAX_MIRROR_CHUNK_BYTES = 512 * 1024

/**
 * How many `mirror-input` frames a second this desktop will act on — counted
 * **separately** from MAX_INPUT_PER_SECOND, which is the point rather than an
 * implementation detail.
 *
 * A pointer moving smoothly over a mirrored screen is around thirty frames a
 * second, and a wheel spun hard is more. Sharing one counter with `write` would
 * mean that moving the mouse spends the budget that answers the same person's
 * keystrokes, and the half that stalls would be the terminal — the thing this
 * link is actually for. Forge Mobile keeps a second counter for exactly this
 * reason; see `allowInput` in electron/mobile/server.ts.
 *
 * The value is the same 120 as MAX_INPUT_PER_SECOND, reached by the same
 * arithmetic rather than by copying it: four times a smooth pointer, so nobody
 * meets it by moving a mouse, and low enough that a runaway `setInterval` in a
 * tab exhausts a counter rather than a desk. Two counters that happen to hold
 * the same number are still two counters, and merging them because the numbers
 * match would reintroduce the starvation the split exists to prevent.
 */
export const MAX_MIRROR_INPUT_PER_SECOND = 120

/**
 * "Show me that screen." Browser → desktop.
 *
 * `pin` is the desktop's unlock PIN, presented *again* — not the one that
 * opened the connection an hour ago on a socket that has been open ever since.
 * A password alone must not buy the mouse, and neither must a PIN typed at the
 * start of a working day. The dance is `hello`'s, for the same reason it is
 * `hello`'s: the first `mirror-start` carries no PIN, the desktop answers
 * `mirror-stop` with `needsPin`, and the second carries what the person typed.
 * That costs a round trip and buys the property that a page only ever holds a
 * PIN it was just asked for.
 *
 * A desktop with no PIN set never asks, and the field is simply absent —
 * watching is then gated by the settings toggle alone. Driving is not: see the
 * escalation guard in electron/web-host.ts, which refuses control outright on a
 * desktop that has no PIN to ask for.
 */
export interface WebMirrorStartFrame {
  type: 'mirror-start'
  pin?: string
  /** A passkey answer instead of `pin`, over the challenge a `needsPin` stop carried. */
  passkey?: WebPasskeyAssertion
}

/**
 * The watch is over, or is not going to happen. Both directions.
 *
 * Upward it means the browser closed the viewer. Downward it is every refusal
 * and every ending: the setting is off, the PIN was wrong, Forge has no window
 * to capture in, the capture failed, another browser is already watching, the
 * encoder produced something too big to send, the desktop is shutting down.
 *
 * `needsPin` exists so the page can draw a PIN box rather than an apology.
 * Without it every refusal renders as the same dead end, and the single most
 * common one — "type the PIN again before you take the mouse" — would look like
 * a failure instead of a question. Same reasoning as `pin-required` being its
 * own `WebRefusal` rather than a shade of `refused`.
 */
export interface WebMirrorStopFrame {
  type: 'mirror-stop'
  /** One sentence, written for the person reading the browser tab. */
  reason?: string
  /** Ask for the PIN and send `mirror-start` again. Nothing has gone wrong. */
  needsPin?: boolean
  /**
   * With `needsPin`, when this account has passkeys: a fresh challenge the
   * page may answer with a biometric instead, sent back as
   * `mirror-start.passkey`.
   */
  passkey?: WebPasskeyRequestOptions
}

/**
 * What a decoder has to be told before it can be handed a single chunk.
 *
 * Its own interface rather than four fields on the frame, because the desktop's
 * *renderer* is where these values are decided — it owns the encoder — and they
 * therefore travel over IPC before they ever reach a socket. One shape, named
 * once, means the main process passes it along instead of unpicking and
 * rebuilding it. See `IPC.webMirrorReady`.
 */
export interface WebMirrorConfig {
  /**
   * A WebCodecs codec string, e.g. `avc1.42E01E` or `vp8`. Chosen by the
   * encoder at capture time and never by this file: what a machine can encode
   * in hardware is a property of that machine, and a codec named here would be
   * a guess that fails on somebody's laptop.
   */
  codec: string
  /** The coded size of the picture, which is not the browser's window size. */
  width: number
  height: number
  /**
   * Codec-private setup bytes, base64 — H.264's `avcC`, and its equivalents.
   *
   * Optional because only some configurations need one: an Annex-B H.264 stream
   * and VP8 carry their own parameter sets inline, and a decoder handed a
   * `description` it does not want will refuse to configure. Absent means "the
   * chunks are self-describing".
   */
  description?: string
}

/**
 * The answer to `mirror-start`, sent when the capture is actually up.
 *
 * Deliberately *not* sent the moment the frame arrives. The renderer has to
 * open a stream onto the display and configure an encoder before anything here
 * is known, and a `mirror-ok` full of guesses would be a decoder configured
 * wrongly rather than a decoder configured early. Between the request and this
 * frame the browser has been told nothing, which is correct: it is waiting on a
 * machine, and the only other thing that can arrive is `mirror-stop` saying why
 * it is not coming.
 *
 * `canControl` is this desktop's answer to "may I also drive it", read at the
 * moment the picture starts. A snapshot, not a subscription, and the same
 * arrangement `HelloOkFrame.canControl` has for a television: switching control
 * *on* at the desk reaches the browser on its next watch; switching it *off* is
 * felt immediately, because every input frame is judged afresh.
 */
export interface WebMirrorOkFrame extends WebMirrorConfig {
  type: 'mirror-ok'
  canControl: boolean
}

/**
 * One encoded video chunk. Desktop → browser, and the only high-rate frame on
 * this link that this desktop originates rather than relays.
 *
 * There is no acknowledgement and there must not be one — the same rule
 * `WebDataFrame` states for terminal bytes, and for a harder reason: what is on
 * the far end is a decoder, and a decoder cannot ask for a frame again. A chunk
 * that does not arrive is a chunk that never existed.
 */
export interface WebMirrorChunk {
  /** The encoded bytes, base64. See the block comment above for why. */
  data: string
  /**
   * A keyframe, decodable on its own. The one bit a viewer joining or
   * recovering has to have: everything else in the stream is a difference from
   * a picture it may not hold.
   */
  key: boolean
  /**
   * Microseconds, on the encoder's own timeline — WebCodecs' unit, passed
   * through rather than converted, so nothing in the middle of this pipe has an
   * opinion about time.
   */
  timestamp: number
  /** How long the chunk covers, in microseconds, when the encoder says. */
  duration?: number
}

export interface WebMirrorChunkFrame extends WebMirrorChunk {
  type: 'mirror-frame'
}

/**
 * The browser driving this desktop's pointer and keyboard. Only ever sent
 * upward, and the only frame in this protocol that ends in a synthetic event at
 * the operating system.
 *
 * Every field is Forge Mobile's, imported rather than restated: `readMirrorInput`
 * in shared/mobile.ts is the validator both links use, it never looks at a
 * frame's discriminant, and so it validates one of these verbatim. A second
 * copy of that parser is the thing most likely to disagree with the first about
 * what a clamped coordinate or an unlisted key means — and disagreements
 * between two validators of an OS-level input frame are not the kind anybody
 * finds by reading.
 *
 * What can be expressed at all is set out at length in shared/mobile.ts's input
 * block: a closed vocabulary, never a keycode; every pointer event carrying its
 * own position; positions as fractions of the mirrored screen rather than
 * pixels. All three arguments hold here unchanged, and the third holds harder —
 * a browser window has no idea what resolution this desk is and is very
 * probably not even the same shape.
 */
export interface WebMirrorInputFrame {
  type: 'mirror-input'
  a: MirrorInputAction
  /** Where the pointer is, as a fraction of the mirrored screen. 0..1. */
  x?: number
  y?: number
  button?: MirrorButton
  /** Wheel notches; positive scrolls away from the reader, like a real wheel. */
  wheel?: number
  key?: MirrorKey
  /** For `key`: the stroke's direction. Both are sent, always in pairs. */
  down?: boolean
  /** For `text`: a phrase to type, as one instruction. */
  text?: string
}

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
    case 'mirror-start':
    case 'mirror-stop':
    // Admitted and nothing more, exactly as `request` is: what an input frame
    // *means* is decided by `readMirrorInput` in shared/mobile.ts, in one place,
    // after the server has established that this socket is the one watching the
    // screen. Nothing here reads `a`, `x` or `key`.
    case 'mirror-input':
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

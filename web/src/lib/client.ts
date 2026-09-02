import {
  HEARTBEAT_MS,
  MAX_WRITE_CHARS,
  PIN_GRACE_MS,
  TOKEN_REFRESH_MS,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  isWebRefusal,
  isWebShutdownReason,
  type WebClientFrame,
  type WebConnectionState,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebMirrorChunk,
  type WebMirrorInputFrame,
  type WebMirrorOkFrame,
  type WebRefusal,
  type WebRequest,
  type WebResult,
  type WebServerFrame,
  type WebSession,
  type WebShutdownReason
} from '@shared/web'
import type { ChatUpdate } from '@shared/chat'
import type { ForemanState } from '@shared/foreman'
import type { GitSnapshot, HandoffRecord, Project, Workspace } from '@shared/types'

/**
 * The browser's end of the Forge Web link — one socket, and everything the page
 * knows about the desktop.
 *
 * Every frame, limit and guard comes from `@shared/web`, which is the file both
 * ends compile against. Nothing here hand-rolls a frame, restates a ceiling or
 * invents a word: `WEB_PROTO`, `WEB_SUBPROTOCOL`, `MAX_WRITE_CHARS`,
 * `HEARTBEAT_MS`, `TOKEN_REFRESH_MS`, `isWebRefusal` and `isWebShutdownReason`
 * are all imported, and the three values this module *does* name for itself
 * (backoff, request patience, the warmth window) are client-side judgements that
 * do not appear on the wire.
 *
 * ## Connection state is the product, not a spinner
 *
 * `WebConnectionState` names the vocabulary — connecting, pin, live, refused,
 * offline — and shared/web.ts says why it is a vocabulary rather than a boolean:
 * each one is a different sentence with a different recovery. So this class never
 * collapses a refusal into "disconnected", and it never retries one that a retry
 * cannot fix. `retryPolicy` below is that judgement written down once, per
 * `WebRefusal`, instead of scattered through a reconnect loop.
 *
 * ## Mirror, never a parallel world
 *
 * `layout()` sends a request and resolves with the desktop's answer. It does not
 * touch any local state, and there is deliberately no method that does: the
 * desktop renderer owns the split tree and persists it (docs/forge-web.md,
 * decision 5), and what redraws this page is the `workspace` push that comes
 * back. A client that mutated its own copy and hoped would be a second source of
 * truth for the one thing this protocol exists to keep singular.
 */

/** Reconnect schedule, in ms. Caps rather than growing forever — as mobile's does. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]

/**
 * How long a `request` waits before its promise is settled as failed.
 *
 * Not a protocol constant and deliberately not in shared/web.ts: the server
 * guarantees that every request settles, so this is not a correctness
 * mechanism — it is how long a *person* is willing to watch a spinner over a git
 * fetch on a slow machine. Thirty seconds is past any of them and short enough
 * that a wedged desktop shows a sentence rather than a permanent spinner.
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long after the last frame the link still counts as warm.
 *
 * Only the connection badge reads it. The socket's real liveness is the
 * server's native WebSocket ping (HEARTBEAT_MS), which a browser answers in its
 * network stack whether or not the tab is visible; the app-level `ping` this
 * class sends is what shared/web.ts describes — it tells the *page* the link is
 * answering, so the badge is honest, and `challenge` below turns that same
 * answer into the test for whether the socket is still worth keeping.
 */
const WARM_MS = HEARTBEAT_MS * 2

/**
 * How long the link has to answer a `ping` before it is treated as dead.
 *
 * This is the number that decides how quickly coming back to a tab you left
 * alone gets you a working connection, and it exists because `readyState` will
 * not tell you. A laptop that slept, or a phone that backgrounded the tab, has
 * its socket torn down by the OS without a close frame ever reaching the page:
 * the browser goes on reporting `OPEN` until its own TCP timeout gives up,
 * which is minutes. So the only honest test is to ask and see if anything comes
 * back, and this is how long "anything" gets.
 *
 * Three seconds is a generous round trip — through a tunnel, from a phone on
 * bad mobile data, to a desktop that is busy — and being wrong here is cheap
 * but not free: a needless reconnect re-attaches every pane and replays every
 * terminal, which is visible churn. Erring long costs a second; erring short
 * costs a screen full of repaint.
 */
const PROBE_MS = 3_000

/**
 * How many probes in a row may go unanswered before the link is hung up on.
 *
 * One was too few. A phone on 5G through a cloudflared quick tunnel sees round
 * trips past three seconds whenever the tunnel's QUIC leg stalls, and hanging
 * up on the first slow answer meant the beat redialled every twenty seconds —
 * the desktop log showed "connected / disconnected" in a steady rhythm — and
 * every redial re-attached and replayed every pane, which on a phone is the
 * screen going blank mid-sentence. A second ask costs one more PROBE_MS before
 * a genuinely dead socket is noticed; a merely slow one gets the benefit of it.
 */
const PROBE_STRIKES = 2

/**
 * How long a keystroke waits for the link to come back before it is dropped.
 *
 * `write` used to hand its frame to a socket that was not open and say
 * nothing, which is how a message arrived at the desktop without its Enter:
 * the words went down the old socket a beat before the probe hung up on it,
 * and the carriage return a beat later went down nothing. Anything a person
 * typed while the link is being re-dialled is held and sent once the desktop
 * has let this browser back in and re-attached its panes — unless the outage
 * was long enough that the pane may be a different conversation by now, in
 * which case they are told what was not typed rather than having it typed
 * into whatever is there.
 *
 * Thirty seconds, because the ceiling has to clear the *slowest honest
 * reconnect*, not the fastest. The retired-tunnel path — one dial burning the
 * whole CONNECT_TIMEOUT_MS, a backoff, a second dial that has to re-find the
 * address first — runs 22–25 seconds end to end, and at fifteen the held Enter
 * was dropped at almost exactly the moment the link came back: the hold
 * existed for that outage and gave up just before it ended.
 */
const WRITE_HOLD_MS = 30_000

/**
 * How long a socket may sit in CONNECTING before a wake-up may abandon it.
 *
 * A dial is a link in hand (`linkInHand`), so every wake-up stands down while
 * one is in flight — which is right until the wake-up *is the news that the
 * dial is doomed*: `online` after a radio handover, `connection.change` when
 * wifi hands to LTE, mean the route the handshake left on no longer exists,
 * and waiting out its CONNECT_TIMEOUT_MS is eight seconds of a person staring
 * at "Reconnecting" on a phone that is back on the air. A connect younger
 * than this is left to finish — most complete well inside it — and one older
 * is hung up and re-run at the network that actually exists now. Only the
 * handshake leg is ever abandoned: the token and address fetches before it
 * carry their own aborts, and restarting *them* on every wake-up turned a
 * slow honest sign-in into one that never finished.
 */
const STUCK_DIAL_MS = 4_000

/**
 * How long a freshly-dialled socket has to reach `OPEN`.
 *
 * The other half of the same problem. When the desktop's address has moved —
 * a cloudflared quick tunnel publishes a new hostname every time it restarts —
 * the dial goes to an address nothing is listening on, and the socket sits in
 * `CONNECTING` until the OS abandons the handshake, which is anywhere from
 * thirty seconds to two minutes. `linkInHand` rightly counts that socket as a
 * link in hand and refuses to open a second one beside it, so without a
 * deadline here the whole of that wait is dead time no wake-up can shorten.
 *
 * Only the network is being timed: nothing on the desktop has been asked to do
 * any work yet, because `hello` does not go out until the socket opens. Eight
 * seconds is well past any reachable address and well short of the OS.
 */
const CONNECT_TIMEOUT_MS = 8_000

/**
 * How long an `attach` may sit without the `replay` that answers it.
 *
 * The desktop answers every `attach` it receives with exactly one `replay` —
 * there is no path through the handler that skips it (server.ts, `case
 * 'attach'` → `sendReplay`) — so an attach with no replay on its heels means
 * one thing only: the frame was eaten by a link that was open enough to take
 * it and not sound enough to deliver it. The socket stays warm, the badge
 * stays green, writes still land, and no pane this browser is watching ever
 * paints again, because the server never registered the subscription the
 * re-attach was meant to carry. This is the "the phone says waiting while the
 * desk shows the agent thinking" failure, and nothing else in the page can
 * see it: every other liveness test here proves the *link*, and this is a
 * test of what the link carried.
 *
 * So every ask — the beat, a wake-up, a keystroke — checks the oldest
 * unanswered attach against this ceiling (`auditPendingReplay`). The first
 * breach re-sends the attach — one frame lost in transit or refused is a fact
 * about a frame, and re-asking costs thirty bytes — and only a second breach
 * for the same pane hangs the link up (`declareDead`), because two losses in a
 * row about the same pane is a fact about the link, which a fresh dial
 * re-attaches from `subs` anyway. Ten seconds is far past any honest replay:
 * the snapshot is taken and sent in one turn of the desktop's event loop, and
 * the panes this guard exists for are ones an eye is actively on. Cleared per
 * session by the `replay`, `exit`, `detach` and `unknown-session` frames that
 * each end the question in their own way.
 */
const REPLAY_GRACE_MS = 10_000

/**
 * How often a live link is asked to prove itself, and re-told what it was told.
 *
 * Not HEARTBEAT_MS, which belongs to the server's native WebSocket ping and to
 * the warmth the badge reads (WARM_MS). This is the *page's* own beat, and it
 * bounds every silent failure the socket object cannot see: a link the OS tore
 * down without a close frame, an attach a tunnel ate, a visibility report that
 * never landed. Twenty seconds of that was a beat nobody was watching; five is
 * one ping and one idempotent re-statement per beat, and the server's frame
 * budget (MAX_INPUT_PER_SECOND) is counted against a wall-clock second, so a
 * beat every five seconds cannot approach it.
 */
const CLIENT_BEAT_MS = 5_000

/**
 * The reconnect re-arm's wave size and spacing — see `sendAttachWave`.
 *
 * Thirty-two per quarter-second stays far under any desktop's per-second frame
 * budget even with everything else `hello-ok` sends in the same tick, while a
 * 128-pane workspace is still fully re-armed inside a second and a half.
 */
const ATTACH_WAVE = 32
const ATTACH_WAVE_MS = 250

/**
 * How long an attach that has just been sent is left alone by the beat's
 * ledger check, so a frame still honestly in flight — down a tunnel, from a
 * phone — is not re-sent on top of itself. Anything the desktop received
 * inside this window answers with its replay well before the next beat asks.
 */
const ATTACH_SETTLE_MS = 2_500

/**
 * How long to wait before re-sending an attach the desktop *refused* for
 * budget (`error{code:'limit'}`). The budget is counted against a wall-clock
 * second, so just over one second is the earliest re-ask that cannot land in
 * the same counted second that refused it.
 */
const LIMIT_RETRY_MS = 1_100

/**
 * How often the sleep detector reads the clock, and the jump that means the
 * machine was not running between two of those readings.
 *
 * The one wake-up signal a desktop browser does not otherwise give you. A tab
 * that was in the foreground when the lid closed is still `visible` when it
 * opens, and no `visibilitychange`, `focus` or `online` need fire — but the
 * wall clock moved by hours while this interval failed to tick, and that is
 * observable. See `watchWakeups`.
 */
const CLOCK_TICK_MS = 5_000
const SLEEP_JUMP_MS = CLOCK_TICK_MS * 3

/* ------------------------------------------------------------------- state */

/**
 * Where this browser stands, as the one word the connection UI switches on plus
 * whatever that word needs to say.
 *
 * The tag is `WebConnectionState` itself rather than a parallel enum, so a state
 * the protocol names and this client forgot to handle is a compile error.
 */
export type Connection =
  | { state: Extract<WebConnectionState, 'connecting'>; attempt: number }
  /**
   * The desktop wants its unlock PIN. `invalid` distinguishes "you have not been
   * asked yet" from "that one did not open the door" — the same screen either
   * way, but only one of them owes the person a red line.
   */
  | { state: Extract<WebConnectionState, 'pin'>; message: string; invalid: boolean; retryAfterMs?: number }
  | { state: Extract<WebConnectionState, 'live'>; desktopName: string; appVersion: string }
  | { state: Extract<WebConnectionState, 'refused'>; reason: WebRefusal; message: string; retryAfterMs?: number }
  | { state: Extract<WebConnectionState, 'offline'>; message: string; reason?: WebShutdownReason; retryAfterMs?: number }

export interface ForgeHandlers {
  /** The connection state changed. The whole of the connection UI is this. */
  onConnection: (connection: Connection) => void
  /** The opening picture, on every (re)connection. */
  onPicture: (picture: WebHelloOkFrame) => void
  /** Terminal bytes. `replay` marks the catch-up buffer, which must clear first. */
  onData: (sessionId: string, data: string, replay: boolean, truncated: boolean) => void
  onExit: (sessionId: string, exitCode: number) => void
  /**
   * One update to a pane's conversation, for whichever surface asked for it.
   * `ChatUpdate` says how two of these relate — see `watchTranscript`.
   */
  onTranscript: (sessionId: string, update: ChatUpdate) => void
  onSessions: (sessions: WebSession[]) => void
  onSessionStarted: (session: WebSession) => void
  onAttention: (sessionId: string, asking: boolean, prompt: string) => void
  /**
   * One pane's Foreman state moved — the whole state, every time, whether or
   * not this browser is the one that switched it on. See `WebForemanFrame`.
   */
  onForeman: (state: ForemanState) => void
  /**
   * One project's handoff packs changed — the whole list for that project, every
   * time, whether or not this browser started the handoff. See `WebHandoffFrame`.
   */
  onHandoff: (projectId: string, records: HandoffRecord[]) => void
  /**
   * The desktop's own window died or hung, and is coming back — or has.
   *
   * Nothing to do with any pane. It is the answer to "why did that button do
   * nothing": the commands this page sends are executed in the desktop's
   * renderer, and while it is being rebuilt they land nowhere. See
   * `WebDesktopFrame` in shared/web.ts.
   */
  onDesktop: (state: 'recovering' | 'ready', reason: string) => void
  onProjects: (projects: Project[]) => void
  onWorkspace: (projectId: string, workspace: Workspace) => void
  onGit: (snapshot: GitSnapshot) => void
  /** Something went wrong that no `rid` is waiting on. One sentence, for the user. */
  onNotice: (message: string) => void
  /**
   * The credential was refused. The page re-authenticates and this class
   * reconnects; the handler exists so a *second* failure signs the person out
   * rather than looping on a token that will never verify.
   */
  onTokenRejected: () => void
}

export interface ForgeCredentials {
  /** Already built by `webSocketUrl`. This class never composes an address. */
  url: string
  /**
   * A valid ID token. `force` means the last one was refused, so a cached one
   * must not be handed back.
   */
  getToken: (force: boolean) => Promise<string>
  deviceId: string
  deviceName: string
  /**
   * Read the desktop's *current* address out of the rendezvous record, for a
   * retry that has already failed against the one this link was handed.
   *
   * Optional because the dev loop's loopback host is a constant and has nothing
   * to look up. Everywhere else it is the difference between working and not:
   * a cloudflared quick tunnel is a **new hostname every time it starts**, and
   * the desktop republishes within seconds — so a link that re-dials the string
   * it was constructed with re-dials a hostname that has been retired, forever,
   * against a desktop that is up and two seconds away. That is
   * indistinguishable on screen from a PC that is off: "Reconnecting to the
   * desktop (attempt 41)…".
   *
   * Only consulted on a *re*-connect (`attempt > 0`), so the first dial costs no
   * extra round trip, and an empty string means "no better answer than the one
   * you have" rather than "give up" — a failed lookup must not turn a retry loop
   * that might still succeed into one that cannot.
   */
  refindUrl?: () => Promise<string>
}

/**
 * What a refusal means for the reconnect loop.
 *
 * One table rather than a chain of ifs, because the whole value of `WebRefusal`
 * being several words instead of one string is that each has a different
 * recovery, and a recovery that only exists in prose is one the code does not
 * have.
 */
type Retry =
  /** Do not reconnect. A human has to do something. */
  | { kind: 'stop' }
  /** Get a fresh credential and try once more. */
  | { kind: 'reauth' }
  /** Wait the server's own `retryAfterMs`, then try again. */
  | { kind: 'after' }

function retryPolicy(reason: WebRefusal): Retry {
  switch (reason) {
    // A fresh token usually fixes it, and usually without the person noticing.
    case 'bad-token':
      return { kind: 'reauth' }
    // Retrying a correct credential against the wrong desktop loops forever.
    case 'wrong-account':
      return { kind: 'stop' }
    // This browser sent a blank `deviceId`, so its storage is unavailable.
    // Reconnecting would send the same blank one forever; recovery is a reload,
    // which mints one.
    case 'not-approved':
      return { kind: 'stop' }
    // Recovery is a reload; this bundle cannot become a different one.
    case 'proto':
      return { kind: 'stop' }
    case 'busy':
      return { kind: 'after' }
    // Both are answered by a human typing something, so neither is a reconnect
    // this loop can decide on its own. `submitPin` is what starts the next
    // attempt, and it carries the thing that was missing.
    case 'pin-required':
    case 'pin-invalid':
      return { kind: 'stop' }
  }
}

/* ------------------------------------------------------------ screen mirror
 *
 * The one part of this link that does not travel through `ForgeHandlers` and the
 * state provider, and the exception is deliberate.
 *
 * Everything else on this socket is *the workspace* — projects, panes, bytes,
 * git — which every screen reads and which `state.tsx` therefore owns. The
 * desktop's screen is not that. At most one surface on this page is ever
 * watching it, that surface owns a decoder and a canvas which must outlive
 * renders and must never be rebuilt by one (see web/src/lib/screen.ts), and
 * chunks arrive thirty times a second. Routing them through a React context
 * would mean either a re-render per frame or a ref that the provider holds for
 * one component's benefit — a second owner of a thing with one owner.
 *
 * So it is a pair of module-level slots instead: one for the surface that is
 * watching, and one for the live socket's own sender, filled in by the client's
 * constructor. There is exactly one `ForgeClient` per page (`state.tsx` builds it
 * once and keeps it in a ref) and exactly one viewer, which is what makes a slot
 * the honest shape rather than a shortcut — a list here would be pretending this
 * link can serve two watchers, which shared/web.ts says it cannot.
 */

/** What a surface watching the screen is told. Every one of these is a frame. */
export interface MirrorWatcher {
  /** The capture is up: configure a decoder from this and start painting. */
  onOk: (frame: WebMirrorOkFrame) => void
  onChunk: (chunk: WebMirrorChunk) => void
  /**
   * The watch is over, or is not going to happen. `needsPin` is a question
   * rather than a failure — show a PIN box and ask again with what was typed.
   */
  onStop: (reason: string, needsPin: boolean) => void
}

let watcher: MirrorWatcher | null = null
/**
 * How a frame gets *out*, without the viewer holding the client.
 *
 * A closure over the client's own private `send`, so the mirror does not add a
 * public method to this class for every frame it needs and cannot send anything
 * else through it. Rebuilt by each `ForgeClient` that is constructed, which in
 * this page is one.
 */
let sendUp: ((frame: WebClientFrame) => void) | null = null

/**
 * Take the screen slot. Returns the release, which the caller must run when its
 * surface goes away — a stale watcher would be handed the next watch's frames.
 */
export function watchMirror(next: MirrorWatcher): () => void {
  watcher = next
  return () => {
    if (watcher === next) watcher = null
  }
}

/**
 * "Show me that screen", with the unlock PIN when the desktop has asked for one.
 * An empty PIN is omitted rather than sent, so a desktop with none set sees the
 * frame it has always seen.
 */
export function askForScreen(pin: string): void {
  sendUp?.({ type: 'mirror-start', ...(pin ? { pin } : {}) })
}

/** The viewer closed. The desktop stops capturing on this frame. */
export function stopWatching(): void {
  sendUp?.({ type: 'mirror-stop' })
}

/**
 * One input, on its way to somebody's actual mouse and keyboard.
 *
 * Takes the frame's body rather than the frame, so the discriminant is written
 * in one place and a caller cannot send anything else up this path by accident.
 */
export function sendMirrorInput(input: Omit<WebMirrorInputFrame, 'type'>): void {
  sendUp?.({ type: 'mirror-input', ...input })
}

/* ------------------------------------------------------------------- class */

export class ForgeClient {
  private readonly handlers: ForgeHandlers
  private credentials: ForgeCredentials | null = null
  private socket: WebSocket | null = null
  /**
   * True from the first line of `open()` until it has either handed a socket
   * over or given up, which is the one window `this.socket` cannot describe.
   *
   * `open()` awaits a token and then, on a retry, a tunnel lookup — two network
   * round trips during which the old socket has been dropped and the new one
   * does not exist. A readyState test taken in that window reads `undefined`
   * and says "nothing here, dial", so anything that re-dials on an event opens
   * a *second* socket beside the one already being built. See `linkInHand`.
   */
  private opening = false
  /**
   * When the current dial's *socket* was created — the handshake leg alone,
   * not the fetches before it. Read by `probe` to decide whether a wake-up
   * may abandon a CONNECTING socket; see STUCK_DIAL_MS.
   */
  private dialStartedAt = 0
  /**
   * Which call to `open()` is the current one, so an older call resuming from
   * an `await` can notice it has been superseded and stand down before it
   * builds a socket. `generation` cannot do this job: it is stamped when a
   * socket is *adopted*, and the whole point here is to stop the older dial
   * before it gets that far — two dials that both reach `new WebSocket` are
   * two sockets saying `hello`, which is the double-attach disaster
   * `linkInHand` exists to prevent.
   */
  private dialCount = 0
  /**
   * No dial before this instant, set only by a wait the desktop itself issued
   * (`retryAfterMs`) and respected only by `wake` — the timer loop's own
   * backoffs neither set nor read it. See the note in `wake`.
   */
  private retryFloor = 0
  /**
   * Which dial the live socket belongs to, so a socket from an older one can
   * recognise itself as superseded.
   *
   * The guard above is the fix; this is the belt to its braces. Every handler
   * captures the counter's value at the moment its socket was adopted and
   * stands down when it no longer matches, so a socket that somehow outlives
   * its dial is inert rather than a second voice on the link — and it matters
   * that it is inert rather than merely untidy, because two sockets both
   * delivering `data` write every byte into xterm twice, and a TUI redraw
   * applied twice repaints the frame down the screen instead of over itself.
   */
  private generation = 0
  private attempt = 0
  private retryTimer: number | null = null
  private beatTimer: number | null = null
  private refreshTimer: number | null = null
  /** The deadline on an outstanding `challenge`. See PROBE_MS. */
  private probeTimer: number | null = null
  /** The deadline on a socket that has not reached `OPEN`. See CONNECT_TIMEOUT_MS. */
  private connectTimer: number | null = null
  /**
   * When the last `ping` went out with nothing heard since, or 0.
   *
   * Zeroed by `receive`, so a non-zero value means precisely one thing: this
   * page asked the desktop a question and not one byte has arrived from it
   * since. That is the whole liveness test — no elapsed-time arithmetic, no
   * guessing at what `readyState` means.
   */
  private pingedAt = 0
  /**
   * True between `hello-ok` and the socket going away.
   *
   * A `challenge` may only be sent down an admitted link. The desktop answers
   * *nothing* but `hello` before it has let a browser in — anything else earns
   * an `error` frame and a closed socket (see `handle` in
   * electron/web/server.ts) — so a liveness ping sent a moment too early would
   * cause the very drop it exists to detect.
   */
  private admitted = false
  private closedByUs = false
  /** True once a `refused` frame has decided this link is not coming back. */
  private stopped = false
  /** Set when the last refusal was `bad-token`, so a second one signs out. */
  private reauthed = false
  private lastFrameAt = 0
  /** Probes that have gone unanswered on this socket, in a row. */
  private strikes = 0
  /** Keystrokes typed while the link was down, in order, to send once it is back. */
  private held: Array<{ sessionId: string; data: string; at: number }> = []
  private rid = 0
  private waiting = new Map<string, { settle: (result: WebResult) => void; timer: number }>()
  /** sessionId → the geometry this browser is reading it at, re-sent on reconnect. */
  private subs = new Map<string, { cols: number; rows: number } | null>()
  /**
   * Panes whose *conversation* this page is reading, re-asked for on reconnect.
   *
   * `subs`'s counterpart and deliberately not a flag on it: a chat view needs
   * no terminal bytes and a terminal needs no transcript, which is the same
   * split the desktop keeps (`chats` beside `subs` in electron/web/server.ts).
   * It has to survive a dropped socket for the same reason `subs` does — the
   * desktop tears every tail down with the socket that asked for it, so a
   * fresh link is a link watching nothing until this list is said again.
   */
  private chats = new Set<string>()
  /**
   * sessionId → the grid the desktop has actually been told, on *this* socket.
   *
   * `subs` cannot answer that question, and the difference is the point. `subs`
   * is the standing wish: it is written whether or not a frame went out, it
   * survives a dropped socket on purpose, and it is what the reconnect
   * re-attaches with. This is a record of what was *said*, and it is only ever
   * written when a frame left the building.
   *
   * It exists because a `resize` is not a cheap thing to repeat. The desktop
   * answers one with a deliberate two-step jiggle — `rows - 1`, then the true
   * size 60ms later, see `resizeForViewer` in electron/pty-host.ts — so that
   * every TUI on the end of it redraws. That is the intended cost of a real
   * size change and an absurd one for a frame that asked for the size the pane
   * already had, because the redraw it forces lands in the normal buffer's
   * scrollback as a second copy of the screen. One duplicate per redundant
   * frame, and the browser has several paths that can produce one.
   *
   * Cleared whenever this link's voice is taken away — `dropSocket` and the
   * socket's own `onclose` — because after a reconnect the desktop's idea of
   * this browser's wish is whatever the re-`attach` carried, and a memory
   * carried across that boundary would suppress the one frame that was needed.
   */
  private told = new Map<string, { cols: number; rows: number }>()
  /**
   * sessionId → when this page sent an `attach` no `replay` has answered yet.
   *
   * The receipt the protocol never had. An attach is a bare frame, so a send
   * that returned true says "the socket took it", not "the desktop got it" —
   * and the difference is exactly the starved-pane failure REPLAY_GRACE_MS
   * describes. Written by `sendAttach` on a successful send, cleared by every
   * frame that answers or ends the question (`replay`, `exit`,
   * `unknown-session`), and audited once per beat.
   */
  private pendingReplay = new Map<string, number>()
  /**
   * Sessions whose overdue attach has already been re-sent once on this
   * socket, so the audit hangs the link up on the *second* breach rather than
   * the first. One lost frame is a fact about a frame; two in a row about the
   * same pane is a fact about the link. Cleared per pane by the `replay` that
   * answers, and wholesale by `hello-ok`, where a fresh socket starts with a
   * clean record.
   */
  private reAsked = new Set<string>()
  /**
   * The visibility this page last reported to the desktop, so it can be
   * *re-said* rather than only said.
   *
   * The desktop withholds every pane's bytes from a tab it last heard was
   * hidden (server.ts, `pushData`), and the one report per connection that
   * clears that flag travels down the same eatable link as everything else.
   * A report lost in transit left a visible tab being starved for as long as
   * the socket stayed up — writes still landed, so nothing else ever noticed.
   * Re-stating it once per beat costs twenty bytes and cannot cause a repaint;
   * it is idempotent on the desktop, where stating what is already stated does
   * nothing at all.
   */
  private reportedVisible: boolean | null = null
  /** The unlock PIN for the *next* hello only. See `submitPin`. */
  private pin = ''
  /**
   * A PIN that already opened the door, held in RAM so a reconnect after the
   * tab was hidden (a phone switching apps) can answer without a re-prompt.
   * Never written down; forgotten after PIN_GRACE_MS hidden, on a wrong PIN,
   * and on sign-out. See PIN_GRACE_MS in shared/web.ts.
   */
  private rememberedPin = ''
  /** The PIN this attempt is carrying, remembered on `hello-ok` only. */
  private sentPin = ''
  /** When the tab last went hidden, or 0 while it is visible. */
  private pinHiddenAt = 0

  constructor(handlers: ForgeHandlers) {
    this.handlers = handlers
    // The outbound half of the screen-mirror slot pair above. A closure rather
    // than the instance, so nothing outside this file can reach the rest of the
    // client through it.
    sendUp = (frame) => this.send(frame)
    this.watchPinGrace()
    this.watchWakeups()
  }

  /** Is the link answering? Drives the badge, and nothing else. See WARM_MS. */
  get warm(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastFrameAt < WARM_MS
  }

  connect(credentials: ForgeCredentials): void {
    this.credentials = credentials
    this.closedByUs = false
    this.stopped = false
    this.reauthed = false
    this.attempt = 0
    void this.open()
  }

  /** A human pressed "Try again" on a screen this class had stopped at. */
  retry(): void {
    if (!this.credentials) return
    this.stopped = false
    this.closedByUs = false
    this.reauthed = false
    this.attempt = 0
    this.clearRetry()
    // A second press while the first is still crossing the network is the same
    // race the wake-ups make, so it stands down for the same reason — and it
    // loses nothing: every screen with this button on it is a screen the
    // desktop hung up on, so the socket is already gone by the time a person
    // can reach for it, and a dial in flight is the press being answered.
    if (this.linkInHand()) return
    void this.open()
  }

  /**
   * A human typed the unlock PIN. Reconnect, carrying it.
   *
   * Held for this `hello` and dropped in `open()`, whatever the desktop makes
   * of it. A *wrong* one is forgotten immediately so it cannot be replayed as
   * a lockout strike. A right one is remembered in RAM (see `rememberedPin`)
   * so a phone that drops its socket on an app switch does not re-prompt for
   * PIN_GRACE_MS. Never written to disk; a reload forgets it.
   */
  submitPin(pin: string): void {
    if (!this.credentials) return
    this.pin = pin.trim()
    this.retry()
  }

  disconnect(): void {
    this.closedByUs = true
    this.clearRetry()
    this.dropSocket()
    this.subs.clear()
    this.chats.clear()
    this.forgetPin()
    this.failWaiting('The link to the desktop closed.')
  }

  /**
   * The PIN this `hello` should carry: a just-typed one, or a successful one
   * still inside the grace window. Clears the one-shot either way.
   */
  private pinForHello(): string {
    const typed = this.pin
    this.pin = ''
    const pin = typed || this.liveRememberedPin()
    this.sentPin = pin
    return pin
  }

  private liveRememberedPin(): string {
    if (!this.rememberedPin) return ''
    if (this.pinHiddenAt && Date.now() - this.pinHiddenAt > PIN_GRACE_MS) {
      this.forgetPin()
      return ''
    }
    return this.rememberedPin
  }

  private forgetPin(): void {
    this.rememberedPin = ''
    this.sentPin = ''
    this.pin = ''
  }

  private watchPinGrace(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pinHiddenAt = Date.now()
        return
      }
      if (this.pinHiddenAt && Date.now() - this.pinHiddenAt > PIN_GRACE_MS) this.forgetPin()
      this.pinHiddenAt = 0
    })
  }

  /**
   * Come back the moment the machine does, rather than at the back-off's leisure.
   *
   * The retry loop exists to ride out a link that is down *somewhere between
   * here and the desktop*, and these are the events that say the fault was on
   * this side and is now over. Waiting out up to fifteen seconds of scheduled
   * back-off after one of them is time paid for nothing.
   *
   * Four signals, because no one of them covers both clients:
   *
   *  - `online`, the radio coming back.
   *  - `visibilitychange` to visible, a phone returning from an app switch.
   *  - `focus`, which is the *desktop* version of that and fires where
   *    `visibilitychange` does not: alt-tabbing to another application leaves
   *    the tab `visible` throughout, so a browser window that has been in the
   *    background all afternoon produces no visibility event at all on return.
   *  - `pageshow`, for a restore out of the back/forward cache, where the page
   *    resumes with its sockets already torn down and, again, no visibility
   *    change to announce it.
   *
   * And then the case none of the four can see: the machine slept with this tab
   * in the foreground and woke with it still there. Nothing fires, because from
   * the page's point of view nothing happened — except that the wall clock
   * moved by hours while `CLOCK_TICK_MS` failed to tick, which is the whole
   * signal. See SLEEP_JUMP_MS.
   *
   * Every one of them hands to `probe` rather than deciding anything itself.
   */
  private watchWakeups(): void {
    window.addEventListener('online', () => this.probe())
    window.addEventListener('focus', () => this.probe())
    window.addEventListener('pageshow', () => this.probe())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      this.probe()
    })
    /*
     * The one wake-up none of the four above can say: the network itself
     * changed — wifi handed over to LTE, a VPN route gone, the tunnel's edge
     * moved — while the tab sat visible and focused the whole time, so no
     * window, page or clock event fires at all. `connection` is not in the DOM
     * lib yet; every browser Forge Web runs in has it, and one that does not
     * simply never fires this.
     */
    const network = (
      navigator as Navigator & { connection?: { addEventListener(type: 'change', listener: () => void): void } }
    ).connection
    network?.addEventListener('change', () => this.probe())
    let ticked = Date.now()
    window.setInterval(() => {
      const now = Date.now()
      const slept = now - ticked > SLEEP_JUMP_MS
      ticked = now
      if (slept) this.probe()
    }, CLOCK_TICK_MS)
  }

  /**
   * Something says this page has just come back. Get it a working link.
   *
   * The hard half is that the socket in hand is usually the problem. Every
   * wake-up above arrives at a client whose `readyState` says `OPEN`, because
   * that is what a socket the OS tore down without a close frame says, for
   * minutes. Standing down on it — which is what a re-dial guard has to do, or
   * it opens a second socket beside a working one — is how the page came to sit
   * there disconnected long after the machine was back.
   *
   * So this does not stand down on a link in hand; it makes the link prove
   * itself, and only the failure of that proof reaches the retry loop.
   * `linkInHand` keeps its job unchanged: nothing here opens a second socket,
   * because `declareDead` hangs the first one up before dialling.
   */
  private probe(): void {
    if (this.closedByUs || this.stopped || !this.credentials) return
    // Nothing in hand is the easy case, and the one this always handled.
    if (!this.linkInHand()) {
      this.wake()
      return
    }
    // A socket sitting in CONNECTING is the one leg of a dial the event that
    // landed here may genuinely doom — `online` after a radio handover means
    // the route the handshake left on is gone. A young connect is left to
    // finish; a stuck one is abandoned and re-run at the network that exists
    // now. `dialCount` makes the abandonment safe: the older `open()` stands
    // down at its next await. Only this leg, deliberately: while `open()` is
    // still in its token or address fetches there is no socket yet, those
    // fetches carry their own eight-second aborts, and restarting them on
    // every focus or visibility flicker turned a slow honest sign-in into one
    // that never finished. See STUCK_DIAL_MS.
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      if (Date.now() - this.dialStartedAt > STUCK_DIAL_MS) {
        this.dropSocket()
        this.clearRetry()
        void this.open()
      }
      return
    }
    // A dial mid-fetch (no socket yet, `opening` true): nothing to prove and
    // nothing worth abandoning — see above.
    if (this.socket?.readyState !== WebSocket.OPEN) return
    // Bytes arrived a moment ago, so there is nothing to prove and no reason to
    // spend a round trip proving it. This is the common path: `focus` fires on
    // every click back into the window, against a link that is plainly fine.
    if (Date.now() - this.lastFrameAt < PROBE_MS) return
    this.challenge()
  }

  /** One immediate re-dial, if there is anything to dial and nothing live. */
  private wake(): void {
    if (this.closedByUs || this.stopped || !this.credentials) return
    if (this.linkInHand()) return
    // A wait the *desktop* asked for is a sentence, not a backoff, and no
    // amount of tapping back into the tab commutes it: every `focus` and
    // `visibilitychange` lands here, and before this floor each one redialled
    // straight into a desktop that had said "try again in sixty seconds" —
    // a phone hammering a lockout it could only wait out. The page's own
    // backoffs never set the floor; see `scheduleRetry`.
    if (Date.now() < this.retryFloor) return
    this.clearRetry()
    void this.open()
  }

  /**
   * The person's own gesture as a liveness test.
   *
   * The beat bounds how long a swallowed link sits unnoticed at one heartbeat,
   * but a beat is still up to twenty seconds of somebody typing into a socket
   * that stopped carrying bytes while the tab was away — the one stretch where
   * "nothing appears" reads as broken rather than as waiting. So the two things
   * a returning hand does first — send a line, ask for something — start the
   * same challenge the wake-ups do, and a link that cannot answer is hung up on
   * within PROBE_MS of the keystroke instead of within a beat of it. Cheap on
   * every other path: a link that heard something recently asks nothing.
   */
  private probeIfStale(): void {
    if (this.closedByUs || this.stopped || !this.admitted) return
    if (Date.now() - this.lastFrameAt < PROBE_MS) return
    this.challenge()
  }

  /**
   * Ask the link to prove it is alive, and hang up on it if it will not.
   *
   * Zeroing `pingedAt` before asking is what makes this a test rather than an
   * inference: at the deadline, a non-zero `pingedAt` means no frame of any
   * kind has arrived since the question went out, which is the definition of a
   * socket that is no longer carrying anything. Whatever went unanswered before
   * now is discarded on purpose — a ping that expired while this tab was
   * throttled in the background says nothing about a link nobody was listening
   * to, and treating it as evidence would drop a perfectly good connection
   * every time somebody came back to the tab.
   *
   * Both callers come through here: the wake-ups above, and every beat. That is
   * deliberate — one mechanism and one tolerance, and a link that dies while
   * somebody is sitting watching it is noticed a beat and a probe later rather
   * than whenever the operating system next has an opinion.
   */
  private challenge(): void {
    // Before the early returns below, so that every ask — beat, wake-up,
    // keystroke — also audits what the link was told, whether or not a probe
    // is already outstanding. An unanswered attach is a fact about the link
    // that a ping answering perfectly does not repair.
    this.auditPendingReplay()
    if (!this.admitted || this.socket?.readyState !== WebSocket.OPEN) return
    // A question is already outstanding; its deadline answers this one too.
    if (this.probeTimer !== null) return
    this.pingedAt = 0
    if (!this.send({ type: 'ping' })) {
      // The socket would not take a frame, which settles it without waiting.
      this.declareDead()
      return
    }
    this.pingedAt = Date.now()
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null
      if (!this.admitted || this.pingedAt === 0) return
      this.strikes += 1
      // A slow answer is not a dead link. Ask once more before giving up on it;
      // a socket that is really gone fails this one just the same.
      if (this.strikes < PROBE_STRIKES) this.challenge()
      else this.declareDead()
    }, PROBE_MS)
  }

  /**
   * The link in hand is a corpse. Bury it and dial.
   *
   * `dropSocket` takes the old socket's handlers away before closing it, so no
   * `onclose` arrives to arm a retry behind this one — which is why the dial
   * happens here rather than being left to the close path.
   *
   * The `attempt` floor is the point of the exercise. A dead socket found on a
   * wake-up is overwhelmingly a machine that has been away a while, and the
   * thing most likely to have changed while it was away is the desktop's
   * address. `open` only consults `refindUrl` on a re-connect, so dialling this
   * one as attempt zero would spend a whole round trip failing against a tunnel
   * hostname that stopped existing hours ago before it thought to ask where the
   * desktop actually is.
   */
  private declareDead(): void {
    this.dropSocket()
    this.attempt = Math.max(this.attempt, 1)
    this.clearRetry()
    void this.open()
  }

  /**
   * Is a link already in hand, or on its way?
   *
   * The one question every re-dial path asks, written once because the answer
   * has two halves and a caller that remembers only one of them opens a second
   * socket. The readyState covers a link that exists; `opening` covers the
   * stretch inside `open()` where it does not yet, which is where this went
   * wrong: a phone fires `online` and `visibilitychange` in bursts, each one
   * landing while the previous dial was still waiting on a token, each one
   * seeing a null socket and dialling again. The loser of that race was never
   * hung up on, so both sockets said `hello`, both were let in, both re-attached
   * every pane, and every byte the desktop pushed was written into the terminal
   * twice — which for a cursor-addressed redraw means the frame is repainted
   * below itself, forever.
   */
  private linkInHand(): boolean {
    if (this.opening) return true
    const ready = this.socket?.readyState
    return ready === WebSocket.OPEN || ready === WebSocket.CONNECTING
  }

  /* ------------------------------------------------------------- terminals */

  /**
   * Watch a pane, at the size this browser is reading it.
   *
   * The geometry is remembered rather than sent and forgotten, because
   * `WebAttachFrame`'s optional `cols`/`rows` are how the desktop knows to stand
   * down and follow the browser — and a reconnect that re-attached without them
   * would hand the pane back to whatever width the desk last set, mid-sentence.
   */
  attach(sessionId: string, size: { cols: number; rows: number } | null): void {
    this.subs.set(sessionId, size)
    this.sendAttach(sessionId, size)
  }

  /**
   * One `attach` frame, and the note that the desktop has now been told a size.
   *
   * Shared with the reconnect's re-arm loop rather than written twice, because
   * the two have to agree: `WebAttachFrame`'s optional `cols`/`rows` *are* a
   * resize — the desktop hands them straight to `GridOwners.noteWish` — so an
   * attach that carried a size while `told` stayed empty would be followed by
   * the browser's next fit sending that same size again as a `resize`. On the
   * desktop that redundant frame is a jiggle pair, a SIGWINCH and a full agent
   * repaint, on the heels of every single reconnect. A phone reconnects
   * constantly.
   */
  private sendAttach(sessionId: string, size: { cols: number; rows: number } | null): void {
    const sent = this.send({ type: 'attach', sessionId, ...(size ? { cols: size.cols, rows: size.rows } : {}) })
    if (sent && size) this.told.set(sessionId, { cols: size.cols, rows: size.rows })
    else this.told.delete(sessionId)
    // The receipt starts only when a frame actually left, and a re-attach
    // arriving while one is unanswered keeps the *older* clock: the question
    // is whether the desktop ever registered this pane, and a remount does
    // not un-ask it. Without this, toggling a pane often enough would push
    // the deadline out forever — the cure gesture silencing the tripwire.
    if (sent) this.pendingReplay.set(sessionId, Math.min(this.pendingReplay.get(sessionId) ?? Number.POSITIVE_INFINITY, Date.now()))
  }

  /**
   * The reconnect's re-arm, in waves of ATTACH_WAVE rather than one tick.
   *
   * Each later wave re-checks `subs` before sending: a pane detached between
   * waves must not be re-attached by a timer that outlived the intent.
   */
  private sendAttachWave(entries: Array<[string, { cols: number; rows: number } | null]>): void {
    const now = entries.slice(0, ATTACH_WAVE)
    for (const [sessionId, size] of now) this.sendAttach(sessionId, size)
    const rest = entries.slice(ATTACH_WAVE)
    if (!rest.length) return
    window.setTimeout(() => {
      this.sendAttachWave(rest.filter(([sessionId]) => this.subs.has(sessionId)))
    }, ATTACH_WAVE_MS)
  }

  detach(sessionId: string): void {
    this.told.delete(sessionId)
    this.pendingReplay.delete(sessionId)
    this.reAsked.delete(sessionId)
    if (!this.subs.delete(sessionId)) return
    this.send({ type: 'detach', sessionId })
  }

  /* ------------------------------------------------------------ transcripts */

  /**
   * Read a pane's conversation as well as its screen.
   *
   * Resolves with null when the desktop is reading it, and with a sentence
   * when it will not — which is the ordinary answer rather than the unhappy
   * one: most panes are not Claude panes, and a Claude pane that has not
   * spoken yet has written no file to tail. That answer is *not* retried. The
   * pane is forgotten instead, so no reconnect re-asks a question the desktop
   * has already said no to, and the caller shows the sentence and offers the
   * terminal.
   *
   * A link that could not carry the frame at all (`no-window`) is the one
   * failure that leaves the pane on the list, because nothing was asked and
   * nothing was answered: the reconnect's re-arm is what asks.
   */
  async watchTranscript(sessionId: string): Promise<string | null> {
    this.chats.add(sessionId)
    const result = await this.request({ kind: 'transcript-watch', sessionId })
    if (result.kind === 'ok') return null
    if (result.kind === 'failed' && result.code === 'no-window') return result.message
    this.chats.delete(sessionId)
    return result.kind === 'failed'
      ? result.message
      : 'The desktop answered that with something this page does not understand.'
  }

  /**
   * Stop reading it. The desktop answers `ok` whether or not this browser was
   * watching, so a caller tidying up need not know what either end believes —
   * but a tail left running on a `~/.claude` file for a view that has gone is
   * a watch nobody will ever stop, which is why every unmount sends this.
   */
  stopTranscript(sessionId: string): void {
    if (!this.chats.delete(sessionId)) return
    void this.request({ kind: 'transcript-stop', sessionId })
  }

  /**
   * Keystrokes.
   *
   * Held to MAX_WRITE_CHARS here as well as at the desktop, and refused with the
   * same sentence rather than sent to be refused: the client has already thrown
   * its draft away by the time this returns, so the person has to be told
   * nothing was typed, and a round trip to learn that is a round trip in which
   * they carried on typing.
   */
  write(sessionId: string, data: string): void {
    if (!data) return
    if (data.length > MAX_WRITE_CHARS) {
      this.handlers.onNotice(
        `That is longer than the ${MAX_WRITE_CHARS} characters one write may carry — nothing was typed.`
      )
      return
    }
    this.probeIfStale()
    // A link being re-dialled is not a reason to lose a keystroke, and neither
    // is a link whose liveness is still being decided: a socket the OS or a
    // tunnel has already given up on goes on saying `OPEN` and goes on
    // *accepting* frames, and what it accepted is never re-sent — the words
    // before the Enter were lost exactly when the person was mid-sentence. So
    // a keystroke that arrives while a probe is outstanding waits for the
    // probe's verdict: any frame back (see `receive`) sends it within a round
    // trip, and a dead link sends it after the re-dial, in the order typed.
    if (this.held.length || this.probeTimer !== null || !this.send({ type: 'write', sessionId, data })) {
      this.held.push({ sessionId, data, at: Date.now() })
      this.wake()
    }
  }

  /**
   * Type what was held while the link was down, now that it is back.
   *
   * Order is preserved, which matters: a draft is words then Enter as two
   * writes a beat apart, and sending the Enter first would send nothing. What
   * was held past WRITE_HOLD_MS is dropped and said so, once, rather than typed
   * into a pane that may have moved on.
   */
  private flushHeld(): void {
    if (!this.held.length) return
    const held = this.held
    this.held = []
    const now = Date.now()
    let dropped = 0
    for (const entry of held) {
      if (now - entry.at > WRITE_HOLD_MS || !this.send({ type: 'write', sessionId: entry.sessionId, data: entry.data })) {
        dropped += 1
      }
    }
    if (dropped) this.handlers.onNotice('The link was down too long — what you typed meanwhile was not sent.')
  }

  /**
   * "This is the size I am reading it at."
   *
   * The wish is recorded first and unconditionally, because `subs` is what a
   * reconnect re-attaches with and the newest wish is the one that should ride
   * along — including one formed while the socket was down, which is exactly
   * the case a phone rotating in a tunnel produces.
   *
   * What is *sent* is then filtered against `told`: a frame that would ask for
   * the grid the desktop has already been given on this socket asks for
   * nothing, and a frame that asks for nothing still costs a full agent
   * repaint. See `told`. This is a floor rather than the whole defence — the
   * fits upstream in lib/term.ts are where a redundant call is stopped from
   * being made at all — but it is the floor every path has to cross, which is
   * why it is here rather than only there.
   */
  resize(sessionId: string, cols: number, rows: number, again = false): void {
    if (this.subs.has(sessionId)) this.subs.set(sessionId, { cols, rows })
    const told = this.told.get(sessionId)
    // `again` is the caller saying the desktop's answer disagrees with what it
    // was told, so "already told" is exactly the frame that has to go out.
    if (!again && told && told.cols === cols && told.rows === rows) return
    // Recorded only if it actually went out. A `send` on a socket that is not
    // open is dropped in silence, and remembering that as something the desktop
    // knows would silence the frame that has to be sent when it comes back.
    if (!this.send({ type: 'resize', sessionId, cols, rows })) return
    this.told.set(sessionId, { cols, rows })
  }

  /**
   * Tell the desktop whether this tab is on screen.
   *
   * The page calls this on every `visibilitychange`; the client remembers the
   * answer (`reportedVisible`) and says it again once per beat for as long as
   * the link lives. The remembered value is also re-said the moment a fresh
   * link is admitted — see `hello-ok` — so a tab that was hidden when its
   * socket dropped arrives at the new one with its flag standing, rather than
   * silently clear until the first beat.
   */
  reportVisibility(visible: boolean): void {
    this.reportedVisible = visible
    if (this.admitted) void this.request({ kind: 'visibility', visible })
  }

  /* -------------------------------------------------------------- requests */

  /**
   * Everything that is a question rather than a stream, correlated by `rid`.
   *
   * Always settles: on the server's answer, on a socket that closed under it, or
   * on REQUEST_TIMEOUT_MS. A promise that can hang is a spinner that can hang.
   */
  request(body: WebRequest): Promise<WebResult> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ kind: 'failed', code: 'no-window', message: 'Not connected to the desktop.' })
    }
    this.probeIfStale()
    this.rid += 1
    const rid = `r${this.rid}`
    return new Promise<WebResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(rid)
        resolve({ kind: 'failed', code: 'failed', message: 'The desktop did not answer in time.' })
      }, REQUEST_TIMEOUT_MS)
      this.waiting.set(rid, { settle: resolve, timer })
      this.send({ type: 'request', rid, body })
    })
  }

  /**
   * One layout gesture. Resolves with the desktop's error sentence, or null when
   * it worked — never with a local mutation. See the header.
   */
  async layout(op: WebLayoutOp): Promise<string | null> {
    const result = await this.request({ kind: 'layout', op })
    if (result.kind === 'ok') return null
    if (result.kind === 'failed') return result.message
    return 'The desktop answered that layout request with something this page does not understand.'
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Dial the desktop. At most one of these is ever in flight; see `opening`.
   *
   * The whole body sits in a `try/finally` for that flag alone. There are five
   * ways out of here — signed out, a token that failed, a page that moved on
   * under either await, a constructor that threw, and the ordinary end — and a
   * flag cleared at each of them is a flag that will be left set the day a
   * sixth is added, which would wedge the reconnect loop shut for good.
   */
  private async open(): Promise<void> {
    const credentials = this.credentials
    if (!credentials || this.closedByUs || this.stopped) return

    const dial = ++this.dialCount
    this.opening = true
    try {
      this.dropSocket()
      this.handlers.onConnection({ state: 'connecting', attempt: this.attempt })

      let idToken: string
      try {
        idToken = await credentials.getToken(this.reauthed)
      } catch (err) {
        // A credential that is gone for good is the page's problem, not this
        // loop's: it hands back to sign-in rather than retrying against nothing.
        if (String(err instanceof Error ? err.message : err) === 'signed-out') {
          this.stopped = true
          this.handlers.onTokenRejected()
          return
        }
        this.scheduleRetry()
        return
      }
      // A token fetch is a network round trip, and the page may have moved on —
      // or a wake-up may have judged this dial stuck and started a fresh one,
      // which from here on speaks for the page; see STUCK_DIAL_MS.
      if (this.closedByUs || this.stopped || dial !== this.dialCount) return

      // Ask where the desktop is *now* before re-dialling where it was. See
      // `refindUrl`: the address a tunnel publishes does not survive the tunnel
      // restarting, and this loop would otherwise never learn that.
      if (this.attempt > 0 && credentials.refindUrl) {
        let fresh = ''
        try {
          fresh = await credentials.refindUrl()
        } catch {
          // A lookup that failed says nothing about the address in hand.
        }
        if (this.closedByUs || this.stopped || dial !== this.dialCount) return
        // Adopted without resetting `attempt`, which is not the obvious choice
        // and is the right one. A new address does look like a fresh start worth
        // a fresh backoff — but a cloudflared quick tunnel that is *flapping*
        // publishes a new hostname every time it comes up, so zeroing the counter
        // here meant every retry saw a new URL, took `BACKOFF[0]` again, and
        // strobed the page against a tunnel that was never up long enough to
        // reach. The backoff exists to survive exactly that, and a moving target
        // is not grounds to abandon it.
        if (fresh && fresh !== credentials.url) credentials.url = fresh
      }

      let socket: WebSocket
      try {
        // The subprotocol is the only field a browser's WebSocket constructor
        // controls, and it is how a version mismatch is refused during the
        // upgrade rather than after a hello round trip. See WEB_SUBPROTOCOL.
        socket = new WebSocket(credentials.url, WEB_SUBPROTOCOL)
      } catch {
        this.scheduleRetry()
        return
      }
      this.socket = socket
      // The stuck-dial clock times the handshake alone, so it starts here —
      // not at the top of `open()`, where it would also be counting the token
      // and address fetches a wake-up has no business abandoning.
      this.dialStartedAt = Date.now()
      // Stamped on the socket the moment it is adopted, and captured by every
      // handler below. See `generation`.
      const generation = (this.generation += 1)
      this.lastFrameAt = Date.now()
      this.pingedAt = 0

      // A socket that never opens has to be given up on by this page, because
      // the platform will not do it in any useful time. See CONNECT_TIMEOUT_MS.
      if (this.connectTimer !== null) clearTimeout(this.connectTimer)
      this.connectTimer = window.setTimeout(() => {
        this.connectTimer = null
        if (generation !== this.generation) return
        if (socket.readyState !== WebSocket.CONNECTING) return
        // `dropSocket` detaches the handlers, so the `onclose` that would
        // normally arm the next attempt never comes: this arms it instead.
        this.dropSocket()
        this.scheduleRetry()
      }, CONNECT_TIMEOUT_MS)

      /**
       * Has this socket been replaced since it was adopted? Then it is not this
       * link's voice any more and must not act: not on the terminal, not on the
       * reconnect loop, not on the watcher. It hangs itself up on the way out,
       * because a socket left listening is a socket the desktop is still
       * pushing bytes down.
       */
      const superseded = (): boolean => {
        if (generation === this.generation) return false
        this.retire(socket)
        return true
      }

      // Spent on this attempt and this attempt only, whatever comes of it — read
      // before `onopen` so a socket that never opens still burns the one-shot
      // rather than leaving a stale typed PIN to be replayed by the reconnect
      // loop. A previously-successful PIN may still ride along; see `pinForHello`.
      const pin = this.pinForHello()

      socket.onopen = () => {
        if (superseded()) return
        // Reached the desktop, so the dialling deadline has been met. What
        // happens to the `hello` from here is the handshake's business.
        if (this.connectTimer !== null) clearTimeout(this.connectTimer)
        this.connectTimer = null
        this.lastFrameAt = Date.now()
        // No ping until `hello-ok`. The desktop honours *nothing* but `hello`
        // before a browser has been let in — it answers anything else with an
        // `error` frame and closes the socket (see `handle` in
        // electron/web/server.ts) — so a beat started here would hang up on this
        // desktop while its answer to the `hello` was still being decided, which
        // on a machine that has to verify a token against Google's keys and then
        // run a PIN through scrypt is not a moment. The pre-`hello-ok` socket does
        // not need one: the *real* heartbeat is the native WebSocket ping, which
        // the browser answers in its network stack whether or not the page has
        // been admitted.
        this.sendFrame(socket, {
          type: 'hello',
          proto: WEB_PROTO,
          idToken,
          client: __WEB_CLIENT_VERSION__,
          deviceId: credentials.deviceId,
          deviceName: credentials.deviceName,
          // Omitted entirely rather than sent empty: the field is optional in the
          // protocol, the first `hello` of every sign-in carries no PIN by design,
          // and a desktop with none set should see a frame that looks exactly like
          // it always did.
          ...(pin ? { pin } : {})
        })
      }

      socket.onmessage = (event) => {
        // A frame from a superseded socket is dropped rather than handled. It
        // would otherwise be a `data` frame written into a terminal that has
        // already had the same bytes from the live socket, or a `hello-ok` that
        // re-attaches every pane a second time.
        if (superseded()) return
        this.receive(String(event.data))
      }

      socket.onclose = () => {
        // A superseded socket closing is the sound of it being tidied away, not
        // of this link dropping, so it arms no retry and tells nobody.
        if (superseded()) return
        this.socket = null
        this.stopBeating()
        // Nothing has been told to anybody down a socket that has closed. The
        // next connection re-establishes it from `subs`; see `told`. The same
        // is true of an attach receipt: it was a claim about *that* socket's
        // delivery, and no frame will ever answer it now.
        this.told.clear()
        this.pendingReplay.clear()
        this.failWaiting('The link to the desktop dropped before that answered.')
        // A watcher hears about it here rather than working it out from a picture
        // that stopped moving: a decoder holding a last frame looks exactly like a
        // desktop that is sitting still, and the two want different sentences. A
        // reconnect does not resume a watch — the desktop tore its capture down
        // with the socket — so this is an ending, not a pause.
        watcher?.onStop('The link to the desktop dropped, so the picture stopped.', false)
        if (this.closedByUs || this.stopped) return
        this.scheduleRetry()
      }

      socket.onerror = () => {
        if (superseded()) return
        /* onclose always follows; retrying is decided there */
      }
    } finally {
      this.opening = false
    }
  }

  private receive(raw: string): void {
    // Before parsing and whatever the frame turns out to be: bytes arriving
    // *are* the warmth signal, including the `pong` that exists for no other
    // reason. They are also the answer to any outstanding `challenge` — any
    // frame will do, because what is being tested is whether the socket is
    // still carrying anything at all, not whether the desktop is polite.
    this.lastFrameAt = Date.now()
    this.pingedAt = 0
    this.strikes = 0
    // The probe's question is answered, so its deadline comes down *now* — not
    // when it expires on its own. Leaving the timer to run out kept `write`'s
    // hold gate closed for the rest of PROBE_MS after every answered challenge,
    // and with a beat every CLIENT_BEAT_MS that was most of the time: typing
    // on a quiet pane arrived in round-trip-sized clumps instead of as typed.
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
    // And they are the all-clear for anything held against the link's verdict:
    // a keystroke held while a probe was outstanding (see `write`) is sent
    // within the same round trip that proved the link, in the order typed.
    // Only once admitted — the frames that arrive before `hello-ok` prove the
    // socket, but this browser has not been let in yet, and a write sent now
    // would be the bad frame that hangs the fresh link up.
    if (this.admitted) this.flushHeld()

    let frame: WebServerFrame
    try {
      frame = JSON.parse(raw) as WebServerFrame
    } catch {
      return
    }

    switch (frame.type) {
      case 'hello-ok': {
        this.attempt = 0
        this.reauthed = false
        this.reAsked.clear()
        if (this.sentPin) this.rememberedPin = this.sentPin
        this.sentPin = ''
        this.handlers.onPicture(frame)
        this.handlers.onConnection({ state: 'live', desktopName: frame.desktopName, appVersion: frame.appVersion })
        // Both timers start here rather than at `onopen`, because this frame is
        // the first moment the desktop will accept a frame that is not `hello`.
        this.startBeating()
        this.startRefreshing()
        // Re-arm every pane the UI still believes it is watching. Each answers
        // with a replay frame, which is what repaints the terminal — and each
        // re-establishes what this browser has told the desktop about its size,
        // which `dropSocket` voided on the way into this connection. In waves
        // rather than one tick: a split-heavy workspace can hold more panes
        // than a desktop's per-second frame budget, and the burst must stay
        // correct against any desktop, not only one that exempts `attach` —
        // spacing the replies also keeps up to 192KB-per-pane repaints from
        // landing on a phone as one wall.
        this.sendAttachWave([...this.subs])
        // And every conversation this page is reading, for the same reason one
        // step over: the desktop ends each of its transcript tails with the
        // socket that asked for it (`stopTranscripts` in electron/web/server.ts),
        // so a fresh link starts out watching nothing at all. Each is answered
        // with a fresh `reset` snapshot, which the view replaces what it holds
        // with — see shared/chat.ts — so a re-arm cannot double a transcript
        // the way a second attach would double a terminal. A copy of the set,
        // because a pane the desktop no longer has a conversation for is
        // dropped from it by the answer.
        for (const sessionId of [...this.chats]) void this.watchTranscript(sessionId)
        this.flushHeld()
        // The new socket starts from whatever the desktop last heard about
        // this tab, which is nothing: state the flag now rather than waiting
        // out a beat, so a tab that was hidden when its old socket dropped
        // does not spend up to HEARTBEAT_MS being sent bytes it will bank as
        // stale anyway. Harmless when the page has never said (null).
        if (this.reportedVisible !== null) void this.request({ kind: 'visibility', visible: this.reportedVisible })
        return
      }

      case 'refused':
        this.onRefused(frame.reason, typeof frame.message === 'string' ? frame.message : '', frame.retryAfterMs)
        return

      case 'replay':
        // The answer to an `attach`. Whatever else it repaints, it is the
        // receipt that proves that attach landed.
        this.pendingReplay.delete(frame.sessionId)
        this.reAsked.delete(frame.sessionId)
        this.handlers.onData(frame.sessionId, frame.data, true, frame.truncated === true)
        return

      case 'data':
        this.handlers.onData(frame.sessionId, frame.data, false, false)
        return

      case 'exit':
        this.subs.delete(frame.sessionId)
        this.told.delete(frame.sessionId)
        this.pendingReplay.delete(frame.sessionId)
        this.reAsked.delete(frame.sessionId)
        // A pane that has ended writes no more transcript, and the desktop has
        // already stopped its own tail (`pushExit` in electron/web/server.ts).
        // Left here it would be re-asked for on every reconnect, forever.
        this.chats.delete(frame.sessionId)
        this.handlers.onExit(frame.sessionId, typeof frame.exitCode === 'number' ? frame.exitCode : 0)
        return

      case 'sessions':
        this.handlers.onSessions(Array.isArray(frame.sessions) ? frame.sessions : [])
        return

      case 'session-started':
        this.handlers.onSessionStarted(frame.session)
        return

      case 'attention':
        this.handlers.onAttention(
          frame.sessionId,
          frame.asking === true,
          typeof frame.prompt === 'string' ? frame.prompt : ''
        )
        return

      case 'foreman':
        // Coerced, not trusted, for the same reason every handler here is: the
        // frame is typed but the wire is not. A malformed state is dropped
        // rather than handed to the store, which would draw a switch lit on a
        // pane nobody is driving.
        if (frame.state && typeof frame.state === 'object' && typeof frame.state.paneId === 'string') {
          this.handlers.onForeman(frame.state)
        }
        return

      case 'handoff':
        // Coerced, not trusted, like the frame above it. A list that is not a
        // list is dropped rather than handed to the store — a Handoff menu built
        // out of a malformed frame is a menu offering panes that do not exist.
        if (typeof frame.projectId === 'string' && Array.isArray(frame.records)) {
          this.handlers.onHandoff(frame.projectId, frame.records)
        }
        return

      case 'desktop':
        // Coerced like every handler here: the frame is typed and the wire is
        // not. Anything that is not one of the two known words is dropped
        // rather than shown, since the only thing a third word could do is
        // strand a banner on screen forever.
        if (frame.state === 'recovering' || frame.state === 'ready') {
          this.handlers.onDesktop(frame.state, typeof frame.reason === 'string' ? frame.reason : '')
        }
        return

      case 'projects':
        this.handlers.onProjects(Array.isArray(frame.projects) ? frame.projects : [])
        return

      case 'workspace':
        this.handlers.onWorkspace(frame.projectId, frame.workspace)
        return

      case 'git':
        this.handlers.onGit(frame.snapshot)
        return

      case 'transcript':
        this.handlers.onTranscript(frame.sessionId, frame.update)
        return

      case 'result': {
        const rid = typeof frame.rid === 'string' ? frame.rid : ''
        const waiting = this.waiting.get(rid)
        if (!waiting) return
        this.waiting.delete(rid)
        clearTimeout(waiting.timer)
        waiting.settle(frame.body)
        return
      }

      case 'shutdown': {
        // The cue to stop reconnecting rather than spend the next minute
        // retrying a machine that is off. Without this frame every shutdown
        // looks like a network fault.
        const reason = isWebShutdownReason(frame.reason) ? frame.reason : undefined
        this.stopped = true
        this.handlers.onConnection({
          state: 'offline',
          message: typeof frame.message === 'string' && frame.message ? frame.message : 'The desktop went away.',
          ...(reason ? { reason } : {}),
          ...(typeof frame.retryAfterMs === 'number' ? { retryAfterMs: frame.retryAfterMs } : {})
        })
        return
      }

      case 'error':
        // `limit` about a named pane is the desktop refusing that one frame
        // for budget, not doubting the link — and if the frame was an attach,
        // dropping it silently is a pane that never paints. Re-ask once the
        // budget's second has turned over, and say nothing: a frame the page
        // re-sends by itself is not news a person can act on.
        if (frame.code === 'limit' && typeof frame.sessionId === 'string' && this.subs.has(frame.sessionId)) {
          const sessionId = frame.sessionId
          window.setTimeout(() => {
            if (!this.subs.has(sessionId)) return
            this.pendingReplay.delete(sessionId)
            this.sendAttach(sessionId, this.subs.get(sessionId) ?? null)
          }, LIMIT_RETRY_MS)
          return
        }
        // `unknown-session` about a named pane is the desktop saying that pane
        // no longer exists, which is the same news as `exit` arriving by another
        // road — a pane closed at the desk while this browser was away never
        // gets an `exit`, because there was no socket to send it down. So it is
        // forgotten here too. Leaving it in `subs` meant re-attaching a dead
        // pane on every single reconnect and re-earning this notice each time,
        // for as long as the tab stayed open.
        if (frame.code === 'unknown-session' && typeof frame.sessionId === 'string') {
          this.subs.delete(frame.sessionId)
          this.told.delete(frame.sessionId)
          // The pane is gone, which is also the answer to its attach — the
          // only one it will ever get. Leaving the receipt standing would
          // have the beat hang a perfectly good link up over a closed pane.
          this.pendingReplay.delete(frame.sessionId)
          this.reAsked.delete(frame.sessionId)
          // Same news for the conversation as for the screen; see `exit`.
          this.chats.delete(frame.sessionId)
        }
        // Only `message` is meant to be shown; the codes exist so a client can
        // decide whether to retry or re-sync, not so it can compose a sentence.
        if (typeof frame.message === 'string' && frame.message) this.handlers.onNotice(frame.message)
        return

      /* --------------------------------------------------- screen mirror
       *
       * Straight to the surface that is watching, without passing through the
       * page's state — see the slot pair above. A frame arriving with nobody
       * watching is dropped in silence: it is the ordinary shape of a viewer
       * that closed while a chunk was in flight, and the desktop has already
       * been told to stop by the `mirror-stop` that closing sent.
       */

      case 'mirror-ok':
        watcher?.onOk(frame)
        return

      case 'mirror-frame':
        watcher?.onChunk(frame)
        return

      case 'mirror-stop':
        watcher?.onStop(
          typeof frame.reason === 'string' && frame.reason ? frame.reason : 'The desktop stopped sharing its screen.',
          frame.needsPin === true
        )
        return

      case 'pong':
        return
    }
  }

  /**
   * A refusal, routed by what it actually means. See `retryPolicy`.
   *
   * A value a newer desktop invented falls out here, at the edge, through
   * `isWebRefusal` — which is exactly the job shared/web.ts gives that guard.
   */
  private onRefused(rawReason: unknown, message: string, retryAfterMs?: number): void {
    if (!isWebRefusal(rawReason)) {
      this.stopped = true
      this.handlers.onConnection({
        state: 'refused',
        reason: 'proto',
        message: message || 'This desktop refused the connection for a reason this page is too old to understand.'
      })
      return
    }
    const reason = rawReason

    // Not a failure and not a shade of one: the desktop is asking a question,
    // and the screen it earns is a text box rather than an apology. Handled
    // ahead of the retry table because the answer comes from a person, so there
    // is nothing for the loop to schedule until `submitPin` is called.
    if (reason === 'pin-required' || reason === 'pin-invalid') {
      this.stopped = true
      // A wrong PIN must not be replayed — each replay is a strike. A missing
      // PIN is the ordinary first ask and leaves `rememberedPin` empty anyway.
      if (reason === 'pin-invalid') this.forgetPin()
      // A lockout that arrives on the pin path still carries its window, and
      // the pin screen is where the countdown belongs — see PinPrompt.
      this.handlers.onConnection({
        state: 'pin',
        message,
        invalid: reason === 'pin-invalid',
        ...(retryAfterMs ? { retryAfterMs } : {})
      })
      return
    }

    const policy = retryPolicy(reason)

    if (policy.kind === 'reauth' && !this.reauthed) {
      // One silent re-authentication. A second `bad-token` in a row means the
      // credential is not going to verify, and looping on it would be a page
      // that never says "sign in again".
      this.reauthed = true
      this.attempt = 0
      this.scheduleRetry(0)
      return
    }

    if (policy.kind === 'reauth') {
      this.stopped = true
      this.handlers.onTokenRejected()
      this.handlers.onConnection({ state: 'refused', reason, message })
      return
    }

    if (policy.kind === 'after') {
      this.handlers.onConnection({ state: 'refused', reason, message, ...(retryAfterMs ? { retryAfterMs } : {}) })
      // Silently, or the refusal is erased by the thing that acts on it:
      // `scheduleRetry` announces `connecting` the instant it is called, in the
      // same React batch, so the screen that carries the desktop's sentence and
      // the "worth trying again in 60s" line never rendered at all. What was
      // shown instead was a rising attempt count against a desktop that had
      // just said, in words, what was wrong with it. The `connecting` screen
      // still arrives — from `open`, when the wait is actually up.
      this.scheduleRetry(retryAfterMs, false)
      return
    }

    this.stopped = true
    this.handlers.onConnection({ state: 'refused', reason, message, ...(retryAfterMs ? { retryAfterMs } : {}) })
  }

  /**
   * `announce` is false only where the caller has just put a *better* screen up
   * — see the `after` branch of `onRefused`. It does not change what the loop
   * does, only whether it overwrites a sentence somebody needs to read.
   */
  private scheduleRetry(waitMs?: number, announce = true): void {
    if (this.closedByUs || this.stopped || this.retryTimer !== null) return
    let wait = waitMs ?? BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!
    // A tab somebody is looking at never sits the full fifteen seconds between
    // tries; a hidden one still can, and should — nobody is waiting, and it is
    // a phone battery paying for the dials. The refusal wait (`waitMs`, the
    // desktop's own "try again in 60s") is never shortened: that one is a
    // sentence from the other end, not a backoff.
    if (waitMs === undefined && document.visibilityState === 'visible') wait = Math.min(wait, 8_000)
    // A desktop-issued wait also sets the floor `wake` respects, so a focus or
    // visibility event cannot turn a lockout into a redial storm.
    if (waitMs !== undefined) this.retryFloor = Date.now() + wait
    this.attempt += 1
    if (announce) this.handlers.onConnection({ state: 'connecting', attempt: this.attempt })
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.open()
    }, wait)
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /**
   * The page's own warmth ping. Not the heartbeat — that is the server's native
   * WebSocket ping, which this browser answers in its network stack. See
   * HEARTBEAT_MS and the note on WARM_MS.
   *
   * Each beat is a `challenge` rather than a bare `ping`, so the answer is
   * waited on instead of merely hoped for. That is what makes this a heartbeat
   * in the sense that matters: a link that stops answering is hung up on and
   * re-dialled within a beat and a probe, rather than sitting there reading
   * `OPEN` until the browser's own TCP timeout notices, which is minutes.
   */
  private startBeating(): void {
    this.stopBeating()
    this.admitted = true
    this.beatTimer = window.setInterval(() => this.beat(), CLIENT_BEAT_MS)
  }

  /**
   * One beat of a live link: prove it, and re-assert what it was told.
   *
   * The `challenge` half is the heartbeat this class has always had. The two
   * halves after it exist because proving the link is not the same as proving
   * what travelled down it: both are re-statements of state the desktop can
   * hold wrongly if the one frame that carried it was eaten by an open-but-
   * dying tunnel.
   *
   *  - `reportedVisible` is said again, because a lost visibility report left
   *    the desktop withholding every pane from a tab that was looking straight
   *    at it. Idempotent, twenty bytes, no repaint.
   *
   *  - `pendingReplay` is audited, because a lost attach left the desktop with
   *    no subscription at all — the same starvation, one cause deeper. A first
   *    breach re-asks; a second hangs the link up: see REPLAY_GRACE_MS.
   *
   *  - the visibility answer's `sessions` ledger is reconciled against `subs`,
   *    so a subscription the desktop lost by any road at all is re-asked
   *    within a beat.
   */
  private beat(): void {
    this.challenge()
    if (!this.admitted) return
    if (this.reportedVisible !== null) {
      void this.request({ kind: 'visibility', visible: this.reportedVisible }).then((result) => {
        // The answer carries the desktop's half of the subscription ledger —
        // see `sessions` on WebResult. Absent on an older desktop, which is
        // "no news", never "no sessions". Any pane this page believes it is
        // watching that the desktop is not streaming had its attach lost
        // somewhere neither end can see, and is re-asked here — the one check
        // that makes every lost-attach failure heal in a beat instead of
        // never. Panes with an attach honestly in flight are left alone;
        // the receipt audit remains the backstop for those.
        if (result.kind !== 'ok' || !Array.isArray(result.sessions)) return
        const streaming = new Set(result.sessions)
        const now = Date.now()
        for (const [sessionId, size] of this.subs) {
          if (streaming.has(sessionId)) continue
          const askedAt = this.pendingReplay.get(sessionId)
          if (askedAt !== undefined && now - askedAt < ATTACH_SETTLE_MS) continue
          // The desktop has answered the receipt's question out loud: it never
          // registered this pane. Restart the clock with the fresh ask.
          this.pendingReplay.delete(sessionId)
          this.sendAttach(sessionId, size)
        }
      })
    }
  }

  /**
   * Hang the link up if any `attach` has waited past REPLAY_GRACE_MS for the
   * `replay` that answers it. Called from every path that asks the link to
   * prove itself — the beat, the wake-ups, a keystroke — so the wait is bound
   * by how often the page asks, not by the beat alone.
   */
  private auditPendingReplay(): void {
    if (!this.pendingReplay.size) return
    const now = Date.now()
    for (const [sessionId, sentAt] of this.pendingReplay) {
      if (now - sentAt <= REPLAY_GRACE_MS) continue
      // First breach: re-ask, once. The receipt's clock restarts with the
      // fresh frame — the delete before the send is what lets it — so the
      // second verdict is about the re-ask, not about time already served.
      if (!this.reAsked.has(sessionId)) {
        this.reAsked.add(sessionId)
        this.pendingReplay.delete(sessionId)
        this.sendAttach(sessionId, this.subs.get(sessionId) ?? null)
        continue
      }
      // Second breach for the same pane: the link itself is the suspect.
      this.declareDead()
      return
    }
  }

  /**
   * Stand the link's timers down.
   *
   * Called from the two places a connection ends — `onclose` and `dropSocket` —
   * and from `startBeating` re-arming, which is why every piece of per-socket
   * liveness state is cleared here rather than at each of those call sites. A
   * `pingedAt` or an armed probe left over from the last socket would be read
   * as evidence about the next one.
   */
  private stopBeating(): void {
    if (this.beatTimer !== null) clearInterval(this.beatTimer)
    this.beatTimer = null
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    if (this.probeTimer !== null) clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.strikes = 0
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
    this.pingedAt = 0
    this.admitted = false
  }

  /**
   * Present a fresh ID token before the old one lapses.
   *
   * Firebase mints them with an hour's life and this link is meant to stay up
   * for a working day, so the credential is re-presented mid-connection rather
   * than only at `hello` (TOKEN_REFRESH_MS). A failure is not fatal here: the
   * desktop refuses a lapsed token with `bad-token` and the refusal path above
   * re-authenticates, which is one route rather than two.
   */
  private startRefreshing(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = window.setInterval(() => {
      const credentials = this.credentials
      if (!credentials) return
      void credentials
        .getToken(false)
        .then((idToken) => {
          this.rid += 1
          this.send({ type: 'auth', rid: `a${this.rid}`, idToken })
        })
        .catch(() => {
          /* the desktop will refuse the lapsed one, and that path re-authenticates */
        })
    }, TOKEN_REFRESH_MS)
  }

  /**
   * Returns whether the frame actually left, which most callers rightly ignore:
   * this link's answer to a socket that is not open is to say nothing and let
   * the reconnect re-establish the picture. `resize` is the exception, because
   * it keeps a memory of what the desktop has been told and a memory of an
   * unsent frame is worse than no memory at all.
   */
  private send(frame: WebClientFrame): boolean {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return false
    return this.sendFrame(socket, frame)
  }

  private sendFrame(socket: WebSocket, frame: WebClientFrame): boolean {
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      /* a dead socket is closed by its own close handler */
      return false
    }
  }

  /**
   * Finish with the current socket without letting it act on the way out.
   *
   * Handlers detached before `close()`, so a half-open socket cannot fire a late
   * `onclose` into a link that has already moved on and arm a second retry
   * behind it — the same care, for the same reason, as mobile's `dropSocket`.
   */
  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    this.stopBeating()
    // Whatever the next socket is, it starts out having been told nothing —
    // and the size it will be told is the one the re-`attach` carries. See
    // `told`. The receipts go with them, for the same reason: they were about
    // this socket's delivery, and this socket is being retired.
    this.told.clear()
    this.pendingReplay.clear()
    if (!socket) return
    this.retire(socket)
  }

  /**
   * Hang up on one socket and take its voice away, wherever it was found.
   *
   * The body of `dropSocket`, split out because a socket that discovers it has
   * been superseded needs exactly this and is by definition no longer
   * `this.socket`, so it cannot go through `dropSocket` to get it. One hang-up
   * in the file rather than two that have to be kept saying the same thing.
   */
  private retire(socket: WebSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close()
    } catch {
      /* already gone */
    }
  }

  /** Settle everything still waiting on a `rid`, because nothing is coming. */
  private failWaiting(message: string): void {
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.settle({ kind: 'failed', code: 'failed', message })
    }
    this.waiting.clear()
  }
}

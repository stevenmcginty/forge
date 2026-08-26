import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Notification,
  powerSaveBlocker,
  screen,
  type DesktopCapturerSource
} from 'electron'
import { IPC } from '@shared/ipc'
import {
  ACCEPT_WINDOW_MS,
  APPROVAL_TIMEOUT_MS,
  MOBILE_DISCOVERY_PORT,
  MOBILE_PORT,
  pairLink,
  type HelloOkFrame,
  type MirrorInput,
  type OpFrame
} from '@shared/mobile'
import type {
  ForgeTvStatus,
  MobileApprovalEvent,
  MobileDeviceRecord,
  MobileMirrorEvent,
  MobilePreviewOffer,
  MobileStatus,
  MobileTunnelStatus,
  MobileWatchEvent,
  Settings
} from '@shared/types'
import { MobileAuth, PAIR_TTL_MS } from './mobile/auth'
import { DiscoveryResponder } from './mobile/discovery'
import { canDriveDesktop, driveDesktop, stopDesktopInput } from './mobile/input'
import { MobileServer, TV_APK_PATH, type MobileApprovalAsk } from './mobile/server'
import { foremanList, foremanStart, foremanSay, foremanStop, onForemanState } from './foreman/ipc'
import { NgrokTunnel, ensureNgrokExe, pairEndpoint, resolveNgrokExe } from './mobile-tunnel'
import {
  disposeTvBuild,
  fetchTv,
  onTvBuildChange,
  reportTvProblem,
  startTvBuild,
  tvApkPath,
  tvBuildState
} from './mobile-tv'
import { addPtySink, getManager, getReplay, killPane, viewerGone, viewerResize, viewerWrite } from './pty-host'
import { UNSUPPORTED, layoutEngine } from './layout-engine'
import { getDataDir, getProjects, getSettings, getWorkspace, setSettings } from './store'

/**
 * Forge Mobile — the Electron half.
 *
 * Everything Electron-shaped lives here so `electron/mobile/server.ts` and
 * `electron/mobile/auth.ts` stay injectable and head-lessly testable, the same
 * split `companion-host.ts` / `companion-sync.ts` uses.
 *
 * Three jobs:
 *
 *  1. Own the server's lifecycle against `mobileEnabled`.
 *  2. Feed it PTY output, by registering a sink on `pty-host` rather than
 *     opening a second route to node-pty. A phone therefore sees exactly the
 *     bytes the window sees, coalesced by the same 12ms flush.
 *  3. Perform a phone's `op` frame. Tabs and panes used to be the renderer's
 *     to own, and this waited on it; they are the main process's now
 *     (electron/layout-engine.ts), because a renderer that has crashed or hung
 *     must not be able to strand a phone that is nowhere near the desk. There
 *     is still exactly one split tree and one workspace file — the renderer
 *     follows what main did rather than doing it a second time.
 *  4. Ask the human. When a credential-less phone requests to pair (and only
 *     while "Accept new phones" is armed), the server's question becomes a
 *     renderer prompt here, by the same request/response shape as the ops —
 *     and every outcome that is not an explicit Allow is a deny.
 */

let server: MobileServer | null = null
let auth: MobileAuth | null = null
/**
 * The "is there a Forge here?" responder, up for exactly as long as the server
 * is. It exists so a television — which has a remote and no keyboard, and in a
 * shared build has no address baked into it — can find this desktop by asking
 * the network instead of being typed at. See electron/mobile/discovery.ts.
 */
let discovery: DiscoveryResponder | null = null
let unsubscribePty: (() => void) | null = null
/**
 * Foreman's state pushes, fanned out to every connected phone for as long as
 * the link is up. The web link holds an identical subscription — one host, two
 * doors — and both are taken down in `stop()` so a push never lands in a
 * server that has gone.
 */
let unsubscribeForeman: (() => void) | null = null
let lastDetail = ''
let starting = false
/**
 * Bumped by every `stop()`, read by every in-flight `start()` when its port
 * bind resolves. Without it, a stop() that lands while `start()` is still
 * awaiting sees `server === null`, returns — and the awaited start then assigns
 * the server anyway, so the link comes up a moment *after* the person at the
 * desk switched it off. The epoch is the start-token: stop invalidates, start
 * re-checks before committing.
 */
let startEpoch = 0

/**
 * The ngrok tunnel rides the server's lifecycle: started after the server is
 * up (a tunnel to a port nothing listens on is a lie in the status panel),
 * stopped before the server, disposed with it. Its status is folded into
 * mobileStatus() and rides the same broadcast — one event stream, on purpose.
 */
const TUNNEL_OFF: MobileTunnelStatus = { state: 'off', url: '', detail: '' }
let tunnel: NgrokTunnel | null = null
let tunnelStatus: MobileTunnelStatus = TUNNEL_OFF
let tunnelStarting = false

/**
 * Held while at least one phone is connected, so Windows does not suspend the
 * app mid-session and drop every socket. Released the moment the last phone
 * goes, because a desktop that never sleeps because of a link nobody is using
 * is a bug, not a feature.
 */
let blockerId = 0

/* ------------------------------------------------- one PTY, several viewers
 *
 * A pane on the desktop and the same pane on a phone are the same ConPTY, and
 * a ConPTY has one width. Both ends used to fit it to their own box, so
 * whichever moved last won — and the desktop moves on every layout change,
 * which meant a phone reading a pane from a train would silently have the
 * width dragged back to the desktop's, and everything after that was wrapped
 * for a screen it was not being read on.
 *
 * That was settled the phone's way for a long time: while a phone had a pane
 * open the phone owned its geometry, and the desktop letterboxed its own
 * terminal to match. Steve rejected it, and rightly — plugging a device in must
 * not change the resolution at the desk, and every pane on the machine
 * somebody is working at re-flowing because a phone came out of a pocket is
 * precisely that.
 *
 * The correction after that was to hand the grid to the desk outright whenever
 * it had a window, and it went too far the other way: a phone then drew a
 * desktop-width grid at a font small enough to fit a handset, which is a
 * 200-column terminal at 7px and unreadable. Rejected in its turn.
 *
 * So the rule is now neither device's by default. **The grid belongs to the
 * device somebody last typed into the pane on.** Type on the phone and the
 * phone's `cols`/`rows` land on the real PTY — native, at a width a handset can
 * read — and every other viewer, this desktop's renderer included, draws that
 * grid font-scaled into its own box. Sit down at the desk and type, and the desk
 * has it back on the first keystroke. Taking the phone out and looking at it
 * moves nothing.
 *
 * The policy itself is electron/pty/grid-owner.ts, reached through
 * `viewerWrite` / `viewerResize` / `viewerGone` on electron/pty-host.ts; this
 * file supplies nothing but the viewer's name. Forge Web's link is wired
 * identically — see the block of the same name in electron/web-host.ts — so the
 * two links answer the question with the same code rather than with two copies
 * of the same paragraph.
 *
 * What the renderer is still told separately is *which* panes a phone is reading
 * (mobileWatched), because "ON PHONE" on a pane header is honest and useful.
 * That message stays ids-only: reading is not typing.
 */

/** Session ids at least one phone currently has open. */
let watched = new Set<string>()

/**
 * How long a PTY resize waits before the session list is pushed again.
 *
 * Whoever owns a pane's grid, every phone that is not that owner is drawing a
 * shape it did not choose — so every move is news it has to hear. Bursts are the
 * normal case: a window drag, a split or a tab switch at the desk moves several
 * panes at once, and a granted remote wish is itself two resizes 60ms apart (the
 * repaint jiggle in electron/pty-host.ts). Long enough to make one message out
 * of a burst, short enough that a phone is never drawing last second's geometry.
 */
const GEOMETRY_PUSH_MS = 80
let geometryPush: NodeJS.Timeout | null = null

/**
 * Tell the renderer which panes a phone is reading.
 *
 * Ids and nothing else, and that is not an accident of history: a size *does*
 * reach the renderer now, but on `IPC.ptyGeometry` and only when somebody has
 * typed into the pane from away. Reading is not typing, so this message must
 * stay what it is — a label — or glancing at a pane would move it after all.
 */
function publishWatched(): void {
  broadcast(IPC.mobileWatched, { ids: [...watched] } satisfies MobileWatchEvent)
}

function getAuth(): MobileAuth {
  if (!auth) {
    auth = new MobileAuth({
      load: () => getSettings().mobileDevices,
      save: (devices) => {
        setSettings({ mobileDevices: devices })
      }
    })
  }
  return auth
}

/* --------------------------------------------------------------- reporting */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * The addresses a phone can actually reach this machine on.
 *
 * "It is listening" does not answer "what do I type into my phone", and
 * `0.0.0.0` is not an address anyone can dial. Tailscale's 100.64/10 addresses
 * are listed first, because if one exists it is the one that works away from
 * home — which is the entire point of this feature.
 */
export function reachableAddresses(): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      found.push(net.address)
    }
  }
  return [...found.filter(isTailnet), ...found.filter((ip) => !isTailnet(ip))]
}

/** 100.64.0.0/10 — the CGNAT range Tailscale allocates from. */
function isTailnet(ip: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
}

export function mobileStatus(): MobileStatus {
  const settings = getSettings()
  const address = server?.address() ?? null
  return {
    enabled: settings.mobileEnabled,
    state: !settings.mobileEnabled ? 'off' : starting ? 'starting' : address ? 'listening' : 'error',
    host: address?.host ?? settings.mobileBindHost,
    port: address?.port ?? settings.mobilePort,
    addresses: address ? reachableAddresses() : [],
    devices: settings.mobileDevices,
    web: !!mobileWebRoot(),
    connected: server?.connectedCount ?? 0,
    acceptUntil: armedUntil(),
    detail: lastDetail,
    tunnel: tunnelStatus
  }
}

function report(detail?: string): void {
  if (detail !== undefined) lastDetail = detail
  broadcast(IPC.mobileStatusEvent, mobileStatus())
}

/* ------------------------------------------------------------- forge tv
 *
 * The Fire TV APK. electron/mobile-tv.ts runs the build and owns its phase;
 * everything here is the half that needs the server: which address a
 * television can dial, and serving the finished file on it.
 */

/**
 * The origin baked into the TV APK, and the one it downloads itself from.
 *
 * `reachableAddresses()` puts the tailnet first, which is the right answer for
 * a phone — a 100.x address keeps working from a train. It is the wrong answer
 * for a television: the TV is on the same router, is not on the tailnet, and an
 * address it cannot reach would be baked into a signed APK and only fail on the
 * far side of the room. Ordinary LAN first here; the tailnet only if there is
 * nothing else at all.
 *
 * '' while the link is not listening, because the port in this URL is the one
 * the server actually bound — an address for a server that is off is a URL that
 * would be typed into a TV with a remote and then not answer.
 */
function tvOrigin(): string {
  const address = server?.address()
  if (!address) return ''
  const found = reachableAddresses()
  const lan = found.find((ip) => !isTailnet(ip)) ?? found[0]
  return lan ? `http://${lan}:${address.port}` : ''
}

function forgeTvStatus(): ForgeTvStatus {
  const origin = tvOrigin()
  return { ...tvBuildState(), url: origin ? `${origin}${TV_APK_PATH}` : '' }
}

function reportTv(): void {
  broadcast(IPC.mobileTvStatusEvent, forgeTvStatus())
}

/* ------------------------------------------------------------ op dispatch */

interface PendingOp {
  resolve: (error: string | null) => void
  timer: NodeJS.Timeout
}

const pendingOps = new Map<string, PendingOp>()
/** A renderer that never answers must not leave a phone waiting forever. */
const OP_TIMEOUT_MS = 8000

/**
 * Perform one layout operation, in main, against the authoritative layout.
 *
 * Returns an error sentence, or null on success. It used to hand the frame to
 * the renderer and wait up to eight seconds for a verdict, which made "Forge
 * has no window open" a real answer a phone got — and, worse, made a window
 * that was merely *hung* look exactly the same. electron/layout-engine.ts holds
 * the split tree now, so a tab closes for a phone whether or not anything at
 * the desk is drawing it; the renderer is told afterwards (see
 * `saveRemoteWorkspace` in electron/main.ts). The old path stays below as the
 * fallback for a verb the engine does not answer — of the phone's four, none —
 * and for the case where main has not installed an engine at all.
 *
 * The phone's `foreman-start`/`foreman-stop` never reach here: the mobile
 * server answers those itself, before this.
 */
async function dispatchOp(op: OpFrame, deviceName: string): Promise<string | null> {
  const engine = layoutEngine()
  if (engine) {
    const result = engine.apply(op.projectId, op)
    if (result.ok) {
      // Killed from here rather than left to the renderer, for the same reason
      // the op was performed here: the renderer might not be there.
      for (const paneId of result.killed) killPane(paneId)
      return null
    }
    if (result.error !== UNSUPPORTED) return result.error
  }

  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.length === 0) return 'Forge has no window open on the desktop, so it cannot change tabs.'

  const requestId = randomUUID()
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingOps.delete(requestId)
      resolve('The desktop did not answer in time.')
    }, OP_TIMEOUT_MS)
    pendingOps.set(requestId, { resolve, timer })
    windows[0].webContents.send(IPC.mobileCommand, { requestId, op, deviceName })
  })
}

/* --------------------------------------------------------- screen mirror
 *
 * The television watching this desktop's own screen. Nothing about WebRTC lives
 * in the main process — it has no peer connection to make an offer with — so
 * this is a pass-through in both directions: the server's hooks become a
 * message to the window, and the window's replies become frames on the socket.
 *
 * Unlike dispatchOp there is no request/response pair and no pending map. A
 * mirror is a stream, not a question: the renderer answers by pushing signals
 * back over `mobileMirrorSignal` for as long as it has any, and says it is over
 * on `mobileMirrorStop`. The renderer half is src/lib/mirror.ts.
 */

/** The window the mirror runs in, or null when Forge has none open. */
function mirrorWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return windows[0] ?? null
}

function sendMirror(event: MobileMirrorEvent): void {
  mirrorWindow()?.webContents.send(IPC.mobileMirror, event)
}

/**
 * Begin a mirror, or say why not.
 *
 * The one failure worth naming here is dispatchOp's: the capture runs in the
 * renderer, so a Forge with its window closed cannot share its screen at all.
 * Minimised is fine — a minimised window still captures. Everything that can
 * only be discovered once capture is attempted (a refused permission, no screen
 * to name) comes back later on `mobileMirrorStop` instead.
 *
 * Whether this one carries sound is decided here, now, and travels with the
 * request. `mobileMirrorAudio` is read at the moment the television asks rather
 * than captured at boot — the same rule the control gate below follows — but
 * unlike an input frame a capture happens once, so switching the sound off
 * silences the next watch and not this one.
 */
function startMirror(): string | null {
  const win = mirrorWindow()
  if (!win) return 'Forge has no window open on the desktop, so it cannot share its screen.'
  const audio = getSettings().mobileMirrorAudio
  win.webContents.send(IPC.mobileMirror, { kind: 'start', audio } satisfies MobileMirrorEvent)
  return null
}

/* ------------------------------------------------- driving from the sofa
 *
 * The mirror pointing back the other way: the remote's D-pad as this desktop's
 * mouse. Everything above this comment ends inside Forge; this ends at the
 * operating system, so it is gated twice — once by a setting that is off until
 * somebody switches it on, and once by the server, which only accepts these
 * frames from the socket that is currently watching the screen.
 *
 * Both gates are read per event, never captured. Switching control off while
 * somebody is holding the remote stops the next click, not the next session.
 */

/** Is the television allowed to touch this machine, right now? */
function canControl(): boolean {
  return canDriveDesktop() && getSettings().mobileControlEnabled
}

/**
 * A fraction of the mirrored screen, as a physical pixel on it.
 *
 * Three coordinate systems meet here and none of them is the television's.
 * `mirrorSource` captures the *primary* display, so that display's bounds are
 * what a 0..1 pair is a fraction of; Electron reports those bounds in
 * device-independent pixels, and `SetCursorPos` wants real ones, which on a
 * screen at 150% is a different number. `dipToScreenPoint` is the conversion,
 * and it is Windows-only — which is fine, because so is the whole feature.
 *
 * Real pixels are only what `SetCursorPos` receives because the input helper
 * declares itself DPI-aware before its first call; a helper left in Windows'
 * default unaware state has these numbers scaled a second time on the way in,
 * and the pointer lands short of the target by exactly the scale factor. See
 * the awareness block in electron/mobile/input.ts — changing either of these
 * two places alone puts the cursor back where the sofa did not aim it.
 *
 * Clamped one pixel inside the far edges: a fraction of exactly 1 lands on the
 * first pixel of the next monitor on a multi-display desk.
 */
function pointFor(x: number, y: number): { x: number; y: number } {
  const bounds = screen.getPrimaryDisplay().bounds
  const dip = {
    x: Math.round(bounds.x + x * Math.max(0, bounds.width - 1)),
    y: Math.round(bounds.y + y * Math.max(0, bounds.height - 1))
  }
  return screen.dipToScreenPoint(dip)
}

/**
 * Perform one input, or refuse it.
 *
 * `false` is the answer the television is told about — see the `mirror-input`
 * case in electron/mobile/server.ts, which turns it into one refusal rather
 * than a silence the sofa has to interpret. A pointer that moves on the
 * television and nowhere else is the failure this exists to prevent.
 */
function applyInput(input: MirrorInput): boolean {
  if (!canControl()) return false
  // A key stroke and a typed phrase both have no position — they land wherever
  // the focus already is, which is the whole point of them. The coordinates are
  // ignored for a `k` or `t` line, and asked for anyway everywhere else so the
  // helper's grammar stays one shape.
  const at = input.a === 'key' || input.a === 'text' ? { x: 0, y: 0 } : pointFor(input.x, input.y)
  driveDesktop(input, at)
  return true
}

/* ------------------------------------------------------ accept new phones
 *
 * The tap-to-pair window. Armed = `mobileAcceptUntil` holds a deadline in the
 * future; the deadline is a *setting* so a Forge restarted mid-window stays
 * armed for the remainder, and the store's normaliser zeroes anything stale
 * or absurd on the way in. Two things enforce the window: the server reads
 * `armedUntil()` on every requestPair (so disarming is instant), and the
 * timer below zeroes the setting when the window lapses (so the Settings
 * toggle visibly switches itself off rather than silently meaning nothing).
 */

let acceptTimer: NodeJS.Timeout | null = null

function armedUntil(): number {
  const until = getSettings().mobileAcceptUntil
  return until > Date.now() ? until : 0
}

function syncAcceptTimer(): void {
  if (acceptTimer) {
    clearTimeout(acceptTimer)
    acceptTimer = null
  }
  const until = armedUntil()
  if (!until) return
  // A short grace past the deadline, so the timer fires on the disarmed side
  // of the comparison the server makes rather than racing it.
  acceptTimer = setTimeout(() => {
    acceptTimer = null
    setSettings({ mobileAcceptUntil: 0 })
    report('')
  }, until - Date.now() + 250)
}

function disarmAccept(): void {
  setSettings({ mobileAcceptUntil: 0 })
  syncAcceptTimer()
}

/* ------------------------------------------------------- pairing approval
 *
 * The server asks; this turns the question into a renderer prompt and waits
 * for the verdict — the same request/response-with-timeout shape as
 * dispatchOp above, because two pending-map patterns in one file is one too
 * many. The one rule that must survive every edit: **no path in here resolves
 * true except an explicit Allow from the renderer.** Timeout is a deny. No
 * window is a deny. Shutdown is a deny. A default-allow anywhere below would
 * be the whole feature undone.
 */

interface PendingApproval {
  resolve: (allow: boolean) => void
  timer: NodeJS.Timeout
}

const pendingApprovals = new Map<string, PendingApproval>()

/** The single exit: withdraw the prompt everywhere, then deliver the verdict. */
function settleApproval(requestId: string, allow: boolean): void {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return
  pendingApprovals.delete(requestId)
  clearTimeout(pending.timer)
  // Every window hears the withdrawal, including the one that answered — a
  // prompt left up in a second window would offer an Allow that lands on a
  // question already closed.
  broadcast(IPC.mobileApproval, {
    requestId,
    deviceName: '',
    words: '',
    known: false,
    open: false
  } satisfies MobileApprovalEvent)
  pending.resolve(allow)
}

function requestApproval(ask: MobileApprovalAsk): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settleApproval(ask.requestId, false), APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(ask.requestId, { resolve, timer })
    broadcast(IPC.mobileApproval, {
      requestId: ask.requestId,
      deviceName: ask.deviceName,
      words: ask.words,
      known: ask.known,
      open: true
    } satisfies MobileApprovalEvent)
    notifyApproval(ask)
  })
}

/** The server's "the phone hung up / the wait is over" — a deny like any other. */
function cancelApproval(requestId: string): void {
  settleApproval(requestId, false)
}

/**
 * The out-of-window fallback: an OS notification when no Forge window is
 * focused to show the prompt. It is a doorbell, not a control — it carries no
 * buttons and can approve nothing; clicking it brings the app (and the real
 * prompt, with the words to compare) to the front. If nobody comes, the
 * approval times out as a deny, which is the only acceptable answer to an
 * unattended question.
 */
function notifyApproval(ask: MobileApprovalAsk): void {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.some((w) => w.isFocused())) return
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: ask.known ? 'A device you have paired is asking to reconnect' : 'A phone wants to connect to Forge',
    body: `"${ask.deviceName}" is asking to ${ask.known ? 'reconnect' : 'pair'}. Its screen should be showing ${ask.words}. Open Forge to allow or deny.`
  })
  note.on('click', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      app.focus({ steal: true })
    }
  })
  note.show()
}

/* ------------------------------------------------------------- lifecycle */

async function start(): Promise<void> {
  if (server || starting) return
  const settings = getSettings()
  if (!settings.mobileEnabled) return

  starting = true
  report('Starting…')

  const instance = new MobileServer({
    auth: getAuth(),
    appVersion: app.getVersion(),
    desktopName: () => hostname(),
    sessions: () => getManager().list(),
    replay: (id) => getReplay(id),
    // Through pty-host's ownership gate rather than straight at the manager:
    // typing is what hands a pane's grid over, and a size is a wish granted only
    // to whoever is holding it. The repaint jiggle a granted phone wish needs
    // lives there too, beside the gate that decides whether it happens at all.
    write: (id, data, viewer) => viewerWrite(id, data, viewer),
    resize: (id, cols, rows, viewer) => viewerResize(id, cols, rows, viewer),
    release: (viewer, id) => viewerGone(viewer, id),
    snapshot: () => snapshotForPhone(),
    dispatchOp,
    // The exported functions from the Foreman module, not the IPC handlers: a
    // phone reaches the same host the desktop's switch reaches, and the
    // renderer is never asked about a pane main owns. A start that comes back
    // `error` answers with Foreman's own sentence, as the footer would show it.
    foremanStart: async (request) => {
      const state = foremanStart(request)
      return state.status === 'error' ? { ok: false, error: state.line || 'Foreman could not start.' } : { ok: true }
    },
    foremanStop: async (paneId) => {
      foremanStop(paneId)
      return { ok: true }
    },
    foremanSay: async (paneId, text) => {
      const state = foremanSay({ paneId, text })
      const driving = state.status === 'starting' || state.status === 'driving' || state.status === 'waiting'
      return driving ? { ok: true } : { ok: false, error: 'Foreman is not driving that pane — start it with a seed instead.' }
    },
    acceptUntil: () => armedUntil(),
    requestApproval,
    cancelApproval,
    mirrorStart: startMirror,
    mirrorSignal: (data) => sendMirror({ kind: 'signal', data }),
    mirrorStop: () => {
      // The helper is torn down with the picture. It costs half a second to
      // start and nothing to keep, but a PowerShell process outliving the
      // television that needed it is the kind of thing people find in a task
      // manager and reasonably worry about.
      stopDesktopInput()
      sendMirror({ kind: 'stop' })
    },
    mirrorControl: canControl,
    mirrorInput: applyInput,
    ...(mobileWebRoot() ? { webRoot: mobileWebRoot() } : {}),
    // A thunk, not a path: the APK appears while the server is running, and a
    // path resolved here would 404 until the next restart.
    tvApk: () => tvApkPath(),
    onPresence: (connected) => {
      if (connected > 0) holdBlocker()
      else releaseBlocker()
      report()
    },
    onWatch: (ids) => {
      watched = new Set(ids)
      publishWatched()
    },
    log: (line) => console.log(line)
  })

  // Read before the port is bound; re-checked the moment the bind resolves.
  // See `startEpoch`.
  const epoch = startEpoch
  try {
    await instance.start({ host: settings.mobileBindHost, port: settings.mobilePort })
  } catch (err) {
    starting = false
    const message = err instanceof Error ? err.message : String(err)
    // The overwhelmingly likely cause, and the one worth naming.
    const detail = /EADDRINUSE/.test(message)
      ? `Port ${settings.mobilePort} is already in use — pick another in Settings.`
      : message
    console.error(`[mobile] failed to start: ${message}`)
    report(detail)
    return
  }

  if (epoch !== startEpoch) {
    // stop() ran while the port was being bound. Tear this one down rather than
    // letting it come up behind the user's back; the tunnel and the discovery
    // responder were already stopped on that side.
    starting = false
    await instance.stop()
    return
  }

  server = instance
  starting = false

  // Foreman's state, fanned out from the moment the link is up — the phone's
  // twin of the subscription electron/web-host.ts holds. The snapshot in
  // `snapshotForPhone` carries the current states to a phone that connects
  // mid-job; this is everything that moves after that.
  unsubscribeForeman = onForemanState((state) => instance.pushForeman(state))

  // The phone sees what the window sees, from the same coalesced flush.
  unsubscribePty = addPtySink({
    onData: (id, data) => instance.pushData(id, data),
    // A pane that has just started is as much a change to the phone's list as
    // one that has just died — and the list is what decides whether a row can
    // be tapped. Without this, a tab opened from the phone could sit there
    // reading "not running" until something unrelated moved. See PtySink.
    onSpawn: () => {
      instance.pushState({ sessions: getManager().list() })
      // Re-adoption after a renderer reload arrives here too, and a renderer
      // that has just reloaded has forgotten which of its panes a phone is
      // reading — the labels on them, and nothing else now, but a label that
      // survives a dev reload is a label that can be trusted. Re-stating the
      // list costs one message.
      publishWatched()
    },
    onResize: () => {
      // A pane's grid moved — at this desk, in a browser, or on another phone —
      // and every phone that is not the one that moved it has just been left
      // drawing the wrong shape. `state` already carries the session list with
      // its cols/rows, so the news needs no new frame — only sending. Coalesced,
      // because a window drag or a split is several panes resizing in the same
      // breath and each one would otherwise broadcast the whole list. A phone's
      // *own* resize lands here too, jiggle and all, and one push at the end of
      // it is exactly what should reach the phone.
      if (geometryPush) return
      geometryPush = setTimeout(() => {
        geometryPush = null
        instance.pushState({ sessions: getManager().list() })
      }, GEOMETRY_PUSH_MS)
    },
    onExit: (id, exitCode) => {
      instance.pushExit(id, exitCode)
      // A dead pane changes the picture, so the phone's list is refreshed too.
      instance.pushState({ sessions: getManager().list() })
    }
  })

  // After the server, because the address it advertises is the server's. A
  // responder that fails to bind is reported and dropped — discovery is a
  // convenience, and the link must not fail to start over a busy UDP port.
  discovery = new DiscoveryResponder({
    origin: () => tvOrigin(),
    name: () => hostname(),
    appVersion: () => app.getVersion(),
    log: (line) => console.log(`[mobile] ${line}`)
  })
  void discovery.start(MOBILE_DISCOVERY_PORT)

  report('')
  // A restart mid-window stays armed for the remainder — re-hang the disarm
  // timer so the remainder still ends itself.
  syncAcceptTimer()
  // The tunnel wants the server listening before it advertises a way in.
  void startTunnel()
  offerPairingOnStart()
}

/**
 * Mint a pairing offer at startup and print the code to the log.
 *
 * Off unless `FORGE_MOBILE_PAIR_ON_START=1`, and deliberately so: a pairing
 * code is a credential, and this writes one in clear to a log file that is not
 * treated as a secret anywhere else. The ordinary door — Settings → Forge
 * Mobile → Pair a phone — keeps the code on screen and nowhere else, and it
 * remains the right door whenever there is a human at the desktop.
 *
 * This one exists for the case that door cannot answer: the phone has lost its
 * device token, the desktop is a hundred miles away, and pairing offers live in
 * memory only, so the very restart that would let you re-pair is also what
 * destroys any offer already open. Without an offer mintable from outside the
 * renderer, a remote phone that forgets its token cannot be let back in at all.
 *
 * The offer is single-use and expires with PAIR_TTL_MS like any other, so the
 * exposure is one code for one window, not a standing key.
 */
function offerPairingOnStart(): void {
  if (process.env.FORGE_MOBILE_PAIR_ON_START !== '1') return
  const offer = getAuth().offerPairing()
  const minutes = Math.round(PAIR_TTL_MS / 60_000)
  console.log(`[mobile] pairing open by FORGE_MOBILE_PAIR_ON_START — code ${offer.token} (${minutes} min)`)
  report('Pairing open — scan the code on your phone.')
}

async function stop(): Promise<void> {
  // First, before anything awaits: invalidate any start() still binding its
  // port, so it tears itself down instead of assigning the server the moment
  // its bind resolves. See `startEpoch`.
  startEpoch += 1
  stopTunnel()
  // Before everything else: a desktop that still answers "I am here" after the
  // link is off is advertising a door that has been bricked up.
  const responder = discovery
  discovery = null
  await responder?.stop()
  // Switching the link off disarms it too: "off" must mean off, not "off but
  // primed to accept strangers the moment it is switched back on".
  disarmAccept()
  for (const requestId of [...pendingApprovals.keys()]) settleApproval(requestId, false)
  unsubscribePty?.()
  unsubscribePty = null
  unsubscribeForeman?.()
  unsubscribeForeman = null
  // A pending push would fire into a server that has stopped, which is the
  // ordinary shape of switching the link off a beat after moving a pane.
  if (geometryPush) clearTimeout(geometryPush)
  geometryPush = null
  // Switching the link off takes every "ON PHONE" chip off the desk with it —
  // a pane labelled as read by a server that no longer exists is a pane telling
  // a lie nothing would ever correct.
  if (watched.size > 0) {
    watched = new Set()
    publishWatched()
  }
  releaseBlocker()
  const instance = server
  server = null
  await instance?.stop()
}

/* -------------------------------------------------------------- the tunnel */

/**
 * Bring the ngrok agent up, fetching the binary first if this machine has
 * never had one. Every early return leaves a sentence in `tunnelStatus` —
 * a tunnel that silently is not there is the failure mode this whole feature
 * exists to end.
 */
async function startTunnel(): Promise<void> {
  if (tunnel || tunnelStarting) return
  const settings = getSettings()
  if (settings.mobileTunnel !== 'ngrok') return
  if (!server) {
    tunnelStatus = { state: 'error', url: '', detail: 'Turn the phone link on first — the tunnel has nothing to carry.' }
    report()
    return
  }
  if (!settings.mobileNgrokAuthtoken || !settings.mobileNgrokDomain) {
    tunnelStatus = {
      state: 'error',
      url: '',
      detail: 'Paste your ngrok authtoken and domain below first — both are on the ngrok dashboard.'
    }
    report()
    return
  }

  tunnelStarting = true
  try {
    const binDir = join(getDataDir(), 'bin')
    let exe = resolveNgrokExe({ env: process.env, binDir })
    if (!exe) {
      tunnelStatus = { state: 'starting', url: '', detail: 'Fetching ngrok (one time, about 12 MB)…' }
      report()
      const fetched = await ensureNgrokExe({ binDir })
      if (!fetched.ok) {
        tunnelStatus = { state: 'error', url: '', detail: fetched.error }
        report()
        return
      }
      exe = fetched.path
    }
    // The download can take a while; the world may have moved on under it.
    if (getSettings().mobileTunnel !== 'ngrok' || !server) return

    tunnel = new NgrokTunnel({
      exe,
      port: getSettings().mobilePort,
      domain: getSettings().mobileNgrokDomain,
      authtoken: getSettings().mobileNgrokAuthtoken,
      onStatus: (status) => {
        tunnelStatus = status
        report()
      },
      log: (line) => console.log(`[mobile] ${line}`)
    })
    tunnel.start()
  } finally {
    tunnelStarting = false
  }
}

/** Take the agent down — the whole process tree, or it holds a session slot. */
function stopTunnel(): void {
  tunnel?.stop()
  tunnel = null
  tunnelStatus = TUNNEL_OFF
}

function snapshotForPhone(): Pick<HelloOkFrame, 'projects' | 'profiles' | 'workspaces' | 'foreman'> {
  const projects = getProjects()
  const workspaces: Record<string, import('@shared/types').Workspace> = {}
  for (const project of projects) {
    const workspace = getWorkspace(project.id)
    if (workspace) workspaces[project.id] = workspace
  }
  return {
    projects,
    profiles: getSettings().agentProfiles,
    workspaces,
    // Always, even empty: a phone reconnecting mid-job learns the switch is on
    // from here, and "nothing is being driven" is a real answer too.
    foreman: foremanList()
  }
}

/**
 * `prevent-app-suspension`, not `prevent-display-sleep`: the screen at home
 * should still go dark. What must not happen is Windows suspending Forge while
 * Steve is typing into it from a train.
 */
function holdBlocker(): void {
  if (blockerId && powerSaveBlocker.isStarted(blockerId)) return
  blockerId = powerSaveBlocker.start('prevent-app-suspension')
}

/**
 * Where the phone bundle lives, or '' when there is none to serve.
 *
 * The real client is the APK, which carries its own copy — this is the browser
 * route: point a phone at `http://<desktop>:8420` and the same app loads, which
 * is how the link is usable before an APK exists and how it is debugged after.
 * It is also what the Devices preview frames, which is why a packaged build
 * carries a copy in `resources/mobile-web` (see electron-builder.yml) rather
 * than shipping none: a Forge with a Devices button that can only say "the
 * bundle is not built" would be a button that lies about whose fault that is.
 *
 * `FORGE_MOBILE_WEB` overrides all of it for anyone who wants to serve a
 * built bundle from elsewhere.
 */
function mobileWebRoot(): string {
  const override = process.env.FORGE_MOBILE_WEB?.trim()
  if (override) return existsSync(override) ? override : ''
  if (app.isPackaged) {
    const packed = join(process.resourcesPath, 'mobile-web')
    return existsSync(packed) ? packed : ''
  }
  // `app.getAppPath()` is the checkout root in a plain `electron .` run but not
  // reliably under electron-vite, where the main bundle lives in `out/main`.
  // Both are tried rather than assumed, because the failure mode of guessing
  // wrong is a phone that loads nothing and a desktop that says it is fine.
  for (const candidate of [
    join(app.getAppPath(), 'mobile', 'dist'),
    join(app.getAppPath(), '..', 'mobile', 'dist'),
    join(process.cwd(), 'mobile', 'dist')
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function releaseBlocker(): void {
  if (blockerId && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = 0
}

/**
 * Tell every connected phone that the desktop's picture changed.
 *
 * Called from the renderer after it has actually applied and persisted a
 * change — including one the phone asked for, so the phone learns the result
 * from the same broadcast a second phone would.
 *
 * `projectId` names the workspace that just changed, and carrying it is not
 * optional decoration: the phone's tab list comes from the `workspaces` map in
 * `hello-ok`, so a broadcast of only projects+sessions leaves that list frozen
 * at whatever it was when the phone connected. Opening a tab — from the desk or
 * from the phone itself — then showed up everywhere except the device that
 * asked for it, until the phone reconnected. The `workspace` field has been on
 * StateFrame all along and link.ts already merges it; nothing ever filled it in.
 */
/**
 * Tell every connected phone that the desktop's *window* is in trouble.
 *
 * The phone's half of `publishDesktopState` in electron/web-host.ts, called
 * from the same place and for the same reason: the ops a phone sends are
 * executed in the desktop's renderer, so a dead renderer is a phone with dead
 * buttons and no way to know it.
 */
export function publishDesktopState(state: 'recovering' | 'ready', reason?: string): void {
  if (!server) return
  server.pushDesktop(state, reason)
}

export function publishMobileState(projectId?: string): void {
  if (!server) return
  const workspace = projectId ? getWorkspace(projectId) : null
  server.pushState({
    projects: getProjects(),
    sessions: getManager().list(),
    ...(projectId && workspace ? { workspace: { projectId, workspace } } : {})
  })
}

/* ------------------------------------------------------------------- IPC */

export function registerMobileHandlers(): void {
  ipcMain.handle(IPC.mobileStatus, () => mobileStatus())

  // Every line the build prints reaches the settings page through here.
  onTvBuildChange(reportTv)

  ipcMain.handle(IPC.mobileTvStatus, (): ForgeTvStatus => forgeTvStatus())

  /**
   * Build the Fire TV APK against this machine's LAN address, right now.
   *
   * Returns the status as it stands the instant the build starts, not when it
   * finishes: Vite plus Gradle is minutes, and this call must not hold the
   * renderer for them. The rest arrives on `mobileTvStatusEvent`.
   */
  ipcMain.handle(IPC.mobileTvBuild, (): ForgeTvStatus => {
    const origin = tvOrigin()
    if (!origin) {
      reportTvProblem(
        'Turn the phone link on first — the television downloads the app from it, so the address it gets baked with is this server’s.'
      )
      return forgeTvStatus()
    }
    startTvBuild(origin)
    return forgeTvStatus()
  })

  /**
   * Download the published TV app.
   *
   * No origin check, unlike the build above: this APK has no address baked into
   * it, so it can be fetched while the link is off and be perfectly correct.
   * The address only matters at the *other* end of the job — the URL a
   * television types — and that one is reported honestly as '' until the link
   * is listening.
   */
  ipcMain.handle(IPC.mobileTvFetch, (): ForgeTvStatus => {
    fetchTv()
    return forgeTvStatus()
  })

  ipcMain.handle(IPC.mobileStart, async (): Promise<MobileStatus> => {
    setSettings({ mobileEnabled: true })
    await start()
    report()
    return mobileStatus()
  })

  ipcMain.handle(IPC.mobileStop, async (): Promise<MobileStatus> => {
    setSettings({ mobileEnabled: false })
    await stop()
    report('')
    return mobileStatus()
  })

  /**
   * Mint a pairing token. The renderer renders it as a QR; the raw token
   * crosses this boundary exactly once and is never persisted.
   *
   * The address half of the offer prefers the live tunnel: `wss://<domain>`
   * with no port, which is what the phone's `toOrigin` expects of a tunnel and
   * which keeps working from anywhere, forever — pairing against a LAN IP when
   * a permanent URL exists would be answering the wrong question.
   */
  ipcMain.handle(IPC.mobilePair, () => {
    if (!server) return { ok: false as const, error: 'Turn the phone link on first.' }
    const offer = getAuth().offerPairing()
    const endpoint = pairEndpoint(
      tunnelStatus,
      reachableAddresses()[0] ?? '127.0.0.1',
      server.address()?.port ?? MOBILE_PORT
    )
    report('Pairing open — scan the code on your phone.')
    return {
      ok: true as const,
      token: offer.token,
      expiresAt: offer.expiresAt,
      ttlMs: PAIR_TTL_MS,
      host: endpoint.host,
      port: endpoint.port,
      url: endpoint.url,
      // `port === 0` is pairEndpoint's "tunnel" marker, and pairLink turns it
      // into the port-less wss link the phone's toOrigin expects of one.
      link: pairLink(endpoint.host, endpoint.port, endpoint.port === 0, offer.token)
    }
  })

  ipcMain.handle(IPC.mobilePairCancel, () => {
    getAuth().cancelPairing()
    report('')
    return true
  })

  /**
   * Mint a pairing code for the Devices preview frames.
   *
   * Same single-use, single-pending machinery as the QR — which is why this
   * hands back ONE code and the Devices view spends it before asking for the
   * next: a second mint replaces the first outstanding offer (see offerPairing),
   * so two live codes cannot coexist. Deliberately does not touch the Settings
   * detail line (`report`), because a preview frame reloading is not a pairing
   * event anyone asked to be told about. Note the flip side, documented here so
   * nobody has to rediscover it: opening Devices *does* replace an outstanding
   * Settings QR offer — the same thing pressing the QR button a second time in
   * Settings does, and no worse.
   *
   * The port is the one the server actually bound, never the setting: a preview
   * URL naming a port the server has since left behind is a frame that loads and
   * then can never dial home.
   */
  ipcMain.handle(IPC.mobilePreviewPair, (): MobilePreviewOffer => {
    if (!server) return { ok: false, error: 'Turn the phone link on first.' }
    if (!mobileWebRoot()) return { ok: false, error: 'The mobile bundle is not built.' }
    const offer = getAuth().offerPairing()
    return {
      ok: true,
      code: offer.token,
      port: server.address()?.port ?? getSettings().mobilePort,
      expiresAt: offer.expiresAt
    }
  })

  /**
   * Arm or disarm "Accept new phones". Arming needs a listening server — an
   * armed door on a stopped server would be a toggle that lies — and always
   * arms for exactly one window from now; there is no "arm forever".
   */
  ipcMain.handle(IPC.mobileAccept, (_e, on: unknown): MobileStatus => {
    if (on === true) {
      if (!server) {
        report('Turn the phone link on first.')
        return mobileStatus()
      }
      setSettings({ mobileAcceptUntil: Date.now() + ACCEPT_WINDOW_MS })
      syncAcceptTimer()
      report('Accepting new phones — open the Forge app on the phone.')
    } else {
      disarmAccept()
      report('')
    }
    return mobileStatus()
  })

  /**
   * Save tunnel credentials. A running tunnel is restarted under the new
   * identity — a corrected authtoken that only applies after the next reboot
   * is a support ticket from the future.
   */
  ipcMain.handle(IPC.mobileTunnelConfig, async (_e, config: { authtoken?: string; domain?: string }): Promise<MobileStatus> => {
    const patch: Partial<Settings> = {}
    if (typeof config?.authtoken === 'string') patch.mobileNgrokAuthtoken = config.authtoken.trim()
    if (typeof config?.domain === 'string') patch.mobileNgrokDomain = config.domain
    setSettings(patch)
    if (tunnel) {
      stopTunnel()
      await startTunnel()
    }
    report()
    return mobileStatus()
  })

  ipcMain.handle(IPC.mobileTunnelStart, async (): Promise<MobileStatus> => {
    setSettings({ mobileTunnel: 'ngrok' })
    await startTunnel()
    report()
    return mobileStatus()
  })

  ipcMain.handle(IPC.mobileTunnelStop, async (): Promise<MobileStatus> => {
    setSettings({ mobileTunnel: 'off' })
    stopTunnel()
    report()
    return mobileStatus()
  })

  ipcMain.handle(IPC.mobileRevoke, (_e, deviceId: string): MobileStatus => {
    const id = String(deviceId ?? '')
    if (getAuth().revoke(id)) {
      // Revoking a device that is connected right now has to hang up on it, or
      // "revoked" would only mean "revoked next time".
      server?.disconnectDevice(id)
      report('Device removed.')
    }
    return mobileStatus()
  })

  /**
   * The human's verdict on a pairing prompt. `=== true` twice over (here and
   * in preload), because the difference between truthy and true is the
   * difference between a paired stranger and none.
   */
  ipcMain.on(IPC.mobileApprovalResult, (_e, payload: { requestId?: string; allow?: boolean }) => {
    settleApproval(String(payload?.requestId ?? ''), payload?.allow === true)
  })

  /** The renderer's verdict on a `mobileCommand`. */
  ipcMain.on(IPC.mobileCommandResult, (_e, payload: { requestId?: string; error?: string }) => {
    const pending = pendingOps.get(String(payload?.requestId ?? ''))
    if (!pending) return
    pendingOps.delete(String(payload.requestId))
    clearTimeout(pending.timer)
    pending.resolve(payload?.error ? String(payload.error) : null)
    // Whatever just changed, tell the phones.
    publishMobileState()
  })

  /**
   * The renderer's half of the screen mirror — both sends, because signalling
   * is a stream of payloads with no answer to wait for.
   *
   * Coerced off the boundary like everything else here, and then forwarded
   * unread: a signalling payload is an SDP or an ICE candidate that only the
   * two peer connections at the ends of this relay have any business parsing.
   */
  ipcMain.on(IPC.mobileMirrorSignal, (_e, payload: { data?: string }) => {
    server?.pushMirrorSignal(String(payload?.data ?? ''))
  })

  /** The mirror ended on this side — the capture failed, or the peer died. */
  ipcMain.on(IPC.mobileMirrorStop, (_e, payload: { reason?: string }) => {
    server?.pushMirrorStop(String(payload?.reason ?? ''))
  })

  /**
   * Which screen to capture, as a `desktopCapturer` source id.
   *
   * `desktopCapturer` is main-only, and this id is the whole of what the
   * renderer needs from it — the thing that turns `getUserMedia` into a stream
   * of the desktop rather than a webcam. Thumbnails are switched off with a
   * zero size (see the SourcesOptions docs): they would be a full screen grab
   * per display, and the answer here is a string.
   *
   * '' when this machine somehow reports no screen, so the renderer refuses
   * with a sentence rather than opening a stream onto nothing.
   */
  ipcMain.handle(IPC.mobileMirrorSource, async (): Promise<string> => {
    const primary = screen.getPrimaryDisplay()
    let sources: DesktopCapturerSource[] = []
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
    } catch (err) {
      // `getSources` rejects when the OS refuses the enumeration (a locked
      // session, a display subsystem still coming up), and a rejected invoke is
      // an unhandled rejection in the renderer. The empty answer is the one the
      // renderer already knows how to show.
      console.error(`[mobile] could not enumerate screens: ${err instanceof Error ? err.message : String(err)}`)
      return ''
    }
    // One entry per display; the primary is the one whose id matches, and the
    // first entry is the sane fallback when none does — the same rule
    // electron/voice-agent/ipc.ts uses for its screenshots.
    const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0] ?? null
    return source?.id ?? ''
  })
}

/** Called on boot and whenever settings change, exactly like the Companion. */
export function applyMobileSettings(): void {
  const enabled = getSettings().mobileEnabled
  // Turning the remote's cursor off closes the helper that performs it, rather
  // than leaving a process alive that every subsequent event is refused by.
  // `applyInput` is what actually enforces the setting; this is hygiene.
  if (!enabled || !getSettings().mobileControlEnabled) stopDesktopInput()
  if (enabled && !server) {
    void start().then(() => report())
    return
  }
  if (!enabled && server) {
    void stop().then(() => report(''))
  }
}

export async function disposeMobile(): Promise<void> {
  // A Gradle assemble outliving the app that asked for it would hold the build
  // lock against the next launch, and the input helper is a child process with
  // the same rule.
  disposeTvBuild()
  stopDesktopInput()
  for (const [, pending] of pendingOps) {
    clearTimeout(pending.timer)
    pending.resolve('Forge is shutting down.')
  }
  pendingOps.clear()
  // stop() below also settles these (as denies — shutdown is not consent),
  // but dispose must not depend on stop being reached.
  for (const requestId of [...pendingApprovals.keys()]) settleApproval(requestId, false)
  await stop()
}

/** Exported for the smoke test, which needs the device shape without Electron. */
export type { MobileDeviceRecord }

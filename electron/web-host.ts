import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, powerSaveBlocker } from 'electron'
import { IPC } from '@shared/ipc'
import { ACCEPT_WINDOW_MS } from '@shared/mobile'
import { APPROVAL_TIMEOUT_MS, normaliseHost, webSocketUrl, type WebHelloOkFrame, type WebLayoutOp } from '@shared/web'
import type {
  AgentPresence,
  CommandPresence,
  GitSnapshot,
  TunnelStatus,
  WebApprovalEvent,
  WebCommandEvent,
  WebRendezvousStatus,
  WebSessionStatus,
  WebSignInResult,
  WebStatus,
  WebTotpOffer,
  WebTotpResult,
  WebTunnelStatus,
  Workspace
} from '@shared/types'
import { WebAuth, googleJwksFetcher, type WebApprovalAsk, type WebTotpState } from './web/auth'
import { open as openSecret, seal as sealSecret, sealingKey } from './web/secret-box'
import { WebServer, type WebServerHost } from './web/server'
import { WebRendezvous, type RendezvousRest } from './web/rendezvous'
import { describe, FirebaseRest } from './companion/rest'
import { NgrokTunnel, ensureNgrokExe, resolveNgrokExe } from './mobile-tunnel'
import { addPtySink, getManager, getReplay } from './pty-host'
import { addGitSink, gitRefresh, runAction } from './git-watcher'
import { getDataDir, getProjects, getSettings, getWorkspace, setSettings } from './store'
import { getSkillsStore } from './skills-store'
import { commandsFeed } from './commands'
import { probeAgents } from './agent-probe'
import { probeCommands } from './which'

/**
 * Forge Web — the Electron half.
 *
 * Everything Electron-shaped lives here so `electron/web/server.ts`,
 * `electron/web/auth.ts` and `electron/web/rendezvous.ts` stay injectable and
 * head-lessly testable — the same split `mobile-host.ts` / `mobile/server.ts`
 * and `companion-host.ts` / `companion-sync.ts` use, and the reason
 * `scripts/web-smoke.mjs` can drive the real server against a real
 * `PtySessionManager` with no Electron in the process. **This is the only file
 * in the feature that imports Electron.**
 *
 * Six jobs:
 *
 *  0. Hold Forge Web's *own* Firebase session, and supervise Forge Web's *own*
 *     tunnel. Both used to be borrowed, and both borrowings were wrong in the
 *     same way — see "What this file used to get wrong" below.
 *  1. Own the server's lifecycle against `webEnabled`, and the rendezvous
 *     record's and the tunnel's alongside it. Off by default and *silent* when
 *     off: no port bound, no credential read, no hostname published, no process
 *     spawned, no timer started. That is not tidiness — docs/forge-web.md's
 *     security posture promises it in those words, and `scripts/web-check.mjs`
 *     asserts it by inspecting the listener, the rendezvous and the fetch log
 *     rather than by trusting the setting.
 *  2. Feed the server PTY output, by registering a sink on `pty-host` rather
 *     than opening a second route to node-pty. A browser therefore sees exactly
 *     the bytes the window sees, coalesced by the same 12ms flush, and cannot
 *     make this desktop chattier than it already is.
 *  3. Feed it git snapshots, through `addGitSink` — the seam
 *     `electron/git-watcher.ts` grew for exactly this. The browser's panel is
 *     told by the same sentence the desktop's panel is, after the same
 *     suppression and stamped with the same sequence number, so the two cannot
 *     disagree about what the repository is doing.
 *  4. Turn a browser's `layout` request into a renderer command and wait for
 *     its answer. Tabs and panes are the renderer's to own — it holds the split
 *     tree and persists the workspace — so the browser joins that code path
 *     instead of growing a parallel one in main that could disagree with it
 *     (docs/forge-web.md, decision 5).
 *  5. Ask the human. A browser this desktop has never approved raises a prompt
 *     here, and every outcome that is not an explicit Allow is a deny.
 *
 * ## What this file used to get wrong
 *
 * Both of these worked, and both arrangements were wrong. They are recorded
 * because the shape they were corrected *into* is the load-bearing part.
 *
 * **It borrowed the Companion's Firebase session.** The rendezvous record is
 * written under a signed-in uid, and the only session this desktop held belonged
 * to Forge Companion — so this file refused to publish unless `companionUid`
 * equalled `webUid`. Switching Forge Web on therefore depended on a *different
 * feature* being signed in as the same account, and signing the Companion out
 * stopped Forge Web publishing without saying so. That is exactly what the note
 * on `webUid` in shared/types.ts says must never happen: the Companion's uid
 * moves whenever somebody signs it in or out, and letting that decide who gets a
 * shell on this machine is not acceptable. Forge Web now holds its own session —
 * its own credentials, its own refresh token, its own uid — through the same
 * `electron/companion/rest.ts` client, because the *provider* is shared and
 * nothing else is. Signed out, it publishes nothing and says so: see
 * `sessionStatus()`, and the `session` block on `WebStatus`.
 *
 * **It took its hostname from `FORGE_WEB_HOSTNAME` and called that a tunnel.**
 * An environment variable is a development seam, not a feature, and the status
 * it produced could only ever say "somebody told us a string". Forge Web now
 * supervises its own ngrok agent through `electron/mobile-tunnel.ts` — the same
 * class Forge Mobile drives, a second instance, on Forge Web's own port and
 * domain — so `starting`, `live` and `error` are observations. The variable
 * survives as an explicitly-documented override for a tunnel run by hand; see
 * `tunnelHostname()`, which is careful to say `configured` rather than `live`
 * on that path.
 *
 * ## What this file deliberately does not do
 *
 * **It does not implement `onWatch`, and it does not push `attention`.** Both
 * are optional on `WebServerHost`, and both are half of a pair whose other half
 * lives in the renderer, which is a different milestone's file:
 *
 *  - `onWatch` is the "one PTY, two viewers" arrangement. Naming the watched
 *    sessions is only useful if the renderer then stands down and letterboxes
 *    its own terminal at the browser's size — see the `mobileWatched` block in
 *    electron/mobile-host.ts and its handler in src/state/AppState.tsx. Sending
 *    a message nothing listens to would look like the feature exists.
 *  - `attention` is worse: Forge has no structured agent-permission channel at
 *    all, and the desktop learns a pane is waiting by watching *settled output*
 *    in `src/lib/terminals.ts`. There is no main-side source to forward, so
 *    "cheaply available" is not true here — it would mean a second detector.
 *
 * Neither is a refusal, and both are one IPC channel each when the renderer
 * half is written. What must not happen in the meantime is a channel that
 * implies a behaviour nothing performs.
 */

/* ----------------------------------------------------------------- the port
 *
 * The *host* is loopback, always, and not a setting. The tunnel agent runs on
 * this machine and dials the socket from here, so the public side never touches
 * this port directly and `isAllowedSource` in electron/web/server.ts still sees
 * 127.0.0.1. Binding this listener to 0.0.0.0 would put the internet-facing
 * half of Forge on the LAN as well, for no gain — Forge Mobile is the LAN
 * answer and it has its own port.
 */
const WEB_BIND_HOST = '127.0.0.1'

/**
 * The port, which *is* a setting (`webPort`, defaulted and clamped by
 * electron/store.ts), because the tunnel has to be told which port to forward
 * to and both halves must read the same number.
 *
 * `FORGE_WEB_PORT` still wins. It predates the setting, `scripts/web-check.mjs`
 * drives the real host through it, and it is how a second Forge on one box gets
 * out of the first one's way without editing anybody's settings.json.
 */
function webPort(): number {
  const raw = Number(process.env['FORGE_WEB_PORT'] ?? '')
  if (Number.isInteger(raw) && raw > 0 && raw < 65536) return raw
  return getSettings().webPort
}

/**
 * Where the Phase 3 dev loop serves the client from.
 *
 * Only ever added in an unpackaged run — see `webAllowedOrigins` — so a shipped
 * Forge cannot be opened from a page on somebody's localhost.
 *
 * 5173 is Vite's default and the number docs/forge-web.md names. It is also the
 * port this repo's *desktop* renderer takes in `npm run dev`, so the two cannot
 * both have it: whichever the `web/` app ends up on, `FORGE_WEB_ORIGINS` is the
 * way to say so without editing this file.
 */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

let server: WebServer | null = null
let auth: WebAuth | null = null
let rendezvous: WebRendezvous | null = null
let rest: FirebaseRest | null = null
let unsubscribePty: (() => void) | null = null
let unsubscribeGit: (() => void) | null = null
let lastDetail = ''
let starting = false

/** Forge Web's own ngrok agent, and the last thing it said. See the tunnel block. */
const TUNNEL_OFF: TunnelStatus = { state: 'off', url: '', detail: '' }
let tunnel: NgrokTunnel | null = null
let tunnelState: TunnelStatus = TUNNEL_OFF
let tunnelStarting = false
/**
 * What the running agent was started with. An ngrok agent takes its port,
 * domain and account on its command line and cannot be re-pointed afterwards,
 * so this is how `applyWebSettings` tells "the settings changed" from "the
 * settings were saved" and restarts only in the first case. In memory only, and
 * never logged or reported — it contains the authtoken.
 */
let tunnelSpec = ''

function tunnelSpecNow(): string {
  const s = getSettings()
  return `${webPort()}|${s.webNgrokDomain}|${s.webNgrokAuthtoken}`
}

/**
 * Held while at least one browser is connected, so Windows does not suspend the
 * app mid-session and drop every socket. Released the moment the last one goes:
 * a desktop that never sleeps because of a link nobody is using is a bug.
 */
let blockerId = 0

/* ------------------------------------------------------------------- auth */

/**
 * The key that seals the TOTP secret, read once and kept for the process.
 *
 * Lazy, because a desktop that never enrols a second factor should never make
 * the file: `getDataDir()` is where it lands, beside settings.json rather than
 * inside it. A failure here is not fatal — it means "no second factor", which
 * `totpState()` reports as an empty secret and the panel reports as a sentence.
 * See electron/web/secret-box.ts for what this does and does not buy.
 */
let totpKey: Buffer | null = null

function getTotpKey(): Buffer | null {
  if (totpKey) return totpKey
  try {
    totpKey = sealingKey(getDataDir())
  } catch (err) {
    console.log(`[web] could not read the second-factor key (${String(err)})`)
    totpKey = null
  }
  return totpKey
}

/**
 * The second factor as `WebAuth` needs it: unsealed here, so that class stays
 * arithmetic and the check script can drive it with a secret it invented.
 *
 * A secret that will not open reports as absent rather than throwing, which is
 * the honest answer — a settings.json restored from a backup taken before the
 * key file existed has no usable second factor, and the recovery is to set one
 * up again, not to be locked out by an exception mid-`hello`.
 */
function totpState(): WebTotpState {
  const s = getSettings()
  if (!s.webTotpSecret) return { secret: '', recovery: s.webTotpRecovery, lastCounter: s.webTotpCounter }
  const key = getTotpKey()
  const secret = key ? openSecret(s.webTotpSecret, key) : ''
  if (!secret) console.log('[web] the stored second factor could not be opened — set it up again in Settings')
  return { secret, recovery: s.webTotpRecovery, lastCounter: s.webTotpCounter }
}

/**
 * Persist a changed second factor. The secret is sealed on the way in and is
 * the only field that is: recovery codes are already one-way images, and the
 * counter is a number.
 *
 * A secret that cannot be sealed is not written in the clear as a fallback —
 * the enrolment fails instead, which is the whole reason this returns a
 * boolean.
 */
function saveTotpState(next: WebTotpState): boolean {
  if (!next.secret) {
    setSettings({ webTotpSecret: '', webTotpRecovery: [], webTotpCounter: 0 })
    return true
  }
  const key = getTotpKey()
  if (!key) return false
  setSettings({
    webTotpSecret: sealSecret(next.secret, key),
    webTotpRecovery: next.recovery,
    webTotpCounter: next.lastCounter
  })
  return true
}

function getAuth(): WebAuth {
  if (!auth) {
    auth = new WebAuth({
      load: () => getSettings().webDevices,
      save: (devices) => {
        setSettings({ webDevices: devices })
      },
      // The real fetcher, injected rather than defaulted — see `JwksFetcher`.
      // Constructing it costs nothing and touches no network; the first request
      // happens when a token is first verified, which is after a browser has
      // reached a listening server, which is after `webEnabled`.
      fetchJwks: googleJwksFetcher(),
      // Thunks, not values: both are read per connection, so re-pointing this
      // desktop at another project or account bites on the next hello rather
      // than the next launch.
      projectId: () => getSettings().webProjectId,
      uid: () => getSettings().webUid,
      acceptUntil: () => armedUntil(),
      // The hardening toggle, read per connection like everything else here.
      // Off is the shipped default and the account-only path — see the header
      // of electron/web/auth.ts.
      requireApproval: () => getSettings().webRequireApproval,
      totp: totpState,
      saveTotp: (next) => {
        saveTotpState(next)
      },
      requestApproval,
      cancelApproval,
      log: (line) => console.log(`[web] ${line}`)
    })
  }
  return auth
}

/* ---------------------------------------------------------------- origins */

/**
 * The pages a browser may open this socket from.
 *
 * Derived from `webProjectId` rather than written down, and that is the whole
 * point: a production origin hard-coded in this file would be a second place
 * the deployment is named, and the first thing to go stale when the project is
 * renamed. Firebase Hosting gives every project two default domains —
 * `<project>.web.app` and `<project>.firebaseapp.com` — and both are served the
 * same bundle, so a page loaded from either has to be able to connect. The id
 * is safe to interpolate because `electron/store.ts` only admits
 * `/^[a-z0-9][a-z0-9-]{2,62}$/` into that field.
 *
 * `FORGE_WEB_ORIGINS` (comma-separated) is for a custom domain and for the
 * Phase 3 dev loop on an unusual port. The dev origins are appended only in an
 * unpackaged run.
 *
 * An empty list admits no browser at all, which is the correct answer for an
 * unconfigured desktop — see `originAllowed` in electron/web/server.ts.
 *
 * Exported for `scripts/web-check.mjs`, which asserts that nothing in here is a
 * fixed production address.
 */
export function webAllowedOrigins(): string[] {
  const origins: string[] = []
  for (const raw of (process.env['FORGE_WEB_ORIGINS'] ?? '').split(',')) {
    const clean = raw.trim()
    if (clean) origins.push(clean)
  }
  const project = getSettings().webProjectId
  if (project) origins.push(`https://${project}.web.app`, `https://${project}.firebaseapp.com`)
  if (!app.isPackaged) origins.push(...DEV_ORIGINS)
  return origins
}

/* ---------------------------------------------------------------- reporting */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * The tunnel, as far as this desktop can honestly tell.
 *
 * Three answers, and the difference between them matters to the person reading
 * the panel:
 *
 *  - **the supervised agent.** Forge started it, so `starting`, `live` and
 *    `error` are things it watched happen. The supervisor's `retrying` is
 *    reported as `starting`, because from the panel's side a tunnel coming back
 *    up is a tunnel coming up, and *why* it is having to is already in `detail`.
 *  - **the override.** `FORGE_WEB_HOSTNAME` names a tunnel somebody else runs.
 *    `configured` says "we were told an address" and refuses to imply more:
 *    Forge never met that process and cannot report on it.
 *  - **nothing at all.** A sentence naming both doors, because a browser with
 *    no address to dial is the single most likely thing to be wrong here.
 */
function tunnelStatus(): WebTunnelStatus {
  const override = normaliseHost(process.env['FORGE_WEB_HOSTNAME'] ?? '')
  if (override) return { state: 'configured', host: override, detail: '' }

  if (tunnelState.state === 'live') {
    const host = normaliseHost(tunnelState.url)
    // A live agent whose URL will not normalise is not a live tunnel: the
    // hostname is what a browser dials, and half of one fails at dial time
    // where it reads as a network fault rather than as this.
    if (host) return { state: 'live', host, detail: '' }
    return { state: 'error', host: '', detail: `ngrok reported an address Forge cannot use (${tunnelState.url}).` }
  }

  if (tunnelState.state === 'starting' || tunnelState.state === 'retrying') {
    return { state: 'starting', host: '', detail: tunnelState.detail }
  }
  if (tunnelState.state === 'error') return { state: 'error', host: '', detail: tunnelState.detail }

  return {
    state: 'off',
    host: '',
    detail:
      getSettings().webTunnel === 'ngrok'
        ? tunnelState.detail
        : 'No way in from outside yet. Switch the tunnel on in Settings › Forge Web, or set FORGE_WEB_HOSTNAME to a tunnel you run yourself.'
  }
}

/**
 * The tunnel's public hostname, normalised, or '' when there is none.
 *
 * This is the string that becomes the address a browser opens a socket to, so
 * it goes through `normaliseHost` however it arrived — "it came off our own
 * agent" is not a reason to trust it, and publishing a half-hostname only moves
 * the failure to dial time.
 *
 * Deliberately '' whenever the tunnel is anything but live: `WebRendezvous`
 * reads this on every tick and retracts the record when it goes empty, which is
 * what stops a dead tunnel leaving a live-looking address in the database for
 * the three minutes `HOST_STALE_MS` would otherwise take.
 */
function tunnelHostname(): string {
  return tunnelStatus().host
}

function rendezvousStatus(): WebRendezvousStatus {
  const state = rendezvous?.getState()
  return { published: state?.published ?? '', at: state?.at ?? 0, detail: state?.detail ?? '' }
}

/**
 * Forge Web's own Firebase session, and — when there is not one — the sentence
 * that says which door to go and open.
 *
 * The sentence is the whole point of this function. A Forge Web that is
 * switched on but signed out cannot publish its address, so no browser can find
 * it; before this file held its own session that state was *silent*, and worse,
 * it could be caused by somebody signing a completely different feature out.
 * Every path below therefore ends in either "signed in" or a sentence naming
 * what is missing.
 */
function sessionStatus(): WebSessionStatus {
  const s = getSettings()
  const signedIn = Boolean(s.webRefreshToken && s.webUid && s.webApiKey && s.webDatabaseURL)
  if (signedIn) return { signedIn: true, email: s.webEmail, uid: s.webUid, detail: '' }
  const detail =
    !s.webApiKey || !s.webDatabaseURL
      ? 'Forge Web has no Firebase project yet — paste the API key and database URL from the Firebase console into Settings › Forge Web.'
      : 'Forge Web is signed out, so no browser can find this desktop. Sign in with the account that should reach these terminals — Forge Companion signing in does not count for this door, and never did.'
  return { signedIn: false, email: s.webEmail, uid: '', detail }
}

export function webStatus(): WebStatus {
  const settings = getSettings()
  const address = server?.address() ?? null
  const tunnel = tunnelStatus()
  const session = sessionStatus()
  return {
    enabled: settings.webEnabled,
    state: !settings.webEnabled ? 'off' : starting ? 'starting' : address ? 'listening' : 'error',
    // The door *and* the session: knowing whose tokens to accept is no use
    // without the credential this desktop publishes its address with, and a
    // panel that called that "configured" would be describing a Forge Web
    // nobody can reach. `session.detail` says which half is missing.
    configured: Boolean(settings.webProjectId && settings.webUid && session.signedIn),
    host: address?.host ?? WEB_BIND_HOST,
    port: address?.port ?? webPort(),
    // The address only means anything while something is listening on it — a
    // URL for a server that is off is a link that would be sent to somebody and
    // then not answer.
    url: address ? webSocketUrl(tunnel.host) : '',
    devices: settings.webDevices,
    connected: server?.connectedCount ?? 0,
    acceptUntil: armedUntil(),
    requireApproval: settings.webRequireApproval,
    // Whether one is enrolled, never what it is. `webTotpSecret` is sealed and
    // this status crosses an IPC boundary into a renderer — the panel needs the
    // fact, and the fact is all it gets.
    totpEnabled: Boolean(settings.webTotpSecret),
    recoveryLeft: settings.webTotpRecovery.length,
    detail: lastDetail,
    session,
    tunnel,
    rendezvous: rendezvousStatus()
  }
}

/**
 * Told whenever this desktop's picture of Forge Web changes.
 *
 * One listener, set by electron/main.ts, because there is exactly one thing
 * outside a renderer that has to *react* to this switch rather than merely
 * display it: the tray, which is the whole of "closing the window does not end
 * the session" and must never disagree with the link it describes. `report()`
 * is the single place every state change already passes through — including
 * `web:start` and `web:stop`, which never reach the settings handler in main.ts
 * that `applyWebSettings()` is called from, and which are exactly how somebody
 * turns this feature on and off.
 */
let statusListener: ((status: WebStatus) => void) | null = null

export function setWebStatusListener(listener: ((status: WebStatus) => void) | null): void {
  statusListener = listener
}

function report(detail?: string): void {
  if (detail !== undefined) lastDetail = detail
  const status = webStatus()
  broadcast(IPC.webStatusEvent, status)
  try {
    statusListener?.(status)
  } catch (err) {
    // `report()` is called from the middle of start, stop and shutdown. A
    // listener that throws must not be the reason the link fails to come up or
    // the reason Forge will not close.
    console.error('[web] the status listener failed:', err)
  }
}

/* --------------------------------------------------- accept new browsers
 *
 * The same arrangement `mobileAcceptUntil` gets, and for the same two reasons:
 * a *deadline* rather than a boolean survives a restart mid-window without
 * arming forever, and two things enforce it — auth.ts reads `armedUntil()` on
 * every unknown device (so disarming is instant) and the timer below zeroes the
 * setting when the window lapses (so the Settings toggle visibly switches
 * itself off rather than silently meaning nothing).
 *
 * It matters more here than it does for a phone link. Forge Mobile's door faces
 * a LAN; this one faces the internet, so a boolean left on would leave this
 * desktop raising approval prompts for anybody who found the address, forever.
 */

let acceptTimer: NodeJS.Timeout | null = null

function armedUntil(): number {
  const until = getSettings().webAcceptUntil
  return until > Date.now() ? until : 0
}

function syncAcceptTimer(): void {
  if (acceptTimer) {
    clearTimeout(acceptTimer)
    acceptTimer = null
  }
  const until = armedUntil()
  if (!until) return
  // A short grace past the deadline, so the timer fires on the disarmed side of
  // the comparison auth.ts makes rather than racing it.
  acceptTimer = setTimeout(() => {
    acceptTimer = null
    setSettings({ webAcceptUntil: 0 })
    report('')
  }, until - Date.now() + 250)
}

function disarmAccept(): void {
  setSettings({ webAcceptUntil: 0 })
  syncAcceptTimer()
}

/* ------------------------------------------------------------ op dispatch */

interface PendingOp {
  resolve: (error: string | null) => void
  timer: NodeJS.Timeout
}

const pendingOps = new Map<string, PendingOp>()
/** A renderer that never answers must not leave a browser waiting forever. */
const OP_TIMEOUT_MS = 8000

/**
 * Ask the renderer to perform a layout operation, and wait for its verdict.
 *
 * Returns an error sentence, or null on success — `WebServerHost.layout`'s
 * contract, and the reason it is a sentence rather than a boolean is the
 * failure below: Forge minimised is fine, Forge with its window closed is not,
 * because the split tree lives in the renderer. The server turns any sentence
 * into `no-window`, which is exactly what this one is.
 */
async function dispatchLayout(op: WebLayoutOp, deviceName: string): Promise<string | null> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.length === 0) return 'Forge has no window open on the desktop, so it cannot change tabs.'

  const requestId = randomUUID()
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingOps.delete(requestId)
      resolve('The desktop did not answer in time.')
    }, OP_TIMEOUT_MS)
    pendingOps.set(requestId, { resolve, timer })
    windows[0].webContents.send(IPC.webCommand, { requestId, deviceName, op } satisfies WebCommandEvent)
  })
}

/* ------------------------------------------------------- device approval
 *
 * auth.ts asks; this turns the question into a renderer prompt and waits for
 * the verdict — the same request/response-with-timeout shape as dispatchLayout
 * above, because two pending-map patterns in one file is one too many. The rule
 * that must survive every edit is mobile-host.ts's, and it is sharper here
 * because this door faces the internet: **no path below resolves true except an
 * explicit Allow from the renderer.** Timeout is a deny. No window is a deny.
 * Shutdown is a deny.
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
  broadcast(IPC.webApproval, {
    requestId,
    deviceName: '',
    words: '',
    uid: '',
    open: false
  } satisfies WebApprovalEvent)
  pending.resolve(allow)
}

function requestApproval(ask: WebApprovalAsk): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // auth.ts has its own deadline on the same question and cancels this one
    // when it fires. The timer here is the backstop for the case that cannot:
    // an auth instance torn down mid-question. Both are denies.
    const timer = setTimeout(() => settleApproval(ask.requestId, false), APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(ask.requestId, { resolve, timer })
    broadcast(IPC.webApproval, {
      requestId: ask.requestId,
      deviceName: ask.deviceName,
      words: ask.words,
      uid: ask.uid,
      open: true
    } satisfies WebApprovalEvent)
    notifyApproval(ask)
  })
}

/** auth.ts's "the browser hung up / the wait is over" — a deny like any other. */
function cancelApproval(requestId: string): void {
  settleApproval(requestId, false)
}

/**
 * The out-of-window fallback: an OS notification when no Forge window is
 * focused to show the prompt. A doorbell, not a control — it carries no buttons
 * and can approve nothing; clicking it brings the app (and the real prompt,
 * with the words to compare) to the front. If nobody comes, the approval times
 * out as a deny, which is the only acceptable answer to an unattended question
 * about a shell.
 */
function notifyApproval(ask: WebApprovalAsk): void {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.some((w) => w.isFocused())) return
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: 'A browser wants to connect to Forge',
    body: `"${ask.deviceName}" is asking to connect. Its screen should be showing ${ask.words}. Open Forge to allow or deny.`
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

/* -------------------------------------------------------------- rendezvous
 *
 * How a browser finds this desktop: one record at `users/<uid>/host`, written
 * over the Companion's REST client. See electron/web/rendezvous.ts, which owns
 * every decision about *when* to write; this half only answers its questions.
 */

/**
 * Build a Firebase client on Forge Web's own settings.
 *
 * `electron/companion/rest.ts` and not a second Firebase client: it already
 * does email/password sign-in and refresh-token rotation over plain REST with
 * no SDK, against the same identity provider, and the emulator suite it is
 * pointed at by `web-rendezvous:check` is the same one. Sharing the *client*
 * is not sharing the *session* — that is the whole distinction this file was
 * corrected to make.
 */
function makeRest(): FirebaseRest {
  const s = getSettings()
  const client = new FirebaseRest({
    apiKey: s.webApiKey,
    databaseURL: s.webDatabaseURL,
    ...(s.webAuthBase ? { authBase: s.webAuthBase } : {}),
    ...(s.webTokenBase ? { tokenBase: s.webTokenBase } : {})
  })
  // Rotated refresh tokens have to reach disk immediately: the rotation
  // invalidates the old one, so a crash before saving locks this feature out
  // until somebody signs in again. companion-sync.ts persists its own for
  // exactly this reason — and now that Forge Web owns a token rather than
  // borrowing one, it owns the saving of it too. The two never write the same
  // field, which is what makes that safe.
  client.onRefreshToken = (refreshToken) => {
    setSettings({ webRefreshToken: refreshToken })
  }
  return client
}

/**
 * The Firebase client the rendezvous writes with, or null when there is none.
 *
 * Note what is *not* guarded here: `webEnabled`. It looks like it belongs, and
 * it would be a bug. `WebRendezvous` asks `isEnabled()` before it ever asks
 * `rest()` (its header sets that order out at length), and this file only ever
 * constructs a rendezvous inside `start()`, which is itself past the gate — so
 * a switched-off Forge never reaches this function. The one path that *does*
 * reach it with the setting already false is `shutdown()` retracting a record
 * this desktop published while it was on, and refusing to hand over a client
 * there would leave the address in the database for the three minutes
 * `HOST_STALE_MS` takes to expire it. Retracting what we published is not
 * "reading a credential while off"; it is finishing what being on started.
 *
 * The guard that *is* here is the session, and it is one thing rather than the
 * two it used to be. There is no longer any comparison with `companionUid`,
 * because there is nothing to compare: the uid this publishes under is the uid
 * Forge Web signed in as. Signed out — no refresh token, or no project to
 * refresh it against — the answer is null, the rendezvous waits, and
 * `sessionStatus()` puts the reason on screen.
 *
 * Built fresh on each `start()` and on each sign-in rather than kept forever,
 * so a corrected project, a new account or a token rotated on disk is picked up
 * then rather than at the next launch.
 */
function webRest(): RendezvousRest | null {
  const s = getSettings()
  if (!s.webUid || !s.webApiKey || !s.webDatabaseURL || !s.webRefreshToken) return null
  if (!rest) {
    rest = makeRest()
    // `expiresAt: 0` forces a refresh on the first write, which is what turns a
    // stored refresh token back into a usable session — and is also how a
    // credential revoked in the Firebase console is discovered without a round
    // trip to the database.
    rest.adopt({
      uid: s.webUid,
      email: s.webEmail,
      idToken: '',
      refreshToken: s.webRefreshToken,
      expiresAt: 0
    })
  }
  return rest
}

function getRendezvous(): WebRendezvous {
  if (!rendezvous) {
    rendezvous = new WebRendezvous({
      isEnabled: () => getSettings().webEnabled && server !== null,
      rest: webRest,
      hostname: tunnelHostname,
      appVersion: () => app.getVersion(),
      computerName: () => hostname(),
      log: (line, ...extra) => console.log(`[web-rendezvous] ${line}`, ...extra)
    })
  }
  return rendezvous
}

/* --------------------------------------------------------------- sign in
 *
 * Forge Web's own front door to Firebase, and the same flow the Companion's
 * is: one HTTPS POST with the password, which is then dropped on the floor.
 * What reaches settings.json is the refresh token — revocable from the Firebase
 * console without touching a password Steve uses anywhere else — the uid, and
 * the email so the form pre-fills next time. Never the password, and never the
 * ID token, which lives for an hour and is minted again from the refresh token
 * whenever it is needed. `scripts/web-check.mjs` reads settings.json back off
 * disk to prove exactly that.
 */

/**
 * Sign Forge Web in, and start publishing if the link is already up.
 *
 * Deliberately does **not** set `webEnabled`. The Companion's sign-in switches
 * itself on because the thing it switches on is a message channel; this one
 * would be switching on a shell behind a public address, and that stays a
 * separate, explicit act (`web:start`). Signing in says who may reach this
 * desktop. It does not say "and let them, now".
 */
async function signIn(email: string, password: string): Promise<WebSignInResult> {
  const s = getSettings()
  if (!s.webApiKey || !s.webDatabaseURL) {
    return {
      ok: false,
      error: 'Set the Firebase API key and database URL for Forge Web first (see companion/GO-LIVE.md for where to find them).'
    }
  }
  try {
    const result = await makeRest().signIn(String(email ?? '').trim(), String(password ?? ''))
    setSettings({ webEmail: result.email, webUid: result.uid, webRefreshToken: result.refreshToken })
    // The old client, if any, holds the old session. Drop it so the next write
    // adopts the credential that was just saved.
    rest = null
    // Idempotent, and a no-op unless the server is already listening — see
    // `WebRendezvous.start`. With the link up this is what turns "signed in"
    // into a published address without waiting for the next heartbeat.
    getRendezvous().start()
    report('')
    return { ok: true, uid: result.uid, created: result.created }
  } catch (err) {
    const error = describe(err)
    report(error)
    return { ok: false, error }
  }
}

/**
 * Sign Forge Web out: retract the address, then forget the credential.
 *
 * The order is the point. Clearing `webUid` first would leave the rendezvous
 * unable to work out the path of the record it published, and the address of
 * this desktop would sit in the database until it went stale — up to three
 * minutes of browsers dialling a door that no longer admits anybody. So the
 * record goes first, with the session that wrote it still intact.
 *
 * `webEmail` survives, like the Companion's, so the form pre-fills. It is not a
 * credential; the credential is the refresh token, and that is gone.
 */
async function signOut(): Promise<void> {
  const service = rendezvous
  rendezvous = null
  await service?.shutdown()
  rest = null
  setSettings({ webUid: '', webRefreshToken: '' })
  report('Forge Web signed out. No browser can find this desktop until you sign in again.')
}

/* -------------------------------------------------------------- the picture */

function snapshotForBrowser(): Pick<WebHelloOkFrame, 'projects' | 'profiles' | 'workspaces'> {
  const projects = getProjects()
  const workspaces: Record<string, Workspace> = {}
  for (const project of projects) {
    const workspace = getWorkspace(project.id)
    if (workspace) workspaces[project.id] = workspace
  }
  return { projects, profiles: getSettings().agentProfiles, workspaces }
}

/**
 * The agent chooser's "is this actually installed" column.
 *
 * Two lists because they answer two different questions: the built-ins are a
 * fixed roster with install links (`probeAgents`), and the arbitrary command
 * lines are whatever custom profiles somebody has written, which the built-in
 * probe cannot know about. Both are PATH walks on this machine; the server caps
 * how many of the second kind one frame may ask for.
 */
function probeForBrowser(commands: string[]): { agents: AgentPresence[]; commands: CommandPresence[] } {
  return { agents: probeAgents(), commands: probeCommands(commands) }
}

/**
 * Tell every connected browser that the desktop's picture changed.
 *
 * Called from the two store writes in main.ts — `storeSetWorkspace`, which is
 * the one place that knows a layout moved whatever caused it and the place
 * `publishMobileState` is already called from, and `storeSetProjects` — so a
 * browser is only ever told about a picture that is already on disk.
 *
 * `projectId` names the workspace that changed, and carrying it is not optional
 * decoration: the browser's tab list comes from the `workspaces` map in
 * `hello-ok`, so a push of only the projects leaves that list frozen at whatever
 * it was when the tab connected.
 */
export function publishWebState(projectId?: string): void {
  if (!server) return
  server.pushProjects(getProjects())
  const workspace = projectId ? getWorkspace(projectId) : null
  if (projectId && workspace) server.pushWorkspace(projectId, workspace)
}

/* -------------------------------------------------------------- lifecycle */

async function start(): Promise<void> {
  if (server || starting) return
  const settings = getSettings()
  // The one gate. Everything below this line — the port, the JWKS fetcher, the
  // refresh token, the heartbeat timer — happens only past it.
  if (!settings.webEnabled) return

  starting = true
  report('Starting…')
  // A fresh Firebase client each time round, so a corrected uid, a sign-in
  // since the last start, or a refresh token rotated on disk is picked up here
  // rather than at the next launch. See `webRest`.
  rest = null

  const host: WebServerHost = {
    auth: getAuth(),
    appVersion: app.getVersion(),
    desktopName: () => hostname(),
    allowedOrigins: webAllowedOrigins,
    sessions: () => getManager().list(),
    replay: (id) => getReplay(id),
    write: (id, data) => getManager().write(id, data),
    resize: (id, cols, rows) => getManager().resize(id, cols, rows),
    snapshot: snapshotForBrowser,
    layout: dispatchLayout,
    // The exported functions, not the IPC handlers: a second host calls what
    // the handlers call, rather than pretending to be a window. See the
    // "handlers" note in electron/git-watcher.ts.
    gitStatus: (projectId) => gitRefresh(projectId),
    gitAction: (request) => runAction(request),
    skills: async () =>
      getSkillsStore()?.listAll(getSettings().skillsEnabled) ?? {
        skills: [],
        machineSkills: [],
        externalSkills: []
      },
    commands: () => commandsFeed(),
    agents: async (commands) => probeForBrowser(commands),
    onPresence: (connected) => {
      if (connected > 0) holdBlocker()
      else releaseBlocker()
      report()
    },
    log: (line) => console.log(line)
  }

  const instance = new WebServer(host)

  try {
    await instance.start({ host: WEB_BIND_HOST, port: webPort() })
  } catch (err) {
    starting = false
    const message = err instanceof Error ? err.message : String(err)
    // The overwhelmingly likely cause, and the one worth naming.
    const detail = /EADDRINUSE/.test(message)
      ? `Port ${webPort()} is already in use — set FORGE_WEB_PORT to a free one.`
      : message
    console.error(`[web] failed to start: ${message}`)
    report(detail)
    return
  }

  server = instance
  starting = false

  // The browser sees what the window sees, from the same coalesced flush.
  unsubscribePty = addPtySink({
    onData: (id, data) => instance.pushData(id, data),
    onSpawn: (id) => {
      // A pane that has just opened is the single moment a client has to build
      // an xterm and attach, so it gets its own frame as well as the list — see
      // `WebSessionStartedFrame`. Both, because the frame is the event and the
      // list is the truth.
      const session = getManager()
        .list()
        .find((s) => s.id === id)
      if (session) instance.pushSessionStarted(session)
      instance.pushSessions()
    },
    onExit: (id, exitCode) => {
      instance.pushExit(id, exitCode)
      // A dead pane changes the picture, so the list is refreshed too.
      instance.pushSessions()
    }
  })

  // Whatever the desktop's panel is shown, the browser's panel is shown.
  unsubscribeGit = addGitSink({
    onSnapshot: (snapshot: GitSnapshot) => instance.pushGit(snapshot)
  })

  report('')
  // A restart mid-window stays armed for the remainder — re-hang the disarm
  // timer so the remainder still ends itself.
  syncAcceptTimer()
  // After the server, never before: a tunnel pointed at a port nothing listens
  // on is a public address that refuses, and the record that would advertise it
  // says "dial this and a Forge will answer". `isEnabled()` checks
  // `server !== null` for the same reason.
  void startTunnel()
  getRendezvous().start()
}

/* -------------------------------------------------------------- the tunnel
 *
 * Forge Web's own supervised ngrok agent, through the class Forge Mobile
 * already drives (electron/mobile-tunnel.ts). A second instance, a second
 * domain, a second port — and, on the free plan, a second of the account's
 * three agent sessions, which is why stopping kills the process tree.
 *
 * The lifecycle is the server's: up after it listens, down before it stops.
 * Every early return leaves a sentence behind, because a tunnel that silently
 * is not there is the failure this half of the job exists to remove.
 */

/**
 * Bring the agent up, fetching the binary first if this machine has never had
 * one. Modelled on `startTunnel` in electron/mobile-host.ts, including the
 * re-check after the download: fetching 12 MB takes long enough that the world
 * can move under it.
 */
async function startTunnel(): Promise<void> {
  if (tunnel || tunnelStarting) return
  const settings = getSettings()
  if (settings.webTunnel !== 'ngrok') return
  if (!server) {
    setTunnelState({ state: 'error', url: '', detail: 'Turn Forge Web on first — the tunnel has nothing to carry.' })
    return
  }
  /*
   * The authtoken is required. The domain is not.
   *
   * Demanding both made a reserved domain compulsory, and ngrok's free tier
   * grants one per account — Forge Mobile holds it, and a domain forwards to a
   * single port, so Forge Web could not have one without paying. Blank means
   * ngrok assigns an address, which `ngrokArgs` now allows.
   *
   * That is safe *here* and would not be on the phone: the address changes
   * every restart, and the rendezvous record exists precisely so the browser
   * reads wherever this desktop landed before it dials. A phone that scanned a
   * QR keeps the address it was given, which is why Forge Mobile still asks
   * for a reserved one.
   */
  if (!settings.webNgrokAuthtoken) {
    setTunnelState({
      state: 'error',
      url: '',
      detail: 'Paste your ngrok authtoken below first — it is on the ngrok dashboard, under Your Authtoken.'
    })
    return
  }

  tunnelStarting = true
  try {
    const binDir = join(getDataDir(), 'bin')
    let exe = resolveNgrokExe({ env: process.env, binDir })
    if (!exe) {
      setTunnelState({ state: 'starting', url: '', detail: 'Fetching ngrok (one time, about 12 MB)…' })
      const fetched = await ensureNgrokExe({ binDir })
      if (!fetched.ok) {
        setTunnelState({ state: 'error', url: '', detail: fetched.error })
        return
      }
      exe = fetched.path
    }
    if (getSettings().webTunnel !== 'ngrok' || !server) return

    tunnel = new NgrokTunnel({
      exe,
      port: webPort(),
      domain: getSettings().webNgrokDomain,
      authtoken: getSettings().webNgrokAuthtoken,
      // Whose card to send somebody to when ngrok refuses permanently. Forge
      // Mobile's is the default in that module; this door is a different one
      // with a different authtoken and a different domain in it.
      settingsCard: 'Settings › Forge Web',
      onStatus: setTunnelState,
      log: (line) => console.log(`[web] ${line}`)
    })
    tunnelSpec = tunnelSpecNow()
    tunnel.start()
  } finally {
    tunnelStarting = false
  }
}

/**
 * Fold the supervisor's verdict into this desktop's picture.
 *
 * Two things follow from a tunnel changing state, and neither can be skipped:
 * the panel is told, and the *rendezvous* is told. The second is the one that
 * matters — the record carries the hostname a browser dials, so an agent that
 * has just come up on a new address must republish now rather than at the next
 * heartbeat, and an agent that has just died must have its address retracted
 * rather than left to go stale for three minutes. `refresh()` does both: it
 * re-reads `hostname()`, which is '' unless the tunnel is live.
 */
function setTunnelState(status: TunnelStatus): void {
  tunnelState = status
  rendezvous?.refresh()
  report()
}

/** Take the agent down — the whole process tree, or it holds a session slot. */
function stopTunnel(): void {
  tunnel?.stop()
  tunnel = null
  tunnelSpec = ''
  tunnelState = TUNNEL_OFF
}

/**
 * Stop listening, and retract the address first.
 *
 * The order is the whole of this function. The browsers are told *why* before
 * their sockets close — without a `shutdown` frame every stop looks like a
 * network fault and the page spends the next minute retrying a machine that is
 * off instead of dropping to GitHub mode (see `WebShutdownFrame`). And the
 * rendezvous record is deleted rather than left to go stale, because a record
 * that outlives the server is up to three minutes of browsers dialling a port
 * nothing is on.
 */
async function stop(reason: 'quit' | 'disabled' = 'disabled'): Promise<void> {
  // Before the socket closes, and before anything else here can throw. A
  // rendezvous failure is logged and swallowed inside `shutdown()` by design,
  // so this cannot be the reason Forge will not close.
  const service = rendezvous
  rendezvous = null
  await service?.shutdown()
  rest = null
  // After the record and not before: retracting the address needs the network
  // the tunnel does not carry (Firebase is reached directly, not through it),
  // but the order still reads correctly — the advertisement goes, then the way
  // in goes, then the door.
  stopTunnel()

  // Switching the link off disarms it too: "off" must mean off, not "off but
  // primed to accept strangers the moment it is switched back on". Guarded on
  // being armed so a Forge that never had this feature on does not write
  // settings.json on the way out of every quit.
  if (armedUntil()) disarmAccept()
  else syncAcceptTimer()
  for (const requestId of [...pendingApprovals.keys()]) settleApproval(requestId, false)

  unsubscribePty?.()
  unsubscribePty = null
  unsubscribeGit?.()
  unsubscribeGit = null
  releaseBlocker()

  const instance = server
  server = null
  if (!instance) return
  await instance.stop({
    reason,
    message:
      reason === 'quit' ? 'Forge is shutting down on the desktop.' : 'Forge Web was switched off on the desktop.',
    // A quit is very likely temporary; a switch being turned off is not, and
    // telling the page to come back in a minute would be telling it to knock at
    // a door somebody deliberately locked.
    ...(reason === 'quit' ? { retryAfterMs: 60_000 } : {})
  })
}

/**
 * `prevent-app-suspension`, not `prevent-display-sleep`: the screen at home
 * should still go dark. What must not happen is Windows suspending Forge while
 * somebody is typing into it from a browser on the other side of the country.
 */
function holdBlocker(): void {
  if (blockerId && powerSaveBlocker.isStarted(blockerId)) return
  blockerId = powerSaveBlocker.start('prevent-app-suspension')
}

function releaseBlocker(): void {
  if (blockerId && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = 0
}

/* ------------------------------------------------------------------- IPC */

export function registerWebHandlers(): void {
  ipcMain.handle(IPC.webStatus, (): WebStatus => webStatus())

  ipcMain.handle(IPC.webStart, async (): Promise<WebStatus> => {
    setSettings({ webEnabled: true })
    await start()
    report()
    return webStatus()
  })

  ipcMain.handle(IPC.webStop, async (): Promise<WebStatus> => {
    setSettings({ webEnabled: false })
    await stop('disabled')
    report('')
    return webStatus()
  })

  /**
   * Forge Web's own sign-in. The password reaches Firebase and nothing else —
   * see `signIn`, and note that this does not switch the link on.
   */
  ipcMain.handle(IPC.webSignIn, async (_e, email: string, password: string): Promise<WebSignInResult> => {
    return signIn(String(email ?? ''), String(password ?? ''))
  })

  ipcMain.handle(IPC.webSignOut, async (): Promise<WebStatus> => {
    await signOut()
    return webStatus()
  })

  /**
   * Arm or disarm "Accept new browsers". Arming needs a listening server — an
   * armed door on a stopped server would be a toggle that lies — and always
   * arms for exactly one window from now; there is no "arm forever".
   */
  ipcMain.handle(IPC.webAccept, (_e, on: unknown): WebStatus => {
    if (on === true) {
      if (!server) {
        report('Turn Forge Web on first.')
        return webStatus()
      }
      setSettings({ webAcceptUntil: Date.now() + ACCEPT_WINDOW_MS })
      syncAcceptTimer()
      report('Accepting new browsers — open the page and sign in.')
    } else {
      disarmAccept()
      report('')
    }
    return webStatus()
  })

  ipcMain.handle(IPC.webRevoke, (_e, deviceId: string): WebStatus => {
    const id = String(deviceId ?? '')
    if (getAuth().revoke(id)) {
      // Revoking a browser that is connected right now has to hang up on it, or
      // "revoked" would only mean "revoked next time" — and this door has a
      // live shell behind it.
      server?.disconnectDevice(id)
      report('Browser removed.')
    }
    return webStatus()
  })

  ipcMain.handle(IPC.webForget, (_e, deviceId: string): WebStatus => {
    const id = String(deviceId ?? '')
    if (getAuth().forget(id)) {
      // Same reasoning as revoke: whatever the row said, the socket it belongs
      // to is no longer one this desktop has agreed to.
      server?.disconnectDevice(id)
      report('Browser forgotten.')
    }
    return webStatus()
  })

  /**
   * Start enrolling a second factor. The secret lives in `WebAuth`'s memory
   * until a code proves an app holds it; nothing reaches settings.json here.
   */
  ipcMain.handle(IPC.webTotpBegin, (): WebTotpOffer => {
    if (!getTotpKey()) {
      return { ok: false, error: 'Forge could not create the key that protects a second factor on this machine.' }
    }
    const offer = getAuth().beginEnrolment(getSettings().webEmail)
    return { ok: true, secret: offer.secret, uri: offer.uri }
  })

  /**
   * Confirm it. The one call that writes a secret, and it writes it sealed —
   * see `saveTotpState`, which refuses rather than falling back to plaintext.
   */
  ipcMain.handle(IPC.webTotpConfirm, (_e, code: string): WebTotpResult => {
    const result = getAuth().completeEnrolment(String(code ?? ''))
    if (result.ok) report('Two-factor is on. Keep the recovery codes somewhere that is not this machine.')
    return result
  })

  ipcMain.handle(IPC.webTotpDisable, (): WebStatus => {
    getAuth().disableTotp()
    report('Two-factor is off.')
    return webStatus()
  })

  /**
   * The human's verdict on an approval prompt. `=== true` twice over (here and
   * in preload), because the difference between truthy and true is the
   * difference between a stranger with a shell and none.
   */
  ipcMain.on(IPC.webApprovalResult, (_e, payload: { requestId?: string; allow?: boolean }) => {
    settleApproval(String(payload?.requestId ?? ''), payload?.allow === true)
  })

  /** The renderer's verdict on a `webCommand`. */
  ipcMain.on(IPC.webCommandResult, (_e, payload: { requestId?: string; error?: string }) => {
    const requestId = String(payload?.requestId ?? '')
    const pending = pendingOps.get(requestId)
    if (!pending) return
    pendingOps.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(payload?.error ? String(payload.error) : null)
    // Whatever just changed, tell the browsers. The workspace write that
    // followed it will say so again with the layout attached; this is the
    // projects half, which nothing else covers.
    publishWebState()
  })
}

/**
 * Re-read settings and bring the link up or down to match. Called on boot and
 * from the settings write handler, exactly like the Companion and Forge Mobile,
 * so flipping `webEnabled` takes effect now rather than at the next launch.
 *
 * The rendezvous is re-started on every call rather than only on a transition:
 * `start()` there is documented as cheap and idempotent, and it is the one path
 * that picks up a sign-in, a corrected uid, or a refresh token rotated on disk.
 *
 * The tunnel gets the same treatment, and needs it more: switching
 * `webTunnel` to `'ngrok'` or pasting a domain while the link is already up
 * must start an agent now. A tunnel already running is left alone —
 * `startTunnel()` returns immediately when one exists — so this stays cheap;
 * changing the *credentials* of a running tunnel is a stop and a start, which
 * is what main.ts's change-detection asks for by calling this after the write.
 */
export function applyWebSettings(): void {
  const enabled = getSettings().webEnabled
  if (enabled && !server) {
    void start().then(() => report())
    return
  }
  if (!enabled && server) {
    void stop('disabled').then(() => report(''))
    return
  }
  if (!enabled) return
  // Enabled and already listening. Bring the tunnel in line with what the
  // settings now say — including "switched off", which has to take the agent
  // down rather than leave a public address open onto a link Steve believes he
  // has closed, and "same switch, different domain", which an already-running
  // agent cannot honour without being restarted.
  if (getSettings().webTunnel !== 'ngrok') {
    if (tunnel) {
      stopTunnel()
      rendezvous?.refresh()
    }
  } else {
    if (tunnel && tunnelSpec !== tunnelSpecNow()) stopTunnel()
    void startTunnel()
  }
  getRendezvous().start()
}

export async function disposeWeb(): Promise<void> {
  for (const [, pending] of pendingOps) {
    clearTimeout(pending.timer)
    pending.resolve('Forge is shutting down.')
  }
  pendingOps.clear()
  // stop() below also settles these (as denies — shutdown is not consent), but
  // dispose must not depend on stop being reached.
  for (const requestId of [...pendingApprovals.keys()]) settleApproval(requestId, false)
  if (acceptTimer) {
    clearTimeout(acceptTimer)
    acceptTimer = null
  }
  await stop('quit')
}

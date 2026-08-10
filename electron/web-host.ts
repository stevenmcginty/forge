import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { app, BrowserWindow, ipcMain, Notification, powerSaveBlocker } from 'electron'
import { IPC } from '@shared/ipc'
import { ACCEPT_WINDOW_MS } from '@shared/mobile'
import { APPROVAL_TIMEOUT_MS, normaliseHost, webSocketUrl, type WebHelloOkFrame, type WebLayoutOp } from '@shared/web'
import type {
  AgentPresence,
  CommandPresence,
  GitSnapshot,
  WebApprovalEvent,
  WebCommandEvent,
  WebRendezvousStatus,
  WebStatus,
  WebTunnelStatus,
  Workspace
} from '@shared/types'
import { WebAuth, googleJwksFetcher, type WebApprovalAsk } from './web/auth'
import { WebServer, type WebServerHost } from './web/server'
import { WebRendezvous, type RendezvousRest } from './web/rendezvous'
import { FirebaseRest } from './companion/rest'
import { addPtySink, getManager, getReplay } from './pty-host'
import { addGitSink, gitRefresh, runAction } from './git-watcher'
import { getProjects, getSettings, getWorkspace, setSettings } from './store'
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
 * Five jobs:
 *
 *  1. Own the server's lifecycle against `webEnabled`, and the rendezvous
 *     record's alongside it. Off by default and *silent* when off: no port
 *     bound, no credential read, no hostname published, no timer started. That
 *     is not tidiness — docs/forge-web.md's security posture promises it in
 *     those words, and `scripts/web-check.mjs` asserts it by inspecting the
 *     listener and the rendezvous rather than by trusting the setting.
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
 * ## What this file deliberately does not do
 *
 * **It does not run the tunnel.** `electron/mobile-tunnel.ts` supervises an
 * *ngrok* agent for Forge Mobile; there is no `cloudflared` supervisor anywhere
 * in the app, and `npm run mobile:tunnel` is a standalone dev script rather than
 * a module. docs/forge-web.md ("What only Steve can do", item 3) asks for a
 * *named* Cloudflare tunnel, which is a thing set up once on the machine and run
 * as a service — it has a stable hostname and nothing about it changes when
 * Forge restarts. So the honest wiring is that Forge is *told* the hostname
 * (`FORGE_WEB_HOSTNAME`) and publishes it, and reports `state: 'off'` rather
 * than inventing a liveness it cannot observe. Starting a second tunnel
 * supervisor here would be a process Forge owns, kills and reports on, for a
 * tunnel it did not create.
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
 * Loopback, always, and not a setting. `cloudflared` runs on this machine and
 * dials the socket from here, so the public side never touches this port
 * directly and `isAllowedSource` in electron/web/server.ts still sees
 * 127.0.0.1. Binding this listener to 0.0.0.0 would put the internet-facing
 * half of Forge on the LAN as well, for no gain — Forge Mobile is the LAN
 * answer and it has its own port.
 */
const WEB_BIND_HOST = '127.0.0.1'

/** Next door to Forge Mobile's 8420. Overridable for a second Forge on one box. */
const DEFAULT_WEB_PORT = 8421

function webPort(): number {
  const raw = Number(process.env['FORGE_WEB_PORT'] ?? '')
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_WEB_PORT
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

/**
 * Held while at least one browser is connected, so Windows does not suspend the
 * app mid-session and drop every socket. Released the moment the last one goes:
 * a desktop that never sleeps because of a link nobody is using is a bug.
 */
let blockerId = 0

/* ------------------------------------------------------------------- auth */

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
 * `configured` means "somebody told us a hostname"; it is not a claim that
 * anything is listening on the far end of it, because Forge does not run the
 * tunnel and has no way to know. See the header.
 */
function tunnelStatus(): WebTunnelStatus {
  const host = tunnelHostname()
  if (!host) {
    return {
      state: 'off',
      host: '',
      detail:
        'No tunnel hostname. Set FORGE_WEB_HOSTNAME to the hostname of your Cloudflare tunnel — until then a browser has no address to dial.'
    }
  }
  return { state: 'configured', host, detail: '' }
}

/**
 * The tunnel's public hostname, normalised, or '' when there is none.
 *
 * Through `normaliseHost` even though it came from this machine's own
 * environment: what leaves here becomes the address a browser opens a socket
 * to, and publishing a half-hostname only moves the failure to dial time, where
 * it reads as a network fault instead of as a typo in an environment variable.
 */
function tunnelHostname(): string {
  return normaliseHost(process.env['FORGE_WEB_HOSTNAME'] ?? '')
}

function rendezvousStatus(): WebRendezvousStatus {
  const state = rendezvous?.getState()
  return { published: state?.published ?? '', at: state?.at ?? 0, detail: state?.detail ?? '' }
}

export function webStatus(): WebStatus {
  const settings = getSettings()
  const address = server?.address() ?? null
  const tunnel = tunnelStatus()
  return {
    enabled: settings.webEnabled,
    state: !settings.webEnabled ? 'off' : starting ? 'starting' : address ? 'listening' : 'error',
    configured: Boolean(settings.webProjectId && settings.webUid),
    host: address?.host ?? WEB_BIND_HOST,
    port: address?.port ?? webPort(),
    // The address only means anything while something is listening on it — a
    // URL for a server that is off is a link that would be sent to somebody and
    // then not answer.
    url: address ? webSocketUrl(tunnel.host) : '',
    devices: settings.webDevices,
    connected: server?.connectedCount ?? 0,
    acceptUntil: armedUntil(),
    detail: lastDetail,
    tunnel,
    rendezvous: rendezvousStatus()
  }
}

function report(detail?: string): void {
  if (detail !== undefined) lastDetail = detail
  broadcast(IPC.webStatusEvent, webStatus())
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
 * Two guards, and neither is decoration:
 *
 *  - **`companionUid === webUid`.** The record's *path* is built from the
 *    signed-in uid, and the credential this desktop holds belongs to the
 *    Companion. `companionUid` moves whenever somebody signs the Companion in
 *    or out; publishing under whatever it happens to be would put this
 *    machine's address in a stranger's subtree, and would advertise a shell to
 *    an account `webUid` does not admit. If the two disagree, the honest
 *    answer is to publish nothing.
 *  - **The credential itself.** No API key, no database URL or no refresh
 *    token means there is no session to write with.
 *
 * Built fresh on each `start()` rather than kept forever, and the refresh token
 * it rotates onto is deliberately *not* persisted from here: the Companion owns
 * that credential and writes it, and two clients racing to save the same field
 * is how one of them ends up holding a token the other has replaced.
 */
function webRest(): RendezvousRest | null {
  const s = getSettings()
  if (!s.webUid || !s.webProjectId) return null
  if (!s.companionUid || s.companionUid !== s.webUid) return null
  if (!s.companionApiKey || !s.companionDatabaseURL || !s.companionRefreshToken) return null
  if (!rest) {
    rest = new FirebaseRest({
      apiKey: s.companionApiKey,
      databaseURL: s.companionDatabaseURL,
      ...(s.companionAuthBase ? { authBase: s.companionAuthBase } : {}),
      ...(s.companionTokenBase ? { tokenBase: s.companionTokenBase } : {})
    })
    // `expiresAt: 0` forces a refresh on the first write, which is what turns a
    // stored refresh token back into a usable session.
    rest.adopt({
      uid: s.webUid,
      email: s.companionEmail,
      idToken: '',
      refreshToken: s.companionRefreshToken,
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
  // A fresh Firebase client each time round, so a corrected uid, a Companion
  // signed in since the last start, or a refresh token the Companion has
  // rotated is picked up here rather than at the next launch. See `webRest`.
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
  // After the server, never before: the record says "dial this address and a
  // Forge will answer", and publishing it while nothing is listening is an
  // invitation to a socket that refuses. `isEnabled()` checks `server !== null`
  // for the same reason.
  getRendezvous().start()
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
 * that picks up a Companion sign-in, a corrected uid, or a refresh token the
 * Companion has since rotated.
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
  if (enabled && server) getRendezvous().start()
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

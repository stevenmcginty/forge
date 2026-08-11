import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, powerSaveBlocker, screen } from 'electron'
import { IPC } from '@shared/ipc'
import { type MirrorInput } from '@shared/mobile'
import {
  normaliseHost,
  PIN_MAX_DIGITS,
  PIN_MIN_DIGITS,
  webSocketUrl,
  type WebHelloOkFrame,
  type WebLayoutOp,
  type WebMirrorChunk,
  type WebMirrorConfig
} from '@shared/web'
import type {
  AgentPresence,
  CommandPresence,
  GitSnapshot,
  TunnelStatus,
  WebCommandEvent,
  WebMirrorEvent,
  WebProjectAddEvent,
  WebRefusal,
  WebRendezvousStatus,
  WebSessionStatus,
  WebSignInResult,
  WebStatus,
  WebTunnelStatus,
  WebWatchEvent,
  Workspace
} from '@shared/types'
import { WebAuth, googleJwksFetcher } from './web/auth'
import { checkFolder, listFolder } from './web/fs-browse'
import { hashPin, isValidPin } from './web/pin'
import { WebServer, type WebServerHost } from './web/server'
import { WebRendezvous, type RendezvousRest } from './web/rendezvous'
import { describe, FirebaseRest } from './companion/rest'
import { NgrokTunnel, ensureNgrokExe, resolveNgrokExe } from './mobile-tunnel'
/*
 * The input injector, borrowed whole from the phone link. It is a module-level
 * singleton in this process — one PowerShell child, started on the first event
 * and torn down with the picture — so a second link driving the same desk needs
 * no new plumbing and, more importantly, cannot end up with a second helper. Its
 * header is the file to read before believing anything about what a browser can
 * do to this machine; `npm run input:check` is what proves it.
 */
import { canDriveDesktop, driveDesktop, stopDesktopInput } from './mobile/input'
import { CloudflareTunnel, ensureCloudflaredExe, resolveCloudflaredExe } from './cloudflare-tunnel'
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
 * Seven jobs:
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
 *  5. Keep this desktop's terminal geometry out of a browser's hands while
 *     there is a window here to disturb, and hand it over when there is not.
 *     One PTY, two viewers — the block of that name below is the whole of it,
 *     and it is deliberately *not* Forge Mobile's arrangement.
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
 * supervises an agent of its own — a cloudflared quick tunnel by default, or
 * ngrok when somebody wants one steady address; see "the tunnel" below — so
 * `starting`, `live` and `error` are observations. The variable
 * survives as an explicitly-documented override for a tunnel run by hand; see
 * `tunnelHostname()`, which is careful to say `configured` rather than `live`
 * on that path.
 *
 * ## What this file deliberately does not do
 *
 * **It does not push `attention`.** It is optional on `WebServerHost`, and it
 * is half of a pair whose other half nothing owns: Forge has no structured
 * agent-permission channel at all, and the desktop learns a pane is waiting by
 * watching *settled output* in `src/lib/terminals.ts`. There is no main-side
 * source to forward, so "cheaply available" is not true here — it would mean a
 * second detector.
 *
 * That is not a refusal, and it is one IPC channel on the day something exists
 * to forward. What must not happen in the meantime is a channel that implies a
 * behaviour nothing performs. `onWatch` stood in this same list for a
 * milestone on exactly that reasoning — naming the watched sessions is only
 * worth anything if the renderer then does something with the names — and left
 * it the day the renderer half was written, not before. What it does with them
 * has since shrunk to a label on the pane header, and that is still something.
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
 * **5174 is the one that matters**, because it is the port `web/vite.config.ts`
 * pins the web client to with `strictPort` — and its comment there says exactly
 * why: the desktop renderer's own dev server already has 5173 in `npm run dev`,
 * and both are routinely up at once. Naming only 5173 here meant `npm run
 * web:dev` was refused at the door by every desktop in the repo, with a bare
 * 403 during the upgrade and so nothing on screen but a retry loop.
 *
 * 5173 stays because docs/forge-web.md names it and because a desktop that is
 * *not* also running its own renderer can hand it to the web client. Two ports
 * on loopback in an unpackaged build is not a wider door than one.
 * `FORGE_WEB_ORIGINS` remains the way to name a third without editing this file.
 */
const DEV_ORIGINS = [
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]

let server: WebServer | null = null
let auth: WebAuth | null = null
let rendezvous: WebRendezvous | null = null
let rest: FirebaseRest | null = null
let unsubscribePty: (() => void) | null = null
let unsubscribeGit: (() => void) | null = null
/**
 * How long a PTY resize waits before the session list is pushed again.
 *
 * The desk owns the grid, so every pane it refits is news a browser reading
 * that pane has to hear — and the desk refits in bursts: a window drag, a
 * split, a tab switch move several panes at once. Long enough to make one
 * message out of a burst, short enough that a browser is never drawing last
 * second's geometry.
 */
const GEOMETRY_PUSH_MS = 80
let geometryPush: NodeJS.Timeout | null = null
let lastDetail = ''
let starting = false

/**
 * The last browser refused at the door for the page it was on, or null.
 *
 * Kept here rather than in the server because it outlives a restart of the
 * listener and because the panel reads its picture from `webStatus()`. Only
 * ever the *last* one: a page that is on the wrong address retries every few
 * seconds, so a list would be the same sentence a hundred times, and the
 * hundredth is worth no more than the first.
 */
let lastRefusal: WebRefusal | null = null

/** Forge Web's own tunnel agent, and the last thing it said. See the tunnel block. */
const TUNNEL_OFF: TunnelStatus = { state: 'off', url: '', detail: '' }
let tunnel: CloudflareTunnel | NgrokTunnel | null = null
let tunnelState: TunnelStatus = TUNNEL_OFF
let tunnelStarting = false
/**
 * What the running agent was started with. Either agent takes its port — and
 * ngrok's also its domain and its account — on its command line and cannot be
 * re-pointed afterwards, so this is how `applyWebSettings` tells "the settings
 * changed" from "the settings were saved" and restarts only in the first case.
 * The transport itself is part of it, because switching between the two is the
 * change most obviously requiring a different process. In memory only, and never
 * logged or reported — it contains the authtoken.
 */
let tunnelSpec = ''

function tunnelSpecNow(): string {
  const s = getSettings()
  return `${s.webTunnel}|${webPort()}|${s.webNgrokDomain}|${s.webNgrokAuthtoken}`
}

/** What to call the agent in a sentence, so a status never names the wrong one. */
function tunnelAgentName(): string {
  return getSettings().webTunnel === 'ngrok' ? 'ngrok' : 'cloudflared'
}

/**
 * Held while at least one browser is connected, so Windows does not suspend the
 * app mid-session and drop every socket. Released the moment the last one goes:
 * a desktop that never sleeps because of a link nobody is using is a bug.
 */
let blockerId = 0

/* ---------------------------------------------------- one PTY, two viewers
 *
 * A pane on the desktop and the same pane in a browser tab are the same
 * ConPTY, and a ConPTY has one width. Both ends used to fit it to their own
 * box, so whichever moved last won — and the desktop moves on every layout
 * change, which meant switching tabs at the desk quietly dragged the width back
 * from a browser reading that pane from somewhere else, and every line after
 * that was wrapped for a screen it was not being drawn on. Switching tabs in
 * the browser dragged it the other way. The two fought.
 *
 * This used to be settled Forge Mobile's way — while a browser had a pane open,
 * the browser owned its geometry and the desktop letterboxed itself at the
 * browser's size. That is the wrong trade for a *desk*. A phone is a glance at
 * a pane; the desktop is the machine somebody is working at, and watching every
 * pane on it re-flow because a tab opened somewhere else is the app rearranging
 * the work in front of you on a stranger's behalf.
 *
 * So the rule is now the other way round, and it has one line: **while this
 * desktop has a window open, the desk owns the grid.** A browser still says
 * what size it is reading at — the frames are unchanged — but that wish is only
 * granted when there is no window to disturb, which is exactly the case Forge
 * Web exists for (the desk closed to the tray, the terminals still running).
 * With a window open the wish is dropped in electron/web/server.ts, and the
 * browser draws the desk's grid at a font small enough to fit its own box; see
 * `follow` in web/src/lib/term.ts.
 *
 * What the renderer is still told is *which* panes a browser is reading
 * (`webWatched`), because "IN BROWSER" on a pane header is honest and useful.
 * It is no longer told a size, because it no longer follows one. Phones live
 * under the same rule — see `setPhoneWatched` in src/lib/terminals.ts and the
 * matching `deskOpen` gate in electron/mobile/server.ts.
 */

/** Session ids at least one browser currently has open. */
let watched = new Set<string>()

/**
 * Is there a desktop window to disturb?
 *
 * The same question `askRenderer` and `mirrorWindow` below ask, in the same
 * terms, because it is the same fact: a window that is not destroyed has a
 * renderer holding the split tree, drawing panes, and refitting them. Note that
 * closing Forge's window with the link on *hides* it rather than destroying it
 * (see the close handler in electron/main.ts), so a Forge sitting in the tray
 * still counts as open — which is the answer this policy wants. That window
 * comes back, and it must come back to the grid it was left at rather than to
 * one a browser chose while nobody was looking.
 */
function deskOpen(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())
}

/**
 * Tell the renderer which panes a browser is reading.
 *
 * Ids and nothing else: the renderer draws these panes at its own size like any
 * other, and the one thing it does differently is label them. A size in this
 * message would be a size somebody would eventually follow.
 */
function publishWatched(): void {
  broadcast(IPC.webWatched, { ids: [...watched] } satisfies WebWatchEvent)
}

/* ------------------------------------------------------------------- auth */

function getAuth(): WebAuth {
  if (!auth) {
    auth = new WebAuth({
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
      // The stored hash, never the digits, and read per connection like
      // everything else here — so setting or clearing a PIN at the desk bites
      // on the next hello rather than the next launch. Blank is the shipped
      // state and the account-only path; see the header of electron/web/auth.ts.
      pinHash: () => getSettings().webPin,
      log: (line) => console.log(`[web] ${line}`)
    })
  }
  return auth
}

/* ---------------------------------------------------------------- origins */

/**
 * The pages a browser may open this socket from.
 *
 * Derived rather than written down, and that is the whole point: a production
 * origin hard-coded in this file would be a second place the deployment is
 * named, and the first thing to go stale when it moves. Firebase Hosting gives
 * every *site* two domains — `<site>.web.app` and `<site>.firebaseapp.com` —
 * and both are served the same bundle, so a page loaded from either has to be
 * able to connect. Both ids are safe to interpolate because
 * `electron/store.ts` only admits `/^[a-z0-9][a-z0-9-]{2,62}$/` into them.
 *
 * ## The site, and the bug that named it
 *
 * This function used to derive its origins from `webProjectId` alone, on the
 * assumption that a project's Hosting site carries the project's name. That is
 * only Firebase's *default*, for a project that has never had a second site
 * added — and this repo has two, because the Companion's PWA and Forge Web's
 * bundle are different sites in one project. `.firebaserc` says so:
 *
 *     "hosting": { "companion": ["forge-sync-aadafc"], "web": ["forge-web-aadafc"] }
 *
 * So the page really served at `https://forge-web-aadafc.web.app` presented an
 * origin this desktop had never heard of, every upgrade was refused with
 * `Origin not allowed`, and — because that refusal happens *during* the
 * handshake, where there is no socket to explain it on — the browser saw a
 * failed connection and did the only reasonable thing with one, which is retry.
 * "Reconnecting to the desktop (attempt 6)…" for as long as anybody watched.
 * Nothing in the token path was wrong and nothing in the tunnel was down.
 *
 * Hence `webSiteId`, and hence the fallback: blank means "named after the
 * project", which is what every single-site project has and what this code
 * assumed of all of them. The project's own pair is still included even when a
 * site is named, because the Companion's site *is* the project and a browser
 * arriving from either address is the same browser.
 *
 * `FORGE_WEB_ORIGINS` (comma-separated) is for a custom domain and for the
 * Phase 3 dev loop on an unusual port. The dev origins are appended only in an
 * unpackaged run.
 *
 * An empty list admits no browser at all, which is the correct answer for an
 * unconfigured desktop — see `originAllowed` in electron/web/server.ts.
 *
 * Exported for `scripts/web-check.mjs`, which asserts that nothing in here is a
 * fixed production address *and* that the site this repo actually deploys to is
 * among the addresses it produces.
 */
export function webAllowedOrigins(): string[] {
  const origins: string[] = []
  for (const raw of (process.env['FORGE_WEB_ORIGINS'] ?? '').split(',')) {
    const clean = raw.trim()
    if (clean) origins.push(clean)
  }
  const settings = getSettings()
  for (const name of new Set([settings.webSiteId, settings.webProjectId])) {
    if (name) origins.push(`https://${name}.web.app`, `https://${name}.firebaseapp.com`)
  }
  if (!app.isPackaged) origins.push(...DEV_ORIGINS)
  return origins
}

/**
 * Record the browser this desktop just turned away, and say so out loud.
 *
 * The notification is the point. A refused origin is invisible from the browser
 * by construction — it retries a handshake that never completes — so unless the
 * desktop speaks, the only evidence anywhere is a line in a log nobody is
 * reading. It fires once per *origin* rather than once per attempt: the page
 * behind it reconnects every couple of seconds, and a notification per attempt
 * would be a machine shouting the same sentence until it was muted.
 */
function noteOriginRefused(origin: string, allowed: string[]): void {
  const clean = origin.trim()
  const first = lastRefusal?.origin !== clean
  lastRefusal = { origin: clean, allowed, at: Date.now() }
  report()
  if (!first) return
  console.log(`[web] a browser at ${clean || '(no origin)'} is not one this desktop serves`)
  if (!Notification.isSupported()) return
  new Notification({
    title: 'Forge Web turned a browser away',
    body: clean
      ? `${clean} is not an address this desktop serves. Check "Hosting site" in Settings › Forge Web.`
      : 'A browser was refused because this desktop serves no origins yet. Fill in Settings › Forge Web.'
  }).show()
}

/**
 * Forget the refusal once the address that caused it would now be admitted.
 *
 * Called after settings are applied, so the panel's warning disappears when the
 * thing it asked for has been done rather than lingering until a restart — a
 * warning that survives its own fix teaches people to ignore warnings.
 */
function clearRefusalIfFixed(): void {
  if (!lastRefusal) return
  const origin = lastRefusal.origin.toLowerCase().replace(/\/$/, '')
  if (webAllowedOrigins().some((allowed) => allowed.trim().toLowerCase().replace(/\/$/, '') === origin)) {
    lastRefusal = null
  }
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
    return {
      state: 'error',
      host: '',
      detail: `${tunnelAgentName()} reported an address Forge cannot use (${tunnelState.url}).`
    }
  }

  if (tunnelState.state === 'starting' || tunnelState.state === 'retrying') {
    return { state: 'starting', host: '', detail: tunnelState.detail }
  }
  if (tunnelState.state === 'error') return { state: 'error', host: '', detail: tunnelState.detail }

  return {
    state: 'off',
    host: '',
    detail:
      getSettings().webTunnel === 'off'
        ? 'No way in from outside yet. Switch the tunnel on in Settings › Forge Web, or set FORGE_WEB_HOSTNAME to a tunnel you run yourself.'
        : tunnelState.detail
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
    connected: server?.connectedCount ?? 0,
    // Read off the server rather than tracked here, so the card cannot say
    // "being watched" about a viewer the socket has already lost. The card is
    // the only place a person can find this out: a capture in progress looks
    // exactly like no capture at all.
    mirroring: server?.mirroring ?? false,
    // Whether one is set, never what it is and never its hash. This status
    // crosses an IPC boundary into a renderer — the panel needs the fact, and
    // the fact is all it gets.
    pinSet: Boolean(settings.webPin),
    detail: lastDetail,
    session,
    tunnel,
    rendezvous: rendezvousStatus(),
    refusal: lastRefusal
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

/* ------------------------------------------------------------ op dispatch */

interface PendingOp {
  resolve: (error: string | null) => void
  timer: NodeJS.Timeout
}

const pendingOps = new Map<string, PendingOp>()
/** A renderer that never answers must not leave a browser waiting forever. */
const OP_TIMEOUT_MS = 8000

/**
 * Ask the renderer a question that only it can answer, and wait for its verdict.
 *
 * Returns an error sentence, or null on success. The reason it is a sentence
 * rather than a boolean is the failure this cannot avoid: Forge minimised is
 * fine, Forge with its window closed is not, because the split tree and the
 * project list both live in the renderer.
 *
 * One function for both questions, because the *mechanism* is the same — a
 * request id, a pending map, a deadline, and an answer on
 * `IPC.webCommandResult` — even though the payloads are different enough to
 * deserve channels of their own (see `IPC.webProjectAdd`). The caller supplies
 * the channel, the payload, and the sentence to use when there is no window,
 * because "it cannot change tabs" and "it cannot add a project" are different
 * things to be told.
 */
function askRenderer(channel: string, payload: object, noWindow: string): Promise<string | null> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.length === 0) return Promise.resolve(noWindow)

  const requestId = randomUUID()
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingOps.delete(requestId)
      resolve('The desktop did not answer in time.')
    }, OP_TIMEOUT_MS)
    pendingOps.set(requestId, { resolve, timer })
    windows[0].webContents.send(channel, { ...payload, requestId })
  })
}

/**
 * One layout operation, performed by the renderer. The server turns any
 * sentence this resolves with into `no-window`, which is exactly what the
 * windowless case is.
 */
function dispatchLayout(op: WebLayoutOp, deviceName: string): Promise<string | null> {
  return askRenderer(
    IPC.webCommand,
    { deviceName, op } satisfies Omit<WebCommandEvent, 'requestId'>,
    'Forge has no window open on the desktop, so it cannot change tabs.'
  )
}

/**
 * A folder a browser picked, on its way to the project rail.
 *
 * The folder is checked *here*, before the renderer hears about it at all:
 * `checkFolder` is what turns "a string arrived off a socket" into "an absolute
 * path that is a directory on this disk right now". The listing the browser
 * chose from could be minutes old, and a project row pointing at a folder that
 * has been renamed is a rail entry every terminal opened from it would fail on.
 *
 * Past that check it is the renderer's, through `addProjectPath` — the same
 * function the desktop's own button reaches. That is decision 5 applied to the
 * rail rather than to tabs: the renderer owns the project list and persists it,
 * so a browser must not be able to reach a code path a local click cannot.
 */
function dispatchProjectAdd(path: string, deviceName: string): Promise<string | null> {
  const checked = checkFolder(path)
  if (!checked.ok) return Promise.resolve(checked.error)
  return askRenderer(
    IPC.webProjectAdd,
    { deviceName, path: checked.path } satisfies Omit<WebProjectAddEvent, 'requestId'>,
    'Forge has no window open on the desktop, so it cannot add a project.'
  )
}

/* -------------------------------------------------------- the screen mirror
 *
 * A browser watching this desktop's own screen, and — behind the guard below —
 * driving it.
 *
 * Nothing about capturing or encoding lives in the main process: it has no
 * display to open a stream onto and no `VideoEncoder` to hand one to. So the
 * picture half is a pass-through, exactly as Forge Mobile's is — the server's
 * hook becomes a message to the window, and the window's chunks become frames
 * on the socket. The renderer half is src/lib/mirror.ts.
 *
 * The *input* half is not a pass-through. It ends at `user32.dll`, on whatever
 * window happens to be under the pointer, and everything below `canControl` is
 * arranged around that one sentence.
 */

/** The window the capture runs in, or null when Forge has none open. */
function mirrorWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return windows[0] ?? null
}

function sendMirror(event: WebMirrorEvent): void {
  mirrorWindow()?.webContents.send(IPC.webMirror, event)
}

/**
 * Begin a mirror, or say why not — three gates, in the order that costs least
 * to fail.
 *
 *  1. **The setting.** Off is the shipped state, and a desktop that is not
 *     sharing its screen should say so before anything else is spent on the
 *     question — in particular before somebody is asked for a PIN to unlock a
 *     feature that was never going to start.
 *  2. **A fresh PIN**, when one is set. Not the one that opened the connection
 *     an hour ago: see `checkFreshPin` in electron/web/auth.ts, which exists
 *     for this and says why a PIN typed at the start of the day is not an
 *     answer to "is somebody still there".
 *  3. **A window.** The capture runs in the renderer, so a Forge with its
 *     window closed cannot share its screen at all. Minimised is fine — a
 *     minimised window still captures.
 *
 * Everything discoverable only once capture is attempted — a refused permission,
 * no display to name, an encoder that will not configure — comes back later on
 * `IPC.webMirrorStop` instead, and reaches the browser as the same
 * `mirror-stop` frame.
 *
 * Whether this one carries sound is decided here, now, and travels with the
 * request. `webMirrorAudio` is read at the moment the browser asks rather than
 * captured at boot — the same rule the control gate follows — but unlike an
 * input frame a capture is negotiated once, so switching the sound off silences
 * the next watch and not this one.
 */
function startMirror(pin: string): { error: string; needsPin?: boolean } | null {
  const settings = getSettings()
  if (!settings.webMirrorEnabled) {
    return { error: 'This desktop does not share its screen with browsers. Turn it on in Settings › Forge Web.' }
  }
  const fresh = getAuth().checkFreshPin(pin)
  if (!fresh.ok) return { error: fresh.message, ...(fresh.needed ? { needsPin: true } : {}) }
  const win = mirrorWindow()
  if (!win) return { error: 'Forge has no window open on the desktop, so it cannot share its screen.' }
  win.webContents.send(IPC.webMirror, { kind: 'start', audio: settings.webMirrorAudio } satisfies WebMirrorEvent)
  return null
}

/**
 * A watch began or ended. Both edges, because the desk has to do something
 * different at each.
 *
 * The notification is not a courtesy. Everything else Forge Web does is visible
 * in the app itself — a tab opens, a pane appears, git moves — but a screen
 * being captured looks exactly like a screen not being captured, and this door
 * faces the internet. So the desk says it out loud, whether or not anybody is
 * looking at Forge. It is a statement of fact about the machine rather than a
 * question anybody is being asked.
 */
function onMirror(watching: boolean): void {
  if (watching) {
    console.log('[web] a browser is watching this screen')
    if (Notification.isSupported()) {
      new Notification({
        title: 'A browser is watching this screen',
        body: canControl()
          ? 'It can also move the mouse and type. Stop it from Settings › Forge Web.'
          : 'It can see this screen but cannot touch it. Stop it from Settings › Forge Web.'
      }).show()
    }
  } else {
    // The helper is torn down with the picture. It costs half a second to start
    // and nothing to keep, but a PowerShell process outliving the browser that
    // needed it is the kind of thing people find in a task manager and
    // reasonably worry about. Every ending routes through here — a hang-up, a
    // `mirror-stop` frame, a revocation, `stop()` — which is what makes one
    // teardown enough.
    stopDesktopInput()
    sendMirror({ kind: 'stop' })
  }
  report()
}

/* ---------------------------------------------- driving from another country
 *
 * The mirror pointing back the other way: a browser's pointer as this desktop's
 * mouse. Everything else in this file ends inside Forge; this ends at the
 * operating system, on whatever window is under the cursor.
 *
 * ## The escalation guard
 *
 * Control is refused outright unless an unlock PIN is set, and that rule is the
 * load-bearing one rather than the `webControlEnabled` toggle beside it.
 *
 * The reason is that a browser which can move the mouse can open Settings on
 * this desk and switch every remaining lock off itself. On an account-only
 * desktop a stolen Firebase password would therefore not merely be a shell: it
 * would be a shell that can quietly re-key the door. Requiring the PIN means
 * the mouse always arrives *after* something a stolen password does not come
 * with — and, because `startMirror` asks for it again rather than accepting the
 * one that opened the socket, after something typed seconds ago.
 *
 * Both gates are read per event, never captured. Switching control off, or
 * clearing the PIN, while somebody is holding the pointer stops the next click
 * rather than the next session.
 */

/** May the browser watching this screen touch this machine, right now? */
function canControl(): boolean {
  const settings = getSettings()
  if (!canDriveDesktop() || !settings.webControlEnabled) return false
  // The escalation guard. See the block above — this is the line, and it is
  // deliberately not a second toggle somebody could switch off from the browser
  // it is protecting against.
  return Boolean(settings.webPin)
}

/**
 * A fraction of the mirrored screen, as a physical pixel on it.
 *
 * `pointFor` in electron/mobile-host.ts, restated rather than imported for the
 * reason shared/web.ts restates MAX_SESSIONS: importing it would drag Forge
 * Mobile's whole host — its discovery, its APK route, its tunnel supervisor —
 * into this file to borrow six lines. The two must stay identical, and the
 * reasoning lives there in full:
 *
 * three coordinate systems meet here and none of them is the browser's. The
 * capture is of the *primary* display, so that display's bounds are what a 0..1
 * pair is a fraction of; Electron reports those bounds in device-independent
 * pixels, and `SetCursorPos` wants real ones, which on a screen at 150% is a
 * different number. `dipToScreenPoint` is the conversion, and it is only correct
 * because the input helper declares itself DPI-aware before its first call —
 * changing either place alone puts the cursor where nobody aimed it.
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
 * `false` is the answer the browser is told about — see `onMirrorInput` in
 * electron/web/server.ts, which turns it into one sentence per watch rather
 * than a silence somebody has to interpret. A pointer that moves in the tab and
 * nowhere else is the failure this exists to prevent.
 */
function applyInput(input: MirrorInput): boolean {
  if (!canControl()) return false
  // A key stroke and a typed phrase both have no position — they land wherever
  // the focus already is, which is the whole point of them. The coordinates are
  // ignored for those two and asked for anyway everywhere else, so the helper's
  // grammar stays one shape.
  const at = input.a === 'key' || input.a === 'text' ? { x: 0, y: 0 } : pointFor(input.x, input.y)
  driveDesktop(input, at)
  return true
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
    onOriginRefused: noteOriginRefused,
    sessions: () => getManager().list(),
    replay: (id) => getReplay(id),
    write: (id, data) => getManager().write(id, data),
    resize: (id, cols, rows) => getManager().resize(id, cols, rows),
    // The policy point is the server, which drops a browser's cols/rows while
    // this is true rather than passing them here. It is a thunk, not a value,
    // for the reason every other thunk on this host is one: the window can go
    // and come back inside one connection, and a captured answer would be a
    // stale one for the rest of it.
    deskOpen,
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
    // Pure filesystem work with no renderer in it: the browser is being shown
    // what is on this disk, not asking for anything to change, so this one is
    // answered here rather than forwarded. Everything it will and will not do
    // is in electron/web/fs-browse.ts, including why a refusal is a value.
    fsList: async (path, name) => listFolder(path, name),
    projectAdd: (path, deviceName) => dispatchProjectAdd(path, deviceName),
    mirrorStart: startMirror,
    onMirror,
    // Two hooks rather than one, and read per event rather than captured: the
    // first decides whether to *offer* a cursor when the picture starts, the
    // second decides whether to move it, and between those two moments somebody
    // may have switched control off at this desk.
    mirrorControl: canControl,
    mirrorInput: applyInput,
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
      // Re-adoption after a renderer reload arrives here too, and a renderer
      // that has just reloaded has forgotten which of its panes a browser is
      // reading — the labels on them, and nothing else now, but a label that
      // survives a dev reload is a label that can be trusted. Re-stating the
      // list costs one message.
      publishWatched()
    },
    onResize: () => {
      // The desk moved a pane's grid, and every browser reading it has just
      // been left drawing the wrong one. `sessions` already carries cols/rows,
      // so the news needs no new frame — only sending. Coalesced, because a
      // window drag or a split is several panes resizing in the same breath and
      // each one would otherwise broadcast the whole list.
      if (geometryPush) return
      geometryPush = setTimeout(() => {
        geometryPush = null
        instance.pushSessions()
      }, GEOMETRY_PUSH_MS)
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
  // After the server, never before: a tunnel pointed at a port nothing listens
  // on is a public address that refuses, and the record that would advertise it
  // says "dial this and a Forge will answer". `isEnabled()` checks
  // `server !== null` for the same reason.
  void startTunnel()
  getRendezvous().start()
}

/* -------------------------------------------------------------- the tunnel
 *
 * Forge Web's own supervised agent, and there are two of them to choose from
 * because the first choice was wrong in a way nobody could see from the code.
 *
 * This file used to drive only `NgrokTunnel` — Forge Mobile's supervisor, a
 * second instance on Forge Web's own port — on the reasoning that reusing a
 * class which already downloads, spawns, restarts and gives up beat writing a
 * second one. What that reasoning never checked is that **ngrok's free plan
 * allows one online endpoint per account**: with the phone link up, Forge Web's
 * agent was refused (ERR_NGROK_334) and the only way to read a browser link was
 * to switch the phone link off. Two links that cannot both be up is one link.
 *
 * So `webTunnel` now names a transport rather than a boolean:
 *
 *  - **cloudflared** (electron/cloudflare-tunnel.ts) — the default. A quick
 *    tunnel with no account, no domain, no token and no per-account limit, so
 *    it runs happily beside Forge Mobile's ngrok agent. Its hostname changes on
 *    every start, which costs nothing here and is the case the rendezvous
 *    record was built for.
 *  - **ngrok** — kept, and still the right answer for anybody who wants one
 *    steady address and is content to stop the phone link to get it.
 *
 * The lifecycle is the server's either way: up after it listens, down before it
 * stops. Every early return leaves a sentence behind, because a tunnel that
 * silently is not there is the failure this half of the job exists to remove.
 */

/**
 * Bring the chosen agent up, fetching its binary first if this machine has
 * never had one. Modelled on `startTunnel` in electron/mobile-host.ts, including
 * the re-check after the download: fetching tens of megabytes takes long enough
 * that the world can move under it — the switch can be flipped off, or the
 * transport changed, while the bytes are still arriving.
 */
async function startTunnel(): Promise<void> {
  if (tunnel || tunnelStarting) return
  const mode = getSettings().webTunnel
  if (mode === 'off') return
  if (!server) {
    setTunnelState({ state: 'error', url: '', detail: 'Turn Forge Web on first — the tunnel has nothing to carry.' })
    return
  }

  tunnelStarting = true
  try {
    if (mode === 'cloudflared') await startCloudflared()
    else await startNgrok()
  } finally {
    tunnelStarting = false
  }
}

/**
 * The default path, and the shortest function in this block — which is the
 * whole argument for it. There is no credential to check, no domain to
 * validate, and nothing for somebody to have forgotten to paste.
 */
async function startCloudflared(): Promise<void> {
  const binDir = join(getDataDir(), 'bin')
  let exe = resolveCloudflaredExe({ env: process.env, binDir })
  if (!exe) {
    setTunnelState({ state: 'starting', url: '', detail: 'Fetching cloudflared (one time, about 50 MB)…' })
    const fetched = await ensureCloudflaredExe({ binDir })
    if (!fetched.ok) {
      setTunnelState({ state: 'error', url: '', detail: fetched.error })
      return
    }
    exe = fetched.path
  }
  // The world may have moved during a 50 MB download; see `startTunnel`.
  if (getSettings().webTunnel !== 'cloudflared' || !server) return

  tunnel = new CloudflareTunnel({
    exe,
    port: webPort(),
    onStatus: setTunnelState,
    log: (line) => console.log(`[web] ${line}`)
  })
  tunnelSpec = tunnelSpecNow()
  tunnel.start()
}

/** The steady-address path, unchanged from when it was the only one. */
async function startNgrok(): Promise<void> {
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
  if (!getSettings().webNgrokAuthtoken) {
    setTunnelState({
      state: 'error',
      url: '',
      detail: 'Paste your ngrok authtoken below first — it is on the ngrok dashboard, under Your Authtoken.'
    })
    return
  }

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
 *
 * On the cloudflared path "a new address" is not an edge case but the norm — a
 * quick tunnel is handed a different `*.trycloudflare.com` name every time the
 * process starts — so this is the line that makes the default transport usable
 * at all, and scripts/web-check.mjs asserts a restart-on-a-different-hostname
 * reaches the record.
 */
function setTunnelState(status: TunnelStatus): void {
  tunnelState = status
  rendezvous?.refresh()
  report()
}

/**
 * Take the agent down — the whole process tree, whichever agent it is. A
 * stranded ngrok holds one of the account's session slots; a stranded
 * cloudflared holds a public address open onto a link Steve believes he closed.
 */
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

  unsubscribePty?.()
  unsubscribePty = null
  unsubscribeGit?.()
  unsubscribeGit = null
  // A pending push would fire into a server that has stopped, which is the
  // ordinary shape of switching the link off a beat after moving a pane.
  if (geometryPush) clearTimeout(geometryPush)
  geometryPush = null
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
   * Set the unlock PIN. The only call that writes one, and the digits stop
   * here: what reaches settings.json is `hashPin`'s output and nothing else.
   *
   * The shape is checked in main rather than trusted from the panel, because a
   * renderer is not the thing that decides what opens this door — and a refusal
   * is a sentence rather than a silent no-op, since the person typing it is the
   * one who has to fix it.
   */
  ipcMain.handle(IPC.webPinSet, (_e, pin: unknown): WebStatus | { error: string } => {
    const typed = String(pin ?? '')
    if (!isValidPin(typed)) {
      return { error: `A PIN is ${PIN_MIN_DIGITS} to ${PIN_MAX_DIGITS} digits, and nothing else.` }
    }
    setSettings({ webPin: hashPin(typed) })
    report('Browsers will be asked for the PIN from the next connection.')
    return webStatus()
  })

  /**
   * Remove it. Browsers then get in on the account alone, and screen control is
   * refused outright — see `canControl`.
   */
  ipcMain.handle(IPC.webPinClear, (): WebStatus => {
    setSettings({ webPin: '' })
    report('The PIN is off — browsers signed in as this account get in without one.')
    return webStatus()
  })

  /* ------------------------------------------------------ the screen mirror
   *
   * The renderer's half, all three of them sends: the capture is a stream, not
   * a question, so there is no request/response pair and no pending map. What
   * arrives here is clamped and rebuilt field by field before it goes near a
   * socket — this is a renderer talking, but what it says ends up on a public
   * wire, and `WebMirrorConfig` is the shape a decoder is configured from.
   */

  /** The capture is up, and here is what the browser's decoder needs. */
  ipcMain.on(IPC.webMirrorReady, (_e, payload: Partial<WebMirrorConfig>) => {
    const description = String(payload?.description ?? '')
    server?.pushMirrorReady({
      codec: String(payload?.codec ?? ''),
      width: Math.max(0, Math.floor(Number(payload?.width) || 0)),
      height: Math.max(0, Math.floor(Number(payload?.height) || 0)),
      // Absent means "the chunks are self-describing", which is a different
      // instruction to a decoder than an empty string — see `WebMirrorConfig`.
      ...(description ? { description } : {})
    })
  })

  /** One encoded chunk. The server holds it to MAX_MIRROR_CHUNK_BYTES. */
  ipcMain.on(IPC.webMirrorChunk, (_e, payload: Partial<WebMirrorChunk>) => {
    const duration = Number(payload?.duration)
    server?.pushMirrorFrame({
      data: String(payload?.data ?? ''),
      key: payload?.key === true,
      timestamp: Math.floor(Number(payload?.timestamp) || 0),
      ...(Number.isFinite(duration) && duration > 0 ? { duration: Math.floor(duration) } : {})
    })
  })

  /**
   * The capture ended on this side — it was refused, Steve stopped sharing at
   * the OS level, the encoder died. A sentence the browser shows instead of a
   * frozen last frame.
   */
  ipcMain.on(IPC.webMirrorStop, (_e, payload: { reason?: string }) => {
    server?.pushMirrorStop(String(payload?.reason ?? '') || 'The desktop stopped sharing its screen.')
  })

  /**
   * The person at the desk pressed Stop. Distinct from `webMirrorStop` above,
   * which is the capture reporting its own death: this is somebody taking their
   * screen back, so it is an invoke that answers with the new status, and it
   * ends the watch at the socket — the teardown of the capture follows from
   * that through `onMirror`, rather than being asked for separately.
   */
  ipcMain.handle(IPC.webMirrorEnd, (): WebStatus => {
    server?.pushMirrorStop('The screen was taken back at the desk.')
    return webStatus()
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
 * `webTunnel` on, or from one transport to the other, or pasting a domain while
 * the link is already up, must start the right agent now. A tunnel already
 * running on the settings it was started with is left alone — `startTunnel()`
 * returns immediately when one exists — so this stays cheap; changing the
 * transport or the credentials under a running agent is a stop and a start,
 * which `tunnelSpec` is what detects and which main.ts's change-detection asks
 * for by calling this after the write.
 */
export function applyWebSettings(): void {
  // Before anything else, and on every path including the ones that return
  // early: naming the Hosting site is precisely the fix the refusal asks for,
  // and the warning must not outlive it.
  clearRefusalIfFixed()
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
  if (getSettings().webTunnel === 'off') {
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
  await stop('quit')
}

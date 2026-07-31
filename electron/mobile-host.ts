import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from 'electron'
import { IPC } from '@shared/ipc'
import { MOBILE_PORT, pairLink, type HelloOkFrame, type OpFrame } from '@shared/mobile'
import type { MobileDeviceRecord, MobileStatus, MobileTunnelStatus, Settings } from '@shared/types'
import { MobileAuth, PAIR_TTL_MS } from './mobile/auth'
import { MobileServer } from './mobile/server'
import { NgrokTunnel, ensureNgrokExe, pairEndpoint, resolveNgrokExe } from './mobile-tunnel'
import { addPtySink, getManager, getReplay } from './pty-host'
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
 *  3. Turn a phone's `op` frame into a renderer command and wait for its
 *     answer. Tabs and panes are the renderer's to own — it holds the split
 *     tree and persists the workspace — so the phone joins that code path
 *     instead of growing a parallel one in main that could disagree with it.
 */

let server: MobileServer | null = null
let auth: MobileAuth | null = null
let unsubscribePty: (() => void) | null = null
let lastDetail = ''
let starting = false

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
  const tailnet = (ip: string): boolean => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  return [...found.filter(tailnet), ...found.filter((ip) => !tailnet(ip))]
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
    connected: server?.connectedCount ?? 0,
    detail: lastDetail,
    tunnel: tunnelStatus
  }
}

function report(detail?: string): void {
  if (detail !== undefined) lastDetail = detail
  broadcast(IPC.mobileStatusEvent, mobileStatus())
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
 * Ask the renderer to perform a layout operation, and wait for its verdict.
 *
 * Returns an error sentence, or null on success. The known failure worth a
 * clear message is "no window": Forge minimised is fine, Forge with its window
 * closed is not, because the split tree lives in the renderer. That limit is
 * documented in docs/MOBILE.md rather than papered over.
 */
async function dispatchOp(op: OpFrame, deviceName: string): Promise<string | null> {
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
    sessions: () => getManager().list(),
    replay: (id) => getReplay(id),
    write: (id, data) => getManager().write(id, data),
    resize: (id, cols, rows) => getManager().resize(id, cols, rows),
    snapshot: () => snapshotForPhone(),
    dispatchOp,
    ...(mobileWebRoot() ? { webRoot: mobileWebRoot() } : {}),
    onPresence: (connected) => {
      if (connected > 0) holdBlocker()
      else releaseBlocker()
      report()
    },
    log: (line) => console.log(line)
  })

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

  server = instance
  starting = false

  // The phone sees what the window sees, from the same coalesced flush.
  unsubscribePty = addPtySink({
    onData: (id, data) => instance.pushData(id, data),
    onExit: (id, exitCode) => {
      instance.pushExit(id, exitCode)
      // A dead pane changes the picture, so the phone's list is refreshed too.
      instance.pushState({ sessions: getManager().list() })
    }
  })

  report('')
  // The tunnel wants the server listening before it advertises a way in.
  void startTunnel()
}

async function stop(): Promise<void> {
  stopTunnel()
  unsubscribePty?.()
  unsubscribePty = null
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

function snapshotForPhone(): Pick<HelloOkFrame, 'projects' | 'profiles' | 'workspaces'> {
  const projects = getProjects()
  const workspaces: Record<string, import('@shared/types').Workspace> = {}
  for (const project of projects) {
    const workspace = getWorkspace(project.id)
    if (workspace) workspaces[project.id] = workspace
  }
  return { projects, profiles: getSettings().agentProfiles, workspaces }
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
 *
 * A packaged Forge ships `out/**` and nothing else (see electron-builder.yml),
 * so `mobile/dist` only exists in a checkout. `FORGE_MOBILE_WEB` overrides it
 * for anyone who wants to serve a built bundle from elsewhere.
 */
function mobileWebRoot(): string {
  const override = process.env.FORGE_MOBILE_WEB?.trim()
  if (override) return existsSync(override) ? override : ''
  if (app.isPackaged) return ''
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
 */
export function publishMobileState(): void {
  if (!server) return
  server.pushState({ projects: getProjects(), sessions: getManager().list() })
}

/* ------------------------------------------------------------------- IPC */

export function registerMobileHandlers(): void {
  ipcMain.handle(IPC.mobileStatus, () => mobileStatus())

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
}

/** Called on boot and whenever settings change, exactly like the Companion. */
export function applyMobileSettings(): void {
  const enabled = getSettings().mobileEnabled
  if (enabled && !server) {
    void start().then(() => report())
    return
  }
  if (!enabled && server) {
    void stop().then(() => report(''))
  }
}

export async function disposeMobile(): Promise<void> {
  for (const [, pending] of pendingOps) {
    clearTimeout(pending.timer)
    pending.resolve('Forge is shutting down.')
  }
  pendingOps.clear()
  await stop()
}

/** Exported for the smoke test, which needs the device shape without Electron. */
export type { MobileDeviceRecord }

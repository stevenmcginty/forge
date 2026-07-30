import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { isNoFeedError, updaterMode } from '@shared/tools'
import type { UpdateStatus } from '@shared/types'

/**
 * Forge updating itself.
 *
 * Three rules, and everything in this file follows from them:
 *
 *  1. **Packaged builds only.** A dev run must never download or replace
 *     anything — `npm run dev` is a checkout, and an updater that overwrote it
 *     would be destroying uncommitted work. The guard is `updaterMode()` in
 *     shared/tools.ts, which is a pure function so it can be tested without
 *     packaging the app, and it is checked before electron-updater is so much
 *     as *imported*.
 *  2. **Nothing downloads without being asked.** `autoDownload = false`. The
 *     check is automatic; the megabytes are not. A banner appears, and until
 *     somebody clicks it Forge has done nothing but one HTTPS GET.
 *  3. **No feed is not an error.** The GitHub repo may not exist yet, the
 *     laptop may be on a train. Both come back from electron-updater as
 *     exceptions, and both mean "no update" — see isNoFeedError().
 *
 * FORGE_FAKE_UPDATE=x.y.z runs the entire banner flow — offered, downloading
 * with a progress bar, ready, restart — against a version that does not exist,
 * without electron-updater and without the ability to install anything. It is
 * how the banner is developed and how it was verified.
 */

/** Let the window paint and the panes start before touching the network. */
const FIRST_CHECK_DELAY_MS = 8000
/** Steve leaves Forge open for days; six hours is roughly "once a session". */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000

type Mode = 'real' | 'simulated' | 'off'

let mode: Mode = 'off'
let status: UpdateStatus = { phase: 'unsupported' }
let timer: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let simulatedTimer: NodeJS.Timeout | null = null
let target: BrowserWindow | null = null
/** electron-updater's AppUpdater, loaded lazily and only in `real` mode. */
let autoUpdater: import('electron-updater').AppUpdater | null = null

function broadcast(next: UpdateStatus): void {
  status = next
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.updateStatusEvent, status)
}

export function setUpdateTarget(win: BrowserWindow | null): void {
  target = win
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/* ------------------------------------------------------------- simulated */

/**
 * The fake flow. Deliberately a separate code path rather than a stubbed
 * electron-updater: there is then no configuration in which the simulated mode
 * could reach a real download, because the object that knows how to download
 * was never constructed.
 */
function simulatedVersion(): string {
  return (process.env['FORGE_FAKE_UPDATE'] ?? '').trim()
}

function simulateDownload(): void {
  let percent = 0
  const version = simulatedVersion()
  if (simulatedTimer) clearInterval(simulatedTimer)
  simulatedTimer = setInterval(() => {
    percent = Math.min(100, percent + 7)
    if (percent >= 100) {
      if (simulatedTimer) clearInterval(simulatedTimer)
      simulatedTimer = null
      broadcast({ phase: 'ready', version, simulated: true })
      return
    }
    broadcast({
      phase: 'downloading',
      version,
      percent,
      // A plausible-looking rate, so the banner's formatting is exercised.
      bytesPerSecond: 3.4 * 1024 * 1024,
      simulated: true
    })
  }, 320)
}

/* ------------------------------------------------------------------ real */

async function loadAutoUpdater(): Promise<import('electron-updater').AppUpdater | null> {
  if (autoUpdater) return autoUpdater
  try {
    // Required lazily: in a dev run this module is never reached, so a broken
    // or absent electron-updater cannot stop Forge from starting.
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: import('electron-updater').AppUpdater
      default?: { autoUpdater: import('electron-updater').AppUpdater }
    }
    // electron-updater is CommonJS, and this bundle is too, so `import()` hands
    // back a module namespace whose `default` is the real module.exports.
    // cjs-module-lexer does *not* pick `autoUpdater` up as a named export here
    // (it is a lazy getter), so `.default` is the one that actually resolves —
    // checked first, with the named one kept as a fallback in case a future
    // release changes that.
    const updater = mod.default?.autoUpdater ?? mod.autoUpdater ?? null
    if (!updater) return null

    updater.autoDownload = false
    // Installing on quit behind your back is the same sin as downloading behind
    // your back, one step later. The only install is quitAndInstall(), from the
    // banner, after you clicked it.
    updater.autoInstallOnAppQuit = false
    updater.logger = null

    updater.on('checking-for-update', () => {
      if (status.phase === 'downloading' || status.phase === 'ready') return
      broadcast({ phase: 'checking' })
    })
    updater.on('update-available', (info: { version: string }) => {
      if (status.phase === 'downloading' || status.phase === 'ready') return
      broadcast({ phase: 'available', version: info?.version ?? '' })
    })
    updater.on('update-not-available', () => {
      if (status.phase === 'downloading' || status.phase === 'ready') return
      broadcast({ phase: 'idle' })
    })
    updater.on('download-progress', (p: { percent?: number; bytesPerSecond?: number }) => {
      broadcast({
        phase: 'downloading',
        ...(status.version ? { version: status.version } : {}),
        percent: Math.round(p?.percent ?? 0),
        bytesPerSecond: Math.round(p?.bytesPerSecond ?? 0)
      })
    })
    updater.on('update-downloaded', (info: { version: string }) => {
      broadcast({ phase: 'ready', version: info?.version ?? status.version ?? '' })
    })
    updater.on('error', (err: Error) => {
      const message = err?.message ?? String(err)
      if (isNoFeedError(message)) {
        // No releases yet, or no network. Neither is news.
        broadcast({ phase: 'idle' })
        return
      }
      console.error('[updater]', message)
      broadcast({ phase: 'error', error: message.slice(0, 200) })
    })

    autoUpdater = updater
    return updater
  } catch (err) {
    console.error('[updater] could not load electron-updater:', (err as Error).message)
    return null
  }
}

/* --------------------------------------------------------------- actions */

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (mode === 'off') return status
  if (mode === 'simulated') {
    // The fake feed always has something, otherwise there would be nothing to
    // look at. Re-checking while a fake download is in flight is a no-op.
    if (status.phase === 'downloading' || status.phase === 'ready') return status
    broadcast({ phase: 'available', version: simulatedVersion(), simulated: true })
    return status
  }
  const updater = await loadAutoUpdater()
  if (!updater) {
    broadcast({ phase: 'unsupported' })
    return status
  }
  try {
    await updater.checkForUpdates()
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    if (isNoFeedError(message)) broadcast({ phase: 'idle' })
    else broadcast({ phase: 'error', error: message.slice(0, 200) })
  }
  return status
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (mode === 'off') return status
  if (status.phase !== 'available') return status
  if (mode === 'simulated') {
    broadcast({ phase: 'downloading', version: simulatedVersion(), percent: 0, simulated: true })
    simulateDownload()
    return status
  }
  const updater = await loadAutoUpdater()
  if (!updater) return status
  broadcast({ phase: 'downloading', ...(status.version ? { version: status.version } : {}), percent: 0 })
  try {
    await updater.downloadUpdate()
  } catch (err) {
    broadcast({ phase: 'error', error: ((err as Error)?.message ?? String(err)).slice(0, 200) })
  }
  return status
}

/**
 * Quit and install. The one function here that can change what is on disk, and
 * it is unreachable in every mode but `real`: a simulated "Restart to finish"
 * says so and does nothing, because restarting into an installer for a version
 * that does not exist would be a genuinely bad joke.
 */
export function installUpdate(): boolean {
  if (mode !== 'real' || status.phase !== 'ready' || !autoUpdater) return false
  // isSilent: false so the NSIS installer's window is visible — an unsigned
  // installer running invisibly is exactly the shape SmartScreen dislikes, and
  // exactly the shape a person should be able to see happening.
  autoUpdater.quitAndInstall(false, true)
  return true
}

/* ------------------------------------------------------------ lifecycle */

export function initUpdater(): void {
  mode = updaterMode(process.env, app.isPackaged)
  if (mode === 'off') {
    status = { phase: 'unsupported' }
    return
  }

  status = { phase: 'idle', ...(mode === 'simulated' ? { simulated: true } : {}) }

  firstTimer = setTimeout(() => {
    void checkForUpdate()
  }, FIRST_CHECK_DELAY_MS)

  if (mode === 'real') {
    timer = setInterval(() => {
      void checkForUpdate()
    }, RECHECK_EVERY_MS)
  }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC.updateStatus, () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, () => checkForUpdate())
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate())
  ipcMain.handle(IPC.updateInstall, () => installUpdate())
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer)
  if (firstTimer) clearTimeout(firstTimer)
  if (simulatedTimer) clearInterval(simulatedTimer)
  timer = null
  firstTimer = null
  simulatedTimer = null
  target = null
}

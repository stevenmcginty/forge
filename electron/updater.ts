import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import { basename } from 'node:path'
import { IPC } from '@shared/ipc'
import { isUpdateBusy, statusAfterUpdateError, updaterMode } from '@shared/tools'
import type { UpdateResult, UpdateStatus, UpdateStep } from '@shared/types'
import { acknowledgeUpdateResult, applyUpdate, canApplyUpdate, setUpdateResultSink } from './update-apply'
import { logUpdate, updateLogPath, updaterLogger } from './update-log'

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
 *     exceptions, and both mean "no update" — see isNoFeedError(). That holds
 *     for a *check* only: a 404 while downloading is a release whose installer
 *     is missing, and that is an error (statusAfterUpdateError()).
 *  4. **Never quitAndInstall.** The install is handed to the apply helper
 *     (electron/update-apply.ts), which can put the old version back. Every
 *     step is logged to <userData>\logs\updater.log (electron/update-log.ts).
 *
 * FORGE_FAKE_UPDATE=x.y.z runs the entire banner flow — offered, downloading
 * with a progress bar, ready, restart — against a version that does not exist,
 * without electron-updater and without the ability to install anything. It is
 * how the banner is developed and how it was verified. Restart there shows
 * `installing` for two seconds and then `updated` — or `failed` with
 * FORGE_FAKE_UPDATE_FAIL=1 — and nothing closes.
 */

/** Let the window paint and the panes start before touching the network. */
const FIRST_CHECK_DELAY_MS = 8000
/**
 * How often a running Forge asks GitHub for latest.yml.
 *
 * This was six hours, and six hours is why a friend's Forge sat on a build
 * Foreman could not launch from while four fixes went out in one afternoon
 * (2026-08-28, v0.3.108 → v0.3.111). The watchdog keeps Forge running for
 * days, so the "eight seconds after launch" check almost never fires on an
 * installed copy — the interval *is* the update mechanism. The check is one
 * HTTPS GET of a 400-byte file, so fifteen minutes costs nothing.
 */
const RECHECK_EVERY_MS = 15 * 60 * 1000
/**
 * A check also runs when the person comes back — window focus, screen unlock,
 * wake from sleep — because "I sat down at Forge" is exactly the moment an
 * update banner is useful. This is the floor between two such checks so a
 * flurry of alt-tabs is not a flurry of requests.
 */
const RETURN_CHECK_FLOOR_MS = 2 * 60 * 1000

type Mode = 'real' | 'simulated' | 'off'

let mode: Mode = 'off'
let status: UpdateStatus = { phase: 'unsupported' }
let timer: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let simulatedTimer: NodeJS.Timeout | null = null
let target: BrowserWindow | null = null
let lastCheckAt = 0
/** electron-updater's AppUpdater, loaded lazily and only in `real` mode. */
let autoUpdater: import('electron-updater').AppUpdater | null = null
/** What `update-downloaded` handed over: the installer the helper will run. */
let downloaded: { version: string; file: string; sha512: string } | null = null
/** The last install attempt, carried on every status for Settings. */
let lastResult: UpdateResult | null = null
/** Which network step is in flight, for the error event's log line. */
let inFlight: UpdateStep | null = null

function broadcast(next: UpdateStatus): void {
  status = lastResult ? { ...next, lastResult } : next
  logUpdate(`status: ${describeStatus(status)}`)
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.updateStatusEvent, status)
}

function describeStatus(s: UpdateStatus): string {
  const parts: string[] = [s.phase]
  if (s.version) parts.push(`v${s.version}`)
  if (s.phase === 'downloading') parts.push(`${s.percent ?? 0}%`)
  if (s.step) parts.push(`step=${s.step}`)
  if (s.closing) parts.push('closing')
  if (s.outcome) parts.push(`outcome=${s.outcome}`)
  if (s.from || s.to) parts.push(`${s.from ?? '?'} → ${s.to ?? '?'}`)
  if (s.error) parts.push(`error="${s.error}"`)
  if (s.reason) parts.push(`reason="${s.reason}"`)
  if (s.simulated) parts.push('simulated')
  return parts.join(' ')
}

/** A result as the banner's status: `updated` only for a verified success. */
function resultStatus(result: UpdateResult): UpdateStatus {
  if (result.outcome === 'succeeded') {
    return { phase: 'updated', version: result.to, from: result.from, to: result.to }
  }
  return {
    phase: 'failed',
    version: result.to,
    from: result.from,
    to: result.to,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.backupDir ? { backupDir: result.backupDir } : {}),
    ...(result.installDir ? { installDir: result.installDir } : {}),
    logPath: updateLogPath()
  }
}

/** An updater error, routed by the step it came from (see statusAfterUpdateError). */
function onUpdaterError(step: UpdateStep, message: string): void {
  logUpdate(`${step} failed: ${message}`)
  const next = statusAfterUpdateError(status, step, message)
  if (!next) {
    logUpdate(`${step} error ignored — the ${status.phase} state stays on screen`)
    return
  }
  broadcast(next.phase === 'error' ? { ...next, logPath: updateLogPath() } : next)
}

export function setUpdateTarget(win: BrowserWindow | null): void {
  target = win
  if (win) win.on('focus', () => checkOnReturn())
}

/** A check triggered by the person coming back, rate-limited; see RETURN_CHECK_FLOOR_MS. */
function checkOnReturn(): void {
  if (mode !== 'real') return
  if (Date.now() - lastCheckAt < RETURN_CHECK_FLOOR_MS) return
  void checkForUpdate()
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

/** The fake install: two seconds of `installing`, then the result. Nothing closes. */
function simulateInstall(version: string): { ok: boolean; reason?: string } {
  broadcast({ phase: 'installing', version, closing: true, simulated: true })
  if (simulatedTimer) clearInterval(simulatedTimer)
  simulatedTimer = setTimeout(() => {
    simulatedTimer = null
    const fail = process.env['FORGE_FAKE_UPDATE_FAIL'] === '1'
    const from = app.getVersion()
    lastResult = {
      outcome: fail ? 'rolled-back' : 'succeeded',
      from,
      to: version,
      current: fail ? from : version,
      ...(fail
        ? {
            reason:
              'Simulated failure (FORGE_FAKE_UPDATE_FAIL=1): the new version did not report in, so the old one was put back.'
          }
        : {}),
      at: new Date().toISOString(),
      acknowledged: false
    }
    broadcast({ ...resultStatus(lastResult), simulated: true })
  }, 2000)
  return { ok: true }
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
    // your back, one step later. The only install is installUpdate(), from the
    // banner, after you clicked it and confirmed.
    updater.autoInstallOnAppQuit = false
    updater.logger = updaterLogger

    // A check never replaces a download, a waiting installer or a result on
    // screen — see isUpdateBusy().
    updater.on('checking-for-update', () => {
      if (isUpdateBusy(status.phase)) return
      broadcast({ phase: 'checking' })
    })
    updater.on('update-available', (info: { version: string }) => {
      if (isUpdateBusy(status.phase)) return
      broadcast({ phase: 'available', version: info?.version ?? '' })
    })
    updater.on('update-not-available', () => {
      if (isUpdateBusy(status.phase)) return
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
    updater.on('update-downloaded', (info: DownloadedInfo) => {
      const version = info?.version ?? status.version ?? ''
      downloaded = { version, file: info?.downloadedFile ?? '', sha512: installerSha512(info) }
      logUpdate(`downloaded ${version}: ${downloaded.file} (sha512 ${downloaded.sha512 ? 'present' : 'MISSING'})`)
      broadcast({ phase: 'ready', version })
    })
    // Log only. checkForUpdates() and downloadUpdate() both reject with the
    // same error, and their catch blocks know which step failed — this event
    // does not, and deciding here is how a background check used to wipe out
    // a finished download.
    updater.on('error', (err: Error) => {
      logUpdate(`electron-updater error event${inFlight ? ` during ${inFlight}` : ''}: ${err?.message ?? String(err)}`)
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
    // look at. Re-checking while a fake download, install or result is on
    // screen is a no-op.
    if (isUpdateBusy(status.phase)) return status
    broadcast({ phase: 'available', version: simulatedVersion(), simulated: true })
    return status
  }
  const updater = await loadAutoUpdater()
  if (!updater) {
    broadcast({ phase: 'unsupported' })
    return status
  }
  lastCheckAt = Date.now()
  inFlight = 'check'
  try {
    await updater.checkForUpdates()
  } catch (err) {
    onUpdaterError('check', (err as Error)?.message ?? String(err))
  } finally {
    if (inFlight === 'check') inFlight = null
  }
  return status
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (mode === 'off') return status
  // "Try again" after a failed download is the same click as the first one.
  const retry = status.phase === 'error' && status.step === 'download'
  if (status.phase !== 'available' && !retry) return status
  if (mode === 'simulated') {
    broadcast({ phase: 'downloading', version: simulatedVersion(), percent: 0, simulated: true })
    simulateDownload()
    return status
  }
  const updater = await loadAutoUpdater()
  if (!updater) return status
  broadcast({ phase: 'downloading', ...(status.version ? { version: status.version } : {}), percent: 0 })
  inFlight = 'download'
  try {
    await updater.downloadUpdate()
  } catch (err) {
    onUpdaterError('download', (err as Error)?.message ?? String(err))
  } finally {
    if (inFlight === 'download') inFlight = null
  }
  return status
}

const RELEASES_URL = 'https://github.com/stevenmcginty/forge/releases/latest'

/**
 * Install. The one function here that can change what is on disk, and it is
 * unreachable in every mode but `real`: the simulated flow fakes the result
 * and closes nothing.
 *
 * It never calls electron-updater's quit-and-install. The downloaded installer
 * goes to the apply helper (electron/update-apply.ts), and Forge quits only
 * once the helper says it is ready — the banner's "Update now" was the
 * confirmation. If this copy of Forge is not an install the helper can update,
 * the answer is the installer download page, never a fallback to the path that
 * could leave nobody with a working Forge.
 *
 * "Try again" from a failure lands here too: with the installer still in hand
 * it installs again; without it (the failure came from the last launch) it
 * dismisses the result and checks, so the banner offers the download afresh.
 */
export async function installUpdate(): Promise<{ ok: boolean; reason?: string }> {
  const retry = status.phase === 'failed' || (status.phase === 'error' && status.step === 'install')
  if (status.phase !== 'ready' && !retry) return { ok: false, reason: 'There is no downloaded update to install.' }
  const version = status.to ?? status.version ?? ''
  logUpdate(`install requested for ${version || '?'}${retry ? ' (try again)' : ''}`)

  if (mode === 'simulated') return simulateInstall(version || simulatedVersion())
  if (mode !== 'real') return { ok: false, reason: 'Updates are off in this build.' }

  if (!downloaded || (version && downloaded.version !== version)) {
    if (!retry) return { ok: false, reason: 'The download is missing — check for the update again.' }
    await dismissUpdateResult()
    return { ok: false, reason: 'Checking for the update again.' }
  }
  if (!downloaded.file || !downloaded.sha512) {
    const reason = 'The downloaded installer has no checksum to verify.'
    onUpdaterError('install', reason)
    return { ok: false, reason }
  }

  const can = canApplyUpdate()
  if (!can.ok) {
    logUpdate(`install refused: ${can.reason ?? 'unknown'}`)
    const reason = `Forge cannot update itself from this folder (${can.reason ?? 'unknown'}). Download the installer from ${RELEASES_URL}`
    broadcast({ phase: 'error', step: 'install', version: downloaded.version, error: reason, logPath: updateLogPath() })
    return { ok: false, reason }
  }

  const to = downloaded.version
  const from = app.getVersion()
  broadcast({ phase: 'installing', version: to })
  const result = await applyUpdate({ from, to, file: downloaded.file, sha512: downloaded.sha512 }, () =>
    broadcast({ phase: 'installing', version: to, closing: true })
  )
  if (result.ok) return result
  if (result.aborted) {
    // The helper's preflight said no; nothing changed and Forge stays open.
    lastResult = {
      outcome: 'aborted',
      from,
      to,
      current: from,
      reason: result.reason,
      at: result.aborted.at || new Date().toISOString(),
      acknowledged: false
    }
    broadcast(resultStatus(lastResult))
  } else {
    broadcast({ phase: 'error', step: 'install', version: to, error: result.reason, logPath: updateLogPath() })
  }
  return { ok: false, reason: result.reason }
}

/** The person dismissed `updated` / `failed`. Settings keeps it as the last update. */
export async function dismissUpdateResult(): Promise<boolean> {
  if (status.phase !== 'updated' && status.phase !== 'failed') return false
  if (mode === 'real') await acknowledgeUpdateResult()
  if (lastResult) lastResult = { ...lastResult, acknowledged: true }
  broadcast({ phase: 'idle', ...(mode === 'simulated' ? { simulated: true } : {}) })
  // A result held the banner; whatever was released meanwhile is offered now.
  if (mode === 'real') void checkForUpdate()
  return true
}

/** Open the updater log in the default editor (writing a line first, so it exists). */
export async function openUpdateLog(): Promise<boolean> {
  logUpdate('log opened from the app')
  const error = await shell.openPath(updateLogPath())
  if (error) logUpdate(`could not open the log: ${error}`)
  return !error
}

type DownloadedInfo = {
  version: string
  downloadedFile?: string
  sha512?: string
  files?: Array<{ url?: string; sha512?: string }>
}

/**
 * The installer's base64 SHA-512 from latest.yml: the entry whose file name is
 * the one downloaded, else the first .exe (what NsisUpdater picks), else the
 * first entry, else the deprecated top-level field.
 */
function installerSha512(info: DownloadedInfo | undefined): string {
  const files = Array.isArray(info?.files) ? info.files : []
  const name = basename(info?.downloadedFile ?? '').toLowerCase()
  const fileName = (url: string | undefined): string => {
    const raw = basename(url ?? '')
    try {
      return decodeURIComponent(raw).toLowerCase()
    } catch {
      return raw.toLowerCase()
    }
  }
  const match =
    (name ? files.find((f) => fileName(f.url) === name) : undefined) ??
    files.find((f) => /\.exe$/i.test(f.url ?? '')) ??
    files[0]
  return match?.sha512 ?? info?.sha512 ?? ''
}

/* ------------------------------------------------------------ lifecycle */

export function initUpdater(): void {
  mode = updaterMode(process.env, app.isPackaged)
  if (mode === 'off') {
    status = { phase: 'unsupported' }
    return
  }

  status = { phase: 'idle', ...(mode === 'simulated' ? { simulated: true } : {}) }
  logUpdate(`updater started: mode ${mode}, Forge ${app.getVersion()}`)

  // The last install attempt, from reconcileUpdateOnStartup().
  setUpdateResultSink((result, show) => {
    lastResult = result
    broadcast(show ? resultStatus(result) : status)
  })

  firstTimer = setTimeout(() => {
    void checkForUpdate()
  }, FIRST_CHECK_DELAY_MS)

  if (mode === 'real') {
    timer = setInterval(() => {
      void checkForUpdate()
    }, RECHECK_EVERY_MS)
    // Wake and unlock are the other two "I'm back" signals; focus is wired in
    // setUpdateTarget because it belongs to the window rather than the app.
    powerMonitor.on('resume', checkOnReturn)
    powerMonitor.on('unlock-screen', checkOnReturn)
  }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC.updateStatus, () => getUpdateStatus())
  ipcMain.handle(IPC.updateCheck, () => checkForUpdate())
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate())
  ipcMain.handle(IPC.updateInstall, () => installUpdate())
  ipcMain.handle(IPC.updateDismissResult, () => dismissUpdateResult())
  ipcMain.handle(IPC.updateOpenLog, () => openUpdateLog())
}

export function disposeUpdater(): void {
  powerMonitor.removeListener('resume', checkOnReturn)
  powerMonitor.removeListener('unlock-screen', checkOnReturn)
  if (timer) clearInterval(timer)
  if (firstTimer) clearTimeout(firstTimer)
  if (simulatedTimer) clearInterval(simulatedTimer)
  timer = null
  firstTimer = null
  simulatedTimer = null
  target = null
  setUpdateResultSink(null)
}

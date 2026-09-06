import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, Notification } from 'electron'
import { IPC } from '@shared/ipc'
import type { RemoteYesStatus } from '@shared/types'
import {
  buildSetupScript,
  firstOptionMismatch,
  generatePassword,
  parseLatestRelease,
  parseSetupResult,
  parseTailscaleIp,
  redactPassword,
  RUSTDESK_EXE,
  RUSTDESK_RELEASE_URL,
  RUSTDESK_SERVICE,
  REMOTE_YES_PORT,
  UacWatcher
} from './remote-yes'
import { publishRemoteYes } from './mobile-host'
import { publishRemoteYes as publishRemoteYesToBrowsers } from './web-host'
import { getDataDir, getSettings, setSettings } from './store'

/**
 * Remote Yes — the Electron half.
 *
 * `electron/remote-yes.ts` holds the parsers, the password, the elevated script
 * and the watcher, all Electron-free so `scripts/remote-yes-check.mjs` can
 * drive them. Everything that needs Electron, the disk or a child process is
 * here: the download, the one elevated call, the settings writes, the desktop
 * notification and the five IPC handlers.
 *
 * ## What the button actually does, and why it asks for admin
 *
 * A Windows administrator (UAC) prompt is drawn on the **secure desktop**.
 * Nothing running as Steve — not Forge, not a screen capture, not a synthesised
 * click — can see it or press anything on it, which is why a phone driving this
 * PC goes dark for two minutes whenever one appears. RustDesk installed as a
 * Windows *service* can, because its SYSTEM helper runs in session 0 and is
 * allowed onto that desktop.
 *
 * Installing a service needs administrator rights. Forge has never asked for
 * them and asks here exactly once: a single `Start-Process -Verb RunAs` that
 * runs one script, immediately after a person pressed a button that says so.
 * Nothing afterwards is elevated. The watcher is an ordinary process reading an
 * ordinary process list.
 *
 * ## Why the configuration goes through one elevated script
 *
 * The service keeps its config under
 * `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\`,
 * which an unelevated process cannot write — editing `%APPDATA%\RustDesk\…`
 * does nothing at all. Options must go through `rustdesk.exe --option <key>
 * <value>` as administrator, so they are set inside the same elevated script
 * that installed it, read back by that script, and compared here. An option
 * that did not take is an error, not a warning: the one that matters is
 * `whitelist 100.64.0.0/10`, and a desktop whose whitelist did not take is a
 * screen the whole LAN can ask for.
 *
 * ## What is never logged
 *
 * The generated password. It goes into settings.json encrypted (see
 * SECRET_FIELDS in electron/store.ts), into a single-quoted PowerShell literal
 * in a script this module deletes afterwards, and nowhere else. Every string
 * that reaches a status detail or a log line goes through `redactPassword`.
 */

/* ---------------------------------------------------------------- plumbing */

const PS_EXE = 'powershell.exe'
const PS_TIMEOUT_MS = 30_000
/** The elevated half installs software and waits out a service restart. */
const ELEVATED_TIMEOUT_MS = 10 * 60_000

/** Nothing RustDesk publishes is anywhere near this. A login page redirect is. */
const MAX_INSTALLER_BYTES = 80 * 1024 * 1024

/**
 * Run one PowerShell command line and hand back stdout — the same shape as
 * `ps()` in electron/desktop-control.ts, and for the same reasons: no native
 * dependency, and every capability is exactly the line a person would type.
 */
function ps(command: string, timeoutMs = PS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'PowerShell failed').trim().slice(0, 400)))
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}

/** Single-quote a value into a PowerShell string literal. The one escape rule. */
function psQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** Run a plain executable and hand back stdout; '' on any failure. */
function run(file: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? ''))
    })
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/* ------------------------------------------------------------------- state */

let watcher: UacWatcher | null = null
let phase: RemoteYesStatus['phase'] = 'idle'
let detail = ''
let uacActive = false
let lastUacAt = ''
/**
 * The two answers only a child process can give, cached between probes so
 * `remoteYesStatus()` stays synchronous and every broadcast is free. `probe()`
 * refreshes them; the status handler awaits it first, so what Settings opens
 * with is always freshly observed.
 */
let serviceRunning = false
let tailscaleOk = false
/** One setup at a time. A second UAC prompt from a double-click is the exact
 *  thing the "exactly one prompt" promise cannot survive. */
let busy = false

const isWindows = process.platform === 'win32'

function log(line: string): void {
  console.log(redactPassword(line, getSettings().remoteYesPassword))
}

/* ------------------------------------------------------------- observation */

/** Is the RustDesk service Running right now? */
async function probeService(): Promise<boolean> {
  try {
    const out = await ps(`(Get-Service -Name ${psQuote(RUSTDESK_SERVICE)} -ErrorAction SilentlyContinue).Status`)
    return out.trim().toLowerCase() === 'running'
  } catch {
    return false
  }
}

/**
 * This PC's Tailscale IPv4, or ''.
 *
 * Two candidates because `tailscale` is on PATH for a session started after
 * Tailscale was installed and not for one started before it — and "no tailnet"
 * is the one answer that stops setup dead, so it must not be produced by a
 * stale PATH.
 */
async function probeTailscaleIp(): Promise<string> {
  const candidates = ['tailscale', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
  for (const exe of candidates) {
    const ip = parseTailscaleIp(await run(exe, ['ip', '-4']))
    if (ip) return ip
  }
  return ''
}

async function probe(): Promise<void> {
  if (!isWindows) {
    serviceRunning = false
    tailscaleOk = false
    return
  }
  serviceRunning = await probeService()
  tailscaleOk = (await probeTailscaleIp()) !== ''
}

export function remoteYesStatus(): RemoteYesStatus {
  const s = getSettings()
  const installed = isWindows && existsSync(RUSTDESK_EXE)
  return {
    supported: isWindows,
    enabled: s.remoteYesEnabled,
    installed,
    serviceRunning,
    configured: !!(s.remoteYesPassword && s.remoteYesAddress && s.remoteYesRustdeskId),
    tailscale: tailscaleOk,
    address: s.remoteYesAddress,
    rustdeskId: s.remoteYesRustdeskId,
    port: REMOTE_YES_PORT,
    phase,
    detail,
    uacActive,
    lastUacAt
  }
}

function report(next?: string, nextPhase?: RemoteYesStatus['phase']): void {
  if (next !== undefined) detail = redactPassword(next, getSettings().remoteYesPassword)
  if (nextPhase !== undefined) phase = nextPhase
  broadcast(IPC.remoteYesStatusEvent, remoteYesStatus())
}

/* --------------------------------------------------------------- the phone */

/**
 * Tell every connected phone where things stand. Sent on every UAC edge and
 * whenever the switch flips, because the phone's card is the whole point: it is
 * what turns "the screen went black" into "open RustDesk and press Yes".
 */
function publish(uac: boolean): void {
  const s = getSettings()
  const info = {
    enabled: s.remoteYesEnabled,
    uac,
    address: s.remoteYesAddress,
    port: REMOTE_YES_PORT
  }
  try {
    publishRemoteYes(info)
  } catch (err) {
    log(`[remote-yes] could not publish to the phones: ${err instanceof Error ? err.message : String(err)}`)
  }
  // The same news to every browser tab on Forge Web. Separately guarded, so a
  // phone server that is off does not silence the browsers, or the reverse.
  try {
    publishRemoteYesToBrowsers(info)
  } catch (err) {
    log(`[remote-yes] could not publish to the browsers: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* -------------------------------------------------------------- the watcher */

function startWatcher(): void {
  if (watcher || !isWindows) return
  watcher = new UacWatcher({
    // tasklist rather than PowerShell: it is one short-lived process every 1.5
    // seconds for as long as the feature is on, and `Get-Process` through
    // powershell.exe would be an order of magnitude more machine for the same
    // one-line answer.
    exec: () => run('tasklist', ['/FI', 'IMAGENAME eq consent.exe', '/NH', '/FO', 'CSV'], 8000),
    onChange: (active) => onUacChange(active),
    log
  })
  watcher.start()
  log('[remote-yes] watching for admin prompts')
}

function stopWatcher(): void {
  watcher?.stop()
  watcher = null
  uacActive = false
}

function onUacChange(active: boolean): void {
  uacActive = active
  if (active) {
    lastUacAt = new Date().toISOString()
    notifyUac()
  }
  publish(active)
  report()
}

function notifyUac(): void {
  if (!Notification.isSupported()) return
  try {
    new Notification({
      title: 'Windows is asking for admin',
      body: 'Open Forge Mobile → Remote Yes, then press Yes in RustDesk.'
    }).show()
  } catch (err) {
    log(`[remote-yes] notification failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* -------------------------------------------------------------- the download */

function binDir(): string {
  const dir = join(getDataDir(), 'bin')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Fetch the installer, verify it is a signed Windows executable, and hand back
 * its path.
 *
 * Three separate checks, because this file is about to be run as
 * administrator and nothing about that is recoverable afterwards:
 *
 *  1. a size cap, so a redirect to a login page cannot fill the disk;
 *  2. the `MZ` magic, so what arrived is at least a PE image;
 *  3. Authenticode, so it is the executable RustDesk signed rather than one
 *     something in the middle substituted. A file that fails is deleted, not
 *     kept for a retry that would find it "already downloaded".
 */
async function downloadInstaller(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  report('Looking for the latest RustDesk…', 'downloading')

  let releaseJson: string
  try {
    const res = await fetch(RUSTDESK_RELEASE_URL, {
      // GitHub's API refuses an unidentified client outright.
      headers: { 'User-Agent': 'Forge', Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status} when asked for the latest RustDesk.` }
    releaseJson = await res.text()
  } catch (err) {
    return { ok: false, error: `Could not reach GitHub (${err instanceof Error ? err.message : String(err)}).` }
  }

  const release = parseLatestRelease(releaseJson)
  if (!release) {
    return { ok: false, error: 'The release feed did not name a 64-bit Windows installer — something replied in its place.' }
  }
  if (release.size > MAX_INSTALLER_BYTES) {
    return { ok: false, error: `The published installer is ${(release.size / 1024 / 1024).toFixed(0)} MB, which is not a RustDesk installer.` }
  }

  report(`Downloading RustDesk ${release.version}…`, 'downloading')
  let bytes: Buffer
  try {
    const res = await fetch(release.url)
    if (!res.ok) return { ok: false, error: `The download answered ${res.status}.` }
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    return { ok: false, error: `The download failed (${err instanceof Error ? err.message : String(err)}).` }
  }
  if (bytes.length > MAX_INSTALLER_BYTES) {
    return { ok: false, error: 'The download is far larger than a RustDesk installer, so it was discarded.' }
  }
  if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return { ok: false, error: 'What arrived is not a Windows executable, so it was discarded rather than run.' }
  }

  const dir = binDir()
  const part = join(dir, 'rustdesk-setup.exe.part')
  const exe = join(dir, 'rustdesk-setup.exe')
  try {
    writeFileSync(part, bytes)
    rmSync(exe, { force: true })
    renameSync(part, exe)
  } catch (err) {
    rmSync(part, { force: true })
    return { ok: false, error: `Downloaded it but could not save it (${err instanceof Error ? err.message : String(err)}).` }
  }

  let signature = ''
  try {
    signature = (await ps(`(Get-AuthenticodeSignature ${psQuote(exe)}).Status`)).trim()
  } catch (err) {
    signature = `unreadable (${err instanceof Error ? err.message : String(err)})`
  }
  if (signature !== 'Valid') {
    rmSync(exe, { force: true })
    return {
      ok: false,
      error: `The installer's signature came back "${signature}" rather than Valid, so it was deleted rather than run as administrator.`
    }
  }

  return { ok: true, path: exe }
}

/* ----------------------------------------------------------------- the setup */

/**
 * The whole install-and-configure, behind exactly one UAC prompt.
 *
 * Idempotent: run against a RustDesk that is already installed and configured,
 * it skips the download, re-applies the same options and reads them back — one
 * prompt, same ending. That is deliberate rather than a shortcut, because
 * "press it again" is the only repair anybody at a sofa can perform.
 */
async function runSetup(): Promise<RemoteYesStatus> {
  if (!isWindows) {
    report('Remote Yes needs Windows — there is no admin prompt to press anywhere else.', 'error')
    return remoteYesStatus()
  }
  if (busy) {
    report('Setup is already running — one admin prompt at a time.')
    return remoteYesStatus()
  }
  busy = true
  try {
    const address = await probeTailscaleIp()
    tailscaleOk = address !== ''
    if (!address) {
      report('Install and sign in to Tailscale first — Remote Yes only ever listens on your tailnet.', 'error')
      return remoteYesStatus()
    }

    const alreadyInstalled = existsSync(RUSTDESK_EXE)
    let installerPath = ''
    if (!alreadyInstalled) {
      const downloaded = await downloadInstaller()
      if (!downloaded.ok) {
        report(downloaded.error, 'error')
        return remoteYesStatus()
      }
      installerPath = downloaded.path
    }

    // Keep an existing password rather than minting a new one: a phone that has
    // already been told this desktop's password must not be silently locked out
    // by pressing the button a second time.
    const password = getSettings().remoteYesPassword || generatePassword()

    const dir = binDir()
    const scriptPath = join(dir, 'remote-yes-setup.ps1')
    const resultPath = join(dir, 'remote-yes-result.json')
    rmSync(resultPath, { force: true })

    report(
      alreadyInstalled ? 'Re-applying RustDesk settings — Windows will ask for admin once.' : 'Installing RustDesk — Windows will ask for admin once.',
      alreadyInstalled ? 'configuring' : 'installing'
    )

    let resultJson = ''
    try {
      writeFileSync(scriptPath, buildSetupScript({ installerPath, password, resultPath, alreadyInstalled }), 'utf8')
      // The one elevated call in this application. `-Wait` so the script has
      // finished (and written its verdict) by the time this resolves; a
      // cancelled prompt throws here and leaves no result file at all.
      const inner = `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
      await ps(
        `Start-Process -FilePath ${psQuote(PS_EXE)} -ArgumentList ${psQuote(inner)} -Verb RunAs -Wait`,
        ELEVATED_TIMEOUT_MS
      )
      resultJson = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : ''
    } catch (err) {
      const reason = redactPassword(err instanceof Error ? err.message : String(err), password)
      report(
        /canceled by the user|cancelled by the user/i.test(reason)
          ? 'The admin prompt was cancelled, so nothing was installed.'
          : `The elevated step failed: ${reason}`,
        'error'
      )
      return remoteYesStatus()
    } finally {
      // Both files hold the password. They do not outlive the call that made them.
      rmSync(scriptPath, { force: true })
      rmSync(resultPath, { force: true })
    }

    const result = parseSetupResult(resultJson)
    if (!result) {
      report('The elevated step left no result, so nothing was switched on. Try again.', 'error')
      return remoteYesStatus()
    }
    if (!result.ok) {
      report(`RustDesk setup failed: ${redactPassword(result.error, password) || 'no reason given'}`, 'error')
      return remoteYesStatus()
    }
    const mismatch = firstOptionMismatch(result.options)
    if (mismatch) {
      report(`RustDesk did not keep the "${mismatch}" setting, so Remote Yes was left off.`, 'error')
      return remoteYesStatus()
    }
    if (!result.id) {
      report('RustDesk did not report an ID, so there is nothing for the phone to show.', 'error')
      return remoteYesStatus()
    }

    setSettings({
      remoteYesEnabled: true,
      remoteYesPassword: password,
      remoteYesAddress: address,
      remoteYesRustdeskId: result.id
    })
    serviceRunning = await probeService()
    startWatcher()
    publish(false)
    report(
      result.listening
        ? `Ready. RustDesk is listening on ${address}:${REMOTE_YES_PORT}.`
        : `Set up, but nothing is listening on port ${REMOTE_YES_PORT} yet — give it a moment and press Test.`,
      'idle'
    )
    log(`[remote-yes] configured on ${address}:${REMOTE_YES_PORT}, id ${result.id}`)
    return remoteYesStatus()
  } finally {
    busy = false
  }
}

/* ----------------------------------------------------------------- the test */

/**
 * Raise a harmless admin prompt so the whole path can be proved from the sofa:
 * the card arrives on the phone, RustDesk shows the secure desktop, Yes gets
 * pressed. `cmd /c exit 0` does nothing whatsoever — the prompt *is* the test.
 */
async function runTest(): Promise<{ ok: boolean; detail: string }> {
  if (!isWindows) return { ok: false, detail: 'There is no admin prompt to raise on this platform.' }
  try {
    await ps(`Start-Process -FilePath 'cmd.exe' -ArgumentList '/c exit 0' -Verb RunAs -Wait`, 3 * 60_000)
    return { ok: true, detail: 'Windows got a Yes.' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (/canceled by the user|cancelled by the user/i.test(reason)) {
      return { ok: false, detail: 'Cancelled or timed out.' }
    }
    return { ok: false, detail: `Cancelled or timed out. (${reason.split('\n')[0]})` }
  }
}

/* ---------------------------------------------------------------- the wiring */

export function registerRemoteYesHandlers(): void {
  ipcMain.handle(IPC.remoteYesStatus, async (): Promise<RemoteYesStatus> => {
    await probe()
    return remoteYesStatus()
  })

  ipcMain.handle(IPC.remoteYesSetup, (): Promise<RemoteYesStatus> => runSetup())

  ipcMain.handle(IPC.remoteYesDisable, async (): Promise<RemoteYesStatus> => {
    setSettings({ remoteYesEnabled: false })
    stopWatcher()
    publish(false)
    await probe()
    // RustDesk stays installed on purpose: removing it would want administrator
    // rights again, and switching a notification off is not a reason to ask.
    report('Off. RustDesk is still installed — press Set up to switch it back on.', 'idle')
    return remoteYesStatus()
  })

  ipcMain.handle(IPC.remoteYesTest, (): Promise<{ ok: boolean; detail: string }> => runTest())
}

/** Called on boot: start watching if the switch is on and this is Windows. */
export function applyRemoteYesSettings(): void {
  if (isWindows && getSettings().remoteYesEnabled) {
    startWatcher()
    publish(false)
    return
  }
  stopWatcher()
}

export function disposeRemoteYes(): void {
  // A poll every 1.5 seconds outliving the app would keep a tasklist process
  // starting for ever with nobody left to tell.
  stopWatcher()
}

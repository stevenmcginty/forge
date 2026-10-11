import { app, type BrowserWindow } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { decideUpdateReconcile, installDirFromBackup, shouldWriteUpdateHealth } from '@shared/tools'
import type { UpdateApplyState, UpdateHealth, UpdateOutcome, UpdateResult } from '@shared/types'
import { ENV_DENYLIST } from './pty/session-manager'
import { allowClose } from './quit-guard'
import { killSttSidecarSync } from './stt-sidecar'
import { logUpdate, updateLogPath } from './update-log'
import { taskName } from './watchdog-host'

/**
 * Applying a downloaded update — the Forge half of the apply-helper contract
 * (scripts/apply-update.ps1 is the other half).
 *
 * Forge no longer calls electron-updater's quitAndInstall(). That ran NSIS
 * while Forge was still alive, and NSIS deletes the old app before copying the
 * new one, so any failure part-way left no working Forge. Instead Forge copies
 * the verified installer and the helper script OUTSIDE the install dir, writes
 * `starting`, spawns the helper, and waits for it to say `waiting-for-exit`
 * before quitting. The helper moves the old install aside, installs into the
 * empty dir, launches the new Forge, waits for that Forge to write the health
 * file, and otherwise puts the old dir back.
 *
 * On the next launch reconcileUpdateOnStartup() reads the state file: a new
 * Forge vouches for itself (the health file), and whatever the outcome was is
 * turned into the banner's result. The decisions are pure functions in
 * shared/tools.ts (decideUpdateReconcile, shouldWriteUpdateHealth) so
 * scripts/updates-check.mjs can test them.
 */

const HELPER_NAME = 'apply-update.ps1'
const HANDSHAKE_TIMEOUT_MS = 20_000
const HANDSHAKE_POLL_MS = 250
/** After did-finish-load, how long the renderer must survive before we vouch for it. */
const HEALTH_DELAY_MS = 5_000
const WATCH_POLL_MS = 1_000
/** The helper's own health timeout is 120 s; this is comfortably past it. */
const WATCH_MAX_MS = 5 * 60_000

const FINAL_PHASES = new Set(['succeeded', 'aborted', 'rolled-back', 'rollback-failed'])

/* ----------------------------------------------------------------- paths */

function stateDir(): string {
  return join(app.getPath('userData'), 'updates')
}

function statePath(): string {
  return join(stateDir(), 'update-state.json')
}

function healthPath(): string {
  return join(stateDir(), 'update-health.json')
}

function helperSource(): string {
  return join(process.resourcesPath, 'updater', HELPER_NAME)
}

function workRoot(): string {
  const local = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local')
  return join(local, 'forge-updater', 'apply')
}

/* --------------------------------------------------------------- helpers */

/** The state file, or null. A leading BOM is tolerated; a torn or foreign file is null. */
export function readApplyState(): UpdateApplyState | null {
  try {
    const path = statePath()
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
    const parsed = JSON.parse(text) as Partial<UpdateApplyState> | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.phase !== 'string') return null
    return {
      ...parsed,
      id: String(parsed.id ?? ''),
      from: String(parsed.from ?? ''),
      to: String(parsed.to ?? ''),
      at: String(parsed.at ?? '')
    } as UpdateApplyState
  } catch (err) {
    logUpdate(`could not read the state file: ${(err as Error).message}`)
    return null
  }
}

/** Write JSON atomically (tmp + rename), retrying a rename the helper's read may block. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  let lastErr: unknown = null
  for (let i = 0; i < 8; i++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      lastErr = err
      await sleep(60)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function killTree(pid: number | undefined): void {
  if (!pid || !isAlive(pid)) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
    logUpdate(`killed helper pid ${pid}`)
  } catch (err) {
    logUpdate(`could not kill helper pid ${pid}: ${(err as Error).message}`)
  }
}

/** Forge's environment minus the pane denylist and minus ELECTRON_RUN_AS_NODE. */
function helperEnv(): Record<string, string> {
  const denied = new Set<string>([...ENV_DENYLIST, 'ELECTRON_RUN_AS_NODE'])
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || denied.has(k)) continue
    env[k] = v
  }
  return env
}

function outcomeOf(state: UpdateApplyState): UpdateOutcome {
  if (state.phase === 'succeeded') return 'succeeded'
  if (state.phase === 'aborted' || state.phase === 'rolled-back' || state.phase === 'rollback-failed') return state.phase
  return 'interrupted'
}

/** The state file as the banner's / Settings' result. */
export function updateResultFromState(
  state: UpdateApplyState,
  outcome: UpdateOutcome,
  reason: string | undefined,
  acknowledged: boolean
): UpdateResult {
  const backupDir = outcome === 'rollback-failed' && state.backupDir ? state.backupDir : undefined
  return {
    outcome,
    from: state.from,
    to: state.to,
    current: app.getVersion(),
    ...(reason ? { reason } : {}),
    ...(backupDir ? { backupDir, installDir: installDirFromBackup(backupDir) } : {}),
    at: state.at || new Date().toISOString(),
    acknowledged
  }
}

/* ------------------------------------------------------------ can apply */

/**
 * Whether this Forge is an install the helper can update: Windows, packaged,
 * and the folder it runs from looks like an NSIS install of Forge, with the
 * helper script shipped beside it. Anything else (a portable copy, an
 * unpacked build) gets told to download the installer instead.
 */
export function canApplyUpdate(): { ok: boolean; reason?: string } {
  if (process.platform !== 'win32') return { ok: false, reason: 'self-update is Windows only' }
  if (!app.isPackaged) return { ok: false, reason: 'this is not an installed build' }
  const installDir = dirname(process.execPath)
  const needed = [
    join(installDir, 'Forge.exe'),
    join(installDir, 'resources', 'app.asar'),
    join(installDir, 'Uninstall Forge.exe'),
    helperSource()
  ]
  for (const path of needed) {
    if (!existsSync(path)) return { ok: false, reason: `${path} is missing` }
  }
  return { ok: true }
}

/* ----------------------------------------------------------------- apply */

export interface ApplyRequest {
  from: string
  to: string
  /** The installer electron-updater downloaded and checked. */
  file: string
  /** Base64 SHA-512 from latest.yml; the helper re-hashes the copy. */
  sha512: string
}

export type ApplyResult =
  | { ok: true }
  | { ok: false; reason: string; aborted?: UpdateApplyState }

/**
 * Start the helper and wait for its handshake. `waiting-for-exit` → Forge
 * quits (after `onClosing`, so the banner can say so); `aborted` → Forge stays
 * open with the helper's reason; anything else after 20 s → Forge stays open,
 * "The updater did not start", and the helper is killed if it is still there.
 */
export async function applyUpdate(req: ApplyRequest, onClosing?: () => void): Promise<ApplyResult> {
  const id = `${req.to}-${Date.now()}-${randomBytes(3).toString('hex')}`
  const installDir = dirname(process.execPath)
  const workDir = join(workRoot(), id)
  const helper = join(workDir, HELPER_NAME)
  const installer = join(workDir, basename(req.file))
  const logFile = updateLogPath()
  logUpdate(`apply ${id}: ${req.from} → ${req.to}, installer ${req.file}, install dir ${installDir}`)

  try {
    await mkdir(workDir, { recursive: true })
    await copyFile(helperSource(), helper)
    await copyFile(req.file, installer)
    await rm(healthPath(), { force: true })
    const starting: UpdateApplyState = {
      id,
      from: req.from,
      to: req.to,
      phase: 'starting',
      at: new Date().toISOString(),
      acknowledged: false
    }
    await writeJsonAtomic(statePath(), starting)
    logUpdate(`apply ${id}: work dir ${workDir} ready, state = starting`)
  } catch (err) {
    const reason = `Could not prepare the update: ${(err as Error).message}`
    logUpdate(`apply ${id}: ${reason}`)
    return { ok: false, reason }
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    helper,
    '-Id',
    id,
    '-InstallDir',
    installDir,
    '-Installer',
    installer,
    '-Sha512',
    req.sha512,
    '-FromVersion',
    req.from,
    '-ToVersion',
    req.to,
    '-AppPid',
    String(process.pid),
    '-StateDir',
    stateDir(),
    '-LogFile',
    logFile,
    '-DataRoot',
    app.getPath('userData'),
    '-WatchdogTask',
    taskName()
  ]

  let helperPid: number | undefined
  let launcherExit: number | null | undefined
  let spawnError: string | null = null
  try {
    // Not `detached: true`: that is DETACHED_PROCESS on Windows, and Windows
    // PowerShell 5.1 with no console exits 0 at once without running the
    // script. Nor a plain child: libuv puts those in a kill-on-close job, so
    // the helper would die with Forge. So cmd.exe, hidden and in the job, runs
    // `start /b`, and the helper it starts shares that hidden console but is
    // outside the job (silent breakaway) and outlives Forge. cmd re-reads the
    // line, so every argument is quoted here (none can contain a quote), with
    // a trailing backslash doubled so it cannot escape the closing quote.
    const quote = (arg: string): string => `"${arg.replace(/\\+$/, (tail) => tail + tail)}"`
    const line = ['/d', '/c', 'start', '""', '/b', 'powershell.exe', ...args.map(quote)]
    const child = spawn('cmd.exe', line, {
      cwd: workDir,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: helperEnv()
    })
    helperPid = child.pid
    child.on('error', (err) => {
      spawnError = err.message
      logUpdate(`apply ${id}: helper spawn error: ${err.message}`)
    })
    child.on('exit', (code) => {
      launcherExit = code
      logUpdate(`apply ${id}: helper launcher exited with code ${code}`)
    })
    child.unref()
    logUpdate(`apply ${id}: helper launcher spawned, pid ${helperPid ?? 'unknown'}`)
  } catch (err) {
    spawnError = (err as Error).message
    logUpdate(`apply ${id}: helper spawn threw: ${spawnError}`)
  }

  // The handshake: poll the state file and log every phase seen.
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
  let lastPhase = 'starting'
  let failedAt = 0
  while (Date.now() < deadline) {
    await sleep(HANDSHAKE_POLL_MS)
    const state = readApplyState()
    if (state && state.id === id) {
      if (state.phase !== lastPhase) {
        lastPhase = state.phase
        logUpdate(`apply ${id}: helper phase ${state.phase}${state.reason ? ` — ${state.reason}` : ''}`)
      }
      if (state.helperPid) helperPid = state.helperPid
      if (state.phase === 'aborted') {
        const reason = state.reason || 'The updater stopped before changing anything.'
        logUpdate(`apply ${id}: aborted — Forge stays open`)
        // Shown live by this session's banner; a later launch need not repeat it.
        await writeJsonAtomic(statePath(), { ...state, acknowledged: true }).catch(() => undefined)
        return { ok: false, reason, aborted: state }
      }
      if (state.phase !== 'starting' && state.phase !== 'preflight') {
        // waiting-for-exit (or later): the helper is ready for Forge to go.
        logUpdate(`apply ${id}: handshake complete at ${state.phase} — quitting`)
        onClosing?.()
        // "Update now" was the confirmation; no second "close Forge?" prompt.
        allowClose()
        // The speech engine's exe lives under resources/ — inside the folder
        // the helper is about to move. Dead, not merely asked to leave.
        killSttSidecarSync()
        app.quit()
        return { ok: true }
      }
    }
    if (spawnError) break
    // The launcher exits as soon as it has started the helper; only a failed
    // launch is news. Give the file one more poll to land, then stop waiting.
    if (launcherExit !== undefined && launcherExit !== 0) {
      if (!failedAt) failedAt = Date.now()
      else if (Date.now() - failedAt > 1000) break
    }
  }

  const reason = spawnError
    ? `The updater did not start (${spawnError}).`
    : launcherExit !== undefined && launcherExit !== 0
      ? `The updater did not start (its launcher exited with code ${launcherExit}).`
      : 'The updater did not start.'
  logUpdate(`apply ${id}: handshake failed at ${lastPhase} — ${reason} Forge stays open.`)
  killTree(helperPid)
  // The helper never got past preflight, so nothing changed. Record that rather
  // than leave `starting`, which the next launch would read as an interrupted update.
  await writeJsonAtomic(statePath(), {
    id,
    from: req.from,
    to: req.to,
    phase: 'aborted',
    reason,
    at: new Date().toISOString(),
    acknowledged: true
  } satisfies UpdateApplyState).catch(() => undefined)
  return { ok: false, reason }
}

/* ------------------------------------------------------------- reconcile */

type ResultSink = (result: UpdateResult, show: boolean) => void
let sink: ResultSink | null = null
let pending: { result: UpdateResult; show: boolean } | null = null

/** Where startup results go (electron/updater.ts). Buffered until it is set. */
export function setUpdateResultSink(next: ResultSink | null): void {
  sink = next
  if (sink && pending) {
    sink(pending.result, pending.show)
    pending = null
  }
}

function report(result: UpdateResult, show: boolean): void {
  logUpdate(
    `result: ${result.outcome} ${result.from} → ${result.to} (running ${result.current})` +
      `${result.reason ? ` — ${result.reason}` : ''}${show ? '' : ' [already dismissed]'}`
  )
  if (sink) sink(result, show)
  else pending = { result, show }
}

/**
 * At startup: act on the helper's state file.
 *
 *  - launching / waiting-for-health and this IS the new version → write the
 *    health file once the main window has loaded and survived 5 s, then watch
 *    for `succeeded`;
 *  - a final phase → the banner's result (or, if already dismissed, only
 *    Settings' "last update");
 *  - a mid-flight phase whose helper is dead → `interrupted`.
 */
export function reconcileUpdateOnStartup(win: BrowserWindow): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const first = readApplyState()
  if (!first) return
  const version = app.getVersion()
  logUpdate(
    `startup: state ${first.phase} (id ${first.id}, ${first.from} → ${first.to}, helper ${first.helperPid ?? '-'}` +
      `${first.acknowledged ? ', acknowledged' : ''}); this Forge is ${version}`
  )

  const wc = win.webContents
  let loaded = !wc.isLoading() && wc.getURL() !== ''
  let crashed = false
  let healthArmed = false
  let healthWritten = false
  let lastAction = ''
  const startedAt = Date.now()
  let timer: NodeJS.Timeout | null = null

  wc.on('did-finish-load', () => {
    loaded = true
  })
  wc.on('render-process-gone', (_event, details) => {
    crashed = true
    logUpdate(`renderer gone during the health wait (${details.reason}) — not vouching for this version`)
  })

  const writeHealth = async (): Promise<void> => {
    if (crashed || win.isDestroyed()) {
      logUpdate('health: skipped — the renderer crashed or the window is gone')
      return
    }
    const state = readApplyState()
    if (!state || !shouldWriteUpdateHealth(state, version)) {
      logUpdate(`health: skipped — state is now ${state?.phase ?? 'missing'}`)
      return
    }
    const health: UpdateHealth = { id: state.id, version, pid: process.pid, at: new Date().toISOString() }
    try {
      await writeJsonAtomic(healthPath(), health)
      healthWritten = true
      logUpdate(`health: written for ${state.id} (${version}, pid ${process.pid})`)
    } catch (err) {
      logUpdate(`health: could not write: ${(err as Error).message}`)
    }
  }

  const armHealth = (): void => {
    if (healthArmed) return
    healthArmed = true
    const go = (): void => {
      logUpdate(`health: window loaded; writing in ${HEALTH_DELAY_MS / 1000} s unless the renderer dies`)
      setTimeout(() => void writeHealth(), HEALTH_DELAY_MS)
    }
    if (loaded) go()
    else wc.once('did-finish-load', go)
  }

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }

  /** One look at the file; true while there is still something to wait for. */
  const step = (): boolean => {
    const state = readApplyState()
    const decision = decideUpdateReconcile(state, version, isAlive(state?.helperPid), healthWritten)
    const key = `${decision.action}:${state?.phase ?? '-'}`
    if (key !== lastAction) {
      lastAction = key
      logUpdate(`reconcile: ${decision.action}${decision.action === 'none' ? ` (${decision.why})` : ''} at ${state?.phase ?? '-'}`)
    }
    switch (decision.action) {
      case 'write-health':
        armHealth()
        break
      case 'watch':
        break
      case 'show':
        if (state) report(updateResultFromState(state, decision.outcome, decision.reason, false), true)
        return false
      case 'none':
        // Already dismissed: Settings still shows it as the last update.
        if (state && decision.why === 'acknowledged') {
          report(updateResultFromState(state, outcomeOf(state), state.reason, true), false)
        }
        return false
    }
    if (Date.now() - startedAt > WATCH_MAX_MS) {
      logUpdate(`reconcile: gave up watching after ${WATCH_MAX_MS / 60_000} min at ${state?.phase ?? '-'}`)
      return false
    }
    return true
  }

  if (!step()) return
  timer = setInterval(() => {
    if (!step()) stop()
  }, WATCH_POLL_MS)
  timer.unref?.()
}

/**
 * The person dismissed the result. Only a finished record (or one whose helper
 * is dead) is touched — a running helper owns the file.
 */
export async function acknowledgeUpdateResult(): Promise<void> {
  const state = readApplyState()
  if (!state || state.acknowledged === true) return
  if (!FINAL_PHASES.has(state.phase) && isAlive(state.helperPid)) return
  try {
    await writeJsonAtomic(statePath(), { ...state, acknowledged: true })
    logUpdate(`acknowledged ${state.id} (${state.phase})`)
  } catch (err) {
    logUpdate(`could not acknowledge ${state.id}: ${(err as Error).message}`)
  }
}

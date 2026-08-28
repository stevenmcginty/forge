import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WatchdogStatus } from '@shared/types'

/**
 * The desktop's side of the watchdog: the "Keep Forge running" switch.
 *
 * The watchdog itself is scripts/watchdog.mjs — a plain Node script run by a
 * Windows scheduled task for the whole logon session, *outside* Forge, because
 * it has to outlive Forge to do its job. What lives here is everything Forge
 * needs to do about it from inside:
 *
 *  - write `<data root>/watchdog.json`, which tells the script what to relaunch
 *    (the dev launcher .vbs, or Forge.exe when packaged), which folder counts
 *    as "this Forge" when it kills leftovers, and which profile it is guarding
 *  - register / remove the scheduled task, and say whether it is there
 *  - pause it — the tray's Quit does this, so Quit means quit
 *
 * Everything that touches the machine goes through one injectable `runPs`, so
 * scripts/watchdog-host-check.mjs can drive the whole module against a temp
 * folder without registering anything. Electron-free for the same reason.
 *
 * The task is per PC and per user. Nothing here talks to a network: enabling
 * the switch on someone else's install registers a task on *their* machine
 * that watches *their* Forge.
 */

export interface WatchdogConfig {
  /** Folder whose processes are "this Forge" — the checkout or install dir. */
  root: string
  /** `%APPDATA%\Forge`, `Forge Dev`, … — where the heartbeat lives. */
  profile: string
  dataRoot: string
  /** What to run to bring Forge back. */
  launcher: string
  args: string[]
  cwd: string
  /** Names of the executables that are Forge's own process tree. */
  exeNames: string[]
}

export type { WatchdogStatus }

export interface WatchdogHostOptions {
  config: WatchdogConfig
  /** The .vbs that keeps the script alive, and the script itself. */
  launcherVbs: string
  script: string
  /** `node`, or Forge.exe with ELECTRON_RUN_AS_NODE when packaged. */
  nodeExe: string
  /** Runs a PowerShell snippet and returns stdout. Injectable for tests. */
  runPs?: (script: string) => string
  /** Starts a detached process. Injectable for tests. */
  spawnDetached?: (file: string, args: string[], cwd: string) => void
  log?: (line: string) => void
}

let opts: WatchdogHostOptions | null = null

function defaultRunPs(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function defaultSpawn(file: string, args: string[], cwd: string): void {
  const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

export function configureWatchdogHost(next: WatchdogHostOptions): void {
  opts = next
}

export function taskName(profile = opts?.config.profile ?? 'Forge'): string {
  return `Forge Watchdog (${profile})`
}

function must(): WatchdogHostOptions {
  if (!opts) throw new Error('watchdog host not configured')
  return opts
}

function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function configPath(): string {
  return join(must().config.dataRoot, 'watchdog.json')
}

/** Write watchdog.json. Called on install and on every startup so it tracks moves. */
export function writeWatchdogConfig(): string {
  const { config } = must()
  mkdirSync(config.dataRoot, { recursive: true })
  const path = configPath()
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}

export function pauseWatchdog(minutes: number): void {
  const { config, log } = must()
  mkdirSync(config.dataRoot, { recursive: true })
  const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0
  writeFileSync(join(config.dataRoot, 'watchdog.pause'), String(until))
  log?.(`[watchdog] paused ${minutes > 0 ? `for ${minutes} min` : 'until resumed'}`)
}

export function resumeWatchdog(): void {
  try {
    unlinkSync(join(must().config.dataRoot, 'watchdog.pause'))
  } catch {
    /* not paused */
  }
}

function isPaused(dataRoot: string): boolean {
  try {
    const until = Number(readFileSync(join(dataRoot, 'watchdog.pause'), 'utf8').trim())
    if (!Number.isFinite(until) || until === 0) return true
    return Date.now() < until
  } catch {
    return false
  }
}

function heartbeatAge(dataRoot: string): number | null {
  try {
    return Math.max(0, Date.now() - statSync(join(dataRoot, 'heartbeat')).mtimeMs)
  } catch {
    return null
  }
}

/** The last "launched …" line in watchdog.log, as an ISO timestamp. */
function lastRestartFromLog(dataRoot: string): string {
  try {
    const text = readFileSync(join(dataRoot, 'watchdog.log'), 'utf8')
    const lines = text.split('\n').filter((l) => l.includes(' launched '))
    const last = lines.at(-1)
    if (!last) return ''
    // Lines are "YYYY-MM-DD HH:MM:SS message", stamped in UTC.
    const m = last.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /)
    return m ? `${m[1]}T${m[2]}Z` : ''
  } catch {
    return ''
  }
}

/** Is the task registered, and is a watchdog for this profile alive? */
export function watchdogStatus(): WatchdogStatus {
  const { config, runPs = defaultRunPs } = must()
  const name = taskName()
  let installed = false
  let running = false
  try {
    const out = runPs(
      `$t = Get-ScheduledTask -TaskName ${psq(name)} -ErrorAction SilentlyContinue; ` +
        `if ($t) { 'installed' }; ` +
        // "watchdog.mjs" plus this root rather than the full script path: a
        // watchdog started by hand runs `node "scripts\watchdog.mjs"` with a
        // relative path and must still count. The wscript/cmd launchers above
        // it are excluded: the task hands them the script path as an argument,
        // so their command lines carry it too, and a wedged launcher with no
        // node under it is not a running watchdog (see ensureSingleWatchdog).
        `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('watchdog.mjs') -and $_.CommandLine.ToLower().Contains(${psq(config.root.toLowerCase())}) -and $_.Name -notin @('wscript.exe','cscript.exe','cmd.exe','conhost.exe') }; ` +
        `if ($p) { 'running' }`
    )
    installed = out.includes('installed')
    running = out.includes('running')
  } catch {
    /* PowerShell unavailable: report what the files say */
  }
  return {
    installed,
    running,
    paused: isPaused(config.dataRoot),
    heartbeatAgeMs: heartbeatAge(config.dataRoot),
    lastRestart: lastRestartFromLog(config.dataRoot),
    taskName: name
  }
}

/**
 * Register the logon task and start it now. Idempotent: re-registering an
 * existing task with -Force replaces it in place and the running watchdog
 * (which reads its config each check) carries on.
 */
export function installWatchdog(): WatchdogStatus {
  const { config, launcherVbs, script, nodeExe, runPs = defaultRunPs, log } = must()
  const cfg = writeWatchdogConfig()
  const name = taskName()
  // wscript "<vbs>" "<node exe>" "<script>" "<config>" — see the .vbs header.
  const argument = `"${launcherVbs}" "${nodeExe}" "${script}" "${cfg}"`
  runPs(
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${psq(argument)} -WorkingDirectory ${psq(config.cwd)}\n` +
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME\n` +
      `$trigger.Delay = 'PT20S'\n` +
      // Windows restarts a task it considers *failed*, and a launcher that
      // hangs keeps the task "Running" for ever — one wedged wscript and the
      // always-on promise is quietly off until the next logon, which is how it
      // failed on 2026-08-28. So re-run every 10 minutes, indefinitely, and let
      // the copies sort themselves out: a fresh watchdog that finds a healthy
      // one exits 0 within a second (ensureSingleWatchdog) and takes its
      // launcher with it. Parallel rather than IgnoreNew, because IgnoreNew is
      // exactly what a wedged instance would use to keep replacements out.
      `$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition\n` +
      `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances Parallel\n` +
      `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited\n` +
      `Register-ScheduledTask -TaskName ${psq(name)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null\n` +
      `Start-ScheduledTask -TaskName ${psq(name)}\n`
  )
  resumeWatchdog()
  log?.(`[watchdog] installed "${name}" → ${launcherVbs}`)
  return watchdogStatus()
}

/** Remove the task and stop the watchdog process. Forge itself is untouched. */
export function uninstallWatchdog(): WatchdogStatus {
  const { config, runPs = defaultRunPs, log } = must()
  const name = taskName()
  runPs(
    `Stop-ScheduledTask -TaskName ${psq(name)} -ErrorAction SilentlyContinue\n` +
      `Unregister-ScheduledTask -TaskName ${psq(name)} -Confirm:$false -ErrorAction SilentlyContinue\n` +
      // Stopping the task does not stop the node the .vbs started; the script
      // path is the one string only watchdog processes carry.
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('watchdog.mjs') -and $_.CommandLine.ToLower().Contains(${psq(config.root.toLowerCase())}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n`
  )
  log?.(`[watchdog] uninstalled "${name}"`)
  return watchdogStatus()
}

/**
 * Start the watchdog process without registering anything — for a task that
 * is registered but whose process has gone (or for tests).
 */
export function startWatchdogProcess(): void {
  const { config, launcherVbs, script, nodeExe, spawnDetached = defaultSpawn } = must()
  const cfg = existsSync(configPath()) ? configPath() : writeWatchdogConfig()
  spawnDetached('wscript.exe', [launcherVbs, nodeExe, script, cfg], config.cwd)
}

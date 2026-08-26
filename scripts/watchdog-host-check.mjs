/**
 * electron/watchdog-host.ts, driven against a temp folder with PowerShell
 * replaced by a recorder — so this never registers, stops or starts anything
 * on the machine it runs on.
 *
 *   npm run watchdog:host-check
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './ts-hooks.mjs'

const {
  configPath,
  configureWatchdogHost,
  installWatchdog,
  pauseWatchdog,
  resumeWatchdog,
  startWatchdogProcess,
  taskName,
  uninstallWatchdog,
  watchdogStatus,
  writeWatchdogConfig
} = await import('../electron/watchdog-host.ts')

let failed = 0
function log(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'forge-watchdog-'))
const calls = []
const spawns = []
let fakeTask = false
const runPs = (script) => {
  calls.push(script)
  if (script.includes('Register-ScheduledTask')) fakeTask = true
  if (script.includes('Unregister-ScheduledTask')) fakeTask = false
  if (script.includes('Get-ScheduledTask')) return fakeTask ? 'installed\n' : ''
  return ''
}

configureWatchdogHost({
  config: {
    root: 'C:\\Fake\\Forge',
    profile: 'Forge Check',
    dataRoot: dir,
    launcher: 'C:\\Fake\\Forge\\Forge.exe',
    args: [],
    cwd: 'C:\\Fake\\Forge',
    exeNames: ['forge.exe']
  },
  launcherVbs: 'C:\\Fake\\Forge\\resources\\watchdog\\Start Forge Watchdog.vbs',
  script: 'C:\\Fake\\Forge\\resources\\watchdog\\watchdog.mjs',
  nodeExe: 'C:\\Fake\\Forge\\Forge.exe',
  runPs,
  spawnDetached: (file, args, cwd) => spawns.push({ file, args, cwd })
})

console.log('\nconfig')
log(taskName() === 'Forge Watchdog (Forge Check)', `the task name carries the profile (${taskName()})`)
const cfg = writeWatchdogConfig()
log(cfg === configPath() && existsSync(cfg), 'watchdog.json is written into the data root')
const parsed = JSON.parse(readFileSync(cfg, 'utf8'))
log(parsed.launcher.endsWith('Forge.exe') && parsed.exeNames[0] === 'forge.exe', 'and names the packaged exe as both launcher and process')

console.log('\nstatus, before anything is installed')
let s = watchdogStatus()
log(s.installed === false && s.running === false, 'nothing installed, nothing running')
log(s.heartbeatAgeMs === null, 'no heartbeat file → null age')
log(s.lastRestart === '', 'no log → no last restart')

console.log('\ninstall')
s = installWatchdog()
const reg = calls.find((c) => c.includes('Register-ScheduledTask'))
log(Boolean(reg), 'registers a scheduled task through PowerShell')
log(reg?.includes("'Forge Watchdog (Forge Check)'"), 'under the profile task name')
log(reg?.includes('-ExecutionTimeLimit ([TimeSpan]::Zero)'), 'with no execution time limit')
log(reg?.includes('-AtLogOn'), 'triggered at logon')
log(reg?.includes('Start Forge Watchdog.vbs') && reg?.includes('watchdog.mjs') && reg?.includes(cfg), 'the action names the .vbs, the script and the config file')
log(reg?.includes('Start-ScheduledTask'), 'and starts it now')
log(s.installed === true, 'status reports it installed')

console.log('\npause / resume')
pauseWatchdog(30)
s = watchdogStatus()
log(s.paused === true, 'pausing for 30 minutes shows as paused')
const until = Number(readFileSync(join(dir, 'watchdog.pause'), 'utf8'))
log(until > Date.now() + 29 * 60_000 && until < Date.now() + 31 * 60_000, 'with an expiry about 30 minutes out')
writeFileSync(join(dir, 'watchdog.pause'), String(Date.now() - 1000))
log(watchdogStatus().paused === false, 'an expired pause is not a pause')
pauseWatchdog(0)
log(watchdogStatus().paused === true, 'pausing with 0 is indefinite')
resumeWatchdog()
log(watchdogStatus().paused === false && !existsSync(join(dir, 'watchdog.pause')), 'resume removes the file')

console.log('\nheartbeat and log')
writeFileSync(join(dir, 'heartbeat'), '1 1\n')
s = watchdogStatus()
log(typeof s.heartbeatAgeMs === 'number' && s.heartbeatAgeMs < 5000, `a fresh heartbeat reads as fresh (${s.heartbeatAgeMs}ms)`)
writeFileSync(
  join(dir, 'watchdog.log'),
  '2026-08-26 21:30:35 restarting Forge: no Forge process running\n2026-08-26 21:30:36 launched C:\\x.vbs\n2026-08-26 21:30:45 Forge is back (heartbeat 0s old)\n'
)
log(watchdogStatus().lastRestart === '2026-08-26T21:30:36Z', 'the last launch in the log is reported as an ISO timestamp')

console.log('\nstart process')
startWatchdogProcess()
log(spawns.length === 1 && spawns[0].file === 'wscript.exe', 'starting the process runs wscript')
log(spawns[0]?.args[0]?.endsWith('.vbs') && spawns[0]?.args[3] === cfg, 'with the .vbs, node exe, script and config as arguments')

console.log('\nuninstall')
s = uninstallWatchdog()
const unreg = calls.find((c) => c.includes('Unregister-ScheduledTask'))
log(Boolean(unreg) && unreg.includes('Stop-Process'), 'removes the task and stops the watchdog process')
log(s.installed === false, 'status reports it gone')
log(!calls.some((c) => /Forge Watchdog \(Forge\)'/.test(c)), 'and the real "Forge Watchdog (Forge)" task was never named')

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)

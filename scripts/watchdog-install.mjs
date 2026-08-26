/**
 * Register (or remove) the Forge watchdog as a Windows logon task, from the
 * command line — the same thing the "Keep Forge running" switch in Settings
 * does, driven through the same module (electron/watchdog-host.ts), for a
 * checkout rather than an installed Forge.
 *
 *   npm run watchdog:install     register "Forge Watchdog (<profile>)" and start it now
 *   npm run watchdog:uninstall   stop it and remove the task
 *
 * A scheduled task rather than the Startup folder because a task can be told
 * to never time out (schtasks' default kills anything after 72h), to run on
 * battery, to survive idle, and to be restarted by Windows if it dies. It runs
 * as the logged-on user, interactively, so the Forge it launches gets a window.
 *
 * The task name carries the profile so the stable checkout and Forge Dev can
 * each have one without stepping on each other.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import './ts-hooks.mjs'

const {
  configureWatchdogHost,
  installWatchdog,
  uninstallWatchdog
} = await import('../electron/watchdog-host.ts')

const ROOT = resolve(import.meta.dirname, '..')

function profile() {
  try {
    return readFileSync(join(ROOT, '.forge-profile'), 'utf8').trim() || 'Forge'
  } catch {
    return 'Forge'
  }
}
const PROFILE = profile()
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')

configureWatchdogHost({
  config: {
    root: ROOT,
    profile: PROFILE,
    dataRoot: process.env.FORGE_DATA_DIR?.trim() || join(appData, PROFILE),
    launcher: join(ROOT, 'Start Forge (silent).vbs'),
    args: [],
    cwd: ROOT,
    exeNames: ['electron.exe']
  },
  launcherVbs: join(ROOT, 'Start Forge Watchdog.vbs'),
  script: join(ROOT, 'scripts', 'watchdog.mjs'),
  nodeExe: 'node',
  log: (line) => console.log(line)
})

const status = process.argv.includes('--uninstall') ? uninstallWatchdog() : installWatchdog()
console.log(JSON.stringify(status, null, 2))

/**
 * Start a Forge checkout with the runtime profile that checkout owns.
 *
 * Which profile that is comes from `.forge-profile`, a one-line untracked file
 * naming a folder under %APPDATA%. This checkout has one saying "Forge Dev";
 * the stable checkout has none and so gets %APPDATA%\Forge, the real data.
 *
 * The marker is untracked on purpose. Putting the choice in tracked code — a
 * hardcoded path in the launcher, an app.isPackaged test in store.ts — means
 * pushing dev and pulling into stable carries the redirect with it, and the
 * everyday app opens an empty profile. Only an untracked file stays behind when
 * the code moves.
 *
 * Keeping this in a Node launcher makes `npm run dev` behave the same from
 * PowerShell, cmd.exe, VS Code, and the Windows shortcut without relying on
 * shell-specific environment-variable syntax.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')

/** The folder name in `.forge-profile`, or null when this checkout has none. */
function profileFromMarker() {
  try {
    const name = readFileSync(join(root, '.forge-profile'), 'utf8').trim()
    return name || null
  } catch {
    return null // no marker: this is the stable checkout
  }
}

const profile = profileFromMarker()
const dataRoot = process.env.FORGE_DATA_DIR?.trim() || join(appData, profile ?? 'Forge')

// Some Forge launches (and older global Electron tooling) export this as a
// machine-wide path. electron-vite prefers it over this checkout's Electron
// package, which makes dev fail with "Electron uninstall" when the other
// checkout is moved or removed. The dev server must resolve Electron locally.
const { ELECTRON_EXEC_PATH: _ignoredElectronPath, ...parentEnv } = process.env

console.log(`[forge] profile: ${profile ?? 'Forge (default)'} -> ${dataRoot}`)

const child = spawn(
  process.execPath,
  [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', ...process.argv.slice(2)],
  {
    cwd: root,
    env: { ...parentEnv, FORGE_DATA_DIR: dataRoot, FORGE_CHANNEL: profile ? 'dev' : 'stable' },
    stdio: 'inherit',
    windowsHide: false
  }
)

const stop = (signal) => child.kill(signal)
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

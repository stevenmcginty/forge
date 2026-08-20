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
import { createServer } from 'node:net'
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

/**
 * The renderer's dev port, decided here — before Vite runs.
 *
 * Why it cannot be left to Vite: electron-vite derives the URL the desktop
 * window loads from the *configured* port, while Vite, on a collision and with
 * `strictPort` off, quietly binds the next one up. The window then loads the
 * server that won the configured port — which, when that port is Vite's
 * famously shared default of 5173, is somebody else's project. Forge would open
 * showing another app entirely, and nothing about it looked like a port clash.
 *
 * Picking a port that is free right now, and pinning it with `strictPort` in
 * electron.vite.config.ts, makes "the port Vite binds" and "the port Electron
 * loads" the same number by construction. The base is deliberately not 5173, so
 * a project dev server started from a Forge terminal does not sit on it; the
 * scan upward is for the second checkout (stable and Forge Dev run at once).
 *
 * Both loopback families are probed, because that is the shape the bug
 * actually took: a project's Vite on ::1:5173 and Forge's on 127.0.0.1:5173,
 * neither seeing a collision, and Chromium resolving `localhost` to the
 * project's. A port counts as free only when it is free on both.
 */
const PORT_BASE = 5273

function portFree(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = createServer()
      socket.once('error', (err) => {
        // No IPv6 stack, or the address family is unavailable: nothing can be
        // holding the port there, so it is not a reason to skip the port.
        resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')
      })
      socket.once('listening', () => socket.close(() => resolve(true)))
      socket.listen(port, host)
    })
  // Vite binds `localhost`, which resolves to both loopback addresses on
  // Windows. A port is only free if it is free on both.
  return probe('127.0.0.1').then((v4) => (v4 ? probe('::1') : false))
}

async function pickRendererPort() {
  const forced = Number(process.env.FORGE_RENDERER_PORT)
  if (Number.isInteger(forced) && forced > 0) return forced
  for (let port = PORT_BASE; port < PORT_BASE + 20; port += 1) {
    if (await portFree(port)) return port
  }
  // Nothing free in the range: hand back the base and let Vite fail loudly
  // rather than start on a port the window will not be looking at.
  return PORT_BASE
}

const rendererPort = await pickRendererPort()

console.log(`[forge] profile: ${profile ?? 'Forge (default)'} -> ${dataRoot}`)
console.log(`[forge] renderer dev server: http://localhost:${rendererPort}`)

const child = spawn(
  process.execPath,
  [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', ...process.argv.slice(2)],
  {
    cwd: root,
    env: {
      ...parentEnv,
      FORGE_DATA_DIR: dataRoot,
      FORGE_CHANNEL: profile ? 'dev' : 'stable',
      FORGE_RENDERER_PORT: String(rendererPort)
    },
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

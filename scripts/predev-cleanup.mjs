// Kills leftover processes from a previous dev session before starting a new one.
// A crashed or half-closed Forge can leave the vite dev server (5173) and the
// mobile server (8420) alive, which blocks the next `npm run dev` from binding.
import { execFileSync, execSync } from 'node:child_process'
import { resolve } from 'node:path'

const PORTS = [5173, 8420]
const ROOT = resolve(import.meta.dirname, '..').toLowerCase()

/**
 * A port is not proof that a process belongs to this checkout. In particular,
 * 8420 is also the packaged Forge Mobile port. The old version blindly used
 * taskkill on every listener and starting dev therefore closed the real Forge.
 * Only processes whose command line points into this checkout are eligible.
 */
function commandLineFor(pid) {
  try {
    const encoded = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    return encoded.trim().toLowerCase()
  } catch {
    return ''
  }
}

function pidsOnPorts() {
  let out = ''
  try {
    out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
  } catch {
    return []
  }
  const pids = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
    if (m && PORTS.includes(Number(m[1]))) pids.add(Number(m[2]))
  }
  pids.delete(process.pid)
  pids.delete(process.ppid)
  return [...pids]
}

const pids = pidsOnPorts()
let killedAny = false
for (const pid of pids) {
  const commandLine = commandLineFor(pid)
  if (!commandLine.includes(ROOT)) {
    console.log(`[predev] left pid ${pid} alone (port belongs to another Forge/app)`)
    continue
  }
  try {
    // /t takes the whole zombie tree (node + electron children) down with it
    execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore' })
    console.log(`[predev] killed stale dev process tree (pid ${pid})`)
    killedAny = true
  } catch {
    console.warn(`[predev] could not kill pid ${pid} — if dev fails to bind, close it manually`)
  }
}
if (pids.length === 0) console.log('[predev] no stale dev processes found')

/**
 * taskkill returning is not the same as the port being free: Windows releases
 * a killed process's sockets a beat later, and starting the dev server inside
 * that beat is exactly the close-Forge-reopen-Forge race that makes the app
 * "not open" on the second try. So having killed anything, wait for the OS to
 * actually let go before handing over to electron-vite.
 */
if (killedAny) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const held = pidsOnPorts().filter((pid) => commandLineFor(pid).includes(ROOT))
    if (held.length === 0) break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
  }
}

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

/**
 * Ports are not the only thing a zombie holds. A dev tree whose window died
 * ugly (renderer crash, half-finished shutdown) keeps the log file's write
 * handle even after its ports are gone — and a launch that cannot open its
 * log dies before this script would ever run via npm. So besides port
 * holders, sweep for this checkout's own dev toolchain by command line:
 * anything running our electron-vite or our scripts/dev.mjs predates this
 * launch (npm runs predev to completion before the dev script starts) and is
 * either a zombie or about to be replaced. Panes, agents and editors that
 * merely have this folder as cwd never match — their command lines do not
 * name the dev toolchain.
 */
function devToolchainPids() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    const pids = []
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      const pid = Number(line.slice(0, tab))
      const cl = line.slice(tab + 1).toLowerCase()
      if (!cl.includes(ROOT)) continue
      if (!cl.includes('electron-vite') && !cl.includes('dev.mjs')) continue
      if (pid === process.pid || pid === process.ppid) continue
      pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

const pids = [...new Set([...pidsOnPorts(), ...devToolchainPids()])]
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

/**
 * The Forge watchdog: whenever this PC is on, Forge is on.
 *
 * Runs outside Forge for the whole Windows session (installed as a logon task
 * by `npm run watchdog:install`) and keeps one promise: the phone is never
 * stranded because the desktop app closed, crashed, hung, or was never started
 * after a reboot.
 *
 * How it decides. Forge's main process writes `<data root>/heartbeat` every
 * 5s (electron/heartbeat.ts). Every CHECK_MS this script reads the file's age:
 *
 *   fresh               → healthy, nothing to do
 *   missing or stale    → Forge is dead, hung, or not started; time to act
 *
 * What acting means, in order:
 *
 *   1. Kill every leftover process of THIS checkout's Forge — the electron
 *      tree, the electron-vite/dev.mjs chain, the wscript launcher, anything
 *      still holding the dev ports. A hung Forge is still holding the
 *      single-instance lock and its ports, and a relaunch that skips this step
 *      just loses the fight and exits (see the lock comment in electron/main.ts).
 *      Only processes whose command line names this checkout are ever touched:
 *      the other checkout (Forge Dev), the bridges Claude panes spawn, and
 *      unrelated apps on the same ports are left alone.
 *   2. Wait for the OS to release the ports.
 *   3. Launch "Start Forge (silent).vbs" — the same launcher as the shortcut.
 *   4. Give it LAUNCH_GRACE_MS to start beating before judging again, and back
 *      off (1→2→5→10 min) if it keeps failing, so a genuinely broken build
 *      does not get relaunched every 20 seconds forever.
 *
 * Deliberate choices:
 *  - Closing Forge on purpose also restarts it. That is the brief: always on.
 *    To work on Forge without the watchdog fighting you: `npm run watchdog:pause`
 *    (writes `<data root>/watchdog.pause`; `watchdog:resume` removes it), or
 *    pass `--pause 30` for minutes.
 *  - Killing a hung Forge takes its terminal panes with it. There is no
 *    alternative — a hung Forge cannot be asked to save them — and the phone
 *    being unreachable is the worse failure.
 *  - One watchdog per checkout. A second copy for the same checkout exits.
 *
 * Log: `<data root>/watchdog.log`.
 */
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where everything is. Two shapes:
 *
 *  - `--config <data root>\watchdog.json`, written by electron/watchdog-host.ts
 *    when the Settings toggle installs the task. It names the root folder, the
 *    profile, the launcher (Forge.exe when packaged) and the exe names — the
 *    script can then live anywhere, including resources/ of an installed Forge.
 *  - no argument: this checkout, the way the npm script and the .vbs run it.
 */
const argv = process.argv.slice(2)
const configArg = argv.indexOf('--config')
const CONFIG = configArg !== -1 ? readConfig(argv[configArg + 1]) : null
function readConfig(path) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'))
    if (!c || typeof c.root !== 'string' || typeof c.launcher !== 'string') return null
    return c
  } catch {
    return null
  }
}
if (configArg !== -1 && !CONFIG) {
  console.error(`watchdog: cannot read config ${argv[configArg + 1]}`)
  process.exit(2)
}

const ROOT = CONFIG ? resolve(CONFIG.root) : resolve(import.meta.dirname, '..')
const ROOT_LC = ROOT.toLowerCase()
const EXE_NAMES = (CONFIG?.exeNames ?? ['electron.exe']).map((n) => n.toLowerCase())
/**
 * "Names this checkout" means the path followed by a separator, a quote or the
 * end — not a plain substring. `...\Desktop\forge` is a prefix of
 * `...\Desktop\Forge Dev`, and a substring match would let the stable
 * watchdog kill the development Forge.
 */
function namesRoot(cl) {
  let from = 0
  for (;;) {
    const at = cl.indexOf(ROOT_LC, from)
    if (at === -1) return false
    const next = cl[at + ROOT_LC.length]
    if (next === undefined || next === '\\' || next === '/' || next === '"' || next === "'") return true
    from = at + 1
  }
}
const LAUNCHER = CONFIG ? CONFIG.launcher : join(ROOT, 'Start Forge (silent).vbs')
const LAUNCHER_ARGS = CONFIG?.args ?? []
const LAUNCHER_CWD = CONFIG?.cwd ?? ROOT
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')

function profileFromMarker() {
  try {
    return readFileSync(join(ROOT, '.forge-profile'), 'utf8').trim() || null
  } catch {
    return null
  }
}
const PROFILE = CONFIG?.profile ?? profileFromMarker() ?? 'Forge'
const DATA_ROOT = CONFIG?.dataRoot ?? (process.env.FORGE_DATA_DIR?.trim() || join(appData, PROFILE))
const HEARTBEAT = join(DATA_ROOT, 'heartbeat')
const PAUSE_FILE = join(DATA_ROOT, 'watchdog.pause')
const LOG_FILE = join(DATA_ROOT, 'watchdog.log')

const CHECK_MS = 10_000
/**
 * Heartbeat is written every 5s. Older than this with the process still there
 * means main is hung. With NO Forge process for this checkout at all the file's
 * age is irrelevant: a Forge that went down the hard-exit path leaves the file
 * behind un-deleted, and waiting for it to age out is a minute and a half the
 * phone spends offline for nothing — so that case restarts at once.
 */
const STALE_MS = 45_000
const GONE_MS = 12_000
/** A cold `npm run dev` on this machine takes well under a minute; be generous. */
const LAUNCH_GRACE_MS = 180_000
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000]
const PORTS = [5173, 5273, 5274, 5275, 5276, 5277, 5278, 5279, 8420]

/* ------------------------------------------------------------------ cli */

const args = argv.filter((a, i) => !(a === '--config' || (i > 0 && argv[i - 1] === '--config')))
if (args[0] === '--pause') {
  const minutes = Number(args[1])
  mkdirSync(DATA_ROOT, { recursive: true })
  const until = Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60_000 : 0
  writeFileSync(PAUSE_FILE, String(until))
  console.log(until ? `watchdog paused for ${minutes} min (${PROFILE})` : `watchdog paused until resumed (${PROFILE})`)
  process.exit(0)
}
if (args[0] === '--resume') {
  try {
    unlinkSync(PAUSE_FILE)
  } catch {
    /* not paused */
  }
  console.log(`watchdog resumed (${PROFILE})`)
  process.exit(0)
}
if (args[0] === '--status') {
  console.log(JSON.stringify(status(), null, 2))
  process.exit(0)
}
const ONCE = args.includes('--once')

/* ------------------------------------------------------------------ log */

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const text = `${stamp} ${line}\n`
  process.stdout.write(text)
  try {
    mkdirSync(DATA_ROOT, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) writeFileSync(LOG_FILE, '')
    writeFileSync(LOG_FILE, text, { flag: 'a' })
  } catch {
    /* logging must never stop the watchdog */
  }
}

/* -------------------------------------------------------------- signals */

function heartbeatAge() {
  try {
    return Date.now() - statSync(HEARTBEAT).mtimeMs
  } catch {
    return Infinity
  }
}

function paused() {
  try {
    const until = Number(readFileSync(PAUSE_FILE, 'utf8').trim())
    if (until === 0 || !Number.isFinite(until)) return true
    if (Date.now() < until) return true
    unlinkSync(PAUSE_FILE) // expired
    return false
  } catch {
    return false
  }
}

function ps(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
}

/** [{pid, ppid, name, cl}] for every process with a command line. */
function processes() {
  try {
    const out = ps(
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`
    )
    const list = []
    for (const line of out.split('\n')) {
      const parts = line.replace(/\r$/, '').split('\t')
      if (parts.length < 4) continue
      list.push({
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        name: parts[2].toLowerCase(),
        cl: parts.slice(3).join('\t').toLowerCase()
      })
    }
    return list
  } catch {
    return []
  }
}

function pidsOnPorts() {
  let out = ''
  try {
    out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true })
  } catch {
    return []
  }
  const pids = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
    if (m && PORTS.includes(Number(m[1]))) pids.add(Number(m[2]))
  }
  return [...pids]
}

/**
 * This checkout's Forge, and nothing else. The electron tree names the
 * checkout in its command line (`<root>\node_modules\electron\dist\electron.exe`
 * / `--app-path=<root>`), so do the dev toolchain and the launcher. The npm and
 * cmd links in the chain do not, but they die with the wscript root of their
 * tree (taskkill /t). Bridges spawned by Claude panes (gemini-bridge.mjs,
 * share-bridge.mjs) also name the checkout and are explicitly excluded: they
 * belong to sessions, not to Forge.
 */
function isForgeProcess(p) {
  if (!namesRoot(p.cl)) return false
  if (p.cl.includes('watchdog')) return false
  if (p.cl.includes('bridge\\') || p.cl.includes('bridge/')) return false
  if (EXE_NAMES.includes(p.name)) return true
  if (p.name === 'wscript.exe' && p.cl.includes('start forge')) return true
  if (p.name === 'node.exe' && (p.cl.includes('electron-vite') || p.cl.includes('dev.mjs'))) return true
  return false
}

function forgePids(all = processes()) {
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const pids = new Set(all.filter(isForgeProcess).map((p) => p.pid))
  for (const pid of pidsOnPorts()) {
    const p = byPid.get(pid)
    if (p && namesRoot(p.cl) && !p.cl.includes('watchdog')) pids.add(pid)
  }
  pids.delete(process.pid)
  pids.delete(process.ppid)
  return [...pids]
}

function status() {
  const age = heartbeatAge()
  return {
    profile: PROFILE,
    dataRoot: DATA_ROOT,
    heartbeatAgeMs: Number.isFinite(age) ? Math.round(age) : null,
    healthy: age < STALE_MS,
    paused: paused(),
    forgePids: forgePids()
  }
}

/* --------------------------------------------------------------- actions */

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function killForge() {
  const pids = forgePids()
  if (pids.length === 0) {
    log('no leftover Forge processes')
    return
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true })
      log(`killed stale Forge process tree (pid ${pid})`)
    } catch {
      /* already gone, or died with its parent */
    }
  }
  // taskkill returning is not the ports being free; wait for the OS to let go.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (forgePids().length === 0) break
    sleep(500)
  }
  const left = forgePids()
  if (left.length) log(`WARNING: still alive after kill: ${left.join(', ')}`)
}

function launchForge() {
  if (!existsSync(LAUNCHER)) {
    log(`ERROR: launcher missing: ${LAUNCHER}`)
    return false
  }
  try {
    // A .vbs needs wscript; an .exe (packaged Forge) runs as itself.
    const viaWscript = LAUNCHER.toLowerCase().endsWith('.vbs')
    const child = spawn(viaWscript ? 'wscript.exe' : LAUNCHER, viaWscript ? [LAUNCHER, ...LAUNCHER_ARGS] : LAUNCHER_ARGS, {
      cwd: LAUNCHER_CWD,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // Never hand Forge this process's identity: a pane started from a Forge
      // that inherited FORGE_DATA_DIR adopts the wrong profile (see
      // electron/pty/session-manager.ts ENV_DENYLIST).
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !['FORGE_DATA_DIR', 'FORGE_CHANNEL', 'ELECTRON_EXEC_PATH', 'ELECTRON_RUN_AS_NODE'].includes(k)
        )
      )
    })
    child.unref()
    log(`launched ${LAUNCHER}`)
    return true
  } catch (err) {
    log(`ERROR: launch failed: ${err?.message ?? err}`)
    return false
  }
}

/* ------------------------------------------------------------------ main */

/**
 * Launchers, not watchdogs. The scheduled task runs
 * `wscript.exe "<vbs>" "<node>" "<script>" "<config>"`, and the .vbs in turn
 * runs `cmd /c "<node>" "<script>" --config …` — so this script's own path is
 * in the command line of every process above it, not only in its own. A twin
 * scan that goes by the string alone therefore finds the launcher that started
 * it and stands down at every boot, which is exactly the watchdog never
 * running. Only a process actually *executing* the script counts.
 */
const LAUNCHER_NAMES = ['wscript.exe', 'cscript.exe', 'cmd.exe', 'conhost.exe']

/** This process's ancestors, so a twin scan can never match its own chain. */
function ancestors(all) {
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const line = new Set()
  let pid = process.ppid
  for (let hops = 0; pid && hops < 12; hops += 1) {
    if (line.has(pid)) break
    line.add(pid)
    pid = byPid.get(pid)?.ppid
  }
  return line
}

function ensureSingleWatchdog() {
  const me = process.pid
  const all = processes()
  const mine = ancestors(all)
  const twins = all.filter(
    (p) =>
      p.pid !== me &&
      !mine.has(p.pid) &&
      !LAUNCHER_NAMES.includes(p.name) &&
      p.cl.includes('watchdog.mjs') &&
      namesRoot(p.cl)
  )
  if (twins.length) {
    // Console, not the log file: the task re-runs every 10 minutes to survive a
    // wedged launcher, so the healthy case stands down constantly and would
    // otherwise bury the restarts the log exists to record.
    process.stdout.write(
      `another watchdog is already running for this checkout (pid ${twins.map((t) => t.pid).join(', ')}); exiting
`
    )
    process.exit(0)
  }
}

let graceUntil = 0
let lastAlive = Date.now()
let failures = 0

function restart(reason) {
  log(`restarting Forge: ${reason}`)
  killForge()
  if (launchForge()) {
    const backoff = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
    graceUntil = Date.now() + LAUNCH_GRACE_MS + (failures > 0 ? backoff : 0)
    failures += 1
  } else {
    graceUntil = Date.now() + BACKOFF_MS[BACKOFF_MS.length - 1]
  }
}

function check() {
  if (paused()) return
  const age = heartbeatAge()
  if (age < GONE_MS) {
    if (failures > 0) log(`Forge is back (heartbeat ${Math.round(age / 1000)}s old)`)
    failures = 0
    graceUntil = 0
    return
  }
  if (Date.now() < graceUntil) return
  if (age >= GONE_MS && !processes().some((p) => EXE_NAMES.includes(p.name) && isForgeProcess(p))) {
    restart('no Forge process running')
    return
  }
  if (age < STALE_MS) return
  restart(Number.isFinite(age) ? `heartbeat is ${Math.round(age / 1000)}s old` : 'no heartbeat file')
}

ensureSingleWatchdog()
log(`watchdog up for ${PROFILE} (${ROOT}); heartbeat ${HEARTBEAT}; launcher ${LAUNCHER}`)
if (ONCE) {
  check()
} else {
  // The first check at boot finds no fresh heartbeat and launches Forge, which
  // is the point. If Forge is already up (task restarted by hand), it is left
  // alone.
  check()
  setInterval(() => {
    try {
      if (Date.now() - lastAlive > 30 * 60_000) {
        lastAlive = Date.now()
        log(`alive; heartbeat ${Math.round(heartbeatAge() / 1000)}s old`)
      }
      check()
    } catch (err) {
      log(`check failed: ${err?.message ?? err}`)
    }
  }, CHECK_MS)
}

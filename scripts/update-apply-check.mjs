/**
 * The Windows update-apply helper, driven through every way an update can end.
 *
 *   npm run update-apply:check
 *
 * scripts/apply-update.ps1 is what stands between a user and a half-deleted
 * Forge: it closes Forge, renames the install aside, runs the installer into
 * the empty folder, waits for the new version to say it is healthy, and puts
 * the old folder back when anything goes wrong. A helper like that is only
 * worth having if its failure paths are proven, and nobody can prove them by
 * hand without breaking their own install. So this builds a throwaway "install"
 * per scenario under the temp dir and runs the real script against it:
 *
 *   - the install is a folder holding `Forge.cmd` (the ExeName),
 *     `resources\app.asar` and `Uninstall Forge.exe` - text, all of it
 *   - the installer is `fake-setup.cmd`, which reads `/D=` the way NSIS does
 *     (everything after it, spaces and all) and copies a v2 tree in, or fails
 *     half-way, as the scenario says
 *   - each version's `Forge.cmd` is a fake app: it logs that it was launched,
 *     reads update-state.json and writes update-health.json by the contract's
 *     rules - or never does, or lies about its version
 *   - "Forge" itself is a hidden ping.exe whose pid goes in as -AppPid; the
 *     harness kills it when the state says `waiting-for-exit`, which is the
 *     handshake the real Forge answers by quitting
 *
 * The helper always runs with -NoUi -LaunchHidden -SkipRegistry and short
 * timeouts, so nothing opens a window, nothing touches HKCU, and the whole
 * file runs in about a minute. Every process this starts is killed and every
 * temp folder removed, pass or fail.
 *
 * The contract it holds the helper to (phases, file schemas, exit codes) is
 * the header of scripts/apply-update.ps1 and electron/update-apply.ts.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('SKIP update-apply:check: the apply helper is Windows-only')
  process.exit(0)
}

const ROOT = resolve(import.meta.dirname, '..')
const HELPER = join(ROOT, 'scripts', 'apply-update.ps1')
const SYS32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PING = join(SYS32, 'PING.EXE')
const NODE = process.execPath
const FROM = '1.0.0'
const TO = '2.0.0'
const HELPER_TIMEOUT_MS = 90_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* -------------------------------------------------------------- fixtures */

/** The fake app every Forge.cmd runs: marker, then health by the contract. */
const FAKE_APP = `import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
const [stateDir, markers, version, mode] = process.argv.slice(2)
appendFileSync(join(markers, 'launches.log'), version + '\\n')
let state = null
for (let i = 0; i < 20 && !state; i++) {
  try {
    let t = readFileSync(join(stateDir, 'update-state.json'), 'utf8')
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    state = JSON.parse(t)
  } catch {
    await new Promise((r) => setTimeout(r, 50))
  }
}
const live = !!state && (state.phase === 'launching' || state.phase === 'waiting-for-health')
// healthy: the contract's rule. reckless: writes whatever version it thinks it is.
const write = mode === 'healthy' ? live && version === state.to : mode === 'reckless' ? live : false
if (write) {
  const tmp = join(stateDir, 'update-health.json.tmp')
  writeFileSync(tmp, JSON.stringify({ id: state.id, version, pid: process.pid, at: new Date().toISOString() }))
  renameSync(tmp, join(stateDir, 'update-health.json'))
}
`

/** The fake NSIS: /D= is the rest of the command line, unquoted. */
const FAKE_SETUP = `import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, 'installer.json'), 'utf8'))
const raw = process.argv.slice(2)
appendFileSync(cfg.argsLog, JSON.stringify(raw) + '\\n')
const at = raw.findIndex((a) => a.startsWith('/D='))
if (at < 0) process.exit(5)
const dest = raw.slice(at).join(' ').slice(3)
if (cfg.mode === 'ok') {
  cpSync(cfg.payload, dest, { recursive: true })
  process.exit(0)
}
// fail-midway: some files land, then the installer gives up.
mkdirSync(join(dest, 'resources'), { recursive: true })
copyFileSync(join(cfg.payload, 'Forge.cmd'), join(dest, 'Forge.cmd'))
writeFileSync(join(dest, 'resources', 'app.asar.partial'), 'half a v2 asar')
process.exit(2)
`

function forgeCmd(s, version, mode) {
  // cd away first: a cmd.exe sitting in the install folder would hold it.
  return [
    '@echo off',
    `cd /d "${s.root}"`,
    `"${NODE}" "${join(s.tools, 'fake-app.mjs')}" "${s.stateDir}" "${s.markers}" ${version} ${mode}`,
    ''
  ].join('\r\n')
}

function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

/** { relative path: sha256 } for every file under dir. */
function manifest(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  if (existsSync(dir)) walk(dir)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

function sha512b64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* already gone */
  }
}

function readText(file) {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

function hasBom(buf) {
  return !!buf && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

function readState(file) {
  const buf = readText(file)
  if (!buf) return null
  try {
    let t = buf.toString('utf8')
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    return JSON.parse(t)
  } catch {
    return null
  }
}

function hidden(cmd, args, opts = {}) {
  return spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function waitExit(child, ms) {
  return new Promise((res) => {
    if (child.exitCode !== null) return res(child.exitCode)
    const t = setTimeout(() => res('timeout'), ms)
    child.once('exit', (code) => {
      clearTimeout(t)
      res(code)
    })
  })
}

async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(step)
  }
  return !!fn()
}

/* ------------------------------------------------------------- scenario */

/**
 * opts: installer 'ok' | 'fail-midway'; v2Mode 'healthy' | 'silent' | 'reckless';
 * v2Version (what v2 thinks it is); badSha; appInside (Forge never exits and
 * runs from the install folder); survivor; holder; staleBackup; prePause.
 * expect: exit, phase, reason (RegExp or null), tree 'v1' | 'v2', launches,
 * logs [RegExp], noLogs [RegExp].
 */
async function scenario(name, opts, expect) {
  const procs = []
  const problems = []
  const check = (ok, what) => {
    if (!ok) problems.push(what)
  }
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'forge-apply-')))
  const s = {
    root,
    install: join(root, 'Programs', 'Forge App'),
    tools: join(root, 'tools'),
    payload: join(root, 'payload-v2'),
    work: join(root, 'apply', 'job'),
    dataRoot: join(root, 'userData'),
    stateDir: join(root, 'userData', 'updates'),
    logFile: join(root, 'userData', 'logs', 'updater.log'),
    markers: join(root, 'markers')
  }
  const backup = s.install + '.update-backup'
  const pauseFile = join(s.dataRoot, 'watchdog.pause')
  const stateFile = join(s.stateDir, 'update-state.json')
  const id = `check-${name.replace(/\W+/g, '-')}-${Date.now()}`
  let helper = null
  try {
    for (const d of [s.tools, s.work, s.stateDir, s.markers]) mkdirSync(d, { recursive: true })
    writeFileSync(join(s.tools, 'fake-app.mjs'), FAKE_APP)
    writeFileSync(join(s.tools, 'fake-setup.mjs'), FAKE_SETUP)
    const argsLog = join(s.markers, 'installer-args.log')
    writeFileSync(
      join(s.tools, 'installer.json'),
      JSON.stringify({ mode: opts.installer ?? 'ok', payload: s.payload, argsLog })
    )

    writeTree(s.install, {
      'Forge.cmd': forgeCmd(s, FROM, 'healthy'),
      'resources/app.asar': 'v1 asar contents',
      'resources/only-in-v1.txt': 'gone after a good update',
      'locales/en-US.pak': 'v1 locale',
      'Uninstall Forge.exe': 'v1 uninstaller placeholder'
    })
    writeTree(s.payload, {
      'Forge.cmd': forgeCmd(s, opts.v2Version ?? TO, opts.v2Mode ?? 'healthy'),
      'resources/app.asar': 'v2 asar contents',
      'resources/only-in-v2.txt': 'new in v2',
      'locales/en-US.pak': 'v2 locale',
      'Uninstall Forge.exe': 'v2 uninstaller placeholder'
    })

    // Forge's side: the installer and the helper go into the work dir.
    const setup = join(s.work, 'fake-setup.cmd')
    writeFileSync(setup, `@echo off\r\n"${NODE}" "${join(s.tools, 'fake-setup.mjs')}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    const helperCopy = join(s.work, 'apply-update.ps1')
    copyFileSync(HELPER, helperCopy)
    const sha = opts.badSha ? createHash('sha512').update('not the installer').digest('base64') : sha512b64(setup)

    // "Forge": a hidden long-running process. In the never-exits scenario it
    // runs from inside the install folder, as the real Forge.exe does.
    let appExe = PING
    if (opts.appInside) {
      appExe = join(s.install, 'resources', 'forge-main.exe')
      copyFileSync(PING, appExe)
    }
    let survivorPid = 0
    if (opts.survivor) {
      const exe = join(s.install, 'resources', 'survivor.exe')
      copyFileSync(PING, exe)
      const sv = hidden(exe, ['-n', '600', '127.0.0.1'], { cwd: root })
      procs.push(sv)
      survivorPid = sv.pid
    }
    if (opts.staleBackup) writeTree(backup, { 'leftover.txt': 'from an update that died' })
    if (opts.prePause !== undefined) writeFileSync(pauseFile, opts.prePause)

    const v1 = manifest(s.install)
    const v2 = manifest(s.payload)

    let holder = null
    if (opts.holder) {
      const ready = join(s.markers, 'holder.ready')
      const q = (p) => `'${p.replace(/'/g, "''")}'`
      holder = hidden(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$f = [IO.File]::Open(${q(join(s.install, 'resources', 'app.asar'))}, 'Open', 'Read', 'None'); ` +
            `[IO.File]::WriteAllText(${q(ready)}, 'ok'); Start-Sleep -Seconds 600`
        ],
        { cwd: root }
      )
      procs.push(holder)
      if (!(await waitFor(() => existsSync(ready), 20_000))) throw new Error('the file holder never opened its file')
    }

    const app = hidden(appExe, ['-n', '600', '127.0.0.1'], { cwd: root })
    procs.push(app)

    // Forge writes `starting` before it spawns the helper.
    writeFileSync(stateFile, JSON.stringify({ id, from: FROM, to: TO, phase: 'starting', at: new Date().toISOString(), acknowledged: false }))

    helper = hidden(
      POWERSHELL,
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helperCopy,
        '-Id', id,
        '-InstallDir', s.install,
        '-Installer', setup,
        '-Sha512', sha,
        '-FromVersion', FROM,
        '-ToVersion', TO,
        '-AppPid', String(app.pid),
        '-StateDir', s.stateDir,
        '-LogFile', s.logFile,
        '-DataRoot', s.dataRoot,
        '-ExeName', 'Forge.cmd',
        '-ExitTimeoutSec', '3',
        '-InstallTimeoutSec', '30',
        '-HealthTimeoutSec', '10',
        '-NoUi', '-LaunchHidden', '-SkipRegistry'
      ],
      { cwd: s.work }
    )
    procs.push(helper)
    let output = ''
    helper.stdout.on('data', (d) => (output += d))
    helper.stderr.on('data', (d) => (output += d))

    // Watch the phases go by, and play Forge's half of the handshake.
    const phases = []
    let pauseAtWaiting = null
    const watcher = setInterval(() => {
      const st = readState(stateFile)
      if (!st || st.phase === phases[phases.length - 1]) return
      phases.push(st.phase)
      if (st.phase === 'waiting-for-exit') {
        pauseAtWaiting = readText(pauseFile)?.toString('utf8') ?? ''
        if (!opts.appInside) killTree(app.pid)
      }
    }, 50)
    const code = await waitExit(helper, HELPER_TIMEOUT_MS)
    clearInterval(watcher)
    if (code === 'timeout') throw new Error(`the helper did not finish within ${HELPER_TIMEOUT_MS / 1000} s; output: ${output.trim()}`)

    if (holder) {
      killTree(holder.pid)
      await waitExit(holder, 5000)
    }

    // The old/new app is started just before the helper exits; give it time
    // to leave its marker, and give an unwanted launch the same time to show.
    const launchesFile = join(s.markers, 'launches.log')
    const launches = () => (readText(launchesFile)?.toString('utf8') ?? '').split('\n').filter(Boolean)
    if (expect.launches.length) await waitFor(() => launches().length >= expect.launches.length, 8000)
    await sleep(expect.launches.length ? 500 : 1500)

    // ----- assertions
    check(code === expect.exit, `exit ${code}, expected ${expect.exit}${output.trim() ? `; output: ${output.trim().slice(0, 300)}` : ''}`)
    const stateBuf = readText(stateFile)
    check(!hasBom(stateBuf), 'state file has a BOM')
    const st = readState(stateFile)
    check(!!st, 'state file missing or not JSON')
    if (st) {
      check(st.phase === expect.phase, `phase ${st.phase}, expected ${expect.phase}`)
      check(st.id === id && st.from === FROM && st.to === TO, 'state id/from/to wrong')
      check(st.helperPid === helper.pid, `helperPid ${st.helperPid}, expected ${helper.pid}`)
      check(st.acknowledged === false, 'acknowledged is not false')
      check(!Number.isNaN(Date.parse(st.at)), 'at is not a date')
      if (expect.reason) check(typeof st.reason === 'string' && expect.reason.test(st.reason), `reason ${JSON.stringify(st.reason)} !~ ${expect.reason}`)
      else check(st.reason === undefined, `unexpected reason ${JSON.stringify(st.reason)}`)
      check(st.backupDir === undefined, 'backupDir set outside rollback-failed')
    }
    check(!existsSync(stateFile + '.tmp'), 'state .tmp left behind')

    const tree = manifest(s.install)
    const want = expect.tree === 'v2' ? v2 : v1
    check(JSON.stringify(tree) === JSON.stringify(want), `install folder is not ${expect.tree}: ${JSON.stringify(Object.keys(tree))}`)
    check(!existsSync(backup), 'backup folder left behind')

    const got = launches()
    check(JSON.stringify(got) === JSON.stringify(expect.launches), `launches ${JSON.stringify(got)}, expected ${JSON.stringify(expect.launches)}`)

    const reachedWaiting = expect.phase !== 'aborted' || !expect.preflight
    if (opts.prePause !== undefined) {
      check(readText(pauseFile)?.toString('utf8') === opts.prePause, 'the pre-existing pause file was changed or removed')
    } else {
      check(!existsSync(pauseFile), 'pause file left behind')
      if (reachedWaiting) {
        const until = Number(pauseAtWaiting)
        check(Number.isFinite(until) && until > Date.now(), `no live pause file at waiting-for-exit (${JSON.stringify(pauseAtWaiting)})`)
      }
    }
    if (reachedWaiting) check(phases.includes('waiting-for-exit'), `never saw waiting-for-exit (saw ${phases.join(',')})`)
    else {
      check(!phases.includes('waiting-for-exit'), `reached waiting-for-exit at preflight abort (saw ${phases.join(',')})`)
      check(pauseAtWaiting === null, 'paused the watchdog at a preflight abort')
      check(alive(app.pid), 'Forge was killed at a preflight abort')
    }

    const logBuf = readText(s.logFile)
    check(!!logBuf && !hasBom(logBuf), 'log missing or has a BOM')
    const log = logBuf?.toString('utf8') ?? ''
    const lines = log.split('\n').filter(Boolean)
    const bad = lines.find((l) => !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[helper\] \S/.test(l))
    check(!bad, `log line out of format: ${bad}`)
    for (const re of [/\[helper\] helper started/, new RegExp(`\\[helper\\] helper exit ${expect.exit}$`, 'm'), ...(expect.logs ?? [])]) {
      check(re.test(log), `log lacks ${re}`)
    }
    for (const re of expect.noLogs ?? []) check(!re.test(log), `log has ${re}`)
    if (survivorPid) {
      check(new RegExp(`killed survivor\\.exe pid ${survivorPid} `).test(log), 'survivor kill not logged')
      check(!alive(survivorPid), 'survivor still alive')
    }
    if (opts.appInside) {
      check(new RegExp(`killed forge-main\\.exe pid ${app.pid} `).test(log), 'Forge kill not logged')
      check(!alive(app.pid), 'Forge still alive')
    }
    if (expect.installerArgs) {
      const recorded = (readText(argsLog)?.toString('utf8') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const line = recorded[0]?.join(' ')
      check(line === `/S --updated /D=${s.install}`, `installer args ${JSON.stringify(line)}`)
    }
    if (expect.extra) await expect.extra({ s, log, check })
  } catch (err) {
    problems.push(`harness error: ${err?.message ?? err}`)
  } finally {
    for (const p of procs) killTree(p.pid)
    await sleep(200)
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (err) {
      problems.push(`could not remove ${root}: ${err.message}`)
    }
  }
  return problems
}

/* -------------------------------------------------------------- the run */

const ROLLED = /^Forge 2\.0\.0 could not be installed: .+ Forge 1\.0\.0 has been put back\.$/

const SCENARIOS = [
  ['happy path', {}, {
    exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], installerArgs: true,
    logs: [/phase -> succeeded/, /installer exit code 0/, /deleted the backup/, /watchdog pause file removed/, /started the new version/, /health reported: version 2\.0\.0/]
  }],
  ['installer fails midway', { installer: 'fail-midway' }, {
    exit: 2, phase: 'rolled-back', reason: /error code 2/, tree: 'v1', launches: [FROM],
    logs: [/installer exit code 2/, /phase -> rolling-back/, /renamed .*update-backup -> /, /started the old version/]
  }],
  ['new app never reports healthy', { v2Mode: 'silent' }, {
    exit: 2, phase: 'rolled-back', reason: /did not report that it started correctly within 10 seconds/, tree: 'v1', launches: [TO, FROM],
    logs: [/phase -> waiting-for-health/, /phase -> rolled-back/]
  }],
  ['new app reports the wrong version', { v2Version: '1.5.0', v2Mode: 'reckless' }, {
    exit: 2, phase: 'rolled-back', reason: /reported itself as 1\.5\.0 instead of 2\.0\.0/, tree: 'v1', launches: ['1.5.0', FROM],
    logs: [/health reported the wrong version: 1\.5\.0/]
  }],
  ['survivor process is killed', { survivor: true }, {
    exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], logs: [/runs from the install folder/]
  }],
  ['outside process holds a file open', { holder: true }, {
    exit: 1, phase: 'aborted', reason: /^Files in use by another program/, tree: 'v1', launches: [FROM],
    logs: [/rename attempt 10 failed/, /started the old version/, /watchdog pause file removed/], noLogs: [/phase -> installing/]
  }],
  ['sha-512 mismatch aborts at preflight', { badSha: true }, {
    exit: 1, phase: 'aborted', reason: /checksum does not match/, tree: 'v1', launches: [], preflight: true,
    logs: [/aborted at preflight/], noLogs: [/phase -> waiting-for-exit/, /started the /]
  }],
  ['Forge that never exits is killed', { appInside: true }, {
    exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], logs: [/did not exit within 3 s; killing it/]
  }],
  ['stale backup is removed', { staleBackup: true }, {
    exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], logs: [/removing a stale backup/, /removed the stale backup/]
  }],
  // Two runs: the file the helper writes is gone afterwards (asserted on
  // every run above too), and one somebody else wrote is left exactly as it was.
  ['watchdog pause: own file removed, pre-existing kept', [
    [{}, { exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], logs: [/watchdog paused until \d+/, /watchdog pause file removed/] }],
    [{ prePause: '0' }, {
      exit: 0, phase: 'succeeded', reason: null, tree: 'v2', launches: [TO], logs: [/pause file already exists \('0'\)/], noLogs: [/watchdog paused until/, /watchdog pause file removed/]
    }]
  ]]
]

const started = Date.now()
let failed = 0
// `node scripts/update-apply-check.mjs <words>` runs only the scenarios whose
// name contains them.
const only = process.argv.slice(2).join(' ').toLowerCase()
const chosen = SCENARIOS.filter(([name]) => name.toLowerCase().includes(only))
for (const [name, opts, expect] of chosen) {
  const t0 = Date.now()
  const runs = Array.isArray(opts) ? opts : [[opts, expect]]
  const problems = []
  for (const [o, e] of runs) problems.push(...(await scenario(name, o, e)))
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (problems.length) {
    failed++
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
  } else {
    console.log(`PASS ${name} (${secs}s)`)
  }
}
console.log(`\n${chosen.length - failed}/${chosen.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)

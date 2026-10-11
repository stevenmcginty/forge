/**
 * The packaged update path, end to end, with nothing faked.
 *
 *   node scripts/update-e2e.mjs build   package Forge 50.0.0 and 50.0.1 from out/
 *   node scripts/update-e2e.mjs run     install 50.0.0, update it, roll an update back
 *
 * scripts/update-apply-check.mjs proves the apply helper's logic against fake
 * installers. This proves the real thing: a real NSIS installer, a real
 * Electron process tree, the real HKCU uninstall key, and the health report
 * from a freshly installed Forge. It runs on a disposable GitHub runner only
 * (.github/workflows/update-e2e.yml) — `run` installs into the per-user
 * location and would replace the Forge on any PC it was started on, so it
 * refuses to run outside GitHub Actions.
 *
 * `build` packages the already-built out/ twice, as 50.0.0 and 50.0.1, both
 * pointed at a generic feed on http://127.0.0.1:<PORT>/ instead of GitHub.
 * `run` then serves that feed from this process and works three stages on one
 * runner:
 *
 *   1. install 50.0.0 silently
 *   2. success: through the banner, 50.0.0 -> 50.0.1; the helper must report
 *      `succeeded` and the new Forge must be the one running
 *   3. rollback: the feed claims 50.0.2 but serves the 50.0.1 installer, so
 *      the helper must refuse at `verifying` and put 50.0.1 back
 *
 * Every check prints one `PASS <name>: <detail>` or `FAIL <name>: <detail>`
 * line; any FAIL exits 1. Screenshots, the updater log, the state file at
 * every phase and the installer's exit code land in release/e2e-artifacts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve, basename } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const OLD = '50.0.0'
const NEW = '50.0.1'
const FAKE = '50.0.2'
const PORT = Number(process.env.FORGE_E2E_PORT || 8765)
const FEED_URL = `http://127.0.0.1:${PORT}/`
const OUT = join(ROOT, 'release')
const FEED = join(OUT, 'e2e-feed')
const ART = join(OUT, 'e2e-artifacts')
const buildDir = (v) => join(OUT, `e2e-${v}`)
const setupName = (v) => `Forge-${v}-setup.exe`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ output */

mkdirSync(ART, { recursive: true })
const DRIVER_LOG = join(ART, 'driver.log')

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  try {
    appendFileSync(DRIVER_LOG, line + '\n')
  } catch {
    /* the artifact log is a convenience */
  }
}

const results = []
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`
  results.push(line)
  log(line)
  return ok
}

/* ------------------------------------------------------------------- build */

function build() {
  const yaml = require('js-yaml')
  const base = yaml.load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))
  for (const version of [OLD, NEW]) {
    const config = {
      ...base,
      // The real feed is GitHub. Both test builds read a local one instead, and
      // nothing here is ever published: --publish never, and no token is passed.
      publish: { provider: 'generic', url: FEED_URL },
      extraMetadata: { ...(base.extraMetadata ?? {}), version },
      directories: { ...base.directories, output: `release/e2e-${version}` }
    }
    const file = join(OUT, `e2e-builder-${version}.yml`)
    mkdirSync(OUT, { recursive: true })
    writeFileSync(file, yaml.dump(config), 'utf8')
    log(`packaging Forge ${version} with ${file}`)
    const env = { ...process.env }
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'EP_GH_TOKEN', 'CSC_LINK', 'WIN_CSC_LINK']) delete env[k]
    const r = spawnSync('npx', ['electron-builder', '--config', file, '--win', 'nsis', '--x64', '--publish', 'never'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env
    })
    if (r.status !== 0) {
      console.error(`electron-builder failed for ${version} (exit ${r.status})`)
      process.exit(1)
    }
    const dir = buildDir(version)
    for (const f of [setupName(version), `${setupName(version)}.blockmap`, 'latest.yml', 'win-unpacked/resources/app-update.yml']) {
      if (!existsSync(join(dir, f))) {
        console.error(`missing ${join(dir, f)} after packaging ${version}`)
        process.exit(1)
      }
    }
    log(`app-update.yml for ${version}:\n${readFileSync(join(dir, 'win-unpacked/resources/app-update.yml'), 'utf8')}`)
    log(`latest.yml for ${version}:\n${readFileSync(join(dir, 'latest.yml'), 'utf8')}`)
  }
}

/* ----------------------------------------------------------- system probes */

/** Windows PowerShell, with values passed by environment so nothing needs quoting. */
function ps(script, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
    windowsHide: true
  })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function psJson(script, env) {
  const r = ps(script, env)
  if (!r.out) return null
  try {
    return JSON.parse(r.out)
  } catch {
    log(`could not parse PowerShell output: ${r.out} ${r.err}`)
    return null
  }
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

function productVersion(exe) {
  if (!existsSync(exe)) return ''
  return ps('(Get-Item -LiteralPath $env:E2E_EXE).VersionInfo.ProductVersion', { E2E_EXE: exe }).out
}

/** The first three parts: electron-builder stamps 50.0.1 as 50.0.1 or 50.0.1.0. */
const short = (v) => String(v ?? '').trim().split('.').slice(0, 3).join('.')

function uninstallEntries() {
  return asList(
    psJson(
      "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | " +
        "Where-Object { $_.DisplayName -like 'Forge*' } | Select-Object PSChildName, DisplayName, DisplayVersion, InstallLocation, UninstallString | ConvertTo-Json -Compress"
    )
  )
}

function forgeProcs(installDir) {
  return asList(
    psJson(
      "$d = $env:E2E_DIR + '\\'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | " +
        'Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
      { E2E_DIR: installDir }
    )
  )
}

/** The Forge.exe main processes: Forge.exe whose parent is not a Forge.exe. */
function forgeMains(installDir) {
  const procs = forgeProcs(installDir)
  const forgePids = new Set(procs.filter((p) => /^forge\.exe$/i.test(p.Name)).map((p) => p.ProcessId))
  return procs.filter((p) => /^forge\.exe$/i.test(p.Name) && !forgePids.has(p.ParentProcessId) && !/--type=/.test(p.CommandLine ?? ''))
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Close Forge: WM_CLOSE first, then force. Returns how it went. */
async function stopForge(installDir, label) {
  const mains = forgeMains(installDir)
  if (mains.length === 0) return 'nothing was running'
  for (const m of mains) spawnSync('taskkill', ['/PID', String(m.ProcessId)], { windowsHide: true })
  const until = Date.now() + 10_000
  while (Date.now() < until && forgeProcs(installDir).length > 0) await sleep(500)
  let how = 'closed on WM_CLOSE'
  if (forgeProcs(installDir).length > 0) {
    how = 'force-killed after WM_CLOSE was not enough (tray keeps it running)'
    for (const m of forgeMains(installDir)) spawnSync('taskkill', ['/PID', String(m.ProcessId), '/T', '/F'], { windowsHide: true })
    await sleep(1500)
    for (const p of forgeProcs(installDir)) spawnSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true })
    const until2 = Date.now() + 15_000
    while (Date.now() < until2 && forgeProcs(installDir).length > 0) await sleep(500)
  }
  const left = forgeProcs(installDir)
  log(`stop Forge (${label}): ${how}; ${left.length} process(es) left`)
  return left.length === 0 ? how : `${how}; still running: ${left.map((p) => `${p.Name} ${p.ProcessId}`).join(', ')}`
}

function desktopShot(name) {
  const file = join(ART, name)
  const r = ps(
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
      '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ' +
      '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); ' +
      '$bmp.Save($env:E2E_OUT, [System.Drawing.Imaging.ImageFormat]::Png); ' +
      '"$($b.Width)x$($b.Height)"',
    { E2E_OUT: file }
  )
  if (r.code === 0 && existsSync(file)) log(`desktop screenshot ${name} (${r.out})`)
  else log(`desktop screenshot skipped (no capturable desktop?): ${r.err || r.out}`)
}

/* -------------------------------------------------------------------- feed */

function sha512b64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function startFeed() {
  mkdirSync(FEED, { recursive: true })
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\/+/, ''))
    const file = join(FEED, basename(name))
    const hit = name && existsSync(file) && statSync(file).isFile()
    log(`feed: ${req.method} ${req.url} -> ${hit ? 200 : 404}`)
    if (!hit) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const size = statSync(file).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2])
      const end = range[1] && range[2] ? Number(range[2]) : size - 1
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
      createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  })
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done(server)))
}

function serveRealNew() {
  const dir = buildDir(NEW)
  for (const f of [setupName(NEW), `${setupName(NEW)}.blockmap`, 'latest.yml']) copyFileSync(join(dir, f), join(FEED, f))
  log(`feed now offers ${NEW}:\n${readFileSync(join(FEED, 'latest.yml'), 'utf8')}`)
}

/** latest.yml for FAKE, pointing at NEW's installer bytes with their real hash. */
function serveLyingFeed() {
  const exe = join(FEED, setupName(NEW))
  const sha = sha512b64(exe)
  const size = statSync(exe).size
  const yml = [
    `version: ${FAKE}`,
    'files:',
    `  - url: ${setupName(NEW)}`,
    `    sha512: ${sha}`,
    `    size: ${size}`,
    `path: ${setupName(NEW)}`,
    `sha512: ${sha}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n')
  writeFileSync(join(FEED, 'latest.yml'), yml, 'utf8')
  log(`feed now claims ${FAKE} with the ${NEW} installer:\n${yml}`)
}

/* -------------------------------------------------------------- app state */

const APPDATA = process.env.APPDATA || ''
const LOCALAPPDATA = process.env.LOCALAPPDATA || ''
const DATA = join(APPDATA, 'Forge')
const STATE = join(DATA, 'updates', 'update-state.json')
const HEALTH = join(DATA, 'updates', 'update-health.json')
const ULOG = join(DATA, 'logs', 'updater.log')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

const readLog = () => (existsSync(ULOG) ? readFileSync(ULOG, 'utf8') : '')

/** The helper's lines for one update id, from its "helper started" line on. */
function helperRun(id) {
  const lines = readLog().split('\n')
  const start = lines.findIndex((l) => l.includes('[helper] helper started: id ' + id))
  if (start < 0) return []
  const out = []
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].includes('[helper] helper started: id ')) break
    if (lines[i].includes('[helper]')) out.push(lines[i])
  }
  return out
}

function seed(project) {
  mkdirSync(DATA, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(DATA, 'settings.json'),
    JSON.stringify(
      // speechKeyReminderOff: no Groq key on the runner, so the "Turn on dictation" card would sit over the window.
      { onboarded: true, webAccountPromptDismissed: true, speechKeyReminderOff: true, lastNotesVersion: OLD },
      null,
      2
    )
  )
  writeFileSync(
    join(DATA, 'projects.json'),
    JSON.stringify(
      [{ id: 'e2e', name: 'e2e', path: project, color: '#7aa2f7', defaultProfileId: 'pwsh', createdAt: Date.now() }],
      null,
      2
    )
  )
  log(`seeded ${DATA}`)
}

function snapshot(name) {
  if (existsSync(STATE)) copyFileSync(STATE, join(ART, name))
}

/* ---------------------------------------------------------- the app, live */

async function launch(installDir, label) {
  const { _electron } = await import('playwright-core')
  const env = { ...process.env }
  for (const k of ['ELECTRON_RENDERER_URL', 'NODE_ENV', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_RUN_AS_NODE', 'FORGE_DATA_DIR']) delete env[k]
  const app = await _electron.launch({
    executablePath: join(installDir, 'Forge.exe'),
    args: ['--force-device-scale-factor=2'],
    cwd: installDir,
    env,
    timeout: 90_000
  })
  const out = join(ART, `app-${label}.log`)
  const proc = app.process()
  proc.stdout?.on('data', (d) => appendFileSync(out, d))
  proc.stderr?.on('data', (d) => appendFileSync(out, d))
  const pid = await app.evaluate(() => process.pid)
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  const page = await mainWindow(app)
  await page.waitForFunction(() => Boolean(window.forge?.updates), null, { timeout: 60_000 })
  log(`launched Forge ${version} (${label}), main pid ${pid}, window ${page.url()}`)
  await dismissOverlays(page)
  return { app, page, pid, version, proc }
}

/**
 * Cards that open over the window on a launch. The "what's new" card opens
 * when the bundled notes are newer than settings' lastNotesVersion — both test
 * builds carry the checkout's notes (0.3.0, not 50.0.x), so it shows on the
 * first launch — and the first-run cards are seeded away but closed here too if
 * one turns up. Each is closed with its own dismiss button, as a person would.
 */
async function dismissOverlays(page) {
  const cards = [
    ['.wnew', '.wnew__dismiss'],
    ['.onboard', '.onboard__dismiss']
  ]
  const until = Date.now() + 8_000
  while (Date.now() < until) {
    let closed = false
    for (const [card, dismiss] of cards) {
      if ((await page.locator(card).count()) === 0) continue
      const label = await page.locator(card).first().getAttribute('aria-label').catch(() => card)
      await page.screenshot({ path: join(ART, `overlay-${Date.now()}.png`) }).catch(() => undefined)
      await page.locator(dismiss).first().click({ timeout: 10_000 })
      await page.locator(card).first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
      log(`dismissed the overlay "${label}"`)
      closed = true
    }
    if (!closed) await sleep(500)
  }
}

async function mainWindow(app) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      const url = w.url()
      if (/index\.html$/i.test(url)) return w
    }
    await app.waitForEvent('window', { timeout: 5_000 }).catch(() => undefined)
  }
  throw new Error(`no main window; windows: ${app.windows().map((w) => w.url()).join(', ')}`)
}

const banner = (page, phase) => page.locator(`.ubanner[data-phase="${phase}"]`)
const button = (page, text) => page.locator('.ubanner button', { hasText: text })

async function bannerShot(page, name) {
  try {
    await page.locator('.ubanner').screenshot({ path: join(ART, `${name}-banner.png`) })
    await page.screenshot({ path: join(ART, `${name}-window.png`) })
    log(`screenshot ${name}`)
  } catch (err) {
    log(`screenshot ${name} failed: ${err.message}`)
  }
}

/** Banner text, for the report: what the person actually read. */
async function bannerText(page) {
  try {
    return (await page.locator('.ubanner').innerText({ timeout: 5_000 })).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * check → available → Download → ready → Restart and update → Update now.
 * Returns once Forge has gone (or the deadline passed).
 */
async function updateThroughBanner(live, offered, tag) {
  const { page, pid } = live
  const status = await page.evaluate(() => window.forge.updates.check())
  log(`${tag}: check() -> ${JSON.stringify(status)}`)

  const available = await banner(page, 'available').waitFor({ timeout: 90_000 }).then(() => true, () => false)
  check(`${tag}: banner offers v${offered}`, available && (await bannerText(page)).includes(`v${offered}`), await bannerText(page))
  if (!available) return false
  await bannerShot(page, `${tag}-1-available`)
  await button(page, 'Download').click()

  const ready = await banner(page, 'ready').waitFor({ timeout: 240_000 }).then(() => true, () => false)
  check(`${tag}: download finishes, banner at ready`, ready, await bannerText(page))
  if (!ready) return false
  await bannerShot(page, `${tag}-2-ready`)
  await button(page, 'Restart and update').click()

  const confirm = await banner(page, 'confirm').waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check(`${tag}: "Restart and update" asks first`, confirm, await bannerText(page))
  if (!confirm) return false
  await bannerShot(page, `${tag}-3-confirm`)
  const clickedAt = Date.now()
  await button(page, 'Update now').click()
  // The closing line, if Forge is still painting it.
  await banner(page, 'installing').waitFor({ timeout: 15_000 }).then(
    () => bannerShot(page, `${tag}-4-installing`),
    () => undefined
  )

  const deadline = clickedAt + 60_000
  while (Date.now() < deadline && isAlive(pid)) await sleep(250)
  const gone = !isAlive(pid)
  const detail = gone ? `after ${Math.round((Date.now() - clickedAt) / 1000)} s` : `still running after 60 s; banner: ${await bannerText(page)}`
  check(`${tag}: Forge ${live.version} (pid ${pid}) closed after "Update now"`, gone, detail)
  return gone
}

/**
 * Poll the state file until a final phase; snapshot every phase seen. Returns
 * { state, phases }.
 */
async function watchHelper(tag, timeoutMs, staleId = '') {
  const finals = new Set(['succeeded', 'aborted', 'rolled-back', 'rollback-failed'])
  const phases = []
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    const read = readJson(STATE)
    // The previous stage's record is not this update.
    state = read && read.id !== staleId ? read : null
    const phase = state?.phase
    if (phase && phases[phases.length - 1] !== phase) {
      phases.push(phase)
      snapshot(`state-${tag}-${String(phases.length).padStart(2, '0')}-${phase}.json`)
      log(`${tag}: state ${phase}${state.reason ? ` (${state.reason})` : ''}`)
    }
    if (phase && finals.has(phase)) break
    await sleep(200)
  }
  return { state, phases }
}

/** The helper writes "helper exit N" last, after deleting the backup and resuming the watchdog. */
async function waitHelperExit(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = helperRun(id).find((l) => /\[helper\] helper exit \d+/.test(l))
    if (line) return Number(/helper exit (\d+)/.exec(line)[1])
    await sleep(500)
  }
  return null
}

/* --------------------------------------------------------------------- run */

async function run() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    console.error('update-e2e run installs Forge into the per-user location and would replace a real install.')
    console.error('It runs on a disposable GitHub runner only (.github/workflows/update-e2e.yml).')
    process.exit(2)
  }
  for (const v of [OLD, NEW]) {
    if (!existsSync(join(buildDir(v), setupName(v)))) {
      console.error(`no ${setupName(v)} — run \`node scripts/update-e2e.mjs build\` first`)
      process.exit(2)
    }
  }

  const server = await startFeed()
  log(`feed on ${FEED_URL} from ${FEED}`)
  const project = join(process.env.RUNNER_TEMP || OUT, 'e2e-project')

  try {
    await stageInstall()
    const installDir = installedDir()
    if (!installDir) return
    seed(project)
    await stageSuccess(installDir)
    await stageRollback(installDir)
    log('watchdog stage skipped: optional, and not run in this job (see the report)')
  } catch (err) {
    check('driver ran to the end', false, err?.stack ?? String(err))
  } finally {
    try {
      const dir = installedDir(true)
      if (dir) await stopForge(dir, 'cleanup')
    } catch {
      /* best effort */
    }
    for (const f of [ULOG, STATE, HEALTH]) if (existsSync(f)) copyFileSync(f, join(ART, `final-${basename(f)}`))
    server.close()
  }
}

let installDirCache = ''
function installedDir(quiet = false) {
  if (installDirCache) return installDirCache
  const entry = uninstallEntries()[0]
  let loc = String(entry?.InstallLocation ?? '').replace(/^"|"$/g, '').replace(/\\+$/, '')
  // InstallLocation is optional in the key; the uninstaller's own path is not.
  if (!loc) {
    const m = /^"?(.*)\\Uninstall Forge\.exe/i.exec(String(entry?.UninstallString ?? ''))
    if (m) loc = m[1]
  }
  if (!loc && !quiet) check('install location is known', false, JSON.stringify(entry ?? null))
  installDirCache = loc
  return loc
}

async function stageInstall() {
  const setup = join(buildDir(OLD), setupName(OLD))
  const t0 = Date.now()
  const r = spawnSync(setup, ['/S'], { timeout: 300_000, windowsHide: true })
  const info = { installer: setup, args: ['/S'], exit: r.status, signal: r.signal, error: r.error?.message ?? null, seconds: (Date.now() - t0) / 1000 }
  writeFileSync(join(ART, 'install-old.json'), JSON.stringify(info, null, 2))
  check(`install ${OLD}: silent installer exits 0`, r.status === 0, JSON.stringify(info))

  const entries = uninstallEntries()
  writeFileSync(join(ART, 'uninstall-key-after-install.json'), JSON.stringify(entries, null, 2))
  const dir = installedDir()
  const expected = join(LOCALAPPDATA, 'Programs', 'forge')
  log(`install location from HKCU: ${dir} (default would be ${expected})`)
  check(`install ${OLD}: one HKCU uninstall entry`, entries.length === 1, JSON.stringify(entries))
  check(`install ${OLD}: DisplayVersion is ${OLD}`, entries[0]?.DisplayVersion === OLD, String(entries[0]?.DisplayVersion))
  const pv = productVersion(join(dir, 'Forge.exe'))
  check(`install ${OLD}: Forge.exe ProductVersion is ${OLD}`, short(pv) === OLD, pv || 'no Forge.exe')
  const feedCfg = existsSync(join(dir, 'resources', 'app-update.yml')) ? readFileSync(join(dir, 'resources', 'app-update.yml'), 'utf8') : ''
  check(`install ${OLD}: app-update.yml reads the local feed`, feedCfg.includes('provider: generic') && feedCfg.includes(FEED_URL), feedCfg.replace(/\n/g, ' | '))
  check(`install ${OLD}: the helper is shipped`, existsSync(join(dir, 'resources', 'updater', 'apply-update.ps1')), join(dir, 'resources', 'updater'))
  // A silent install does not start the app; make sure nothing is running.
  if (dir) log(`after install: ${await stopForge(dir, 'after install')}`)
}

async function stageSuccess(installDir) {
  const tag = 'success'
  serveRealNew()
  const backup = `${installDir}.update-backup`

  const live = await launch(installDir, `${tag}-${OLD}`)
  check(`${tag}: launched Forge is ${OLD}`, live.version === OLD, live.version)
  const gone = await updateThroughBanner(live, NEW, tag)
  if (!gone) return

  const { state, phases } = await watchHelper(tag, 4 * 60_000)
  const id = state?.id ?? ''
  check(`${tag}: state reaches succeeded within 4 min`, state?.phase === 'succeeded', `phases ${phases.join(' > ')}`)
  check(`${tag}: state is ${OLD} -> ${NEW}`, state?.from === OLD && state?.to === NEW, `${state?.from} -> ${state?.to}`)
  const exit = await waitHelperExit(id, 90_000)
  check(`${tag}: helper exit 0`, exit === 0, String(exit))

  const pv = productVersion(join(installDir, 'Forge.exe'))
  check(`${tag}: installed Forge.exe ProductVersion is ${NEW}`, short(pv) === NEW, pv)
  const entries = uninstallEntries()
  writeFileSync(join(ART, `uninstall-key-after-${tag}.json`), JSON.stringify(entries, null, 2))
  check(`${tag}: HKCU DisplayVersion is ${NEW}`, entries.length === 1 && entries[0]?.DisplayVersion === NEW, JSON.stringify(entries.map((e) => e.DisplayVersion)))
  check(`${tag}: backup folder is gone`, !existsSync(backup), backup)

  const mains = forgeMains(installDir)
  writeFileSync(join(ART, `procs-after-${tag}.json`), JSON.stringify(forgeProcs(installDir), null, 2))
  check(
    `${tag}: a new Forge.exe is running from the install folder`,
    mains.length >= 1 && mains.every((m) => m.ProcessId !== live.pid),
    JSON.stringify(mains.map((m) => ({ pid: m.ProcessId, cmd: m.CommandLine })))
  )

  const health = readJson(HEALTH)
  if (existsSync(HEALTH)) copyFileSync(HEALTH, join(ART, `health-${tag}.json`))
  check(`${tag}: update-health.json has this id and ${NEW}`, health?.id === id && health?.version === NEW, JSON.stringify(health))

  const lines = readLog()
  const run = helperRun(id)
  check(`${tag}: [main] handed over to the helper`, lines.includes(`[main] apply ${id}: handshake complete at waiting-for-exit`), id)
  check(`${tag}: [helper] saw Forge quit by itself`, run.some((l) => l.includes(`Forge (pid ${live.pid}) exited`)), run.find((l) => l.includes(`pid ${live.pid}`)) ?? 'no line')
  check(`${tag}: [helper] installer exit code 0`, run.some((l) => l.includes('[helper] installer exit code 0')), run.find((l) => l.includes('installer exit code')) ?? 'no line')
  check(`${tag}: [helper] health reported ${NEW}`, run.some((l) => l.includes(`health reported: version ${NEW}`)), '')
  check(`${tag}: [main] the new Forge wrote its health`, lines.includes(`[main] health: written for ${id} (${NEW}`), '')
  copyFileSync(ULOG, join(ART, `updater-after-${tag}.log`))

  await sleep(8000)
  desktopShot(`${tag}-5-desktop-after-relaunch.png`)
}

async function stageRollback(installDir) {
  const tag = 'rollback'
  const backup = `${installDir}.update-backup`

  log(`before ${tag}: ${await stopForge(installDir, `before ${tag}`)}`)
  serveLyingFeed()

  const live = await launch(installDir, `${tag}-${NEW}`)
  check(`${tag}: launched Forge is ${NEW}`, live.version === NEW, live.version)
  // The last update's result greets the next launch; it holds the banner until dismissed.
  const updated = await banner(live.page, 'updated').waitFor({ timeout: 30_000 }).then(() => true, () => false)
  check(`${tag}: next launch says the last update worked`, updated && (await bannerText(live.page)).includes(`Updated to v${NEW}`), await bannerText(live.page))
  if (updated) {
    await bannerShot(live.page, `${tag}-0-updated`)
    await button(live.page, 'OK').click()
  }

  const lastId = readJson(STATE)?.id ?? ''
  const gone = await updateThroughBanner(live, FAKE, tag)
  if (!gone) return

  const { state, phases } = await watchHelper(tag, 4 * 60_000, lastId)
  const id = state?.id ?? ''
  check(`${tag}: state reaches rolled-back within 4 min`, state?.phase === 'rolled-back', `phases ${phases.join(' > ')}`)
  check(`${tag}: rolled-back carries a reason`, Boolean(state?.reason?.trim()), state?.reason ?? '')
  const exit = await waitHelperExit(id, 90_000)
  check(`${tag}: helper exit 2`, exit === 2, String(exit))

  const run = helperRun(id)
  check(`${tag}: [helper] installer exit code 0`, run.some((l) => l.includes('[helper] installer exit code 0')), run.find((l) => l.includes('installer exit code')) ?? 'no line')
  check(
    `${tag}: [helper] refused at verifying on the version`,
    run.some((l) => l.includes('phase -> verifying')) && run.some((l) => l.includes(`rolling back: The installed Forge is version`) && l.includes(`not ${FAKE}`)),
    run.find((l) => l.includes('rolling back:')) ?? 'no rolling back line'
  )
  check(`${tag}: [helper] never launched the refused build`, !run.some((l) => l.includes('phase -> launching')), '')
  check(`${tag}: [helper] re-imported the registry`, run.some((l) => /registry: reg import .* exit 0/.test(l)), run.filter((l) => l.includes('registry:')).join(' || '))
  check(`${tag}: [helper] restarted the old version`, run.some((l) => l.includes('started the old version')), '')

  const pv = productVersion(join(installDir, 'Forge.exe'))
  check(`${tag}: Forge.exe ProductVersion is still ${NEW}`, short(pv) === NEW, pv)
  const entries = uninstallEntries()
  writeFileSync(join(ART, `uninstall-key-after-${tag}.json`), JSON.stringify(entries, null, 2))
  check(`${tag}: HKCU DisplayVersion is still ${NEW}`, entries.length === 1 && entries[0]?.DisplayVersion === NEW, JSON.stringify(entries.map((e) => e.DisplayVersion)))
  check(`${tag}: backup folder is gone`, !existsSync(backup), backup)

  await sleep(8000)
  const mains = forgeMains(installDir)
  writeFileSync(join(ART, `procs-after-${tag}.json`), JSON.stringify(forgeProcs(installDir), null, 2))
  check(
    `${tag}: the old Forge was relaunched from the install folder`,
    mains.length >= 1 && mains.every((m) => m.ProcessId !== live.pid),
    JSON.stringify(mains.map((m) => ({ pid: m.ProcessId, cmd: m.CommandLine })))
  )
  desktopShot(`${tag}-5-desktop-after-relaunch.png`)
  copyFileSync(ULOG, join(ART, `updater-after-${tag}.log`))

  // The next launch must say the update did not finish.
  log(`before the result check: ${await stopForge(installDir, 'result check')}`)
  const next = await launch(installDir, `${tag}-result`)
  const failed = await banner(next.page, 'failed').waitFor({ timeout: 30_000 }).then(() => true, () => false)
  const text = await bannerText(next.page)
  check(`${tag}: next launch is still ${NEW}`, next.version === NEW, next.version)
  check(
    `${tag}: next launch's banner says the update did not finish`,
    failed && text.includes(`Update to v${FAKE} did not finish`) && text.includes(`Forge is still on v${NEW}`),
    text
  )
  await bannerShot(next.page, `${tag}-6-result`)
}

/* -------------------------------------------------------------------- main */

const cmd = process.argv[2]
if (cmd === 'build') {
  build()
} else if (cmd === 'run') {
  await run()
  const failed = results.filter((l) => l.startsWith('FAIL'))
  const summary = [`update-e2e: ${results.length - failed.length} passed, ${failed.length} failed`, ...results].join('\n')
  writeFileSync(join(ART, 'summary.txt'), summary + '\n')
  console.log(`\n${summary}`)
  process.exit(failed.length || results.length === 0 ? 1 : 0)
} else {
  console.error('usage: node scripts/update-e2e.mjs build | run')
  process.exit(2)
}

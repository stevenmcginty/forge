/**
 * Drive the *packaged* Forge and prove it actually works.
 *
 *   npm run dist && node scripts/packaged-check.mjs
 *   node scripts/packaged-check.mjs --app release/win-unpacked/Forge.exe
 *   node scripts/packaged-check.mjs --keep     leave the data dir behind
 *
 * Everything else in scripts/ tests modules. This tests the artifact: the thing
 * that gets zipped and handed to somebody. Packaging breaks in ways no unit test
 * can see — a native module that will not load out of an asar, a resource path
 * that only resolved because a dev checkout happened to be two directories up, a
 * frozen Python binary missing a DLL. All of those look fine until you run the
 * exe, so this runs the exe.
 *
 * It launches with `--remote-debugging-port` and talks CDP to the real renderer,
 * so every check goes through the same `window.forge` bridge the UI uses. Run
 * against an isolated FORGE_DATA_DIR, so it can never touch a real install — and
 * so the data directory is genuinely empty, which is the only way to see the
 * first-run overlay.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APP = resolve(val('--app', join(ROOT, 'release', 'win-unpacked', 'Forge.exe')))
const RESOURCES = join(APP, '..', 'resources')
const PORT = Number(val('--port', '9333'))
const KEEP = argv.includes('--keep')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

if (!existsSync(APP)) {
  console.error(`\n  ✕    no packaged app at ${APP} — run \`npm run dist\` first\n`)
  process.exit(2)
}

const dataDir = mkdtempSync(join(tmpdir(), 'forge-packaged-'))
console.log(`\npackaged check\n  ..   app       ${APP}\n  ..   data dir  ${dataDir}`)

/* ------------------------------------------------------------------ launch */

/**
 * Smart App Control is on by default on clean Windows 11 installs. It blocks
 * unsigned executables it has no reputation for — and electron-builder's
 * rebranding (icon, version resource, asar integrity) invalidates the signature
 * Electron ships with, so every fresh Forge.exe is exactly that.
 *
 * The failure surfaces as `spawn UNKNOWN`, which explains nothing, so say what
 * it actually means. This is the same wall the person you hand the zip to will
 * hit; GIVE-TO-A-FRIEND.md covers what they can do about it.
 */
function explainSpawnFailure(err) {
  if (process.platform !== 'win32' || err?.code !== 'UNKNOWN') return null
  const probe = spawnSync(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
    { encoding: 'utf8' }
  )
  const on = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x1\b/.test(probe.stdout ?? '')
  return [
    'Windows refused to start the packaged exe (spawn UNKNOWN).',
    on
      ? 'Smart App Control is ON on this machine (VerifiedAndReputablePolicyState = 1).'
      : 'This is usually an application-control policy, antivirus quarantine, or a file still locked by the build.',
    'electron-builder rebrands electron.exe (icon, version resource, asar integrity),',
    'which breaks the Authenticode signature Electron ships with — so a freshly',
    'built Forge.exe is an unsigned binary with no reputation, which is precisely',
    'what Smart App Control blocks. Nothing in the build is wrong; the machine is',
    'refusing to run an unsigned exe.'
  ].join('\n       ')
}

let child
try {
  child = spawn(APP, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, FORGE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
} catch (err) {
  rmSync(dataDir, { recursive: true, force: true })
  const why = explainSpawnFailure(err)
  console.error(`\n  ✕    ${why ?? (err?.message ?? String(err))}\n`)
  // 3, not 1: this is "could not run the check", not "the check found a fault".
  process.exit(3)
}
let appStderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => {
  appStderr += d
})
child.stderr.on('data', (d) => {
  appStderr += d
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  return null
}

/* --------------------------------------------------------------------- cdp */

let ws = null
let nextId = 1
const waiting = new Map()

function connect(url) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      ws = socket
      done(socket)
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const pending = waiting.get(msg.id)
      if (!pending) return
      waiting.delete(msg.id)
      pending(msg)
    })
  })
}

function send(method, params) {
  const id = nextId++
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`${method} timed out`))
    }, 120_000)
    waiting.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
      else done(msg.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * Spawn the packaged bridge the way Claude Code does — bare `node <path>`,
 * cwd somewhere unrelated — and see whether it completes an MCP handshake.
 * This is the check that catches the bridge shipping without its SDK.
 */
function bridgeAnswers(script) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [script], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    const finish = (result) => {
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* gone */
      }
      done(result)
    }
    const timer = setTimeout(() => finish(false), 20_000)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('"serverInfo"') && out.includes('forge-bridge')) finish(true)
    })
    proc.on('error', () => finish(false))
    proc.on('exit', () => finish(out.includes('forge-bridge')))
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packaged-check', version: '1' } }
      })}\n`
    )
  })
}

/** Evaluate an async expression in the renderer and get its value back. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'renderer threw')
  }
  return result.result.value
}

/* -------------------------------------------------------------------- run */

let exitCode = 1
try {
  const target = await waitForTarget()
  ok(target !== null, 'the packaged app boots and exposes a renderer')
  if (!target) throw new Error('no renderer target')

  await connect(target.webSocketDebuggerUrl)
  await send('Runtime.enable', {})

  // The renderer hydrates from disk before it renders anything real.
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate("return !!document.querySelector('.app[data-ready=\"true\"]')")
    if (ready) break
    await sleep(400)
  }

  /* ------------------------------------------------------------- identity */

  const info = await evaluate('return await window.forge.info()')
  ok(info?.name === 'Forge', 'window.forge is wired up in the packaged renderer', JSON.stringify(info))
  ok(
    resolve(info?.dataDir ?? '') === resolve(dataDir),
    'FORGE_DATA_DIR is honoured by the packaged build',
    `${info?.dataDir} !== ${dataDir}`
  )
  console.log(`  ..   Electron ${info?.electron}, Chrome ${info?.chrome}, Node ${info?.node}`)

  /* ----------------------------------------------------------- onboarding */

  const onboarding = await evaluate(`
    const el = document.querySelector('.onboard')
    if (!el) return null
    return {
      steps: el.querySelectorAll('.onboard__step').length,
      title: el.querySelector('.onboard__title')?.textContent ?? '',
      hasCta: !!el.querySelector('.onboard__foot .cta-btn')
    }
  `)
  ok(onboarding !== null, 'the first-run welcome shows on an empty data directory')
  ok(onboarding?.steps === 3, 'with three steps', JSON.stringify(onboarding))
  ok(onboarding?.hasCta === true, 'and a way out of it')

  const agents = await evaluate('return await window.forge.probeAgents()')
  ok(Array.isArray(agents) && agents.length === 3, 'agent detection answers', JSON.stringify(agents?.map?.((a) => a.id)))
  for (const agent of agents ?? []) {
    console.log(`  ..   ${agent.name}: ${agent.found ? agent.path : 'not on PATH'}`)
  }
  ok(
    (agents ?? []).every((a) => typeof a.found === 'boolean' && (a.found ? Boolean(a.path) : Boolean(a.installUrl))),
    'every agent is either resolved to a path or offered an install link'
  )

  /* ------------------------------------------------------------- terminal */

  const pty = await evaluate(`
    const id = 'packaged-check-1'
    const created = await window.forge.pty.create({ id, cwd: ${JSON.stringify(dataDir)}, cols: 80, rows: 24 })
    // ConPTY reports pid 0 until the console host has attached, so the real
    // proof that a shell was forked comes from a later list(), not from create().
    let live = []
    for (let i = 0; i < 40; i++) {
      live = await window.forge.pty.list()
      if (live[0]?.pid > 0) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const output = await new Promise((resolve) => {
      let seen = ''
      const off = window.forge.pty.onData((e) => {
        if (e.id !== id) return
        seen += e.data
        if (seen.length > 8) {
          off()
          resolve(seen)
        }
      })
      setTimeout(() => {
        off()
        resolve(seen)
      }, 8000)
    })
    await window.forge.pty.kill(id)
    return { created, live, output: output.slice(0, 200) }
  `)
  ok(pty?.created?.ok === true, 'a real PTY session opens in the packaged app', JSON.stringify(pty?.created))
  ok(pty?.live?.length === 1, 'and the manager sees it')
  ok(
    (pty?.live?.[0]?.pid ?? 0) > 0,
    'node-pty loaded out of app.asar.unpacked and forked a real shell',
    JSON.stringify(pty?.live)
  )
  ok((pty?.output ?? '').length > 0, 'and the shell printed something back down the pipe')

  /* ---------------------------------------------------------------- tray */

  const shotPath = join(dataDir, 'probe.png')
  // A 1x1 PNG — enough for the shelf to decode, hash and thumbnail.
  writeFileSync(
    shotPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  const tray = await evaluate(`
    const adopted = await window.forge.shots.adopt([${JSON.stringify(shotPath)}])
    const list = await window.forge.shots.list()
    return { adopted, count: list.length, hasThumb: !!list[0]?.thumb, ui: !!document.querySelector('.tray') }
  `)
  ok(tray?.ui === true, 'the screenshot tray is on screen')
  ok(tray?.adopted === 1 && tray?.count === 1, 'a dropped image lands on the shelf', JSON.stringify(tray))
  ok(tray?.hasThumb === true, 'and gets a thumbnail — the native image decode works packaged')

  /* -------------------------------------------------------------- bridge */

  const mcpPath = join(dataDir, 'bridge', 'mcp.json')
  ok(existsSync(mcpPath), 'the bridge MCP config is generated on start', mcpPath)
  if (existsSync(mcpPath)) {
    const config = JSON.parse(readFileSync(mcpPath, 'utf8'))
    const args = config?.mcpServers?.['forge-bridge']?.args ?? []
    const script = args[0]
    ok(typeof script === 'string' && existsSync(script), 'and points at a bridge script that exists', String(script))
    ok(
      resolve(script ?? '').startsWith(resolve(RESOURCES)),
      'which is the packaged one under resources/, not a dev checkout',
      String(script)
    )
    // The real question is not what the file looks like but whether `node`
    // can run it from somewhere with no node_modules above it — which is
    // exactly the situation a Claude pane spawns it in.
    ok(await bridgeAnswers(script), 'and `node` can run it standalone from an unrelated directory')
  }

  /* ----------------------------------------------------------------- stt */

  ok(existsSync(join(RESOURCES, 'stt-bin', 'forge-stt.exe')), 'the frozen speech engine is in the package')

  // Deliberately point at a folder that is not there: the packaged engine has
  // to *start*, look, and say so in a typed way the setup card can render. This
  // is the state a friend with a fresh install is in, and it must not look like
  // a crash.
  const sttState = await evaluate(`
    await window.forge.store.setSettings({ sttModelDir: 'C:\\\\forge-packaged-check\\\\no-model-here', sttPython: '' })
    await window.forge.stt.reload(true)
    for (let i = 0; i < 120; i++) {
      const s = await window.forge.stt.status()
      if (s.error || s.ready) return s
      await new Promise((r) => setTimeout(r, 500))
    }
    return await window.forge.stt.status()
  `)
  ok(sttState?.error?.kind === 'model-missing', 'the packaged engine starts and reports model-missing', JSON.stringify(sttState))
  ok(sttState?.phase === 'error' && sttState?.ready === false, 'as a setup state, not a crash loop')
  console.log(`  ..   "${sttState?.error?.msg}"`)

  const model = await evaluate('return await window.forge.stt.modelState()')
  ok(typeof model?.status === 'string', 'the model downloader reports its state', JSON.stringify(model))
  ok(model?.sizeHint?.includes('MB'), 'including how big the download is')

  exitCode = fail === 0 ? 0 : 1
} catch (err) {
  fail++
  console.log(`  FAIL ${err?.message ?? err}`)
} finally {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  // Take the whole tree down, not just the main process. Electron's GPU and
  // utility children outlive a plain kill() by a moment, and while they are
  // alive they hold a handle on release/win-unpacked — which leaves the
  // *directory name* in delete-pending state and makes the next `npm run dist`
  // fail with EPERM renaming win-unpacked.tmp into place. taskkill /T is the
  // only thing on Windows that reliably gets the children.
  child.kill()
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  await sleep(2500)
  if (child.exitCode === null) child.kill('SIGKILL')
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true })
  else console.log(`  ..   data dir kept at ${dataDir}`)
}

if (appStderr.trim()) {
  console.log('\n  ..   app output:')
  for (const line of appStderr.trim().split(/\r?\n/).slice(-20)) console.log(`       ${line}`)
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(exitCode)

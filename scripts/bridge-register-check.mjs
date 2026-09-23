/**
 * bridge-register-check — end-to-end dry run of the bridge's registration.
 *
 * Proves the *real* electron/bridge/mcp-config.ts (not a copy of its logic):
 *   1. bundles it with esbuild and runs it inside a real Electron process, so
 *      app.getAppPath()/app.getPath('appData') are the genuine article;
 *   2. asserts %APPDATA%\Forge\bridge\mcp.json is written with absolute paths
 *      that exist;
 *   3. asserts applyMcpBridge() appends the flag for Claude and leaves every
 *      other profile alone;
 *   4. hands the generated file to the real `claude --mcp-config <path> --help`
 *      to confirm the CLI accepts both the flag and the file's shape.
 *   5. holds forge-bridge's other registrations to their shapes — Codex's -c
 *      override (asked of the real `codex mcp get` under a temp CODEX_HOME),
 *      OpenCode's pane config, and scripts/bridge-install.mjs run against a
 *      temp home: entry shape, other entries untouched, backup before the first
 *      write, idempotence, not-installed skip. The real home is never touched.
 *
 * No interactive Claude session is started, and no Forge window is opened.
 *
 * Run:  node scripts/bridge-register-check.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Temp files written into the repo root; removed however we exit. */
const cleanup = []

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ')}` : ''}`)
  }
}

function run(file, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
      done({ code: null, timedOut: true, stdout, stderr })
    }, 120_000)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ code: null, spawnError: e.code ?? e.message, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

/* ------------------------------- 1. run the real module inside Electron ---- */

async function probeInsideElectron(extraEnv = {}) {
  // The probe files must live in the repo root: Electron derives getAppPath()
  // from the directory holding the entry script's nearest package.json, and the
  // module under test resolves the bridge relative to it. Anywhere else and we
  // would be testing a layout Forge never runs in.
  const bundle = join(root, '.bridge-check-config.cjs')
  await build({
    entryPoints: [join(root, 'electron', 'bridge', 'mcp-config.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    // The module reaches into ../store, which imports the @shared alias.
    alias: { '@shared': join(root, 'shared') },
    logLevel: 'silent'
  })

  const entry = join(root, '.bridge-check-main.cjs')
  cleanup.push(bundle, entry)
  writeFileSync(
    entry,
    `const { app } = require('electron')
const path = require(${JSON.stringify(bundle)})
// Match Forge's own appData layout so we write the real mcp.json, not a stray one.
app.setName('Forge')
app.whenReady().then(() => {
  const out = {
    appPath: app.getAppPath(),
    script: path.resolveBridgeScript(),
    configPath: path.writeBridgeConfig(),
    claude: path.applyMcpBridge('claude'),
    claudeWithArgs: path.applyMcpBridge('claude --resume'),
    kimi: path.applyMcpBridge('kimi'),
    gemini: path.applyMcpBridge('gemini'),
    plain: path.applyMcpBridge(''),
    idempotent: path.applyMcpBridge(path.applyMcpBridge('claude')),
    codex: path.applyMcpBridge('codex'),
    codexIdempotent: path.applyMcpBridge(path.applyMcpBridge('codex')),
    instructions: path.bridgeInstructionsPath(),
    outDir: path.bridgeOutDir()
  }
  process.stdout.write('@@RESULT@@' + JSON.stringify(out) + '@@END@@')
  app.exit(0)
})
`,
    'utf8'
  )

  const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(electronExe)) {
    console.log('  --   electron binary missing — run `node node_modules/electron/install.js`')
    return null
  }

  // ELECTRON_RUN_AS_NODE must NOT be set: we need the real app module.
  const env = { ...process.env, ...extraEnv }
  delete env['ELECTRON_RUN_AS_NODE']
  const r = await run(electronExe, [entry], { env })
  const m = r.stdout.match(/@@RESULT@@([\s\S]*?)@@END@@/)
  if (!m) {
    check('Electron probe produced a result', false, `exit ${r.code}\n${r.stdout}\n${r.stderr}`)
    return null
  }
  return JSON.parse(m[1])
}

/* ---------------------------------------------------------------- 2. claude */

/**
 * Resolve `claude` to something spawnable with a clean argv.
 *
 * Node will not spawn a `.cmd` without `shell: true`, and shelling out means
 * quoting a config path *and* a prompt through cmd.exe — which mangles nested
 * quotes. So pull the real JS entry out of the npm shim and run it under Node,
 * passing every argument as its own argv slot. (Forge itself has no such
 * problem: it types the command into pwsh, which quotes correctly.)
 */
function claudeLauncher() {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  for (const d of dirs) {
    for (const n of ['claude.cmd', 'claude.exe', 'claude']) {
      const p = join(d, n)
      if (!existsSync(p)) continue
      if (n.endsWith('.exe')) return { file: p, prefixArgs: [] }
      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      for (const m of text.matchAll(/"?(?:%dp0%|\$basedir|%~dp0)[\\/]?([^"\s]+\.(?:[cm]?js|exe))"?/g)) {
        const target = join(dirname(p), m[1].replace(/\\/g, '/'))
        if (!existsSync(target)) continue
        // npm points claude.cmd at a native launcher; gemini.cmd at a JS entry.
        return /\.exe$/i.test(target) ? { file: target, prefixArgs: [] } : { file: process.execPath, prefixArgs: [target] }
      }
      if (process.platform !== 'win32') return { file: p, prefixArgs: [] }
    }
  }
  return null
}

/* ------------------------------------------------------- 5. the other CLIs */

/**
 * forge-bridge for Codex, OpenCode, Gemini CLI, Qwen and Antigravity
 * (electron/bridge/cli-register.ts, scripts/bridge-install.mjs) — against a temp
 * home only. Nothing here reads or writes the real one.
 */
async function otherClis(gate) {
  await import('./ts-hooks.mjs')
  const R = await import('../electron/bridge/cli-register.ts')
  const script = join(root, 'bridge', 'gemini-bridge.mjs')

  console.log('\n[5a] Per-pane shapes: Codex -c and OpenCode env')
  const fragment = R.codexBridgeFragment(script, 'C:\\Forge Data\\bridge-out')
  const inner = /\{(.*)\}"$/.exec(fragment ?? '')?.[1] ?? ''
  check('codex fragment is a -c override on the bare dashed key', fragment?.startsWith('-c "mcp_servers.forge-bridge={'), fragment)
  check('codex fragment has no " or $ inside (it is typed into PowerShell)', inner.length > 0 && !inner.includes('"') && !inner.includes('$'), inner)
  check('codex fragment carries the path verbatim', fragment?.includes(`args=['${script}']`), fragment)
  check(
    'codex fragment forwards every pane variable by name',
    R.BRIDGE_PANE_ENV.every((n) => inner.includes(`'${n}'`)),
    inner
  )
  check("a path with an apostrophe is refused, not mangled", R.codexBridgeFragment("C:\\it's\\b.mjs", null) === null)
  check('an unsafe out dir is dropped, the server kept', R.codexBridgeFragment(script, "C:\\o'k")?.includes('env=') === false)
  check('the Electron probe built exactly this fragment for a codex pane', gate.codex === `codex ${R.codexBridgeFragment(gate.script, gate.outDir)}`, gate.codex)

  const oc = JSON.parse(R.openCodePaneConfig({ bridgeScript: script, outDir: 'C:\\o', instructionsPath: 'C:\\i.md', shareScript: null }))
  check('opencode: forge-bridge is a local server run by node', JSON.stringify(oc.mcp?.['forge-bridge']?.command) === JSON.stringify(['node', script]) && oc.mcp['forge-bridge'].type === 'local', JSON.stringify(oc))
  check('opencode: and the instructions file rides in the same value', JSON.stringify(oc.instructions) === JSON.stringify(['C:\\i.md']), JSON.stringify(oc))
  check('opencode: no share server unless it is on', !('forge_share' in oc.mcp), JSON.stringify(Object.keys(oc.mcp)))
  const both = JSON.parse(R.openCodePaneConfig({ bridgeScript: script, outDir: null, instructionsPath: null, shareScript: 'C:\\s.mjs' }))
  check('opencode: with both, the share copy drops its browser tools', both.mcp?.forge_share?.environment?.FORGE_BROWSER_TOOLS === 'off', JSON.stringify(both))
  check('opencode: nothing at all when there is no bridge and no share', R.openCodePaneConfig({ bridgeScript: null, outDir: null, instructionsPath: null, shareScript: null }) === null)

  const codexOk = (await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'codex --version'])).code === 0
  if (codexOk) {
    const codexHome = join(tmpdir(), `forge-register-codex-${Date.now()}`)
    cleanup.push(codexHome)
    mkdirSync(codexHome, { recursive: true })
    const r = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `codex mcp get forge-bridge --json ${fragment}`], {
      env: { ...process.env, CODEX_HOME: codexHome }
    })
    let got = null
    try {
      got = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
    } catch {
      /* reported below */
    }
    check('live: codex reads the fragment, typed into PowerShell, as server "forge-bridge"', got?.name === 'forge-bridge', `${r.stdout}\n${r.stderr}`.slice(0, 600))
    check('live: with the bridge path and env_vars intact', got?.transport?.args?.[0] === script && got?.transport?.env_vars?.includes('FORGE_BROWSER_LINK_FILE'), JSON.stringify(got?.transport))
  } else {
    console.log('  --   codex not installed; live -c probe skipped')
  }

  // Reads the config and prints it; starts no session and writes nothing.
  const ocProbe = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'opencode debug config'], {
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: R.openCodePaneConfig({ bridgeScript: script, outDir: null, instructionsPath: join(root, 'README.md'), shareScript: null }) }
  })
  if (ocProbe.code === 0) {
    check('live: opencode merges forge-bridge from the pane value', /"forge-bridge"/.test(ocProbe.stdout), ocProbe.stdout.slice(0, 400))
    check('live: and takes the instructions path', ocProbe.stdout.includes(JSON.stringify(join(root, 'README.md')).slice(1, -1)), ocProbe.stdout.slice(0, 400))
  } else {
    console.log('  --   opencode not installed (or failed to start); live pane-config probe skipped')
  }

  console.log('\n[5b] Pure merges')
  const theirs = JSON.stringify({ ui: { theme: 'x' }, mcpServers: { theirs: { command: 'y' } } }, null, 2)
  const entry = R.settingsEntry('qwen', script)
  const added = R.mergeSettingsEntry(theirs, entry)
  const addedJson = added.action === 'write' ? JSON.parse(added.text) : {}
  check('settings: forge-bridge is added', added.action === 'write' && JSON.stringify(addedJson.mcpServers['forge-bridge']) === JSON.stringify(entry), JSON.stringify(added))
  check('settings: every other key and server is untouched', JSON.stringify(addedJson.ui) === '{"theme":"x"}' && addedJson.mcpServers.theirs?.command === 'y', JSON.stringify(addedJson))
  check('settings: a second merge is a no-op', R.mergeSettingsEntry(added.text, entry).action === 'none')
  const foreign = JSON.stringify({ mcpServers: { 'forge-bridge': { command: 'z' } } })
  check('settings: a forge-bridge Forge did not write is refused', R.mergeSettingsEntry(foreign, entry).action === 'refuse')
  check('settings: an unparseable file is refused', R.mergeSettingsEntry('{ nope', entry).action === 'refuse')
  check('gemini entry names the key by reference, never by value', R.settingsEntry('gemini', script).env?.GEMINI_API_KEY === '${GEMINI_API_KEY}')

  const md = '# Mine\r\n\r\nKeep this.'
  const once = R.mergeInstructionLine(md)
  check('instructions: the line is appended and the rest kept byte for byte', once.action === 'write' && once.text.startsWith(md) && once.text.includes(R.BROWSER_INSTRUCTION_LINE), JSON.stringify(once))
  check('instructions: a second merge is a no-op', once.action === 'write' && R.mergeInstructionLine(once.text).action === 'none')
  const stale = `a\n${'old wording ' + R.INSTRUCTION_MARKER}\nb\n`
  const refreshed = R.mergeInstructionLine(stale)
  check('instructions: a stale marked line is replaced in place', refreshed.action === 'write' && refreshed.text === `a\n${R.BROWSER_INSTRUCTION_LINE}\nb\n`, JSON.stringify(refreshed))

  console.log('\n[5c] bridge-install against a temp home')
  const home = join(tmpdir(), `forge-register-home-${Date.now()}`)
  cleanup.push(home)
  const seed = {
    [join(home, '.gemini', 'settings.json')]: JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, mcpServers: { other: { command: 'npx', args: ['x'] } } }, null, 2),
    [join(home, '.gemini', 'GEMINI.md')]: '# my rules\nBe brief.\n',
    [join(home, '.qwen', 'settings.json')]: JSON.stringify({ ui: { autoModeAcknowledged: true } }, null, 2),
    [join(home, '.gemini', 'config', 'mcp_config.json')]: JSON.stringify({ mcpServers: { 'firebase-mcp-server': { command: 'npx', args: ['-y', 'firebase-tools@latest', 'mcp'] } } }, null, 2)
  }
  for (const [p, text] of Object.entries(seed)) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
  const agyOk = (await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command agy -ErrorAction Stop'])).code === 0
  const installedList = ['codex', 'opencode', 'gemini', 'qwen', ...(agyOk ? ['antigravity'] : [])].join(',')
  const install = (extra = []) => run(process.execPath, [join(root, 'scripts', 'bridge-install.mjs'), '--home', home, '--installed', installedList, ...extra])
  const listAll = (dir) => {
    const out = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)))
    }
    walk(dir)
    return out.sort()
  }

  const dry = await install(['--dry-run'])
  check('dry run exits 0', dry.code === 0, dry.stderr || dry.stdout.slice(-400))
  check('dry run writes nothing', JSON.stringify(listAll(home)) === JSON.stringify(Object.keys(seed).sort()) && Object.entries(seed).every(([p, t]) => readFileSync(p, 'utf8') === t), listAll(home).join('\n'))
  check('dry run says codex and opencode are per-pane and kimi is skipped', /codex\s+mcp\s+per-pane/.test(dry.stdout) && /opencode\s+mcp\s+per-pane/.test(dry.stdout) && /kimi\s+mcp\s+skip/.test(dry.stdout), dry.stdout.slice(0, 600))
  check('a CLI missing from --installed is skipped', /opencode\s+mcp\s+skip\s+not installed/.test((await run(process.execPath, [join(root, 'scripts', 'bridge-install.mjs'), '--home', home, '--installed', 'gemini', '--dry-run'])).stdout))

  const first = await install()
  check('install exits 0', first.code === 0, `${first.stdout}\n${first.stderr}`.slice(-800))
  const g = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'))
  check('gemini: forge-bridge written', g.mcpServers?.['forge-bridge']?.args?.[0] === script, JSON.stringify(g))
  check('gemini: other settings and servers untouched', g.security?.auth?.selectedType === 'gemini-api-key' && g.mcpServers?.other?.command === 'npx', JSON.stringify(g))
  const q = JSON.parse(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8'))
  check('qwen: forge-bridge written, the rest untouched', q.mcpServers?.['forge-bridge']?.command === 'node' && q.ui?.autoModeAcknowledged === true, JSON.stringify(q))
  check('gemini GEMINI.md: their text first, then the line', readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8').startsWith('# my rules\nBe brief.\n') && readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8').includes(R.INSTRUCTION_MARKER))
  check('codex AGENTS.md and qwen QWEN.md created', [join(home, '.codex', 'AGENTS.md'), join(home, '.qwen', 'QWEN.md')].every((p) => existsSync(p) && readFileSync(p, 'utf8').includes(R.INSTRUCTION_MARKER)))
  if (agyOk) {
    const a = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
    check('antigravity (real agy, temp home): forge-bridge added', a.mcpServers?.['forge-bridge']?.args?.[0] === script, JSON.stringify(a))
    check('antigravity: firebase entry untouched', JSON.stringify(a.mcpServers?.['firebase-mcp-server']?.args) === JSON.stringify(['-y', 'firebase-tools@latest', 'mcp']), JSON.stringify(a))
  } else {
    console.log('  --   agy not installed; antigravity apply skipped')
  }

  const baks = listAll(home).filter((p) => p.endsWith('.bak'))
  const expectBak = Object.keys(seed).filter((p) => agyOk || !p.endsWith('mcp_config.json'))
  check('every pre-existing file was backed up once, beside itself', expectBak.every((p) => baks.filter((b) => b.startsWith(`${p}.`)).length === 1) && baks.length === expectBak.length, baks.join('\n'))
  check('each backup is the original content', baks.every((b) => readFileSync(b, 'utf8') === seed[b.replace(/\.[^.]+\.bak$/, '')]), baks.join('\n'))
  check('no backup for a file that did not exist', !baks.some((b) => b.includes('AGENTS.md') || b.includes('QWEN.md')), baks.join('\n'))

  const snapshot = listAll(home).map((p) => `${p}\n${readFileSync(p, 'utf8')}`).join('\n')
  const second = await install()
  check('second run: exits 0 and applies nothing', second.code === 0 && /\n0 change\(s\) applied/.test(second.stdout), second.stdout.slice(-400))
  check('second run: no file changed and no new backup', listAll(home).map((p) => `${p}\n${readFileSync(p, 'utf8')}`).join('\n') === snapshot)
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('bridge-register-check')
  try {
    console.log('\n[1] Real mcp-config.ts inside a real Electron process')
    const res = await probeInsideElectron()
    if (!res) {
      console.log('\nFAIL — could not run the Electron probe')
      process.exitCode = 1
      return
    }

    check('resolveBridgeScript() found gemini-bridge.mjs', !!res.script && existsSync(res.script), res.script)
    check('writeBridgeConfig() returned a path', !!res.configPath, res.configPath)
    check('mcp.json exists on disk', !!res.configPath && existsSync(res.configPath), res.configPath)
    check(
      'mcp.json sits under %APPDATA%\\Forge\\bridge',
      !!res.configPath && /[\\/]Forge[\\/]bridge[\\/]mcp\.json$/.test(res.configPath),
      res.configPath
    )

    let cfg = null
    if (res.configPath && existsSync(res.configPath)) {
      cfg = JSON.parse(readFileSync(res.configPath, 'utf8'))
      const server = cfg?.mcpServers?.['forge-bridge']
      check('registers a forge-bridge server', !!server, JSON.stringify(cfg))
      check('command is node', server?.command === 'node', server?.command)
      check(
        'args point at an existing absolute bridge path',
        Array.isArray(server?.args) && server.args.length === 1 && /^[A-Za-z]:[\\/]/.test(server.args[0]) && existsSync(server.args[0]),
        JSON.stringify(server?.args)
      )
      check(
        'FORGE_BRIDGE_OUT is an absolute directory',
        typeof server?.env?.FORGE_BRIDGE_OUT === 'string' && existsSync(server.env.FORGE_BRIDGE_OUT),
        JSON.stringify(server?.env)
      )
    }

    // The Gemini key rides in this file's env block — the only place besides
    // settings.json that Forge ever writes one. Both directions matter: it must
    // be there when set, and *absent* (not empty) when not, so the bridge can
    // tell "no key" from "bad key".
    console.log('\n[1b] Key injection, against a throwaway data dir')
    const sandbox = join(tmpdir(), `forge-register-check-${Date.now()}`)
    cleanup.push(sandbox)
    try {
      mkdirSync(sandbox, { recursive: true })

      const noKey = await probeInsideElectron({ FORGE_DATA_DIR: sandbox })
      const envOf = (probe) =>
        probe?.configPath && existsSync(probe.configPath)
          ? JSON.parse(readFileSync(probe.configPath, 'utf8'))?.mcpServers?.['forge-bridge']?.env ?? {}
          : null
      const before = envOf(noKey)
      check('no key set → GEMINI_API_KEY is omitted entirely', !!before && !('GEMINI_API_KEY' in before), JSON.stringify(before))
      check(
        'no override set → FORGE_GEMINI_IMAGE_MODEL is omitted entirely',
        !!before && !('FORGE_GEMINI_IMAGE_MODEL' in before),
        JSON.stringify(before)
      )

      // A fake key, written the way Forge writes settings. Key-shaped on
      // purpose, and declared to the packaging gate: SECRETS-AUDIT: fixtures
      const fake = 'AIzaSyFAKEKEYFORTESTSONLY0000000000000000'
      const settings = join(sandbox, 'settings.json')
      writeFileSync(
        settings,
        JSON.stringify({ geminiKey: fake, geminiImageModel: 'gemini-3.1-flash-image' }, null, 2),
        'utf8'
      )
      const withKey = await probeInsideElectron({ FORGE_DATA_DIR: sandbox })
      const after = envOf(withKey)
      check('key set → GEMINI_API_KEY is passed to the bridge', after?.GEMINI_API_KEY === fake, JSON.stringify(after))
      check(
        'image-model override → FORGE_GEMINI_IMAGE_MODEL is passed too',
        after?.FORGE_GEMINI_IMAGE_MODEL === 'gemini-3.1-flash-image',
        JSON.stringify(after)
      )
      check(
        'the key went nowhere but the config it belongs in',
        !readFileSync(join(root, 'bridge', 'gemini-bridge.mjs'), 'utf8').includes(fake),
        'a key must never be written into the repo'
      )
    } catch (err) {
      check('key-injection probe ran', false, String(err))
    }

    /*
     * The share scratchpad's server rides in the same file, as a second entry.
     * One file rather than a repeated `--mcp-config`, because whether a repeated
     * variadic flag appends or replaces is a commander detail nobody should bet a
     * pane's launch on — so the thing to prove is that Claude still accepts the
     * file once there are two servers in it, which [3] below does.
     *
     * It must carry no `env`. That is the whole reason it is a separate server
     * rather than five more tools on forge-bridge: this one is registered with
     * Codex, Qwen and OpenCode as well, and the key must not follow it there.
     */
    console.log('\n[1c] The share server, on and off')
    const shareBox = join(tmpdir(), `forge-register-share-${Date.now()}`)
    cleanup.push(shareBox)
    /** The two-server config, kept for [3] to hand to the real claude. */
    let twoServerConfig = null
    try {
      mkdirSync(shareBox, { recursive: true })
      const serversOf = (probe) =>
        probe?.configPath && existsSync(probe.configPath)
          ? JSON.parse(readFileSync(probe.configPath, 'utf8'))?.mcpServers ?? {}
          : null

      writeFileSync(join(shareBox, 'settings.json'), JSON.stringify({ shareTools: false }, null, 2), 'utf8')
      const off = serversOf(await probeInsideElectron({ FORGE_DATA_DIR: shareBox }))
      check('tools off → only forge-bridge is registered', !!off && !('forge_share' in off), JSON.stringify(Object.keys(off ?? {})))

      writeFileSync(join(shareBox, 'settings.json'), JSON.stringify({ shareTools: true }, null, 2), 'utf8')
      const onProbe = await probeInsideElectron({ FORGE_DATA_DIR: shareBox })
      twoServerConfig = onProbe?.configPath ?? null
      const on = serversOf(onProbe)
      check('tools on → both servers are registered', !!on?.['forge-bridge'] && !!on?.['forge_share'], JSON.stringify(Object.keys(on ?? {})))
      check('the share server is named with an underscore, as every vendor spells it', 'forge_share' in (on ?? {}), JSON.stringify(Object.keys(on ?? {})))
      check('run by node', on?.['forge_share']?.command === 'node', on?.['forge_share']?.command)
      check(
        'from an absolute path that exists',
        Array.isArray(on?.['forge_share']?.args) &&
          on['forge_share'].args.length === 1 &&
          /^[A-Za-z]:[\\/]/.test(on['forge_share'].args[0]) &&
          existsSync(on['forge_share'].args[0]),
        JSON.stringify(on?.['forge_share']?.args)
      )
      check(
        // One non-secret switch only: Claude already has the browser tools from
        // forge-bridge, so its copy of the share server runs without them.
        'and carries no key in its env — only the browser-tools switch',
        !!on?.['forge_share'] &&
          JSON.stringify(on['forge_share'].env ?? {}) === JSON.stringify({ FORGE_BROWSER_TOOLS: 'off' }),
        JSON.stringify(on?.['forge_share'])
      )
    } catch (err) {
      check('share-server probe ran', false, String(err))
    }

    /*
     * Against a data dir with no settings.json, so the profiles are the seeded
     * built-ins — where Claude Code carries `mcpBridge: true`.
     *
     * Probe [1]'s real data dir cannot answer this: the flag is gated on a
     * per-profile switch the user owns, so a machine whose owner has turned the
     * Gemini bridge *off* would fail these four checks while the code was
     * perfectly correct. What is being tested here is the gating, not somebody's
     * preferences.
     */
    console.log('\n[2] applyMcpBridge() gating, against seeded defaults')
    const gateBox = join(tmpdir(), `forge-register-gate-${Date.now()}`)
    cleanup.push(gateBox)
    mkdirSync(gateBox, { recursive: true })
    const gate = (await probeInsideElectron({ FORGE_DATA_DIR: gateBox })) ?? res
    check('claude gets the flag', /^claude --mcp-config "/.test(gate.claude), gate.claude)
    check('flag goes last, after existing args', /^claude --resume --mcp-config "/.test(gate.claudeWithArgs), gate.claudeWithArgs)
    check('kimi is untouched', gate.kimi === 'kimi', gate.kimi)
    check('gemini is untouched', gate.gemini === 'gemini', gate.gemini)
    check('plain shell is untouched', gate.plain === '', JSON.stringify(gate.plain))
    check('idempotent — never doubles the flag', gate.idempotent === gate.claude, gate.idempotent)
    check(
      'codex gets forge-bridge as a -c override, never --mcp-config',
      /^codex -c "mcp_servers\.forge-bridge=\{/.test(gate.codex) && !/--mcp-config/.test(gate.codex),
      gate.codex
    )
    check('codex forwards the pane variables forge-bridge reads', /env_vars=\[[^\]]*'FORGE_BROWSER_LINK_FILE'/.test(gate.codex), gate.codex)
    check('codex: idempotent too', gate.codexIdempotent === gate.codex, gate.codexIdempotent)
    check(
      'agent-instructions.md is written beside mcp.json',
      !!gate.instructions && existsSync(gate.instructions) && /forge-managed:browser/.test(readFileSync(gate.instructions, 'utf8')),
      gate.instructions
    )

    console.log('\n[3] claude accepts the generated config')
    const claude = claudeLauncher()
    if (!claude) {
      check('claude CLI found on PATH', false, 'not found')
    } else {
      // --help exits immediately: no session starts and no model is called.
      const r = await run(claude.file, [...claude.prefixArgs, '--mcp-config', res.configPath, '--help'])
      const combined = `${r.stdout}\n${r.stderr}`
      const clean = r.code === 0
      check('claude --mcp-config <file> --help exits 0', clean, `exit ${r.code}\n${combined.slice(0, 800)}`)
      check(
        'claude did not reject the flag or the config file',
        clean && !/unknown option|unrecognized|failed to (load|parse)|invalid .*config/i.test(combined),
        combined.slice(0, 800)
      )
      check('claude documents --mcp-config (flag is current)', /--mcp-config/.test(combined), combined.slice(0, 400))

      /*
       * And again with the two-server file. This is the assertion that stands
       * behind the decision to put the share server in the same mcp.json rather
       * than to repeat the flag: if Claude were ever to reject a config with two
       * servers in it, every Claude pane would die at launch.
       */
      if (twoServerConfig && existsSync(twoServerConfig)) {
        const both = await run(claude.file, [...claude.prefixArgs, '--mcp-config', twoServerConfig, '--help'])
        const bothOut = `${both.stdout}\n${both.stderr}`
        check(
          'claude accepts a config carrying forge-bridge AND forge_share',
          both.code === 0 && !/unknown option|unrecognized|failed to (load|parse)|invalid .*config/i.test(bothOut),
          `exit ${both.code}\n${bothOut.slice(0, 800)}`
        )
      } else {
        check('the two-server config was available to test', false, String(twoServerConfig))
      }
    }

    // Opt-in: the only way to prove Claude really *loads* the server (its
    // `mcp list` subcommand ignores --mcp-config), but it spends tokens.
    if (process.argv.includes('--live-claude') && claude) {
      console.log('\n[4] Live: Claude loads forge-bridge and sees its tools')
      const r = await run(claude.file, [
        ...claude.prefixArgs,
        '-p',
        'List the exact names of every tool you have from the forge-bridge MCP server. ' +
          'Reply with just the names, comma separated. Do not call them.',
        '--mcp-config',
        res.configPath,
        '--strict-mcp-config'
      ])
      const out = `${r.stdout}\n${r.stderr}`
      for (const tool of ['ask_gemini', 'summarize_video', 'make_image', 'edit_image']) {
        check(`Claude sees ${tool}`, out.includes(tool), out.slice(0, 500))
      }
    }

    await otherClis(gate)

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
    // exitCode, not exit(): exit() inside the try skipped the finally below and
    // left every temp dir and probe file behind.
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    for (const f of cleanup) rmSync(f, { force: true, recursive: true })
  }
}

main().catch((err) => {
  console.error('bridge-register-check crashed:', err)
  process.exit(1)
})

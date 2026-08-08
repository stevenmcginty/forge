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
 *
 * No interactive Claude session is started, and no Forge window is opened.
 *
 * Run:  node scripts/bridge-register-check.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    idempotent: path.applyMcpBridge(path.applyMcpBridge('claude'))
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

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('bridge-register-check')
  try {
    console.log('\n[1] Real mcp-config.ts inside a real Electron process')
    const res = await probeInsideElectron()
    if (!res) {
      console.log('\nFAIL — could not run the Electron probe')
      process.exit(1)
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
        'and carries no env at all — no key follows it to the other vendors',
        !!on?.['forge_share'] && !('env' in on['forge_share']),
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

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
    process.exit(failures === 0 ? 0 : 1)
  } finally {
    for (const f of cleanup) rmSync(f, { force: true, recursive: true })
  }
}

main().catch((err) => {
  console.error('bridge-register-check crashed:', err)
  process.exit(1)
})

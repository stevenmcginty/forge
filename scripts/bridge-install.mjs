/**
 * Register forge-bridge (the built-in browser, the canvas board, the Gemini
 * tools) with the agent CLIs that can only learn about it from their own
 * user-scope config, and add the one-line "use Forge's built-in browser" note
 * to each CLI's instructions file.
 *
 *   npm run bridge:install -- --dry-run   print every planned change, write nothing
 *   npm run bridge:install                apply it
 *
 * Claude, GLM, Codex and OpenCode need nothing from this: Forge hands them
 * forge-bridge per pane, at launch (electron/bridge/mcp-config.ts, share-mcp.ts).
 * The plan itself is electron/bridge/cli-register.ts, pure; this file only reads,
 * backs up, writes and spawns.
 *
 * The rules, all enforced by the plan or here:
 *   • idempotent — a second run changes nothing and makes no backup;
 *   • every file is copied to `<file>.<timestamp>.bak` beside it before its
 *     first write in a run;
 *   • only `mcpServers["forge-bridge"]` and the marked line are ever touched,
 *     and an entry under that name Forge did not write is refused;
 *   • a CLI that is not installed is skipped.
 *
 * The bridge path written is THIS checkout's bridge/gemini-bridge.mjs — what a
 * Forge started from this checkout resolves (app.getAppPath()/bridge). The home
 * directory is shared by every checkout, so the last checkout to run this wins.
 *
 * For tests: `--home <dir>` plans against (and writes into) another home, and
 * runs agy with USERPROFILE/HOME and APPDATA/LOCALAPPDATA pointed there;
 * `--installed a,b` replaces PATH detection.
 *
 * Settings are never read here: the one Gemini entry names the key as
 * `${GEMINI_API_KEY}` and the CLI expands it from the pane Forge starts, so no
 * key — encrypted or not — is ever copied into a CLI's config.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import './ts-hooks.mjs'

const R = await import('../electron/bridge/cli-register.ts')
const { whichCommand } = await import('../electron/which.ts')

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const opt = (name) => {
  const i = argv.indexOf(name)
  return i !== -1 ? argv[i + 1] : undefined
}
const homeOverride = opt('--home')
const home = resolve(homeOverride ?? homedir())
const codexHome = homeOverride ? join(home, '.codex') : process.env.CODEX_HOME?.trim() || join(home, '.codex')
const installedList = opt('--installed')?.split(',').map((s) => s.trim()).filter(Boolean)

const script = join(ROOT, 'bridge', 'gemini-bridge.mjs')
if (!existsSync(script)) {
  console.error(`bridge-install: ${script} does not exist`)
  process.exit(1)
}

const EXE = { codex: 'codex', opencode: 'opencode', gemini: 'gemini', qwen: 'qwen', antigravity: 'agy' }

function agyExe() {
  const onPath = whichCommand('agy')
  if (onPath) return onPath
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const fallback = join(local, 'agy', 'bin', 'agy.exe')
  return existsSync(fallback) ? fallback : null
}

function installed(cli) {
  if (installedList) return installedList.includes(cli)
  if (cli === 'antigravity') return !!agyExe()
  return !!(EXE[cli] && whichCommand(EXE[cli]))
}

function read(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch (err) {
    console.error(`bridge-install: cannot read ${path}: ${err.message}`)
    return null
  }
}

const plan = R.planRegistration({ home, codexHome, script, installed, read })

/* ------------------------------------------------------------------- print */

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backedUp = new Set()

function describe(item) {
  const head = `${item.cli.padEnd(11)} ${item.what.padEnd(12)}`
  if (item.kind === 'skip') return `${head} skip      ${item.reason}`
  if (item.kind === 'per-pane') return `${head} per-pane  ${item.mechanism} (nothing written)`
  if (item.kind === 'cli') {
    return item.upToDate
      ? `${head} ok        ${item.path} already has forge-bridge → ${script}`
      : `${head} run       agy ${item.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}  (writes ${item.path}${existsSync(item.path) ? `, backed up first` : ''})`
  }
  const m = item.merge
  if (m.action === 'none') return `${head} ok        ${item.path} is already up to date`
  if (m.action === 'refuse') return `${head} REFUSED   ${item.path}: ${m.reason}`
  const exists = existsSync(item.path)
  return `${head} write     ${item.path} (${exists ? 'backup first, then ' : 'new file, '}${item.what === 'mcp' ? `mcpServers["forge-bridge"] → node ${script}` : 'add/refresh the marked browser line'})`
}

console.log(`bridge-install${dryRun ? ' --dry-run' : ''}`)
console.log(`  home:   ${home}`)
console.log(`  bridge: ${script}`)
console.log('')
for (const item of plan) console.log(`  ${describe(item)}`)

const pending = plan.filter(R.itemWrites)
if (dryRun) {
  console.log('')
  for (const item of pending.filter((i) => i.kind === 'file')) {
    console.log(`--- ${item.path} would become:`)
    console.log(item.merge.text.replace(/^/gm, '    ').trimEnd())
  }
  console.log(`\n${pending.length} change(s) planned; --dry-run wrote nothing.`)
  process.exit(0)
}

/* ------------------------------------------------------------------- apply */

function backup(path) {
  if (backedUp.has(path) || !existsSync(path)) return
  copyFileSync(path, `${path}.${stamp}.bak`)
  backedUp.add(path)
  console.log(`  backup  ${path}.${stamp}.bak`)
}

let failed = 0
for (const item of pending) {
  try {
    backup(item.path)
    if (item.kind === 'file') {
      mkdirSync(dirname(item.path), { recursive: true })
      const tmp = `${item.path}.tmp`
      writeFileSync(tmp, item.merge.text, 'utf8')
      renameSync(tmp, item.path)
      console.log(`  wrote   ${item.path}`)
    } else if (item.kind === 'cli') {
      const exe = agyExe()
      if (!exe) throw new Error('agy is not on this machine')
      // With --home, the app-data pair moves too, so agy has nowhere real to write.
      const env = homeOverride
        ? {
            ...process.env,
            USERPROFILE: home,
            HOME: home,
            APPDATA: join(home, 'AppData', 'Roaming'),
            LOCALAPPDATA: join(home, 'AppData', 'Local')
          }
        : process.env
      const r = spawnSync(exe, item.args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, env })
      if (r.error || r.status !== 0) throw new Error(`agy exited ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || r.error}`)
      console.log(`  ran     agy ${item.args.join(' ')}`)
    }
  } catch (err) {
    failed += 1
    console.error(`  FAILED  ${item.cli} ${item.what}: ${err.message}`)
  }
}
const refused = plan.filter((i) => i.kind === 'file' && i.merge.action === 'refuse').length
console.log(`\n${pending.length - failed} change(s) applied${failed ? `, ${failed} failed` : ''}${refused ? `, ${refused} refused` : ''}.`)
process.exit(failed ? 1 : 0)

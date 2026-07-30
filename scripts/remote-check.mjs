/**
 * Head-less proof of M7 — Claude Remote Control.
 *
 * Bundles the *real* modules with esbuild and drives them the way Forge does:
 *
 *   1. naming + command composition        shared/remote.ts
 *   2. the presence marker's life          electron/presence.ts
 *   3. the bootstrap line a pane really    electron/pty/session-manager.ts,
 *      types into its shell                 with a `claude` shim on PATH that
 *                                           prints the argv it was handed
 *   4. the installed CLI accepts the flag  a real `claude --remote-control
 *                                           <name> --version` in a live pwsh
 *
 * What it cannot prove is the phone: whether the session actually shows up in
 * the Claude app needs Steve's account, his phone and his network. Step 4 is
 * the closest a script gets — the CLI parsing the flag and the name we compose.
 *
 *   npm run remote:check
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-remote-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const eq = (actual, expected, label) =>
  log(actual === expected, `${label}${actual === expected ? '' : `\n        got: ${actual}\n        want: ${expected}`}`)

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolvePromise()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function bundle(relSource, outName, external = []) {
  const outfile = join(scratch, outName)
  await build({
    entryPoints: [join(ROOT, relSource)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  return import(pathToFileURL(outfile).href)
}

/** ConPTY hard-wraps at the terminal width; join the screen back into one line. */
const flat = (s) => (s ?? '').replace(/\r?\n/g, '')

async function main() {
  const remote = await bundle('shared/remote.ts', 'remote.mjs')
  const presence = await bundle('electron/presence.ts', 'presence.mjs')
  const { PtySessionManager } = await bundle('electron/pty/session-manager.ts', 'session-manager.mjs', [
    '@lydell/node-pty'
  ])

  const { REMOTE_NAME_MAX, composeRemoteControl, findRemoteSessionUrl, remoteControlName } = remote

  /* ------------------------------------------------------------ 1. naming */

  eq(remoteControlName('Forge', 'Claude Code'), 'Forge — Claude Code', 'project and pane become one name')
  eq(remoteControlName('Forge', ''), 'Forge', 'an unnamed pane leaves just the project')
  eq(remoteControlName('', 'Claude Code'), 'Claude Code', 'a project-less pane leaves just the title')
  eq(remoteControlName('Forge', 'Forge'), 'Forge', 'identical halves are not doubled up')
  eq(remoteControlName('', ''), 'Forge', 'nothing at all still gets a name')
  eq(remoteControlName('  Cafe   Roma  ', '\tPOS\n'), 'Cafe Roma — POS', 'whitespace and control chars are tidied')
  log(
    remoteControlName('x'.repeat(200), 'y'.repeat(200)).length <= REMOTE_NAME_MAX,
    `a runaway name is capped at ${REMOTE_NAME_MAX} characters`
  )

  /* ------------------------------------------------------- 2. composition */

  const name = remoteControlName('Forge', 'Claude Code')
  eq(composeRemoteControl('claude', name), `claude --remote-control 'Forge — Claude Code'`, 'the plain Claude profile')
  eq(
    composeRemoteControl('claude --resume', name),
    `claude --resume --remote-control 'Forge — Claude Code'`,
    'a customised Claude command still gets the flag'
  )
  eq(composeRemoteControl('gemini', name), 'gemini', 'a profile pointed at another tool is left alone')
  eq(composeRemoteControl('kimi --yolo', name), 'kimi --yolo', 'so is a renamed profile command')
  eq(composeRemoteControl('claude --rc', name), 'claude --rc', 'a hand-written --rc is not doubled')
  eq(
    composeRemoteControl('claude --remote-control "Mine"', name),
    'claude --remote-control "Mine"',
    'a hand-written --remote-control is not doubled'
  )
  eq(composeRemoteControl('claude -p "hi"', name), 'claude -p "hi"', 'a one-shot --print run gets no session flag')
  eq(composeRemoteControl('', name), '', 'a plain shell is left alone')
  eq(
    composeRemoteControl('claude', "Steve's project — pane"),
    `claude --remote-control 'Steve''s project — pane'`,
    'an apostrophe is doubled for PowerShell'
  )
  eq(
    composeRemoteControl('C:\\tools\\claude.exe', name),
    `C:\\tools\\claude.exe --remote-control 'Forge — Claude Code'`,
    'an absolute path to claude.exe is recognised'
  )
  eq(
    composeRemoteControl('claude.cmd --resume', name),
    `claude.cmd --resume --remote-control 'Forge — Claude Code'`,
    "npm's .cmd shim is recognised as Claude too"
  )

  // The order pty-host.ts applies them in: Remote Control, then the bridge,
  // whose `--mcp-config <configs...>` is variadic and has to stay last.
  const composed = `${composeRemoteControl('claude', name)} --mcp-config "C:\\Forge\\bridge\\mcp.json"`
  eq(
    composed,
    `claude --remote-control 'Forge — Claude Code' --mcp-config "C:\\Forge\\bridge\\mcp.json"`,
    'both transforms compose, with --mcp-config last'
  )

  /* ------------------------------------------------- 2b. the session URL */

  // What Claude really prints in the pane once Remote Control connects,
  // captured verbatim from a live run (v2.1.220):
  const banner =
    '\x1b[2m/remote-control is active\x1b[0m · Continue here, on your phone, or at\r\n' +
    '\x1b[4mhttps://claude.ai/code/session_01DVNvj8NnRwAL2C38MWhGcj\x1b[0m\r\n'
  eq(
    findRemoteSessionUrl(banner),
    'https://claude.ai/code/session_01DVNvj8NnRwAL2C38MWhGcj',
    'the session URL is read straight out of the pane output'
  )
  eq(findRemoteSessionUrl('nothing to see here'), null, 'ordinary output yields no URL')
  eq(findRemoteSessionUrl('https://claude.ai/code'), null, 'the bare session list is not mistaken for a session')

  // PTY output arrives in arbitrary slices; the pane keeps a short tail so a
  // URL split across two chunks is still found (see TerminalHost.scanForRemoteUrl).
  const cut = banner.indexOf('session_') + 6
  eq(findRemoteSessionUrl(banner.slice(0, cut)), null, 'half a URL is not a URL')
  eq(
    findRemoteSessionUrl(banner.slice(0, cut).slice(-256) + banner.slice(cut)),
    'https://claude.ai/code/session_01DVNvj8NnRwAL2C38MWhGcj',
    'and the two halves rejoined across the scan overlap are'
  )

  /* ---------------------------------------------------------- 3. presence */

  const presenceDir = mkdtempSync(join(tmpdir(), 'forge-presence-'))
  const stale = join(presenceDir, 'presence')
  writeFileSync(stale, 'left over from a crash')

  const marker = presence.initPresence(presenceDir, 250)
  eq(marker, stale, 'the marker lands at <dataDir>/presence')
  log(!existsSync(marker), 'a marker left behind by a crash is cleared on init')

  presence.setPresence(true)
  log(existsSync(marker), 'focus creates the marker immediately')

  presence.setPresence(false)
  log(existsSync(marker), 'blur does not remove it straight away (alt-tab grace)')

  presence.setPresence(true)
  await sleep(400)
  log(existsSync(marker), 'refocusing inside the grace period cancels the removal')

  presence.setPresence(false)
  await sleep(400)
  log(!existsSync(marker), 'staying away past the grace period removes it')

  presence.setPresence(true)
  presence.disposePresence()
  log(!existsSync(marker), 'quitting removes the marker')

  /* ------------------------------------------ 4. the line a pane really types */

  // A `claude` that only reports its argv, first on the session's PATH. This is
  // the argv the real CLI would have received, quoting and all.
  const shimDir = mkdtempSync(join(tmpdir(), 'forge-claude-shim-'))
  writeFileSync(
    join(shimDir, 'claude.ps1'),
    'Write-Output ("CLAUDEARGV:" + (($args | ForEach-Object { "<$_>" }) -join " "))\n',
    'utf8'
  )
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'

  const cwd = mkdtempSync(join(tmpdir(), 'forge-remote-cwd-'))
  const out = new Map()
  const manager = new PtySessionManager({
    maxSessions: 4,
    env: { [pathKey]: `${shimDir};${process.env[pathKey] ?? ''}` },
    onData: (id, data) => out.set(id, (out.get(id) ?? '') + data),
    onExit: () => {}
  })

  const created = manager.create({ id: 'rc-1', cwd, cols: 400, rows: 30, bootstrapCommand: composed })
  log(created.ok === true, `spawned a Claude RC pane in ${cwd}`)
  if (!created.ok) throw new Error(created.error)

  await waitFor(() => flat(out.get('rc-1')).includes('CLAUDEARGV:'), 20000, 'the shim to report its argv')
  const argv = flat(out.get('rc-1'))
  const expectedArgv = `CLAUDEARGV:<--remote-control> <${name}> <--mcp-config> <C:\\Forge\\bridge\\mcp.json>`
  log(
    argv.includes(expectedArgv),
    argv.includes(expectedArgv)
      ? 'the pane typed the composed line, and Claude would receive the name as one argument'
      : `argv did not match\n        want: ${expectedArgv}`
  )

  /* ------------------------------------- 5. the installed CLI accepts it */

  // No shim this time: the real claude. It is asked to parse our composed flag
  // *alongside a deliberately invented one*, and then it exits on the parse
  // error without ever opening a session or touching the network.
  //
  // Why not `--version`: it short-circuits before commander validates options
  // (`claude --nonsense --version` cheerfully prints the version), so a version
  // banner proves nothing about the flag. Naming only the invented option does
  // — if `--remote-control` or its quoted value were wrong, commander would
  // have complained about that instead.
  const realOut = new Map()
  const real = new PtySessionManager({
    maxSessions: 3,
    onData: (id, data) => realOut.set(id, (realOut.get(id) ?? '') + data),
    onExit: () => {}
  })

  real.create({ id: 'cli-0', cwd, cols: 400, rows: 30, bootstrapCommand: 'claude --version' })
  await waitFor(() => /\d+\.\d+\.\d+ \(Claude Code\)/.test(flat(realOut.get('cli-0'))), 60000, 'the CLI version')
  const version = /\d+\.\d+\.\d+ \(Claude Code\)/.exec(flat(realOut.get('cli-0')))?.[0] ?? '?'

  real.create({
    id: 'cli-1',
    cwd,
    cols: 400,
    rows: 30,
    bootstrapCommand: `${composeRemoteControl('claude', name)} --forge-probe-unknown`
  })
  await waitFor(() => /unknown option/i.test(flat(realOut.get('cli-1'))), 60000, 'the real CLI to parse our flag')
  const cliText = flat(realOut.get('cli-1'))
  const blamedOurs = /unknown option '--(remote-control|rc)'/i.test(cliText)
  log(
    !blamedOurs && /unknown option '--forge-probe-unknown'/i.test(cliText),
    blamedOurs
      ? `installed CLI rejected our flag: ${cliText.slice(-160)}`
      : `${version} parsed \`--remote-control '${name}'\` and blamed only the invented flag`
  )

  real.create({
    id: 'cli-2',
    cwd,
    cols: 400,
    rows: 30,
    bootstrapCommand: 'claude --remote-control-that-does-not-exist'
  })
  await waitFor(
    () => /unknown option '--remote-control-that-does-not-exist'/i.test(flat(realOut.get('cli-2'))),
    60000,
    'the negative control'
  )
  log(true, 'negative control: a near-miss flag name IS rejected, so the acceptance above means something')

  manager.killAll()
  real.killAll()
  await sleep(300)

  rmSync(cwd, { recursive: true, force: true })
  rmSync(shimDir, { recursive: true, force: true })
  rmSync(presenceDir, { recursive: true, force: true })
}

main()
  .then(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nRemote Control check: OK' : `\nRemote Control check: ${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    rmSync(scratch, { recursive: true, force: true })
    console.error('\nRemote Control check crashed:', err)
    process.exit(1)
  })

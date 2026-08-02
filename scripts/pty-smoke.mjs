/**
 * Head-less proof that Forge's PTY layer works.
 *
 * Bundles the *real* electron/pty/session-manager.ts with esbuild (the copy
 * Vite already ships) and drives it exactly as electron/pty-host.ts does:
 * create a pwsh session in a project folder, let the bootstrap command type
 * itself, and assert the output comes back.
 *
 *   npm run pty:smoke
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'electron', 'pty', 'session-manager.ts')

// The bundle has to sit inside the project so Node can resolve the external
// native module (@lydell/node-pty) from node_modules.
const scratch = join(ROOT, 'node_modules', '.forge-smoke')
mkdirSync(scratch, { recursive: true })
const bundle = join(scratch, 'session-manager.mjs')

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

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

async function main() {
  /*
   * Pretend this runner was itself launched from inside a Claude Code session.
   * Forge often is — Steve starts it from a Claude pane — and a shell that
   * inherits these markers tells the next `claude` it is a child session, which
   * silently turns transcript saving off. Set before the manager is imported,
   * because buildEnv reads process.env at spawn time.
   */
  process.env.CLAUDE_CODE_CHILD_SESSION = '1'
  process.env.CLAUDECODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.FORGE_SMOKE_KEEPME = 'kept'
  await build({
    entryPoints: [SOURCE],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty'],
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { PtySessionManager, ENV_DENYLIST } = await import(pathToFileURL(bundle).href)

  /* ---------------------------------------------------- 1. plain session */

  const output = new Map()
  const exits = []
  const manager = new PtySessionManager({
    maxSessions: 3,
    onData: (id, data) => output.set(id, (output.get(id) ?? '') + data),
    onExit: (id, exitCode) => exits.push({ id, exitCode })
  })

  const created = manager.create({ id: 'smoke-1', cwd: ROOT, cols: 100, rows: 30 })
  log(created.ok === true, `spawned pwsh in ${ROOT}`)
  if (!created.ok) throw new Error(created.error)

  await waitFor(() => (output.get('smoke-1') ?? '').length > 0, 15000, 'first prompt')
  // ConPTY only reports the shell's pid once the console host has attached.
  log(manager.pidOf('smoke-1') > 0, `shell reported pid ${manager.pidOf('smoke-1')} once attached`)
  manager.write('smoke-1', 'echo forge-ok\r')
  await waitFor(() => (output.get('smoke-1') ?? '').includes('forge-ok'), 15000, 'echo output')
  log(true, 'wrote `echo forge-ok` and read `forge-ok` back')

  const resized = manager.resize('smoke-1', 120, 40)
  log(resized === true, 'resized session to 120x40')

  /* ------------------------------------------- 2. bootstrapped session */

  // Proves the agent-profile mechanism: the command is TYPED into a fresh
  // shell (rather than spawned), so the prompt survives when it exits.
  const marker = 'forge-bootstrap-marker'
  const boot = manager.create({
    id: 'smoke-2',
    cwd: ROOT,
    cols: 100,
    rows: 30,
    bootstrapCommand: `echo ${marker}`
  })
  log(boot.ok === true, 'spawned a session with a bootstrap command')
  await waitFor(() => (output.get('smoke-2') ?? '').includes(marker), 15000, 'bootstrap output')
  log(true, 'bootstrap command typed itself and produced output')

  /* ------------------------------- 2a. the agent that is not installed */

  // What a pane does when the CLI its profile launches is not on the machine
  // (electron/pty-host.ts decides that; this is the half that carries it out).
  // The notice must be *painted* and the command must never be typed — typing
  // it is what produced the red "not recognized" splat that made a missing
  // Codex look like a broken Forge.
  const noticeText = '\r\n  codex is not installed on this machine.\r\n'
  const quiet = manager.create({
    id: 'smoke-notice',
    cwd: ROOT,
    cols: 100,
    rows: 30,
    bootstrapCommand: `echo forge-should-never-run`,
    bootstrapNotice: noticeText
  })
  log(quiet.ok === true, 'spawned a session with a notice instead of a command')
  await waitFor(() => (output.get('smoke-notice') ?? '').includes('not installed'), 15000, 'the notice')
  log(true, 'the notice reached the pane')
  // The empty line the notice sends brings a prompt back, so give the shell a
  // moment to prove it typed nothing of its own.
  await new Promise((r) => setTimeout(r, 600))
  log(
    !(output.get('smoke-notice') ?? '').includes('forge-should-never-run'),
    'the bootstrap command was never typed into the shell'
  )
  manager.write('smoke-notice', 'echo still-alive\r')
  await waitFor(() => (output.get('smoke-notice') ?? '').includes('still-alive'), 15000, 'shell still usable')
  log(true, 'the shell underneath is live and usable')
  manager.kill('smoke-notice')

  /* --------------------------------------- 2b. inherited Claude markers */

  // A pane is a new top-level shell, not a continuation of whatever launched
  // Forge, so the session markers must not survive into it — while ordinary
  // environment the user set stays exactly where it was.
  manager.create({ id: 'smoke-env', cwd: ROOT, cols: 100, rows: 30 })
  await waitFor(() => (output.get('smoke-env') ?? '').length > 0, 15000, 'env prompt')
  manager.write(
    'smoke-env',
    'Write-Host "child=<$env:CLAUDE_CODE_CHILD_SESSION> cc=<$env:CLAUDECODE> entry=<$env:CLAUDE_CODE_ENTRYPOINT> keep=<$env:FORGE_SMOKE_KEEPME>"\r'
  )
  // The echoed command line comes back first and carries the variable *names*;
  // only the expanded readout has the keep marker in it, so wait for that.
  await waitFor(() => /keep=<kept>/.test(output.get('smoke-env') ?? ''), 15000, 'env readout').catch((e) => {
    console.log('---RAW---')
    console.log(JSON.stringify(output.get('smoke-env') ?? ''))
    throw e
  })
  const readout = (output.get('smoke-env') ?? '').split(/\r?\n/).find((l) => /keep=<kept>/.test(l)) ?? ''
  log(/child=<>/.test(readout), 'CLAUDE_CODE_CHILD_SESSION is not inherited by a pane')
  log(/cc=<>/.test(readout), 'CLAUDECODE is not inherited by a pane')
  log(/entry=<>/.test(readout), 'CLAUDE_CODE_ENTRYPOINT is not inherited by a pane')
  log(/keep=<kept>/.test(readout), 'unrelated environment is left alone')

  // Hand the slot back, so the session-cap test below still measures the cap.
  manager.kill('smoke-env')

  /* ------------------------------------------------- 3. cwd is honoured */

  const probeDir = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
  writeFileSync(join(probeDir, 'forge-cwd-probe.txt'), 'x')
  manager.create({ id: 'smoke-3', cwd: probeDir, cols: 100, rows: 30 })
  await waitFor(() => (output.get('smoke-3') ?? '').length > 0, 15000, 'third prompt')
  manager.write('smoke-3', 'Get-ChildItem -Name\r')
  await waitFor(() => (output.get('smoke-3') ?? '').includes('forge-cwd-probe.txt'), 15000, 'cwd listing')
  log(true, 'session cwd is the project folder')

  /* -------------------------------------------- 4. the environment audit */

  // Remote Control dies quietly if any of these reach the pane, and Steve has
  // several of them set globally. Prove buildEnv strips them even when the
  // parent process is carrying them, and that a caller-supplied variable
  // (CLAUDE_CLIENT_PRESENCE_FILE) survives.
  //
  // A second manager, because these have to be set before the shell is spawned
  // and the first three sessions are already running.
  const presencePath = join(probeDir, 'presence')
  for (const name of ENV_DENYLIST) process.env[name] = `forge-should-strip-${name}`

  const envOut = new Map()
  const envManager = new PtySessionManager({
    maxSessions: 2,
    env: { CLAUDE_CLIENT_PRESENCE_FILE: presencePath },
    onData: (id, data) => envOut.set(id, (envOut.get(id) ?? '') + data),
    onExit: () => {}
  })
  envManager.create({ id: 'env-1', cwd: ROOT, cols: 200, rows: 30 })
  await waitFor(() => (envOut.get('env-1') ?? '').length > 0, 15000, 'env prompt')

  // One line per denied name, printed as `NAME=<value or empty>`; `Get-Item
  // env:X` throws when unset, so read the provider dictionary directly.
  const names = [...ENV_DENYLIST, 'CLAUDE_CLIENT_PRESENCE_FILE'].join(',')
  //
  // Two defences against reading the *echo* of the command rather than its
  // output — PSReadLine both echoes what is typed and offers the previous run's
  // identical line as an inline suggestion, so a naive marker is on screen
  // before PowerShell has run anything:
  //   - a per-run nonce, which no history entry can contain, and
  //   - an end marker spelled as a concatenation, so even this run's echo of
  //     the command does not contain the finished token.
  const nonce = Math.random().toString(36).slice(2, 10)
  const tag = `ENVPROBE-${nonce}`
  const probe =
    `foreach ($n in "${names}".Split(",")) ` +
    `{ "${tag}:$n=[" + [Environment]::GetEnvironmentVariable($n) + "]" }; "${tag}" + "-DONE"`
  envManager.write('env-1', `${probe}\r`)
  await waitFor(() => (envOut.get('env-1') ?? '').includes(`${tag}-DONE`), 15000, 'env probe')

  // ConPTY hard-wraps at the terminal width, so strip the wrapping before
  // matching — a long path would otherwise arrive with a newline through it.
  const envText = (envOut.get('env-1') ?? '').replace(/\r?\n/g, '')
  const leaked = ENV_DENYLIST.filter((name) => !envText.includes(`${tag}:${name}=[]`))
  log(
    leaked.length === 0,
    leaked.length === 0
      ? `all ${ENV_DENYLIST.length} denied variables absent from the pane (telemetry, auth and session markers)`
      : `denied variables leaked into the pane: ${leaked.join(', ')}`
  )
  log(
    envText.includes(`${tag}:CLAUDE_CLIENT_PRESENCE_FILE=[${presencePath}]`),
    'CLAUDE_CLIENT_PRESENCE_FILE points at the presence marker'
  )

  envManager.killAll()
  for (const name of ENV_DENYLIST) delete process.env[name]

  /* ------------------------------------------------------- 5. the caps */

  const overflow = manager.create({ id: 'smoke-4', cwd: ROOT, cols: 80, rows: 24 })
  log(overflow.ok === false, `session cap enforced (${overflow.error ?? 'no error?'})`)

  const missing = manager.create({ id: 'smoke-5', cwd: join(ROOT, 'definitely-not-here'), cols: 80, rows: 24 })
  log(missing.ok === false, 'missing cwd rejected cleanly')

  /* ------------------------------------------------------- 6. teardown */

  log(manager.count === 3, `manager reports ${manager.count} live sessions`)
  manager.killAll()
  await waitFor(() => exits.length >= 3, 10000, 'exit events')
  log(true, `killAll() emitted ${exits.length} exit events and drained the map`)
  log(manager.count === 0, 'no sessions left behind')

  rmSync(probeDir, { recursive: true, force: true })
}

main()
  .then(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nPTY smoke test: OK' : `\nPTY smoke test: ${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    rmSync(scratch, { recursive: true, force: true })
    console.error('\nPTY smoke test crashed:', err)
    process.exit(1)
  })

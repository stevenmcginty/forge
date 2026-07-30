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

  const { PtySessionManager } = await import(pathToFileURL(bundle).href)

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

  /* ------------------------------------------------- 3. cwd is honoured */

  const probeDir = mkdtempSync(join(tmpdir(), 'forge-cwd-'))
  writeFileSync(join(probeDir, 'forge-cwd-probe.txt'), 'x')
  manager.create({ id: 'smoke-3', cwd: probeDir, cols: 100, rows: 30 })
  await waitFor(() => (output.get('smoke-3') ?? '').length > 0, 15000, 'third prompt')
  manager.write('smoke-3', 'Get-ChildItem -Name\r')
  await waitFor(() => (output.get('smoke-3') ?? '').includes('forge-cwd-probe.txt'), 15000, 'cwd listing')
  log(true, 'session cwd is the project folder')

  /* ------------------------------------------------------- 4. the caps */

  const overflow = manager.create({ id: 'smoke-4', cwd: ROOT, cols: 80, rows: 24 })
  log(overflow.ok === false, `session cap enforced (${overflow.error ?? 'no error?'})`)

  const missing = manager.create({ id: 'smoke-5', cwd: join(ROOT, 'definitely-not-here'), cols: 80, rows: 24 })
  log(missing.ok === false, 'missing cwd rejected cleanly')

  /* ------------------------------------------------------- 5. teardown */

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

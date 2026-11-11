/**
 * Forge Bubble's link module, tested against the real Forge Web server.
 *
 *   node scripts/bubble-link-check.mjs
 *
 * Starts scripts/bubble-dev-server.mjs twice — first with no PIN, then with
 * `--pin 1234 --confirm` — and each time runs the link module's Gradle tests
 * (bubble/link) with FORGE_DEV_WS / FORGE_DEV_TOKEN / FORGE_DEV_CONTROL (and
 * FORGE_DEV_PIN the second time) set, so the integration tests in
 * DevServerTest run against it; the unit tests run both times. Each run must
 * also have *executed* the integration tests meant for it — a run where they
 * all skipped (an env var lost on the way) is a failure, not a pass.
 *
 * Prints one summary line; exits non-zero on any failure. Gradle's output goes
 * to bubble/link/build/bubble-link-check-<run>.log.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LINK = join(ROOT, 'bubble', 'link')
const RESULTS = join(LINK, 'build', 'test-results', 'test')
const GRADLEW = join(ROOT, 'hands', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const PORT = 8493
const PIN = '1234'

/** `devTests`: how many DevServerTest methods must run against that server; the rest of the class skips. */
const RUNS = [
  { name: 'no-pin', flags: [], pin: '', devTests: 4 },
  { name: 'pin', flags: ['--pin', PIN, '--confirm'], pin: PIN, devTests: 2 }
]

function startServer(flags) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'bubble-dev-server.mjs'), '--port', String(PORT), ...flags], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const seen = {}
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`dev server did not start in 60 s\n${err}`))
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      for (const line of out.split(/\r?\n/)) {
        const m = /^(READY|TOKEN|CONTROL) (\S+)$/.exec(line.trim())
        if (m) seen[m[1]] = m[2]
      }
      if (seen.READY && seen.TOKEN && seen.CONTROL) {
        clearTimeout(timer)
        resolvePromise({ child, ws: seen.READY, token: seen.TOKEN, control: seen.CONTROL })
      }
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dev server exited (${code}) before READY\n${err}`))
    })
  })
}

function stopServer(server) {
  return new Promise((r) => {
    if (server.child.exitCode !== null) return r()
    server.child.once('exit', () => r())
    server.child.kill()
  })
}

function gradleTest(env, logFile) {
  return new Promise((resolvePromise) => {
    // One command string: a .bat needs a shell, and Node warns about args beside shell: true.
    const child = spawn(`"${GRADLEW}" -p "${LINK}" test --console=plain`, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (c) => (log += c))
    child.stderr.on('data', (c) => (log += c))
    child.on('exit', (code) => {
      writeFileSync(logFile, log)
      resolvePromise(code ?? 1)
    })
  })
}

/** Totals from the JUnit XML Gradle writes, overall and for DevServerTest. */
function readResults() {
  const totals = { tests: 0, skipped: 0, failed: 0, devRan: 0, failures: [] }
  let files = []
  try {
    files = readdirSync(RESULTS).filter((f) => f.endsWith('.xml'))
  } catch {
    return totals
  }
  for (const file of files) {
    const xml = readFileSync(join(RESULTS, file), 'utf8')
    const suite = /<testsuite name="([^"]+)" tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(xml)
    if (!suite) continue
    const [, name, tests, skipped, failures, errors] = suite
    totals.tests += Number(tests)
    totals.skipped += Number(skipped)
    totals.failed += Number(failures) + Number(errors)
    if (name.endsWith('.DevServerTest')) totals.devRan += Number(tests) - Number(skipped)
    for (const m of xml.matchAll(/<testcase name="([^"]+)" classname="([^"]+)"[^>]*>\s*<failure message="([^"]*)"/g)) {
      totals.failures.push(`${m[2].split('.').pop()}.${m[1]}: ${m[3].slice(0, 200)}`)
    }
  }
  return totals
}

async function main() {
  mkdirSync(join(LINK, 'build'), { recursive: true })
  const lines = []
  let failed = 0
  for (const run of RUNS) {
    let server = null
    try {
      server = await startServer(run.flags)
      rmSync(RESULTS, { recursive: true, force: true })
      const logFile = join(LINK, 'build', `bubble-link-check-${run.name}.log`)
      const code = await gradleTest(
        {
          FORGE_DEV_WS: server.ws,
          FORGE_DEV_TOKEN: server.token,
          FORGE_DEV_CONTROL: server.control,
          FORGE_DEV_PIN: run.pin
        },
        logFile
      )
      const r = readResults()
      // Kept per run, so the first run's report is not overwritten by the second.
      rmSync(`${RESULTS}-${run.name}`, { recursive: true, force: true })
      if (existsSync(RESULTS)) cpSync(RESULTS, `${RESULTS}-${run.name}`, { recursive: true })
      let runFailed = r.failed
      if (r.tests === 0) {
        runFailed++
        console.log(`FAIL  ${run.name}: Gradle ran no tests (exit ${code}); see ${logFile}`)
      } else if (code !== 0 && r.failed === 0) {
        runFailed++
        console.log(`FAIL  ${run.name}: Gradle exited ${code}; see ${logFile}`)
      }
      if (r.devRan !== run.devTests) {
        runFailed++
        console.log(`FAIL  ${run.name}: ${r.devRan} dev-server tests ran, expected ${run.devTests}`)
      }
      for (const f of r.failures) console.log(`FAIL  ${run.name}: ${f}`)
      failed += runFailed
      lines.push(`${run.name} ${r.tests} tests (${r.devRan} on the dev server, ${r.skipped} skipped)`)
    } catch (err) {
      failed++
      console.log(`FAIL  ${run.name}: ${err.message}`)
      lines.push(`${run.name} did not run`)
    } finally {
      if (server) await stopServer(server)
    }
  }
  console.log(`bubble-link-check: ${lines.join('; ')} - ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

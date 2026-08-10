/**
 * web-rendezvous — Forge Web's rendezvous service, end to end, against the real
 * Firebase emulator suite.
 *
 *   npm run web:rendezvous
 *
 * There is no mock Firebase here and no mock rendezvous. The suite spawns
 * `firebase emulators:exec`, which brings up the genuine Auth and Realtime
 * Database emulators, then re-runs this file inside them; the check esbuild
 * bundles the *real* electron/web/rendezvous.ts and the *real*
 * electron/companion/rest.ts and drives them exactly as electron/web-host.ts
 * will — over real HTTP, against a real database, with real security rules.
 * The same bar scripts/companion-smoke.mjs and scripts/mobile-smoke.mjs hold.
 *
 * What *is* injected is time. The clock and the timer are constructor-injected
 * into `WebRendezvous`, so a heartbeat, a three-minute staleness window and an
 * exponential backoff can each be observed in milliseconds instead of minutes.
 * That is the point of the injection, not a shortcut around it: every write the
 * virtual clock provokes is still a real one.
 *
 * What is proven, in order:
 *   0.  off by default — no write, no timer, no credential read
 *   1.  the committed security rules do NOT yet admit users/<uid>/host  (see below)
 *   2.  a hostname normaliseHost rejects is never published
 *   3.  switching on publishes a record parseHostRecord accepts and isHostLive calls live
 *   4.  a heartbeat refreshes `at` and changes nothing else
 *   5.  a changed tunnel hostname republishes
 *   6.  shutdown clears the record, and afterwards isHostLive is false
 *   7.  a record left behind goes not-live once HOST_STALE_MS has passed
 *   8.  an OfflineError is retried with backoff — not abandoned, not hammered
 *   9.  a hostname change that lands mid-write is deferred, not swallowed
 *
 * ## About check 1, and why this file installs a second ruleset
 *
 * companion/database.rules.json ends every user subtree with
 * `"$other": { ".validate": false }`, and it has no `host` entry — so as
 * committed, the rules *refuse* the one write this whole feature depends on.
 * That is a real gap in the deploy, not a quirk of the test, which is why check
 * 1 asserts the refusal against the committed rules rather than papering over
 * it. Checks 2 onwards then install the committed rules *plus* the `host` block
 * the feature needs (`PROPOSED_HOST_RULES` below, via the Database emulator's
 * runtime `/.settings/rules.json` endpoint) so the service's behaviour can be
 * exercised at all. That block still has to be added to
 * companion/database.rules.json and deployed before Forge Web can work against
 * the real project; this file prints a NOTE saying so at the end.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'companion', 'firebase.json')
const PROJECT_ID = 'demo-forge-sync'
const NAMESPACE = `${PROJECT_ID}-default-rtdb`

/* Emulator endpoints, matching companion/firebase.json's `emulators` block. */
const AUTH_BASE = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
const TOKEN_BASE = 'http://127.0.0.1:9099/securetoken.googleapis.com/v1'
const DB_ORIGIN = 'http://127.0.0.1:9000'
const DB_URL = `${DB_ORIGIN}?ns=${NAMESPACE}`
/** The emulator ignores the key entirely; it only has to be non-empty. */
const API_KEY = 'demo-forge-sync-key'

/**
 * Matches MIN_REPUBLISH_MS in electron/web/rendezvous.ts.
 *
 * Declared up here rather than beside the other plumbing at the foot of the
 * file, for the reason scripts/companion-smoke.mjs gives about its `tokenCache`:
 * `main()` runs from a top-level await further down, so a `const` below that
 * line is still in its temporal dead zone when `main()` reaches for it.
 */
const MIN_REPUBLISH_WAIT = 5_000

/**
 * The block companion/database.rules.json is missing.
 *
 * Shaped like the neighbouring `presence` block: `hasChildren` on the fields the
 * browser cannot do without, a type and a length on each field, and `$other`
 * closed so a future field cannot be smuggled in past review. The lengths match
 * what `parseHostRecord` clamps to on the way back in, so a record that survives
 * the rules is a record the browser will render whole.
 *
 * `hasChildren` holds on the heartbeat too: RTDB validates the *post-write*
 * state, so a PATCH of `{ at }` alone is judged against the merged record.
 */
const PROPOSED_HOST_RULES = {
  '.validate': "newData.hasChildren(['host', 'proto', 'at'])",
  host: { '.validate': 'newData.isString() && newData.val().length <= 255' },
  proto: { '.validate': 'newData.isNumber()' },
  app: { '.validate': 'newData.isString() && newData.val().length <= 24' },
  name: { '.validate': 'newData.isString() && newData.val().length <= 64' },
  at: { '.validate': 'newData.isNumber()' },
  $other: { '.validate': false }
}

/* --------------------------------------------------------------- reporting */

let failures = 0
let checks = 0
const log = (ok, message) => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** Assert-shaped wrapper so one bad expectation does not abort the whole run. */
function check(message, fn) {
  try {
    fn()
    log(true, message)
  } catch (err) {
    log(false, `${message}\n        ${err?.message ?? err}`)
  }
}

/* ------------------------------------------------- outer: start emulators */

if (!process.env.FORGE_WEB_RENDEZVOUS_EMULATED) {
  const cli = join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js')
  if (!existsSync(cli)) {
    console.error(
      `\n[web-rendezvous] firebase-tools is not installed in this worktree.\n` + `  npm i -D firebase-tools\n`
    )
    process.exit(1)
  }

  // Spawn the CLI's own entry point with this Node rather than the `.cmd` shim,
  // for the reason spelled out in scripts/companion-smoke.mjs: a shim needs
  // `shell: true` on Windows, and a shell re-splits the `emulators:exec`
  // command argument on its spaces.
  const args = [
    cli,
    'emulators:exec',
    '--only',
    'auth,database',
    '--project',
    PROJECT_ID,
    '--config',
    CONFIG,
    `"${process.execPath}" "${join(ROOT, 'scripts', 'web-rendezvous-check.mjs')}"`
  ]
  console.log(`[web-rendezvous] starting the Firebase emulator suite…\n`)
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORGE_WEB_RENDEZVOUS_EMULATED: '1' }
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    console.error(`\n[web-rendezvous] could not run the Firebase CLI: ${err.message}\n`)
    process.exit(1)
  })
} else {
  await main()
}

/* ---------------------------------------------------- inner: the real test */

async function main() {
  const scratch = join(ROOT, 'node_modules', '.forge-web-rendezvous-check')
  mkdirSync(scratch, { recursive: true })

  // The real modules, bundled — not copies, not mocks. One entry, so the
  // service and the client it branches on share one copy of OfflineError.
  const bundle = join(scratch, 'rendezvous.mjs')
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'web-rendezvous-entry.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    alias: { '@shared': join(ROOT, 'shared') },
    absWorkingDir: ROOT
  })

  const {
    WebRendezvous,
    FirebaseRest,
    OfflineError,
    HOST_HEARTBEAT_MS,
    HOST_STALE_MS,
    isHostLive,
    parseHostRecord,
    WEB_PROTO,
    webHostPath
  } = await import(pathToFileURL(bundle).href)

  /* ------------------------------------------------------- a real session */

  const email = `steve+web-${Date.now()}@example.com`
  const password = 'forge-web-rendezvous-test'
  const rest = new FirebaseRest({
    apiKey: API_KEY,
    databaseURL: DB_URL,
    authBase: AUTH_BASE,
    tokenBase: TOKEN_BASE
  })
  await rest.signIn(email, password)
  const uid = rest.uid
  const PATH = webHostPath(uid)
  assert.equal(PATH, `users/${uid}/host`, 'webHostPath must own the path')

  /** Read the published record straight out of the database, as the browser does. */
  const readHost = async () => (await rawGet(PATH, await rest.token())).json

  /* -------------------------------------------------- the injected clock */

  const clock = {
    now: 1_700_000_000_000,
    seq: 0,
    timers: new Map(),
    created: 0,
    delays: []
  }
  const setTimer = (fn, ms) => {
    const id = ++clock.seq
    clock.created += 1
    clock.delays.push(ms)
    clock.timers.set(id, { fn, at: clock.now + ms })
    return id
  }
  const clearTimer = (id) => clock.timers.delete(id)

  /** Fire every timer already due, oldest first, letting each one's work finish. */
  async function fireDue() {
    for (let guard = 0; guard < 64; guard += 1) {
      const due = [...clock.timers.entries()].filter(([, t]) => t.at <= clock.now).sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) return
      const [id, timer] = due[0]
      clock.timers.delete(id)
      timer.fn()
      await settle()
    }
    throw new Error('timer storm — a tick rescheduled itself with no delay')
  }

  /** Move the virtual clock forward and run whatever that made due. */
  async function advance(ms) {
    clock.now += ms
    await fireDue()
  }

  /** Move the clock without running anything — the process is dead, not idle. */
  const skip = (ms) => {
    clock.now += ms
  }

  /* ------------------------------------------------------------- the host */

  const settings = { enabled: false, hostname: '', client: rest }
  const spy = { rest: 0, hostname: 0 }

  const host = {
    isEnabled: () => settings.enabled,
    rest: () => {
      spy.rest += 1
      return settings.client
    },
    hostname: () => {
      spy.hostname += 1
      return settings.hostname
    },
    appVersion: () => '0.3.25',
    computerName: () => 'STEVE-PC',
    now: () => clock.now,
    setTimer,
    clearTimer,
    // Surfaced, not swallowed: when this suite fails it is nearly always the
    // service quietly catching something.
    log: (line, ...more) => console.log(`      [service] ${line}`, ...more)
  }

  /* --------------------------------------------------- 0. off by default */

  const idle = new WebRendezvous(host)
  idle.start()
  await settle()
  const idleRecord = await readHost()
  check('off by default: no timer, no credential read, nothing published', () => {
    assert.equal(clock.created, 0, 'a disabled Forge must not arm a timer')
    assert.equal(spy.rest, 0, 'a disabled Forge must not reach for a Firebase client')
    assert.equal(spy.hostname, 0, 'a disabled Forge must not even look at the tunnel')
    assert.equal(idleRecord, null, 'nothing may be published while the feature is off')
    assert.equal(idle.getState().enabled, false)
  })
  await idle.shutdown()
  check('shutdown while disabled stays silent', () => {
    assert.equal(spy.rest, 0, 'shutdown must not read a credential it never used')
  })

  /* ------------------------------- 1. the committed rules refuse the write */

  settings.enabled = true
  settings.hostname = 'forge-alpha.trycloudflare.com'
  const refused = new WebRendezvous(host)
  refused.start()
  await settle()
  const afterRefusal = await readHost()
  check('the committed database.rules.json refuses users/<uid>/host', () => {
    assert.equal(afterRefusal, null, 'the rules as committed should not have admitted this record')
    assert.match(refused.getState().detail, /revoked|denied|401|403/i, `got detail: ${refused.getState().detail}`)
  })
  await refused.shutdown()

  // Install the committed rules *plus* the block this feature needs, so the
  // remaining checks can exercise behaviour rather than re-proving the gap.
  await installRules(withHostRules(readCommittedRules()))
  clock.created = 0
  clock.delays.length = 0

  /* ------------------------------- 2. a rejected hostname is never published */

  settings.hostname = 'localhost'
  const bad = new WebRendezvous(host)
  bad.start()
  await settle()
  const afterBad = await readHost()
  check('a hostname normaliseHost rejects is never published', () => {
    assert.equal(afterBad, null, '`localhost` has no dot — normaliseHost rejects it')
    assert.equal(bad.getState().published, '', 'nothing should be recorded as published')
  })
  bad.stop()
  // A tick that found no usable hostname still arms the next look, which is
  // correct behaviour and would otherwise be counted against the publish below.
  check('a rejected hostname leaves no timer behind once stopped', () => {
    assert.equal(clock.timers.size, 0)
  })
  clock.created = 0
  clock.delays.length = 0

  /* ---------------------------------------------------- 3. publish on start */

  settings.hostname = 'forge-alpha.trycloudflare.com'
  const rv = new WebRendezvous(host)
  rv.start()
  await waitFor(async () => (await readHost()) !== null, 'the rendezvous record to be published')
  const published = await readHost()
  const parsed = parseHostRecord(published)
  check('switching on publishes a record parseHostRecord accepts and isHostLive calls live', () => {
    assert.ok(parsed, `parseHostRecord refused ${JSON.stringify(published)}`)
    assert.equal(parsed.host, 'forge-alpha.trycloudflare.com')
    assert.equal(parsed.proto, WEB_PROTO)
    assert.equal(parsed.app, '0.3.25')
    assert.equal(parsed.name, 'STEVE-PC')
    assert.equal(parsed.at, clock.now)
    assert.equal(isHostLive(parsed, clock.now), true, 'a record just written must read as live')
  })
  check('the record carries nothing but host, proto, app, name and at', () => {
    assert.deepEqual(Object.keys(published).sort(), ['app', 'at', 'host', 'name', 'proto'])
  })
  check('publishing arms exactly one timer, at the heartbeat interval', () => {
    assert.deepEqual(clock.delays, [HOST_HEARTBEAT_MS])
    assert.equal(clock.timers.size, 1, 'exactly one timer may ever be pending')
  })

  /* ------------------------------------------------------- 4. the heartbeat */

  const beforeBeat = await readHost()
  await advance(HOST_HEARTBEAT_MS)
  await waitFor(async () => (await readHost())?.at !== beforeBeat.at, 'the heartbeat to refresh `at`')
  const afterBeat = await readHost()
  check('a heartbeat refreshes `at` and changes nothing else', () => {
    assert.equal(afterBeat.at, clock.now, '`at` should be the current clock')
    assert.ok(afterBeat.at > beforeBeat.at, '`at` must move forward')
    const { at: _skipA, ...restBefore } = beforeBeat
    const { at: _skipB, ...restAfter } = afterBeat
    assert.deepEqual(restAfter, restBefore, 'a heartbeat must not restate host, proto, app or name')
  })
  check('the heartbeat reschedules itself once, at the heartbeat interval', () => {
    assert.deepEqual(clock.delays, [HOST_HEARTBEAT_MS, HOST_HEARTBEAT_MS])
    assert.equal(clock.timers.size, 1)
  })

  /* ------------------------------------------- 5. a changed hostname republishes */

  settings.hostname = 'forge-beta.trycloudflare.com'
  rv.refresh()
  await advance(MIN_REPUBLISH_WAIT)
  await waitFor(async () => (await readHost())?.host === 'forge-beta.trycloudflare.com', 'the republish')
  const republished = await readHost()
  check('a changed tunnel hostname republishes the record', () => {
    assert.equal(republished.host, 'forge-beta.trycloudflare.com')
    assert.equal(republished.proto, WEB_PROTO)
    assert.equal(isHostLive(parseHostRecord(republished), clock.now), true)
    assert.equal(rv.getState().published, 'forge-beta.trycloudflare.com')
  })

  /* -------------------------------------------------- 6. shutdown clears it */

  await rv.shutdown()
  const afterShutdown = await readHost()
  check('shutdown clears the record, and afterwards isHostLive is false', () => {
    assert.equal(afterShutdown, null, 'the record must be gone, not merely stale')
    assert.equal(isHostLive(parseHostRecord(afterShutdown), clock.now), false)
    assert.equal(rv.getState().published, '')
  })
  check('shutdown cancels the heartbeat', () => {
    assert.equal(clock.timers.size, 0, 'no timer may outlive shutdown')
  })

  /* ------------------------------------ 7. a record left behind goes stale */

  settings.hostname = 'forge-gamma.trycloudflare.com'
  const abandoned = new WebRendezvous(host)
  abandoned.start()
  await waitFor(async () => (await readHost()) !== null, 'the record to be republished')
  const liveRecord = await readHost()
  // The power cut: the heartbeat simply stops. Nothing is cleared, because
  // nothing got the chance — that is the whole case HOST_STALE_MS exists for,
  // and the case RTDB's onDisconnect would have covered if this client had one.
  abandoned.stop()
  skip(HOST_STALE_MS + 1)
  const leftBehind = await readHost()
  check('a record left behind reads as not-live once HOST_STALE_MS has passed', () => {
    assert.equal(isHostLive(parseHostRecord(liveRecord), liveRecord.at), true, 'it was live when written')
    assert.deepEqual(leftBehind, liveRecord, 'nothing cleared it — it is still there, unchanged')
    assert.equal(isHostLive(parseHostRecord(leftBehind), clock.now), false, 'but the browser must not dial it')
  })
  await abandoned.shutdown()
  check('the abandoned record is retracted once the desktop can say so', () => {
    assert.equal(abandoned.getState().published, '')
  })

  /* ------------------------------------------ 8. OfflineError backs off */

  // A client that is offline for three attempts and then is not. Real
  // `OfflineError`, from the same bundle the service branches on.
  const flaky = { attempts: 0, failFor: 3, uid, last: null }
  flaky.put = async (path, value) => {
    flaky.attempts += 1
    if (flaky.attempts <= flaky.failFor) throw new OfflineError(new Error('getaddrinfo ENOTFOUND'))
    flaky.last = { path, value }
    return value
  }
  flaky.patch = async () => {
    throw new Error('the offline check should never reach a heartbeat')
  }
  flaky.remove = async () => {}

  settings.client = flaky
  settings.hostname = 'forge-delta.trycloudflare.com'
  clock.delays.length = 0

  const offline = new WebRendezvous(host)
  offline.start()
  await settle()
  const firstDelays = [...clock.delays]

  // Walk the backoff out. Each advance runs exactly the retry that was due.
  await advance(clock.delays[clock.delays.length - 1])
  await advance(clock.delays[clock.delays.length - 1])
  const retryDelays = [...clock.delays]
  await advance(clock.delays[clock.delays.length - 1])

  check('a write that fails with OfflineError is retried rather than abandoned', () => {
    assert.equal(flaky.attempts, 4, `expected 3 failures then a success, got ${flaky.attempts} attempts`)
    assert.ok(flaky.last, 'the retry that succeeded must actually have written')
    assert.equal(flaky.last.path, PATH)
    assert.equal(flaky.last.value.host, 'forge-delta.trycloudflare.com')
    assert.equal(offline.getState().published, 'forge-delta.trycloudflare.com')
  })
  check('the retries back off exponentially rather than hammering', () => {
    assert.deepEqual(firstDelays, [2_000], `first retry should be 2s, got ${JSON.stringify(firstDelays)}`)
    assert.deepEqual(retryDelays, [2_000, 4_000, 8_000], `expected a doubling ladder, got ${JSON.stringify(retryDelays)}`)
    assert.ok(
      retryDelays.every((d) => d >= 2_000),
      'no retry may be sooner than the base delay — that is the write-per-second bug'
    )
  })
  check('a recovered write returns to the plain heartbeat cadence', () => {
    assert.equal(clock.delays[clock.delays.length - 1], HOST_HEARTBEAT_MS)
    assert.equal(clock.timers.size, 1, 'still exactly one timer pending')
  })
  offline.stop()

  /* ------------------------- 9. a refresh that lands mid-write is honoured */

  // The narrow window `refreshWanted` exists for: cloudflared reconnects on a
  // new address while a write is still in flight. A client that parks its first
  // write until we release it is the only way to stand inside that window.
  let release = () => {}
  const gate = {
    uid,
    writes: [],
    put: async (_path, value) => {
      gate.writes.push(value.host)
      if (gate.writes.length === 1) await new Promise((r) => (release = r))
      return value
    },
    patch: async () => {
      throw new Error('the mid-write check should never reach a heartbeat')
    },
    remove: async () => {}
  }

  settings.client = gate
  settings.hostname = 'forge-one.trycloudflare.com'
  clock.delays.length = 0

  const midwrite = new WebRendezvous(host)
  midwrite.start()
  await settle()
  const parked = [...gate.writes]

  // The tunnel moves while that first write is still parked.
  settings.hostname = 'forge-two.trycloudflare.com'
  midwrite.refresh()
  release()
  await settle()
  const deferred = [...clock.delays]
  await advance(MIN_REPUBLISH_WAIT)

  check('a refresh that arrives mid-write is deferred, not swallowed', () => {
    assert.deepEqual(parked, ['forge-one.trycloudflare.com'], 'the first write should have been in flight')
    assert.deepEqual(
      deferred,
      [MIN_REPUBLISH_WAIT],
      'the deferred refresh must come back at the republish floor, not a minute later'
    )
  })
  check('the deferred refresh republishes the new hostname', () => {
    assert.deepEqual(gate.writes, ['forge-one.trycloudflare.com', 'forge-two.trycloudflare.com'])
    assert.equal(midwrite.getState().published, 'forge-two.trycloudflare.com')
    assert.equal(clock.delays[clock.delays.length - 1], HOST_HEARTBEAT_MS, 'and then settles back to the heartbeat')
  })
  midwrite.stop()

  /* ------------------------------------------------------------ teardown */

  settings.client = rest
  settings.enabled = false
  try {
    await rest.remove(PATH)
  } catch {
    /* already gone */
  }

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`)
  console.log(
    [
      '',
      'NOTE  companion/database.rules.json has no `host` block, and its',
      '      "$other": { ".validate": false } refuses the rendezvous write — which is',
      '      what check 1 asserts. Every check after it ran against the committed rules',
      '      PLUS this file\'s PROPOSED_HOST_RULES. That block has to be added to',
      '      companion/database.rules.json and deployed before Forge Web can publish',
      '      against the real project.',
      "NOTE  RTDB's onDisconnect is not reachable over REST, so a power cut is covered",
      '      by HOST_STALE_MS alone (check 7) rather than by a server-side clear. The',
      '      header of electron/web/rendezvous.ts explains why.'
    ].join('\n')
  )
  process.exit(failures === 0 ? 0 : 1)
}

/* --------------------------------------------------------------- the rules */

/**
 * companion/database.rules.json is JSON *with comments* — Firebase's parser
 * accepts them, and the file leans on that for its schema notes. Every comment
 * in it is a whole line, and no string in it contains `//`, so dropping lines
 * that begin with `//` is enough and stays obvious.
 */
function readCommittedRules() {
  const text = readFileSync(join(ROOT, 'companion', 'database.rules.json'), 'utf8')
  const stripped = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  return JSON.parse(stripped)
}

/** The committed rules, plus the block `users/<uid>/host` still needs. */
function withHostRules(rules) {
  const next = structuredClone(rules)
  next.rules.users.$uid.host = PROPOSED_HOST_RULES
  return next
}

/**
 * Swap the Database emulator's rules at runtime.
 *
 * The emulator exposes the deployed ruleset at `/.settings/rules.json`, writable
 * with the emulator's own owner credential. That is what lets one emulator run
 * assert both "the committed rules refuse this" and "the service behaves
 * correctly once they do not".
 */
async function installRules(rules) {
  const res = await fetch(`${DB_ORIGIN}/.settings/rules.json?ns=${NAMESPACE}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(rules)
  })
  if (!res.ok) throw new Error(`installing rules failed: ${res.status} ${await res.text()}`)
}

/* -------------------------------------------------------------- the plumbing */

function dbUrl(path, params = {}) {
  const base = new URL(DB_URL)
  const url = new URL(`${base.origin}/${String(path).replace(/^\/+/, '')}.json`)
  for (const [k, v] of base.searchParams) url.searchParams.set(k, v)
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  return url.toString()
}

async function rawGet(path, token) {
  const res = await fetch(dbUrl(path, { auth: token }))
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null }
}

/** Let pending promises and their HTTP round trips finish. */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 15))
}

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

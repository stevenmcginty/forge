/**
 * companion-smoke — the Forge Companion, end to end, against the real Firebase
 * emulator suite.
 *
 *   npm run companion:smoke
 *
 * There is no mock Firebase here. The suite spawns `firebase emulators:exec`,
 * which brings up the genuine Auth and Realtime Database emulators (including
 * companion/database.rules.json, actually enforced), then re-runs this file
 * inside them. Everything the desktop service does — create an account, sign
 * in, publish projects, stream the inbox, decode an image, write it through the
 * screenshot shelf, emit the utterance, ack the item, reply into the outbox —
 * happens over real HTTP against a real database.
 *
 * The phone side is driven with plain `fetch` calls, which is exactly what
 * companion/web/js/rtdb.js does. (The PWA itself is checked separately in a
 * browser — see companion/README.md.)
 *
 * What is proven, in order:
 *   1.  off by default — no config, no network, no credential read
 *   2.  sign-in creates the account and stores only a refresh token
 *   3.  the project list publishes, with derived status lines
 *   4.  security rules: another signed-in user cannot read Steve's subtree
 *   5.  an inbox image lands in the project AND on the screenshot shelf
 *   6.  an inbox message fires `companion:utterance` with the right payload
 *   7.  both items are acked with a terminal status
 *   8.  reply() round-trips into the outbox, threaded to the message
 *   9.  a stale item is refused rather than run
 *   10. an oversized image is refused with a sentence, not half-saved
 *   11. a session restored from a refresh token alone comes back live
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(ROOT, 'companion', 'firebase.json')
const PROJECT_ID = 'demo-forge-sync'

/* Emulator endpoints, matching companion/firebase.json's `emulators` block. */
const AUTH_BASE = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
const TOKEN_BASE = 'http://127.0.0.1:9099/securetoken.googleapis.com/v1'
const DB_URL = `http://127.0.0.1:9000?ns=${PROJECT_ID}-default-rtdb`
/** The emulator ignores the key entirely; it only has to be non-empty. */
const API_KEY = 'demo-forge-sync-key'

/* --------------------------------------------------------------- reporting */

/**
 * Declared up here, not next to `phoneToken()`. `main()` runs from a top-level
 * await further down the file, so anything it touches has to be initialised
 * before that line — a `const` further down is still in its temporal dead zone.
 */
const tokenCache = new Map()

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

if (!process.env.FORGE_COMPANION_EMULATED) {
  const cli = join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js')
  if (!existsSync(cli)) {
    console.error(
      `\n[companion-smoke] firebase-tools is not installed in this worktree.\n` +
        `  npm i -D firebase-tools\n`
    )
    process.exit(1)
  }

  // Spawn the CLI's own entry point with this Node rather than the `.cmd`
  // shim. A shim needs `shell: true` on Windows, and a shell re-splits the
  // `emulators:exec` command argument on its spaces — which is how a path with
  // "Program Files" (or, here, a quoted `node "<script>"`) turns into "Too many
  // arguments". No shell, no re-splitting.
  const args = [
    cli,
    'emulators:exec',
    '--only',
    'auth,database',
    '--project',
    PROJECT_ID,
    '--config',
    CONFIG,
    `"${process.execPath}" "${join(ROOT, 'scripts', 'companion-smoke.mjs')}"`
  ]
  console.log(`[companion-smoke] starting the Firebase emulator suite…\n`)
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORGE_COMPANION_EMULATED: '1' }
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    console.error(`\n[companion-smoke] could not run the Firebase CLI: ${err.message}\n`)
    process.exit(1)
  })
} else {
  await main()
}

/* ---------------------------------------------------- inner: the real test */

async function main() {
  const scratch = join(ROOT, 'node_modules', '.forge-companion-smoke')
  mkdirSync(scratch, { recursive: true })

  // The real modules, bundled — not copies, not mocks.
  const syncBundle = join(scratch, 'companion-sync.mjs')
  const shelfBundle = join(scratch, 'shelf.mjs')
  await build({
    entryPoints: [join(ROOT, 'electron', 'companion-sync.ts')],
    outfile: syncBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  await build({
    entryPoints: [join(ROOT, 'electron', 'shots', 'shelf.ts')],
    outfile: shelfBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { CompanionSync } = await import(pathToFileURL(syncBundle).href)
  const { ShotShelf } = await import(pathToFileURL(shelfBundle).href)

  // A throwaway data root and a throwaway project folder — nothing this run
  // does can touch the real %APPDATA%\Forge.
  const home = mkdtempSync(join(tmpdir(), 'forge-companion-'))
  const dataDir = join(home, 'data')
  const shotsDir = join(dataDir, 'shots')
  const projectDir = join(home, 'project-alpha')
  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  const shelf = new ShotShelf(shotsDir, 12)
  shelf.load()

  /* ------------------------------------------------------------ the host */

  const config = {
    enabled: false,
    apiKey: API_KEY,
    databaseURL: DB_URL,
    authBase: AUTH_BASE,
    tokenBase: TOKEN_BASE,
    email: '',
    refreshToken: '',
    uid: ''
  }
  const events = []
  const adoptCalls = []

  const host = {
    getConfig: () => ({ ...config }),
    saveConfig: (patch) => Object.assign(config, patch),
    listProjects: () => [
      { id: 'proj-alpha', name: 'Alpha', color: '#c6ff4a', path: projectDir },
      { id: 'proj-beta', name: 'Beta', color: '#7fd1ff', path: join(home, 'project-beta') }
    ],
    statusOf: (id) => (id === 'proj-alpha' ? { panes: 3, tabs: 2, lastActivity: 1700 } : { panes: 0, tabs: 1, lastActivity: 900 }),
    adoptShots: (files) => {
      adoptCalls.push(...files)
      // The *real* shelf, so "landed on the tray" means the real shelf accepted it.
      let n = 0
      for (const f of files) if (shelf.pinFile(f).ok) n += 1
      return n
    },
    emit: (e) => {
      events.push(e)
      if (process.env.FORGE_COMPANION_DEBUG) {
        console.log(`      [event] ${e.type}${e.type === 'status' ? ` ${e.status.state} ${e.status.detail}` : ''}`)
      }
    },
    // Surfaced, not swallowed: when this suite fails it is nearly always the
    // service quietly catching something, and a silent host makes that
    // invisible.
    log: (line, ...rest) => console.log(`      [service] ${line}`, ...rest)
  }

  const sync = new CompanionSync(host)

  /* --------------------------------------------------- 1. off by default */

  sync.start()
  check('off by default: no config touched, state is off', () => {
    const s = sync.getStatus()
    assert.equal(s.state, 'off')
    assert.equal(s.enabled, false)
    assert.equal(config.refreshToken, '', 'nothing should have been written')
  })

  /* ---------------------------------------------------------- 2. sign in */

  config.enabled = true
  const email = `steve+${Date.now()}@example.com`
  const signInResult = await sync.signIn(email, 'forge-companion-test')
  check('sign-in creates the account and starts the link', () => {
    assert.equal(signInResult.ok, true, JSON.stringify(signInResult))
    assert.equal(signInResult.created, true, 'a brand-new email should create an account')
    assert.ok(config.uid, 'uid stored')
    assert.ok(config.refreshToken, 'refresh token stored')
    assert.equal(config.email, email)
  })
  const uid = config.uid

  check('the password is never written to config', () => {
    assert.equal(
      JSON.stringify(config).includes('forge-companion-test'),
      false,
      'the password must not appear anywhere in the stored config'
    )
  })

  await waitFor(() => sync.getStatus().state === 'live', 'the inbox stream to go live')
  check('link reaches live', () => assert.equal(sync.getStatus().state, 'live'))

  /* --------------------------------------------------- 3. project publish */

  const publishedCount = await sync.publishProjects()
  const published = await phoneGet(uid, `users/${uid}/projects`, await phoneToken(email, 'forge-companion-test'))
  if (process.env.FORGE_COMPANION_DEBUG) {
    console.log(`      [debug] uid ${uid}, published ${publishedCount}: ${JSON.stringify(published)}`)
  }
  check('project list publishes with derived status lines', () => {
    assert.ok(published, 'projects node exists')
    // Bracket notation, because `-` is legal in an RTDB key and Forge's project
    // ids really do contain one. (`safeKey()` leaves it alone on purpose.)
    assert.equal(published['proj-alpha'].name, 'Alpha')
    assert.equal(published['proj-alpha'].status, '3 panes · 2 tabs')
    assert.equal(published['proj-alpha'].panes, 3)
    assert.equal(published['proj-beta'].status, 'Idle · 1 tab')
    assert.ok(typeof published['proj-alpha'].updatedAt === 'number', 'server timestamp resolved')
  })
  check('the local folder path is never published', () => {
    assert.equal(JSON.stringify(published).includes(projectDir.replace(/\\/g, '\\\\')), false)
    assert.equal(JSON.stringify(published).includes('project-alpha'), false)
  })

  /* ------------------------------------------------------ 4. rules bite */

  const intruder = await phoneSignIn(`intruder+${Date.now()}@example.com`, 'not-steves-password')
  const stolen = await rawGet(`users/${uid}/projects`, intruder.idToken)
  check('security rules: another account cannot read this uid subtree', () => {
    assert.equal(stolen.ok, false, `expected a refusal, got ${stolen.status}`)
    assert.ok(stolen.status === 401 || stolen.status === 403, `expected 401/403, got ${stolen.status}`)
  })
  const anon = await rawGet(`users/${uid}/projects`, '')
  check('security rules: an unauthenticated read is refused', () => {
    assert.equal(anon.ok, false, `expected a refusal, got ${anon.status}`)
  })

  /* ------------------------------------------------------- 5+6. the inbox */

  const token = await phoneToken(email, 'forge-companion-test')
  const imageId = sortableId()
  const messageId = sortableId(Date.now() + 1)

  // A 2x2 red PNG — small, real, and decodable by the shelf.
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAwMDAwAAADgABsxbF2gAAAABJRU5ErkJggg=='

  await phonePatch(`users/${uid}/inbox/proj-alpha/${imageId}`, token, {
    kind: 'image',
    name: 'whiteboard.png',
    mime: 'image/png',
    data: `data:image/png;base64,${tinyPng}`,
    createdAt: { '.sv': 'timestamp' },
    origin: 'phone',
    status: 'pending'
  })
  await phonePatch(`users/${uid}/inbox/proj-alpha/${messageId}`, token, {
    kind: 'message',
    text: 'run the tests and tell me what broke',
    createdAt: { '.sv': 'timestamp' },
    origin: 'phone',
    status: 'pending'
  })

  await waitFor(
    () => events.some((e) => e.type === 'utterance') && adoptCalls.length > 0,
    'the image and the message to be consumed'
  )

  const inboxImage = join(projectDir, 'assets', 'inbox', 'whiteboard.png')
  check('image lands in the project as a real file', () => {
    assert.ok(existsSync(inboxImage), `expected ${inboxImage}`)
    assert.ok(readFileSync(inboxImage).length > 0)
  })
  check('image is adopted onto the screenshot shelf', () => {
    assert.deepEqual(adoptCalls, [inboxImage])
    const onShelf = readdirSync(shotsDir)
    assert.equal(onShelf.length, 1, `shelf holds ${JSON.stringify(onShelf)}`)
    assert.match(onShelf[0], /^whiteboard\.png$/)
  })

  const utterance = events.find((e) => e.type === 'utterance')
  check('companion:utterance fires with the documented payload', () => {
    assert.ok(utterance, 'no utterance event')
    assert.equal(utterance.projectId, 'proj-alpha', "the app's own project id, not the RTDB key")
    assert.equal(utterance.projectName, 'Alpha')
    assert.equal(utterance.itemId, messageId)
    assert.equal(utterance.text, 'run the tests and tell me what broke')
  })

  /* --------------------------------------------------------- 7. the acks */

  const acked = await phoneGet(uid, `users/${uid}/inbox/proj-alpha`, token)
  check('both items are acked with a terminal status', () => {
    assert.equal(acked[imageId].status, 'done', JSON.stringify(acked[imageId]))
    assert.match(acked[imageId].result, /Alpha/)
    assert.equal(acked[messageId].status, 'done')
    assert.equal(acked[messageId].result, 'Sent to Alpha')
    assert.ok(typeof acked[messageId].doneAt === 'number')
  })

  /* ------------------------------------------------------------ 8. reply */

  const replied = await sync.reply(messageId, 'Two failed: the pty smoke and the shots smoke.')
  await waitFor(async () => {
    const out = await phoneGet(uid, `users/${uid}/outbox/proj-alpha`, token)
    return out && Object.keys(out).length > 0
  }, 'the reply to reach the outbox')
  const outbox = await phoneGet(uid, `users/${uid}/outbox/proj-alpha`, token)
  check('reply round-trips into the outbox, threaded to the message', () => {
    assert.equal(replied, true)
    const rows = Object.values(outbox)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'reply')
    assert.equal(rows[0].text, 'Two failed: the pty smoke and the shots smoke.')
    assert.equal(rows[0].origin, 'forge')
    assert.equal(rows[0].replyTo, messageId)
    assert.ok(typeof rows[0].createdAt === 'number')
  })
  // Awaited out here rather than inside check() — check()'s callback is sync,
  // so an async one would resolve after the check had already reported.
  const strayReply = await sync.reply('never-seen-this', 'hello?')
  check('replying to an unknown item is refused rather than misfiled', () => {
    assert.equal(strayReply, false)
  })

  /* ------------------------------------------------------------ 9. stale */

  const staleId = sortableId()
  await phonePatch(`users/${uid}/inbox/proj-alpha/${staleId}`, token, {
    kind: 'message',
    text: 'this one sat in a tunnel for a week',
    // A literal, very old timestamp rather than the server's.
    createdAt: Date.now() - 48 * 3600 * 1000,
    origin: 'phone',
    status: 'pending'
  })
  await waitFor(async () => {
    const all = await phoneGet(uid, `users/${uid}/inbox/proj-alpha`, token)
    return all?.[staleId]?.status && all[staleId].status !== 'pending'
  }, 'the stale item to be refused')
  const afterStale = await phoneGet(uid, `users/${uid}/inbox/proj-alpha`, token)
  check('an item older than the stale window is refused, not run', () => {
    assert.equal(afterStale[staleId].status, 'stale')
    assert.equal(
      events.filter((e) => e.type === 'utterance').length,
      1,
      'the stale message must not have reached the voice pipeline'
    )
  })

  /* ------------------------------------------------------- 10. big image */

  const oversizeId = sortableId()
  await phonePatch(`users/${uid}/inbox/proj-alpha/${oversizeId}`, token, {
    kind: 'image',
    name: 'huge.png',
    mime: 'image/png',
    // Over MAX_INLINE_BASE64 but under the rules' ceiling, so it reaches the
    // service and has to be refused there rather than by the database.
    data: `data:image/png;base64,${'A'.repeat(204_900)}`,
    createdAt: { '.sv': 'timestamp' },
    origin: 'phone',
    status: 'pending'
  })
  await waitFor(async () => {
    const all = await phoneGet(uid, `users/${uid}/inbox/proj-alpha`, token)
    return all?.[oversizeId]?.status && all[oversizeId].status !== 'pending'
  }, 'the oversized image to be refused')
  const afterBig = await phoneGet(uid, `users/${uid}/inbox/proj-alpha`, token)
  check('an oversized image is refused with a sentence, not half-saved', () => {
    assert.equal(afterBig[oversizeId].status, 'failed')
    assert.match(afterBig[oversizeId].result, /too big/i)
    assert.equal(existsSync(join(projectDir, 'assets', 'inbox', 'huge.png')), false)
  })

  /* --------------------------------------- 11. restore from refresh token */

  sync.stop()
  const restored = new CompanionSync(host)
  restored.start()
  await waitFor(() => restored.getStatus().state === 'live', 'the restored session to come back live')
  check('a session restored from the refresh token alone comes back live', () => {
    const s = restored.getStatus()
    assert.equal(s.state, 'live')
    assert.equal(s.uid, uid)
    assert.equal(s.email, email)
  })

  /* ------------------------------------------------------------ teardown */

  restored.dispose()
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* Windows sometimes still has a handle; the temp dir is disposable */
  }

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

/* ------------------------------------------------- the phone, in 40 lines */

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

async function phoneGet(_uid, path, token) {
  const res = await rawGet(path, token)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json
}

async function phonePatch(path, token, value) {
  const res = await fetch(dbUrl(path, { auth: token }), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  })
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

async function phoneSignIn(email, password) {
  const body = { email, password, returnSecureToken: true }
  let res = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    res = await fetch(`${AUTH_BASE}/accounts:signUp?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }
  if (!res.ok) throw new Error(`phone sign-in failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function phoneToken(email, password) {
  if (!tokenCache.has(email)) tokenCache.set(email, (await phoneSignIn(email, password)).idToken)
  return tokenCache.get(email)
}

/** Matches sortableId() in electron/companion/protocol.ts. */
function sortableId(now = Date.now()) {
  const stamp = Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')
  let tail = ''
  for (let i = 0; i < 8; i++) tail += Math.floor(Math.random() * 36).toString(36)
  return `${stamp}-${tail}`
}

async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out waiting for ${what}`)
}

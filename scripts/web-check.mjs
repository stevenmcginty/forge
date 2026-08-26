/**
 * Forge Web's *lifecycle*, proved by observation.
 *
 *   npm run web:check
 *
 * `web:smoke` proves the socket and every refusal on it; `web:auth` proves the
 * token; `web:rendezvous` proves the record against a real Firebase emulator.
 * None of them touches the thing this feature can most easily be wrong about,
 * which is the switch: docs/forge-web.md promises that a Forge with `webEnabled`
 * off "publishes no hostname, reads no credential", and specifies that the proof
 * must come from *inspecting the listener and the rendezvous* rather than from
 * trusting the setting. A comment saying "off by default" is not a test.
 *
 * So this drives the real `electron/web-host.ts` — the whole file, with its real
 * `WebServer`, `WebAuth`, `WebRendezvous` and `NgrokTunnel` behind it — with
 * `electron` stubbed the way scripts/git-check.mjs and scripts/gitwatch-smoke.mjs
 * stub it, and watches from outside:
 *
 *  - a **TCP connect** to the port answers the question "is it listening",
 *    which no amount of reading `webStatus()` does;
 *  - a **fetch counter** answers "did anything read a credential or publish a
 *    hostname", because every credential this feature has travels over `fetch`
 *    — the JWKS, the sign-in, the token refresh, and the RTDB write itself;
 *  - a **real WebSocket** with a real Firebase-shaped ID token answers "does a
 *    browser this desktop has never seen actually get in, and does the unlock
 *    PIN actually stop one that has not answered it";
 *  - **settings.json, read back off disk** answers "what did signing in
 *    actually write down", the way scripts/mobile-auth-check.mjs does;
 *  - a **scripted tunnel process** answers "does the tunnel's own hostname reach
 *    the rendezvous record, does a tunnel that dies take it away again, and does
 *    one that comes back on a *different* address replace it". Both supervisors
 *    are the shipped ones — cloudflared's and ngrok's — and only the OS process
 *    is a stand-in, the same bargain scripts/tunnel-check.mjs strikes.
 *
 * Two of the phases below exist because of arrangements this feature was
 * *corrected out of*, and they are the ones to keep if anything here is ever
 * trimmed. Forge Web used to publish under the Companion's Firebase session, so
 * it silently stopped working when a different feature was signed out or signed
 * in as somebody else — phase 2 sets up exactly that (Companion signed in, as
 * another account, Forge Web signed out) and demands a refusal that says why.
 * And it used to take its hostname from an environment variable, which no
 * status could ever describe honestly — phases 9 and 9b drive real supervisors
 * instead. Phase 9's middle is a third correction: Forge Web shipped on ngrok,
 * whose free plan allows one online endpoint per account, so the browser link
 * and the phone link could not both be up. The default is now a cloudflared
 * quick tunnel, and the price of that — a new address on every start — is what
 * the kill-and-return assertions there exist to prove has already been paid.
 *
 * Everything Google and Firebase would supply is generated or served here: an
 * RSA keypair, a self-signed X.509 certificate in the shape the securetoken
 * endpoint publishes, JWTs minted against it, and a fake RTDB that records every
 * method and path it is handed. The certificate construction is the one in
 * scripts/web-smoke.mjs and scripts/web-auth-check.mjs — restated rather than
 * shared because each check stands alone and neither of those files is this
 * one's to edit.
 *
 * Nothing here reaches the network, and nothing here touches Steve's own data
 * root: `FORGE_DATA_DIR` points at a temporary folder that is removed on the way
 * out.
 */
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, parse as parsePath, sep } from 'node:path'
import { WebSocket } from 'ws'

/* ------------------------------------------------------------- the sandbox */

const dataDir = mkdtempSync(join(tmpdir(), 'forge-web-check-'))

/**
 * On the way out, however it ends. The happy path removes this itself, but a
 * check that dies on its third assertion should not leave a folder behind for
 * somebody to find in six months and wonder about.
 */
process.on('exit', () => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* the happy path already removed it */
  }
})

const PORT = 8479
const HOSTNAME = 'forge-web-check.trycloudflare.invalid'
const PROJECT = 'forge-web-check'
const OTHER_PROJECT = 'somebody-elses-project'
/**
 * A Hosting site whose name has nothing in common with the project's, because
 * that is the case this feature was wrong about: `webAllowedOrigins` derived
 * every origin from the project id, which is only the site's name when nobody
 * has added a second site. A site called `<project>-web` would have let the old
 * code pass a substring check and prove nothing.
 */
const SITE = 'a-site-of-its-own'

/**
 * What this repo actually deploys Forge Web to, read out of `.firebaserc`.
 *
 * The one fact in this file that is not invented, and the reason for that is
 * the bug: every assertion here can pass against made-up names while the real
 * page is served from an address the real desktop refuses. `firebase.json`'s
 * `target: "web"` names the target; `.firebaserc` maps it to a site.
 * '' when either cannot be read, which fails below rather than skipping.
 */
const { DEPLOY_PROJECT, DEPLOY_SITE } = readDeployTarget()

function readDeployTarget() {
  try {
    const rc = JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url), 'utf8'))
    const project = String(rc?.projects?.default ?? '')
    const sites = rc?.targets?.[project]?.hosting?.web
    const site = Array.isArray(sites) ? String(sites[0] ?? '') : ''
    return { DEPLOY_PROJECT: project, DEPLOY_SITE: site }
  } catch {
    return { DEPLOY_PROJECT: '', DEPLOY_SITE: '' }
  }
}
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
/** The Companion's account — deliberately *not* the one Forge Web signs into. */
const COMPANION_UID = 'zZ9tGhK2wR4nB7cV1xM6qL0sD85e'
const KID = 'c0ffee'
const DB = 'https://db.invalid'
const AUTH_BASE = 'https://identity.invalid/v1'
const TOKEN_BASE = 'https://token.invalid/v1'
const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

/* Forge Web's own sign-in. The password is here so the assertion that it never
 * reaches settings.json has something specific to look for. */
const WEB_EMAIL = 'forge-web@example.invalid'
const WEB_PASSWORD = 'correct-horse-battery-staple-check'
const WEB_REFRESH = 'web-refresh-token-issued-by-the-fake-identity-toolkit'

/* Forge Web's own tunnel: its own domain, its own authtoken, neither shared
 * with Forge Mobile's. */
const NGROK_DOMAIN = 'forge-web-check.ngrok-free.app'
const NGROK_TOKEN = '2FakeNgrokAuthtoken_ForTheWebCheckOnly99'
/**
 * The two addresses a cloudflared quick tunnel hands out — two, because they
 * are never the same twice and that is the whole reason this transport is the
 * default. Phase 9 kills a tunnel that is live on the first and asserts the
 * second reaches the browser.
 */
const CF_HOST_ONE = 'forge-check-first-address.trycloudflare.com'
const CF_HOST_TWO = 'forge-check-second-address.trycloudflare.com'
/** The banner a quick tunnel prints, in the shape cloudflared really prints it. */
const cfBanner = (host) => `2026-08-10T16:42:54Z INF |  https://${host}                      |`
/**
 * Something for `resolveNgrokExe` and `resolveCloudflaredExe` to find, so the
 * host never tries to download an agent. Neither is ever executed: the spawn
 * that would run them is intercepted below.
 */
const FAKE_NGROK = join(dataDir, 'fake-ngrok.exe')
writeFileSync(FAKE_NGROK, 'not a real ngrok')
const FAKE_CLOUDFLARED = join(dataDir, 'fake-cloudflared.exe')
writeFileSync(FAKE_CLOUDFLARED, 'not a real cloudflared')

process.env['FORGE_DATA_DIR'] = dataDir
process.env['FORGE_WEB_PORT'] = String(PORT)
process.env['FORGE_WEB_HOSTNAME'] = HOSTNAME
process.env['FORGE_NGROK_EXE'] = FAKE_NGROK
process.env['FORGE_CLOUDFLARED_EXE'] = FAKE_CLOUDFLARED
// Read by `webAllowedOrigins`, and deliberately left unset until the origins
// phase: an override in place from the start would mask the derivation this
// check exists to prove.
delete process.env['FORGE_WEB_ORIGINS']

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolvePromise()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

/**
 * Is anything actually listening on the port?
 *
 * A TCP connect, not a read of `webStatus()`. The whole promise being tested is
 * that a switched-off Forge binds nothing, and a status object is exactly the
 * kind of evidence that can agree with the setting while the socket disagrees
 * with both.
 */
function portOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (answer) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(answer)
    }
    socket.setTimeout(1500)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
    socket.on('timeout', () => done(false))
  })
}

/* --------------------------------------------------- what electron would be
 *
 * The same trick gitwatch-smoke.mjs plays, with a wider shape because
 * web-host.ts names five things out of electron rather than three. The IPC
 * registry is hung off globalThis so the check can *invoke* the handlers the
 * settings panel would — a lifecycle test that called the module's private
 * `start()` would be testing a function nobody reaches.
 */
globalThis.__forgeIpc = { handlers: new Map(), listeners: new Map() }

/**
 * The notification area, as far as a head-less run can see it.
 *
 * `new Tray(...)` is the whole observable fact — an icon exists or it does not —
 * so the stand-in registers itself here and remembers what it was last told to
 * show. That is enough for phase 11 to assert the rule electron/tray.ts is built
 * around: Forge never hides itself behind an icon that is not there.
 */
globalThis.__forgeTray = null
globalThis.__forgeBalloons = []

/**
 * The windows `BrowserWindow.getAllWindows()` reports, which is none for almost
 * the whole of this run.
 *
 * None is the honest state for a head-less check and the one `dispatchLayout`
 * has to refuse cleanly in, so it stays the default. The exception is the "one
 * PTY, two viewers" phase: what a browser's watch produces is a *broadcast to
 * every renderer*, and a broadcast with nothing to receive it cannot be
 * observed at all. That phase installs a window that records what it is sent
 * and takes it away again afterwards.
 */
globalThis.__forgeWindows = []

const ELECTRON_STUB = 'forge-web-check:electron'

/* --------------------------------------------- a scripted tunnel agent
 *
 * The supervisors under test are the shipped ones — `CloudflareTunnel` and
 * `NgrokTunnel`, reached the way the app reaches them, through
 * `electron/web-host.ts`'s own `startTunnel()`. What is faked is the
 * operating-system process, and *only* for the two modules that spawn one: the
 * `node:child_process` swap below is keyed on the importer, so everything else
 * in this graph (git, taskkill, whatever else main reaches for) still gets the
 * real one.
 *
 * The stand-in carries no pid on purpose. `NgrokTunnel.stop()` kills by process
 * *tree* when it has one — `taskkill /pid <n> /T /F` — and inventing a number
 * here would point that at whatever process on this machine happens to own it.
 */
const CHILD_PROCESS_STUB = 'forge-web-check:child_process'

/** Every fake agent this run has spawned, newest last. */
const agents = []

function fakeAgent(args) {
  // Two separate lists, as scripts/tunnel-check.mjs keeps them: the supervisor
  // hangs the same reader on both pipes, and one shared list would deliver
  // every line twice.
  const listeners = { stdout: [], stderr: [], exit: [] }
  const agent = {
    args,
    pid: undefined,
    stdout: { on: (event, cb) => event === 'data' && listeners.stdout.push(cb) },
    stderr: { on: (event, cb) => event === 'data' && listeners.stderr.push(cb) },
    on: (event, cb) => event === 'exit' && listeners.exit.push(cb),
    killed: false,
    kill: () => {
      agent.killed = true
    },
    /* test controls */
    say: (line) => listeners.stdout.forEach((cb) => cb(`${line}\n`)),
    die: (code) => listeners.exit.forEach((cb) => cb(code))
  }
  agents.push(agent)
  return agent
}

globalThis.__forgeSpawn = (exe, args, options, realSpawn) => {
  if (exe === FAKE_NGROK || exe === FAKE_CLOUDFLARED) return fakeAgent(args)
  return realSpawn(exe, args, options)
}

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    const importer = String(context.parentURL ?? '')
    if (
      spec === 'node:child_process' &&
      (importer.endsWith('mobile-tunnel.ts') || importer.endsWith('cloudflare-tunnel.ts'))
    ) {
      return { url: CHILD_PROCESS_STUB, shortCircuit: true }
    }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    // Extensionless relative imports are Forge's TypeScript, but only inside
    // Forge. `@lydell/node-pty` — which this graph reaches through pty-host —
    // has extensionless CommonJS requires of its own, and rewriting one of
    // those to `./utils.ts` is how the whole check dies before its first
    // assertion, in a stack trace about a missing platform binary.
    const fromDependency = importer.includes('/node_modules/')
    if (!fromDependency && spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === CHILD_PROCESS_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          // The real module, reached from *this* URL rather than from
          // mobile-tunnel.ts, so the resolve hook above lets it through.
          'import { spawn as realSpawn } from "node:child_process"',
          'export const spawn = (exe, args, options) => globalThis.__forgeSpawn(exe, args, options, realSpawn)'
        ].join('\n')
      }
    }
    if (url === ELECTRON_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'const ipc = globalThis.__forgeIpc',
          'export const app = {',
          '  getVersion: () => "0.0.0-check",',
          '  getPath: () => process.env.FORGE_DATA_DIR,',
          '  getAppPath: () => process.cwd(),',
          '  isPackaged: false,',
          '  focus: () => {},',
          '  on: () => {}',
          '}',
          'export const ipcMain = {',
          '  handle: (channel, fn) => ipc.handlers.set(channel, fn),',
          '  on: (channel, fn) => ipc.listeners.set(channel, fn),',
          '  removeHandler: (channel) => ipc.handlers.delete(channel)',
          '}',
          // Whatever `__forgeWindows` holds, which is nothing unless a phase has
          // deliberately put a recorder there — see the declaration above.
          'export const BrowserWindow = { getAllWindows: () => globalThis.__forgeWindows, fromWebContents: () => null }',
          'export const Notification = { isSupported: () => false }',
          'export class Tray {',
          '  constructor(image) { this.image = image; globalThis.__forgeTray = this }',
          '  on() {}',
          '  setToolTip(text) { this.tooltip = text }',
          '  setContextMenu(menu) { this.menu = menu }',
          '  displayBalloon(options) { globalThis.__forgeBalloons.push(options) }',
          '  destroy() { if (globalThis.__forgeTray === this) globalThis.__forgeTray = null }',
          '}',
          // The template goes through untouched, so the check can click the
          // items a person would click rather than the functions behind them.
          'export const Menu = { buildFromTemplate: (template) => template }',
          'export const nativeImage = {',
          '  createFromPath: (path) => ({ isEmpty: () => false, path }),',
          '  createFromBitmap: () => ({ isEmpty: () => false, path: "" })',
          '}',
          'export const powerSaveBlocker = { start: () => 1, stop: () => {}, isStarted: () => true }',
          'export const shell = { openPath: () => {} }',
          'export const clipboard = { readText: () => "", writeText: () => {} }',
          'export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }',
          'export const screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 0, height: 0 } }) }'
        ].join('\n')
      }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

/* -------------------------------------------------------- a certificate CA
 *
 * Minimal DER: a v1 certificate is a serial, an algorithm, a name, a validity
 * window and the SPKI, which node:crypto hands over ready-made. Serving a bare
 * public key instead would mean the production path — parsing what Google
 * actually sends — was the one path never exercised.
 */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let value = n
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))

/** AlgorithmIdentifier for sha256WithRSAEncryption, with its NULL parameters. */
const SHA256_RSA = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
/** OID 2.5.4.3 — commonName. */
const OID_CN = Buffer.from('0603550403', 'hex')

function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const text =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

function certificateFor(pair, commonName) {
  const name = seq(set(seq(OID_CN, tlv(0x13, Buffer.from(commonName, 'ascii')))))
  const now = Date.now()
  const tbs = seq(
    tlv(0x02, Buffer.from([0x01])),
    SHA256_RSA,
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name,
    pair.publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = createSign('RSA-SHA256').update(tbs).sign(pair.privateKey)
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])))
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

const b64url = (value) => Buffer.from(value).toString('base64url')

const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const served = { [KID]: certificateFor(google, 'securetoken.google.com') }
const nowSec = () => Math.floor(Date.now() / 1000)

/** A Firebase ID token, correct in every way unless told otherwise. */
function mint(overrides = {}) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
  const claims = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: UID,
    auth_time: nowSec() - 300,
    iat: nowSec() - 60,
    exp: nowSec() + 3600,
    ...overrides
  }
  const payload = b64url(JSON.stringify(claims))
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(google.privateKey)
  return `${header}.${payload}.${signature.toString('base64url')}`
}

/* ------------------------------------------------------------- fake network
 *
 * Every credential this feature reads and every hostname it publishes leaves
 * through `fetch`. So counting fetches is not a convenience — it is the
 * instrument that turns "nothing is published when the switch is off" into
 * something observable rather than asserted.
 */

const calls = []

/**
 * The ID token the fake Identity Toolkit handed back at sign-in.
 *
 * Kept so the disk assertion can look for that exact string rather than for
 * "something JWT-shaped": an hour-long bearer token has no business in a
 * settings file, and the way to prove it is not there is to know what it was.
 */
let issuedIdToken = ''

function answer(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const method = String(init.method ?? 'GET').toUpperCase()
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    /* record it verbatim */
  }
  let body = null
  if (typeof init.body === 'string' && init.body.startsWith('{')) {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = null
    }
  }
  calls.push({ url, method, path, body })

  if (url.startsWith(GOOGLE_JWKS_URL)) return answer(200, JSON.stringify(served), { 'cache-control': 'max-age=3600' })
  if (url.startsWith(`${AUTH_BASE}/accounts:signInWithPassword`)) {
    // Identity Toolkit's real answer, in its real shape. The refresh token is
    // the durable half and the ID token is the hour-long half; which of the two
    // reaches disk is the question phase 8 asks.
    issuedIdToken = mint()
    return answer(
      200,
      JSON.stringify({
        localId: UID,
        email: String(body?.email ?? WEB_EMAIL),
        idToken: issuedIdToken,
        refreshToken: WEB_REFRESH,
        expiresIn: 3600
      })
    )
  }
  if (url.startsWith(`${TOKEN_BASE}/token`)) {
    return answer(200, JSON.stringify({ id_token: mint(), expires_in: 3600, user_id: UID }))
  }
  if (url.startsWith(DB)) return answer(200, method === 'DELETE' ? '' : 'null')
  // Anything else is a request this feature was not supposed to make. Recorded
  // above so the assertion below can name it, and refused here so it cannot
  // quietly succeed against the real internet.
  return answer(404, 'not stubbed')
}

const dbCalls = (method, suffix) =>
  calls.filter((c) => c.url.startsWith(DB) && c.method === method && c.path.endsWith(suffix))

/* --------------------------------------------------------------- the host */

const store = await import('../electron/store.ts')
const host = await import('../electron/web-host.ts')
const { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH } = await import('../shared/web.ts')
// The channel name, from the file that owns it: a literal here would keep
// passing after somebody renamed the real one.
const { IPC } = await import('../shared/ipc.ts')

const ipc = globalThis.__forgeIpc
const invoke = (channel, ...args) => {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

/**
 * A browser tab. Keeps every frame, the close code, and the order the two
 * arrived in — which is the whole of the shutdown assertion: a `shutdown` frame
 * sent *after* the close is a frame nobody receives.
 */
function browser(deviceId, { origin, pin } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], {
    ...(origin ? { origin } : {})
  })
  const tab = { socket, frames: [], closed: null, deviceId, framesAtClose: 0 }
  socket.on('message', (raw) => tab.frames.push(JSON.parse(String(raw))))
  socket.on('close', (code) => {
    tab.closed = code
    tab.framesAtClose = tab.frames.length
  })
  socket.on('error', () => {
    /* a refused upgrade closes without a frame; the assertions read `closed` */
  })
  return new Promise((resolvePromise) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          proto: WEB_PROTO,
          idToken: mint(),
          client: 'web-check',
          deviceId,
          deviceName: 'Check',
          // Omitted unless a phase is exercising the unlock PIN, so every other
          // phase sends the hello it always sent.
          ...(pin ? { pin } : {})
        })
      )
      resolvePromise(tab)
    })
    socket.on('error', () => resolvePromise(tab))
  })
}

const frameOf = (tab, type) => tab.frames.find((f) => f.type === type)

/* ================================================================== phase 1
 *
 * The switch is off. Nothing may bind, publish or read a credential — and the
 * evidence is the listener and the fetch log, not the setting.
 */

console.log('\nwebEnabled: false')

/*
 * What a desktop that has never chosen gets, read before this file writes a
 * single setting. The tunnel is the one field in the Forge Web block that does
 * *not* default to off, because the transport it defaults to needs no account,
 * no domain and no token — so "switch Forge Web on" is genuinely the whole
 * setup. The two assertions beside it are the reason that is safe to default:
 * the link is still off, and there is still no credential anywhere.
 */
const fresh = store.getSettings()
log(fresh.webTunnel === 'cloudflared', `a fresh profile picks the tunnel that needs nothing pasted (${fresh.webTunnel})`)
log(fresh.webEnabled === false, 'while the link itself is off, so the default costs nothing until somebody switches it on')
log(
  fresh.webNgrokAuthtoken === '' && fresh.webNgrokDomain === '',
  'and there is no credential stored for it to need, because it has none'
)

store.setSettings({
  webEnabled: false,
  // Pinned rather than left at the default for the eight phases below: they are
  // about the switch, the session and the socket, and `FORGE_WEB_HOSTNAME` is
  // answering the address question for all of them. The tunnel gets phase 9 to
  // itself, where the environment override is deleted first.
  webTunnel: 'off',
  webProjectId: PROJECT,
  // Signed out: Forge Web knows *which* Firebase project to trust, and holds no
  // session of its own yet. The uid arrives when somebody signs in, in phase 3.
  webUid: '',
  webApiKey: 'check-web-api-key',
  webDatabaseURL: DB,
  webAuthBase: AUTH_BASE,
  webTokenBase: TOKEN_BASE,
  webEmail: '',
  webRefreshToken: '',
  // No unlock PIN, which is what this desktop ships as. Phase 5b sets one.
  webPin: '',
  // The Companion, signed in — as a *different account*. This is the whole
  // point of the arrangement: there is a perfectly good Firebase session on this
  // desktop, and it belongs to somebody else's subtree. Forge Web must not
  // touch it, and must not fall silent because of it.
  companionEnabled: true,
  companionUid: COMPANION_UID,
  companionEmail: 'companion@example.invalid',
  companionApiKey: 'check-api-key',
  companionDatabaseURL: DB,
  companionTokenBase: TOKEN_BASE,
  companionRefreshToken: 'companion-refresh-token'
})

host.registerWebHandlers()
host.applyWebSettings()
// A generous beat: if anything were going to bind a port or reach the network
// off the back of "apply", this is where it would.
await sleep(250)

log((await portOpen(PORT)) === false, `nothing is listening on ${PORT}`)
log(calls.length === 0, `no request left this desktop (${calls.length} made)`)
log(host.webStatus().state === 'off', `status reads off (${host.webStatus().state})`)
log(host.webStatus().rendezvous.published === '', 'no hostname is published')
log(host.webStatus().url === '', 'and there is no address to hand anybody')
log(agents.length === 0, `and no tunnel agent was spawned (${agents.length})`)
log((await invoke('web:status')).enabled === false, 'the settings panel is told the same thing')

/* ================================================================== phase 2
 *
 * The case that used to fail in silence.
 *
 * Forge Web switched on and signed out, while the Companion is signed in as a
 * different account. Before this feature held a session of its own, that was an
 * arrangement in which `web-host.ts` simply did not publish — no record, no
 * error, no sentence anywhere — and the cause was a *different feature's*
 * sign-in state. Everything asserted here is the opposite of that: nothing is
 * published, nothing is read, and the status says why in words.
 */

console.log('\nswitched on, signed out, with the Companion signed in as somebody else')

const signedOut = await invoke('web:start')
await sleep(400)

log(signedOut.state === 'listening', `the door still opens (${signedOut.state})`)
log(signedOut.configured === false, 'but it reports itself unconfigured')
log(signedOut.session.signedIn === false, 'because Forge Web has no session of its own')
log(
  /sign(ed)? in/i.test(signedOut.session.detail) && /companion/i.test(signedOut.session.detail),
  `and it says so, naming the feature it is *not* borrowing from ("${signedOut.session.detail}")`
)
log(
  calls.filter((c) => c.url.startsWith(DB)).length === 0,
  `nothing was published anywhere (${calls.filter((c) => c.url.startsWith(DB)).length} database calls)`
)
log(
  dbCalls('PUT', `/users/${COMPANION_UID}/host.json`).length === 0,
  "and nothing under the Companion's uid, which is the record that used to be borrowed"
)
log(
  !calls.some((c) => c.url.startsWith(TOKEN_BASE)),
  "the Companion's refresh token sat right there and was never read"
)
log(host.webStatus().rendezvous.published === '', 'so there is no hostname published for anybody to dial')

await invoke('web:stop')

const enableUnsigned = await invoke('web:enable')
log(
  enableUnsigned.enabled === false,
  'enable() — the one-click friend path — refuses when nobody is signed in'
)
log(
  /Forge account/i.test(enableUnsigned.detail),
  `and names the missing account ("${enableUnsigned.detail}")`
)

/* ================================================================== phase 3
 *
 * Signing Forge Web in — its own account, its own credential.
 *
 * The Companion is signed out entirely first, so nothing below can be it.
 */

console.log('\nsigning Forge Web in, with the Companion signed out entirely')

store.setSettings({ companionEnabled: false, companionUid: '', companionRefreshToken: '' })

const signIn = await invoke('web:sign-in', WEB_EMAIL, WEB_PASSWORD)

log(signIn.ok === true, `the sign-in succeeded (${signIn.ok ? 'ok' : signIn.error})`)
log(signIn.uid === UID, `and returned Forge Web's own uid (${signIn.uid})`)
log(
  calls.some((c) => c.url.startsWith(`${AUTH_BASE}/accounts:signInWithPassword`)),
  'the password went to the identity provider and nowhere else'
)

const afterSignIn = host.webStatus()
log(afterSignIn.session.signedIn === true, 'the status says Forge Web is signed in')
log(afterSignIn.session.email === WEB_EMAIL, `as the account that was typed (${afterSignIn.session.email})`)
log(afterSignIn.session.uid === UID, 'under its own uid')
log(afterSignIn.session.detail === '', 'with nothing left to explain')
log(afterSignIn.configured === true, 'and the desktop now counts as configured')
log(store.getSettings().companionUid === '', 'while the Companion is signed out — nothing here came from it')
log(
  afterSignIn.enabled === false,
  'and signing in did not switch the link on: a shell behind a public address stays a separate, deliberate act'
)

/* ================================================================== phase 4
 *
 * Switched on: it binds, and it publishes.
 */

console.log('\nturning it on')

// The Companion signs back in — as the other account, again. This is the case
// the old arrangement refused outright: a desktop where Forge Web has a session
// of its own *and* another feature holds a different one. What has to happen
// now is that Forge Web publishes under its own uid and takes no notice.
store.setSettings({ companionEnabled: true, companionUid: COMPANION_UID, companionRefreshToken: 'companion-refresh-token' })

const started = await invoke('web:start')

log(started.enabled === true, 'the setting was written')
log(started.state === 'listening', `and it is listening (${started.state})`)
log((await portOpen(PORT)) === true, `the port answers on ${PORT}`)
log(started.url === `wss://${HOSTNAME}${WEB_WS_PATH}`, `the address it hands out is right (${started.url})`)
log(started.tunnel.state === 'configured', `the tunnel reads configured (${started.tunnel.state})`)

await waitFor(() => dbCalls('PUT', `/users/${UID}/host.json`).length > 0, 4000, 'the rendezvous publish')

const published = dbCalls('PUT', `/users/${UID}/host.json`)[0]
log(published.body?.host === HOSTNAME, `the record names the tunnel hostname (${published.body?.host})`)
log(published.body?.proto === WEB_PROTO, `and the protocol it speaks (${published.body?.proto})`)
log(
  calls.some((c) => c.url.startsWith(`${TOKEN_BASE}/token`)),
  'the credential was only read once the switch was on'
)
await waitFor(() => host.webStatus().rendezvous.published === HOSTNAME, 2000, 'the published hostname')
log(host.webStatus().rendezvous.published === HOSTNAME, 'and the desktop knows what it published')
log(
  published.url.includes(`/users/${UID}/`) && dbCalls('PUT', `/users/${COMPANION_UID}/host.json`).length === 0,
  "it published under its own uid with another feature's session sitting right beside it — the case that used to refuse"
)

/* ================================================================== phase 5
 *
 * A browser this desktop has never seen, holding a good token, from anywhere.
 *
 * This phase used to revoke a connected browser and watch its socket drop. There
 * is no device list to revoke from any more — it was never a gate, since any
 * browser with a verified token for `webUid` and the PIN was admitted whether or
 * not it was on the list — so what is asserted instead is the thing that
 * replaced it: an unseen browser is let in on the account alone, the desktop
 * counts it while it is there, and nothing about it is written down. What ends
 * access now is the unlock PIN below and signing Forge Web out, both of which
 * later phases drive.
 */

console.log('\na browser this desktop has never seen')

const first = await browser('never-seen-before', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(first, 'hello-ok') || first.closed !== null, 4000, 'the first browser to be let in')

log(Boolean(frameOf(first, 'hello-ok')), 'a browser with a valid token is let in without ever having been approved')
log(host.webStatus().connected === 1, `and is counted as connected while it is there (${host.webStatus().connected})`)
log(
  !JSON.stringify(store.getSettings()).includes('never-seen-before'),
  'and settings.json is not given a row for it — there is no list to accumulate one'
)

first.socket.close()
await waitFor(() => host.webStatus().connected === 0, 2000, 'the connection count to fall')
log(host.webStatus().connected === 0, 'and the count falls again when it hangs up')

/* ================================================================== phase 5a
 *
 * The folder browser, and the project it adds.
 *
 * The one part of Forge Web that reads this machine's disk on a browser's say-so
 * — so it is driven the way a browser drives it: real `request` frames down a
 * real socket into the real `electron/web-host.ts`, against a real directory
 * tree made below inside the sandbox. Nothing here is a unit test of
 * `listFolder`; what is being proved is the whole route, including the two
 * things it must refuse and the ceiling it must not exceed.
 *
 * The refusals are the point of the phase. Every path here arrives off a socket,
 * and a picker is a thing somebody clicks around in — so a relative path, a
 * `..`, a folder that has gone and a file where a folder was are all ordinary
 * events, and each of them has to come back as a *sentence on the same rid*
 * rather than as a throw. A rejected promise inside the host would settle
 * nothing, and the browser would be left holding a request forever.
 */

console.log('\nbrowsing this desktop’s folders from a browser')

const { MAX_FS_ENTRIES } = await import('../electron/web/fs-browse.ts')

/* A small tree with one of each thing the picker has to draw: a repository, a
 * plain folder, and a file. */
const browseDir = join(dataDir, 'browse')
mkdirSync(join(browseDir, 'alpha', '.git'), { recursive: true })
mkdirSync(join(browseDir, 'beta'), { recursive: true })
writeFileSync(join(browseDir, 'notes.txt'), 'not a folder')

/* And one folder with more in it than an answer may carry. Made three past the
 * ceiling rather than ten thousand: what is being tested is that the cap is
 * applied and confessed, and building fifty thousand directories to prove it
 * would only be testing NTFS. */
const manyDir = join(dataDir, 'many')
for (let i = 0; i < MAX_FS_ENTRIES + 3; i++) mkdirSync(join(manyDir, `d${String(i).padStart(4, '0')}`), { recursive: true })

const picker = await browser('browser-picker', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(picker, 'hello-ok') || picker.closed !== null, 4000, 'the browser that will do the picking')
log(Boolean(frameOf(picker, 'hello-ok')), 'a browser is let in to do the picking')

let rid = 0
const ask = async (body) => {
  const id = `pick-${++rid}`
  picker.socket.send(JSON.stringify({ type: 'request', rid: id, body }))
  await waitFor(() => picker.frames.some((f) => f.type === 'result' && f.rid === id), 8000, `the result for ${id}`)
  return picker.frames.find((f) => f.type === 'result' && f.rid === id).body
}

const roots = await ask({ kind: 'fs-list', path: '' })
log(roots.kind === 'folder' && roots.folder.path === '', 'an empty path is answered with the drive roots rather than with a guess')
log(
  roots.kind === 'folder' && roots.folder.entries.every((e) => e.dir) && roots.folder.entries.length > 0,
  `and every root is a folder the picker can open (${roots.kind === 'folder' ? roots.folder.entries.length : 0})`
)
log(
  roots.kind === 'folder' && roots.folder.sep === sep,
  `the answer carries this desktop’s own separator (${roots.kind === 'folder' ? JSON.stringify(roots.folder.sep) : '?'}), so the browser never has to guess at one`
)
log(roots.kind === 'folder' && roots.folder.crumbs.length === 0, 'and nothing above the roots, because there is nothing above them')

const listed = await ask({ kind: 'fs-list', path: browseDir })
const names = listed.kind === 'folder' ? listed.folder.entries.map((e) => e.name) : []
log(listed.kind === 'folder' && listed.folder.path === browseDir, `a real folder comes back resolved (${browseDir})`)
log(
  names.join(',') === 'alpha,beta,notes.txt',
  `with folders before files, in name order (${names.join(', ')})`
)
log(
  listed.kind === 'folder' && listed.folder.entries[0].repo === true && listed.folder.entries[1].repo === false,
  'and the one with a .git in it is flagged, so a project stands out from the folder above it'
)
log(
  listed.kind === 'folder' && listed.folder.entries[2].dir === false,
  'a file is named but is not something to open'
)
log(
  listed.kind === 'folder' &&
    listed.folder.crumbs.at(-1)?.path === browseDir &&
    listed.folder.crumbs.at(-1)?.name === 'browse' &&
    listed.folder.crumbs[0].path === parsePath(browseDir).root,
  'the breadcrumb is built on the desktop, root first, each step carrying the path to send back for it'
)

const descended = await ask({ kind: 'fs-list', path: browseDir, name: 'alpha' })
log(
  descended.kind === 'folder' && descended.folder.path === join(browseDir, 'alpha'),
  'a name is appended by the desktop, so the browser never joins two strings and calls the result a path'
)

const capped = await ask({ kind: 'fs-list', path: manyDir })
log(
  capped.kind === 'folder' && capped.folder.entries.length === MAX_FS_ENTRIES,
  `a folder of ${MAX_FS_ENTRIES + 3} is cut to the ${MAX_FS_ENTRIES} one answer carries (${capped.kind === 'folder' ? capped.folder.entries.length : 0})`
)
log(capped.kind === 'folder' && capped.folder.truncated === true, 'and says so, rather than quietly describing a smaller folder')

const relative = await ask({ kind: 'fs-list', path: 'scripts' })
log(
  relative.kind === 'failed' && relative.message.length > 0,
  `a relative path is refused with a sentence rather than resolved against wherever Forge was started ("${relative.message ?? ''}")`
)
const dotdot = await ask({ kind: 'fs-list', path: browseDir, name: '..' })
log(dotdot.kind === 'failed', `".." is not a folder name this desktop appends ("${dotdot.message ?? ''}")`)

const gone = await ask({ kind: 'fs-list', path: join(browseDir, 'never-existed') })
log(
  gone.kind === 'failed' && gone.message.includes('not there'),
  `a folder that is not there comes back as a sentence, not a crash ("${gone.message ?? ''}")`
)
const notAFolder = await ask({ kind: 'fs-list', path: join(browseDir, 'notes.txt') })
log(
  notAFolder.kind === 'failed' && notAFolder.message.includes('file'),
  `and so does a file where a folder was ("${notAFolder.message ?? ''}")`
)

const stillAlive = await ask({ kind: 'fs-list', path: browseDir })
log(stillAlive.kind === 'folder', 'and the socket is still good after all four refusals — none of them threw')

/* ------------------------------------------------- and adding one, for real
 *
 * `project-add` goes to the renderer, because the renderer owns the project
 * list. So the two things worth proving are that it *does* — the window below
 * records what it is handed — and that the folder is checked before the
 * renderer hears anything, which is what the file and the relative path assert.
 */

const noWindowAdd = await ask({ kind: 'project-add', path: browseDir })
log(
  noWindowAdd.kind === 'failed' && noWindowAdd.message.includes('no window'),
  `with no window on the desktop there is nothing that owns the rail, and the browser is told so ("${noWindowAdd.message ?? ''}")`
)

const added = []
globalThis.__forgeWindows = [
  {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (channel !== IPC.webProjectAdd) return
        added.push(payload)
        // The renderer's half, in one line: it is the thing that answers, and
        // until it does the request is still in flight on the main side.
        ipc.listeners.get(IPC.webCommandResult)({}, { requestId: payload.requestId, error: '' })
      }
    }
  }
]

const addedOk = await ask({ kind: 'project-add', path: browseDir })
log(addedOk.kind === 'ok', `a folder that is really there is added (${addedOk.kind})`)
log(
  added.length === 1 && added[0].path === browseDir,
  'and it reached the renderer — which owns the project list — rather than being written from main behind its back'
)

const addedFile = await ask({ kind: 'project-add', path: join(browseDir, 'notes.txt') })
log(addedFile.kind === 'failed' && addedFile.message.includes('file'), `a file is not a project ("${addedFile.message ?? ''}")`)
const addedRelative = await ask({ kind: 'project-add', path: 'browse' })
log(addedRelative.kind === 'failed', `and neither is a relative path ("${addedRelative.message ?? ''}")`)
log(added.length === 1, 'neither of which the renderer was ever told about: the folder is checked before anything is asked of it')

/* ------------------------------------------- and creating one from a name
 *
 * `project-create` is a name and an allow-list key, never a path — the same
 * fence the desk's form and the voice agent go through
 * (electron/projectfolder.ts). The stubbed `app.getPath` points every root at
 * the sandbox, so what is being proved is the route: the folder appears on
 * disk, the renderer is the thing told to add it, a duplicate is refused with
 * its path attached rather than adopted, and a name the fence rejects never
 * becomes a mkdir.
 */

const madePath = join(dataDir, 'web-made')
const made = await ask({ kind: 'project-create', name: 'web-made', parentDir: 'desktop' })
log(made.kind === 'ok', `a name and a key become a folder and a rail entry in one act (${made.kind})`)
log(existsSync(madePath), 'the folder is really on disk')
log(
  added.length === 2 && added[1].path === madePath,
  'and the renderer was handed exactly that path — creation takes the same road into the rail as picking'
)

const madeAgain = await ask({ kind: 'project-create', name: 'web-made', parentDir: 'desktop' })
log(
  madeAgain.kind === 'project-exists' && madeAgain.path === madePath,
  `the same name again is refused with the path attached, so "open it instead" stays an explicit act ("${madeAgain.message ?? ''}")`
)
log(added.length === 2, 'and the renderer never heard about the refusal')

const madeReserved = await ask({ kind: 'project-create', name: 'NUL', parentDir: 'desktop' })
log(
  madeReserved.kind === 'failed' && !existsSync(join(dataDir, 'NUL')),
  `a reserved Windows name is refused by the fence before any mkdir ("${madeReserved.message ?? ''}")`
)
const madeDots = await ask({ kind: 'project-create', name: '..', parentDir: 'desktop' })
log(madeDots.kind === 'failed', `and ".." is not a folder name at all ("${madeDots.message ?? ''}")`)

globalThis.__forgeWindows = []

const noWindowMake = await ask({ kind: 'project-create', name: 'web-orphan', parentDir: 'desktop' })
log(
  noWindowMake.kind === 'failed' && noWindowMake.message.includes('no window'),
  `with no window the refusal comes before the mkdir ("${noWindowMake.message ?? ''}")`
)
log(!existsSync(join(dataDir, 'web-orphan')), 'so no folder is left behind that no rail entry ever pointed at')
picker.socket.close()
await waitFor(() => host.webStatus().connected === 0, 4000, 'the picking browser to go')

/* ================================================================== phase 5b
 *
 * The unlock PIN, through the real host and over a real socket.
 *
 * `scripts/web-auth-check.mjs` proves the decision and every refusal; what only
 * this file can prove is the *lifecycle* — that the two IPC calls the settings
 * panel makes write what they claim, that only a hash reaches the file, and
 * that a browser holding no PIN is turned away by the server rather than merely
 * by the class.
 */

console.log('\nthe unlock PIN')

// Eight digits rather than four, so "these digits are not in settings.json" is
// a claim about this PIN rather than about a run of digits that could turn up
// inside a timestamp by luck.
const PIN = '81547309'

log(store.getSettings().webPin === '', 'the desktop ships with no PIN — the account alone is the key')
log(host.webStatus().pinSet === false, 'and the panel is told so')

const shipped = await browser('browser-2', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(shipped, 'hello-ok') || shipped.closed !== null, 4000, 'the browser on the shipped door')
log(Boolean(frameOf(shipped, 'hello-ok')), 'so a browser signed in as this account gets in without one')
shipped.socket.close()
await waitFor(() => host.webStatus().connected === 0, 4000, 'that browser to go')

const badPin = await invoke('web:pin-set', '12ab')
log(typeof badPin.error === 'string' && badPin.error.length > 0, `something that is not a PIN is refused with a sentence ("${badPin.error ?? ''}")`)
log(store.getSettings().webPin === '', 'and nothing is written')

const pinSet = await invoke('web:pin-set', PIN)
log(pinSet.pinSet === true, 'a real PIN is accepted, and the panel is told the door has one')
log(store.getSettings().webPin.startsWith('scrypt$1$'), 'what reaches settings is the versioned scrypt string')

const pinOnDisk = readFileSync(join(dataDir, 'settings.json'), 'utf8')
log(!pinOnDisk.includes(PIN), 'the PIN itself is nowhere in settings.json')
log(pinOnDisk.includes('scrypt$1$'), 'only its hash is, which is the whole point of hashing it')

const noPin = await browser('browser-2', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => noPin.closed !== null, 4000, 'the browser with no PIN to be turned away')
log(frameOf(noPin, 'refused')?.reason === 'pin-required', 'a browser with no PIN is refused over the wire, not let in')
log(!frameOf(noPin, 'hello-ok'), 'and never sees the opening picture')

const wrongPin = await browser('browser-2', { origin: `https://${PROJECT}.web.app`, pin: '00000000' })
await waitFor(() => wrongPin.closed !== null, 4000, 'the browser with a wrong PIN')
log(frameOf(wrongPin, 'refused')?.reason === 'pin-invalid', 'and a wrong one is refused pin-invalid')

const withPin = await browser('browser-2', { origin: `https://${PROJECT}.web.app`, pin: PIN })
await waitFor(() => frameOf(withPin, 'hello-ok') || withPin.closed !== null, 4000, 'the browser with the PIN')
log(Boolean(frameOf(withPin, 'hello-ok')), 'a browser presenting the right PIN is let in')
withPin.socket.close()
await waitFor(() => host.webStatus().connected === 0, 4000, 'that browser to go')

const afterClear = await invoke('web:pin-clear')
log(afterClear.pinSet === false, 'clearing it puts the panel back to no PIN')
log(store.getSettings().webPin === '', 'and leaves nothing behind in settings.json')

const afterCleared = await browser('browser-2', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(afterCleared, 'hello-ok') || afterCleared.closed !== null, 4000, 'the browser after the PIN went')
log(Boolean(frameOf(afterCleared, 'hello-ok')), 'and browsers are admitted on the account alone again')
afterCleared.socket.close()
await waitFor(() => host.webStatus().connected === 0, 4000, 'that browser to go')

/* ================================================================== phase 6
 *
 * Switched off: the browsers are told first, the record is retracted, the port
 * goes.
 */

console.log('\nturning it off again')

const second = await browser('browser-2', { origin: `https://${PROJECT}.firebaseapp.com` })
await waitFor(() => frameOf(second, 'hello-ok') || second.closed !== null, 4000, 'the second browser')
log(Boolean(frameOf(second, 'hello-ok')), 'a second browser is live')

const stopped = await invoke('web:stop')
await waitFor(() => second.closed !== null, 4000, 'the socket to close')

const shutdown = frameOf(second, 'shutdown')
log(shutdown?.reason === 'disabled', `every browser was told the desk is going (${shutdown?.reason})`)
log(
  second.frames.indexOf(shutdown) < second.framesAtClose,
  'and told before the socket closed, not after'
)
log(stopped.state === 'off', `the link reads off (${stopped.state})`)
log((await portOpen(PORT)) === false, 'the port is gone')
log(dbCalls('DELETE', `/users/${UID}/host.json`).length === 1, 'the rendezvous record was cleared, not left to rot')
log(host.webStatus().rendezvous.published === '', 'and the desktop knows it published nothing')

const callsAfterStop = calls.length
await sleep(400)
log(calls.length === callsAfterStop, `nothing keeps talking after the switch (${calls.length - callsAfterStop} more)`)

/* ================================================================== phase 7
 *
 * The origin allowlist. The claim is that no production address is written down
 * in the source — so the proof is that moving the project id moves every origin.
 */

console.log('\nthe origin allowlist')

const forProject = host.webAllowedOrigins()
log(
  forProject.includes(`https://${PROJECT}.web.app`) && forProject.includes(`https://${PROJECT}.firebaseapp.com`),
  'both Firebase Hosting domains for the configured project are allowed'
)

store.setSettings({ webProjectId: OTHER_PROJECT })
const forOther = host.webAllowedOrigins()
log(
  forOther.includes(`https://${OTHER_PROJECT}.web.app`) && !forOther.some((o) => o.includes(PROJECT)),
  'renaming the project renames every origin — none of them is fixed in the source'
)

/*
 * The site, which is not the project — and this is the assertion that was
 * missing when Forge Web shipped.
 *
 * Everything above proves the origins move with the *project id*, and every one
 * of them passed while no browser could connect at all, because a Firebase
 * project may host any number of sites and only the first is named after it.
 * `.firebaserc` below is read rather than restated so this cannot agree with a
 * deployment that has moved: it names the site `npm run web:deploy` actually
 * publishes to, and the claim is that a desktop configured for this repo's
 * deployment admits the page that deployment serves.
 */
store.setSettings({ webProjectId: PROJECT, webSiteId: SITE })
const forSite = host.webAllowedOrigins()
log(
  forSite.includes(`https://${SITE}.web.app`) && forSite.includes(`https://${SITE}.firebaseapp.com`),
  `a named Hosting site is served, not only the project (${SITE})`
)
log(
  forSite.includes(`https://${PROJECT}.web.app`),
  'and naming one does not stop serving the project’s own site, which the Companion is'
)

if (DEPLOY_SITE) {
  store.setSettings({ webProjectId: DEPLOY_PROJECT, webSiteId: DEPLOY_SITE })
  const forDeploy = host.webAllowedOrigins()
  log(
    forDeploy.includes(`https://${DEPLOY_SITE}.web.app`),
    `the site this repo deploys to is one this desktop would admit (https://${DEPLOY_SITE}.web.app)`
  )
  log(
    DEPLOY_SITE === DEPLOY_PROJECT || !host.webAllowedOrigins.toString().includes(DEPLOY_SITE),
    'and it is admitted because .firebaserc says so, not because the name is written into the source'
  )
} else {
  // Not a failure. `.firebaserc` is gitignored — it names somebody's own
  // project and sites — so a fresh clone and CI both have every right to be
  // without one. Said out loud rather than skipped silently, because "this
  // check did not run" and "this check passed" must not look the same.
  console.log('--    no .firebaserc here, so the real deployment’s site was not checked (nothing has been deployed yet)')
}

store.setSettings({ webProjectId: PROJECT, webSiteId: '' })
const siteless = host.webAllowedOrigins()
log(
  siteless.includes(`https://${PROJECT}.web.app`) && !siteless.some((o) => o.includes(SITE)),
  'a blank site falls back to the project, which is what a single-site project has'
)

// There is no unconfigured desktop any more: clearing the project id lands on
// the deployment Forge ships in its defaults (WEB_DEFAULT_* in
// electron/store.ts), so a fresh install admits the real Forge Web page with
// nothing pasted. What must still be true is that the fallback is *the shipped
// deployment* — a cleared field must never degrade to admitting everywhere or
// to admitting nothing, both of which this phase used to be able to say when
// blank meant blank.
store.setSettings({ webProjectId: '', webSiteId: '' })
const cleared = host.webAllowedOrigins()
log(
  cleared.includes(`https://${store.WEB_DEFAULT_SITE_ID}.web.app`),
  `a cleared desktop falls back to the shipped deployment (https://${store.WEB_DEFAULT_SITE_ID}.web.app)`
)
log(
  cleared.every(
    (o) =>
      [store.WEB_DEFAULT_SITE_ID, store.WEB_DEFAULT_PROJECT_ID].some(
        (name) => o === `https://${name}.web.app` || o === `https://${name}.firebaseapp.com`
      ) ||
      o.startsWith('http://localhost') ||
      o.startsWith('http://127.0.0.1')
  ),
  'and admits nothing beyond that deployment and the dev loop of this unpackaged run'
)

process.env['FORGE_WEB_ORIGINS'] = 'https://forge.example.test, https://second.example.test'
const overridden = host.webAllowedOrigins()
log(
  overridden.includes('https://forge.example.test') && overridden.includes('https://second.example.test'),
  'a custom domain is configured rather than committed'
)

/* ================================================================== phase 8
 *
 * What signing in actually wrote down.
 *
 * Read back off disk rather than out of the settings cache, the way
 * scripts/mobile-auth-check.mjs proves the phone's token hashes: the promise is
 * about the *file*, and a getter can agree with the promise while the file on
 * disk disagrees with both. The password was used for one POST and dropped; the
 * ID token expires in an hour and is minted again from the refresh token
 * whenever it is needed; the refresh token is the one credential worth storing,
 * because Steve can revoke it from the Firebase console without touching a
 * password he uses anywhere else.
 */

console.log('\nwhat reached the disk')

const settingsOnDisk = readFileSync(join(dataDir, 'settings.json'), 'utf8')
const saved = JSON.parse(settingsOnDisk)

log(!settingsOnDisk.includes(WEB_PASSWORD), 'settings.json does not contain the password')
log(issuedIdToken !== '' && !settingsOnDisk.includes(issuedIdToken), 'nor the ID token the sign-in came back with')
log(!/"eyJ[A-Za-z0-9_-]/.test(settingsOnDisk), 'nor anything else JWT-shaped, in any field')
log(saved.webRefreshToken === WEB_REFRESH, 'what it holds is the refresh token — revocable, and revocable alone')
log(saved.webUid === UID, "and Forge Web's own uid, in Forge Web's own field")
log(
  saved.companionUid === COMPANION_UID && saved.companionRefreshToken === 'companion-refresh-token',
  "with the Companion's own fields untouched beside them"
)
log(
  saved.webRefreshToken !== saved.companionRefreshToken && saved.webUid !== saved.companionUid,
  'and holding a different account entirely — two sessions on one desktop, sharing nothing but a provider'
)
// The browsers phase 5 and 5b let in wrote nothing, and the key they used to
// write into is not one this store knows any more — so an upgrading desktop's
// list is dropped on load rather than carried forward. Asserted against the
// file, because a stale row nobody can see is exactly the kind that survives.
log(saved.webDevices === undefined, 'and no list of admitted browsers, however many have been let in by now')

/* ================================================================== phase 9
 *
 * The tunnel Forge Web reaches for by itself: a cloudflared quick tunnel.
 *
 * `FORGE_WEB_HOSTNAME` goes first, because with it set nothing below would
 * prove anything — an environment variable would be answering every question
 * the supervisor is supposed to answer. What is exercised from here is the real
 * `CloudflareTunnel`, started by the real `web-host.ts`, against a scripted
 * process.
 *
 * This transport is the default because ngrok's free plan allows one online
 * endpoint per account, so Forge Web's agent and Forge Mobile's could not both
 * be up — a live bug, not a preference. What it costs is a different hostname
 * on every start, and the middle of this phase is the assertion that the cost
 * is already paid for: a tunnel is killed while live on one address, comes back
 * on another, and the browser is told the new one.
 */

console.log('\nthe tunnel: cloudflared, the default')

delete process.env['FORGE_WEB_HOSTNAME']
store.setSettings({ webProjectId: PROJECT, webTunnel: 'cloudflared' })

const putsBeforeCf = dbCalls('PUT', `/users/${UID}/host.json`).length

await invoke('web:start')
await waitFor(() => agents.length > 0, 4000, 'the cloudflared agent to be spawned')
const cfAgent = agents.at(-1)

log(
  JSON.stringify(cfAgent.args) === JSON.stringify(['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate']),
  `the agent forwards to Forge Web's own loopback port and nothing else (${cfAgent.args.join(' ')})`
)
log(
  !cfAgent.args.some((a) => /token|auth|domain/i.test(String(a))),
  'with no credential on the command line, because this transport has none'
)
log(host.webStatus().tunnel.state === 'starting', `the panel reads starting (${host.webStatus().tunnel.state})`)
log(host.webStatus().tunnel.host === '', 'and hands out no hostname yet, because there is not one yet')
await sleep(300)
log(
  dbCalls('PUT', `/users/${UID}/host.json`).length === putsBeforeCf,
  'nothing is published while the tunnel is still coming up'
)

/* ------------------------------------------- the door that stays shut */

// Taken first, while nothing has been published, because a flag parser speaks
// at startup and that is the only permanent refusal this transport has: there
// is no credential to reject. Retrying it buys nothing but the same sentence at
// sixty-second intervals, so the supervisor must stop and repeat what it was
// told rather than translate it into an instruction nobody can act on.
cfAgent.say('Incorrect Usage. flag provided but not defined: -nope')
cfAgent.die(1)
await waitFor(() => host.webStatus().tunnel.state === 'error', 8000, 'the refusal to be reported')

const cfDead = host.webStatus()
log(cfDead.tunnel.state === 'error', `a refused agent reads error, not live (${cfDead.tunnel.state})`)
log(
  /flag provided but not defined/.test(cfDead.tunnel.detail),
  `with cloudflared's own complaint in it ("${cfDead.tunnel.detail}")`
)
log(cfDead.tunnel.host === '' && cfDead.url === '', 'and no stale address is handed to anybody')
log(
  dbCalls('PUT', `/users/${UID}/host.json`).length === putsBeforeCf,
  'and a tunnel that never came up advertised nothing on the way down'
)

/* --------------------------------------- and now one that actually works */

// Switching off and on is the deliberate retry a permanent refusal asks for.
const cfAgentsBeforeRetry = agents.length
await invoke('web:stop')
await invoke('web:start')
await waitFor(() => agents.length > cfAgentsBeforeRetry, 4000, 'a second cloudflared agent')
const cfLive = agents.at(-1)

cfLive.say(cfBanner(CF_HOST_ONE))
await waitFor(() => host.webStatus().tunnel.state === 'live', 4000, 'the quick tunnel to go live')

log(host.webStatus().tunnel.host === CF_HOST_ONE, `the address in the banner is the one the panel shows (${host.webStatus().tunnel.host})`)
log(host.webStatus().url === `wss://${CF_HOST_ONE}${WEB_WS_PATH}`, `and the address it hands out is the tunnel's (${host.webStatus().url})`)

await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host === CF_HOST_ONE,
  20_000,
  'the quick tunnel hostname to be published'
)
log(
  dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host === CF_HOST_ONE,
  `the tunnel's own hostname reaches the rendezvous record (${dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host})`
)

/* ------------------------------ the case this transport is chosen despite */

// A quick tunnel is anonymous: the address is handed back when the process ends
// and a different one is issued to the next. So the agent is killed while live,
// and what has to happen — without anybody touching Settings — is that the
// record stops naming the dead address and starts naming the new one. This is
// the whole reason the rendezvous record exists, and it is the one assertion in
// this file that could not be made against a reserved domain.
const cfAgentsBeforeFlap = agents.length
cfLive.die(1)
await waitFor(() => agents.length > cfAgentsBeforeFlap, 8000, 'the supervisor to bring it back')
const cfLive2 = agents.at(-1)
log(cfLive2 !== cfLive, 'a tunnel that dies is restarted rather than mourned')
log(host.webStatus().tunnel.host === '', 'and hands out nothing in the meantime — the old address answers for nobody now')

cfLive2.say(cfBanner(CF_HOST_TWO))
await waitFor(() => host.webStatus().tunnel.host === CF_HOST_TWO, 8000, 'the second address')
log(host.webStatus().tunnel.host === CF_HOST_TWO, `it comes back on a different address, and the panel says so (${host.webStatus().tunnel.host})`)

await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host === CF_HOST_TWO,
  20_000,
  'the new address to be republished'
)
const afterFlap = dbCalls('PUT', `/users/${UID}/host.json`).at(-1)
log(afterFlap.body?.host === CF_HOST_TWO, `the record follows it, so a browser dials the address that is live (${afterFlap.body?.host})`)
log(host.webStatus().rendezvous.published === CF_HOST_TWO, 'and the desktop knows which one it is advertising')

/* ------------------------------------------- switching the tunnel off */

// Off has to mean off: the agent goes, and so does the advertisement. A record
// left behind is up to three minutes of browsers dialling a public address that
// Steve believes he has just closed. Done here, from a record that was just
// confirmed published, so what is observed is the retraction and not a leftover.
const deletesBeforeOff = dbCalls('DELETE', `/users/${UID}/host.json`).length
store.setSettings({ webTunnel: 'off' })
host.applyWebSettings()

log(cfLive2.killed === true, 'switching the tunnel off takes the running agent down')
log(host.webStatus().tunnel.state === 'off', `and the panel reads off (${host.webStatus().tunnel.state})`)
await waitFor(
  () => dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeOff,
  20_000,
  'the record to be retracted'
)
log(
  dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeOff,
  'the published record is retracted rather than left for browsers to dial'
)
log(host.webStatus().rendezvous.published === '', 'and the desktop knows it is advertising nothing')

/* ------------------------------- the other transport is still reachable */

// The whole point of keeping ngrok: somebody who wants one steady address, and
// is content to stop the phone link to get it, changes one setting. What must
// happen is a *different agent*, on ngrok's command line, without Forge Web
// being restarted around it.
const agentsBeforeSwitch = agents.length
store.setSettings({ webTunnel: 'ngrok', webNgrokDomain: NGROK_DOMAIN, webNgrokAuthtoken: NGROK_TOKEN })
host.applyWebSettings()
await waitFor(() => agents.length > agentsBeforeSwitch, 4000, 'the ngrok agent to take over')

const switched = agents.at(-1)
log(switched.args.includes(`--url=https://${NGROK_DOMAIN}`), `switching to ngrok really runs ngrok (${switched.args.join(' ')})`)
log(switched.args.includes('--authtoken'), 'with the account this desktop was told to use')

switched.say(`{"lvl":"info","msg":"started tunnel","url":"https://${NGROK_DOMAIN}"}`)
await waitFor(() => host.webStatus().tunnel.host === NGROK_DOMAIN, 8000, 'the ngrok tunnel to go live')
await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host === NGROK_DOMAIN,
  20_000,
  'the steady address to be published'
)
log(
  dbCalls('PUT', `/users/${UID}/host.json`).at(-1)?.body?.host === NGROK_DOMAIN,
  'and the record names it, exactly as it named the quick tunnel'
)

await invoke('web:stop')

/* ================================================================= phase 9b
 *
 * The same questions asked of the ngrok supervisor, from a cold start — the
 * transport this feature shipped on, and still the right answer for anybody who
 * wants one address forever.
 */

console.log('\nthe tunnel: ngrok, for a steady address')

store.setSettings({
  webProjectId: PROJECT,
  webTunnel: 'ngrok',
  webNgrokDomain: NGROK_DOMAIN,
  webNgrokAuthtoken: NGROK_TOKEN
})

const putsBeforeTunnel = dbCalls('PUT', `/users/${UID}/host.json`).length
const deletesBeforeTunnel = dbCalls('DELETE', `/users/${UID}/host.json`).length
const agentsBeforeNgrok = agents.length

await invoke('web:start')
await waitFor(() => agents.length > agentsBeforeNgrok, 4000, 'the ngrok agent to be spawned')
const agent = agents[agents.length - 1]

log(agent.args.includes(`--url=https://${NGROK_DOMAIN}`), `the agent binds Forge Web's own domain (${NGROK_DOMAIN})`)
log(agent.args.includes(String(PORT)), `and forwards to Forge Web's own port, not the phone's (${PORT})`)
log(host.webStatus().tunnel.state === 'starting', `the panel reads starting (${host.webStatus().tunnel.state})`)
log(host.webStatus().tunnel.host === '', 'and hands out no hostname yet, because there is not one yet')
await sleep(300)
log(
  dbCalls('PUT', `/users/${UID}/host.json`).length === putsBeforeTunnel,
  'nothing is published while the tunnel is still coming up'
)

agent.say(`{"lvl":"info","msg":"started tunnel","url":"https://${NGROK_DOMAIN}"}`)
await waitFor(() => host.webStatus().tunnel.state === 'live', 4000, 'the tunnel to go live')

log(host.webStatus().tunnel.state === 'live', 'the URL in the agent’s log makes the tunnel live')
log(host.webStatus().tunnel.host === NGROK_DOMAIN, `and that is the hostname the panel shows (${host.webStatus().tunnel.host})`)
log(host.webStatus().url === `wss://${NGROK_DOMAIN}${WEB_WS_PATH}`, `the address it hands out is the tunnel's (${host.webStatus().url})`)

await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).length > putsBeforeTunnel,
  4000,
  'the tunnel hostname to be published'
)
const republished = dbCalls('PUT', `/users/${UID}/host.json`).at(-1)
log(republished.body?.host === NGROK_DOMAIN, `the tunnel's own hostname reaches the rendezvous record (${republished.body?.host})`)

// Now kill it in the one way that is terminal: ngrok refusing the authtoken.
// Retrying that buys nothing, so the supervisor stops — which means the address
// this desktop published is now an address nothing answers on.
agent.say(`{"lvl":"crit","msg":"authentication failed","err":"The authtoken you specified is properly formed, but it is invalid. ERR_NGROK_107"}`)
agent.die(1)
await waitFor(() => host.webStatus().tunnel.state === 'error', 4000, 'the dead tunnel to be reported')

const dead = host.webStatus()
log(dead.tunnel.state === 'error', `a tunnel that dies reads error, not live (${dead.tunnel.state})`)
log(/authtoken/i.test(dead.tunnel.detail), `with ngrok's own complaint in it ("${dead.tunnel.detail}")`)
log(dead.tunnel.detail.includes('Settings › Forge Web'), 'pointing at Forge Web’s card, not the phone’s')
log(!dead.tunnel.detail.includes(NGROK_TOKEN), 'and never repeating the authtoken back')
log(dead.tunnel.host === '' && dead.url === '', 'no stale address is handed to anybody')

// A generous window on purpose: `WebRendezvous` floors hostname-driven
// republishes at MIN_REPUBLISH_MS so a flapping tunnel cannot write once a
// second, and a retraction is a republish like any other.
await waitFor(
  () => dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeTunnel,
  10_000,
  'the stale record to be retracted'
)
log(
  dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeTunnel,
  'and the published record is retracted rather than left for browsers to dial'
)
log(host.webStatus().rendezvous.published === '', 'the desktop knows it is advertising nothing')

await invoke('web:stop')

// The agent above is already gone — a permanent refusal is a process that
// exited — so it can prove nothing about teardown. Bring a *live* one up and
// switch the link off underneath it, which is the case that matters: a stranded
// ngrok agent holds one of the account's three sessions open, and Forge Mobile
// is the thing that then cannot start.
const agentsBeforeRestart = agents.length
const putsBeforeRestart = dbCalls('PUT', `/users/${UID}/host.json`).length
await invoke('web:start')
await waitFor(() => agents.length > agentsBeforeRestart, 4000, 'a second ngrok agent')
const liveAgent = agents.at(-1)
liveAgent.say(`{"lvl":"info","msg":"started tunnel","url":"https://${NGROK_DOMAIN}"}`)
await waitFor(() => host.webStatus().tunnel.state === 'live', 4000, 'the second tunnel to go live')
await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).length > putsBeforeRestart,
  10_000,
  'the address to be published again'
)

/* ================================================================= phase 10
 *
 * Signing out, while everything is up and publishing.
 *
 * The hard part is not stopping — it is stopping *in the right order*. The
 * record is written under the uid of the session that is about to be thrown
 * away, so clearing the credential first would leave this desktop's address in
 * the database with nothing left able to reach in and take it back.
 */

console.log('\nsigning out with the link live')

const deletesBeforeSignOut = dbCalls('DELETE', `/users/${UID}/host.json`).length
const signedOutStatus = await invoke('web:sign-out')

log(
  dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeSignOut,
  'signing out retracts the published record rather than leaving it to go stale'
)
log(signedOutStatus.rendezvous.published === '', 'and the desktop knows it is advertising nothing')
log(signedOutStatus.session.signedIn === false, 'the session is gone')
log(signedOutStatus.configured === false, 'so the desktop reports itself unconfigured again')
log(/sign(ed)? in/i.test(signedOutStatus.session.detail), `with the sentence back ("${signedOutStatus.session.detail}")`)
log(signedOutStatus.session.email === WEB_EMAIL, 'while the email survives, so the form pre-fills')

const putsAfterSignOut = dbCalls('PUT', `/users/${UID}/host.json`).length
await sleep(600)
log(
  dbCalls('PUT', `/users/${UID}/host.json`).length === putsAfterSignOut,
  'and nothing publishes again on the next heartbeat'
)

const signedOutOnDisk = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
log(
  signedOutOnDisk.webRefreshToken === '' && signedOutOnDisk.webUid === '',
  'the credential and the uid are gone from settings.json too, not just from memory'
)
log(signedOutOnDisk.webEmail === WEB_EMAIL, 'and the email is what is left behind')

/* ------------------------------------------------- and the link goes down */

await invoke('web:stop')
log(liveAgent.killed === true, 'switching Forge Web off takes a live agent down with it')
log(host.webStatus().tunnel.state === 'off', `and the panel reads off (${host.webStatus().tunnel.state})`)

/* ================================================================= phase 11
 *
 * Closing the window.
 *
 * This is the assertion docs/forge-web.md's "honest limitation" rests on, and
 * until electron/tray.ts existed the document was simply wrong about it:
 * "closing the Forge **window** must not end the session … Only a genuine
 * power-off or reboot drops the browser to GitHub-only mode." Closing the window
 * closed the last window, `window-all-closed` quit the app, and the before-quit
 * chain retracted the record, killed the tunnel, hung up on every browser and
 * took every PTY with it.
 *
 * Everything below drives the *shipped* decision — `handleWindowClose` in
 * electron/tray.ts, given the same narrow slice of a window electron/main.ts
 * hands it — and then watches from outside, exactly as the earlier phases do:
 * a TCP connect for the listener, the fake RTDB for the record, the live socket
 * for the browser, and a real pwsh answering a string that only ever existed in
 * its own output for the pane. "The port is still open" is not the claim being
 * tested; "the session survived" is.
 */

console.log('\nclosing the window with Forge Web on')

const tray = await import('../electron/tray.ts')
const ptyHost = await import('../electron/pty-host.ts')

/**
 * Forge's window, as far as this file needs one.
 *
 * `TrayWindow` is three methods wide on purpose — that is the whole of what the
 * close decision touches — so the code being exercised here is the code that
 * ships rather than a copy of it.
 */
function fakeWindow() {
  const win = {
    visible: true,
    destroyed: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    hide: () => {
      win.visible = false
    }
  }
  return win
}

let copied = ''
let quitRan = false
let quitPromise = Promise.resolve()
let opened = 0
let window = fakeWindow()

tray.setTrayHost({
  open: () => {
    opened++
    window.visible = true
  },
  quit: () => {
    quitRan = true
    // What electron/main.ts does on this click, minus the window it does not
    // have here: raise the flag that stops the next close being absorbed, then
    // run the disposer this feature owns in the before-quit chain.
    tray.noteQuitting()
    quitPromise = host.disposeWeb()
  },
  status: () => host.webStatus(),
  copy: (text) => {
    copied = text
  },
  iconFile: 'icon.ico'
})
// The seam main.ts hangs the tray on, wired here for the same reason it is
// wired there: `web:start` and `web:stop` never reach a settings handler, and
// an icon that disagrees with the link is worse than no icon.
host.setWebStatusListener(tray.syncTray)

/* --------------------------------------- back on its feet, and publishing */

await invoke('web:sign-in', WEB_EMAIL, WEB_PASSWORD)
const agentsBeforeClose = agents.length
const putsBeforeClose = dbCalls('PUT', `/users/${UID}/host.json`).length
await invoke('web:start')
await waitFor(() => agents.length > agentsBeforeClose, 4000, 'an ngrok agent for the close phase')
const closeAgent = agents.at(-1)
closeAgent.say(`{"lvl":"info","msg":"started tunnel","url":"https://${NGROK_DOMAIN}"}`)
await waitFor(() => host.webStatus().tunnel.state === 'live', 4000, 'the tunnel for the close phase')
await waitFor(
  () => dbCalls('PUT', `/users/${UID}/host.json`).length > putsBeforeClose,
  10_000,
  'the address to be published for the close phase'
)

/* ------------------------------------- a real pane, and a real browser on it */

const pane = ptyHost.getManager().create({ id: 'tray-1', cwd: process.cwd(), cols: 90, rows: 30 })
log(pane.ok === true, `a real shell is running before the window closes (${pane.ok ? pane.id : pane.error})`)
// The *prompt*, not the first byte: a shell that has printed something is not a
// shell that is ready to be typed at, which is the whole flaky-test story.
await waitFor(() => ptyHost.getReplay('tray-1').includes('> '), 25_000, 'the first prompt')

const held = await browser('browser-2', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(held, 'hello-ok') || held.closed !== null, 4000, 'the browser that will hold the socket')
log(Boolean(frameOf(held, 'hello-ok')), 'and a browser is attached to this desktop')

const sendFrame = (tab, frame) => tab.socket.send(JSON.stringify(frame))
const textFor = (tab, id) =>
  tab.frames
    .filter((f) => (f.type === 'data' || f.type === 'replay') && f.sessionId === id)
    .map((f) => f.data)
    .join('')

/**
 * Answer the shell's "where is the cursor?", which a real browser's xterm does
 * and a raw socket does not.
 *
 * pwsh asks `CSI 6 n` hardest right after a resize, because PSReadLine has to
 * know where its line begins before it can repaint — and with nothing
 * answering, ConPTY waits out a timeout measured in tens of seconds, during
 * which the pane accepts input and prints nothing. That is not a detail of the
 * resize below; it is what makes the resize below testable at all.
 * scripts/web-smoke.mjs answers the same question for the same reason, and only
 * live output is scanned: electron/pty/replay.ts is careful that a *replay*
 * never carries these questions, precisely so they are not answered twice.
 */
held.socket.on('message', (raw) => {
  const frame = JSON.parse(String(raw))
  if (frame.type !== 'data' || frame.sessionId !== 'tray-1') return
  const asked = String(frame.data).match(/\x1b\[6n/g)
  for (let i = 0; i < (asked?.length ?? 0); i++) ptyHost.getManager().write('tray-1', '\x1b[1;1R')
})

/* -------------------------------------------- one PTY, several viewers
 *
 * The desktop and a browser are two viewers of one ConPTY, which has one width.
 * The rule is that the width **follows the typist**: the grid belongs to the
 * device somebody last typed into the pane on, and every other viewer — the desk
 * included — draws that grid font-scaled. Reading a pane from anywhere changes
 * nothing anywhere.
 *
 * This file is the only check that can drive the *whole* of that: the real
 * registry, the real host, the real IPC handlers electron/main.ts registers, and
 * a real browser on a real socket. So both directions are asserted here, and so
 * is the message the desktop renderer needs in order to be a follower at all.
 *
 * Two separate messages reach the renderer and they must stay separate. The
 * watch list (`IPC.webWatched`) carries ids and no geometry, because reading is
 * not typing; the geometry (`IPC.ptyGeometry`) carries the real grid and who
 * owns it, and only moves when somebody actually types.
 */

const watched = []
globalThis.__forgeWindows = [
  {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (channel === IPC.webWatched) watched.push(payload)
      }
    }
  }
]

/*
 * The desk's own half, through the handlers electron/main.ts registers rather
 * than through the registry directly: `IPC.ptyWrite` is what a keystroke in
 * src/lib/terminals.ts reaches, and `IPC.ptyResize` is what a settled fit
 * reaches. Driving those is what makes this phase about the shipped wiring.
 */
ptyHost.registerPtyHandlers()
const deskTyped = (id, data) => ipc.listeners.get(IPC.ptyWrite)({}, id, data)
const deskWished = (id, cols, rows) => ipc.listeners.get(IPC.ptyResize)({}, id, cols, rows)

/** Every `IPC.ptyGeometry` the renderer was sent, in order. */
const geometries = []
ptyHost.setPtyTarget({
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      if (channel === IPC.ptyGeometry) geometries.push(payload)
    }
  }
})
const lastGeometry = () => geometries.filter((g) => g.id === 'tray-1').at(-1)

const paneNow = () => ptyHost.getManager().list().find((s) => s.id === 'tray-1')

/*
 * The desk sits down and works: a fit, then a keystroke. A backspace, because it
 * is unambiguously typing and is a no-op at an empty prompt — everything below
 * runs real commands in this shell and must not find a stray character in front
 * of them.
 */
deskWished('tray-1', 90, 30)
deskTyped('tray-1', '\x7f')
const deskGeometry = paneNow()

// A size neither the session was created at (90x30) nor a default, so a PTY
// that moved could only have moved because of this frame.
sendFrame(held, { type: 'attach', sessionId: 'tray-1', cols: 104, rows: 27 })
await waitFor(() => frameOf(held, 'replay'), 5000, 'the replay frame')

const namesTray = () => watched.length > 0 && watched.at(-1).ids.includes('tray-1')
await waitFor(namesTray, 5000, 'the watch broadcast')
log(true, 'a browser attaching to a pane is named to the renderer, so the pane can say it is being read from away')
log(
  Array.isArray(watched.at(-1).ids) && watched.at(-1).ids.every((id) => typeof id === 'string'),
  'and named is all it is — that message carries ids and no geometry, because watching decides nothing'
)

const afterAttach = paneNow()
log(
  afterAttach.cols === deskGeometry.cols && afterAttach.rows === deskGeometry.rows,
  `while the desk holds the pane, the browser's attach geometry did not move the real PTY (still ${afterAttach.cols}x${afterAttach.rows})`
)

sendFrame(held, { type: 'resize', sessionId: 'tray-1', cols: 132, rows: 44 })
// Long enough that a resize which was going to land would have landed: the
// frame is answered on the same socket the replay above arrived on, and every
// other assertion in this phase settles inside a second.
await new Promise((r) => setTimeout(r, 500))
const afterResize = paneNow()
log(
  afterResize.cols === deskGeometry.cols && afterResize.rows === deskGeometry.rows,
  'and neither did a resize frame — a browser resizing its window is not somebody typing in it'
)

// The other direction: the desk moves the pane, and a browser reading it has to
// be told, or it goes on drawing a shape the PTY no longer has. `sessions`
// already carries cols/rows, so this is a push rather than a new frame.
const sessionsBefore = held.frames.filter((f) => f.type === 'sessions').length
deskWished('tray-1', 96, 28)
await waitFor(
  () =>
    held.frames
      .filter((f) => f.type === 'sessions')
      .slice(sessionsBefore)
      .some((f) => f.sessions.some((s) => s.id === 'tray-1' && s.cols === 96 && s.rows === 28)),
  5000,
  'the desk-driven geometry reaching the browser'
)
log(true, 'while a resize made at the desk is pushed to every browser, which is how they follow it')

await waitFor(() => lastGeometry()?.cols === 96, 5000, 'the geometry message to the renderer')
log(
  lastGeometry().deskOwns === true && lastGeometry().rows === 28,
  `and the renderer is told the same thing on its own channel, marked as the desk's own (${lastGeometry().cols}x${lastGeometry().rows}, deskOwns ${lastGeometry().deskOwns})`
)

/* ------------------------------------------- and now somebody types elsewhere
 *
 * One keystroke in the browser, and the pane changes hands: the size that
 * browser has already asked for lands on the real PTY without it re-sending
 * anything, and the desk is told it is now a follower.
 */
sendFrame(held, { type: 'write', sessionId: 'tray-1', data: '\x7f' })
await waitFor(() => paneNow().cols === 132 && paneNow().rows === 44, 8000, 'the pane changing hands')
log(
  true,
  'one keystroke in the browser took the pane and applied the size it had already asked for (132x44) — the client re-sent nothing'
)
await waitFor(() => lastGeometry()?.deskOwns === false, 5000, 'the renderer being told it is now following')
log(
  lastGeometry().cols === 132 && lastGeometry().rows === 44,
  `and the desk is told to follow that exact grid (${lastGeometry().cols}x${lastGeometry().rows}, deskOwns ${lastGeometry().deskOwns})`
)

// And back. Sitting down at the desk and typing is the whole promise, so it is
// asserted as one keystroke and no ceremony.
deskTyped('tray-1', '\x7f')
await waitFor(() => paneNow().cols === 96 && paneNow().rows === 28, 6000, 'the desk taking the pane back')
log(true, "typing at the desk took it straight back, at the desk's own last fit (96x28)")
await waitFor(() => lastGeometry()?.deskOwns === true, 5000, 'the renderer being told it is native again')
log(true, 'and the renderer is told it owns its grid again, so it stops font-scaling somebody else\'s')

sendFrame(held, { type: 'detach', sessionId: 'tray-1' })
await waitFor(() => watched.at(-1).ids.length === 0, 5000, 'the pane being handed back')
log(true, 'and dropping off the watch list is the same message with the pane no longer in it')

// Re-attached because everything below reads this pane's output back down this
// socket, and only a subscriber is sent it. Still with the window installed,
// because the broadcast this waits on is a message to a renderer.
sendFrame(held, { type: 'attach', sessionId: 'tray-1', cols: 104, rows: 27 })
await waitFor(namesTray, 5000, 'the re-attach')

/*
 * And away: the desktop window is destroyed. `setPtyTarget(null)` is the line
 * electron/main.ts runs from the window's `closed` event, and it releases every
 * pane the desk was holding — so the browser, which is now the only viewer left,
 * takes this one with its very next wish and no typing at all. No window is also
 * the honest state for the rest of this run.
 */
globalThis.__forgeWindows = []
ptyHost.setPtyTarget(null)
sendFrame(held, { type: 'resize', sessionId: 'tray-1', cols: 104, rows: 27 })
await waitFor(() => paneNow().cols === 104 && paneNow().rows === 27, 6000, "the browser's geometry with no window open")
log(
  true,
  'a destroyed window hands its panes back, and the same frame the desk was ignoring now resizes the real PTY — the browser is the only viewer left'
)

// A string that only ever exists in pwsh's *output* — what was typed is a
// concatenation of two halves of it — so a client-side echo cannot fake this.
const beforeNonce = randomBytes(4).toString('hex')
sendFrame(held, { type: 'write', sessionId: 'tray-1', data: `Write-Output ("forge-tray-" + "${beforeNonce}")\r` })
await waitFor(() => textFor(held, 'tray-1').includes(`forge-tray-${beforeNonce}`), 25_000, 'the shell before the close')
log(true, `the pane is alive and writable before the window closes (forge-tray-${beforeNonce})`)

/* -------------------------------------------------------- and now, closing */

const icon = globalThis.__forgeTray
log(Boolean(icon), 'with Forge Web on, there is an icon in the notification area')
log(
  String(icon?.tooltip ?? '').includes(NGROK_DOMAIN),
  `and it says what the link is doing without opening a window ("${icon?.tooltip}")`
)

const balloonsBefore = globalThis.__forgeBalloons.length
const absorbed = tray.handleWindowClose(window)

// Since 2026-08-26 the close is never absorbed: X quits, and the out-of-process
// watchdog (scripts/watchdog.mjs) brings Forge back. The icon stays for the link.
log(absorbed === false, 'closing the window is not absorbed — X quits Forge, the watchdog restarts it')
log(window.visible === true, 'the window is not hidden away')
log(globalThis.__forgeBalloons.length === balloonsBefore, 'and nothing pops up claiming Forge is still running')

await sleep(250)

log((await portOpen(PORT)) === true, `the server is still listening on ${PORT}`)
log(
  host.webStatus().rendezvous.published === NGROK_DOMAIN,
  `the rendezvous record still names this desktop (${host.webStatus().rendezvous.published || 'nothing'})`
)
log(held.closed === null, "the connected browser's socket was never broken — not reconnected, never broken")
log(!frameOf(held, 'shutdown'), 'and nothing told it the desk was going, because the desk did not go')
log(host.webStatus().connected === 1, `it is still counted as connected (${host.webStatus().connected})`)

const afterNonce = randomBytes(4).toString('hex')
sendFrame(held, { type: 'write', sessionId: 'tray-1', data: `Write-Output ("forge-tray-" + "${afterNonce}")\r` })
await waitFor(() => textFor(held, 'tray-1').includes(`forge-tray-${afterNonce}`), 25_000, 'the shell after the close')
log(
  ptyHost.getManager().list().some((s) => s.id === 'tray-1'),
  'the pane started before the close is still alive after it'
)
log(true, `and still writable from the browser (forge-tray-${afterNonce})`)

/* ------------------------------------------------------------- the menu */

const menu = tray.trayMenuTemplate()
const labels = menu.map((item) => item.label ?? '—')

log(
  menu.some((item) => item.label === 'Open Forge'),
  'the menu offers the way back'
)
log(
  labels.some((label) => label.includes(NGROK_DOMAIN)),
  `and says where the link is, so a closed window is not a silent one (${labels.join(' | ')})`
)
menu.find((item) => item.label === 'Copy the link')?.click()
log(copied === `wss://${NGROK_DOMAIN}${WEB_WS_PATH}`, `with the address itself a click away (${copied})`)

const quitItem = menu.find((item) => /^Quit Forge/.test(String(item.label)))
log(Boolean(quitItem), `and one way out, named for what it costs ("${quitItem?.label}")`)

menu.find((item) => item.label === 'Open Forge')?.click()
log(opened === 1 && window.visible === true, 'clicking the way back gives the window back')
window.visible = false

/* ================================================================ phase 11a
 *
 * Foreman, from a browser, against the real host.
 *
 * What can be driven here without a brain: the real snapshot carries the
 * foreman states to a connecting browser, the additive exports answer without
 * a host behind them, and a real foreman-stop travels the whole chain —
 * browser, server boundary, web-host hook, electron/foreman — and is held to
 * the boundary rule against this desktop's *real* session list. The start
 * verb is deliberately not exercised: it opens a real Claude session, and the
 * boundary rules it shares with stop (live pane, capped seed) are
 * scripts/web-smoke.mjs's to assert against a recording host.
 */

console.log('\nforeman from a browser')

const foreman = await import('../electron/foreman/ipc.ts')
const resultOf = (tab, rid) => tab.frames.find((f) => f.type === 'result' && f.rid === rid)

log(
  Array.isArray(frameOf(held, 'hello-ok').foreman),
  "the real host's hello-ok carries the foreman states, so a reconnecting browser hears 'nothing is driven' as an answer rather than as silence"
)
log(
  foreman.foremanList().length === 0,
  'and the exported list answers with no host behind it, which is the shape a freshly booted desktop has'
)

sendFrame(held, { type: 'request', rid: 'r-fm-stop', body: { kind: 'foreman-stop', paneId: 'tray-1' } })
await waitFor(() => resultOf(held, 'r-fm-stop'), 5000, 'the real foreman-stop')
log(
  resultOf(held, 'r-fm-stop').body.kind === 'ok',
  'a foreman-stop for a live pane travels the whole chain — browser, server, web-host, the foreman module — and answers ok'
)
sendFrame(held, { type: 'request', rid: 'r-fm-gone', body: { kind: 'foreman-stop', paneId: 'never-existed' } })
await waitFor(() => resultOf(held, 'r-fm-gone'), 5000, 'the refused foreman-stop')
log(
  resultOf(held, 'r-fm-gone').body.code === 'unknown-session',
  'and the same verb for a pane this desktop does not have is refused at the boundary, against the real session list'
)

/* ================================================================ phase 11b
 *
 * Quitting from the tray, which must be the full shutdown the app has always
 * done on `before-quit` — not a lesser one because the window went first.
 */

console.log('\nquitting from the tray')

const deletesBeforeQuit = dbCalls('DELETE', `/users/${UID}/host.json`).length
quitItem.click()
log(quitRan === true, 'the tray’s Quit reaches the shutdown the before-quit chain runs')
await quitPromise
await waitFor(() => held.closed !== null, 4000, 'the held socket to close')

const bye = frameOf(held, 'shutdown')
log(bye?.reason === 'quit', `every connected browser is told the desk is going, and why (${bye?.reason})`)
log(held.frames.indexOf(bye) < held.framesAtClose, 'and told before the socket closed, not after')
log(
  dbCalls('DELETE', `/users/${UID}/host.json`).length > deletesBeforeQuit,
  'the rendezvous record is retracted rather than left for browsers to dial'
)
log((await portOpen(PORT)) === false, 'the listener is gone')
log(closeAgent.killed === true, 'and the tunnel agent goes with it')
log(
  tray.handleWindowClose(fakeWindow()) === false,
  'a close arriving during a quit is never absorbed — the window really goes'
)

/* ================================================================ phase 11c
 *
 * The desktop that never switched this on.
 *
 * The rule is that nobody acquires a notification-area icon for a feature they
 * have not asked for, and that closing the window on such a desktop behaves
 * exactly as it did before any of this existed. The second half of it — what
 * happens when Forge Web is switched off while Forge is already hidden — is the
 * one that could strand a process with no window and no icon, so it is asserted
 * rather than reasoned about.
 */

console.log('\nswitching Forge Web off, and closing the window without it')

tray.cancelQuitting()
await invoke('web:start')
await sleep(200)
log(Boolean(globalThis.__forgeTray), 'switching Forge Web on puts the icon back without anybody asking it to')

const stillOpen = fakeWindow()
log(tray.handleWindowClose(stillOpen) === false, 'and closing the window still quits rather than hiding to it')
log(stillOpen.visible === true, 'so the window is never hidden')

window = stillOpen
await invoke('web:stop')
await sleep(200)

log(globalThis.__forgeTray === null, 'switching Forge Web off takes the icon away')
log(stillOpen.visible === true, 'and the window is where it was')

const off = fakeWindow()
log(tray.handleWindowClose(off) === false, 'with Forge Web off, closing the window is not absorbed')
log(off.visible === true, 'the window is not hidden, and Forge quits exactly as it always did')

/* ------------------------------------------------------------------- done */

host.setWebStatusListener(null)
tray.disposeTray()
ptyHost.disposePtyHost()
await host.disposeWeb()
for (const tab of [first, second, held]) {
  try {
    tab.socket.terminate()
  } catch {
    /* already gone */
  }
}
rmSync(dataDir, { recursive: true, force: true })

/*
 * Let the pane this check spawned actually finish dying before the process
 * leaves, because on Windows `process.exit()` is not the escape hatch it reads
 * like. node-pty's `ConoutConnection` runs its console reader on a real
 * `worker_threads` Worker, and a live Worker keeps this process up *through* an
 * explicit exit — the exit event fires, and then nothing happens, for as long as
 * anybody waits. `killAll()` above kills the ConPTY, but the Worker it takes
 * with it is torn down a tick later, so exiting in the same turn is a race this
 * check lost the moment it grew enough phases to change its timing. It ran
 * green and hung anyway, which is the worst of both: every assertion passed and
 * the run never ended, so `npm run web:check` looked like a check that failed.
 *
 * Bounded, so a pane that will not die still ends the run rather than replacing
 * one hang with another, and reported rather than swallowed — a pty that
 * outlives `killAll` is worth knowing about.
 */
const settled = await waitFor(
  () => ptyHost.getManager().list().length === 0,
  5_000,
  'the pane to finish exiting'
).then(
  () => true,
  () => false
)
if (!settled) console.log('  --   a pty outlived killAll; exiting anyway')
await sleep(150)

console.log(`\n${failures === 0 ? 'web lifecycle: all good' : `web lifecycle: ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)

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
 *  - a **real WebSocket** with a real Firebase-shaped ID token answers "was the
 *    revoked browser hung up on, or merely refused next time";
 *  - **settings.json, read back off disk** answers "what did signing in
 *    actually write down", the way scripts/mobile-auth-check.mjs does;
 *  - a **scripted ngrok process** answers "does the tunnel's own hostname reach
 *    the rendezvous record, and does a tunnel that dies take it away again".
 *    The supervisor is the shipped one; only the OS process is a stand-in, the
 *    same bargain scripts/tunnel-check.mjs strikes.
 *
 * Two of the phases below exist because of arrangements this feature was
 * *corrected out of*, and they are the ones to keep if anything here is ever
 * trimmed. Forge Web used to publish under the Companion's Firebase session, so
 * it silently stopped working when a different feature was signed out or signed
 * in as somebody else — phase 2 sets up exactly that (Companion signed in, as
 * another account, Forge Web signed out) and demands a refusal that says why.
 * And it used to take its hostname from an environment variable, which no
 * status could ever describe honestly — phase 9 drives a real supervisor
 * instead.
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
import { createSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * Something for `resolveNgrokExe` to find, so the host never tries to download
 * an agent. It is never executed: the spawn that would run it is intercepted
 * below.
 */
const FAKE_NGROK = join(dataDir, 'fake-ngrok.exe')
writeFileSync(FAKE_NGROK, 'not a real ngrok')

process.env['FORGE_DATA_DIR'] = dataDir
process.env['FORGE_WEB_PORT'] = String(PORT)
process.env['FORGE_WEB_HOSTNAME'] = HOSTNAME
process.env['FORGE_NGROK_EXE'] = FAKE_NGROK
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

const ELECTRON_STUB = 'forge-web-check:electron'

/* ------------------------------------------------------- a scripted ngrok
 *
 * The supervisor under test is the shipped one — `NgrokTunnel`, reached the way
 * the app reaches it, through `electron/web-host.ts`'s own `startTunnel()`. What
 * is faked is the operating-system process, and *only* for the one module that
 * spawns it: the `node:child_process` swap below is keyed on the importer, so
 * everything else in this graph (git, taskkill, whatever else main reaches for)
 * still gets the real one.
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
  if (exe === FAKE_NGROK) return fakeAgent(args)
  return realSpawn(exe, args, options)
}

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec === 'node:child_process' && String(context.parentURL ?? '').endsWith('mobile-tunnel.ts')) {
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
    const fromDependency = String(context.parentURL ?? '').includes('/node_modules/')
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
          // No windows, ever. That is the honest state for a head-less run, and
          // it is also the state `dispatchLayout` has to refuse cleanly in.
          'export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }',
          'export const Notification = { isSupported: () => false }',
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
function browser(deviceId, { origin, totp } = {}) {
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
          // Omitted unless a phase is exercising the second factor, so every
          // other phase sends the hello it always sent.
          ...(totp ? { totp } : {})
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

store.setSettings({
  webEnabled: false,
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
  webDevices: [
    { id: 'browser-1', name: 'Check', createdAt: 1, lastSeenAt: 1, revokedAt: 0 },
    { id: 'browser-2', name: 'Check two', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }
  ],
  webAcceptUntil: 0,
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
 * A live, authenticated browser, revoked while it is holding the socket.
 */

console.log('\nrevoking a browser that is connected right now')

const first = await browser('browser-1', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => frameOf(first, 'hello-ok') || first.closed !== null, 4000, 'the first browser to be let in')

log(Boolean(frameOf(first, 'hello-ok')), 'a browser with a valid token and an approved id is let in')
log(host.webStatus().connected === 1, `and is counted as connected (${host.webStatus().connected})`)

const afterRevoke = await invoke('web:revoke', 'browser-1')
await waitFor(() => first.closed !== null, 4000, 'the revoked socket to close')

const refused = frameOf(first, 'refused')
log(refused?.reason === 'revoked', `the live socket was told why (${refused?.reason})`)
log(first.closed === 4003, `and hung up on, not left open (close ${first.closed})`)
log(afterRevoke.devices.find((d) => d.id === 'browser-1')?.revokedAt > 0, 'the row is a tombstone, not a deletion')
await waitFor(() => host.webStatus().connected === 0, 2000, 'the connection count to fall')
log(host.webStatus().connected === 0, 'nobody is connected any more')

/* ================================================================== phase 5b
 *
 * The second factor, through the real host and over a real socket.
 *
 * `scripts/web-auth-check.mjs` proves the arithmetic and every refusal; what
 * only this file can prove is the *lifecycle* — that the three IPC calls the
 * settings panel makes write what they claim, that the secret is sealed by the
 * time it reaches the file, and that a browser holding no code is turned away
 * by the server rather than merely by the class.
 */

console.log('\nthe second factor')

const { totpCode } = await import('../electron/web/totp.ts')

log(store.getSettings().webRequireApproval === false, 'the desktop ships with device approval off — the account is the key')
log(host.webStatus().requireApproval === false, 'and the panel is told so')
log(host.webStatus().totpEnabled === false, 'with no second factor enrolled either')

const totpOffer = await invoke('web:totp-begin')
log(totpOffer.ok === true && totpOffer.uri.startsWith('otpauth://totp/'), 'starting the setup hands back an otpauth:// URI')
log(store.getSettings().webTotpSecret === '', 'and writes nothing — an unproved secret is never persisted')

const badConfirm = await invoke('web:totp-confirm', '000000')
log(badConfirm.ok === false, 'a wrong code does not complete the setup')
log(store.getSettings().webTotpSecret === '', 'and still writes nothing')

const confirmed = await invoke('web:totp-confirm', totpCode(totpOffer.secret, Math.floor(Date.now() / 30_000)))
log(confirmed.ok === true, 'a correct code completes it')
log(confirmed.ok && confirmed.recovery.length === 10, 'and hands back ten recovery codes, this once')
log(host.webStatus().totpEnabled === true && host.webStatus().recoveryLeft === 10, 'the panel now reads code required')

const totpOnDisk = readFileSync(join(dataDir, 'settings.json'), 'utf8')
log(!totpOnDisk.includes(totpOffer.secret), 'the secret is not in settings.json — what is written there is sealed')
log(
  confirmed.ok && confirmed.recovery.every((code) => !totpOnDisk.includes(code)),
  'and no recovery code is either, only their digests'
)
log(existsSync(join(dataDir, 'web-totp.key')), 'the key that opens it is a file of its own beside settings.json')

const noCode = await browser('browser-2', { origin: `https://${PROJECT}.web.app` })
await waitFor(() => noCode.closed !== null, 4000, 'the browser with no code to be turned away')
log(frameOf(noCode, 'refused')?.reason === 'totp-required', 'a browser with no code is refused over the wire, not let in')
log(!frameOf(noCode, 'hello-ok'), 'and never sees the opening picture')

// A recovery code rather than a TOTP one, deliberately: the code that completed
// the enrolment is spent by having completed it, and inside the same 30 seconds
// there is no *other* TOTP code to present.
const withCode = await browser('browser-2', {
  origin: `https://${PROJECT}.web.app`,
  totp: confirmed.ok ? confirmed.recovery[0] : ''
})
await waitFor(() => frameOf(withCode, 'hello-ok') || withCode.closed !== null, 4000, 'the browser with a code')
log(Boolean(frameOf(withCode, 'hello-ok')), 'a browser presenting a valid code is let in')
log(host.webStatus().recoveryLeft === 9, 'and the code it used is struck off, so it will not work twice')
withCode.socket.close()
await waitFor(() => host.webStatus().connected === 0, 4000, 'that browser to go')

const afterDisable = await invoke('web:totp-disable')
log(afterDisable.totpEnabled === false && afterDisable.recoveryLeft === 0, 'turning it off takes the spare codes with it')
log(
  store.getSettings().webTotpSecret === '' && store.getSettings().webTotpCounter === 0,
  'and leaves nothing behind in settings.json'
)

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

store.setSettings({ webProjectId: '' })
const unconfigured = host.webAllowedOrigins()
log(
  !unconfigured.some((o) => o.startsWith('https://')),
  `an unconfigured desktop allows no https origin at all (${unconfigured.join(', ') || 'none'})`
)
log(
  unconfigured.every((o) => o.startsWith('http://localhost') || o.startsWith('http://127.0.0.1')),
  'what is left is the dev loop, and only because this is not a packaged run'
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

/* ================================================================== phase 9
 *
 * The tunnel: Forge Web's own supervised agent.
 *
 * `FORGE_WEB_HOSTNAME` goes first, because with it set nothing below would
 * prove anything — an environment variable would be answering every question
 * the supervisor is supposed to answer. What is exercised from here is the real
 * `NgrokTunnel`, started by the real `web-host.ts`, against a scripted process.
 */

console.log('\nthe tunnel')

delete process.env['FORGE_WEB_HOSTNAME']
store.setSettings({
  webProjectId: PROJECT,
  webTunnel: 'ngrok',
  webNgrokDomain: NGROK_DOMAIN,
  webNgrokAuthtoken: NGROK_TOKEN
})

const putsBeforeTunnel = dbCalls('PUT', `/users/${UID}/host.json`).length
const deletesBeforeTunnel = dbCalls('DELETE', `/users/${UID}/host.json`).length

await invoke('web:start')
await waitFor(() => agents.length > 0, 4000, 'the ngrok agent to be spawned')
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

/* ------------------------------------------------------------------- done */

await host.disposeWeb()
for (const tab of [first, second]) {
  try {
    tab.socket.terminate()
  } catch {
    /* already gone */
  }
}
rmSync(dataDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'web lifecycle: all good' : `web lifecycle: ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)

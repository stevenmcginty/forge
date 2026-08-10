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
 * `WebServer`, `WebAuth` and `WebRendezvous` behind it — with `electron` stubbed
 * the way scripts/git-check.mjs and scripts/gitwatch-smoke.mjs stub it, and
 * watches from outside:
 *
 *  - a **TCP connect** to the port answers the question "is it listening",
 *    which no amount of reading `webStatus()` does;
 *  - a **fetch counter** answers "did anything read a credential or publish a
 *    hostname", because every credential this feature has travels over `fetch`
 *    — the JWKS, the token refresh, and the RTDB write itself;
 *  - a **real WebSocket** with a real Firebase-shaped ID token answers "was the
 *    revoked browser hung up on, or merely refused next time".
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
import { mkdtempSync, rmSync } from 'node:fs'
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
const KID = 'c0ffee'
const DB = 'https://db.invalid'
const TOKEN_BASE = 'https://token.invalid/v1'
const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

process.env['FORGE_DATA_DIR'] = dataDir
process.env['FORGE_WEB_PORT'] = String(PORT)
process.env['FORGE_WEB_HOSTNAME'] = HOSTNAME
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

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
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
function browser(deviceId, { origin } = {}) {
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
          deviceName: 'Check'
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
  webUid: UID,
  webDevices: [
    { id: 'browser-1', name: 'Check', createdAt: 1, lastSeenAt: 1, revokedAt: 0 },
    { id: 'browser-2', name: 'Check two', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }
  ],
  webAcceptUntil: 0,
  companionUid: UID,
  companionEmail: 'check@example.invalid',
  companionApiKey: 'check-api-key',
  companionDatabaseURL: DB,
  companionTokenBase: TOKEN_BASE,
  companionRefreshToken: 'check-refresh-token'
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
 * Switched on: it binds, and it publishes.
 */

console.log('\nturning it on')

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

/* ================================================================== phase 3
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

/* ================================================================== phase 4
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

/* ================================================================== phase 5
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

/**
 * Head-less proof that the Forge Web link works, and that its refusals refuse.
 *
 * Bundles the *real* electron/web/server.ts and electron/web/auth.ts with
 * esbuild and drives them exactly as electron/web-host.ts will — against a real
 * PtySessionManager, over a real WebSocket, with a real pwsh session on the
 * other end. No mock server, no fake PTY, no stubbed auth. A link that has only
 * ever run inside Electron is a link nobody has tested, and this one puts a
 * shell on a home PC behind a public web address.
 *
 *   npm run web:smoke
 *
 * Everything Google would supply is generated here instead: an RSA keypair, a
 * self-signed X.509 certificate in the shape the securetoken endpoint publishes,
 * and JWTs minted against it. The construction is the one in
 * scripts/web-auth-check.mjs — restated rather than shared because each check
 * bundles stand-alone and that file is not this one's to edit — and it is
 * hand-rolled DER because node:crypto can read certificates and cannot write
 * them. Serving a bare public key instead would mean the production path,
 * parsing what Google actually sends, was the one path never exercised.
 *
 * ## Why the phases
 *
 * The failure lockout in auth.ts is per *source address*, and every socket in a
 * smoke run comes from 127.0.0.1. So phase A spends its strikes proving each
 * refusal separately, then is torn down; phase B starts a fresh WebAuth with no
 * strikes against it. Sharing one between them would mean phase A's lockout
 * silently failing every check in phase B — every later assertion passing or
 * failing for a reason that has nothing to do with what it is testing. The last
 * check in phase A asserts the lockout is live, which is the same fact stated
 * out loud rather than assumed.
 *
 * Phase C is the unlock PIN on a third server, so the refusals it produces are
 * observed as frames on a socket rather than as return values. Phase D is the
 * heartbeat, on a fourth whose ping interval is injected short — a browser that
 * stops answering has to be dropped by a timer actually firing, not by an
 * argument.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-smoke')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const PORT = 8481
const PROJECT = 'forge-web-smoke'
const OTHER_PROJECT = 'somebody-elses-project'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const OTHER_UID = 'ZZZo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'a1b2c3d4e5f6'
/** The one page this desktop is willing to be opened from. See `originAllowed`. */
const ORIGIN = 'https://forge-web.web.app'

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
      setTimeout(tick, 40)
    }
    tick()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* -------------------------------------------------- a certificate authority
 *
 * Minimal DER, and minimal on purpose: a v1 certificate is a serial, an
 * algorithm, a name, a validity window and the SPKI — which node:crypto will
 * hand over ready-made. Everything below is the ASN.1 wrapping around it.
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

/** A self-signed certificate carrying `pair.publicKey`, PEM-armoured. */
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

/* ------------------------------------------------------------ the workspace */

const PROJECTS = [
  { id: 'p1', name: 'forge', path: ROOT, color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 }
]
const PROFILES = [{ id: 'shell', name: 'Shell', command: '', accent: '#888', badge: 'SH' }]
const WORKSPACES = { p1: { tabs: [], activeTabId: null } }
const SKILLS = { skills: [{ id: 'sk1', name: 'caveman' }], machineSkills: [] }
const FEED = {
  commands: [{ name: '/init' }],
  releases: [],
  commandsFrom: 'bundled',
  releasesFrom: 'bundled',
  installed: null,
  latest: null,
  fetchedAt: null
}
const SNAPSHOT = {
  projectId: 'p1',
  seq: 1,
  at: 0,
  presence: 'clean',
  repoRoot: ROOT,
  branch: 'master',
  detached: false,
  unborn: false,
  head: 'abc1234',
  upstream: null,
  ahead: 0,
  behind: 0,
  state: 'synced',
  remoteUrl: null,
  slug: null
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'web-smoke-entry.ts')],
    outfile: join(scratch, 'web.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty', 'ws'],
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const {
    WebServer,
    WebAuth,
    PtySessionManager,
    hashPin,
    isAllowedSource,
    webSocketUrl,
    HEARTBEAT_GRACE_MS,
    HEARTBEAT_MS,
    MAX_FRAME_BYTES,
    MAX_INPUT_PER_SECOND,
    MAX_MIRROR_CHUNK_BYTES,
    MAX_MIRROR_INPUT_PER_SECOND,
    MAX_REPLAY_BYTES,
    MAX_WRITE_CHARS,
    WEB_PROTO,
    WEB_SUBPROTOCOL,
    WEB_WS_PATH,
    WEB_MAX_SESSIONS,
    IPC_MAX_SESSIONS,
    AUTH_MAX_FAILURES
  } = await import(pathToFileURL(join(scratch, 'web.mjs')).href)

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

  /**
   * A browser tab. Collects every frame it is sent, its close code, and — for
   * the upgrade refusals, which never become a socket at all — the HTTP status
   * the server answered with.
   */
  function connect({ protocols = [WEB_SUBPROTOCOL], origin = ORIGIN, autoPong = true } = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WEB_WS_PATH}`, protocols, {
      ...(origin ? { origin } : {}),
      autoPong
    })
    const browser = {
      socket,
      frames: [],
      opened: false,
      closed: null,
      closeReason: '',
      refusal: '',
      openedAt: 0,
      closedAt: 0,
      send: (frame) => socket.send(JSON.stringify(frame)),
      raw: (text) => socket.send(text),
      of: (type) => browser.frames.filter((f) => f.type === type),
      first: (type) => browser.frames.find((f) => f.type === type),
      result: (rid) => browser.frames.find((f) => f.type === 'result' && f.rid === rid),
      text: (id) =>
        browser.frames
          .filter((f) => (f.type === 'data' || f.type === 'replay') && f.sessionId === id)
          .map((f) => f.data)
          .join('')
    }
    socket.on('message', (raw) => browser.frames.push(JSON.parse(String(raw))))
    socket.on('close', (code, reason) => {
      browser.closed = code
      browser.closedAt = Date.now()
      // The browser tab shows this sentence word for word, so the checks assert
      // that refusals stay distinguishable to a human.
      browser.closeReason = String(reason ?? '')
    })
    socket.on('error', (err) => {
      // An upgrade the server refused never opens, so this is the only place its
      // status line is visible.
      browser.refusal = String(err?.message ?? err)
    })
    return new Promise((resolvePromise) => {
      socket.on('open', () => {
        browser.opened = true
        browser.openedAt = Date.now()
        resolvePromise(browser)
      })
      socket.on('error', () => resolvePromise(browser))
    })
  }

  /* --------------------------------------------------------- the desktop */

  // `active` stands in for web-host's PTY sink: the manager's callbacks close
  // over a mutable reference so the same live shell can outlive one phase's
  // server and be driven by the next.
  let active = null
  const replay = new Map()
  const manager = new PtySessionManager({
    maxSessions: 4,
    // `-NoProfile`, and it is not a shortcut: Steve's own pwsh profile installs
    // shell integration and a prompt that takes tens of seconds to come up, and
    // a check that waited for it would be measuring his dotfiles rather than
    // this link. Everything that matters here is still real — a real pwsh, a
    // real ConPTY, a real console host — it just starts from a shell nobody has
    // customised, which is the only way this run means the same thing on
    // another machine.
    shellArgs: ['-NoLogo', '-NoProfile'],
    onData: (id, data) => {
      // Mirrors pty-host: remember first (the catch-up buffer), then push.
      replay.set(id, (replay.get(id) ?? '') + data)
      active?.pushData(id, data)
      answerCursorQuery(id, data)
    },
    onExit: (id, exitCode) => active?.pushExit(id, exitCode)
  })

  /**
   * Answer the shell's "where is the cursor?" — the one thing a terminal does
   * that this test would otherwise not.
   *
   * `CSI 6 n` is a Device Status Report: pwsh asks it constantly, and hardest
   * right after a resize, because PSReadLine has to know where its line begins
   * before it can repaint. On the desktop and in the browser xterm.js answers it
   * in microseconds. With nothing on the end of the PTY, ConPTY waits out a
   * timeout instead — measured here at *39 seconds* for one resize, against 47ms
   * once the question is answered.
   *
   * So this is not a convenience: without it the geometry half of `attach` could
   * not be exercised on the same session as the echo, and the check would be
   * quietly testing a terminal nobody ships. `electron/pty/replay.ts` documents
   * the same queries from the other side, where a *replay* must never answer
   * them; a live stream must.
   */
  const answerCursorQuery = (id, data) => {
    const asked = data.match(/\x1b\[6n/g)
    for (let i = 0; i < (asked?.length ?? 0); i++) manager.write(id, '\x1b[1;1R')
  }

  let allowedOrigins = [ORIGIN]
  /**
   * Every origin the server turned away, in order.
   *
   * The refusal this records is the only one in the file that cannot reach the
   * browser it concerns — it happens during the upgrade, where there is no
   * socket to carry a `refused` frame — so a desktop that does not hear about
   * it has no way to tell anybody, and the page retries forever looking like a
   * network fault. See `onOriginRefused` in electron/web/server.ts.
   */
  const refusedOrigins = []
  const ops = []
  let layoutAnswer = null
  const watches = []
  let releaseSkills = null
  let releaseCommands = null

  /**
   * A WebAuth over its own private device list.
   *
   * The list is held in a closure and replaced wholesale on save, exactly as
   * scripts/web-auth-check.mjs does it. Mutating a caller's array in place looks
   * equivalent and is not: `authenticate` bumps `lastSeenAt` on the array it was
   * handed and then saves *that same array*, so an implementation that empties
   * its target before refilling it wipes the device list on every successful
   * connection — and the next hello is answered `not-approved` for a browser
   * that was approved a second ago.
   */
  const makeAuth = (initial, extra = {}) => {
    let saved = initial
    return new WebAuth({
      load: () => saved,
      save: (next) => {
        saved = next
      },
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID,
      // No unlock PIN unless a phase sets one, which is what this desktop ships
      // as. This file is about the *protocol* — what a refusal frame looks
      // like, what the socket does afterwards — so the phases that care about
      // the PIN pass a `pinHash` of their own; where the admission decision
      // itself is judged is scripts/web-auth-check.mjs.
      ...extra
    })
  }

  const makeServer = (auth, extra = {}) =>
    new WebServer({
      auth,
      appVersion: '0.0.0-smoke',
      desktopName: () => 'SMOKE-PC',
      allowedOrigins: () => allowedOrigins,
      onOriginRefused: (origin, allowed) => refusedOrigins.push({ origin, allowed }),
      sessions: () => manager.list(),
      replay: (id) => replay.get(id) ?? '',
      write: (id, data) => manager.write(id, data),
      resize: (id, cols, rows) => manager.resize(id, cols, rows),
      snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: WORKSPACES }),
      layout: async (op, deviceName) => {
        ops.push({ op, deviceName })
        return layoutAnswer
      },
      gitStatus: async (projectId) => (projectId === 'p1' ? SNAPSHOT : null),
      // Deliberately deferred, so two requests can be in flight at once and
      // answered out of the order they arrived in.
      skills: () => new Promise((r) => (releaseSkills = () => r(SKILLS))),
      commands: () => new Promise((r) => (releaseCommands = () => r(FEED))),
      onWatch: (ids) => watches.push(ids.join(' ')),
      ...extra
    })

  /* ============================== 0. the pure rules, before any socket */

  log(isAllowedSource('127.0.0.1') && isAllowedSource('::1'), 'loopback is allowed — this is the address a tunnel dials from')
  log(isAllowedSource('192.168.1.42') && isAllowedSource('10.0.0.4'), 'LAN is allowed')
  log(!isAllowedSource('8.8.8.8') && !isAllowedSource('203.0.113.7'), 'a public address is refused')
  log(!isAllowedSource(''), 'an unknown address is refused')

  /* ---- 14. two constants that are only "the same" because a comment says so */

  log(
    WEB_MAX_SESSIONS === IPC_MAX_SESSIONS,
    `MAX_SESSIONS in shared/web.ts (${WEB_MAX_SESSIONS}) equals MAX_SESSIONS in shared/ipc.ts (${IPC_MAX_SESSIONS}), which until now nothing enforced`
  )

  /* ------------------------------------- 15. the address the browser dials */

  log(
    webSocketUrl('forge-abc-123.trycloudflare.com') === 'wss://forge-abc-123.trycloudflare.com/web',
    'webSocketUrl gives wss: for a tunnel hostname'
  )
  log(webSocketUrl('not a hostname') === '', 'and "" for rubbish, so a client fails visibly rather than dialling wss://undefined')
  log(
    webSocketUrl('localhost:5173') === '',
    'and "" for localhost without the loopback flag, so a hostile record cannot steer a session onto plaintext'
  )
  log(
    webSocketUrl('localhost:5173', true) === 'ws://localhost:5173/web',
    'while the opt-in dev flag gives ws://localhost:5173/web'
  )
  log(
    webSocketUrl('127.0.0.1.evil.com', true) === 'wss://127.0.0.1.evil.com/web',
    'and a hostname that merely starts 127.0.0.1 is not downgraded to plaintext'
  )

  /* ================================================== PHASE A — refusals
   *
   * Five refusals that reach auth.ts, which is exactly AUTH_MAX_FAILURES, so
   * each is still answered on its own merits. The sixth check proves the
   * lockout has closed behind them — and is why this server is torn down before
   * anything that has to succeed.
   */

  const devicesA = [
    { id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 },
    { id: 'gone-1', name: 'Old Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 2 }
  ]
  const authA = makeAuth(devicesA)
  const serverA = makeServer(authA)
  active = serverA
  await serverA.start({ host: '127.0.0.1', port: PORT })

  const refusedBy = async (frame, label) => {
    const browser = await connect()
    browser.send({ type: 'hello', proto: WEB_PROTO, client: '0.0.0-smoke', deviceName: 'Chrome on Windows', ...frame })
    await waitFor(() => browser.closed !== null, 8000, `${label} to be refused`)
    return browser
  }

  const malformed = await refusedBy({ idToken: 'not.a.token', deviceId: 'browser-1' }, 'a malformed token')
  log(malformed.first('refused')?.reason === 'bad-token', 'a malformed token is refused with bad-token')
  log(malformed.closed === 4001 && !malformed.first('hello-ok'), 'and the socket is closed rather than left sitting open')

  const expired = await refusedBy(
    { idToken: mint({ exp: nowSec() - 3600, iat: nowSec() - 7200, auth_time: nowSec() - 7200 }), deviceId: 'browser-1' },
    'an expired token'
  )
  log(expired.first('refused')?.reason === 'bad-token', 'an expired token is refused with bad-token')

  const otherAccount = await refusedBy({ idToken: mint({ sub: OTHER_UID }), deviceId: 'browser-1' }, 'another account')
  log(
    otherAccount.first('refused')?.reason === 'wrong-account',
    'a valid token for a different uid is wrong-account, not bad-token — a different sentence with a different recovery'
  )

  const otherProject = await refusedBy(
    { idToken: mint({ aud: OTHER_PROJECT, iss: `https://securetoken.google.com/${OTHER_PROJECT}` }), deviceId: 'browser-1' },
    "another Firebase project"
  )
  log(
    otherProject.first('refused')?.reason === 'bad-token',
    "a valid token minted by another Firebase project is bad-token, so a guessed uid learns nothing"
  )

  // `not-approved` no longer means "no prompt can be raised for you" — there is
  // no prompt any more — so what it is asserted on is what it means now: a
  // browser that sent no device id, which there is nothing to record an
  // admission against.
  const nameless = await refusedBy({ idToken: mint(), deviceId: '' }, 'a browser with no device id')
  log(
    nameless.first('refused')?.reason === 'not-approved',
    'a browser that did not identify itself is not-approved, whatever its token says'
  )

  // Five strikes spent. The lockout is now shut, which is the whole reason this
  // phase cannot be shared with the ones that have to succeed.
  const lockedOut = await refusedBy({ idToken: mint(), deviceId: 'browser-1' }, 'a locked-out source')
  log(
    lockedOut.first('refused')?.reason === 'busy' && lockedOut.first('refused')?.retryAfterMs > 0,
    `${AUTH_MAX_FAILURES} refusals lock 127.0.0.1 out, so every later phase needs a fresh WebAuth`
  )

  await serverA.stop()

  /* ------------------------- the two refusals that never reach a credential */

  // A revoked device on a fresh auth, so the lockout above cannot be what
  // refuses it. Revoked and not-approved are different rows and different
  // recoveries, so they are asserted apart.
  const devicesR = [{ id: 'gone-1', name: 'Old Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 2 }]
  const serverR = makeServer(makeAuth(devicesR))
  active = serverR
  await serverR.start({ host: '127.0.0.1', port: PORT })

  const revoked = await refusedBy({ idToken: mint(), deviceId: 'gone-1' }, 'a revoked device')
  log(
    revoked.first('refused')?.reason === 'revoked',
    'a revoked browser is refused with revoked rather than not-approved, and raises no prompt'
  )

  const staleProto = await refusedBy({ proto: WEB_PROTO + 99, idToken: mint(), deviceId: 'gone-1' }, 'a stale protocol')
  log(
    staleProto.first('refused')?.reason === 'proto' && staleProto.closed === 4002,
    'a stale protocol version is named at hello rather than failing later in a way that looks like a bug'
  )

  /* ------------------------------------ the two refusals at the upgrade */

  const wrongProtocol = await connect({ protocols: ['forge-web.v0'] })
  log(
    wrongProtocol.opened === false && wrongProtocol.refusal.includes('400'),
    'a client asking for the wrong subprotocol is refused during the upgrade, before a socket or a hello exists'
  )

  const noProtocol = await connect({ protocols: [] })
  log(
    noProtocol.opened === false && noProtocol.refusal.includes('400'),
    'and so is one that names no subprotocol at all'
  )

  const wrongOrigin = await connect({ origin: 'https://not-forge.example' })
  log(
    wrongOrigin.opened === false && wrongOrigin.refusal.includes('403'),
    'an unexpected Origin is refused at the upgrade — the one control that stops a page on the internet dialling a guessed hostname'
  )
  /*
   * And the desktop is told which page it just refused.
   *
   * Forge Web shipped with this refusal firing only into a console log, so a
   * Hosting site that did not match the project id refused every browser in
   * the world in silence: the page said "Reconnecting to the desktop" for as
   * long as anybody watched it, and nothing at either end said why. The
   * *sentence* is the fix, so the sentence is what is asserted.
   */
  const lastRefused = refusedOrigins.at(-1)
  log(
    lastRefused?.origin === 'https://not-forge.example',
    `the desktop is told which page was turned away (${lastRefused?.origin ?? 'nothing was reported'})`
  )
  log(
    Array.isArray(lastRefused?.allowed) && lastRefused.allowed.includes(ORIGIN),
    'and what it would have accepted instead, so the two can be compared without reading the source'
  )

  allowedOrigins = []
  const noOriginsConfigured = await connect()
  log(
    noOriginsConfigured.opened === false && noOriginsConfigured.refusal.includes('403'),
    'and a desktop that has configured no origins at all refuses every browser rather than accepting them all'
  )
  allowedOrigins = [ORIGIN]

  await serverR.stop()

  /* ================================================= PHASE B — the link */

  const devices = [{ id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }]
  const auth = makeAuth(devices)
  const server = makeServer(auth)
  active = server
  await server.start({ host: '127.0.0.1', port: PORT })

  /* --------------------------------------------- 1. the opening picture */

  const browser = await connect()
  browser.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-1',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => browser.first('hello-ok'), 8000, 'hello-ok')
  const ok = browser.first('hello-ok')
  log(!!ok && ok.proto === WEB_PROTO, 'a valid token for the configured uid from an approved device is let in')
  log(ok.projects?.[0]?.name === 'forge', 'hello-ok carries the project list')
  log(ok.profiles?.[0]?.id === 'shell', 'hello-ok carries the launchable profiles')
  log(!!ok.workspaces?.p1, 'hello-ok carries the workspaces the desktop is persisting')
  log(Array.isArray(ok.sessions), 'hello-ok carries the live session list')
  log(ok.appVersion === '0.0.0-smoke' && ok.desktopName === 'SMOKE-PC', 'and names the desktop and its version')

  /* --------------------------------------------- a real shell to drive */

  const created = manager.create({ id: 'w1', cwd: ROOT, cols: 90, rows: 30 })
  log(created.ok === true, 'spawned a real pwsh session for the browser to drive')
  if (!created.ok) throw new Error(created.error)
  // The *prompt*, not merely the first byte. A shell that has printed something
  // is not a shell that is ready to be typed at, and a write that lands in
  // ConPTY's buffer before the prompt exists is the whole flaky-test story.
  await waitFor(() => (replay.get('w1') ?? '').includes('> '), 25000, 'the first prompt')

  server.pushSessionStarted(manager.list().find((s) => s.id === 'w1'))
  await waitFor(() => browser.first('session-started'), 5000, 'session-started')
  log(browser.first('session-started').session.id === 'w1', 'a pane opening on the desktop is announced as an event, not only as a list')
  log(
    browser.first('session-started').session.pid === undefined,
    "and the frame carries no pid — shared/web.ts says it is absent on purpose, and this is where that stays true"
  )

  /* ---------------------------------------------------- 2. attach + replay */

  browser.send({ type: 'attach', sessionId: 'w1', cols: 100, rows: 32 })
  await waitFor(() => browser.first('replay'), 8000, 'replay frame')
  log(browser.first('replay').sessionId === 'w1', 'attach answers with the replay buffer first')
  log(browser.first('replay').data.length > 0, 'and that buffer carries the scrollback')
  log(browser.first('replay').truncated === false, `a buffer under MAX_REPLAY_BYTES (${MAX_REPLAY_BYTES}) is not marked truncated`)

  await waitFor(() => watches.length > 0, 5000, 'the watch announcement')
  log(watches.at(-1) === 'w1', 'a browser opening a pane says so, so the desktop can stand down and hand it the geometry')
  await waitFor(() => manager.list().find((s) => s.id === 'w1')?.cols === 100, 6000, "attach's own geometry")
  log(true, "and attach's optional cols/rows resized the real PTY to what the browser is reading it at")

  /* ------------------------------ 2b. a real byte, through a real PTY */

  const nonce = randomBytes(4).toString('hex')
  browser.send({ type: 'write', sessionId: 'w1', data: `echo forge-web-${nonce}\r` })
  await waitFor(() => browser.text('w1').includes(`forge-web-${nonce}`), 25000, 'the echo back down the socket')
  log(true, `a keystroke from the browser reached the real shell and came back (forge-web-${nonce})`)

  // The assertion above is satisfied by the shell echoing what was typed. This
  // one cannot be: the literal string only ever exists in pwsh's *output*,
  // because what was typed is a concatenation of two halves of it.
  const outNonce = randomBytes(4).toString('hex')
  browser.send({ type: 'write', sessionId: 'w1', data: `Write-Output ("forge-web-" + "${outNonce}")\r` })
  await waitFor(() => browser.text('w1').includes(`forge-web-${outNonce}`), 25000, "the shell's own output")
  log(true, "and a string that only exists in the shell's output — never in what was typed — came back too")

  /* ------------------------------------------------------------ 3. resize */

  browser.send({ type: 'resize', sessionId: 'w1', cols: 132, rows: 44 })
  await waitFor(() => manager.list().find((s) => s.id === 'w1')?.cols === 132, 6000, 'resize to land')
  const geometry = manager.list().find((s) => s.id === 'w1')
  log(geometry.cols === 132 && geometry.rows === 44, 'a resize from the browser resized the real PTY')

  /* ------------------------------- 11. typing into a pane that has gone */

  const errsBeforeStray = browser.of('error').length
  browser.send({ type: 'write', sessionId: 'never-existed', data: 'echo into-the-void\r' })
  await waitFor(() => browser.of('error').length > errsBeforeStray, 5000, 'the refusal of a write to a dead pane')
  log(
    browser.of('error').at(-1).code === 'unknown-session',
    'a write to a session that is not there is refused rather than swallowed — the client has already thrown its draft away'
  )

  /* -------------------------------------- 10. a layout request, and its no */

  layoutAnswer = 'Forge has no window open on the desktop, so it cannot open a tab.'
  browser.send({
    type: 'request',
    rid: 'r-layout-fail',
    body: { kind: 'layout', op: { op: 'create-tab', projectId: 'p1', profileId: 'shell' } }
  })
  await waitFor(() => browser.result('r-layout-fail'), 5000, 'the layout result')
  log(ops.at(-1).op.op === 'create-tab' && ops.at(-1).op.projectId === 'p1', 'a layout request reaches the injected host verbatim')
  log(ops.at(-1).deviceName === 'Chrome on Windows', 'carrying the name of the browser that asked')
  log(
    browser.result('r-layout-fail').body.kind === 'failed' &&
      browser.result('r-layout-fail').body.code === 'no-window' &&
      browser.result('r-layout-fail').body.message === layoutAnswer,
    "and the desktop's refusal comes back as { kind: 'failed' } on the same rid rather than being dropped on the floor"
  )

  layoutAnswer = null
  browser.send({
    type: 'request',
    rid: 'r-layout-ok',
    body: { kind: 'layout', op: { op: 'select-tab', projectId: 'p1', tabId: 'tab-1' } }
  })
  await waitFor(() => browser.result('r-layout-ok'), 5000, 'the accepted layout result')
  log(browser.result('r-layout-ok').body.kind === 'ok', 'an accepted layout request answers ok on its own rid')
  log(ops.at(-1).op.tabId === 'tab-1', 'and its tab id survived the wire')

  /* ------------------------------------------- 9. two requests in flight */

  browser.send({ type: 'request', rid: 'r-skills', body: { kind: 'skills' } })
  browser.send({ type: 'request', rid: 'r-commands', body: { kind: 'commands' } })
  await waitFor(() => releaseSkills && releaseCommands, 5000, 'both requests to reach the host')
  // Answered in the opposite order to the one they arrived in, which is the
  // only way to prove the correlation is by rid rather than by arrival.
  releaseCommands()
  await waitFor(() => browser.result('r-commands'), 5000, 'the commands result')
  log(browser.result('r-commands').body.kind === 'commands', 'of two requests in flight, the second to be answered lands on its own rid')
  log(browser.result('r-skills') === undefined, 'and the first is still outstanding, not answered with the other one')
  releaseSkills()
  await waitFor(() => browser.result('r-skills'), 5000, 'the skills result')
  log(browser.result('r-skills').body.kind === 'skills', 'and the first lands on its rid when it finally answers')

  browser.send({ type: 'request', rid: 'r-git', body: { kind: 'git-status', projectId: 'p1' } })
  await waitFor(() => browser.result('r-git'), 5000, 'the git result')
  log(browser.result('r-git').body.snapshot?.branch === 'master', 'a git-status request answers with the snapshot the desktop read')

  browser.send({ type: 'request', rid: 'r-nogit', body: { kind: 'git-status', projectId: 'nope' } })
  await waitFor(() => browser.result('r-nogit'), 5000, 'the unknown-project result')
  log(
    browser.result('r-nogit').body.code === 'unknown-project',
    'and a project this desktop does not have is unknown-project rather than a promise that never settles'
  )

  browser.send({ type: 'request', rid: 'r-future', body: { kind: 'invented-by-a-newer-client' } })
  await waitFor(() => browser.result('r-future'), 5000, 'the unsupported result')
  log(
    browser.result('r-future').body.kind === 'failed' && browser.result('r-future').body.code === 'unsupported',
    'a request kind this build has never heard of is answered unsupported, so a newer client never hangs'
  )

  /* ------------------------------------------------------ the auth refresh */

  browser.send({ type: 'auth', rid: 'r-auth', idToken: mint() })
  await waitFor(() => browser.result('r-auth'), 8000, 'the auth refresh result')
  log(browser.result('r-auth').body.kind === 'ok', 'a fresh token presented mid-connection is re-verified and answered ok')

  /* ------------------------- 7. nothing but hello, before authentication */

  const sneaky = await connect()
  sneaky.send({ type: 'attach', sessionId: 'w1' })
  await waitFor(() => sneaky.closed !== null, 5000, 'the unauthenticated attach to be refused')
  log(sneaky.first('replay') === undefined, 'an attach sent before hello gets no replay — a live pane it named is not handed over')
  log(sneaky.of('data').length === 0, 'and no live data either')
  log(
    sneaky.closed === 4001 && sneaky.first('error')?.code === 'bad-frame',
    'the socket is dropped for it rather than left holding a slot'
  )

  const sneakyPing = await connect()
  sneakyPing.send({ type: 'ping' })
  await waitFor(() => sneakyPing.closed !== null, 5000, 'the unauthenticated ping to be refused')
  log(
    sneakyPing.closed === 4001 && sneakyPing.of('pong').length === 0,
    'and not even a ping is honoured first — the real heartbeat is the native one, so nothing needs this carve-out'
  )

  /* -------------------------------------------------------- 6. the limits */

  const errsBeforeBigWrite = browser.of('error').length
  browser.send({ type: 'write', sessionId: 'w1', data: 'x'.repeat(MAX_WRITE_CHARS + 1) })
  await waitFor(() => browser.of('error').length > errsBeforeBigWrite, 5000, 'the over-long write refusal')
  log(
    browser.of('error').at(-1).code === 'limit',
    `a write over MAX_WRITE_CHARS (${MAX_WRITE_CHARS}) is answered error/limit, not dropped in silence`
  )

  const limits = () => browser.of('error').filter((e) => e.code === 'limit').length
  const limitsBeforeBurst = limits()
  for (let i = 0; i < MAX_INPUT_PER_SECOND * 2; i++) browser.send({ type: 'ping' })
  await waitFor(() => limits() > limitsBeforeBurst, 5000, 'the rate-limit refusal')
  log(true, `a burst past MAX_INPUT_PER_SECOND (${MAX_INPUT_PER_SECOND}) is answered error/limit rather than silently dropped`)
  log(browser.of('pong').length <= MAX_INPUT_PER_SECOND, 'and the frames past the ceiling were not acted on')
  log(
    limits() === limitsBeforeBurst + 1,
    'and the refusal is said once for the exhausted second — answering every dropped frame is the flood arriving twice'
  )
  // Past the exhausted second, so nothing after this is dropped by a counter
  // that has nothing to do with what it is checking.
  await sleep(1100)

  const oversized = await connect()
  oversized.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-1',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(
    () => oversized.first('hello-ok') || oversized.first('refused') || oversized.closed !== null,
    8000,
    'the second hello to be answered'
  )
  const secondRefusal = oversized.first('refused')
  log(
    !!oversized.first('hello-ok'),
    `a second browser is let in alongside the first${secondRefusal ? ` (refused: ${secondRefusal.reason})` : ''}`
  )
  oversized.raw(`{"type":"write","sessionId":"w1","data":"${'z'.repeat(MAX_FRAME_BYTES + 1024)}"}`)
  await waitFor(() => oversized.closed !== null, 5000, 'the oversized frame to close the socket')
  log(
    oversized.closed !== null,
    `a frame over MAX_FRAME_BYTES (${MAX_FRAME_BYTES}) closes the socket at ws's own maxPayload, before a string ever exists`
  )

  /* --------------------------------------------------- the HTTP side */

  const health = await fetch(`http://127.0.0.1:${PORT}/health`)
  log(health.status === 200 && (await health.json()).ok === true, 'the liveness probe answers, and says nothing but yes')
  const nothing = await fetch(`http://127.0.0.1:${PORT}/`)
  log(nothing.status === 404, 'and there is no bundle here — Firebase Hosting serves the client')

  /* -------------------------------------------- 13. the way out is announced */

  await server.stop({ reason: 'quit', message: 'Forge is closing on the desktop.' })
  await waitFor(() => browser.first('shutdown'), 5000, 'the shutdown frame')
  log(
    browser.first('shutdown').reason === 'quit' && browser.first('shutdown').message.length > 0,
    'a shutdown frame is sent before the server closes, so the page drops to GitHub mode instead of retrying a machine that is off'
  )
  await waitFor(() => browser.closed !== null, 5000, 'the socket to close behind it')
  log(browser.closed === 1001, 'and then the socket closes')

  /* ============================================= PHASE C — the unlock PIN
   *
   * A third server, with a PIN on it. scripts/web-auth-check.mjs proves the
   * decision; what only this file can prove is that it reaches the *socket* —
   * that a browser with no PIN is turned away over the wire with a refusal it
   * can act on, and never sees the opening picture.
   */

  const PIN = '824159'
  const devicesC = []
  const authC = makeAuth(devicesC, { pinHash: () => hashPin(PIN) })
  const serverC = makeServer(authC)
  active = serverC
  await serverC.start({ host: '127.0.0.1', port: PORT })

  const helloC = (tab, extra = {}) =>
    tab.send({
      type: 'hello',
      proto: WEB_PROTO,
      idToken: mint(),
      client: '0.0.0-smoke',
      deviceId: 'brand-new-browser',
      deviceName: 'Firefox on Linux',
      ...extra
    })

  const askedForPin = await connect()
  helloC(askedForPin)
  await waitFor(() => askedForPin.first('refused'), 8000, 'the pin-required refusal')
  const wantsPin = askedForPin.first('refused')
  log(wantsPin.reason === 'pin-required', 'a browser reaching a desktop with a PIN set is refused pin-required')
  log(typeof wantsPin.message === 'string' && wantsPin.message.length > 0, 'with a sentence to put above the PIN box')
  log(!askedForPin.first('hello-ok'), 'and never sees the opening picture')
  log(authC.devices().length === 0, 'and nothing is recorded for it')

  /* --------------------------------------------- 12. a wrong PIN, and the right one */

  const wrongPin = await connect()
  helloC(wrongPin, { pin: '000000' })
  await waitFor(() => wrongPin.first('refused'), 8000, 'the pin-invalid refusal')
  log(wrongPin.first('refused').reason === 'pin-invalid', 'a wrong PIN is refused pin-invalid over the same wire')
  log(!wrongPin.first('hello-ok'), 'and it too is told nothing else')

  const withPin = await connect()
  helloC(withPin, { pin: PIN })
  await waitFor(() => withPin.first('hello-ok'), 8000, 'the browser that knows the PIN')
  log(Boolean(withPin.first('hello-ok')), 'the right PIN gets the same browser the whole opening picture')
  log(
    authC.devices().some((d) => d.id === 'brand-new-browser'),
    'and it is recorded in the device list, so it can be revoked later'
  )
  withPin.socket.close()

  await serverC.stop()

  /* ===================================================== PHASE D — heartbeat */

  // The shipped numbers are twenty seconds and ten; injected short here so the
  // timer actually fires inside a smoke run. The mechanism is the native
  // WebSocket ping, so the browser is made to stop answering it by switching
  // ws's automatic pong off — which is exactly what a wedged tab looks like
  // from this side.
  log(HEARTBEAT_MS === 20_000 && HEARTBEAT_GRACE_MS === 10_000, 'the shipped heartbeat is a ping every 20s with 10s to answer')

  const beatMs = 200
  const graceMs = 300
  const authD = makeAuth([{ id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }])
  const serverD = makeServer(authD, { heartbeatMs: beatMs, heartbeatGraceMs: graceMs })
  active = serverD
  await serverD.start({ host: '127.0.0.1', port: PORT })

  const deaf = await connect({ autoPong: false })
  deaf.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-1',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => deaf.first('hello-ok'), 8000, 'the deaf browser to be let in')
  const openedAt = Date.now()
  await waitFor(() => deaf.closed !== null, 5000, 'the deaf socket to be dropped')
  const took = deaf.closedAt - openedAt
  log(deaf.closed === 4008, 'a browser that stops answering the native ping is closed with a heartbeat code')
  log(
    took < (beatMs + graceMs) * 3,
    `and inside the grace window rather than whenever a sweep next happens (${took}ms, ping ${beatMs}ms + grace ${graceMs}ms)`
  )

  // The other half: a browser that *is* answering must not be dropped by the
  // same timer. Same server, same short heartbeat, several beats of silence.
  const alive = await connect()
  alive.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-1',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => alive.first('hello-ok'), 8000, 'the live browser to be let in')
  await sleep((beatMs + graceMs) * 4)
  log(alive.closed === null, 'while a browser that answers it survives, however quiet the link goes')

  /* ------------------------------------------------ revoking a live socket */

  log(authD.revoke('browser-1') === true, 'an approved browser can be revoked at the desk')
  serverD.disconnectDevice('browser-1')
  await waitFor(() => alive.closed !== null, 5000, 'the revoked socket to close')
  log(
    alive.closed === 4003 && alive.first('refused')?.reason === 'revoked',
    'and revoking hangs up on the live socket with a reason, not just on the next one'
  )

  await serverD.stop()

  /* ================================== PHASE E — the screen mirror, and the
   *                                             one frame that ends at the OS
   *
   * Everything else on this link ends inside Forge. A `mirror-frame` ends at a
   * decoder somewhere on the internet and a `mirror-input` ends at `user32`, so
   * this phase drives the real relay over a real socket rather than reasoning
   * about it — including the two things that are only true because the code
   * says so in one place: that a refused control is *one* sentence per watch,
   * and that pointer frames spend a budget of their own rather than the one
   * that answers keystrokes.
   *
   * The gates that decide whether any of it may happen at all — the settings
   * and the escalation guard — are electron/web-host.ts's and are not in this
   * file, which is the same division phase D observes: this server relays and
   * counts, and the host says yes or no. What is asserted here is that a "no"
   * arrives as a sentence and that a "yes" arrives intact — including the one
   * "no" that is really a question, which is the fresh PIN a watch asks for.
   */

  const MIRROR_PIN = '246813'
  /** Set only for the escalation check below; '' for every phase before it. */
  let mirrorPin = ''
  const devicesE = [
    { id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 },
    { id: 'browser-2', name: 'Firefox', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }
  ]
  const authE = makeAuth(devicesE, { pinHash: () => mirrorPin })

  /** An authenticated tab, the shape every check below starts from. */
  const admitted = async (deviceId) => {
    const tab = await connect()
    tab.send({
      type: 'hello',
      proto: WEB_PROTO,
      idToken: mint(),
      client: '0.0.0-smoke',
      deviceId,
      deviceName: 'Chrome on Windows'
    })
    await waitFor(() => tab.first('hello-ok'), 8000, `${deviceId} to be let in`)
    return tab
  }

  /* ------------------------------------- 16. a desktop that cannot be watched */

  // The base `makeServer` supplies no mirror hooks at all, which is exactly the
  // shape of an older Forge and of any future host that has not thought about
  // this. It must refuse rather than half-start something and leave a tab on a
  // black rectangle.
  const serverBare = makeServer(authE)
  active = serverBare
  await serverBare.start({ host: '127.0.0.1', port: PORT })

  const bare = await admitted('browser-1')
  bare.send({ type: 'mirror-start' })
  await waitFor(() => bare.first('mirror-stop'), 5000, 'the refusal from a host with no mirror hooks')
  log(
    typeof bare.first('mirror-stop').reason === 'string' && bare.first('mirror-stop').reason.length > 0,
    'a host that supplies no mirror hooks refuses to be watched, with a sentence rather than a silence'
  )
  log(serverBare.mirroring === false, 'and no viewer was created by the asking')

  await serverBare.stop()

  /* ------------------------------------------------ the desktop that can be */

  const starts = []
  /** Every edge of `onMirror`, in order — true when a watch begins, false when it ends. */
  const edges = []
  const inputs = []
  let startRefusal = null
  /** Stands in for the escalation guard and the control toggle behind it. */
  let controlAllowed = false
  const serverE = makeServer(authE, {
    // The desktop's own answer, in the shape electron/web-host.ts's
    // `startMirror` gives it: the relay hands the PIN straight over, and what
    // decides is `checkFreshPin` on the real WebAuth rather than a stand-in
    // written to agree with it.
    mirrorStart: (pin) => {
      starts.push(pin)
      const fresh = authE.checkFreshPin(pin)
      if (!fresh.ok) return { error: fresh.message, ...(fresh.needed ? { needsPin: true } : {}) }
      return startRefusal
    },
    onMirror: (watching) => edges.push(watching),
    // The desktop's own two answers, exactly as electron/web-host.ts gives
    // them: may anybody drive at all, and here is one input to perform. Both
    // are read per call, because that is what makes switching control off stop
    // the *next* event rather than the next session.
    mirrorControl: () => controlAllowed,
    mirrorInput: (input) => {
      if (!controlAllowed) return false
      inputs.push(input)
      return true
    }
  })
  active = serverE
  await serverE.start({ host: '127.0.0.1', port: PORT })

  /* -------------------------------------------------- 17. a viewer starts */

  const viewer = await admitted('browser-1')
  viewer.send({ type: 'mirror-start', pin: '123456' })
  await waitFor(() => starts.length > 0, 5000, 'the mirrorStart hook call')
  log(starts[0] === '123456', 'the PIN a browser typed reaches the desktop verbatim — the relay never reads it')
  log(serverE.mirroring === true, 'and the server now considers itself mirroring')
  log(edges.at(-1) === true, 'the desk is told a watch has begun, so it can say so and raise a notification')

  /* ---------------------------- 18. what the decoder is configured with */

  serverE.pushMirrorReady({ codec: 'vp8', width: 1920, height: 1080 })
  await waitFor(() => viewer.first('mirror-ok'), 5000, 'the mirror-ok frame')
  const mirrorOk = viewer.first('mirror-ok')
  log(
    mirrorOk.codec === 'vp8' && mirrorOk.width === 1920 && mirrorOk.height === 1080,
    'mirror-ok carries what a decoder has to be configured with, from the renderer that chose it'
  )
  log(
    mirrorOk.canControl === false,
    'and says plainly that this desktop will not be driven, so a tab never offers a cursor it cannot deliver'
  )

  /* --------------------------------------- 19. the picture, to the viewer only */

  const bystander = await admitted('browser-2')
  serverE.pushMirrorFrame({ data: 'AAAA', key: true, timestamp: 0 })
  await waitFor(() => viewer.of('mirror-frame').length > 0, 5000, 'the chunk to reach the viewer')
  log(viewer.first('mirror-frame').key === true, 'a chunk reaches the viewer with the one bit a decoder needs per frame')
  log(
    bystander.of('mirror-frame').length === 0 && bystander.of('mirror-ok').length === 0,
    'and a second authenticated browser is sent neither the picture nor the means to decode it'
  )

  /* ------------------------------------------- 20. one screen at a time */

  const startsBeforeSecond = starts.length
  bystander.send({ type: 'mirror-start' })
  await waitFor(() => bystander.first('mirror-stop'), 5000, 'the second viewer to be refused')
  log(
    typeof bystander.first('mirror-stop').reason === 'string' && bystander.first('mirror-stop').reason.length > 0,
    'a second browser asking while one is watching gets a mirror-stop with a reason'
  )
  log(starts.length === startsBeforeSecond, 'and the desktop is never asked to start a second capture')
  log(serverE.mirroring === true, 'the original viewer is still the viewer')

  /* ------------------------------- 21. the same browser asking again is a restart
   *
   * A tab's own attempt can die where this side cannot see it — a decoder that
   * would not configure, a reload — leaving the server still believing it has a
   * watcher. Refusing that tab's retry would tell the only browser in the room
   * that it was busy watching itself.
   */

  const startsBeforeRestart = starts.length
  const edgesBeforeRestart = edges.length
  const viewerStopsBeforeRestart = viewer.of('mirror-stop').length
  viewer.send({ type: 'mirror-start' })
  await waitFor(() => starts.length > startsBeforeRestart, 5000, 'the restart from the browser already watching')
  log(starts.length === startsBeforeRestart + 1, 'the browser already watching can ask again, and the desktop starts over')
  log(viewer.of('mirror-stop').length === viewerStopsBeforeRestart, 'it is never told another browser is watching')
  log(serverE.mirroring === true, 'and it is still the viewer afterwards')
  log(
    edges.length === edgesBeforeRestart,
    'and the desk is not told a second time — a tab retrying in a loop must not be a notification a second'
  )

  /* --------------------------------- 22. only the screen that is watching drives */

  const straysBefore = inputs.length
  const bystanderErrsBefore = bystander.of('error').length
  bystander.send({ type: 'mirror-input', a: 'move', x: 0.5, y: 0.5 })
  // Nothing to wait *for* — the assertion is that nothing happens — so the
  // proof is a frame that does travel, sent afterwards on the same socket.
  bystander.send({ type: 'ping' })
  await waitFor(() => bystander.of('pong').length > 0, 5000, 'a frame behind the stray input')
  log(inputs.length === straysBefore, 'an input from a browser that is not watching the screen never reaches the desktop')
  log(
    bystander.of('error').length === bystanderErrsBefore,
    'and is dropped in silence: a frame from a socket that has just stopped watching is timing, not an attack'
  )

  /* ------------------------ 23. a refused control is one sentence, not a hundred */

  const errsBeforeRefusal = viewer.of('error').length
  for (let i = 0; i < 20; i++) viewer.send({ type: 'mirror-input', a: 'move', x: 0.5, y: 0.5 })
  await waitFor(() => viewer.of('error').length > errsBeforeRefusal, 5000, 'the refusal of a control that is switched off')
  // "Exactly one" is a claim about the whole burst, not about the first refusal
  // having arrived — so a frame sent behind the twenty and answered is what
  // settles it. Without this the check would pass on a second error still in
  // flight.
  const pongsBeforeSettle = viewer.of('pong').length
  viewer.send({ type: 'ping' })
  await waitFor(() => viewer.of('pong').length > pongsBeforeSettle, 5000, 'the frame sent behind the burst')
  log(
    viewer.of('error').length === errsBeforeRefusal + 1,
    'a burst of input at a desktop that refuses control draws exactly one error, not one per press'
  )
  log(
    viewer.of('error').at(-1).code === 'unsupported',
    'and it is answered rather than dropped, so the tab can stop offering a cursor'
  )
  log(inputs.length === straysBefore, 'and not one of the twenty reached the desktop')

  /* ------------------------------ 24. the watching screen drives, once allowed */

  controlAllowed = true
  viewer.send({ type: 'mirror-input', a: 'move', x: 0.25, y: 0.75 })
  await waitFor(() => inputs.length > straysBefore, 5000, 'the first input to reach the desktop')
  log(
    inputs.at(-1).a === 'move' && inputs.at(-1).x === 0.25 && inputs.at(-1).y === 0.75,
    'a move from the watching browser reaches the desktop with its coordinates intact'
  )

  viewer.send({ type: 'mirror-input', a: 'down', button: 'left', x: 0.5, y: 0.5 })
  await waitFor(() => inputs.at(-1).a === 'down', 5000, 'the button press')
  log(inputs.at(-1).button === 'left', 'and a button press names its button')

  viewer.send({ type: 'mirror-input', a: 'move', x: 4, y: -3 })
  await waitFor(() => inputs.at(-1).a === 'move', 5000, 'the clamped move')
  log(
    inputs.at(-1).x === 1 && inputs.at(-1).y === 0,
    'a coordinate outside the screen is clamped to its edge by the same readMirrorInput the phone link uses'
  )

  const shapelessBefore = inputs.length
  const errsBeforeShapeless = viewer.of('error').length
  viewer.send({ type: 'mirror-input', a: 'key', key: 'f13', down: true })
  await waitFor(() => viewer.of('error').length > errsBeforeShapeless, 5000, 'the refusal of a key nobody listed')
  log(viewer.of('error').at(-1).code === 'bad-frame', 'a key outside the closed list is refused as bad-frame')
  log(inputs.length === shapelessBefore, 'and never reaches the desktop')

  /* ------------------- 25. the pointer's budget is not the terminal's budget
   *
   * The whole reason `mirror-input` is counted separately. A pointer moving
   * smoothly is thirty frames a second; if those spent the budget that answers
   * `write`, the half of this link that stalls would be the terminal.
   */

  const burst = MAX_MIRROR_INPUT_PER_SECOND * 3
  const actedBefore = inputs.length
  const limitsBefore = viewer.of('error').filter((e) => e.code === 'limit').length
  const pongsBefore = viewer.of('pong').length
  for (let i = 0; i < burst; i++) viewer.send({ type: 'mirror-input', a: 'move', x: 0.5, y: 0.5 })
  viewer.send({ type: 'ping' })
  await waitFor(() => viewer.of('pong').length > pongsBefore, 8000, 'the ping sent behind the burst')
  log(
    viewer.of('error').filter((e) => e.code === 'limit').length === limitsBefore,
    `a burst of ${burst} pointer frames spends none of MAX_INPUT_PER_SECOND (${MAX_INPUT_PER_SECOND}) — the terminal's budget is untouched`
  )
  log(
    inputs.length - actedBefore < burst,
    `while the pointer's own ceiling of ${MAX_MIRROR_INPUT_PER_SECOND} a second still bites (${inputs.length - actedBefore} of ${burst} were acted on)`
  )
  await sleep(1100)

  /* -------------------------------- 26. a chunk too big to send ends the watch */

  const edgesBeforeOversized = edges.length
  serverE.pushMirrorFrame({ data: 'A'.repeat(MAX_MIRROR_CHUNK_BYTES * 2), key: true, timestamp: 1 })
  await waitFor(() => viewer.of('mirror-stop').length > viewerStopsBeforeRestart, 5000, 'the oversized chunk to end the watch')
  log(
    viewer.of('mirror-stop').at(-1).reason.length > 0,
    `a chunk over MAX_MIRROR_CHUNK_BYTES (${MAX_MIRROR_CHUNK_BYTES}) ends the watch with a sentence rather than showing a picture that cannot decode`
  )
  log(serverE.mirroring === false && edges.length === edgesBeforeOversized + 1, 'and the desktop is told to stop capturing')

  /* ------------------------------------------------- 27. a hang-up ends it */

  viewer.send({ type: 'mirror-start' })
  await waitFor(() => serverE.mirroring === true, 5000, 'the watch to begin again')
  const edgesBeforeHangup = edges.length
  viewer.socket.close()
  await waitFor(() => edges.length > edgesBeforeHangup, 5000, 'the hang-up to end the watch')
  log(edges.at(-1) === false, "the viewer's own hang-up tells the desktop to stop capturing")
  log(serverE.mirroring === false, 'and the server is no longer mirroring')

  /* ------------------------- 27b. the fresh PIN, before the picture starts
   *
   * The escalation the whole mirror block rests on: a desktop with a PIN set
   * asks for it *again* at `mirror-start`, and the refusal carries the one bit
   * that makes a browser draw a PIN box rather than an apology.
   */

  mirrorPin = hashPin(MIRROR_PIN)
  const stopsBeforePin = bystander.of('mirror-stop').length
  bystander.send({ type: 'mirror-start' })
  await waitFor(() => bystander.of('mirror-stop').length > stopsBeforePin, 5000, 'the refusal that asks for a PIN')
  const mirrorWantsPin = bystander.of('mirror-stop').at(-1)
  log(mirrorWantsPin.needsPin === true, 'a watch asked for on a desktop with a PIN set comes back needing one')
  log(
    typeof mirrorWantsPin.reason === 'string' && mirrorWantsPin.reason.length > 0,
    'with a sentence to put above the box, rather than a bare refusal'
  )
  log(serverE.mirroring === false, 'and no watch began, so the browser can ask again once it has the PIN')

  const stopsBeforeWrong = bystander.of('mirror-stop').length
  bystander.send({ type: 'mirror-start', pin: '999999' })
  await waitFor(() => bystander.of('mirror-stop').length > stopsBeforeWrong, 5000, 'the refusal of a wrong PIN')
  log(
    bystander.of('mirror-stop').at(-1).needsPin === undefined,
    'a wrong PIN is a failure rather than a question, so the page shows an apology and not another box'
  )

  bystander.send({ type: 'mirror-start', pin: MIRROR_PIN })
  await waitFor(() => serverE.mirroring === true, 5000, 'the watch to begin once the PIN is right')
  log(serverE.mirroring === true, 'and the right PIN starts the capture')

  // Closed by the browser, and the desktop put back to no-PIN: the last check is
  // about the relay tearing a watch down rather than about the lock in front of
  // it, and it starts from no viewer.
  bystander.send({ type: 'mirror-stop' })
  await waitFor(() => serverE.mirroring === false, 5000, 'the viewer to close its own watch')
  mirrorPin = ''

  /* ---------------------------------------------- 28. and so does stop() */

  bystander.send({ type: 'mirror-start' })
  await waitFor(() => serverE.mirroring === true, 5000, 'the second browser to take the screen')
  const edgesBeforeStop = edges.length
  await serverE.stop()
  log(
    edges.length === edgesBeforeStop + 1 && edges.at(-1) === false,
    'and a server stopping tears the capture down with it, rather than leaving a desktop encoding for nobody'
  )
  log(serverE.mirroring === false, 'with no viewer left behind to refuse the next one')

  /* ---------------------------------------------------------------- done */

  manager.killAll()
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nweb:smoke — all checks passed' : `\nweb:smoke — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })

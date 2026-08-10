/**
 * The Forge Web client, in a real browser, against a real desktop.
 *
 *   npm run web:e2e
 *
 * This is Phase 3's gate in docs/forge-web.md, and it is written to the bar
 * scripts/web-smoke.mjs set: the *real* `WebServer`, the *real* `WebAuth`, and a
 * *real* `PtySessionManager` with a *real* pwsh on the other end. What is new is
 * the half that smoke test could not reach — the client. Chrome loads the actual
 * `web/` bundle, signs in through the actual form, and the assertion the whole
 * feature exists for is that a nonce typed on a keyboard comes back out of a
 * ConPTY and lands on screen.
 *
 * ## What is stubbed, and what is not
 *
 * Exactly one thing is stubbed: Google. A tiny HTTP server stands in for the
 * Identity Toolkit, the securetoken endpoint and the Realtime Database, because
 * the alternative is a test that needs somebody's Firebase project and their
 * password. Everything about that stub is the *shape* Google publishes: the
 * sign-in response is the one `Auth.signIn` parses, the refresh response is the
 * one `Auth.idToken` parses, the rendezvous record is the one `parseHostRecord`
 * reads, and the ID tokens are RS256 JWTs signed by a key served as an X.509
 * certificate — the construction from scripts/web-smoke.mjs, restated here for
 * the reason that file gives, which is that each check bundles stand-alone.
 *
 * The token verifier is the real one and it is not told to trust anything: the
 * JWKS *fetcher* is injected, exactly as `JwksFetcher`'s comment intends, and
 * every claim check in electron/web/auth.ts runs for real.
 *
 * ## Why the dev server rather than the built bundle
 *
 * A built bundle cannot dial this desktop, by design. `webSocketUrl` refuses a
 * loopback address unless the caller opts in, and the client's only opt-in
 * (`__DEV_SERVER__`, see web/vite.config.ts) is compiled out of everything
 * `vite build` emits — which is the property that stops a hostile rendezvous
 * record steering a real session onto a plaintext socket. So the browser here is
 * pointed at Vite's dev server, which is also the loop `npm run web:dev` runs,
 * and `npm run web:build` is what proves the production artefact compiles. A run
 * that dialled a *tunnel* would need a tunnel, a certificate and a public
 * hostname, none of which belong in a check.
 *
 * ## Why the phases
 *
 * Each phase gets its own port, its own `WebServer` and its own `WebAuth`, for
 * the reason web-smoke sets out at length: the failure lockout in auth.ts is per
 * source address and every socket here comes from 127.0.0.1, so a phase that
 * spends a strike must not be able to fail the next one for a reason that has
 * nothing to do with what it is testing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-e2e')
const shots = join(scratch, 'shots')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const STUB_PORT = 8491
const VITE_PORT = 5179
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const OTHER_UID = 'ZZZo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const PROJECT = 'forge-web-e2e'
const KID = 'a1b2c3d4e5f6'
const EMAIL = 'steve@example.com'
/** The one deviceId this browser profile uses, seeded so phases can address it. */
const DEVICE_ID = 'e2e-browser'
const ORIGIN = `http://localhost:${VITE_PORT}`

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const tick = async () => {
      try {
        if (await predicate()) return resolvePromise()
      } catch {
        /* a predicate that throws mid-navigation is a "not yet" */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 120)
    }
    void tick()
  })
}

/* -------------------------------------------------- a certificate authority
 *
 * Minimal DER, lifted from scripts/web-smoke.mjs — a v1 certificate is a serial,
 * an algorithm, a name, a validity window and the SPKI, and node:crypto hands
 * over the last of those ready-made. Serving a bare public key instead would
 * mean the production path, parsing what Google actually sends, was the one path
 * never exercised.
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

/* ------------------------------------------------------------ the workspace
 *
 * One project, one tab, one pane — and the pane's id is the PTY session id,
 * exactly as `PaneLeaf` says it is on the desktop. That identity is what lets
 * the browser draw a pane from the workspace and attach to the live shell behind
 * it without a second lookup.
 */

const SESSION_ID = 'w1'
const PROJECTS = [
  { id: 'p1', name: 'forge', path: ROOT, color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 }
]
const PROFILES = [{ id: 'shell', name: 'Shell', command: '', accent: '#8e9093', badge: 'SH' }]
const WORKSPACES = {
  p1: {
    tabs: [
      {
        id: 't1',
        title: 'e2e',
        root: { type: 'leaf', id: SESSION_ID, profileId: 'shell', title: '' },
        activePaneId: SESSION_ID
      }
    ],
    activeTabId: 't1'
  }
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'web-e2e-entry.ts')],
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

  const { WebServer, WebAuth, PtySessionManager, WEB_PROTO, webHostPath } = await import(
    pathToFileURL(join(scratch, 'web.mjs')).href
  )

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

  /* ------------------------------------------------------- the Google stub */

  /** Swapped between phases: which uid the minted token claims to be. */
  let tokenSub = UID
  /** What `users/<uid>/host` currently holds, or null for "nobody is home". */
  let hostRecord = null
  const rtdbReads = []

  const stub = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`)
    // The page is served from localhost:5179 and these are on 127.0.0.1, so
    // every call is cross-origin and a JSON POST is preflighted.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end()
      return
    }
    const json = (body) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body))

    if (url.pathname === '/identitytoolkit/v1/accounts:signInWithPassword') {
      json({
        idToken: mint({ sub: tokenSub }),
        refreshToken: 'refresh-e2e',
        expiresIn: '3600',
        localId: UID,
        email: EMAIL
      })
      return
    }
    if (url.pathname === '/securetoken/v1/token') {
      json({ id_token: mint({ sub: tokenSub }), refresh_token: 'refresh-e2e', expires_in: '3600', user_id: UID })
      return
    }
    if (url.pathname === `/rtdb/${webHostPath(UID)}.json`) {
      rtdbReads.push(url.searchParams.get('auth') ?? '')
      json(hostRecord)
      return
    }
    res.writeHead(404, cors).end('no')
  })
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

  /* --------------------------------------------------------- the desktop */

  // `active` stands in for web-host's PTY sink: the manager's callbacks close
  // over a mutable reference so one live shell outlives each phase's server.
  let active = null
  /** True while a browser has the pane open — see `answerCursorQuery`. */
  let watched = false
  const replay = new Map()
  const manager = new PtySessionManager({
    maxSessions: 4,
    // `-NoProfile` for the reason web-smoke gives: Steve's own pwsh profile
    // installs shell integration and a prompt that takes tens of seconds, and a
    // check that waited for it would be measuring his dotfiles.
    shellArgs: ['-NoLogo', '-NoProfile'],
    onData: (id, data) => {
      replay.set(id, (replay.get(id) ?? '') + data)
      active?.pushData(id, data)
      answerCursorQuery(id, data)
    },
    onExit: (id, exitCode) => active?.pushExit(id, exitCode)
  })

  /**
   * Answer `CSI 6 n` — but only while no browser is attached.
   *
   * pwsh asks constantly and hardest right after a resize, and with nothing on
   * the end of the PTY ConPTY waits out a timeout instead: web-smoke measured 39
   * seconds for one resize against 47ms once the question is answered. Before
   * the browser connects there is nothing else to answer it, so this does.
   *
   * The moment a browser attaches, xterm.js answers it for real — which is the
   * whole point of decision 6 — and answering it *as well* would put two replies
   * into PSReadLine for one question. `onWatch` is what tells the two apart, and
   * it fires on every attach, detach, exit and hangup.
   */
  const answerCursorQuery = (id, data) => {
    if (watched) return
    const asked = data.match(/\x1b\[6n/g)
    for (let i = 0; i < (asked?.length ?? 0); i++) manager.write(id, '\x1b[1;1R')
  }

  const layoutOps = []
  const makeAuth = (devices, extra = {}) => {
    let saved = devices
    return new WebAuth({
      load: () => saved,
      save: (next) => {
        saved = next
      },
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID,
      ...extra
    })
  }

  const makeServer = (auth) =>
    new WebServer({
      auth,
      appVersion: '0.0.0-e2e',
      desktopName: () => 'E2E-PC',
      allowedOrigins: () => [ORIGIN],
      sessions: () => manager.list(),
      replay: (id) => replay.get(id) ?? '',
      write: (id, data) => manager.write(id, data),
      resize: (id, cols, rows) => manager.resize(id, cols, rows),
      snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: WORKSPACES }),
      layout: async (op, deviceName) => {
        layoutOps.push({ op, deviceName })
        return null
      },
      agents: async (commands) => ({ agents: [], commands: commands.map((c) => ({ command: c, exe: c, found: true, unknown: false })) }),
      onWatch: (ids) => {
        watched = ids.length > 0
      }
    })

  /** Start a phase: a fresh port, a fresh WebAuth, a fresh WebServer. */
  let port = 8500
  let server = null
  const startPhase = async (devices, extra = {}) => {
    if (server) await server.stop()
    port += 1
    server = makeServer(makeAuth(devices, extra))
    active = server
    await server.start({ host: '127.0.0.1', port })
    return port
  }

  /* ------------------------------------------------------ the client, served */

  /**
   * `/config.json` from memory rather than from `web/public`, so a check run
   * leaves no file behind in the repo for the next `vite build` to ship.
   */
  let config = {}
  const vite = await createViteServer({
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    server: { port: VITE_PORT, strictPort: true },
    logLevel: 'error',
    plugins: [
      {
        name: 'forge-web-e2e-config',
        configureServer(dev) {
          dev.middlewares.use('/config.json', (_req, res) => {
            res.setHeader('content-type', 'application/json')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify(config))
          })
        }
      }
    ]
  })
  await vite.listen()

  const setConfig = (extra) => {
    config = {
      apiKey: 'e2e-key',
      databaseUrl: `http://127.0.0.1:${STUB_PORT}/rtdb`,
      authBase: `http://127.0.0.1:${STUB_PORT}/identitytoolkit/v1`,
      tokenBase: `http://127.0.0.1:${STUB_PORT}/securetoken/v1`,
      ...extra
    }
  }

  /* ------------------------------------------------------------- the browser */

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // The device id is the one thing a phase needs to be able to name — a revoked
  // browser has to be *this* browser. Seeded rather than read back so no phase
  // depends on a previous one having run.
  await context.addInitScript(`localStorage.setItem('forge-web-device', ${JSON.stringify(DEVICE_ID)})`)
  const page = await context.newPage()
  const consoleErrors = []
  const noteError = (text) => {
    // The one thing filtered, and it is not the client's doing: a socket the
    // *desktop* hung up on — which is every refusal phase, on purpose — is
    // logged by Chrome itself as a failed WebSocket handshake before any page
    // code runs. Nothing else is excused; a 404 for a missing favicon used to
    // be, and the answer was to stop shipping a page without one.
    if (/WebSocket connection to/i.test(text)) return
    consoleErrors.push(text)
  }
  page.on('console', (message) => {
    // The URL, not only the text: a failed subresource logs "Failed to load
    // resource: … 404" and names the file nowhere in its message, so filtering
    // on the text alone would either swallow every 404 or none of them.
    if (message.type() === 'error') noteError(`${message.text()} (${message.location()?.url ?? '?'})`)
  })
  page.on('pageerror', (err) => noteError(String(err)))

  /** Everything the terminal is currently rendering, as text. */
  const screenText = () => page.locator('.xterm-rows').first().innerText().catch(() => '')
  const gateReason = () => page.getAttribute('.gate__card', 'data-reason').catch(() => null)

  /**
   * Load the page with no stored sign-in, and sign in again through the form.
   *
   * Every phase does this, because `Auth.idToken` correctly hands back a cached
   * token until it is near expiry — so a phase that changed which uid the stub
   * mints for would otherwise be tested against the *previous* phase's token and
   * quietly assert nothing. Clearing the session is what makes each phase's
   * credential its own.
   */
  const signInFresh = async () => {
    await page.evaluate(() => localStorage.removeItem('forge-web-auth'))
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type="email"]', { timeout: 20_000 })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', 'not-checked-by-the-stub')
    await page.click('button[type="submit"]')
  }

  const approved = [{ id: DEVICE_ID, name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }]

  /* ===================================================== PHASE 1 — sign in */

  const livePort = await startPhase(approved)
  setConfig({ devHost: `127.0.0.1:${livePort}` })
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })

  await page.waitForSelector('.gate__card[data-reason="unconfigured"], .gate__card input[type="email"]', {
    timeout: 20_000
  })
  log((await gateReason()) !== 'unconfigured', 'the page read /config.json and offered a sign-in rather than a setup error')

  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', 'not-checked-by-the-stub')
  await page.click('button[type="submit"]')

  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace to appear')
  log(true, 'signing in through the form reaches a live link and the app is drawn')
  log(
    (await page.locator('.linkbadge[data-state="live"]').count()) === 1,
    'the connection badge says live, which is WebApprovalState "live" and not a spinner'
  )

  /* ------------------------------- the opening picture, on screen */

  log(
    (await page.locator('.prow .prow__name').first().innerText()) === 'forge',
    'the project list from hello-ok is drawn in the rail'
  )
  log((await page.locator('.tab .tab__title').first().innerText()) === 'e2e', 'and the workspace from hello-ok is drawn as a tab')
  log((await page.locator('.pane').count()) === 1, 'and its pane tree is drawn as a pane')

  /* --------------------------------------- a real shell behind the pane */

  const created = manager.create({ id: SESSION_ID, cwd: ROOT, cols: 90, rows: 30 })
  log(created.ok === true, 'spawned a real pwsh session for the browser to drive')
  if (!created.ok) throw new Error(created.error)
  // The *prompt*, not merely the first byte: a shell that has printed something
  // is not a shell that is ready to be typed at.
  await waitFor(() => (replay.get(SESSION_ID) ?? '').includes('> '), 40_000, 'the first prompt')

  const replayNonce = randomBytes(4).toString('hex')
  manager.write(SESSION_ID, `Write-Output ("forge-replay-" + "${replayNonce}")\r`)
  await waitFor(() => (replay.get(SESSION_ID) ?? '').includes(`forge-replay-${replayNonce}`), 40_000, 'the replay marker')

  // The pane was on screen before this shell existed — its first `attach` was
  // answered `unknown-session` — so bringing it to life is `session-started`
  // doing the job shared/web.ts says it exists for, with no reload anywhere.
  // Announced exactly as electron/web-host.ts announces it.
  log(
    (await page.locator('.pane__terminal .xterm').count()) > 0,
    'a pane whose shell has not started yet still draws a terminal rather than an empty box'
  )
  server.pushSessionStarted(manager.list().find((s) => s.id === SESSION_ID))
  server.pushSessions()

  await waitFor(
    async () => (await screenText()).includes(`forge-replay-${replayNonce}`),
    40_000,
    'the replay buffer on screen'
  )
  log(
    true,
    `session-started re-attached that pane with no reload, and the replay buffer painted into it (forge-replay-${replayNonce})`
  )
  log(watched === true, 'and the desktop was told a browser is reading that pane, so it can stand down on geometry')
  log(
    (await page.locator('.notice').count()) === 0,
    'and a pane that had not started yet raised no "that pane is gone" — a sentence nobody could act on'
  )

  const geometry = manager.list().find((s) => s.id === SESSION_ID)
  log(
    geometry.cols !== 90 || geometry.rows !== 30,
    `and attach carried the browser's own geometry, so the PTY is no longer at the size the desk set (now ${geometry.cols}×${geometry.rows})`
  )

  /* ------------------- THE assertion: a keystroke through a real ConPTY */

  const nonce = randomBytes(4).toString('hex')
  await page.click('.pane__terminal')
  await page.keyboard.type(`echo forge-web-${nonce}`)
  await page.keyboard.press('Enter')
  await waitFor(async () => (await screenText()).includes(`forge-web-${nonce}`), 60_000, 'the echo on screen')
  log(true, `typing in the browser reached the real shell and came back on screen (forge-web-${nonce})`)
  log(
    (replay.get(SESSION_ID) ?? '').includes(`forge-web-${nonce}`),
    'and the same bytes went through the desktop, so this is a mirror rather than a client-side echo'
  )

  /* -------------------------------------- every gesture is a request */

  const opsBefore = layoutOps.length
  await page.click('.prow')
  await waitFor(() => layoutOps.length > opsBefore, 10_000, 'the layout request')
  log(
    layoutOps.at(-1).op.op === 'select-project' && layoutOps.at(-1).op.projectId === 'p1',
    'clicking a project sends a layout request to the desktop rather than mutating a local copy'
  )
  log(
    /chrome/i.test(layoutOps.at(-1).deviceName),
    `carrying the name the browser called itself, which is what the desktop's device list shows ("${layoutOps.at(-1).deviceName}")`
  )

  /* ------------------------------------------------------- screenshots */

  await page.screenshot({ path: join(shots, 'live-1440.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(600)
  await page.screenshot({ path: join(shots, 'live-390.png'), fullPage: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(400)
  log(true, 'screenshots taken at 1440px and 390px')

  /* ============================================ PHASE 2 — pending, with words */

  // No approved devices, the desk armed, and a prompt nobody answers — which is
  // exactly the screen somebody stands in front of comparing two word pairs.
  const prompts = []
  const pendingPort = await startPhase([], {
    acceptUntil: () => Date.now() + 600_000,
    requestApproval: (ask) => {
      prompts.push(ask)
      return new Promise(() => {})
    },
    cancelApproval: () => {}
  })
  setConfig({ devHost: `127.0.0.1:${pendingPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'pending', 30_000, 'the pending screen')

  const words = await page.locator('[data-testid="approval-words"]').innerText()
  log(/^[A-Z]+ [A-Z]+$/.test(words), `the pending screen shows the word pair in large type ("${words}")`)
  log(
    prompts.length === 1 && prompts[0].words === words,
    'and it is the pair the desktop minted, which is the whole anti-confusion device'
  )
  const wordSize = await page.locator('[data-testid="approval-words"]').evaluate((el) => getComputedStyle(el).fontSize)
  log(
    Number.parseFloat(wordSize) >= 20,
    `"large type" is literal rather than aspirational — the pair renders at ${wordSize}`
  )
  await page.screenshot({ path: join(shots, 'pending-1440.png') })

  /* ================================ PHASE 3 — two refusals, two sentences */

  const refusalScreens = {}
  const captureRefusal = async (label) => {
    const reason = await gateReason()
    refusalScreens[label] = {
      reason,
      title: await page.locator('.gate__title').innerText(),
      body: await page.locator('.gate__card').innerText()
    }
    return reason
  }

  // wrong-account: a perfectly valid token, for a uid this desktop is not
  // configured for. Refused before the device is even looked at.
  tokenSub = OTHER_UID
  const wrongPort = await startPhase(approved)
  setConfig({ devHost: `127.0.0.1:${wrongPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'wrong-account', 30_000, 'the wrong-account screen')
  await captureRefusal('wrong-account')
  await page.screenshot({ path: join(shots, 'refused-wrong-account-1440.png') })

  // revoked: approved once, since revoked at the desk. A different row, a
  // different recovery, and no prompt raised.
  tokenSub = UID
  const revokedPort = await startPhase([{ id: DEVICE_ID, name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 2 }])
  setConfig({ devHost: `127.0.0.1:${revokedPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'revoked', 30_000, 'the revoked screen')
  await captureRefusal('revoked')
  await page.screenshot({ path: join(shots, 'refused-revoked-1440.png') })

  const wrong = refusalScreens['wrong-account']
  const revoked = refusalScreens['revoked']
  log(wrong.reason === 'wrong-account' && revoked.reason === 'revoked', 'each refusal names itself on screen')
  log(
    wrong.title !== revoked.title,
    `and wears a different headline (“${wrong.title}” vs “${revoked.title}”), not one generic failure`
  )
  log(wrong.body !== revoked.body, 'with different prose underneath it')
  log(
    /sign out|sign in as/i.test(wrong.body) && /forget this browser/i.test(revoked.body),
    'and a different recovery: sign in as somebody else, against forget this browser and ask again'
  )

  /* ====================================== PHASE 4 — the desktop is asleep */

  if (server) await server.stop()
  server = null
  active = null
  // No devHost, so the client goes the production route: read the rendezvous
  // record and decide with `isHostLive`. The record is a real one, three
  // heartbeats stale — the case HOST_STALE_MS exists for.
  hostRecord = { host: 'forge-e2e.trycloudflare.com', proto: WEB_PROTO, app: '0.0.0-e2e', name: 'E2E-PC', at: 1 }
  setConfig({})
  const readsBefore = rtdbReads.length
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await waitFor(() => page.locator('[data-testid="offline-banner"]').count().then((n) => n > 0), 30_000, 'the offline banner')

  log(rtdbReads.length > readsBefore, 'with no dev host, the client reads users/<uid>/host to find the desktop')
  log(
    (await page.locator('.app').count()) === 1 && (await page.locator('.prow').count()) === 1,
    'a stale record draws the cached picture — the project rail is still there rather than a blank page'
  )
  log((await page.locator('.tab .tab__title').first().innerText()) === 'e2e', 'and the cached workspace, tab and all')
  const banner = await page.locator('[data-testid="offline-banner"]').innerText()
  log(/asleep/i.test(banner), `and it is badged as asleep rather than broken ("${banner.split('\n')[0]}")`)
  log((await page.locator('.pane__perm[data-frozen="true"]').count()) === 1, 'and the pane itself is marked FROZEN')
  log(
    (await page.locator('.pane .pane__title').innerText()) === 'Shell',
    'and it still wears its own agent, because the cache keeps the profiles rather than letting resolveProfile fall back to a built-in'
  )
  const frozenText = await screenText()
  log(
    frozenText.includes(`forge-web-${nonce}`),
    'and the frozen terminal is showing the transcript this browser cached while it was live'
  )
  await page.screenshot({ path: join(shots, 'offline-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(600)
  await page.screenshot({ path: join(shots, 'offline-390.png') })

  /* ---------------------------------------------------------------- tidy */

  log(consoleErrors.length === 0, `the browser console stayed clean${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`)

  await context.close()
  await browser.close()
  await vite.close()
  manager.killAll()
  await new Promise((r) => stub.close(r))

  console.log(`\nscreenshots: ${shots}`)
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    console.log(failures === 0 ? '\nweb:e2e — all checks passed' : `\nweb:e2e — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })

/**
 * Forge Web with the desktop off: GitHub mode, in a real browser.
 *
 *   npm run web:offline
 *
 * This is Phase 4's gate in docs/forge-web.md. It is written to the same bar as
 * scripts/web-e2e.mjs, and it is the same shape: the *real* `WebServer`, the
 * *real* `WebAuth`, the *real* `web/` bundle in real Chrome, driven through the
 * actual sign-in form. What is different is which half of the product is under
 * test — not the mirror, but what the browser can still do once the mirror is
 * gone.
 *
 * ## What is stubbed, and why it has to be
 *
 * Two things, and both for reasons that would otherwise make this a check
 * nobody runs.
 *
 * **Google**, exactly as in web-e2e: the Identity Toolkit, the securetoken
 * endpoint and the Realtime Database, because the alternative is a test that
 * needs somebody's Firebase project and their password. Every response is the
 * shape Google publishes and the token verifier is the real one.
 *
 * **GitHub**, which is new here. There is no CORS-free way to reach
 * `api.github.com` from a page under test, and a check that needed Steve's
 * personal access token — a live credential against live repositories, which a
 * commit assertion would then *write* to — is a check that would be run once and
 * disabled. So `github` below is a small, real HTTP server holding a real
 * two-file repository in memory: it signs blobs with sha1, it refuses a `PUT`
 * whose `sha` does not match, it answers `409` for an empty repository, and it
 * sends the CORS headers api.github.com sends, `access-control-expose-headers`
 * included — without that last one a browser cannot read `x-ratelimit-remaining`
 * and the rate-limit path could not be exercised at all.
 *
 * The *client* is not stubbed anywhere. `web/src/lib/github.ts` builds every
 * URL, every header and every body; the assertions below read what actually
 * arrived.
 *
 * ## Why the shutdown frame rather than a stale record
 *
 * The client reaches GitHub mode two ways, and both are checked. The rendezvous
 * route — no record, or one too old for `isHostLive` — needs a page load, so it
 * is Phase 5 here. The `shutdown` route needs none, which is what makes Phases 2
 * and 3 able to prove the thing the brief actually asks for: that a desktop
 * going away drops this page into GitHub mode, and a desktop coming back takes
 * it out again, **with no reload in between**. A stamp is put on `window` before
 * the transition and read afterwards; a reload would have wiped it.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-offline')
const shots = join(scratch, 'shots')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const STUB_PORT = 8493
const GH_PORT = 8494
const VITE_PORT = 5181
const WEB_PORT = 8510
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const PROJECT = 'forge-web-offline'
const KID = 'a1b2c3d4e5f6'
const EMAIL = 'steve@example.com'
const DEVICE_ID = 'offline-browser'
const ORIGIN = `http://localhost:${VITE_PORT}`

/** The repository this check reads and commits to. Nothing outside this file. */
const SLUG = 'forge/scratch'
const DEFAULT_BRANCH = 'main'
/** A token that looks like a fine-grained one and is not one. */
const TOKEN = 'github_pat_offline_check_11ABCDEF0_notarealtoken'

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
 * Lifted from scripts/web-e2e.mjs, which lifted it from scripts/web-smoke.mjs,
 * for the reason that file gives: each check bundles stand-alone, and serving a
 * bare public key instead would mean the production path — parsing what Google
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

const SHA256_RSA = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
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
 * Two projects, because the sentence "this project has no GitHub remote" is one
 * of the things being asserted and it needs a project that genuinely has none.
 * One pane, and no shell behind it: this check never types at a terminal.
 */

const SESSION_ID = 'w1'
const PROJECTS = [
  { id: 'p1', name: 'scratch', path: join(ROOT, 'scratch'), color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 },
  { id: 'p2', name: 'nowhere', path: join(ROOT, 'nowhere'), color: '#59C2A0', defaultProfileId: 'shell', createdAt: 0 }
]
const PROFILES = [{ id: 'shell', name: 'Shell', command: '', accent: '#8e9093', badge: 'SH' }]
const WORKSPACES = {
  p1: {
    tabs: [
      {
        id: 't1',
        title: 'offline',
        root: { type: 'leaf', id: SESSION_ID, profileId: 'shell', title: '' },
        activePaneId: SESSION_ID
      }
    ],
    activeTabId: 't1'
  },
  p2: { tabs: [], activeTabId: null }
}

/** A `GitSnapshot` with only the fields anything here reads filled in honestly. */
function gitSnapshot(projectId, slug) {
  return {
    projectId,
    seq: 1,
    at: Date.now(),
    presence: 'repo',
    repoRoot: null,
    branch: DEFAULT_BRANCH,
    detached: false,
    unborn: false,
    head: 'abcdef1',
    upstream: `origin/${DEFAULT_BRANCH}`,
    ahead: 0,
    behind: 0,
    state: 'synced',
    remoteUrl: slug ? `https://github.com/${slug}.git` : null,
    slug,
    files: [],
    filesTruncated: false,
    changed: 0,
    staged: 0,
    conflicted: 0,
    branches: [],
    fetchedAt: null,
    slow: false,
    gh: { available: false, authed: false, checkedAt: 0 }
  }
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'web-offline-entry.ts')],
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

  const { WebServer, WebAuth, WEB_PROTO, webHostPath } = await import(pathToFileURL(join(scratch, 'web.mjs')).href)

  const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const served = { [KID]: certificateFor(google, 'securetoken.google.com') }
  const nowSec = () => Math.floor(Date.now() / 1000)

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

  let hostRecord = null
  const stub = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`)
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
      json({ idToken: mint(), refreshToken: 'refresh-offline', expiresIn: '3600', localId: UID, email: EMAIL })
      return
    }
    if (url.pathname === '/securetoken/v1/token') {
      json({ id_token: mint(), refresh_token: 'refresh-offline', expires_in: '3600', user_id: UID })
      return
    }
    if (url.pathname === `/rtdb/${webHostPath(UID)}.json`) {
      json(hostRecord)
      return
    }
    res.writeHead(404, cors).end('no')
  })
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

  /* --------------------------------------------------------- the GitHub stub
   *
   * A real repository, in memory: branch → path → blob. sha1 over the bytes,
   * which is close enough to git's blob hash for the only property that is
   * being relied on — that it changes when the content does, so a stale `sha`
   * on a `PUT` is detectable rather than assumed.
   */

  const blob = (text) => ({ text, sha: createHash('sha1').update(text).digest('hex') })
  const branches = new Map([
    [
      DEFAULT_BRANCH,
      new Map([
        ['README.md', blob('# scratch\n\nA repository that lives only inside npm run web:offline.\n')],
        ['src/app.ts', blob('export const answer = 41\n')],
        ['docs/notes.md', blob('Notes.\n')]
      ])
    ]
  ])
  const heads = new Map([[DEFAULT_BRANCH, createHash('sha1').update('head:main').digest('hex')]])

  /** Every request the client actually made, for the assertions to read back. */
  const ghRequests = []
  /** When set, the next matching request is answered with this instead. */
  let fault = null
  /** `status|path` for every refusal this check deliberately caused. */
  const faulted = new Set()

  const github = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GH_PORT}`)
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,accept,x-github-api-version',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
      // api.github.com sends this, and without it a browser cannot read the
      // rate-limit headers at all — which is the difference between "wait until
      // 14:05" and "that token cannot see this repository" on screen.
      'access-control-expose-headers': 'x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,retry-after'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end()
      return
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      ghRequests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body,
        authorized: (req.headers.authorization ?? '') === `Bearer ${TOKEN}`
      })

      const send = (status, payload, headers = {}) =>
        res
          .writeHead(status, { ...cors, ...headers, 'content-type': 'application/json' })
          .end(JSON.stringify(payload))

      if (fault && fault.match.test(url.pathname) && (!fault.method || fault.method === req.method)) {
        // Remembered so the console check below can excuse exactly the refusals
        // this check asked for, and nothing else. See `noteError`.
        faulted.add(`${fault.status}|${url.pathname}`)
        send(fault.status, { message: fault.message ?? 'no' }, fault.headers ?? {})
        return
      }

      const prefix = `/gh/repos/${SLUG}`
      if (!url.pathname.startsWith(prefix)) {
        send(404, { message: 'Not Found' })
        return
      }
      const rest = url.pathname.slice(prefix.length)

      if (rest === '') {
        send(200, { default_branch: DEFAULT_BRANCH, private: true, permissions: { push: true } })
        return
      }

      // Prefix matching, exactly as GitHub documents it — asking for `feature`
      // returns `featureA` too — so the client's exact-ref comparison is under
      // test rather than assumed.
      if (rest.startsWith('/git/matching-refs/heads/')) {
        const wanted = rest
          .slice('/git/matching-refs/heads/'.length)
          .split('/')
          .map(decodeURIComponent)
          .join('/')
        send(
          200,
          [...heads.entries()]
            .filter(([branch]) => branch.startsWith(wanted))
            .map(([branch, sha]) => ({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha, url: '' } }))
        )
        return
      }

      if (rest.startsWith('/git/trees/')) {
        const ref = decodeURIComponent(rest.slice('/git/trees/'.length))
        const files = branches.get(ref)
        if (!files) {
          send(404, { message: 'Not Found' })
          return
        }
        send(200, {
          sha: heads.get(ref) ?? '',
          truncated: false,
          tree: [...files.entries()].map(([path, file]) => ({
            path,
            mode: '100644',
            type: 'blob',
            sha: file.sha,
            size: Buffer.byteLength(file.text)
          }))
        })
        return
      }

      if (rest.startsWith('/contents/')) {
        const path = rest
          .slice('/contents/'.length)
          .split('/')
          .map(decodeURIComponent)
          .join('/')

        if (req.method === 'GET') {
          const ref = url.searchParams.get('ref') ?? DEFAULT_BRANCH
          const file = branches.get(ref)?.get(path)
          if (!file) {
            send(404, { message: 'Not Found' })
            return
          }
          send(200, {
            type: 'file',
            path,
            sha: file.sha,
            size: Buffer.byteLength(file.text),
            encoding: 'base64',
            content: Buffer.from(file.text, 'utf8').toString('base64')
          })
          return
        }

        if (req.method === 'PUT') {
          const branch = String(body?.branch ?? '')
          const files = branches.get(branch)
          if (!files) {
            send(422, { message: `Branch ${branch} does not exist` })
            return
          }
          const existing = files.get(path)
          if (existing && existing.sha !== String(body?.sha ?? '')) {
            send(409, { message: 'is at ' + existing.sha + ' but expected ' + body?.sha })
            return
          }
          const text = Buffer.from(String(body?.content ?? ''), 'base64').toString('utf8')
          files.set(path, blob(text))
          const commit = createHash('sha1').update(`${branch}:${path}:${text}`).digest('hex')
          heads.set(branch, commit)
          send(existing ? 200 : 201, {
            content: { path, sha: files.get(path).sha },
            commit: { sha: commit, message: String(body?.message ?? '') }
          })
          return
        }
      }

      if (rest === '/git/refs' && req.method === 'POST') {
        const ref = String(body?.ref ?? '')
        const branch = ref.replace(/^refs\/heads\//, '')
        if (!ref.startsWith('refs/heads/') || branches.has(branch)) {
          send(422, { message: 'Reference already exists' })
          return
        }
        const from = [...heads.entries()].find(([, sha]) => sha === String(body?.sha ?? ''))
        if (!from) {
          send(422, { message: 'Object does not exist' })
          return
        }
        branches.set(branch, new Map([...branches.get(from[0]).entries()]))
        heads.set(branch, String(body.sha))
        send(201, { ref, object: { type: 'commit', sha: String(body.sha), url: '' } })
        return
      }

      send(404, { message: 'Not Found' })
    })
  })
  await new Promise((r) => github.listen(GH_PORT, '127.0.0.1', r))

  /* --------------------------------------------------------- the desktop */

  const layoutOps = []
  const auth = new WebAuth({
    load: () => [{ id: DEVICE_ID, name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }],
    save: () => {},
    fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
    projectId: () => PROJECT,
    uid: () => UID
  })

  let server = null
  const startServer = async () => {
    server = new WebServer({
      auth,
      appVersion: '0.0.0-offline',
      desktopName: () => 'OFFLINE-PC',
      allowedOrigins: () => [ORIGIN],
      sessions: () => [],
      replay: () => '',
      write: () => {},
      resize: () => {},
      snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: WORKSPACES }),
      layout: async (op) => {
        layoutOps.push(op)
        return null
      },
      gitStatus: async (projectId) => gitSnapshot(projectId, projectId === 'p1' ? SLUG : null),
      agents: async () => ({ agents: [], commands: [] })
    })
    await server.start({ host: '127.0.0.1', port: WEB_PORT })
    return server
  }

  /* ------------------------------------------------------ the client, served */

  let config = {}
  const vite = await createViteServer({
    configFile: join(ROOT, 'web', 'vite.config.ts'),
    server: { port: VITE_PORT, strictPort: true },
    logLevel: 'error',
    plugins: [
      {
        name: 'forge-web-offline-config',
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
      apiKey: 'offline-key',
      databaseUrl: `http://127.0.0.1:${STUB_PORT}/rtdb`,
      authBase: `http://127.0.0.1:${STUB_PORT}/identitytoolkit/v1`,
      tokenBase: `http://127.0.0.1:${STUB_PORT}/securetoken/v1`,
      githubApiBase: `http://127.0.0.1:${GH_PORT}/gh`,
      ...extra
    }
  }

  /* ------------------------------------------------------------- the browser */

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(`localStorage.setItem('forge-web-device', ${JSON.stringify(DEVICE_ID)})`)
  const page = await context.newPage()

  const consoleErrors = []
  /** *Every* line the console produced, for the "the token is nowhere" check. */
  const consoleAll = []
  const noteError = (text) => {
    // Two things are excused, and both are Chrome talking about the network
    // before any page code runs — the same allowance scripts/web-e2e.mjs makes,
    // and held to the same rule that nothing else gets one.
    //
    // A socket the desktop hung up on, which is Phase 2 on purpose:
    if (/WebSocket connection to/i.test(text)) return
    // And a refusal *this check asked the GitHub stub for*. Matched against the
    // exact status and path the stub recorded serving, so a 500 the client
    // caused on its own would still fail the run.
    const status = text.match(/status of (\d+)/)
    const where = text.match(/\((https?:\/\/[^)\s]+)\)\s*$/)
    if (status && where && faulted.has(`${status[1]}|${new URL(where[1]).pathname}`)) return
    consoleErrors.push(text)
  }
  page.on('console', (message) => {
    consoleAll.push(`${message.type()}: ${message.text()} (${message.location()?.url ?? '?'})`)
    if (message.type() === 'error') noteError(`${message.text()} (${message.location()?.url ?? '?'})`)
  })
  page.on('pageerror', (err) => {
    consoleAll.push(String(err))
    noteError(String(err))
  })

  const text = (selector) => page.locator(selector).first().innerText()
  const count = (selector) => page.locator(selector).count()

  /* ===================================================== PHASE 1 — the desk */

  await startServer()
  setConfig({ devHost: `127.0.0.1:${WEB_PORT}` })
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', 'not-checked-by-the-stub')
  await page.click('button[type="submit"]')
  await waitFor(() => count('.linkbadge[data-state="live"]').then((n) => n === 1), 30_000, 'a live link')
  log(true, 'signed in through the form and the desktop is live, so the cache is being filled from a real picture')

  // Exactly what electron/web-host.ts does when the git watcher speaks: the
  // desktop pushes a snapshot per project, and the browser writes down the one
  // field that outlives the connection.
  server.pushGit(gitSnapshot('p1', SLUG))
  server.pushGit(gitSnapshot('p2', null))

  await waitFor(
    async () => {
      const snap = await page.evaluate(() => localStorage.getItem('forge-web-snapshot'))
      return Boolean(snap && JSON.parse(snap).slugs?.p1 === SLUG)
    },
    15_000,
    'the remote to reach the offline snapshot'
  )
  const cachedSlugs = JSON.parse(await page.evaluate(() => localStorage.getItem('forge-web-snapshot'))).slugs
  log(
    cachedSlugs.p1 === SLUG && cachedSlugs.p2 === null,
    `a git push wrote each project's remote into the offline snapshot (p1 → ${cachedSlugs.p1}, p2 → ${cachedSlugs.p2}), which is the only way a desktop that is off can name a repository`
  )

  /* ========================== PHASE 2 — the desk goes away, with no reload */

  await page.evaluate(() => {
    window.__forgeNoReload = 'kept'
  })
  await server.stop({ reason: 'sleep', message: 'That machine is going to sleep.' })
  server = null

  await waitFor(() => count('[data-testid="offline-banner"]').then((n) => n > 0), 20_000, 'the offline banner')
  log(
    (await count('.app')) === 1 && (await count('.prow')) === 2,
    'a shutdown frame drops the page into the offline screen with the cached picture still drawn'
  )
  log(
    (await count('[data-testid="offline-mode-switch"]')) === 1,
    `and the offline screen offers GitHub mode rather than only the frozen picture ("${await text('[data-testid="offline-mode-switch"]')}")`
  )
  log((await count('.pane__perm[data-frozen="true"]')) === 1, 'with the terminal still frozen and badged behind it')

  await page.click('[data-testid="offline-mode-switch"]')
  await waitFor(() => count('.gate__card[data-reason="github-token"]').then((n) => n > 0), 15_000, 'the token screen')
  const gate = await text('.gate__card[data-reason="github-token"]')
  log(/fine-grained/i.test(gate), 'the token screen asks for a fine-grained personal access token')
  log(
    /Contents — Read and write/.test(gate) && /only select repositories/i.test(gate),
    'and names the exact permission and scope rather than leaving somebody to guess'
  )
  log(
    /capability against those repositories for as long as it lives/i.test(gate),
    'and says out loud what a token in browser storage is, rather than burying it'
  )
  log(gate.includes(SLUG), `and names the repository it is about (${SLUG})`)
  log(
    (await count('.pane__terminal')) === 0 && !/\bRun\b/.test(gate),
    'and offers no terminal, no agent and nothing to run — there is no computer to run one'
  )

  /* ------------------------------------------------------- reading the repo */

  await page.fill('[data-testid="github-token-input"]', TOKEN)
  await page.click('.gate__card[data-reason="github-token"] button[type="submit"]')
  await waitFor(() => count('[data-testid="github-tree"]').then((n) => n > 0), 20_000, 'the file tree')

  const fileRows = await count('.ghrow[data-kind="file"]')
  const folderRows = await count('.ghrow[data-kind="folder"]')
  log(
    fileRows === 1 && folderRows === 2,
    `the tree lists the repository from GitHub — one file at the root and two folders (${fileRows} files, ${folderRows} folders)`
  )
  log((await text('[data-testid="github-slug"]')) === SLUG, `and the header names the repository it read (${SLUG})`)
  log(
    ghRequests.some((r) => r.method === 'GET' && r.path === `/gh/repos/${SLUG}` && r.authorized),
    'and every call carried the pasted token as a bearer credential'
  )

  await page.click('.ghrow[data-kind="file"]')
  /*
   * Wait for the editor to have *contents*, not merely to exist.
   *
   * The textarea is rendered as soon as a file is selected and filled when the
   * fetch settles, so waiting on the element alone races the network — and it
   * is a race that only ever fails one way, reading an empty string and
   * reporting it as "GitHub sent the wrong bytes". It went from occasional to
   * reliable without anything in web/ changing, which is what a timing-shaped
   * check does when the machine around it gets busier.
   */
  await waitFor(
    () => page.inputValue('[data-testid="github-editor"]').then((v) => v.length > 0).catch(() => false),
    15_000,
    'the editor to be filled'
  )
  const opened = await page.inputValue('[data-testid="github-editor"]')
  log(
    opened.includes('A repository that lives only inside npm run web:offline'),
    'clicking a file opens its contents, decoded from what GitHub sent'
  )
  log(
    (await text('[data-testid="github-file-path"]')) === 'README.md',
    'and the file view names the path it is showing'
  )

  /* --------------------------------------------------------- committing it */

  const branchLabel = await text('[data-testid="github-branch"]')
  log(
    branchLabel.startsWith('forge-web/'),
    `the branch is named before anything is committed, and it is a forge-web one ("${branchLabel}")`
  )

  const nonce = randomBytes(3).toString('hex')
  await page.fill('[data-testid="github-editor"]', `${opened}\nedited by web:offline ${nonce}\n`)
  await page.fill('[data-testid="github-commit-message"]', `Write ${nonce} from a browser`)
  await page.click('[data-testid="github-commit-go"]')
  await waitFor(() => count('[data-testid="github-landed"]').then((n) => n > 0), 20_000, 'the commit to land')
  log(true, `an edit committed from the browser (${await text('[data-testid="github-landed"]')})`)

  const created = ghRequests.filter((r) => r.method === 'POST' && r.path.endsWith('/git/refs'))
  const puts = ghRequests.filter((r) => r.method === 'PUT' && r.path.includes('/contents/'))
  log(
    created.length === 1 && String(created[0].body?.ref ?? '').startsWith('refs/heads/forge-web/'),
    `the branch it created was "${created[0]?.body?.ref}" — a forge-web ref, made from the current head`
  )
  log(
    puts.length === 1 && String(puts[0].body?.branch ?? '').startsWith('forge-web/'),
    `and the write named branch "${puts[0]?.body?.branch}"`
  )
  log(
    !ghRequests.some(
      (r) => r.body?.branch === DEFAULT_BRANCH || r.body?.ref === `refs/heads/${DEFAULT_BRANCH}`
    ),
    `and no request in the whole run targeted ${DEFAULT_BRANCH} — decision 9 is enforced in lib/github.ts, not asked for in the UI`
  )
  log(
    branches.get(DEFAULT_BRANCH).get('README.md').text === '# scratch\n\nA repository that lives only inside npm run web:offline.\n',
    `and ${DEFAULT_BRANCH} on the server is byte-for-byte what it was before the commit`
  )
  log(
    branches.get(created[0].body.ref.replace('refs/heads/', '')).get('README.md').text.includes(nonce),
    `while the forge-web branch has the new text (${nonce})`
  )

  /* ------------------------------------- a commit that fails, and survives */

  const lost = randomBytes(3).toString('hex')
  await page.fill('[data-testid="github-editor"]', `${opened}\nnot committed ${lost}\n`)
  await page.fill('[data-testid="github-commit-message"]', `This one will not land ${lost}`)
  fault = { match: /\/contents\//, method: 'PUT', status: 500, message: 'Server Error' }
  await page.click('[data-testid="github-commit-go"]')
  await waitFor(() => count('[data-testid="github-failure-broken"]').then((n) => n > 0), 20_000, 'the failed commit')
  fault = null
  log(true, `a commit that failed says so in its own sentence ("${(await text('[data-testid="github-failure-broken"]')).split('\n')[0]}")`)

  await sleep(700)
  const storedDrafts = await page.evaluate(() => localStorage.getItem('forge-web-github-drafts'))
  log(
    Boolean(storedDrafts) && storedDrafts.includes(lost),
    'and the edit it could not commit is in browser storage rather than gone'
  )
  log(
    (await count('[data-testid="github-drafts"]')) === 1 && (await text('[data-testid="github-drafts"]')).includes('README.md'),
    'and the page lists it as an edit that has not been committed, so it can be found again'
  )

  // Recovered from *storage*: the file is closed, re-read from GitHub, and the
  // draft is what comes back — not GitHub's copy.
  await page.click('.ghfile__actions button:last-child')
  await waitFor(() => count('[data-testid="github-editor"]').then((n) => n === 0), 10_000, 'the file to close')
  await page.click('.ghrow[data-kind="file"]')
  await waitFor(() => count('[data-testid="github-editor"]').then((n) => n > 0), 15_000, 'the file to reopen')
  await waitFor(
    async () => (await page.inputValue('[data-testid="github-editor"]')).includes(lost),
    10_000,
    'the draft to come back'
  )
  log(true, `closing and reopening the file brings the uncommitted edit back out of storage (${lost})`)

  /* ------------- and a branch that moved while that edit was stranded */

  const webBranch = created[0].body.ref.replace('refs/heads/', '')
  const theirs = `# scratch\n\nSomebody else pushed this to ${webBranch}.\n`
  branches.get(webBranch).set('README.md', blob(theirs))

  // The recovered draft, committed against the branch it was *made* against
  // rather than against whatever landed while it was stranded. This is the case
  // a recovered edit exists to survive, and the one where silently taking the
  // fresh blob would overwrite somebody else's commit with no conflict raised.
  await page.fill('[data-testid="github-commit-message"]', `Racing the branch ${lost}`)
  await page.click('[data-testid="github-commit-go"]')
  await waitFor(() => count('[data-testid="github-conflict"]').then((n) => n > 0), 20_000, 'the conflict')
  log(
    /moved on GitHub after this page read it/i.test(await text('[data-testid="github-conflict"]')),
    'a branch that moved underneath a recovered edit is said out loud rather than merged silently'
  )
  log(
    puts.length === 1,
    'and nothing was written while it was unresolved — the conflict was found before the PUT, not after it'
  )
  log(
    (await page.inputValue('[data-testid="github-editor"]')).includes(lost),
    'with the edit still on screen for the person to decide about'
  )
  await page.click('[data-testid="github-conflict"] .ghost-btn')
  await waitFor(
    async () => (await page.inputValue('[data-testid="github-editor"]')).includes('Somebody else pushed'),
    15_000,
    "GitHub's version to be taken"
  )
  log(true, "and choosing GitHub's version re-reads it rather than guessing at a merge")

  const draftsAfter = await page.evaluate(() => localStorage.getItem('forge-web-github-drafts'))
  log(
    !String(draftsAfter).includes(lost) && (await count('[data-testid="github-drafts"]')) === 0,
    'and throwing an edit away is a deliberate act that empties the store rather than hiding a row'
  )

  /* ------------------------------------ three refusals, three sentences */

  const refusal = async (label, next, testid) => {
    fault = next
    await page.click('.ghmode__head button[aria-label="Read GitHub again"]')
    await waitFor(() => count(`[data-testid="${testid}"]`).then((n) => n > 0), 20_000, `the ${label} strip`)
    const sentence = await text(`[data-testid="${testid}"]`)
    fault = null
    return sentence
  }

  const limited = await refusal(
    'rate limit',
    {
      match: new RegExp(`^/gh/repos/${SLUG}$`),
      status: 403,
      message: 'API rate limit exceeded',
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800)
      }
    },
    'github-failure-rate-limited'
  )
  const gone = await refusal(
    'not found',
    { match: new RegExp(`^/gh/repos/${SLUG}$`), status: 404, message: 'Not Found' },
    'github-failure-missing'
  )
  const refused = await refusal(
    'forbidden',
    {
      match: new RegExp(`^/gh/repos/${SLUG}$`),
      status: 403,
      message: 'Resource not accessible by personal access token',
      headers: { 'x-ratelimit-remaining': '58' }
    },
    'github-failure-forbidden'
  )

  log(/rate limiting/i.test(limited) && /\d\d:\d\d/.test(limited), `a rate limit says so, with the time it resets ("${oneLine(limited)}")`)
  log(/Not found on GitHub/i.test(gone), `a 404 is its own sentence ("${oneLine(gone)}")`)
  log(
    /cannot reach this repository/i.test(refused) && /only select repositories/i.test(refused),
    `and a token without access is a third, with the thing to do about it ("${oneLine(refused)}")`
  )
  log(
    new Set([oneLine(limited), oneLine(gone), oneLine(refused)]).size === 3,
    'three different failures, three different sentences — not one "could not load"'
  )

  await page.click('.ghmode__head button[aria-label="Read GitHub again"]')
  await waitFor(() => count('.ghfail').then((n) => n === 0), 20_000, 'the failure strip to clear')

  /* ----------------------------------------------------------- screenshots */

  await page.screenshot({ path: join(shots, 'github-1440.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(700)
  await page.screenshot({ path: join(shots, 'github-390.png'), fullPage: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(500)
  log(true, `screenshots taken at 1440px and 390px (${shots})`)

  /* ------------------------------------------- what the token can reach */

  await page.click('[data-testid="github-token-reach"]')
  await waitFor(
    async () => (await text('.ghtoken__sheet')).includes('default branch'),
    20_000,
    'the reach list to answer'
  )
  const sheet = await text('.ghtoken__sheet')
  log(
    sheet.includes(SLUG) && /Private/.test(sheet) && /may write/.test(sheet),
    `the token screen shows what that token can actually reach, asked of GitHub rather than assumed ("${oneLine(sheet)}")`
  )

  /* -------------------------------------- the token is where it belongs */

  const storage = await page.evaluate(() => {
    const all = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      all[key] = localStorage.getItem(key)
    }
    return all
  })
  log(
    (storage['forge-web-snapshot'] ?? '').includes(TOKEN) === false,
    'the token is not in the offline cache snapshot'
  )
  log(
    Object.entries(storage)
      .filter(([key]) => key !== 'forge-web-github-token')
      .every(([, value]) => !String(value).includes(TOKEN)),
    `and is in no browser storage key but its own (${Object.keys(storage).join(', ')})`
  )
  log(
    consoleAll.every((line) => !line.includes(TOKEN)),
    `and appears in none of the ${consoleAll.length} lines this page put on the console`
  )

  /* ------------------------------------ a project with no GitHub remote */

  await page.click('.prow:nth-of-type(2)')
  await waitFor(() => count('[data-testid="github-no-remote"]').then((n) => n > 0), 15_000, 'the no-remote screen')
  const noRemote = await text('[data-testid="github-no-remote"]')
  log(
    /No GitHub remote/i.test(noRemote) && /not the same as something being broken/i.test(noRemote),
    `a project with no GitHub remote says so plainly rather than looking broken ("${oneLine(noRemote)}")`
  )
  await page.click('.prow:nth-of-type(1)')
  await waitFor(() => count('[data-testid="github-tree"]').then((n) => n > 0), 20_000, 'the tree again')

  /* -------------------------------------------------- forgetting the token */

  await page.click('[data-testid="github-token-reach"]')
  await page.click('[data-testid="github-forget-token"]')
  await waitFor(() => count('.gate__card[data-reason="github-token"]').then((n) => n > 0), 15_000, 'the token screen')
  const afterForget = await page.evaluate(() => localStorage.getItem('forge-web-github-token'))
  log(afterForget === null, 'forgetting the token actually removes it from browser storage rather than hiding it')

  /* ============================== PHASE 3 — the desk comes back, no reload */

  await startServer()
  await page.click('.offline__look:last-of-type')
  await waitFor(() => count('.linkbadge[data-state="live"]').then((n) => n === 1), 30_000, 'the live link again')
  log(true, 'a desktop that came back put the page straight back into live mode')
  log(
    (await page.evaluate(() => window.__forgeNoReload)) === 'kept',
    'and it did so without a reload — a stamp put on window before the desktop went away is still there'
  )
  log(
    (await count('[data-testid="github-mode"]')) === 0 && (await count('.pane')) === 1,
    'with GitHub mode gone and the terminal grid back'
  )

  /* ================= PHASE 4 — the cold route: no record, no live socket */

  await server.stop()
  server = null
  hostRecord = null
  setConfig({})
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await waitFor(() => count('[data-testid="offline-banner"]').then((n) => n > 0), 30_000, 'the offline banner')
  log(
    (await count('[data-testid="offline-mode-switch"]')) === 1,
    'a cold load with no rendezvous record reaches the same offer, through isHostLive rather than a shutdown frame'
  )
  await page.click('[data-testid="offline-mode-switch"]')
  await waitFor(() => count('.gate__card[data-reason="github-token"]').then((n) => n > 0), 15_000, 'the token screen')
  log(true, 'and asks for a token again, because forgetting one meant it')

  /* ---------------------------------------------------------------- tidy */

  log(consoleErrors.length === 0, `the browser console stayed clean${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`)

  await context.close()
  await browser.close()
  await vite.close()
  await new Promise((r) => stub.close(r))
  await new Promise((r) => github.close(r))

  console.log(`\nscreenshots: ${shots}`)
}

const oneLine = (value) => value.replace(/\s+/g, ' ').trim().slice(0, 150)

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    console.log(failures === 0 ? '\nweb:offline — all checks passed' : `\nweb:offline — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })

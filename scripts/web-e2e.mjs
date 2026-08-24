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
 * Two things are stubbed, and the second only in the phase that needs it.
 *
 * The first is Google. A tiny HTTP server stands in for the
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
 * The second is the display, in phase 5d and nowhere else. A machine running a
 * check has no screen worth capturing and Windows will not hand one to a
 * headless run, so `getUserMedia` there answers with a canvas being redrawn
 * thirty times a second. Everything above it is the shipped code: the real
 * `captureScreen` and its constraints, the real `VideoEncoder` in the real
 * Chrome, the real chunk ceiling on the real server, and the real decoder
 * painting the real component's canvas. What is stubbed is the picture, not the
 * pipe.
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
 *
 * ## The two ways this link used to loop forever
 *
 * Phases 3b and 5 are not features being shown off; they are corrections being
 * held down. Each is a bug that shipped behind a full suite of passing checks,
 * and both looked identical from the outside — "Reconnecting to the desktop
 * (attempt 41)…" on a page that was never going to connect. A refusal the
 * desktop had explained in words, erased in the same React batch by the retry
 * that acts on it (3b); and an address that had been retired under a browser
 * which went on re-dialling it (5).
 *
 * Phase 6 is the third shape of that disease, moved. It used to be a browser
 * hung up on mid-approval by its own heartbeat, twenty seconds into a two-minute
 * window; there is no approval to sit through any more, and a `pin-required` is
 * answered and then hung up on by the desktop itself, so there is no held-open
 * socket either. What is left is the property underneath both: the one screen
 * where this client waits on a person has to hold still while it waits. That is
 * now the PIN box, and that is what phase 6 asserts.
 *
 * Phase 7 is the fourth, and it is the one none of the others could see. Every
 * drop above is a socket that *closed* — the desktop said goodbye, or the
 * process went away and the OS said it for it. The drop this product actually
 * suffers says nothing at all: a laptop sleeps, a phone backgrounds the tab,
 * and the connection is torn down somewhere in the middle with no close frame
 * ever reaching the page. The browser goes on reporting `OPEN` for minutes, and
 * a client that trusts `readyState` sits there disconnected the whole time. So
 * phase 7 puts a relay in front of the desktop and has it swallow the link
 * whole, which is the only way to write that case down.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
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
/** A second real shell, so Phase 1d's split is two live terminals. */
const SECOND_ID = 'w2'
/** A pane in Phase 1d's second tab that never gets a shell — see that phase. */
const THIRD_ID = 'w3'
const PROJECTS = [
  { id: 'p1', name: 'forge', path: ROOT, color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 }
]
/*
 * Two profiles, because one of them has to carry a permission ladder. `claude`
 * is the only reason the chooser draws a mode submenu at all, and the check
 * below picks the dangerous rung off it to prove the override survives the trip
 * to the desktop instead of being flattened into the profile's own default.
 */
const PROFILES = [
  { id: 'shell', name: 'Shell', command: '', accent: '#8e9093', badge: 'SH' },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#C6FF4A',
    badge: 'CC',
    kind: 'agent',
    permissionMode: 'default'
  }
]
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

  const {
    WebServer,
    WebAuth,
    PtySessionManager,
    checkFolder,
    listFolder,
    planProjectFolder,
    WEB_PROTO,
    webHostPath,
    hashPin,
    HEARTBEAT_GRACE_MS,
    HEARTBEAT_MS,
    MAX_MIRROR_CHUNK_BYTES,
    PIN_MIN_DIGITS
  } = await import(pathToFileURL(join(scratch, 'web.mjs')).href)

  /*
   * The desktop's *encoder*, bundled on its own so a browser can run it.
   *
   * src/lib/web-mirror.ts is renderer code — it opens a capture and drives a
   * `VideoEncoder`, neither of which exists in Node — so the mirror phase runs
   * the shipped file inside the same Chrome the client is in and hands what it
   * produces to the real `WebServer`. That is the only way this end of the
   * feature can be driven at all without a display, and it is worth the trouble:
   * the alternative is a check that invents its own chunks, which would prove
   * the viewer decodes something rather than that these two halves fit.
   */
  await build({
    entryPoints: [join(ROOT, 'src', 'lib', 'web-mirror.ts')],
    outfile: join(scratch, 'web-mirror.js'),
    bundle: true,
    format: 'iife',
    globalName: 'ForgeWebMirror',
    platform: 'browser',
    target: 'es2022',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  const encoderBundle = readFileSync(join(scratch, 'web-mirror.js'), 'utf8')

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
  /** How many times the stored refresh token has been spent for a fresh ID token. */
  let tokenRefreshes = 0

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
      tokenRefreshes++
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
  /** Every folder a browser has asked this desktop to add, in order. */
  const projectAdds = []

  /*
   * What `electron/web-host.ts` does with a folder on its way to the rail,
   * minus the renderer it does not have: check the folder is really there, add
   * it, and then *push the list*. The push is the half worth having here — the
   * browser's rail must redraw because the desktop said so, never because the
   * click that asked for it optimistically added a row. Shared by `project-add`
   * and the tail of `project-create`, exactly as `dispatchProjectAdd` is on the
   * real desktop.
   */
  const addProjectFolder = async (path) => {
    const checked = checkFolder(path)
    if (!checked.ok) return checked.error
    projectAdds.push(checked.path)
    PROJECTS.push({
      id: `p${PROJECTS.length + 1}`,
      name: basename(checked.path),
      path: checked.path,
      color: '#4AA3FF',
      defaultProfileId: 'shell',
      createdAt: Date.now()
    })
    active?.pushProjects(PROJECTS)
    return null
  }

  /* ------------------------------------------------------- the screen mirror
   *
   * The desktop's half of the mirror, as `electron/web-host.ts` supplies it
   * minus the two things this process does not have: a display and a settings
   * file. What is left is exactly the part worth driving — the PIN spent at
   * `mirror-start`, whether control is allowed at the moment the watch begins,
   * and every input frame that survives `readMirrorInput`.
   *
   * Everything between these hooks and the browser is the shipped server: the
   * one-viewer rule, the chunk ceiling, the input budget and the gate that
   * refuses an input frame from a socket that is not the one watching.
   */

  /** The PIN `mirror-start` must carry, or '' for a desktop with none set. */
  let mirrorPin = ''
  /** Every PIN a browser has presented at `mirror-start`, in order. */
  const mirrorStarts = []
  /** Every input that reached the desktop, after `readMirrorInput` read it. */
  const mirrorInputs = []
  /** What `mirrorControl` answers when a watch begins. */
  let screenControl = true
  /** Is a browser watching right now, as the server's own edge reports it? */
  let mirroring = false
  /**
   * Every session the desktop has served a catch-up buffer for, in order.
   *
   * The one observation that decides Phase 1d. A replay is served on exactly one
   * event — an `attach` the server accepted — so this list is a record of which
   * panes the browser threw away and rebuilt, taken at the desktop rather than
   * inferred from what the screen looks like afterwards.
   */
  const replayServed = []
  const makeAuth = (extra = {}) =>
    new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID,
      ...extra
    })

  const makeServer = (auth) =>
    new WebServer({
      auth,
      appVersion: '0.0.0-e2e',
      desktopName: () => 'E2E-PC',
      /*
       * A blind spot, stated rather than hidden: this hands the server the
       * origin the harness serves the page from, so it exercises
       * `originAllowed` and never `webAllowedOrigins`. The real desktop's list
       * is *derived* — and it derived the wrong thing for the whole of Forge
       * Web's first release, refusing the real page from the real Hosting site
       * while this check passed end to end every time.
       *
       * It cannot be fixed here. The page under test is served from
       * `http://localhost:<vite>`, so a list built the production way would
       * refuse it, and pointing the derivation at "localhost" would prove
       * nothing about `https://<site>.web.app`. The assertion that covers it
       * lives in scripts/web-check.mjs instead: it reads `.firebaserc` and
       * demands that the site this repo actually deploys to is one
       * `webAllowedOrigins()` produces.
       */
      allowedOrigins: () => [ORIGIN],
      sessions: () => manager.list(),
      replay: (id) => {
        replayServed.push(id)
        return replay.get(id) ?? ''
      },
      write: (id, data) => manager.write(id, data),
      resize: (id, cols, rows) => manager.resize(id, cols, rows),
      snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: WORKSPACES }),
      layout: async (op, deviceName) => {
        layoutOps.push({ op, deviceName })
        return null
      },
      agents: async (commands) => ({ agents: [], commands: commands.map((c) => ({ command: c, exe: c, found: true, unknown: false })) }),
      /*
       * The shipped listing code, bundled straight out of
       * electron/web/fs-browse.ts by the entry fixture — so the picker on
       * screen walks a real directory tree through the same function the real
       * desktop answers with, rather than through a fixture written to agree
       * with it. That module has no Electron in it for exactly this reason.
       */
      fsList: async (path, name) => listFolder(path, name),
      projectAdd: async (path) => addProjectFolder(path),
      /*
       * `dispatchProjectCreate` in electron/web-host.ts, minus the renderer and
       * the settings read: the same shipped fence (`planProjectFolder`), the
       * same refusal of an existing folder with its path attached, and the same
       * one-act tail — the folder lands on the rail through the exact
       * `addProjectFolder` the pick flow takes, so the browser's redraw comes
       * from the push and never from its own click. The one root points into
       * the scratch tree so everything this makes is deleted with it.
       */
      projectCreate: async (name, parentDir) => {
        const plan = planProjectFolder({ name, parentDir, roots: [{ key: 'desktop', path: scratch }] })
        if (!plan.ok) return { ok: false, error: plan.error }
        if (existsSync(plan.path)) {
          return { ok: false, error: `“${plan.leaf}” already exists — open it instead.`, existingPath: plan.path }
        }
        mkdirSync(plan.path)
        const error = await addProjectFolder(plan.path)
        if (error) return { ok: false, error }
        return { ok: true }
      },
      onWatch: (ids) => {
        watched = ids.length > 0
      },
      /*
       * `startMirror` in electron/web-host.ts, with the settings check and the
       * window lookup removed and the PIN kept — that is the gate the browser
       * has to draw a text box for, and the only one of the three that is
       * visible from a page.
       */
      mirrorStart: (pin) => {
        mirrorStarts.push(pin)
        if (mirrorPin && pin !== mirrorPin) {
          return { error: 'Type the desktop’s unlock PIN to take its screen.', needsPin: true }
        }
        return null
      },
      mirrorControl: () => screenControl,
      mirrorInput: (input) => {
        mirrorInputs.push(input)
        return true
      },
      onMirror: (watching) => {
        mirroring = watching
      }
    })

  /**
   * A TCP relay in front of the desktop, so a phase can take the link away
   * *without closing it*.
   *
   * Stopping the server proves the wrong thing. It closes the socket, the
   * browser gets an `onclose`, and the reconnect loop that has always worked
   * runs — which is phase 1a, and it passes. What no server-side action can
   * produce from in here is the failure this client is actually bad at: a
   * connection that is gone while both ends still hold an open socket, because
   * the path between them stopped carrying anything and nobody was told.
   *
   * `swallow()` is that, and it is deliberately total. A wedged pair forwards
   * no bytes in either direction *and does not propagate the close* when the
   * desktop's own heartbeat gives up on its end — because the whole point is
   * that the browser never finds out. What the page is left holding is exactly
   * what a phone that lost its radio is holding: a socket that says `OPEN` and
   * a desktop that tidied up thirty seconds ago.
   *
   * Only the pairs alive at the moment of the call are swallowed. A re-dial
   * therefore reaches the desktop normally, which is what makes the recovery
   * observable rather than something the harness has to remember to permit.
   */
  let relayPort = 8600
  const startRelay = async (targetPort) => {
    const pairs = new Set()
    let dials = 0
    relayPort += 1
    const tcp = createTcpServer((down) => {
      dials += 1
      const up = tcpConnect(targetPort, '127.0.0.1')
      const pair = { down, up, wedged: false }
      pairs.add(pair)
      down.on('data', (b) => {
        if (!pair.wedged) up.write(b)
      })
      up.on('data', (b) => {
        if (!pair.wedged) down.write(b)
      })
      // The browser hanging up is always honoured — that is the client deciding
      // this socket is finished, which is the behaviour under test.
      down.on('close', () => {
        pairs.delete(pair)
        up.destroy()
      })
      // The desktop hanging up is honoured only while the pair is whole. Once
      // swallowed, the browser is told nothing, ever.
      up.on('close', () => {
        if (!pair.wedged) down.destroy()
      })
      down.on('error', () => up.destroy())
      up.on('error', () => {
        if (!pair.wedged) down.destroy()
      })
    })
    await new Promise((r) => tcp.listen(relayPort, '127.0.0.1', r))
    return {
      port: relayPort,
      /**
       * How many times a browser has opened a connection through here.
       *
       * The observation this phase turns on, and it is taken at the wire rather
       * than off the screen for a reason the first draft of this phase ran into:
       * the re-dial goes to a desktop on loopback and completes in single-digit
       * milliseconds, so `Reconnecting…` can come and go between two polls of
       * the DOM. The banner is real and it is not what is being claimed. What is
       * being claimed is that the client hung up on a socket it had no way of
       * knowing was dead, and a second TCP connection arriving here is that,
       * exactly, with a timestamp.
       */
      dials: () => dials,
      /**
       * Take every live link, and report how many were newly taken.
       *
       * Already-swallowed pairs are counted out rather than counted again,
       * because they linger: a client hanging up on a swallowed socket sends a
       * close frame into the same void everything else went into, so the
       * browser sits waiting for a close handshake that cannot come and the
       * pair stays on the books. That is faithful — it is what a phone holding
       * a dead socket looks like — but it means `pairs.size` answers a
       * different question from the one each call is asking.
       */
      swallow: () => {
        let taken = 0
        for (const pair of pairs) {
          if (pair.wedged) continue
          pair.wedged = true
          taken += 1
        }
        return taken
      },
      close: () =>
        new Promise((r) => {
          for (const pair of pairs) {
            pair.down.destroy()
            pair.up.destroy()
          }
          tcp.close(r)
        })
    }
  }

  /** Start a phase: a fresh port, a fresh WebAuth, a fresh WebServer. */
  let port = 8500
  let server = null
  const startPhase = async (extra = {}) => {
    if (server) await server.stop()
    port += 1
    server = makeServer(makeAuth(extra))
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
  const consoleErrors = []
  /**
   * Every address this browser has dialled, in order.
   *
   * The one observation that survives a socket which never opens: Playwright
   * raises `websocket` when the page *constructs* one, so a dial at a hostname
   * that resolves nowhere is as visible here as one that connects. Phase 5 is
   * about nothing else — which of two addresses the client chose.
   */
  const dialled = []
  const noteError = (text) => {
    // The one thing filtered, and it is not the client's doing: a socket the
    // *desktop* hung up on — which is every refusal phase, on purpose — is
    // logged by Chrome itself as a failed WebSocket handshake before any page
    // code runs. Nothing else is excused; a 404 for a missing favicon used to
    // be, and the answer was to stop shipping a page without one.
    if (/WebSocket connection to/i.test(text)) return
    consoleErrors.push(text)
  }

  /**
   * A browser profile, optionally carrying one over from a previous life.
   *
   * `storageState` is the whole of the restart assertion: quitting Chrome and
   * opening it again keeps `localStorage` on disk, and a `newContext` with no
   * state would be a *fresh install* rather than a restart — which would prove
   * the opposite of what it looked like it proved.
   */
  const newContext = async (storageState) => {
    const made = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(storageState ? { storageState } : {})
    })
    // A fixed device id, so the desktop's log names the same browser across
    // every phase and a run is readable. It buys this page nothing — the door is
    // the account and the PIN, and any non-blank id would do — but seeding it
    // rather than letting each context mint its own keeps no phase depending on
    // a previous one having run.
    await made.addInitScript(`localStorage.setItem('forge-web-device', ${JSON.stringify(DEVICE_ID)})`)
    // Every write of the offline cache, counted. The snapshot is written whole
    // and synchronously, so "how many times was it written" is the honest cost
    // of a push arriving — which is what the identical-projects assertion in
    // phase 1 is about. Counted rather than timed: a stopwatch here would be
    // measuring the machine the check happens to be running on.
    await made.addInitScript(`{
      const real = Storage.prototype.setItem
      window.__forgeSnapshotWrites = 0
      Storage.prototype.setItem = function (key, value) {
        if (key === 'forge-web-snapshot') window.__forgeSnapshotWrites++
        return real.call(this, key, value)
      }
    }`)
    return made
  }

  const newPage = async (ctx) => {
    const made = await ctx.newPage()
    made.on('console', (message) => {
      // The URL, not only the text: a failed subresource logs "Failed to load
      // resource: … 404" and names the file nowhere in its message, so filtering
      // on the text alone would either swallow every 404 or none of them.
      if (message.type() === 'error') noteError(`${message.text()} (${message.location()?.url ?? '?'})`)
    })
    made.on('pageerror', (err) => noteError(String(err)))
    made.on('websocket', (socket) => dialled.push(socket.url()))
    return made
  }

  // `let`, because the restart phase below genuinely replaces both — a browser
  // that was quit and reopened is a different context and a different tab.
  let context = await newContext()
  let page = await newPage(context)

  /** Everything the terminal is currently rendering, as text. */
  const screenText = () => page.locator('.xterm-rows').first().innerText().catch(() => '')
  /** The same, for one named pane, once there is more than one on screen. */
  const paneText = (id) =>
    page
      .locator(`.pane[data-pane-id="${id}"] .xterm-rows`)
      .first()
      .innerText()
      .catch(() => '')
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
  /**
   * How many times a credential has been typed into this browser, ever.
   *
   * The counter *is* the seamlessness assertion. "The workspace appeared" is
   * easy to satisfy by accident; "the workspace appeared and this number did
   * not move" is the claim — nothing was typed, so nothing was asked for.
   */
  let credentialsTyped = 0

  const signInFresh = async () => {
    await page.evaluate(() => localStorage.removeItem('forge-web-auth'))
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type="email"]', { timeout: 20_000 })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', 'not-checked-by-the-stub')
    credentialsTyped++
    await page.click('button[type="submit"]')
  }

  /* ===================================================== PHASE 1 — sign in */

  const livePort = await startPhase()
  setConfig({ devHost: `127.0.0.1:${livePort}` })
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })

  await page.waitForSelector('.gate__card[data-reason="unconfigured"], .gate__card input[type="email"]', {
    timeout: 20_000
  })
  log((await gateReason()) !== 'unconfigured', 'the page read /config.json and offered a sign-in rather than a setup error')

  // The sign-in screen, before anything is typed into it, at both widths.
  await page.screenshot({ path: join(shots, 'signin-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(400)
  await page.screenshot({ path: join(shots, 'signin-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(300)

  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', 'not-checked-by-the-stub')
  credentialsTyped++
  await page.click('button[type="submit"]')

  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace to appear')
  log(true, 'signing in through the form reaches a live link and the app is drawn')
  log(
    (await page.locator('.linkbadge[data-state="live"]').count()) === 1,
    'the connection badge says live, which is WebConnectionState "live" and not a spinner'
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
  log(watched === true, 'and the desktop was told a browser is reading that pane, so it can say so on the pane itself')
  log(
    (await page.locator('.notice').count()) === 0,
    'and a pane that had not started yet raised no "that pane is gone" — a sentence nobody could act on'
  )

  // This server's host resizes unconditionally: it takes no viewer name and
  // keeps no ownership registry, which is the branch electron/web/server.ts
  // documents as "a host that ignores the argument behaves as it always did".
  // That is the same answer an *unowned* pane gives — nothing here ever claimed
  // this one — so the browser's attach geometry lands, and a head-less setup
  // needs no registry to work. The branches where a pane is already held, and
  // where typing takes it, are asserted in scripts/web-smoke.mjs and
  // scripts/web-check.mjs, both of which drive the real registry.
  const geometry = manager.list().find((s) => s.id === SESSION_ID)
  log(
    geometry.cols !== 90 || geometry.rows !== 30,
    `and against a host with no ownership registry, attach carried the browser's own geometry, so the PTY is no longer at the size the desk set (now ${geometry.cols}×${geometry.rows})`
  )

  /* ------------------------------- and the other pointer, which is a finger
   *
   * A phone reads Forge Web in the same bundle a desktop does, and for a long
   * time it could read only the last screenful of it: xterm scrolls its viewport
   * from wheel events and from the keyboard, so the scrollback this client keeps
   * (5,000 lines) was history that was retained and unreachable. "The scroller
   * works fine on the PC but on the phone it doesn't" is exactly that asymmetry,
   * and it is invisible to every other check here because Playwright drives a
   * mouse.
   *
   * So this one drives a finger. Chrome's own touch emulation is switched on
   * over CDP and the drag is dispatched through `Input.dispatchTouchEvent`,
   * which is the same input pipeline a handset's digitiser feeds — not a
   * `TouchEvent` constructed in page script, which would prove the handler is
   * wired and nothing about whether a real touch ever reaches it.
   *
   * Four properties, because three of them can pass while the feature is still
   * useless: that a drag scrolls at all, that it keeps going to the *top* of the
   * transcript rather than the last screenful, that it comes back, and that
   * scrolling does not take the caret — a finger that focused the terminal would
   * open Android's keyboard on every swipe and resize the pane out from under
   * the gesture.
   */

  const touch = await context.newCDPSession(page)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })

  /**
   * One finger dragged down the terminal (`+1`, which reveals older output) or
   * up it (`-1`), over most of the pane's height and in steps a phone would send.
   */
  const swipe = async (direction) => {
    const box = await page.locator('.pane__terminal').first().boundingBox()
    const distance = Math.round(box.height * 0.6) * direction
    const x = Math.round(box.x + box.width / 2)
    const from = Math.round(box.y + box.height / 2 - distance / 2)
    const point = (y) => [{ x, y: Math.round(y), id: 1 }]
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
    for (let step = 1; step <= 8; step++) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(from + (distance * step) / 8)
      })
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  const tap = async () => {
    const box = await page.locator('.pane__terminal').first().boundingBox()
    const point = [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), id: 1 }]
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /** Whether the caret is in this terminal — xterm's own class for it. */
  const caretHeld = () => page.locator('.pane__terminal .xterm.focus').count()

  // Halved in the command and joined by the shell, as the replay marker above
  // is: the echo of what was typed is part of the transcript too, and a mark
  // that appeared in it as well would be found one row early.
  const topNonce = randomBytes(4).toString('hex')
  const topMark = `forge-top-${topNonce}`
  manager.write(SESSION_ID, `Write-Output ("forge-top-" + "${topNonce}"); 1..140 | ForEach-Object { "forge-scroll-line-$_" }\r`)
  await waitFor(async () => (await screenText()).includes('forge-scroll-line-140'), 60_000, 'a transcript past the bottom')
  log(
    !(await screenText()).includes(topMark),
    'a transcript longer than the pane has a first line that is off the screen and reachable no other way'
  )

  await swipe(1)
  await waitFor(
    async () => !(await screenText()).includes('forge-scroll-line-140'),
    10_000,
    'the bottom of the transcript to leave the screen'
  )
  log(true, 'one downward drag of a finger scrolls the terminal itself, rather than the page around it')

  let swipes = 1
  await waitFor(
    async () => {
      if ((await screenText()).includes(topMark)) return true
      swipes++
      await swipe(1)
      return false
    },
    60_000,
    'the top of the transcript'
  )
  log(true, `and it keeps going to the top of the transcript rather than one screenful (${swipes} drags to reach it)`)

  await waitFor(
    async () => {
      if ((await screenText()).includes('forge-scroll-line-140')) return true
      await swipe(-1)
      return false
    },
    60_000,
    'the live end of the transcript'
  )
  log(true, 'and an upward drag comes back down to where the shell is still printing')

  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await waitFor(async () => (await caretHeld()) === 0, 10_000, 'the caret to leave the terminal')
  await swipe(1)
  await sleep(200)
  log(
    (await caretHeld()) === 0,
    'scrolling with a finger does not take the caret, so a phone does not answer every swipe with its keyboard'
  )
  await tap()
  await waitFor(() => caretHeld().then((n) => n === 1), 10_000, 'the caret to come back on a tap')
  log(true, 'while a tap still does, which is how a phone types into a pane at all')

  // Back to the live end and pinned there, so every later assertion about what
  // is "on screen" is reading the bottom of the transcript rather than wherever
  // this drag left the viewport. A keypress is what does it: xterm scrolls to
  // the bottom on user input, exactly as it does at the desk.
  await page.keyboard.press('Enter')
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await touch.detach()

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

  /* ------------------------------------ and one of them carries a permission mode
   *
   * The ladder end to end. The rungs the browser draws are not the browser's:
   * they come out of the same PERMISSION_FAMILIES table the desk reads, so the
   * assertion is on the desktop's own words in the desktop's own order, and a
   * client that invented its own vocabulary would fail here rather than at the
   * moment somebody launched a mode this machine cannot spell.
   *
   * Bypass specifically, for both halves: it is the rung marked dangerous, and
   * it is the one nobody wants to discover was quietly dropped on the way — a
   * `create-tab` that arrived without `permissionMode` would open Claude asking
   * for permission after the person had deliberately chosen the mode that never
   * asks, and would look like the chooser rather than the wire.
   */

  await page.click('.tabstrip__new')
  const claudeLine = page.locator('.agent-chooser__line', { hasText: 'Claude Code' })
  await claudeLine.locator('.agent-chooser__modes').click()
  const rungs = (await page.locator('.agent-chooser__submenu .agent-chooser__mode-name').allInnerTexts()).join(' / ')
  log(rungs === 'Default / Accept edits / Plan / Bypass', `the chooser offers the desktop's own ladder, in its order ("${rungs}")`)
  const bypass = page.locator('.agent-chooser__mode-row[data-danger="true"]')
  log(
    (await bypass.count()) === 1 && (await bypass.locator('.agent-chooser__mode-name').innerText()) === 'Bypass',
    'with exactly one rung marked dangerous, and it is the one that never asks'
  )
  const modeOpsBefore = layoutOps.length
  await bypass.click()
  await waitFor(() => layoutOps.length > modeOpsBefore, 10_000, 'the create-tab request')
  const opened = layoutOps.at(-1).op
  log(
    opened.op === 'create-tab' && opened.profileId === 'claude' && opened.permissionMode === 'bypass',
    `and picking a rung opens the tab in that mode rather than the profile's default (${opened.op}, ${opened.profileId}, ${opened.permissionMode})`
  )
  log(
    (await page.locator('.agent-chooser__submenu').count()) === 0,
    'and the chooser closes on the pick, so the ladder is not still hanging open behind the new tab'
  )

  /* ------------------------------------------------------- screenshots */

  await page.screenshot({ path: join(shots, 'live-1440.png'), fullPage: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(600)
  await page.screenshot({ path: join(shots, 'live-390.png'), fullPage: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(400)
  log(true, 'screenshots taken at 1440px and 390px')

  /* --------------------------- a push that says nothing, and costs nothing
   *
   * The desktop answers a `focus-pane` — which is every click into a terminal —
   * with the project list, whether or not the list changed. The browser used to
   * act on each one: a fresh picture object, so every pane in the app
   * re-rendered, and a fresh snapshot, so the whole offline cache was parsed,
   * serialised and written back to `localStorage` synchronously, on the same
   * thread as the keystroke that caused it.
   *
   * The write is the observable half, counted by the patch every context above
   * carries. A changed list goes first, because a check that only proved
   * "nothing was written" would pass exactly as well if the push had never
   * arrived at all.
   */

  const snapshotWrites = () => page.evaluate(() => window.__forgeSnapshotWrites ?? 0)
  // The transcript flush writes on its own three-second timer whenever a pane
  // has said something, and the resize above made this one say plenty. Wait for
  // a full second with no write before measuring anything.
  await waitFor(
    async () => {
      const settled = await snapshotWrites()
      await sleep(1000)
      return (await snapshotWrites()) === settled
    },
    30_000,
    'the offline cache to go quiet'
  )

  const quiet = await snapshotWrites()
  server.pushProjects([{ ...PROJECTS[0], name: 'forge-renamed' }])
  await waitFor(async () => (await snapshotWrites()) > quiet, 15_000, 'the changed project list to be cached')
  log(true, 'a project list that changed is drawn and written into the offline cache')

  server.pushProjects(PROJECTS)
  await waitFor(
    async () => (await page.locator('.prow .prow__name').first().innerText()) === 'forge',
    15_000,
    'the rail to go back to the real name'
  )
  // Drain the transcript timer before measuring, rather than hoping it has
  // already fired. Waiting for a quiet second is not the same thing: the flush
  // runs on its own three-second interval, so output that stopped one second ago
  // leaves a *pending* write that has not happened yet and is not visible as one
  // — and if it lands inside the window below, this check fails having observed
  // nothing about the projects push at all. `pagehide` is the flush the client
  // already performs for a closed tab, so this drains the dirty set through a
  // real code path rather than a test hook, and the interval that follows writes
  // nothing because `flush` returns early on an empty set. Anything counted
  // after this line was caused by the pushes below.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  const writesBefore = await snapshotWrites()
  server.pushProjects(PROJECTS)
  server.pushProjects(PROJECTS)
  await sleep(1500)
  log(
    (await snapshotWrites()) === writesBefore,
    'and pushing that same list again rewrites nothing — which is what every click into a pane costs'
  )

  /* ======== PHASE 1d — a split and a tab flip that cost the other panes nothing
   *
   * Two complaints that turned out to be one shape: "the UI keeps glitching" and
   * "I can't flip between tabs". Both were React unmounting `PaneView`, and a
   * `PaneView` that unmounts disposes a live xterm, detaches from the session and
   * buys a fresh catch-up buffer when it comes back — up to MAX_REPLAY_BYTES,
   * down a tunnel, for a pane that did not move.
   *
   * Splitting did it because the layout was drawn by recursion: React reconciles
   * by position and element *type*, and splitting a pane turns the `<PaneView>`
   * at a position into a `<div className="split">`, which unmounts the whole
   * subtree beside it. Switching tabs did it because only the active tab was
   * mounted at all.
   *
   * The assertion is taken at the desktop, not on screen: `replayServed` records
   * every session the server has handed a catch-up buffer to, and a buffer is
   * served on exactly one event, an accepted `attach`. A pane that was never
   * thrown away asks for nothing. Reading the screen instead would pass just as
   * happily against a client that destroyed the pane and rebuilt it perfectly.
   */

  const second = manager.create({ id: SECOND_ID, cwd: ROOT, cols: 90, rows: 30 })
  log(second.ok === true, 'spawned a second real pwsh session, so the split under test is two live terminals')
  if (!second.ok) throw new Error(second.error)
  await waitFor(() => (replay.get(SECOND_ID) ?? '').includes('> '), 40_000, "the second shell's first prompt")

  const leafOf = (id) => ({ type: 'leaf', id, profileId: 'shell', title: '' })
  const splitTab = {
    id: 't1',
    title: 'e2e',
    root: { type: 'split', id: 's1', direction: 'row', ratio: 0.5, a: leafOf(SESSION_ID), b: leafOf(SECOND_ID) },
    activePaneId: SECOND_ID
  }
  // Its pane never gets a shell, on purpose: this phase is about what happens to
  // the *other* tab, and a second PTY spawn is forty seconds of somebody's life.
  const asideTab = { id: 't2', title: 'aside', root: leafOf(THIRD_ID), activePaneId: THIRD_ID }
  const servedFor = (id) => replayServed.filter((served) => served === id).length
  /** Push a workspace the way the desk does — the snapshot moves with it. */
  const pushWorkspace = (tabs, activeTabId) => {
    WORKSPACES.p1 = { tabs, activeTabId }
    server.pushWorkspace('p1', WORKSPACES.p1)
  }

  const beforeSplit = servedFor(SESSION_ID)
  pushWorkspace([splitTab], 't1')
  server.pushSessions()
  await waitFor(
    () => page.locator('.grid__tab[data-active="true"] .pane').count().then((n) => n === 2),
    20_000,
    'the split to be drawn'
  )
  log(
    servedFor(SESSION_ID) === beforeSplit,
    `splitting a pane left the one beside it alone — the desktop served it no second catch-up buffer (${beforeSplit}, before and after)`
  )
  log(
    (await paneText(SESSION_ID)).includes(`forge-web-${nonce}`),
    'and it still shows what was typed into it rather than a repainted blank'
  )

  /*
   * The arithmetic flex used to do. Panes.tsx composes it into `calc()` down the
   * tree now, and an expression that is out by a pixel per level is exactly the
   * kind of thing that looks fine on one split and wrong on four — so it is
   * measured rather than looked at.
   */
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, width: r.width }
  }
  const wall = await page.locator('.grid__tab[data-active="true"] .panes').evaluate(rect)
  const halves = await page.locator('.grid__tab[data-active="true"] .panes__slot').evaluateAll((slots) => {
    const box = (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, width: r.width }
    }
    return slots.map(box)
  })
  const near = (a, b) => Math.abs(a - b) < 0.5
  log(
    halves.length === 2 &&
      near(halves[0].left, wall.left) &&
      near(halves[1].right, wall.right) &&
      near(halves[1].left - halves[0].right, 6) &&
      near(halves[0].width, halves[1].width),
    `and the two halves tile the box the way the nested flex version did — flush to both edges, equal, the desktop's 6px divider between them (${Math.round(halves[0]?.width ?? 0)}px + 6 + ${Math.round(halves[1]?.width ?? 0)}px in ${Math.round(wall.width)}px)`
  )

  /* --------------------------------------------------- and now the tabs */

  pushWorkspace([splitTab, asideTab], 't1')
  await waitFor(() => page.locator('.tab').count().then((n) => n === 2), 20_000, 'the second tab')

  const beforeFlip = [servedFor(SESSION_ID), servedFor(SECOND_ID)]
  await page.click('.tab:nth-of-type(2)')
  log(
    (await page.locator('.tab[data-pending="true"]').count()) === 1,
    'clicking a tab says so at once rather than looking dead until the desk answers'
  )
  log(
    (await page.locator('.tab[data-active="true"] .tab__title').innerText()) === 'e2e',
    'and does not move the strip on its own — the desktop still owns which tab is active (decision 5)'
  )
  log(
    layoutOps.at(-1).op.op === 'select-tab' && layoutOps.at(-1).op.tabId === 't2',
    'while the request that would move it is on its way to the desktop'
  )

  // The desk agreeing, which is the only thing that switches a tab.
  pushWorkspace([splitTab, asideTab], 't2')
  await waitFor(
    () => page.locator('.tab[data-active="true"] .tab__title').innerText().then((title) => title === 'aside'),
    20_000,
    'the switch to land'
  )
  log((await page.locator('.tab[data-pending="true"]').count()) === 0, 'and the asked-for mark clears when the push arrives')
  log(
    servedFor(SESSION_ID) === beforeFlip[0] && servedFor(SECOND_ID) === beforeFlip[1],
    `flipping tabs re-replayed neither pane in the tab being left (${beforeFlip.join(' and ')} buffers, unchanged)`
  )
  log(
    (await page.locator('.grid__tab[data-active="true"] .pane').count()) === 1 &&
      (await page.locator('.pane').count()) === 3,
    'because the tab that went away is hidden rather than destroyed — one pane on screen, three still mounted'
  )

  pushWorkspace([splitTab, asideTab], 't1')
  await waitFor(
    () => page.locator('.tab[data-active="true"] .tab__title').innerText().then((title) => title === 'e2e'),
    20_000,
    'the switch back'
  )
  log(
    servedFor(SESSION_ID) === beforeFlip[0] && servedFor(SECOND_ID) === beforeFlip[1],
    'and coming back cost nothing either, which is the half a lazily-mounted tab would still have got wrong'
  )
  log(
    (await paneText(SESSION_ID)).includes(`forge-web-${nonce}`),
    'with the terminal showing exactly what it was showing before both switches'
  )

  /* ------------------------------- the same two gestures, with a thumb
   *
   * "Which tab am I in" is two gestures and not one — go to another, and get
   * out of this one — and on a phone they are drawn by different files, so
   * every assertion above this one can pass while a phone is trapped.
   *
   * That is not hypothetical. `.app[data-mobile] .tab__close` is `display:
   * none` and says why in its own comment: a row of ×s is noise on a phone,
   * *the pane header's × closes the tab*. 76b716b moved that × to the top bar
   * and turned it into `close-pane`, leaving the rule standing with nothing
   * behind it — so a phone on a tab whose pane the desk no longer had could
   * neither leave it nor close it, and the whole suite stayed green.
   *
   * So the close half is asserted on the property rather than on the button:
   * *something visible on this page gets me out of the tab I am in*, wherever
   * a later rework decides to put it. The selecting half is the same claim the
   * mouse made above, re-made at 390px because the pill is a different size,
   * in a strip that scrolls, under a different stylesheet.
   */

  /*
   * A finger, not merely a narrow window. `useMobile` wants `(pointer: coarse)`
   * as well as the width — deliberately, because a laptop dragged to 390px has
   * a mouse and wants the folded desktop layout — and neither `setViewportSize`
   * nor a context flag on a page that is already open can say that. Touch
   * emulation can, and without a reload: this phase's panes, its replay ledger
   * and its live shells all have to survive the trip, and a `?phone`
   * navigation would throw every one of them away.
   *
   * Enabled before the resize on purpose. The query is an `and`, so with a
   * fine pointer it is false at every width and turning the finger on at
   * 1440px moves nothing; the narrowing is then the edge that fires it, which
   * is the same order a phone's first paint arrives in.
   */
  const emulation = await context.newCDPSession(page)
  await emulation.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.setViewportSize({ width: 390, height: 844 })
  await waitFor(() => page.getAttribute('.app', 'data-mobile').then((v) => v === 'true'), 10_000, 'the phone layout')
  await sleep(500)

  const thumbOps = layoutOps.length
  await page.click('.tab:nth-of-type(2)')
  await sleep(300)
  /*
   * Among the ops rather than the last of them: swapping to the phone face
   * unmounts `SplitView` and mounts `MobilePanes`, and the pane that comes up
   * under the thumb takes the caret on its way in. So a `focus-pane` legitimately
   * lands after the request being asserted, and pinning this to `at(-1)` was
   * asserting the order of two unrelated things.
   */
  const thumbAsked = layoutOps.slice(thumbOps).map(({ op }) => op)
  log(
    thumbAsked.some((op) => op.op === 'select-tab' && op.tabId === 't2'),
    `a thumb on a tab pill asks for that tab, the same as a mouse on the folded layout does (${thumbAsked.map((op) => op.op).join(', ') || 'nothing arrived'})`
  )
  log(
    (await page.locator('.tab[data-active="true"] .tab__title').innerText()) === 'e2e',
    'and no more moves the strip by itself than the mouse did'
  )
  pushWorkspace([splitTab, asideTab], 't2')
  await waitFor(
    () => page.locator('.tab[data-active="true"] .tab__title').innerText().then((title) => title === 'aside'),
    20_000,
    'the phone-width switch to land'
  )
  log(true, 'and the strip moves to it when the desktop says so')

  /**
   * Every control on screen that would get this browser out of the tab it is
   * in, counted as a person would count them: drawn, sized and not painted
   * out. `:visible` alone would take a `display: none` rule's word for it and
   * miss an opacity-0 pill.
   */
  const wayOut = () =>
    page.evaluate(() => {
      const drawn = (selector) =>
        [...document.querySelectorAll(selector)].filter((el) => {
          const box = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          )
        })
      return drawn('.tab[data-active="true"] .tab__close, .grid__tab[data-active="true"] .pane__action--close').length
    })
  log((await wayOut()) > 0, 'and the tab it is now in can be got out of — a × on this page, drawn and not merely mounted')

  const closeOps = layoutOps.length
  await page
    .locator('.tab[data-active="true"] .tab__close, .grid__tab[data-active="true"] .pane__action--close')
    .filter({ visible: true })
    .first()
    .click()
  log(
    layoutOps.length > closeOps && ['close-tab', 'close-pane'].includes(layoutOps.at(-1).op.op),
    `and pressing it reaches the desktop as a close (${layoutOps.at(-1)?.op?.op ?? 'nothing arrived'})`
  )

  await page.screenshot({ path: join(shots, 'tabs-390.png') })
  pushWorkspace([splitTab, asideTab], 't1')
  await waitFor(
    () => page.locator('.tab[data-active="true"] .tab__title').innerText().then((title) => title === 'e2e'),
    20_000,
    'the switch back at phone width'
  )
  await emulation.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await waitFor(() => page.getAttribute('.app', 'data-mobile').then((v) => v === null), 10_000, 'the folded layout back')
  await emulation.detach()
  // The width flip re-mounts every pane, so the replay ledger below is read
  // after it has settled rather than across it.
  await sleep(800)

  /* ------------------------------------- and closing, which is the same bug */

  const beforeClose = servedFor(SESSION_ID)
  pushWorkspace([{ ...splitTab, root: leafOf(SESSION_ID), activePaneId: SESSION_ID }], 't1')
  await waitFor(() => page.locator('.pane').count().then((n) => n === 1), 20_000, 'the pane count after the close')
  log(
    servedFor(SESSION_ID) === beforeClose,
    'closing the pane beside it — and the whole second tab with it — left this one untouched as well'
  )
  log(
    (await paneText(SESSION_ID)).includes(`forge-web-${nonce}`),
    'and it is the same terminal it has been since Phase 1, with the same transcript in it'
  )

  /* ============== PHASE 1e — the socket drops, and the workspace stays put
   *
   * `lib/client.ts` announces `connecting` at the top of every `open()` and on
   * every scheduled retry, and `App` used to answer that by replacing the entire
   * application with the full-page gate. That unmounted `Workspace`, which
   * unmounted every `PaneView`, which disposed every xterm and detached every
   * pane — so a socket that merely flinched took away the thing the person was
   * reading and bought each pane a fresh catch-up buffer on the way back in.
   *
   * Dropped without a `shutdown` notice on purpose. A shutdown is the desktop
   * saying in words that it is going away, which is a different screen and is
   * Phase 4's; this is the network flinching, which is the case the gate was
   * wrong about.
   */

  const droppedAt = [servedFor(SESSION_ID), servedFor(SECOND_ID)]
  await server.stop()
  await waitFor(
    () => page.locator('[data-testid="reconnecting-banner"]').count().then((n) => n > 0),
    30_000,
    'the reconnecting strip'
  )
  log(
    (await page.locator('.gate__card').count()) === 0 && (await page.locator('.pane').count()) === 1,
    'a socket that dropped badges the workspace rather than replacing it with a spinner — the pane is still on screen'
  )
  log(
    (await screenText()).includes(`forge-web-${nonce}`),
    'still showing the transcript it was showing, because the terminal was never disposed'
  )
  log(
    (await page.locator('.pane__perm[data-reconnecting="true"]').count()) === 1 &&
      (await page.locator('.pane__terminal .xterm-helper-textarea').evaluate((el) => el.readOnly)) === true,
    'and it says so rather than pretending — the pane is badged and its keyboard is shut'
  )

  server = makeServer(makeAuth())
  active = server
  await server.start({ host: '127.0.0.1', port: livePort })
  await waitFor(
    () => page.locator('.linkbadge[data-state="live"]').count().then((n) => n === 1),
    40_000,
    'the link to come back'
  )
  log(
    (await page.locator('[data-testid="reconnecting-banner"]').count()) === 0,
    'and the badge comes off on its own when the link is back, with no reload anywhere'
  )
  await waitFor(async () => (await screenText()).includes(`forge-web-${nonce}`), 30_000, 'the repaint')
  log(
    servedFor(SESSION_ID) === droppedAt[0] + 1 && servedFor(SECOND_ID) === droppedAt[1],
    'and the hello-ok re-attach loop re-armed exactly the pane still on screen — one catch-up buffer, and none for the pane that was closed before the drop'
  )
  log(
    (await page.locator('.notice').count()) === 0,
    'raising no "that pane is gone" on the way, which is what that loop used to be good for'
  )

  /* ================================== PHASE 1b — coming back, and typing nothing
   *
   * The thing this whole feature is for: most visits should involve no login at
   * all. Two of them, and they are genuinely different failures — a reload
   * exercises the session surviving in `localStorage` and being restored on
   * load, and a restart exercises it surviving the tab that wrote it.
   *
   * `credentialsTyped` is the assertion. Landing in the workspace is easy to
   * satisfy by accident; landing in the workspace without that number moving is
   * the claim.
   */

  const typedBeforeReload = credentialsTyped
  const stored = await page.evaluate(() => localStorage.getItem('forge-web-auth'))
  log(
    typeof stored === 'string' && JSON.parse(stored).refreshToken === 'refresh-e2e',
    'signing in left a refresh token in browser storage — the credential a return visit restores from'
  )

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after a reload')
  log(credentialsTyped === typedBeforeReload, 'reloading lands straight back in the workspace with nothing typed')
  log((await page.locator('input[type="email"]').count()) === 0, 'and the sign-in form is never drawn on the way')

  // The stored ID token, aged past its own margin. `Auth.idToken` has to notice
  // and spend the refresh token rather than presenting a dead one — the case
  // that decides whether this works tomorrow morning as well as this minute.
  const refreshesBefore = tokenRefreshes
  await page.evaluate(() => {
    const raw = localStorage.getItem('forge-web-auth')
    if (!raw) return
    const session = JSON.parse(raw)
    session.expiresAt = Date.now() - 60_000
    localStorage.setItem('forge-web-auth', JSON.stringify(session))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after a refresh')
  log(tokenRefreshes > refreshesBefore, 'an ID token past its margin is refreshed rather than presented dead')
  log(credentialsTyped === typedBeforeReload, 'and that still costs nobody a password')

  // A browser that was quit and reopened. `storageState` carried over is what
  // makes this a restart rather than a fresh install — without it this would
  // assert the opposite of what it looks like it asserts.
  const carriedOver = await context.storageState()
  await context.close()
  context = await newContext(carriedOver)
  page = await newPage(context)
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after a restart')
  log(credentialsTyped === typedBeforeReload, 'and a browser that was quit and reopened is still signed in')
  log(
    (await page.locator('.linkbadge[data-state="live"]').count()) === 1,
    'with a live link rather than a cached picture — it reconnected on its own'
  )

  /* ======================================= PHASE 1c — the unlock PIN, on screen
   *
   * A desktop with a PIN set, answered from a browser. The claim
   * `scripts/web-auth-check.mjs` cannot make is this one: that a person in a
   * browser is asked, can answer, and gets in — and that the same person is
   * asked again on the next connection, because shared/web.ts says there is no
   * "remember this browser" and there must not be one.
   *
   * The PIN is seeded through the shipped `hashPin`, so what stands on this
   * desktop is the exact `scrypt$1$…` string the settings panel would have
   * written and what judges the browser is the real `verifyPin`. A comparison
   * written into this file would agree with itself forever.
   */

  const PIN = '483920'
  const PIN_HASH = hashPin(PIN)
  /**
   * How many connections have reached the PIN gate, counted at the desktop.
   *
   * `pinHash` is read once per `hello` that gets as far as `checkPin` — see
   * `authenticate` in electron/web/auth.ts — so this counts *dials that were
   * judged*, which is the observation a screen cannot give: whether the browser
   * asked once and waited, or kept knocking.
   */
  let pinChecks = 0
  const pinHost = {
    pinHash: () => {
      pinChecks++
      return PIN_HASH
    }
  }

  const pinPort = await startPhase(pinHost)
  setConfig({ devHost: `127.0.0.1:${pinPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'pin', 30_000, 'the PIN prompt')
  log(true, 'a desktop with an unlock PIN asks the browser for it rather than refusing the connection')
  log(
    (await page.locator('[data-testid="pin-input"]').count()) === 1 && pinChecks === 1,
    'and the ask is a box on a gate card, reached by a first hello that deliberately carried no PIN'
  )
  log(
    (await page.locator('.gate__card[data-reason="pin"] button[type="submit"]').isDisabled()) === true,
    `with nothing to send until there are ${PIN_MIN_DIGITS} digits in it, which is the shortest PIN this desktop would accept`
  )

  await page.screenshot({ path: join(shots, 'pin-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(400)
  await page.screenshot({ path: join(shots, 'pin-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(300)

  const asked = await page.locator('.gate__card[data-reason="pin"] .gate__body').innerText()
  await page.fill('[data-testid="pin-input"]', '000000')
  await page.click('.gate__card[data-reason="pin"] button[type="submit"]')
  await waitFor(async () => (await page.locator('.gate__error').count()) > 0, 20_000, 'the refusal for a wrong PIN')
  log((await gateReason()) === 'pin', 'a wrong PIN is answered on the same screen rather than by a dead end')
  const refusedPin = await page.locator('.gate__error').innerText()
  log(
    refusedPin !== asked && pinChecks === 2,
    `carrying the desktop's own sentence about the PIN that did not work rather than the one that asked for it ("${refusedPin}")`
  )

  await page.fill('[data-testid="pin-input"]', PIN)
  await page.click('.gate__card[data-reason="pin"] button[type="submit"]')
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after the PIN')
  log(true, 'and the PIN set on that desktop gets the browser in')
  log(pinChecks === 3, `each answer costing exactly one dial (${pinChecks} connections judged, and no others)`)

  /* ------------------- and asked again next time, because it is not a device key */

  const typedBeforePin = credentialsTyped
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(async () => (await gateReason()) === 'pin', 30_000, 'the PIN prompt on the next connection')
  log(
    true,
    'the next connection is asked for it again — there is no "trust this browser", so answering once does not buy tomorrow'
  )
  log(
    credentialsTyped === typedBeforePin && (await page.locator('input[type="email"]').count()) === 0,
    'and it is the PIN alone being asked for: the account is still signed in, and no password was typed'
  )
  await page.fill('[data-testid="pin-input"]', PIN)
  await page.click('.gate__card[data-reason="pin"] button[type="submit"]')
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after the second PIN')

  const stashed = await page.evaluate((pin) => {
    for (let at = 0; at < localStorage.length; at++) {
      const key = localStorage.key(at) ?? ''
      if ((localStorage.getItem(key) ?? '').includes(pin)) return key || '(a blank key)'
    }
    return ''
  }, PIN)
  log(
    stashed === '',
    `and nothing on this page wrote the PIN down${stashed ? ` — "${stashed}" is holding it` : ', so a page only ever holds one it was just asked for'}`
  )

  /* ================================ PHASE 3 — two refusals, two sentences
   *
   * The pair used to be `wrong-account` and `revoked`. There is no `revoked` any
   * more — the device list it named is gone, because it was never a gate — so
   * the second half of the contrast moved to `busy` in phase 3b, which is a
   * sharper pair anyway: those two refusals differ in the one way that matters
   * most to somebody reading the screen, which is whether the page is going to
   * come back on its own or is waiting for them.
   */

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
  const wrongPort = await startPhase()
  setConfig({ devHost: `127.0.0.1:${wrongPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'wrong-account', 30_000, 'the wrong-account screen')
  await captureRefusal('wrong-account')
  await page.screenshot({ path: join(shots, 'refused-wrong-account-1440.png') })

  tokenSub = UID

  /* ============== PHASE 3b — the refusal that is retried, and read anyway
   *
   * `busy` is the one refusal this client is *supposed* to come back from on its
   * own, and that is exactly why it used to be the one nobody could read:
   * `scheduleRetry` announced `connecting` the instant it was called, in the
   * same React batch as the refusal that called it, so the screen carrying the
   * desktop's own sentence and the "worth trying again" line never rendered at
   * all. What was on screen instead was a rising attempt count against a desktop
   * that had just said, in words, what was wrong with it.
   *
   * A desktop with no uid configured is the reachable way to be told this: see
   * `checkToken` in electron/web/auth.ts, which answers a desktop that is up but
   * not set up with `busy` and a minute's back-off rather than with `bad-token`,
   * because no amount of re-authenticating would fix it.
   */

  const busyPort = await startPhase({ uid: () => '' })
  setConfig({ devHost: `127.0.0.1:${busyPort}` })
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'busy', 30_000, 'the busy screen')
  await captureRefusal('busy')
  const busyCard = await page.locator('.gate__card').innerText()
  log(true, 'a desktop that is up but not set up refuses with busy, and that refusal is drawn rather than skipped past')
  log(
    busyCard.includes('This desktop is not set up for Forge Web yet.'),
    "carrying the desktop's own sentence about what is wrong with it, verbatim"
  )
  log(
    /trying again in about \d+s/i.test(busyCard),
    'and the line that says when coming back is worth it, which is the only thing a back-off is good for'
  )
  await page.screenshot({ path: join(shots, 'refused-busy-1440.png') })

  // The refusal is the screen for the whole of the back-off rather than for one
  // frame of it. A second and a half is far longer than the batch that used to
  // overwrite it, and far shorter than the minute the desktop asked for.
  await sleep(1500)
  log(
    (await gateReason()) === 'busy',
    'and it is still there a second and a half later, rather than replaced by the retry that is waiting on it'
  )

  /* --------------------- the contrast phase 3 set this pair up to make
   *
   * Two refusals, side by side, taken off the screen rather than off the type:
   * different words, and — the half that actually decides what somebody does
   * next — different recoveries. `wrong-account` is a correct credential for the
   * wrong desktop, so retrying would loop on it forever and the only way out is
   * a human signing in as somebody else; `busy` is a desktop that will be ready
   * later, so the page comes back on its own and says when.
   */

  const wrong = refusalScreens['wrong-account']
  const busy = refusalScreens['busy']
  log(wrong.reason === 'wrong-account' && busy.reason === 'busy', 'each refusal names itself on screen')
  log(
    wrong.title !== busy.title,
    `and wears a different headline (“${wrong.title}” vs “${busy.title}”), not one generic failure`
  )
  log(wrong.body !== busy.body, 'with different prose underneath it')
  log(
    /sign out|sign in as/i.test(wrong.body) && /trying again in about \d+s/i.test(busy.body),
    'and a different recovery: sign in as somebody else, against a page that is already coming back on its own'
  )

  /* ====================================== PHASE 4 — the desktop is asleep
   *
   * ## The picture this phase needs, and why it has to be made here
   *
   * Everything below asserts the *cached* workspace, so this phase needs a
   * cache — and it cannot inherit one, because phase 3 correctly destroys it.
   * That phase signs in with `tokenSub` set to `OTHER_UID` to earn a
   * `wrong-account` refusal, which is a genuine sign-in as a second person, and
   * `signIn` in web/src/state.tsx answers a uid that is not the cached one by
   * clearing the snapshot. It has to: SNAPSHOT_VERSION 4 in web/src/lib/cache.ts
   * exists for exactly that, because a browser lent to somebody else was showing
   * the first person's projects and transcripts in the frozen view. Neither
   * phase 3 nor 3b then reaches a `hello-ok`, both being refusals, so nothing
   * writes a new one.
   *
   * So this phase used to run against an empty cache and assert a picture that
   * had been deliberately deleted three phases earlier. It failed on the rail,
   * the tabs and the frozen pane — one product behaviour working exactly as
   * designed, read as three bugs — and it failed silently for as long as it did
   * because web:e2e needs a browser and so is not one of the checks CI runs.
   *
   * The fix is to establish the precondition rather than to weaken the
   * assertion: sign in once more as the real account against a live desktop, let
   * a `hello-ok` write the snapshot, and only then take the desktop away. What
   * follows is unchanged, and now tests what it says it tests.
   */

  const revivePort = await startPhase()
  setConfig({ devHost: `127.0.0.1:${revivePort}` })
  await signInFresh()
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'a live desktop to cache a picture from')
  await waitFor(
    () => page.evaluate(() => localStorage.getItem('forge-web-snapshot') !== null),
    15_000,
    'the picture to reach the offline cache'
  )
  log(
    await page.evaluate(() => {
      const raw = localStorage.getItem('forge-web-snapshot')
      return raw !== null && (JSON.parse(raw).projects ?? []).length > 0
    }),
    'a browser that has seen this desktop has its picture written down, which is what the rest of this phase reads'
  )

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
  // Waited for rather than read once, which is the same correction the commit
  // "The offline check waits for the editor to be filled, not to exist" already
  // made one phase earlier. The frozen pane is a *fresh* xterm mounted against
  // the cached transcript, so between the badge appearing — which the assertions
  // above have just proved — and the first row being painted there is a tick
  // this read was landing inside, on roughly two runs in three under load. It
  // failed while the screenshot taken moments later showed the text present,
  // which is a check calling the product broken because the check was early.
  // The wait is bounded, and a genuine regression still arrives as a FAIL
  // carrying what was on screen rather than as a thrown timeout.
  await waitFor(
    async () => (await screenText()).includes(`forge-web-${nonce}`),
    15_000,
    'the frozen terminal to paint the cached transcript'
  ).catch(() => {})
  const frozenText = await screenText()
  log(
    frozenText.includes(`forge-web-${nonce}`),
    'and the frozen terminal is showing the transcript this browser cached while it was live'
  )
  await page.screenshot({ path: join(shots, 'offline-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(600)
  await page.screenshot({ path: join(shots, 'offline-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(300)

  /* ================================ PHASE 5 — the desktop moved, mid-loop
   *
   * A cloudflared quick tunnel comes back on a **new hostname every time it
   * starts**, and the desktop republishes the record within seconds. So the
   * address a browser was handed can be retired under it while the machine it
   * names is up and two seconds away — and a reconnect loop that re-dials the
   * string it was constructed with then dials a hostname that no longer exists,
   * forever, against a desktop that would answer. On screen that is
   * "Reconnecting to the desktop (attempt 41)…", which is exactly what a PC that
   * is switched off looks like.
   *
   * Neither address here answers, and neither needs to: the assertion is *which
   * one the browser dials*. Both are under `.invalid`, which RFC 6761 reserves
   * precisely so that it resolves nowhere — the dial fails without a packet
   * leaving the machine, and this phase therefore needs no tunnel, no
   * certificate and no public hostname, none of which belong in a check (see the
   * header). What it does exercise for real is the whole production route: the
   * rendezvous record read out of the database, `webSocketUrl` composing the
   * address from it, and — on the retry, and only on the retry — that read
   * happening *again* rather than the loop trusting the address it already has.
   */

  const OLD_HOST = 'forge-e2e-old.invalid'
  const NEW_HOST = 'forge-e2e-new.invalid'
  const publish = (host) => {
    hostRecord = { host, proto: WEB_PROTO, app: '0.0.0-e2e', name: 'E2E-PC', at: Date.now() }
  }

  publish(OLD_HOST)
  setConfig({})
  /*
   * Reloaded rather than signed into afresh, and the difference is the whole
   * of the last assertion in this phase.
   *
   * `signInFresh` clears `forge-web-auth`, and a page that loads with no stored
   * session drops the offline snapshot on mount — deliberately, because a
   * browser nobody is signed into must not still be holding somebody's projects
   * and transcripts. Every address in this phase is under `.invalid`, so nothing
   * here ever reaches a `hello-ok` to write a new one, and the stranded handoff
   * below therefore had no frozen picture to hand the page back *to*: it fell
   * through to `Unpaired` — "No PC is publishing for this account" — under a
   * message that said the opposite, which is that an address had been published
   * and was not answering.
   *
   * Phase 4 leaves exactly what is wanted: a valid session and a cached picture
   * of this desktop. Nothing in this phase changes `tokenSub`, which is the one
   * thing `signInFresh` exists to keep honest, so inheriting both costs no
   * assertion and buys the precondition the stranded case is written about.
   */
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await waitFor(() => dialled.some((url) => url.includes(OLD_HOST)), 30_000, 'the first dial')
  log(true, `a live record is dialled at the address it publishes (wss://${OLD_HOST}/web)`)
  const readsAtFirstDial = rtdbReads.length

  // The tunnel restarted and came back somewhere else, which is the only thing
  // that happens here — the desktop is no more reachable than it was a moment
  // ago, and no less.
  publish(NEW_HOST)
  await waitFor(() => dialled.some((url) => url.includes(NEW_HOST)), 60_000, 'the dial at the new address')
  log(true, `a reconnect dials where the desktop is now, not where it was (wss://${NEW_HOST}/web)`)
  log(
    rtdbReads.length > readsAtFirstDial,
    'which it can only have learnt by reading the rendezvous record again on the retry, rather than re-dialling the string it was handed'
  )
  log(
    (dialled.at(-1) ?? '').includes(NEW_HOST),
    'and it stays on the new address afterwards rather than alternating between the two'
  )

  /* ------------------------ and a record that turns out not to be true
   *
   * Neither address here answers, which is the fourth way this link used to loop
   * forever and the only one with no way back. A record is a *claim* about a
   * desktop, and `isHostLive` keeps believing it for HOST_STALE_MS — three
   * minutes — so a machine that slept without saying so leaves the browser
   * dialling nothing. That much is by design. What was not is where it left the
   * page: `Connecting` has no button on it, and the poll that would read the
   * record again runs only while the stage is `offline`, so the tab sat on a
   * rising attempt count until somebody reloaded it. A bounded number of failed
   * dials now hands the page back to the frozen picture, which has both.
   *
   * The wait is the client's own back-off rather than anything this file
   * invented, so the ceiling below is generous on purpose: what is being
   * asserted is that the page arrives, not how fast.
   */
  await waitFor(
    () => page.locator('[data-testid="offline-banner"]').count().then((n) => n > 0),
    90_000,
    'the page to stop waiting on a record nothing is answering'
  )
  log(
    (await page.locator('.app').count()) === 1 && (await page.locator('.gate__card').count()) === 0,
    'a live record that nothing answers drops the page back to the frozen picture, where the poll runs and there is something to press, rather than stranding it on a Connecting screen forever'
  )

  /* ============ PHASE 5c — adding a project, from three hundred miles away
   *
   * The desktop's own Add project opens `dialog.showOpenDialog`, which draws a
   * window on the desktop's screen — the one screen the person adding the
   * project is definitively not sitting at. So Forge Web browses that machine's
   * folders in the page instead, and this is the whole route in one gesture: a
   * click on the rail's +, an `fs-list` per screen answered by the shipped
   * `listFolder`, a `project-add` on the folder somebody chose, and a rail that
   * redraws because the desktop pushed a new list rather than because the
   * browser assumed one.
   *
   * The tree below is real and made here, so the names on screen can be
   * asserted exactly: a folder that is a repository, a folder that is not, and
   * a file, which is drawn — a folder full of source that rendered as empty
   * would be the moment somebody loses their bearings — but cannot be picked.
   */

  const browseRoot = join(scratch, 'browse')
  mkdirSync(join(browseRoot, 'alpha', '.git'), { recursive: true })
  mkdirSync(join(browseRoot, 'beta'), { recursive: true })
  writeFileSync(join(browseRoot, 'notes.txt'), 'not a folder')

  /*
   * A second project, pointing at the scratch folder, so the picker opens
   * somewhere this file controls the contents of. It is added before the phase
   * starts rather than pushed afterwards, so it arrives in `hello-ok` like any
   * other project this desktop already had.
   */
  PROJECTS.push({ id: 'p2', name: 'scratch', path: scratch, color: '#4AA3FF', defaultProfileId: 'shell', createdAt: 0 })

  const pickPort = await startPhase()
  setConfig({ devHost: `127.0.0.1:${pickPort}` })
  await signInFresh()
  await waitFor(() => page.locator('.rail').count().then((n) => n > 0), 30_000, 'the rail')

  const pickerList = page.locator('[data-testid="folder-picker-list"] .picker__row')
  const pickerRow = (name) => pickerList.filter({ hasText: name }).first()
  const pickerHere = () => page.locator('.picker__here').innerText()

  await page.locator('.prow').filter({ hasText: 'scratch' }).first().click()
  await page.click('[data-testid="add-project"]')
  await waitFor(() => page.locator('[data-testid="folder-picker"]').count().then((n) => n > 0), 15_000, 'the picker')
  log(true, 'the rail has a + that opens onto the desktop, which it could not have before')
  log(
    (await page.locator('[data-testid="add-project-new"]').count()) === 1 &&
      (await page.locator('[data-testid="add-project-existing"]').count()) === 1,
    'and it opens on the desk’s own choice: create a new folder, or use an existing one'
  )

  await page.click('[data-testid="add-project-existing"]')
  await waitFor(async () => (await pickerHere()) === scratch, 15_000, 'the first listing')
  log(
    true,
    `it opens inside the project this browser is looking at (${basename(scratch)}) rather than at the top of a disk nobody wants to walk down`
  )

  await pickerRow('browse').click()
  await waitFor(async () => (await pickerHere()) === browseRoot, 15_000, 'the walk into browse')
  log(true, 'and clicking a folder walks into it, one request per screen')

  const alphaRow = pickerRow('alpha')
  log((await alphaRow.locator('.picker__repo').count()) === 1, 'a folder with a .git in it is badged, so a project stands out from the folders around it')
  log((await pickerRow('beta').locator('.picker__repo').count()) === 0, 'and one without is not')
  log(
    (await pickerRow('notes.txt').evaluate((el) => el.tagName)) === 'DIV',
    'a file is drawn — a folder of source that looked empty would lose somebody entirely — but is not something that can be pressed'
  )
  log(
    (await page.locator('.picker__crumb').allInnerTexts()).includes('browse'),
    'the breadcrumb names every folder above this one, each carrying the path the desktop gave for it'
  )

  await page.screenshot({ path: join(shots, 'folder-picker.png') })

  await alphaRow.click()
  await waitFor(async () => (await pickerHere()) === join(browseRoot, 'alpha'), 15_000, 'the walk into alpha')
  await page.click('.picker__use')
  await waitFor(() => Promise.resolve(projectAdds.length > 0), 15_000, 'the desktop to be asked')
  log(
    projectAdds.at(-1) === join(browseRoot, 'alpha'),
    `the folder the browser chose is the folder the desktop was asked for (${projectAdds.at(-1)})`
  )
  await waitFor(
    () => page.locator('.prow').filter({ hasText: 'alpha' }).count().then((n) => n > 0),
    15_000,
    'the new project in the rail'
  )
  log(
    true,
    'and it appears in the rail because the desktop pushed a new project list — the browser adds nothing to its own picture, exactly as it adds no tab of its own'
  )
  log((await page.locator('[data-testid="folder-picker"]').count()) === 0, 'the picker closes behind it rather than sitting there over the answer')

  /*
   * The other road: a brand-new folder from a name. The fence is the shipped
   * `planProjectFolder` (see the fixture's `projectCreate`), so what this
   * drives is the browser's half — the form, the request, the rail redrawn by
   * the push, and a duplicate refused with "open it instead" on offer.
   */
  await page.click('[data-testid="add-project"]')
  await page.click('[data-testid="add-project-new"]')
  await page.fill('#picker-name', 'minted')
  await page.click('[data-testid="create-project"]')
  await waitFor(() => Promise.resolve(existsSync(join(scratch, 'minted'))), 15_000, 'the folder on disk')
  log(true, 'a name typed in a browser becomes a real folder on the desktop')
  await waitFor(
    () => page.locator('.prow').filter({ hasText: 'minted' }).count().then((n) => n > 0),
    15_000,
    'the created project in the rail'
  )
  log(true, 'and it lands in the rail the same way a picked folder does — because the desktop pushed the list')
  log((await page.locator('[data-testid="folder-picker"]').count()) === 0, 'and this road closes the popover behind it too')

  await page.click('[data-testid="add-project"]')
  await page.click('[data-testid="add-project-new"]')
  await page.fill('#picker-name', 'minted')
  await page.click('[data-testid="create-project"]')
  await waitFor(() => page.locator('.picker__error').count().then((n) => n > 0), 15_000, 'the duplicate refusal')
  log(
    (await page.locator('.picker__error').innerText()).includes('already exists'),
    'the same name again is refused in a sentence rather than silently adopting the folder'
  )
  const openInstead = page.locator('.popover__actions .ghost-btn', { hasText: 'Open it instead' })
  log((await openInstead.count()) === 1, 'with "Open it instead" one explicit click away')
  await openInstead.click()
  await waitFor(() => page.locator('[data-testid="folder-picker"]').count().then((n) => n === 0), 15_000, 'the popover to close')
  log(true, 'and taking that offer lands on the project it already has, rather than a second row')

  /*
   * And the fold, which is the case this whole feature is for: below 640px
   * `useNarrow` collapses the rail by the *window*, so there is no toggle to
   * press and a header hidden at that width would take Add project away from
   * the one screen most likely to be nowhere near the desk.
   */
  await page.setViewportSize({ width: 390, height: 844 })
  await sleep(400)
  log(
    (await page.locator('[data-testid="add-project"]').count()) === 1,
    'and the + is still there at phone width, where the rail is collapsed by the window rather than by a click'
  )
  await page.screenshot({ path: join(shots, 'add-project-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(300)

  /* ============ PHASE 5d — the desktop's screen, watched and then driven
   *
   * The one feature on this link that does not end inside Forge. Everything
   * else here is a pane, a tab or a folder; this is a display, and in its second
   * mode a mouse and a keyboard on somebody's actual machine — so it is the
   * phase most worth driving end to end rather than reasoning about.
   *
   * Both ends are the shipped code and neither is a stand-in. The picture is
   * produced by src/lib/web-mirror.ts, bundled and run inside this same Chrome
   * against a canvas standing in for the display, and handed to the real
   * `WebServer` exactly as electron/web-host.ts hands it over on IPC. The
   * browser half is the real `Mirror` component, the real `startScreen` decoder
   * and the real `fractionFor` arithmetic. What is asserted is what neither half
   * can prove alone: that a chunk this encoder produced decodes and *paints* at
   * the other end, and that a click at a known place on that picture arrives at
   * the desktop as the fraction of the screen it was actually over.
   *
   * The mode is the other half of the phase, and it is a safety device rather
   * than a feature. Watching sends nothing at all — not "sends nothing because a
   * flag says so", but because no keyboard listener exists — and driving is
   * entered by a click and left by Escape *twice*, never once, because Escape is
   * one of the fifteen keys this link can send and is the one somebody driving a
   * remote desktop needs most.
   */

  /**
   * The PIN this desktop demands before it will show its screen.
   *
   * Compared as a plain string by the hook above rather than through `verifyPin`,
   * and deliberately: the hashing is already driven end to end in phase 1c, and
   * what is being asserted here is the round trip — the browser is refused,
   * draws a box, and the PIN it was asked for reaches `mirrorStart` on the
   * *second* frame rather than being replayed from the one that opened the
   * connection an hour ago.
   */
  mirrorPin = '424242'
  screenControl = true
  mirrorStarts.length = 0
  mirrorInputs.length = 0

  const screenPort = await startPhase()
  setConfig({ devHost: `127.0.0.1:${screenPort}` })
  await signInFresh()
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace')

  await page.click('button[aria-label^="Watch this desktop"]')
  await waitFor(() => Promise.resolve(mirrorStarts.length > 0), 15_000, 'the browser to ask for the screen')
  log(mirrorStarts[0] === '', 'the first ask for the screen carries no PIN, so a page only ever holds one it was just asked for')

  await waitFor(() => page.locator('.mirror__card input').count().then((n) => n > 0), 15_000, 'the PIN box')
  log(true, 'and a desktop that wants its PIN before it shares a screen gets a box rather than an apology')

  await page.fill('.mirror__card input', mirrorPin)
  await page.click('.mirror__card button[type="submit"]')
  await waitFor(() => Promise.resolve(mirrorStarts.length > 1), 15_000, 'the second ask')
  log(mirrorStarts[1] === mirrorPin, 'the PIN typed into that box is what reaches the desktop, on a second ask')
  await waitFor(() => Promise.resolve(mirroring), 15_000, 'the desktop to record a viewer')
  log(mirroring === true, 'and the desktop now believes it is being watched')

  /* --- the encoder, running in this browser and speaking to the real server */

  /** Every config and chunk that left the shipped encoder, as the server saw it. */
  const mirrorConfigs = []
  const mirrorChunks = []
  const mirrorEndings = []
  await page.exposeFunction('forgeMirrorReady', (config) => {
    mirrorConfigs.push(config)
    active?.pushMirrorReady(config)
  })
  await page.exposeFunction('forgeMirrorChunk', (chunk) => {
    // The same arithmetic the server uses to judge a chunk against its ceiling —
    // three bytes per four characters of base64 — so what is asserted below is
    // the number that would have ended the watch.
    mirrorChunks.push({ key: chunk.key === true, bytes: Math.floor((chunk.data.length * 3) / 4) })
    active?.pushMirrorFrame(chunk)
  })
  await page.exposeFunction('forgeMirrorStopped', (reason) => {
    mirrorEndings.push(reason)
    active?.pushMirrorStop(reason)
  })
  await page.addScriptTag({ content: encoderBundle })

  /*
   * The display, and the *second* thing this file stubs. A canvas being redrawn
   * thirty times a second is handed back from `getUserMedia`, so `captureScreen`
   * in src/lib/mirror.ts runs its real constraints against a real stream and the
   * encoder above it never learns the difference. Bright, and moving, because
   * both halves of the assertion need it: a still frame proves nothing about a
   * codec, and a dark one proves nothing about a canvas.
   *
   * Deliberately *noisy* over most of its area, too. A flat picture compresses
   * to a few hundred bytes a frame, which would make the ceiling assertion below
   * true by accident; a field of random blocks is the nearest a canvas gets to
   * the worst case a real desktop presents an encoder — every pixel changing at
   * once — and pushes a keyframe into the kilobytes where the number means
   * something. The bottom quarter is left flat because that is the strip the
   * decoded-pixel assertion reads.
   */
  const encoderError = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const ctx = canvas.getContext('2d')
    const draw = () => {
      for (let y = 0; y < 300; y += 8) {
        for (let x = 0; x < canvas.width; x += 8) {
          ctx.fillStyle = `rgb(${(Math.random() * 256) | 0},${(Math.random() * 256) | 0},${(Math.random() * 256) | 0})`
          ctx.fillRect(x, y, 8, 8)
        }
      }
      ctx.fillStyle = '#00e0a0'
      ctx.fillRect(0, 300, canvas.width, 100)
    }
    draw()
    const stream = canvas.captureStream(30)
    window.__forgeDrawing = window.setInterval(draw, 33)
    navigator.mediaDevices.getUserMedia = async () => stream
    window.forge = { mobile: { mirrorSource: async () => 'screen:0:0' } }
    return await window.ForgeWebMirror.startWebMirror(false, {
      ready: (config) => window.forgeMirrorReady(config),
      chunk: (chunk) => window.forgeMirrorChunk(chunk),
      closed: (reason) => window.forgeMirrorStopped(reason)
    })
  })
  log(encoderError === null, `the desktop's encoder started${encoderError ? `: ${encoderError}` : ''}`)

  await waitFor(() => Promise.resolve(mirrorConfigs.length > 0), 20_000, 'the encoder to describe its stream')
  const shape = mirrorConfigs[0]
  log(mirrorConfigs.length === 1, 'a decoder is described exactly once per watch, before any chunk')
  log(
    typeof shape.codec === 'string' && shape.codec.length > 0 && shape.width === 640 && shape.height === 400,
    `and it names what it actually encoded (${shape.codec}, ${shape.width}x${shape.height})`
  )

  await waitFor(() => Promise.resolve(mirrorChunks.length >= 8), 20_000, 'a run of encoded chunks')
  log(mirrorChunks[0].key === true, 'the first chunk of a watch is a keyframe, so a viewer has something it can start from')
  const biggest = Math.max(...mirrorChunks.map((c) => c.bytes))
  log(
    biggest < MAX_MIRROR_CHUNK_BYTES,
    `and the largest chunk (${biggest} bytes) is inside the ${MAX_MIRROR_CHUNK_BYTES}-byte ceiling the server would end the watch over`
  )
  log(mirrorEndings.length === 0, 'and nothing on the desktop side has ended the watch')

  /*
   * The assertion the whole feature exists for: those bytes are pixels now.
   *
   * Read off the canvas the client is painting into, near the bottom where the
   * moving square never reaches, and judged loosely — a codec at 4:2:0 shifts a
   * colour by a few units and a limited-range one shifts it further. What is
   * being proved is that this is the picture the desktop sent rather than an
   * empty canvas, and the green screen is unmistakable at any tolerance.
   */
  await waitFor(
    () =>
      page.evaluate(() => {
        const canvas = document.querySelector('.mirror__picture')
        return Boolean(canvas && canvas.width > 1)
      }),
    20_000,
    'a decoded frame on the canvas'
  )
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.mirror__picture')
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), canvas.height - 12, 1, 1).data
    return { width: canvas.width, height: canvas.height, r: pixel[0], g: pixel[1], b: pixel[2] }
  })
  log(painted.width === 640 && painted.height === 400, `the browser is painting the desktop's own frames (${painted.width}x${painted.height})`)
  log(
    painted.g > 120 && painted.r < 110,
    `and what decoded is the picture that was sent, not a blank canvas (rgb ${painted.r},${painted.g},${painted.b})`
  )
  await page.screenshot({ path: join(shots, 'mirror-1440.png') })

  log(
    (await page.locator('.mirror__limits').innerText()).includes('Ctrl+C'),
    'the toolbar says out loud that Ctrl+C, Ctrl+V, Alt+Tab and the F-keys cannot be sent at all'
  )

  /* ----------------------------------------- watching sends nothing at all */

  const picture = await page.locator('.mirror__picture').boundingBox()
  const at = (fx, fy) => [picture.x + picture.width * fx, picture.y + picture.height * fy]
  await page.mouse.move(...at(0.6, 0.4))
  await sleep(200)
  log(mirrorInputs.length === 0, 'a pointer moving over the picture in watching mode sends nothing to that desk')
  log(
    (await page.getAttribute('.mirror__mode', 'data-driving')) === 'false',
    'and the toolbar says so rather than leaving anybody to guess which mode they are in'
  )

  /* ------------------------------------------------- driving, and leaving */

  await page.mouse.down()
  await page.mouse.up()
  await waitFor(
    () => page.getAttribute('.mirror__mode', 'data-driving').then((v) => v === 'true'),
    10_000,
    'driving mode'
  )
  log(mirrorInputs.length === 0, 'the click that takes the mouse is not also sent, so reaching for control costs no press on that desk')

  await page.mouse.move(...at(0.25, 0.75))
  await sleep(200)
  const moved = mirrorInputs.filter((i) => i.a === 'move').pop()
  log(
    moved !== undefined && Math.abs(moved.x - 0.25) < 0.01 && Math.abs(moved.y - 0.75) < 0.01,
    `a pointer a quarter across and three quarters down arrives as that fraction of the screen (${moved?.x?.toFixed(3)}, ${moved?.y?.toFixed(3)})`
  )

  const beforeClick = mirrorInputs.length
  await page.mouse.down()
  await page.mouse.up()
  await sleep(150)
  const pressed = mirrorInputs.slice(beforeClick)
  log(
    pressed.some((i) => i.a === 'down' && i.button === 'left') && pressed.some((i) => i.a === 'up' && i.button === 'left'),
    'and a click once driving is a press and a release, each carrying its own position'
  )

  await page.keyboard.press('Escape')
  await sleep(150)
  log(
    mirrorInputs.some((i) => i.a === 'key' && i.key === 'escape' && i.down === true) &&
      mirrorInputs.some((i) => i.a === 'key' && i.key === 'escape' && i.down === false),
    'one Escape is a real Escape on that desk — pressed and released — because dismissing a dialog is what somebody opened this to do'
  )
  log(
    (await page.getAttribute('.mirror__mode', 'data-driving')) === 'true',
    'and it does not hand the browser back, which is the whole reason leaving takes two'
  )

  // Comfortably past DOUBLE_ESC_MS, so the pair below is unambiguously a pair
  // rather than the tail of the press above.
  await sleep(700)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await waitFor(
    () => page.getAttribute('.mirror__mode', 'data-driving').then((v) => v === 'false'),
    10_000,
    'driving mode to end'
  )
  log(true, 'Escape twice inside half a second gives the browser back')
  const afterLeaving = mirrorInputs.length
  await page.mouse.move(...at(0.4, 0.4))
  await sleep(200)
  log(mirrorInputs.length === afterLeaving, 'and nothing is sent afterwards, because the listeners are gone rather than gated')

  /* --------------------------------------------- closing takes the screen back */

  await page.evaluate(() => {
    window.clearInterval(window.__forgeDrawing)
    window.ForgeWebMirror.stopWebMirror()
  })
  await page.click('button[aria-label="Stop watching this screen"]')
  await waitFor(() => Promise.resolve(!mirroring), 10_000, 'the desktop to stop capturing')
  log(mirroring === false, "closing the viewer tells the desktop to stop, rather than leaving it encoding for a tab nobody is looking at")
  log((await page.locator('.mirror').count()) === 0, 'and the workspace is back')

  mirrorPin = ''

  /* ==================== PHASE 6 — held at the PIN box, past the heartbeat
   *
   * The one screen where this client waits on a person: a box, and however long
   * it takes somebody to remember the PIN their desktop is set to. Nothing
   * behind the page may disturb that wait.
   *
   * This phase used to assert something else, and the change is worth writing
   * down rather than quietly making. A browser used to sit *unauthenticated on
   * an open socket* for the whole of an approval window, and a client that
   * started its own ping at `onopen` hung up on that socket one HEARTBEAT_MS in
   * — a sixth of the way through — so approval could essentially never be
   * completed by a human. There is no such socket now: `pin-required` is a
   * `refused` frame, and `refuse` in electron/web/server.ts says it once and
   * then drops the connection, so this page draws its box with nothing open at
   * all and `submitPin` dials afresh.
   *
   * What survives is the property underneath both: a page waiting on a human
   * holds still. The window is the shipped HEARTBEAT_MS plus HEARTBEAT_GRACE_MS
   * — the span in which a socket nobody was minding would have been swept away —
   * and it is sat through for real rather than compressed, because there is no
   * longer a timer to bend: the client's own beat starts at `hello-ok`, and this
   * page has never reached one. What would fail here is a client that retried
   * `pin-required` on its back-off — `retryPolicy`'s judgement in lib/client.ts
   * — which is invisible on screen until the third or fourth knock, and so is
   * counted at the desktop instead.
   */

  const heldPort = await startPhase(pinHost)
  setConfig({ devHost: `127.0.0.1:${heldPort}` })
  pinChecks = 0
  await signInFresh()
  await waitFor(async () => (await gateReason()) === 'pin', 30_000, 'the PIN box')
  log(pinChecks === 1, 'a browser at the PIN box has knocked exactly once, and is now waiting on a person')

  const heldMs = HEARTBEAT_MS + HEARTBEAT_GRACE_MS
  await sleep(heldMs + 500)
  log(
    (await gateReason()) === 'pin',
    `and it is still there ${Math.round(heldMs / 1000)}s later — a whole heartbeat and its grace — rather than having drifted off into a reconnect`
  )
  log(
    pinChecks === 1,
    'having knocked no further times in all of that, so nothing behind the screen is retrying a question only a person can answer'
  )
  log(
    (await page.locator('.gate__card[data-reason="pin"] button[type="submit"]').isDisabled()) === true,
    'with the box still empty and its button still shut, which is where somebody who went to look up their PIN left it'
  )

  await page.fill('[data-testid="pin-input"]', PIN)
  await page.click('.gate__card[data-reason="pin"] button[type="submit"]')
  await waitFor(() => page.locator('.app').count().then((n) => n > 0), 30_000, 'the workspace after the wait')
  log(pinChecks === 2, 'and the PIN typed after all of that still gets the browser in, on the second dial and no more')

  /* ============== PHASE 7 — the link that died without saying so
   *
   * See the note at the top of this file. Everything else here drops a link by
   * closing it; this drops one by swallowing it, which is what going away and
   * coming back actually does to a socket, and it is the case the client used
   * to be worst at by an enormous margin — `readyState` says `OPEN` and goes on
   * saying it until the operating system abandons the TCP connection, which is
   * minutes, and every re-dial guard in the file correctly stands down on a
   * link that is in hand.
   *
   * Two halves, because there are two ways to find out and they are worth
   * different amounts. The beat is the backstop: somebody sitting looking at
   * the tab when the link dies. The wake-up is the fast path, and it is the one
   * this phase exists for — the return to a tab that has been left alone, where
   * the whole cost of being wrong is paid by a person waiting.
   */

  /**
   * The client's own probe window, restated here rather than imported.
   *
   * `lib/client.ts` is browser code and this is a Node harness, so the constant
   * cannot be shared the way `HEARTBEAT_MS` is — and it is used below only to
   * *avoid* racing a guard, never as the thing being asserted. What is asserted
   * is the wall-clock gap between the two halves, which is measured.
   */
  const PROBE_MS = 3_000

  const wedgePort = await startPhase()
  const relay = await startRelay(wedgePort)
  setConfig({ devHost: `127.0.0.1:${relay.port}` })
  await signInFresh()
  await waitFor(
    () => page.locator('.linkbadge[data-state="live"]').count().then((n) => n === 1),
    30_000,
    'a live link through the relay'
  )
  log((await page.locator('.app').count()) === 1, 'a link relayed through a plain TCP hop is a link like any other')

  /* ---- half one: nobody touches anything, and the beat finds it anyway */

  const swallowed = relay.swallow()
  log(swallowed === 1, `the relay swallowed the live link whole (${swallowed} socket), closing nothing`)
  log(
    (await page.locator('.linkbadge[data-state="live"]').count()) === 1,
    'and the page cannot tell — its socket still reads open, which is exactly the lie this is about'
  )

  const beatDials = relay.dials()
  const beatStarted = Date.now()
  await waitFor(
    () => Promise.resolve(relay.dials() > beatDials),
    HEARTBEAT_MS + HEARTBEAT_GRACE_MS + 30_000,
    'the beat to notice a link that stopped answering'
  )
  const beatNoticedMs = Date.now() - beatStarted
  log(
    beatNoticedMs < HEARTBEAT_MS + HEARTBEAT_GRACE_MS,
    `the beat noticed on its own in ${(beatNoticedMs / 1000).toFixed(1)}s and dialled again — a ping that went unanswered, rather than a close frame that never came`
  )
  await waitFor(
    () => page.locator('.linkbadge[data-state="live"]').count().then((n) => n === 1),
    40_000,
    'the link to come back after the beat noticed'
  )
  log(
    (await page.locator('[data-testid="reconnecting-banner"]').count()) === 0,
    'and what it dialled into is a working desktop, badged live again with no reload anywhere'
  )

  /* ---- half two: the same death, found by a person coming back to the tab */

  const swallowedAgain = relay.swallow()
  log(swallowedAgain === 1, 'the relay swallowed the replacement link too, the same way')

  // Long enough that the last frame is not still warm, which is a property of
  // the client this phase has to respect rather than defeat: a wake-up arriving
  // within PROBE_MS of live traffic asks nothing, because there is nothing to
  // ask — bytes have just been through. That guard is why `focus`, which fires
  // on every click back into a window, does not cost a round trip; the case it
  // stands down for is not the case anybody is complaining about. The tab this
  // is really about was left alone for minutes, so this waits a few seconds to
  // be that tab instead of pretending the guard is not there.
  await sleep(PROBE_MS + 1_000)

  // The wake-up path, entered through the listener the real event reaches. A
  // headless page is `visible` throughout and cannot be alt-tabbed away from,
  // so the event is dispatched rather than caused — but everything downstream
  // of `addEventListener('focus')` is the shipped client deciding for itself,
  // including whether there is anything wrong at all.
  const wakeDials = relay.dials()
  const wakeStarted = Date.now()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitFor(
    () => Promise.resolve(relay.dials() > wakeDials),
    30_000,
    'the wake-up to notice the swallowed link'
  )
  const wakeNoticedMs = Date.now() - wakeStarted
  log(
    wakeNoticedMs < 10_000,
    `coming back to the tab found it in ${(wakeNoticedMs / 1000).toFixed(1)}s — the link was made to prove itself rather than believed`
  )
  log(
    wakeNoticedMs < beatNoticedMs,
    `which is quicker than waiting for the beat (${(wakeNoticedMs / 1000).toFixed(1)}s against ${(beatNoticedMs / 1000).toFixed(1)}s), and that gap is the whole point of the wake-up`
  )
  await waitFor(
    () => page.locator('.linkbadge[data-state="live"]').count().then((n) => n === 1),
    40_000,
    'the link to come back after the wake-up noticed'
  )
  log(
    (await page.locator('.app').count()) === 1 && (await page.locator('input[type="email"]').count()) === 0,
    'and what came back is the workspace that was already on screen, not a fresh sign-in'
  )

  await relay.close()

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

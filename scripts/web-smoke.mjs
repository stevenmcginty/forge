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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
    LayoutEngine,
    UNSUPPORTED,
    GridOwners,
    DESK_VIEWER,
    hashPin,
    saveInboxImage,
    imagePasteIntoPane,
    GROK_IMAGE_PASTE,
    INBOX_KEEP,
    planTouchScroll,
    planPointerDelta,
    wheelDeltaPx,
    wheelReportCell,
    TUI_PAGE_ROWS,
    isAllowedSource,
    webSocketUrl,
    HEARTBEAT_GRACE_MS,
    HEARTBEAT_MS,
    MAX_FRAME_BYTES,
    MAX_IMAGE_BASE64,
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
    AUTH_MAX_FAILURES,
    AUTH_LOCKOUT_MS,
    FOREMAN_SEED_MAX,
    readHandoffTarget
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
  /**
   * The real layout engine, switched on for phase 10c and off everywhere else.
   *
   * Off, the hook is the recorder the phases above need: they are about the
   * *wire* — that a request reaches the host verbatim and that its refusal
   * comes back on the right rid — and a host that really performed them would
   * be answering questions those phases are not asking.
   *
   * On, it is the shipped `LayoutEngine` with the six lines of
   * `dispatchLayout` (electron/web-host.ts) around it: apply, kill what it
   * names, fall back to the renderer only for the verb it answers UNSUPPORTED.
   * There is no Electron in this process and therefore no renderer at all,
   * which is precisely the desktop this whole change exists for.
   */
  let engine = null
  const watches = []
  const writes = []
  const clipboardOffers = []
  let pasteCommand = ''
  /*
   * Foreman's hooks, as a recording host: every start and stop the server
   * hands over, and the states a snapshot will carry. The phase below drives
   * the boundary rules (live pane, seed cap) against these rather than a real
   * brain — scripts/foreman-check.mjs owns the loop itself.
   */
  const foremanStarts = []
  const foremanStops = []
  const foremanStates = []
  /*
   * Handoff's hooks, as a recording host: every start the server hands over,
   * and the per-project lists a snapshot will carry. The flow itself is the
   * *renderer's* — there is none in this process, which is the point of the
   * hook — so what is provable here is exactly what this server owns: the
   * boundary rules, and that a parsed target reaches the host verbatim.
   */
  const handoffStarts = []
  const handoffSnapshot = []
  let handoffAnswer = null
  const inboxDir = join(scratch, 'inbox')
  mkdirSync(inboxDir, { recursive: true })
  /**
   * The *real* ownership registry, wired to the real PTY.
   *
   * The width follows the typist (electron/pty/grid-owner.ts), so "does this
   * frame move the pane?" is a question with state behind it rather than a
   * boolean a phase can flip. Driving the shipped registry rather than a
   * stand-in is the whole point: a stand-in written to agree with the policy is
   * a check that keeps passing after the policy moves.
   *
   * No jiggle here, unlike electron/pty-host.ts: the repaint jiggle belongs to
   * the host, and a check that had to wait one out would be asserting a timer
   * rather than a rule. The phases below therefore read one resize as one size.
   */
  const owners = new GridOwners({ apply: (id, cols, rows) => manager.resize(id, cols, rows) })
  let releaseSkills = null
  let releaseCommands = null

  /**
   * A WebAuth wired to the same fixed project and uid every phase uses.
   *
   * There is nothing to seed it with: this door admits any browser holding a
   * verified token for `UID` and, where a phase sets one, the unlock PIN. It
   * keeps no list of the browsers it has admitted, so a phase says who may get
   * in by choosing which token to mint rather than by handing over rows.
   */
  const makeAuth = (extra = {}) =>
    new WebAuth({
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

  const makeServer = (auth, extra = {}) =>
    new WebServer({
      auth,
      appVersion: '0.0.0-smoke',
      desktopName: () => 'SMOKE-PC',
      allowedOrigins: () => allowedOrigins,
      onOriginRefused: (origin, allowed) => refusedOrigins.push({ origin, allowed }),
      sessions: () =>
        manager.list().map((s) =>
          pasteCommand && s.id === 'w1' ? { ...s, bootstrapCommand: pasteCommand } : s
        ),
      replay: (id) => replay.get(id) ?? '',
      write: (id, data, viewer) => {
        writes.push({ id, data, viewer })
        owners.noteWrite(id, viewer, data)
        return manager.write(id, data)
      },
      saveInboxImage: async (bytes, ext) => saveInboxImage(inboxDir, bytes, ext),
      offerClipboardImage: (bytes) => {
        clipboardOffers.push(Buffer.from(bytes))
        return true
      },
      resize: (id, cols, rows, viewer) => owners.noteWish(id, viewer, cols, rows),
      release: (viewer, id) => owners.release(viewer, id),
      snapshot: () => ({
        projects: PROJECTS,
        profiles: PROFILES,
        workspaces: WORKSPACES,
        foreman: [...foremanStates],
        handoff: handoffSnapshot.map((entry) => ({ ...entry }))
      }),
      layout: async (op, deviceName) => {
        ops.push({ op, deviceName })
        if (!engine) return layoutAnswer
        const result = engine.apply(op.projectId, op)
        if (result.ok) {
          for (const id of result.killed) manager.kill(id)
          return null
        }
        return result.error === UNSUPPORTED ? layoutAnswer : result.error
      },
      foremanStart: async (request) => {
        foremanStarts.push(request)
        return { ok: true }
      },
      foremanStop: async (paneId) => {
        foremanStops.push(paneId)
        return { ok: true }
      },
      handoffStart: async (request, deviceName) => {
        handoffStarts.push({ ...request, deviceName })
        return handoffAnswer
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
  log(
    MAX_IMAGE_BASE64 + 512 < MAX_FRAME_BYTES,
    `a paste-image payload (${MAX_IMAGE_BASE64}) fits inside MAX_FRAME_BYTES (${MAX_FRAME_BYTES}) with envelope room`
  )

  const grokPaste = imagePasteIntoPane('grok --yolo', 'C:\\tmp\\paste.png')
  log(
    grokPaste.wantClipboard && grokPaste.data === GROK_IMAGE_PASTE,
    'Grok is handed Alt+V so it can mint an image chip, not a quoted path it would treat as text'
  )
  const claudePaste = imagePasteIntoPane('claude', 'C:\\tmp\\paste.png')
  log(
    !claudePaste.wantClipboard && claudePaste.data === '"C:\\tmp\\paste.png" ',
    'Claude Code is still typed the quoted path a desktop drop would type'
  )
  const agyPaste = imagePasteIntoPane('agy', 'C:\\tmp\\paste.png')
  log(
    !agyPaste.wantClipboard && agyPaste.data.startsWith('"'),
    'an agent that is not Grok still gets the quoted path'
  )

  const wheelUp = planTouchScroll(-3, true, true, 120)
  log(
    wheelUp.kind === 'data' && wheelUp.data === '\x1b[<64;60;1M'.repeat(3),
    'a finger drag on a mouse-tracking TUI (Grok, Antigravity) is three SGR wheel-up reports'
  )
  const pageUp = planTouchScroll(-8, true, false, 120)
  log(
    pageUp.kind === 'data' && pageUp.data === '\x1b[5~',
    'the same drag on an alt-screen with no mouse is PageUp — arrows would only move Grok\'s caret'
  )
  const notYet = planTouchScroll(-3, true, false, 120)
  log(
    notYet.kind === 'viewport' && notYet.lines === 0,
    'fewer than a page of travel on that alt-screen is held, not fired — one row used to be one PageUp'
  )
  const scrollback = planTouchScroll(-4, false, false, 120)
  log(
    scrollback.kind === 'viewport' && scrollback.lines === -4,
    'Claude Code\'s normal buffer is still xterm scrollback, which is why its swipe already worked'
  )

  log(wheelDeltaPx(-3, 1, 16) === -48, 'a three-line mouse notch is three rows of pixels')
  log(wheelDeltaPx(-16, 0, 16) === -16, 'a trackpad pixel delta is left as pixels')
  log(TUI_PAGE_ROWS === 8, 'one PageUp is eight rows of travel')
  const carry = { px: 0 }
  const pending = planPointerDelta(carry, -16, 16, true, false, 120)
  log(
    pending.kind === 'viewport' && pending.lines === 0 && carry.px === -16,
    'one row of wheel on Grok is held in the remainder'
  )
  const paged = planPointerDelta(carry, -16 * 7, 16, true, false, 120)
  log(
    paged.kind === 'data' && paged.data === '\x1b[5~' && carry.px === 0,
    'eight rows of wheel on Grok is one PageUp, remainder spent'
  )
  const sgrCarry = { px: 0 }
  const sgr = planPointerDelta(sgrCarry, -48, 16, true, true, 120)
  log(
    sgr.kind === 'data' && sgr.data === '\x1b[<64;60;1M'.repeat(3),
    'the same pixels on a mouse-tracking TUI are three SGR reports mid-width on the top row'
  )

  // The cell those reports claim to be over. opencode 1.18.21, measured in a
  // PTY, drops a wheel report on columns 1-2 and on the last column without a
  // byte of response, and its composer owns the bottom of a short grid — so a
  // report has to be mid-width and at the top to land in the message list.
  log(
    wheelReportCell(120).col === 60 && wheelReportCell(120).row === 1,
    'a wheel report is aimed mid-width at the top row, not at the 1;1 that opencode ignores'
  )
  log(
    [24, 45, 60, 80, 120, 200].every((cols) => {
      const cell = wheelReportCell(cols)
      return cell.col > 2 && cell.col < cols && cell.row === 1
    }),
    'at every grid width a phone or a desktop can produce, that column clears both gutters'
  )
  const phoneSgr = planPointerDelta({ px: 0 }, -16, 16, true, true, 45)
  log(
    phoneSgr.kind === 'data' && phoneSgr.data === '\x1b[<64;22;1M',
    'a phone-width pane aims its finger-drag report at its own middle, not at column 60'
  )

  const viewCarry = { px: 0 }
  const view = planPointerDelta(viewCarry, 64, 16, false, false, 120)
  log(
    view.kind === 'viewport' && view.lines === 4,
    'Claude Code still gets viewport lines, which is why its wheel already worked'
  )

  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const pixelBytes = Buffer.from(PIXEL, 'base64')
  const inboxProbe = join(scratch, 'inbox-probe')
  const firstShot = saveInboxImage(inboxProbe, pixelBytes, '.png', new Date(2026, 7, 20, 15, 30, 12))
  log(
    firstShot.ok && existsSync(firstShot.path) && firstShot.path.endsWith(`paste-20260820-153012.png`),
    'a pasted png lands as a stamped file in the inbox'
  )
  log(
    firstShot.ok && readFileSync(firstShot.path).equals(pixelBytes),
    'and the bytes on disk are the bytes that were handed over'
  )
  log(!saveInboxImage(inboxProbe, new Uint8Array(), '.png').ok, 'an empty image is refused rather than written')
  log(!saveInboxImage(inboxProbe, pixelBytes, '.exe').ok, 'a non-image suffix is refused rather than written')
  for (let i = 0; i < INBOX_KEEP + 2; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i))
    saveInboxImage(inboxProbe, pixelBytes, '.png', at)
  }
  const kept = readdirSync(inboxProbe).filter((n) => n.startsWith('paste-'))
  log(kept.length === INBOX_KEEP, `the inbox prunes back to INBOX_KEEP (${INBOX_KEEP}), so a working day of pastes is not a photo library`)

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

  const authA = makeAuth()
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
  // no prompt any more — nor "you are not on the desktop's list", because there
  // is no list either. What it is asserted on is what it means now: a browser
  // that sent no device id, which is a page whose storage is unavailable.
  const nameless = await refusedBy({ idToken: mint(), deviceId: '' }, 'a browser with no device id')
  log(
    nameless.first('refused')?.reason === 'not-approved',
    'a browser that did not identify itself is not-approved, whatever its token says'
  )

  // Five refusals spent, and *nothing is shut behind them*. This assertion used
  // to say the opposite — that the address was now locked out — and it is worth
  // saying why it was inverted rather than deleted, because the old sentence
  // reads like the safer one.
  //
  // Behind a tunnel every caller on earth arrives from this machine's own
  // loopback, so an address-keyed bucket is one bucket shared by the owner and
  // every stranger who can reach the hostname: five garbage tokens from anyone
  // at all locked the owner out of their own desktop for a renewable minute.
  // A JWT keyspace is not guessable, so striking bad tokens bought no security
  // and handed over a denial-of-service. The address bucket is gone (see "Which
  // failures count against which bucket" in electron/web/auth.ts); the lockout
  // now lives only on the account, where the identity is proven and the secret
  // is short enough to be worth guessing. That is asserted below in phase C.
  //
  // So what this phase proves now is the *absence*: an unguessable credential
  // presented badly, five times, costs a good credential nothing.
  const stillWelcome = await connect()
  stillWelcome.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-1',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => stillWelcome.first('hello-ok'), 8000, 'the good credential after five bad ones')
  log(
    Boolean(stillWelcome.first('hello-ok')) && !stillWelcome.first('refused'),
    `${AUTH_MAX_FAILURES} bad tokens lock nobody out — a stranger cannot spend the owner's strikes`
  )
  stillWelcome.socket.close()

  await serverA.stop()

  /* --------------------------- the refusal that never reaches a credential */

  // On a fresh auth, so the lockout above cannot be what refuses it: a
  // protocol mismatch is decided before the token is looked at, and asserting
  // it against a locked-out source would prove nothing about which check fired.
  const serverR = makeServer(makeAuth())
  active = serverR
  await serverR.start({ host: '127.0.0.1', port: PORT })

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

  const auth = makeAuth()
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
  log(!!ok && ok.proto === WEB_PROTO, 'a valid token for the configured uid is let in')
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
  log(watches.at(-1) === 'w1', 'a browser opening a pane says so, so the desktop can label it as read from away')
  await waitFor(() => manager.list().find((s) => s.id === 'w1')?.cols === 100, 6000, "attach's own geometry")
  log(
    true,
    "attach's optional cols/rows landed on the real PTY, because nobody had claimed this pane — an unowned pane takes the first wish"
  )

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
  log(
    geometry.cols === 132 && geometry.rows === 44,
    'a resize from the browser resized the real PTY, because this browser is the device that has been typing into it'
  )

  /* ----------------------------------------- 3b. the width follows the typist
   *
   * A PTY has one grid, and it belongs to whichever device somebody last typed
   * into the pane on. Everything below is that one rule seen from five sides,
   * driven through the *real* registry: a pane the desk is holding does not move
   * because a browser looked at it or resized its window; it moves the instant
   * that browser types; and it comes straight back when the desk types.
   *
   * The `attach` is what sequences each step — it is answered on the same socket
   * the resize was sent down, so its `replay` is proof that the frames before it
   * have been handled and not merely posted.
   */

  const paneNow = () => manager.list().find((s) => s.id === 'w1')
  /** Send a bare `attach` and wait for its `replay` — proof the frames before it landed. */
  const settled = async (label) => {
    const before = browser.of('replay').length
    browser.send({ type: 'attach', sessionId: 'w1' })
    await waitFor(() => browser.of('replay').length > before, 8000, label)
  }

  // (a) The desk takes the pane back by typing into it, exactly as the renderer
  //     does — `owners.noteWrite(id, DESK_VIEWER, …)` is the line
  //     electron/pty-host.ts runs on `IPC.ptyWrite`.
  owners.noteWish('w1', DESK_VIEWER, 96, 28)
  owners.noteWrite('w1', DESK_VIEWER, 'x')
  const reclaimed = paneNow()
  log(
    reclaimed.cols === 96 && reclaimed.rows === 28,
    `typing at the desk took the pane back and applied the desk's own stored wish at once (now ${reclaimed.cols}x${reclaimed.rows})`
  )

  // (b) Looking at it changes nothing. Both frames that carry a size, from a
  //     browser that is not the one being typed on.
  const held = paneNow()
  const replaysBefore = browser.of('replay').length
  browser.send({ type: 'resize', sessionId: 'w1', cols: 80, rows: 24 })
  browser.send({ type: 'attach', sessionId: 'w1', cols: 81, rows: 25 })
  await waitFor(() => browser.of('replay').length > replaysBefore, 8000, 'the re-attach to be answered')
  const unmoved = paneNow()
  log(
    unmoved.cols === held.cols && unmoved.rows === held.rows,
    `while the desk holds the pane, neither a resize nor an attach from the browser moved the real PTY (still ${unmoved.cols}x${unmoved.rows})`
  )
  log(browser.of('error').every((e) => e.sessionId !== 'w1'), 'and neither was refused out loud — a stored wish is not an error')

  // (c) A terminal answering a question is not a person typing. This exact frame
  //     is what a browser sends constantly while a pane is busy, and if it
  //     counted as typing then merely *watching* would reshape the desk.
  browser.send({ type: 'write', sessionId: 'w1', data: '\x1b[24;80R' })
  await settled('the cursor-report write to be handled')
  const afterReport = paneNow()
  log(
    afterReport.cols === held.cols && afterReport.rows === held.rows,
    "a browser's cursor-position reply did not take the pane — watching a busy pane is not typing into it"
  )

  // (d) And now somebody actually types in the browser. The wish stored at (b)
  //     is applied on the keystroke, without the client re-sending anything.
  //     Ctrl+C rather than a character, so the line the reply at (c) left in the
  //     prompt is abandoned rather than run by the phases below.
  browser.send({ type: 'write', sessionId: 'w1', data: '\x03' })
  await waitFor(() => paneNow().cols === 81 && paneNow().rows === 25, 6000, 'the pane changing hands')
  log(
    true,
    "one keystroke in the browser took the pane and applied the size it had already asked for (81x25) — the client re-sent nothing"
  )

  // (e) A *second* browser — because two browsers must be two viewers — takes
  //     the pane by typing, then hangs up. What it held goes back to unclaimed,
  //     and the next wish, from anybody, wins outright.
  const second = await connect()
  second.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-2',
    deviceName: 'Chrome on the other machine'
  })
  await waitFor(() => second.first('hello-ok'), 8000, "the second browser's hello-ok")
  second.send({ type: 'attach', sessionId: 'w1', cols: 150, rows: 50 })
  await waitFor(() => second.first('replay'), 8000, "the second browser's replay")
  log(
    paneNow().cols === 81,
    'a second browser attaching did not take the pane from the first — two sockets are two viewers, and only typing moves a grid'
  )
  second.send({ type: 'write', sessionId: 'w1', data: 'a' })
  await waitFor(() => paneNow().cols === 150 && paneNow().rows === 50, 6000, 'the second browser taking the pane')
  log(true, 'and typing in the second browser took it, at the size that browser had asked for (150x50)')

  second.socket.close()
  await waitFor(() => owners.ownerOf('w1') === null, 6000, 'the pane being released')
  log(true, 'a browser that hangs up stops holding the pane it was holding — ownership goes back to unclaimed')
  owners.noteWish('w1', DESK_VIEWER, 120, 40)
  const afterRelease = paneNow()
  log(
    afterRelease.cols === 120 && afterRelease.rows === 40,
    `and the next wish wins outright, with no typing needed (now ${afterRelease.cols}x${afterRelease.rows})`
  )

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

  /* ------------------ 10c. the same op, performed in main, with no renderer
   *
   * The failure this phase is about happened to Steve on a train. Every layout
   * op used to be forwarded into the desktop renderer and awaited, so a window
   * that had crashed, hung or gone blank turned every tap on the phone into
   * "The desktop did not answer in time" — with nobody in the building.
   *
   * electron/layout-engine.ts is the fix, and this is the shipped class: there
   * is no Electron in this process, so there is no renderer here to fall back
   * to and `layoutAnswer` below is the exact sentence a windowless desktop used
   * to answer with. A `close-pane` that comes back `ok` therefore means the
   * work was done somewhere a dead window cannot reach — and the pane it named
   * is a *real* pwsh, which has to be gone afterwards, because a layout that
   * says a terminal is closed while the process is still running is the one
   * outcome worse than the refusal.
   */

  const spare = manager.create({ id: 'w-spare', cwd: ROOT, cols: 80, rows: 24 })
  log(spare.ok === true, 'spawned a second real pwsh for the engine to close')
  const leaf = (id) => ({ type: 'leaf', id, profileId: 'shell', title: '' })
  const saved = []
  engine = new LayoutEngine({
    load: () => ({
      tabs: [
        {
          id: 'tab-1',
          title: 'One',
          activePaneId: 'w-spare',
          root: { type: 'split', id: 'sp-1', direction: 'row', ratio: 0.5, a: leaf('w-spare'), b: leaf('w-keep') }
        }
      ],
      activeTabId: 'tab-1'
    }),
    save: (projectId, workspace) => saved.push({ projectId, workspace }),
    projects: () => PROJECTS
  })

  layoutAnswer = 'Forge has no window open on the desktop, so it cannot change tabs.'
  browser.send({
    type: 'request',
    rid: 'r-engine-close',
    body: { kind: 'layout', op: { op: 'close-pane', projectId: 'p1', paneId: 'w-spare' } }
  })
  await waitFor(() => browser.result('r-engine-close'), 5000, 'the engine-backed close-pane result')
  log(
    browser.result('r-engine-close').body.kind === 'ok',
    'a close-pane from a browser answers ok with no renderer anywhere — the sentence about no window open is gone'
  )
  log(saved.length === 1 && saved[0].projectId === 'p1', 'and the new layout was written from main, once', `${saved.length} write(s)`)
  log(
    saved.length === 1 && !JSON.stringify(saved[0].workspace).includes('w-spare'),
    'with the closed pane out of the tree'
  )
  await waitFor(() => !manager.list().some((s) => s.id === 'w-spare'), 5000, "the closed pane's shell to go")
  log(true, "and the pane's real PTY was killed, not merely forgotten")
  log(manager.list().some((s) => s.id === 'w1'), 'while the pane nobody closed is still running')

  // The one verb the engine does not answer. `select-project` is about which
  // project a *window* is looking at, so it still goes to the renderer — and
  // still fails without one, which is the same limit it has always had.
  browser.send({
    type: 'request',
    rid: 'r-engine-project',
    body: { kind: 'layout', op: { op: 'select-project', projectId: 'p1' } }
  })
  await waitFor(() => browser.result('r-engine-project'), 5000, 'the select-project result')
  log(
    browser.result('r-engine-project').body.kind === 'failed' &&
      browser.result('r-engine-project').body.message === layoutAnswer,
    'while select-project still falls back to the renderer, and still says so when there is none'
  )
  log(saved.length === 1, 'a refusal wrote nothing', `${saved.length} write(s)`)

  engine = null
  layoutAnswer = null

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

  /* ------------------------------------------ a pasted image becomes a path */

  browser.send({
    type: 'request',
    rid: 'r-img',
    body: { kind: 'paste-image', sessionId: 'w1', mime: 'image/png', data: PIXEL }
  })
  await waitFor(() => browser.result('r-img'), 5000, 'the paste-image result')
  log(browser.result('r-img').body.kind === 'ok', 'a pasted png is saved and answered ok')
  const pasted = writes.at(-1)
  log(
    pasted?.id === 'w1' &&
      typeof pasted?.data === 'string' &&
      pasted.data.startsWith('"') &&
      pasted.data.includes('paste-') &&
      pasted.data.endsWith('.png" '),
    'and the quoted path is typed into the pane, with a trailing space, the way a dropped screenshot is'
  )
  const typedPath = typeof pasted?.data === 'string' ? pasted.data.slice(1, -2) : ''
  log(
    typedPath.startsWith(inboxDir) && existsSync(typedPath) && readFileSync(typedPath).equals(pixelBytes),
    'the file on disk is the bytes that were sent, in this desktop\'s inbox'
  )

  pasteCommand = 'grok'
  clipboardOffers.length = 0
  browser.send({
    type: 'request',
    rid: 'r-img-grok',
    body: { kind: 'paste-image', sessionId: 'w1', mime: 'image/png', data: PIXEL }
  })
  await waitFor(() => browser.result('r-img-grok'), 5000, 'the grok paste-image result')
  log(browser.result('r-img-grok').body.kind === 'ok', 'a Grok pane accepts the same png')
  const grokTyped = writes.at(-1)
  log(
    grokTyped?.data === GROK_IMAGE_PASTE,
    'and is typed Alt+V rather than the quoted path Claude Code wants'
  )
  log(
    clipboardOffers.length === 1 && clipboardOffers[0].equals(pixelBytes),
    'after the bitmap has been put on this machine\'s clipboard, which is what Alt+V reads'
  )
  pasteCommand = ''

  browser.send({
    type: 'request',
    rid: 'r-img-gone',
    body: { kind: 'paste-image', sessionId: 'never-existed', mime: 'image/png', data: PIXEL }
  })
  await waitFor(() => browser.result('r-img-gone'), 5000, 'the unknown-session paste-image')
  log(
    browser.result('r-img-gone').body.code === 'unknown-session',
    'a paste aimed at a pane that is gone is unknown-session rather than a file with nowhere to go'
  )

  browser.send({
    type: 'request',
    rid: 'r-img-mime',
    body: { kind: 'paste-image', sessionId: 'w1', mime: 'application/pdf', data: PIXEL }
  })
  await waitFor(() => browser.result('r-img-mime'), 5000, 'the bad-mime paste-image')
  log(browser.result('r-img-mime').body.code === 'bad-frame', 'a non-image mime is bad-frame, not written')

  browser.send({
    type: 'request',
    rid: 'r-img-big',
    body: { kind: 'paste-image', sessionId: 'w1', mime: 'image/jpeg', data: 'A'.repeat(MAX_IMAGE_BASE64 + 1) }
  })
  await waitFor(() => browser.result('r-img-big'), 5000, 'the oversize paste-image')
  log(
    browser.result('r-img-big').body.code === 'limit',
    `a payload over MAX_IMAGE_BASE64 (${MAX_IMAGE_BASE64}) is limit, and the socket stays up`
  )
  log(browser.closed === null, 'and the oversize image did not hang up the socket')

  /* ------------------------------------------ 6c. foreman, from a browser
   *
   * The switch in a pane header, seen from this side of the socket: the
   * state pushes reach a connected browser, a connecting one gets them in
   * the snapshot, and the two verbs are held to the boundary rules — a live
   * pane (the same authorisation `close-pane` gets) and a capped seed. The
   * loop behind the switch is scripts/foreman-check.mjs's to prove; the host
   * here records what the server hands over, which is the part this server
   * owns.
   */

  const driven = {
    paneId: 'w1',
    status: 'waiting',
    line: 'Waiting for the pane',
    seed: 'a website for a sweet shop',
    log: []
  }
  server.pushForeman(driven)
  await waitFor(() => browser.first('foreman'), 5000, 'the foreman frame')
  log(
    browser.first('foreman').state.paneId === 'w1' && browser.first('foreman').state.status === 'waiting',
    'a Foreman state pushed on the desktop reaches a connected browser as a foreman frame'
  )

  // The snapshot half: a browser connecting *after* the push learns the same
  // thing from hello-ok, without waiting for the next state change.
  foremanStates.push(driven)
  const foremanTab = await connect()
  foremanTab.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-foreman',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => foremanTab.first('hello-ok'), 8000, "the foreman browser's hello-ok")
  log(
    Array.isArray(foremanTab.first('hello-ok').foreman) &&
      foremanTab.first('hello-ok').foreman.some((s) => s.paneId === 'w1'),
    'and hello-ok carries the current Foreman states, so a reconnecting browser learns the switch is on from the snapshot'
  )

  // The seed cap. Capped rather than refused, exactly as `write` is capped:
  // the seed is a line a person typed, and the honest answer to a very long
  // one is its first FOREMAN_SEED_MAX characters.
  browser.send({
    type: 'request',
    rid: 'r-fm-long',
    body: { kind: 'foreman-start', paneId: 'w1', seed: 'x'.repeat(FOREMAN_SEED_MAX + 500) }
  })
  await waitFor(() => browser.result('r-fm-long'), 5000, 'the over-long foreman-start')
  log(
    browser.result('r-fm-long').body.kind === 'ok' &&
      foremanStarts[0]?.seed === 'x'.repeat(FOREMAN_SEED_MAX),
    `a seed over FOREMAN_SEED_MAX (${FOREMAN_SEED_MAX}) is capped to it and starts, not refused`
  )

  // The pane-liveness rule, both verbs. Same authorisation as `close-pane`:
  // an authenticated browser naming a pane that is live right now.
  browser.send({
    type: 'request',
    rid: 'r-fm-gone-start',
    body: { kind: 'foreman-start', paneId: 'never-existed', seed: 'a job' }
  })
  await waitFor(() => browser.result('r-fm-gone-start'), 5000, 'the unknown-session foreman-start')
  log(
    browser.result('r-fm-gone-start').body.code === 'unknown-session' && foremanStarts.length === 1,
    'foreman-start for a pane the client cannot see is refused as unknown-session, and the host was never asked'
  )
  browser.send({
    type: 'request',
    rid: 'r-fm-gone-stop',
    body: { kind: 'foreman-stop', paneId: 'never-existed' }
  })
  await waitFor(() => browser.result('r-fm-gone-stop'), 5000, 'the unknown-session foreman-stop')
  log(
    browser.result('r-fm-gone-stop').body.code === 'unknown-session' && foremanStops.length === 0,
    'and so is foreman-stop, for the same reason and with the same courtesy'
  )

  // A stop for a live pane goes through and answers ok.
  browser.send({ type: 'request', rid: 'r-fm-stop', body: { kind: 'foreman-stop', paneId: 'w1' } })
  await waitFor(() => browser.result('r-fm-stop'), 5000, 'the healthy foreman-stop')
  log(
    browser.result('r-fm-stop').body.kind === 'ok' && foremanStops[0] === 'w1',
    'while foreman-stop for a live pane reaches the host and answers ok'
  )

  /* ----------------------------------------- 6d. handoff, from a browser
   *
   * The Handoff menu in a pane header, seen from this side of the socket. The
   * division of labour is the thing to keep: main *forwards* a handoff and
   * never performs one, because the flow spans two panes, a file on disk and a
   * paste, and lives in one piece in the desktop's renderer. So what is
   * asserted here is the wire — the packs reach a browser, a connecting one
   * gets them in the snapshot — and the boundary: a live pane, and a target out
   * of the closed list in shared/handoffview.ts.
   */

  const PACK = {
    id: '20260902-141233-9f0a',
    title: 'The sync endpoint',
    status: 'ready',
    from: 'w1',
    fromAgent: 'Claude',
    fromTitle: 'main',
    to: '',
    toAgent: 'Codex',
    toTitle: '',
    origin: '',
    createdAt: 1,
    updatedAt: 2,
    transcript: '',
    bytes: 120,
    filled: true
  }

  log(
    readHandoffTarget({ kind: 'pane', paneId: 'w1' })?.paneId === 'w1' &&
      readHandoffTarget({ kind: 'new', profileId: 'shell' })?.profileId === 'shell' &&
      readHandoffTarget({ kind: 'back' })?.kind === 'back',
    'the three handoff target kinds are read off the wire, and nothing else is'
  )
  log(
    readHandoffTarget({ kind: 'nowhere' }) === null &&
      readHandoffTarget({ kind: 'pane' }) === null &&
      readHandoffTarget('back') === null,
    'a kind this desktop does not know, and a pane target naming no pane, are refused rather than guessed at'
  )

  server.pushHandoff('p1', [PACK])
  await waitFor(() => browser.first('handoff'), 5000, 'the handoff frame')
  log(
    browser.first('handoff').projectId === 'p1' && browser.first('handoff').records[0]?.id === PACK.id,
    'a handoff list pushed on the desktop reaches a connected browser as a handoff frame'
  )

  // The snapshot half, and it covers every project rather than the one the desk
  // is watching — a browser may be reading any of them.
  handoffSnapshot.push({ projectId: 'p1', records: [PACK] })
  const handoffTab = await connect()
  handoffTab.send({
    type: 'hello',
    proto: WEB_PROTO,
    idToken: mint(),
    client: '0.0.0-smoke',
    deviceId: 'browser-handoff',
    deviceName: 'Chrome on Windows'
  })
  await waitFor(() => handoffTab.first('hello-ok'), 8000, "the handoff browser's hello-ok")
  log(
    handoffTab.first('hello-ok').handoff?.[0]?.projectId === 'p1' &&
      handoffTab.first('hello-ok').handoff[0].records[0]?.id === PACK.id,
    'and hello-ok carries the packs project by project, so a reconnecting browser draws the chips from the snapshot'
  )

  // The pane-liveness rule, the same authorisation `foreman-start` gets.
  browser.send({
    type: 'request',
    rid: 'r-ho-gone',
    body: { kind: 'handoff-start', paneId: 'never-existed', target: { kind: 'back' } }
  })
  await waitFor(() => browser.result('r-ho-gone'), 5000, 'the unknown-session handoff-start')
  log(
    browser.result('r-ho-gone').body.code === 'unknown-session' && handoffStarts.length === 0,
    'handoff-start for a pane the client cannot see is refused as unknown-session, and the host was never asked'
  )

  // A target is a choice out of a closed list. Refused, never coerced: guessing
  // which of the three was meant is worse than saying it was not understood.
  browser.send({
    type: 'request',
    rid: 'r-ho-bad',
    body: { kind: 'handoff-start', paneId: 'w1', target: { kind: 'somewhere-else' } }
  })
  await waitFor(() => browser.result('r-ho-bad'), 5000, 'the bad-frame handoff-start')
  log(
    browser.result('r-ho-bad').body.code === 'bad-frame' && handoffStarts.length === 0,
    'a target kind this desktop does not know is bad-frame, and the host was never asked'
  )

  browser.send({
    type: 'request',
    rid: 'r-ho-ok',
    body: { kind: 'handoff-start', paneId: 'w1', target: { kind: 'new', profileId: 'shell' } }
  })
  await waitFor(() => browser.result('r-ho-ok'), 5000, 'the healthy handoff-start')
  log(
    browser.result('r-ho-ok').body.kind === 'ok' &&
      handoffStarts[0]?.paneId === 'w1' &&
      handoffStarts[0]?.target.kind === 'new' &&
      handoffStarts[0]?.target.profileId === 'shell',
    'while handoff-start for a live pane reaches the host with the parsed target, and answers ok'
  )

  // And the renderer's refusal is carried through rather than swallowed — this
  // is the one that matters, because every real failure of a handoff (no window,
  // nothing to hand back) is a sentence the window wrote.
  handoffAnswer = 'Nothing to hand back'
  browser.send({
    type: 'request',
    rid: 'r-ho-refused',
    body: { kind: 'handoff-start', paneId: 'w1', target: { kind: 'back' } }
  })
  await waitFor(() => browser.result('r-ho-refused'), 5000, 'the refused handoff-start')
  log(
    browser.result('r-ho-refused').body.kind === 'failed' &&
      browser.result('r-ho-refused').body.message === 'Nothing to hand back',
    "and the desktop window's own refusal reaches the browser as a sentence, not as a silence"
  )
  handoffAnswer = null

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
  const authC = makeAuth({ pinHash: () => hashPin(PIN) })
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
  withPin.socket.close()

  // The other half of "there is no list": a browser this desktop has never seen
  // and will never remember gets in on exactly the same two things. Nothing was
  // seeded for it, and nothing is left behind by it.
  const strangerWithPin = await connect()
  helloC(strangerWithPin, { deviceId: 'never-seen-before', deviceName: 'Safari on iOS', pin: PIN })
  await waitFor(() => strangerWithPin.first('hello-ok'), 8000, 'the stranger that knows the PIN')
  log(
    Boolean(strangerWithPin.first('hello-ok')),
    'and so does a browser the desktop has never seen — the account and the PIN are the whole door'
  )
  strangerWithPin.socket.close()

  await serverC.stop()

  /* ------------------------------------- 12b. the lockout, which is the PIN's
   *
   * The five-then-wait that makes a six-digit secret defensible. This is the
   * only thing in the whole door that counts a failure, and it is keyed on the
   * *account* rather than the address — phase A proves the other half, that a
   * stranger throwing bad tokens at the same loopback cannot spend these
   * strikes.
   *
   * On a server of its own because the count has to be unambiguous: the wrong
   * PIN in section 12 above already put one strike on this account, and a test
   * that has to reason about "five, less the one earlier" is a test nobody can
   * safely edit later.
   */

  const authL = makeAuth({ pinHash: () => hashPin(PIN) })
  const serverL = makeServer(authL)
  active = serverL
  await serverL.start({ host: '127.0.0.1', port: PORT })

  const guessPin = async (pin, label) => {
    const tab = await connect()
    tab.send({
      type: 'hello',
      proto: WEB_PROTO,
      idToken: mint(),
      client: '0.0.0-smoke',
      deviceId: 'guessing-browser',
      deviceName: 'Chrome on Windows',
      pin
    })
    await waitFor(() => tab.first('refused') || tab.first('hello-ok'), 8000, label)
    return tab
  }

  // Spend exactly the budget. Each is still answered on its own merits, which is
  // what makes the next one the interesting question rather than this one.
  const spent = []
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
    spent.push(await guessPin(String(100000 + i), `wrong PIN ${i + 1} of ${AUTH_MAX_FAILURES}`))
  }
  log(
    spent.every((tab) => tab.first('refused')?.reason === 'pin-invalid'),
    `each of the first ${AUTH_MAX_FAILURES} wrong PINs is answered pin-invalid on its own merits`
  )

  const locked = await guessPin('999999', 'the wrong PIN past the budget')
  const lockedRefusal = locked.first('refused')
  log(
    lockedRefusal?.reason === 'busy' && lockedRefusal?.retryAfterMs > 0,
    `the ${AUTH_MAX_FAILURES + 1}th wrong PIN is busy with a retryAfterMs, not another pin-invalid`
  )
  log(
    lockedRefusal?.retryAfterMs <= AUTH_LOCKOUT_MS,
    'and the wait it names is no longer than the lockout itself, so the sentence can be believed'
  )

  // The half that makes it a lockout rather than a counter: the *right* PIN is
  // refused too. If knowing the secret got you in during the wait, the wait
  // would cost a guesser nothing — they would simply keep guessing.
  const rightPinWhileLocked = await guessPin(PIN, 'the correct PIN during the lockout')
  log(
    rightPinWhileLocked.first('refused')?.reason === 'busy' && !rightPinWhileLocked.first('hello-ok'),
    'and the correct PIN is refused busy while the lockout stands — it is a lockout, not a counter'
  )

  await serverL.stop()

  /* ===================================================== PHASE D — heartbeat */

  // The shipped numbers are twenty seconds and ten; injected short here so the
  // timer actually fires inside a smoke run. The mechanism is the native
  // WebSocket ping, so the browser is made to stop answering it by switching
  // ws's automatic pong off — which is exactly what a wedged tab looks like
  // from this side.
  log(HEARTBEAT_MS === 20_000 && HEARTBEAT_GRACE_MS === 10_000, 'the shipped heartbeat is a ping every 20s with 10s to answer')

  const beatMs = 200
  const graceMs = 300
  const authD = makeAuth()
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

  // There is no per-browser revocation to assert here any more. The only thing
  // that ends a live connection from this side is the whole link going down,
  // and phase B already proves that path announces itself before it hangs up.
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
  const authE = makeAuth({ pinHash: () => mirrorPin })

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

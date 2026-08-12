/**
 * Head-less proof that the Forge Mobile link works.
 *
 * Bundles the *real* electron/mobile/server.ts and electron/mobile/auth.ts with
 * esbuild and drives them exactly as electron/mobile-host.ts does — against a
 * real PtySessionManager, over a real WebSocket, with a real pwsh session on
 * the other end. No mock server, no fake PTY, no stubbed auth. A link that has
 * only ever run inside Electron is a link nobody has tested.
 *
 *   npm run mobile:smoke
 *
 * Three phases, because the lockout is per source address and every socket
 * here comes from 127.0.0.1: phase A spends the strikes proving refusal works,
 * then is torn down, and phase B starts a fresh server whose auth has no
 * strikes against it. Sharing one server between the two would mean the
 * lockout from phase A silently failing every check in phase B. Phase C is
 * pairing by approval — "Accept new phones" — on a third server whose clock
 * and approval hooks are injected, so arming expiry and the prompt cooldown
 * run on a fake clock and the bounded approval wait on a short real one.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-mobile-smoke')
mkdirSync(scratch, { recursive: true })

const PORT = 8479
const WS_PATH = '/link'

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

/** A phone. Collects every frame it is sent, its close code, and the reason. */
function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`)
  const phone = {
    socket,
    frames: [],
    closed: null,
    closeReason: '',
    send: (frame) => socket.send(JSON.stringify(frame)),
    of: (t) => phone.frames.filter((f) => f.t === t),
    first: (t) => phone.frames.find((f) => f.t === t),
    text: (id) =>
      phone.frames
        .filter((f) => (f.t === 'data' || f.t === 'replay') && f.id === id)
        .map((f) => f.data)
        .join('')
  }
  socket.on('message', (raw) => phone.frames.push(JSON.parse(String(raw))))
  socket.on('close', (code, reason) => {
    phone.closed = code
    // The phone app shows this sentence word-for-word, so the checks assert on
    // it being a sentence and on refusals being distinguishable to a human.
    phone.closeReason = String(reason ?? '')
  })
  socket.on('error', () => {
    /* a refused socket closes; the close handler is the assertion */
  })
  return new Promise((resolvePromise) => {
    socket.on('open', () => resolvePromise(phone))
    socket.on('error', () => resolvePromise(phone))
  })
}

/** Pair a fresh phone against `auth` and drive it through hello-ok — for
 * phases where the handshake itself is not what is under test. */
async function authenticatedClient(auth, deviceId, deviceName) {
  const offer = auth.offerPairing()
  const client = await connect()
  client.send({ t: 'hello', proto: 1, deviceId, deviceName, token: offer.token })
  await waitFor(() => client.first('hello-ok'), 5000, `${deviceId} hello-ok`)
  return client
}

const PROJECTS = [
  { id: 'p1', name: 'forge', path: ROOT, color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 }
]
const PROFILES = [{ id: 'shell', name: 'Shell', command: '', accent: '#888', badge: 'SH' }]

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'mobile-entry.ts')],
    outfile: join(scratch, 'mobile.mjs'),
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
    MobileServer,
    MobileAuth,
    PtySessionManager,
    GridOwners,
    DESK_VIEWER,
    isAllowedSource,
    resolveWithin,
    ACCEPT_WINDOW_MS,
    MAX_INPUT_PER_SECOND,
    MAX_SIGNAL_CHARS,
    MAX_TEXT_CHARS
  } = await import(pathToFileURL(join(scratch, 'mobile.mjs')).href)

  /* ------------------------------------------------- the desktop, once */

  // `active` stands in for mobile-host's PTY sink: the manager's callbacks
  // close over a mutable reference so the same live shell can outlive the
  // phase-A server, which is itself check 9 in disguise.
  let active = null
  const replay = new Map()
  const manager = new PtySessionManager({
    maxSessions: 4,
    onData: (id, data) => {
      // Mirrors pty-host: remember first (the 192KB catch-up), then push.
      replay.set(id, (replay.get(id) ?? '') + data)
      active?.pushData(id, data)
    },
    onExit: (id, exitCode) => active?.pushExit(id, exitCode)
  })

  let saved = []
  const persisted = []
  const store = {
    load: () => saved,
    save: (devices) => {
      saved = devices
      // Everything ever handed to persistence, so check 12 can prove no raw
      // token was among it.
      persisted.push(JSON.stringify(devices))
    }
  }

  const ops = []
  let opAnswer = null
  // Every set of watched panes the server has announced, in order. The desktop
  // labels those panes as read from away, so "it fired" and "it fired only when
  // the set actually changed" are both worth proving.
  const watches = []
  /**
   * The *real* ownership registry, wired to the real PTY.
   *
   * The width follows the typist (electron/pty/grid-owner.ts), so "does this
   * frame move the pane?" is a question with state behind it rather than a
   * boolean a phase can flip. Driving the shipped registry rather than a
   * stand-in is the whole point: a stand-in written to agree with the policy is
   * a check that keeps passing after the policy moves.
   *
   * No repaint jiggle here, unlike electron/pty-host.ts, which is where it lives
   * — a check that had to wait one out would be asserting a timer rather than a
   * rule. The phases below therefore read one resize as one size.
   */
  const owners = new GridOwners({ apply: (id, cols, rows) => manager.resize(id, cols, rows) })
  const makeServer = (auth) =>
    new MobileServer({
      auth,
      appVersion: '0.0.0-smoke',
      sessions: () => manager.list(),
      replay: (id) => replay.get(id) ?? '',
      write: (id, data, viewer) => {
        owners.noteWrite(id, viewer, data)
        return manager.write(id, data)
      },
      resize: (id, cols, rows, viewer) => owners.noteWish(id, viewer, cols, rows),
      release: (viewer, id) => owners.release(viewer, id),
      snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: {} }),
      dispatchOp: async (op) => {
        ops.push(op)
        return opAnswer
      },
      onWatch: (ids) => watches.push(ids.join(' '))
    })

  /* ------------------------------------------------ 0. the address rules */

  log(isAllowedSource('127.0.0.1') && isAllowedSource('::1'), 'loopback is allowed')
  log(isAllowedSource('192.168.1.42') && isAllowedSource('10.0.0.4'), 'LAN is allowed')
  log(isAllowedSource('100.101.102.103'), 'the Tailscale CGNAT range is allowed')
  log(!isAllowedSource('8.8.8.8') && !isAllowedSource('203.0.113.7'), 'a public address is refused')
  log(!isAllowedSource(''), 'an unknown address is refused')
  log(resolveWithin(ROOT, '/../../etc/passwd') === null, 'static hosting refuses a path that escapes its root')
  log(resolveWithin(ROOT, '/index.html') !== null, 'and allows an ordinary file')

  /* ------------------------------- 0b. pairing expiry, on a fake clock */

  // Time is injected precisely so this can be tested without sleeping for five
  // minutes. An offer that outlives its TTL is the difference between a QR you
  // can photograph over someone's shoulder on Tuesday and one you cannot.
  {
    let clock = 1_000_000
    const devices = []
    const timed = new MobileAuth({
      load: () => devices,
      save: () => {},
      now: () => clock
    })
    const offer = timed.offerPairing()
    log(timed.pendingOffer() !== null, 'a fresh pairing offer is live')

    clock += 4 * 60_000
    log(timed.pendingOffer() !== null, 'and still live after four minutes')

    clock += 61_000
    log(timed.pendingOffer() === null, 'but expired after five')
    const late = timed.authenticate({ source: 'fake', deviceId: 'd', deviceName: 'D', pairToken: offer.token })
    log(late.ok === false, 'and an expired code no longer pairs')

    // The lockout must also let go on its own, or one fat-fingered code would
    // wall the phone off until Forge restarted.
    for (let i = 0; i < 6; i++) {
      timed.authenticate({ source: 'fake2', deviceId: 'd', deviceName: 'D', token: 'wrong' })
    }
    log(
      timed.authenticate({ source: 'fake2', deviceId: 'd', deviceName: 'D', token: 'wrong' }).code === 'locked',
      'a locked-out source is refused'
    )
    clock += 61_000
    const offer2 = timed.offerPairing()
    log(
      timed.authenticate({ source: 'fake2', deviceId: 'd', deviceName: 'D', pairToken: offer2.token }).ok === true,
      'and the lockout releases itself a minute later'
    )
  }

  /* =================================================== PHASE A — refusal */

  const authA = new MobileAuth(store)
  const serverA = makeServer(authA)
  active = serverA
  await serverA.start({ host: '127.0.0.1', port: PORT })

  const anon = await connect()
  anon.send({ t: 'hello', proto: 1, deviceId: 'anon' })
  await waitFor(() => anon.closed !== null, 5000, 'anonymous socket to close')
  log(anon.first('err')?.code === 'auth', 'a hello with no credential is refused')
  log(anon.closed === 4001, 'and the socket is closed rather than left sitting open')

  const stale = await connect()
  stale.send({ t: 'hello', proto: 99, deviceId: 'old', token: 'x'.repeat(43) })
  await waitFor(() => stale.closed !== null, 5000, 'protocol-mismatch socket to close')
  log(stale.first('err')?.code === 'proto', 'a protocol mismatch is named rather than failing later')

  // Unauthenticated frames must not be honoured, whatever they ask for.
  const sneaky = await connect()
  sneaky.send({ t: 'write', id: 'm1', data: 'echo pwned\r' })
  await waitFor(() => sneaky.closed !== null, 5000, 'unauthenticated write to be refused')
  log(sneaky.closed === 4001, 'a write before hello is refused and the socket dropped')

  // Five failures in total trips the lockout. One was spent by `anon` above.
  for (let i = 0; i < 4; i++) {
    const s = await connect()
    s.send({ t: 'hello', proto: 1, deviceId: `bad${i}`, token: 'nope' })
    await waitFor(() => s.closed !== null, 5000, 'lockout attempt to close')
  }
  const locked = await connect()
  locked.send({ t: 'hello', proto: 1, deviceId: 'bad9', token: 'nope' })
  await waitFor(() => locked.closed !== null, 5000, 'locked-out socket to close')
  log(locked.first('err')?.code === 'locked', 'repeated failures lock the source address out')

  await serverA.stop()

  /* ================================================== PHASE B — the link */

  const auth = new MobileAuth(store)
  const server = makeServer(auth)
  active = server
  await server.start({ host: '127.0.0.1', port: PORT })

  /* --------------------------------------------- 3. pairing, over the wire */

  const offer = auth.offerPairing()
  const pairing = await connect()
  pairing.send({ t: 'hello', proto: 1, deviceId: 'phone-1', deviceName: 'Pixel', token: offer.token })
  await waitFor(() => pairing.first('hello-ok'), 5000, 'pairing hello-ok')
  const issued = pairing.first('hello-ok').deviceToken
  log(typeof issued === 'string' && issued.length >= 40, 'scanning the pairing code issues a device token')

  const replay2 = await connect()
  replay2.send({ t: 'hello', proto: 1, deviceId: 'phone-2', deviceName: 'Other', token: offer.token })
  await waitFor(() => replay2.closed !== null, 5000, 'reused pairing token to be refused')
  log(replay2.first('err')?.code === 'auth', 'the pairing code is single-use')

  /* ------------------------------------- 4. the token authenticates, picture */

  const phone = await connect()
  phone.send({ t: 'hello', proto: 1, deviceId: 'phone-1', deviceName: 'Pixel', token: issued })
  await waitFor(() => phone.first('hello-ok'), 5000, 'hello-ok')
  const ok = phone.first('hello-ok')
  log(!!ok, 'the issued device token authenticates a later connection')
  log(ok.deviceToken === undefined, 'and no second token is issued on that connection')
  log(ok.projects?.[0]?.name === 'forge', 'hello-ok carries the project list')
  log(ok.profiles?.[0]?.id === 'shell', 'hello-ok carries the launchable profiles')
  log(ok.appVersion === '0.0.0-smoke', 'hello-ok carries the desktop version')
  log(ok.desktopName === undefined, 'a host that does not name itself omits desktopName rather than sending an empty one')

  /* --------------------------------------------- a real shell to drive */

  const created = manager.create({ id: 'm1', cwd: ROOT, cols: 90, rows: 30 })
  log(created.ok === true, 'spawned a real pwsh session for the phone to drive')
  if (!created.ok) throw new Error(created.error)
  await waitFor(() => (replay.get('m1') ?? '').length > 0, 25000, 'first prompt')

  /* ------------------------------------------------------ 5. sub + replay */

  phone.send({ t: 'sub', id: 'm1' })
  await waitFor(() => phone.first('replay'), 6000, 'replay frame')
  log(phone.first('replay').id === 'm1', 'sub answers with the replay buffer first')
  log(phone.first('replay').data.length > 0, 'and that buffer carries the scrollback')

  await waitFor(() => watches.length > 0, 5000, 'the watch announcement')
  log(watches[watches.length - 1] === 'm1', 'a phone opening a pane says so, so the desktop can label it as read from away')

  phone.send({ t: 'sub', id: 'does-not-exist' })
  await waitFor(() => phone.of('err').length > 0, 5000, 'unknown-session error')
  log(phone.of('err')[0].code === 'unknown-session', 'subscribing to a pane that is gone is refused')
  log(watches[watches.length - 1] === 'm1', 'and a refused sub changes nothing about what is watched')

  /* --------------------------------------------------------- 6. write echo */

  phone.send({ t: 'write', id: 'm1', data: 'echo forge-phone-ok\r' })
  await waitFor(() => phone.text('m1').includes('forge-phone-ok'), 25000, 'echo back down the socket')
  log(true, 'a keystroke from the phone reached the real shell and came back')

  /* ------------------------------------------------------------ 7. resize */

  phone.send({ t: 'resize', id: 'm1', cols: 132, rows: 44 })
  await waitFor(() => manager.list().find((s) => s.id === 'm1')?.cols === 132, 6000, 'resize to land')
  const geometry = manager.list().find((s) => s.id === 'm1')
  log(
    geometry.cols === 132 && geometry.rows === 44,
    'a resize from the phone resized the real PTY, because this phone is the device that has been typing into it'
  )

  /* ----------------------------------------- 7b. the width follows the typist
   *
   * A PTY has one grid, and it belongs to whichever device somebody last typed
   * into the pane on. Everything below is that rule seen from four sides, driven
   * through the *real* registry: a pane the desk is holding does not move because
   * a phone slid its keyboard up; it moves the instant somebody types on the
   * phone; the terminal's own replies are not typing; and a phone that hangs up
   * hands the pane back.
   *
   * The ping is what sequences each step — it is answered on the same socket the
   * resize was sent down, so its pong is proof the frames before it have been
   * handled and not merely posted.
   */

  const paneNow = () => manager.list().find((s) => s.id === 'm1')
  const settled = async (label) => {
    const before = phone.of('pong').length
    phone.send({ t: 'ping' })
    await waitFor(() => phone.of('pong').length > before, 6000, label)
  }

  // (a) The desk takes the pane back by typing into it, exactly as the renderer
  //     does — `owners.noteWrite(id, DESK_VIEWER, …)` is the line
  //     electron/pty-host.ts runs on `IPC.ptyWrite`.
  owners.noteWish('m1', DESK_VIEWER, 96, 28)
  owners.noteWrite('m1', DESK_VIEWER, 'x')
  const reclaimed = paneNow()
  log(
    reclaimed.cols === 96 && reclaimed.rows === 28,
    `typing at the desk took the pane back and applied the desk's own stored wish at once (now ${reclaimed.cols}x${reclaimed.rows})`
  )

  // (b) A keyboard sliding up is not typing, so the wish is stored and nothing
  //     on the desk moves.
  const held = paneNow()
  const errsBeforeHeld = phone.of('err').length
  phone.send({ t: 'resize', id: 'm1', cols: 40, rows: 12 })
  await settled('the frame behind the held resize')
  const unmoved = paneNow()
  log(
    unmoved.cols === held.cols && unmoved.rows === held.rows,
    `while the desk holds the pane, a resize from the phone did not move the real PTY (still ${unmoved.cols}x${unmoved.rows})`
  )
  log(phone.of('err').length === errsBeforeHeld, 'and it was not refused out loud — a stored wish is not an error')

  // (c) Nor does the terminal answering a question, which is what a phone sends
  //     constantly while a pane is busy. If that counted, glancing at a phone
  //     would reshape the desk.
  phone.send({ t: 'write', id: 'm1', data: '\x1b[24;80R' })
  await settled('the cursor-report write to be handled')
  const afterReport = paneNow()
  log(
    afterReport.cols === held.cols && afterReport.rows === held.rows,
    "a phone's cursor-position reply did not take the pane — watching a busy pane is not typing into it"
  )

  // (d) And now somebody types on the phone. The wish stored at (b) lands on the
  //     keystroke, without the phone re-sending anything. Ctrl+C rather than a
  //     character, so the line the reply at (c) left in the prompt is abandoned
  //     rather than run by the phases below.
  phone.send({ t: 'write', id: 'm1', data: '\x03' })
  await waitFor(() => paneNow().cols === 40 && paneNow().rows === 12, 6000, 'the pane changing hands')
  log(
    true,
    'one keystroke on the phone took the pane and applied the size it had already asked for (40x12) — the phone re-sent nothing'
  )

  // (e) Unsubscribing hands it straight back: a pane this phone has closed is
  //     one it is certainly not typing into. Then the next wish wins outright.
  phone.send({ t: 'unsub', id: 'm1' })
  await waitFor(() => owners.ownerOf('m1') === null, 6000, 'the pane being released')
  log(true, 'a phone that closes a pane stops holding its grid — ownership goes back to unclaimed')
  owners.noteWish('m1', DESK_VIEWER, 120, 40)
  const afterRelease = paneNow()
  log(
    afterRelease.cols === 120 && afterRelease.rows === 40,
    `and the next wish wins outright, with no typing needed (now ${afterRelease.cols}x${afterRelease.rows})`
  )
  // Back on, because everything below reads this pane's output down this socket.
  phone.send({ t: 'sub', id: 'm1' })
  await waitFor(() => watches[watches.length - 1] === 'm1', 6000, 'the re-subscribe')

  /* ------------------------------------------------- 8. a late subscriber */

  const watchesBeforeLate = watches.length
  const late = await connect()
  late.send({ t: 'hello', proto: 1, deviceId: 'phone-1', token: issued })
  await waitFor(() => late.first('hello-ok'), 5000, 'late hello-ok')
  late.send({ t: 'sub', id: 'm1' })
  await waitFor(() => late.first('replay'), 6000, 'late replay')
  log(
    late.first('replay').data.includes('forge-phone-ok'),
    'a phone connecting late still gets the scrollback it missed'
  )

  /* ------------------------------------ 9. disconnect does not kill the pane */

  log(
    watches.length === watchesBeforeLate,
    'a second phone on the same pane does not change the set, and says nothing'
  )

  late.socket.close()
  await waitFor(() => late.closed !== null, 5000, 'late socket to close')
  log(manager.list().some((s) => s.id === 'm1'), 'closing the phone does not kill the session')
  log(watches[watches.length - 1] === 'm1', 'and the pane stays watched while the other phone still holds it')

  /* ------------------------------------------- 9b. letting the pane go again */

  phone.send({ t: 'unsub', id: 'm1' })
  await waitFor(() => watches[watches.length - 1] === '', 5000, 'the pane to be let go')
  log(true, 'leaving a pane says so, so the desktop can take the label off it')

  phone.send({ t: 'sub', id: 'm1' })
  await waitFor(() => watches[watches.length - 1] === 'm1', 5000, 'the pane to be taken again')
  log(true, 'and opening it again puts the label back')

  /* ----------------------------------- 9c. typing into a pane that has gone
   *
   * The one silence on this wire a user cannot recover from. A phone clears
   * its composer the instant it sends, so a write that lands nowhere costs
   * whatever was in it, and a server that answers a dead pane exactly as it
   * answers a live one is doing the worst thing a remote can do: looking like
   * it worked. Two ways a pane can be gone, and both are checked: an id that
   * never existed, and a real shell that has exited while the phone was in a
   * pocket.
   */

  const errsBeforeStrayWrite = phone.of('err').length
  phone.send({ t: 'write', id: 'never-existed', data: 'echo into-the-void\r' })
  await waitFor(() => phone.of('err').length > errsBeforeStrayWrite, 5000, 'the refusal of a write to an unknown id')
  log(
    phone.of('err').at(-1).code === 'unknown-session',
    'a write to a session id that never existed is refused rather than swallowed'
  )

  const secondPane = manager.create({ id: 'm2', cwd: ROOT, cols: 80, rows: 24 })
  log(secondPane.ok === true, 'spawned a second real shell, so a pane can be made to die under the phone')
  if (!secondPane.ok) throw new Error(secondPane.error)
  await waitFor(() => (replay.get('m2') ?? '').length > 0, 25000, "the second shell's first prompt")

  phone.send({ t: 'sub', id: 'm2' })
  await waitFor(() => phone.frames.some((f) => f.t === 'replay' && f.id === 'm2'), 6000, 'the replay for the second pane')
  manager.kill('m2')
  // The exit frame rather than the manager's own map: it is what clears the
  // phone's subscription, and waiting for it keeps the watch bookkeeping below
  // from moving underneath its own baseline.
  await waitFor(() => phone.frames.some((f) => f.t === 'exit' && f.id === 'm2'), 15000, 'the second pane to exit')

  const errsBeforeDeadWrite = phone.of('err').length
  phone.send({ t: 'write', id: 'm2', data: 'echo too-late\r' })
  await waitFor(() => phone.of('err').length > errsBeforeDeadWrite, 5000, 'the refusal of a write to an exited pane')
  log(
    phone.of('err').at(-1).code === 'unknown-session',
    'and a write to a pane whose shell has exited is refused too, rather than looking like it worked'
  )
  log(
    phone.of('err').at(-1).msg === 'That pane is gone — nothing was typed',
    'and says in a sentence that nothing was typed, because the phone has already thrown the draft away'
  )

  /* --------------------------- 9d. two frames that answer nothing, on purpose
   *
   * Not every silence is a bug, but every silence ought to be a decision. These
   * two frames are dropped on the floor by the server today, and what follows
   * records that rather than endorses it: if either silence ever stops being
   * the right answer, the change should break a check here rather than surface
   * as a puzzled user.
   */

  // A resize for a pane that has gone. Nothing at all comes back, so the phone
  // cannot tell "resized" from "there was nothing to resize". Deliberate, per
  // the comment on the `resize` case in electron/mobile/server.ts: the frame
  // carries nothing the user composed, and a subscribed client is told the
  // session ended by its own `exit` frame anyway. KNOWN GAP, documented: a
  // phone that resizes a pane it never subscribed to learns nothing.
  const pongsBeforeDeadResize = phone.of('pong').length
  const errsBeforeDeadResize = phone.of('err').length
  phone.send({ t: 'resize', id: 'm2', cols: 100, rows: 40 })
  // Nothing to wait *for*, so the wait is a frame that does answer, sent behind
  // it on the same socket — the technique the mirror checks below use.
  phone.send({ t: 'ping' })
  await waitFor(() => phone.of('pong').length > pongsBeforeDeadResize, 5000, 'the frame behind the dead resize')
  log(phone.of('err').length === errsBeforeDeadResize, 'a resize for a pane that has gone is dropped in silence')

  // An unsub for a pane this phone never opened. The id is simply not in the
  // set, and the watch announcement dedupes by value, so neither the phone nor
  // the desktop hears anything. KNOWN GAP, documented: an unsub is never
  // acknowledged, so a phone cannot distinguish "handed back" from "you never
  // held it" — harmless today because nothing on the phone waits on it.
  const watchesBeforeStrayUnsub = watches.length
  const errsBeforeStrayUnsub = phone.of('err').length
  const pongsBeforeStrayUnsub = phone.of('pong').length
  phone.send({ t: 'unsub', id: 'never-opened' })
  phone.send({ t: 'ping' })
  await waitFor(() => phone.of('pong').length > pongsBeforeStrayUnsub, 5000, 'the frame behind the stray unsub')
  log(phone.of('err').length === errsBeforeStrayUnsub, 'an unsub for a pane that was never opened is accepted in silence')
  log(watches.length === watchesBeforeStrayUnsub, 'and the desktop is not told the watch changed, because it did not')

  /* ---------------------------------------------------------------- 10. op */

  opAnswer = 'Forge has no window open on the desktop, so it cannot change tabs.'
  phone.send({ t: 'op', op: 'create-tab', projectId: 'p1', profileId: 'shell' })
  await waitFor(() => ops.length > 0, 5000, 'op to reach the host')
  log(ops[0].op === 'create-tab' && ops[0].projectId === 'p1', 'an op frame is forwarded to the desktop')
  await waitFor(() => phone.of('err').some((e) => e.code === 'no-window'), 5000, 'op refusal')
  log(true, "and the desktop's refusal reaches the phone rather than being swallowed")

  /* ------------------------------- 10b. a successful op, and static hosting */

  // The same frame again, but with the host accepting it — proving the success
  // path is wired, not just the refusal one.
  opAnswer = null
  const before = ops.length
  phone.send({ t: 'op', op: 'select-tab', projectId: 'p1', tabId: 'tab-1' })
  await waitFor(() => ops.length > before, 5000, 'second op to reach the host')
  log(ops[before].op === 'select-tab' && ops[before].tabId === 'tab-1', 'an accepted op carries its tab id through')
  const errorsBefore = phone.of('err').length
  // Give a refusal time to arrive if one were coming; silence is the assertion.
  await new Promise((r) => setTimeout(r, 300))
  log(phone.of('err').length === errorsBefore, 'and an op the desktop accepted produces no error frame')

  const page = await fetch(`http://127.0.0.1:${PORT}/`)
  log(page.status === 404, 'static hosting answers 404 when no bundle is configured')

  /* ------------------------------------------------------------ 11. revoke */

  const record = saved.find((d) => d.id === 'phone-1')
  log(auth.revoke('phone-1') === true, 'a device can be revoked')
  server.disconnectDevice('phone-1')
  await waitFor(() => phone.closed !== null, 5000, 'revoked socket to close')
  log(phone.closed === 4003, 'revoking hangs up on the live socket, not just the next one')

  const after = await connect()
  after.send({ t: 'hello', proto: 1, deviceId: 'phone-1', token: issued })
  await waitFor(() => after.closed !== null, 5000, 'revoked token to be refused')
  log(after.first('err')?.code === 'auth', 'and its token no longer authenticates')

  /* -------------------------------------------------- 12. no raw secrets */

  log(!!record && /^[0-9a-f]{64}$/.test(record.tokenHash), 'the persisted record holds a SHA-256 hex digest')
  log(
    persisted.length > 0 && persisted.every((json) => !json.includes(issued)),
    'no raw device token was ever handed to persistence'
  )

  await server.stop()

  /* ====================================== PHASE C — pairing by approval */

  // The clock is fake so arming expiry and the 60-second prompt cooldown can
  // be crossed by assignment; the approval wait itself runs on a real timer,
  // injected short where the check needs it to actually fire.
  let clockC = 50_000_000
  let acceptUntilC = 0
  const prompts = []
  const withdrawn = []
  let verdict = () => new Promise(() => {})
  const authC = new MobileAuth({ load: store.load, save: store.save, now: () => clockC })
  const hostC = {
    auth: authC,
    appVersion: '0.0.0-smoke',
    desktopName: () => 'SMOKE-PC',
    sessions: () => manager.list(),
    replay: () => '',
    write: () => true,
    resize: () => true,
    snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: {} }),
    dispatchOp: async () => null,
    now: () => clockC,
    acceptUntil: () => acceptUntilC,
    approvalTimeoutMs: 30_000,
    requestApproval: (ask) => {
      prompts.push(ask)
      return verdict(ask)
    },
    cancelApproval: (requestId) => withdrawn.push(requestId)
  }
  const serverC = new MobileServer(hostC)
  active = serverC
  await serverC.start({ host: '127.0.0.1', port: PORT })

  /* -------------------------------------------- 13. unarmed = no such door */

  const cold = await connect()
  cold.send({ t: 'hello', proto: 1, deviceId: 'stray', deviceName: 'Stray', requestPair: true })
  await waitFor(() => cold.closed !== null, 5000, 'unarmed requestPair to be refused')
  log(cold.closed === 4001 && cold.first('err')?.code === 'auth', 'an unarmed desktop refuses requestPair and closes 4001')
  log(prompts.length === 0, 'and raises no prompt')

  const bare = await connect()
  bare.send({ t: 'hello', proto: 1, deviceId: 'bare' })
  await waitFor(() => bare.closed !== null, 5000, 'flag-less hello to be refused')
  log(
    bare.first('err')?.msg === cold.first('err')?.msg && bare.closed === cold.closed,
    'and that refusal is indistinguishable from a plain no-credential hello'
  )

  /* --------------------------------------------------- 14. armed + Allow */

  acceptUntilC = clockC + ACCEPT_WINDOW_MS
  verdict = async () => true
  const pixel = await connect()
  pixel.send({ t: 'hello', proto: 1, deviceId: 'pixel-8', deviceName: 'Pixel 8', requestPair: true })
  await waitFor(() => pixel.first('hello-ok'), 5000, 'approval hello-ok')
  const showing = pixel.first('awaiting-approval')
  log(!!showing && /^[A-Z]+ [A-Z]+$/.test(showing.words), 'an armed desktop answers awaiting-approval with a word pair')
  log(
    prompts.length === 1 && prompts[0].words === showing.words && prompts[0].deviceName === 'Pixel 8',
    'exactly one prompt was raised, carrying the same words and the device name'
  )
  log(prompts[0].known === false, 'and it says this is a device the desktop has never seen')
  log(
    pixel.first('hello-ok').desktopName === 'SMOKE-PC',
    'hello-ok names the desktop, so a television can recognise it at a new address later'
  )
  const granted = pixel.first('hello-ok').deviceToken
  log(
    typeof granted === 'string' && granted.length === issued.length && /^[A-Za-z0-9_-]+$/.test(granted),
    "Allow issues a token identical in shape to the code path's"
  )
  const grantedRecord = saved.find((d) => d.id === 'pixel-8')
  log(
    !!grantedRecord && /^[0-9a-f]{64}$/.test(grantedRecord.tokenHash),
    'and persists only a SHA-256 hash, exactly like the code path'
  )
  log(pixel.first('hello-ok').projects?.[0]?.name === 'forge', 'and its hello-ok carries the same opening picture')

  /* ------------------------------------------------ 15. the prompt floor */

  const eager = await connect()
  eager.send({ t: 'hello', proto: 1, deviceId: 'eager', requestPair: true })
  await waitFor(() => eager.closed !== null, 5000, 'cooldown refusal')
  log(
    eager.closed === 4001 && eager.first('err')?.code === 'limit' && prompts.length === 1,
    'a second request inside 60 seconds is refused without a second prompt'
  )

  /* ----------------------------- 16. one pending; the wait may keep warm */

  clockC += 61_000
  let settleSecond = null
  verdict = () => new Promise((r) => (settleSecond = r))
  const second = await connect()
  second.send({ t: 'hello', proto: 1, deviceId: 'second', deviceName: 'Second', requestPair: true })
  await waitFor(() => prompts.length === 2, 5000, 'second prompt')

  // The phone pings through the wait; hanging up on that would make it
  // reconnect and mint fresh words mid-comparison.
  second.send({ t: 'ping' })
  await waitFor(() => second.of('pong').length > 0, 5000, 'pong during the approval wait')
  log(second.closed === null, 'a socket waiting on a human may ping and is not dropped for it')

  clockC += 61_000 // past the cooldown, so only the single-pending rule refuses
  const third = await connect()
  third.send({ t: 'hello', proto: 1, deviceId: 'third', requestPair: true })
  await waitFor(() => third.closed !== null, 5000, 'single-pending refusal')
  log(third.closed === 4001 && prompts.length === 2, 'only one approval can be pending at a time')

  settleSecond(false)
  await waitFor(() => second.closed !== null, 5000, 'denied socket to close')
  log(second.closed === 4001 && !second.first('hello-ok'), 'Deny issues nothing and closes the socket')
  log(!saved.some((d) => d.id === 'second'), 'and nothing was persisted for the denied phone')

  /* ------------------------------------------- 17. an unanswered prompt */

  clockC += 61_000
  hostC.approvalTimeoutMs = 300
  verdict = () => new Promise(() => {})
  const idle = await connect()
  idle.send({ t: 'hello', proto: 1, deviceId: 'idle', deviceName: 'Idle', requestPair: true })
  await waitFor(() => prompts.length === 3, 5000, 'third prompt')
  await waitFor(() => idle.closed !== null, 5000, 'unanswered approval to time out')
  log(
    idle.closed === 4001 && !idle.first('hello-ok'),
    'an approval nobody answers times out and closes rather than holding the socket'
  )
  log(withdrawn.includes(prompts[2].requestId), 'and the desktop prompt is withdrawn when it does')
  log(
    idle.closeReason.length > 0 && second.closeReason.length > 0 && idle.closeReason !== second.closeReason,
    'timeout and Deny close with distinct human sentences'
  )

  /* ------------------------------------------------- 18. arming expires */

  clockC = acceptUntilC + 1
  const late2 = await connect()
  late2.send({ t: 'hello', proto: 1, deviceId: 'late', requestPair: true })
  await waitFor(() => late2.closed !== null, 5000, 'post-window refusal')
  log(
    late2.closed === 4001 && late2.first('err')?.code === 'auth' && prompts.length === 3,
    'arming expires: after the window the same request is refused with no prompt'
  )

  /* --------------------------------- 19. the minted token is a real one */

  const back = await connect()
  back.send({ t: 'hello', proto: 1, deviceId: 'pixel-8', token: granted })
  await waitFor(() => back.first('hello-ok'), 5000, 'approved token to authenticate')
  log(
    !!back.first('hello-ok') && back.first('hello-ok').deviceToken === undefined,
    'the approved token authenticates a later connection, with no second token issued'
  )
  log(
    persisted.length > 0 && persisted.every((json) => !json.includes(granted)),
    'no raw approval-minted token was ever handed to persistence'
  )

  /* ------------------------- 20. a device already paired may still ask */

  // The television's homecoming. Its token is no good against an address it has
  // not confirmed, so it asks instead — and a desktop that made somebody walk
  // over and arm a window first would have turned "press Allow" into a chore
  // for a device already sitting in its own list. What is *not* loosened: the
  // prompt still goes up, and a human still answers it.
  clockC += 61_000
  verdict = async () => true
  const returning = await connect()
  returning.send({ t: 'hello', proto: 1, deviceId: 'pixel-8', deviceName: 'TV (Fire TV)', requestPair: true })
  await waitFor(() => returning.first('hello-ok'), 5000, 'known-device approval hello-ok')
  log(
    prompts.length === 4 && prompts[3].known === true,
    'a device already in the paired list may ask again with the window shut, and the prompt says it is a returning one'
  )
  const regranted = returning.first('hello-ok').deviceToken
  log(
    typeof regranted === 'string' && regranted !== granted,
    'Allow issues it a fresh token rather than resurrecting the old one'
  )

  // The same hello with an id nobody has paired is still refused, which is the
  // whole difference between a door for a known device and no door at all.
  clockC += 61_000
  const impostor = await connect()
  impostor.send({ t: 'hello', proto: 1, deviceId: 'not-a-device', deviceName: 'TV (Fire TV)', requestPair: true })
  await waitFor(() => impostor.closed !== null, 5000, 'unknown-device refusal')
  log(
    impostor.closed === 4001 && impostor.first('err')?.code === 'auth' && prompts.length === 4,
    'and an unpaired device asking the same way with the window shut is refused with no prompt at all'
  )

  // Revoke is still the kill switch: the relaxation lives entirely inside the
  // paired list, so leaving the list closes the door behind you.
  clockC += 61_000
  authC.revoke('pixel-8')
  const revoked = await connect()
  revoked.send({ t: 'hello', proto: 1, deviceId: 'pixel-8', deviceName: 'TV (Fire TV)', requestPair: true })
  await waitFor(() => revoked.closed !== null, 5000, 'revoked-device refusal')
  log(
    revoked.closed === 4001 && prompts.length === 4,
    'and a revoked device loses that door with its pairing — no prompt, no way back in'
  )

  await serverC.stop()

  /* ====================================== PHASE D — screen mirror relay */

  // The server never parses a signalling payload — it only relays and
  // counts — so nothing here speaks WebRTC. `mirrorStart` is a function
  // rather than a fixed answer so the refusing-host check can flip it
  // without tearing the server down.
  const mirrorStarts = []
  const mirrorSignals = []
  const mirrorStops = []
  const inputs = []
  let mirrorStartReturn = null
  /** Stands in for `mobileControlEnabled`, flipped by the checks in phase E. */
  let controlAllowed = false
  const authD = new MobileAuth(store)
  const serverD = new MobileServer({
    auth: authD,
    appVersion: '0.0.0-smoke',
    sessions: () => manager.list(),
    replay: () => '',
    write: () => true,
    resize: () => true,
    snapshot: () => ({ projects: PROJECTS, profiles: PROFILES, workspaces: {} }),
    dispatchOp: async () => null,
    mirrorStart: () => {
      mirrorStarts.push(true)
      return mirrorStartReturn
    },
    mirrorSignal: (data) => mirrorSignals.push(data),
    mirrorStop: () => mirrorStops.push(true),
    // The desktop's own two answers, exactly as electron/mobile-host.ts gives
    // them: may anybody drive at all, and here is one input to perform. Both
    // read the flag per call, because that is what makes switching control off
    // stop the *next* event rather than the next session.
    mirrorControl: () => controlAllowed,
    mirrorInput: (input) => {
      if (!controlAllowed) return false
      inputs.push(input)
      return true
    }
  })
  active = serverD
  await serverD.start({ host: '127.0.0.1', port: PORT })

  /* ---------------------------------------------------- 20. a viewer starts */

  const viewer = await authenticatedClient(authD, 'tv-1', 'Fire TV')
  viewer.send({ t: 'mirror-start' })
  await waitFor(() => mirrorStarts.length > 0, 5000, 'mirrorStart hook call')
  log(mirrorStarts.length === 1, 'an authenticated viewer starting a mirror calls the mirrorStart hook')
  log(serverD.mirroring === true, 'and the server now considers itself mirroring')

  /* ------------------------------------------------ 21. signalling, verbatim */

  const toHost = 'offer:' + 'A'.repeat(48)
  viewer.send({ t: 'mirror-signal', data: toHost })
  await waitFor(() => mirrorSignals.length > 0, 5000, 'mirrorSignal hook call')
  log(mirrorSignals[0] === toHost, 'a signal from the viewer reaches the mirrorSignal hook byte for byte')

  const toViewer = 'answer:' + 'B'.repeat(48)
  serverD.pushMirrorSignal(toViewer)
  await waitFor(() => viewer.of('mirror-signal').length > 0, 5000, 'mirror-signal frame down to the viewer')
  log(viewer.first('mirror-signal').data === toViewer, 'and pushMirrorSignal reaches the viewer verbatim')

  /* -------------------------------------------------- 22. only the viewer */

  const bystander = await authenticatedClient(authD, 'phone-b', 'Bystander')
  const viewerSignalsBefore = viewer.of('mirror-signal').length
  serverD.pushMirrorSignal('should-not-leak')
  await waitFor(
    () => viewer.of('mirror-signal').length > viewerSignalsBefore,
    5000,
    'the viewer to receive the next pushed signal'
  )
  log(bystander.of('mirror-signal').length === 0, 'a second authenticated client never receives a mirror signal')
  log(viewer.of('mirror-signal').length === viewerSignalsBefore + 1, 'while the viewer alone gets it')

  /* ----------------------------------------------- 23. one viewer at a time */

  const mirrorStartsBeforeSecond = mirrorStarts.length
  bystander.send({ t: 'mirror-start' })
  await waitFor(() => bystander.first('mirror-stop'), 5000, 'second mirror-start refusal')
  log(
    typeof bystander.first('mirror-stop').reason === 'string' && bystander.first('mirror-stop').reason.length > 0,
    'a second client asking to view while one is watching gets a mirror-stop with a reason'
  )
  log(mirrorStarts.length === mirrorStartsBeforeSecond, 'and the mirrorStart hook is not called a second time')
  log(serverD.mirroring === true, 'the original viewer is still the viewer')

  /* ------------------------------------- 23b. the same screen asking again
   *
   * The television's own attempt can die where this side cannot see it — its
   * no-answer deadline, a peer that never connected — leaving the server still
   * believing it has a watcher. Refusing that screen's retry told the one
   * television in the room that another television was watching, and left the
   * sofa with nothing to press. A repeat from the *viewer* is a restart.
   */

  const startsBeforeRestart = mirrorStarts.length
  const viewerStopsBeforeRestart = viewer.of('mirror-stop').length
  viewer.send({ t: 'mirror-start' })
  await waitFor(() => mirrorStarts.length > startsBeforeRestart, 5000, 'restart from the screen already watching')
  log(mirrorStarts.length === startsBeforeRestart + 1, 'the screen already watching can ask again, and the host starts over')
  log(viewer.of('mirror-stop').length === viewerStopsBeforeRestart, 'it is never told another screen is watching')
  log(serverD.mirroring === true, 'and it is still the viewer afterwards')

  /* --------------------------------------------------- 24. a hang-up ends it */

  viewer.socket.close()
  await waitFor(() => mirrorStops.length > 0, 5000, 'mirrorStop hook call')
  log(mirrorStops.length === 1, "the viewer's own hang-up fires the mirrorStop hook")
  log(serverD.mirroring === false, 'and the server is no longer mirroring')

  /* ----------------------------------------------- 25. a refusing host */

  mirrorStartReturn = 'Screen capture failed: no display.'
  const stopsBeforeRefusal = bystander.of('mirror-stop').length
  bystander.send({ t: 'mirror-start' })
  await waitFor(() => bystander.of('mirror-stop').length > stopsBeforeRefusal, 5000, 'refused mirror-start reply')
  log(
    bystander.of('mirror-stop').at(-1).reason === mirrorStartReturn,
    "a refusing host's sentence reaches the would-be viewer verbatim"
  )
  log(serverD.mirroring === false, 'and no viewer was created, so it can ask again')

  /* --------------------------------------------- 26. oversized signalling */

  mirrorStartReturn = null
  const mirrorStartsBeforeRetry = mirrorStarts.length
  bystander.send({ t: 'mirror-start' })
  await waitFor(() => mirrorStarts.length > mirrorStartsBeforeRetry, 5000, 'retry mirror-start call')
  log(serverD.mirroring === true, 'asking again after a refusal succeeds')

  const oversized = 'x'.repeat(MAX_SIGNAL_CHARS + 1)
  const mirrorSignalsBeforeOversized = mirrorSignals.length
  const errsBefore = bystander.of('err').length
  bystander.send({ t: 'mirror-signal', data: oversized })
  await waitFor(() => bystander.of('err').length > errsBefore, 5000, 'oversized signal rejection')
  log(bystander.of('err').at(-1).code === 'bad-frame', 'a signal over MAX_SIGNAL_CHARS is rejected as bad-frame')
  log(mirrorSignals.length === mirrorSignalsBeforeOversized, 'and the mirrorSignal hook never sees it')

  /* ------------------------------------------ 27. no hello, no mirror-start */

  const mirrorStartsBeforeStranger = mirrorStarts.length
  const stranger = await connect()
  stranger.send({ t: 'mirror-start' })
  await waitFor(() => stranger.closed !== null, 5000, 'unauthenticated mirror-start to be refused')
  log(stranger.closed === 4001, 'a socket that never said hello is dropped for sending mirror-start')
  log(mirrorStarts.length === mirrorStartsBeforeStranger, 'and the mirrorStart hook is never reached')

  /* ------------------------------------------------ 28. "play this on the TV"
   *
   * The one frame the server relays rather than acts on: a phone sends it up,
   * every *other* authenticated socket gets it down. What is worth proving is
   * not that a message moved — it is the three rules around it. The sender does
   * not get its own frame back (or a phone would fling to itself). A stranger
   * cannot send one at all. And the id is re-derived on this side, so a phone
   * that has been tampered with cannot put arbitrary text into the URL a
   * television opens.
   */

  const flinger = await authenticatedClient(authD, 'phone-fling', 'Phone')
  const television = await authenticatedClient(authD, 'tv-fling', 'Fire TV')

  flinger.send({ t: 'tv-play', video: 'aqz-KE-bpKQ' })
  await waitFor(() => television.first('tv-play'), 5000, 'the relayed tv-play')
  log(television.first('tv-play').video === 'aqz-KE-bpKQ', 'a tv-play from one phone reaches another device verbatim')
  log(flinger.of('tv-play').length === 0, 'and never comes back to the phone that sent it')

  const flingerErrsBefore = flinger.of('err').length
  flinger.send({ t: 'tv-play', video: 'https://youtu.be/aqz-KE-bpKQ' })
  await waitFor(() => flinger.of('err').length > flingerErrsBefore, 5000, 'the refusal of a URL')
  log(flinger.of('err').at(-1).code === 'bad-frame', 'a URL where an id belongs is refused rather than relayed')
  log(television.of('tv-play').length === 1, 'and nothing reached the television')

  const flingStranger = await connect()
  flingStranger.send({ t: 'tv-play', video: 'aqz-KE-bpKQ' })
  await waitFor(() => flingStranger.closed !== null, 5000, 'unauthenticated tv-play to be refused')
  log(flingStranger.closed === 4001, 'a socket that never said hello is dropped for sending tv-play')
  log(television.of('tv-play').length === 1, 'and still nothing reached the television')

  /* ================================ PHASE E — the remote driving the desk
   *
   * The one frame on this wire that ends in a synthetic event at the operating
   * system, so it is the one worth being hard about. Four gates stand between
   * a socket and somebody's mouse — it must be the screen currently watching,
   * it must fit a rate limit, it must parse into an exact shape, and the
   * desktop must still be saying yes — and each is checked here against the
   * real server over a real socket rather than reasoned about.
   */

  /* --------------------------------- 29. the desktop's answer, at hello */

  const denied = await authenticatedClient(authD, 'tv-denied', 'Fire TV')
  log(
    denied.first('hello-ok').canControl === undefined,
    'a desktop with control switched off never claims it in hello-ok'
  )

  controlAllowed = true
  const remote = await authenticatedClient(authD, 'tv-remote', 'Fire TV')
  log(remote.first('hello-ok').canControl === true, 'and says so plainly once it is switched on')

  /* ------------------------------------ 30. only the screen that is watching */

  const strayInputs = inputs.length
  remote.send({ t: 'mirror-input', a: 'move', x: 0.5, y: 0.5 })
  // Nothing to wait *for* — the assertion is that nothing happens — so the
  // proof is a frame that does travel, sent afterwards on the same socket.
  bystander.send({ t: 'mirror-signal', data: 'still-the-viewer' })
  await waitFor(() => mirrorSignals.at(-1) === 'still-the-viewer', 5000, 'the viewer’s own signal')
  log(inputs.length === strayInputs, 'an input from a device that is not watching the screen is dropped')
  log(remote.of('err').length === 0, 'and silently: a frame from a screen that just stopped watching is timing, not an attack')

  /* ------------------------------------------- 31. the watching screen drives */

  bystander.send({ t: 'mirror-stop' })
  await waitFor(() => serverD.mirroring === false, 5000, 'the previous viewer to let go')
  remote.send({ t: 'mirror-start' })
  await waitFor(() => serverD.mirroring === true, 5000, 'the remote to become the viewer')

  remote.send({ t: 'mirror-input', a: 'move', x: 0.25, y: 0.75 })
  await waitFor(() => inputs.length > strayInputs, 5000, 'the first input to reach the host')
  log(
    inputs.at(-1).a === 'move' && inputs.at(-1).x === 0.25 && inputs.at(-1).y === 0.75,
    'a move from the watching screen reaches the desktop with its coordinates intact'
  )

  remote.send({ t: 'mirror-input', a: 'down', button: 'left', x: 0.5, y: 0.5 })
  await waitFor(() => inputs.at(-1).a === 'down', 5000, 'a button press')
  log(inputs.at(-1).button === 'left', 'and a button press names its button')

  remote.send({ t: 'mirror-input', a: 'key', key: 'win', down: true })
  await waitFor(() => inputs.at(-1).a === 'key', 5000, 'a key press')
  log(inputs.at(-1).key === 'win' && inputs.at(-1).down === true, 'a key from the closed list is performed')

  /* ------------------------------------------------------ 32. out of bounds */

  remote.send({ t: 'mirror-input', a: 'move', x: 4, y: -3 })
  await waitFor(() => inputs.at(-1).a === 'move', 5000, 'the clamped move')
  log(
    inputs.at(-1).x === 1 && inputs.at(-1).y === 0,
    'a coordinate outside the screen is clamped to its edge rather than refused'
  )

  const badBefore = inputs.length
  const errsBeforeBad = remote.of('err').length
  remote.send({ t: 'mirror-input', a: 'key', key: 'f13', down: true })
  await waitFor(() => remote.of('err').length > errsBeforeBad, 5000, 'the refusal of a key nobody listed')
  log(remote.of('err').at(-1).code === 'bad-frame', 'a key outside the closed list is refused as bad-frame')
  log(inputs.length === badBefore, 'and never reaches the desktop')

  const errsBeforeShapeless = remote.of('err').length
  remote.send({ t: 'mirror-input', a: 'move' })
  await waitFor(() => remote.of('err').length > errsBeforeShapeless, 5000, 'the refusal of a move with no coordinates')
  log(inputs.length === badBefore, 'a move with no coordinates is refused too — every pointer event carries its own')

  /* ------------------------------------------------- 32b. the remote types
   *
   * Everything above this line is a pointer or one key at a time. This is the
   * frame that carries a *phrase* — dictated into the remote, or tapped out on
   * the television's own keyboard and committed with Done — and it is the frame
   * that reached a living room and was answered with "That is not an input this
   * desktop understands". The parser is already exercised as a pure function by
   * scripts/input-check.mjs; what was never exercised, and what shipped broken,
   * is the same frame arriving over this socket through the same four gates as
   * a click. So it is driven here end to end rather than reasoned about.
   */

  const typedBefore = inputs.length
  const errsBeforeTyping = remote.of('err').length
  const phrase = 'git status'
  remote.send({ t: 'mirror-input', a: 'text', a_unused: undefined, text: phrase })
  await waitFor(() => inputs.length > typedBefore, 5000, 'the typed phrase to reach the desktop')
  log(
    inputs.at(-1).a === 'text' && inputs.at(-1).text === phrase,
    'a phrase typed on the television reaches the desktop verbatim'
  )
  // Silence is half the assertion: the regression was an error frame, not a
  // missing keystroke, so a phrase that arrives *and* draws a refusal would
  // still put that sentence on the screen. A frame that does answer, sent
  // behind it, is the proof the refusal is not merely in flight.
  remote.send({ t: 'mirror-signal', data: 'after-the-phrase' })
  await waitFor(() => mirrorSignals.at(-1) === 'after-the-phrase', 5000, 'the frame behind the phrase')
  log(remote.of('err').length === errsBeforeTyping, 'and draws no error frame at all — this is the regression, asserted directly')

  const typedBeforeControlOnly = inputs.length
  const errsBeforeControlOnly = remote.of('err').length
  remote.send({ t: 'mirror-input', a: 'text', text: ' ' })
  await waitFor(
    () => remote.of('err').length > errsBeforeControlOnly,
    5000,
    'the refusal of a phrase that is only control characters'
  )
  log(
    remote.of('err').at(-1).code === 'bad-frame',
    'a phrase that is nothing but control characters survives stripping as nothing, and is refused as bad-frame'
  )
  // The string itself, not just the code. This exact sentence on a television
  // is what the regression looked like from the sofa, so the check that guards
  // it has to be the check that reads it.
  log(
    remote.of('err').at(-1).msg === 'That is not an input this desktop understands',
    'and the sentence a television would put on the screen is exactly the one this desktop sends'
  )
  log(inputs.length === typedBeforeControlOnly, 'and nothing was typed on the desk')

  const exact = 'q'.repeat(MAX_TEXT_CHARS)
  const typedBeforeExact = inputs.length
  remote.send({ t: 'mirror-input', a: 'text', text: exact })
  await waitFor(() => inputs.length > typedBeforeExact, 5000, 'a phrase of exactly MAX_TEXT_CHARS')
  log(
    inputs.at(-1).text === exact && inputs.at(-1).text.length === MAX_TEXT_CHARS,
    `a phrase of exactly MAX_TEXT_CHARS (${MAX_TEXT_CHARS}) survives the wire intact`
  )

  // Over the ceiling the phrase is cut, and *silently*: nothing goes back to
  // say so, so a dictated sentence can arrive on the desk with its tail
  // missing and the television none the wiser. This asserts today's behaviour
  // deliberately. If the truncation is ever made loud — a refusal, or a frame
  // that says how much was dropped — this assertion is meant to break, and
  // breaking is the point: it is how the change gets noticed here rather than
  // in somebody's living room.
  const overlong = 'z'.repeat(MAX_TEXT_CHARS + 60)
  const typedBeforeOverlong = inputs.length
  const errsBeforeOverlong = remote.of('err').length
  remote.send({ t: 'mirror-input', a: 'text', text: overlong })
  await waitFor(() => inputs.length > typedBeforeOverlong, 5000, 'an over-long phrase')
  log(
    inputs.at(-1).text === overlong.slice(0, MAX_TEXT_CHARS),
    'a phrase past MAX_TEXT_CHARS is cut to the ceiling rather than refused'
  )
  log(remote.of('err').length === errsBeforeOverlong, 'and the cut is silent today — the television is told nothing about it')

  // The same first gate a pointer meets. `denied` is authenticated and has
  // never asked to watch anything, so its keyboard must reach nothing at all,
  // and must do so without an error: a frame from a screen that has just
  // stopped watching is timing, not an attack.
  const typedBeforeStranger = inputs.length
  const deniedErrsBefore = denied.of('err').length
  denied.send({ t: 'mirror-input', a: 'text', text: 'typed from the wrong sofa' })
  remote.send({ t: 'mirror-signal', data: 'after-the-wrong-sofa' })
  await waitFor(() => mirrorSignals.at(-1) === 'after-the-wrong-sofa', 5000, 'the frame behind the stranger')
  log(inputs.length === typedBeforeStranger, 'a phrase from a device that is not watching the screen is dropped')
  log(denied.of('err').length === deniedErrsBefore, 'and silently, exactly as a stray pointer event is')

  /* ----------------------------------------------------- 33. the rate limit */

  const burstBefore = inputs.length
  for (let i = 0; i < MAX_INPUT_PER_SECOND * 3; i++) {
    remote.send({ t: 'mirror-input', a: 'move', x: 0.5, y: 0.5 })
  }
  // Everything sent on one socket arrives in order, so a frame sent last and
  // known to be dropped cannot be waited for — this waits for the burst to be
  // over by asking for something that answers.
  remote.send({ t: 'mirror-signal', data: 'after-the-burst' })
  await waitFor(() => mirrorSignals.at(-1) === 'after-the-burst', 5000, 'the frame behind the burst')
  const performed = inputs.length - burstBefore
  log(
    performed <= MAX_INPUT_PER_SECOND * 2,
    `a burst of ${MAX_INPUT_PER_SECOND * 3} inputs is capped by the rate limit (${performed} performed)`
  )

  /* ------------------------------------------------- 34. switched off mid-watch */

  // Past the burst's own second, because the rate limit is checked before the
  // permission is: an input dropped by the counter is dropped in silence, and
  // waiting for a refusal inside the exhausted second would be waiting for a
  // frame the server is right not to send.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1100))

  controlAllowed = false
  const refusedBefore = inputs.length
  const errsBeforeRefusal = remote.of('err').length
  remote.send({ t: 'mirror-input', a: 'move', x: 0.1, y: 0.1 })
  await waitFor(() => remote.of('err').length > errsBeforeRefusal, 5000, 'the refusal')
  log(remote.of('err').at(-1).code === 'locked', 'switching control off refuses the very next input, not the next session')
  log(inputs.length === refusedBefore, 'and nothing is performed')

  const errsAfterFirstRefusal = remote.of('err').length
  for (let i = 0; i < 5; i++) remote.send({ t: 'mirror-input', a: 'move', x: 0.2, y: 0.2 })
  remote.send({ t: 'mirror-signal', data: 'after-the-refusals' })
  await waitFor(() => mirrorSignals.at(-1) === 'after-the-refusals', 5000, 'the frame behind the refusals')
  log(
    remote.of('err').length === errsAfterFirstRefusal,
    'and the refusal is said once per watch — a held button must not fill the screen with it'
  )

  await serverD.stop()

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
    console.log(failures === 0 ? '\nmobile:smoke — all checks passed' : `\nmobile:smoke — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })

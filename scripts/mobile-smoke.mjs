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

  const { MobileServer, MobileAuth, PtySessionManager, isAllowedSource, resolveWithin, ACCEPT_WINDOW_MS } =
    await import(pathToFileURL(join(scratch, 'mobile.mjs')).href)

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
  // uses these to decide which PTYs it must stop resizing, so "it fired" and
  // "it fired only when the set actually changed" are both worth proving.
  const watches = []
  const makeServer = (auth) =>
    new MobileServer({
      auth,
      appVersion: '0.0.0-smoke',
      sessions: () => manager.list(),
      replay: (id) => replay.get(id) ?? '',
      write: (id, data) => manager.write(id, data),
      resize: (id, cols, rows) => manager.resize(id, cols, rows),
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
  log(watches[watches.length - 1] === 'm1', 'a phone opening a pane says so, so the desktop can hand it the geometry')

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
  log(geometry.cols === 132 && geometry.rows === 44, 'a resize from the phone resized the real PTY')

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
    'a second phone on the same pane is not a change of ownership, and says nothing'
  )

  late.socket.close()
  await waitFor(() => late.closed !== null, 5000, 'late socket to close')
  log(manager.list().some((s) => s.id === 'm1'), 'closing the phone does not kill the session')
  log(watches[watches.length - 1] === 'm1', 'and the pane stays watched while the other phone still holds it')

  /* --------------------------------------------- 9b. handing the pane back */

  phone.send({ t: 'unsub', id: 'm1' })
  await waitFor(() => watches[watches.length - 1] === '', 5000, 'the pane to be handed back')
  log(true, 'leaving a pane hands its geometry back to the desktop')

  phone.send({ t: 'sub', id: 'm1' })
  await waitFor(() => watches[watches.length - 1] === 'm1', 5000, 'the pane to be taken again')
  log(true, 'and opening it again takes it back')

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

  /* ---------------------------------------------------------------- done */

  manager.killAll()
  await serverC.stop()
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

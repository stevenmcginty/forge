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
 * Two phases, because the lockout is per source address and every socket here
 * comes from 127.0.0.1: phase A spends the strikes proving refusal works, then
 * is torn down, and phase B starts a fresh server whose auth has no strikes
 * against it. Sharing one server between the two would mean the lockout from
 * phase A silently failing every check in phase B.
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

/** A phone. Collects every frame it is sent, and its close code. */
function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`)
  const phone = {
    socket,
    frames: [],
    closed: null,
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
  socket.on('close', (code) => {
    phone.closed = code
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

  const { MobileServer, MobileAuth, PtySessionManager, isAllowedSource, resolveWithin } = await import(
    pathToFileURL(join(scratch, 'mobile.mjs')).href
  )

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
      }
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

  phone.send({ t: 'sub', id: 'does-not-exist' })
  await waitFor(() => phone.of('err').length > 0, 5000, 'unknown-session error')
  log(phone.of('err')[0].code === 'unknown-session', 'subscribing to a pane that is gone is refused')

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

  late.socket.close()
  await waitFor(() => late.closed !== null, 5000, 'late socket to close')
  log(manager.list().some((s) => s.id === 'm1'), 'closing the phone does not kill the session')

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

  /* ---------------------------------------------------------------- done */

  manager.killAll()
  await server.stop()
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

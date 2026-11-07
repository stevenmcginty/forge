/**
 * Head-less proof of phone hands, the desk half (docs/PHONE-HANDS.md).
 *
 * Starts the *real* electron/mobile/server.ts and auth.ts standalone — the
 * mobile-smoke pattern, no Electron — mints a device token, and connects two
 * fake sockets with it: the phone's normal app socket and its native hands
 * socket (`role: "hands"`). Then drives electron/phone-hands.ts against them
 * over real WebSockets, and checks that the three tool lists agree.
 *
 *   npm run phone-hands:check
 *
 * And the J3 mode — a desk for a real phone or an emulator to dial into:
 *
 *   node scripts/phone-hands-check.mjs --serve 8490 [--token <device token>]
 *
 * keeps the server up on 0.0.0.0:<port>, prints a device token, a pairing
 * code the app can use, and Forge Hands pairing links (forgehands://pair?…,
 * for this machine's LAN address and for an emulator; `--host <h>` picks the
 * LAN one), and takes ops two ways: one line on stdin
 * (`read`, `tap {"n":3}`, `open_link {"url":"https://wa.me/447..."}`, `pair`
 * for a fresh Forge Hands link), or HTTP on 127.0.0.1:<port+1> —
 * POST /op {"op":"read","args":{}}, GET /status, GET /pair, GET /pair-hands.
 * Pictures are saved and their path printed.
 */
import './ts-hooks.mjs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { WebSocket } from 'ws'
// Never hand a check the environment's AI keys (this shell's may be someone else's, refused).
for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k]

const ROOT = resolve(import.meta.dirname, '..')
const { MobileServer } = await import('../electron/mobile/server.ts')
const { MobileAuth, hashToken } = await import('../electron/mobile/auth.ts')
const PH = await import('../electron/phone-hands.ts')
const SPEC = await import('../shared/phone-hands-spec.mjs')
const { handsPairLink } = await import('../shared/mobile.ts')

const WS_PATH = '/link'

function freePort() {
  return new Promise((res, rej) => {
    const probe = createNetServer()
    probe.once('error', rej)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => res(port))
    })
  })
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((res, rej) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return res()
      if (Date.now() - started > timeoutMs) return rej(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A fake socket. Collects every frame it is sent and how it closed. */
function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`)
  const peer = {
    socket,
    frames: [],
    closed: null,
    send: (frame) => socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
    first: (t) => peer.frames.find((f) => f.t === t),
    of: (t) => peer.frames.filter((f) => f.t === t),
    onFrame: null
  }
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    peer.frames.push(frame)
    peer.onFrame?.(frame)
  })
  socket.on('close', (code) => {
    peer.closed = code
  })
  socket.on('error', () => {})
  return new Promise((res) => {
    socket.on('open', () => res(peer))
    socket.on('error', () => res(peer))
  })
}

function makeAuth(devices) {
  return new MobileAuth({ load: () => devices, save: (next) => devices.splice(0, devices.length, ...next), pairTtlMs: 30 * 60_000 })
}

function makeServer(auth, hands, extra = {}) {
  const server = new MobileServer({
    auth,
    appVersion: '0.0.0-phone-hands',
    desktopName: () => 'phone-hands-check',
    sessions: () => [],
    replay: () => '',
    write: () => false,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    dispatchOp: async () => 'This is the phone-hands test desk; it has no layout.',
    onHands: (event) => hands.handle(event),
    ...extra
  })
  hands.setLink({ send: (socketId, frame) => server.sendHands(socketId, frame) })
  return server
}

/* ==================================================================== serve */

/** A Forge Hands pairer over a test auth, built the way mobile-host's mintHandsPairing builds one. */
function handsPairer(auth, host, port) {
  return () => {
    const offer = auth.offerPairing('hands')
    return { ok: true, token: offer.token, expiresAt: offer.expiresAt, ttlMs: 0, host, port, url: '', link: handsPairLink(host, port, false, offer.token) }
  }
}

/** This machine's first non-internal IPv4 address, for a LAN link. */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '127.0.0.1'
}

async function serve(port, pinnedToken, lanHost) {
  const devices = []
  const auth = makeAuth(devices)
  let token = pinnedToken
  if (token) {
    devices.push({ id: 'j3-phone', name: 'Test phone', tokenHash: hashToken(token), createdAt: Date.now(), lastSeenAt: 0 })
  } else {
    token = auth.mintDevice('j3-phone', 'Test phone').issuedToken
  }
  const hands = new PH.PhoneHands()
  hands.onChange(() => console.log(`[hands] ${JSON.stringify(hands.status())}`))
  const server = makeServer(auth, hands, { log: (line) => console.log(line) })
  await server.start({ host: '0.0.0.0', port })
  const shotDir = mkdtempSync(join(tmpdir(), 'forge-phone-looks-'))
  const pair = auth.offerPairing()
  hands.setPairer(handsPairer(auth, lanHost, port))

  const run = async (op, args) => {
    if (op === 'pair') return hands.pair()
    const reply = await hands.request(op, args ?? {})
    if (reply.ok && reply.image) {
      const saved = await PH.phoneLinkOp(`phone_${op}`, {}, { shotDir, hands: { request: async () => reply } })
      return { ok: true, text: reply.text, imagePath: saved.imagePath, imageBase64Chars: reply.image.length, mime: reply.mime }
    }
    return reply
  }

  const http = createHttpServer((req, res) => {
    const answer = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2))
    if (req.method === 'GET' && req.url === '/status') return answer(200, hands.status())
    if (req.method === 'GET' && req.url === '/pair') return answer(200, auth.offerPairing())
    if (req.method === 'GET' && req.url === '/pair-hands') {
      const offer = auth.offerPairing('hands')
      return answer(200, { ...offer, link: handsPairLink(lanHost, port, false, offer.token), emulatorLink: handsPairLink('10.0.2.2', port, false, offer.token) })
    }
    if (req.method === 'POST' && req.url === '/op') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const { op, args } = JSON.parse(body || '{}')
          answer(200, await run(String(op), args))
        } catch (err) {
          answer(400, { ok: false, error: String(err?.message ?? err) })
        }
      })
      return
    }
    answer(404, { error: 'POST /op, GET /status, GET /pair, GET /pair-hands' })
  })
  await new Promise((r) => http.listen(port + 1, '127.0.0.1', r))

  console.log(`phone-hands test desk on 0.0.0.0:${port} (ws path ${WS_PATH}); emulator: ws://10.0.2.2:${port}${WS_PATH}`)
  console.log(`device token: ${token}`)
  console.log(`pairing code (30 min, one use): ${pair.token}`)
  // One Forge Hands offer, two addresses for it: whichever the phone uses spends it.
  const handsOffer = auth.offerPairing('hands')
  console.log(`Forge Hands link (30 min, one use; "pair" on stdin or GET /pair-hands for a fresh one):`)
  console.log(`  LAN:      ${handsPairLink(lanHost, port, false, handsOffer.token)}`)
  console.log(`  emulator: ${handsPairLink('10.0.2.2', port, false, handsOffer.token)}`)
  console.log(`ops: one per line on stdin, e.g. "read" or 'tap {"n":3}'; or POST http://127.0.0.1:${port + 1}/op {"op":"read","args":{}}`)

  const lines = createInterface({ input: process.stdin })
  lines.on('line', async (line) => {
    const m = line.trim().match(/^(\w+)\s*(.*)$/)
    if (!m) return
    let args = {}
    try {
      args = m[2] ? JSON.parse(m[2]) : {}
    } catch {
      console.log('args must be JSON')
      return
    }
    console.log(JSON.stringify(await run(m[1], args), null, 2))
  })
  const stop = async () => {
    await server.stop()
    http.close()
    rmSync(shotDir, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGINT', stop)
}

/* ==================================================================== check */

let passed = 0
let failed = 0
function ok(cond, label, detail) {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
const LOCKED = 'The phone is locked. Ask Steve to unlock it, then try again.'

async function check() {
  const port = await freePort()
  const devices = []
  const auth = makeAuth(devices)
  const { issuedToken: token } = auth.mintDevice('pixel-10', 'Pixel 10 Pro XL')
  const hands = new PH.PhoneHands({ timeoutMs: 600 })
  const handsEvents = []
  let presence = []
  const server = makeServer(auth, hands, {
    onPresence: (n) => presence.push(n),
    // Every desk-side hook a stray frame could reach, spied: none may fire.
    foremanStart: async () => {
      handsEvents.push('foremanStart')
      return { ok: true }
    }
  })
  const realHandle = hands.handle.bind(hands)
  hands.handle = (event) => {
    handsEvents.push(event.kind)
    realHandle(event)
  }
  await server.start({ host: '127.0.0.1', port })
  const shotDir = mkdtempSync(join(tmpdir(), 'forge-phone-hands-check-'))

  try {
    console.log('phone hands — the socket')
    ok(hands.request('status') instanceof Promise, 'phoneOp is a promise')
    const before = await hands.request('status')
    ok(!before.ok && before.error === SPEC.PHONE_NOT_CONNECTED, 'with no hands socket, the answer is the not-connected sentence', before)

    const app = await connect(port)
    app.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', deviceName: 'Pixel', token })
    await waitFor(() => app.first('hello-ok'), 3000, 'app hello-ok')
    ok(!!app.first('hello-ok'), 'the app socket authenticates with the device token')
    presence = []

    const phone = await connect(port)
    // The fake phone: answers by op, in both dialects (`t` and `type`).
    const seenReqs = []
    phone.onFrame = (f) => {
      if (f.t !== 'hands:req') return
      seenReqs.push(f)
      const id = f.id
      switch (f.op) {
        case 'status':
          phone.send({ type: 'hands:res', id, ok: true, text: 'Switch on. Accessibility on. App: Uber (com.ubercab)' })
          break
        case 'look':
          phone.send({ t: 'hands:res', id, ok: true, text: 'App: Uber (com.ubercab)', image: JPEG.toString('base64'), mime: 'image/jpeg' })
          break
        case 'tap':
          phone.send({ type: 'hands:res', id, ok: false, error: LOCKED })
          break
        case 'scroll':
          break // never answers: the timeout path
        case 'read':
          setTimeout(() => phone.send({ t: 'hands:res', id, ok: true, text: `App: WhatsApp (com.whatsapp)\n[1] button "Send" (clickable) args=${JSON.stringify(f.args)}` }), 50)
          break
      }
    }
    phone.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', deviceName: 'Pixel hands', token, role: 'hands' })
    await waitFor(() => phone.first('hello-ok'), 3000, 'hands hello-ok')
    const helloOk = phone.first('hello-ok')
    ok(!!helloOk, 'the hands socket authenticates with the same device token')
    ok(!helloOk.deviceToken && helloOk.sessions.length === 0 && helloOk.projects.length === 0 && !helloOk.features, 'its hello-ok is bare: no token, no sessions, no projects, no features', helloOk)
    await waitFor(() => hands.connected, 2000, 'hands connected')
    ok(hands.connected && hands.status().connected, 'phone-hands hears the socket open')

    await sleep(150)
    ok(app.closed === null && app.socket.readyState === WebSocket.OPEN, 'the app socket stays open after the hands socket joins')
    ok(server.connectedCount === 1, 'the hands socket is not counted as a phone (presence unchanged)', server.connectedCount)
    ok(presence.length === 0, 'and onPresence did not fire for it', presence)
    app.send({ t: 'ping' })
    await waitFor(() => app.first('pong'), 2000, 'app pong')
    ok(!!app.first('pong'), 'the app socket still works (ping → pong)')

    phone.send({ type: 'hands:status', accessibility: true, notifications: false, contacts: true, enabled: true, screenOn: true, locked: false, app: 'com.ubercab', version: '1.2.3' })
    await waitFor(() => hands.status().accessibility === true, 2000, 'status recorded')
    const st = hands.status()
    ok(st.accessibility === true && st.notifications === false && st.enabled === true && st.app === 'com.ubercab' && st.version === '1.2.3', 'the last hands:status is kept (sent with `type`)', st)

    console.log('phone hands — pushes stay off the hands socket')
    const handsFramesBefore = phone.frames.length
    server.pushState({ sessions: [] })
    server.pushDesktop('ready')
    server.pushRemoteYes({ enabled: true, prompt: null })
    server.pushForeman({ paneId: 'p', status: 'idle' })
    server.pushHandoff('proj', [])
    server.pushData('nope', 'x')
    await waitFor(() => app.first('state') && app.first('desktop') && app.first('remote-yes') && app.first('foreman') && app.first('handoff'), 2000, 'app pushes')
    await sleep(100)
    ok(['state', 'desktop', 'remote-yes', 'foreman', 'handoff'].every((t) => app.of(t).length === 1), 'the app socket got state, desktop, remote-yes, foreman and handoff')
    ok(phone.frames.length === handsFramesBefore, 'the hands socket got none of them', phone.frames.slice(handsFramesBefore))

    console.log('phone hands — requests')
    const status = await hands.request('status', {})
    ok(status.ok && status.text.startsWith('Switch on.'), 'phoneOp round-trips text (answer sent with `type`)', status)
    const req = seenReqs.find((r) => r.op === 'status')
    ok(req && req.t === 'hands:req' && req.type === 'hands:req' && typeof req.id === 'string' && req.id.length >= 32, 'the request frame carries t and type "hands:req" and a uuid id', req)

    const read = await PH.phoneOp('read')
    ok(!read.ok && read.error === SPEC.PHONE_NOT_CONNECTED, 'the shared instance (phoneOp) is not this test’s: not connected', read)

    const args = { n: 4, long: true }
    const readOwn = await hands.request('read', args)
    ok(readOwn.ok && readOwn.text.includes(`args=${JSON.stringify(args)}`), 'args reach the phone unchanged', readOwn)

    const look = await PH.phoneLinkOp('phone_look', {}, { shotDir, hands })
    ok(look.ok && look.text === 'App: Uber (com.ubercab)' && typeof look.imagePath === 'string' && existsSync(look.imagePath), 'phone_look over the pipe: text plus a saved picture', look)
    ok(look.imagePath && readFileSync(look.imagePath).equals(JPEG) && look.imagePath.endsWith('.jpg'), 'the saved picture is the phone’s JPEG, byte for byte')

    const brain = PH.phoneBrainTools(hands)
    const brainLook = await brain.find((t) => t.name === 'phone_look').handler({})
    const img = brainLook.content.find((c) => c.type === 'image')
    ok(img && img.mimeType === 'image/jpeg' && img.data === JPEG.toString('base64') && brainLook.content[0].text === 'App: Uber (com.ubercab)', 'phone_look for the brains: text plus an inline image/jpeg', brainLook)

    const tap = await hands.request('tap', { n: 3 })
    ok(!tap.ok && tap.error === LOCKED, 'ok:false passes the phone’s error through verbatim', tap)
    const tapPipe = await PH.phoneLinkOp('phone_tap', { n: 3 }, { shotDir, hands })
    ok(!tapPipe.ok && tapPipe.text === LOCKED, 'and over the pipe', tapPipe)
    const tapBrain = await brain.find((t) => t.name === 'phone_tap').handler({ n: 3 })
    ok(tapBrain.content[0].text === LOCKED, 'and for the brains', tapBrain)

    const t0 = Date.now()
    const scroll = await hands.request('scroll', { direction: 'down' })
    const took = Date.now() - t0
    ok(!scroll.ok && scroll.error === SPEC.PHONE_TIMED_OUT && took >= 550 && took < 3000, `a phone that never answers times out with the contract sentence (${took} ms at a 600 ms test timeout)`, scroll)
    ok(SPEC.PHONE_TIMEOUT_MS === 15_000 && SPEC.PHONE_TIMED_OUT === 'The phone did not answer in 15 s.', 'the shipped timeout is 15 s, and the sentence says so')
    const late = seenReqs.find((r) => r.op === 'scroll')
    phone.send({ t: 'hands:res', id: late.id, ok: true, text: 'late' })
    await sleep(100)
    const again = await hands.request('status')
    ok(again.ok && again.text.startsWith('Switch on.') && phone.closed === null, 'a late answer to a timed-out request is dropped without harm: the next request still works', again)

    console.log('phone hands — a hands socket may say only ping, hands:res, hands:status')
    const framesBefore = phone.frames.length
    const eventsBefore = handsEvents.length
    phone.send({ t: 'sub', id: 'x' })
    phone.send({ t: 'write', id: 'x', data: 'rm -rf /' })
    phone.send({ t: 'op', id: 'o1', op: { kind: 'closeTab', tabId: 't' } })
    phone.send({ t: 'foreman-start', paneId: 'p', seed: 'x' })
    phone.send({ t: 'mirror-start' })
    phone.send({ t: 'hello', proto: 1, deviceId: 'x', token })
    phone.send('this is not json')
    phone.send({ nothing: true })
    await sleep(200)
    ok(phone.closed === null && phone.socket.readyState === WebSocket.OPEN, 'non-allowed frames do not close the hands socket')
    ok(phone.frames.length === framesBefore, 'and are ignored: no answer, no err frame', phone.frames.slice(framesBefore))
    ok(handsEvents.length === eventsBefore, 'and reach no host hook', handsEvents.slice(eventsBefore))
    phone.send({ type: 'ping' })
    await waitFor(() => phone.first('pong'), 2000, 'hands pong')
    ok(!!phone.first('pong'), 'ping still works on it (sent with `type`)')

    app.send({ t: 'hands:res', id: 'x', ok: true, text: 'from the app' })
    app.send({ t: 'hands:status', accessibility: false })
    await sleep(150)
    ok(hands.status().accessibility === true, 'hands frames from the app socket are not taken as the phone’s')
    ok(app.closed === null, 'and the app socket is left open')

    console.log('phone hands — refusals')
    const noToken = await connect(port)
    noToken.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', role: 'hands', requestPair: true })
    await waitFor(() => noToken.closed !== null, 3000, 'no-token close')
    ok(noToken.closed === 4001, 'a hands hello with no token is refused (4001), never sent to the approval door', noToken.closed)
    const pairCode = await connect(port)
    pairCode.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', role: 'hands', token: auth.offerPairing().token })
    await waitFor(() => pairCode.closed !== null, 3000, 'pair-code close')
    ok(pairCode.closed === 4001 && auth.pendingOffer() !== null, 'a pairing code cannot open a hands socket, and the offer is not spent')
    auth.cancelPairing?.()
    const wrong = await connect(port)
    wrong.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', role: 'hands', token: 'x'.repeat(43) })
    await waitFor(() => wrong.closed !== null, 3000, 'wrong-token close')
    ok(wrong.closed === 4001, 'a wrong device token is refused (4001)')
    ok(hands.connected && app.closed === null, 'none of that touched the live sockets')

    console.log('phone hands — the newest socket is used, and goes away cleanly')
    const phone2 = await connect(port)
    phone2.onFrame = (f) => {
      if (f.t === 'hands:req') phone2.send({ t: 'hands:res', id: f.id, ok: true, text: 'second socket' })
    }
    phone2.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', token, role: 'hands' })
    await waitFor(() => phone2.first('hello-ok'), 3000, 'second hands hello-ok')
    await sleep(50)
    const second = await hands.request('status')
    ok(second.ok && second.text === 'second socket', 'a request goes to the most recently connected hands socket', second)
    ok(phone.closed === null, 'the older hands socket was not displaced')
    phone2.socket.close()
    await waitFor(() => phone2.closed !== null, 2000, 'phone2 closed')
    await sleep(100)
    const back = await hands.request('status')
    ok(back.ok && back.text.startsWith('Switch on.'), 'when it closes, the older one answers again', back)

    // Mid-request hang-up: answered at once, not after the timeout.
    const pendingScroll = hands.request('scroll', { direction: 'up' })
    await sleep(50)
    phone.socket.close()
    const cut = await pendingScroll
    ok(!cut.ok && /disconnected/.test(cut.error), 'a hang-up mid-request answers in words straight away', cut)
    await waitFor(() => !hands.connected, 2000, 'hands disconnected')
    const after = await hands.request('status')
    ok(!after.ok && after.error === SPEC.PHONE_NOT_CONNECTED, 'with the hands socket gone: the not-connected sentence', after)
    ok(app.closed === null && server.connectedCount === 1, 'and the app socket is still there')
    ok(handsEvents.includes('open') && handsEvents.includes('close') && handsEvents.includes('res') && handsEvents.includes('status'), 'onHands saw open, status, res and close', [...new Set(handsEvents)])

    const phone3 = await connect(port)
    phone3.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', token, role: 'hands' })
    await waitFor(() => phone3.first('hello-ok'), 3000, 'third hands hello-ok')
    server.disconnectDevice('pixel-10')
    await waitFor(() => phone3.closed !== null && app.closed !== null, 2000, 'revoke closes both')
    ok(phone3.closed === 4003 && app.closed === 4003, 'revoking the device closes its hands socket with its app socket')

    const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')
    const host = new VoiceAgentHost({ sendEvent() {}, sendToolRequest() {}, getModel: () => 'opus', getBrain: () => 'codex-cli' })
    const ptOf = (link) => new URL(String(link).replace('forgehands://', 'http://x/')).searchParams.get('pt')

    console.log('Forge Hands — the link')
    ok(
      handsPairLink('cure-task-legroom.ngrok-free.dev', 0, true, 'abc_-123') === 'forgehands://pair?host=cure-task-legroom.ngrok-free.dev&scheme=wss&pt=abc_-123',
      'handsPairLink, tunnel: forgehands://pair?host=<domain>&scheme=wss&pt=<code>, no port'
    )
    ok(
      handsPairLink('192.168.1.20', 8420, false, 'abc') === 'forgehands://pair?host=192.168.1.20&port=8420&pt=abc',
      'handsPairLink, LAN: forgehands://pair?host=<ip>&port=<port>&pt=<code>'
    )
    ok(handsPairLink('', 8420, false, 'abc') === '' && handsPairLink('h', 8420, false, '') === '', 'handsPairLink: no host or no code, no link')

    console.log('Forge Hands — phone_pair runs on the PC, with no phone connected')
    ok(!hands.connected, 'no hands socket is open now')
    const offPair = hands.pair()
    ok(!offPair.ok && offPair.error === SPEC.PHONE_PAIR_OFF, 'with no pairer (phone link off), phone_pair says so in words', offPair)
    const offLink = await host.callLinkTool('phone_pair', {})
    ok(offLink.content?.[0]?.text === SPEC.PHONE_PAIR_OFF, 'and through the brain link (the shared instance has no pairer in this process)', offLink)
    const normalOffer = auth.offerPairing()
    hands.setPairer(handsPairer(auth, '127.0.0.1', port))
    const piped = await PH.phoneLinkOp('phone_pair', {}, { shotDir, hands })
    const pairLine = piped.text?.split('\n') ?? []
    ok(piped.ok && /^forgehands:\/\/pair\?host=127\.0\.0\.1&port=\d+&pt=[\w-]{22}$/.test(pairLine[0]), 'phone_pair over the pipe: the first line is a forgehands://pair link', piped)
    ok(
      pairLine[1] === SPEC.PHONE_PAIR_WORDS &&
        SPEC.PHONE_PAIR_WORDS === 'Tap this link on your phone (works once, for 5 minutes). If tapping does nothing, long-press it, copy it, then open Forge Hands - it offers to use the copied link.',
      'then the contract’s words, word for word'
    )
    ok(pairLine[2] === SPEC.PHONE_PAIR_LAN_NOTE, 'and, with no tunnel, the home-network note')
    ok(auth.pendingOffer() === normalOffer, 'minting a Forge Hands link leaves the Forge Mobile QR offer live')
    auth.cancelPairing()
    const viaBrain = await brain.find((t) => t.name === 'phone_pair').handler({})
    const brainLink = viaBrain.content[0].text.split('\n')[0]
    ok(brainLink.startsWith('forgehands://pair?') && brainLink !== pairLine[0], 'phone_pair for the brains: a fresh link, replacing the last', viaBrain)
    const code = ptOf(brainLink)
    ok(code === auth.pendingOffer('hands')?.token, 'its code is the live Forge Hands offer')

    console.log('Forge Hands — a hands-scoped device')
    const stale = await connect(port)
    stale.send({ t: 'hello', proto: 1, deviceId: 'helper-1', role: 'hands', token: ptOf(pairLine[0]) })
    await waitFor(() => stale.closed !== null, 3000, 'replaced-code close')
    ok(stale.closed === 4001, 'the replaced code is dead (4001)')
    const asApp = await connect(port)
    asApp.send({ t: 'hello', proto: 1, deviceId: 'helper-1', deviceName: 'Forge Hands (Pixel 10)', token: code })
    await waitFor(() => asApp.closed !== null, 3000, 'hands-code-as-app close')
    ok(asApp.closed === 4001 && auth.pendingOffer('hands') !== null, 'a Forge Hands code cannot pair Forge Mobile (no role hands), and the offer is not spent')
    const helper = await connect(port)
    helper.send({ t: 'hello', proto: 1, deviceId: 'helper-1', deviceName: 'Forge Hands (Pixel 10)', role: 'hands', token: code })
    await waitFor(() => helper.first('hello-ok') || helper.closed !== null, 3000, 'helper hello-ok')
    const helperOk = helper.first('hello-ok')
    const handsToken = helperOk?.deviceToken
    ok(typeof handsToken === 'string' && handsToken.length === 43, 'a Forge Hands code pairs with role hands, and hello-ok returns a device token', helperOk)
    ok(helperOk && helperOk.sessions.length === 0 && helperOk.projects.length === 0 && !helperOk.features, 'that hello-ok is otherwise bare', helperOk)
    ok(auth.pendingOffer('hands') === null, 'the offer is spent')
    const record = devices.find((d) => d.tokenHash === hashToken(handsToken ?? ''))
    ok(record && record.scope === 'hands' && record.id === 'hands-helper-1' && record.name === 'Forge Hands (Pixel 10)', 'the device is saved with scope hands, its own id and the helper’s name', record)
    ok(devices.some((d) => d.id === 'pixel-10' && !d.scope), 'the Forge Mobile device is untouched')
    await waitFor(() => hands.connected, 2000, 'helper connected')
    ok(hands.connected, 'phone-hands hears the helper’s socket open')
    helper.socket.close()
    await waitFor(() => !hands.connected, 2000, 'helper closed')

    const resumed = await connect(port)
    resumed.send({ t: 'hello', proto: 1, deviceId: 'hands-helper-1', role: 'hands', token: handsToken })
    await waitFor(() => resumed.first('hello-ok') || resumed.closed !== null, 3000, 'hands resume')
    ok(!!resumed.first('hello-ok') && !resumed.first('hello-ok').deviceToken, 'the hands token resumes with role hands (no new token)')
    resumed.socket.close()
    const escalate = await connect(port)
    escalate.send({ t: 'hello', proto: 1, deviceId: 'hands-helper-1', token: handsToken })
    await waitFor(() => escalate.closed !== null, 3000, 'hands-token-as-app close')
    ok(escalate.closed === 4001 && !escalate.first('hello-ok') && escalate.first('err')?.code === 'auth', 'the hands token is REFUSED without role hands (4001, err auth)', escalate.frames)
    const appRole = await connect(port)
    appRole.send({ t: 'hello', proto: 1, deviceId: 'hands-helper-1', token: handsToken, role: 'app' })
    await waitFor(() => appRole.closed !== null, 3000, 'hands-token-role-app close')
    ok(appRole.closed === 4001, 'and with any other role')

    const normalApp = await connect(port)
    normalApp.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', token })
    const normalHands = await connect(port)
    normalHands.send({ t: 'hello', proto: 1, deviceId: 'pixel-10', token, role: 'hands' })
    await waitFor(() => (normalApp.first('hello-ok') || normalApp.closed !== null) && (normalHands.first('hello-ok') || normalHands.closed !== null), 3000, 'normal token both ways')
    ok(!!normalApp.first('hello-ok') && !!normalHands.first('hello-ok'), 'a normal token still works both ways: app and hands')
    normalApp.socket.close()
    normalHands.socket.close()

    console.log('phone hands — the three name lists agree')
    const { PHONE_TOOLS, PHONE_HANDLERS, PHONE_INSTRUCTION_LINE } = await import('../bridge/phone-tools.mjs')
    const bridgeNames = PHONE_TOOLS.map((t) => t.name)
    const brainNames = brain.map((t) => t.name)
    const contract = ['status', 'look', 'read', 'tap', 'type', 'scroll', 'key', 'open_app', 'open_link', 'apps', 'notifications', 'reply', 'find_contact']
    ok(JSON.stringify(SPEC.PHONE_OPS) === JSON.stringify(contract), 'the spec has the contract’s thirteen ops, in order')
    ok(JSON.stringify(bridgeNames) === JSON.stringify([...contract.map((op) => `phone_${op}`), 'phone_pair']), 'PHONE_TOOLS is phone_<op> for every op, then phone_pair', bridgeNames)
    ok(bridgeNames.includes('phone_pair') && brainNames.includes('phone_pair') && PH.PHONE_LINK_OPS.includes('phone_pair'), 'phone_pair is in all three name lists')
    ok(JSON.stringify(bridgeNames) === JSON.stringify(brainNames), 'PHONE_TOOLS names == phoneBrainTools names', brainNames)
    ok(JSON.stringify(bridgeNames) === JSON.stringify([...PH.PHONE_LINK_OPS]), 'PHONE_TOOLS names == PHONE_LINK_OPS', PH.PHONE_LINK_OPS)
    ok(bridgeNames.every((n) => typeof PHONE_HANDLERS[n] === 'function'), 'every bridge tool has a handler')
    ok(JSON.stringify(PH.PHONE_BRAIN_ALLOWED) === JSON.stringify(bridgeNames.map((n) => `mcp__forge__${n}`)), 'PHONE_BRAIN_ALLOWED names every one as mcp__forge__<name>')
    ok(PHONE_TOOLS.every((t, i) => t.description === brain[i].description), 'pane and brain tools share each description word for word')
    const allSpecs = [...SPEC.PHONE_TOOL_SPECS, SPEC.PHONE_PAIR_SPEC]
    ok(PHONE_TOOLS.length === allSpecs.length && PHONE_TOOLS.every((t, i) => JSON.stringify(t.inputSchema.required) === JSON.stringify(allSpecs[i].required)), 'bridge schemas carry the spec’s required lists')

    const defNames = host.listLinkTools().map((t) => t.name).filter((n) => n.startsWith('phone_'))
    ok(JSON.stringify(defNames) === JSON.stringify(bridgeNames), 'forgeToolDefs phone_* names == PHONE_TOOLS names', defNames)
    const viaLink = await host.callLinkTool('phone_status', {})
    ok(viaLink.content?.[0]?.text === SPEC.PHONE_NOT_CONNECTED, 'a brain-link call reaches phone-hands (not connected in this process)', viaLink)

    const src = (p) => readFileSync(join(ROOT, p), 'utf8')
    const hostSrc = src('electron/voice-agent/host.ts')
    ok(/\.\.\.PHONE_BRAIN_ALLOWED,/.test(hostSrc), 'host.ts allowedTools spreads PHONE_BRAIN_ALLOWED (canUseTool lets them through)')
    const gated = hostSrc.match(/const GATED_TOOLS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
    ok(gated.length > 0 && !/phone_/.test(gated), 'no phone tool is in GATED_TOOLS', gated)
    const appOps = src('electron/browser-panes/service.ts').match(/export const APP_LINK_OPS[^\n]*/)?.[0] ?? ''
    ok(/\.\.\.PHONE_LINK_OPS/.test(appOps) && /\.\.\.DESKTOP_LINK_OPS/.test(appOps), 'APP_LINK_OPS lets PHONE_LINK_OPS through the pipe, beside DESKTOP_LINK_OPS', appOps)
    ok(/if \(isPhoneOp\(op\)\) return phoneLinkOp\(/.test(src('electron/browser-panes/ipc.ts')), 'ipc.ts routes phone ops to phoneLinkOp')
    ok(/PHONE_INSTRUCTION_LINE/.test(src('bridge/gemini-bridge.mjs')) && PHONE_INSTRUCTION_LINE.includes('Any app:'), 'forge-bridge instructions carry the phone line, general recipe first')
    const { PHONE_HANDS_RULES } = await import('../shared/brain-persona.ts')
    ok(PHONE_HANDS_RULES.indexOf('Any app:') < PHONE_HANDS_RULES.indexOf('Example, Uber') && PHONE_HANDS_RULES.includes('wait for yes'), 'the persona puts the general recipe before the examples, with the confirm rule')
    ok(
      PHONE_HANDS_RULES.includes('Forge Hands') && PHONE_HANDS_RULES.includes('use phone_pair') && PHONE_INSTRUCTION_LINE.includes('Forge Hands') && PHONE_INSTRUCTION_LINE.includes('use phone_pair'),
      'persona and forge-bridge instructions name Forge Hands and say when to use phone_pair'
    )
    ok(
      SPEC.PHONE_NOT_CONNECTED === "The phone is not connected. Open Forge Hands on the phone and turn on 'Let Forge use this phone'. If it was never set up, use phone_pair.",
      'the not-connected sentence is the v2 contract’s, word for word'
    )
  } finally {
    await server.stop()
    rmSync(shotDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

const at = process.argv.indexOf('--serve')
if (at >= 0) {
  const port = Number(process.argv[at + 1]) || 8490
  const t = process.argv.indexOf('--token')
  const h = process.argv.indexOf('--host')
  await serve(port, t >= 0 ? process.argv[t + 1] : '', h >= 0 ? process.argv[h + 1] : lanAddress())
} else {
  await check()
}

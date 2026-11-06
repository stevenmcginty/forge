/**
 * A throwaway "desk" for exercising the phone-hands socket without Forge.
 *
 * It is NOT the real desk: no Origin/token check, no displacement rules. It
 * serves /link, answers the phone's hello with a minimal hello-ok (the shape
 * of HelloOkFrame in shared/mobile.ts), prints every hands:status the phone
 * pushes, and then fires a scripted list of hands:req ops, printing each
 * hands:res — the base64 image is reported only by its length, never dumped.
 *
 *   node scripts/phone-hands-fake-desk.mjs --port 8799 \
 *     '{"op":"status"}' \
 *     '{"op":"open_link","args":{"url":"https://example.com"}}' \
 *     '{"op":"read"}'
 *
 * Each positional argument is one op as JSON: {"op":"<name>","args":{...}}.
 * Flags: --port <n> (default 8799), --keep (stay open after the script),
 *         --timeout <ms> (per op, default 15000).
 */
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
let port = 8799
let keep = false
let timeoutMs = 15000
const ops = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--port') port = Number(argv[++i])
  else if (a === '--keep') keep = true
  else if (a === '--timeout') timeoutMs = Number(argv[++i])
  else ops.push(JSON.parse(a))
}

const HELLO_OK = {
  t: 'hello-ok',
  proto: 1,
  appVersion: '0.0.0-fakedesk',
  deviceName: 'Fake Desk',
  desktopName: 'Fake Desk',
  projects: [],
  profiles: [],
  workspaces: {},
  sessions: []
}

const wss = new WebSocketServer({ port, path: '/link' })
console.log(`[fake-desk] listening on ws://0.0.0.0:${port}/link  (reachable from the emulator as 10.0.2.2:${port})`)
console.log(`[fake-desk] ${ops.length} op(s) scripted`)

let handled = false

// Don't hang a test run forever if the phone never dials in.
const idleExit = setTimeout(() => {
  if (!handled) {
    console.log('[fake-desk] no phone connected in 45 s — exiting.')
    process.exit(2)
  }
}, 45000)

wss.on('connection', (ws, req) => {
  clearTimeout(idleExit)
  console.log(`[fake-desk] socket from ${req.socket.remoteAddress}  origin=${req.headers.origin ?? '-'}`)
  if (handled) {
    console.log('[fake-desk] a socket is already being driven; ignoring this one')
    return
  }
  handled = true

  const pending = new Map() // id -> { resolve, timer }

  ws.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    const kind = frame.t || frame.type
    if (kind === 'hello') {
      console.log(`[fake-desk] <- hello  role=${frame.role ?? 'app'}  deviceId=${frame.deviceId}  token=${frame.token ? `${frame.token.length} chars` : 'none'}`)
      ws.send(JSON.stringify(HELLO_OK))
      void runScript(ws, pending)
      return
    }
    if (kind === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }))
      return
    }
    if (kind === 'hands:status') {
      const { t, type, ...rest } = frame
      console.log('[fake-desk] <- hands:status', JSON.stringify(rest))
      return
    }
    if (kind === 'hands:res') {
      const entry = pending.get(frame.id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(frame.id)
        entry.resolve(frame)
      }
      return
    }
  })

  ws.on('close', () => console.log('[fake-desk] socket closed'))
  ws.on('error', (e) => console.log('[fake-desk] socket error', e.message))
})

async function runScript(ws, pending) {
  for (const spec of ops) {
    const id = randomUUID()
    const req = { t: 'hands:req', type: 'hands:req', id, op: spec.op, args: spec.args ?? {} }
    console.log(`\n[fake-desk] -> hands:req  op=${spec.op}  args=${JSON.stringify(req.args)}`)
    const res = await send(ws, pending, req)
    if (res === null) {
      console.log(`[fake-desk] <- (no answer in ${timeoutMs} ms) — "The phone did not answer in 15 s."`)
      continue
    }
    const image = typeof res.image === 'string' ? ` image=${res.image.length} base64 chars (${Math.round(res.image.length / 1024)} KB)` : ''
    if (res.ok) {
      console.log(`[fake-desk] <- hands:res ok=true${image}`)
      if (res.text) console.log(indent(res.text))
    } else {
      console.log(`[fake-desk] <- hands:res ok=false  error="${res.error}"`)
    }
  }
  console.log('\n[fake-desk] script done.')
  if (!keep) {
    setTimeout(() => process.exit(0), 300)
  }
}

function send(ws, pending, req) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.id)
      resolve(null)
    }, timeoutMs)
    pending.set(req.id, { resolve, timer })
    ws.send(JSON.stringify(req))
  })
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `      | ${l}`)
    .join('\n')
}

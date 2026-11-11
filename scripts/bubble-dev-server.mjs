/**
 * A dev desktop for Forge Bubble's link module (bubble/link).
 *
 * Runs the *real* Forge Web server (electron/web/server.ts) and the *real*
 * token door (electron/web/auth.ts), bundled with esbuild exactly the way
 * scripts/web-smoke.mjs does it, with only two things faked: Google's key set
 * (a self-signed certificate made here, so test JWTs verify) and the voice host
 * (a scripted stand-in for Claude Live on the desktop). Everything a phone would
 * meet on the wire — hello, refusals, the PIN lockout, request/result, the
 * voice-claude long poll, brain-confirm — is the shipped code.
 *
 *   node scripts/bubble-dev-server.mjs [--port 8493] [--pin 1234] [--confirm]
 *
 * Prints, one per line:
 *   READY ws://127.0.0.1:<port>/web
 *   TOKEN <a test Firebase ID token, valid one hour>
 *   CONTROL http://127.0.0.1:<port+1>
 *
 * CONTROL is a small HTTP side door for the link checks: GET /stats says what
 * the server saw (hello count per device, PIN sent or not — never the digits —
 * says, speaks, interrupts, brain-confirms, job taps), POST /restart drops every
 * socket and starts the server again on the same port. Both bind 127.0.0.1.
 */
import { createServer } from 'node:http'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
// Under bubble/link/build (git-ignored) rather than node_modules: in a worktree
// node_modules is a junction into the main checkout, and this is not its file.
// Inside the repo tree so the bundle's bare `ws` import still resolves.
const OUT_DIR = join(ROOT, 'bubble', 'link', 'build', 'dev-server')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}
const PORT = Number(option('--port', '8493'))
const CONTROL_PORT = PORT + 1
const PIN = option('--pin', '')
const WITH_CONFIRM = flag('--confirm')
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65000) throw new Error(`bad --port ${PORT}`)
if (PIN && !/^\d{4,12}$/.test(PIN)) throw new Error('--pin must be 4 to 12 digits')

const PROJECT = 'forge-bubble-dev'
const UID = 'BUBBLEdevUid0000000000000001'
const KID = 'bubbledev01'

/* ----------------------------------------------- a certificate, as web-smoke */

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

/* --------------------------------------------------------------- fake audio */

/** A 0.4 s 24 kHz PCM16 mono sine in a WAV header — the shape OpenAI TTS comes back as. */
function sineWav(seconds = 0.4, rate = 24000, hz = 440) {
  const samples = Math.round(seconds * rate)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm]).toString('base64')
}
const CLIP = sineWav()

/* ---------------------------------------------------------- the fake desktop */

const ASKING_PANE = 'pane-zeb'
const KESS_PANE = 'pane-kess'
const now = () => Date.now()

const STATUS = {
  ready: true,
  voiceModel: 'dev-voice',
  conductorModel: 'dev-conductor',
  voiceRoute: 'api',
  hasApiKey: true,
  conductorBusy: false
}

function job(id, title, state, extra = {}) {
  const at = now()
  return { id, title, owner: 'conductor', state, steps: [{ at, text: `${title}: ${state}` }], createdAt: at - 60_000, updatedAt: at, ...extra }
}

const brainStatus = (confirms) => ({
  enabled: true,
  engine: 'claude',
  state: 'idle',
  paneId: null,
  projectId: 'brain',
  sessionId: null,
  queued: 0,
  error: null,
  unavailable: {},
  confirms
})
let confirms = WITH_CONFIRM
  ? [{ id: 'c-close-tab', tool: 'run_app_action', summary: 'close the tab Zeb', risk: 'medium', at: now() }]
  : []

const stats = {
  hellos: [],
  opens: 0,
  closes: 0,
  dones: 0,
  says: [],
  speaks: [],
  interrupts: 0,
  latency: 0,
  confirms: [],
  jobs: [],
  restarts: 0
}

let ledgerSeq = 0

function voiceHost() {
  return {
    transcribeAudio: async (bytes) => {
      stats.dones++
      return bytes.length >= 2 ? { ok: true, text: 'what is running' } : { ok: true, text: '' }
    },
    voiceSpeak: async (text) => {
      stats.speaks.push(text)
      return { ok: true, audio: CLIP, mime: 'audio/wav' }
    },
    voiceClaudeOpen: (onEvent) => {
      stats.opens++
      let open = true
      const live = (event) => {
        if (open) onEvent({ type: 'live', event })
      }
      // What openWebLive queues at open: one status, one ledger.
      live({ type: 'status', status: STATUS })
      live({ type: 'ledger', snapshot: { jobs: [job('j-build', 'Build the bubble', 'running')], seq: ++ledgerSeq } })
      return {
        say: async (text, turnId) => {
          stats.says.push({ text, turnId: turnId ?? null })
          setTimeout(() => live({ type: 'say', turnId, text: 'Two agents are working. ', final: false }), 60)
          setTimeout(() => live({ type: 'say', turnId, text: 'Kess needs you.', final: true }), 140)
          setTimeout(() => {
            live({ type: 'turn-end', turnId, ok: true })
            live({ type: 'news', id: `n-kess-${stats.says.length}`, jobId: 'j-kess', text: 'Kess needs you to approve a file change.', urgency: 'needs-you' })
          }, 200)
          // The ledger trails the news by a beat, so a client is seen to make a
          // card from the news alone before the job it is about turns up.
          setTimeout(() => {
            live({
              type: 'ledger',
              snapshot: {
                jobs: [
                  job('j-kess', 'Approve the file change', 'needs-you', { paneId: KESS_PANE, paneName: 'Kess', owner: 'pane' }),
                  job('j-build', 'Build the bubble', 'running')
                ],
                seq: ++ledgerSeq
              }
            })
          }, 1700)
        },
        interrupt: async () => {
          stats.interrupts++
        },
        close: () => {
          open = false
          stats.closes++
        },
        job: async (jobId, action) => {
          stats.jobs.push({ jobId, action })
          return { ok: true }
        },
        latency: () => {
          stats.latency++
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const outfile = join(OUT_DIR, 'web-dev.mjs')
  await build({
    stdin: {
      contents: [
        "export { WebServer } from './electron/web/server'",
        "export { WebAuth } from './electron/web/auth'",
        "export { hashPin } from './electron/web/pin'"
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'bubble-dev-entry.ts',
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty', 'ws'],
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  const { WebServer, WebAuth, hashPin } = await import(pathToFileURL(outfile).href)

  const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const served = { [KID]: certificateFor(google, 'securetoken.google.com') }
  const nowSec = () => Math.floor(Date.now() / 1000)
  const mint = () => {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
    const payload = b64url(
      JSON.stringify({
        aud: PROJECT,
        iss: `https://securetoken.google.com/${PROJECT}`,
        sub: UID,
        auth_time: nowSec() - 300,
        iat: nowSec() - 60,
        exp: nowSec() + 3600
      })
    )
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(google.privateKey)
    return `${header}.${payload}.${signature.toString('base64url')}`
  }

  const pinHash = PIN ? hashPin(PIN) : ''
  // One door for the life of the process, so a lockout earned before a
  // restart is still there after it — as on a real desktop.
  const auth = new WebAuth({
    fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
    projectId: () => PROJECT,
    uid: () => UID,
    ...(PIN ? { pinHash: () => pinHash } : {})
  })
  const authenticate = auth.authenticate.bind(auth)
  auth.authenticate = async (request) => {
    stats.hellos.push({ deviceId: request.deviceId, pin: Boolean(request.pin), at: now() })
    return authenticate(request)
  }

  const session = { id: ASKING_PANE, cwd: join(ROOT, 'zeb'), cols: 80, rows: 24, bootstrapCommand: 'claude', startedAt: now() }
  const workspaces = {
    p1: { tabs: [{ id: 't-zeb', title: 'Zeb', root: { type: 'leaf', id: ASKING_PANE }, activePaneId: ASKING_PANE }], activeTabId: 't-zeb' }
  }

  let server = null
  const makeServer = () =>
    new WebServer({
      auth,
      appVersion: '0.0.0-bubble-dev',
      desktopName: () => 'BUBBLE-DEV',
      allowedOrigins: () => [],
      sessions: () => [session],
      replay: () => '',
      write: () => false,
      resize: () => true,
      snapshot: () => ({
        projects: [{ id: 'p1', name: 'forge', path: ROOT, color: '#7C5CFF', defaultProfileId: 'shell', createdAt: 0 }],
        profiles: [{ id: 'shell', name: 'Shell', command: '', accent: '#888', badge: 'SH' }],
        workspaces,
        ...(WITH_CONFIRM ? { brain: brainStatus(confirms) } : {})
      }),
      layout: async () => null,
      ...(WITH_CONFIRM
        ? {
            brainConfirm: (id, allow) => {
              if (!confirms.some((c) => c.id === id)) return false
              stats.confirms.push({ id, allow })
              confirms = confirms.filter((c) => c.id !== id)
              setTimeout(() => server?.pushBrain(brainStatus(confirms)), 10)
              return true
            }
          }
        : {}),
      ...voiceHost()
    })

  const startServer = async () => {
    server = makeServer()
    await server.start({ host: '127.0.0.1', port: PORT })
    // A pane settled on a question: replayed to every socket right after hello-ok.
    server.pushAttention(ASKING_PANE, true, 'Allow edit to app.ts?')
    if (WITH_CONFIRM) server.pushBrain(brainStatus(confirms))
  }
  await startServer()

  const control = createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/stats') return reply(200, stats)
    if (req.method === 'POST' && req.url === '/restart') {
      stats.restarts++
      void (async () => {
        await server.stop({ reason: 'restart', message: 'Forge is restarting.' })
        await new Promise((r) => setTimeout(r, 300))
        await startServer()
        reply(200, { ok: true })
      })().catch((err) => reply(500, { ok: false, error: String(err?.message ?? err) }))
      return
    }
    reply(404, { ok: false })
  })
  await new Promise((r) => control.listen(CONTROL_PORT, '127.0.0.1', r))

  console.log(`READY ws://127.0.0.1:${PORT}/web`)
  console.log(`TOKEN ${mint()}`)
  console.log(`CONTROL http://127.0.0.1:${CONTROL_PORT}`)

  const quit = async () => {
    control.close()
    await server?.stop({ reason: 'quit', message: 'Dev server stopping.' }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

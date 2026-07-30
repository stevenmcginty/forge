/**
 * Sidecar smoke test — drives stt/stt_service.py over its real line protocol.
 *
 *   node scripts/stt-smoke.mjs                       stub engine, WAV fake mic
 *   node scripts/stt-smoke.mjs --real                 load the actual model
 *   node scripts/stt-smoke.mjs --real --mic           ...and use the real mic
 *   node scripts/stt-smoke.mjs --wav path.wav         pick the WAV to feed
 *   node scripts/stt-smoke.mjs --bad-model            prove the degraded path
 *
 * Asserts: the port is announced, `ready` arrives, `state` round-trips,
 * `level` events flow while listening, phrases come back, auto-stop fires and
 * shutdown is clean.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const PY = val('--python', 'C:/Users/steve/Desktop/DictationMic/venv/Scripts/python.exe')
const MODEL = has('--bad-model')
  ? 'C:/nope/not/a/model'
  : val('--model', 'C:/Users/steve/Desktop/DictationMic/models/parakeet-tdt-0.6b-v2')
const WAV = val('--wav', join(ROOT, 'scripts', 'fixtures', 'speech.wav'))
const AUTO_STOP = val('--auto-stop', '4')

const useMic = has('--mic')
const args = [
  join(ROOT, 'stt', 'stt_service.py'),
  '--model-dir',
  MODEL,
  '--auto-stop',
  AUTO_STOP
]
if (!has('--real')) args.push('--stub-engine')
if (!useMic) {
  if (!existsSync(WAV)) {
    console.error(`✕ no WAV fixture at ${WAV} — run scripts/make-speech-wav.ps1 or pass --mic`)
    process.exit(1)
  }
  args.push('--fake-mic', WAV)
}

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const child = spawn(PY, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const events = []
let sock = null
let portSeen = null
let buffered = ''

child.on('error', (err) => {
  record(false, 'spawn python', err.message)
  finish(1)
})

child.stderr.on('data', (d) => {
  if (has('--verbose')) process.stderr.write(String(d))
})

child.stdout.on('data', (chunk) => {
  buffered += String(chunk)
  const m = /FORGE_STT_PORT=(\d+)/.exec(buffered)
  if (m && !portSeen) {
    portSeen = Number(m[1])
    record(portSeen > 0 && portSeen < 65536, 'port announced on stdout', String(portSeen))
    connect(portSeen)
  }
})

function connect(port) {
  let acc = ''
  sock = createConnection({ host: '127.0.0.1', port }, () => {
    record(true, 'connected to sidecar')
  })
  sock.on('data', (d) => {
    acc += String(d)
    let i
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i).trim()
      acc = acc.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        record(false, 'server sent valid JSON', line.slice(0, 80))
        continue
      }
      events.push(msg)
      if (has('--verbose') && msg.evt !== 'level') console.log('   <', line)
      onEvent(msg)
    }
  })
  // The sidecar hangs up on its clients as it leaves, so a reset once we have
  // asked it to go is the expected end of the conversation, not a failure.
  sock.on('error', (err) => {
    if (err.code === 'ECONNRESET' && phase !== 'waiting') return
    record(false, 'socket', err.message)
  })
}

const send = (obj) => sock?.write(JSON.stringify(obj) + '\n')

let started = false
let phase = 'waiting'

function onEvent(msg) {
  if (msg.evt === 'ready' && !started) {
    started = true
    record(true, 'model loaded (ready)')
    phase = 'listening'
    send({ cmd: 'start' })
    return
  }
  if (msg.evt === 'error' && phase === 'waiting') {
    // Degraded path: this is the expected outcome for --bad-model.
    phase = 'degraded'
    record(has('--bad-model'), `error event (kind=${msg.kind})`, msg.msg?.slice(0, 90))
    if (!has('--bad-model')) return finish(1)
    // Prove `start` is refused with the same typed error rather than crashing.
    send({ cmd: 'start' })
    return
  }
  if (msg.evt === 'error' && phase === 'degraded') {
    phase = 'degraded-refused'
    record(msg.kind === 'model-missing', 'start refused while degraded', `kind=${msg.kind}`)
    setTimeout(() => send({ cmd: 'shutdown' }), 300)
    return
  }
  if (msg.evt === 'state' && msg.v === 'listening') {
    record(true, 'state -> listening')
  }
  if (msg.evt === 'state' && msg.v === 'finishing') {
    record(msg.reason === 'autostop', 'auto-stop fired', `reason=${msg.reason ?? 'none'}`)
  }
  if (msg.evt === 'state' && msg.v === 'idle' && phase === 'listening') {
    phase = 'done'
    const levels = events.filter((e) => e.evt === 'level')
    const phrases = events.filter((e) => e.evt === 'phrase')
    record(levels.length > 5, 'level events flowed', `${levels.length} received`)
    record(
      levels.every((e) => typeof e.rms === 'number' && e.rms >= 0 && e.rms <= 1),
      'level values in 0..1'
    )
    record(phrases.length > 0, 'phrase events received', `${phrases.length}`)
    for (const p of phrases) console.log(`     phrase: "${p.text}"`)
    record(true, 'state -> idle after finishing')
    send({ cmd: 'shutdown' })
  }
}

// Exiting on its own after `shutdown` is the check — no kill, no signal.
child.on('exit', (code, signal) => {
  record(code === 0 && !signal, 'shutdown clean', `exit ${code}${signal ? ` ${signal}` : ''}`)
  finish(summary())
})

function summary() {
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`)
  return bad.length === 0 ? 0 : 1
}

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  try {
    sock?.destroy()
  } catch {
    /* ignore */
  }
  if (child.exitCode === null) child.kill()
  process.exit(code)
}

// Overall watchdog: the real model takes ~30 s to load on a cold cache.
const budget = has('--real') ? 180_000 : 45_000
setTimeout(() => {
  record(false, 'completed inside time budget', `${budget}ms`)
  finish(1)
}, budget)

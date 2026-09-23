/**
 * Offline check of Gemini Live's audio path and wire shapes.
 *
 * No network, no microphone, no Electron. The AudioWorklet processors run in
 * a vm with a fake worklet scope; GeminiLiveSession runs against a fake
 * WebSocket, AudioContext and getUserMedia. What is held here:
 *
 *   • capture worklet  — a 48 kHz tone comes out as ~16 000 Int16 samples/s,
 *                        in ~100 ms chunks, non-zero, pitch kept, and it keeps
 *                        coming (a transferred buffer is detached, as in a
 *                        real MessagePort — the one-chunk-ever bug)
 *   • player worklet   — 24 kHz PCM in comes out as sound, then "drained"
 *   • setup            — the first frame on the socket is `setup`, audio only
 *   • audio out        — no mic frame before setupComplete; after it every
 *                        chunk is realtimeInput.audio, audio/pcm;rate=16000
 *   • replies          — modelTurn audio reaches the player; state speaking
 *   • trace            — the [realtime] lines name no key or token
 *
 * Run: node scripts/gemini-live-check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import './ts-hooks.mjs'

registerHooks({
  resolve(spec, context, next) {
    if (/\?url\b/.test(spec)) {
      return { url: 'data:text/javascript,export default "pcm-worklet.js"', shortCircuit: true }
    }
    return next(spec, context)
  }
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`)
    process.exitCode = 1
  }
}

/* ---------------------------------------------------------- the worklets */

function loadWorklets(rate, source = readFileSync(join(ROOT, 'src/lib/realtime/pcm-worklet.js'), 'utf8')) {
  const registered = {}
  const posted = []
  class AudioWorkletProcessor {
    constructor() {
      const self = this
      this.port = {
        onmessage: null,
        // A real MessagePort detaches what it transfers; so does this one.
        postMessage(msg, transfer) {
          posted.push({ from: self, msg: transfer ? structuredClone(msg, { transfer }) : msg })
        }
      }
    }
  }
  const scope = {
    sampleRate: rate,
    AudioWorkletProcessor,
    registerProcessor: (name, cls) => {
      registered[name] = cls
    }
  }
  vm.runInNewContext(source, scope)
  return { registered, posted }
}

await check('capture worklet: 48 kHz tone → ~16 000 non-zero Int16 samples/s in 100 ms chunks, pitch kept', () => {
  const { registered, posted } = loadWorklets(48000)
  const cap = new registered['forge-pcm-capture']({ processorOptions: { targetRate: 16000 } })
  const freq = 440
  let t = 0
  for (let b = 0; b < 48000 / 128; b++) {
    const block = new Float32Array(128)
    for (let i = 0; i < 128; i++, t++) block[i] = 0.3 * Math.sin((2 * Math.PI * freq * t) / 48000)
    cap.process([[block]])
  }
  const chunks = posted.filter((p) => p.msg.pcm).map((p) => new Int16Array(p.msg.pcm))
  assert.ok(chunks.length >= 9 && chunks.length <= 10, `chunks in 1 s: ${chunks.length}`)
  for (const c of chunks) assert.equal(c.length, 1600, 'each chunk is 100 ms at 16 kHz')
  const all = Int16Array.from(chunks.flatMap((c) => Array.from(c)))
  assert.ok(all.some((s) => Math.abs(s) > 5000), 'the samples are not silent')
  let crossings = 0
  for (let i = 1; i < all.length; i++) if (all[i - 1] < 0 !== all[i] < 0) crossings++
  const hz = crossings / 2 / (all.length / 16000)
  assert.ok(Math.abs(hz - freq) < 10, `pitch after resampling: ${hz.toFixed(1)} Hz`)
  const level = posted.find((p) => p.msg.pcm).msg.level
  assert.ok(level > 0.15 && level < 0.25, `rms level of a 0.3 sine: ${level}`)
})

await check('capture worklet: keeps posting after the first chunk (the transfer detaches the old buffer)', () => {
  const { registered, posted } = loadWorklets(48000)
  const cap = new registered['forge-pcm-capture']({ processorOptions: { targetRate: 16000 } })
  for (let b = 0; b < (3 * 48000) / 128; b++) cap.process([[new Float32Array(128).fill(0.1)]])
  const n = posted.filter((p) => p.msg.pcm).length
  assert.ok(n >= 29, `chunks in 3 s: ${n} (one, ever, is the silent-Gemini bug)`)
})

await check('player worklet: 24 kHz PCM in → sound out at 48 kHz, "started" then "drained"', () => {
  const { registered, posted } = loadWorklets(48000)
  const player = new registered['forge-pcm-player']({ processorOptions: { sourceRate: 24000 } })
  const pcm = new Int16Array(2400).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 24000)))
  player.port.onmessage({ data: { pcm: pcm.buffer } })
  let loud = 0
  for (let b = 0; b < 8; b++) {
    const out = [[new Float32Array(128), new Float32Array(128)]]
    player.process([], out)
    loud += out[0][0].filter((s) => Math.abs(s) > 0.01).length
    assert.deepEqual(Array.from(out[0][1]), Array.from(out[0][0]), 'both channels carry it')
  }
  assert.ok(loud > 500, `audible frames: ${loud}`)
  for (let b = 0; b < 40; b++) player.process([], [[new Float32Array(128), new Float32Array(128)]])
  const words = posted.map((p) => Object.keys(p.msg)[0])
  assert.ok(words.indexOf('started') >= 0 && words.indexOf('drained') > words.indexOf('started'), words.join(','))
})

/* ------------------------------------------------ the session, with fakes */

class FakePort {
  constructor() {
    this.onmessage = null
    this.sent = []
  }
  postMessage(msg) {
    this.sent.push(msg)
  }
  emit(data) {
    this.onmessage?.({ data })
  }
}

class FakeWorkletNode {
  constructor(ctx, name, opts) {
    this.name = name
    this.opts = opts
    this.port = new FakePort()
    this.connections = []
    ctx.nodes.push(this)
  }
  connect(to) {
    this.connections.push(to)
  }
  disconnect() {}
}

function makeEnv({ initialCtxState }) {
  const sockets = []
  const contexts = []
  class FakeWebSocket {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(s) {
      this.sent.push(JSON.parse(s))
    }
    close() {
      this.readyState = 3
    }
    serverSends(obj, binary = false) {
      const text = JSON.stringify(obj)
      this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text })
    }
  }
  class FakeAudioContext {
    constructor() {
      this.state = initialCtxState
      this.sampleRate = 48000
      this.destination = { kind: 'destination' }
      this.nodes = []
      this.resumed = 0
      this.onstatechange = null
      this.audioWorklet = { addModule: async () => undefined }
      contexts.push(this)
    }
    createMediaStreamSource(stream) {
      const src = { stream, connections: [], connect: (to) => src.connections.push(to) }
      this.source = src
      return src
    }
    async resume() {
      this.resumed++
      this.state = 'running'
      this.onstatechange?.()
    }
    async close() {
      this.state = 'closed'
    }
  }
  const track = { enabled: true, muted: false, readyState: 'live', stop() {} }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  globalThis.WebSocket = FakeWebSocket
  globalThis.AudioContext = FakeAudioContext
  globalThis.AudioWorkletNode = FakeWorkletNode
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true
  })
  globalThis.window = { forge: { realtime: { geminiToken: async () => ({ ok: true, token: 'auth_tokens/SECRETTOKEN123', expiresAt: 0 }) } } }
  return { sockets, contexts }
}

const { GeminiLiveSession } = await import('../src/lib/realtime/gemini.ts')
const { setLiveTraceSink } = await import('../src/lib/realtime/live-trace.ts')
const { GEMINI_LIVE_MODEL } = await import('../shared/realtime.ts')

async function runSession({ initialCtxState = 'running', binaryFrames = false } = {}) {
  const env = makeEnv({ initialCtxState })
  const trace = []
  setLiveTraceSink((l) => trace.push(l), true)
  const states = []
  const session = new GeminiLiveSession({
    provider: 'gemini-live',
    model: GEMINI_LIVE_MODEL,
    voice: 'Kore',
    instructions: 'be brief',
    tools: [],
    events: {
      onState: (s) => states.push(s),
      onCaption: () => undefined,
      onToolCall: async () => ({ ok: true, text: 'done' }),
      onExpiring: () => undefined
    }
  })
  const started = session.start()
  // Let getUserMedia, addModule, the token and the socket's open run.
  for (let i = 0; i < 20 && !env.sockets[0]?.sent.length; i++) await new Promise((r) => setTimeout(r, 0))
  const ws = env.sockets[0]
  const ctx = env.contexts[0]
  const capture = ctx.nodes.find((n) => n.name === 'forge-pcm-capture')
  const player = ctx.nodes.find((n) => n.name === 'forge-pcm-player')
  const chunk = () => {
    const pcm = new Int16Array(1600).map((_, i) => Math.round(3000 * Math.sin(i / 5)))
    capture.port.emit({ pcm: pcm.buffer, level: 0.09 })
  }
  chunk() // before setupComplete: must not be sent
  const beforeSetup = ws.sent.length
  ws.serverSends({ setupComplete: {} }, binaryFrames)
  await started
  for (let i = 0; i < 5; i++) chunk()
  ws.serverSends({ serverContent: { inputTranscription: { text: 'hello' } } }, binaryFrames)
  const reply = Buffer.from(new Int16Array(2400).fill(4000).buffer).toString('base64')
  ws.serverSends({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: reply } }] } } }, binaryFrames)
  player.port.emit({ started: true })
  ws.serverSends({ serverContent: { turnComplete: true } }, binaryFrames)
  session.stop()
  setLiveTraceSink(null)
  return { ws, ctx, capture, player, states, trace, beforeSetup }
}

await check('the socket opens on the constrained v1alpha endpoint with the token, and sends setup first', async () => {
  const { ws } = await runSession()
  assert.match(ws.url, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1alpha\.GenerativeService\.BidiGenerateContentConstrained\?access_token=/)
  const setup = ws.sent[0].setup
  assert.ok(setup, 'first frame is setup')
  assert.equal(setup.model, `models/${GEMINI_LIVE_MODEL}`)
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO'])
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.disabled, false)
  assert.equal(setup.generationConfig.thinkingConfig, undefined, '3.8 Live refuses thinking settings')
})

await check('no mic frame before setupComplete; after it every chunk is realtimeInput.audio at 16 kHz, non-zero', async () => {
  const { ws, capture, ctx, beforeSetup } = await runSession()
  assert.equal(beforeSetup, 1, 'only the setup frame went out before setupComplete')
  assert.ok(ctx.source.connections.includes(capture), 'the mic source feeds the capture worklet')
  assert.equal(capture.opts.processorOptions.targetRate, 16000)
  const audio = ws.sent.filter((m) => m.realtimeInput?.audio)
  assert.equal(audio.length, 5)
  for (const m of audio) {
    assert.deepEqual(Object.keys(m), ['realtimeInput'])
    assert.equal(m.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000')
    const pcm = new Int16Array(Uint8Array.from(Buffer.from(m.realtimeInput.audio.data, 'base64')).buffer)
    assert.equal(pcm.length, 1600)
    assert.ok(pcm.some((s) => s !== 0), 'not an all-zero frame')
  }
  assert.equal(ws.sent.filter((m) => m.realtimeInput?.mediaChunks).length, 0, 'never the deprecated mediaChunks')
})

await check('a reply: modelTurn audio reaches the player, and the session says speaking', async () => {
  const { player, states } = await runSession()
  const pcm = player.port.sent.find((m) => m.pcm)
  assert.ok(pcm, 'the player was handed PCM')
  assert.equal(new Int16Array(pcm.pcm).length, 2400)
  assert.ok(player.connections.some((c) => c.kind === 'destination'), 'the player is wired to the speakers')
  assert.ok(states.includes('listening') && states.includes('speaking'), states.join(','))
})

await check('binary server frames are read the same as text frames', async () => {
  const { player, states } = await runSession({ binaryFrames: true })
  assert.ok(states.includes('listening'), 'setupComplete as a binary frame still completes setup')
  assert.ok(player.port.sent.some((m) => m.pcm))
})

await check('the [realtime] trace covers the path and carries no key or token', async () => {
  const { trace } = await runSession()
  const text = trace.join('\n')
  for (const want of [/ws open; setup sent model=/, /setupComplete after \d+ ms/, /mic chunks=\d+ sent=5 .*samples\/s\) rms avg=/, /dropped=not-ready:1/, /first server message of type modelTurn/, /first server message of type serverContent.inputTranscription/, /audio in chunks=1 bytes=4800/, /playback started; audio context running/]) {
    assert.match(text, want)
  }
  assert.doesNotMatch(text, /SECRETTOKEN|auth_tokens\/|access_token=/)
  for (const l of trace) assert.ok(l.startsWith('[realtime] '), l)
})

console.log(`\ngemini-live-check: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`)

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
 *   • stop while starting — a start stopped mid-way opens nothing and
 *                        releases the mic (V1)
 *   • interrupt        — during playback, after generation, the next reply
 *                        still plays (V2)
 *   • quiet turns      — a tool call with no spoken reply is back to
 *                        listening on turnComplete (V3)
 *   • the mic          — a blocked mic says "mic blocked", not "key refused" (V4)
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

function makeEnv({ initialCtxState = 'running', getUserMedia, geminiToken } = {}) {
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
  const track = {
    enabled: true,
    muted: false,
    readyState: 'live',
    stopped: 0,
    stop() {
      this.stopped++
      this.readyState = 'ended'
    }
  }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  globalThis.WebSocket = FakeWebSocket
  globalThis.AudioContext = FakeAudioContext
  globalThis.AudioWorkletNode = FakeWorkletNode
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: getUserMedia ? () => getUserMedia(stream) : async () => stream } },
    configurable: true
  })
  const token = async () => ({ ok: true, token: 'auth_tokens/SECRETTOKEN123', expiresAt: 0 })
  globalThis.window = { forge: { realtime: { geminiToken: geminiToken ?? token } } }
  return { sockets, contexts, track }
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

/* ------------- stop while starting (V1), interrupt (V2), quiet turns (V3), the mic (V4) */

const tick = () => new Promise((r) => setTimeout(r, 0))
/** A start() that never settles is the V1 bug itself (it carried on): fail, do not hang. */
const within = (p, ms = 1000) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
function newSession() {
  const states = []
  const tools = []
  const session = new GeminiLiveSession({
    provider: 'gemini-live',
    model: GEMINI_LIVE_MODEL,
    voice: 'Kore',
    instructions: 'be brief',
    tools: [],
    events: {
      onState: (s) => states.push(s),
      onCaption: () => undefined,
      onToolCall: async (call) => {
        tools.push(call.name)
        return { ok: true, text: 'done' }
      },
      onExpiring: () => undefined
    }
  })
  return { session, states, tools }
}
/** A session through setupComplete, with its socket and player. */
async function liveSession() {
  const env = makeEnv()
  const s = newSession()
  const started = s.session.start()
  for (let i = 0; i < 20 && !env.sockets[0]?.sent.length; i++) await tick()
  const ws = env.sockets[0]
  ws.serverSends({ setupComplete: {} })
  await started
  const player = env.contexts[0].nodes.find((n) => n.name === 'forge-pcm-player')
  return { ...s, env, ws, player }
}
const audioPart = () => ({
  inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(new Int16Array(240).fill(900).buffer).toString('base64') }
})
const pcmCount = (player) => player.port.sent.filter((m) => m.pcm).length

await check('V1: Listen off during getUserMedia — the late start is torn down: no socket, the mic track stopped', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const env = makeEnv({ getUserMedia: async (stream) => (await gate, stream) })
  const { session, states } = newSession()
  const started = session.start()
  session.stop()
  release()
  await assert.rejects(within(started), /stopped while starting/)
  await tick()
  assert.equal(env.sockets.length, 0, 'no WebSocket was opened after stop()')
  assert.equal(env.contexts.length, 0, 'no AudioContext was built after stop()')
  assert.ok(env.track.stopped > 0, 'the late mic stream was stopped')
  assert.deepEqual(states.filter((s) => s !== 'connecting'), ['closed'], 'nothing after closed')
})

await check('V1: Listen off during the token mint — no socket opens, the mic and audio graph are released', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const env = makeEnv({ geminiToken: async () => (await gate, { ok: true, token: 'auth_tokens/SECRETTOKEN123', expiresAt: 0 }) })
  const { session } = newSession()
  const started = session.start()
  for (let i = 0; i < 20 && !env.contexts[0]?.nodes.length; i++) await tick()
  await tick()
  session.stop()
  release()
  await assert.rejects(within(started), /stopped while starting/)
  await tick()
  assert.equal(env.sockets.length, 0, 'the socket never opened')
  assert.equal(env.contexts[0].state, 'closed')
  assert.ok(env.track.stopped > 0)
})

await check('V1: Listen off while the socket waits for setupComplete — start rejects, the socket is closed', async () => {
  const env = makeEnv()
  const { session } = newSession()
  const started = session.start()
  for (let i = 0; i < 20 && !env.sockets[0]?.sent.length; i++) await tick()
  const ws = env.sockets[0]
  session.stop()
  // A real socket fires close after close(); the fake leaves that to us.
  ws.onclose?.({ code: 1000, reason: '', wasClean: true })
  await assert.rejects(within(started))
  assert.equal(ws.readyState, 3, 'closed')
  assert.ok(env.track.stopped > 0)
})

await check('V2: interrupt after generationComplete, during playback, does not silence the next reply', async () => {
  const { session, ws, player } = await liveSession()
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart(), audioPart()] } } })
  ws.serverSends({ serverContent: { generationComplete: true } })
  ws.serverSends({ serverContent: { turnComplete: true } })
  player.port.emit({ started: true }) // still playing its buffer
  session.interrupt()
  assert.ok(player.port.sent.some((m) => m.flush), 'the queued audio was flushed')
  const before = pcmCount(player)
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart()] } } })
  assert.equal(pcmCount(player), before + 1, 'the next reply reaches the player')
  session.stop()
})

await check('V2: interrupt mid-generation drops the rest of that turn, and the turn after plays', async () => {
  const { session, ws, player } = await liveSession()
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart()] } } })
  session.interrupt()
  const before = pcmCount(player)
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart()] } } })
  assert.equal(pcmCount(player), before, 'the rest of the interrupted turn is dropped')
  ws.serverSends({ serverContent: { turnComplete: true } })
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart()] } } })
  assert.equal(pcmCount(player), before + 1, 'the next turn plays')
  session.stop()
})

await check('V3: a tool call answered with no spoken reply goes back to listening on turnComplete', async () => {
  const { session, ws, states, tools } = await liveSession()
  ws.serverSends({ toolCall: { functionCalls: [{ id: 'c1', name: 'run_app_action', args: {} }] } })
  assert.equal(states.at(-1), 'thinking')
  await tick()
  assert.deepEqual(tools, ['run_app_action'])
  assert.ok(ws.sent.some((m) => m.toolResponse), 'the tool was answered')
  ws.serverSends({ serverContent: { turnComplete: true } })
  assert.equal(states.at(-1), 'listening', states.join(','))
  session.stop()
})

await check('V3: turnComplete while audio is still queued leaves the phase to playback', async () => {
  const { session, ws, states, player } = await liveSession()
  ws.serverSends({ toolCall: { functionCalls: [{ id: 'c2', name: 'run_app_action', args: {} }] } })
  await tick()
  ws.serverSends({ serverContent: { modelTurn: { parts: [audioPart()] } } })
  ws.serverSends({ serverContent: { turnComplete: true } })
  assert.equal(states.at(-1), 'thinking', 'not flipped to listening before the audio plays')
  player.port.emit({ started: true })
  player.port.emit({ drained: true })
  assert.equal(states.at(-1), 'listening')
  session.stop()
})

await check('V4: a blocked microphone is "mic blocked", never "key refused"', async () => {
  const { errorReasonOf } = await import('../src/lib/realtime/errors.ts')
  makeEnv({
    getUserMedia: async () => {
      const e = new Error('Permission denied by system')
      e.name = 'NotAllowedError'
      throw e
    }
  })
  const { session } = newSession()
  const err = await session.start().then(
    () => null,
    (e) => e
  )
  assert.match(err?.message ?? '', /^Microphone blocked/)
  assert.equal(errorReasonOf('gemini', err.message), 'Gemini: mic blocked')
  assert.equal(errorReasonOf('openai', err.message), 'OpenAI: mic blocked')
  assert.equal(errorReasonOf('gemini', 'Could not start audio source'), 'Gemini: mic blocked')
  assert.equal(errorReasonOf('gemini', 'Microphone not found (NotFoundError) — plug one in'), 'Gemini: no mic')
  assert.equal(errorReasonOf('gemini', 'Gemini refused (403) the key'), 'Gemini: key refused', 'a real key refusal still says so')
  assert.equal(errorReasonOf('parakeet', 'microphone busy'), 'Parakeet: mic busy or missing', 'Parakeet keeps its own words')
})

console.log(`\ngemini-live-check: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`)

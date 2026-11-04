/**
 * Checks for Claude Live's voice shell (src/lib/live/, src/state/live/).
 *
 * Covers the pure decisions the shell is built on — captions, the echo guard,
 * the news gap, the spoken ack, the latency sample, phase and jobs — plus the
 * mouth's queue against a fake TTS backend, the Parakeet pause, and the
 * transcription handshake's request shapes against a fake fetch. No mic, no
 * speaker, no network.
 *
 * Run: npm run live-voice:check
 *
 * The hooks only tell Node how to load the app's .ts modules (the same as
 * scripts/voice-check.mjs, plus the renderer's `@/` alias).
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = pathToFileURL(join(ROOT, 'shared')).href
const SRC = pathToFileURL(join(ROOT, 'src')).href

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) return next(`${SHARED}/${spec.slice('@shared/'.length)}.ts`, context)
    if (spec.startsWith('@/')) return next(`${SRC}/${spec.slice(2)}.ts`, context)
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const turns = await import(pathToFileURL(join(ROOT, 'src/lib/live/turns.ts')).href)
const { LiveMouth } = await import(pathToFileURL(join(ROOT, 'src/lib/live/mouth.ts')).href)
const { parakeetPauseCut } = await import(pathToFileURL(join(ROOT, 'src/lib/live/ears-parakeet.ts')).href)
const tts = await import(pathToFileURL(join(ROOT, 'src/lib/tts.ts')).href)
const tokens = await import(pathToFileURL(join(ROOT, 'electron/realtime/tokens.ts')).href)
const hub = await import(pathToFileURL(join(ROOT, 'src/lib/live/hub.ts')).href)
const { paneHome } = await import(pathToFileURL(join(ROOT, 'src/lib/live/showPane.ts')).href)
const card = await import(pathToFileURL(join(ROOT, 'shared/live-card.ts')).href)
const { brainSwitchWaits } = await import(pathToFileURL(join(ROOT, 'src/lib/brainStatus.ts')).href)

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}`)
    throw err
  }
}

console.log('live-voice:check')

/* --------------------------------------------------------------- captions */

await check('appendCaption joins streamed pieces and folds a doubled space', () => {
  let c = turns.appendCaption(undefined, '  Sure')
  c = turns.appendCaption(c, ", I'll ")
  c = turns.appendCaption(c, ' check')
  assert.equal(c, "Sure, I'll check")
})

await check('joinPhrases makes one turn of a thought said with a breath in it', () => {
  assert.equal(turns.joinPhrases(['open the  ', '', ' koraos project ']), 'open the koraos project')
})

await check('upsertTurn replaces by id and keeps the newest 30', () => {
  let list = []
  for (let i = 0; i < 35; i++) list = turns.upsertTurn(list, { id: `t${i}`, who: 'you', text: `${i}`, at: i, final: true })
  assert.equal(list.length, turns.LIVE_TURNS_KEPT)
  assert.equal(list[0].id, 't5')
  list = turns.upsertTurn(list, { id: 't10', who: 'you', text: 'changed', at: 10, final: true })
  assert.equal(list.length, 30)
  assert.equal(list.find((t) => t.id === 't10').text, 'changed')
  assert.equal(list[5].id, 't10', 'a replaced turn keeps its place')
})

/* ------------------------------------------------------------- echo guard */

await check('isEcho: Forge heard through the mic while a line plays is an echo', () => {
  const lines = turns.rememberLine([], 'I opened the koraos project for you.')
  assert.equal(turns.isEcho('opened the koraos project for you', lines, 1000), true)
})

await check('isEcho: inside the window after the line ended, yes; after it, no', () => {
  const lines = turns.endLines(turns.rememberLine([], 'The tests passed in the forge pane.'), 10_000)
  assert.equal(turns.isEcho('the tests passed in the forge pane', lines, 12_000), true)
  assert.equal(turns.isEcho('the tests passed in the forge pane', lines, 10_000 + 7_000), false)
})

await check('isEcho: across lines of one reply, and never for his own words or under three words', () => {
  let lines = turns.rememberLine([], 'Sure, I will check the ledger.')
  lines = turns.rememberLine(turns.endLines(lines, 500), 'Two jobs are running now.')
  assert.equal(turns.isEcho('check the ledger two jobs are running', lines, 900), true)
  assert.equal(turns.isEcho('stop the build in the other pane please', lines, 900), false)
  assert.equal(turns.isEcho('the ledger', lines, 900), false)
})

/* ------------------------------------------------------------------- news */

await check('queueNews: one item per id, and newer news about a job replaces older', () => {
  let q = turns.queueNews([], { id: 'n1', jobId: 'j1', text: 'Kess needs you.', urgency: 'needs-you', at: 1 })
  q = turns.queueNews(q, { id: 'n1', jobId: 'j1', text: 'Kess needs you.', urgency: 'needs-you', at: 2 })
  assert.equal(q.length, 1)
  q = turns.queueNews(q, { id: 'n2', jobId: 'j1', text: 'Kess is done.', urgency: 'done', at: 3 })
  assert.deepEqual(q.map((n) => n.id), ['n2'])
  q = turns.queueNews(q, { id: 'n3', text: '   ', urgency: 'info', at: 4 })
  assert.equal(q.length, 1, 'empty news is not queued')
})

await check('newsGapOpen: never over him, within 1 s of him stopping, over speech or a pending reply', () => {
  const base = { now: 10_000, hearing: false, heardEndAt: null, speaking: false, turnBusy: false }
  assert.equal(turns.newsGapOpen(base), true)
  assert.equal(turns.newsGapOpen({ ...base, hearing: true }), false)
  assert.equal(turns.newsGapOpen({ ...base, heardEndAt: 9_500 }), false)
  assert.equal(turns.newsGapOpen({ ...base, heardEndAt: 9_000 }), true)
  assert.equal(turns.newsGapOpen({ ...base, speaking: true }), false)
  assert.equal(turns.newsGapOpen({ ...base, turnBusy: true }), false)
})

await check('takeNews: "needs you" first and alone, then the rest batched', () => {
  const q = [
    { id: 'a', text: 'Mira is done.', urgency: 'done', at: 1 },
    { id: 'b', text: 'Lena needs a yes.', urgency: 'needs-you', at: 2 },
    { id: 'c', text: 'Tomas is done.', urgency: 'done', at: 3 }
  ]
  const first = turns.takeNews(q)
  assert.equal(first.say, 'Lena needs a yes.')
  assert.deepEqual(first.ids, ['b'])
  const second = turns.takeNews(first.rest)
  assert.equal(second.say, 'Mira is done. Tomas is done.')
  assert.equal(second.rest.length, 0)
  assert.equal(turns.takeNews([]), null)
})

/* -------------------------------------------------------------------- ack */

await check('shouldAck: once, only after 600 ms of silence, only with a clip ready', () => {
  const base = { now: 1_600, eosAt: 1_000, audioStarted: false, ready: 4, acked: false }
  assert.equal(turns.shouldAck(base), true)
  assert.equal(turns.shouldAck({ ...base, now: 1_599 }), false)
  assert.equal(turns.shouldAck({ ...base, audioStarted: true }), false)
  assert.equal(turns.shouldAck({ ...base, ready: 0 }), false)
  assert.equal(turns.shouldAck({ ...base, acked: true }), false)
})

/* ---------------------------------------------------------------- latency */

await check('buildLatencySample: every gap from end of speech, ack flagged', () => {
  const s = turns.buildLatencySample({ turnId: 't', eosAt: 1000, sentAt: 1040, firstTextAt: 1500, firstReplyAudioAt: 2100, firstAudioAt: 1600, ack: true })
  assert.deepEqual(s, { turnId: 't', eosToSendMs: 40, sendToFirstTextMs: 460, firstTextToAudioMs: 600, eosToAudioMs: 600, ack: true })
})

await check('buildLatencySample: a typed turn has none; a cancelled one has what it got', () => {
  assert.equal(turns.buildLatencySample({ turnId: 't', sentAt: 5, ack: false }), null)
  assert.deepEqual(turns.buildLatencySample({ turnId: 'u', eosAt: 100, sentAt: 130, ack: false }), { turnId: 'u', eosToSendMs: 30, ack: false })
})

/* ------------------------------------------------------------ phase, jobs */

await check('livePhase: off, starting, speaking over hearing over thinking, else listening', () => {
  const p = { running: true, starting: false, speaking: false, hearing: false, thinking: false }
  assert.equal(turns.livePhase({ ...p, running: false }), 'off')
  assert.equal(turns.livePhase({ ...p, running: false, starting: true }), 'starting')
  assert.equal(turns.livePhase({ ...p, speaking: true, hearing: true, thinking: true }), 'speaking')
  assert.equal(turns.livePhase({ ...p, hearing: true, thinking: true }), 'hearing')
  assert.equal(turns.livePhase({ ...p, thinking: true }), 'thinking')
  assert.equal(turns.livePhase(p), 'listening')
})

await check('jobsView: running count, newest running is "now", needs-you newest first', () => {
  const job = (id, state, updatedAt) => ({ id, title: id, owner: 'conductor', state, steps: [], createdAt: 0, updatedAt })
  const v = turns.jobsView([job('a', 'running', 5), job('b', 'running', 9), job('c', 'needs-you', 1), job('d', 'needs-you', 7), job('e', 'done', 20)])
  assert.equal(v.working, 2)
  assert.equal(v.now.id, 'b')
  assert.deepEqual(v.needsYou.map((j) => j.id), ['d', 'c'])
  assert.equal(turns.jobsView([]).now, undefined)
})

/* -------------------------------------------------------------- the mouth */

function fakeBackend(log) {
  return {
    async speak(req) {
      log.push(`synth:${req.engine}:${req.text}`)
      return { ok: true, audio: 'AAAA', format: 'pcm', sampleRate: 24000, channels: 1, voice: req.voice, model: 'kokoro' }
    },
    async cancelSpeak() {
      return true
    },
    play() {
      let stop = () => {}
      const done = new Promise((r) => {
        stop = r
        setTimeout(r, 5)
      })
      return { done, stop: () => stop(), duck: () => {} }
    },
    async decode() {
      throw new Error('no mp3 here')
    }
  }
}

const KOKORO = { engine: 'edge', hasKey: false, edgeVoice: '', geminiVoice: '', ttsModel: '', localVoice: '', kokoroVoice: 'bf_emma' }

function mouthWith(log) {
  const started = []
  const busy = []
  const mouth = new LiveMouth(() => KOKORO, {
    onBusy: (b) => busy.push(b),
    onStart: (item) => started.push(`${item.kind}:${item.text}`),
    onEnd: () => {},
    onNotice: () => {}
  })
  return { mouth, started, busy }
}

async function idle(mouth) {
  for (let i = 0; i < 200 && mouth.active; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(mouth.active, false, 'the mouth fell silent')
}

await check('mouth: first clause first, then sentences, in order, and quiet at the end', async () => {
  const log = []
  tts.setTtsBackend(fakeBackend(log))
  const { mouth, started, busy } = mouthWith(log)
  mouth.pushReply('t1', 'Okay, so I will check this, then the ')
  mouth.pushReply('t1', 'koraos project. Two jobs are running')
  mouth.endReply('t1')
  await idle(mouth)
  assert.deepEqual(started, ['reply:Okay, so I will check this,', 'reply:then the koraos project.', 'reply:Two jobs are running'])
  assert.deepEqual(busy, [true, false])
  mouth.dispose()
  tts.setTtsBackend(null)
})

await check('mouth: an ack goes ahead of the reply; dropTurn silences only that turn', async () => {
  const log = []
  tts.setTtsBackend(fakeBackend(log))
  const { mouth, started } = mouthWith(log)
  assert.equal(mouth.ack('t2', 'One sec.'), true)
  mouth.say('Mira is done.')
  mouth.pushReply('t3', 'This turn is dropped. And so is this.')
  mouth.dropTurn('t3')
  await idle(mouth)
  assert.deepEqual(started, ['ack:One sec.', 'news:Mira is done.'])
  assert.equal(mouth.holds('t3'), false)
  mouth.dispose()
  tts.setTtsBackend(null)
})

/* ----------------------------------------------------------------- ears */

await check('Parakeet pause: the Agent silence window, clamped to 0.5–2 s', () => {
  assert.equal(parakeetPauseCut(800), 0.8)
  assert.equal(parakeetPauseCut(0), 0.8)
  assert.equal(parakeetPauseCut(100), 0.5)
  assert.equal(parakeetPauseCut(9000), 2)
})

await check('transcription session: type transcription, semantic VAD, streaming model, no conversation fields', () => {
  const s = tokens.buildOpenAITranscriptionSession()
  assert.equal(s.type, 'transcription')
  assert.deepEqual(s.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'auto' })
  assert.deepEqual(s.audio.input.transcription, { model: tokens.LIVE_TRANSCRIBE_MODEL, language: 'en' })
  assert.notEqual(tokens.LIVE_TRANSCRIBE_MODEL, 'whisper-1', 'whisper-1 sends no partial deltas')
  assert.equal('output' in s.audio, false)
  assert.equal(tokens.buildOpenAITranscriptionSession({ eagerness: 'high', language: 'fr' }).audio.input.turn_detection.eagerness, 'high')
  assert.equal(tokens.buildOpenAITranscriptionSession({ eagerness: 'nope' }).audio.input.turn_detection.eagerness, 'auto')
})

await check('connectOpenAITranscription: mints a transcription secret, posts the SDP with it', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/client_secrets')) return new Response(JSON.stringify({ value: 'ek_test', expires_at: 100 }), { status: 200 })
    return new Response('v=0\r\no=- answer', { status: 201 })
  }
  const result = await tokens.connectOpenAITranscription('sk-key', { sdp: 'v=0 offer' }, fakeFetch)
  assert.deepEqual(result, { ok: true, sdp: 'v=0\r\no=- answer', expiresAt: 100_000 })
  assert.equal(calls[0].url, 'https://api.openai.com/v1/realtime/client_secrets')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-key')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.session.type, 'transcription')
  assert.equal(calls[1].url, 'https://api.openai.com/v1/realtime/calls')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ek_test')
  assert.equal(calls[1].init.body, 'v=0 offer')
  assert.deepEqual(await tokens.connectOpenAITranscription('', { sdp: 'v=0' }, fakeFetch), {
    ok: false,
    error: 'No OpenAI key is set — add one in Settings → Models & APIs'
  })
  assert.equal((await tokens.connectOpenAITranscription('k', { sdp: ' ' }, fakeFetch)).ok, false)
})

/* ------------------------------------------------- the bar's view (L4) */

await check('liveHubPhase maps every Live phase to one hub phase; a failed start is an error', () => {
  assert.equal(hub.liveHubPhase({ phase: 'off' }), 'off')
  assert.equal(hub.liveHubPhase({ phase: 'off', startError: 'Microphone blocked' }), 'error')
  assert.equal(hub.liveHubPhase({ phase: 'starting' }), 'connecting')
  assert.equal(hub.liveHubPhase({ phase: 'listening' }), 'listening')
  assert.equal(hub.liveHubPhase({ phase: 'hearing' }), 'listening')
  assert.equal(hub.liveHubPhase({ phase: 'thinking' }), 'thinking')
  assert.equal(hub.liveHubPhase({ phase: 'speaking' }), 'speaking')
  // The error only counts while off: a running Live reports its notes elsewhere.
  assert.equal(hub.liveHubPhase({ phase: 'listening', startError: 'x' }), 'listening')
})

await check('liveMicState: the mic is open in every running phase, words for each, ended note while off', () => {
  assert.deepEqual(hub.liveMicState({ phase: 'starting' }, null), { capturing: false, starting: true, listenNote: 'Starting…' })
  for (const phase of ['listening', 'hearing', 'thinking', 'speaking']) assert.equal(hub.liveMicState({ phase }, null).capturing, true, phase)
  assert.equal(hub.liveMicState({ phase: 'hearing' }, null).listenNote, 'Hearing you')
  assert.equal(hub.liveMicState({ phase: 'off' }, null).listenNote, 'Off')
  assert.equal(hub.liveMicState({ phase: 'off' }, 'Conversation ended — you turned it off').listenNote, 'Conversation ended — you turned it off')
  assert.equal(hub.liveMicState({ phase: 'off', startError: 'no mic' }, null).listenNote, 'Claude Live: no mic')
})

await check('a brain pick while Listen is on: Claude Live either way waits for the next press', () => {
  const W = (o) => brainSwitchWaits({ listening: true, liveRealtime: false, current: 'claude-voice', target: 'forge-brain', ...o })
  assert.equal(W({ current: 'claude-live' }), true, 'off Claude Live: its ears close on the switch')
  assert.equal(W({ target: 'claude-live' }), true, 'to Claude Live: the conversation on screen ends first')
  assert.equal(W({ current: 'claude-live', target: 'claude-live' }), false, 'the brain in use')
  assert.equal(W({ listening: false, target: 'claude-live' }), false, 'Listen off: nothing to wait for')
  assert.equal(W({}), false, 'Parakeet to Parakeet is unchanged')
})

/* ---------------------------------------------------- show me (L4) */

await check('paneHome finds the project a pane is in, the one on screen first', () => {
  const leaf = (id) => ({ type: 'leaf', id, profileId: 'p', title: '' })
  const ws = {
    a: { tabs: [{ id: 't1', title: 'T', activePaneId: 'x', root: { type: 'split', id: 's', direction: 'row', ratio: 0.5, a: leaf('x'), b: leaf('y') } }] },
    b: { tabs: [{ id: 't2', title: 'T', activePaneId: 'z', root: leaf('z') }, { id: 't3', title: 'C', activePaneId: 'c', root: { type: 'chat', id: 'c', bot: 'claude', title: 'Claude' } }] },
    c: { tabs: [{ id: 't4', title: 'T', activePaneId: 'y', root: leaf('y') }] }
  }
  assert.equal(paneHome(ws, 'y', 'a'), 'a')
  assert.equal(paneHome(ws, 'y', 'c'), 'c')
  assert.equal(paneHome(ws, 'z', 'a'), 'b')
  assert.equal(paneHome(ws, 'nope', 'a'), null)
  // A chat tab's leaf is not a pane.
  assert.equal(paneHome(ws, 'c', 'b'), null)
  assert.equal(paneHome(ws, 'x', null), 'a')
})

/* --------------------------------------------- the desktop card (L4) */

await check('liveCardFor: needs-you and done become cards with the crew name; info never does', () => {
  const jobs = [
    { id: 'j1', title: 'Run the tests', paneId: 'p1', paneName: 'Lena', owner: 'pane', state: 'needs-you', steps: [], createdAt: 1, updatedAt: 2 },
    { id: 'j2', title: 'Look it up', owner: 'conductor', state: 'done', steps: [], createdAt: 1, updatedAt: 2 }
  ]
  const needs = card.liveCardFor({ id: 'n1', jobId: 'j1', text: ' Lena needs you:   allow npm test? ', urgency: 'needs-you' }, jobs)
  assert.deepEqual(needs, { id: 'n1', jobId: 'j1', who: 'Lena', text: 'Lena needs you: allow npm test?', urgency: 'needs-you', canShow: true })
  assert.equal(card.liveCardHeadline(needs), 'Lena needs you')
  assert.deepEqual(card.liveCardChoices(needs), ['push', 'show', 'later'])
  const done = card.liveCardFor({ id: 'n2', jobId: 'j2', text: 'Done.', urgency: 'done' }, jobs)
  assert.equal(done.who, 'Forge')
  assert.equal(card.liveCardHeadline(done), 'Forge is done')
  // No pane: no "Show me"; done: no "Push it".
  assert.deepEqual(card.liveCardChoices(done), ['later'])
  // A batched "done" names no job: a card with only Later.
  const batch = card.liveCardFor({ id: 'n3', text: 'Two jobs are done.', urgency: 'done' }, jobs)
  assert.equal(batch.jobId, undefined)
  assert.deepEqual(card.liveCardChoices(batch), ['later'])
  assert.equal(card.liveCardFor({ id: 'n4', text: 'fyi', urgency: 'info' }, jobs), null)
  assert.equal(card.liveCardFor({ id: 'n5', text: '   ', urgency: 'done' }, jobs), null)
  assert.ok(card.liveCardFor({ id: 'n6', text: 'x'.repeat(400), urgency: 'done' }, jobs).text.length <= 240)
})

await check('"Push it" says what the rail flyout says, word for word', () => {
  assert.equal(card.livePushLine('Lena'), 'Yes, Lena can go ahead.')
  assert.deepEqual(Object.values(card.LIVE_CARD_WORDS), ['Push it', 'Show me', 'Later'])
})

console.log(`live-voice:check: ${passed} passed`)

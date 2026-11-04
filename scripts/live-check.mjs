/**
 * live:check — Claude Live's job ledger and contract, offline.
 *
 *  - The pure reducer (electron/live/ledger.ts applyLedgerEvent): create,
 *    steps cut to 200 characters, state moves (stopped is final), the 200-job
 *    cap dropping finished jobs first.
 *  - Pane attention: asking → needs-you with news once, idle → working
 *    again, done → done with news once.
 *  - The digest for the voice brain: needs-you first, newest first, whole
 *    lines, never longer than asked.
 *  - Reload from the JSONL log: the last 24 h come back, a torn line is
 *    skipped, the file is compacted.
 *  - The contract's channel names, the preload's methods, the settings.
 *  - The brains' pure rules (electron/live/brain-helpers.ts): per-model
 *    params, the history trim, the state block, news, the Conductor's
 *    messages and steps; the news queue's batching; the Conductor's restart
 *    sweep and its stop / steer answers without a session.
 *
 *   node scripts/live-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './ts-hooks.mjs'

const L = await import('../electron/live/ledger.ts')
const S = await import('../shared/live.ts')

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`)
  }
}

const apply = (snap, ...events) => events.reduce((s, e) => L.applyLedgerEvent(s, e), snap)
const create = (id, at, extra = {}) => ({ t: 'create', at, job: { id, title: `Job ${id}`, owner: 'conductor', ...extra } })

console.log('the reducer')

await check('create: a queued job with no steps, newest first; the same id twice is ignored', () => {
  const a = apply(L.EMPTY_LEDGER, create('a', 100), create('b', 200, { paneId: 'p1', paneName: 'Xander', project: 'forge' }))
  assert.deepEqual(a.jobs.map((j) => j.id), ['b', 'a'])
  assert.equal(a.seq, 2)
  const b = a.jobs[0]
  assert.equal(b.state, 'queued')
  assert.deepEqual(b.steps, [])
  assert.equal(b.createdAt, 200)
  assert.equal(b.updatedAt, 200)
  assert.equal(b.paneName, 'Xander')
  assert.equal(L.applyLedgerEvent(a, create('a', 300)), a, 'a repeated create is a no-op by identity')
  assert.equal(L.applyLedgerEvent(a, { t: 'create', at: 1, job: { id: '', title: 'x', owner: 'pane' } }), a, 'no id, no job')
  assert.equal(L.applyLedgerEvent(a, { t: 'nope' }), a)
})

await check('steps: one line, cut to 200 characters; empty or unknown is a no-op; a job keeps its last 50', () => {
  let s = apply(L.EMPTY_LEDGER, create('a', 1))
  const long = `${'word '.repeat(80)}\n\nend`
  s = L.applyLedgerEvent(s, { t: 'step', at: 5, id: 'a', text: long })
  const step = s.jobs[0].steps[0]
  assert.ok(step.text.length <= S.LIVE_STEP_MAX, `step is ${step.text.length} chars`)
  assert.equal(step.text.length, 200)
  assert.ok(step.text.endsWith('…'))
  assert.ok(!/\n/.test(step.text))
  assert.equal(s.jobs[0].updatedAt, 5)
  assert.equal(L.applyLedgerEvent(s, { t: 'step', at: 6, id: 'a', text: '   ' }), s)
  assert.equal(L.applyLedgerEvent(s, { t: 'step', at: 6, id: 'zz', text: 'hello' }), s)
  for (let i = 0; i < 60; i++) s = L.applyLedgerEvent(s, { t: 'step', at: 10 + i, id: 'a', text: `step ${i}` })
  assert.equal(s.jobs[0].steps.length, S.LIVE_STEPS_PER_JOB)
  assert.equal(s.jobs[0].steps.at(-1).text, 'step 59')
})

await check('state: moves and summaries; a repeat is a no-op; stopped is final; nonsense is ignored', () => {
  let s = apply(L.EMPTY_LEDGER, create('a', 1))
  s = L.applyLedgerEvent(s, { t: 'state', at: 2, id: 'a', state: 'running', summary: 'Running the tests' })
  assert.equal(s.jobs[0].state, 'running')
  assert.equal(s.jobs[0].summary, 'Running the tests')
  assert.equal(L.applyLedgerEvent(s, { t: 'state', at: 3, id: 'a', state: 'running' }), s, 'same state, no summary: no-op')
  s = L.applyLedgerEvent(s, { t: 'state', at: 4, id: 'a', state: 'done', summary: 'All green' })
  assert.equal(s.jobs[0].state, 'done')
  s = L.applyLedgerEvent(s, { t: 'state', at: 5, id: 'a', state: 'needs-you' })
  assert.equal(s.jobs[0].state, 'needs-you', 'a done pane can ask again')
  s = L.applyLedgerEvent(s, { t: 'state', at: 6, id: 'a', state: 'stopped' })
  assert.equal(L.applyLedgerEvent(s, { t: 'state', at: 7, id: 'a', state: 'running' }), s, 'stopped is final')
  assert.equal(L.applyLedgerEvent(s, { t: 'state', at: 7, id: 'a', state: 'exploded' }), s)
  assert.equal(s.jobs[0].updatedAt, 6)
})

await check('update: renames and pane fields; an empty string clears an optional field', () => {
  let s = apply(L.EMPTY_LEDGER, create('a', 1, { paneName: 'Old' }))
  s = L.applyLedgerEvent(s, { t: 'update', at: 2, id: 'a', patch: { title: 'New title', paneId: 'p9' } })
  assert.equal(s.jobs[0].title, 'New title')
  assert.equal(s.jobs[0].paneId, 'p9')
  s = L.applyLedgerEvent(s, { t: 'update', at: 3, id: 'a', patch: { paneName: '' } })
  assert.ok(!('paneName' in s.jobs[0]))
  assert.equal(L.applyLedgerEvent(s, { t: 'update', at: 4, id: 'a', patch: { title: 'New title' } }), s)
})

await check('the cap: 200 jobs, the oldest finished dropped before any unfinished one', () => {
  let s = L.EMPTY_LEDGER
  for (let i = 0; i < 200; i++) s = L.applyLedgerEvent(s, create(`j${i}`, 1000 + i))
  // j150 finishes (late), j0 is the oldest and still queued.
  s = L.applyLedgerEvent(s, { t: 'state', at: 5000, id: 'j150', state: 'done' })
  s = L.applyLedgerEvent(s, create('new', 6000))
  assert.equal(s.jobs.length, S.LIVE_JOB_CAP)
  assert.ok(!s.jobs.some((j) => j.id === 'j150'), 'the finished one went')
  assert.ok(s.jobs.some((j) => j.id === 'j0'), 'the oldest unfinished stayed')
  s = L.applyLedgerEvent(s, create('newer', 7000))
  assert.ok(!s.jobs.some((j) => j.id === 'j0'), 'with nothing finished, the oldest goes')
  assert.equal(s.jobs[0].id, 'newer')
})

console.log('pane attention')

await check('asking → needs-you with news once; idle → working again; done → done with news once', () => {
  let s = apply(L.EMPTY_LEDGER, create('a', 1, { paneId: 'p1', paneName: 'Xander', state: 'running' }))
  const ask = { paneId: 'p1', state: 'asking', prompt: 'Do you want to proceed?' }
  const o1 = L.attentionToLedger(s, ask, 10)
  assert.equal(o1.jobId, 'a')
  assert.deepEqual(o1.news, { text: 'Xander needs you: Do you want to proceed?', urgency: 'needs-you' })
  s = apply(s, ...o1.events)
  assert.equal(s.jobs[0].state, 'needs-you')
  assert.equal(s.jobs[0].steps.at(-1).text, 'Asked: Do you want to proceed?')
  assert.equal(L.attentionToLedger(s, ask, 11), null, 'the same question again: no second news')
  const idle = L.attentionToLedger(s, { paneId: 'p1', state: 'idle', prompt: '' }, 12)
  assert.equal(idle.news, null)
  s = apply(s, ...idle.events)
  assert.equal(s.jobs[0].state, 'running')
  assert.equal(L.attentionToLedger(s, { paneId: 'p1', state: 'idle', prompt: '' }, 13), null, 'idle while working: nothing')
  const done = L.attentionToLedger(s, { paneId: 'p1', state: 'done', prompt: '' }, 14)
  assert.deepEqual(done.news, { text: 'Xander is done.', urgency: 'done' })
  s = apply(s, ...done.events)
  assert.equal(s.jobs[0].state, 'done')
  assert.equal(L.attentionToLedger(s, { paneId: 'p1', state: 'done', prompt: '' }, 15), null, 'done twice: one news')
  assert.equal(L.attentionToLedger(s, { paneId: 'other', state: 'asking', prompt: 'x' }, 16), null, 'a pane no job watches')
})

await check('the newest unstopped job on a pane hears it; a stopped job does not', () => {
  let s = apply(L.EMPTY_LEDGER, create('old', 1, { paneId: 'p1' }), create('new', 2, { paneId: 'p1' }))
  assert.equal(L.jobForPane(s, 'p1').id, 'new')
  s = L.applyLedgerEvent(s, { t: 'state', at: 3, id: 'new', state: 'stopped' })
  assert.equal(L.jobForPane(s, 'p1').id, 'old')
  s = L.applyLedgerEvent(s, { t: 'state', at: 4, id: 'old', state: 'stopped' })
  assert.equal(L.attentionToLedger(s, { paneId: 'p1', state: 'asking', prompt: 'x' }, 5), null)
})

await check('LiveLedger.handleAttention applies it and hands back a news event', () => {
  const ledger = new L.LiveLedger({ file: null, now: () => 50 })
  const job = ledger.createJob({ title: 'Run the tests', owner: 'pane', paneId: 'p7', paneName: 'Koraos' })
  assert.match(job.id, /^job-/)
  const seen = []
  const off = ledger.subscribe((snap) => seen.push(snap.seq))
  const news = ledger.handleAttention({ paneId: 'p7', state: 'asking', prompt: 'Allow npm test?' })
  assert.equal(news.type, 'news')
  assert.equal(news.jobId, job.id)
  assert.equal(news.urgency, 'needs-you')
  assert.ok(news.id)
  assert.equal(ledger.get(job.id).state, 'needs-you')
  assert.ok(seen.length >= 1)
  off()
  assert.equal(ledger.handleAttention({ paneId: 'nobody', state: 'done', prompt: '' }), null)
})

console.log('the digest')

await check('needs-you first, then working, waiting, finished; newest first; newest steps under unfinished jobs', () => {
  const now = 10 * 60_000
  let s = apply(
    L.EMPTY_LEDGER,
    create('q', 1000, { title: 'Queued job' }),
    create('r', 2000, { title: 'Running job', state: 'running' }),
    create('d', 3000, { title: 'Done job', state: 'done' }),
    create('n', 500, { title: 'Needs job', state: 'needs-you', paneName: 'Xander', project: 'forge' }),
    { t: 'step', at: 4000, id: 'r', text: 'first step' },
    { t: 'step', at: 5000, id: 'r', text: 'second step' },
    { t: 'step', at: 6000, id: 'r', text: 'third step' }
  )
  const text = L.ledgerDigest(s, 1500, now)
  const lines = text.split('\n')
  assert.match(lines[0], /^- Needs you: Needs job \(pane Xander, project forge\)/)
  assert.match(lines[1], /^- Working: Running job/)
  assert.equal(lines[2], '    · third step')
  assert.equal(lines[3], '    · second step')
  assert.ok(!text.includes('first step'), 'only the newest two steps')
  assert.match(lines[4], /^- Waiting: Queued job/)
  assert.match(lines[5], /^- Done: Done job/)
  assert.equal(L.ledgerDigest(L.EMPTY_LEDGER), 'No jobs.')
  s = L.EMPTY_LEDGER
  for (let i = 0; i < 9; i++) s = apply(s, create(`f${i}`, 100 + i, { state: 'done' }))
  assert.equal(L.ledgerDigest(s, 1500, now).split('\n').filter((l) => l.startsWith('- Done')).length, 5, 'the last five finished')
})

await check('the digest never runs past maxChars and cuts whole lines', () => {
  let s = L.EMPTY_LEDGER
  for (let i = 0; i < 60; i++) {
    s = apply(s, create(`j${i}`, 1000 + i, { state: 'running', title: `A fairly long job title number ${i} for the digest` }))
    s = L.applyLedgerEvent(s, { t: 'step', at: 2000 + i, id: `j${i}`, text: 'x'.repeat(190) })
  }
  for (const max of [1500, 400, 120, 30]) {
    const text = L.ledgerDigest(s, max, 10_000)
    assert.ok(text.length <= max, `${text.length} > ${max}`)
    assert.ok(text.length > 0)
  }
  const d = L.ledgerDigest(s, 1500, 10_000)
  assert.match(d, /…and \d+ more$/)
  assert.match(d.split('\n')[0], /number 59/, 'newest running first')
  // The LiveLedger default is 1500.
  const ledger = new L.LiveLedger({ file: null, now: () => 10_000 })
  for (const job of s.jobs) ledger.createJob({ ...job, id: job.id })
  assert.ok(ledger.digest().length <= 1500)
})

console.log('reload from the log')

const dir = mkdtempSync(join(tmpdir(), 'forge-live-check-'))
try {
  await check('a new ledger replays the JSONL: jobs, steps and states come back; a torn line is skipped', () => {
    const file = join(dir, 'live', 'ledger.jsonl')
    let t = 1_000_000
    const a = new L.LiveLedger({ file, now: () => t })
    const j1 = a.createJob({ title: 'Build it', owner: 'conductor', project: 'forge' })
    t += 10
    a.setState(j1.id, 'running', 'Building')
    a.addStep(j1.id, 'Opened a pane')
    const j2 = a.createJob({ id: 'pane-job', title: 'Watch Xander', owner: 'pane', paneId: 'p1' })
    a.handleAttention({ paneId: 'p1', state: 'asking', prompt: 'Proceed?' })
    appendFileSync(file, '{"t":"step","at":5,"id":"pane-jo')
    const b = new L.LiveLedger({ file, now: () => t + 1000 })
    b.load()
    assert.deepEqual(b.snapshot().jobs, a.snapshot().jobs)
    assert.equal(b.get(j1.id).steps[0].text, 'Opened a pane')
    assert.equal(b.get(j2.id).state, 'needs-you')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, 'compacted to one put per job')
    assert.ok(lines.every((l) => JSON.parse(l).t === 'put'))
    // And the compacted file replays to the same thing.
    const c = new L.LiveLedger({ file, now: () => t + 2000 })
    c.load()
    assert.deepEqual(c.snapshot().jobs, a.snapshot().jobs)
  })

  await check('only the last 24 h come back', () => {
    const file = join(dir, 'old.jsonl')
    const day = S.LIVE_KEEP_MS
    writeFileSync(
      file,
      [
        JSON.stringify(create('stale', 1000)),
        JSON.stringify(create('fresh', day + 5000)),
        'not json',
        JSON.stringify({ t: 'step', at: day + 6000, id: 'fresh', text: 'still here' })
      ].join('\n') + '\n'
    )
    const ledger = new L.LiveLedger({ file, now: () => day + 1000 + 5000 })
    ledger.load()
    assert.deepEqual(ledger.snapshot().jobs.map((j) => j.id), ['fresh'])
    assert.equal(ledger.get('fresh').steps[0].text, 'still here')
  })

  await check('a missing file starts empty, and the ledger still writes', () => {
    const file = join(dir, 'nested', 'deeper', 'ledger.jsonl')
    const ledger = new L.LiveLedger({ file })
    ledger.load()
    assert.deepEqual(ledger.snapshot().jobs, [])
    ledger.createJob({ title: 'x', owner: 'operator' })
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('the contract')

const preloadSrc = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8')
const storeSrc = readFileSync(new URL('../electron/store.ts', import.meta.url), 'utf8')
const mainSrc = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

await check('the IPC channel names and the preload methods match the contract', () => {
  assert.deepEqual(S.LIVE_IPC, {
    ask: 'live:ask',
    cancel: 'live:cancel',
    jobAction: 'live:job-action',
    ledger: 'live:ledger',
    status: 'live:status',
    start: 'live:start',
    stop: 'live:stop',
    latency: 'live:latency',
    event: 'live:event'
  })
  const block = preloadSrc.slice(preloadSrc.indexOf('  live: {'), preloadSrc.indexOf('  },', preloadSrc.indexOf('  live: {')))
  for (const name of ['ask', 'cancelTurn', 'jobAction', 'ledger', 'status', 'start', 'stop', 'logLatency', 'onEvent']) {
    assert.ok(new RegExp(`\\n    ${name}: `).test(block), `preload live.${name}`)
  }
  assert.ok(/logLatency: \(sample\) => ipcRenderer\.send\(LIVE_IPC\.latency/.test(block), 'logLatency is a send, not an invoke')
  assert.ok(/\n      initLive\(\)\n/.test(mainSrc), 'main calls initLive at startup')
})

await check('settings: voice model Opus by default (Opus, Sonnet, Haiku), Conductor Opus, ears OpenAI', () => {
  assert.deepEqual(S.LIVE_VOICE_MODELS, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  assert.equal(S.DEFAULT_LIVE_VOICE_MODEL, 'claude-opus-5-5')
  assert.deepEqual(S.LIVE_CONDUCTOR_MODELS, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])
  assert.equal(S.DEFAULT_LIVE_CONDUCTOR_MODEL, 'claude-opus-5-5')
  assert.equal(S.DEFAULT_LIVE_EARS, 'openai')
  assert.ok(S.isLiveVoiceModel('claude-haiku-5-5') && !S.isLiveVoiceModel('claude-fable-5-1'))
  assert.ok(S.isLiveConductorModel('claude-fable-5-1') && !S.isLiveConductorModel('claude-haiku-5-5'))
  assert.ok(S.isLiveEars('parakeet') && !S.isLiveEars('groq'))
  assert.ok(/liveVoiceModel: DEFAULT_LIVE_VOICE_MODEL,/.test(storeSrc), 'store default')
  assert.ok(/liveVoiceModel: isLiveVoiceModel\(s\.liveVoiceModel\)/.test(storeSrc), 'store sanitises')
  assert.ok(/liveConductorModel: isLiveConductorModel\(s\.liveConductorModel\)/.test(storeSrc))
  assert.ok(/liveEars: isLiveEars\(s\.liveEars\)/.test(storeSrc))
  assert.ok(/'anthropicKey',/.test(storeSrc.slice(storeSrc.indexOf('const SECRET_FIELDS'))), 'the Anthropic key is a secret at rest')
})

console.log('the brains (L1)')

const H = await import('../electron/live/brain-helpers.ts')

await check('per-model params: Opus omits thinking, Sonnet between_tools, Haiku disabled; all at low effort', () => {
  assert.deepEqual(H.voiceModelParams('claude-opus-5-5'), { output_config: { effort: 'low' } })
  assert.deepEqual(H.voiceModelParams('claude-sonnet-5-5'), { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } })
  assert.deepEqual(H.voiceModelParams('claude-haiku-5-5'), { thinking: { type: 'disabled' }, output_config: { effort: 'low' } })
  assert.deepEqual(H.voiceSdkThinking('claude-haiku-5-5'), { type: 'disabled' })
  assert.equal(H.voiceSdkThinking('claude-opus-5-5'), undefined)
  assert.equal(H.voiceSdkThinking('claude-sonnet-5-5'), undefined)
})

await check('the key: trimmed; an undecrypted enc: value is no key', () => {
  assert.equal(H.anthropicKeyOf({ anthropicKey: '  sk-ant-x  ' }), 'sk-ant-x')
  assert.equal(H.anthropicKeyOf({ anthropicKey: 'enc:abc' }), '')
  assert.equal(H.anthropicKeyOf({}), '')
})

await check('history: append-only under the cap; over it the last 20 turns, every thinking block out', () => {
  const turn = (i) => [
    { role: 'user', content: `u${i}` },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: `a${i}` }] }
  ]
  const few = Array.from({ length: 30 }, (_, i) => turn(i))
  assert.equal(H.trimTurns(few), few, 'at the cap: the same array')
  const many = [...few, turn(30)]
  const kept = H.trimTurns(many)
  assert.equal(kept.length, 20)
  assert.equal(kept[0][0].content, 'u11')
  assert.ok(kept.every((t) => t[1].content.every((b) => b.type !== 'thinking')), 'no thinking survives a trim')
  assert.equal(kept[19][1].content[0].text, 'a30', 'text stays')
  assert.ok(H.turnsWithoutThinking(few).every((t) => t[1].content.length === 1))
})

await check('history: a system message only after a user message and before an assistant one (or last); empties go', () => {
  const ok = [
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'state' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: 'and' },
    { role: 'system', content: 'state 2' }
  ]
  assert.deepEqual(H.normaliseHistory(ok), ok, 'valid history is unchanged')
  const bad = [
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'unanswered' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'system', content: 'after an assistant' }
  ]
  assert.deepEqual(H.normaliseHistory(bad).map((m) => m.role), ['user', 'user', 'assistant'])
})

await check('the state block: only what changed since the model last saw it', () => {
  const none = { app: '', digest: '' }
  const both = H.stateBlock('app A', 'jobs A', none)
  assert.ok(both.includes('# FORGE RIGHT NOW') && both.includes('app A') && both.includes('# JOBS') && both.includes('jobs A'))
  const seen = H.seenState('app A', 'jobs A')
  assert.equal(H.stateBlock('app A', 'jobs A', seen), '')
  const jobsOnly = H.stateBlock('app A', 'jobs B', seen)
  assert.ok(!jobsOnly.includes('FORGE RIGHT NOW') && jobsOnly.includes('jobs B'))
  assert.ok(H.stateBlock('x'.repeat(9000), '', none).length < H.STATE_APP_MAX + 100, 'the app state is capped')
})

await check('news: paneless needs-you and done, any failure; a new job, a pane job and a stop are not news', () => {
  const job = (id, state, extra = {}) => ({ id, title: `Job ${id}`, owner: 'conductor', state, steps: [], createdAt: 1, updatedAt: 1, ...extra })
  const prev = new Map([['a', 'running'], ['b', 'running'], ['c', 'running'], ['d', 'running'], ['e', 'running']])
  const snap = {
    seq: 9,
    jobs: [
      job('a', 'done', { summary: 'tests pass' }),
      job('b', 'needs-you', { summary: 'which branch?' }),
      job('c', 'done', { paneId: 'p1', paneName: 'Kess' }),
      job('d', 'failed', { paneId: 'p2', summary: 'pane died' }),
      job('e', 'stopped'),
      job('f', 'queued')
    ]
  }
  const { items, next } = H.ledgerNews(prev, snap)
  assert.deepEqual(items, [
    { jobId: 'a', urgency: 'done', text: 'Job a is done: tests pass' },
    { jobId: 'b', urgency: 'needs-you', text: 'Job b needs you: which branch?' },
    { jobId: 'd', urgency: 'done', text: 'Job d failed: pane died' }
  ])
  assert.equal(next.get('f'), 'queued')
  assert.deepEqual(H.ledgerNews(next, snap).items, [], 'no change, no news')
  assert.equal(H.batchNewsText(items.slice(0, 1).concat(items.slice(2))), 'Job a is done: tests pass. Job d failed: pane died.')
})

await check('the Conductor: brief and steer messages carry the job id; a restart loses only paneless Conductor jobs', () => {
  const brief = H.conductorBrief({ id: 'job-1', title: 'Run tests', project: 'koraos' }, 'run npm test')
  assert.ok(brief.startsWith('[Job job-1: Run tests]\nProject: koraos.'))
  assert.ok(brief.includes('run npm test') && brief.includes('jobId "job-1"'))
  assert.ok(H.conductorSteer({ id: 'job-1', title: 'Run tests', paneName: 'Kess' }, 'only unit').includes('Kess'))
  const job = (id, owner, state, extra = {}) => ({ id, title: id, owner, state, steps: [], createdAt: 1, updatedAt: 1, ...extra })
  const snap = {
    seq: 1,
    jobs: [
      job('lost', 'conductor', 'running'),
      job('waiting', 'conductor', 'queued'),
      job('onpane', 'conductor', 'running', { paneId: 'p1' }),
      job('pane', 'pane', 'running'),
      job('over', 'conductor', 'done')
    ]
  }
  assert.deepEqual(H.jobsLostInRestart(snap), ['lost', 'waiting'])
})

await check('the Conductor: an opened pane is read off open_agent_pane; steps are short and plain', () => {
  assert.deepEqual(H.paneOpenedIn('OK: Opened Zeb (Claude) inside Forge (pane id p-12) — the prompt goes in'), { paneId: 'p-12', paneName: 'Zeb' })
  assert.deepEqual(H.paneOpenedIn("OK: opened Kess (Codex) in koraos (pane id abc); Steve's screen stayed"), { paneId: 'abc', paneName: 'Kess' })
  assert.deepEqual(H.paneOpenedIn('OK: Opened a new Claude pane inside Forge (pane id q9)'), { paneId: 'q9' })
  assert.equal(H.paneOpenedIn('FAILED: no agent called "x" (pane id nope)'), null)
  assert.equal(H.toolResponseText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'one\ntwo')
  assert.equal(H.toolResponseText({ content: [{ type: 'text', text: 'x' }] }), 'x')
  assert.equal(H.describeToolStep('mcp__forge__report', {}), null)
  assert.equal(H.describeToolStep('mcp__forge__open_agent_pane', { agent: 'claude', name: 'Kess', project: 'koraos' }), 'Opened a claude pane (Kess) in koraos')
  assert.equal(H.describeToolStep('mcp__forge__read_pane', { target: 'Kess' }), "Read Kess's screen")
  assert.equal(H.describeToolStep('Read', { file_path: 'C:\\x\\y\\HANDOFF.md' }), 'Read HANDOFF.md')
  assert.equal(H.describeToolStep('mcp__forge-bridge__make_image', {}), 'Used make image')
})

await check('the voice brain: news batches done for the window, needs-you at once', async () => {
  const V = await import('../electron/live/voice-brain.ts')
  const ledger = new L.LiveLedger({ file: null })
  const events = []
  const ctx = { emit: (e) => events.push(e), ledger, settings: () => ({}) }
  const a = ledger.createJob({ title: 'Alpha', owner: 'conductor' })
  const b = ledger.createJob({ title: 'Beta', owner: 'conductor' })
  const c = ledger.createJob({ title: 'Gamma', owner: 'conductor' })
  const news = new V.LiveNewsQueue(ctx, 40)
  news.start()
  ledger.setState(a.id, 'done', 'all green')
  ledger.setState(c.id, 'needs-you', 'which folder?')
  ledger.setState(b.id, 'failed', 'no tests')
  assert.deepEqual(events.map((e) => e.urgency), ['needs-you'], 'needs-you goes out at once')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'news')
  assert.equal(events[1].urgency, 'done')
  assert.equal(events[1].text, 'Alpha is done: all green. Beta failed: no tests.')
  assert.equal(events[1].jobId, undefined, 'a batch names no one job')
  news.stop()
  ledger.setState(c.id, 'done')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(events.length, 2, 'stopped: no more news')
})

await check('the Conductor: a restart closes its lost jobs with a step; stop and cancel on a waiting job never open a session', async () => {
  const C = await import('../electron/live/conductor.ts')
  const ledger = new L.LiveLedger({ file: null })
  const lost = ledger.createJob({ title: 'Lost', owner: 'conductor', state: 'running' })
  const onPane = ledger.createJob({ title: 'On a pane', owner: 'conductor', state: 'running', paneId: 'p1' })
  const ctx = { emit: () => {}, ledger, settings: () => ({}) }
  const conductor = new C.Conductor(ctx, { askRenderer: async () => 'unused' })
  assert.equal(ledger.get(lost.id).state, 'failed')
  assert.equal(ledger.get(lost.id).summary, 'Forge restarted before it finished')
  assert.equal(ledger.get(lost.id).steps.at(-1).text, 'Forge restarted, so the Conductor lost this job')
  assert.equal(ledger.get(onPane.id).state, 'running', 'a pane job carries on')
  assert.equal(conductor.busy(), false)
  assert.deepEqual(await conductor.steer('nope', 'x'), { ok: false, error: 'No such job.' })
  assert.equal((await conductor.steer(lost.id, 'x')).ok, false, 'a finished job cannot be steered')
  assert.deepEqual(await conductor.cancel(onPane.id), { ok: true })
  assert.equal(ledger.get(onPane.id).state, 'stopped')
  await conductor.stop()
})

await check('host.ts: ask_brain and tell_brain are allowed; the Conductor profile is additive', () => {
  const hostSrc = readFileSync(new URL('../electron/voice-agent/host.ts', import.meta.url), 'utf8')
  assert.ok(hostSrc.includes("'mcp__forge__ask_brain',") && hostSrc.includes("'mcp__forge__tell_brain',"))
  assert.ok(/const profile = this\.deps\.profile/.test(hostSrc))
  const indexSrc = readFileSync(new URL('../electron/live/index.ts', import.meta.url), 'utf8')
  assert.ok(/deps\.conductor \?\? realConductor/.test(indexSrc) && /deps\.voiceBrain \?\? realVoiceBrain/.test(indexSrc), 'the real brains are the defaults')
})

await check('L4 wiring: the bar drives Live, the card and the OpenAI ears are wired end to end', () => {
  const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  // The OpenAI ears' handshake: channel, handler, preload, typed call.
  const ipc = src('shared/ipc.ts')
  assert.ok(ipc.includes("realtimeOpenAITranscribeConnect: 'realtime:openai-transcribe-connect'"))
  assert.ok(/IPC\.realtimeOpenAITranscribeConnect,[\s\S]{0,200}connectOpenAITranscription\(getSettings\(\)\.openaiKey/.test(src('electron/realtime/ipc.ts')))
  const preload = src('electron/preload.ts')
  assert.ok(/openaiTranscribeConnect: \(req\) => ipcRenderer\.invoke\(IPC\.realtimeOpenAITranscribeConnect/.test(preload))
  assert.ok(!/openaiTranscribeConnect\?: TranscribeConnect \}/.test(src('src/lib/live/ears-openai.ts')), 'the loose bridge type is gone')
  // The desktop card: every channel has its sender and its handler.
  for (const ch of ['livecardOffer', 'livecardAnswer', 'livecardDone', 'livecardClickThrough']) {
    assert.ok(preload.includes(`IPC.${ch}`), `preload sends ${ch}`)
    assert.ok(src('electron/live-card-window.ts').includes(`ipcMain.on(IPC.${ch}`), `main handles ${ch}`)
  }
  assert.ok(preload.includes('IPC.livecardShow') && preload.includes('IPC.livecardChoice'))
  const main = src('electron/main.ts')
  assert.ok(main.includes('registerLiveCardIpc()') && main.includes("safely('disposeLiveCard', disposeLiveCard)") && main.includes('watchMainForLiveCard(mainWindow)'))
  assert.ok(src('src/main.tsx').includes('window.forge.liveCard?.isLiveCard?.()'), 'the #livecard window gets its own tree')
  assert.ok(src('src/main.tsx').includes('<LiveControllerProvider>'), 'the Live shell is mounted once, above the hub')
  // The bar: Claude Live never arms the VoiceAgent, and Listen off never stops the jobs.
  const hubSrc = src('src/state/VoiceHubController.tsx')
  assert.ok(/pick\.brain === 'claude-live'\) \{[\s\S]{0,160}liveRef\.current\.start\(\)[\s\S]{0,20}return/.test(hubSrc))
  const ctl = src('src/state/live/LiveController.tsx')
  const stopBody = ctl.slice(ctl.indexOf('  async stop(): Promise<void> {'), ctl.indexOf('  async toggle(): Promise<void> {'))
  assert.ok(stopBody.length > 0 && !/liveApi\(\)\??\.stop\(|live\.stop\(/.test(stopBody), 'Listen off does not call live.stop()')
  assert.ok(!/void live\.stop\(\)/.test(ctl), 'a failed start does not stop the jobs either')
  // Parakeet's phrases go to Live only while its ears hold them.
  assert.ok(/if \(liveEarsHoldPhrases\(\)\) return/.test(src('src/hooks/useDictation.ts')))
  assert.ok(src('src/App.tsx').includes('<LiveMount />'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

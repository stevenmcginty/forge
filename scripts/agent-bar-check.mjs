/**
 * agent-bar:check — the Agent bar's mic and routing rules, offline (B7).
 *
 *  - ONE press always works: a cold start (sidecar not ready), a wake session
 *    that is only monitoring, and a provider switch all reach real capture
 *    with no second press.
 *  - "Listening" only while the recogniser is really recording; "Starting…"
 *    until then; words for every other state.
 *  - Hands-free: a phrase end needs no Send, and the mic stays open for the
 *    next turn; the silence window rides along with every agent start.
 *  - ONE brain setting: the migration from the two old pickers, and the
 *    no-key fallback, route every turn.
 *
 *   node scripts/agent-bar-check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import './ts-hooks.mjs'

const M = await import('../src/lib/realtime/micstate.ts')
const P = await import('../src/lib/realtime/provider.ts')
const B = await import('../shared/agent-brain.ts')
const E = await import('../src/lib/realtime/errors.ts')
const C = await import('../src/lib/realtime/context.ts')

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

/** Replay a sidecar status sequence after ONE press; returns what the hook did. */
function replay(statuses) {
  let wanted = true // the one press
  const armed = true
  const did = []
  const notes = []
  for (const s of statuses) {
    const step = M.listenStep({ armed, wanted, speaking: false, ...s })
    did.push(step)
    if (step === 'done' || step === 'clear') wanted = false
    const rec = {
      phase: s.phase,
      ready: s.ready ?? true,
      capturing: M.isCapturing(s.phase, s.mode, s.capturing),
      wake: s.mode === 'wake',
      wanted
    }
    notes.push(M.micState({ realtime: false, phase: 'listening', muted: false, armed, recogniser: rec, errorReason: null }).listenNote)
  }
  return { did, notes, wanted }
}

console.log('one press, every start')
await check('cold start: sidecar still loading → Starting… → capture begins by itself', () => {
  const r = replay([
    { phase: 'starting', mode: 'phrase', ready: false, capturing: false },
    { phase: 'idle', mode: 'phrase', ready: true, capturing: false },
    { phase: 'listening', mode: 'phrase', ready: true, capturing: true }
  ])
  assert.deepEqual(r.did, ['wait', 'wait', 'done'])
  assert.deepEqual(r.notes, ['Starting…', 'Starting…', 'Listening'])
  assert.equal(r.wanted, false, 'the press is honoured once, never needs repeating')
})
await check('wake session only monitoring (Steve: wake word on) → the hook captures inside it', () => {
  const r = replay([
    { phase: 'listening', mode: 'wake', ready: true, capturing: false },
    { phase: 'listening', mode: 'wake', ready: true, capturing: true }
  ])
  assert.deepEqual(r.did, ['capture', 'done'])
  assert.deepEqual(r.notes, ['Starting…', 'Listening'], 'never "Listening" while only monitoring')
})
await check('provider switch (Gemini Live → Claude), then first press → capture with no second press', () => {
  const before = P.resolveAgentBrain('gemini-live', { geminiKey: 'AIza-x' })
  assert.equal(before.realtime, 'gemini-live')
  const after = P.resolveAgentBrain('claude', { geminiKey: 'AIza-x' })
  assert.equal(after.realtime, null, 'Claude is a Parakeet brain: the press goes to listenNow')
  const r = replay([
    { phase: 'off', mode: 'phrase', ready: true, capturing: false },
    { phase: 'starting', mode: 'phrase', ready: true, capturing: false },
    { phase: 'listening', mode: 'phrase', ready: true, capturing: true }
  ])
  assert.deepEqual(r.did, ['wait', 'wait', 'done'])
})
await check('disarmed mid-start: the pending press is dropped, not replayed later', () => {
  assert.equal(M.listenStep({ armed: false, wanted: true, speaking: false, phase: 'starting' }), 'clear')
})

console.log('honest words')
await check('monitoring with no press pending says so', () => {
  const s = M.micState({
    realtime: false,
    phase: 'listening',
    muted: false,
    armed: true,
    recogniser: { phase: 'listening', ready: true, capturing: false, wake: true, wanted: false },
    errorReason: null
  })
  assert.deepEqual(s, { capturing: false, starting: false, listenNote: 'Waiting for "Hey Jarvis"' })
})
await check('mic on but idle is "Mic on · not recording", never "Listening"', () => {
  const s = M.micState({
    realtime: false,
    phase: 'listening',
    muted: false,
    armed: true,
    recogniser: { phase: 'idle', ready: true, capturing: false, wake: false, wanted: false },
    errorReason: null
  })
  assert.equal(s.listenNote, 'Mic on · not recording')
  assert.equal(s.capturing, false)
})
await check('an error reason replaces the word unless it is really recording', () => {
  const s = M.micState({ realtime: true, phase: 'error', muted: false, armed: false, errorReason: 'Gemini: key refused' })
  assert.equal(s.listenNote, 'Gemini: key refused')
})
await check('realtime: connecting is Starting…, live is Listening, muted is Muted', () => {
  assert.equal(M.micState({ realtime: true, phase: 'connecting', muted: false, armed: false, errorReason: null }).listenNote, 'Starting…')
  assert.equal(M.micState({ realtime: true, phase: 'listening', muted: false, armed: false, errorReason: null }).listenNote, 'Listening')
  assert.equal(M.micState({ realtime: true, phase: 'listening', muted: true, armed: false, errorReason: null }).listenNote, 'Muted')
})
await check('error reasons in words', () => {
  assert.equal(E.errorReasonOf('gemini', 'Gemini token: the key was refused (403) — API key not valid'), 'Gemini: key refused')
  assert.equal(E.errorReasonOf('gemini', 'Gemini token failed (429) — RESOURCE_EXHAUSTED'), 'Gemini: free-tier limit (429)')
  assert.equal(E.errorReasonOf('gemini', 'Gemini Live closed the connection (1007)'), 'Gemini: setup rejected')
  assert.equal(E.errorReasonOf('openai', 'No OpenAI key is set — add one in Settings'), 'OpenAI: no key')
  assert.equal(E.errorReasonOf('parakeet', 'the parakeet model is missing'), 'Parakeet: model missing')
})

console.log('hands-free')
const agent = readFileSync(new URL('../src/state/VoiceAgent.tsx', import.meta.url), 'utf8')
await check('the bar mic starts a plain conversation (no wake word), with the silence window', () => {
  assert.ok(/handsFreeRef\.current = true/.test(agent), 'listenNow marks the conversation hands-free')
  assert.ok(/: \{ conversation: true, pauseCut \}/.test(agent), 'the hands-free start is a conversation with pauseCut')
  assert.ok(/Math\.min\(2000, Math\.max\(500, silenceMsRef\.current \|\| 800\)\) \/ 1000/.test(agent), '0.5–2 s, default 0.8 s')
})
await check('a finished phrase goes to the brain with no Send press (ask → runPhrase)', () => {
  assert.ok(/const ask = useCallback\([\s\S]*?return runPhrase\(body\)/.test(agent))
})
await check('the mic stays open for the next turn: the re-arm poll restarts a phrase session after it idles', () => {
  assert.ok(/if \(stt\.phase !== 'idle' && stt\.phase !== 'off'\) return undefined[\s\S]{0,300}startListening\(\)/.test(agent))
})

console.log('one Agent brain')
await check('migration: Steve\'s profile (hub claude + voiceBrain gemini) → Claude', () => {
  assert.equal(B.migrateAgentBrain('claude', 'gemini'), 'claude')
})
await check('migration: a realtime hub pick wins; groq/openrouter text brains carry over; the rest → Claude', () => {
  assert.equal(B.migrateAgentBrain('gemini-live', 'groq'), 'gemini-live')
  assert.equal(B.migrateAgentBrain('claude', 'groq'), 'groq')
  assert.equal(B.migrateAgentBrain(undefined, 'openrouter'), 'openrouter')
  assert.equal(B.migrateAgentBrain(undefined, 'stub'), 'claude')
})
await check('a keyed brain with no key falls back to Claude and says why', () => {
  const r = P.resolveAgentBrain('gpt-realtime', { openaiKey: '' })
  assert.equal(r.brain, 'claude')
  assert.match(r.fallbackReason, /No OpenAI key/)
  assert.equal(P.resolveAgentBrain('groq', { groqKey: 'gsk_x' }).brain, 'groq')
})

console.log('live context')
await check('the manifest names call-sign, panel, agent, state and focus; unchanged state is not re-sent', () => {
  const text = C.buildAppContext({
    projectName: 'Forge Dev',
    otherProjects: ['landing'],
    branch: 'desktop-redesign',
    tabs: [{ number: 1, title: 'Main', active: true }],
    panes: [
      { paneId: 'a', tabId: 't', tabNumber: 1, tabTitle: 'Main', number: 1, title: 'Claude Code', profileId: 'claude', profileName: 'Claude Code', live: true, focused: true, agent: true, lastFocusedAt: 0, callSign: 'Everest', state: 'working' },
      { paneId: 'b', tabId: 't', tabNumber: 1, tabTitle: 'Main', number: 2, title: 'Codex', profileId: 'codex', profileName: 'Codex', live: true, focused: false, agent: true, lastFocusedAt: 0, callSign: 'Skylar', state: 'asking' }
    ]
  })
  assert.match(text, /branch desktop-redesign/)
  assert.match(text, /Everest · panel 1 · tab 1 · Claude Code · working · FOCUSED/)
  assert.match(text, /Skylar · panel 2 · tab 1 · Codex · asking/)
  const t = new C.ContextTracker()
  assert.equal(t.take(text), text)
  assert.equal(t.take(text), null, 'the same state is not sent twice')
  assert.ok(text.length < 1200, `compact: ${text.length} chars for two panes`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

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
 *  - The voice agent picker beside Listen: one row per brain, the pick
 *    writes agentBrain as Settings does, and both read one status.
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
await check('the manifest names each terminal once (name, agent, state, focus); unchanged state is not re-sent', () => {
  const text = C.buildAppContext({
    projectName: 'Forge Dev',
    otherProjects: ['landing'],
    branch: 'desktop-redesign',
    panes: [
      { paneId: 'a', tabId: 't', tabNumber: 1, tabTitle: 'Zeb', number: 1, name: 'Zeb', profileId: 'claude', profileName: 'Claude Code', live: true, focused: true, agent: true, lastFocusedAt: 0, state: 'working' },
      { paneId: 'b', tabId: 't', tabNumber: 1, tabTitle: 'Zeb', number: 2, name: 'Zeb 2', profileId: 'codex', profileName: 'Codex', live: true, focused: false, agent: true, lastFocusedAt: 0, state: 'asking' }
    ]
  })
  assert.match(text, /branch desktop-redesign/)
  assert.match(text, /- Zeb · Claude Code · working · focused/)
  assert.match(text, /- Zeb 2 · Codex · asking/)
  // One name per terminal: no numbers, no tab line, no call-signs.
  assert.doesNotMatch(text, /panel \d|tab \d|Terminal \d|call-sign/)
  const t = new C.ContextTracker()
  assert.equal(t.take(text), text)
  assert.equal(t.take(text), null, 'the same state is not sent twice')
  assert.ok(text.length < 1200, `compact: ${text.length} chars for two panes`)
})

/* ------------------------------------------------ the conversation (B11) */

const V = await import('../src/lib/realtime/conversation.ts')
const hubSrc = readFileSync(new URL('../src/state/VoiceHubController.tsx', import.meta.url), 'utf8')
const barSrc = readFileSync(new URL('../src/components/hub/VoicePill.tsx', import.meta.url), 'utf8')
const layerSrc = readFileSync(new URL('../src/components/hub/HubLayer.tsx', import.meta.url), 'utf8')

console.log('the conversation: stop phrases')
await check('"that\'s all" / "stop listening" and close variants end it, in canonical words', () => {
  for (const said of ["That's all.", 'That is all.', 'Okay, that’s all, thanks.', "That's all for now.", 'That will be all.', "That's everything."]) {
    assert.equal(V.stopPhraseOf(said), "that's all", said)
  }
  for (const said of ['Stop listening.', 'You can stop listening now.', 'OK stop listening, thanks.', 'End the conversation.']) {
    assert.equal(V.stopPhraseOf(said), 'stop listening', said)
  }
  assert.equal(V.stopPhraseOf('Goodbye.'), 'goodbye')
})
await check('a sentence that only contains the words is a sentence, not a goodbye', () => {
  for (const said of ["That's all the files in there.", 'Stop listening to that pane.', 'Is that all?', 'Tell me when that is all done.', 'all right', '']) {
    assert.equal(V.stopPhraseOf(said), null, said)
  }
})
await check('Parakeet: the stop phrase is matched before the grammar and the brain, spoken only, and ends the conversation', () => {
  const at = agent.indexOf('const stop = stopPhraseOf(said)')
  assert.ok(at > 0, 'runPhrase checks stop phrases')
  assert.ok(at < agent.indexOf('const hit = ctx ? parseUtterance(said, ctx) : null'), 'before the grammar')
  assert.ok(at < agent.indexOf('if (usingClaudeRef.current) {'), 'before the brain')
  assert.ok(/const spokenHere = !opts\?\.silent && !typed/.test(agent), 'never a typed line or a phone message')
  assert.ok(/endConversationRef\.current\(end\)[\s\S]{0,120}return ''/.test(agent), 'it ends the conversation and gives the brain no turn')
})
await check('realtime: a user caption that is a stop phrase ends the live session', () => {
  assert.ok(/if \(c\.role === 'user'\) onUserCaption\(c\)/.test(hubSrc))
  assert.ok(/const stop = typed \? null : stopPhraseOf\(c\.text\)/.test(hubSrc), 'typed text is never taken for a spoken goodbye')
})

console.log('the conversation: idle timeout')
await check('agentIdleTimeoutMs: default 2 min, 30 s – 10 min, 0 = never', () => {
  assert.equal(V.IDLE_TIMEOUT_DEFAULT_MS, 120000)
  assert.equal(V.normaliseIdleTimeout(undefined), 120000)
  assert.equal(V.normaliseIdleTimeout(0), 0)
  assert.equal(V.normaliseIdleTimeout(-5), 0)
  assert.equal(V.normaliseIdleTimeout(5000), 30000)
  assert.equal(V.normaliseIdleTimeout(60_400), 60000)
  assert.equal(V.normaliseIdleTimeout(99e9), 600000)
  const store = readFileSync(new URL('../electron/store.ts', import.meta.url), 'utf8')
  assert.ok(/agentIdleTimeoutMs: 120_000/.test(store), 'store default')
  assert.ok(/clamp\(Math\.round\(s\.agentIdleTimeoutMs \/ 1000\) \* 1000, 30_000, 600_000\)/.test(store), 'store clamps the same way')
})
await check('the clock runs only while open and listening, and counts from the last thing that was not quiet', () => {
  const base = { open: true, listening: true, timeoutMs: 120000, lastActivityAt: 1000 }
  assert.equal(V.idleRemainingMs({ ...base, now: 1000 }), 120000)
  assert.equal(V.idleRemainingMs({ ...base, now: 61000 }), 60000)
  assert.equal(V.idleRemainingMs({ ...base, now: 999999 }), 0, 'overdue ends it now')
  assert.equal(V.idleRemainingMs({ ...base, listening: false, now: 61000 }), null, 'thinking or speaking is not quiet')
  assert.equal(V.idleRemainingMs({ ...base, open: false, now: 61000 }), null)
  assert.equal(V.idleRemainingMs({ ...base, timeoutMs: 0, now: 61000 }), null, 'Never')
  assert.ok(/endConversationRef\.current\(\{ kind: 'idle', ms: idleMs \}\)/.test(hubSrc), 'the hub ends it on the clock')
})
await check('why it ended, in words', () => {
  assert.equal(V.endedNote({ kind: 'phrase', phrase: "that's all" }), 'Conversation ended — you said "that\'s all"')
  assert.equal(V.endedNote({ kind: 'idle', ms: 120000 }), 'Conversation ended — 2 min quiet')
  assert.equal(V.endedNote({ kind: 'idle', ms: 30000 }), 'Conversation ended — 30 s quiet')
  assert.equal(V.endedNote({ kind: 'press' }), 'Conversation ended — you turned it off')
})

console.log('the conversation: honest words')
const recOn = { phase: 'listening', ready: true, capturing: true, wake: false, wanted: false }
await check('Thinking… and Speaking win over an open mic; "Listening again" after a reply', () => {
  const mic = (o) => M.micState({ realtime: false, muted: false, armed: true, recogniser: recOn, errorReason: null, ...o }).listenNote
  assert.equal(mic({ phase: 'thinking' }), 'Thinking…', 'Steve\'s trace showed "Listening" while the brain worked')
  assert.equal(mic({ phase: 'speaking' }), 'Speaking')
  assert.equal(mic({ phase: 'listening', again: true }), 'Listening again')
  assert.equal(mic({ phase: 'listening', again: false }), 'Listening')
  const rt = (o) => M.micState({ realtime: true, muted: false, armed: false, errorReason: null, ...o }).listenNote
  assert.equal(rt({ phase: 'listening', again: true }), 'Listening again')
  assert.equal(rt({ phase: 'thinking' }), 'Thinking…')
  assert.equal(rt({ phase: 'speaking' }), 'Speaking')
})
await check('off after an ending says why; an error still wins', () => {
  const ended = 'Conversation ended — you said "that\'s all"'
  assert.equal(M.micState({ realtime: false, phase: 'off', muted: false, armed: false, errorReason: null, ended }).listenNote, ended)
  assert.equal(M.micState({ realtime: true, phase: 'off', muted: false, armed: false, errorReason: null, ended }).listenNote, ended)
  assert.equal(M.micState({ realtime: true, phase: 'error', muted: false, armed: false, errorReason: 'Gemini: key refused', ended }).listenNote, 'Gemini: key refused')
})

console.log('the conversation: dictation by voice')
const panes = { everest: 'p1', skylar: 'p2', codex: 'p2', 'the codex': 'p2', this: 'p1' }
const resolve = (s) => panes[s.toLowerCase()] ?? null
await check('"type this into <name>: …" with and without the colon', () => {
  assert.deepEqual(V.parseVoiceDictation('Type this into Everest: echo hi.', resolve), { kind: 'pane', target: 'Everest', paneId: 'p1', text: 'echo hi', submit: false })
  assert.deepEqual(V.parseVoiceDictation('Type this into Everest echo hi.', resolve), { kind: 'pane', target: 'Everest', paneId: 'p1', text: 'echo hi', submit: false })
  assert.deepEqual(V.parseVoiceDictation('okay, type into Skylar, git status', resolve), { kind: 'pane', target: 'Skylar', paneId: 'p2', text: 'git status', submit: false })
})
await check('by agent type and "this pane"; "and send it" / "press enter" is the only Enter', () => {
  assert.deepEqual(V.parseVoiceDictation('Dictate into the Codex pane fix the login bug.', resolve), { kind: 'pane', target: 'the Codex pane', paneId: 'p2', text: 'fix the login bug', submit: false })
  assert.deepEqual(V.parseVoiceDictation('Type this into this pane ls, and send it.', resolve), { kind: 'pane', target: 'this pane', paneId: 'p1', text: 'ls', submit: true })
  assert.equal(V.parseVoiceDictation('Type into Everest npm test then press enter', resolve).submit, true)
  assert.equal(V.parseVoiceDictation('Type this into Everest echo send', resolve).submit, false, '"send" inside the text is text')
})
await check('"put this in the bar …" lands in the composer; unknown panes say so; other sentences are left alone', () => {
  assert.deepEqual(V.parseVoiceDictation('Put this in the bar, refactor the parser.', resolve), { kind: 'bar', text: 'refactor the parser' })
  assert.deepEqual(V.parseVoiceDictation('Type this into Zebra: echo hi', resolve), { kind: 'pane', target: 'Zebra', paneId: null, text: 'echo hi', submit: false })
  assert.equal(V.parseVoiceDictation('Write to the log file that we are done.', resolve), null, '"write to" is not dictation without a pane')
  assert.equal(V.parseVoiceDictation('What is typed into Everest?', resolve), null)
  assert.equal(V.parseVoiceDictation('Open a new Codex pane.', resolve), null)
})
await check('Parakeet: dictation by voice types raw words (no brain) through the one dictate helper', () => {
  assert.ok(/const dictation = parseVoiceDictation\(said, resolveSpokenPane\)/.test(agent))
  assert.ok(agent.indexOf('parseVoiceDictation(said') < agent.indexOf('if (usingClaudeRef.current) {'), 'before the brain')
  assert.ok(/await dictateToPane\(d\.paneId, d\.text, \{ submit: d\.submit \}\)/.test(agent))
  assert.ok(/dictateToPane\(paneId, text, opts\)/.test(hubSrc), 'hub.dictateTo is the same helper')
  assert.ok(/window\.dispatchEvent\(new CustomEvent\(HUB_COMPOSER_EVENT/.test(agent), '"put this in the bar" uses the composer event')
})

console.log('the conversation: one press, one switch')
await check('the Listen switch and the Agent key call hub.start / hub.stop, and start always opens the conversation on the Agent brain', () => {
  assert.ok(/onClick=\{\(\) => \(ls\.on \? hub\.stop\(\) : hub\.start\(\)\)\}/.test(barSrc), 'the bar switch')
  assert.ok(/if \(h\.phase === 'off' \|\| h\.phase === 'error'\) h\.start\(\)/.test(layerSrc), 'the Agent key')
  assert.ok(/if \(!pick\.realtime\) \{[\s\S]{0,300}a\.listenNow\(\)/.test(hubSrc), 'Parakeet brains: listenNow (a hands-free conversation, never dictate-into-bar)')
  assert.ok(/void startRealtime\(pick\.realtime, null\)/.test(hubSrc), 'realtime brains: the live session')
})
await check('the switch tracks the conversation: a failed turn keeps it on, ending the live session does not re-arm a hidden brain', () => {
  assert.ok(/case 'error':[\s\S]{0,400}return armed \? 'listening' : 'off'/.test(hubSrc))
  assert.ok(!/resumeAgent/.test(hubSrc), 'no hidden Parakeet re-arm after a live session')
  assert.ok(/const stop = useCallback\(\(\): void => endConversation\(\{ kind: 'press' \}\)/.test(hubSrc), 'a second press ends it, with why')
  assert.ok(/realtimeLive \|\| \(resolved\.provider !== 'claude' && !agent\.armed\)/.test(hubSrc), 'an open Parakeet conversation stays the one shown')
})

console.log('the live session: stop while starting, brain switch, watchdog, dictation (V1 V3 V5 V6 V8)')
await check('V1: a start that resolves after Listen went off is stopped, and a stale session runs no tools', () => {
  assert.ok(/await session\.start\(\)[\s\S]{0,300}if \(sessionRef\.current !== session\) \{\s*session\.stop\(\)\s*return/.test(hubSrc), 'late success is torn down')
  assert.ok(/\} catch \(err\) \{\s*if \(sessionRef\.current !== session\) \{\s*session\.stop\(\)\s*return/.test(hubSrc), 'late failure is torn down too')
  assert.ok(/onToolCall: \(call\) =>\s*sessionRef\.current === session\s*\? onToolCall\(call\)/.test(hubSrc), 'onToolCall is gated on the session still being the one shown')
})
await check('V6: changing the brain mid-session ends the live one, and says why', () => {
  assert.equal(V.endedNote({ kind: 'switched' }), 'Conversation ended — brain changed')
  assert.equal(V.liveBrainSwitched('gemini-live', 'gemini-live'), false, 'same brain: keep going')
  assert.equal(V.liveBrainSwitched(null, 'gemini-live'), false, 'nothing live: nothing to end')
  assert.equal(V.liveBrainSwitched('gemini-live', null), true, 'moved to Claude (or the key went)')
  assert.equal(V.liveBrainSwitched('gemini-live', 'gpt-realtime'), true, 'moved to another live brain')
  assert.ok(
    /if \(!liveBrainSwitched\(liveProvider, pickedBrain\.realtime\)\) return\s*endConversationRef\.current\(\{ kind: 'switched' \}\)\s*\}, \[liveProvider, pickedBrain\.realtime\]\)/.test(hubSrc),
    'the hub watches the picked brain against the live provider'
  )
})
await check('V3: the watchdog — Starting… / Thinking… that never moves on ends with a reason; a running tool is not quiet', () => {
  assert.equal(V.stuckAfterMs({ phase: 'connecting', toolRunning: false }), V.STUCK_CONNECTING_MS)
  assert.equal(V.stuckAfterMs({ phase: 'thinking', toolRunning: false }), V.STUCK_THINKING_MS)
  assert.equal(V.stuckAfterMs({ phase: 'thinking', toolRunning: true }), null, 'a video takes minutes')
  for (const phase of ['listening', 'speaking', 'off', 'error']) assert.equal(V.stuckAfterMs({ phase, toolRunning: false }), null, phase)
  assert.ok(V.STUCK_THINKING_MS >= 20_000 && V.STUCK_THINKING_MS <= 60_000, 'bounded, and not twitchy')
  assert.equal(E.errorReasonOf('gemini', V.stuckReason('Gemini Live', 'thinking', 30_000)), 'Gemini: no reply')
  assert.equal(E.errorReasonOf('openai', V.stuckReason('GPT Realtime', 'connecting', 30_000)), 'OpenAI: no reply')
  assert.match(V.stuckReason('Gemini Live', 'thinking', 30_000), /Gemini Live went quiet: no reply for 30 s/)
  assert.ok(/const ms = stuckAfterMs\(\{ phase: rtPhase, toolRunning \}\)/.test(hubSrc), 'the hub runs it on the live phase')
  assert.ok(/setRtPhase\('error'\)\s*setRtError\(stuckReason\(/.test(hubSrc), 'it ends in the error phase, with the reason on the pill')
})
await check('V5: the Dictate key capturing holds the live session\'s mic shut, apart from his Mute', () => {
  assert.equal(M.dictationHoldsMic({ phase: 'listening', capturing: true }), true)
  assert.equal(M.dictationHoldsMic({ phase: 'listening' }), true, 'phrase mode has no capturing flag')
  assert.equal(M.dictationHoldsMic({ phase: 'finishing' }), true)
  assert.equal(M.dictationHoldsMic({ phase: 'listening', capturing: false }), false, 'wake monitoring is not his voice')
  for (const phase of ['off', 'idle', 'starting', 'error']) assert.equal(M.dictationHoldsMic({ phase }), false, phase)
  assert.equal(M.dictationHoldsMic(null), false)
  assert.ok(/sessionRef\.current\?\.setMuted\(mutedRef\.current \|\| dictatingNow\)/.test(hubSrc), 'the hold follows the capture')
  assert.ok(/session\.setMuted\(mutedRef\.current \|\| dictatingRef\.current\)/.test(hubSrc), 'a session that opens mid-dictation starts held')
  assert.ok(/sessionRef\.current\.setMuted\(on \|\| dictatingRef\.current\)/.test(hubSrc), 'unmuting mid-dictation keeps the hold')
})
await check('V8: a held dictation phrase is not quiet on a Parakeet brain', () => {
  assert.ok(/`\$\{agent\.turns\.length\}:\$\{agent\.dictationBuffer\.length\}`/.test(hubSrc), 'the idle clock restarts on the dictation buffer growing')
})

/* ---------------------------------------- the voice agent picker (bar) */

const S = await import('../src/lib/brainStatus.ts')
const pickerSrc = readFileSync(new URL('../src/components/hub/BrainPicker.tsx', import.meta.url), 'utf8')
const composerSrc = readFileSync(new URL('../src/components/hub/Composer.tsx', import.meta.url), 'utf8')
const mainAgentSrc = readFileSync(new URL('../src/components/settings/MainAgent.tsx', import.meta.url), 'utf8')

console.log('the voice bar: the voice agent picker')
await check('the picker is one chip beside Listen, in the one bar', () => {
  assert.ok(/<ListenToggle \/>\s*<BrainPicker \/>/.test(composerSrc), 'rendered right after Listen')
  assert.ok(/AGENT_BRAINS\.map\(\(spec\) =>/.test(pickerSrc), 'one row per brain')
  assert.ok(/role="menuitemradio"\s*aria-checked=\{inUse\}/.test(pickerSrc), 'the brain in use is checked')
  assert.ok(/data-tone="use">\s*in use/.test(pickerSrc), 'and says "in use" in words')
  assert.ok(/disabled=\{off\}/.test(pickerSrc), 'an unavailable brain cannot be picked')
  assert.ok(/actions\.openSettings\('voice'\)/.test(pickerSrc), 'Voice settings… lands on the Main agent card')
})
await check('picking a row writes agentBrain, as Settings does', () => {
  assert.ok(/onClick=\{\(\) => onPick\(spec\.id\)\}/.test(pickerSrc), 'the row picks its own brain')
  assert.ok(/onPick=\{\(id\) => \{\s*if \(id !== chosen\) actions\.patchSettings\(\{ agentBrain: id \}\)/.test(pickerSrc), 'the pick is the agentBrain setting')
  assert.ok(/onPick=\{\(\) => actions\.patchSettings\(\{ agentBrain: spec\.id \}\)\}/.test(mainAgentSrc), 'the same write as the Settings card')
})
await check('Settings and the picker read one status: the same probe, the same words', () => {
  assert.ok(/import \{ useBrainProbes \} from '@\/hooks\/useBrainStatus'/.test(mainAgentSrc))
  assert.ok(/import \{ statusOf,[^}]*\} from '@\/lib\/brainStatus'/.test(mainAgentSrc))
  assert.ok(/useBrainProbes\(s\)/.test(pickerSrc) && /statusOf\(spec, s, probes\[spec\.id\]\)/.test(pickerSrc))
  const none = { geminiKey: '', openaiKey: '', groqKey: '', openrouterKey: '' }
  const claude = B.agentBrainSpec('claude')
  assert.equal(S.statusOf(B.agentBrainSpec('gemini-live'), none, undefined).word, 'Needs key')
  assert.equal(S.statusOf(claude, none, undefined).word, 'Checking…')
  assert.equal(S.statusOf(claude, none, { busy: false, result: { ok: true, reason: 'ok' } }).word, 'Ready')
  assert.equal(S.statusOf(B.agentBrainSpec('codex-cli'), none, { busy: false, result: { ok: false, reason: 'codex: command not found' } }).word, 'Not installed')
  assert.equal(S.statusOf(B.agentBrainSpec('gemini-cli'), none, { busy: false, result: { ok: false, reason: 'Not logged in' } }).word, 'Not logged in')
  for (const word of ['Needs key', 'Not installed', 'Not logged in']) assert.equal(S.brainUnavailable({ word, glyph: '', tone: 'need' }), true, word)
  for (const word of ['Ready', 'Checking…', 'Not ready']) assert.equal(S.brainUnavailable({ word, glyph: '', tone: 'ok' }), false, word)
})
await check('the chip names the brain that answers; a fallback says why, in words', () => {
  assert.equal(S.barBrainLabel('claude', P.resolveAgentBrain('claude', {})), 'Claude')
  assert.equal(S.barBrainLabel('gemini-live', P.resolveAgentBrain('gemini-live', {})), 'Claude · Gemini Live needs a key')
  assert.equal(S.barBrainLabel('groq', P.resolveAgentBrain('groq', {})), 'Claude · Groq (text) needs a key')
  assert.equal(S.barBrainLabel('gemini-live', P.resolveAgentBrain('gemini-live', { geminiKey: 'k' })), 'Gemini Live')
})
await check('a pick made while Listen is on: next turn on Parakeet, next press when a live session is involved', () => {
  const W = (o) => S.brainSwitchWaits({ listening: true, liveRealtime: false, current: 'claude', target: 'codex-cli', ...o })
  assert.equal(W({ listening: false, target: 'gemini-live' }), false, 'Listen off: nothing to wait for')
  assert.equal(W({}), false, 'Parakeet to Parakeet: the host re-reads the brain every turn')
  assert.equal(W({ target: 'groq' }), false, 'to a text brain: next turn too')
  assert.equal(W({ target: 'gemini-live' }), true, 'Parakeet to a live brain: opens on the next press (B11)')
  assert.equal(W({ liveRealtime: true, current: 'gemini-live', target: 'claude' }), true, 'a live session ends on the switch (V6)')
  assert.equal(W({ liveRealtime: true, current: 'gemini-live', target: 'gemini-live' }), false, 'the brain in use')
  assert.ok(/brainSwitchWaits\(\{ listening, liveRealtime, current, target: spec\.id \}\)[\s\S]{0,40}'Starts next time you press Listen'/.test(pickerSrc), 'the row says so')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

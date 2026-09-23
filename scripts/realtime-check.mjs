/**
 * Offline checks for the realtime voice brains (Gemini Live, GPT Realtime).
 *
 * No network, no microphone, no Electron: every fetch is a fake that records
 * what it was asked, and the session classes are only imported for their pure
 * builders. What is held here:
 *
 *   • token minting   — the exact request shapes main sends to OpenAI and
 *                       Google, and that neither key reaches the other call
 *   • hands-free      — server VAD on for both providers, no push-to-talk
 *   • the tool list   — run_app_action's kinds are ACTION_SPECS 1:1, and each
 *                       one is a case runAppAction implements
 *   • tool answers    — through the Claude brain's own dispatcher
 *   • rollover        — the carry-over summary for a new session
 *   • fallback        — a missing key means the Claude path
 *   • discussion mode — what it holds, what it lets through, and "go"
 *
 * Run: npm run realtime:check
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './ts-hooks.mjs'

// Vite asset imports (the AudioWorklet's `?url`) are a bundler feature; here
// they are a string, which is all the module does with them at import time.
registerHooks({
  resolve(spec, context, next) {
    if (/\?url\b/.test(spec)) {
      return { url: 'data:text/javascript,export default "pcm-worklet.js"', shortCircuit: true }
    }
    return next(spec, context)
  }
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const tokens = await import('../electron/realtime/tokens.ts')
const shared = await import('../shared/realtime.ts')
const tools = await import('../src/lib/realtime/tools.ts')
const { ACTION_SPECS } = await import('../src/lib/appmanifest.ts')
const { describePaneText } = await import('../src/lib/agenttools.ts')
const { buildRolloverSummary, ROLLOVER_SUMMARY_MAX_CHARS } = await import('../src/lib/realtime/summary.ts')
const { resolveHubProvider, providerAvailability } = await import('../src/lib/realtime/provider.ts')
const discussion = await import('../src/lib/realtime/discussion.ts')
const { buildGeminiSetup } = await import('../src/lib/realtime/gemini.ts')
const { buildRealtimeInstructions, REALTIME_PERSONA } = await import('../src/lib/realtime/persona.ts')

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

/** A fetch that answers from a queue and remembers every request. */
function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected fetch to ${url}`)
    return new Response(next.body, { status: next.status ?? 200 })
  }
  return { fn, calls }
}

const OPENAI_KEY = 'sk-test-OPENAI-KEY'
const GEMINI_KEY = 'AIza-test-GEMINI-KEY'
const SDP_OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'
const SDP_ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\n'

console.log('token minting')

await check('OpenAI: client secret then SDP, with the documented shapes', async () => {
  const f = fakeFetch([
    { body: JSON.stringify({ value: 'ek_EPHEMERAL', expires_at: 1756310470 }) },
    { body: SDP_ANSWER }
  ])
  const res = await tokens.connectOpenAI(
    OPENAI_KEY,
    { model: shared.OPENAI_REALTIME_MINI_MODEL, voice: 'marin', instructions: 'be brief', tools: tools.toOpenAITools(), sdp: SDP_OFFER },
    f.fn
  )
  assert.deepEqual(res, { ok: true, sdp: SDP_ANSWER, expiresAt: 1756310470 * 1000 })
  assert.equal(f.calls.length, 2)

  const [mint, call] = f.calls
  assert.equal(mint.url, 'https://api.openai.com/v1/realtime/client_secrets')
  assert.equal(mint.init.method, 'POST')
  assert.equal(mint.init.headers.Authorization, `Bearer ${OPENAI_KEY}`)
  assert.equal(mint.init.headers['Content-Type'], 'application/json')
  const body = JSON.parse(mint.init.body)
  assert.deepEqual(body.expires_after, { anchor: 'created_at', seconds: 600 })
  assert.equal(body.session.type, 'realtime')
  assert.equal(body.session.model, 'gpt-realtime-2.1-mini')
  assert.equal(body.session.instructions, 'be brief')
  assert.equal(body.session.audio.output.voice, 'marin')
  assert.equal(body.session.truncation.type, 'retention_ratio')
  assert.ok(body.session.truncation.retention_ratio > 0 && body.session.truncation.retention_ratio < 1)
  assert.equal(body.session.tools.length, tools.REALTIME_TOOLS.length)
  for (const t of body.session.tools) {
    assert.equal(t.type, 'function')
    assert.ok(t.name && t.description && t.parameters)
  }

  assert.equal(call.url, 'https://api.openai.com/v1/realtime/calls')
  assert.equal(call.init.method, 'POST')
  // The ephemeral secret — never the key — goes on the call.
  assert.equal(call.init.headers.Authorization, 'Bearer ek_EPHEMERAL')
  assert.equal(call.init.headers['Content-Type'], 'application/sdp')
  assert.equal(call.init.body, SDP_OFFER)
})

await check('OpenAI: no key means no request at all', async () => {
  const f = fakeFetch([])
  const res = await tokens.connectOpenAI('  ', { model: 'm', voice: 'v', instructions: '', tools: [], sdp: SDP_OFFER }, f.fn)
  assert.equal(res.ok, false)
  assert.match(res.error, /No OpenAI key/)
  assert.equal(f.calls.length, 0)
})

await check('OpenAI: a refused key says so and never echoes the key', async () => {
  const f = fakeFetch([{ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) }])
  const res = await tokens.connectOpenAI(OPENAI_KEY, { model: 'm', voice: 'v', instructions: '', tools: [], sdp: SDP_OFFER }, f.fn)
  assert.equal(res.ok, false)
  assert.match(res.error, /refused \(401\)/)
  assert.ok(!res.error.includes(OPENAI_KEY))
  assert.equal(f.calls.length, 1, 'no SDP is posted after a failed mint')
})

await check('Gemini: v1alpha auth_tokens, single use, one minute to start', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const f = fakeFetch([{ body: JSON.stringify({ name: 'auth_tokens/abc123' }) }])
  const res = await tokens.mintGeminiToken(GEMINI_KEY, f.fn, now)
  assert.deepEqual(res, { ok: true, token: 'auth_tokens/abc123', expiresAt: now + 30 * 60_000 })
  const [mint] = f.calls
  assert.equal(mint.url, 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens')
  assert.equal(mint.init.method, 'POST')
  assert.equal(mint.init.headers['x-goog-api-key'], GEMINI_KEY)
  assert.deepEqual(JSON.parse(mint.init.body), {
    uses: 1,
    expireTime: '2026-09-23T12:30:00.000Z',
    newSessionExpireTime: '2026-09-23T12:01:00.000Z'
  })
  assert.equal(shared.GEMINI_LIVE_WS_URL.includes('v1alpha.GenerativeService.BidiGenerateContentConstrained'), true)
})

await check('Gemini: no key means no request', async () => {
  const f = fakeFetch([])
  const res = await tokens.mintGeminiToken('', f.fn)
  assert.equal(res.ok, false)
  assert.equal(f.calls.length, 0)
})

await check('openaiKey is a secret field, encrypted at rest like geminiKey', () => {
  const store = readFileSync(join(ROOT, 'electron', 'store.ts'), 'utf8')
  const list = store.slice(store.indexOf('const SECRET_FIELDS'), store.indexOf('] as const satisfies'))
  assert.match(list, /'openaiKey'/)
  assert.match(list, /'geminiKey'/)
})

console.log('hands-free')

await check('GPT Realtime: semantic VAD answers and barges in by itself', () => {
  const session = tokens.buildOpenAISession({ model: 'm', voice: 'cedar', instructions: '', tools: [] })
  assert.deepEqual(session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'auto',
    create_response: true,
    interrupt_response: true
  })
})

await check('Gemini Live: server VAD on, compression + resumption for a long day', () => {
  const opts = { model: shared.GEMINI_LIVE_MODEL, voice: 'Kore', instructions: 'hi', tools: tools.REALTIME_TOOLS }
  const fresh = buildGeminiSetup(opts, null).setup
  assert.equal(fresh.model, 'models/gemini-3.8-live')
  assert.deepEqual(fresh.generationConfig.responseModalities, ['AUDIO'])
  assert.equal(fresh.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore')
  assert.deepEqual(fresh.systemInstruction, { parts: [{ text: 'hi' }] })
  assert.equal(fresh.realtimeInputConfig.automaticActivityDetection.disabled, false)
  assert.deepEqual(fresh.contextWindowCompression, { slidingWindow: {} })
  assert.deepEqual(fresh.sessionResumption, {})
  assert.deepEqual(fresh.inputAudioTranscription, {})
  assert.deepEqual(fresh.outputAudioTranscription, {})
  assert.deepEqual(buildGeminiSetup(opts, 'h-42').setup.sessionResumption, { handle: 'h-42' })
})

console.log('the tool list')

await check('run_app_action kinds are ACTION_SPECS, 1:1, and each is a runAppAction case', () => {
  const spec = tools.REALTIME_TOOLS.find((t) => t.name === 'run_app_action')
  const kinds = spec.parameters.properties.kind.enum
  assert.deepEqual(kinds, ACTION_SPECS.map((s) => s.kind))
  assert.equal(new Set(kinds).size, kinds.length)
  const actions = readFileSync(join(ROOT, 'src', 'lib', 'appactions.ts'), 'utf8')
  for (const kind of kinds) assert.ok(actions.includes(`case '${kind}':`), `runAppAction has no case for ${kind}`)
  for (const kind of kinds) assert.ok(spec.description.includes(`- ${kind}:`), `description skips ${kind}`)
})

await check('every field an ACTION_SPECS example names is a typed parameter', () => {
  const props = tools.REALTIME_TOOLS.find((t) => t.name === 'run_app_action').parameters.properties
  for (const s of ACTION_SPECS) {
    for (const m of s.args.matchAll(/"([A-Za-z]+)"\s*:/g)) {
      assert.ok(props[m[1]]?.type, `${s.kind}.${m[1]} has no parameter`)
    }
  }
  assert.equal(props.count.type, 'integer')
  assert.equal(props.submit.type, 'boolean')
})

await check('one list: the brief’s tools, B2’s four hub tools and B3’s seven browser tools, unique names', () => {
  const names = tools.REALTIME_TOOLS.map((t) => t.name)
  assert.deepEqual(names, [
    'get_app_state',
    'run_app_action',
    'get_project_memory',
    'remember',
    'read_pane',
    'take_screenshot',
    'focus_pane_by_name',
    'list_panes_with_names',
    'run_saved_prompt',
    'show_on_canvas',
    'browser_open',
    'browser_list',
    'browser_read',
    'browser_click',
    'browser_type',
    'browser_screenshot',
    'browser_close'
  ])
  const gem = tools.toGeminiTools()[0].functionDeclarations
  assert.deepEqual(gem.map((d) => d.name), names)
  const run = gem.find((d) => d.name === 'run_app_action')
  assert.equal(run.parameters.type, 'OBJECT')
  assert.equal(run.parameters.properties.kind.type, 'STRING')
  assert.equal(gem.find((d) => d.name === 'get_app_state').parameters, undefined, 'no empty schemas for Gemini')
})

/** Deps shaped like the VoiceAgentProvider's, recording what they were asked. */
function fakeDeps() {
  const seen = { actions: [], notes: [], reads: [] }
  const deps = {
    getSnapshot: () => ({
      appVersion: '0.3.0',
      projects: [{ name: 'forge', path: 'C:/forge', active: true }],
      profiles: [],
      tabs: [],
      paneCount: 0,
      maxSessions: 16,
      maxPanesPerTab: 8,
      view: { railCollapsed: false, voiceHub: 'docked', terminalFontSize: 14, shell: 'pwsh' }
    }),
    runAction: (action) => {
      seen.actions.push(action)
      return { ok: true, summary: 'Opened 2 Claude tabs', requested: 2, done: 2 }
    },
    getProjectMemory: () => '',
    remember: (note) => {
      seen.notes.push(note)
      return true
    },
    readPane: (target, lines) => {
      seen.reads.push([target, lines])
      return `Terminal 2 “build”, last ${lines} lines:\nall green`
    }
  }
  return { deps, seen }
}

await check('tools answer through the Claude brain’s dispatcher', async () => {
  const { deps, seen } = fakeDeps()
  const state = await tools.runRealtimeTool('get_app_state', {}, { deps })
  assert.equal(state.ok, true)
  assert.match(state.text, /run_app_action kinds: open_tabs/)

  const run = await tools.runRealtimeTool('run_app_action', { kind: 'open_tabs', profileId: 'claude', count: 2 }, { deps })
  assert.deepEqual(seen.actions, [{ kind: 'open_tabs', profileId: 'claude', count: 2 }])
  assert.equal(run.ok, true)
  assert.equal(tools.realtimeResultLabel('run_app_action', run), 'Opened 2 Claude tabs')

  const mem = await tools.runRealtimeTool('get_project_memory', {}, { deps })
  assert.equal(mem.text, 'Nothing remembered about this project yet.')

  const read = await tools.runRealtimeTool('read_pane', { target: 'terminal 2' }, { deps })
  assert.deepEqual(seen.reads, [['terminal 2', 40]])
  assert.match(read.text, /all green/)

  const shot = await tools.runRealtimeTool('take_screenshot', {}, { deps, screenshot: async () => ({ mime: 'image/jpeg', base64: 'AAAA' }) })
  assert.deepEqual(shot.image, { mime: 'image/jpeg', base64: 'AAAA' })
})

await check('B2 stubs, unknown tools and missing deps fail in words, never throw', async () => {
  const { deps } = fakeDeps()
  for (const name of tools.STUB_TOOL_NAMES) {
    const r = await tools.runRealtimeTool(name, {}, { deps })
    assert.equal(r.ok, false)
    assert.match(r.text, /not available yet/)
  }
  assert.match((await tools.runRealtimeTool('rm_rf', {}, { deps })).text, /no tool called rm_rf/)
  assert.equal((await tools.runRealtimeTool('get_app_state', {}, { deps: null })).ok, false)
  const bad = await tools.runRealtimeTool('run_app_action', {}, { deps })
  assert.equal(bad.ok, false)
  assert.match(bad.text, /no "kind"/)
})

await check('read_pane resolves targets like send_prompt, and asks when ambiguous', () => {
  const pane = (number, title, profileName, focused = false) => ({
    paneId: `p${number}`, tabId: 't1', tabNumber: 1, tabTitle: 'one', number, title,
    profileId: profileName.toLowerCase(), profileName, live: true, focused, agent: true, lastFocusedAt: 0
  })
  const ctx = { panes: [pane(1, 'api', 'Claude', true), pane(2, 'web', 'Claude')], focusedPaneId: 'p1' }
  const read = (id, n) => `${id}:${n}`
  assert.match(describePaneText(ctx, 'terminal 2', 10, read), /Terminal 2 .*last 10 lines:\np2:10/)
  assert.match(describePaneText(ctx, 'this', 999, read), /p1:200/)
  // The focused Claude pane is what "the claude one" means (resolvePaneTarget's
  // own rule); with nothing focused there is no honest tie-break, so it asks.
  assert.match(describePaneText(ctx, 'the claude one', 5, read), /Terminal 1 [\s\S]*p1:5/)
  const unfocused = { panes: ctx.panes.map((p) => ({ ...p, focused: false })), focusedPaneId: null }
  assert.match(describePaneText(unfocused, 'the claude one', 5, read), /^FAILED: more than one pane matches/)
  assert.match(describePaneText({ panes: [], focusedPaneId: null }, 'x', 5, read), /no panes are open/)
})

console.log('rollover')

await check('the carry-over keeps the recent end, final lines only, under the cap', () => {
  const captions = []
  for (let i = 0; i < 200; i++) {
    captions.push({ role: i % 2 ? 'assistant' : 'user', text: `line ${i} ${'x'.repeat(40)}`, final: true })
  }
  captions.push({ role: 'user', text: 'half a sentence', final: false })
  const actions = [
    { label: 'Opened 2 Claude tabs', status: 'ok' },
    { label: 'Closing tab 3', status: 'running' },
    { label: 'Could not find terminal 9', status: 'failed' },
    { label: 'Planned: Sending a prompt', status: 'planned' }
  ]
  const out = buildRolloverSummary(captions, actions, { appState: '# CURRENT STATE\nTab 1: api' })
  assert.ok(out.length <= ROLLOVER_SUMMARY_MAX_CHARS)
  assert.match(out, /Steve: line 198/)
  assert.match(out, /You: line 199/)
  assert.ok(!out.includes('line 0 '), 'the oldest lines are dropped first')
  assert.ok(!out.includes('half a sentence'), 'partials are not carried')
  assert.ok(out.indexOf('line 150') < out.indexOf('line 199'), 'oldest first')
  assert.match(out, /- Opened 2 Claude tabs/)
  assert.match(out, /- FAILED: Could not find terminal 9/)
  assert.match(out, /- PLANNED, NOT RUN: Planned: Sending a prompt/)
  assert.ok(!out.includes('Closing tab 3'), 'in-flight calls are not reported as done')
  assert.match(out, /Tab 1: api/)
})

await check('an empty conversation carries nothing, and the persona is unchanged', () => {
  assert.equal(buildRolloverSummary([], []), '')
  assert.equal(buildRealtimeInstructions(''), REALTIME_PERSONA)
  const seeded = buildRealtimeInstructions('Conversation:\nSteve: open two claude tabs')
  assert.ok(seeded.startsWith(REALTIME_PERSONA))
  assert.match(seeded, /# WHERE YOU WERE[\s\S]*open two claude tabs/)
})

console.log('provider fallback')

await check('a missing key means Claude, and says why', () => {
  const none = { geminiKey: '', openaiKey: '' }
  assert.deepEqual(resolveHubProvider('claude', none), { provider: 'claude', fallbackReason: null })
  const gpt = resolveHubProvider('gpt-realtime', none)
  assert.equal(gpt.provider, 'claude')
  assert.match(gpt.fallbackReason, /No OpenAI key/)
  const gem = resolveHubProvider('gemini-live', { geminiKey: ' ', openaiKey: 'sk' })
  assert.equal(gem.provider, 'claude')
  assert.match(gem.fallbackReason, /No Gemini key/)
  assert.deepEqual(resolveHubProvider('gemini-live', { geminiKey: 'AIza', openaiKey: '' }), { provider: 'gemini-live', fallbackReason: null })
  assert.deepEqual(resolveHubProvider('gpt-realtime-mini', { geminiKey: '', openaiKey: 'sk' }), { provider: 'gpt-realtime-mini', fallbackReason: null })
  assert.deepEqual(resolveHubProvider('nonsense', none), { provider: 'claude', fallbackReason: null })
  assert.deepEqual(providerAvailability({ geminiKey: 'AIza', openaiKey: '' }), {
    claude: true,
    'gemini-live': true,
    'gpt-realtime': false,
    'gpt-realtime-mini': false
  })
})

await check('voices fall back to the vendor default', () => {
  assert.equal(shared.resolveVoice('openai', ''), 'marin')
  assert.equal(shared.resolveVoice('openai', 'Kore'), 'marin', 'a Gemini voice is not an OpenAI one')
  assert.equal(shared.resolveVoice('openai', 'cedar'), 'cedar')
  assert.equal(shared.resolveVoice('gemini', ''), shared.DEFAULT_GEMINI_VOICE)
  assert.equal(shared.resolveVoice('gemini', 'Kore'), 'Kore')
})

console.log('discussion mode')

await check('holds anything that changes Forge, lets looking through', () => {
  for (const name of ['run_app_action', 'remember', 'focus_pane_by_name', 'show_on_canvas', 'some_future_tool']) {
    assert.equal(discussion.discussionGate(true, name), 'plan', name)
    assert.equal(discussion.discussionGate(false, name), 'run', name)
  }
  for (const name of ['get_app_state', 'read_pane', 'get_project_memory', 'take_screenshot']) {
    assert.equal(discussion.discussionGate(true, name), 'run', name)
  }
  // Every tool in the list is classified on purpose, not by accident.
  for (const t of tools.REALTIME_TOOLS) assert.equal(typeof discussion.isSideEffecting(t.name), 'boolean')
})

await check('"go" is a whole short utterance, not a sentence with go in it', () => {
  for (const yes of ['go', 'Go.', 'go ahead', 'OK, do it', 'yes, run it now.', 'Right then, go for it!', 'make it so', 'Let’s go']) {
    assert.equal(discussion.isGoCommand(yes), true, yes)
  }
  for (const no of ['go to terminal two', 'do it later', 'don’t go', 'what would you do', '', 'going home']) {
    assert.equal(discussion.isGoCommand(no), false, no)
  }
})

await check('after go the model is told what already ran, so it does not repeat it', () => {
  const note = discussion.planRanNote([
    { call: { name: 'run_app_action', args: { kind: 'open_tabs' } }, text: 'OK: Opened 2 Claude tabs\n(asked for 2, done 2)' }
  ])
  assert.match(note, /ALREADY been run/)
  assert.match(note, /1\. run_app_action open_tabs → OK: Opened 2 Claude tabs$/)
  assert.match(discussion.planRanNote([]), /Carry out the plan/)
  assert.match(discussion.DISCUSSION_REFUSAL, /^NOT DONE/)
})

console.log(process.exitCode ? `\nrealtime:check FAILED (${passed} passed)` : `\nrealtime:check passed (${passed} checks)`)

/**
 * Component-level checks for the voice agent (M4).
 *
 * Covers the contracts the rest of the app is built on:
 *   • VoiceBrain      — StubBrain, the scaffolds, and the getActiveBrain selector
 *   • TranscriptSource — push sources and the fan-in bus
 *   • voicecommands   — the deterministic grammar (no model involved)
 *   • appactions      — the executor, its limits and its fuzzy name matching
 *   • appmanifest     — the capability manifest handed to every brain
 *   • brainjson       — the JSON contract both live brains parse against
 *   • geminibrain     — request/JSON handling against a fake transport
 *   • openrouterbrain — the same, over the OpenAI-shaped wire format
 *
 * Run: npm run voice:check
 *      npm run voice:check -- --live-openrouter   # + one real, cheap API call
 *
 * The default run makes no network call at all: every transport is a fake, so
 * the suite is deterministic and free. `--live-openrouter` adds a single
 * round trip using the key in ~/.kimi-key, which is the only way to prove the
 * model id in the defaults still exists.
 *
 * The hooks below only tell Node how to load the app's .ts modules: the package
 * is CommonJS for Electron's sake, and Node does not resolve extensionless
 * relative imports the way the bundler does. Nothing is transformed beyond
 * stripping types, so these are the real modules, not copies.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const SHARED = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'shared')).href

registerHooks({
  resolve(spec, context, next) {
    // `@shared/x` is a bundler alias, not a package — the app resolves it
    // through electron.vite.config.ts, and Node has to be told the same thing.
    if (spec.startsWith('@shared/')) return next(`${SHARED}/${spec.slice('@shared/'.length)}.ts`, context)
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE_OPENROUTER = process.argv.includes('--live-openrouter')

const {
  StubBrain,
  ClaudeBrain,
  OpenAIBrain,
  getActiveBrain,
  brainStatusLabel,
  maskKey,
  NOT_CONNECTED,
  DEFAULT_OPENROUTER_MODEL
} = await import('../src/lib/voicebrain.ts')
const { createPushSource, transcriptBus, typedTranscript } = await import('../src/lib/transcriptSource.ts')
const { parseCommand, parseUtterance } = await import('../src/lib/voicecommands.ts')
const { runAppAction, matchProfile, matchProject } = await import('../src/lib/appactions.ts')
const { buildManifest, ACTION_SPECS, EXTENSION_POINTS } = await import('../src/lib/appmanifest.ts')
const {
  GeminiBrain,
  parseBrainJson,
  sanitiseActions,
  extractJsonObject,
  salvagePartialJson,
  tidySay,
  withProjectMemory,
  MEMORY_HEADING,
  RESPONSE_SCHEMA
} = await import('../src/lib/geminibrain.ts')
const brainjson = await import('../src/lib/brainjson.ts')
const { OpenRouterBrain } = await import('../src/lib/openrouterbrain.ts')
const {
  agentMemory,
  describeMemory,
  draftSubject,
  extractMemoryUpdates,
  setMemoryBackend,
  setMemorySummariser,
  SUMMARISE_EVERY
} = await import('../src/lib/agentmemory.ts')
const { formatMemory, parseMemory } = await import('../shared/memory.ts')

/* ------------------------------------------------------------- fixtures */

const PROFILES = [
  { id: 'pwsh', name: 'PowerShell', command: '', accent: '#7FD1FF', badge: 'PS', builtin: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#C6FF4A', badge: 'CC', builtin: true },
  { id: 'kimi', name: 'Kimi', command: 'kimi', accent: '#C08BFF', badge: 'KI', builtin: true }
]

const PROJECTS = [
  { id: 'p1', name: 'forge' },
  { id: 'p2', name: '1' },
  { id: 'p3', name: 'cafe-roma-homepage' }
]

function ctx(over = {}) {
  return {
    projects: PROJECTS,
    profiles: PROFILES,
    defaultProfileId: 'claude',
    activeProjectId: 'p1',
    activeProjectName: 'forge',
    loadedProjectIds: ['p1'],
    tabs: [
      { id: 't1', title: 'build' },
      { id: 't2', title: 'notes' }
    ],
    activeTabId: 't1',
    focusedPaneId: 'pane1',
    paneCount: 2,
    panesInActiveTab: 1,
    maxSessions: 16,
    maxPanesPerTab: 8,
    ...over
  }
}

function fakeRunner() {
  const calls = []
  return {
    calls,
    newTab: (profileId) => calls.push(['newTab', profileId]),
    splitPane: (paneId, direction, profileId) => calls.push(['splitPane', paneId, direction, profileId]),
    closePane: (paneId) => calls.push(['closePane', paneId]),
    closeTab: (tabId) => calls.push(['closeTab', tabId]),
    selectProject: (projectId) => calls.push(['selectProject', projectId]),
    selectTab: (tabId) => calls.push(['selectTab', tabId])
  }
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

/* ------------------------------------------------------------ VoiceBrain */

console.log('\nVoiceBrain')

await test('StubBrain reports itself as not connected', () => {
  const status = new StubBrain().ready()
  assert.equal(status.ok, false)
  assert.equal(status.reason, 'not-implemented')
  assert.equal(brainStatusLabel(status), 'engine not connected')
  assert.equal(brainStatusLabel(new StubBrain('no-key').ready()), 'no API key')
})

await test('StubBrain echoes the transcript as the draft prompt', async () => {
  const reply = await new StubBrain().interpret('build me a car game like Mario', {
    projectName: 'forge',
    recentTranscript: ['build me a car game like Mario']
  })
  assert.equal(reply.understood, NOT_CONNECTED)
  assert.equal(reply.draftPrompt, 'build me a car game like Mario')
  assert.equal(reply.confidence, 'low')
  assert.equal(reply.actions, undefined)
})

await test('scaffolds exist, hold a key, and admit they are not implemented', async () => {
  assert.equal(new ClaudeBrain('').ready().reason, 'no-key')
  // The key-shaped strings below and in the masking test are invented, and are
  // declared to the packaging gate as such: SECRETS-AUDIT: fixtures
  assert.equal(new ClaudeBrain('sk-ant-test').ready().reason, 'not-implemented')
  assert.equal(new OpenAIBrain('sk-test').ready().reason, 'not-implemented')
  await assert.rejects(() => new ClaudeBrain('k').interpret('hi', { recentTranscript: [] }), /not implemented/)
})

await test('getActiveBrain: gemini with a key, stub without', () => {
  assert.equal(getActiveBrain({ voiceBrain: 'gemini', geminiKey: 'AIzaFAKE' }).name, 'Gemini')
  const noKey = getActiveBrain({ voiceBrain: 'gemini', geminiKey: '   ' })
  assert.equal(noKey.name, 'Stub')
  assert.equal(noKey.ready().reason, 'no-key')
  assert.equal(getActiveBrain({ voiceBrain: 'stub', geminiKey: 'AIzaFAKE' }).name, 'Stub')
  assert.equal(getActiveBrain({ voiceBrain: 'claude', anthropicKey: 'x' }).name, 'Claude')
  assert.equal(getActiveBrain({ voiceBrain: 'openai' }).name, 'OpenAI')
  // Nonsense from a hand-edited settings.json still yields a usable brain.
  assert.equal(getActiveBrain({ voiceBrain: 'llama' }).name, 'Stub')
  assert.equal(getActiveBrain(undefined).name, 'Stub')
})

await test('getActiveBrain: an explicit choice is never quietly overridden', () => {
  assert.equal(getActiveBrain({ voiceBrain: 'openrouter', openrouterKey: 'sk-or-FAKE' }).name, 'OpenRouter')
  // Picking OpenRouter with no OpenRouter key must NOT silently spend the
  // Gemini key instead — that is the kind of swap you notice from the bill.
  const wrongKey = getActiveBrain({ voiceBrain: 'openrouter', geminiKey: 'AIzaFAKE' })
  assert.equal(wrongKey.name, 'Stub')
  assert.equal(wrongKey.ready().reason, 'no-key')
  const wrongWay = getActiveBrain({ voiceBrain: 'gemini', openrouterKey: 'sk-or-FAKE' })
  assert.equal(wrongWay.name, 'Stub')
})

await test('getActiveBrain: unset falls through gemini > openrouter > stub', () => {
  assert.equal(getActiveBrain({ geminiKey: 'AIzaFAKE', openrouterKey: 'sk-or-FAKE' }).name, 'Gemini')
  assert.equal(getActiveBrain({ openrouterKey: 'sk-or-FAKE' }).name, 'OpenRouter')
  assert.equal(getActiveBrain({}).name, 'Stub')
  // Same order for a junk value, since that is "no choice made" too.
  assert.equal(getActiveBrain({ voiceBrain: 'llama', openrouterKey: 'sk-or-FAKE' }).name, 'OpenRouter')
})

await test('the OpenRouter default model is one string, written in two places', () => {
  // electron/store.ts cannot import a renderer module, so it repeats the
  // literal. If they drift, a fresh settings.json points at a model the panel
  // does not expect — cheap to assert, expensive to debug.
  const store = readFileSync(join(ROOT, 'electron', 'store.ts'), 'utf8')
  const m = /openrouterModel:\s*'([^']+)'/.exec(store)
  assert.ok(m, 'store.ts has no openrouterModel default')
  assert.equal(m[1], DEFAULT_OPENROUTER_MODEL)
  assert.match(DEFAULT_OPENROUTER_MODEL, /^[a-z0-9-]+\/[a-z0-9.\-:]+$/i, 'looks like an OpenRouter id')
})

await test('the reported model is the chip label when live', () => {
  const status = getActiveBrain({ voiceBrain: 'gemini', geminiKey: 'AIzaFAKE', geminiModel: 'gemini-2.5-flash' }).ready()
  assert.equal(status.ok, true)
  assert.equal(brainStatusLabel(status), 'gemini-2.5-flash')
})

await test('maskKey never renders the middle of a secret', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('sk-ant-api03-abcdefghijklmnop'), 'sk-ant-••••••••mnop')
  assert.equal(maskKey('short'), 'sho••••')
  assert.ok(!maskKey('sk-ant-api03-abcdefghijklmnop').includes('defghij'))
})

/* ------------------------------------------------------ TranscriptSource */

console.log('\nTranscriptSource')

await test('a push source delivers phrases and unsubscribes cleanly', () => {
  const source = createPushSource()
  const seen = []
  const off = source.onPhrase((t) => seen.push(t))
  source.push('first')
  source.push('  second  ')
  source.push('   ')
  off()
  source.push('after unsubscribe')
  assert.deepEqual(seen, ['first', 'second'])
})

await test('the bus fans several sources into one listener', () => {
  const dictation = createPushSource() // stands in for M3
  const unregister = transcriptBus.register(dictation)
  const seen = []
  const off = transcriptBus.onPhrase((t) => seen.push(t))
  typedTranscript.push('typed line')
  dictation.push('spoken line')
  unregister()
  dictation.push('after unregister')
  off()
  typedTranscript.push('after listener off')
  assert.deepEqual(seen, ['typed line', 'spoken line'])
})

await test('a phrase spoken before anything is listening is not lost', () => {
  // Drain anything an earlier check left buffered.
  transcriptBus.onPhrase(() => {})()
  const source = createPushSource()
  const unregister = transcriptBus.register(source)
  // Nothing is listening yet — this is the dictation-fires-early case.
  source.push('said too early')
  assert.equal(transcriptBus.pendingCount(), 1)
  const seen = []
  const off = transcriptBus.onPhrase((t) => seen.push(t))
  assert.deepEqual(seen, ['said too early'])
  assert.equal(transcriptBus.pendingCount(), 0)
  // With a listener attached, nothing is buffered.
  source.push('live')
  assert.equal(transcriptBus.pendingCount(), 0)
  assert.deepEqual(seen, ['said too early', 'live'])
  off()
  unregister()
})

await test('registering the same source twice does not double-deliver', () => {
  const source = createPushSource()
  const a = transcriptBus.register(source)
  const b = transcriptBus.register(source)
  const seen = []
  const off = transcriptBus.onPhrase((t) => seen.push(t))
  source.push('once')
  a()
  b()
  off()
  assert.deepEqual(seen, ['once'])
  assert.ok(transcriptBus.sourceCount() >= 1)
})

/* ---------------------------------------------------------- name matching */

console.log('\nFuzzy name matching')

await test('profiles match by name, badge, prefix and sound', () => {
  assert.equal(matchProfile(PROFILES, 'kimi').id, 'kimi')
  assert.equal(matchProfile(PROFILES, 'kimmy').id, 'kimi')
  assert.equal(matchProfile(PROFILES, 'Kimmi').id, 'kimi')
  assert.equal(matchProfile(PROFILES, 'claude').id, 'claude')
  assert.equal(matchProfile(PROFILES, 'claud').id, 'claude')
  assert.equal(matchProfile(PROFILES, 'cc').id, 'claude')
  assert.equal(matchProfile(PROFILES, 'powershell').id, 'pwsh')
  assert.equal(matchProfile(PROFILES, 'shell').id, 'pwsh')
  assert.equal(matchProfile(PROFILES, 'ps').id, 'pwsh')
  assert.equal(matchProfile(PROFILES, 'mario'), null)
  assert.equal(matchProfile(PROFILES, 'browser'), null)
})

await test('projects match loosely too', () => {
  assert.equal(matchProject(PROJECTS, 'forge').id, 'p1')
  assert.equal(matchProject(PROJECTS, 'Forge').id, 'p1')
  assert.equal(matchProject(PROJECTS, 'cafe roma homepage').id, 'p3')
  assert.equal(matchProject(PROJECTS, '1').id, 'p2')
  assert.equal(matchProject(PROJECTS, 'nothing-like-it'), null)
})

/* -------------------------------------------------------------- grammar */

console.log('\nCommand grammar (no model involved)')

const C = ctx()
const parse = (text) => parseCommand(text, C)

await test('Steve’s own phrasings parse', () => {
  assert.deepEqual(parse('open up three tabs of Kimi').action, { kind: 'open_tabs', profileId: 'kimi', count: 3 })
  assert.deepEqual(parse('open two tabs of Claude').action, { kind: 'open_tabs', profileId: 'claude', count: 2 })
  assert.deepEqual(parse('open sixteen new tabs').action, { kind: 'open_tabs', profileId: 'claude', count: 16 })
  assert.deepEqual(parse('switch to cafe-roma-homepage').action, {
    kind: 'switch_project',
    name: 'cafe-roma-homepage'
  })
  assert.deepEqual(parse('close this pane').action, { kind: 'close_pane', which: 'focused' })
  assert.deepEqual(parse('close the tab').action, { kind: 'close_tab', which: 'current' })
})

await test('mis-heard agent names still land', () => {
  assert.equal(parse('open up three tabs of kimmy').action.profileId, 'kimi')
  assert.equal(parse('fire up two kimmi terminals').action.profileId, 'kimi')
  assert.equal(parse('give me a claud tab').action.profileId, 'claude')
})

await test('counts in words and digits, and plural/singular nouns', () => {
  assert.equal(parse('open 4 kimi tabs').action.count, 4)
  assert.equal(parse('open a couple of claude tabs').action.count, 2)
  assert.equal(parse('open a few powershell tabs').action.count, 3)
  assert.equal(parse('open a dozen tabs').action.count, 12)
  assert.equal(parse('open one kimi tab').action.count, 1)
  assert.equal(parse('open a kimi tab').action.count, 1)
  assert.equal(parse('launch twelve instances of kimi').action.count, 12)
  assert.equal(parse('spin up two claude windows').action.count, 2)
  assert.equal(parse('boot three kimi sessions').action.count, 3)
})

await test('verbs and shapes Steve might actually use', () => {
  for (const phrase of [
    'open three kimi tabs',
    'launch three kimi tabs',
    'fire up three kimi tabs',
    'start three kimi tabs',
    'give me three kimi tabs',
    'get me three kimi tabs',
    'add three kimi tabs',
    'three kimi tabs',
    'three tabs of kimi'
  ]) {
    const hit = parse(phrase)
    assert.ok(hit, `no hit for "${phrase}"`)
    assert.equal(hit.action.kind, 'open_tabs', phrase)
    assert.equal(hit.action.profileId, 'kimi', phrase)
    assert.equal(hit.action.count, 3, phrase)
  }
})

await test('panes and split direction', () => {
  assert.deepEqual(parse('split two claude panes down').action, {
    kind: 'open_panes',
    profileId: 'claude',
    count: 2,
    direction: 'column'
  })
  assert.deepEqual(parse('open a kimi pane to the right').action, {
    kind: 'open_panes',
    profileId: 'kimi',
    count: 1,
    direction: 'row'
  })
  assert.equal(parse('open two panes').action.kind, 'open_panes')
  assert.equal(parse('open two panes').action.direction, undefined)
})

await test('a bare shell resolves to PowerShell, not the default agent', () => {
  assert.equal(parse('open a shell').action.profileId, 'pwsh')
  assert.equal(parse('open two shells').action.count, 2)
})

await test('tab navigation and project switching', () => {
  assert.deepEqual(parse('go to tab 2').action, { kind: 'focus_tab', index: 1 })
  assert.deepEqual(parse('switch to tab three').action, { kind: 'focus_tab', index: 2 })
  assert.deepEqual(parse('tab 1').action, { kind: 'focus_tab', index: 0 })
  assert.deepEqual(parse('show me the second tab').action, { kind: 'focus_tab', index: 1 })
  assert.deepEqual(parse('switch to the forge project').action, { kind: 'switch_project', name: 'forge' })
  assert.deepEqual(parse('go to project 1').action, { kind: 'switch_project', name: '1' })
  assert.equal(parse('switch to the forge project').confidence, 'high')
})

await test('closing, and the safer reading of "close this"', () => {
  assert.equal(parse('close this pane').action.kind, 'close_pane')
  assert.equal(parse('kill this split').action.kind, 'close_pane')
  assert.equal(parse('close this tab').action.kind, 'close_tab')
  assert.equal(parse('close tab').action.kind, 'close_tab')
  const vague = parse('close this')
  assert.equal(vague.action.kind, 'close_pane')
  assert.equal(vague.confidence, 'medium')
})

await test('asking the memory about itself is a command, not a prompt', () => {
  for (const phrase of [
    'what do you remember',
    'what do you remember about this project',
    'what do you remember about this project?',
    'so what do you remember',
    'what have you learned',
    'what have you learnt about this project',
    'what do you know about this project',
    "what's in your memory"
  ]) {
    const hit = parse(phrase)
    assert.ok(hit, `no hit for "${phrase}"`)
    assert.deepEqual(hit.action, { kind: 'recall_memory' }, phrase)
    assert.equal(hit.confidence, 'high', phrase)
  }
})

await test('wiping the memory is a command too', () => {
  for (const phrase of [
    "forget this project's memory",
    'forget the memory',
    'clear your memory',
    'wipe this memory',
    'reset the memory',
    'forget everything about this project',
    'forget this project'
  ]) {
    const hit = parse(phrase)
    assert.ok(hit, `no hit for "${phrase}"`)
    assert.deepEqual(hit.action, { kind: 'forget_memory' }, phrase)
  }
})

await test('stating a preference is NOT a memory command — the brain must answer it', () => {
  // This is the whole reason the recall patterns are anchored on "what": a
  // preference has to reach the brain (and get a reply), while agentmemory
  // records it in parallel. Swallowing it here would lose the answer.
  for (const phrase of [
    'remember I prefer TypeScript strict mode',
    'always run the tests before you push',
    'never commit straight to master',
    'from now on use British English',
    'remember that the API key lives in dot env'
  ]) {
    assert.equal(parse(phrase), null, `"${phrase}" should fall through to the brain`)
  }
})

await test('adding a project is a hint, never a folder picker', () => {
  assert.deepEqual(parse('add a new project').action, { kind: 'new_project_hint' })
  assert.deepEqual(parse('create a project').action, { kind: 'new_project_hint' })
})

await test('open in another project', () => {
  assert.deepEqual(parse('open two kimi tabs in cafe-roma-homepage').action, {
    kind: 'open_tabs',
    profileId: 'kimi',
    count: 2,
    projectName: 'cafe-roma-homepage'
  })
})

await test('briefs are NOT commands — they fall through to the brain', () => {
  for (const phrase of [
    'I want to build a car game like Mario, top down, for the browser',
    'add a menu screen and a lap timer',
    'make the login page look like Apple',
    'why is the build failing',
    'what can you do',
    'the terminal font is too small can you look at it',
    'I need a plan for the database migration',
    'open source it later'
  ]) {
    assert.equal(parse(phrase), null, `"${phrase}" should not parse as a command`)
  }
})

await test('a long sentence is a brief even if it mentions tabs', () => {
  assert.equal(
    parse('later on I would like the app to open a tab automatically whenever I plug in my second monitor'),
    null
  )
})

await test('two orders in one breath both get obeyed', () => {
  const both = parseUtterance('right, open two kimi tabs and one powershell tab', C)
  assert.deepEqual(both.actions, [
    { kind: 'open_tabs', profileId: 'kimi', count: 2 },
    { kind: 'open_tabs', profileId: 'pwsh', count: 1 }
  ])

  const mixed = parseUtterance('close this pane and open a shell', C)
  assert.deepEqual(mixed.actions, [
    { kind: 'close_pane', which: 'focused' },
    { kind: 'open_tabs', profileId: 'pwsh', count: 1 }
  ])

  // A single order still comes back as one action.
  assert.deepEqual(parseUtterance('open three kimi tabs', C).actions, [
    { kind: 'open_tabs', profileId: 'kimi', count: 3 }
  ])
})

await test('half-command, half-brief goes to the brain whole', () => {
  // Obeying only the first half would be worse than obeying none of it.
  assert.equal(parseUtterance('open two kimi tabs and make the login page look like Apple', C), null)
  assert.equal(parseUtterance('I want to build a car game like Mario, top down, for the browser', C), null)
  assert.equal(parseUtterance('add a menu screen and a lap timer', C), null)
})

/* ------------------------------------------------------------- executor */

console.log('\nAction executor')

await test('open_tabs opens exactly what was asked', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'open_tabs', profileId: 'kimi', count: 3 }, ctx(), run)
  assert.equal(out.ok, true)
  assert.equal(out.done, 3)
  assert.equal(out.summary, 'Opened 3 Kimi tabs')
  assert.deepEqual(run.calls, [
    ['newTab', 'kimi'],
    ['newTab', 'kimi'],
    ['newTab', 'kimi']
  ])
})

await test('the 16-session cap is enforced with an honest partial summary', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'open_tabs', profileId: 'kimi', count: 6 }, ctx({ paneCount: 12 }), run)
  assert.equal(out.ok, true)
  assert.equal(out.done, 4)
  assert.equal(out.requested, 6)
  assert.match(out.summary, /Opened 4 of 6 Kimi tabs — session limit \(16\) reached/)
  assert.equal(run.calls.length, 4)
})

await test('at the cap, nothing opens and it says so', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'open_tabs', profileId: 'kimi', count: 2 }, ctx({ paneCount: 16 }), run)
  assert.equal(out.ok, false)
  assert.equal(out.done, 0)
  assert.match(out.summary, /Session limit \(16\) reached/)
  assert.equal(run.calls.length, 0)
})

await test('open_panes respects the per-tab cap as well as the session cap', () => {
  const run = fakeRunner()
  const out = runAppAction(
    { kind: 'open_panes', profileId: 'claude', count: 5, direction: 'column' },
    ctx({ panesInActiveTab: 6 }),
    run
  )
  assert.equal(out.done, 2)
  assert.deepEqual(run.calls, [
    ['splitPane', 'pane1', 'column', 'claude'],
    ['splitPane', 'pane1', 'column', 'claude']
  ])
})

await test('open_panes needs something to split', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'open_panes', profileId: 'claude', count: 1 }, ctx({ focusedPaneId: null }), run)
  assert.equal(out.ok, false)
  assert.match(out.summary, /No pane to split/)
})

await test('close_pane and close_tab act on what has focus', () => {
  const run = fakeRunner()
  assert.equal(runAppAction({ kind: 'close_pane', which: 'focused' }, ctx(), run).ok, true)
  const tabOut = runAppAction({ kind: 'close_tab', which: 'current' }, ctx(), run)
  assert.equal(tabOut.summary, 'Closed “build”')
  assert.deepEqual(run.calls, [
    ['closePane', 'pane1'],
    ['closeTab', 't1']
  ])
})

await test('switch_project matches loosely and notices when it is a no-op', () => {
  const run = fakeRunner()
  assert.equal(runAppAction({ kind: 'switch_project', name: 'cafe roma homepage' }, ctx(), run).summary,
    'Switched to cafe-roma-homepage')
  assert.deepEqual(run.calls, [['selectProject', 'p3']])
  assert.equal(runAppAction({ kind: 'switch_project', name: 'forge' }, ctx(), fakeRunner()).summary, 'Already in forge')
  const missing = runAppAction({ kind: 'switch_project', name: 'nowhere' }, ctx(), fakeRunner())
  assert.equal(missing.ok, false)
  assert.match(missing.summary, /No project called/)
})

await test('focus_tab is honest about tabs that do not exist', () => {
  const run = fakeRunner()
  assert.equal(runAppAction({ kind: 'focus_tab', index: 1 }, ctx(), run).summary, 'Switched to “notes”')
  const out = runAppAction({ kind: 'focus_tab', index: 7 }, ctx(), fakeRunner())
  assert.equal(out.ok, false)
  assert.match(out.summary, /no tab 8 — 2 open/)
})

await test('opening in an unvisited project switches first rather than clobbering its layout', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'open_tabs', profileId: 'kimi', count: 2, projectName: 'cafe-roma-homepage' }, ctx(), run)
  assert.equal(out.done, 0)
  assert.match(out.summary, /Switched to cafe-roma-homepage — say that again/)
  assert.deepEqual(run.calls, [['selectProject', 'p3']])
})

await test('opening in an already-visited project just works', () => {
  const run = fakeRunner()
  const out = runAppAction(
    { kind: 'open_tabs', profileId: 'kimi', count: 2, projectName: 'cafe-roma-homepage' },
    ctx({ loadedProjectIds: ['p1', 'p3'] }),
    run
  )
  assert.equal(out.done, 2)
  assert.deepEqual(run.calls, [
    ['selectProject', 'p3'],
    ['newTab', 'kimi'],
    ['newTab', 'kimi']
  ])
})

await test('new_project_hint explains instead of acting', () => {
  const run = fakeRunner()
  const out = runAppAction({ kind: 'new_project_hint' }, ctx(), run)
  assert.equal(out.done, 0)
  assert.match(out.summary, /projects rail/)
  assert.equal(run.calls.length, 0)
})

await test('an unknown profile id is refused, not guessed', () => {
  const out = runAppAction({ kind: 'open_tabs', profileId: 'gpt5', count: 1 }, ctx(), fakeRunner())
  assert.equal(out.ok, false)
})

/* ------------------------------------------------------- media actions */

console.log('\nMedia actions')

/** A runner that can generate, so the async path can be driven end to end. */
function mediaRunner(result) {
  const base = fakeRunner()
  return {
    ...base,
    makeImage: async (request) => {
      base.calls.push(['makeImage', request.description, request.count, request.aspect])
      return result ?? { ok: true, summary: 'Made 1 image', requested: request.count, done: 1, paths: ['C:\\a.png'] }
    },
    editImage: async (request) => {
      base.calls.push(['editImage', request.path, request.instruction])
      return result ?? { ok: true, summary: 'Edited', requested: 1, done: 1, paths: ['C:\\b.png'] }
    }
  }
}

await test('make_image hands back a provisional chip plus a promise', async () => {
  const run = mediaRunner()
  const out = runAppAction({ kind: 'make_image', description: 'a red car', count: 2, aspect: '16:9' }, ctx(), run)
  // Synchronous half: honest that nothing has happened yet.
  assert.equal(out.ok, true)
  assert.equal(out.done, 0)
  assert.equal(out.requested, 2)
  assert.match(out.summary, /Generating 2 images…/)
  assert.ok(out.pending instanceof Promise)
  assert.deepEqual(run.calls, [['makeImage', 'a red car', 2, '16:9']])
  // Asynchronous half: the real outcome.
  const settled = await out.pending
  assert.equal(settled.done, 1)
  assert.deepEqual(settled.paths, ['C:\\a.png'])
})

await test('make_image clamps the count and refuses an empty description', async () => {
  const run = mediaRunner()
  runAppAction({ kind: 'make_image', description: 'x', count: 99 }, ctx(), run)
  assert.equal(run.calls[0][2], 4, 'four is the ceiling — each one is a separate API call')
  runAppAction({ kind: 'make_image', description: 'y', count: 0 }, ctx(), run)
  assert.equal(run.calls[1][2], 1)

  const empty = runAppAction({ kind: 'make_image', description: '   ', count: 1 }, ctx(), mediaRunner())
  assert.equal(empty.ok, false)
  assert.equal(empty.pending, undefined)
  assert.match(empty.summary, /picture of nothing/)
})

await test('edit_image needs both a path and an instruction', async () => {
  const run = mediaRunner()
  const out = runAppAction({ kind: 'edit_image', path: 'C:\\in.png', instruction: 'make it blue' }, ctx(), run)
  assert.ok(out.pending instanceof Promise)
  assert.deepEqual(run.calls, [['editImage', 'C:\\in.png', 'make it blue']])
  await out.pending

  assert.equal(runAppAction({ kind: 'edit_image', path: '', instruction: 'x' }, ctx(), mediaRunner()).ok, false)
  assert.equal(runAppAction({ kind: 'edit_image', path: 'C:\\a.png', instruction: ' ' }, ctx(), mediaRunner()).ok, false)
})

await test('a runner with no media support refuses instead of pretending', () => {
  // The command grammar's own runner (and every test double) has no makeImage.
  const out = runAppAction({ kind: 'make_image', description: 'a red car', count: 1 }, ctx(), fakeRunner())
  assert.equal(out.ok, false)
  assert.equal(out.done, 0)
  assert.equal(out.pending, undefined)
  assert.match(out.summary, /not available/)
  const edit = runAppAction({ kind: 'edit_image', path: 'C:\\a.png', instruction: 'blue' }, ctx(), fakeRunner())
  assert.equal(edit.ok, false)
})

await test('a media failure comes back as a failed outcome, not a throw', async () => {
  const run = mediaRunner({ ok: false, summary: 'Gemini is out of quota for this key (429)', requested: 1, done: 0 })
  const out = runAppAction({ kind: 'make_image', description: 'a red car', count: 1 }, ctx(), run)
  const settled = await out.pending
  assert.equal(settled.ok, false)
  assert.equal(settled.done, 0)
  assert.match(settled.summary, /out of quota/)
})

/* ------------------------------------------------------- memory actions */

console.log('\nMemory actions')

function memoryRunner() {
  const base = fakeRunner()
  return {
    ...base,
    recallMemory: async () => {
      base.calls.push(['recallMemory'])
      return { ok: true, summary: 'You told me: I prefer strict mode', requested: 1, done: 1 }
    },
    forgetMemory: async () => {
      base.calls.push(['forgetMemory'])
      return { ok: true, summary: 'Forgotten — this project’s memory file is deleted.', requested: 1, done: 1 }
    }
  }
}

await test('recall_memory reads the file, provisionally then for real', async () => {
  const run = memoryRunner()
  const out = runAppAction({ kind: 'recall_memory' }, ctx(), run)
  assert.equal(out.ok, true)
  assert.equal(out.done, 0)
  assert.match(out.summary, /Reading what I remember…/)
  assert.ok(out.pending instanceof Promise)
  const settled = await out.pending
  assert.match(settled.summary, /I prefer strict mode/)
  assert.deepEqual(run.calls, [['recallMemory']])
})

await test('forget_memory says plainly that it is gone', async () => {
  const run = memoryRunner()
  const out = runAppAction({ kind: 'forget_memory' }, ctx(), run)
  assert.match(out.summary, /Forgetting…/)
  const settled = await out.pending
  assert.match(settled.summary, /deleted/)
  assert.deepEqual(run.calls, [['forgetMemory']])
})

await test('neither works without a project, and neither pretends', () => {
  const none = runAppAction({ kind: 'recall_memory' }, ctx({ activeProjectId: null }), memoryRunner())
  assert.equal(none.ok, false)
  assert.equal(none.pending, undefined)
  assert.match(none.summary, /No project open/)

  // A runner with no memory support (the head-less ones) refuses honestly.
  const bare = runAppAction({ kind: 'recall_memory' }, ctx(), fakeRunner())
  assert.equal(bare.ok, false)
  assert.match(bare.summary, /not available/)
  assert.equal(runAppAction({ kind: 'forget_memory' }, ctx(), fakeRunner()).ok, false)
})

await test('a brain can never recall or forget — those are grammar-only', () => {
  // The model is not told these exist, and would be ignored if it invented them.
  assert.deepEqual(sanitiseActions([{ kind: 'recall_memory' }]), [])
  assert.deepEqual(sanitiseActions([{ kind: 'forget_memory' }]), [])
  assert.ok(!brainjson.ACTION_KINDS.has('forget_memory'))
  assert.ok(!ACTION_SPECS.some((s) => s.kind === 'forget_memory'))
})

/* -------------------------------------------------------------- manifest */

console.log('\nCapability manifest')

const SNAPSHOT = {
  appVersion: '0.1.0',
  projects: [
    { name: 'forge', path: 'C:\\Users\\steve\\Desktop\\forge', active: true },
    { name: '1', path: 'C:\\Users\\steve\\Desktop\\1', active: false }
  ],
  profiles: PROFILES,
  tabs: [
    {
      number: 1,
      title: 'build',
      active: true,
      panes: [{ title: 'PowerShell', profileName: 'PowerShell', status: 'live', focused: true }]
    }
  ],
  paneCount: 1,
  maxSessions: 16,
  maxPanesPerTab: 8,
  view: { railCollapsed: false, voicePanelWidth: 380, terminalFontSize: 13, shell: 'pwsh.exe' }
}

await test('the manifest describes the app, the actions, the limits and the state', () => {
  const text = buildManifest(SNAPSHOT)
  for (const heading of [
    '# FORGE',
    '# YOUR JOB',
    '# ACTIONS YOU MAY RETURN',
    '# LIMITS',
    '# LAUNCH PROFILES',
    '# CURRENT STATE',
    '# NOT YET POSSIBLE',
    '# HOW TO REPLY'
  ]) {
    assert.ok(text.includes(heading), `missing ${heading}`)
  }
  for (const spec of ACTION_SPECS) assert.ok(text.includes(spec.kind), `missing action ${spec.kind}`)
  for (const point of EXTENSION_POINTS) assert.ok(text.includes(point.split(' —')[0]))
  assert.ok(text.includes('16 shells maximum'))
  assert.ok(text.includes('8 panes maximum per tab'))
  assert.ok(text.includes('C:\\Users\\steve\\Desktop\\forge'))
  assert.ok(text.includes('[ACTIVE]'))
  assert.ok(text.includes('1. "build" [CURRENT]'))
  assert.ok(text.includes('kimmy'), 'spoken aliases should be listed')
  assert.ok(text.includes('draftPrompt'))
  // Small enough to send every turn.
  assert.ok(text.length < 6000, `manifest is ${text.length} chars`)
})

await test('the manifest offers the media actions and names the bridge tools', () => {
  const text = buildManifest(SNAPSHOT)
  assert.ok(text.includes('make_image'), 'make_image must be offered')
  assert.ok(text.includes('edit_image'), 'edit_image must be offered')
  assert.ok(text.includes('assets/generated'), 'say where the files land')
  // The drafted prompt has to tell the coding agent what it can reach for.
  assert.ok(text.includes('# TOOLS THE CODING AGENT HAS'))
  for (const tool of ['make_image', 'edit_image', 'ask_gemini', 'summarize_video']) {
    assert.ok(text.includes(tool), `TOOLS section must name ${tool}`)
  }
  assert.match(text, /never claim the agent has any tool that is not on that list/i)
})

await test('the manifest, the action union and the sanitiser agree on what exists', () => {
  // Three lists that must not drift: what the model is told, what is honoured,
  // and what the executor implements.
  const kinds = ACTION_SPECS.map((s) => s.kind)
  for (const kind of kinds) {
    assert.ok(brainjson.ACTION_KINDS.has(kind), `${kind} is advertised but would be dropped by sanitiseActions`)
  }
  for (const kind of brainjson.ACTION_KINDS) {
    assert.ok(kinds.includes(kind), `${kind} is honoured but never advertised`)
  }
  // And nothing that is still only a plan leaked into the offered list.
  for (const point of EXTENSION_POINTS) {
    assert.ok(!kinds.includes(point.split(' —')[0]), `${point} is listed as both possible and not`)
  }
})

await test('the manifest copes with an empty app', () => {
  const text = buildManifest({
    ...SNAPSHOT,
    appVersion: null,
    projects: [],
    tabs: [],
    profiles: [],
    paneCount: 0
  })
  assert.ok(text.includes('projects: none yet'))
  assert.ok(text.includes('tabs: none open'))
  assert.ok(text.includes('(none configured)'))
})

/* ------------------------------------------------------------ GeminiBrain */

console.log('\nGeminiBrain (fake transport)')

const GOOD = JSON.stringify({
  understood: 'open three kimi tabs',
  say: 'Done — three Kimi tabs.',
  actions: [{ kind: 'open_tabs', profileId: 'kimi', count: 3 }],
  confidence: 'high'
})

await test('extractJsonObject copes with fences and stray prose', () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}')
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extractJsonObject('Sure! {"a":1} hope that helps'), '{"a":1}')
  assert.equal(extractJsonObject('no json here'), null)
  assert.equal(extractJsonObject(''), null)
})

await test('parseBrainJson coerces every field defensively', () => {
  const reply = parseBrainJson(GOOD)
  assert.equal(reply.understood, 'open three kimi tabs')
  assert.equal(reply.say, 'Done — three Kimi tabs.')
  assert.equal(reply.confidence, 'high')
  assert.deepEqual(reply.actions, [{ kind: 'open_tabs', profileId: 'kimi', count: 3 }])

  // Junk confidence falls back to low; missing understood borrows say.
  const loose = parseBrainJson('{"say":"hello","confidence":"VERY SURE"}')
  assert.equal(loose.confidence, 'low')
  assert.equal(loose.understood, 'hello')

  assert.equal(parseBrainJson('not json'), null)
  assert.equal(parseBrainJson('{"broken":'), null)
  assert.equal(parseBrainJson('[1,2,3]'), null)
})

await test('invented actions are dropped and counts clamped', () => {
  assert.deepEqual(sanitiseActions([{ kind: 'rm_rf', path: 'C:\\' }]), [])
  assert.deepEqual(sanitiseActions([{ kind: 'open_tabs' }]), [], 'profileId is required')
  assert.deepEqual(sanitiseActions([{ kind: 'open_tabs', profileId: 'kimi', count: 5000 }]), [
    { kind: 'open_tabs', profileId: 'kimi', count: 64 }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'open_tabs', profileId: 'kimi', count: -3 }]), [
    { kind: 'open_tabs', profileId: 'kimi', count: 1 }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'open_panes', profileId: 'kimi', count: 2, direction: 'sideways' }]), [
    { kind: 'open_panes', profileId: 'kimi', count: 2 }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'focus_tab', index: '2' }]), [{ kind: 'focus_tab', index: 2 }])
  assert.deepEqual(sanitiseActions([{ kind: 'focus_tab', index: -1 }]), [])
  assert.deepEqual(sanitiseActions('nonsense'), [])
  assert.equal(sanitiseActions(new Array(30).fill({ kind: 'close_pane', which: 'focused' })).length, 8)
})

await test('a good round trip sends the manifest, the history and the schema', async () => {
  const seen = []
  const brain = new GeminiBrain('AIzaFAKE', 'gemini-2.5-flash', async (req) => {
    seen.push(req)
    return { ok: true, text: GOOD }
  })
  const reply = await brain.interpret('open three kimi tabs', {
    recentTranscript: [],
    manifest: 'MANIFEST-HERE',
    history: [
      { role: 'user', text: 'hello' },
      { role: 'agent', text: 'hi' }
    ]
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].system, 'MANIFEST-HERE')
  assert.equal(seen[0].model, 'gemini-2.5-flash')
  assert.equal(seen[0].schema, RESPONSE_SCHEMA)
  assert.deepEqual(
    seen[0].turns.map((t) => t.role),
    ['user', 'model', 'user']
  )
  assert.equal(seen[0].turns.at(-1).text, 'open three kimi tabs')
  assert.equal(reply.actions.length, 1)
})

await test('a looping model costs a sentence, not the card', () => {
  // gemini-2.5-flash really did this: the same line, hundreds of times.
  const loop = 'Right, here it is. ' + "I'm ready when you are. ".repeat(200)
  const tidy = tidySay(loop)
  assert.ok(tidy.length < 460, `still ${tidy.length} chars`)
  assert.match(tidy, /^Right, here it is\./)
  assert.equal((tidy.match(/ready when you are/g) ?? []).length, 1)
  // Ordinary replies are left alone.
  assert.equal(tidySay('Two Kimi tabs open. Anything else?'), 'Two Kimi tabs open. Anything else?')
  // The draft is emitted before the chatter, so truncation cannot eat it.
  const order = RESPONSE_SCHEMA.propertyOrdering
  assert.ok(order.indexOf('draftPrompt') < order.indexOf('say'))
})

await test('a draft cut off by the output limit is rescued, not lost', async () => {
  // Exactly what a real gemini-2.5-flash reply looked like at maxOutputTokens.
  const truncated =
    '{"understood":"The user wants a two-player top-down car game.","confidence":"high",' +
    '"say":"Right, here it is.","draftPrompt":"# Goal\\nBuild a top-down car game.\\n\\n# Constraints\\n- Two players on one keyb'
  const salvaged = salvagePartialJson(truncated)
  assert.equal(salvaged.understood, 'The user wants a two-player top-down car game.')
  assert.match(salvaged.say, /length limit/)
  assert.match(salvaged.say, /Right, here it is\./)
  assert.match(salvaged.draftPrompt, /^# Goal\nBuild a top-down car game\./)
  assert.match(salvaged.draftPrompt, /Two players on one keyb$/)
  assert.equal(salvaged.confidence, 'low')
  assert.equal(salvagePartialJson('total nonsense'), null)
  assert.equal(salvagePartialJson(''), null)

  // And the brain uses it when the API says why it stopped.
  const brain = new GeminiBrain('AIzaFAKE', 'm', async () => ({
    ok: true,
    text: truncated,
    finishReason: 'MAX_TOKENS'
  }))
  const reply = await brain.interpret('a car game', { recentTranscript: [] })
  assert.match(reply.draftPrompt, /# Goal/)
})

await test('malformed JSON is retried once with a nudge', async () => {
  let calls = 0
  const brain = new GeminiBrain('AIzaFAKE', 'm', async () => {
    calls++
    return { ok: true, text: calls === 1 ? 'Sure, I can help with that!' : GOOD }
  })
  const reply = await brain.interpret('open three kimi tabs', { recentTranscript: [] })
  assert.equal(calls, 2)
  assert.equal(reply.confidence, 'high')
})

await test('two malformed replies fail soft into the card, not into nothing', async () => {
  const brain = new GeminiBrain('AIzaFAKE', 'm', async () => ({ ok: true, text: 'still not json' }))
  const reply = await brain.interpret('hello', { recentTranscript: [] })
  assert.match(reply.understood, /not in the JSON shape/)
  assert.equal(reply.say, 'still not json')
  assert.equal(reply.confidence, 'low')
})

await test('API errors surface honestly, with Google’s own words', async () => {
  const brain = new GeminiBrain('AIzaFAKE', 'm', async () => ({
    ok: false,
    error: '400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.',
    status: 400
  }))
  await assert.rejects(
    () => brain.interpret('hello', { recentTranscript: [] }),
    /Gemini refused the key.*API key not valid/s
  )

  const timedOut = new GeminiBrain('AIzaFAKE', 'm', async () => ({
    ok: false,
    error: 'Gemini did not answer within 75s'
  }))
  await assert.rejects(() => timedOut.interpret('hello', { recentTranscript: [] }), /took too long/)

  const broke = new GeminiBrain('AIzaFAKE', 'm', async () => ({ ok: false, error: '429 RESOURCE_EXHAUSTED: quota' }))
  await assert.rejects(() => broke.interpret('hello', { recentTranscript: [] }), /out of quota/)
})

await test('history is capped so the request cannot grow forever', async () => {
  let sent = null
  const brain = new GeminiBrain('AIzaFAKE', 'm', async (req) => {
    sent = req
    return { ok: true, text: GOOD }
  })
  const history = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `t${i}` }))
  await brain.interpret('now this', { recentTranscript: [], history })
  assert.equal(sent.turns.length, 21)
  assert.equal(sent.turns.at(-1).text, 'now this')
})

/* -------------------------------------------------------------- brainjson */

console.log('\nShared JSON contract (brainjson)')

await test('geminibrain still re-exports the helpers it used to own', () => {
  // Existing importers (and the section above) reach for these on geminibrain.
  // The move to brainjson.ts must not have broken that.
  assert.equal(extractJsonObject, brainjson.extractJsonObject)
  assert.equal(parseBrainJson, brainjson.parseBrainJson)
  assert.equal(salvagePartialJson, brainjson.salvagePartialJson)
  assert.equal(sanitiseActions, brainjson.sanitiseActions)
  assert.equal(tidySay, brainjson.tidySay)
})

await test('media actions survive sanitising, and half-formed ones do not', () => {
  assert.deepEqual(sanitiseActions([{ kind: 'make_image', description: 'a red car' }]), [
    { kind: 'make_image', description: 'a red car', count: 1 }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'make_image', description: 'a red car', count: 3, aspect: '16:9' }]), [
    { kind: 'make_image', description: 'a red car', count: 3, aspect: '16:9' }
  ])
  // Four is the ceiling here as well as in the executor.
  assert.equal(sanitiseActions([{ kind: 'make_image', description: 'x', count: 40 }])[0].count, 4)
  assert.deepEqual(sanitiseActions([{ kind: 'make_image' }]), [], 'description is required')
  assert.deepEqual(sanitiseActions([{ kind: 'make_image', description: '   ' }]), [])

  assert.deepEqual(sanitiseActions([{ kind: 'edit_image', path: 'C:\\a.png', instruction: 'blue' }]), [
    { kind: 'edit_image', path: 'C:\\a.png', instruction: 'blue' }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'edit_image', path: 'C:\\a.png' }]), [], 'instruction is required')
  assert.deepEqual(sanitiseActions([{ kind: 'edit_image', instruction: 'blue' }]), [], 'path is required')
  // Still no back door for kinds nobody implements.
  assert.deepEqual(sanitiseActions([{ kind: 'make_video', description: 'a red car' }]), [])
})

await test('salvage names whichever brain was cut off', () => {
  const truncated = '{"understood":"a car game","confidence":"high","draftPrompt":"# Goal\\nBuild a top'
  assert.match(salvagePartialJson(truncated).say, /^Gemini hit its length limit/)
  assert.match(salvagePartialJson(truncated, 'OpenRouter').say, /^OpenRouter hit its length limit/)
  assert.equal(salvagePartialJson('{}', 'OpenRouter'), null)
})

await test('the response schema describes every field an action can carry', () => {
  const props = RESPONSE_SCHEMA.properties.actions.items.properties
  for (const field of ['kind', 'profileId', 'count', 'description', 'aspect', 'path', 'instruction']) {
    assert.ok(props[field], `responseSchema is missing ${field}`)
  }
})

/* --------------------------------------------------------- OpenRouterBrain */

console.log('\nOpenRouterBrain (fake transport)')

await test('no key means the stub, not a doomed request', () => {
  const status = new OpenRouterBrain('', DEFAULT_OPENROUTER_MODEL, async () => {
    throw new Error('should never be called')
  }).ready()
  assert.equal(status.ok, false)
  assert.equal(status.reason, 'no-key')
  assert.match(status.detail, /Kimi/, 'point him at the key he already has')

  const live = new OpenRouterBrain('sk-or-FAKE', 'openai/gpt-5-nano', async () => ({ ok: true, text: GOOD })).ready()
  assert.equal(live.ok, true)
  assert.equal(brainStatusLabel(live), 'openai/gpt-5-nano')
})

await test('a good round trip sends the manifest, the history and asks for JSON', async () => {
  const seen = []
  const brain = new OpenRouterBrain('sk-or-FAKE', 'google/gemini-2.5-flash-lite', async (req) => {
    seen.push(req)
    return { ok: true, text: GOOD }
  })
  const reply = await brain.interpret('open three kimi tabs', {
    recentTranscript: [],
    manifest: 'MANIFEST-HERE',
    history: [
      { role: 'user', text: 'hello' },
      { role: 'agent', text: 'hi' }
    ]
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].model, 'google/gemini-2.5-flash-lite')
  assert.ok(seen[0].system.startsWith('MANIFEST-HERE'))
  // OpenAI-compatible JSON mode 400s if no message mentions JSON.
  assert.match(seen[0].system, /JSON/)
  assert.equal(seen[0].json, true)
  // OpenAI roles, not Gemini's — 'assistant', never 'model'.
  assert.deepEqual(
    seen[0].turns.map((t) => t.role),
    ['user', 'assistant', 'user']
  )
  assert.equal(seen[0].turns.at(-1).text, 'open three kimi tabs')
  assert.deepEqual(reply.actions, [{ kind: 'open_tabs', profileId: 'kimi', count: 3 }])
  assert.equal(reply.confidence, 'high')
})

await test('the same defensive parsing as Gemini: fences, prose, junk fields', async () => {
  const fenced = new OpenRouterBrain('k', 'm', async () => ({ ok: true, text: '```json\n' + GOOD + '\n```' }))
  assert.equal((await fenced.interpret('hi', { recentTranscript: [] })).confidence, 'high')

  const chatty = new OpenRouterBrain('k', 'm', async () => ({ ok: true, text: `Sure! ${GOOD} hope that helps` }))
  assert.equal((await chatty.interpret('hi', { recentTranscript: [] })).actions.length, 1)

  const invented = new OpenRouterBrain('k', 'm', async () => ({
    ok: true,
    text: '{"understood":"x","confidence":"high","actions":[{"kind":"rm_rf","path":"C:\\\\"}]}'
  }))
  const reply = await invented.interpret('hi', { recentTranscript: [] })
  assert.equal(reply.actions, undefined, 'an invented action must not reach the executor')
})

await test('malformed JSON is retried once with a nudge', async () => {
  let calls = 0
  const brain = new OpenRouterBrain('k', 'm', async (req) => {
    calls++
    if (calls === 2) {
      // The nudge replays the bad reply as an assistant turn, then asks again.
      assert.equal(req.turns.at(-2).role, 'assistant')
      assert.match(req.turns.at(-1).text, /not valid JSON/)
    }
    return { ok: true, text: calls === 1 ? 'Sure, I can help with that!' : GOOD }
  })
  const reply = await brain.interpret('open three kimi tabs', { recentTranscript: [] })
  assert.equal(calls, 2)
  assert.equal(reply.confidence, 'high')
})

await test('a draft cut off by the token limit is rescued, not lost', async () => {
  const truncated =
    '{"understood":"The user wants a two-player top-down car game.","confidence":"high",' +
    '"say":"Right, here it is.","draftPrompt":"# Goal\\nBuild a top-down car game.\\n\\n# Constraints\\n- Two players on one keyb'
  // OpenAI's word for it is `length`, not Gemini's MAX_TOKENS.
  const brain = new OpenRouterBrain('k', 'm', async () => ({ ok: true, text: truncated, finishReason: 'length' }))
  const reply = await brain.interpret('a car game', { recentTranscript: [] })
  assert.match(reply.draftPrompt, /^# Goal/)
  assert.match(reply.say, /OpenRouter hit its length limit/)
  assert.equal(reply.confidence, 'low')
})

await test('two malformed replies fail soft into the card, not into nothing', async () => {
  const brain = new OpenRouterBrain('k', 'm', async () => ({ ok: true, text: 'still not json' }))
  const reply = await brain.interpret('hello', { recentTranscript: [] })
  assert.match(reply.understood, /not in the JSON shape/)
  assert.equal(reply.say, 'still not json')
  assert.equal(reply.confidence, 'low')
})

await test('API errors surface honestly, with OpenRouter’s own words', async () => {
  const cases = [
    ['401: No auth credentials found', /refused the key/],
    ['402: Insufficient credits', /out of credit or rate-limiting/],
    ['429: rate limited by upstream', /out of credit or rate-limiting/],
    ['OpenRouter did not answer within 75s', /took too long/],
    ['404: No endpoints found for llama/nope', /not on OpenRouter/],
    ['Could not reach OpenRouter: ENOTFOUND', /check your connection/]
  ]
  for (const [error, expected] of cases) {
    const brain = new OpenRouterBrain('k', 'm', async () => ({ ok: false, error }))
    await assert.rejects(() => brain.interpret('hello', { recentTranscript: [] }), expected, error)
  }
})

await test('history is capped so the request cannot grow forever', async () => {
  let sent = null
  const brain = new OpenRouterBrain('k', 'm', async (req) => {
    sent = req
    return { ok: true, text: GOOD }
  })
  const history = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `t${i}` }))
  await brain.interpret('now this', { recentTranscript: [], history })
  assert.equal(sent.turns.length, 21)
  assert.equal(sent.turns.at(-1).text, 'now this')
})

/* --------------------------------------------------------- agent memory */

console.log('\nAgent memory')

const MEMORY_MD = [
  '# Project memory',
  '',
  '## About this project',
  'A browser car game in TypeScript.',
  '',
  '## Preferences',
  '- remember I prefer TypeScript strict mode',
  '',
  '## Recent activity',
  '- 2026-07-30 15:06 — Opened 3 Kimi tabs',
  ''
].join('\n')

await test('a project’s memory is folded into the system text under its own heading', () => {
  const folded = withProjectMemory('MANIFEST-HERE', MEMORY_MD)
  assert.ok(folded.startsWith('MANIFEST-HERE'), 'the manifest comes first, untouched')
  assert.ok(folded.includes(MEMORY_HEADING))
  assert.ok(folded.includes('I prefer TypeScript strict mode'))
  assert.ok(folded.indexOf(MEMORY_HEADING) > folded.indexOf('MANIFEST-HERE'))
})

await test('no memory means the system text is byte-identical to before', () => {
  // The whole feature has to be invisible on a project that has said nothing.
  assert.equal(withProjectMemory('MANIFEST-HERE'), 'MANIFEST-HERE')
  assert.equal(withProjectMemory('MANIFEST-HERE', ''), 'MANIFEST-HERE')
  assert.equal(withProjectMemory('MANIFEST-HERE', '   \n  '), 'MANIFEST-HERE')
})

await test('GeminiBrain really sends it, and only when there is some', async () => {
  const seen = []
  const brain = new GeminiBrain('AIzaFAKE', 'm', async (req) => {
    seen.push(req)
    return { ok: true, text: GOOD }
  })
  await brain.interpret('open three kimi tabs', {
    recentTranscript: [],
    manifest: 'MANIFEST-HERE',
    projectMemory: MEMORY_MD
  })
  assert.match(seen[0].system, new RegExp(MEMORY_HEADING))
  assert.match(seen[0].system, /I prefer TypeScript strict mode/)

  await brain.interpret('again', { recentTranscript: [], manifest: 'MANIFEST-HERE' })
  assert.equal(seen[1].system, 'MANIFEST-HERE', 'no memory, no heading')
})

await test('OpenRouterBrain folds it in the same way, before the JSON reminder', async () => {
  const seen = []
  const brain = new OpenRouterBrain('sk-or-FAKE', 'm', async (req) => {
    seen.push(req)
    return { ok: true, text: GOOD }
  })
  await brain.interpret('open three kimi tabs', {
    recentTranscript: [],
    manifest: 'MANIFEST-HERE',
    projectMemory: MEMORY_MD
  })
  assert.match(seen[0].system, new RegExp(MEMORY_HEADING))
  assert.match(seen[0].system, /JSON/, 'the JSON-mode reminder still comes last')
  assert.ok(seen[0].system.indexOf(MEMORY_HEADING) < seen[0].system.lastIndexOf('JSON object'))
})

await test('the manifest tells the model the memory exists, and stays small', () => {
  const text = buildManifest(SNAPSHOT)
  assert.match(text, /WHAT YOU REMEMBER ABOUT THIS PROJECT/, 'one line naming the section it will arrive under')
  assert.ok(text.length < 6000, `manifest is ${text.length} chars`)
})

await test('the markdown format round-trips through parse and format', () => {
  const parsed = parseMemory(MEMORY_MD)
  assert.equal(parsed.about, 'A browser car game in TypeScript.')
  assert.deepEqual(parsed.preferences, ['remember I prefer TypeScript strict mode'])
  assert.deepEqual(parsed.activity, ['2026-07-30 15:06 — Opened 3 Kimi tabs'])
  assert.deepEqual(parseMemory(formatMemory(parsed)), parsed, 'format ∘ parse is identity')
  assert.equal(formatMemory(parseMemory('')), '', 'nothing in, nothing out')
})

/* ---------------------------------------------------------- what it learns */

await test('a standing instruction is stored verbatim as a preference', () => {
  for (const said of [
    'remember I prefer TypeScript strict mode',
    'always run the tests before you push',
    'never commit straight to master',
    'from now on use British English',
    "don't touch the packaging config",
    'I prefer tabs over spaces'
  ]) {
    const updates = extractMemoryUpdates({ utterance: said })
    assert.deepEqual(updates, [{ section: 'preferences', entry: said }], said)
  }
})

await test('an ordinary request is not mistaken for a standing instruction', () => {
  for (const said of [
    'open three kimi tabs',
    'why is the build failing',
    'can you remember to check the tests',
    'build me a car game like Mario',
    'what do you remember'
  ]) {
    const updates = extractMemoryUpdates({ utterance: said })
    assert.ok(!updates.some((u) => u.section === 'preferences'), `"${said}" is not a preference`)
  }
})

await test('what actually happened becomes activity — and what has not, does not', () => {
  const updates = extractMemoryUpdates({
    utterance: 'open three kimi tabs',
    outcomes: [
      { ok: true, summary: 'Opened 3 Kimi tabs' },
      { ok: false, summary: 'Session limit (16) reached — nothing opened' },
      // Provisional: the image is still generating. Recording it would be a lie.
      { ok: true, summary: 'Generating 2 images…' }
    ]
  })
  assert.deepEqual(updates, [{ section: 'activity', entry: 'Opened 3 Kimi tabs' }])
})

await test('a drafted prompt names what the project is working on', () => {
  const updates = extractMemoryUpdates({
    utterance: 'I want a top-down car game',
    reply: {
      understood: 'build a car game',
      confidence: 'high',
      draftPrompt: '# Goal\nBuild a top-down two-player car game for the browser.\n\n# Constraints\n- Canvas only'
    }
  })
  assert.deepEqual(updates, [
    { section: 'decisions', entry: 'Working on: Build a top-down two-player car game for the browser.' },
    { section: 'activity', entry: 'Drafted a prompt for: Build a top-down two-player car game for the browser.' }
  ])
  // A bare "# Goal" says nothing; the subject is the line that does.
  assert.equal(draftSubject('# Goal\n\nShip the payments rewrite.'), 'Ship the payments rewrite.')
  assert.equal(draftSubject('   \n\n'), null)
})

await test('one exchange can teach more than one thing', () => {
  const updates = extractMemoryUpdates({
    utterance: 'always use strict mode',
    reply: { understood: 'a preference', confidence: 'high', draftPrompt: 'Turn on strict mode everywhere.' },
    outcomes: [{ ok: true, summary: 'Opened 1 Kimi tab' }]
  })
  assert.deepEqual(
    updates.map((u) => u.section),
    ['preferences', 'activity', 'decisions', 'activity']
  )
})

await test('nothing worth remembering means nothing is written', () => {
  assert.deepEqual(extractMemoryUpdates({ utterance: 'hello' }), [])
  assert.deepEqual(extractMemoryUpdates({ utterance: '' }), [])
})

/* ---------------------------------------------------------- reading it back */

await test('“what do you remember?” is answered off the file, not by a model', () => {
  const answer = describeMemory(MEMORY_MD)
  assert.match(answer, /About: A browser car game/)
  assert.match(answer, /You told me: remember I prefer TypeScript strict mode/)
  assert.match(answer, /Last thing I did: Opened 3 Kimi tabs/)
  assert.ok(!answer.includes('2026-07-30'), 'the stamp is not what he asked for')
  assert.ok(answer.length <= 600)

  assert.match(describeMemory(''), /Nothing yet/)
  assert.match(describeMemory('# Project memory\n'), /Nothing yet/)
})

await test('a huge memory is clipped rather than dumped into one chip', () => {
  const fat = formatMemory({
    about: 'z'.repeat(1000),
    decisions: [],
    preferences: [],
    activity: []
  })
  const answer = describeMemory(fat)
  assert.ok(answer.length <= 600, `${answer.length} chars`)
  assert.ok(answer.endsWith('…'))
})

/* --------------------------------------------------------- the write loop */

/** An in-memory stand-in for the main process's store, same contract. */
function fakeBackend() {
  const files = new Map()
  const calls = []
  const backend = {
    files,
    calls,
    async read(id) {
      calls.push(['read', id])
      return files.get(id) ?? ''
    },
    async append(id, section, entry, at) {
      calls.push(['append', id, section, entry, at])
      const memory = parseMemory(files.get(id) ?? '')
      if (section === 'about') memory.about = `${memory.about} ${entry}`.trim()
      else memory[section].push(section === 'activity' ? `2026-07-30 15:04 — ${entry}` : entry)
      const next = formatMemory(memory)
      files.set(id, next)
      return next
    },
    async replaceSummary(id, text) {
      calls.push(['replaceSummary', id, text])
      const memory = parseMemory(files.get(id) ?? '')
      memory.about = text
      const next = formatMemory(memory)
      files.set(id, next)
      return next
    },
    async clear(id) {
      calls.push(['clear', id])
      files.delete(id)
      return true
    }
  }
  return backend
}

await test('recording an exchange writes it, and warms the copy the brain sees', async () => {
  const backend = fakeBackend()
  setMemoryBackend(backend)
  setMemorySummariser(async () => null)
  agentMemory.__reset()

  await agentMemory.record({
    projectId: 'p1',
    utterance: 'remember I prefer TypeScript strict mode',
    at: Date.parse('2026-07-30T15:04:00Z'),
    outcomes: [{ ok: true, summary: 'Opened 3 Kimi tabs' }]
  })

  const file = backend.files.get('p1')
  assert.match(file, /- remember I prefer TypeScript strict mode/)
  assert.match(file, /Opened 3 Kimi tabs/)
  // The panel builds the next brain context synchronously — no await allowed.
  assert.equal(agentMemory.cached('p1'), file)
})

await test('memory is per project: nothing leaks from one to another', async () => {
  const backend = fakeBackend()
  setMemoryBackend(backend)
  agentMemory.__reset()

  await agentMemory.record({ projectId: 'p1', utterance: 'always use strict mode', at: 1 })
  await agentMemory.record({ projectId: 'p2', utterance: 'never use jQuery', at: 2 })

  assert.match(agentMemory.cached('p1'), /strict mode/)
  assert.ok(!agentMemory.cached('p1').includes('jQuery'))
  assert.match(agentMemory.cached('p2'), /jQuery/)
  assert.ok(!agentMemory.cached('p2').includes('strict mode'))
  assert.equal(agentMemory.cached(null), '', 'no project, no memory')
})

await test('with no project id nothing is written at all', async () => {
  const backend = fakeBackend()
  setMemoryBackend(backend)
  agentMemory.__reset()
  await agentMemory.record({ projectId: null, utterance: 'always use strict mode', at: 1 })
  assert.equal(backend.calls.length, 0)
})

await test('recall and forget go through the same store', async () => {
  const backend = fakeBackend()
  setMemoryBackend(backend)
  agentMemory.__reset()
  await agentMemory.record({ projectId: 'p1', utterance: 'always use strict mode', at: 1 })

  const recalled = await agentMemory.recall('p1')
  assert.equal(recalled.ok, true)
  assert.match(recalled.summary, /You told me: always use strict mode/)

  const forgotten = await agentMemory.forget('p1')
  assert.equal(forgotten.ok, true)
  assert.match(forgotten.summary, /Forgotten/)
  assert.equal(backend.files.has('p1'), false)
  assert.equal(agentMemory.cached('p1'), '')

  const again = await agentMemory.forget('p1')
  assert.match(again.summary, /nothing to forget/)
  assert.equal((await agentMemory.recall('p1')).summary, describeMemory(''))
})

await test('a store that is broken costs the memory, never the reply', async () => {
  setMemoryBackend({
    read: async () => {
      throw new Error('disk on fire')
    },
    append: async () => {
      throw new Error('disk on fire')
    },
    replaceSummary: async () => {
      throw new Error('disk on fire')
    },
    clear: async () => {
      throw new Error('disk on fire')
    }
  })
  agentMemory.__reset()
  // record() must resolve, not reject: the reply is already on screen. It does
  // warn, which is the point — silenced here so the suite output stays honest
  // about what failed and what merely proved it fails quietly.
  const warn = console.warn
  console.warn = () => {}
  await agentMemory.record({ projectId: 'p1', utterance: 'always use strict mode', at: 1 })
  console.warn = warn
  assert.equal(await agentMemory.prime('p1'), '')
  const failed = await agentMemory.recall('p1')
  assert.equal(failed.ok, false)
  assert.match(failed.summary, /disk on fire/)
})

await test('the optional LLM summary is off by default and rare when on', async () => {
  const backend = fakeBackend()
  setMemoryBackend(backend)
  agentMemory.__reset()

  let asked = 0
  setMemorySummariser(async () => {
    asked++
    return 'A car game, built the way Steve likes it.'
  })

  for (let i = 0; i < SUMMARISE_EVERY - 1; i++) {
    await agentMemory.record({ projectId: 'p1', utterance: `always do thing ${i}`, at: i })
  }
  assert.equal(asked, 0, 'nine exchanges cost nothing extra')

  await agentMemory.record({ projectId: 'p1', utterance: 'always do the last thing', at: 99 })
  assert.equal(asked, 1, `one call every ${SUMMARISE_EVERY} exchanges, not one per phrase`)
  assert.match(agentMemory.cached('p1'), /A car game, built the way Steve likes it\./)
  assert.match(agentMemory.cached('p1'), /always do thing 0/, 'and it rewrites only the summary')

  // A summariser that declines (no key, setting off, API error) changes nothing.
  setMemorySummariser(async () => null)
  const before = agentMemory.cached('p1')
  for (let i = 0; i < SUMMARISE_EVERY; i++) {
    await agentMemory.record({ projectId: 'p1', utterance: 'nothing worth remembering', at: i })
  }
  assert.equal(agentMemory.cached('p1'), before)
})

setMemoryBackend(null)
setMemorySummariser(null)

/* ------------------------------------------------------------------- live */

/**
 * The only check here that costs money — a single call on the cheapest model in
 * the defaults, which is the only way to prove that model id still exists on
 * OpenRouter. Opt-in, and skipped entirely without a key on disk.
 */
if (LIVE_OPENROUTER) {
  console.log('\nOpenRouter (live)')
  const keyPath = join(homedir(), '.kimi-key')
  if (!existsSync(keyPath)) {
    console.log(`  --  skipped: no ${keyPath}`)
  } else {
    const key = readFileSync(keyPath, 'utf8').trim()
    await test(`a real round trip on ${DEFAULT_OPENROUTER_MODEL}`, async () => {
      const started = Date.now()
      const brain = new OpenRouterBrain(key, DEFAULT_OPENROUTER_MODEL, async (req) => {
        // The main process is not running, so stand in for electron/voice-bridge.
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${req.key}`,
            'HTTP-Referer': 'https://forge.local',
            'X-Title': 'Forge'
          },
          body: JSON.stringify({
            model: req.model,
            messages: [
              { role: 'system', content: req.system },
              ...req.turns.map((t) => ({ role: t.role, content: t.text }))
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 800
          })
        })
        const body = await res.json()
        if (!res.ok || body.error) {
          return { ok: false, error: `${res.status}: ${body?.error?.message ?? 'unknown'}` }
        }
        return {
          ok: true,
          text: body.choices?.[0]?.message?.content ?? '',
          finishReason: body.choices?.[0]?.finish_reason,
          model: body.model
        }
      })

      const reply = await brain.interpret('open three kimi tabs', {
        recentTranscript: [],
        manifest: buildManifest(SNAPSHOT)
      })
      console.log(`      ${Date.now() - started}ms · understood: ${reply.understood}`)
      console.log(`      actions: ${JSON.stringify(reply.actions ?? [])}`)
      assert.ok(reply.understood, 'a live reply must say what it understood')
      assert.ok(['low', 'medium', 'high'].includes(reply.confidence))
    })
  }
}

console.log(`\n${passed} checks passed\n`)

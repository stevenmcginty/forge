/**
 * Component-level checks for the voice agent (M4).
 *
 * Covers the contracts the rest of the app is built on:
 *   • VoiceBrain      — StubBrain, the scaffolds, and the getActiveBrain selector
 *   • TranscriptSource — push sources and the fan-in bus
 *   • voicecommands   — the deterministic grammar (no model involved)
 *   • appactions      — the executor, its limits and its fuzzy name matching
 *   • appmanifest     — the capability manifest handed to every brain
 *   • geminibrain     — request/JSON handling against a fake transport
 *
 * Run: npm run voice:check
 *
 * The hooks below only tell Node how to load the app's .ts modules: the package
 * is CommonJS for Electron's sake, and Node does not resolve extensionless
 * relative imports the way the bundler does. Nothing is transformed beyond
 * stripping types, so these are the real modules, not copies.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const {
  StubBrain,
  ClaudeBrain,
  OpenAIBrain,
  getActiveBrain,
  brainStatusLabel,
  maskKey,
  NOT_CONNECTED
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
  RESPONSE_SCHEMA
} = await import('../src/lib/geminibrain.ts')

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

console.log(`\n${passed} checks passed\n`)

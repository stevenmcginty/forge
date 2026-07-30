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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
const { runAppAction, matchProfile, matchProject, resolvePaneTarget, paneLabel } = await import(
  '../src/lib/appactions.ts'
)
const { buildManifest, ACTION_SPECS, EXTENSION_POINTS, SAY_RULES } = await import('../src/lib/appmanifest.ts')
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
const { claimsCompletedAction, companionReplyText } = brainjson
const { chooseVoice, speakable, echoOverlap, ECHO_WINDOW_MS } = await import('../src/lib/speech.ts')
const { planProjectFolder, sanitiseFolderName } = await import('../electron/projectfolder.ts')
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

/**
 * A pane as the agent sees it. `number` is the spoken handle — "Terminal 2" —
 * and the order of this array is the order the manifest prints.
 */
function pane(over = {}) {
  return {
    paneId: 'pane1',
    tabId: 't1',
    tabNumber: 1,
    tabTitle: 'build',
    number: 1,
    title: 'PowerShell',
    profileId: 'pwsh',
    profileName: 'PowerShell',
    live: true,
    focused: false,
    agent: false,
    lastFocusedAt: 0,
    ...over
  }
}

/** The default workspace the executor tests target: one shell, two Claudes. */
const PANES = [
  pane({ paneId: 'pane1', number: 1, title: 'PowerShell', focused: true }),
  pane({
    paneId: 'pane2',
    number: 2,
    tabId: 't2',
    tabNumber: 2,
    tabTitle: 'notes',
    title: 'Claude Code',
    profileId: 'claude',
    profileName: 'Claude Code',
    agent: true
  })
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
    panes: PANES,
    autoRelay: true,
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

/** A runner that can also deliver prompts, so send_prompt runs end to end. */
function dispatchRunner() {
  const base = fakeRunner()
  return {
    ...base,
    sendPrompt: async ({ pane: target, text, submit, holdReason, flesh }) => {
      base.calls.push(['sendPrompt', target.paneId, text, submit, holdReason ?? null, flesh ?? null])
      return {
        ok: true,
        summary: submit ? `Sent to ${paneLabel(target)}` : `Typed into ${paneLabel(target)}`,
        requested: 1,
        done: 1
      }
    }
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

/* ---------------------------------------------------------- count matrix */

console.log('\nCounts, end to end')

/**
 * The regression Steve actually hit: "is this working, open 3 claude code
 * terminals" opened one tab. Everything below is the count travelling intact
 * from his mouth to the executor, by every route it can take.
 */
await test('the exact sentence Steve said, and its variants, all mean three', () => {
  for (const phrase of [
    'open 3 claude code terminals',
    'open three claude code terminals',
    'three claude terminals',
    '3 cc sessions',
    'open 3 cc terminals',
    'fire up three claude code sessions',
    'give me 3 claude terminals'
  ]) {
    const hit = parseUtterance(phrase, C)
    assert.ok(hit, `"${phrase}" did not parse`)
    assert.equal(hit.actions.length, 1, `"${phrase}" should be one action, not ${hit.actions.length}`)
    assert.equal(hit.actions[0].kind, 'open_tabs', phrase)
    assert.equal(hit.actions[0].profileId, 'claude', phrase)
    assert.equal(hit.actions[0].count, 3, `"${phrase}" lost its count`)
  }
})

await test('the leading pleasantry sends it to the brain — and the count survives there', () => {
  // The grammar deliberately refuses a half-command ("is this working" is a
  // question), so this sentence is the brain's. What must not happen again is
  // the count evaporating on the way through the JSON contract.
  assert.equal(parseUtterance('is this working, open 3 claude code terminals', C), null)

  const reply = parseBrainJson(
    '{"understood":"three claude code tabs","confidence":"high",' +
      '"actions":[{"kind":"open_tabs","profileId":"claude","count":3}]}'
  )
  assert.deepEqual(reply.actions, [{ kind: 'open_tabs', profileId: 'claude', count: 3 }])
  const run = fakeRunner()
  const out = runAppAction(reply.actions[0], ctx(), run)
  assert.equal(out.done, 3)
  assert.equal(out.summary, 'Opened 3 Claude Code tabs')
  assert.equal(run.calls.length, 3)
})

await test('count is REQUIRED in the response schema — this is the bug', () => {
  // gemini-2.5-flash, with count optional, simply did not emit it: the field is
  // absent from the JSON and the sanitiser's fallback made every action a 1.
  // Requiring it in the responseSchema is what actually fixed the repro.
  const item = RESPONSE_SCHEMA.properties.actions.items
  assert.ok(item.required.includes('count'), 'count must be required, or the model may skip it')
  assert.ok(item.required.includes('kind'))
  // And emitted early, so a reply that runs long cannot lose it.
  assert.ok(item.propertyOrdering.indexOf('count') < item.propertyOrdering.indexOf('description'))
})

await test('N duplicate actions mean N — the shape the model actually returned', () => {
  // The raw reply from the live repro: three open_tabs, no count anywhere.
  const raw = [
    { kind: 'open_tabs', profileId: 'claude', projectName: 'forge' },
    { kind: 'open_tabs', profileId: 'claude', projectName: 'forge' },
    { kind: 'open_tabs', profileId: 'claude', projectName: 'forge' }
  ]
  assert.deepEqual(sanitiseActions(raw), [
    { kind: 'open_tabs', profileId: 'claude', count: 3, projectName: 'forge' }
  ])
  // Different agents are different orders and stay apart.
  assert.deepEqual(
    sanitiseActions([
      { kind: 'open_tabs', profileId: 'claude', count: 2 },
      { kind: 'open_tabs', profileId: 'kimi', count: 1 }
    ]),
    [
      { kind: 'open_tabs', profileId: 'claude', count: 2 },
      { kind: 'open_tabs', profileId: 'kimi', count: 1 }
    ]
  )
  // So do different split directions.
  assert.equal(
    sanitiseActions([
      { kind: 'open_panes', profileId: 'claude', count: 1, direction: 'row' },
      { kind: 'open_panes', profileId: 'claude', count: 1, direction: 'column' }
    ]).length,
    2
  )
})

await test('every count route agrees: grammar, brain, executor, clamp', () => {
  const cases = [
    { spoken: 'open two claude tabs', count: 2, paneCount: 2, done: 2, summary: /^Opened 2 Claude Code tabs$/ },
    { spoken: 'open 5 claude tabs', count: 5, paneCount: 14, done: 2, summary: /Opened 2 of 5 .* session limit \(16\)/ },
    { spoken: 'open one claude tab', count: 1, paneCount: 0, done: 1, summary: /^Opened 1 Claude Code tab$/ },
    { spoken: 'open sixteen claude tabs', count: 16, paneCount: 0, done: 16, summary: /^Opened 16 Claude Code tabs$/ }
  ]
  for (const c of cases) {
    const hit = parseUtterance(c.spoken, C)
    assert.equal(hit.actions[0].count, c.count, c.spoken)
    // The same count, arriving from a model instead, must behave identically.
    const viaBrain = sanitiseActions([{ kind: 'open_tabs', profileId: 'claude', count: c.count }])
    assert.deepEqual(viaBrain[0], hit.actions[0], `${c.spoken}: grammar and brain must agree`)
    const run = fakeRunner()
    const out = runAppAction(viaBrain[0], ctx({ paneCount: c.paneCount }), run)
    assert.equal(out.requested, c.count, c.spoken)
    assert.equal(out.done, c.done, c.spoken)
    assert.equal(run.calls.length, c.done, c.spoken)
    assert.match(out.summary, c.summary, c.spoken)
  }
})

await test('terminals and sessions are tab words, so the free path catches them', () => {
  for (const noun of ['terminal', 'terminals', 'session', 'sessions', 'instance', 'instances', 'shell', 'shells']) {
    const hit = parseCommand(`open two claude ${noun}`, C)
    assert.ok(hit, `"${noun}" is not a tab word`)
    assert.equal(hit.action.kind, 'open_tabs', noun)
    assert.equal(hit.action.count, 2, noun)
  }
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

/* ------------------------------------------------- dispatch to a terminal */

console.log('\nFree-flow dispatch (send_prompt)')

/** Three Claude panes and a shell — the shape "the claude one" is ambiguous in. */
const CROWDED = [
  pane({ paneId: 'p1', number: 1, title: 'PowerShell', focused: true }),
  pane({ paneId: 'p2', number: 2, title: 'build', profileId: 'claude', profileName: 'Claude Code', agent: true }),
  pane({ paneId: 'p3', number: 3, title: 'docs', profileId: 'claude', profileName: 'Claude Code', agent: true }),
  pane({ paneId: 'p4', number: 4, title: 'tests', profileId: 'claude', profileName: 'Claude Code', agent: true }),
  pane({ paneId: 'p5', number: 5, title: 'sidebar', profileId: 'kimi', profileName: 'Kimi', agent: true })
]

await test('the grammar dispatches a named terminal without a model', () => {
  const cases = [
    ['in terminal two, build me a landing page for a cafe', 'terminal two', 'build me a landing page for a cafe'],
    ['terminal one build me a landing page', 'terminal one', 'build me a landing page'],
    ['in tab 3: add a lap timer', 'tab 3', 'add a lap timer'],
    ['on pane two — refactor the router', 'pane two', 'refactor the router'],
    ['in the second terminal, write the tests', 'terminal second', 'write the tests'],
    ['tell the claude pane to fix the header', 'claude', 'to fix the header'],
    ['in terminal two, this is the prompt: build me a menu page', 'terminal two', 'build me a menu page']
  ]
  for (const [said, target, text] of cases) {
    const hit = parseUtterance(said, C)
    assert.ok(hit, `"${said}" did not dispatch`)
    assert.equal(hit.actions.length, 1, said)
    assert.equal(hit.actions[0].kind, 'send_prompt', said)
    assert.equal(hit.actions[0].target, target, said)
    assert.equal(hit.actions[0].text, text, said)
    // The quick path hands his words over as they are; fleshing is the brain's.
    assert.equal(hit.actions[0].flesh, false, said)
  }
})

await test('a prompt full of commas is still one prompt', () => {
  const hit = parseUtterance('in terminal two, build a landing page, a menu page and a booking form', C)
  assert.equal(hit.actions.length, 1)
  assert.equal(hit.actions[0].text, 'build a landing page, a menu page and a booking form')
})

await test('talking ABOUT a terminal is not talking TO it', () => {
  for (const said of [
    'the second tab is broken',
    'terminal two keeps crashing',
    'in terminal two what is going on',
    'tab 3 looks wrong',
    'terminal one',
    'why is terminal two so slow'
  ]) {
    const hit = parseUtterance(said, C)
    const kind = hit?.actions?.[0]?.kind
    assert.notEqual(kind, 'send_prompt', `"${said}" must not be dispatched as a prompt`)
  }
})

await test('targets resolve by number, ordinal, title and agent', () => {
  const at = (spoken, focusedId = 'p1') => resolvePaneTarget(spoken, CROWDED, focusedId)
  assert.equal(at('terminal two').pane.paneId, 'p2')
  assert.equal(at('terminal 2').pane.paneId, 'p2')
  assert.equal(at('2').pane.paneId, 'p2')
  assert.equal(at('tab 4').pane.paneId, 'p4')
  assert.equal(at('terminal second').pane.paneId, 'p2')
  assert.equal(at('the last one').pane.paneId, 'p5')
  assert.equal(at('docs').pane.paneId, 'p3')
  assert.equal(at('the kimi one').pane.paneId, 'p5')
  assert.equal(at('this').pane.paneId, 'p1')
  assert.equal(at('').pane.paneId, 'p1')
  assert.equal(at('current pane').pane.paneId, 'p1')
  // A number nobody has is not silently rounded to the nearest pane.
  assert.equal(at('terminal 9').kind, 'none')
  assert.equal(at('terminal nine').kind, 'none')
})

await test('"terminal one" is pane one, not the pane he happens to be in', () => {
  // Found live, with six terminals open: "in terminal one, <prompt>" delivered
  // the prompt to terminal six. "one" is in TARGET_NOUNS so that "the claude
  // one" strips to "claude" -- which left "terminal one" stripping to nothing,
  // and a target with no words left fell through to the focused pane. Silently.
  const focusedLast = 'p5'
  assert.equal(resolvePaneTarget('terminal one', CROWDED, focusedLast).pane.number, 1)
  assert.equal(resolvePaneTarget('tab one', CROWDED, focusedLast).pane.number, 1)
  assert.equal(resolvePaneTarget('pane one', CROWDED, focusedLast).pane.number, 1)
  assert.equal(resolvePaneTarget('the first terminal', CROWDED, focusedLast).pane.number, 1)
  // And the reading it was protecting still holds: a bare "one" after a word
  // that is not a numbered noun is "that one", not pane 1.
  assert.equal(resolvePaneTarget('this one', CROWDED, focusedLast).pane.paneId, focusedLast)
  assert.equal(resolvePaneTarget('the last one', CROWDED, focusedLast).pane.number, 5)
  assert.equal(resolvePaneTarget('the kimi one', CROWDED, focusedLast).pane.paneId, 'p5')
})

await test('two equal matches are asked about, never guessed', () => {
  // Steve's own example: three Claude panes and "the claude one".
  const out = resolvePaneTarget('the claude one', CROWDED, 'p1')
  assert.equal(out.kind, 'ambiguous')
  assert.deepEqual(
    out.candidates.map((c) => c.number),
    [2, 3, 4]
  )
  // Sitting in one of them makes it obvious which one he means.
  assert.equal(resolvePaneTarget('the claude one', CROWDED, 'p3').pane.paneId, 'p3')
  // So does having been in one most recently.
  const recent = CROWDED.map((p) => (p.paneId === 'p4' ? { ...p, lastFocusedAt: 9 } : p))
  assert.equal(resolvePaneTarget('the claude one', recent, 'p1').pane.paneId, 'p4')
})

await test('the ambiguous case comes back as a question listing the candidates', () => {
  const run = dispatchRunner()
  const out = runAppAction(
    { kind: 'send_prompt', target: 'the claude one', text: 'build a landing page' },
    ctx({ panes: CROWDED, focusedPaneId: 'p1' }),
    run
  )
  assert.equal(out.ok, false)
  assert.match(out.summary, /^Which one\?/)
  assert.match(out.summary, /Terminal 2 “build”/)
  assert.match(out.summary, /Terminal 3 “docs”/)
  assert.match(out.summary, /Terminal 4 “tests”/)
  assert.equal(run.calls.length, 0, 'nothing may be sent while it is ambiguous')
})

await test('a resolved agent pane is typed into and submitted, once', async () => {
  const run = dispatchRunner()
  const out = runAppAction(
    { kind: 'send_prompt', target: 'terminal two', text: 'build me a landing page', flesh: true },
    ctx({ panes: CROWDED, focusedPaneId: 'p1' }),
    run
  )
  assert.equal(out.ok, true)
  assert.match(out.summary, /Sending to Terminal 2 “build”… say “wait” to hold/)
  const settled = await out.pending
  assert.equal(settled.done, 1)
  assert.deepEqual(run.calls, [['sendPrompt', 'p2', 'build me a landing page', true, null, true]])
})

await test('a plain shell is never submitted for him, whatever the settings say', async () => {
  const run = dispatchRunner()
  const out = runAppAction(
    { kind: 'send_prompt', target: 'terminal one', text: 'rm -rf everything' },
    ctx({ panes: CROWDED, focusedPaneId: 'p1', autoRelay: true }),
    run
  )
  await out.pending
  assert.equal(run.calls[0][3], false, 'submit must be false for a plain shell')
  assert.match(out.summary, /plain shell/)
})

await test('auto-relay off types it in and leaves the Enter to him', async () => {
  const run = dispatchRunner()
  const out = runAppAction(
    { kind: 'send_prompt', target: 'terminal two', text: 'build me a landing page' },
    ctx({ panes: CROWDED, focusedPaneId: 'p1', autoRelay: false }),
    run
  )
  await out.pending
  assert.equal(run.calls[0][3], false)
  assert.match(out.summary, /auto-relay is off/)

  // And an explicit submit:false from the brain is obeyed even with it on.
  const run2 = dispatchRunner()
  runAppAction(
    { kind: 'send_prompt', target: 'terminal two', text: 'x', submit: false },
    ctx({ panes: CROWDED, focusedPaneId: 'p1', autoRelay: true }),
    run2
  ).pending
  assert.equal(run2.calls[0][3], false)
})

await test('send_prompt refuses what it cannot do, rather than pretending', () => {
  const full = ctx({ panes: CROWDED, focusedPaneId: 'p1' })
  assert.match(runAppAction({ kind: 'send_prompt', target: 'terminal two', text: '  ' }, full, dispatchRunner()).summary,
    /prompt is empty/)
  assert.match(
    runAppAction({ kind: 'send_prompt', target: 'terminal nine', text: 'x' }, full, dispatchRunner()).summary,
    /No terminal called “terminal nine”/
  )
  const dead = CROWDED.map((p) => (p.paneId === 'p2' ? { ...p, live: false } : p))
  assert.match(
    runAppAction({ kind: 'send_prompt', target: 'terminal two', text: 'x' }, ctx({ panes: dead }), dispatchRunner())
      .summary,
    /shell has exited/
  )
  assert.match(
    runAppAction({ kind: 'send_prompt', target: 'terminal two', text: 'x' }, ctx({ panes: [] }), dispatchRunner())
      .summary,
    /No terminals open/
  )
  // A runner with no dispatch support says so instead of silently doing nothing.
  assert.equal(runAppAction({ kind: 'send_prompt', target: 'this', text: 'x' }, full, fakeRunner()).ok, false)
})

await test('the whole flow: open three, then dispatch to the second', async () => {
  // 1 — "open three claude terminals" opens three.
  const opened = parseUtterance('open three claude terminals', C)
  assert.equal(opened.actions[0].count, 3)
  const run = fakeRunner()
  assert.equal(runAppAction(opened.actions[0], ctx({ paneCount: 0 }), run).done, 3)

  // 2 — "in terminal two, build me a landing page for a cafe" goes to that one.
  const three = [
    pane({ paneId: 'a', number: 1, title: 'Claude Code', profileId: 'claude', profileName: 'Claude Code', agent: true, focused: true }),
    pane({ paneId: 'b', number: 2, title: 'Claude Code', profileId: 'claude', profileName: 'Claude Code', agent: true }),
    pane({ paneId: 'c', number: 3, title: 'Claude Code', profileId: 'claude', profileName: 'Claude Code', agent: true })
  ]
  const said = parseUtterance('in terminal two, build me a landing page for a cafe', C)
  assert.equal(said.actions[0].kind, 'send_prompt')
  const run2 = dispatchRunner()
  const out = runAppAction(said.actions[0], ctx({ panes: three, focusedPaneId: 'a' }), run2)
  await out.pending
  assert.deepEqual(run2.calls, [['sendPrompt', 'b', 'build me a landing page for a cafe', true, null, false]])
})

await test('sanitiseActions carries a send_prompt through, and its empty-text convention', () => {
  assert.deepEqual(sanitiseActions([{ kind: 'send_prompt', target: 'terminal 2', text: 'go', flesh: true }]), [
    { kind: 'send_prompt', target: 'terminal 2', text: 'go', flesh: true }
  ])
  // Empty text is legal and means "the draftPrompt in this same reply"; the
  // panel substitutes it before the executor ever sees it.
  assert.deepEqual(sanitiseActions([{ kind: 'send_prompt', target: 'terminal 2' }]), [
    { kind: 'send_prompt', target: 'terminal 2', text: '' }
  ])
  // No target at all means the pane he is looking at.
  assert.equal(sanitiseActions([{ kind: 'send_prompt', text: 'go' }])[0].target, 'this')
  assert.equal(sanitiseActions([{ kind: 'send_prompt', target: 't', text: 'x', submit: false }])[0].submit, false)
})

/* ----------------------------------------------- closing, making, viewing */

console.log('\nClosing, creating, and the actions that used to be substituted')

/** A runner that can also close in bulk and create a project. */
function fullRunner(createResult) {
  const base = dispatchRunner()
  return {
    ...base,
    renameTab: (tabId, title) => base.calls.push(['renameTab', tabId, title]),
    setViewMode: (mode) => base.calls.push(['setViewMode', mode]),
    openSettings: (section) => base.calls.push(['openSettings', section ?? null]),
    closeMany: async ({ tabIds, label }) => {
      base.calls.push(['closeMany', tabIds.join(','), label])
      return { ok: true, summary: `Closed ${tabIds.length} tabs (${label})`, requested: tabIds.length, done: tabIds.length }
    },
    createProject: async ({ name, parentDir }) => {
      base.calls.push(['createProject', name, parentDir ?? null])
      return createResult ?? { ok: true, summary: `Created “${name}”`, requested: 1, done: 1 }
    }
  }
}

await test('“Close tab one” closes tab one — it does not switch to it', () => {
  // The exact regression from Steve's session: the closing actions took no
  // target, so the model reached for focus_tab and Forge said "Switched to Tab
  // 1" about a tab he had asked it to get rid of.
  const hit = parseUtterance('close tab one', C)
  assert.equal(hit.actions[0].kind, 'close_tab', 'close tab one must CLOSE')
  assert.equal(hit.actions[0].which, 'tab one')

  const run = fullRunner()
  const out = runAppAction(hit.actions[0], ctx(), run)
  assert.equal(out.ok, true)
  assert.equal(out.summary, 'Closed “build”')
  assert.deepEqual(run.calls, [['closeTab', 't1']])

  // And the navigation reading still works when the verb is navigation.
  assert.equal(parseUtterance('go to tab one', C).actions[0].kind, 'focus_tab')
  assert.equal(parseUtterance('switch to tab 2', C).actions[0].kind, 'focus_tab')
})

await test('closing by number, ordinal and name, for tabs and for panes', () => {
  const cases = [
    ['close tab 2', 'close_tab', 'tab 2'],
    ['close the second tab', 'close_tab', 'tab second'],
    ['close the last tab', 'close_tab', 'tab last'],
    ['kill terminal 3', 'close_tab', 'terminal 3'],
    ['close pane two', 'close_pane', 'pane two'],
    ['close this pane', 'close_pane', 'focused'],
    ['close the tab', 'close_tab', 'current']
  ]
  for (const [said, kind, which] of cases) {
    const hit = parseUtterance(said, C)
    assert.ok(hit, said)
    assert.equal(hit.actions[0].kind, kind, said)
    assert.equal(hit.actions[0].which, which, said)
  }
  // Resolution: "tab second" and "the last tab" land on real tabs.
  assert.equal(runAppAction({ kind: 'close_tab', which: 'tab second' }, ctx(), fullRunner()).summary, 'Closed “notes”')
  assert.equal(runAppAction({ kind: 'close_tab', which: 'tab last' }, ctx(), fullRunner()).summary, 'Closed “notes”')
  assert.equal(runAppAction({ kind: 'close_tab', which: 'notes' }, ctx(), fullRunner()).summary, 'Closed “notes”')
  assert.match(runAppAction({ kind: 'close_tab', which: 'tab 9' }, ctx(), fullRunner()).summary, /No tab called/)
})

await test('bulk close counts down first, and only for more than one', async () => {
  const three = [
    { id: 'a', title: 'one' },
    { id: 'b', title: 'two' },
    { id: 'c', title: 'three' }
  ]
  const hit = parseUtterance('close all three tabs', C)
  assert.equal(hit.actions[0].kind, 'close_tabs')
  assert.equal(hit.actions[0].which, 'all')

  const run = fullRunner()
  const out = runAppAction(hit.actions[0], ctx({ tabs: three, activeTabId: 'a' }), run)
  // Provisional, and honest that nothing has happened yet.
  assert.equal(out.done, 0)
  assert.match(out.summary, /Closing 3 tabs \(every tab\)… say “wait” to stop/)
  const settled = await out.pending
  assert.equal(settled.done, 3)
  assert.deepEqual(run.calls, [['closeMany', 'a,b,c', 'every tab']])

  // One tab needs no ceremony.
  const single = fullRunner()
  const one = runAppAction({ kind: 'close_tabs', which: 'all' }, ctx({ tabs: [three[0]], activeTabId: 'a' }), single)
  assert.equal(one.done, 1)
  assert.equal(one.pending, undefined)
  assert.deepEqual(single.calls, [['closeTab', 'a']])
})

await test('“close everything” and “close the kimi ones”', async () => {
  assert.equal(parseUtterance('close everything', C).actions[0].which, 'all')
  assert.equal(parseUtterance('close all the tabs', C).actions[0].which, 'all')
  assert.equal(parseUtterance('close the other tabs', C).actions[0].which, 'others')
  assert.equal(parseUtterance('close the kimi ones', C).actions[0].which, 'kimi')

  // "the kimi ones" only closes tabs that are running Kimi.
  const panes = [
    pane({ paneId: 'a', tabId: 't1', number: 1, profileId: 'kimi', profileName: 'Kimi', agent: true }),
    pane({ paneId: 'b', tabId: 't2', number: 2, profileId: 'claude', profileName: 'Claude Code', agent: true })
  ]
  const run = fullRunner()
  const out = runAppAction({ kind: 'close_tabs', which: 'kimi' }, ctx({ panes }), run)
  assert.equal(out.done, 1)
  assert.deepEqual(run.calls, [['closeTab', 't1']])
  // And says so rather than closing the lot when nothing matches.
  assert.match(
    runAppAction({ kind: 'close_tabs', which: 'gemini' }, ctx({ panes }), fullRunner()).summary,
    /No tabs are running/
  )
})

await test('Steve’s exact project sentence creates the folder and opens it', async () => {
  const said = 'Open up a new project called Tester Tester. Put the project file on the desktop and then open it in the projects pane'
  const hit = parseUtterance(said, C)
  assert.ok(hit, 'the sentence did not parse')
  assert.equal(hit.actions[0].kind, 'create_project')
  assert.equal(hit.actions[0].name, 'Tester Tester', 'the name must survive with its capitals')
  assert.equal(hit.actions[0].parentDir, 'desktop')

  const run = fullRunner()
  const out = runAppAction(hit.actions[0], ctx(), run)
  assert.match(out.summary, /Creating “Tester Tester”/)
  await out.pending
  assert.deepEqual(run.calls, [['createProject', 'Tester Tester', 'desktop']])

  // Shorter forms too, and a nameless one still falls back to the hint.
  assert.equal(parseUtterance('create a new project called roma', C).actions[0].name, 'roma')
  assert.equal(parseUtterance('make a new project named tester in documents', C).actions[0].parentDir, 'documents')
  assert.equal(parseUtterance('add a new project', C).actions[0].kind, 'new_project_hint')
})

await test('rename, view mode and settings are real actions now, not excuses', () => {
  const run = fullRunner()
  assert.equal(runAppAction({ kind: 'rename_tab', which: 'tab 2', name: 'docs' }, ctx(), run).ok, true)
  assert.deepEqual(run.calls.at(-1), ['renameTab', 't2', 'docs'])
  runAppAction({ kind: 'set_view', mode: 'mosaic' }, ctx(), run)
  assert.deepEqual(run.calls.at(-1), ['setViewMode', 'mosaic'])
  runAppAction({ kind: 'open_settings', section: 'voice' }, ctx(), run)
  assert.deepEqual(run.calls.at(-1), ['openSettings', 'voice'])
  // A runner that cannot do them refuses honestly.
  assert.equal(runAppAction({ kind: 'set_view', mode: 'tabs' }, ctx(), fakeRunner()).ok, false)
})

await test('the new kinds survive sanitising, and junk in them does not', () => {
  assert.deepEqual(sanitiseActions([{ kind: 'close_tab', which: 'tab 1' }]), [{ kind: 'close_tab', which: 'tab 1' }])
  // The old literal shape still means what it used to.
  assert.deepEqual(sanitiseActions([{ kind: 'close_tab' }]), [{ kind: 'close_tab', which: 'current' }])
  assert.deepEqual(sanitiseActions([{ kind: 'close_pane' }]), [{ kind: 'close_pane', which: 'focused' }])
  assert.deepEqual(sanitiseActions([{ kind: 'close_tabs' }]), [{ kind: 'close_tabs', which: 'all' }])
  assert.deepEqual(sanitiseActions([{ kind: 'create_project', name: 'x', parentDir: 'desktop' }]), [
    { kind: 'create_project', name: 'x', parentDir: 'desktop' }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'create_project' }]), [], 'a nameless project is nothing')
  assert.deepEqual(sanitiseActions([{ kind: 'set_view', mode: 'sideways' }]), [], 'invented view modes are dropped')
  assert.deepEqual(sanitiseActions([{ kind: 'open_settings', section: 'nonsense' }]), [{ kind: 'open_settings' }])
  assert.deepEqual(sanitiseActions([{ kind: 'rename_tab', which: 'tab 1' }]), [], 'a rename needs a name')
})

await test('a spoken folder name cannot escape the folders Forge may write to', () => {
  const roots = [
    { key: 'desktop', path: 'C:\\Users\\steve\\Desktop' },
    { key: 'documents', path: 'C:\\Users\\steve\\Documents' }
  ]
  const plan = (name, parentDir) => planProjectFolder({ name, parentDir, roots })

  const good = plan('Tester Tester', 'desktop')
  assert.equal(good.ok, true)
  assert.equal(good.path, 'C:\\Users\\steve\\Desktop\\Tester Tester')
  assert.equal(good.leaf, 'Tester Tester')
  assert.equal(plan('roma', 'documents').path, 'C:\\Users\\steve\\Documents\\roma')
  // No parent named: the first root, which is Desktop unless one is configured.
  assert.equal(plan('roma').path, 'C:\\Users\\steve\\Desktop\\roma')

  // Traversal, absolute paths and separators are all just *words* by the time
  // they get here — neutralised into one flat leaf rather than refused, so
  // whatever he says, the result is still a folder inside an allowed root.
  for (const nasty of [
    '..\\..\\Windows\\System32',
    '../../etc/passwd',
    'C:\\Windows',
    '\\\\server\\share',
    'a/b/c'
  ]) {
    const out = plan(nasty)
    assert.equal(out.ok, true, nasty)
    assert.ok(out.path.startsWith('C:\\Users\\steve\\Desktop\\'), `${nasty} escaped to ${out.path}`)
    assert.ok(!out.leaf.includes('\\') && !out.leaf.includes('/'), `${nasty} kept a separator`)
  }
  assert.equal(sanitiseFolderName('..\\..\\Windows'), 'Windows')
  assert.equal(sanitiseFolderName('a/b/c'), 'a b c')
  assert.equal(sanitiseFolderName('  ...  '), '')

  // Windows' own landmines.
  assert.match(plan('NUL').error, /will not allow/)
  assert.match(plan('com1').error, /will not allow/)
  assert.match(plan('   ').error, /No name given/)
  assert.match(plan('x'.repeat(80)).error, /too long/)

  // A configured projects folder becomes the default and is allowed.
  const withRoot = [{ key: 'projectsroot', path: 'D:\\code' }, ...roots]
  assert.equal(planProjectFolder({ name: 'roma', roots: withRoot }).path, 'D:\\code\\roma')
  assert.equal(planProjectFolder({ name: 'roma', parentDir: 'desktop', roots: withRoot }).path,
    'C:\\Users\\steve\\Desktop\\roma')
})

/* ------------------------------------------------------------- speaking */

console.log('\nSpeaking back (TTS)')

await test('the default voice is never the robotic male one', () => {
  // Exactly what Electron's renderer exposes on Steve's PC, `default` and all.
  // Windows marks George as the default, and George is the voice he called
  // "awful" — so `default` must count for nothing here.
  const HIS_MACHINE = [
    { name: 'Microsoft George - English (United Kingdom)', lang: 'en-GB', default: true },
    { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB' },
    { name: 'Microsoft Susan - English (United Kingdom)', lang: 'en-GB' }
  ]
  assert.equal(chooseVoice(HIS_MACHINE).name, 'Microsoft Hazel - English (United Kingdom)')
  assert.ok(!/George|David|Mark/.test(chooseVoice(HIS_MACHINE).name))

  // A neural voice, where one exists, beats every legacy voice.
  const withNeural = [...HIS_MACHINE, { name: 'Microsoft Sonia Online (Natural) - English (UK)', lang: 'en-GB' }]
  assert.match(chooseVoice(withNeural).name, /Natural/)

  // David is the US default and must lose to Zira for the same reason.
  const usa = [
    { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US', default: true },
    { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US' }
  ]
  assert.match(chooseVoice(usa).name, /Zira/)

  // An explicit choice always wins, even a male one — it is his ear.
  assert.match(chooseVoice(HIS_MACHINE, 'Microsoft George - English (United Kingdom)').name, /George/)
  // A saved name that is no longer installed falls back rather than failing.
  assert.match(chooseVoice(HIS_MACHINE, 'Microsoft Gone').name, /Hazel/)
  // No English at all: take what there is rather than staying silent.
  assert.equal(chooseVoice([{ name: 'Hortense', lang: 'fr-FR' }]).name, 'Hortense')
  assert.equal(chooseVoice([]), null)
})

await test('a turn is spoken exactly once, however often it re-renders', async () => {
  // The bug Steve heard as "he keeps going on and on, over and over again".
  // A React component re-renders freely; anything that speaks from a render
  // path speaks twice. Speaking is therefore keyed by turn id.
  const spoken = []
  let queuedAtSpeak = []
  global.window = {
    speechSynthesis: {
      speak(u) {
        spoken.push(u.text)
        queuedAtSpeak.push(spk.pending)
        window.setTimeout(() => u.onend?.(), 0)
      },
      cancel() {},
      getVoices: () => [{ name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB' }]
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
  }
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
    }
  }
  const { speaker: spk } = await import('../src/lib/speech.ts?once')

  await spk.speakOnce('turn_1', 'Three Claude Code tabs open.')
  await spk.speakOnce('turn_1', 'Three Claude Code tabs open.')
  await spk.speakOnce('turn_1', 'Three Claude Code tabs open.')
  assert.deepEqual(spoken, ['Three Claude Code tabs open.'], 'one turn, one utterance')

  await spk.speakOnce('turn_2', 'Two Kimi tabs open.')
  assert.equal(spoken.length, 2)
  // The queue is never a queue: nothing is ever waiting behind something else.
  assert.ok(
    queuedAtSpeak.every((n) => n <= 1),
    `queue reached ${Math.max(...queuedAtSpeak)}`
  )
  assert.equal(spk.pending, 0)

  delete global.window
  delete global.SpeechSynthesisUtterance
})

await test('a reply that claims to have acted, but did not, is contradicted', () => {
  // Seen live from gemini-2.5-flash: "Opening three Claude Code terminals for
  // you." with an empty actions array. With no actions there are no chips, so
  // without this the untruth is the only thing on screen.
  for (const claim of [
    'Opening three Claude Code terminals for you.',
    'Opened 3 tabs.',
    'Closing the tab now.',
    'Created the project and switched to it.',
    'Sending that to terminal two.'
  ]) {
    assert.equal(claimsCompletedAction(claim), true, claim)
  }
  // Offers, questions and plain talk are not claims.
  for (const innocent of [
    'I can open three tabs if you like.',
    'Would you like me to open three terminals?',
    'Shall I close it?',
    'Yes, I can hear you.',
    'That is a big job — what should it do first?',
    undefined,
    ''
  ]) {
    assert.equal(claimsCompletedAction(innocent), false, String(innocent))
  }
})

await test('the phone gets the words and the draft, and is told what could not run', () => {
  // Level 2 of the Companion hookup: the phone named a project that is not
  // the one on screen. Words and brief come back; the refusal is one line,
  // and only when the reply actually wanted to do something.
  const wanting = companionReplyText(
    {
      understood: 'open three claude terminals in roma',
      say: 'Right — three of them.',
      actions: [{ kind: 'open_tabs', profileId: 'claude', count: 3 }]
    },
    'roma-2026'
  )
  assert.match(wanting, /Right — three of them\./)
  assert.match(wanting, /Switch to roma-2026 in Forge to run app actions\./)

  // A question is answered with an answer. No nagging about switching.
  const asking = companionReplyText({ understood: 'what is it', say: 'A POS for the cafe.' }, 'roma-2026')
  assert.equal(asking, 'A POS for the cafe.')

  // A drafted brief travels; it is the useful half of an answer he cannot run.
  const drafted = companionReplyText(
    { understood: 'brief it', say: 'Brief is ready.', draftPrompt: '# Goal\nBuild the till screen.' },
    'roma-2026'
  )
  assert.match(drafted, /Brief is ready\./)
  assert.match(drafted, /# Goal/)
  assert.ok(!drafted.includes('Switch to'), 'nothing was asked for, so nothing is refused')

  // Nothing but questions still says something rather than an empty bubble.
  const asked = companionReplyText({ understood: 'unclear', questions: ['Which project?'] }, 'roma-2026')
  assert.equal(asked, 'Which project?')
})

await test('Forge does not answer its own voice coming back through the mic', () => {
  // Seen live: it said "Typed into Terminal 6 Claude Code, auto-relay is off in
  // Settings", the sidecar cut the phrase once the room went quiet -- after the
  // while-speaking guard had lifted -- and the brain was asked to answer it.
  const said = 'Typed into Terminal 6 Claude Code, auto-relay is off in Settings'
  // Speech-to-text mangles spelling, not shape: "Claude Code" comes back
  // "clawed code". Words, therefore, not characters.
  assert.ok(echoOverlap('Typing into Terminal 6 clawed code, auto relay is off in settings', said) >= 0.7)
  assert.ok(echoOverlap(said, said) === 1)

  // And what he actually says is not an echo, even on the same subject.
  assert.ok(echoOverlap('open three more terminals', said) < 0.7)
  assert.ok(echoOverlap('turn auto-relay on', said) < 0.7)
  assert.ok(echoOverlap('no, terminal two', said) < 0.7)
  assert.equal(echoOverlap('', said), 0)
  assert.equal(echoOverlap('anything', ''), 0)

  // The window is short: a minute later the same sentence is his.
  assert.ok(ECHO_WINDOW_MS > 0 && ECHO_WINDOW_MS <= 10_000)
})

await test('a drafted prompt is never read aloud', () => {
  const draft = '# Goal\nBuild a landing page.\n\n```js\nconst x = 1\n```\n- one\n- two\nSee https://example.com/spec'
  const said = speakable(draft)
  assert.ok(!said.includes('```'), 'code fences must not be spoken')
  assert.ok(!said.includes('#'), 'markdown headings must not be spoken')
  assert.ok(!said.includes('https://'), 'URLs must not be read out character by character')
  assert.ok(said.includes('a link'))
  // Long replies are cut at a sentence, not mid-word.
  const long = 'One two three. '.repeat(80)
  assert.ok(speakable(long).length <= 340)
  assert.match(speakable(long), /\.$/)
  assert.equal(speakable(''), '')
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
    },
    makeVideo: async (request) => {
      base.calls.push(['makeVideo', request.description, request.aspect, request.duration])
      return result ?? { ok: true, summary: 'Made a video', requested: 1, done: 1, paths: ['C:\\a.mp4'] }
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

await test('make_video warns that it is slow before it starts', async () => {
  const run = mediaRunner()
  const out = runAppAction(
    { kind: 'make_video', description: 'a red pixel-art go-kart', aspect: '16:9', duration: 4 },
    ctx(),
    run
  )
  // Synchronous half: honest that nothing exists yet, and that this one is a
  // wait rather than a blink — that warning is the whole point of the chip.
  assert.equal(out.ok, true)
  assert.equal(out.done, 0)
  assert.equal(out.requested, 1)
  assert.match(out.summary, /Rendering video…/)
  assert.match(out.summary, /couple of minutes/)
  assert.ok(out.pending instanceof Promise)
  assert.deepEqual(run.calls, [['makeVideo', 'a red pixel-art go-kart', '16:9', 4]])

  // Asynchronous half: exactly one real outcome replaces it.
  const settled = await out.pending
  assert.equal(settled.done, 1)
  assert.deepEqual(settled.paths, ['C:\\a.mp4'])
})

await test('make_video refuses what Veo would refuse, before spending anything', () => {
  const empty = runAppAction({ kind: 'make_video', description: '   ' }, ctx(), mediaRunner())
  assert.equal(empty.ok, false)
  assert.equal(empty.pending, undefined)
  assert.match(empty.summary, /video of nothing/)

  // The image aspect list is much longer than Veo's; a square video does not exist.
  const square = runAppAction({ kind: 'make_video', description: 'a go-kart', aspect: '1:1' }, ctx(), mediaRunner())
  assert.equal(square.ok, false)
  assert.equal(square.pending, undefined)
  assert.match(square.summary, /16:9 or 9:16/)

  for (const duration of [1, 3, 9, 60]) {
    const out = runAppAction({ kind: 'make_video', description: 'a go-kart', duration }, ctx(), mediaRunner())
    assert.equal(out.ok, false, `${duration}s should be refused`)
    assert.match(out.summary, /4–8 seconds/)
  }
  // The two Veo does take must survive.
  for (const aspect of ['16:9', '9:16']) {
    assert.equal(runAppAction({ kind: 'make_video', description: 'a go-kart', aspect }, ctx(), mediaRunner()).ok, true)
  }
})

await test('a runner with no video support refuses instead of pretending', () => {
  const out = runAppAction({ kind: 'make_video', description: 'a go-kart' }, ctx(), fakeRunner())
  assert.equal(out.ok, false)
  assert.equal(out.done, 0)
  assert.equal(out.pending, undefined)
  assert.match(out.summary, /not available/)
})

await test('a video failure comes back as a failed outcome, not a throw', async () => {
  const run = mediaRunner({
    ok: false,
    summary: 'Video generation is a paid-only Google feature and this key is not billed (400)',
    requested: 1,
    done: 0
  })
  const out = runAppAction({ kind: 'make_video', description: 'a go-kart' }, ctx(), run)
  const settled = await out.pending
  assert.equal(settled.ok, false)
  assert.equal(settled.done, 0)
  assert.match(settled.summary, /paid-only/)
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

/**
 * The SKILLS roster, sized like the real one.
 *
 * Steve has ten skills in ~/.claude/skills and Forge now lists all of them
 * alongside its own library, so the manifest carries a roster from the moment
 * he opens the app — a snapshot with an empty `skills` would measure a manifest
 * nobody ever sends. The descriptions here are the real ones, and they are the
 * point: a skill's frontmatter is written for the agent about to *read* it and
 * runs to a paragraph, so `skillBlurb` cuts each one back to a sentence before
 * it goes anywhere near the wire.
 */
const SKILLS = [
  {
    name: 'adhd',
    enabled: true,
    description:
      'Parallel divergent ideation for coding agents. Spawns N isolated branches under different cognitive frames ' +
      '(regulator, biology, speedrunner, 10-year-old, $0 budget), scores, clusters, prunes traps, and deepens top ' +
      'survivors. Use on /adhd, "ADHD mode", brainstorm/ideate intents, or open-ended design decisions.'
  },
  {
    name: 'apple-design',
    enabled: true,
    description:
      "Build interfaces with Apple's actual design language - the real easing curves, durations, stagger timings, " +
      'colour ramps, type tracking and scroll-reveal patterns measured directly from apple.com production CSS. Use ' +
      'when the user wants something to feel "like Apple", premium, glassy or cinematic.'
  },
  {
    name: 'fable-5',
    enabled: true,
    description:
      'Build distinctive, gallery-grade front-end UI — hero sections, landing pages, portfolios, design-system ' +
      'showcases, shaders, animated/interactive components, and 3D/WebGL scenes — using the design protocol and ' +
      'motion-pattern library distilled from the claude-directory gallery of ~550 UI experiments.'
  },
  { name: 'fable-judge', enabled: true, description: 'Adversarial verification of finished work.' },
  {
    name: 'fable-loop',
    enabled: true,
    description:
      'End-to-end orchestrated workflow that runs a task the way Fable ran sessions - parallel evidence subagents, ' +
      'one committed plan, surgical execution, verification by observation.'
  },
  {
    name: 'fable-method',
    enabled: true,
    description:
      'A step-by-step problem-solving loop (classify the ask, define done, gather evidence, decide, act surgically, ' +
      'verify by observation, report outcome-first).'
  },
  {
    name: 'front-end-design',
    enabled: true,
    description: 'Front-end design guidance, best practices, and modern web development patterns'
  },
  {
    name: 'gaffer',
    enabled: true,
    description:
      'Delegation harness. Opus 5 acts as the gaffer — understands the request, reads the codebase, writes detailed ' +
      'job briefs, judges the results — then delegates implementation to a crew of specialist agents.'
  },
  {
    name: 'huashu-design',
    enabled: true,
    description:
      '花叔Design（Huashu-Design）——用HTML做高保真原型、交互Demo、幻灯片、动画、设计变体探索+设计方向顾问+专家评审的一体化设计能力。' +
      'HTML是工具不是媒介，根据任务embody不同专家（UX设计师/动画师/幻灯片设计师/原型师），避免web design tropes。'
  },
  {
    name: 'remotion-best-practices',
    enabled: true,
    description: 'Best practices for Remotion - Video creation in React'
  },
  { name: 'release-checklist', enabled: false, description: 'What to do before Forge ships a build.' }
]

const SNAPSHOT = {
  appVersion: '0.1.0',
  skills: SKILLS,
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
      panes: [{ number: 1, title: 'PowerShell', profileName: 'PowerShell', status: 'live', focused: true, agent: false }]
    },
    {
      number: 2,
      title: 'notes',
      active: false,
      panes: [
        { number: 2, title: 'Claude Code', profileName: 'Claude Code', status: 'live', focused: false, agent: true },
        { number: 3, title: 'docs', profileName: 'Claude Code', status: 'live', focused: false, agent: true }
      ]
    }
  ],
  paneCount: 3,
  maxSessions: 16,
  maxPanesPerTab: 8,
  view: { railCollapsed: false, voiceHub: 'docked', terminalFontSize: 13, shell: 'pwsh.exe' }
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
  // Small enough to send every turn — about 2.4k tokens. It grew when
  // send_prompt, the COUNTS rules and the closing/creating actions landed,
  // again for the two lines that tell the model its per-project memory is real,
  // again for make_video (which has to warn that a clip takes minutes), again
  // for the SKILLS roster and use_skill — a skill the model is never told about
  // is a skill it will never reach for — and last for the VOICE rules, which
  // are the half of "it sounds robotic" that no speech model fixes, because a
  // neural voice reading "Ready for your next instruction." is still a machine
  // reading a card. Each one earns its room, but the ceiling still has to bite,
  // because this goes up the wire on every single thing Steve says.
  //
  // Raised from 11400 to 12800 when the rail started listing Steve's own
  // ~/.claude/skills beside Forge's library: the roster went from empty to
  // eleven names and it is never empty again, which is ~1.3k the old number had
  // no room for. The prose itself did not grow — it is ~11.0k either side. The
  // roster is already clamped by skillBlurb (a sentence per skill, not the
  // paragraph the frontmatter carries), so when this fires again the first
  // question is which prose grew, and the second is whether SKILL_BLURB_MAX
  // should tighten. Moving the number is the last answer, not the first.
  assert.ok(text.length < 12800, `manifest is ${text.length} chars`)
})

await test('the SKILLS roster names every skill, and never carries a whole paragraph', () => {
  const text = buildManifest(SNAPSHOT)
  const roster = text
    .slice(text.indexOf('# SKILLS'))
    .split('\n# ')[0]
    .split('\n')
    .filter((l) => l.startsWith('- '))

  assert.equal(roster.length, SKILLS.length, 'every skill is listed — one the model is not told about is one it cannot use')
  for (const skill of SKILLS) {
    assert.ok(
      roster.some((l) => l.startsWith(`- ${skill.name}`)),
      `missing ${skill.name}`
    )
  }
  // A library skill that is switched off still gets named — the model may say
  // so — but it is marked, because typing it would not load anything.
  assert.ok(roster.some((l) => l.includes('release-checklist [off]')), 'a disabled skill is marked')
  assert.ok(!roster.some((l) => l.includes('gaffer [off]')), 'and an enabled one is not')

  // The clamp. huashu-design's real description is 1.3k characters on its own.
  for (const line of roster) {
    assert.ok(line.length < 180, `roster line is ${line.length} chars: ${line.slice(0, 60)}…`)
  }
})

await test('the manifest gives every pane the spoken handle Steve uses', () => {
  const text = buildManifest(SNAPSHOT)
  // The numbering runs across tabs, in tab then pane order — the same walk the
  // executor's ActionPane list uses, which is what makes "terminal two" mean
  // one thing to him, to the model and to the code.
  assert.ok(text.includes('Terminal 1 — "PowerShell"'), 'pane 1 has no handle')
  assert.ok(text.includes('Terminal 2 — "Claude Code"'), 'pane 2 has no handle')
  assert.ok(text.includes('Terminal 3 — "docs"'), 'pane 3 has no handle')
  assert.match(text, /Terminal 1 — "PowerShell" \(PowerShell, live, plain shell[^)]*, FOCUSED\)/)
  assert.match(text, /These Terminal numbers are what he says out loud/)
  // And the model is told how to use them.
  assert.ok(text.includes('# DISPATCHING TO A TERMINAL'))
  assert.ok(text.includes('send_prompt'))
})

await test('the manifest spells out the counts rule that the repro broke on', () => {
  const text = buildManifest(SNAPSHOT)
  assert.ok(text.includes('# COUNTS'))
  assert.match(text, /ONE action with count N\. Never N actions with count 1\./)
  assert.ok(text.includes('"count":3'), 'show the model the exact shape')
})

await test('the manifest offers the media actions and names the bridge tools', () => {
  const text = buildManifest(SNAPSHOT)
  assert.ok(text.includes('make_image'), 'make_image must be offered')
  assert.ok(text.includes('edit_image'), 'edit_image must be offered')
  assert.ok(text.includes('make_video'), 'make_video must be offered')
  assert.ok(text.includes('assets/generated'), 'say where the files land')
  // The drafted prompt has to tell the coding agent what it can reach for.
  assert.ok(text.includes('# TOOLS THE CODING AGENT HAS'))
  for (const tool of ['make_image', 'edit_image', 'make_video', 'ask_gemini', 'summarize_video']) {
    assert.ok(text.includes(tool), `TOOLS section must name ${tool}`)
  }
  assert.match(text, /never claim the agent has any tool that is not on that list/i)
})

await test('the manifest is honest about how slow make_video is', () => {
  const text = buildManifest(SNAPSHOT)
  // A model that thinks video is as quick as an image will queue several and
  // then narrate a wait it never warned about, so the cost has to be stated in
  // both places the model reads: the action list and the coding-agent tools.
  const spec = ACTION_SPECS.find((s) => s.kind === 'make_video')
  assert.ok(spec, 'make_video must be in ACTION_SPECS')
  assert.match(spec.what, /1–3 minutes/, 'the action spec must state the cost')
  assert.match(spec.args, /make_video/)
  assert.match(text, /1–3 minutes/)
  // And the limits Veo actually enforces, so it does not ask for a square 30s clip.
  assert.match(text, /4–8/, 'the clip-length limit must be stated')
  assert.match(text, /9:16/, 'the two aspect ratios must be stated')
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

  // make_video is real now. Description is the only required field; the two
  // optional ones are dropped or clamped rather than passed on to be refused.
  assert.deepEqual(sanitiseActions([{ kind: 'make_video', description: 'a red go-kart' }]), [
    { kind: 'make_video', description: 'a red go-kart' }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'make_video', description: 'a go-kart', aspect: '9:16', duration: 6 }]), [
    { kind: 'make_video', description: 'a go-kart', aspect: '9:16', duration: 6 }
  ])
  assert.deepEqual(sanitiseActions([{ kind: 'make_video' }]), [], 'description is required')
  assert.deepEqual(sanitiseActions([{ kind: 'make_video', description: '  ' }]), [])
  // An aspect Veo does not take is dropped, not forwarded: the default beats a
  // guaranteed 400.
  assert.equal(sanitiseActions([{ kind: 'make_video', description: 'x', aspect: '1:1' }])[0].aspect, undefined)
  assert.equal(sanitiseActions([{ kind: 'make_video', description: 'x', aspect: '21:9' }])[0].aspect, undefined)
  // Duration is clamped into Veo's 4-8s window.
  assert.equal(sanitiseActions([{ kind: 'make_video', description: 'x', duration: 99 }])[0].duration, 8)
  assert.equal(sanitiseActions([{ kind: 'make_video', description: 'x', duration: 1 }])[0].duration, 4)
  assert.equal(sanitiseActions([{ kind: 'make_video', description: 'x', duration: 'six' }])[0].duration, undefined)

  // Still no back door for kinds nobody implements.
  assert.deepEqual(sanitiseActions([{ kind: 'make_hologram', description: 'a red car' }]), [])
})

await test('salvage names whichever brain was cut off', () => {
  const truncated = '{"understood":"a car game","confidence":"high","draftPrompt":"# Goal\\nBuild a top'
  assert.match(salvagePartialJson(truncated).say, /^Gemini hit its length limit/)
  assert.match(salvagePartialJson(truncated, 'OpenRouter').say, /^OpenRouter hit its length limit/)
  assert.equal(salvagePartialJson('{}', 'OpenRouter'), null)
})

await test('the response schema describes every field an action can carry', () => {
  const props = RESPONSE_SCHEMA.properties.actions.items.properties
  for (const field of ['kind', 'profileId', 'count', 'description', 'aspect', 'duration', 'path', 'instruction']) {
    assert.ok(props[field], `responseSchema is missing ${field}`)
  }
  // Without this the model cannot ask for a clip length at all: a field absent
  // from responseSchema is a field Gemini is structurally unable to emit.
  assert.equal(props.duration.type, 'INTEGER', 'make_video duration must be an integer')
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
  // Same ceiling as the manifest check above, and for the same reason.
  assert.ok(text.length < 12800, `manifest is ${text.length} chars`)
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

/* ----------------------------------------------------- neural speech (M10)
 *
 * Steve's verdict on the first version of talking back: "honestly, the voice
 * agent is just garbage. It sounds robotic. 'Ready for your next instruction.'
 * You've got to fix that."
 *
 * Two separate faults, so two separate groups of checks below. The synthesiser
 * is now a Gemini TTS model (`electron/gemini-tts.ts`), driven here against a
 * fake `fetch` so the exact wire shape is pinned without spending a request.
 * The *writing* is fixed by the VOICE rules in the manifest, and by a grep that
 * fails if a canned sign-off is ever hard-coded again.
 */

console.log('\nNeural speech — the request')

const ttsModule = await import('../electron/gemini-tts.ts')
const { speak: ttsSpeak, parsePcmMime, trimLeadingSilence, ttsVoice, ttsModel } = ttsModule
const sharedTts = await import('../shared/tts.ts')

/**
 * 24 kHz mono PCM: `seconds` of a quiet tone, after `silence` seconds of
 * nothing. A cosine rather than a sine so the very first audible sample is at
 * full amplitude — with a sine it is zero, and the trim test would be arguing
 * about one frame of nothing.
 */
function fakePcm(seconds = 0.5, silence = 0) {
  const rate = 24_000
  const frames = Math.round(rate * (seconds + silence))
  const buf = Buffer.alloc(frames * 2)
  for (let i = Math.round(rate * silence); i < frames; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.cos((i / rate) * 2 * Math.PI * 220)), i * 2)
  }
  return buf
}

/**
 * Stand in for the network. Each reply is `{ status, body }` or a function;
 * every request is recorded so the shape can be asserted rather than assumed.
 */
function fakeFetch(replies) {
  const calls = []
  const queue = [...replies]
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), headers: init.headers, body, signal: init.signal })
    const next = queue.shift() ?? { status: 200, body: audioReply(fakePcm()) }
    const reply = typeof next === 'function' ? next(calls.length) : next
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: 'x',
      text: async () => JSON.stringify(reply.body)
    }
  }
  return calls
}

function audioReply(pcm, mime = 'audio/l16; rate=24000; channels=1') {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data: pcm.toString('base64') } }] }, finishReason: 'STOP' }] }
}

const realFetch = globalThis.fetch

await test('the request is the shape the API actually accepts', async () => {
  // Verified live on 2026-07-30. The array form printed on ai.google.dev
  // ("speechConfig": [{ "voice": "Kore" }]) is a 400 — "Proto field is not
  // repeating, cannot start list" — so this nested shape is not a preference,
  // it is the only one that works.
  const calls = fakeFetch([{ status: 200, body: audioReply(fakePcm()) }])
  const r = await ttsSpeak({ key: 'k-123', text: 'Opened three Claude Code tabs.', voice: 'Sulafat' })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-3\.1-flash-tts-preview:generateContent$/)
  assert.equal(calls[0].headers['x-goog-api-key'], 'k-123')
  assert.deepEqual(calls[0].body, {
    contents: [{ parts: [{ text: 'Opened three Claude Code tabs.' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } } }
    }
  })
  // The key is never in the URL — a key in a URL ends up in a log.
  assert.ok(!calls[0].url.includes('k-123'))
})

await test('both spellings of the PCM mime type parse, and anything else is 24k mono', () => {
  // These are the two real ones, one per model generation, seen live.
  assert.deepEqual(parsePcmMime('audio/l16; rate=24000; channels=1'), { sampleRate: 24_000, channels: 1 })
  assert.deepEqual(parsePcmMime('audio/L16;codec=pcm;rate=24000'), { sampleRate: 24_000, channels: 1 })
  assert.deepEqual(parsePcmMime('audio/l16; rate=48000; channels=2'), { sampleRate: 48_000, channels: 2 })
  // Nonsense must not produce a chipmunk: fall back to what every model sends.
  assert.deepEqual(parsePcmMime(''), { sampleRate: 24_000, channels: 1 })
  assert.deepEqual(parsePcmMime('audio/l16; rate=3'), { sampleRate: 24_000, channels: 1 })
})

await test('leading digital silence is trimmed, and pure silence is left alone', () => {
  // gemini-3.1-flash-tts-preview opens with a run of exact-zero samples. That
  // is dead air between him finishing and hearing an answer, and it is free to
  // remove because the samples are literally zero.
  const withGap = fakePcm(0.4, 0.5)
  const trimmed = trimLeadingSilence(withGap, 1)
  assert.ok(trimmed.trimmed > 0, 'the silence should have been found')
  // 240 frames of run-up are kept, so the first consonant is not on a cliff.
  assert.equal(trimmed.trimmed, Math.round(24_000 * 0.5) - 240)
  assert.equal(trimmed.audio.length, withGap.length - trimmed.trimmed * 2)

  // Audio that starts immediately is returned untouched.
  const noGap = fakePcm(0.4, 0)
  assert.equal(trimLeadingSilence(noGap, 1).trimmed, 0)

  // All silence is a bug upstream; returning nothing would look like success.
  const silent = Buffer.alloc(4800)
  assert.equal(trimLeadingSilence(silent, 1).trimmed, 0)
  assert.equal(trimLeadingSilence(silent, 1).audio.length, 4800)
})

await test('an unknown voice or model never reaches the wire', () => {
  // An unknown voice name comes back as a 404 "Requested entity was not found",
  // which is indistinguishable from a missing model — so it is caught here
  // instead of costing a round trip and a confusing error.
  assert.equal(ttsVoice('Sulafat'), 'Sulafat')
  assert.equal(ttsVoice('NotARealVoice'), sharedTts.DEFAULT_TTS_VOICE)
  assert.equal(ttsVoice(''), sharedTts.DEFAULT_TTS_VOICE)
  assert.equal(ttsVoice(undefined), sharedTts.DEFAULT_TTS_VOICE)
  assert.equal(ttsModel(''), sharedTts.DEFAULT_TTS_MODEL)
  assert.equal(ttsModel('gemini-2.5-flash-preview-tts'), 'gemini-2.5-flash-preview-tts')
  assert.equal(ttsModel('../../etc/passwd'), sharedTts.DEFAULT_TTS_MODEL)
})

await test('the voice catalogue is one list, and the default is the warm one', () => {
  assert.equal(sharedTts.TTS_VOICES.length, 30)
  assert.equal(sharedTts.DEFAULT_TTS_VOICE, 'Sulafat')
  // The default was not a hunch: it is the only voice Google describes as warm,
  // and warm is the exact opposite of "it sounds robotic".
  const warm = sharedTts.TTS_VOICES.filter((v) => v.character === 'Warm')
  assert.deepEqual(warm.map((v) => v.name), ['Sulafat'])
  assert.ok(sharedTts.isTtsVoice('Kore') && !sharedTts.isTtsVoice('Kore '.repeat(4)))
  // The fallback model must be a real one, and not the default.
  assert.ok(sharedTts.isTtsModel(sharedTts.FALLBACK_TTS_MODEL))
  assert.notEqual(sharedTts.FALLBACK_TTS_MODEL, sharedTts.DEFAULT_TTS_MODEL)
})

await test('out of quota on one model, the other one says it', async () => {
  // Not belt-and-braces: on a free AI Studio key the 3.1 preview 429s after
  // roughly six sentences a minute, and its bucket is not the 2.5 bucket.
  // Measured live — thirteen requests in a minute was enough to trip it.
  const calls = fakeFetch([
    { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } } },
    { status: 200, body: audioReply(fakePcm()) }
  ])
  const r = await ttsSpeak({ key: 'k', text: 'Opened three Claude Code tabs.' })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /gemini-3\.1-flash-tts-preview/)
  assert.match(calls[1].url, /gemini-2\.5-flash-preview-tts/)
  assert.equal(r.model, sharedTts.FALLBACK_TTS_MODEL)
  assert.match(r.note, /unavailable \(quota\)/)
})

await test('a bad key is not retried on a second model — it would fail identically', async () => {
  const calls = fakeFetch([{ status: 403, body: { error: { message: 'API key not valid' } } }])
  const r = await ttsSpeak({ key: 'k', text: 'hello' })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'auth')
  assert.equal(calls.length, 1, 'one failure, one request')
})

await test('no key, empty text and a novel are all refused before the network', async () => {
  const calls = fakeFetch([])
  assert.equal((await ttsSpeak({ key: '', text: 'hi' })).kind, 'no-key')
  assert.equal((await ttsSpeak({ key: 'k', text: '   ' })).kind, 'bad-input')
  assert.equal((await ttsSpeak({ key: 'k', text: 'x'.repeat(2000) })).kind, 'bad-input')
  assert.equal(calls.length, 0, 'nothing reached the wire')
})

await test('a reply with no audio part is a failure, not silence pretending to be success', async () => {
  fakeFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'I would rather not' }] }, finishReason: 'STOP' }] } }])
  const r = await ttsSpeak({ key: 'k', text: 'hello' })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'no-audio')
})

await test('barge-in before the request goes out costs nothing', async () => {
  const calls = fakeFetch([])
  const controller = new AbortController()
  controller.abort()
  const r = await ttsSpeak({ key: 'k', text: 'hello', signal: controller.signal })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'cancelled')
  assert.equal(calls.length, 0)
})

globalThis.fetch = realFetch

/* ------------------------------------------------------- the engine chain */

console.log('\nNeural speech — the engine chain')

const {
  voiceSpeaker,
  setTtsBackend,
  chooseEngine,
  stripFiller,
  pickVaried,
  ttsCacheKey,
  LruCache,
  base64ToPcm,
  pcmToFloat32
} = await import('../src/lib/tts.ts')

/** A backend that never touches IPC or an audio device. */
function fakeTts(reply = () => ({ ok: true, audio: fakePcm(0.2).toString('base64'), mime: 'audio/l16; rate=24000; channels=1', sampleRate: 24_000, channels: 1, model: 'm', voice: 'Sulafat', ms: 12 })) {
  const calls = { speak: [], cancel: [], play: [] }
  let release = null
  return {
    calls,
    /** Let a request that was deliberately held finish. */
    finish: () => release?.(),
    hold: false,
    backend: {
      speak: async (req) => {
        calls.speak.push(req)
        if (fake.hold) await new Promise((r) => (release = r))
        return reply(req, calls.speak.length)
      },
      cancelSpeak: async (id) => {
        calls.cancel.push(id)
        return true
      },
      play: (pcm, rate, channels) => {
        calls.play.push({ frames: pcm.length, rate, channels })
        return { done: Promise.resolve(), stop: () => calls.play.push('stopped') }
      }
    }
  }
}
let fake = fakeTts()

/** Windows, as far as speech.ts is concerned — so the local leg can be driven. */
function withSpeechSynthesis() {
  const said = []
  global.window = {
    speechSynthesis: {
      speak(u) {
        said.push(u.text)
        setTimeout(() => u.onend?.(), 0)
      },
      cancel() {},
      getVoices: () => [{ name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB' }]
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
  }
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
    }
  }
  return said
}

const GEMINI = { engine: 'gemini', hasKey: true, geminiVoice: 'Sulafat', ttsModel: '', localVoice: '' }

await test('the engine is chosen by settings AND by whether a key exists', () => {
  assert.equal(chooseEngine(GEMINI), 'gemini')
  // No key is not a failure to report later — it is a different engine now.
  assert.equal(chooseEngine({ ...GEMINI, hasKey: false }), 'local')
  // An explicit choice of the local voice is honoured even with a key.
  assert.equal(chooseEngine({ ...GEMINI, engine: 'local' }), 'local')
})

await test('with a key, the neural engine speaks and the audio reaches the device', async () => {
  fake = fakeTts()
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()
  const r = await voiceSpeaker.speak('Opened three Claude Code tabs.', GEMINI)
  assert.equal(r.spoke, true)
  assert.equal(r.engine, 'gemini')
  assert.equal(r.cached, false)
  assert.equal(fake.calls.speak.length, 1)
  assert.equal(fake.calls.speak[0].text, 'Opened three Claude Code tabs.')
  assert.equal(fake.calls.speak[0].voice, 'Sulafat')
  assert.equal(fake.calls.play.length, 1)
  assert.equal(fake.calls.play[0].rate, 24_000)
  assert.ok(fake.calls.play[0].frames > 0, 'silence is not speech')
})

await test('the same sentence twice is a cache hit — no second request', async () => {
  // The free-tier TTS quota is about six sentences a minute, and "Opened three
  // Claude Code tabs." is a sentence he hears twenty times a day.
  fake = fakeTts()
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()
  await voiceSpeaker.speak('Opened three Claude Code tabs.', GEMINI)
  const second = await voiceSpeaker.speak('Opened three Claude Code tabs.', GEMINI)
  assert.equal(second.cached, true)
  assert.equal(second.spoke, true)
  assert.equal(fake.calls.speak.length, 1, 'the second one must not hit the network')
  assert.equal(fake.calls.play.length, 2, 'but it must still be heard')

  // A different voice is a different sound, so it is a different key.
  await voiceSpeaker.speak('Opened three Claude Code tabs.', { ...GEMINI, geminiVoice: 'Puck' })
  assert.equal(fake.calls.speak.length, 2)
})

await test('the cache key separates voice and model, and the LRU forgets the oldest', () => {
  assert.notEqual(ttsCacheKey('hi', 'Sulafat', ''), ttsCacheKey('hi', 'Puck', ''))
  assert.notEqual(ttsCacheKey('hi', 'Sulafat', 'a'), ttsCacheKey('hi', 'Sulafat', 'b'))
  assert.equal(ttsCacheKey(' hi ', 'Sulafat', ''), ttsCacheKey('hi', 'Sulafat', ''))

  const lru = new LruCache(3)
  lru.set('a', 1)
  lru.set('b', 2)
  lru.set('c', 3)
  assert.equal(lru.get('a'), 1) // touching 'a' makes 'b' the oldest
  lru.set('d', 4)
  assert.equal(lru.size, 3)
  assert.equal(lru.has('b'), false)
  assert.equal(lru.get('a'), 1)
  assert.equal(lru.get('d'), 4)
})

await test('when the neural voice fails, the local one still says the words', async () => {
  // NEVER DEAD AIR. An agent that silently says nothing is indistinguishable
  // from one that has crashed, and Steve is not looking at the screen.
  const said = withSpeechSynthesis()
  const notices = []
  fake = fakeTts(() => ({ ok: false, error: 'Gemini is out of quota for this key (429): ...', kind: 'quota' }))
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()

  const r = await voiceSpeaker.speak('Opened three Claude Code tabs.', GEMINI, (m) => notices.push(m))
  assert.equal(r.engine, 'local')
  assert.equal(r.spoke, true)
  assert.equal(r.fellBackBecause, 'quota')
  assert.deepEqual(said, ['Opened three Claude Code tabs.'])
  assert.equal(notices.length, 1, 'it explains itself once')
  assert.match(notices[0], /Neural voice unavailable/)
  assert.match(notices[0], /out of quota/)

  // Once per session, not once per sentence — a toast on every reply would be
  // its own kind of nagging.
  await voiceSpeaker.speak('Two Kimi tabs open.', GEMINI, (m) => notices.push(m))
  assert.equal(notices.length, 1)
  assert.deepEqual(said, ['Opened three Claude Code tabs.', 'Two Kimi tabs open.'])

  delete global.window
  delete global.SpeechSynthesisUtterance
})

await test('barge-in aborts the request in flight and never plays the late reply', async () => {
  fake = fakeTts()
  fake.hold = true
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()

  const speaking = voiceSpeaker.speak('A long answer he does not want to hear.', GEMINI)
  await new Promise((r) => setTimeout(r, 5))
  voiceSpeaker.cancel()
  fake.finish()
  const r = await speaking

  assert.equal(r.spoke, false, 'nothing may be heard after he interrupts')
  assert.equal(fake.calls.cancel.length, 1, 'the main-process fetch is aborted too')
  assert.equal(fake.calls.cancel[0], fake.calls.speak[0].requestId)
  assert.equal(fake.calls.play.length, 0, 'the clip that landed late is discarded')
  fake.hold = false
})

await test('a turn is spoken exactly once, however often the panel re-renders', async () => {
  fake = fakeTts()
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()
  await voiceSpeaker.speakOnce('turn_neural_1', 'Three Claude Code tabs open.', GEMINI)
  await voiceSpeaker.speakOnce('turn_neural_1', 'Three Claude Code tabs open.', GEMINI)
  await voiceSpeaker.speakOnce('turn_neural_1', 'Three Claude Code tabs open.', GEMINI)
  assert.equal(fake.calls.play.length, 1, 'one turn, one utterance')
})

await test('echo rejection covers the neural engine too, or it covers neither', async () => {
  // The bug this guards against was found live with SAPI: Forge said "Typed
  // into Terminal 6 Claude Code, auto-relay is off in Settings", the sidecar
  // cut those words once the room went quiet, and it answered itself. The
  // microphone does not care which engine said them — and `gemini` is the
  // default — so a neural clip has to arm the same guard.
  const { speaker: spk } = await import('../src/lib/speech.ts')
  spk.forgetLastSpoken()
  assert.equal(spk.heardItself('opened three claude code tabs'), false, 'nothing said yet')

  fake = fakeTts()
  setTtsBackend(fake.backend)
  voiceSpeaker.clearCache()
  await voiceSpeaker.speak('Opened three Claude Code tabs.', GEMINI)

  // Mangled by speech-to-text, as it really comes back, and still caught:
  // the comparison is on words, not spelling.
  assert.equal(spk.heardItself('opened three clawed code tabs'), true)
  // Steve's own words are not an echo.
  assert.equal(spk.heardItself('now open two kimi tabs instead'), false)
  // And the window closes: six seconds later it is his again.
  assert.equal(spk.heardItself('opened three clawed code tabs', Date.now() + 20_000), false)
  spk.forgetLastSpoken()
})

await test('raw PCM becomes the floats Web Audio wants, without a WAV header', () => {
  // Gemini sends headerless PCM, so decodeAudioData cannot be used at all —
  // it sniffs container formats and rejects raw samples.
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(0, 0)
  pcm.writeInt16LE(32767, 2)
  pcm.writeInt16LE(-32768, 4)
  pcm.writeInt16LE(-16384, 6)
  const samples = base64ToPcm(pcm.toString('base64'))
  assert.deepEqual([...samples], [0, 32767, -32768, -16384])
  const floats = pcmToFloat32(samples)
  assert.equal(floats[0], 0)
  assert.equal(floats[2], -1, 'the negative extreme maps to exactly -1')
  assert.equal(floats[3], -0.5)
  assert.ok(floats[1] < 1 && floats[1] > 0.999, 'and the positive one cannot overflow')
})

setTtsBackend(null)

/* ------------------------------------------------- the canned robotics (B) */

console.log('\nNothing canned')

await test('a canned sign-off is stripped before anything is spoken', () => {
  // The exact sentence Steve quoted. A prompt rule is a request, not a
  // guarantee, so it is also removed on the way out.
  assert.equal(stripFiller('Ready for your next instruction.'), '')
  assert.equal(stripFiller('Opened three tabs. Ready for your next instruction.'), 'Opened three tabs.')
  assert.equal(stripFiller('Done. Awaiting your next command.'), 'Done.')
  assert.equal(stripFiller('Done. I am ready for your next instruction. Ready for the next command.'), 'Done.')
  assert.equal(stripFiller('Standing by for your next request.'), '')
  assert.equal(stripFiller("I'm listening."), '')
  assert.equal(stripFiller('How can I help?'), '')
  assert.equal(stripFiller('Anything else?'), '')
  assert.equal(stripFiller("What's next?"), '')

  // Real information survives, including sentences that merely contain the
  // words. Stripping "the build is ready" would be a much worse bug.
  assert.equal(stripFiller('The build is ready.'), 'The build is ready.')
  assert.equal(stripFiller('Terminal two is listening on port 3000.'), 'Terminal two is listening on port 3000.')
  assert.equal(stripFiller('Right — three of them, up and running.'), 'Right — three of them, up and running.')
  assert.equal(stripFiller(''), '')
})

await test('what Forge says for itself is never the same sentence twice running', () => {
  const options = ['one', 'two', 'three']
  for (let i = 0; i < 50; i++) assert.notEqual(pickVaried(options, 'one'), 'one')
  // A pool of one still has to answer rather than returning nothing.
  assert.equal(pickVaried(['only'], 'only'), 'only')
  assert.equal(pickVaried([], 'x'), '')
})

await test('no canned assistant filler is hard-coded anywhere in Forge', () => {
  // The regression guard. Steve heard "Ready for your next instruction." and
  // called the whole thing garbage; if one is ever typed into a source file
  // again, this fails rather than shipping.
  const CANNED = [
    /ready for (?:your|the) next/i,
    /awaiting (?:your|the|further)/i,
    /standing by/i,
    /at your service/i,
    /how (?:can|may) i (?:help|assist)/i,
    /is there anything else/i,
    /next (?:instruction|command)\b/i,
    /i am (?:ready|listening) (?:for|to receive)/i
  ]
  // Code only — comments are allowed to name the thing they are about, and two
  // of them have to. Two files are exempt outright: appmanifest.ts quotes the
  // sentence to forbid it, and tts.ts's regexes have to spell it to strip it.
  const decomment = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ')
  const roots = ['src', 'electron', 'shared', 'bridge', 'companion']
  const SKIP = new Set(['node_modules', 'out', 'dist', '.git'])
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mjs|js|html)$/.test(entry.name)) continue
      if (full.endsWith(join('src', 'lib', 'appmanifest.ts'))) continue
      if (full.endsWith(join('src', 'lib', 'tts.ts'))) continue
      const text = decomment(readFileSync(full, 'utf8'))
      for (const rx of CANNED) {
        const hit = rx.exec(text)
        if (hit) offenders.push(`${full}: ${hit[0]}`)
      }
    }
  }
  for (const root of roots) walk(join(ROOT, root))
  assert.deepEqual(offenders, [], `canned filler found:\n${offenders.join('\n')}`)

  // And prove the guard actually bites: the sentence Steve quoted, in code.
  assert.ok(CANNED.some((rx) => rx.test('const say = "Ready for your next instruction."')))
})

await test('the brain is told, in the manifest, how a spoken reply must sound', () => {
  const manifest = buildManifest(SNAPSHOT)
  // Every rule ships, or the fix is only half applied.
  for (const rule of SAY_RULES) assert.ok(manifest.includes(rule), `missing rule: ${rule.slice(0, 60)}`)

  // And the rules themselves say the things that matter, so a future edit
  // cannot quietly hollow them out while keeping the heading.
  const rules = SAY_RULES.join('\n')
  assert.match(rules, /TWO SHORT SENTENCES MAXIMUM/)
  assert.match(rules, /Contractions, always/)
  assert.match(rules, /VARY IT/i)
  assert.match(rules, /never reuse a sentence you have already/i)
  assert.match(rules, /NO SIGN-OFFS/)
  assert.match(rules, /Ready for your next instruction/)
  assert.match(rules, /"instruction", "command", "request" or "query"/)
  assert.match(rules, /Do not narrate yourself/)
  assert.match(rules, /Do not read out what is already on screen/)
  assert.match(rules, /Silence is a valid reply/)
})

await test('the speech settings default to the good engine, and survive a hand-edited file', () => {
  // The renderer's fallback settings and the main process's defaults are two
  // literals that must agree, exactly as geminiModel and openrouterModel do.
  const store = readFileSync(join(ROOT, 'electron', 'store.ts'), 'utf8')
  const state = readFileSync(join(ROOT, 'src', 'state', 'AppState.tsx'), 'utf8')
  for (const line of ["voiceEngine: 'gemini'", 'voiceEarcons: true', "voiceTtsVoice: ''", "voiceTtsModel: ''"]) {
    assert.ok(store.includes(line), `electron/store.ts is missing ${line}`)
    assert.ok(state.includes(line), `AppState.tsx is missing ${line}`)
  }
  // Blank is meaningful for both — "whatever gemini-tts.ts defaults to" — so
  // neither may be seeded with a literal model or voice name.
  assert.ok(!/voiceTtsVoice: 'Sulafat'/.test(store))
})

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

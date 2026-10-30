/**
 * brain-agent-model:check — agents Forge Brain opens start on a fixed model.
 *
 *  - The flags: bare `claude` gets them; a command that names its own model, any
 *    other CLI and a plain shell do not; junk is dropped, never typed; a resume
 *    gets nothing.
 *  - The Brain's call: its settings are the default, what it names wins, an id
 *    off the list is refused, and only the opening kinds are touched.
 *  - The route: through the real VoiceAgentHost (whose zod shape strips unknown
 *    arguments) to a fake renderer; the executor hands the pin to its runner; a
 *    request without one opens a pane without one.
 *  - The wiring: where the PTY host applies it, and that only Forge Brain's host
 *    ever calls brainAgentCall.
 *
 *   npm run brain-agent-model:check
 */
import './ts-hooks.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const A = await import('../shared/agents.ts')
const T = await import('../shared/brain-tools.ts')
const { makeLeaf } = await import('../shared/splitTree.ts')
const { makeTab } = await import('../shared/workspace.ts')
const { runAppAction } = await import('../src/lib/appactions.ts')
const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')

let passed = 0
let failed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${label}\n       ${err?.message ?? err}`)
  }
}

const OPUS = 'claude-opus-5-5[1m]'
const PIN = { launchModel: OPUS, launchEffort: 'xhigh' }
const SETTINGS = { brainAgentModel: OPUS, brainAgentEffort: 'xhigh' }

console.log('the flags')
await check('bare claude gets both, with [1m] single-quoted', () => {
  assert.equal(A.pinnedModelFlags('claude', OPUS, 'xhigh'), "--model 'claude-opus-5-5[1m]' --effort xhigh")
})
await check('a claude command naming its own model gets nothing (GLM)', () => {
  assert.equal(A.pinnedModelFlags("claude --model 'glm-5.3[1m]'", OPUS, 'xhigh'), '')
  assert.equal(A.pinnedModelFlags('claude --model=sonnet', OPUS, 'xhigh'), '')
})
await check('other CLIs and a plain shell get nothing', () => {
  for (const command of ['codex', 'gemini', 'grok', 'claudette', '']) assert.equal(A.pinnedModelFlags(command, OPUS, 'xhigh'), '', command)
})
await check('junk and shell metacharacters are dropped, never typed', () => {
  for (const bad of ["x'; Remove-Item -Recurse C:\\ #", 'claude-opus-5-5[1m] --foo', '$(whoami)', 'CLAUDE-OPUS-5-5[1M]', 42, null, undefined]) {
    assert.equal(A.pinnedModelFlags('claude', bad, 'nope; calc'), '', String(bad))
  }
  assert.equal(A.pinnedModelFlags('claude', "x'y", 'high'), '--effort high')
  assert.equal(A.pinnedModelFlags('claude', OPUS, "high'"), "--model 'claude-opus-5-5[1m]'")
})
await check('a command with its own effort keeps it', () => {
  assert.equal(A.pinnedModelFlags('claude --effort low', OPUS, 'xhigh'), "--model 'claude-opus-5-5[1m]'")
})
await check('every listed id and level passes, and the defaults are on the lists', () => {
  for (const m of A.CLAUDE_AGENT_MODELS) assert.ok(A.pinnedModelFlags('claude', m.id, 'high').includes(`'${m.id}'`), m.id)
  for (const l of A.EFFORT_LEVELS) assert.ok(A.pinnedModelFlags('claude', OPUS, l.id).endsWith(`--effort ${l.id}`), l.id)
  assert.equal(A.sanitiseBrainAgentModel('junk'), OPUS)
  assert.equal(A.sanitiseBrainAgentEffort('junk'), 'xhigh')
  assert.equal(A.sanitiseBrainAgentModel('claude-fable-5-1'), 'claude-fable-5-1')
  assert.equal(A.sanitiseBrainAgentEffort('max'), 'max')
})

console.log('the launch')
const SESSION = 'claude --session-id 11111111-1111-4111-8111-111111111111'
await check('a new session is pinned, flags after the session flag', () => {
  assert.equal(A.pinLaunch(SESSION, 'new', PIN), `${SESSION} --model 'claude-opus-5-5[1m]' --effort xhigh`)
})
await check('an unmanaged launch is pinned too (resumeSessions off)', () => {
  assert.equal(A.pinLaunch('claude', null, PIN), "claude --model 'claude-opus-5-5[1m]' --effort xhigh")
})
await check('a resume plan gets nothing, so a by-hand /model survives', () => {
  const resumed = 'claude --resume 11111111-1111-4111-8111-111111111111'
  assert.equal(A.pinLaunch(resumed, 'resume', PIN), resumed)
})
await check('a hand-written resume gets nothing', () => {
  assert.equal(A.pinLaunch('claude --resume', null, PIN), 'claude --resume')
  assert.equal(A.pinLaunch('claude -c', null, PIN), 'claude -c')
})
await check('no pin is the same command, character for character', () => {
  for (const command of ['claude', '  claude ', "claude --model 'glm-5.3[1m]'", 'codex', '']) {
    assert.equal(A.pinLaunch(command, 'new', undefined), command)
    assert.equal(A.pinLaunch(command, 'new', {}), command)
  }
})

console.log('the Brain\'s call')
await check('open_agent_pane with nothing named takes the settings', () => {
  const call = T.brainAgentCall('open_agent_pane', { agent: 'claude' }, { brainAgentModel: 'claude-sonnet-5-5', brainAgentEffort: 'low' })
  assert.deepEqual(call.pin, { launchModel: 'claude-sonnet-5-5', launchEffort: 'low' })
})
await check('junk settings fall back to the defaults', () => {
  const call = T.brainAgentCall('open_agent_pane', { agent: 'claude' }, { brainAgentModel: 'x', brainAgentEffort: 'y' })
  assert.deepEqual(call.pin, PIN)
})
await check('what Steve named wins, one at a time', () => {
  const both = T.brainAgentCall('open_agent_pane', { agent: 'claude', model: 'claude-fable-5-1', effort: 'max' }, SETTINGS)
  assert.deepEqual(both.pin, { launchModel: 'claude-fable-5-1', launchEffort: 'max' })
  const model = T.brainAgentCall('open_agent_pane', { agent: 'claude', model: 'claude-haiku-5-5' }, SETTINGS)
  assert.deepEqual(model.pin, { launchModel: 'claude-haiku-5-5', launchEffort: 'xhigh' })
})
await check('a model off the list is refused, naming the valid ids', () => {
  const call = T.brainAgentCall('open_agent_pane', { agent: 'claude', model: 'gpt-5.5' }, SETTINGS)
  assert.ok(call.refused.includes('gpt-5.5'))
  for (const m of A.CLAUDE_AGENT_MODELS) assert.ok(call.refused.includes(m.id), m.id)
})
await check('an effort off the list is refused', () => {
  assert.ok(T.brainAgentCall('open_agent_pane', { agent: 'claude', effort: 'huge' }, SETTINGS).refused.includes('xhigh'))
})
await check('run_app_action: the opening kinds get the settings in the action', () => {
  for (const kind of ['open_agent_pane', 'open_tabs', 'open_panes']) {
    const call = T.brainAgentCall('run_app_action', { action: { kind, profileId: 'claude', count: 1 } }, SETTINGS)
    assert.deepEqual(call.args.action, { kind, profileId: 'claude', count: 1, ...PIN }, kind)
  }
})
await check('anything else passes untouched', () => {
  const close = { action: { kind: 'close_tab', which: 'Zeb' } }
  assert.deepEqual(T.brainAgentCall('run_app_action', close, SETTINGS), { args: close })
  const read = { target: 'Zeb' }
  assert.deepEqual(T.brainAgentCall('read_pane', read, SETTINGS), { args: read })
})
await check('the spec: the Brain gets model and effort, the shared spec does not', () => {
  const open = T.MAIN_AGENT_TOOL_SPECS.find((s) => s.name === 'open_agent_pane')
  assert.ok(!('model' in open.parameters.properties) && !('effort' in open.parameters.properties))
  const tool = T.withBrainAgentArgs({ name: 'open_agent_pane', inputSchema: { type: 'object', properties: { agent: {} }, required: ['agent'] } })
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['agent', 'model', 'effort'])
  assert.deepEqual(tool.inputSchema.required, ['agent'])
  assert.deepEqual(tool.inputSchema.properties.model.enum, A.CLAUDE_AGENT_MODELS.map((m) => m.id))
  const other = { name: 'read_pane', inputSchema: {} }
  assert.equal(T.withBrainAgentArgs(other), other)
})
await check('Steve can change them by asking: both are allowed settings, with choices', () => {
  assert.deepEqual(T.brainSetting('brainAgentModel').choices, A.CLAUDE_AGENT_MODELS.map((m) => m.id))
  assert.deepEqual(T.brainSetting('brainAgentEffort').choices, A.EFFORT_LEVELS.map((l) => l.id))
})

console.log('the route')
{
  const asked = []
  const host = new VoiceAgentHost({
    sendEvent() {},
    sendToolRequest(req) {
      asked.push(req)
      setTimeout(() => host.resolveTool({ id: req.id, ok: true, result: 'renderer ran' }), 0)
    },
    getModel: () => 'opus',
    getBrain: () => 'codex-cli'
  })
  await check('the pin reaches the renderer through the real host, though zod strips model and effort', async () => {
    const call = T.brainAgentCall('open_agent_pane', { agent: 'claude', model: 'claude-fable-5-1' }, SETTINGS)
    await host.callLinkTool('open_agent_pane', call.args, call.pin)
    const { name, args } = asked.at(-1)
    assert.equal(name, 'open_agent_pane')
    assert.deepEqual(args, { agent: 'claude', launchModel: 'claude-fable-5-1', launchEffort: 'xhigh' })
  })
  await check('another brain, with no pin, reaches the renderer with none; a sent launchModel is stripped', async () => {
    await host.callLinkTool('open_agent_pane', { agent: 'claude', launchModel: OPUS, model: OPUS })
    assert.deepEqual(asked.at(-1).args, { agent: 'claude' })
  })
  await check('run_app_action carries it in the action', async () => {
    const call = T.brainAgentCall('run_app_action', { action: { kind: 'open_tabs', profileId: 'claude', count: 2 } }, SETTINGS)
    await host.callLinkTool('run_app_action', call.args, call.pin)
    assert.deepEqual(asked.at(-1).args, { kind: 'open_tabs', profileId: 'claude', count: 2, ...PIN })
  })
  host.dispose?.()
}

const profile = { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#fff', badge: 'C' }
const context = (over = {}) => ({
  profiles: [profile],
  projects: [],
  loadedProjectIds: [],
  activeProjectId: 'p1',
  tabs: [],
  paneCount: 0,
  maxSessions: 16,
  maxPanesPerTab: 8,
  panesInActiveTab: 1,
  focusedPaneId: 'pane-1',
  panes: [],
  ...over
})
function spyRunner() {
  const calls = []
  return {
    calls,
    newTab: (id, pin) => calls.push(['newTab', pin]),
    splitPane: (_p, _d, id, pin) => calls.push(['splitPane', pin]),
    openAgentPane: (req) => {
      calls.push(['openAgentPane', req.pin])
      return { paneId: 'new', name: 'Zeb' }
    }
  }
}

await check('the executor hands the pin to every way of opening', () => {
  const run = spyRunner()
  runAppAction({ kind: 'open_tabs', profileId: 'claude', count: 1, ...PIN }, context(), run)
  runAppAction({ kind: 'open_panes', profileId: 'claude', count: 1, ...PIN }, context(), run)
  runAppAction({ kind: 'open_agent_pane', agent: 'claude', prompt: 'hi', ...PIN }, context(), run)
  runAppAction({ kind: 'open_agent_pane', agent: 'claude', ...PIN }, context(), run)
  assert.deepEqual(run.calls, [['newTab', PIN], ['splitPane', PIN], ['openAgentPane', PIN], ['newTab', PIN]])
})
await check('without one, the executor opens with an empty pin', () => {
  const run = spyRunner()
  runAppAction({ kind: 'open_tabs', profileId: 'claude', count: 1 }, context(), run)
  runAppAction({ kind: 'open_agent_pane', agent: 'claude', prompt: 'hi' }, context(), run)
  assert.deepEqual(run.calls, [['newTab', {}], ['openAgentPane', {}]])
})
await check('a leaf carries a pin it is given, and an empty one leaves no field', () => {
  const pinned = makeLeaf('claude', '', undefined, PIN)
  assert.equal(pinned.launchModel, OPUS)
  assert.equal(pinned.launchEffort, 'xhigh')
  for (const leaf of [makeLeaf('claude'), makeLeaf('claude', '', undefined, {})]) {
    assert.ok(!('launchModel' in leaf) && !('launchEffort' in leaf))
  }
  const { tab } = makeTab('claude', [], 0, undefined, PIN)
  assert.equal(tab.root.launchModel, OPUS)
})

console.log('the wiring')
const source = (file) => readFileSync(resolve(ROOT, file), 'utf8')
await check('the PTY host pins after the session flag and before the variadic transforms', () => {
  const pty = source('electron/pty-host.ts')
  assert.ok(pty.includes('applyForgeBrowserOnly(pinLaunch(plan.command, plan.mode, req),'))
})
await check('only Forge Brain\'s host sets a pin, and every terminal spec passes it on', () => {
  assert.ok(source('electron/brain/host.ts').includes('brainToolHost().callLinkTool(name, call.args, call.pin)'))
  for (const file of ['electron/voice-agent/host.ts', 'electron/foreman/host.ts', 'electron/browser-panes/ipc.ts', 'electron/foreman/pane-caller.ts']) {
    assert.ok(!source(file).includes('brainAgentCall'), file)
  }
  for (const file of ['src/components/TerminalPane.tsx', 'src/components/MosaicView.tsx', 'src/components/brainview/BrainMap.tsx', 'src/state/AppState.tsx', 'src/lib/agenttools.ts']) {
    const text = source(file)
    assert.equal(text.split('bootstrapCommand: launchCommand(').length, text.split('...leafLaunchPin(').length, file)
  }
})
await check('Foreman\'s runner stays unpinned', () => {
  const foreman = source('src/state/Foreman.tsx')
  assert.ok(foreman.includes('newTab: (profileId) => actions.newTab(profileId)'))
  assert.ok(foreman.includes('splitPane: (paneId, direction, profileId) => actions.splitPane(paneId, direction, profileId)'))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

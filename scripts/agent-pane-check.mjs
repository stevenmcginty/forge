/**
 * Agents opening agents — the paths a pane agent's open_agent_pane and a
 * queued brief take, checked without Electron or a renderer.
 *
 *   node scripts/agent-pane-check.mjs
 *
 * Four things have to hold:
 *
 *  1. A pane agent's new agent opens in the *caller's* project. The bridge
 *     tags the call with the calling pane; the link must turn that into an
 *     anchored action (electron/foreman/pane-caller.ts) and the executor must
 *     hand the anchor to the runner that places the tab.
 *  2. A brief goes in once. Delivery is recorded per queued entry in an object
 *     that outlives the drain effect's runs (src/lib/briefDelivery.ts); a run
 *     that starts after a paste must skip it, not paste it again.
 *  3. A brief is never pasted into a shell. A pane that never printed an
 *     agent's banner is refused its brief at the deadline, never handed it.
 *  4. A hire's answer names the panes it opened, before they are running.
 *
 * Plus source checks that the Electron and React halves — which a node script
 * cannot load — are wired to the pure halves above.
 */
import './ts-hooks.mjs'
import { readFileSync } from 'node:fs'

const { anchoredOpenAction, paneOpenReply } = await import('../electron/foreman/pane-caller.ts')
const { BriefDelivery, BRIEF_DEADLINE_MS, BRIEF_READY_BYTES, BRIEF_READY_QUIET_MS } = await import(
  '../src/lib/briefDelivery.ts'
)
const { runAppAction } = await import('../src/lib/appactions.ts')
const { BUILTIN_AGENT_PROFILES } = await import('../shared/agents.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const src = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/* ------------------------------------------------------------ the caller */

console.log('\na pane agent opens its helper in its own project')
{
  const action = anchoredOpenAction({ agent: 'codex', prompt: 'review the diff', name: 'Review', submit: true }, 'pane:pane-a1')
  ok(action?.kind === 'open_agent_pane', 'a pane caller becomes an open_agent_pane action', JSON.stringify(action))
  ok(action?.anchorPaneId === 'pane-a1', 'anchored on the calling pane', String(action?.anchorPaneId))
  ok(
    action?.agent === 'codex' && action?.prompt === 'review the diff' && action?.name === 'Review' && action?.submit === true,
    'with the agent, prompt, name and submit it asked for',
    JSON.stringify(action)
  )
  ok(anchoredOpenAction({ agent: 'codex' }, 'agent') === null, 'a caller that is not a pane has no anchor (opens on screen)')
  ok(anchoredOpenAction({ agent: 'codex' }, 'pane:') === null, 'nor does a pane caller with an empty id')
  ok(paneOpenReply('Opened a new Codex pane').text.startsWith('OK: '), 'a success reads OK:')
  ok(paneOpenReply('That failed: no room').ok === false, 'a refusal is not ok')
  ok(paneOpenReply('Forge did not answer within 15 seconds.').ok === false, 'nor is a timeout')

  const ipc = src('electron/browser-panes/ipc.ts')
  ok(/appOp:\s*async\s*\(op,\s*args,\s*caller\)/.test(ipc), "the link's appOp takes the caller instead of dropping it")
  ok(/anchoredOpenAction\(args,\s*caller\.id\)/.test(ipc), 'and anchors open_agent_pane on it')
}

/* ------------------------------------------------------------ the executor */

const profiles = BUILTIN_AGENT_PROFILES
const ctx = (over = {}) => ({
  projects: [
    { id: 'p-a', name: 'alpha' },
    { id: 'p-b', name: 'beta' }
  ],
  profiles,
  defaultProfileId: profiles[0].id,
  activeProjectId: 'p-a',
  activeProjectName: 'alpha',
  loadedProjectIds: ['p-a', 'p-b'],
  tabs: [{ id: 't1', title: 'one' }],
  activeTabId: 't1',
  focusedPaneId: 'pane-a1',
  paneCount: 1,
  panesInActiveTab: 1,
  maxSessions: 16,
  maxPanesPerTab: 4,
  panes: [],
  ...over
})
const runner = (answer = 'pane-new') => {
  const calls = []
  return {
    calls,
    newTab: (profileId) => calls.push(['newTab', profileId]),
    splitPane: () => calls.push(['splitPane']),
    closePane: () => {},
    closeTab: () => {},
    selectProject: () => {},
    selectTab: () => {},
    openAgentPane: (request) => {
      calls.push(['openAgentPane', request])
      return answer
    },
    hireTab: (anchor, profileId, count) => {
      calls.push(['hireTab', anchor, profileId, count])
      return { ok: true, done: count, summary: `Opened ${count} panes`, paneIds: ['pane-h1', 'pane-h2'].slice(0, count) }
    }
  }
}

console.log('\nthe executor hands the anchor to the runner')
{
  const claude = profiles.find((p) => p.id === 'claude') ?? profiles[0]
  const run = runner()
  const out = runAppAction({ kind: 'open_agent_pane', agent: claude.id, prompt: 'go', anchorPaneId: 'pane-a1' }, ctx(), run)
  const call = run.calls.find((c) => c[0] === 'openAgentPane')
  ok(call?.[1]?.anchorPaneId === 'pane-a1', 'openAgentPane gets the anchor pane', JSON.stringify(call))
  ok(out.ok && out.paneIds?.[0] === 'pane-new', 'the outcome names the new pane', JSON.stringify(out))
  ok(out.summary.includes('pane-new'), 'and so does the sentence', out.summary)

  const bare = runner()
  runAppAction({ kind: 'open_agent_pane', agent: claude.id, anchorPaneId: 'pane-a1' }, ctx(), bare)
  ok(
    bare.calls.some((c) => c[0] === 'openAgentPane') && !bare.calls.some((c) => c[0] === 'newTab'),
    'an anchored open with no prompt still goes to the runner that knows the project, not newTab',
    JSON.stringify(bare.calls)
  )

  const refused = runAppAction({ kind: 'open_agent_pane', agent: claude.id, prompt: 'go' }, ctx(), runner(null))
  ok(refused.ok === false, 'a refused open is not reported as opened', refused.summary)

  const hired = runAppAction(
    { kind: 'open_panes', profileId: claude.id, count: 2, direction: 'row', anchorPaneId: 'pane-a1' },
    ctx(),
    runner()
  )
  ok(
    hired.summary.includes('pane-h1') && hired.summary.includes('pane-h2'),
    "a hire's answer names the panes it opened",
    hired.summary
  )
  ok(hired.paneIds?.length === 2, 'and carries their ids', JSON.stringify(hired.paneIds))
}

/* ------------------------------------------------------------ the briefs */

const ready = { status: 'live', outputBytes: BRIEF_READY_BYTES + 500, quietForMs: BRIEF_READY_QUIET_MS + 100, exists: true }
const shell = { status: 'live', outputBytes: 400, quietForMs: 60_000, exists: true }

console.log('\na brief goes in once')
{
  const delivery = new BriefDelivery()
  const a = { paneId: 'pane-1', text: 'brief one', submit: true, paste: true }
  const b = { paneId: 'pane-2', text: 'brief two', submit: true, paste: true }
  const t0 = 1_000_000
  ok(delivery.step(a, true, ready, t0) === 'deliver', 'a ready agent gets its brief')
  delivery.markDone(a)
  // The queue changed (b was added), so the drain effect runs again — with
  // the same delivery record, which is the fix.
  ok(delivery.step(a, true, ready, t0 + 2000) === 'skip', 'a later run skips the brief already pasted')
  ok(delivery.step(b, true, { ...ready, status: 'starting' }, t0 + 2000) === 'wait', 'while the new pane waits for its own')
  ok(delivery.step(a, true, ready, t0 + 60_000) === 'skip', 'and it never comes back, however long the queue lives')

  const drain = src('src/state/AppState.tsx')
  ok(/useRef\(new BriefDelivery</.test(drain), "AppState's drain keeps the record in a ref that outlives its runs")
  ok(!/const delivered: string\[\] = \[\]/.test(drain), 'and no longer keeps a per-run delivered list')
}

console.log('\na brief is never pasted into a shell')
{
  const delivery = new BriefDelivery()
  const brief = { paneId: 'pane-3', text: 'git reset --hard\nrm -rf build', submit: false, paste: true }
  const t0 = 2_000_000
  ok(delivery.step(brief, true, shell, t0) === 'wait', 'a pane that printed only a prompt is not ready')
  ok(delivery.step(brief, true, shell, t0 + BRIEF_DEADLINE_MS - 1) === 'wait', 'right up to the deadline')
  ok(delivery.step(brief, true, shell, t0 + BRIEF_DEADLINE_MS + 1) === 'refuse', 'and past it the brief is refused, not pasted')

  const typed = { paneId: 'pane-4', text: 'winget upgrade --all', submit: false }
  ok(delivery.step(typed, false, shell, t0) === 'deliver', 'a typed command for a shell still goes in once the shell is live')

  const later = new BriefDelivery()
  const offscreen = { paneId: 'pane-5', text: 'brief', submit: false, paste: true }
  ok(later.step(offscreen, true, { ...shell, status: 'idle' }, t0) === 'wait', 'a pane not mounted yet waits…')
  ok(
    later.step(offscreen, true, { ...shell, status: 'idle' }, t0 + 10 * BRIEF_DEADLINE_MS) === 'wait',
    '…with no clock running, however long its project stays closed'
  )
  ok(later.step(offscreen, true, ready, t0 + 10 * BRIEF_DEADLINE_MS + 5) === 'deliver', 'and gets its brief once it starts')
  ok(later.step({ ...offscreen }, true, { ...ready, exists: false }, t0) === 'drop', 'a pane whose tab was closed is dropped')

  const drain = src('src/state/AppState.tsx')
  ok(
    !/pending\.paste && Date\.now\(\) < deadline/.test(drain),
    'the drain no longer pastes past the deadline on the strength of a timer'
  )
}

/* ------------------------------------------------------ every pane, reached */

const AT = await import('../src/lib/agenttools.ts')
const { setHubRuntime } = await import('../src/lib/hubRuntime.ts')

const pane = (name, over = {}) => ({
  paneId: `id-${name.toLowerCase()}`,
  tabId: `tab-${name.toLowerCase()}`,
  tabNumber: 1,
  tabTitle: name,
  number: 1,
  name,
  profileId: 'claude',
  profileName: 'Claude Code',
  live: true,
  focused: false,
  agent: true,
  ...over
})
const where = { id: 'p-b', name: 'beta', path: 'C:/beta', onScreen: false }

/**
 * A stand-in for the live app and terminal host: `hasEntry` is whether this
 * window has a terminal for the pane, `live` the ids main runs a process for.
 */
const fakeReach = ({ target, hasEntry = false, live = new Set(), screen = 'agent screen', listable = true } = {}) => {
  const calls = []
  let has = hasEntry
  let status = hasEntry ? 'live' : 'idle'
  let text = screen
  const term = {
    has: () => has,
    startHidden: async (id, spec) => {
      calls.push(['startHidden', id, spec])
      const restored = live.has(id)
      has = true
      status = 'live'
      return restored ? 'restored' : 'started'
    },
    snapshotText: () => (has ? text : null),
    runtime: () => ({ status }),
    readiness: () => ({ outputBytes: BRIEF_READY_BYTES + 500, quietForMs: BRIEF_READY_QUIET_MS + 100 }),
    paste: (id, t) => calls.push(['paste', id, t]),
    type: (id, t) => {
      calls.push(['type', id, t])
      return true
    },
    submit: (id) => {
      calls.push(['submit', id])
      text += '\nworking…'
      return true
    }
  }
  const leaf = { type: 'leaf', id: target.paneId, profileId: 'claude', title: target.name }
  const r = {
    app: { get: () => ({ workspaces: { [where.id]: { tabs: [{ id: target.tabId, root: leaf }] } } }) },
    term,
    activity: () => 'dormant',
    panesOf: () => [target],
    themes: [],
    livePtys: async () => (listable ? live : null),
    specFor: async (projectId, paneId) => (projectId === where.id && paneId === target.paneId ? { cwd: where.path } : null)
  }
  return { r, calls }
}

console.log('\na running pane with no terminal here is adopted, not called "not started"')
{
  const zeb = pane('Zeb')
  const read = fakeReach({ target: zeb, live: new Set([zeb.paneId]), screen: '> fix the tests\n✻ Working' })
  const readAnswer = await AT.readElsewhere(read.r, where, zeb, 40)
  ok(read.calls[0]?.[0] === 'startHidden', 'read_pane adopts the live process before reading', JSON.stringify(read.calls))
  ok(readAnswer.includes('Working') && readAnswer.startsWith('Zeb (beta)'), 'and reads its real screen', readAnswer)
  ok(!/not started|has not started/.test(readAnswer), 'never "has not started yet"', readAnswer)

  const type = fakeReach({ target: zeb, live: new Set([zeb.paneId]) })
  const typed = await AT.typeElsewhere(type.r, where, zeb, 'run the tests', false)
  ok(type.calls[0]?.[0] === 'startHidden', 'type_into_pane adopts it before typing', JSON.stringify(type.calls))
  ok(type.calls.some((c) => c[0] === 'type' && c[2] === 'run the tests'), 'then types into the same pane', JSON.stringify(type.calls))
  ok(typed.startsWith('OK: typed into Zeb (beta)'), 'and says so', typed)

  const present = fakeReach({ target: zeb, hasEntry: true, live: new Set([zeb.paneId]) })
  await AT.readElsewhere(present.r, where, zeb, 40)
  ok(!present.calls.some((c) => c[0] === 'startHidden'), 'a pane with a terminal already is not started again')

  const blind = fakeReach({ target: zeb, listable: false })
  const blindRead = await AT.readElsewhere(blind.r, where, zeb, 40)
  ok(blindRead.startsWith('FAILED') && !/not running|not started/.test(blindRead), 'main unreachable: says it could not check, claims nothing', blindRead)
  ok(!blind.calls.length, 'and starts nothing')

  ok(AT.wakeStep(true, null, 'x') === 'present', 'wakeStep: a terminal here is present')
  ok(AT.wakeStep(false, new Set(['x']), 'x') === 'adopt', 'wakeStep: no terminal but a live process is adopted')
  ok(AT.wakeStep(false, new Set(), 'x') === 'dormant', 'wakeStep: no process anywhere is dormant')
  ok(AT.wakeStep(false, null, 'x') === 'unknown', 'wakeStep: main unasked is unknown, never dormant')

  const tools = src('src/lib/agenttools.ts')
  ok(!/has not started yet/.test(tools), 'no answer in agenttools says "has not started yet"')
  ok(!/requestAnimationFrame\(/.test(tools), 'and nothing in it waits on an animation frame')
  ok(/adoptLivePanes\(\)/.test(tools.slice(tools.indexOf('export function registerVoiceAgentTools'))), 'the adopt sweep runs once the tools register')
  ok(/ADOPT_SWEEP_STEP_MS = 150/.test(tools), 'one adoption every 150 ms')
  const host = src('src/lib/terminals.ts')
  const hidden = host.slice(host.indexOf('  startHidden('), host.indexOf('  geometryFor('))
  ok(hidden.length > 0 && !/setWebgl/.test(hidden), 'a hidden terminal takes no WebGL context')
}

console.log('\na dormant pane in another project starts when typed into')
{
  const kess = pane('Kess')
  const sent = fakeReach({ target: kess })
  const answer = await AT.typeElsewhere(sent.r, where, kess, 'review the diff', true)
  ok(sent.calls[0]?.[0] === 'startHidden' && sent.calls[0]?.[2]?.cwd === where.path, 'it is started off screen with its own launch', JSON.stringify(sent.calls[0]))
  ok(sent.calls.some((c) => c[0] === 'type' && c[2] === 'review the diff'), 'the text goes in once the agent is up', JSON.stringify(sent.calls))
  ok(sent.calls.some((c) => c[0] === 'submit'), 'then Enter, in its own write', JSON.stringify(sent.calls))
  ok(answer.startsWith('OK: ') && answer.includes('in and sent'), 'answered "in and sent" once the screen moved', answer)

  const unsent = fakeReach({ target: kess })
  const held = await AT.typeElsewhere(unsent.r, where, kess, 'line one\nline two', false)
  ok(unsent.calls.some((c) => c[0] === 'paste'), 'multi-line text is pasted whole', JSON.stringify(unsent.calls))
  ok(!unsent.calls.some((c) => c[0] === 'submit'), 'and not sent when not asked')
  ok(held.includes('typed, not sent'), 'answered "typed, not sent"', held)

  const still = AT.startedTypingAnswer('Kess', 'beta', 'id-kess', null, true)
  ok(still.startsWith('STILL STARTING') && /check with read_pane before sending anything/i.test(still), 'past the wait: STILL STARTING, check with read_pane', still)
  ok(still.includes('id-kess'), 'naming the pane', still)
  const lost = AT.startedTypingAnswer('Kess', 'beta', 'id-kess', { outcome: 'pasted', sent: false }, true)
  ok(lost.startsWith('FAILED') && lost.includes('did not take the Enter'), 'a lost Enter is a failure, not "sent"', lost)
  const refused = AT.startedTypingAnswer('Kess', 'beta', 'id-kess', { outcome: 'refused', sent: false }, true)
  ok(refused.startsWith('FAILED') && refused.includes('NOT typed'), 'a refused brief says NOT typed', refused)

  const dormantRead = await AT.readElsewhere(fakeReach({ target: kess }).r, where, kess, 40)
  ok(/is not running/.test(dormantRead) && /type_into_pane starts it/.test(dormantRead), 'read_pane on it: not running, typing starts it', dormantRead)
  const readCalls = fakeReach({ target: kess })
  await AT.readElsewhere(readCalls.r, where, kess, 40)
  ok(!readCalls.calls.length, 'and reading never starts it')
}

console.log('\na pane named without a project is found in whichever project has it')
{
  const alpha = { id: 'p-a', name: 'alpha', path: 'C:/alpha' }
  const beta = { id: 'p-b', name: 'beta', path: 'C:/beta' }
  const groups = [
    { project: alpha, panes: [pane('Viggo'), pane('Zeb')] },
    { project: beta, panes: [pane('Zeb', { paneId: 'id-zeb-b' }), pane('Kess')] }
  ]
  const one = AT.findPaneAcrossProjects('kess', groups)
  ok(one.kind === 'one' && one.hit.project.name === 'beta' && one.hit.pane.name === 'Kess', 'one match: that pane, in its project', JSON.stringify(one))
  const several = AT.findPaneAcrossProjects('Zeb', groups)
  ok(several.kind === 'several' && several.hits.length === 2, 'the same name in two projects: several', JSON.stringify(several))
  const text = AT.severalPanesAnswer('Zeb', several.hits ?? [])
  ok(text.startsWith('FAILED:') && text.includes('Zeb (alpha)') && text.includes('Zeb (beta)') && /say which project/i.test(text), 'answered with "name (project)" and "say which project"', text)
  ok(AT.findPaneAcrossProjects('Ludo', groups).kind === 'none', 'no match: none (the on-screen tools answer)')
  ok(AT.findPaneAcrossProjects('terminal 2', groups).kind === 'none', 'a number is never matched across projects')
  ok(AT.findPaneAcrossProjects('claude', groups).kind === 'none', 'nor an agent word')
  const tools = src('src/lib/agenttools.ts')
  ok(/byNameOnly/.test(tools) && /paneOffScreen\(r, str\(args\['target'\]\)\)/.test(tools), 'answerAcrossProjects looks beyond the screen when no project is named')
}

console.log('\npane answers end with the pane id')
{
  ok(AT.withPaneId('OK: typed into Zeb.', 'p-9') === 'OK: typed into Zeb. (pane id p-9)', 'withPaneId appends " (pane id …)"')
  const zeb = pane('Zeb', { paneId: 'p-zeb' })
  const typed = await AT.typeElsewhere(fakeReach({ target: zeb, hasEntry: true }).r, where, zeb, 'go', false)
  ok(typed.startsWith('OK'), 'cross-project typing succeeds first', typed)
  const tools = src('src/lib/agenttools.ts')
  ok(/typed\.startsWith\('OK'\) \? withPaneId\(typed, pane\.paneId\)/.test(tools), 'cross-project type_into_pane appends the id on success')

  setHubRuntime({
    panes: () => [zeb],
    focusedPaneId: () => 'p-zeb',
    activeProjectId: () => 'p-a',
    prompts: () => [],
    revealPane: () => {},
    focusTerminal: () => {},
    typeIntoPane: () => true
  })
  const deps = {
    getSnapshot: () => ({}),
    getProjectMemory: () => '',
    remember: () => true,
    actionContext: () => ctx({ panes: [zeb], focusedPaneId: 'p-zeb' }),
    runAction: () => ({ ok: true, summary: 'Sending to Zeb… say “wait” to hold', requested: 1, done: 0 })
  }
  const onScreen = await AT.answerVoiceAgentTool('type_into_pane', { target: 'Zeb', text: 'go', submit: true }, deps)
  ok(onScreen.ok && onScreen.result.endsWith(' (pane id p-zeb)'), 'on-screen type_into_pane ends with the pane id', JSON.stringify(onScreen))
  const prompt = await AT.answerVoiceAgentTool('run_app_action', { kind: 'send_prompt', target: 'Zeb', text: 'go' }, deps)
  ok(prompt.ok && prompt.result.endsWith(' (pane id p-zeb)'), 'on-screen send_prompt ends with the pane id', JSON.stringify(prompt))
  setHubRuntime(null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

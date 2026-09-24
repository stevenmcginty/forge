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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

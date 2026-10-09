/**
 * Check for show_view — the one tool that changes what Forge's desktop shows,
 * and only when Steve asks (src/lib/showView.ts).
 *
 *   node scripts/show-view-check.mjs
 *
 * Pure: the planner is fed snapshots built here, no window, no React, no IPC.
 * Then the tool's name and words across the three ways in: the shared spec
 * every brain gets, the forge-bridge tool pane agents get, and main's pipe ops.
 */
import './ts-hooks.mjs'

const { planShowView, SHOW_VIEW_LIST_MAX, AWAY_NOTE, forgeIsAway } = await import('../src/lib/showView.ts')
const specs = await import('../shared/brain-tools.ts')
const APP = await import('../bridge/forge-app-tools.mjs')

let pass = 0
let fail = 0
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------- snapshots */

const SURFACES = [
  { id: 'browser', title: 'Browser' },
  { id: 'board', title: 'Board' },
  { id: 'read', title: 'Read' }
]
const PROJECTS = [
  { id: 'p1', name: 'Forge' },
  { id: 'p2', name: 'Cafe' }
]

let clock = 1000
function tab(id, project, title, owner = { id: 'user', label: 'You' }, url = `https://${id}.example/`) {
  return { id, project, url, title, owner, createdAt: clock++ }
}

function snap(over = {}) {
  return {
    mode: 'agents',
    surfaces: SURFACES,
    project: { id: 'p1', name: 'Forge' },
    projects: PROJECTS,
    tabs: [],
    front: null,
    ...over
  }
}

const zeb = { id: 'pane:z1', label: 'Zeb' }

/* ---------------------------------------------------------------- rule 1 */
console.log('rule 1: the browser, with tabs here')
{
  const a = tab('b-1', 'p1', 'Docs', zeb)
  const b = tab('b-2', 'p1', 'Mine')
  const c = tab('b-3', '', 'Everywhere')
  const o = tab('b-9', 'p2', 'Menu')
  const plan = planShowView({ view: 'browser' }, snap({ tabs: [a, b, c, o] }))
  ok(plan.ok && plan.switchTo === 'browser', 'switches to the Browser', JSON.stringify(plan))
  ok(plan.switchProject === null, 'stays in the project')
  ok(plan.frontTab === 'b-3', 'no front tab yet: the newest here comes forward', plan.frontTab)
  ok(plan.text.startsWith('Desktop now shows the Browser.'), 'says what the desktop shows now', plan.text)
  ok(plan.text.includes('In front: [b-3] "Everywhere" https://b-3.example/ (yours).'), 'names the front tab with id, title, url and owner', plan.text)
  ok(plan.text.includes('Open here: [b-1] "Docs" (agent: Zeb) · [b-2] "Mine" (yours) · [b-3] "Everywhere" (yours).'), 'lists the tabs here, owners in words', plan.text)
  ok(plan.text.includes('Other projects: 1 tab — [b-9] "Menu" in Cafe.'), 'counts and names the other projects’ tabs', plan.text)

  const kept = planShowView({ view: 'browser' }, snap({ tabs: [a, b, c, o], front: 'b-1' }))
  ok(kept.frontTab === 'b-1' && kept.text.includes('In front: [b-1]'), 'keeps the current front tab', kept.text)

  const stale = planShowView({ view: 'BROWSER ' }, snap({ tabs: [a, b, o], front: 'b-9' }))
  ok(stale.frontTab === 'b-2', 'a front tab from another project is not kept; the newest here is', stale.frontTab)

  const already = planShowView({ view: 'browser' }, snap({ mode: 'browser', tabs: [a, b], front: 'b-1' }))
  ok(already.ok && already.switchTo === null, 'already on the Browser: no switch', JSON.stringify(already))
  ok(already.text.startsWith('Already showing the Browser. In front: [b-1]'), 'and says so, with the same list', already.text)
  ok(!already.text.includes('Other projects'), 'no other-projects line when there are none', already.text)
}

/* ---------------------------------------------------------------- rule 2 */
console.log('rule 2: no tabs here, some elsewhere')
{
  const o = tab('b-20', 'p2', 'Menu', zeb)
  const plan = planShowView({ view: 'browser' }, snap({ mode: 'board', tabs: [o] }))
  ok(!plan.ok && plan.switchTo === null && plan.switchProject === null && plan.frontTab === null, 'switches nothing, not even the project', JSON.stringify(plan))
  ok(plan.reason === 'none-here', 'reason none-here', plan.reason)
  ok(
    plan.text ===
      'No browser tabs in this project (Forge). The desktop stays on the Board. Other projects: 1 tab — [b-20] "Menu" in Cafe. Call show_view with tab to show one.',
    'the exact words',
    plan.text
  )
}

/* ---------------------------------------------------------------- rule 3 */
console.log('rule 3: no tabs anywhere')
{
  const plan = planShowView({ view: 'browser' }, snap({ tabs: [] }))
  ok(!plan.ok && plan.switchTo === null && plan.reason === 'no-tabs', 'switches nothing', JSON.stringify(plan))
  ok(
    plan.text === 'No browser tabs are open, so there is nothing to show. The desktop stays on Agents. browser_open opens one.',
    'the exact words',
    plan.text
  )
}

/* ---------------------------------------------------------------- rule 4 */
console.log('rule 4: a tab by id')
{
  const a = tab('b-30', 'p1', 'Here')
  const b = tab('b-31', 'p1', 'Also here')
  const o = tab('b-32', 'p2', 'Over there', zeb)
  const tabs = [a, b, o]

  const here = planShowView({ view: 'browser', tab: 'b-30' }, snap({ tabs, front: 'b-31' }))
  ok(here.ok && here.switchTo === 'browser' && here.frontTab === 'b-30' && here.switchProject === null, 'a tab here: switch, that tab in front', JSON.stringify(here))
  ok(here.text.includes('In front: [b-30] "Here"'), 'and it is named as in front', here.text)

  const there = planShowView({ view: 'board', tab: 'b-32' }, snap({ tabs }))
  ok(there.ok && there.switchTo === 'browser', 'tab implies the Browser, whatever view says', JSON.stringify(there))
  ok(there.switchProject === 'p2' && there.frontTab === 'b-32', 'a tab in another project: switch project too', JSON.stringify(there))
  ok(there.text.startsWith('Desktop now shows the Browser, in project Cafe.'), 'and says which project', there.text)
  ok(there.text.includes('In front: [b-32] "Over there" https://b-32.example/ (agent: Zeb).'), 'that tab is in front', there.text)
  ok(there.text.includes('Open here: [b-32]') && there.text.includes('Other projects: 2 tabs — [b-30] "Here" in Forge'), 'lists from the new project’s side', there.text)

  const same = planShowView({ view: 'browser', tab: 'b-31' }, snap({ mode: 'browser', tabs, front: 'b-31' }))
  ok(same.ok && same.switchTo === null && same.text.startsWith('Already showing the Browser.'), 'already that tab: already showing', same.text)

  const other = planShowView({ view: 'browser', tab: 'b-30' }, snap({ mode: 'browser', tabs, front: 'b-31' }))
  ok(other.ok && other.frontTab === 'b-30' && other.text.startsWith('Desktop now shows the Browser.'), 'on the Browser, another tab: brought forward', other.text)

  const missing = planShowView({ view: 'browser', tab: 'b-99' }, snap({ tabs }))
  ok(!missing.ok && missing.switchTo === null && missing.switchProject === null && missing.frontTab === null, 'an unknown id switches nothing', JSON.stringify(missing))
  ok(missing.reason === 'no-such-tab', 'reason no-such-tab', missing.reason)
  ok(
    missing.text === 'No tab b-99. Open tabs: [b-30] "Here" · [b-31] "Also here" · [b-32] "Over there" in Cafe. The desktop stays on Agents.',
    'names the id and lists every open tab',
    missing.text
  )

  const empty = planShowView({ view: 'browser', tab: 'b-99' }, snap({ tabs: [] }))
  ok(empty.reason === 'no-tabs' && empty.text.startsWith('No browser tabs are open'), 'an unknown id with no tabs at all: the rule 3 words', empty.text)
}

/* ---------------------------------------------------------------- rule 5 */
console.log('rule 5: the browser cannot be reached')
{
  const t = [tab('b-40', 'p1', 'X')]
  const unregistered = planShowView({ view: 'browser' }, snap({ surfaces: SURFACES.filter((s) => s.id !== 'browser'), tabs: t }))
  ok(!unregistered.ok && unregistered.switchTo === null && unregistered.reason === 'unavailable', 'no browser surface: no switch', JSON.stringify(unregistered))
  ok(
    unregistered.text ===
      'The Browser view is not available in this Forge right now (the Browser view is not registered). A Forge restart usually fixes it. The desktop stays on Agents.',
    'says so, with the reason',
    unregistered.text
  )

  const stale = planShowView({ view: 'browser' }, snap({ tabs: null, browserProblem: 'its preload is older than the browser' }))
  ok(!stale.ok && stale.switchTo === null, 'stale preload (no tab list): no switch')
  ok(stale.text.includes('(its preload is older than the browser)') && stale.text.includes('A Forge restart usually fixes it.'), 'gives the short reason', stale.text)

  const threw = planShowView({ view: 'browser', tab: 'b-40' }, snap({ tabs: null, browserProblem: 'the tab list failed: boom' }))
  ok(!threw.ok && threw.switchTo === null && threw.text.includes('(the tab list failed: boom)'), 'list() threw: no switch, says why', threw.text)

  const bare = planShowView({ view: 'browser' }, snap({ tabs: null }))
  ok(!bare.ok && /\(the tab list could not be read\)/.test(bare.text), 'no reason given: a default one', bare.text)
}

/* ---------------------------------------------------------------- rule 6 */
console.log('rule 6: the board, the agents, anything else')
{
  const board = planShowView({ view: 'board' }, snap())
  ok(board.ok && board.switchTo === 'board' && board.text === 'Desktop now shows the Board.', 'board', JSON.stringify(board))
  const onBoard = planShowView({ view: 'board' }, snap({ mode: 'board' }))
  ok(onBoard.ok && onBoard.switchTo === null && onBoard.text === 'Already showing the Board.', 'already on the board', onBoard.text)
  const noBoard = planShowView({ view: 'board' }, snap({ mode: 'browser', surfaces: SURFACES.filter((s) => s.id !== 'board') }))
  ok(!noBoard.ok && noBoard.switchTo === null, 'no board surface: no switch')
  ok(noBoard.text === 'The Board is not available in this Forge right now. The desktop stays on the Browser.', 'says so', noBoard.text)

  const agents = planShowView({ view: 'agents' }, snap({ mode: 'read' }))
  ok(agents.ok && agents.switchTo === 'agents' && agents.text === 'Desktop now shows Agents.', 'agents', JSON.stringify(agents))
  const onAgents = planShowView({ view: 'agents' }, snap())
  ok(onAgents.ok && onAgents.switchTo === null && onAgents.text === 'Already showing Agents.', 'already on the agents', onAgents.text)

  const odd = planShowView({ view: 'Terminal' }, snap({ mode: 'read' }))
  ok(!odd.ok && odd.switchTo === null && odd.reason === 'unknown-view', 'unknown view: no switch', JSON.stringify(odd))
  ok(odd.text === 'Unknown view "Terminal". Use agents, browser or board. The desktop stays on the Read view.', 'names it and the three it takes', odd.text)
  const blank = planShowView({}, snap())
  ok(!blank.ok && blank.text.startsWith('Unknown view "".'), 'no view at all: the same words', blank.text)
}

/* ---------------------------------------------------------------- rule 9 */
console.log('rule 9: long titles, long lists')
{
  const long = 'A'.repeat(100)
  const many = Array.from({ length: 12 }, (_, i) => tab(`b-5${String(i).padStart(2, '0')}`, 'p1', i === 11 ? long : `Tab ${i}`))
  const others = Array.from({ length: 10 }, (_, i) => tab(`b-6${String(i).padStart(2, '0')}`, 'p2', `Far ${i}`))
  const plan = planShowView({ view: 'browser' }, snap({ tabs: [...many, ...others] }))
  const quoted = plan.text.match(/In front: \[b-511\] "([^"]*)"/)?.[1] ?? ''
  ok(quoted.length <= 60 && quoted.endsWith('…') && quoted.startsWith('AAAA'), 'a long title is cut to about 60 characters', `${quoted.length}: ${quoted}`)
  const hereList = plan.text.match(/Open here: (.*?)\. Other projects/)?.[1] ?? ''
  ok(hereList.split(' · ').filter((s) => s.startsWith('[')).length === SHOW_VIEW_LIST_MAX, `at most ${SHOW_VIEW_LIST_MAX} tabs here`, hereList)
  ok(hereList.endsWith('+4 more'), 'then "+N more"', hereList)
  ok(plan.text.includes('Other projects: 10 tabs — ') && plan.text.endsWith(' · +2 more.'), 'the other projects are capped the same way', plan.text)
  ok(!plan.text.includes('[b-508]') && plan.text.includes('[b-507]'), 'the first eight are the ones listed')
}

/* --------------------------------------------------------------- rule 10 */
console.log('rule 10: a pane full screen, the Wall, maximise')
{
  // Panes as runShowView builds them: buildActionPanes per project, plus the project.
  const counts = {}
  function pane(paneId, name, project, profileName = 'Claude Code') {
    const number = (counts[project] = (counts[project] ?? 0) + 1)
    return {
      paneId,
      tabId: `t-${paneId}`,
      tabNumber: number,
      tabTitle: name,
      number,
      name,
      profileId: profileName.toLowerCase().split(' ')[0],
      profileName,
      live: true,
      focused: false,
      agent: true,
      lastFocusedAt: 0,
      project
    }
  }
  const zebP = pane('z1', 'Zeb', 'p1')
  const viggo = pane('v1', 'Viggo', 'p1', 'Codex')
  const kira = pane('k1', 'Kira', 'p2')
  const panes = [zebP, viggo, kira]
  const on = (over = {}) => snap({ panes, activePane: 'z1', viewMode: 'tabs', ...over })

  const full = planShowView({ view: 'agents', pane: 'Viggo' }, on({ mode: 'browser', viewMode: 'mosaic' }))
  ok(full.ok && full.revealPane === 'v1' && full.viewMode === 'tabs', 'a pane found: revealed, Full screen by default', JSON.stringify(full))
  ok(full.switchTo === 'agents' && full.switchProject === null && full.frontTab === null, 'and the desktop goes to Agents, same project', JSON.stringify(full))
  ok(full.text === 'Showing Viggo full screen.' && full.maximise === false, 'the exact words; no maximise unasked', full.text)

  const spoken = planShowView({ view: 'agents', pane: 'the codex one' }, on())
  ok(spoken.ok && spoken.revealPane === 'v1' && spoken.viewMode === null, 'the focus_pane_by_name matcher ("the codex one"); already Full screen: layout left', JSON.stringify(spoken))
  const near = planShowView({ view: 'agents', pane: 'Vigo' }, on())
  ok(near.ok && near.revealPane === 'v1', 'a near miss is found the same way', JSON.stringify(near))

  const there = planShowView({ view: 'agents', pane: 'Kira' }, on())
  ok(there.ok && there.switchProject === 'p2' && there.revealPane === 'k1' && there.viewMode === 'tabs', 'a pane in another project: switch project, reveal, set Full screen there', JSON.stringify(there))
  ok(there.text === 'Showing Kira full screen, in project Cafe.', 'and says which project', there.text)

  const missing = planShowView({ view: 'agents', pane: 'Bob' }, on({ mode: 'board' }))
  ok(!missing.ok && missing.reason === 'no-such-pane', 'no such pane: refused', JSON.stringify(missing))
  ok(
    missing.switchTo === null && missing.switchProject === null && missing.revealPane === null && missing.viewMode === null && missing.maximise === false,
    'and nothing changes, the window included',
    JSON.stringify(missing)
  )
  ok(missing.text === 'No pane called "Bob". Panes: Zeb · Viggo · Kira in Cafe. The desktop stays on the Board.', 'names the panes, other projects’ with theirs', missing.text)
  const many = Array.from({ length: 11 }, (_, i) => pane(`m${i}`, `Pane${String.fromCharCode(65 + i)}`, 'p1'))
  const capped = planShowView({ view: 'agents', pane: 'Nobody' }, on({ panes: many }))
  ok(capped.text.startsWith(`No pane called "Nobody". Panes: PaneA · `) && capped.text.includes('PaneH · +3 more.') && !capped.text.includes('PaneI'), `at most ${SHOW_VIEW_LIST_MAX} names, then "+N more"`, capped.text)
  const nothing = planShowView({ view: 'agents', pane: 'Bob' }, on({ panes: [] }))
  ok(!nothing.ok && nothing.text === 'No pane called "Bob". No panes are open. The desktop stays on Agents.', 'no panes at all: says so', nothing.text)

  const active = planShowView({ view: 'agents', layout: 'full' }, on({ activePane: 'v1', viewMode: 'mosaic' }))
  ok(active.ok && active.revealPane === 'v1' && active.viewMode === 'tabs' && active.text === 'Showing Viggo full screen.', 'layout full, no pane: the active pane (the bar’s)', JSON.stringify(active))
  const empty = planShowView({ view: 'agents', layout: 'full' }, on({ panes: [kira], activePane: null }))
  ok(!empty.ok && empty.reason === 'no-panes' && empty.revealPane === null && empty.viewMode === null, 'layout full with no panes here: refused, nothing changes', JSON.stringify(empty))
  ok(empty.text === 'No agent panes are open, so there is nothing to show full screen. The desktop stays on Agents.', 'the exact words', empty.text)

  const wall = planShowView({ view: 'agents', layout: 'wall' }, on({ mode: 'read' }))
  ok(wall.ok && wall.viewMode === 'mosaic' && wall.revealPane === null && wall.switchTo === 'agents', 'layout wall: the mosaic, on Agents', JSON.stringify(wall))
  ok(wall.text === 'Showing the Wall (2 panes).', 'counts the panes in the project', wall.text)
  const wallPane = planShowView({ view: 'agents', layout: 'WALL', pane: 'Viggo' }, on())
  ok(wallPane.ok && wallPane.viewMode === 'mosaic' && wallPane.revealPane === 'v1', 'a pane with the wall: active inside it', JSON.stringify(wallPane))
  const saidWall = planShowView({ view: 'agents', pane: 'the wall' }, on())
  ok(saidWall.ok && saidWall.viewMode === 'mosaic' && saidWall.text === 'Showing the Wall (2 panes).', '"the wall" as the pane: the Wall', JSON.stringify(saidWall))
  const onWall = planShowView({ view: 'agents', layout: 'wall' }, on({ viewMode: 'mosaic' }))
  ok(onWall.ok && onWall.viewMode === null, 'already on the Wall: layout left', JSON.stringify(onWall))
  const noWall = planShowView({ view: 'agents', layout: 'wall' }, on({ panes: [] }))
  ok(!noWall.ok && noWall.reason === 'no-panes' && noWall.viewMode === null, 'the Wall with no panes: refused', noWall.text)

  const noView = planShowView({ pane: 'Zeb' }, on({ mode: 'board' }))
  ok(noView.ok && noView.switchTo === 'agents' && noView.revealPane === 'z1', 'a pane with no view: Agents', JSON.stringify(noView))
  for (const [req, label] of [
    [{ view: 'browser', pane: 'Zeb' }, 'browser + pane'],
    [{ view: 'board', layout: 'wall' }, 'board + layout'],
    [{ view: 'agents', tab: 'b-1', pane: 'Zeb' }, 'tab + pane']
  ]) {
    const r = planShowView(req, on())
    ok(
      !r.ok && r.reason === 'agents-only' && r.text === 'Use view agents with pane or layout. The desktop stays on Agents.' && r.switchTo === null && r.revealPane === null,
      `${label}: refused, nothing changes`,
      JSON.stringify(r)
    )
  }
  const odd = planShowView({ view: 'agents', layout: 'grid' }, on())
  ok(!odd.ok && odd.text.startsWith('Unknown layout "grid". Use full or wall.'), 'an unknown layout: refused', odd.text)
  const board = planShowView({ view: 'agents', pane: 'the board' }, on())
  ok(!board.ok && board.reason === 'no-such-pane' && board.text.includes('For the Board, use view board.'), '"the board" as a pane: refused, pointed at view board', board.text)

  const big = planShowView({ view: 'agents', pane: 'Zeb', maximise: true }, on())
  ok(big.ok && big.maximise === true, 'maximise passes through with a pane', JSON.stringify(big))
  const bigBoard = planShowView({ view: 'board', maximise: true }, on())
  ok(bigBoard.ok && bigBoard.maximise === true && bigBoard.switchTo === 'board', 'and with any view', JSON.stringify(bigBoard))
  const loose = planShowView({ view: 'agents', maximise: 'yes' }, on())
  ok(loose.ok && loose.maximise === false, 'only maximise true maximises', JSON.stringify(loose))

  ok(AWAY_NOTE === 'Forge is minimised, so this is not on screen. Use show_view to bring it up.', 'the minimised note, word for word', AWAY_NOTE)
  ok(forgeIsAway() === false, 'headless (no window): never minimised')
}

/* ------------------------------------------------------------- the tool */
console.log('the tool, everywhere it is offered')
{
  ok(specs.MAIN_AGENT_TOOL_NAMES.includes('show_view'), 'show_view is in the shared tool names (every brain)')
  const spec = specs.MAIN_AGENT_TOOL_SPECS.find((t) => t.name === 'show_view')
  ok(!!spec && JSON.stringify(spec.parameters.required) === '["view"]', 'the shared spec takes view (required) and tab', JSON.stringify(spec?.parameters))
  ok(JSON.stringify(spec?.parameters.properties.view.enum) === '["agents","browser","board"]', 'view is one of agents, browser, board')
  ok(spec?.description.includes('Use only when Steve asks to see something; never on your own.'), 'the description says: only on his ask', spec?.description)
  ok(spec?.description.includes('Brings Forge back if it is minimised.'), 'and that it brings Forge back', spec?.description)
  const props = spec?.parameters.properties ?? {}
  ok(props.pane?.type === 'string' && JSON.stringify(props.layout?.enum) === '["full","wall"]' && props.maximise?.type === 'boolean', 'it takes pane, layout (full or wall) and maximise', JSON.stringify(props))

  const bridge = APP.APP_TOOLS.find((t) => t.name === 'show_view')
  ok(!!bridge, 'show_view is a forge-bridge APP_TOOLS tool (pane agents)')
  ok(bridge?.description === spec?.description, 'its description is the shared one, word for word', bridge?.description)
  ok(JSON.stringify(bridge?.inputSchema) === JSON.stringify(spec?.parameters), 'its schema is the shared one')
  ok(typeof APP.APP_HANDLERS.show_view === 'function', 'and it has a handler')
  ok(APP.APP_TOOLS[0].name === 'open_agent_pane', 'open_agent_pane stays first')

  const { readFileSync } = await import('node:fs')
  const service = readFileSync(new URL('../electron/browser-panes/service.ts', import.meta.url), 'utf8')
  const ops = service.match(/export const APP_LINK_OPS[^\n]*/)?.[0] ?? ''
  ok(/'show_view'/.test(ops), 'main lets show_view through the pipe (APP_LINK_OPS)', ops)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

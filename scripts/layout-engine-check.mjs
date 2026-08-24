/**
 * The split tree, performed in the main process.
 *
 *   node scripts/layout-engine-check.mjs
 *
 * electron/layout-engine.ts is the answer to a failure that actually happened:
 * every layout operation a phone or a browser sent used to be forwarded into
 * the desktop renderer, so a window that had crashed, hung or gone blank turned
 * every tap on the phone into "The desktop did not answer in time" — with
 * nobody in the building to fix it. Main performs them itself now, which means
 * the arithmetic of the tree has a second implementation site, and this file is
 * what stops it from becoming a second implementation.
 *
 * Driven head-less through node:module's type-stripping hook (the trick
 * scripts/mosaic-check.mjs uses) rather than through esbuild, because the
 * engine is Electron-free on purpose: its store, its disk and its project rail
 * all arrive as injected functions, so the *shipped* class can be run here over
 * a seeded workspace rather than a stand-in written to agree with it.
 *
 * What is asserted: every verb in the vocabulary, both refusals and successes;
 * that a closed pane names the PTY the host must kill and leaves the focus on
 * its neighbour; that a closed tab hands over to the tab on its left; that a
 * split goes the way it was asked to; that the caps still cap; that every
 * result would load again (`isValidLayout`); that one applied op is exactly one
 * write to disk and a refusal is none; and that a workspace the desk saved
 * under the engine's feet is the one the next op applies to.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { LayoutEngine, UNSUPPORTED } = await import('../electron/layout-engine.ts')
const { collectLeaves, countLeaves, isValidLayout, makeLeaf, splitLeaf } = await import('../shared/splitTree.ts')
const { MAX_PANES_PER_TAB, MAX_SESSIONS, MAX_TABS_PER_PROJECT } = await import('../shared/ipc.ts')

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

const PROJECTS = [
  { id: 'p1', name: 'Forge', defaultProfileId: 'shell' },
  { id: 'p2', name: 'Other', defaultProfileId: 'claude' }
]

/** A tab of `panes` leaves, split rightwards, with fixed ids a check can name. */
function seedTab(id, prefix, panes, title = id) {
  let root = { ...makeLeaf('shell', ''), id: `${prefix}1` }
  for (let i = 2; i <= panes; i++) {
    root = splitLeaf(root, `${prefix}${i - 1}`, 'row', { ...makeLeaf('shell', ''), id: `${prefix}${i}` })
  }
  return { id, title, root, activePaneId: `${prefix}1`, textColor: '#C6FF4A' }
}

/**
 * Two tabs, three panes: the smallest workspace in which "the pane beside it"
 * and "the tab to its left" both mean something.
 */
function seed() {
  return {
    tabs: [seedTab('t1', 'a', 2, 'Otis'), seedTab('t2', 'b', 1, 'Pearl')],
    activeTabId: 't1',
    viewMode: 'tabs',
    nameCursor: 0,
    mosaic: { mode: 'custom', tiles: { a1: { x: 0, y: 0, w: 400, h: 300 }, a2: { x: 400, y: 0, w: 400, h: 300 } }, wallTabs: ['t1'] }
  }
}

/** An engine over a fresh seed, recording every write it makes. */
function engineOver(workspaces = { p1: seed() }, projects = PROJECTS) {
  const saves = []
  const disk = { ...workspaces }
  const engine = new LayoutEngine({
    load: (projectId) => disk[projectId] ?? null,
    save: (projectId, workspace) => {
      saves.push({ projectId, workspace })
      disk[projectId] = workspace
    },
    projects: () => projects
  })
  return { engine, saves, disk }
}

const tabOf = (ws, id) => ws.tabs.find((t) => t.id === id)
const paneIds = (ws, tabId) => collectLeaves(tabOf(ws, tabId).root).map((l) => l.id)
/** Every result that says ok must be a workspace that would load again. */
const loadable = (ws) => ws.tabs.every((t) => isValidLayout(t.root))

/* ------------------------------------------------------------- the refusals */

console.log('\nrefusals')
{
  const { engine, saves } = engineOver()
  const gone = engine.apply('nope', { op: 'select-tab', projectId: 'nope', tabId: 't1' })
  ok(gone.ok === false && /no longer open/.test(gone.error), 'a project this desktop does not have is refused', gone.error)

  const verb = engine.apply('p1', { op: 'dance', projectId: 'p1' })
  ok(verb.ok === false && verb.error === 'Forge does not know that command.', 'an unknown verb is refused', verb.error)

  const project = engine.apply('p1', { op: 'select-project', projectId: 'p1' })
  ok(
    project.ok === false && project.error === UNSUPPORTED,
    'select-project comes back UNSUPPORTED, so the host falls back to the renderer that owns which project is on screen',
    String(project.error)
  )

  const pane = engine.apply('p1', { op: 'close-pane', projectId: 'p1', paneId: 'not-a-pane' })
  ok(pane.ok === false && /gone/.test(pane.error), 'closing a pane that is not in the layout is refused', pane.error)

  const split = engine.apply('p1', { op: 'create-pane', projectId: 'p1', paneId: 'not-a-pane' })
  ok(split.ok === false && /gone/.test(split.error), 'splitting a pane that is not in the layout is refused', split.error)

  const tab = engine.apply('p1', { op: 'close-tab', projectId: 'p1', tabId: 'not-a-tab' })
  ok(tab.ok === false && /gone/.test(tab.error), 'closing a tab that is not in the layout is refused', tab.error)

  const unnamed = engine.apply('p1', { op: 'close-pane', projectId: 'p1' })
  ok(unnamed.ok === false && unnamed.error === 'No pane named.', 'an op that names no pane is refused', unnamed.error)

  ok(saves.length === 0, 'and not one refusal wrote anything to disk', `${saves.length} write(s)`)
}

/* ------------------------------------------------------------- select-tab */

console.log('\nselect-tab')
{
  const { engine, saves } = engineOver()
  const r = engine.apply('p1', { op: 'select-tab', projectId: 'p1', tabId: 't2' })
  ok(r.ok === true && r.workspace.activeTabId === 't2', 'brings the named tab to the front')
  ok(r.ok === true && r.killed.length === 0, 'and kills nothing')
  ok(saves.length === 1 && saves[0].projectId === 'p1', 'one applied op is exactly one write', `${saves.length} write(s)`)
  ok(loadable(r.workspace), 'the result would load again')
}

/* -------------------------------------------------------------- create-tab */

console.log('\ncreate-tab')
{
  const { engine, saves } = engineOver()
  const r = engine.apply('p1', { op: 'create-tab', projectId: 'p1', profileId: 'claude' })
  ok(r.ok === true && r.workspace.tabs.length === 3, 'adds a tab')
  const made = r.ok ? r.workspace.tabs[2] : null
  ok(made !== null && r.workspace.activeTabId === made.id, 'and brings it to the front')
  ok(made !== null && countLeaves(made.root) === 1 && collectLeaves(made.root)[0].profileId === 'claude', 'with one pane, running the profile the client named')
  ok(made !== null && made.title !== '' && made.title !== 'Otis' && made.title !== 'Pearl', 'named out of the pool, skipping the names already in use', made?.title)
  ok(r.ok === true && (r.workspace.nameCursor ?? 0) > 0, 'and the project name cursor moved on', String(r.workspace.nameCursor))
  ok(made !== null && typeof made.textColor === 'string' && made.textColor !== '#C6FF4A', 'wearing a terminal colour nobody in the project has', made?.textColor)
  ok(loadable(r.workspace) && saves.length === 1, 'one write, and the result would load again')

  // No profile named: the project's own default, exactly as the renderer's
  // handler falls back.
  const bare = engineOver().engine.apply('p1', { op: 'create-tab', projectId: 'p1' })
  ok(
    bare.ok === true && collectLeaves(bare.workspace.tabs[2].root)[0].profileId === 'shell',
    "a tab with no profile named opens on the project's default"
  )

  // The per-open permission override is wire data: checked, never cast.
  const modes = engineOver().engine.apply('p1', { op: 'create-tab', projectId: 'p1', permissionMode: 'bypass' })
  ok(
    modes.ok === true && collectLeaves(modes.workspace.tabs[2].root)[0].permissionMode === 'bypass',
    'a permission mode off the wire lands on the new pane'
  )
  const junk = engineOver().engine.apply('p1', { op: 'create-tab', projectId: 'p1', permissionMode: 'sudo' })
  ok(
    junk.ok === true && collectLeaves(junk.workspace.tabs[2].root)[0].permissionMode === undefined,
    'and one that is not a permission mode is dropped rather than carried'
  )
}

/* ------------------------------------------------------------- create-pane */

console.log('\ncreate-pane')
{
  const { engine } = engineOver()
  const r = engine.apply('p1', { op: 'create-pane', projectId: 'p1', paneId: 'a1', direction: 'column' })
  ok(r.ok === true && paneIds(r.workspace, 't1').length === 3, 'splits the named pane')
  const root = r.ok ? tabOf(r.workspace, 't1').root : null
  ok(root && root.type === 'split' && root.a.type === 'split' && root.a.direction === 'column', 'the way it was asked to — column, beneath', root?.a?.direction)
  const made = r.ok ? paneIds(r.workspace, 't1').find((id) => id !== 'a1' && id !== 'a2') : null
  ok(made !== null && tabOf(r.workspace, 't1').activePaneId === made, 'and the new pane takes the focus ring')
  ok(loadable(r.workspace), 'the result would load again')

  const sideways = engineOver().engine.apply('p1', { op: 'create-pane', projectId: 'p1', paneId: 'a1' })
  const sidewaysRoot = sideways.ok ? tabOf(sideways.workspace, 't1').root : null
  ok(sidewaysRoot?.a?.direction === 'row', 'a split with no direction named goes beside, like the desktop button', sidewaysRoot?.a?.direction)

  // The phone sends no pane id at all when it means "split what I am looking
  // at", which is the active tab's focused pane.
  const implied = engineOver().engine.apply('p1', { op: 'create-pane', projectId: 'p1' })
  ok(
    implied.ok === true && paneIds(implied.workspace, 't1').length === 3,
    "no pane named splits the active tab's focused pane"
  )

  // The per-tab ceiling, which the renderer only ever reported as a notice on
  // a screen the phone cannot see.
  const full = engineOver({ p1: { tabs: [seedTab('t1', 'a', MAX_PANES_PER_TAB)], activeTabId: 't1' } })
  const refused = full.engine.apply('p1', { op: 'create-pane', projectId: 'p1', paneId: 'a1' })
  ok(
    refused.ok === false && refused.error === `That tab already holds its ${MAX_PANES_PER_TAB} panes.`,
    'a tab already holding its panes refuses another, in words the phone can show',
    String(refused.error)
  )
}

/* -------------------------------------------------------------- close-pane */

console.log('\nclose-pane')
{
  const { engine, saves } = engineOver()
  const r = engine.apply('p1', { op: 'close-pane', projectId: 'p1', paneId: 'a2' })
  ok(r.ok === true && r.killed.length === 1 && r.killed[0] === 'a2', 'names the pane whose PTY the host must kill', String(r.killed))
  ok(r.ok === true && paneIds(r.workspace, 't1').join() === 'a1', 'and the pane is out of the tree')
  ok(r.ok === true && tabOf(r.workspace, 't1').activePaneId === 'a1', 'the focus lands on the neighbour it left behind')
  ok(r.ok === true && r.workspace.mosaic.tiles.a2 === undefined && r.workspace.mosaic.tiles.a1 !== undefined, 'and the dead pane loses its box on the mosaic wall')
  ok(saves.length === 1 && loadable(r.workspace), 'one write, and the result would load again')

  // Closing the last pane of a tab closes the tab — the reducer's rule, and the
  // reason a × on a lone pane does not leave an empty tab behind.
  const lone = engineOver()
  const gone = lone.engine.apply('p1', { op: 'close-pane', projectId: 'p1', paneId: 'b1' })
  ok(gone.ok === true && gone.workspace.tabs.length === 1 && tabOf(gone.workspace, 't2') === undefined, 'closing the last pane of a tab closes the tab')
  ok(gone.ok === true && gone.killed.join() === 'b1', 'and still names the pane to kill', String(gone.killed))
}

/* --------------------------------------------------------------- close-tab */

console.log('\nclose-tab')
{
  const { engine, saves } = engineOver()
  const r = engine.apply('p1', { op: 'close-tab', projectId: 'p1', tabId: 't1' })
  ok(r.ok === true && r.workspace.tabs.length === 1 && tabOf(r.workspace, 't2') !== undefined, 'takes the tab out')
  ok(r.ok === true && r.killed.join() === 'a1,a2', 'and names every pane that went with it', String(r.killed))
  ok(r.ok === true && r.workspace.activeTabId === 't2', 'the tab that takes over is the one now on its left')
  ok(r.ok === true && r.workspace.mosaic.mode === 'auto', 'a wall left with nothing on it goes back to the auto grid')
  ok(saves.length === 1 && loadable(r.workspace), 'one write, and the result would load again')

  // Closing a tab that is *not* the one on screen leaves the front alone.
  const other = engineOver().engine.apply('p1', { op: 'close-tab', projectId: 'p1', tabId: 't2' })
  ok(other.ok === true && other.workspace.activeTabId === 't1', 'closing a tab nobody is looking at does not move the front')

  // Three tabs, middle one closed while it is the active one: the eye is
  // already at its left-hand edge, so that is where the front goes.
  const three = engineOver({
    p1: { tabs: [seedTab('t0', 'z', 1), seedTab('t1', 'a', 2), seedTab('t2', 'b', 1)], activeTabId: 't1' }
  })
  const middle = three.engine.apply('p1', { op: 'close-tab', projectId: 'p1', tabId: 't1' })
  ok(middle.ok === true && middle.workspace.activeTabId === 't0', 'and the tab to the left takes over, not the first one', String(middle.ok && middle.workspace.activeTabId))
}

/* -------------------------------------------------------------- focus-pane */

console.log('\nfocus-pane')
{
  const { engine } = engineOver()
  const r = engine.apply('p1', { op: 'focus-pane', projectId: 'p1', paneId: 'b1' })
  ok(r.ok === true && r.workspace.activeTabId === 't2', 'reaches across tabs — the tab holding the pane comes to the front')
  ok(r.ok === true && tabOf(r.workspace, 't2').activePaneId === 'b1', 'and the ring lands on the pane itself')
  ok(r.ok === true && r.killed.length === 0 && loadable(r.workspace), 'nothing killed, and the result would load again')
}

/* ------------------------------------------------------------------ limits */

console.log('\nlimits')
{
  const tabs = []
  for (let i = 0; i < MAX_TABS_PER_PROJECT; i++) tabs.push(seedTab(`t${i}`, `p${i}`, 1))
  const { engine } = engineOver({ p1: { tabs, activeTabId: 't0' } })
  const r = engine.apply('p1', { op: 'create-tab', projectId: 'p1' })
  ok(
    r.ok === false && r.error === `That project already holds its ${MAX_TABS_PER_PROJECT} tabs.`,
    'a project already holding its tabs refuses another',
    String(r.error)
  )

  // MAX_SESSIONS counts panes across *every* project, which is why the engine
  // is given the rail rather than one workspace: half the desktop's panes here
  // are in a project the op does not name.
  const full = (prefix) => {
    const out = []
    for (let i = 0; i < MAX_TABS_PER_PROJECT; i++) out.push(seedTab(`${prefix}t${i}`, `${prefix}${i}`, MAX_PANES_PER_TAB))
    return { tabs: out, activeTabId: `${prefix}t0` }
  }
  const both = engineOver({ p1: full('x'), p2: full('y') })
  const panes = PROJECTS.reduce(
    (n, p) => n + both.engine.workspace(p.id).tabs.reduce((m, t) => m + countLeaves(t.root), 0),
    0
  )
  ok(panes === MAX_SESSIONS, `the two seeded projects hold exactly MAX_SESSIONS panes between them (${panes})`)
  const refused = both.engine.apply('p1', { op: 'create-pane', projectId: 'p1', paneId: 'x01' })
  ok(
    refused.ok === false && refused.error === `Forge is at its ${MAX_SESSIONS}-session limit.`,
    'and a full Forge refuses another pane, counting the project the op did not name',
    String(refused.error)
  )
}

/* ------------------------------------------------- staying in step with the desk */

console.log('\nreplace')
{
  const { engine, saves } = engineOver()
  // The desk splits a pane and persists it. Without `replace`, the engine would
  // still be holding the layout it read at boot, and the phone's next op would
  // silently undo the split.
  const atDesk = seed()
  atDesk.tabs[1] = seedTab('t2', 'b', 2, 'Pearl')
  engine.replace('p1', atDesk)
  const r = engine.apply('p1', { op: 'close-pane', projectId: 'p1', paneId: 'b2' })
  ok(r.ok === true && paneIds(r.workspace, 't2').join() === 'b1', 'an op after replace() applies to the workspace the desk saved')
  ok(r.ok === true && r.killed.join() === 'b2', 'and kills the pane that was in it', String(r.killed))

  const stale = engineOver().engine.apply('p1', { op: 'close-pane', projectId: 'p1', paneId: 'b2' })
  ok(stale.ok === false, 'while the same op against the layout on disk is refused, because that pane is not in it')
  ok(saves.length === 1, 'and replace() itself wrote nothing — it adopts, it does not persist', `${saves.length} write(s)`)
}

/* ------------------------------------------------------- a project with nothing in it */

console.log('\nan empty project')
{
  const { engine } = engineOver({})
  const r = engine.apply('p2', { op: 'create-tab', projectId: 'p2' })
  ok(r.ok === true && r.workspace.tabs.length === 1, 'a project nobody has opened a terminal in yet takes its first tab')
  ok(r.ok === true && collectLeaves(r.workspace.tabs[0].root)[0].profileId === 'claude', "on that project's own default profile")
  const nothing = engineOver({}).engine.apply('p2', { op: 'create-pane', projectId: 'p2' })
  ok(nothing.ok === false && nothing.error === 'There is no pane open to split.', 'and there is nothing in it to split', String(nothing.error))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

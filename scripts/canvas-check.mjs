/**
 * Check for the hub backends: the canvas board, pane call-signs, saved
 * prompts and the keymap registry.
 *
 *   node scripts/canvas-check.mjs
 *
 * Everything here runs against a throwaway data dir in the temp folder — a
 * real one, with real files and a real fs.watch — never Steve's profile. The
 * Electron-only corner (which folder a pane's FORGE_CANVAS_DIR points at) is
 * driven through a stub `electron` module, the way web-check does it.
 */
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ELECTRON_STUB = 'data:text/javascript,' + encodeURIComponent(
  [
    'export const app = { getPath: () => process.env.FORGE_DATA_DIR, getVersion: () => "0.0.0-check", isPackaged: false, on: () => {} }',
    'export const ipcMain = { handle: () => {}, on: () => {} }',
    'export const BrowserWindow = { getAllWindows: () => [] }',
    'export const shell = { openPath: async () => "" }',
    'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) }'
  ].join('\n')
)

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    const importer = String(context.parentURL ?? '')
    if (!importer.includes('/node_modules/') && spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const root = mkdtempSync(join(tmpdir(), 'forge-canvas-check-'))
process.env.FORGE_DATA_DIR = root

const hub = await import('../shared/hub.ts')
const { CanvasBoard, BridgeOutFeed } = await import('../electron/canvas-board.ts')
const { HubStore } = await import('../electron/hub-store.ts')
const nav = await import('../src/lib/hubnav.ts')
const km = await import('../src/lib/keymap.ts')
const { BUILTIN_COMMANDS } = await import('../src/lib/shortcutCommands.ts')

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Resolve with the first change matching `pred`, or null after `ms`. */
function waitFor(events, pred, ms = 4000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const hit = events.find(pred)
      if (hit) return resolve(hit)
      if (Date.now() - started > ms) return resolve(null)
      setTimeout(tick, 25)
    }
    tick()
  })
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex')

try {
  /* ------------------------------------------------------------ watcher */

  console.log('\ncanvas board — watcher')
  const events = []
  const board = new CanvasBoard({ root: join(root, 'canvas'), debounceMs: 60, onChange: (c) => events.push(c) })
  const dir = board.dirFor('proj-a')
  ok(dir === join(root, 'canvas', 'proj-a'), 'one folder per project under <dataDir>/canvas', dir)
  ok(board.list('proj-a').items.length === 0, 'a new board is empty')
  board.watch()
  await sleep(150)

  writeFileSync(join(dir, 'hero.png'), PNG)
  const added = await waitFor(events, (c) => c.projectId === 'proj-a' && c.added.includes('hero.png'))
  ok(Boolean(added), 'a file a CLI saves into the folder arrives as an add event')
  ok(added?.snapshot.items[0]?.kind === 'image' && added?.snapshot.items[0]?.title === 'hero', 'it is an image titled from its name', JSON.stringify(added?.snapshot.items[0]))

  writeFileSync(join(dir, 'notes.exe'), 'x')
  writeFileSync(join(dir, '.draft.png.tmp'), PNG)
  writeFileSync(join(dir, 'clip.mp4'), Buffer.alloc(64))
  const clip = await waitFor(events, (c) => c.added.includes('clip.mp4'))
  ok(Boolean(clip), 'a clip arrives too')
  ok(clip && !clip.snapshot.items.some((i) => i.id === 'notes.exe' || i.id.includes('.tmp')), 'non-board files and dot-tmp files are ignored', JSON.stringify(clip?.snapshot.items.map((i) => i.id)))

  events.length = 0
  rmSync(join(dir, 'hero.png'))
  const removed = await waitFor(events, (c) => c.removed.includes('hero.png'))
  ok(Boolean(removed), 'deleting a file arrives as a remove event')
  ok(removed && !removed.snapshot.items.some((i) => i.id === 'hero.png'), 'and it is gone from the board')

  events.length = 0
  writeFileSync(join(dir, 'a.png'), PNG)
  writeFileSync(join(dir, 'a.png'), Buffer.concat([PNG, PNG]))
  writeFileSync(join(dir, 'a.png'), Buffer.concat([PNG, PNG, PNG]))
  await sleep(400)
  ok(events.filter((c) => c.added.includes('a.png')).length === 1, 'a burst of writes to one file is one add (debounced)', String(events.length))

  /* --------------------------------------------------------- post/layout */

  console.log('\ncanvas board — post, layout, read')
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'mock.png'), PNG)
  const posted = board.post('proj-a', join(outside, 'mock.png'), 'Landing hero: dark')
  ok(posted.ok && posted.item.id === 'Landing hero dark.png', 'post copies the file in under a safe title-based name', JSON.stringify(posted))
  ok(existsSync(join(outside, 'mock.png')), 'the original is left where it was')
  ok(posted.ok && posted.item.title === 'Landing hero: dark', 'the title is kept verbatim for display')
  const again = board.post('proj-a', join(outside, 'mock.png'), 'Landing hero: dark')
  ok(again.ok && again.item.id === 'Landing hero dark -2.png', 'posting twice never overwrites', JSON.stringify(again))
  ok(!board.post('proj-a', join(outside, 'nope.png')).ok, 'posting a missing file is refused')
  writeFileSync(join(outside, 'x.exe'), 'x')
  ok(!board.post('proj-a', join(outside, 'x.exe')).ok, 'posting a non-board type is refused')

  const ids = board.list('proj-a').items.map((i) => i.id)
  const reversed = [...ids].reverse()
  board.layout('proj-a', { order: reversed, placements: { [ids[0]]: { x: 10, y: 20, w: 300, h: 200 } } })
  const fresh = new CanvasBoard({ root: join(root, 'canvas') })
  const reread = fresh.list('proj-a')
  ok(JSON.stringify(reread.items.map((i) => i.id)) === JSON.stringify(reversed), 'order persists across a restart', JSON.stringify(reread.items.map((i) => i.id)))
  ok(reread.items.find((i) => i.id === ids[0])?.placement?.w === 300, 'placements persist across a restart')
  ok(existsSync(join(root, 'canvas', 'proj-a.board.json')) && !existsSync(join(dir, 'proj-a.board.json')), 'the board file sits beside the folder, not in it')
  const pendingRead = board.read('proj-a', 'clip.mp4')
  ok(pendingRead instanceof Promise, 'read is asynchronous (a big clip never blocks main)')
  const readBack = await pendingRead
  ok(readBack?.mime === 'video/mp4' && readBack.bytes.length === 64, 'read returns bytes and the mime type')
  ok((await board.read('proj-a', '../proj-a.board.json')) === null, 'read refuses anything outside the folder')
  ok((await board.read('proj-a', 'missing.png')) === null, 'read of a missing file is null, not a throw')
  ok(!board.remove('proj-a', '..'), 'remove refuses anything outside the folder')
  ok(board.remove('proj-a', 'clip.mp4') && !existsSync(join(dir, 'clip.mp4')), 'remove deletes the file')

  /* ------------------------------------------------------ one size limit */

  console.log('\ncanvas board — one size limit for posting and showing')
  const canvasMod = await import('../electron/canvas-board.ts')
  const MB256 = 256 * 1024 * 1024
  ok(canvasMod.CANVAS_MAX_BYTES === MB256, 'the board limit is 256 MB', String(canvasMod.CANVAS_MAX_BYTES))
  ok(
    canvasMod.CANVAS_POST_MAX_BYTES === canvasMod.CANVAS_MAX_BYTES && canvasMod.CANVAS_READ_MAX_BYTES === canvasMod.CANVAS_MAX_BYTES,
    'post and read use the same limit (nothing can be posted that will not show)'
  )
  const bridgeSrc = readFileSync(new URL('../bridge/canvas-tools.mjs', import.meta.url), 'utf8')
  ok(/const MAX_BYTES = 256 \* 1024 \* 1024\b/.test(bridgeSrc), "the bridge's show_on_board limit is the same 256 MB")
  const boardSrc = readFileSync(new URL('../src/components/hub/BoardSurface.tsx', import.meta.url), 'utf8')
  ok(/export const BOARD_MAX_BYTES = 256 \* 1024 \* 1024\b/.test(boardSrc), "the Board's own limit is the same 256 MB")
  ok(/if \(tooBig\)[\s\S]{0,80}Too big to show/.test(boardSrc) && /if \(failed\)[\s\S]{0,80}Could not load/.test(boardSrc), 'a tile says "too big" or "could not load" instead of waiting forever')
  const big = join(outside, 'huge.mp4')
  writeFileSync(big, '')
  truncateSync(big, MB256 + 1)
  const bigPost = board.post('proj-a', big)
  ok(!bigPost.ok && /256 MB/.test(bigPost.error), 'main refuses to post a file over the limit, and says the limit', JSON.stringify(bigPost))
  process.env.FORGE_CANVAS_DIR = join(root, 'canvas', 'proj-bridge')
  const bridgeTools = await import('../bridge/canvas-tools.mjs')
  const bridgeBig = bridgeTools.postToCanvas(big)
  ok(!bridgeBig.ok && /256 MB/.test(bridgeBig.error), 'the bridge refuses it too, and says the limit', JSON.stringify(bridgeBig))
  const justUnder = join(outside, 'edge.mp4')
  writeFileSync(justUnder, '')
  truncateSync(justUnder, 1024)
  ok(bridgeTools.postToCanvas(justUnder).ok, 'the bridge still posts a file under the limit')
  delete process.env.FORGE_CANVAS_DIR
  writeFileSync(join(dir, 'dropped-in.mp4'), '')
  truncateSync(join(dir, 'dropped-in.mp4'), MB256 + 1)
  ok((await board.read('proj-a', 'dropped-in.mp4')) === null, 'a file saved straight into the folder over the limit is not read')
  rmSync(join(dir, 'dropped-in.mp4'))
  rmSync(big)

  /* -------------------------------------------------------- bridge-out */

  console.log('\ncanvas board — bridge-out feed')
  const out = join(root, 'bridge-out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'old.png'), Buffer.from('old'))
  let active = 'proj-b'
  const feed = new BridgeOutFeed({ dir: out, board, activeProject: () => active, settleMs: 80 })
  feed.start()
  await sleep(100)
  writeFileSync(join(out, 'forge-image-1.png.tmp'), Buffer.from('fresh-image'))
  renameSync(join(out, 'forge-image-1.png.tmp'), join(out, 'forge-image-1.png'))
  await sleep(700)
  ok(existsSync(join(root, 'canvas', 'proj-b', 'forge-image-1.png')), 'new voice-made media is posted to the open project')
  ok(!existsSync(join(root, 'canvas', 'proj-b', 'old.png')), 'files already in bridge-out at start are left alone')
  // A pane's bridge already copied this one into proj-a; it must not be posted again.
  writeFileSync(join(dir, 'pane-made.png'), Buffer.from('pane-image'))
  writeFileSync(join(out, 'forge-image-2.png'), Buffer.from('pane-image'))
  await sleep(700)
  ok(!existsSync(join(root, 'canvas', 'proj-b', 'forge-image-2.png')), 'media already on a board (a pane posted it) is not posted twice')
  active = null
  writeFileSync(join(out, 'forge-image-3.png'), Buffer.from('no-project'))
  await sleep(700)
  ok(!existsSync(join(root, 'canvas', 'proj-b', 'forge-image-3.png')), 'with no project open nothing is posted')
  feed.close()
  board.close()

  /* --------------------------------------------------------- call-signs */

  console.log('\ncall-signs')
  const store = new HubStore(root)
  const first = store.syncCallSigns('proj-a', ['p1', 'p2', 'p3'], true)
  const names = Object.values(first.map)
  ok(first.map.p1 === 'Everest' && first.map.p2 === 'Skylar' && first.map.p3 === 'Vega', 'new panes get names from the pool, in pool order', JSON.stringify(first.map))
  ok(new Set(names.map(hub.callSignKey)).size === names.length, 'names are unique in a project')
  ok(!store.syncCallSigns('proj-a', ['p1', 'p2', 'p3'], true).changed, 'a second sync with the same panes changes nothing')
  const other = store.syncCallSigns('proj-b', ['q1'], true)
  ok(other.map.q1 === 'Everest', 'each project has its own names')
  const reopened = new HubStore(root)
  ok(JSON.stringify(reopened.getCallSigns('proj-a')) === JSON.stringify(first.map), 'names persist across a restart')
  ok(!reopened.syncCallSigns('proj-a', [], false).changed, 'an unloaded workspace (no prune) never drops names')
  const pruned = reopened.syncCallSigns('proj-a', ['p1', 'p3', 'p4'], true)
  ok(!pruned.map.p2 && pruned.map.p4 === 'Skylar', 'a closed pane frees its name for the next one', JSON.stringify(pruned.map))
  const renamed = reopened.renameCallSign('proj-a', 'p1', '  Summit   Two ')
  ok(renamed.ok && renamed.map.p1 === 'Summit Two', 'rename trims and keeps it', JSON.stringify(renamed))
  ok(!reopened.renameCallSign('proj-a', 'p3', 'summit two').ok, 'rename refuses a name another pane has (any case)')
  ok(!reopened.renameCallSign('proj-a', 'p3', '4').ok, 'rename refuses a bare number (it would clash with "panel 4")')
  ok(!reopened.renameCallSign('proj-a', 'p3', 'canvas').ok, 'rename refuses a word the resolver owns')
  ok(!reopened.renameCallSign('proj-a', 'p3', '').ok, 'rename refuses an empty name')
  ok(new HubStore(root).getCallSigns('proj-a').p1 === 'Summit Two', 'a rename persists')
  const many = hub.assignCallSigns({}, Array.from({ length: hub.CALL_SIGN_POOL.length + 3 }, (_, i) => `x${i}`))
  const manyNames = Object.values(many.map)
  ok(new Set(manyNames.map(hub.callSignKey)).size === manyNames.length && manyNames.includes('Everest 2'), 'past the pool it counts on, still unique')

  /* ----------------------------------------------------------- resolver */

  console.log('\nresolver')
  // Each terminal has one name, its tab's (shared/terminal-names.ts).
  const pane = (n, id, name, profileName, focused = false) => ({
    paneId: id, tabId: `t${n}`, tabNumber: n, tabTitle: name, number: n, name, profileId: profileName.toLowerCase(),
    profileName, live: true, focused, agent: true, lastFocusedAt: 0
  })
  const panes = [
    pane(1, 'p1', 'Everest', 'Claude Code', true),
    pane(2, 'p2', 'Skylar', 'Codex'),
    pane(3, 'p3', 'Vega', 'Gemini'),
    pane(4, 'p4', 'Orion', 'Claude Code')
  ]
  const r = (s) => nav.resolveNavTarget(s, panes, 'p1')
  const hitId = (t) => (t.kind === 'pane' ? t.pane.paneId : t.kind)
  ok(hitId(r('go to panel 4')) === 'p4', '"go to panel 4" → panel 4', JSON.stringify(r('go to panel 4')))
  ok(hitId(r('go to panel four')) === 'p4', '"go to panel four" → panel 4')
  ok(hitId(r('everest')) === 'p1', '"everest" → Everest')
  ok(hitId(r('Go to Skylar.')) === 'p2', '"Go to Skylar." → Skylar')
  ok(hitId(r('switch over to the Vega pane')) === 'p3', '"switch over to the Vega pane" → Vega')
  // The Wall is every terminal at once, the Board is agent images; "canvas" is neither — it asks.
  ok(r('go to the wall').kind === 'wall', '"go to the wall" → the Wall', JSON.stringify(r('go to the wall')))
  ok(r('show all terminals').kind === 'wall', '"show all terminals" → the Wall')
  ok(r('show me all the terminals').kind === 'wall', '"show me all the terminals" → the Wall')
  ok(r('the wall').kind === 'wall', '"the wall" → the Wall')
  ok(r('go to the board').kind === 'canvas', '"go to the board" → the Board')
  ok(r('show me the image board').kind === 'canvas', '"show me the image board" → the Board')
  ok(r('go to the canvas').kind === 'which_view', '"go to the canvas" → asks: the Wall or the Board?', JSON.stringify(r('go to the canvas')))
  ok(r('the canvas').kind === 'which_view', '"the canvas" → asks, never a guess')
  ok(r('show me the canvas board').kind === 'which_view', '"the canvas board" → still asks')
  ok(hitId(r('Everist')) === 'p1', 'a near-miss name still lands ("Everist")')
  ok(hitId(r('the codex one')) === 'p2', '"the codex one" → by agent')
  ok(r('panel 9').kind === 'none', '"panel 9" with four panes → none, not a guess')
  ok(r('zanzibar').kind === 'none', 'an unknown name → none')
  const twoClaude = nav.resolveNavTarget('the claude one', panes, 'p3')
  ok(twoClaude.kind === 'ambiguous' && twoClaude.candidates.length === 2, 'two Claude panes, neither focused: asks which, never guesses', twoClaude.kind)
  ok(hitId(nav.resolveNavTarget('the claude one', panes, 'p1')) === 'p1', 'two Claude panes, sitting in one: that one')

  /* ------------------------------------------------ voice grammar (fast path) */

  console.log('\nvoice grammar: the Wall, the Board, "canvas"')
  const vc = await import('../src/lib/voicecommands.ts')
  const gctx = { profiles: [{ id: 'claude', name: 'Claude Code', command: 'claude', accent: '#C6FF4A', badge: 'CC', builtin: true }], projects: [{ id: 'pr1', name: 'forge' }], defaultProfileId: 'claude' }
  const said = (t) => vc.parseUtterance(t, gctx)
  for (const t of ['go to the wall', 'show all terminals', 'Show me all the terminals.', 'switch to the wall']) {
    const hit = said(t)
    ok(JSON.stringify(hit?.actions) === JSON.stringify([{ kind: 'set_view', mode: 'mosaic' }]), `"${t}" → set_view mosaic, no model`, JSON.stringify(hit))
  }
  for (const t of ['full screen', 'Go full screen.', 'back to full screen', 'leave the wall']) {
    const hit = said(t)
    ok(JSON.stringify(hit?.actions) === JSON.stringify([{ kind: 'set_view', mode: 'tabs' }]), `"${t}" → set_view tabs (Full screen), no model`, JSON.stringify(hit))
  }
  for (const t of ['go to the board', 'show me the board', 'go to the canvas', 'show me the canvas']) {
    ok(said(t) === null, `"${t}" → left to the brain (never a project switch)`, JSON.stringify(said(t)))
  }
  ok(said('switch to forge')?.actions[0]?.kind === 'switch_project', 'a real project switch still parses')

  /* -------------------------------------------------------- voice tools */

  console.log('\nvoice tools')
  const tools = await import('../src/lib/realtime/tools-hub.ts')
  const toolNames = tools.HUB_REALTIME_TOOLS.map((t) => t.name).sort().join()
  ok(toolNames === 'focus_pane_by_name,list_panes_with_names,run_saved_prompt,show_on_board', 'the four hub tools are declared, show_on_board by that name', toolNames)
  ok(!toolNames.includes('show_on_canvas'), 'the old show_on_canvas is not listed')
  ok(tools.isHubTool('show_on_canvas') && tools.isHubTool('show_on_board'), 'but show_on_canvas is still a hub tool (hidden alias)')
  ok((await tools.runHubTool('get_app_state', {})) === null, 'a non-hub tool is left to the caller')
  const early = await tools.runHubTool('focus_pane_by_name', { name: 'Everest' })
  ok(early && !early.ok && /starting up/.test(early.text), 'before the app is up it answers in words, never throws', JSON.stringify(early))
  // A stand-in renderer: the runtime the app registers, and the window events it fires.
  globalThis.window = new EventTarget()
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  const rt = await import('../src/lib/hubRuntime.ts')
  const seen = { revealed: [], focused: [], typed: [], events: [] }
  window.addEventListener(nav.HUB_FOCUS_EVENT, (e) => seen.events.push(e.detail))
  window.addEventListener(nav.HUB_COMPOSER_EVENT, (e) => seen.events.push({ composer: e.detail }))
  rt.setHubRuntime({
    panes: () => panes,
    focusedPaneId: () => 'p1',
    activeProjectId: () => 'proj-a',
    prompts: () => [
      { id: 'pr1', title: 'Code review', text: 'Review the diff.', target: 'active-pane', createdAt: 1, updatedAt: 1 },
      { id: 'pr2', title: 'Plan it', text: 'Make a plan.', target: 'composer', createdAt: 1, updatedAt: 1 }
    ],
    revealPane: (id) => seen.revealed.push(id),
    focusTerminal: (id) => seen.focused.push(id),
    typeIntoPane: (id, text, submit) => (seen.typed.push([id, text, submit]), true)
  })
  const went = await tools.runHubTool('focus_pane_by_name', { name: 'go to panel 3' })
  await sleep(20)
  ok(went.ok && seen.revealed.at(-1) === 'p3' && seen.focused.at(-1) === 'p3', 'focus_pane_by_name "panel 3" reveals and focuses it', JSON.stringify(went))
  ok(seen.events.some((d) => d.kind === 'pane' && d.paneId === 'p3' && d.name === 'Vega' && d.source === 'voice'), 'and fires the focus event D2 animates')
  const toBoard = await tools.runHubTool('focus_pane_by_name', { name: 'the board' })
  ok(toBoard.ok && /Board/.test(toBoard.text) && seen.events.some((d) => d.kind === 'canvas'), '"the board" fires the Board focus event', JSON.stringify(toBoard))
  const before = seen.events.length
  const toCanvas = await tools.runHubTool('focus_pane_by_name', { name: 'go to the canvas' })
  ok(!toCanvas.ok && /the Wall or the Board\?/.test(toCanvas.text) && seen.events.length === before, '"the canvas" goes nowhere and asks "the Wall or the Board?"', JSON.stringify(toCanvas))
  const actions = []
  const deps = { runAction: (a) => (actions.push(a), { ok: true, summary: 'ok', requested: 1, done: 1 }) }
  const toWall = await tools.runHubTool('focus_pane_by_name', { name: 'go to the wall' }, deps)
  ok(toWall.ok && JSON.stringify(actions) === JSON.stringify([{ kind: 'set_view', mode: 'mosaic' }]), '"go to the wall" sets the view to the Wall through set_view', JSON.stringify({ toWall, actions }))
  ok(seen.events.some((d) => d.kind === 'wall' && d.source === 'voice'), 'and fires the Wall focus event')
  const noDeps = await tools.runHubTool('focus_pane_by_name', { name: 'show all terminals' })
  ok(!noDeps.ok && /Wall/.test(noDeps.text), 'without the voice agent it says so rather than pretending', JSON.stringify(noDeps))
  const listed = await tools.runHubTool('list_panes_with_names', {})
  ok(
    /Everest \(Claude Code\), focused/.test(listed.text) && /Orion \(Claude Code\)/.test(listed.text) && !/panel \d/.test(listed.text),
    'list_panes_with_names shows each terminal by its name and agent, no numbers',
    listed.text
  )
  const ran = await tools.runHubTool('run_saved_prompt', { prompt: 'code review', pane: 'Skylar' })
  ok(ran.ok && JSON.stringify(seen.typed.at(-1)) === JSON.stringify(['p2', 'Review the diff.', false]), 'run_saved_prompt types into the named pane, unsent', JSON.stringify(ran))
  const toComposer = await tools.runHubTool('run_saved_prompt', { prompt: 'plan it' })
  ok(toComposer.ok && seen.events.some((d) => d.composer?.text === 'Make a plan.'), 'a composer prompt goes to the composer event')
  const unknown = await tools.runHubTool('run_saved_prompt', { prompt: 'nope' })
  ok(!unknown.ok && /Code review/.test(unknown.text), 'an unknown prompt lists the real ones', unknown.text)
  const noHub = await tools.runHubTool('show_on_canvas', { path: 'C:\\x.png' })
  ok(!noHub.ok && /not available/.test(noHub.text), 'the old name show_on_canvas is still answered, the same way', JSON.stringify(noHub))
  const onBoard = await tools.runHubTool('show_on_board', { path: 'C:\\x.png' })
  ok(onBoard && !onBoard.ok && /not available/.test(onBoard.text), 'show_on_board without the preload says so', JSON.stringify(onBoard))
  const justShow = await tools.runHubTool('show_on_canvas', {})
  ok(justShow?.ok && /Board/.test(justShow.text), 'show_on_canvas with no path shows the Board', JSON.stringify(justShow))
  rt.setHubRuntime(null)
  delete globalThis.window

  /* ------------------------------------------------------------ prompts */

  console.log('\nsaved prompts')
  const ps = new HubStore(root)
  const created = ps.savePrompt({ title: 'Code review', text: 'Review the diff.', hotkey: 'Ctrl+Shift+1' }, 1000)
  ok(created.ok && created.prompt.target === 'active-pane' && created.prompt.hotkey === 'Ctrl+Shift+1', 'create: defaults the target to the active pane', JSON.stringify(created))
  const id = created.ok ? created.prompt.id : ''
  const edited = ps.savePrompt({ id, title: 'Code review', text: 'Review the diff carefully.', target: 'composer', hotkey: null }, 2000)
  ok(edited.ok && edited.prompt.id === id && edited.prompt.createdAt === 1000 && edited.prompt.updatedAt === 2000, 'edit: same id, created time kept')
  ok(edited.ok && edited.prompt.target === 'composer' && edited.prompt.hotkey === undefined, 'edit: target changed, hotkey cleared')
  ok(!ps.savePrompt({ title: '', text: 'x' }).ok, 'a prompt needs a title')
  ok(!ps.savePrompt({ title: 'x', text: '   ' }).ok, 'a prompt needs text')
  ps.savePrompt({ title: 'Ship it', text: 'npm run release' })
  ok(new HubStore(root).listPrompts().length === 2, 'prompts persist in prompts.json')
  ok(ps.deletePrompt(id).length === 1 && new HubStore(root).listPrompts().every((p) => p.id !== id), 'delete removes it, on disk too')
  writeFileSync(join(root, 'prompts.json'), '{not json')
  ok(new HubStore(root).listPrompts().length === 0 && existsSync(join(root, 'prompts.json.corrupt')), 'a corrupt prompts.json is set aside, not fatal')

  /* ------------------------------------------------------------- keymap */

  console.log('\nkeymap')
  const base = km.resolveKeymap(BUILTIN_COMMANDS, {})
  ok(base.conflicts.length === 0, 'the built-in defaults never collide', JSON.stringify(base.conflicts))
  ok(base.rejected.length === 0, 'no built-in default takes a terminal key', JSON.stringify(base.rejected))
  const legacy = { 'voice.hubCard': 'Ctrl+Shift+G', 'app.settings': 'Ctrl+,', 'tab.new': 'Ctrl+T', 'pane.close': 'Ctrl+W', 'tab.next': 'Ctrl+Tab', 'view.toggle': 'Ctrl+G', 'tab.goto.3': 'Alt+3', 'pane.split.right': 'Ctrl+Shift+Right', 'pane.focus.left': 'Alt+Left', 'clipboard.copy': 'Ctrl+Shift+C', 'font.bigger': 'Ctrl+=' }
  ok(Object.entries(legacy).every(([id, combo]) => base.bindings.get(combo) === id), "every pre-registry shortcut keeps its old keys")
  const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  ok(km.comboFromEvent(ev('KeyG', { ctrlKey: true, shiftKey: true })) === 'Ctrl+Shift+G', 'a keydown reads as Ctrl+Shift+G')
  ok(km.comboFromEvent(ev('Comma', { ctrlKey: true })) === 'Ctrl+,', 'Ctrl+Comma reads as Ctrl+,')
  ok(km.comboFromEvent(ev('ControlLeft', { ctrlKey: true })) === null, 'a lone modifier is not a combo')
  ok(km.normaliseCombo('shift+ctrl+g') === 'Ctrl+Shift+G', 'combos are normalised (modifier order, case)')
  ok(km.normaliseCombo('Ctrl+G+H') === null, 'two keys is not a combo')
  for (const bad of ['Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Ctrl+L', 'Ctrl+R', 'Ctrl+V', 'A', 'Shift+A', 'Esc', 'Ctrl+Esc', 'Left', 'Ctrl+Left', 'Alt+B', 'Ctrl+Alt+E']) {
    ok(km.reservedReason(km.normaliseCombo(bad)) !== null, `${bad} can never be bound`)
  }
  ok(km.reservedReason('Ctrl+Shift+C') === null && km.reservedReason('F5') === null, 'Ctrl+Shift+C and F5 can')
  const cmds = [...BUILTIN_COMMANDS, { id: 'prompt.x', title: 'Prompt: x', group: 'Saved prompts', defaultKeys: [], scope: 'workspace' }]
  const refused = km.setBinding(cmds, {}, 'prompt.x', ['Ctrl+W'])
  ok(!refused.ok && refused.conflictsWith?.includes('pane.close'), 'binding a taken combo is refused and names the owner', JSON.stringify(refused))
  ok(!km.setBinding(cmds, {}, 'prompt.x', ['Ctrl+C']).ok, 'binding a terminal key is refused')
  const took = km.setBinding(cmds, {}, 'prompt.x', ['Ctrl+W'], { takeOver: true })
  const tookMap = took.ok ? km.resolveKeymap(cmds, took.overrides) : null
  ok(tookMap?.bindings.get('Ctrl+W') === 'prompt.x' && (tookMap?.keysFor['pane.close'] ?? ['x']).length === 0, 'take-over moves the key, explicitly unbinding the old owner', JSON.stringify(took))
  ok(tookMap?.conflicts.length === 0, 'take-over leaves no conflict behind')
  const rebound = km.setBinding(cmds, {}, 'view.toggle', ['Ctrl+Shift+Y'])
  const reboundMap = rebound.ok ? km.resolveKeymap(cmds, rebound.overrides) : null
  ok(reboundMap?.bindings.get('Ctrl+Shift+Y') === 'view.toggle' && !reboundMap?.bindings.has('Ctrl+G'), 'an override replaces the default keys')
  ok(rebound.ok && JSON.stringify(km.resetBinding(rebound.overrides, 'view.toggle')) === '{}', 'reset one command drops its override')
  ok(JSON.stringify(km.resetBinding({ a: [], b: ['F5'] })) === '{}', 'reset all drops every override')
  const clash = km.resolveKeymap([...BUILTIN_COMMANDS, { id: 'late.one', title: 'Late', group: 'X', defaultKeys: ['Ctrl+T'], scope: 'global' }])
  ok(clash.conflicts.length === 1 && clash.conflicts[0].commandIds.join() === 'tab.new,late.one' && clash.bindings.get('Ctrl+T') === 'tab.new', 'a clashing late default is reported, and the first command keeps the key', JSON.stringify(clash.conflicts))
  const tainted = km.resolveKeymap(BUILTIN_COMMANDS, { 'tab.new': ['Ctrl+C'] })
  ok(tainted.rejected.some((x) => x.combo === 'Ctrl+C') && !tainted.bindings.has('Ctrl+C'), 'a hand-edited keymap.json with a terminal key is rejected, not obeyed')
  const ks = new HubStore(root)
  ks.setKeymap({ version: 1, overrides: { 'view.toggle': ['Ctrl+Shift+Y'], junk: 'nope' } })
  ok(JSON.stringify(new HubStore(root).getKeymap()) === JSON.stringify({ version: 1, overrides: { 'view.toggle': ['Ctrl+Shift+Y'] } }), 'overrides persist in keymap.json, cleaned')

  /* ------------------------------------------------------ pane env var */

  console.log('\npane environment')
  mkdirSync(join(root, 'repos', 'app', 'packages', 'ui'), { recursive: true })
  writeFileSync(
    join(root, 'projects.json'),
    JSON.stringify([
      { id: 'app', name: 'App', path: join(root, 'repos', 'app'), color: '#fff', defaultProfileId: 'pwsh', createdAt: 1 },
      { id: 'ui', name: 'UI', path: join(root, 'repos', 'app', 'packages', 'ui'), color: '#fff', defaultProfileId: 'pwsh', createdAt: 1 },
      { id: 'named', name: 'Named', path: join(root, 'repos', 'elsewhere'), color: '#fff', defaultProfileId: 'pwsh', createdAt: 1 }
    ])
  )
  const { canvasEnvFor } = await import('../electron/hub-ipc.ts')
  const envOf = (cwd, name = '') => canvasEnvFor(cwd, name)[hub.CANVAS_DIR_ENV] ?? null
  ok(envOf(join(root, 'repos', 'app')) === join(root, 'canvas', 'app'), 'a pane in a project folder gets that project\'s board', String(envOf(join(root, 'repos', 'app'))))
  ok(envOf(join(root, 'repos', 'app', 'packages', 'ui', 'src')) === join(root, 'canvas', 'ui'), 'the deepest project wins for a nested folder')
  ok(envOf(join(root, 'nowhere'), 'Named') === join(root, 'canvas', 'named'), 'falls back to the project name')
  ok(envOf(join(root, 'nowhere')) === null, 'a pane in no project gets no variable')
  ok(!envOf(join(root, 'repos', 'app'))?.startsWith(join(root, 'repos')), 'the board is never inside a user project folder')
  const pty = readFileSync(new URL('../electron/pty-host.ts', import.meta.url), 'utf8')
  ok(/\.\.\.canvasEnv\b/.test(pty) && /canvasEnvFor\(cwd, projectName\)/.test(pty), 'pty-host puts it in every pane\'s environment')

  /* ------------------------------------------- handing a piece to a pane */

  console.log('\nthe Board hands a piece to a pane — the wall strip takes drops')
  const strip = readFileSync(new URL('../src/components/shell/WallStrip.tsx', import.meta.url), 'utf8')
  const tileTag = /<div\s+ref=\{ref\}\s+className="wstrip__tile"[\s\S]*?>\s*\{\/\*/.exec(strip)?.[0] ?? ''
  ok(/onDragOver=\{acceptDrag\}/.test(tileTag) && /onDrop=\{onDrop\}/.test(tileTag), 'a strip tile listens for dragover and drop', tileTag.slice(0, 120))
  const accept = /const acceptDrag = [\s\S]*?\n  \}/.exec(strip)?.[0] ?? ''
  ok(/PATH_DRAG_TYPE/.test(accept) && /TASK_DRAG_TYPE/.test(accept) && /maybeFiles\(e\)/.test(accept) && /preventDefault\(\)/.test(accept), 'it accepts a Board tile (path), a task card and Explorer files', accept)
  const drop = /const onDrop = [\s\S]*?\n  \}/.exec(strip)?.[0] ?? ''
  ok(/getData\(PATH_DRAG_TYPE\)/.test(drop) && /droppedFilePaths\(e\)/.test(drop), 'the drop reads the dragged path, else the files')
  ok(/^\s*e\.preventDefault\(\)/m.test(drop.split('\n').slice(1, 5).join('\n')), 'the drop is always prevented (a stray file drop would navigate the window)')
  const focusThenPaste = /terminalHost\.focus\(paneId\)\s*\n\s*requestAnimationFrame\(\(\) => terminalHost\.paste\(paneId,/
  ok(focusThenPaste.test(drop), 'focus first, paste a frame later (the DECSET 1004 rule)')
  const toPane = /const toPane = [\s\S]*?\n  \}/.exec(boardSrc)?.[0] ?? ''
  ok(focusThenPaste.test(toPane), '"→ Pane" also focuses first and pastes a frame later', toPane)
  ok(/\.wstrip__tile\[data-pane-id=/.test(toPane), '"→ Pane" flashes the pane in the wall strip too')
  ok(/data-armed=\{a\.removeArmed/.test(boardSrc) && /if \(!removeArmed\) \{\s*setRemoveArmed\(true\)\s*return/.test(boardSrc), 'deleting a piece takes two presses, never one')
  ok(/if \(!gone\) actions\.setNotice\(/.test(boardSrc), 'a delete that fails says so')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`)
process.exit(fail === 0 ? 0 : 1)

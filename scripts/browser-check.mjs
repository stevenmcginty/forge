#!/usr/bin/env node
/**
 * browser:check — Forge's built-in browser, proved against the real code.
 *
 *   1. persistence   BrowserSurfaceStore round-trips surfaces through disk, keeps ids
 *                    unique across restarts, and survives a damaged file.
 *   2. refs          formatRead numbers from 1, caps the list, and badRef refuses junk.
 *   2b. overlays     the page hides under every pop-up that overlaps it (overlays.ts), and
 *                    main names keys exactly as the keymap does (browserKeyCombo).
 *   3. tool schema   bridge/browser-tools.mjs offers exactly the eight tools, with words
 *                    and schemas identical to shared/browser.ts (the canonical copy).
 *   4. link auth     the real BrowserLink answers the right token and refuses a wrong,
 *                    missing or oversized one — without ever calling the handler.
 *   5. ownership     BrowserAgentOps against a fake driver: own tabs by default, other
 *                    tabs only by id, per-tab queue, and no queue across tabs.
 *   6. Electron      the real BrowserService in a real Electron window (small, inactive,
 *                    unfocusable, in a corner — a hidden window draws nothing), driven by
 *                    two simulated agents — two separate node processes running the real
 *                    bridge handlers with different FORGE_PANE_IDs — opening, reading,
 *                    clicking, typing and screenshotting local pages IN PARALLEL, then
 *                    isolation, cross-tab by id, a wrong token over the real pipe, and the
 *                    surfaces file after the app has quit.
 *   6b. failures     a failing iframe, shadow DOM, a typed password never read back, pages
 *                    off screen when the renderer reloads, Forge's keys taken from a page,
 *                    a crashed tab reborn, a hung tab answering and closing.
 *   6c. upload       browser_upload puts a real file into a hidden file box (no dialog),
 *                    the page's own input/change handlers fire, several boxes are listed
 *                    and picked by `which` or by a nearby element's ref.
 *   6d. read         only what a person could see and reach is listed: a covered till is left
 *                    out, a modal's buttons come first, `find` narrows the list (and its number
 *                    clicks), plain, below-the-fold and scroll-box buttons all stay.
 *
 *   --live [--shots <dir>]  also: a VISIBLE window mounting the real React surface,
 *                    an agent opening https://example.com, browser_read + browser_screenshot
 *                    through the bridge's code path, and the shots saved to <dir>.
 *
 * Everything runs in a throwaway data dir with its own userData, so the check never
 * touches Steve's real browser session or surfaces.
 */
import { registerHooks } from 'node:module'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Never hand a check the environment's AI keys (this shell's may be someone else's, refused).
for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k]

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec) && context.parentURL?.endsWith('.ts')) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const LIVE = argv.includes('--live')
const SHOTS = argv.includes('--shots') ? resolve(argv[argv.indexOf('--shots') + 1] ?? '') : null

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split('\n').join('\n       ')}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

/** Every child this check starts, killed if the check itself ends first. */
const children = new Set()
process.on('exit', () => {
  for (const c of children) c.kill()
})

const scratch = mkdtempSync(join(tmpdir(), 'forge-browser-check-'))
const cleanup = () => {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch {
    /* Electron may still hold a file for a moment */
  }
}

const S = await import('../shared/browser.ts')

/* --------------------------------------------------------- 1. persistence */
section('1. persistence round trip')
{
  const { BrowserSurfaceStore, parseSurfacesFile } = await import('../electron/browser-panes/store.ts')
  const dir = join(scratch, 'store')
  const a = new BrowserSurfaceStore(dir)
  const id1 = a.nextId()
  const id2 = a.nextId()
  const owner = { id: 'pane:p1', label: 'Rex', agent: 'claude' }
  a.put({ id: id1, project: 'proj-1', url: 'https://example.com/', title: 'Example', owner, rect: { x: 10, y: 20, w: 800, h: 600 }, createdAt: 1, updatedAt: 1 })
  a.put({ id: id2, project: '', url: 'https://example.org/', title: 'Org', owner: S.USER_OWNER, rect: { x: 0, y: 0, w: 500, h: 400 }, createdAt: 2, updatedAt: 2 })
  a.patch(id1, { rect: { x: 11, y: 22, w: 900, h: 700 }, title: 'Example Domain' })
  const b = new BrowserSurfaceStore(dir)
  const back = b.get(id1)
  check('a saved surface reads back after a "restart"', back?.url === 'https://example.com/' && back?.title === 'Example Domain')
  check('its canvas position survives', back?.rect.x === 11 && back?.rect.y === 22 && back?.rect.w === 900 && back?.rect.h === 700)
  check('its owner survives', back?.owner.id === 'pane:p1' && back?.owner.label === 'Rex' && back?.owner.agent === 'claude')
  check('its project survives', back?.project === 'proj-1')
  check('ids keep counting after a restart (no reuse)', b.nextId() === 'b3', b.nextId())
  b.remove(id2)
  check('a removed surface stays removed', new BrowserSurfaceStore(dir).get(id2) === null)
  writeFileSync(join(dir, S.BROWSER_SURFACES_FILE), '{ not json', 'utf8')
  check('a damaged file reads as empty, not a throw', new BrowserSurfaceStore(dir).all().length === 0)
  const parsed = parseSurfacesFile(JSON.stringify({ v: 1, nextId: 1, surfaces: [{ id: 'b9', url: 'x' }, { id: 'evil', url: 'y' }, { id: 'b9' }] }))
  check('junk ids and duplicates are dropped', parsed.surfaces.length === 1 && parsed.surfaces[0].id === 'b9')
  check('nextId is never behind an id on disk', parsed.nextId === 10, String(parsed.nextId))
}

/* --------------------------------------------------------------- 2. refs */
section('2. ref numbering')
{
  const { formatRead, badRef, readScript } = await import('../electron/browser-panes/snapshot.ts')
  const READ_SCRIPT = readScript(null)
  const items = Array.from({ length: 3 }, (_, i) => `[${i + 1}] button "B${i + 1}"`)
  const text = formatRead('b4', { url: 'https://x.test/', title: 'X', items, dropped: 2, text: 'Hello' })
  check('the read names the tab', text.startsWith('Tab b4: https://x.test/ — "X"'))
  check('refs are listed from [1] in order', /\[1\] button "B1"\n\[2\] button "B2"\n\[3\] button "B3"/.test(text))
  check('what was dropped past the cap is said', text.includes(`…and 2 more, past the limit of ${S.BROWSER_MAX_REFS}.`))
  check('the page text follows', text.endsWith('What the page says:\nHello'))
  const long = formatRead('b1', { url: 'u', title: 't', items: [], dropped: 0, text: 'y'.repeat(S.BROWSER_MAX_READ_CHARS * 2) })
  check('a huge page is truncated to the budget', long.length <= S.BROWSER_MAX_READ_CHARS + 20 && long.endsWith('…truncated'))
  check('badRef refuses 0, -1, 1.2e9, NaN, "x"', [0, -1, 1.2e9, Number.NaN, 'x'].every((r) => badRef(r)))
  check('badRef accepts 1 and 7', !badRef(1) && !badRef(7))
  check('the page script parks refs on window.__forgeRefs and starts at 1', READ_SCRIPT.includes('window.__forgeRefs = refs') && READ_SCRIPT.includes("'[' + refs.length + '] '"))
  check('find is carried into the page script as a JSON string literal', readScript('Ne"x`t').includes(`const FIND_RAW = ${JSON.stringify('Ne"x`t')};`))
  const busy = formatRead('b2', { url: 'u', title: 't', items: ['[1] button "Close"', '[2] button "Next"'], dropped: 5, hidden: 200, inDialog: 2, text: '' })
  check('the read says how many were hidden or covered, apart from the cap', busy.includes('Left out: 200 hidden, covered by something on top, or out of reach') && busy.includes(`…and 5 more, past the limit of ${S.BROWSER_MAX_REFS}.`), busy)
  check('past the cap, the read hints `find`', busy.includes('Pass `find`'), busy)
  check('the read says which numbers are in the dialog on top', busy.includes('[1]–[2] are in the dialog on top of the page.'), busy)
  const found = formatRead('b2', { url: 'u', title: 't', items: ['[1] button "Next"'], dropped: 0, hidden: 0, unmatched: 9, find: 'Next', text: '' })
  check('a find read says what it was narrowed to and how many others were left out', found.includes('Only elements whose words contain "Next" are listed; 9 others were left out.') && !found.includes('Pass `find`'), found)
  const none = formatRead('b2', { url: 'u', title: 't', items: [], dropped: 0, unmatched: 3, find: 'Zebra', text: '' })
  check('a find with no match says so', none.includes('Nothing you can click here has "Zebra" in its words.'), none)
  const plain = formatRead('b2', { url: 'u', title: 't', items: ['[1] button "A"'], dropped: 0, hidden: 0, text: '' })
  check('a plain read has no footer lines', !plain.includes('Left out') && !plain.includes('past the limit') && !plain.includes('dialog on top'), plain)
}

/* ------------------------------------------------- 2b. overlays and keys */
section('2b. what the page hides under, and the keys it hands back')
{
  const { COVERS } = await import('../src/components/browser/overlays.ts')
  const covers = COVERS.split(',').map((s) => s.trim())
  for (const sel of ['[data-shell-overlay]', '.spop', '.cheat', '.sheet', '.popover', '.blight', '.deckmenu__panel', '.approval', '.onboard', '.wnew']) {
    check(`the page hides while ${sel} overlaps it`, covers.includes(sel), COVERS)
  }
  const drawnBy = {
    '.deckmenu__panel': 'src/components/TitleBar.tsx',
    '.approval': 'src/components/ApprovalPrompt.tsx',
    '.onboard': 'src/components/Onboarding.tsx',
    '.wnew': 'src/components/WhatsNew.tsx'
  }
  for (const [sel, file] of Object.entries(drawnBy)) {
    check(`${sel} is still a class ${file} draws`, readFileSync(join(ROOT, file), 'utf8').includes(`className="${sel.slice(1)}"`))
  }
  const K = await import('../src/lib/keymap.ts')
  const codes = ['KeyA', 'KeyO', 'KeyZ', 'Digit0', 'Digit9', 'Numpad5', 'F1', 'F13', 'F24', 'F25', 'Comma', 'Period', 'Slash', 'Backslash', 'BracketLeft',
    'Semicolon', 'Quote', 'Backquote', 'Minus', 'Equal', 'ArrowLeft', 'ArrowDown', 'Escape', 'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home',
    'End', 'PageUp', 'PageDown', 'NumpadAdd', 'NumpadSubtract', 'NumpadEnter', 'ControlRight', 'ShiftLeft', 'MetaLeft', 'CapsLock', '']
  const drift = []
  for (const code of codes) {
    for (let m = 0; m < 16; m++) {
      const mods = { ctrl: !!(m & 1), alt: !!(m & 2), shift: !!(m & 4), meta: !!(m & 8) }
      const main = S.browserKeyCombo({ code, ...mods })
      const renderer = K.comboFromEvent({ code, ctrlKey: mods.ctrl, altKey: mods.alt, shiftKey: mods.shift, metaKey: mods.meta })
      if (main !== renderer) drift.push(`${code}/${m}: main ${main} vs keymap ${renderer}`)
    }
  }
  check("main's browserKeyCombo names every key exactly as the keymap's comboFromEvent", drift.length === 0, drift.slice(0, 8).join('\n'))
}

/* --------------------------------------------------------- 3. tool schema */
section('3. tool schema (bridge copy vs shared/browser.ts)')
const bridgeUrl = pathToFileURL(join(ROOT, 'bridge', 'browser-tools.mjs')).href
{
  const B = await import(bridgeUrl)
  const names = B.BROWSER_TOOLS.map((t) => t.name)
  check('exactly the eight tools, in order', JSON.stringify(names) === JSON.stringify(S.BROWSER_TOOL_NAMES), names.join(', '))
  check('a handler for every tool', names.every((n) => typeof B.BROWSER_HANDLERS[n] === 'function') && Object.keys(B.BROWSER_HANDLERS).length === 8)
  for (const tool of B.BROWSER_TOOLS) {
    check(`${tool.name}: description matches shared word for word`, tool.description === S.BROWSER_TOOL_DESCRIPTIONS[tool.name])
    check(`${tool.name}: schema matches shared`, JSON.stringify(tool.inputSchema) === JSON.stringify(S.BROWSER_TOOL_PARAMS[tool.name]))
    check(`${tool.name}: says it is Forge's browser, preferred, own tabs, parallel`, tool.description.startsWith(S.BROWSER_PREAMBLE))
  }
  for (const name of ['browser_click', 'browser_type', 'browser_upload']) {
    const d = B.BROWSER_TOOLS.find((t) => t.name === name).description
    check(`${name}: carries the ask-first rule`, d.includes('Ask the user before purchases, messages, or submitting forms'))
  }
  check('server instructions match shared', B.BROWSER_INSTRUCTIONS === S.BROWSER_INSTRUCTIONS)
  check('the bridge module imports no MCP SDK and no child_process', !/@modelcontextprotocol|child_process/.test(readFileSync(join(ROOT, 'bridge', 'browser-tools.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
  const saved = process.env['FORGE_BROWSER_LINK_FILE']
  delete process.env['FORGE_BROWSER_LINK_FILE']
  const r = await B.BROWSER_HANDLERS.browser_list({})
  check('with no link env, a tool says why instead of failing silently', r.isError === true && r.content[0].text.includes('FORGE_BROWSER_LINK_FILE is not set'))
  if (saved !== undefined) process.env['FORGE_BROWSER_LINK_FILE'] = saved
}

/* ----------------------------------------------------------- 4. link auth */
section('4. link auth')
{
  const { BrowserLink, callerOf } = await import('../electron/browser-panes/link.ts')
  const B = await import(bridgeUrl)
  const calls = []
  const link = new BrowserLink(join(scratch, 'link'), async (op, args, caller) => {
    calls.push({ op, args, caller })
    return { ok: true, text: `ran ${op} for ${caller.id}` }
  })
  const pipe = await link.listen()
  const file = JSON.parse(readFileSync(link.linkFile, 'utf8'))
  check('the link file names the pipe and a 64-hex token', file.pipe === pipe && /^[0-9a-f]{64}$/.test(file.token))
  check('the transport is a pipe/socket, not a TCP port', process.platform === 'win32' ? pipe.startsWith('\\\\.\\pipe\\') : pipe.endsWith('.sock'))
  process.env['FORGE_PANE_ID'] = 'pane-auth'
  const good = await B.browserAsk('browser_list', {}, { pipe, token: file.token })
  check('the right token is answered', good?.ok === true && good.text === 'ran browser_list for pane:pane-auth', JSON.stringify(good))
  const before = calls.length
  const bad = await B.browserAsk('browser_list', {}, { pipe, token: file.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })
  check('a wrong token is refused', bad?.ok === false && bad.error === 'bad-token', JSON.stringify(bad))
  const none = await B.browserAsk('browser_list', {}, { pipe, token: '' })
  check('a missing token is refused', none?.ok === false && none.error === 'bad-token')
  check('refused requests never reach the handler', calls.length === before)
  const big = await B.browserAsk('browser_type', { text: 'x'.repeat(S.BROWSER_LINK_MAX_REQUEST_BYTES + 10) }, { pipe, token: file.token })
  check('an oversized request is refused', big?.ok === false && big.error === 'too-large')
  check('callerOf maps a pane id to its own owner', callerOf({ paneId: 'abc', name: 'Rex', agent: 'Claude' }).id === 'pane:abc' && callerOf({ paneId: 'abc', agent: 'Claude' }).agent === 'claude')
  link.close()
  check('closing removes the link file', !existsSync(link.linkFile))
  delete process.env['FORGE_PANE_ID']
}

/* ---------------------------------------------------------- 5. ownership */
section('5. ownership and concurrency (fake driver)')
{
  const { BrowserAgentOps } = await import('../electron/browser-panes/agent-ops.ts')
  const records = []
  let n = 0
  const log = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const driver = {
    records: () => records,
    open: async (owner, url, title, project) => {
      const id = `b${++n}`
      records.push({ id, owner, url, title, project, rect: S.BROWSER_DEFAULT_RECT, createdAt: n, updatedAt: n })
      return { id, text: `opened ${id}` }
    },
    read: async (id, find) => {
      log.push(`start ${id}`)
      await delay(150)
      log.push(`end ${id}`)
      return `read ${id}${find ? ` find=${find}` : ''}`
    },
    click: async (id, ref) => `click ${id} ${ref}`,
    type: async (id, ref, text, submit) => `type ${id} ${ref} ${text} ${submit}`,
    navigate: async (id, url) => `nav ${id} ${url}`,
    upload: async (id, path, ref, which) => `upload ${id} ${path} ${ref} ${which}`,
    screenshot: async (id) => ({ path: `/tmp/${id}.png` }),
    close: async (id) => {
      const at = records.findIndex((r) => r.id === id)
      if (at >= 0) records.splice(at, 1)
      return at >= 0
    }
  }
  const ops = new BrowserAgentOps(driver, (o) => `proj-of-${o.id}`)
  const A = { id: 'pane:A', label: 'Rex', agent: 'claude' }
  const Bo = { id: 'pane:B', label: 'Zora', agent: 'codex' }
  const noTab = await ops.run('browser_read', {}, A)
  check('reading with no tab says to open one first', !noTab.ok && noTab.text.includes('browser_open'))
  const oa = await ops.run('browser_open', { url: 'example.com' }, A)
  const ob = await ops.run('browser_open', { url: 'example.org' }, Bo)
  check('open fills in https and returns an id', oa.ok && oa.id === 'b1' && records[0].url === 'https://example.com')
  check('a tab lands in its owner\'s project', records[0].project === 'proj-of-pane:A')
  const bad = await ops.run('browser_open', { url: 'file:///C:/secret' }, A)
  check('non-http urls are refused', !bad.ok && bad.text.includes('Only http and https'))
  check('A with no id acts on A\'s own tab', (await ops.run('browser_read', {}, A)).text === 'read b1')
  check('B with no id acts on B\'s own tab, not A\'s', (await ops.run('browser_read', {}, Bo)).text === 'read b2')
  check('B can use A\'s tab only by naming it', (await ops.run('browser_click', { id: 'b1', ref: 2 }, Bo)).text === 'click b1 2')
  check('after naming A\'s tab, B\'s next call with no id is back on B\'s own tab', (await ops.run('browser_type', { text: 'hi', submit: true }, Bo)).text === 'type b2 null hi true')
  check('an unknown id is refused with the caller\'s tabs listed', (await ops.run('browser_read', { id: 'b99' }, A)).text.includes('Your tabs: b1'))
  const list = await ops.run('browser_list', {}, A)
  check('browser_list shows every tab with its owner', list.text.includes('b1') && list.text.includes('yours') && list.text.includes('owned by Zora (codex)'))
  check('a bad ref is refused before the driver', !(await ops.run('browser_click', { ref: 0 }, A)).ok)
  check('read passes `find` to the driver, trimmed', (await ops.run('browser_read', { find: '  Next \n page ' }, A)).text === 'read b1 find=Next page')
  check('an empty `find` reads everything', (await ops.run('browser_read', { find: '   ' }, A)).text === 'read b1')
  const badFind = await ops.run('browser_read', { find: 5 }, A)
  check('a `find` that is not text is refused before the driver', !badFind.ok && badFind.text.includes('`find` must be text'), badFind.text)
  log.length = 0
  const t0 = Date.now()
  await Promise.all([ops.run('browser_read', { id: 'b1' }, A), ops.run('browser_read', { id: 'b2' }, Bo)])
  const across = Date.now() - t0
  check('reads on different tabs overlap (no global lock)', log[0].startsWith('start') && log[1].startsWith('start') && across < 280, `${log.join(', ')} in ${across}ms`)
  log.length = 0
  await Promise.all([ops.run('browser_read', { id: 'b1' }, A), ops.run('browser_read', { id: 'b1' }, Bo)])
  check('reads on the same tab queue (no interleaving on one page)', log.join(',') === 'start b1,end b1,start b1,end b1', log.join(', '))
  const upFile = join(scratch, 'upload-me.csv')
  writeFileSync(upFile, 'date,amount\n', 'utf8')
  const up = (args) => ops.run('browser_upload', args, A)
  check('upload hands the driver the tab, the path and no ref/which', (await up({ path: upFile })).text === `upload b1 ${upFile} null null`)
  check('upload passes ref and which through, rounded', (await up({ path: upFile, ref: 3, which: 2.2 })).text === `upload b1 ${upFile} 3 2`)
  const noPath = await up({})
  check('upload with no path is refused before the driver', !noPath.ok && noPath.text.includes('`path` is required'), noPath.text)
  const rel = await up({ path: 'upload-me.csv' })
  check('a relative path is refused (it would resolve against Forge, not the agent)', !rel.ok && rel.text.includes('must be a full path'), rel.text)
  const gone = await up({ path: join(scratch, 'no-such-file.csv') })
  check('a missing file is refused', !gone.ok && gone.text.startsWith('There is no file at'), gone.text)
  const dir = await up({ path: scratch })
  check('a folder is refused', !dir.ok && dir.text.includes('is not a file'), dir.text)
  check('a bad ref or which is refused', !(await up({ path: upFile, ref: 0 })).ok && !(await up({ path: upFile, which: 0 })).ok && !(await up({ path: upFile, which: 'x' })).ok)
  const shot = await ops.run('browser_screenshot', {}, A)
  check('screenshot returns the file path', shot.ok && shot.imagePath === '/tmp/b1.png')
  const closed = await ops.run('browser_close', {}, A)
  check('close with no id closes the caller\'s current tab', closed.ok && records.every((r) => r.id !== 'b1'))
  const stuck = [{ id: 'b7', owner: A, url: 'u', title: 't', project: '', rect: S.BROWSER_DEFAULT_RECT, createdAt: 1, updatedAt: 1 }]
  const wedged = new BrowserAgentOps({ ...driver, records: () => stuck, read: () => new Promise(() => {}), close: async () => stuck.splice(0).length > 0 })
  void wedged.run('browser_read', { id: 'b7' }, A)
  const t1 = Date.now()
  const shut = await Promise.race([wedged.run('browser_close', { id: 'b7' }, A), delay(1000).then(() => null)])
  check('browser_close never waits behind a hung call on the same tab', shut?.ok === true && Date.now() - t1 < 500, JSON.stringify(shut))
}

/* ------------------------------------------------------------ 6. Electron */
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const { build } = await import('esbuild')

async function bundleHarness() {
  const dir = join(scratch, 'harness')
  mkdirSync(dir, { recursive: true })
  const alias = { '@shared': join(ROOT, 'shared'), '@': join(ROOT, 'src') }
  const nodePaths = [join(ROOT, 'node_modules')]
  const mainSrc = join(dir, 'main.ts')
  writeFileSync(
    mainSrc,
    `import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserService } from ${JSON.stringify(join(ROOT, 'electron', 'browser-panes', 'service.ts'))}

const cfg = JSON.parse(process.env.BROWSER_CHECK_CFG || '{}')
// Never a modal on the desk, never a harness that outlives the check.
process.on('uncaughtException', (e) => { console.error(e); process.exit(1) })
dialog.showErrorBox = () => {}
setTimeout(() => process.exit(3), cfg.live ? 180000 : 150000)
app.setPath('userData', join(cfg.dataDir, 'userdata'))
const say = (tag, value) => process.stdout.write('@@' + tag + '@@' + JSON.stringify(value) + '@@END@@\\n')

function page(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><title>' + (html.title || 'Test') + '</title></head><body>' + html.body + '</body></html>')
}

// The check's control channel. Test-only: Electron's main process has no usable
// stdin on Windows, and this loopback server exists for the test pages anyway.
let control = async (_cmd) => ({ error: 'not ready' })
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/__cmd') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let value
      try { value = await control(JSON.parse(body)) } catch (err) { value = { error: String(err && err.stack || err) } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value === undefined ? null : value))
    })
    return
  }
  const who = url.searchParams.get('who') || '?'
  const delay = Number(url.searchParams.get('delay') || 0)
  setTimeout(() => {
    if (url.pathname === '/form') {
      page(res, { title: 'Form ' + who, body:
        '<h1>Agent ' + who + ' page</h1><p id="status">Not pressed</p>' +
        '<button onclick="window.n=(window.n||0)+1;document.getElementById(\\'status\\').textContent=\\'Pressed \\'+window.n">Press me</button>' +
        '<form action="/result"><input name="name" placeholder="Your name"><input type="hidden" name="who" value="' + who + '"></form>' +
        '<a href="/form?who=' + who + '&n=2">Next page</a>' })
    } else if (url.pathname === '/result') {
      page(res, { title: 'Result ' + who, body: '<h1>Hello, ' + (url.searchParams.get('name') || '') + '</h1><p>for agent ' + who + '</p>' })
    } else if (url.pathname === '/login') {
      page(res, { title: 'Login', body: '<h1>Sign in</h1><input type="password" name="pw" placeholder="Password"><input name="code" autocomplete="one-time-code" placeholder="Code">' })
    } else if (url.pathname === '/framed') {
      page(res, { title: 'Framed', body: '<h1>Framed page</h1><iframe src="http://127.0.0.1:1/"></iframe>' })
    } else if (url.pathname === '/shadow') {
      page(res, { title: 'Shadow', body: '<h1>Shadow page</h1><x-card></x-card><script>customElements.define("x-card", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<button>Inside shadow</button><p>Shadow words</p>" } })</script>' })
    } else if (url.pathname === '/keys') {
      page(res, { title: 'Keys', body: '<h1>Keys page</h1><input id="f" autofocus><script>window.__got = []; addEventListener("keydown", function (e) { window.__got.push(e.code + (e.ctrlKey ? "+ctrl" : "")) }, true)</script>' })
    } else if (url.pathname === '/upload') {
      page(res, { title: 'Upload', body: '<h1>Upload page</h1><p id="out">No file yet</p><style>.hidden{display:none}</style>' +
        '<label>Upload Statement<input type="file" class="hidden" accept=".csv"></label>' +
        '<script>window.__ev = []; document.querySelector("input[type=file]").addEventListener("input", function () { window.__ev.push("input") });' +
        'document.addEventListener("change", function (e) { const f = e.target.files[0]; window.__ev.push("change:" + (f ? f.name : "none"));' +
        'if (f) f.text().then(function (t) { document.getElementById("out").textContent = "Got " + t.split(String.fromCharCode(10))[1] }) })</script>' })
    } else if (url.pathname === '/upload2') {
      page(res, { title: 'Two boxes', body: '<h1>Two boxes</h1>' +
        '<div><button>Upload A</button><input type="file" name="a" style="display:none"></div>' +
        '<div><button>Upload B</button><input type="file" name="b" accept=".pdf" style="display:none"></div>' +
        '<script>window.__got = []; document.addEventListener("change", function (e) { window.__got.push(e.target.name + ":" + e.target.files[0].name) })</script>' })
    } else if (url.pathname === '/busy') {
      // A till of 200 buttons under an opaque full-screen back office, with a dialog on it.
      // ?plain=1: the dialog has no role or aria-modal, so only the layer itself can tell.
      const plain = url.searchParams.get('plain') === '1';
      let till = '';
      for (let i = 1; i <= 200; i++) till += '<button style="display:block;margin:6px">Till ' + i + '</button>';
      page(res, { title: 'Busy', body: '<div id="till">' + till + '</div>' +
        '<div style="position:fixed;inset:0;background:#eee;z-index:10"><h2>Back office</h2><button>Dashboard home</button>' +
        '<div ' + (plain ? '' : 'role="dialog" aria-modal="true" ') + 'style="position:fixed;left:30%;top:25%;width:400px;height:400px;background:#fff;border:1px solid #000">' +
        '<p>Reconcile</p><button onclick="this.parentNode.remove()">Close</button>' +
        '<button onclick="document.title=&quot;Next pressed&quot;">Next</button></div></div>' })
    } else if (url.pathname === '/plain') {
      let body = '<h1>Plain</h1>';
      for (let i = 1; i <= 20; i++) body += '<button>Plain ' + i + '</button> ';
      page(res, { title: 'Plain', body })
    } else if (url.pathname === '/long') {
      // A fixed header bar, a scroll box taller inside than out, and a page far below the fold.
      let rows = '';
      for (let i = 1; i <= 30; i++) rows += '<button style="display:block">Row ' + i + '</button>';
      let low = '';
      for (let i = 1; i <= 40; i++) low += '<button style="display:block;margin:20px">Low ' + i + '</button>';
      page(res, { title: 'Long', body: '<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#333;z-index:5"><button>Menu</button></div>' +
        '<div style="height:60px"></div><div id="list" style="height:150px;overflow:auto;border:1px solid #000">' + rows + '</div>' + low })
    } else if (url.pathname === '/ghosts') {
      page(res, { title: 'Ghosts', body: '<h1>Ghosts</h1><button>Real one</button>' +
        '<div style="visibility:hidden"><button>Ghost vis</button></div>' +
        '<div style="opacity:0"><button>Ghost opacity</button></div>' +
        '<div inert><button>Ghost inert</button></div>' +
        '<div aria-hidden="true"><button>Ghost aria</button></div>' +
        '<div style="position:fixed;left:-400px;top:0;width:300px;height:100%"><button>Ghost drawer</button></div>' +
        '<div style="height:40px;overflow:hidden"><div style="height:200px"></div><button>Ghost clipped</button></div>' +
        '<button style="position:absolute;left:-9999px">Ghost offscreen</button>' +
        '<div style="position:relative"><button>Ghost covered</button><div style="position:absolute;inset:0;background:#fff"></div></div>' +
        '<label><input type="checkbox" name="agree" style="position:absolute;opacity:0.01"><span style="position:relative;display:inline-block;width:20px;height:20px;background:#000"></span> Agree</label>' })
    } else if (url.pathname === '/hang') {
      page(res, { title: 'Hang', body: '<h1>Hang page</h1><script>window.onload = function () { setTimeout(function () { for (;;) {} }, 50) }</script>' })
    } else { res.writeHead(404); res.end('no') }
  }, delay)
})

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)))
  const port = server.address().port
  const service = new BrowserService({ dataDir: cfg.dataDir, downloadsDir: join(cfg.dataDir, 'downloads') })
  service.registerIpc(ipcMain)
  await service.start()
  // Shown (inactive, unfocusable, tucked in a corner): a hidden window draws
  // nothing, and screenshots need drawing. Small unless --live needs the surface.
  const wa = screen.getPrimaryDisplay().workArea
  const W = cfg.live ? Math.min(1440, wa.width) : 520
  const H = cfg.live ? Math.min(900, wa.height) : 360
  const win = new BrowserWindow({ width: W, height: H, x: wa.x + wa.width - W, y: wa.y + wa.height - H, show: false,
    focusable: false, skipTaskbar: true, backgroundColor: '#101114', title: 'Forge browser check',
    webPreferences: { preload: cfg.preload, contextIsolation: true, sandbox: false } })
  service.setWindow(win)
  // What main hands the renderer as page keys, recorded for the key checks.
  const sentKeys = []
  const realSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === 'browser:key') sentKeys.push(args[0])
    return realSend(channel, ...args)
  }
  const tabOf = (id) => service.manager['tabs'].get(id)
  if (cfg.live) await win.loadFile(cfg.html)
  else await win.loadURL('about:blank')
  win.showInactive()
  say('READY', { linkFile: service.linkFile, base: 'http://127.0.0.1:' + port })

  control = async (cmd) => {
    if (cmd.cmd === 'infos') return service.manager.infos()
    if (cmd.cmd === 'eval') return await win.webContents.executeJavaScript(cmd.js)
    if (cmd.cmd === 'tab') {
      const t = tabOf(cmd.id)
      return t ? { visible: t.visible, drawn: !!t.view && t.view.getVisible(), error: t.error } : { error: 'no tab' }
    }
    if (cmd.cmd === 'show') { service.manager.setBounds(cmd.id, { x: 0, y: 0, width: 400, height: 300 }); return true }
    if (cmd.cmd === 'reloadHost') { win.webContents.reload(); return true }
    if (cmd.cmd === 'crash') { tabOf(cmd.id).view.webContents.forcefullyCrashRenderer(); return true }
    if (cmd.cmd === 'keys') { service.manager.setAppKeys(cmd.keys); return true }
    if (cmd.cmd === 'press') {
      const wc = tabOf(cmd.id).view.webContents
      for (const ev of cmd.events) {
        wc.sendInputEvent(ev)
        await new Promise((r) => setTimeout(r, 40))
      }
      await new Promise((r) => setTimeout(r, 300))
      return true
    }
    if (cmd.cmd === 'sentKeys') return sentKeys
    if (cmd.cmd === 'tabEval') return await tabOf(cmd.id).view.webContents.executeJavaScript(cmd.js)
    if (cmd.cmd === 'composite') {
      const tabs = service.manager['tabs']
      const tab = [...tabs.values()].find((t) => t.visible && t.view)
      if (!tab) return { error: 'no visible surface' }
      const chrome = await win.webContents.capturePage()
      const shot = await tab.view.webContents.capturePage()
      const b = tab.bounds
      const js = '(async () => { const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s });' +
        'const a = await load(' + JSON.stringify(chrome.toDataURL()) + '); const p = await load(' + JSON.stringify(shot.toDataURL()) + ');' +
        'const c = document.createElement("canvas"); c.width = a.width; c.height = a.height; const g = c.getContext("2d");' +
        'const s = a.width / window.innerWidth; g.drawImage(a, 0, 0); g.drawImage(p, ' + b.x + ' * s, ' + b.y + ' * s, ' + b.width + ' * s, ' + b.height + ' * s);' +
        'return c.toDataURL("image/png") })()'
      const url = await win.webContents.executeJavaScript(js)
      writeFileSync(cmd.out, Buffer.from(String(url).split(',')[1], 'base64'))
      return { out: cmd.out, bounds: b }
    }
    if (cmd.cmd === 'quit') {
      service.dispose()
      setTimeout(() => { server.close(); app.exit(0) }, 100)
      return { quit: true }
    }
    return { error: 'unknown command' }
  }
})
`,
    'utf8'
  )
  await build({
    entryPoints: [mainSrc],
    outfile: join(dir, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    alias,
    logLevel: 'silent'
  })
  const preloadSrc = join(dir, 'preload.ts')
  writeFileSync(
    preloadSrc,
    `import { contextBridge } from 'electron'
import { browserApi } from ${JSON.stringify(join(ROOT, 'electron', 'browser-panes', 'preload-api.ts'))}
contextBridge.exposeInMainWorld('forgeBrowser', browserApi)
`,
    'utf8'
  )
  await build({ entryPoints: [preloadSrc], outfile: join(dir, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias, logLevel: 'silent' })
  const rendererSrc = join(dir, 'renderer.tsx')
  writeFileSync(
    rendererSrc,
    `import { createRoot } from 'react-dom/client'
import ${JSON.stringify(join(ROOT, 'src', 'theme', 'global.css'))}
import { BrowserSurfaces } from ${JSON.stringify(join(ROOT, 'src', 'components', 'browser', 'BrowserSurfaces.tsx'))}
const profiles = [{ id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', badge: 'CC' }]
createRoot(document.getElementById('root')!).render(<div style={{ position: 'fixed', inset: 0, background: 'var(--bg-base)' }}><BrowserSurfaces projectId="" profiles={profiles as never} /></div>)
`,
    'utf8'
  )
  await build({
    entryPoints: [rendererSrc],
    outfile: join(dir, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    alias,
    nodePaths,
    loader: { '.css': 'css', '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent'
  })
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
    'utf8'
  )
  const runner = join(dir, 'agent.mjs')
  writeFileSync(
    runner,
    `const { BROWSER_HANDLERS } = await import(${JSON.stringify(bridgeUrl)})
const steps = JSON.parse(process.argv[2])
const out = []
for (const s of steps) {
  const t0 = Date.now()
  const r = await BROWSER_HANDLERS[s.op](s.args || {})
  out.push({ op: s.op, t0, t1: Date.now(), isError: !!r.isError, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\\n'), image: r.content.some((c) => c.type === 'image') })
}
process.stdout.write('@@AGENT@@' + JSON.stringify(out) + '@@END@@')
`,
    'utf8'
  )
  return { dir, main: join(dir, 'main.cjs'), preload: join(dir, 'preload.cjs'), html: join(dir, 'index.html'), runner }
}

/** Launch the harness; resolves once it says READY. */
function launch(h, dataDir, live) {
  const env = { ...process.env, BROWSER_CHECK_CFG: JSON.stringify({ dataDir, live, preload: h.preload, html: h.html }) }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_ENV', 'NODE_ENV_ELECTRON_VITE']) delete env[k]
  const child = spawn(electronExe, [h.main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.on('exit', () => children.delete(child))
  let buffer = ''
  let stderr = ''
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let m
    while ((m = buffer.match(/@@(\w+)@@([\s\S]*?)@@END@@/))) {
      buffer = buffer.slice(m.index + m[0].length)
      const w = waiters.shift()
      if (w) w({ tag: m[1], value: JSON.parse(m[2]) })
    }
  })
  child.stderr.on('data', (c) => (stderr += c))
  const next = (ms = 30_000) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`harness timed out\n${stderr.slice(-2000)}`)), ms)
      waiters.push((v) => {
        clearTimeout(timer)
        res(v)
      })
    })
  let base = ''
  const send = async (cmd, ms = 30_000) => {
    const res = await fetch(`${base}/__cmd`, { method: 'POST', body: JSON.stringify(cmd), signal: AbortSignal.timeout(ms) })
    return await res.json()
  }
  const exited = new Promise((res) => child.on('exit', res))
  const ready = async (ms) => {
    const r = await next(ms)
    base = r.value.base
    return r
  }
  return { child, next: ready, send, exited, stderr: () => stderr }
}

/** One simulated agent: its own node process, its own pane id, the real bridge handlers. */
function agent(h, linkFile, pane, steps) {
  return new Promise((res) => {
    const env = { ...process.env, FORGE_BROWSER_LINK_FILE: linkFile, FORGE_PANE_ID: pane.id, FORGE_SHARE_AGENT: pane.name, FORGE_PANE_AGENT: pane.agent }
    const child = spawn(process.execPath, [h.runner, JSON.stringify(steps)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    children.add(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('exit', () => {
      children.delete(child)
      const m = out.match(/@@AGENT@@([\s\S]*?)@@END@@/)
      res(m ? JSON.parse(m[1]) : [{ op: 'crash', isError: true, text: `${out}\n${err}` }])
    })
  })
}

if (!existsSync(electronExe)) {
  section('6. Electron')
  check('electron binary present', false, 'run `node node_modules/electron/install.js`')
} else {
  const h = await bundleHarness()
  section('6. Electron: two agents in parallel on the real browser (tabs not on screen)')
  const dataDir = join(scratch, 'data')
  const app = launch(h, dataDir, false)
  try {
    const { value: ready } = await app.next(60_000)
    const rex = { id: 'pane-A', name: 'Rex', agent: 'claude' }
    const zora = { id: 'pane-B', name: 'Zora', agent: 'codex' }
    const script = (who) => [
      { op: 'browser_open', args: { url: `${ready.base}/form?who=${who}&delay=1500` } },
      { op: 'browser_read' },
      { op: 'browser_click', args: { ref: 1 } },
      { op: 'browser_read' },
      { op: 'browser_type', args: { ref: 2, text: `hello ${who}`, submit: true } },
      { op: 'browser_read' },
      { op: 'browser_screenshot' }
    ]
    const [ra, rb] = await Promise.all([agent(h, ready.linkFile, rex, script('A')), agent(h, ready.linkFile, zora, script('B'))])
    const firstStart = Math.min(ra[0].t0, rb[0].t0)
    const lastOpen = Math.max(ra[0].t1, rb[0].t1) - firstStart
    for (const [who, r] of [['A', ra], ['B', rb]]) {
      const errs = r.filter((s) => s.isError)
      check(`agent ${who}: all seven calls succeeded`, errs.length === 0, errs.map((e) => `${e.op}: ${e.text}`).join('\n'))
      check(`agent ${who}: open returned a tab of its own`, /Opened tab b\d+ \(yours\)/.test(r[0]?.text ?? ''), r[0]?.text)
      check(
        `agent ${who}: refs numbered [1] button, [2] input, [3] link`,
        (r[1]?.text ?? '').includes('[1] button "Press me"\n[2] input text "Your name"\n[3] link "Next page"'),
        r[1]?.text
      )
      check(`agent ${who}: a real click changed the page`, (r[3]?.text ?? '').includes('Pressed 1'), r[3]?.text)
      check(`agent ${who}: typing + Enter submitted the form`, (r[5]?.text ?? '').includes(`Hello, hello ${who}`) && (r[5]?.text ?? '').includes(`for agent ${who}`), r[5]?.text)
      const path = (r[6]?.text ?? '').match(/saved to (.+\.png)/)?.[1]
      const png = path && existsSync(path) ? readFileSync(path) : null
      check(`agent ${who}: screenshot is a real PNG on disk, also returned as an image`, !!png && png.length > 1000 && png.subarray(1, 4).toString() === 'PNG' && r[6].image === true, r[6]?.text)
    }
    check('both slow opens (1.5 s each) finished within 2.7 s of the first start — no global lock', lastOpen < 2700, `${lastOpen}ms`)
    const idA = ra[0].text.match(/tab (b\d+)/)?.[1]
    const idB = rb[0].text.match(/tab (b\d+)/)?.[1]
    check('the two agents got different tabs', !!idA && !!idB && idA !== idB)
    const [cross] = await Promise.all([
      agent(h, ready.linkFile, zora, [{ op: 'browser_read' }, { op: 'browser_read', args: { id: idA } }, { op: 'browser_list' }])
    ])
    check("Zora with no id still reads her own tab, not Rex's", (cross[0]?.text ?? '').includes('for agent B') && !(cross[0]?.text ?? '').includes('for agent A'), cross[0]?.text)
    check("Zora can read Rex's tab by naming it", (cross[1]?.text ?? '').includes('for agent A'), cross[1]?.text)
    check('browser_list shows both tabs and Rex as the other owner', (cross[2]?.text ?? '').includes('owned by Rex (claude)') && (cross[2]?.text ?? '').includes('yours'), cross[2]?.text)
    const infos = await app.send({ cmd: 'infos' })
    const ownA = infos.find((s) => s.id === idA)?.owner
    check('the surface records its owner (pane id, pane name, CLI) for the badge', ownA?.id === 'pane:pane-A' && ownA?.label === 'Rex' && ownA?.agent === 'claude', JSON.stringify(ownA))
    const linkBody = JSON.parse(readFileSync(ready.linkFile, 'utf8'))
    const forged = join(scratch, 'forged-link.json')
    writeFileSync(forged, JSON.stringify({ ...linkBody, token: 'f'.repeat(64) }), 'utf8')
    const [wrong] = await Promise.all([agent(h, forged, rex, [{ op: 'browser_list' }])])
    check('over the real pipe, a wrong token is refused', wrong[0]?.isError === true && (wrong[0]?.text ?? '').includes('token is wrong'), wrong[0]?.text)
    const [closed] = await Promise.all([agent(h, ready.linkFile, rex, [{ op: 'browser_close' }])])
    check("Rex's close with no id closes Rex's tab", !closed[0]?.isError && (closed[0]?.text ?? '').includes(`Closed tab ${idA}`), closed[0]?.text)

    section('6b. Electron: iframes, shadow DOM, passwords, renderer reload, page keys, crash, hang')
    const wait = (ms) => new Promise((res) => setTimeout(res, ms))
    const tess = { id: 'pane-C', name: 'Tess', agent: 'claude' }
    const tabIn = (r) => (r?.text ?? '').match(/tab (b\d+)/)?.[1]
    const secret = 'hunter2secret'
    const run1 = await agent(h, ready.linkFile, tess, [
      { op: 'browser_open', args: { url: `${ready.base}/framed` } },
      { op: 'browser_open', args: { url: `${ready.base}/shadow` } },
      { op: 'browser_read' },
      { op: 'browser_open', args: { url: `${ready.base}/login` } },
      { op: 'browser_read' },
      { op: 'browser_type', args: { ref: 1, text: secret } },
      { op: 'browser_type', args: { ref: 2, text: '774411' } },
      { op: 'browser_read' },
      { op: 'browser_click', args: { ref: 1 } }
    ])
    const [, , , , , typedPw, typedCode, loginReadStep, clickPw] = run1
    check('a page whose iframe fails still opens as loaded', !run1[0]?.isError && /Opened tab b\d+ \(yours\)/.test(run1[0]?.text ?? '') && !(run1[0]?.text ?? '').includes('did not load'), run1[0]?.text)
    check('browser_read sees buttons and words inside an open shadow root', (run1[2]?.text ?? '').includes('button "Inside shadow"') && (run1[2]?.text ?? '').includes('Shadow words'), run1[2]?.text)
    check(
      'typing into the password and one-time-code fields worked',
      (typedPw?.text ?? '').startsWith('Typed that into "Password"') && (typedCode?.text ?? '').startsWith('Typed that into "Code"'),
      `${typedPw?.text}\n${typedCode?.text}`
    )
    const loginRead = loginReadStep?.text ?? ''
    check('browser_read says a secret field is filled, and still names it', /input password "Password" \(filled in — hidden\)/.test(loginRead) && loginRead.includes('"Code" (filled in — hidden)'), loginRead)
    check('browser_read never shows a typed password or one-time code', !loginRead.includes(secret) && !loginRead.includes('774411'), loginRead)
    check('clicking a password field never echoes its value', (clickPw?.text ?? '').startsWith('Clicked') && !(clickPw?.text ?? '').includes(secret), clickPw?.text)
    const pwValue = await app.send({ cmd: 'tabEval', id: tabIn(run1[3]), js: 'document.querySelector("input[type=password]").value' })
    check('…while the field really holds what was typed', pwValue === secret, String(pwValue))

    const loginId = tabIn(run1[3])
    await app.send({ cmd: 'show', id: loginId })
    const shownTab = await app.send({ cmd: 'tab', id: loginId })
    check('a tab given bounds is drawn', shownTab.visible === true && shownTab.drawn === true, JSON.stringify(shownTab))
    await app.send({ cmd: 'reloadHost' })
    await wait(1000)
    const afterReload = await app.send({ cmd: 'tab', id: loginId })
    check('when the renderer reloads, the page comes off the screen', afterReload.visible === false && afterReload.drawn === false, JSON.stringify(afterReload))

    const keysRun = await agent(h, ready.linkFile, tess, [{ op: 'browser_open', args: { url: `${ready.base}/keys` } }])
    const keysId = tabIn(keysRun[0])
    await app.send({ cmd: 'show', id: keysId })
    await app.send({ cmd: 'keys', keys: { combos: ['Ctrl+Shift+O'], talk: ['F13'] } })
    await app.send({
      cmd: 'press',
      id: keysId,
      events: [
        { type: 'keyDown', keyCode: 'O', modifiers: ['control', 'shift'] },
        { type: 'keyUp', keyCode: 'O', modifiers: ['control', 'shift'] },
        { type: 'keyDown', keyCode: 'A' },
        { type: 'keyUp', keyCode: 'A' },
        { type: 'keyDown', keyCode: 'F13' },
        { type: 'keyUp', keyCode: 'F13' }
      ]
    })
    const sent = (await app.send({ cmd: 'sentKeys' })) ?? []
    const got = (await app.send({ cmd: 'tabEval', id: keysId, js: 'window.__got' })) ?? []
    const keyWords = `sent to Forge: ${JSON.stringify(sent)}\npage saw: ${JSON.stringify(got)}`
    check("a Forge shortcut pressed in a page is handed to Forge's renderer", sent.some((k) => k.type === 'keyDown' && k.code === 'KeyO' && k.ctrl && k.shift), keyWords)
    check('…and the page never sees it', Array.isArray(got) && !got.some((c) => String(c).startsWith('KeyO')), keyWords)
    check('the voice key is handed to Forge, down and up (a hold needs its key-up)', sent.filter((k) => k.code === 'F13').map((k) => k.type).join() === 'keyDown,keyUp', keyWords)
    check('ordinary keys still reach the page and stay there', Array.isArray(got) && got.includes('KeyA') && !sent.some((k) => k.code === 'KeyA'), keyWords)

    await app.send({ cmd: 'crash', id: keysId })
    await wait(1500)
    const crashed = ((await app.send({ cmd: 'infos' })) ?? []).find((s) => s.id === keysId)
    check('a crashed page says so on its surface', /crashed/i.test(crashed?.error ?? ''), JSON.stringify(crashed))
    const revived = await agent(h, ready.linkFile, tess, [{ op: 'browser_read', args: { id: keysId } }])
    check('the next call on a crashed tab gets a fresh page', !revived[0]?.isError && (revived[0]?.text ?? '').includes('Keys page'), revived[0]?.text)

    const hung = await agent(h, ready.linkFile, tess, [
      { op: 'browser_open', args: { url: `${ready.base}/hang` } },
      { op: 'browser_read' },
      { op: 'browser_close' }
    ])
    const readMs = (hung[1]?.t1 ?? 0) - (hung[1]?.t0 ?? 0)
    check('reading a hung page says "not responding" instead of waiting forever', (hung[1]?.text ?? '').includes('not responding') && readMs < 15_000, `${readMs}ms: ${hung[1]?.text}`)
    check('browser_close frees a hung tab at once', !hung[2]?.isError && (hung[2]?.text ?? '').includes('Closed tab') && (hung[2]?.t1 ?? 0) - (hung[2]?.t0 ?? 0) < 5_000, hung[2]?.text)
    // Tess's other tabs go, so only Zora's is left for the after-quit checks.
    const tessIds = [tabIn(run1[0]), tabIn(run1[1]), loginId, keysId].filter(Boolean)
    const tidy = await agent(h, ready.linkFile, tess, tessIds.map((id) => ({ op: 'browser_close', args: { id } })))
    check("Tess's remaining tabs close", tessIds.length === 4 && tidy.every((r) => !r.isError), tidy.map((r) => r.text).join('\n'))

    section('6c. Electron: browser_upload into hidden file boxes (tabs not on screen)')
    const uma = { id: 'pane-D', name: 'Uma', agent: 'claude' }
    const statement = join(scratch, 'statement.csv')
    writeFileSync(statement, 'date,amount\n2026-07-01,12.50\n', 'utf8')
    const ups = await agent(h, ready.linkFile, uma, [
      { op: 'browser_open', args: { url: `${ready.base}/upload` } },
      { op: 'browser_upload', args: { path: statement } },
      { op: 'browser_read' },
      { op: 'browser_open', args: { url: `${ready.base}/upload2` } },
      { op: 'browser_upload', args: { path: statement } },
      { op: 'browser_upload', args: { path: statement, which: 1 } },
      { op: 'browser_read' },
      { op: 'browser_upload', args: { path: statement, ref: 2 } },
      { op: 'browser_upload', args: { path: statement, which: 3 } },
      { op: 'browser_upload', args: { path: join(scratch, 'nope.csv') } }
    ])
    const upId = tabIn(ups[0])
    const twoId = tabIn(ups[3])
    check(
      'upload into a hidden box inside a label says what went where',
      !ups[1]?.isError && (ups[1]?.text ?? '') === `Put statement.csv into the file box "Upload Statement" on tab ${upId}. Read the page again to see what changed.`,
      ups[1]?.text
    )
    check("the page's own change handler read the file's bytes", (ups[2]?.text ?? '').includes('Got 2026-07-01,12.50'), ups[2]?.text)
    const ev = await app.send({ cmd: 'tabEval', id: upId, js: 'window.__ev' })
    check('input then change fired, as for a pick by hand (bubbling, so React sees it)', JSON.stringify(ev) === JSON.stringify(['input', 'change:statement.csv']), JSON.stringify(ev))
    const many = ups[4]?.text ?? ''
    check('two boxes and no which: a numbered list, nothing uploaded', !ups[4]?.isError && many.includes('has 2 file boxes') && many.includes('1. "a"') && many.includes('2. "b" (accepts .pdf)') && many.includes('`which`'), many)
    check('which: 1 picks the first box', (ups[5]?.text ?? '').startsWith('Put statement.csv into the file box "a"'), ups[5]?.text)
    check('ref of the button beside a box picks that box', (ups[6]?.text ?? '').includes('[2] button "Upload B"') && (ups[7]?.text ?? '').startsWith('Put statement.csv into the file box "b"'), `${ups[6]?.text}\n${ups[7]?.text}`)
    check('a which past the list is answered with the list', (ups[8]?.text ?? '').includes('There is no file box 3') && (ups[8]?.text ?? '').includes('2. "b"'), ups[8]?.text)
    const got2 = await app.send({ cmd: 'tabEval', id: twoId, js: 'window.__got' })
    check('each box got the file once, the right one each time', JSON.stringify(got2) === JSON.stringify(['a:statement.csv', 'b:statement.csv']), JSON.stringify(got2))
    check('a missing file is refused over the real pipe', ups[9]?.isError === true && (ups[9]?.text ?? '').startsWith('There is no file at'), ups[9]?.text)
    const umaTidy = await agent(h, ready.linkFile, uma, [upId, twoId].filter(Boolean).map((id) => ({ op: 'browser_close', args: { id } })))
    check("Uma's tabs close", umaTidy.length === 2 && umaTidy.every((r) => !r.isError), umaTidy.map((r) => r.text).join('\n'))

    section('6d. Electron: browser_read lists only what a person could see and reach, and `find` (tabs not on screen)')
    const vic = { id: 'pane-E', name: 'Vic', agent: 'claude' }
    const listOf = (text) => (text ?? '').split('\n').filter((l) => /^\[\d+\] /.test(l))
    const busy = await agent(h, ready.linkFile, vic, [
      { op: 'browser_open', args: { url: `${ready.base}/busy` } },
      { op: 'browser_read' },
      { op: 'browser_read', args: { find: 'next' } },
      { op: 'browser_click', args: { ref: 1 } },
      { op: 'browser_read' },
      { op: 'browser_open', args: { url: `${ready.base}/busy?plain=1` } },
      { op: 'browser_read' }
    ])
    const busyItems = listOf(busy[1]?.text)
    check('a modal over a covered till: its buttons come first', busyItems[0] === '[1] button "Close"' && busyItems[1] === '[2] button "Next"', busy[1]?.text)
    check('…the 200 covered till buttons are left out, and the read says so', !busyItems.some((l) => l.includes('Till')) && /Left out: 2\d\d hidden/.test(busy[1]?.text ?? '') && !(busy[1]?.text ?? '').includes('past the limit'), busy[1]?.text)
    check('…and says which numbers are in the dialog on top', (busy[1]?.text ?? '').includes('[1]–[2] are in the dialog on top of the page.'), busy[1]?.text)
    const nextItems = listOf(busy[2]?.text)
    check('find "next" lists only the Next button, numbered 1', nextItems.length === 1 && nextItems[0] === '[1] button "Next"' && (busy[2]?.text ?? '').includes('Only elements whose words contain "next"'), busy[2]?.text)
    check('…and clicking that number presses Next', !busy[3]?.isError && (busy[3]?.text ?? '').startsWith('Clicked "Next"') && (busy[4]?.text ?? '').includes('"Next pressed"'), `${busy[3]?.text}\n${busy[4]?.text}`)
    const plainBusy = listOf(busy[6]?.text)
    check(
      'a full-screen layer with no dialog role, seen covering the till: its buttons first, the till left out',
      plainBusy.length === 3 && plainBusy[0] === '[1] button "Dashboard home"' && plainBusy[1] === '[2] button "Close"' && plainBusy[2] === '[3] button "Next"' && /Left out: 2\d\d hidden/.test(busy[6]?.text ?? ''),
      busy[6]?.text
    )
    const plain = await agent(h, ready.linkFile, vic, [
      { op: 'browser_open', args: { url: `${ready.base}/plain` } },
      { op: 'browser_read' },
      { op: 'browser_open', args: { url: `${ready.base}/long` } },
      { op: 'browser_read' },
      { op: 'browser_open', args: { url: `${ready.base}/ghosts` } },
      { op: 'browser_read' }
    ])
    const plainItems = listOf(plain[1]?.text)
    check('a plain page of 20 buttons lists all 20, with nothing left out', plainItems.length === 20 && plainItems[19] === '[20] button "Plain 20"' && !(plain[1]?.text ?? '').includes('Left out'), plain[1]?.text)
    const longWant = ['Menu', ...Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`), ...Array.from({ length: 40 }, (_, i) => `Low ${i + 1}`)]
    const longSame = (text) => JSON.stringify(listOf(text).map((l) => l.replace(/^\[\d+\] button "(.*)"$/, '$1'))) === JSON.stringify(longWant)
    check('below the fold and inside a scroll box: every button is still listed', longSame(plain[3]?.text) && !(plain[3]?.text ?? '').includes('Left out'), plain[3]?.text)
    const longId = tabIn(plain[2])
    const scrolled = await app.send({
      cmd: 'tabEval',
      id: longId,
      js: 'scrollTo(0, 300); document.getElementById("list").scrollTop = 200; [scrollY, document.getElementById("list").scrollTop, [...document.querySelectorAll("button")].filter((b) => b.textContent.startsWith("Low") && b.getBoundingClientRect().top < 50 && b.getBoundingClientRect().bottom > 0).length]'
    })
    check('the page scrolled 300px, the box 200px, and a button now sits under the header bar', Array.isArray(scrolled) && scrolled[0] === 300 && scrolled[1] === 200 && scrolled[2] >= 1, JSON.stringify(scrolled))
    const [longAgain] = await agent(h, ready.linkFile, vic, [{ op: 'browser_read', args: { id: longId } }])
    check('scrolled: buttons under the fixed header bar, above the fold and scrolled out of the box are all still listed', longSame(longAgain?.text) && !(longAgain?.text ?? '').includes('Left out'), longAgain?.text)
    const ghosts = plain[5]?.text ?? ''
    check('hidden, transparent, inert, aria-hidden, off-canvas, clipped, off-page and covered buttons are left out', listOf(ghosts).every((l) => !l.includes('Ghost')) && ghosts.includes('Left out: 8 hidden'), ghosts)
    check('…while a visible button and a checkbox under its own styled label are kept', listOf(ghosts).some((l) => l.includes('button "Real one"')) && listOf(ghosts).some((l) => l.startsWith('[2] input checkbox')), ghosts)
    const vicIds = [tabIn(busy[0]), tabIn(busy[5]), tabIn(plain[0]), longId, tabIn(plain[4])].filter(Boolean)
    const vicTidy = await agent(h, ready.linkFile, vic, vicIds.map((id) => ({ op: 'browser_close', args: { id } })))
    check("Vic's tabs close", vicIds.length === 5 && vicTidy.every((r) => !r.isError), vicTidy.map((r) => r.text).join('\n'))

    await app.send({ cmd: 'quit' })
    await app.exited
    const { BrowserSurfaceStore } = await import('../electron/browser-panes/store.ts')
    const after = new BrowserSurfaceStore(join(dataDir, 'browser')).all()
    check("after quitting, Zora's surface is on disk with its page and owner", after.length === 1 && after[0].id === idB && after[0].url.includes('/result') && after[0].owner.label === 'Zora', JSON.stringify(after))
    check('after quitting, the link file is gone', !existsSync(ready.linkFile))
  } catch (err) {
    check('the Electron harness ran', false, `${err?.stack ?? err}\n${app.stderr().slice(-2000)}`)
    app.child.kill()
  }

  if (LIVE) {
    section('7. live: the React surface in a visible window, example.com through the bridge path')
    const liveDir = join(scratch, 'live')
    const ui = launch(h, liveDir, true)
    try {
      const { value: ready } = await ui.next(60_000)
      const rex = { id: 'pane-live', name: 'Rex', agent: 'claude' }
      const r = await agent(h, ready.linkFile, rex, [{ op: 'browser_open', args: { url: 'https://example.com' } }, { op: 'browser_read' }])
      check('browser_open example.com through the bridge', !r[0]?.isError && /Opened tab b\d+/.test(r[0]?.text ?? ''), r[0]?.text)
      check('browser_read sees "Example Domain" and a numbered link', (r[1]?.text ?? '').includes('Example Domain') && /\[1\] link "/.test(r[1]?.text ?? ''), r[1]?.text)
      await new Promise((res) => setTimeout(res, 1500))
      const chip = await ui.send({ cmd: 'eval', js: 'document.querySelector(".browser-surface__owner")?.textContent || ""' })
      check('the surface toolbar says who is driving, in words', String(chip).includes('Rex') && String(chip).includes('is driving'), String(chip))
      const url = await ui.send({ cmd: 'eval', js: 'document.querySelector(".browser-surface__bar .browser-surface__url")?.value || ""' })
      check('the URL field shows the page address', String(url).startsWith('https://example.com'), String(url))
      const [shot] = [await agent(h, ready.linkFile, rex, [{ op: 'browser_screenshot' }])]
      const path = (shot[0]?.text ?? '').match(/saved to (.+\.png)/)?.[1]
      check('browser_screenshot through the bridge saved a PNG', !!path && existsSync(path), shot[0]?.text)
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true })
        if (path && existsSync(path)) copyFileSync(path, join(SHOTS, 'b3-tab-example.png'))
        const comp = await ui.send({ cmd: 'composite', out: join(SHOTS, 'b3-surface-example.png') }, 30_000)
        check('composite of the surface (toolbar + page) saved', !comp.error && existsSync(join(SHOTS, 'b3-surface-example.png')), JSON.stringify(comp))
        console.log(`       shots: ${join(SHOTS, 'b3-tab-example.png')}\n              ${join(SHOTS, 'b3-surface-example.png')}`)
      }
      await ui.send({ cmd: 'quit' })
      await ui.exited
    } catch (err) {
      check('the live harness ran', false, `${err?.stack ?? err}\n${ui.stderr().slice(-2000)}`)
      ui.child.kill()
    }
  }
}

cleanup()
console.log(`\nbrowser:check — ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

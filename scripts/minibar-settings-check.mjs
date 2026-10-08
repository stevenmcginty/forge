/**
 * Check for the mini bar's master switch (docs/MINI-BAR.md, 4.8).
 *
 *   node scripts/minibar-settings-check.mjs
 *
 * Steve: off by default, "so by default it acts exactly how it acts today".
 * Pure Node, no Electron: electron/store.ts is loaded as it is against a
 * scratch data folder, and electron/minibar-window.ts against a stand-in
 * `electron` (and stand-ins for its app-side neighbours) that counts every
 * window built and every message sent to the main window.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ------------------------------------------------------------ stand-ins */

const mod = (src) => `data:text/javascript,${encodeURIComponent(src)}`

/** What the stand-ins report back. */
globalThis.__mb = { created: [], settings: {} }

const ELECTRON = mod(`
const t = globalThis.__mb
const noop = () => {}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
export class BrowserWindow {
  constructor(opts) {
    t.created.push(opts)
    this.webContents = { on: noop, once: noop, send: noop, setWindowOpenHandler: noop }
  }
  isDestroyed() { return false }
  isVisible() { return false }
  isMinimized() { return false }
  getBounds() { return { x: 0, y: 0, width: 800, height: 52 } }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  on() {} once() {} show() {} showInactive() {} hide() {} focus() {} setBounds() {}
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setMenuBarVisibility() {} setIgnoreMouseEvents() {}
}
export const app = { on: noop, getPath: () => '' }
export const dialog = {}
export const ipcMain = { on: noop, handle: noop }
export const screen = {
  getDisplayMatching: () => display,
  getPrimaryDisplay: () => display,
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getAllDisplays: () => [display]
}
export default { app, BrowserWindow, dialog, ipcMain, screen }
`)

const NEIGHBOURS = {
  './store': mod(`
export const getSettings = () => globalThis.__mb.settings
export const setSettings = (p) => Object.assign(globalThis.__mb.settings, p)
export const getProjects = () => []
export const getWorkspace = () => null
`),
  './tray': mod(`export const isQuitting = () => false`),
  './overlay-window': mod(`export const clampToScreen = (r) => r`),
  './pane-reply': mod(`export const lastReply = async () => null`),
  './quit-guard': mod(`export const allowClose = () => {}; export const quitSummary = () => ({ running: 0, resume: 0, lost: 0 })`)
}

registerHooks({
  resolve(spec, context, next) {
    const fromWindow = context.parentURL?.includes('/electron/minibar-window.ts')
    if (spec === 'electron') return { url: ELECTRON, shortCircuit: true }
    if (fromWindow && NEIGHBOURS[spec]) return { url: NEIGHBOURS[spec], shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) {
      return next(url, { ...context, format: 'module-typescript' })
    }
    return next(url, context)
  }
})

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
const is = (got, want, label) => ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/* ------------------------------------------------------- store defaults */

const scratch = mkdtempSync(join(tmpdir(), 'forge-minibar-settings-'))
let n = 0
/** A fresh electron/store.ts on its own data folder, holding this settings.json (or none). */
async function storeWith(settings) {
  const dir = join(scratch, `case-${++n}`)
  process.env.FORGE_DATA_DIR = dir
  if (settings !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
  }
  return import(`../electron/store.ts?case=${n}`)
}

try {
  console.log('store defaults')
  {
    const s = (await storeWith(undefined)).getSettings()
    is(s.miniBar, false, 'a new install: miniBar is off')
    is(s.miniGlobalKeys && s.shotsOnDesktop && s.miniSpeakUpdates && s.miniChime, true, 'a new install: the four under it keep their own default (on)')
  }
  {
    const s = (await storeWith({ onboarded: true, shotsOnDesktop: true })).getSettings()
    is(s.miniBar, false, 'a settings.json from before the bar: miniBar is off')
  }
  {
    const s = (await storeWith({ onboarded: true, miniBar: true })).getSettings()
    is(s.miniBar, true, 'turned on stays on')
  }
  {
    const s = (await storeWith({ onboarded: true, miniBar: 'yes' })).getSettings()
    is(typeof s.miniBar, 'boolean', 'a junk value is sanitised to a boolean')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.FORGE_DATA_DIR
}

/* ------------------------------------------------------ the minimise path */

console.log('minimise with the bar off')
// The view loads from the dev URL in this check, so the stand-in never needs a file path.
process.env.ELECTRON_RENDERER_URL = 'http://localhost:0'
globalThis.__dirname = join(process.cwd(), 'out', 'main')
const win = await import('../electron/minibar-window.ts')
const { IPC } = await import('../shared/ipc.ts')

const toMain = []
const mainWindow = {
  isDestroyed: () => false,
  isMinimized: () => true,
  getNormalBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
  webContents: { on: () => {}, send: (channel, payload) => toMain.push({ channel, payload }) }
}
win.setMiniBarHost(mainWindow)
const modeOn = () => toMain.some((m) => m.channel === IPC.minibarMode && m.payload?.on === true)

globalThis.__mb.settings = { miniBar: false, miniGlobalKeys: true, shotsOnDesktop: true, miniSpeakUpdates: true, miniChime: true }
win.showMiniBar() // main.ts: mainWindow.on('minimize', showMiniBar)
is(globalThis.__mb.created.length, 0, 'minimising builds no bar window')
is(modeOn(), false, 'and never tells the host minibar:mode on')
win.summon() // the summon key's route in
is(globalThis.__mb.created.length, 0, 'the summon route builds none either')
is(modeOn(), false, 'nor turns mini mode on')

console.log('minimise with the bar on (the control)')
globalThis.__mb.settings.miniBar = true
win.showMiniBar()
is(globalThis.__mb.created.length, 1, 'minimising builds the bar window')
is(modeOn(), true, 'and tells the host minibar:mode on')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

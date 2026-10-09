import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { IPC } from '@shared/ipc'
import type { MiniBarCall, MiniBarQuitInfo, MiniBarState, RemoteKey } from '@shared/minibar'
import { clampToScreen } from './overlay-window'
import { lastReply, type PanePlace } from './pane-reply'
import { allowClose, quitSummary } from './quit-guard'
import { getProjects, getSettings, getWorkspace, setSettings } from './store'
import { isQuitting } from './tray'

/**
 * The mini bar: a floating bar on the desktop while Forge's main window is
 * minimised (docs/MINI-BAR.md).
 *
 * Built the way electron/overlay-window.ts builds the undocked voice hub, and
 * for the same reasons — read that file's header first. A frameless,
 * transparent, always-on-top window at the 'screen-saver' level, NOT a child
 * of the main window (a child minimises with its parent, which is the one
 * thing this must not do), and shown inactive, so appearing never takes the
 * keyboard from the app Steve switched to.
 *
 * What this file is NOT: the mini bar's brain. The main window's renderer
 * keeps running while minimised (`backgroundThrottling: false`) and is the
 * HOST: the only writer of MiniBarState, and the one place every MiniBarCall
 * runs. The #minibar window is a view. Main is the wire in between, and it
 * caches the last state so a freshly loaded view draws at once:
 *
 *   host  --minibar:publish-->  main  --minibar:state-->  view
 *   view  --minibar:call----->  main  --minibar:call--->  host
 *
 * Created on the first minimise and then only hidden, never destroyed, so the
 * next minimise shows it without a page load. Destroyed in `before-quit`.
 */

/** The bar row's height; the view grows the window upward from here. */
const BAR_HEIGHT = 52
/** Default gap between the bar and the bottom of the work area (the taskbar). */
const BOTTOM_GAP = 12
/** Default width: 94% of the work area, within a cap and a floor (wide, so more fits). */
const WIDTH_SHARE = 0.94
const MAX_WIDTH = 2400
const MIN_WIDTH = 640
/** The cap before the bar went wide. Wider than this, a saved width can only be a drag. */
const OLD_MAX_WIDTH = 1240
/** clampToScreen's margin, on both sides: the widest a bar can be is the work area less this twice. */
const EDGE = 8
/** A drag or an end-resize is saved once it settles. */
const SAVE_MS = 400

/** The main window: the host. */
let host: BrowserWindow | null = null
let bar: BrowserWindow | null = null
/** The bar has loaded once and may be shown. */
let ready = false
/** What the host was last told: the bar is up. */
let mode = false
/** Focus the bar as well as showing it, once it is ready (a summon before the first load). */
let focusWhenReady = false
/** The host's last MiniBarState, for a view that loads after it was published. */
let lastState: MiniBarState | null = null
/**
 * The bar's words as main last saw them pass (the view's `setDraft`, or a
 * draft the host published), while the bar is up. A host that reloads gets
 * them back with its mode, or they would die with the old renderer.
 */
let lastDraft: string | null = null
/** The bar's current height, as the view last asked for it. */
let height = BAR_HEIGHT
/** Set while we move the window ourselves, so our own setBounds is not saved as a drag. */
let placing = false
let saveTimer: NodeJS.Timeout | null = null
let openMain: (() => void) | null = null

function hostAlive(): boolean {
  return !!host && !host.isDestroyed()
}

function barAlive(): boolean {
  return !!bar && !bar.isDestroyed()
}

function toHost(channel: string, payload: unknown): void {
  if (!hostAlive()) return
  host!.webContents.send(channel, payload)
}

function toBar(channel: string, payload: unknown): void {
  if (!barAlive()) return
  bar!.webContents.send(channel, payload)
}

function sendMode(): void {
  toHost(IPC.minibarMode, mode && lastDraft !== null ? { on: true, draft: lastDraft } : { on: mode })
}

/**
 * Clicks on the see-through room around the surfaces fall through to the app
 * below. The view says when the pointer crosses into or out of that room;
 * `forward` keeps the pointer's moves coming to it meanwhile, so it can tell
 * when to take clicks again.
 */
export function setClickThrough(win: BrowserWindow, on: boolean): void {
  if (win.isDestroyed()) return
  if (on) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

/* ------------------------------------------------------------------ host */

/**
 * The main window, or null when it has gone. Its every load (a dev reload, a
 * renderer the watchdog revived) is told the current mode, so a remounted host
 * starts publishing again at once.
 */
export function setMiniBarHost(win: BrowserWindow | null): void {
  host = win
  if (!win) {
    // No host, no bar: a bar wired to a renderer that no longer exists is a
    // dead strip floating over every other app.
    hideMiniBar()
    return
  }
  win.webContents.on('did-finish-load', () => {
    if (host === win) sendMode()
  })
}

/** True while the main window is minimised. */
export function isMainMinimised(): boolean {
  return hostAlive() && host!.isMinimized()
}

/** A MiniBarCall for the host, from the bar or from the shot card. */
export function callHost(call: MiniBarCall): void {
  toHost(IPC.minibarCall, call)
}

/** A talk key, another key or a summon from the global key hook (electron/global-keys.ts). */
export function sendRemoteKey(key: RemoteKey): void {
  toHost(IPC.keysRemote, key)
}

/* ---------------------------------------------------------------- bounds */

/** Keep a rectangle on its display's work area, never wider or taller than it. */
function clampRect(rect: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getDisplayMatching(rect).workArea
  const width = Math.min(rect.width, Math.max(1, area.width - 2 * EDGE))
  const tall = Math.min(rect.height, Math.max(1, area.height - 2 * EDGE))
  return clampToScreen({ x: rect.x, y: rect.y, width, height: tall })
}

function defaultWidth(area: Electron.Rectangle): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, area.width * WIDTH_SHARE)))
}

/**
 * Once only (`miniBarWidened`): the default went from 70% to 94%, and a width
 * saved under the old default would hide the new one. A saved width narrower
 * than its display's new default becomes that default, centred, with the same
 * bottom edge. A display not plugged in now cannot be measured: its entry is
 * dropped unless it is wider than the old cap. After this, a deliberate drag
 * narrower is saved and kept like any other.
 */
function widenOnce(): void {
  const s = getSettings()
  if (s.miniBarWidened) return
  const displays = screen.getAllDisplays()
  const next: Record<string, { x: number; y: number; width: number }> = {}
  for (const [id, b] of Object.entries(s.miniBarBounds ?? {})) {
    const display = displays.find((d) => String(d.id) === id)
    if (!display) {
      if (b.width > OLD_MAX_WIDTH) next[id] = b
      continue
    }
    const area = display.workArea
    const width = defaultWidth(area)
    next[id] = b.width < width ? { x: Math.round(area.x + (area.width - width) / 2), y: b.y, width } : b
  }
  setSettings({ miniBarBounds: next, miniBarWidened: true })
}

/**
 * Where the bar goes when it shows: where Steve last put it on the display
 * the main window is on, else bottom centre of that display's work area,
 * 12 px above the taskbar.
 */
function homeRect(): Electron.Rectangle {
  widenOnce()
  // getNormalBounds, not getBounds: a minimised window's bounds on Windows
  // are parked far off screen.
  const display = hostAlive() ? screen.getDisplayMatching(host!.getNormalBounds()) : screen.getPrimaryDisplay()
  const area = display.workArea
  const saved = getSettings().miniBarBounds?.[String(display.id)]
  if (saved) {
    // Saved by its bottom edge: the bar grows upward, so that is what stays put.
    return clampRect({ x: saved.x, y: saved.y - height, width: saved.width, height })
  }
  const width = defaultWidth(area)
  return clampRect({
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + area.height - BOTTOM_GAP - height,
    width,
    height
  })
}

/** Move/resize without it being saved as a user gesture. */
function place(rect: Electron.Rectangle): void {
  if (!barAlive()) return
  placing = true
  try {
    // An unresizable window can refuse a size change on Windows (see place()
    // in overlay-window.ts), so it is resizable for exactly as long as it takes.
    bar!.setResizable(true)
    bar!.setBounds(rect)
    bar!.setResizable(false)
  } finally {
    placing = false
  }
}

/** Save the bar's left edge, bottom edge and width for the display it is on, once things settle. */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveBounds, SAVE_MS)
}

function saveBounds(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!barAlive()) return
  const b = bar!.getBounds()
  const id = String(screen.getDisplayMatching(b).id)
  setSettings({
    miniBarBounds: { ...(getSettings().miniBarBounds ?? {}), [id]: { x: b.x, y: b.y + b.height, width: b.width } }
  })
}

/**
 * The view's new content size. The bottom edge stays where it is; a new width
 * (Steve dragged an end) keeps the bar's centre and is saved. A width sent by
 * the tucked pill is not saved: it is the pill's, not the bar's.
 */
function resize(size: { height?: unknown; width?: unknown }): void {
  if (!barAlive()) return
  const wantH = Number(size?.height)
  const wantW = size?.width === undefined ? NaN : Number(size.width)
  if (!Number.isFinite(wantH) || wantH <= 0) return
  height = Math.round(wantH)
  const b = bar!.getBounds()
  const width = Number.isFinite(wantW) && wantW > 0 ? Math.round(wantW) : b.width
  const rect = clampRect({
    x: Math.round(b.x + (b.width - width) / 2),
    y: b.y + b.height - height,
    width,
    height
  })
  place(rect)
  if (Number.isFinite(wantW) && lastState?.tucked !== true) scheduleSave()
}

/** Displays came, went or changed (DPI, taskbar): pull the bar back onto one. */
function reclamp(): void {
  if (!barAlive()) return
  place(clampRect(bar!.getBounds()))
}

/* ---------------------------------------------------------------- window */

function createBar(): BrowserWindow {
  const win = new BrowserWindow({
    ...homeRect(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Windows 11 draws its own corners, which do not follow our CSS radius.
    roundedCorners: false,
    resizable: false,
    // Deliberately absent: `parent`. A child minimises with the main window.
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // The first click both focuses the bar and presses what is under it.
    acceptFirstMouse: true,
    focusable: true,
    title: 'Forge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Always in the background by design; its heartbeat check and dictation
      // countdown must not tick once a second.
      backgroundThrottling: false
    }
  })

  // 'screen-saver', not 'floating': floating loses to a maximised Chrome.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setMenuBarVisibility(false)

  // A drag by the grip is the only move worth saving; our own place() calls
  // are filtered by `placing`.
  win.on('moved', () => {
    if (!placing) scheduleSave()
  })

  // Some shell interactions quietly demote a topmost window. See overlay-window.ts.
  win.on('blur', () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
  })

  win.on('closed', () => {
    if (bar === win) {
      bar = null
      ready = false
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Same preload as the main window, so the same rule: nothing navigates it.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
  // A view that (re)loads gets the last state at once rather than after the
  // host's next publish.
  win.webContents.on('did-finish-load', () => {
    // A fresh page has not said where the pointer is: take clicks until it does.
    setClickThrough(win, false)
    if (lastState) toBar(IPC.minibarState, lastState)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}#minibar`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'minibar' })
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    ready = true
    if (!mode) return
    if (focusWhenReady) {
      focusWhenReady = false
      win.show()
      win.focus()
    } else {
      win.showInactive()
    }
  })

  return win
}

/**
 * The main window was minimised: show the bar, inactive, and tell the host.
 * Never while Forge is quitting, with the setting off, or with no main window.
 */
export function showMiniBar(): void {
  if (isQuitting() || !hostAlive() || !getSettings().miniBar) return
  if (!barAlive()) {
    bar = createBar()
  } else {
    place(homeRect())
    if (ready && !bar!.isVisible()) bar!.showInactive()
  }
  if (!mode) {
    mode = true
    // A new minimise: the host takes the big bar's words, not the last bar's.
    lastDraft = null
    sendMode()
  }
}

/** The main window is back (restored, shown or focused): hide the bar and tell the host. */
export function hideMiniBar(): void {
  focusWhenReady = false
  if (barAlive() && bar!.isVisible()) bar!.hide()
  if (mode) {
    mode = false
    lastDraft = null
    sendMode()
  }
}

/** Show the bar and give it the keyboard (the summon key). Only while Forge is minimised. */
export function summon(): void {
  if (!isMainMinimised()) return
  showMiniBar()
  if (!barAlive()) return
  if (!ready) {
    focusWhenReady = true
    return
  }
  bar!.show()
  bar!.focus()
}

/* ----------------------------------------------------------------- relay */

/** The places a pane's transcript may be found: every project's folder and saved layout, in turn. */
function* panePlaces(): Generator<PanePlace> {
  for (const project of getProjects()) yield { path: project.path, workspace: getWorkspace(project.id) }
}

/**
 * The relay and the bar's own requests. Needs the app to be ready (`screen`).
 * `openMainWindow` is main.ts's: restore, show, focus — or build a new window.
 */
export function registerMiniBarIpc(deps: { openMainWindow: () => void }): void {
  openMain = deps.openMainWindow

  // Host → view. Cached, so a view that loads later still draws at once.
  ipcMain.on(IPC.minibarPublish, (e, state: MiniBarState) => {
    if (!hostAlive() || e.sender !== host!.webContents) return
    // The hand-off at minimise, or the host moved the words itself (picked
    // paths, words it gave back). Its heartbeat repeats them: that is no news.
    if (mode && typeof state?.draft === 'string' && (lastDraft === null || state.draft !== lastState?.draft)) {
      lastDraft = state.draft
    }
    lastState = state
    toBar(IPC.minibarState, state)
  })

  // View → host. Main has no opinion on the payload.
  ipcMain.on(IPC.minibarCall, (e, call: MiniBarCall) => {
    if (!barAlive() || e.sender !== bar!.webContents) return
    if (mode && call?.t === 'setDraft' && typeof call.text === 'string') lastDraft = call.text
    callHost(call)
  })

  ipcMain.on(IPC.minibarClickThrough, (e, on: unknown) => {
    if (!barAlive() || e.sender !== bar!.webContents) return
    setClickThrough(bar!, on === true)
  })

  ipcMain.on(IPC.minibarResize, (e, size: { height?: unknown; width?: unknown }) => {
    if (!barAlive() || e.sender !== bar!.webContents) return
    resize(size ?? {})
  })

  ipcMain.handle(IPC.minibarOpenMain, (_e, maximised: unknown) => {
    openMain?.()
    if (maximised === true && hostAlive()) host!.maximize()
  })

  ipcMain.handle(IPC.minibarQuitInfo, (): MiniBarQuitInfo => quitSummary())

  // Exactly the main window's X: no watchdog pause (decided, D2). allowClose()
  // because the bar has already asked, in its own confirm row.
  ipcMain.handle(IPC.minibarQuit, (_e, opts: { dontAskAgain?: unknown } | undefined) => {
    if (opts?.dontAskAgain === true) setSettings({ confirmOnQuit: false })
    allowClose()
    app.quit()
  })

  // Parented to the bar, never to the minimised main window, where it could
  // open out of sight.
  ipcMain.handle(IPC.minibarPickFiles, async (): Promise<string[]> => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const result = barAlive() ? await dialog.showOpenDialog(bar!, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.panesLastReply, (_e, paneId: unknown) => lastReply(String(paneId ?? ''), panePlaces()))

  screen.on('display-added', reclamp)
  screen.on('display-removed', reclamp)
  screen.on('display-metrics-changed', reclamp)
}

/** Called on the way out, so a topmost window cannot outlive the app. */
export function disposeMiniBar(): void {
  if (saveTimer) saveBounds()
  screen.removeListener('display-added', reclamp)
  screen.removeListener('display-removed', reclamp)
  screen.removeListener('display-metrics-changed', reclamp)
  const win = bar
  bar = null
  ready = false
  mode = false
  lastDraft = null
  if (win && !win.isDestroyed()) win.destroy()
  host = null
}

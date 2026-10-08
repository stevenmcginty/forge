import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '@shared/ipc'
import type { Shot } from '@shared/types'
import { callHost } from './minibar-window'

/**
 * The desktop shot card: a new screen capture, popped at the top right of the
 * screen while Forge is minimised (docs/MINI-BAR.md 4.7). The desktop twin of
 * the big window's ShotPop.
 *
 * Built like the mini bar and the overlay (frameless, transparent, topmost,
 * not a child of the main window), with one difference that matters: it is
 * NOT focusable and never calls focus(). A card that took the keyboard would
 * eat the next keystrokes of whatever Steve was typing when he pressed
 * Win+Shift+S. Clicks and drags still reach it.
 *
 * Created on the first shot and then only hidden. Where it shows is decided
 * at every show: the work area of the display under the mouse pointer, which
 * is where the snip was just taken.
 */

const CARD_WIDTH = 288
const CARD_HEIGHT = 230
/** In from the top and right edges of the work area. */
const INSET = 14

let card: BrowserWindow | null = null
let ready = false
/** Shots that arrived before the card's page had loaded, oldest first. */
let pending: Shot[] = []

function cardAlive(): boolean {
  return !!card && !card.isDestroyed()
}

/** Top right of the work area of the display under the pointer. */
function cardRect(): Electron.Rectangle {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: area.x + area.width - CARD_WIDTH - INSET,
    y: area.y + INSET,
    width: CARD_WIDTH,
    height: CARD_HEIGHT
  }
}

function createCard(): BrowserWindow {
  const win = new BrowserWindow({
    ...cardRect(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    // Deliberately absent: `parent`. See electron/overlay-window.ts.
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    acceptFirstMouse: true,
    // Never the keyboard: see the header.
    focusable: false,
    title: 'Forge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Its 10 s timer and fade run while nothing of Forge's has focus.
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setMenuBarVisibility(false)

  win.on('closed', () => {
    if (card === win) {
      card = null
      ready = false
      pending = []
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Same preload as the main window, so the same rule: nothing navigates it.
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  // The page subscribes as it mounts, so the shots that came first are
  // handed over once it has loaded.
  win.webContents.on('did-finish-load', () => {
    ready = true
    const queued = pending
    pending = []
    if (queued.length === 0 || win.isDestroyed()) return
    for (const shot of queued) win.webContents.send(IPC.shotcardShow, { shot })
    win.showInactive()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}#shotcard`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'shotcard' })
  }

  return win
}

/** Pop a shot on the desktop. Inactive: it never takes focus. */
export function showShotCard(shot: Shot): void {
  if (!cardAlive()) {
    card = createCard()
    pending.push(shot)
    return
  }
  if (!ready) {
    pending.push(shot)
    return
  }
  // Only moved while hidden: a card already up stays put and stacks the new
  // shot, rather than jumping to another screen under the pointer.
  if (!card!.isVisible()) card!.setBounds(cardRect())
  card!.webContents.send(IPC.shotcardShow, { shot })
  if (!card!.isVisible()) card!.showInactive()
}

/** The card has faded out. */
export function hideShotCard(): void {
  if (cardAlive() && card!.isVisible()) card!.hide()
}

export function registerShotCardIpc(): void {
  ipcMain.on(IPC.shotcardDone, (e) => {
    if (!cardAlive() || e.sender !== card!.webContents) return
    hideShotCard()
  })

  // A click on the picture: the path goes into the mini bar's box. The host
  // decides what that means (the bar may not be up); main only carries it.
  ipcMain.on(IPC.shotcardToMiniBar, (e, paths: unknown) => {
    if (!cardAlive() || e.sender !== card!.webContents) return
    if (!Array.isArray(paths)) return
    const clean = paths.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 20)
    if (clean.length > 0) callHost({ t: 'paths', paths: clean })
  })
}

/** Called on the way out, so a topmost window cannot outlive the app. */
export function disposeShotCard(): void {
  const win = card
  card = null
  ready = false
  pending = []
  if (win && !win.isDestroyed()) win.destroy()
}

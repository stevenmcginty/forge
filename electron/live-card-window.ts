import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '@shared/ipc'
import type { LiveCardAnswer, LiveCardChoice, LiveCardOffer } from '@shared/live-card'
import { getMainWindow } from './main-window'
import { setClickThrough } from './minibar-window'

/**
 * Claude Live's desktop card (shared/live-card.ts): "Lena needs you — Push it
 * / Show me / Later", popped at the top right of the screen while Forge is
 * minimised or not the window in front. The spoken line still plays; this is
 * for when he is looking at something else.
 *
 * Built like the shot card (electron/shot-card-window.ts): frameless,
 * transparent, topmost, not a child of the main window, and NOT focusable —
 * a card that took the keyboard would eat what he is typing elsewhere. Clicks
 * still reach it. Created on the first card, then only hidden.
 *
 * The main renderer offers (it hears the news and knows the ledger); this
 * decides whether Forge is away. A tap is passed back to the main renderer,
 * which does what the rail's flyout does; "Show me" also brings Forge up,
 * because he asked to see it.
 */

const CARD_WIDTH = 360
/** Room for the card at its tallest (three lines of news) and its shadow. */
const CARD_HEIGHT = 210
/** In from the top and right edges of the work area, as the shot card. */
const INSET = 14

let card: BrowserWindow | null = null
let ready = false
/** The card waiting for the page to load: only the newest matters. */
let pending: LiveCardOffer | null = null
/** The offer on the card now, so a tap is only taken for the card it was on. */
let showing: LiveCardOffer | null = null

function cardAlive(): boolean {
  return !!card && !card.isDestroyed()
}

/** Forge is not in front: minimised, hidden, or behind another window. */
function forgeAway(): boolean {
  const win = getMainWindow()
  if (!win) return false
  return win.isMinimized() || !win.isVisible() || !win.isFocused()
}

function cardRect(): Electron.Rectangle {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return { x: area.x + area.width - CARD_WIDTH - INSET, y: area.y + INSET, width: CARD_WIDTH, height: CARD_HEIGHT }
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
      // Its fade timer runs while nothing of Forge's has focus.
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
      pending = null
      showing = null
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  win.webContents.on('did-finish-load', () => {
    ready = true
    setClickThrough(win, false)
    const offer = pending
    pending = null
    if (!offer || win.isDestroyed()) return
    showing = offer
    win.webContents.send(IPC.livecardShow, offer)
    win.showInactive()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}#livecard`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'livecard' })

  return win
}

/** Pop a card, if Forge is away. Inactive: it never takes focus. */
export function offerLiveCard(offer: LiveCardOffer): void {
  if (!forgeAway()) return
  if (!cardAlive()) {
    card = createCard()
    pending = offer
    return
  }
  if (!ready) {
    pending = offer
    return
  }
  // Only moved while hidden: a card already up stays put and takes the new news.
  if (!card!.isVisible()) card!.setBounds(cardRect())
  showing = offer
  card!.webContents.send(IPC.livecardShow, offer)
  if (!card!.isVisible()) card!.showInactive()
}

export function hideLiveCard(): void {
  showing = null
  if (cardAlive() && card!.isVisible()) card!.hide()
}

/** He asked to see it: Forge comes back to the front, restored first (a focused minimised window stays minimised on Windows). */
function bringForgeUp(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function isChoice(value: unknown): value is LiveCardChoice {
  return value === 'push' || value === 'show' || value === 'later'
}

export function registerLiveCardIpc(): void {
  ipcMain.on(IPC.livecardOffer, (e, offer: unknown) => {
    if (e.sender !== getMainWindow()?.webContents) return
    if (!offer || typeof offer !== 'object') return
    const o = offer as Partial<LiveCardOffer>
    if (typeof o.id !== 'string' || typeof o.text !== 'string' || (o.urgency !== 'needs-you' && o.urgency !== 'done')) return
    offerLiveCard({
      id: o.id,
      ...(typeof o.jobId === 'string' ? { jobId: o.jobId } : {}),
      who: typeof o.who === 'string' && o.who ? o.who : 'Forge',
      text: o.text,
      urgency: o.urgency,
      canShow: o.canShow === true
    })
  })

  ipcMain.on(IPC.livecardAnswer, (e, answer: unknown) => {
    if (!cardAlive() || e.sender !== card!.webContents) return
    const a = (answer ?? {}) as Partial<LiveCardAnswer>
    const on = showing
    hideLiveCard()
    if (!on || a.id !== on.id || !isChoice(a.choice)) return
    if (a.choice === 'later') return
    if (a.choice === 'show') bringForgeUp()
    const reply: LiveCardAnswer = { id: on.id, choice: a.choice, ...(on.jobId ? { jobId: on.jobId } : {}) }
    getMainWindow()?.webContents.send(IPC.livecardChoice, reply)
  })

  ipcMain.on(IPC.livecardDone, (e) => {
    if (!cardAlive() || e.sender !== card!.webContents) return
    hideLiveCard()
  })

  // The room around the card (its window is the tallest card's size) lets clicks through.
  ipcMain.on(IPC.livecardClickThrough, (e, on: unknown) => {
    if (!cardAlive() || e.sender !== card!.webContents) return
    setClickThrough(card!, on === true)
  })
}

/**
 * Forge is back in front: the rail's flyout has the same question, so the
 * card goes. Called from main once the main window exists.
 */
export function watchMainForLiveCard(win: BrowserWindow): void {
  win.on('focus', hideLiveCard)
  win.on('restore', hideLiveCard)
}

/** Called on the way out, so a topmost window cannot outlive the app. */
export function disposeLiveCard(): void {
  const win = card
  card = null
  ready = false
  pending = null
  showing = null
  if (win && !win.isDestroyed()) win.destroy()
}

import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '@shared/ipc'
import type { OverlayBounds } from '@shared/api'

/**
 * The undocked voice hub, as a real window.
 *
 * Steve's ask, in his words: "when it is undocked it should float on top of
 * everything in windows it should work even when the app is minimised, it
 * should work when I'm in chrome". None of that is possible for a `<div>`. The
 * in-window hub (src/components/VoiceHub.tsx) is clamped to Forge's client
 * area by construction — it cannot be over Chrome, because Chrome is another
 * process's window and Forge is behind it.
 *
 * So undocking now opens *this*: a frameless, transparent, always-on-top
 * BrowserWindow that is not a child of the main window and does not appear in
 * the taskbar. Three properties do the work Steve actually asked for:
 *
 *   • ALWAYS ON TOP, at the screen-saver level rather than the merely-floating
 *     one. 'floating' loses to a maximised Chrome on Windows; 'screen-saver'
 *     does not, and it is the level Electron's own docs point at for exactly
 *     this "little always-visible panel" case.
 *
 *   • NOT A CHILD. It is tempting to pass `parent: mainWindow` — it makes the
 *     two windows feel related and saves a line of teardown. It is also the
 *     bug: a child window minimises, hides and restores *with* its parent, so
 *     the one thing that was asked for (works when the app is minimised) would
 *     be the one thing it could not do. It is a top-level window that happens
 *     to be owned by the same process.
 *
 *   • SHOWN INACTIVE. `showInactive()`, never `show()`. The overlay appearing
 *     must not steal focus from whatever he is typing into — that is the whole
 *     difference between a thing that floats over Chrome and a thing that
 *     interrupts Chrome. It becomes focusable the moment it is clicked, which
 *     is what lets the composer be typed into.
 *
 * What this file is NOT: an agent. It owns no transcript subscription, no
 * sidecar, no speaker. It is a window plus a relay, and the relay is
 * deliberately stupid — it forwards opaque payloads between the host renderer
 * and the overlay renderer and never looks inside one. The single voice agent
 * stays where it has always been, in the main window, so there is still
 * exactly one of everything. See shared/ipc.ts for the direction of each leg.
 */

/** The main window — the one that holds the real engine. */
let host: BrowserWindow | null = null
let overlay: BrowserWindow | null = null

/** Set while we are moving the window ourselves, so we don't echo it back. */
let placing = false

export function setOverlayHost(win: BrowserWindow | null): void {
  host = win
  // The host going away takes the overlay with it: a floating pill wired to a
  // renderer that no longer exists is a dead button that still looks alive.
  if (!win) closeOverlay()
}

function hostAlive(): boolean {
  return !!host && !host.isDestroyed()
}

function toHost(channel: string, payload: unknown): void {
  if (!hostAlive()) return
  host!.webContents.send(channel, payload)
}

function toOverlay(channel: string, payload: unknown): void {
  if (!overlay || overlay.isDestroyed()) return
  overlay.webContents.send(channel, payload)
}

/* ------------------------------------------------------------------ bounds */

/**
 * Keep the overlay somewhere a mouse can reach it.
 *
 * Against the *work area* of the nearest display, not the display bounds: the
 * taskbar is not somewhere a window can usefully be, and a pill dropped behind
 * it is a pill you have to edit settings.json to get back.
 *
 * `getDisplayMatching` rather than `getPrimaryDisplay` is what makes the
 * overlay a multi-monitor citizen — dropped on the second screen it is clamped
 * to the second screen, which is where Chrome usually is.
 */
function clampToScreen(bounds: OverlayBounds): Electron.Rectangle {
  const width = Math.max(1, Math.round(bounds.width))
  const height = Math.max(1, Math.round(bounds.height))
  const wanted = { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height }
  const area = screen.getDisplayMatching(wanted).workArea
  // A margin, so it never sits flush in a corner looking like a rendering
  // artefact — and so there is always a grabbable edge outside it.
  const edge = 8
  const maxX = area.x + area.width - width - edge
  const maxY = area.y + area.height - height - edge
  return {
    width,
    height,
    // The floor wins over the ceiling: on a display smaller than the card,
    // flush with the top-left beats a negative coordinate.
    x: Math.round(Math.max(area.x + edge, Math.min(maxX, wanted.x))),
    y: Math.round(Math.max(area.y + edge, Math.min(maxY, wanted.y)))
  }
}

/** Move/resize without the move being reported back as a user gesture. */
function place(bounds: OverlayBounds): void {
  if (!overlay || overlay.isDestroyed()) return
  const rect = clampToScreen(bounds)
  placing = true
  // Resizability is set before the bounds: a window still marked unresizable
  // silently refuses a size change on Windows, which is how a pill expanding
  // into a card ends up pill-sized with a card drawn inside it.
  overlay.setResizable(bounds.resizable === true)
  if (bounds.resizable) {
    overlay.setMinimumSize(340, 400)
    overlay.setMaximumSize(760, 1000)
  } else {
    // Clearing the minimum first — a 180×56 pill is smaller than the card's
    // minimum, and setBounds is clamped by whatever the old minimum was.
    overlay.setMinimumSize(1, 1)
    overlay.setMaximumSize(0, 0)
  }
  overlay.setBounds(rect)
  placing = false
}

/* ------------------------------------------------------------------ window */

export function isOverlayOpen(): boolean {
  return !!overlay && !overlay.isDestroyed()
}

export function openOverlay(bounds: OverlayBounds): void {
  if (isOverlayOpen()) {
    place(bounds)
    if (!overlay!.isVisible()) overlay!.showInactive()
    return
  }
  if (!hostAlive()) return

  const rect = clampToScreen(bounds)

  overlay = new BrowserWindow({
    ...rect,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Windows draws its own rounded corners on an 11 window and they do not
    // follow our border-radius, so the result is a light grey arc around a
    // dark pill. Ours are in CSS.
    roundedCorners: false,
    resizable: bounds.resizable === true,
    // Deliberately absent: `parent`. See the header — a child window would
    // minimise with Forge, which is the one thing this must not do.
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // So the first click both focuses the overlay and presses the button under
    // the pointer. Without it, talking to a floating pill takes two clicks.
    acceptFirstMouse: true,
    title: 'Forge Voice',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload uses only contextBridge/ipcRenderer/webUtils — all of them
      // available to a sandboxed preload — so the renderer gets no Node.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The overlay is the surface you watch while Forge is minimised and you
      // are working in Chrome — i.e. permanently in the background, by design.
      // Chromium would otherwise throttle its timers to once a second and the
      // level ring would tick like a clock.
      backgroundThrottling: false
    }
  })

  // 'screen-saver' rather than the default 'floating': floating loses to a
  // maximised Chrome, which is precisely the case Steve named.
  overlay.setAlwaysOnTop(true, 'screen-saver')
  // Follow him between virtual desktops, and stay up over a fullscreen window.
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.setMenuBarVisibility(false)
  if (bounds.resizable) {
    overlay.setMinimumSize(340, 400)
    overlay.setMaximumSize(760, 1000)
  }

  // A user drag or edge-resize is the only bounds change worth persisting;
  // our own place() calls are filtered by `placing` so the two cannot fight.
  const report = (): void => {
    if (placing || !overlay || overlay.isDestroyed()) return
    const b = overlay.getBounds()
    toHost(IPC.overlayBoundsEvent, { x: b.x, y: b.y, width: b.width, height: b.height })
  }
  overlay.on('moved', report)
  overlay.on('resized', report)

  // Belt and braces for the always-on-top: some Windows shell interactions
  // (a UAC prompt, a full-screen app going away) quietly demote a topmost
  // window, and a voice hub that has slipped behind Chrome is indistinguishable
  // from one that has crashed.
  overlay.on('blur', () => {
    if (!overlay || overlay.isDestroyed()) return
    overlay.setAlwaysOnTop(true, 'screen-saver')
  })

  overlay.on('closed', () => {
    overlay = null
  })

  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // The overlay loads the same privileged preload as the main window, so it is
  // held to the same rule: nothing navigates it anywhere. A link or file
  // dragged onto the pill would otherwise load with window.forge in reach, and
  // window.forge is a shell. Mirrors the guard in createWindow() in main.ts.
  overlay.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void overlay.loadURL(`${devUrl}#overlay`)
  } else {
    void overlay.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }

  overlay.once('ready-to-show', () => {
    if (!overlay || overlay.isDestroyed()) return
    // Inactive: appearing must not take the caret out of whatever he is typing
    // into. Clicking it focuses it; merely existing does not.
    overlay.showInactive()
  })
}

export function closeOverlay(): void {
  if (!overlay || overlay.isDestroyed()) {
    overlay = null
    return
  }
  const win = overlay
  overlay = null
  win.destroy()
}

/* ------------------------------------------------------------------- relay */

export function registerOverlayIpc(): void {
  ipcMain.handle(IPC.overlayOpen, (_e, bounds: OverlayBounds) => {
    openOverlay(bounds)
  })

  ipcMain.handle(IPC.overlayClose, () => {
    closeOverlay()
  })

  ipcMain.on(IPC.overlaySetBounds, (_e, bounds: OverlayBounds) => {
    place(bounds)
  })

  // Host → overlay. Forwarded verbatim; main has no opinion on the payload.
  ipcMain.on(IPC.overlayState, (_e, snapshot: unknown) => {
    toOverlay(IPC.overlayState, snapshot)
  })
  ipcMain.on(IPC.overlayLevel, (_e, level: unknown) => {
    toOverlay(IPC.overlayLevel, level)
  })

  // Overlay → host. Same deal in reverse: this is how the round button on a
  // floating pill reaches the one real `toggleAgent` in the main window.
  ipcMain.on(IPC.overlayCall, (_e, message: unknown) => {
    toHost(IPC.overlayCall, message)
  })
}

/** Called on the way out, so a topmost window cannot outlive the app. */
export function disposeOverlay(): void {
  closeOverlay()
  host = null
}

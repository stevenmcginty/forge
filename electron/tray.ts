import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { WebStatus } from '@shared/types'

/**
 * Forge in the notification area — and with it, the rule that closing the
 * window is no longer the same act as quitting.
 *
 * ## Why this exists
 *
 * docs/forge-web.md sets out the one honest limitation of Forge Web: with the
 * PC off there is no terminal, so the browser drops to GitHub-only mode. The
 * mitigation it promises, in those words, is that "closing the Forge **window**
 * must not end the session … Only a genuine power-off or reboot drops the
 * browser to GitHub-only mode." Until this file, that sentence was false.
 * Closing the window closed the last window, `window-all-closed` quit the app,
 * and the `before-quit` chain retracted the rendezvous record, stopped the
 * tunnel, hung up on every browser and killed every PTY. GitHub-only mode was a
 * nightly event rather than the rare one the design claims.
 *
 * ## Why a tray icon rather than closing to nothing
 *
 * The cheaper shape was to let the window close and simply not quit — no icon,
 * no menu, no taskbar entry. It was rejected, and the reason is written all over
 * electron/main.ts already: a Forge with no window and no way to reach it, still
 * holding a port, is the *zombie* those comments exist to prevent. The
 * renderer-death path destroys the window specifically so the quit machinery
 * runs; `window-all-closed` arms a hard-exit backstop; the losing copy of a
 * double launch calls `app.exit(0)` rather than a quit that could be out-raced.
 * Every one of those was written after an evening spent in Task Manager. A
 * background process whose only exit is Task Manager would have re-created the
 * exact failure, and worse, for a feature whose whole point is to be running
 * when nobody is at the desk.
 *
 * So: an icon, a menu, and one visible act of quitting. It is also the shape
 * that answers the *other* half of the promise — the link needs somewhere to
 * live when the window is gone, and "Forge Web is live at <host>" in a menu is
 * that somewhere.
 *
 * ## The rules this file keeps
 *
 *  - **No tray unless Forge Web is on.** Nobody who has not switched this
 *    feature on acquires an icon, and closing the window still quits for them,
 *    byte for byte as before. `syncTray()` is driven by `webEnabled`.
 *  - **Closing the window quits.** `handleWindowClose` never absorbs a close
 *    any more (it did, while Forge Web was on, until 2026-08-26). The watchdog
 *    in scripts/watchdog.mjs restarts Forge, so X can mean what X means.
 *  - **Switching Forge Web off while hidden brings the window back**, because
 *    the icon is about to go and something has to be left to click.
 *  - **Hiding is not quitting.** Nothing is killed, so quit-guard.ts's list of
 *    what is about to be lost has nothing to say and is not raised. The window
 *    is *hidden* rather than destroyed, which also keeps the renderer alive —
 *    it holds the split tree that `dispatchLayout` in electron/web-host.ts
 *    dispatches a browser's tab and pane requests into.
 *  - **`quitting` is a flag, not a promise.** Every quit route in this app emits
 *    `before-quit` (see the disposer chain in main.ts), so main sets the flag
 *    there and a close during a quit is never absorbed. The one route that can
 *    be *cancelled* is quit-guard.ts saying no, and main calls
 *    `cancelQuitting()` on that answer — without it a declined quit would leave
 *    the flag set and the next close would take the terminals down in silence.
 */

/** The narrow slice of a `BrowserWindow` this file touches. */
export interface TrayWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  hide(): void
}

/**
 * What the tray needs from the app, injected by electron/main.ts rather than
 * imported — the same arrangement `WebServerHost` and `MobileServerHost` get,
 * and the reason scripts/web-check.mjs can drive the real close decision with no
 * window at all.
 */
export interface TrayHost {
  /** Bring Forge back: the window it has, or a new one if it has none. */
  open: () => void
  /** Quit for real, through the route that still raises the close guard. */
  quit: () => void
  /** Forge Web, as the desktop currently understands it. */
  status: () => WebStatus
  /** Put the browser's address on the clipboard. */
  copy: (text: string) => void
  /** Which of the two committed icons this channel wears — see main.ts. */
  iconFile: string
}

let host: TrayHost | null = null
let tray: Tray | null = null
/** The window this file hid, so it can be handed back if the icon goes away. */
let hidden: TrayWindow | null = null
/** The balloon is shown once per run: it is an explanation, not a nag. */
/** Set for the whole of a real quit — see the header. */
let quitting = false

export function setTrayHost(next: TrayHost | null): void {
  host = next
}

/* ------------------------------------------------------------------ icon */

/**
 * Forge's own icon, off disk, at every size Windows might ask the tray for.
 *
 * Two candidates and no `__dirname`: this module is loaded as ESM by
 * scripts/web-check.mjs, where `__dirname` does not exist, so the checkout path
 * is derived from `app.getAppPath()` the way everything else injectable here is.
 *
 *  - packaged, beside app.asar, put there by `extraResources` in
 *    electron-builder.yml. Change one and change the other.
 *  - a checkout, where `getAppPath()` is the repo root and build/*.ico is
 *    committed.
 */
function iconCandidates(): string[] {
  const name = host?.iconFile ?? 'icon.ico'
  const paths: string[] = []
  if (process.resourcesPath) paths.push(join(process.resourcesPath, name))
  paths.push(join(app.getAppPath(), 'build', name))
  return paths
}

/**
 * The last resort: a plain volt-lime plate, drawn here so that a Forge which
 * cannot find its own .ico still puts *something* clickable in the tray.
 *
 * An empty `NativeImage` is worse than no feature at all — Windows reserves the
 * slot and paints nothing, which is a hidden Forge with no visible way back.
 * Raw BGRA, which is what `createFromBitmap` takes; the colour is `--accent`
 * from src/theme/tokens.css.
 */
function plainPlate(): NativeImage {
  const size = 16
  const px = Buffer.alloc(size * size * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 0x4a // B
    px[i + 1] = 0xff // G
    px[i + 2] = 0xc6 // R
    px[i + 3] = 0xff // A
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size })
}

function trayImage(): NativeImage {
  for (const path of iconCandidates()) {
    if (!existsSync(path)) continue
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image
  }
  console.log('[tray] no icon file found, falling back to a plain plate')
  return plainPlate()
}

/* ------------------------------------------------------------------ menu */

/**
 * Forge Web in one sentence, for somebody who has no window to look at.
 *
 * Every branch says something specific, because the whole value of the icon
 * while the window is closed is that it can be trusted about the link. "Forge
 * Web is on" with a dead tunnel behind it would be worse than saying nothing.
 */
function webLine(status: WebStatus): string {
  if (!status.enabled) return 'Forge Web is off'
  if (status.state === 'starting') return 'Forge Web is starting…'
  if (status.state !== 'listening') {
    return status.detail ? `Forge Web could not start — ${status.detail}` : 'Forge Web could not start'
  }
  if (!status.configured) return 'Forge Web is on, but this desktop is not configured yet'
  if (!status.tunnel.host) return 'Forge Web is on, but there is no way in from outside yet'
  const browsers = status.connected === 1 ? '1 browser connected' : `${status.connected} browsers connected`
  return `Forge Web is live at ${status.tunnel.host}${status.connected ? ` — ${browsers}` : ''}`
}

/**
 * The menu, exported so scripts/web-check.mjs can invoke the items a person
 * would click rather than the private functions behind them.
 *
 * Three things, in the order somebody reaching for the icon wants them: the way
 * back, what the link is doing, and the one act that ends it. Quit is named for
 * what it costs — hiding to the tray keeps every terminal and this does not, and
 * that difference is the entire point of the feature.
 */
export function trayMenuTemplate(): MenuItemConstructorOptions[] {
  const status = host?.status() ?? null
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Forge', click: () => host?.open() },
    { type: 'separator' },
    { label: status ? webLine(status) : 'Forge Web is off', enabled: false }
  ]
  if (status?.url) {
    const url = status.url
    items.push({ label: 'Copy the link', click: () => host?.copy(url) })
  }
  items.push({ type: 'separator' }, { label: 'Quit Forge — closes every terminal', click: () => host?.quit() })
  return items
}

function tooltip(status: WebStatus | null): string {
  return status ? `Forge — ${webLine(status)}` : 'Forge'
}

/* ------------------------------------------------------------- lifecycle */

/**
 * Take the icon away, and make sure something is left behind.
 *
 * Switching Forge Web off while Forge is hidden would otherwise leave a running
 * process with no window and no icon, which is the one state this module exists
 * to prevent. So the window comes back with the icon's removal.
 */
function takeTrayDown(): void {
  try {
    tray?.destroy()
  } catch (err) {
    console.error('[tray] could not remove the icon:', err)
  }
  tray = null
  const window = hidden
  hidden = null
  if (!quitting && window && !window.isDestroyed() && !window.isVisible()) host?.open()
}

/**
 * Create, update or remove the tray so it matches Forge Web.
 *
 * Driven from `report()` in electron/web-host.ts through the status listener
 * main.ts hangs there, which is the only place every state change already
 * passes — including `web:start` and `web:stop`, which never touch the settings
 * handler `applyWebSettings()` is called from.
 */
export function syncTray(): void {
  const status = host?.status() ?? null
  if (!status?.enabled) {
    if (tray) takeTrayDown()
    return
  }
  if (!tray) {
    try {
      tray = new Tray(trayImage())
      // Both, because Windows sends one or the other depending on where the
      // click landed, and a person clicking the icon means "give it back".
      tray.on('click', () => host?.open())
      tray.on('double-click', () => host?.open())
    } catch (err) {
      // No icon means no hiding: `handleWindowClose` refuses without one, so
      // closing the window quits exactly as it did before this file existed.
      console.error('[tray] could not create the icon, so closing Forge will still quit it:', err)
      tray = null
      return
    }
  }
  tray.setToolTip(tooltip(status))
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
}

/**
 * The window's `close` handler, decided here. Returns true when the close was
 * absorbed — hidden to the tray — and the caller should `preventDefault()`.
 *
 * False for every other case, and each of them deliberately: during a real quit,
 * with no icon to get back from, and for a window that is already gone.
 */
export function handleWindowClose(win: TrayWindow): boolean {
  void win
  // Closing the window quits Forge. This used to hide to the tray while Forge
  // Web was on, to keep the terminals alive for the phone — and it made X a
  // button that could not close the app, which is not what X means. Since
  // 2026-08-26 the out-of-process watchdog (scripts/watchdog.mjs) brings
  // Forge straight back whenever it goes down, so the phone's continuity no
  // longer needs the window to pretend to close. The tray stays: it is where
  // the Forge Web link lives, and Quit is on its menu.
  return false
}

/** Called from `before-quit`, which every quit route in this app emits. */
export function noteQuitting(): void {
  quitting = true
}

/** Called when quit-guard.ts's dialog was answered with Cancel. */
export function cancelQuitting(): void {
  quitting = false
}

export function isQuitting(): boolean {
  return quitting
}

/** True while there is an icon to get Forge back from. */
export function trayIsUp(): boolean {
  return tray !== null
}

/**
 * On the way out. The process taking the icon with it is the usual outcome, but
 * a tray entry orphaned by a hard exit sits in the notification area until
 * somebody moves the mouse over it, and this app has a hard exit on a timer.
 */
export function disposeTray(): void {
  quitting = true
  hidden = null
  takeTrayDown()
  host = null
}

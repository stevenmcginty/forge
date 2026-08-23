import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, screen, session, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import { PACK_EXTENSION } from '@shared/skillpack'
import { planProjectFolder } from './projectfolder'
import { gitRemoteOrigin } from './git-remote'
import { portOwner } from './preview/port-owner'
import { makeSafeStorageCodec } from './secretbox'
import type {
  AppInfo,
  MakeProjectFolderRequest,
  MakeProjectFolderResult,
  PortOwnerQuery,
  PreviewDevCommand,
  Project,
  Settings,
  Workspace
} from '@shared/types'
import {
  deleteWorkspace,
  getDataDir,
  getProjects,
  getSettings,
  getWorkspace,
  resolveDataRoot,
  setProjects,
  setSettings,
  setStoreHost,
  setWorkspace,
  snapshot
} from './store'
import { registerMemoryHandlers, setMemoryDir } from './memory-store'
import { registerSkillsHandlers, setSkillsDirs } from './skills-store'
import { disposePtyHost, getReplay, registerPtyHandlers, setPtyTarget } from './pty-host'
import { askBeforeClose, shouldConfirmClose } from './quit-guard'
import { writeBridgeConfig } from './bridge/mcp-config'
import { syncAgyConfig, syncQwenConfig } from './bridge/share-mcp'
import { disposePresence, initPresence, setPresence } from './presence'
import { applyShotSettings, disposeShotsWatcher, registerShotsHandlers } from './shots-watcher'
import { disposeSttSidecar, registerSttHandlers, setSttTarget } from './stt-sidecar'
import { disposeSttModel, registerSttModelHandlers, setSttModelTarget } from './stt-model'
import { registerAgentProbeHandlers } from './agent-probe'
import { disposeOverlay, registerOverlayIpc, setOverlayHost } from './overlay-window'
import { registerVoiceHandlers } from './voice-bridge'
import {
  disposeVoiceAgent,
  registerVoiceAgentHandlers,
  setVoiceAgentTarget
} from './voice-agent/ipc'
import { applyCompanionSettings, disposeCompanion, registerCompanionHandlers } from './companion-host'
import { applyMobileSettings, disposeMobile, publishMobileState, registerMobileHandlers } from './mobile-host'
import {
  applyWebSettings,
  disposeWeb,
  publishWebState,
  registerWebHandlers,
  setWebStatusListener,
  webStatus
} from './web-host'
import {
  cancelQuitting,
  disposeTray,
  handleWindowClose,
  noteQuitting,
  setTrayHost,
  syncTray
} from './tray'
import { registerSystemHandlers } from './system'
import { disposePlannerWatchers, registerPlannerWatcherHandlers } from './planner-watcher'
import { disposeGitWatchers, registerGitWatcherHandlers } from './git-watcher'
import { disposeActivityWatchers, registerActivityHandlers } from './activity-watcher'
import { disposeShareWatchers, registerShareHandlers } from './share-watcher'
import { registerToolsHandlers } from './tools'
import { registerCommandsHandlers } from './commands'
import {
  disposeStaleWatcher,
  initStaleWatcher,
  registerStaleHandlers,
  setStaleTarget
} from './stale-watcher'
import { disposeUpdater, initUpdater, registerUpdateHandlers, setUpdateTarget } from './updater'
import {
  disposeSourceUpdater,
  initSourceUpdater,
  registerSourceUpdateHandlers,
  setSourceUpdateTarget,
  watchFocusForSourceUpdate
} from './source-updater'

const isDev = !app.isPackaged
// The development checkout announces itself, so the taskbar and title bar say
// which of the two is in front. That comes from FORGE_CHANNEL, set by
// scripts/dev.mjs from the untracked .forge-profile marker - not from
// app.isPackaged, which is also true of the everyday app when it is launched
// from source, and would rename it the moment this file reached that checkout.
const isDevChannel = process.env['FORGE_CHANNEL'] === 'dev'
const APP_NAME = isDevChannel ? 'Forge Dev' : 'Forge'
const APP_ID = isDevChannel ? 'dev.forge.app.dev' : 'dev.forge.app'
/** Only the very first launch, before a theme has ever been recorded. */
const FALLBACK_BG = '#0B0C0E'
const TITLEBAR_HEIGHT = 38

/* ------------------------------------------------------------- app identity
 *
 * Named and rooted before anything else runs, because the single-instance lock
 * below is taken on the userData path. Pointing userData at Forge's own data
 * root is what makes FORGE_DATA_DIR a complete isolation switch: a second copy
 * with its own root gets its own lock and its own Chromium profile instead of
 * quitting on startup or fighting over the session directory.
 */

// store.ts is Electron-free and takes Electron by injection — see the
// StoreHost comment there. This has to run before resolveDataRoot() below,
// which is what the single-instance lock is keyed on. The secrets codec is
// safeStorage (DPAPI here on Windows) behind the `enc:v1:` marker — see
// electron/secretbox.ts; the codec itself degrades to plaintext when the
// platform has nothing to offer.
setStoreHost({
  appDataDir: () => app.getPath('appData'),
  appVersion: () => app.getVersion(),
  secrets: makeSafeStorageCodec(safeStorage)
})
const DATA_ROOT = resolveDataRoot()
// setPath throws on a directory that is not there yet.
mkdirSync(DATA_ROOT, { recursive: true })

app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
app.setPath('userData', DATA_ROOT)
// Keep Chromium's caches out of the way so the data root stays readable:
// settings.json, projects.json, layouts/ and shots/ at the top, browser guts
// in chromium/.
app.setPath('sessionData', join(DATA_ROOT, 'chromium'))

let mainWindow: BrowserWindow | null = null
let boundsTimer: NodeJS.Timeout | null = null
/** Set only by user-driven resize/move — see persistBounds(). */
let boundsDirty = false

/* -------------------------------------------------------------- app single instance
 *
 * The lock is per data directory, not per application, and that falls out of
 * the ordering above: Electron keys it on the userData path, and userData was
 * just pointed at DATA_ROOT. So
 *
 *   forge                                 one window; launching it again focuses that window
 *   forge --data-dir D:\forge-test        an independent instance with its own lock
 *   FORGE_DATA_DIR=... forge              likewise
 *
 * which is what makes a throwaway copy safe to run alongside the real one.
 *
 * TODO(phase B): `--project <path>` should open a second window onto another
 * project inside the *same* instance, by handing the path to second-instance
 * below and opening a BrowserWindow for it. Deliberately not built yet —
 * everything from the store cache to terminalHost currently assumes one window,
 * so it is a feature rather than the one-line arg parse it looks like.
 */

/**
 * `exit(0)` and not `quit()`, and the flag is read again inside whenReady.
 *
 * Losing the lock used to call `app.quit()` and fall through. Two things go
 * wrong with that, and between them they produce a Forge that cannot be opened
 * again at all:
 *
 *  - `quit()` is a *request*. It runs the before-quit disposers, and it can be
 *    out-raced by `whenReady` resolving. Lose that race the wrong way and the
 *    losing copy stays alive with no window, no renderer and no error printed —
 *    while still holding this very lock, so every later launch loses it too and
 *    hangs the same way. The only way out is Task Manager, which is exactly
 *    what a "Forge won't open" morning looks like.
 *  - Win that race the other way and the losing copy runs the whole startup
 *    below first: binds 8420 (EADDRINUSE), rewrites the bridge config and
 *    clears the running Forge's presence marker out from under it.
 *
 * `exit(0)` is immediate and cannot be blocked or out-raced.
 *
 * The lock is per data root (userData was pointed at DATA_ROOT above), so the
 * packaged Forge and `npm run dev` share one — starting one while the other is
 * up is the ordinary way to arrive here, and the sentence says so.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log(
    `[main] Another Forge is already using ${DATA_ROOT} — focusing that window instead of starting a second copy.\n` +
      '[main] If no Forge window appears, an earlier Forge is stuck: end electron.exe / Forge.exe in Task Manager and start again.'
  )
  app.exit(0)
} else {
  // `openMainWindow` rather than a bare focus: with Forge Web on, the running
  // copy may be hidden in the tray, and focusing a hidden window leaves it
  // hidden — so launching Forge from the Start menu would appear to do nothing
  // at all, which is precisely the "Forge won't open" morning this lock exists
  // to avoid.
  app.on('second-instance', () => openMainWindow())
}

/* ----------------------------------------------------------------- window */

/**
 * Keep the saved rectangle only if it still lands on a connected display.
 * Returns null when the saved position is unusable (monitor unplugged, etc.).
 */
function usableBounds(win: Settings['window']): Electron.Rectangle | null {
  const { x, y, width, height } = win
  if (typeof x !== 'number' || typeof y !== 'number') return null
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    // Require a decent chunk of the titlebar to be reachable by the mouse.
    return x + 120 > a.x && x < a.x + a.width - 40 && y + 60 > a.y && y < a.y + a.height - 20
  })
  return visible ? { x, y, width, height } : null
}

/**
 * At fractional display scaling, getBounds() can come back a pixel or two off
 * what setBounds() was given. Persisting that unconditionally makes the window
 * grow a little on every launch, forever. So we only write a new rectangle
 * after the *user* has resized or moved the window ('resized'/'moved' fire for
 * user gestures; 'resize'/'move' also fire for our own setBounds call).
 */
function persistBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const maximized = mainWindow.isMaximized()
  if (!boundsDirty) {
    setSettings({ window: { ...getSettings().window, maximized } })
    return
  }
  const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  setSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

function schedulePersistBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(persistBounds, 400)
}

/**
 * "Is Steve at the PC?" — true while *any* Forge window has focus and is not
 * minimised. The walk-away debounce lives in presence.ts, so a blur followed
 * straight away by another Forge window focusing never registers as an absence.
 *
 * Minimised counts as away even when Windows still reports the window as
 * focused, which it sometimes does: a window you cannot see is not a window you
 * are watching, and without this the phone could stay silent all afternoon.
 */
function syncPresence(): void {
  setPresence(
    BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused() && !w.isMinimized())
  )
}

/**
 * Forge's own icon, for the taskbar and Alt+Tab — dev only.
 *
 * A packaged Forge does not need this: electron-builder stamps build/icon.ico
 * onto Forge.exe and the shell reads it off the binary. `electron-vite dev`
 * runs the stock Electron binary, though, which carries Electron's icon, and a
 * window that is not told otherwise inherits it. So the dev window is pointed
 * at the same .ico the installer uses.
 *
 * The dev channel gets the ember variant instead. Two identical lime plates in
 * the taskbar is how you end up typing into the wrong Forge; the same run from
 * the stable checkout still gets the lime one, because there the window *is*
 * the everyday Forge and should look like it.
 *
 * Existence-guarded rather than assumed: the files are generated by
 * `npm run icon` (and by `npm run dist`), and they are committed, but a
 * checkout mid-regeneration should start Forge rather than throw.
 */
function windowIcon(): string | undefined {
  if (!isDev) return undefined
  // __dirname is out/main at runtime, so the repo root is two up.
  const icon = join(__dirname, '..', '..', 'build', isDevChannel ? 'icon-dev.ico' : 'icon.ico')
  return existsSync(icon) ? icon : undefined
}

function createWindow(): void {
  const settings = getSettings()
  // Paint the window in the theme it will be wearing a frame from now, rather
  // than flashing near-black on the way into a light theme.
  const bg = settings.themeBg || FALLBACK_BG
  const ink = settings.themeInk || '#E8EAED'

  mainWindow = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    icon: windowIcon(),
    backgroundColor: bg,
    autoHideMenuBar: true,
    // Native window controls painted onto our own dark titlebar. This is the
    // reliable custom-titlebar route on Windows 11 (no re-implemented buttons).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: bg,
      symbolColor: ink,
      height: TITLEBAR_HEIGHT
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload is contextBridge/ipcRenderer/webUtils only — all available
      // to a sandboxed preload — so the renderer gets no Node of its own.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  mainWindow.setMenuBarVisibility(false)

  // Restore position with setBounds rather than through the constructor: only
  // setBounds/getBounds are symmetric, so the window can't creep a couple of
  // pixels bigger on every launch.
  const saved = usableBounds(settings.window)
  if (saved) mainWindow.setBounds(saved)

  // Forge owns its keyboard. Electron's default menu would claim Ctrl+W
  // (close window), Ctrl+R and friends before the renderer ever sees them.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
    if (isDev && input.control && input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault()
      mainWindow?.webContents.reload()
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    if (settings.window.maximized) mainWindow.maximize()
    mainWindow.show()
    // show() does not always emit 'focus' on Windows, and a first launch that
    // never claimed presence would leave the phone buzzing while Steve sits in
    // front of the app.
    syncPresence()
  })

  const emitWindowState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.windowState, {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused()
    })
  }

  mainWindow.on('resized', () => {
    boundsDirty = true
    schedulePersistBounds()
  })
  mainWindow.on('moved', () => {
    boundsDirty = true
    schedulePersistBounds()
  })
  mainWindow.on('maximize', () => {
    schedulePersistBounds()
    emitWindowState()
  })
  mainWindow.on('unmaximize', () => {
    schedulePersistBounds()
    emitWindowState()
  })
  mainWindow.on('focus', () => {
    emitWindowState()
    syncPresence()
  })
  mainWindow.on('blur', () => {
    emitWindowState()
    syncPresence()
  })
  // Minimising does not reliably emit `blur` on Windows, and a minimised Forge
  // is the clearest "I have walked away" there is.
  mainWindow.on('minimize', syncPresence)
  mainWindow.on('restore', syncPresence)
  mainWindow.on('hide', syncPresence)
  mainWindow.on('show', syncPresence)

  mainWindow.on('close', (event) => {
    if (boundsTimer) clearTimeout(boundsTimer)
    persistBounds()
    if (!mainWindow) return
    /*
     * With Forge Web on, the window goes and the desk stays.
     *
     * `handleWindowClose` hides rather than destroys, and answers true only
     * when there is a tray icon to get Forge back from — so a desktop with
     * Forge Web switched off, or one whose icon could not be created, falls
     * straight through to the behaviour below and quits exactly as it always
     * did. Hidden rather than destroyed matters twice over: the terminals keep
     * their renderer, and the split tree that `dispatchLayout` in
     * electron/web-host.ts sends a browser's tab and pane requests into is in
     * that renderer.
     *
     * No close confirmation here on purpose. quit-guard.ts's dialog is a list
     * of what is about to be killed, and hiding kills nothing.
     */
    if (handleWindowClose(mainWindow)) {
      event.preventDefault()
      return
    }
    if (!shouldConfirmClose()) return
    // Nothing is closed yet: the dialog is asynchronous, so the window has to
    // be kept alive until it comes back with an answer. See quit-guard.ts.
    event.preventDefault()
    void askBeforeClose(mainWindow).then((closing) => {
      // Cancel is also a *cancelled quit*: this close may have been the tray's
      // Quit, which sets the flag before closing the window. Left set, the next
      // ordinary close would take the terminals down without hiding and without
      // asking again.
      if (!closing) cancelQuitting()
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setPtyTarget(null)
    setSttTarget(null)
    setSttModelTarget(null)
    setUpdateTarget(null)
    setStaleTarget(null)
    setVoiceAgentTarget(null)
    // Takes the overlay down with it. A topmost pill wired to a renderer that
    // no longer exists would be a dead button floating over every other app,
    // and — because it is skipTaskbar — one with no obvious way to close it.
    setOverlayHost(null)
    syncPresence()
  })

  /**
   * A dead renderer must not become an immortal app.
   *
   * When the renderer process crashes — an update pulled under a running app,
   * npm install rewriting node_modules beneath vite, a plain Chromium OOM —
   * the OS process is gone but the BrowserWindow object is not. Electron
   * therefore never fires 'window-all-closed', so none of the shutdown
   * machinery runs, and what is left is a windowless Forge holding port 5173
   * and the dev log against every later launch. That is the zombie behind
   * every "Forge won't open" evening.
   *
   * So: one reload, because a crash during a dev-server hiccup usually comes
   * straight back. A second death without a healthy load in between means the
   * ground is bad; destroy the window so 'window-all-closed' fires and the
   * quit path (with its hard-exit backstop) takes the process down honestly.
   */
  let rendererDeaths = 0
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return
    rendererDeaths += 1
    console.error(`[main] renderer gone (${details.reason}), death #${rendererDeaths}`)
    if (rendererDeaths === 1) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
      }, 1500)
    } else {
      mainWindow.destroy()
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererDeaths = 0
  })

  // Never let the renderer navigate away or spawn windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  setPtyTarget(mainWindow)
  setSttTarget(mainWindow)
  setSttModelTarget(mainWindow)
  setUpdateTarget(mainWindow)
  setStaleTarget(mainWindow)
  setSourceUpdateTarget(mainWindow)
  watchFocusForSourceUpdate(mainWindow)
  setVoiceAgentTarget(mainWindow)
  // The main window is the overlay's *host*: it holds the one voice agent, so
  // it is the end the relay pushes state from and delivers callbacks to.
  setOverlayHost(mainWindow)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void loadDevUrl(mainWindow, devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Load the Vite dev server, retrying while it is still coming up.
 *
 * `loadURL` rejects if nothing is listening yet and then does nothing further,
 * which is a **blank window that never recovers** — you have to close Forge and
 * start it again. Normally electron-vite starts Vite before it starts Electron
 * so the race cannot happen, but anything that brings Electron up on its own —
 * `app.relaunch()` from the stale-build Restart button, most of all — reaches
 * this line a second or two before the new dev server is answering.
 *
 * Retrying is the whole fix. Ten attempts over ~10s covers a cold Vite start on
 * a busy machine; past that the error is real and worth printing rather than
 * hiding behind another retry.
 */
async function loadDevUrl(win: BrowserWindow, url: string, attempt = 0): Promise<void> {
  // Never hand the window to a server that is not ours. See devServerIdentity.
  if ((await devServerIdentity(url)) === 'stranger') {
    reportStartupFailure(
      'Forge did not start',
      new Error(
        `Something other than Forge's renderer is serving ${url}, so Forge has not loaded it.\n\n` +
          'Close whatever dev server is on that port (a project started from a Forge terminal is the usual one) and start Forge again.'
      )
    )
    win.destroy()
    return
  }
  try {
    await win.loadURL(url)
  } catch (err) {
    if (win.isDestroyed()) return
    if (attempt >= 10) {
      console.error(`[main] dev server never answered at ${url}:`, err)
      return
    }
    setTimeout(() => void loadDevUrl(win, url, attempt + 1), 1000)
  }
}

/**
 * Who is answering at the dev URL: our renderer, a stranger, or nobody yet.
 *
 * The window is told where to load from by `ELECTRON_RENDERER_URL`, and a URL
 * is only a promise about a port — not about what is listening on it. When that
 * port belonged to another dev server, Forge's own window came up showing one
 * of the user's projects: a real app, fully working, with Forge's title bar
 * around it and no way to get to Forge short of a reboot.
 *
 * scripts/dev.mjs and the `strictPort` in electron.vite.config.ts should make
 * that impossible now. This check is the second lock: it costs one loopback
 * request at startup and turns any future mix-up into a plain sentence instead
 * of a window full of somebody else's software.
 *
 * 'silent' — nothing listening — is not a failure here. That is the ordinary
 * cold-start race the retry loop above exists for.
 */
async function devServerIdentity(url: string): Promise<'forge' | 'stranger' | 'silent'> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return 'silent'
    const html = await res.text()
    // index.html's entry point, which vite's dev transform leaves in place.
    return html.includes('/src/main.tsx') ? 'forge' : 'stranger'
  } catch {
    return 'silent' // not up yet, or refused the connection
  }
}

/**
 * Give Forge back — from the tray, from a second launch, or from macOS's dock.
 *
 * Restore before show before focus: focusing a minimised window on Windows
 * flashes the taskbar button and leaves it minimised, and showing a hidden one
 * without focusing it puts it behind whatever the person was looking at.
 *
 * The window is only ever *hidden* by the tray, never destroyed, so the branch
 * that builds a new one is for the case where something else took it — a
 * renderer that died twice, most of all. See the render-process-gone handler.
 */
function openMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * The tray's Quit, and — once Forge Web is holding the terminals open — the
 * only way out.
 *
 * It closes the *window* rather than calling `app.quit()`, so the route is
 * exactly the one the X button has always taken. Two things depend on that:
 * quit-guard.ts's list of what is about to be killed still appears, and the
 * `before-quit` disposers still run *after* that answer rather than before it —
 * `app.quit()` here would dispose the PTY host and the web link first and then
 * ask, which is a dialog whose Cancel cannot work.
 *
 * The window is shown first because a modal attached to a hidden window is a
 * dialog nobody can answer.
 */
function quitForReal(): void {
  noteQuitting()
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.close()
}

/* -------------------------------------------------------------------- ipc */

/**
 * The one folder picker, borrowed by both "add project" and "import skill" —
 * they differ only in what the dialog calls its button.
 */
async function pickFolder(title: string, buttonLabel: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    buttonLabel,
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]!
}

/**
 * The two dialogs a skill pack needs.
 *
 * Both filter on `.forgepack` and both offer "All files" underneath, because a
 * pack that arrived over chat is as likely as not to have been renamed to
 * `.txt` on the way — refusing to *show* it would look like the file was
 * corrupt. What the file actually is gets decided by `parsePack`, not by its
 * name.
 */
async function savePackAs(suggestedName: string): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Save skill pack',
    buttonLabel: 'Save pack',
    defaultPath: join(app.getPath('documents'), suggestedName),
    filters: [
      { name: 'Forge skill pack', extensions: [PACK_EXTENSION] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function saveZipAs(suggestedName: string): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Save skills as a zip',
    buttonLabel: 'Save zip',
    defaultPath: join(app.getPath('documents'), suggestedName),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  }
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function pickPack(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open a skill pack',
    buttonLabel: 'Open pack',
    properties: ['openFile'],
    filters: [
      { name: 'Forge skill pack', extensions: [PACK_EXTENSION] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]!
}

/**
 * Settings keys the main process owns outright, stripped from anything the
 * renderer sends.
 *
 * The renderer persists its *whole* settings object on a debounce (see
 * AppState's persistence effect), and that object is only ever as fresh as the
 * last hydrate. `mobileDevices` is minted and revoked here, in the main
 * process, and nothing pushes the new list back into renderer state — so a
 * phone that paired after launch lived in a key the renderer still believed was
 * empty, and the next unrelated settings change (a theme, a rail drag, the
 * accept-window mirror in MobileSection) wrote the stale list back over it. The
 * phone stayed paired for exactly as long as nobody touched a setting, then
 * came back as `auth refused ... This device is not paired`.
 *
 * A merge cannot fix this: the renderer's value is not a partial, it is a
 * confident and wrong whole. The only stable answer is one writer per key, so
 * these never travel inward.
 *
 * Any new device list belongs on this list the day it is added. Forge Web used
 * to have one and no longer does — it admits a browser on its account and its
 * PIN and writes nothing down — which is why only the mobile pair are here.
 *
 * `webUid`/`webRefreshToken`/`webEmail` are here for the same reason and with
 * sharper consequences: they are written by Forge Web's sign-in, in main, and
 * the refresh token is the credential this desktop publishes its address with.
 * A renderer that saved its pre-sign-in snapshot back over them would sign
 * Forge Web out roughly 200ms after the next theme change, and the symptom
 * would be a browser that simply stops finding the desktop. Values a human
 * types — the API key, the database URL, the ngrok pair — stay renderer-owned:
 * a form is exactly where those belong.
 */
const MAIN_OWNED_SETTINGS = [
  'mobileDevices',
  'mobileAcceptUntil',
  'webUid',
  'webRefreshToken',
  'webEmail',
  // The unlock PIN is written by main alone (`web:pin-set`/`web:pin-clear`),
  // hashed on the way in. Without it here the renderer's debounced whole-object
  // save would post its pre-PIN copy back and silently unlock the door.
  'webPin'
] as const

function rendererOwned(patch: Partial<Settings>): Partial<Settings> {
  const out = { ...patch }
  for (const key of MAIN_OWNED_SETTINGS) delete out[key]
  return out
}

/* ------------------------------------------------- the project's dev server */

/**
 * The script names that mean "serve this project", in the order they are
 * believed. `dev` first because that is what a dev server is called in every
 * generation of the tooling; `preview` last because in Vite's vocabulary it
 * serves a *build*, which is the right answer only when nothing better exists.
 */
const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview'] as const

/**
 * Which package manager this folder is run with, read off its lockfile —
 * `npm run dev` in a pnpm workspace is a broken command, not a near miss.
 * npm is the fallback, because a folder with no lockfile at all is a folder
 * nobody has installed yet and npm is what ships with node.
 */
const LOCKFILES: Array<{ file: string; run: (script: string) => string }> = [
  { file: 'pnpm-lock.yaml', run: (s) => `pnpm run ${s}` },
  { file: 'yarn.lock', run: (s) => `yarn ${s}` },
  { file: 'bun.lockb', run: (s) => `bun run ${s}` },
  { file: 'bun.lock', run: (s) => `bun run ${s}` }
]

/**
 * How a project folder starts its own dev server, for the Devices preview's
 * Start button. Reads exactly one file and spawns nothing — see the channel's
 * note in shared/ipc.ts.
 *
 * Null for every uncertainty there is: not a directory, no package.json, JSON
 * that will not parse, no `scripts`, no script by a name we recognise. The
 * renderer guesses nothing on a null — it offers a box to type the command
 * into instead, and remembers what is typed there on the workspace.
 *
 * `{ kind: 'self' }` when the folder is this very checkout. `npm run dev` in the
 * running Forge's own tree is not a dev server, it is a second Forge fighting
 * the first for its profile and rebuilding out/ under the app that is executing
 * it — pressing that button took the whole app down. Forge previews itself
 * through the Forge Mobile mode, never through a button that saws off the
 * branch it sits on, and saying so out loud is what lets the view offer that
 * mode instead of an apology. It is a refusal to *guess*, not a prohibition: a
 * command somebody typed for this project by hand still wins.
 */
function previewDevCommand(dir: string): PreviewDevCommand | null {
  if (!dir) return null
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  // Case-insensitive on purpose: Windows paths compare that way, and this is a
  // safety latch, not a lookup.
  if (resolve(dir).toLowerCase() === resolve(app.getAppPath()).toLowerCase()) return { kind: 'self' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts
  if (!scripts || typeof scripts !== 'object') return null
  const script = DEV_SCRIPTS.find((name) => {
    const body = scripts[name]
    return typeof body === 'string' && body.trim() !== ''
  })
  if (!script) return null
  const manager = LOCKFILES.find((m) => existsSync(join(dir, m.file)))
  return { kind: 'command', command: manager ? manager.run(script) : `npm run ${script}`, script }
}

function registerAppHandlers(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    const settings = getSettings()
    return {
      name: 'Forge',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      dataDir: getDataDir(),
      maxSessions: MAX_SESSIONS,
      shell: settings.shell,
      channel: isDevChannel ? 'dev' : 'stable'
    }
  })

  ipcMain.handle(IPC.storeSnapshot, () => snapshot())
  ipcMain.handle(IPC.storeSetSettings, (_e, patch: Partial<Settings>) => {
    const before = getSettings()
    const next = setSettings(rendererOwned(patch ?? {}))
    applyShotSettings(next)
    // The bridge's mcp.json carries the Gemini key and image model, so it has to
    // be rewritten when either changes — otherwise a key pasted today would not
    // reach make_image until the next launch. (Panes still have to be reopened:
    // Claude reads the config once, at start.)
    if (before.geminiKey !== next.geminiKey || before.geminiImageModel !== next.geminiImageModel) {
      writeBridgeConfig()
    }
    // Turning the share tools on or off changes every half of their
    // registration: the mcp.json Claude reads (rewritten above only for a key
    // change, so it needs saying separately), the one config file Forge owns
    // (~/.qwen/settings.json) and the one it asks a CLI to write for it
    // (Antigravity's, via `agy mcp`). Qwen reloads its file without a restart;
    // Claude, Codex, OpenCode and Antigravity read theirs once per pane, so
    // those take effect on the next pane rather than in the ones already open.
    if (before.shareTools !== next.shareTools) {
      writeBridgeConfig()
      syncQwenConfig()
      syncAgyConfig()
    }
    // Flipping the phone link on or repointing it at another Firebase project
    // should take effect now, not at the next launch. Restarting the service is
    // cheap and idempotent, so only the fields it actually reads are compared.
    if (
      before.companionEnabled !== next.companionEnabled ||
      before.companionApiKey !== next.companionApiKey ||
      before.companionDatabaseURL !== next.companionDatabaseURL ||
      before.companionAuthBase !== next.companionAuthBase ||
      before.companionTokenBase !== next.companionTokenBase ||
      before.companionUid !== next.companionUid
    ) {
      applyCompanionSettings()
    }
    // The same rule for Forge Web, and the same one-line reason: flipping the
    // switch, repointing the door at another Firebase project, or changing the
    // way in from outside should take effect now rather than at the next
    // launch. `applyWebSettings` is idempotent, so only the fields it actually
    // reads are compared — its own session (which it publishes the rendezvous
    // record with) and its own tunnel (which the record advertises).
    if (
      before.webEnabled !== next.webEnabled ||
      before.webProjectId !== next.webProjectId ||
      // Not because the listener reads it — `webAllowedOrigins` asks the store
      // afresh on every upgrade, so a new site name admits browsers with or
      // without this line. It is here because `applyWebSettings` is also what
      // calls `clearRefusalIfFixed`, and without it the red "a browser was
      // turned away" warning outlives the act that fixes it. Somebody who names
      // the site and watches nothing whatsoever change on the panel concludes
      // the setting did not take — which is the failure this warning exists to
      // prevent, arriving by another door.
      before.webSiteId !== next.webSiteId ||
      before.webUid !== next.webUid ||
      before.webApiKey !== next.webApiKey ||
      before.webDatabaseURL !== next.webDatabaseURL ||
      before.webAuthBase !== next.webAuthBase ||
      before.webTokenBase !== next.webTokenBase ||
      before.webRefreshToken !== next.webRefreshToken ||
      before.webPort !== next.webPort ||
      before.webTunnel !== next.webTunnel ||
      before.webNgrokDomain !== next.webNgrokDomain ||
      before.webNgrokAuthtoken !== next.webNgrokAuthtoken
    ) {
      applyWebSettings()
    }
    return next
  })
  ipcMain.handle(IPC.storeSetProjects, (_e, projects: Project[]) => {
    const saved = setProjects(Array.isArray(projects) ? projects : [])
    // A browser draws the project rail from this list, and unlike the phone it
    // has no second route to it — so the one place the list is written is the
    // place that says so.
    publishWebState()
    return saved
  })
  ipcMain.handle(IPC.storeGetWorkspace, (_e, projectId: string) => getWorkspace(String(projectId)))
  ipcMain.handle(IPC.storeSetWorkspace, (_e, projectId: string, workspace: Workspace) => {
    const id = String(projectId)
    setWorkspace(id, workspace)
    // Every tab and pane change the renderer makes lands here, whatever caused
    // it — a click, a shortcut, or an op the phone asked for. So this is the one
    // place that knows the layout moved, and therefore the right place to tell
    // the phones. Publishing from here rather than from each action also means
    // the phone is only ever told about a layout that is already on disk.
    publishMobileState(id)
    // And the browsers, from the same place and for the same reason. Two calls
    // rather than one broadcast because the two links have different wire
    // protocols; what they share is this being the only moment either of them
    // is told, so neither can be shown a layout that is not yet on disk.
    publishWebState(id)
  })
  ipcMain.handle(IPC.storeDeleteWorkspace, (_e, projectId: string) => deleteWorkspace(String(projectId)))
  ipcMain.handle(IPC.storeReveal, () => shell.openPath(getDataDir()))

  // Per-project memory. The store is handed a directory rather than importing
  // the data root itself, which is what keeps memory-store.ts electron-free and
  // therefore drivable head-less by scripts/memory-smoke.mjs.
  setMemoryDir(join(getDataDir(), 'memory'))
  registerMemoryHandlers(ipcMain, {
    read: IPC.memoryRead,
    append: IPC.memoryAppend,
    replaceSummary: IPC.memoryReplaceSummary,
    clear: IPC.memoryClear
  })

  /**
   * The skills library. Same shape as memory above: the store is handed its two
   * directories rather than importing them, which keeps skills-store.ts free of
   * `electron` and — the part that matters — lets scripts/skills-smoke.mjs run
   * the real code against a temporary HOME instead of Steve's own
   * ~/.claude/skills, which is full of skills he wrote by hand.
   */
  setSkillsDirs({
    libraryDir: getSettings().skillsLibraryDir || join(getDataDir(), 'skills'),
    claudeSkillsDir: join(homedir(), '.claude', 'skills'),
    codexSkillsDir: join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'skills'),
    antigravitySkillsDir: join(homedir(), '.gemini', 'antigravity-cli', 'skills'),
    // Read-only, and only to say "that name exists over there too".
    peerDirs: [join(homedir(), '.agents', 'skills'), join(homedir(), '.gemini', 'skills')],
    // Read-only too, and the reason a plugin Steve installed used to be missing
    // from the rail entirely: everything `/plugin install` fetches lives here
    // and nowhere near ~/.claude/skills.
    pluginsDir: join(homedir(), '.claude', 'plugins'),
    // A thunk, so a project added after launch brings its `.claude/skills` with
    // it on the very next read rather than at the next restart.
    projectDirs: () => getProjects().map((p) => ({ name: p.name, path: p.path }))
  }).syncEnabled(getSettings().skillsEnabled)

  registerSkillsHandlers(
    ipcMain,
    {
      list: IPC.skillsList,
      read: IPC.skillsRead,
      create: IPC.skillsCreate,
      import: IPC.skillsImport,
      remove: IPC.skillsRemove,
      setEnabled: IPC.skillsSetEnabled,
      openFolder: IPC.skillsOpenFolder,
      copyToLibrary: IPC.skillsCopyToLibrary,
      packPlugins: IPC.skillsPackPlugins,
      packExport: IPC.skillsPackExport,
      packExportZip: IPC.skillsPackExportZip,
      packOpen: IPC.skillsPackOpen,
      packInstall: IPC.skillsPackInstall
    },
    {
      enabled: () => getSettings().skillsEnabled,
      setEnabled: (names) => void setSettings({ skillsEnabled: names }),
      openPath: (path) => void shell.openPath(path),
      pickFolder: () => pickFolder('Import a skill folder', 'Import skill'),
      savePackAs,
      saveZipAs,
      pickPack,
      appVersion: () => app.getVersion()
    }
  )

  ipcMain.handle(IPC.pickFolder, () => pickFolder('Add project folder', 'Add project'))

  /**
   * Create a project folder from a spoken name.
   *
   * The one place in Forge where a voice command reaches the file system, so it
   * is fenced in three ways rather than one:
   *
   *  1. The parent must be Desktop, Documents, or the folder Steve nominated in
   *     Settings. Nothing else, and the resolved path is checked *after*
   *     resolution, so `../../Windows` cannot sneak through a name.
   *  2. The leaf is a single sanitised segment — no separators, no drive
   *     letters, no dots-only names, no reserved Windows device names.
   *  3. An existing folder is never touched. It comes back as an error saying
   *     "open it instead", because silently adopting a folder full of somebody
   *     else's work is exactly the surprise nobody wants from a microphone.
   */
  ipcMain.handle(IPC.makeProjectFolder, async (_e, req: MakeProjectFolderRequest): Promise<MakeProjectFolderResult> => {
    const nominated = getSettings().projectsRoot?.trim()
    const roots = [
      // A nominated folder is the default when there is one, so it goes first.
      ...(nominated ? [{ key: 'projectsroot', path: nominated }] : []),
      { key: 'desktop', path: app.getPath('desktop') },
      { key: 'documents', path: app.getPath('documents') }
    ]

    const plan = planProjectFolder({
      name: String(req?.name ?? ''),
      parentDir: String(req?.parentDir ?? ''),
      roots
    })
    if (!plan.ok) return { ok: false, error: plan.error }
    if (existsSync(plan.path)) {
      return {
        ok: false,
        error: `“${plan.leaf}” already exists in ${plan.root.path} — open it instead`,
        path: plan.path
      }
    }

    try {
      mkdirSync(plan.path, { recursive: false })
    } catch (err) {
      return { ok: false, error: `Could not create it: ${(err as Error).message}` }
    }
    return { ok: true, path: plan.path, name: plan.leaf }
  })

  // Existing directories only. openPath is ShellExecute underneath, so a
  // renderer string naming an .exe/.bat/.hta would not be "reveal it" but "run
  // it". The one caller (revealProject) opens a project folder; the path is
  // resolved before the check so tricks like a trailing " ..\x.exe" cannot
  // smuggle a non-directory through, and every refusal is logged.
  ipcMain.handle(IPC.openPath, async (_e, target: string): Promise<string> => {
    const candidate = resolve(String(target ?? ''))
    let directory = false
    try {
      directory = statSync(candidate).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) {
      console.error(`[shell] refused openPath — not an existing directory: ${candidate}`)
      return ''
    }
    return shell.openPath(candidate)
  })

  // http(s) only. openExternal hands a string straight to the OS launcher, so
  // an unfiltered channel would let any renderer bug turn into "run this".
  ipcMain.handle(IPC.openExternal, async (_e, url: string): Promise<boolean> => {
    const target = String(url ?? '')
    if (!/^https?:\/\//i.test(target)) {
      console.error(`[shell] refused to open non-http url: ${target.slice(0, 80)}`)
      return false
    }
    try {
      await shell.openExternal(target)
    } catch (err) {
      // It can reject (no handler, malformed target); an unhandled rejection
      // here would surface as an opaque invoke error in the renderer.
      console.error(`[shell] openExternal failed for ${target.slice(0, 80)}:`, err)
      return false
    }
    return true
  })

  // Read-only, and only ever a read: the renderer can ask what a folder's origin
  // is, never set one. Everything else about the repo stays git's business.
  ipcMain.handle(IPC.gitRemoteOrigin, (_e, dir: string) => gitRemoteOrigin(String(dir ?? '')))

  // The same shape of favour for the Devices preview, and the same limit on it:
  // a folder goes in, a fact comes back, and the only thing this touches is that
  // folder's package.json.
  ipcMain.handle(IPC.previewDevCommand, (_e, dir: string) => previewDevCommand(String(dir ?? '')))

  // And the question that comes after it: the URL was noticed, but is the server
  // answering there actually this project's? Only main can tell — the listener
  // table and the process table are machine-wide, and the renderer can see
  // neither.
  ipcMain.handle(IPC.previewPortOwner, (_e, query: PortOwnerQuery) =>
    portOwner({
      port: Number(query?.port ?? 0),
      pids: Array.isArray(query?.pids) ? query.pids.map(Number) : [],
      path: String(query?.path ?? '')
    })
  )

  // The renderer never touches navigator.clipboard: it needs a permission
  // handler, rejects silently when the window is not focused, and cannot do
  // images at all.
  ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText())
  ipcMain.handle(IPC.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  ipcMain.on(
    IPC.rendererError,
    (_e, payload: { kind: string; message: string; source?: string; stack?: string }) => {
      console.error(
        `[renderer:${payload?.kind ?? 'error'}] ${payload?.message ?? 'unknown'}` +
          (payload?.source ? `\n  at ${payload.source}` : '') +
          (payload?.stack ? `\n${payload.stack}` : '')
      )
    }
  )

  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => mainWindow?.close())

  /**
   * The window controls are painted by Windows, not by us, so a theme change
   * has to be pushed to them explicitly — otherwise Paper gets three near-black
   * buttons in its top-right corner. Only hex colours are accepted: this value
   * goes straight into a native API.
   */
  // From the overlay, which is on screen while Forge itself may be minimised
  // behind Chrome. Restore first, then focus: focusing a minimised window on
  // Windows flashes the taskbar button and leaves it minimised.
  ipcMain.on(IPC.windowRestoreFocus, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  ipcMain.on(IPC.windowTitlebar, (_e, color: string, symbolColor: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const hex = /^#[0-9a-fA-F]{6}$/
    if (!hex.test(String(color)) || !hex.test(String(symbolColor))) return
    try {
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT })
    } catch {
      /* not every platform has an overlay to set */
    }
  })
}

/* ------------------------------------------------------------- lifecycle */

// A terminal grid is not a place for background throttling or GPU surprises.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

/**
 * Startup went wrong somewhere it cannot be recovered from silently.
 *
 * The console line is for the dev terminal; the dialog is for the shortcut,
 * where there is no terminal to read. Without both, a throw anywhere in the
 * block below leaves a running process with no window and nothing said about
 * it — indistinguishable, from the outside, from Forge simply not opening.
 */
function reportStartupFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[main] ${what}:`, detail)
  try {
    dialog.showErrorBox('Forge', `${what}.\n\n${detail}`)
  } catch {
    /* no dialog before ready, and the console line has already been printed */
  }
}

void app
  .whenReady()
  .then(() => {
    // The losing copy of a double-launch gets no further. app.exit(0) above has
    // already been called; whenReady can still resolve first, and everything
    // below binds ports, starts sidecars and writes into the shared data root.
    if (!gotSingleInstanceLock) return

    // No application menu at all: every accelerator belongs to the renderer.
    Menu.setApplicationMenu(null)

    /*
     * The microphone, for barge-in.
     *
     * Talking over the agent needs `getUserMedia` in the renderer — that is where
     * the echo cancellation lives, and it is the only reason an open microphone
     * during a reply does not make Forge answer itself (see src/lib/bargein.ts).
     *
     * Electron's default handler would grant this, and a good deal else besides.
     * An explicit allow-list of one is worth the six lines: Forge renders no
     * remote content, so nothing should ever be asking for the camera, the
     * screen, notifications or a location, and the honest answer to all of them
     * is no rather than whatever the default happens to be this major version.
     */
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })
    // The synchronous half of the same question — `getUserMedia` consults this
    // one first, and a handler that only answers the async form leaves the
    // request denied before it is ever asked.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

    /*
     * The Devices preview iframes the current project's local dev server so it
     * can show phone-framed live previews. Most dev servers (Next.js, Vite,
     * CRA...) send X-Frame-Options or a frame-ancestors CSP directive that
     * would make the browser refuse to render inside our iframe. Strip just
     * those from loopback responses — the URL filter keeps this scoped to
     * http(s) traffic the renderer is already allowed to frame per its own CSP.
     */
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] },
      (details, callback) => {
        const responseHeaders: Record<string, string[]> = { ...details.responseHeaders }
        for (const name of Object.keys(responseHeaders)) {
          const lower = name.toLowerCase()
          if (lower === 'x-frame-options') {
            delete responseHeaders[name]
          } else if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
            responseHeaders[name] = responseHeaders[name].map((value) =>
              value
                .split(';')
                .filter((directive) => !directive.trim().toLowerCase().startsWith('frame-ancestors'))
                .join(';'),
            )
          }
        }
        callback({ responseHeaders })
      },
    )

    /*
     * Every subsystem, and then the window — but the window happens either way.
     *
     * All of this used to run bare. One throw anywhere in it (a port, a bad
     * settings file, a sidecar that will not start) skipped createWindow(), and
     * because the whole chain was `void`ed the rejection was swallowed too: a
     * live process, no window, not one line of output. A visibly broken Forge
     * with a dialog naming the failure is worth far more than an invisible one,
     * so the failure is reported and the window is opened regardless.
     */
    try {
      registerAppHandlers()
      // Regenerate the cross-agent bridge's MCP config with absolute paths before
      // any pane can launch, so Claude panes pick it up on the first bootstrap.
      writeBridgeConfig()
      // The share server's registrations for the two vendors with no launch
      // flag: Qwen's config file, written directly, and Antigravity's, written
      // for us by `agy mcp add`. Both are a no-op — including a *removal* — when
      // the setting is off, so a machine that never asked for this ends up with
      // nothing in ~/.qwen and nothing in `agy mcp list`.
      syncQwenConfig()
      syncAgyConfig()
      // Before the PTY host builds its manager: the marker path goes into every
      // pane's CLAUDE_CLIENT_PRESENCE_FILE, and init also clears a marker left
      // behind by a crash (a stale one would mute the phone for good).
      initPresence(getDataDir())
      // App-level, so presence follows *any* Forge window rather than only the one
      // createWindow happens to be holding.
      app.on('browser-window-focus', syncPresence)
      app.on('browser-window-blur', syncPresence)
      registerPtyHandlers()
      registerShotsHandlers()
      registerSttHandlers()
      registerSttModelHandlers()
      registerAgentProbeHandlers()
      registerVoiceHandlers()
      // Registers the handlers only. No session, no subprocess and no Claude
      // login is touched until the renderer actually starts the brain — see
      // electron/voice-agent/host.ts.
      registerVoiceAgentHandlers()
      // Off by default: this reads settings, sees `companionEnabled: false`, and
      // returns without touching the network or a credential.
      registerCompanionHandlers()
      // Same posture as the Companion above, and the same one-line reason: this
      // reads settings, sees `mobileEnabled: false`, and returns without binding a
      // port or minting a credential. See docs/MOBILE.md.
      registerMobileHandlers()
      applyMobileSettings()
      /*
       * The tray, and with it the rule that closing the window is not the same
       * act as quitting — the thing docs/forge-web.md's "honest limitation"
       * promises, and that this app did not do until electron/tray.ts existed.
       *
       * Wired before the link starts, so the very first status lands on it, and
       * hung off `report()` in web-host rather than off the settings write
       * below: `web:start` and `web:stop` are how this feature is actually
       * switched, and neither of them comes through the settings handler.
       *
       * Nothing appears for anybody who has not switched Forge Web on. That is
       * not a nicety — an icon for a feature nobody enabled is a change to
       * every desktop user's notification area for nothing.
       */
      setTrayHost({
        open: openMainWindow,
        quit: quitForReal,
        status: webStatus,
        copy: (text) => clipboard.writeText(text),
        // The same two committed files windowIcon() picks between, and for the
        // same reason: two identical lime plates in the notification area is
        // how you quit the wrong Forge.
        iconFile: isDevChannel ? 'icon-dev.ico' : 'icon.ico'
      })
      setWebStatusListener(syncTray)
      // And the third time, for the door that faces the internet rather than
      // the LAN: this reads settings, sees `webEnabled: false`, and returns
      // without binding a port, reading a credential or publishing a hostname.
      // See docs/forge-web.md's security posture, which promises exactly that.
      registerWebHandlers()
      applyWebSettings()
      // `applyWebSettings` reports asynchronously; this is the synchronous read
      // of the setting, so a Forge that starts with the link already on has its
      // icon before the first window can be closed.
      syncTray()
      registerSystemHandlers()
      // Handlers only: nothing is tailed until the tasks panel opens a planning
      // session and asks for it. See electron/planner-watcher.ts.
      registerPlannerWatcherHandlers()
      // Same deal for all three of these: handlers only. Nothing watches a
      // folder, spawns git, tails a transcript or creates a directory in the
      // project until the rail's GIT, ACTIVITY or SHARE section is switched on
      // and asks. All three default off.
      registerGitWatcherHandlers()
      registerActivityHandlers()
      // The pane reader is injected rather than imported, so share-watcher.ts
      // carries no dependency on the PTY host — the same arrangement mobile-host
      // is given for the same buffer.
      registerShareHandlers({ replayFor: getReplay })
      registerToolsHandlers()
      registerCommandsHandlers()
      registerUpdateHandlers()
      registerStaleHandlers()
      registerSourceUpdateHandlers()
      // Only the relay is registered here. No overlay window exists until the hub
      // is actually undocked — see electron/overlay-window.ts.
      registerOverlayIpc()
    } catch (err) {
      reportStartupFailure('Part of Forge failed to start, so some of it will not work', err)
    }

    createWindow()
    // After the window, so the first status event has somewhere to go — and it
    // is a no-op in a dev run: initUpdater() returns immediately unless this is
    // a packaged build or FORGE_FAKE_UPDATE is set. See electron/updater.ts.
    initUpdater()
    // The other side of that coin, and a no-op in a packaged build for the exact
    // opposite reason: there, out/ cannot change under the running process. In a
    // checkout it takes the mtimes of the bundles we just booted from, which is
    // why it goes here rather than earlier — after the build that produced them.
    initStaleWatcher()
    // And its outward-looking sibling: the stable checkout watching origin for
    // pushes from Forge Dev. Guards itself out of dev runs and packaged builds.
    initSourceUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((err) => reportStartupFailure('Forge could not start', err))

app.on('window-all-closed', () => {
  // Backstop for the disposers below: the last window is gone, so nothing of
  // value is left to lose — if quit has not finished in a couple of seconds
  // (a disposer wedged, an emit threw), take the process down regardless. A
  // quit that silently aborts here is a windowless Forge that survives to hold
  // port 5173 against every later `npm run dev`. Armed here and not in
  // before-quit, because the stale-watcher can request a quit while a window
  // is still open behind the close-confirm dialog, and that quit is allowed
  // to take as long as the user does.
  setTimeout(() => app.exit(0), 2500).unref()
  app.quit()
})

app.on('before-quit', () => {
  // First, and outside the catches below: every quit route in this app emits
  // this event — the tray's Quit, the updater, the stale-build Restart, an OS
  // shutdown — and from here on the window's close handler must stop hiding to
  // the tray and let the window actually go. See electron/tray.ts.
  noteQuitting()
  // Each disposer behind its own catch: a throw from any of them propagates
  // out of the 'before-quit' emit and aborts app.quit() itself — skipping the
  // remaining disposers and leaving the app alive with no window. That is how
  // a closed Forge kept its whole dev tree (and port 5173) alive.
  const safely = (name: string, dispose: () => unknown): void => {
    try {
      void dispose()
    } catch (err) {
      console.error(`[main] ${name} failed during shutdown:`, err)
    }
  }
  safely('disposePresence', disposePresence)
  safely('disposePtyHost', disposePtyHost)
  safely('disposeShotsWatcher', disposeShotsWatcher)
  safely('disposePlannerWatchers', disposePlannerWatchers)
  safely('disposeGitWatchers', disposeGitWatchers)
  safely('disposeActivityWatchers', disposeActivityWatchers)
  safely('disposeShareWatchers', disposeShareWatchers)
  safely('disposeSttSidecar', disposeSttSidecar)
  safely('disposeSttModel', disposeSttModel)
  // Ends the Agent SDK session and its subprocess. A voice brain outliving the
  // app would hold a `claude` process open with nobody to talk to.
  safely('disposeVoiceAgent', disposeVoiceAgent)
  safely('disposeCompanion', disposeCompanion)
  safely('disposeMobile', disposeMobile)
  // Retracts the rendezvous record and tells every browser why before the
  // sockets close — without it, a quit reads as a network fault and the page
  // spends the next minute retrying a machine that is off.
  safely('disposeWeb', disposeWeb)
  safely('disposeUpdater', disposeUpdater)
  safely('disposeStaleWatcher', disposeStaleWatcher)
  safely('disposeSourceUpdater', disposeSourceUpdater)
  // The icon goes with the process in the ordinary case; this is for the other
  // one. `window-all-closed` arms a 2.5s hard exit, and a notification-area
  // entry orphaned by a hard exit sits there as a ghost until somebody happens
  // to move the mouse across it.
  safely('disposeTray', disposeTray)
  // Last, and unconditional: an always-on-top window that outlived the app
  // would sit over everything with nothing behind it to close it.
  safely('disposeOverlay', disposeOverlay)
})

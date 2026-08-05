import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import { planProjectFolder } from './projectfolder'
import type {
  AppInfo,
  MakeProjectFolderRequest,
  MakeProjectFolderResult,
  Project,
  Settings,
  Workspace
} from '@shared/types'
import {
  deleteWorkspace,
  getDataDir,
  getSettings,
  getWorkspace,
  resolveDataRoot,
  setProjects,
  setSettings,
  setWorkspace,
  snapshot
} from './store'
import { registerMemoryHandlers, setMemoryDir } from './memory-store'
import { registerSkillsHandlers, setSkillsDirs } from './skills-store'
import { disposePtyHost, registerPtyHandlers, setPtyTarget } from './pty-host'
import { askBeforeClose, shouldConfirmClose } from './quit-guard'
import { writeBridgeConfig } from './bridge/mcp-config'
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
import { registerSystemHandlers } from './system'
import { disposePlannerWatchers, registerPlannerWatcherHandlers } from './planner-watcher'
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
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
      sandbox: false,
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
    if (!mainWindow || !shouldConfirmClose()) return
    // Nothing is closed yet: the dialog is asynchronous, so the window has to
    // be kept alive until it comes back with an answer. See quit-guard.ts.
    event.preventDefault()
    void askBeforeClose(mainWindow)
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
    const next = setSettings(patch ?? {})
    applyShotSettings(next)
    // The bridge's mcp.json carries the Gemini key and image model, so it has to
    // be rewritten when either changes — otherwise a key pasted today would not
    // reach make_image until the next launch. (Panes still have to be reopened:
    // Claude reads the config once, at start.)
    if (before.geminiKey !== next.geminiKey || before.geminiImageModel !== next.geminiImageModel) {
      writeBridgeConfig()
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
    return next
  })
  ipcMain.handle(IPC.storeSetProjects, (_e, projects: Project[]) => setProjects(Array.isArray(projects) ? projects : []))
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
    // Read-only, and only to say "that name exists over there too".
    peerDirs: [join(homedir(), '.agents', 'skills'), join(homedir(), '.gemini', 'skills')]
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
      copyToLibrary: IPC.skillsCopyToLibrary
    },
    {
      enabled: () => getSettings().skillsEnabled,
      setEnabled: (names) => void setSettings({ skillsEnabled: names }),
      openPath: (path) => void shell.openPath(path),
      pickFolder: () => pickFolder('Import a skill folder', 'Import skill')
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

  ipcMain.handle(IPC.openPath, async (_e, target: string) => shell.openPath(String(target)))

  // http(s) only. openExternal hands a string straight to the OS launcher, so
  // an unfiltered channel would let any renderer bug turn into "run this".
  ipcMain.handle(IPC.openExternal, async (_e, url: string): Promise<boolean> => {
    const target = String(url ?? '')
    if (!/^https?:\/\//i.test(target)) {
      console.error(`[shell] refused to open non-http url: ${target.slice(0, 80)}`)
      return false
    }
    await shell.openExternal(target)
    return true
  })

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
      registerSystemHandlers()
      // Handlers only: nothing is tailed until the tasks panel opens a planning
      // session and asks for it. See electron/planner-watcher.ts.
      registerPlannerWatcherHandlers()
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
  safely('disposeSttSidecar', disposeSttSidecar)
  safely('disposeSttModel', disposeSttModel)
  // Ends the Agent SDK session and its subprocess. A voice brain outliving the
  // app would hold a `claude` process open with nobody to talk to.
  safely('disposeVoiceAgent', disposeVoiceAgent)
  safely('disposeCompanion', disposeCompanion)
  safely('disposeMobile', disposeMobile)
  safely('disposeUpdater', disposeUpdater)
  safely('disposeStaleWatcher', disposeStaleWatcher)
  safely('disposeSourceUpdater', disposeSourceUpdater)
  // Last, and unconditional: an always-on-top window that outlived the app
  // would sit over everything with nothing behind it to close it.
  safely('disposeOverlay', disposeOverlay)
})

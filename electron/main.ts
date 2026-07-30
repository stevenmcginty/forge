import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { AppInfo, Project, Settings, Workspace } from '@shared/types'
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
import { disposePtyHost, registerPtyHandlers, setPtyTarget } from './pty-host'
import { writeBridgeConfig } from './bridge/mcp-config'
import { applyShotSettings, disposeShotsWatcher, registerShotsHandlers } from './shots-watcher'
import { disposeSttSidecar, registerSttHandlers, setSttTarget } from './stt-sidecar'
import { disposeSttModel, registerSttModelHandlers, setSttModelTarget } from './stt-model'
import { registerAgentProbeHandlers } from './agent-probe'
import { registerVoiceHandlers } from './voice-bridge'
import { registerSystemHandlers } from './system'

const isDev = !app.isPackaged
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

app.setName('Forge')
if (process.platform === 'win32') app.setAppUserModelId('dev.forge.app')
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
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
    title: 'Forge',
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
  mainWindow.on('focus', emitWindowState)
  mainWindow.on('blur', emitWindowState)

  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    persistBounds()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setPtyTarget(null)
    setSttTarget(null)
    setSttModelTarget(null)
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

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* -------------------------------------------------------------------- ipc */

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
      shell: settings.shell
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
    return next
  })
  ipcMain.handle(IPC.storeSetProjects, (_e, projects: Project[]) => setProjects(Array.isArray(projects) ? projects : []))
  ipcMain.handle(IPC.storeGetWorkspace, (_e, projectId: string) => getWorkspace(String(projectId)))
  ipcMain.handle(IPC.storeSetWorkspace, (_e, projectId: string, workspace: Workspace) => {
    setWorkspace(String(projectId), workspace)
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

  ipcMain.handle(IPC.pickFolder, async (): Promise<string | null> => {
    const parent = mainWindow ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Add project folder',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Add project'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })

  ipcMain.handle(IPC.openPath, async (_e, target: string) => shell.openPath(String(target)))

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

void app.whenReady().then(() => {
  // No application menu at all: every accelerator belongs to the renderer.
  Menu.setApplicationMenu(null)
  registerAppHandlers()
  // Regenerate the cross-agent bridge's MCP config with absolute paths before
  // any pane can launch, so Claude panes pick it up on the first bootstrap.
  writeBridgeConfig()
  registerPtyHandlers()
  registerShotsHandlers()
  registerSttHandlers()
  registerSttModelHandlers()
  registerAgentProbeHandlers()
  registerVoiceHandlers()
  registerSystemHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  disposePtyHost()
  disposeShotsWatcher()
  disposeSttSidecar()
  disposeSttModel()
})

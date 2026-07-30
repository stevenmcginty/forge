import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { join } from 'node:path'
import { IPC, MAX_SESSIONS } from '@shared/ipc'
import type { AppInfo, Project, Settings, Workspace } from '@shared/types'
import {
  deleteWorkspace,
  getDataDir,
  getSettings,
  getWorkspace,
  setProjects,
  setSettings,
  setWorkspace,
  snapshot
} from './store'
import { disposePtyHost, registerPtyHandlers, setPtyTarget } from './pty-host'

const isDev = !app.isPackaged
const BG = '#0B0C0E'
const TITLEBAR_HEIGHT = 38

let mainWindow: BrowserWindow | null = null
let boundsTimer: NodeJS.Timeout | null = null

/* -------------------------------------------------------------- app single instance */

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

function persistBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const maximized = mainWindow.isMaximized()
  const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  setSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } })
}

function schedulePersistBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(persistBounds, 400)
}

function createWindow(): void {
  const settings = getSettings()

  mainWindow = new BrowserWindow({
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Forge',
    backgroundColor: BG,
    autoHideMenuBar: true,
    // Native window controls painted onto our own dark titlebar. This is the
    // reliable custom-titlebar route on Windows 11 (no re-implemented buttons).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: BG,
      symbolColor: '#E8EAED',
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

  mainWindow.on('resize', schedulePersistBounds)
  mainWindow.on('move', schedulePersistBounds)
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
  ipcMain.handle(IPC.storeSetSettings, (_e, patch: Partial<Settings>) => setSettings(patch ?? {}))
  ipcMain.handle(IPC.storeSetProjects, (_e, projects: Project[]) => setProjects(Array.isArray(projects) ? projects : []))
  ipcMain.handle(IPC.storeGetWorkspace, (_e, projectId: string) => getWorkspace(String(projectId)))
  ipcMain.handle(IPC.storeSetWorkspace, (_e, projectId: string, workspace: Workspace) => {
    setWorkspace(String(projectId), workspace)
  })
  ipcMain.handle(IPC.storeDeleteWorkspace, (_e, projectId: string) => deleteWorkspace(String(projectId)))
  ipcMain.handle(IPC.storeReveal, () => shell.openPath(getDataDir()))

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
}

/* ------------------------------------------------------------- lifecycle */

app.setName('Forge')
if (process.platform === 'win32') app.setAppUserModelId('dev.forge.app')

// Keep Chromium's caches out of the way so %APPDATA%\Forge stays readable:
// settings.json, projects.json and layouts/ at the top, browser guts in
// chromium/.
app.setPath('sessionData', join(app.getPath('appData'), 'Forge', 'chromium'))

// A terminal grid is not a place for background throttling or GPU surprises.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

void app.whenReady().then(() => {
  // No application menu at all: every accelerator belongs to the renderer.
  Menu.setApplicationMenu(null)
  registerAppHandlers()
  registerPtyHandlers()
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
})

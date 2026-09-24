import { BrowserWindow, ipcMain, shell } from 'electron'
import { join, resolve, sep } from 'node:path'
import {
  CANVAS_DIR_ENV,
  HUB_IPC,
  type CanvasLayoutPatch,
  type KeymapFile,
  type SavedPromptInput
} from '@shared/hub'
import { BridgeOutFeed, CanvasBoard } from './canvas-board'
import { HubStore } from './hub-store'
import { getDataDir, getProjects } from './store'

/**
 * Main-process wiring for the hub backends: the canvas board, saved prompts
 * and the keymap file. The logic lives in canvas-board.ts and
 * hub-store.ts; this file only answers IPC and pushes changes to every window.
 */

let board: CanvasBoard | null = null
let feed: BridgeOutFeed | null = null
let store: HubStore | null = null
let activeProjectId: string | null = null

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

function getBoard(): CanvasBoard {
  board ??= new CanvasBoard({
    root: join(getDataDir(), 'canvas'),
    onChange: (change) => broadcast(HUB_IPC.canvasChanged, change)
  })
  return board
}

function getStore(): HubStore {
  store ??= new HubStore(getDataDir())
  return store
}

/**
 * The user's keys for one command, from keymap.json, or null when it keeps its
 * default. For the few keys the main process must read itself (Developer
 * tools, which has to work while the renderer is blank).
 */
export function keymapOverride(commandId: string): string[] | null {
  try {
    const keys = getStore().getKeymap().overrides[commandId]
    return Array.isArray(keys) ? keys : null
  } catch {
    return null
  }
}

/**
 * `FORGE_CANVAS_DIR` for a pane, from the pane's cwd: the project whose folder
 * the pane runs in (the deepest match, so a nested project wins over its
 * parent), else the project with the pane's project name. A pane in no project
 * gets no variable — there is no board it could appear on.
 */
export function canvasEnvFor(cwd: string, projectName: string): Record<string, string> {
  try {
    const projects = getProjects()
    const here = cwd ? resolve(cwd).toLowerCase() : ''
    let best: { id: string; len: number } | null = null
    for (const p of projects) {
      const root = resolve(p.path).toLowerCase()
      if (here && (here === root || here.startsWith(root.endsWith(sep) ? root : root + sep))) {
        if (!best || root.length > best.len) best = { id: p.id, len: root.length }
      }
    }
    const id = best?.id ?? (projectName ? projects.find((p) => p.name === projectName)?.id : undefined)
    return id ? { [CANVAS_DIR_ENV]: getBoard().dirFor(id) } : {}
  } catch (err) {
    console.error('[canvas] could not pick a canvas folder for the pane', err)
    return {}
  }
}

export function registerHubHandlers(): void {
  const b = getBoard()
  b.watch()
  feed = new BridgeOutFeed({ dir: join(getDataDir(), 'bridge-out'), board: b, activeProject: () => activeProjectId })
  feed.start()

  ipcMain.handle(HUB_IPC.canvasList, (_e, projectId: string) => getBoard().list(String(projectId)))
  ipcMain.handle(HUB_IPC.canvasPost, (_e, projectId: string, path: string, title?: string) =>
    getBoard().post(String(projectId), String(path), typeof title === 'string' ? title : undefined)
  )
  ipcMain.handle(HUB_IPC.canvasRemove, (_e, projectId: string, id: string) => getBoard().remove(String(projectId), String(id)))
  ipcMain.handle(HUB_IPC.canvasLayout, (_e, projectId: string, patch: CanvasLayoutPatch) =>
    getBoard().layout(String(projectId), patch ?? {})
  )
  ipcMain.handle(HUB_IPC.canvasRead, (_e, projectId: string, id: string) => getBoard().read(String(projectId), String(id)))
  ipcMain.handle(HUB_IPC.canvasReveal, async (_e, projectId: string) => {
    await shell.openPath(getBoard().dirFor(String(projectId)))
  })
  ipcMain.handle(HUB_IPC.canvasActive, (_e, projectId: string | null) => {
    activeProjectId = typeof projectId === 'string' && projectId ? projectId : null
  })

  ipcMain.handle(HUB_IPC.promptsList, () => getStore().listPrompts())
  ipcMain.handle(HUB_IPC.promptsSave, (_e, input: SavedPromptInput) => {
    const result = getStore().savePrompt(input)
    if (result.ok) broadcast(HUB_IPC.promptsChanged, result.prompts)
    return result
  })
  ipcMain.handle(HUB_IPC.promptsDelete, (_e, id: string) => {
    const prompts = getStore().deletePrompt(String(id))
    broadcast(HUB_IPC.promptsChanged, prompts)
    return prompts
  })

  ipcMain.handle(HUB_IPC.keymapGet, () => getStore().getKeymap())
  ipcMain.handle(HUB_IPC.keymapSet, (_e, file: KeymapFile) => getStore().setKeymap(file))
}

/**
 * Post a file to a project's board — the renderer's active project when none
 * is named. For main-side features (the built-in browser's screenshots); wired
 * in main.ts so this module never imports them.
 */
export function postToBoard(projectId: string | null, path: string, title: string): void {
  const target = projectId || activeProjectId
  if (target) void getBoard().post(target, path, title)
}

export function disposeHub(): void {
  feed?.close()
  feed = null
  board?.close()
}

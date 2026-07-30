/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type { ForgeApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ForgeApi = {
  info: () => ipcRenderer.invoke(IPC.appInfo),

  pty: {
    create: (req) => ipcRenderer.invoke(IPC.ptyCreate, req),
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.ptyKill, id),
    list: () => ipcRenderer.invoke(IPC.ptyList),
    onData: (cb) => subscribe(IPC.ptyData, cb),
    onExit: (cb) => subscribe(IPC.ptyExit, cb)
  },

  store: {
    snapshot: () => ipcRenderer.invoke(IPC.storeSnapshot),
    setSettings: (patch) => ipcRenderer.invoke(IPC.storeSetSettings, patch),
    setProjects: (projects) => ipcRenderer.invoke(IPC.storeSetProjects, projects),
    getWorkspace: (projectId) => ipcRenderer.invoke(IPC.storeGetWorkspace, projectId),
    setWorkspace: (projectId, workspace) => ipcRenderer.invoke(IPC.storeSetWorkspace, projectId, workspace),
    deleteWorkspace: (projectId) => ipcRenderer.invoke(IPC.storeDeleteWorkspace, projectId),
    revealDataDir: () => ipcRenderer.invoke(IPC.storeReveal)
  },

  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardReadText),
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWriteText, text)
  },

  shots: {
    list: () => ipcRenderer.invoke(IPC.shotsList),
    remove: (path) => ipcRenderer.invoke(IPC.shotsRemove, path),
    clear: () => ipcRenderer.invoke(IPC.shotsClear),
    copy: (path) => ipcRenderer.invoke(IPC.shotsCopy, path),
    adopt: (paths) => ipcRenderer.invoke(IPC.shotsAdopt, paths),
    // send, not invoke: startDrag has to happen while the mouse button is
    // still down, so there is nothing useful to await.
    startDrag: (path) => ipcRenderer.send(IPC.shotsDrag, path),
    openFolder: () => ipcRenderer.invoke(IPC.shotsOpenFolder),
    onUpdated: (cb) => subscribe(IPC.shotsUpdated, cb)
  },

  stt: {
    start: () => ipcRenderer.invoke(IPC.sttStart),
    stop: () => ipcRenderer.invoke(IPC.sttStop),
    reload: (force) => ipcRenderer.invoke(IPC.sttReload, force === true),
    status: () => ipcRenderer.invoke(IPC.sttStatus),
    onStatus: (cb) => subscribe(IPC.sttStatusEvent, cb),
    onPhrase: (cb) => subscribe(IPC.sttPhrase, cb),

    downloadModel: () => ipcRenderer.invoke(IPC.sttDownloadModel),
    cancelDownload: () => ipcRenderer.invoke(IPC.sttDownloadCancel),
    modelState: () => ipcRenderer.invoke(IPC.sttDownloadState),
    onDownloadProgress: (cb) => subscribe(IPC.sttDownloadProgress, cb),
    onDownloadDone: (cb) => subscribe(IPC.sttDownloadDone, cb),
    onDownloadError: (cb) => subscribe(IPC.sttDownloadError, cb)
  },

  voice: {
    gemini: (req) => ipcRenderer.invoke(IPC.voiceGemini, req),
    openrouter: (req) => ipcRenderer.invoke(IPC.voiceOpenRouter, req),
    importKey: (which) => ipcRenderer.invoke(IPC.voiceImportKey, which ?? 'gemini'),
    makeImage: (req) => ipcRenderer.invoke(IPC.voiceMakeImage, req),
    editImage: (req) => ipcRenderer.invoke(IPC.voiceEditImage, req),
    makeVideo: (req) => ipcRenderer.invoke(IPC.voiceMakeVideo, req)
  },

  memory: {
    read: (projectId) => ipcRenderer.invoke(IPC.memoryRead, projectId),
    append: (projectId, section, entry, at) => ipcRenderer.invoke(IPC.memoryAppend, projectId, section, entry, at),
    replaceSummary: (projectId, text) => ipcRenderer.invoke(IPC.memoryReplaceSummary, projectId, text),
    clear: (projectId) => ipcRenderer.invoke(IPC.memoryClear, projectId)
  },

  companion: {
    status: () => ipcRenderer.invoke(IPC.companionStatus),
    signIn: (email, password) => ipcRenderer.invoke(IPC.companionSignIn, email, password),
    signOut: () => ipcRenderer.invoke(IPC.companionSignOut),
    publish: () => ipcRenderer.invoke(IPC.companionPublish),
    reply: (itemId, text, projectId) => ipcRenderer.invoke(IPC.companionReply, itemId, text, projectId),
    onStatus: (cb) => subscribe(IPC.companionStatusEvent, cb),
    onUtterance: (cb) => subscribe(IPC.companionUtterance, cb)
  },

  system: {
    userName: () => ipcRenderer.invoke(IPC.systemUserName),
    claudeVersion: () => ipcRenderer.invoke(IPC.systemClaudeVersion)
  },

  probeAgents: () => ipcRenderer.invoke(IPC.agentsProbe),

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  makeProjectFolder: (req) => ipcRenderer.invoke(IPC.makeProjectFolder, req),
  openPath: (target) => ipcRenderer.invoke(IPC.openPath, target),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  // File.path was removed in Electron 32; webUtils is the sanctioned way and
  // it only works from the preload.
  pathForFile: (file) => webUtils.getPathForFile(file as File),

  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    onState: (cb) => subscribe(IPC.windowState, cb),
    setTitlebar: (color, symbolColor) => ipcRenderer.send(IPC.windowTitlebar, color, symbolColor)
  }
}

contextBridge.exposeInMainWorld('forge', api)

/**
 * Anything that blows up in the renderer is reported to the main process, which
 * prints it in the terminal running `npm run dev`. Without this, a React crash
 * is invisible unless DevTools happens to be open.
 */
window.addEventListener('error', (e) => {
  ipcRenderer.send(IPC.rendererError, {
    kind: 'error',
    message: e.message,
    source: `${e.filename}:${e.lineno}:${e.colno}`,
    stack: e.error instanceof Error ? e.error.stack : undefined
  })
})

window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason
  ipcRenderer.send(IPC.rendererError, {
    kind: 'unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  })
})

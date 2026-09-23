import type { IpcRenderer, IpcRendererEvent } from 'electron'
import { HUB_IPC, type HubApi } from '@shared/hub'

/**
 * `window.forgeHub`, built from the preload's ipcRenderer. A separate global
 * from `window.forge` so the hub needs no change to ForgeApi; the renderer
 * reaches it only through src/lib/hubApi.ts, which treats it as optional.
 */
export function hubPreloadApi(ipc: IpcRenderer): HubApi {
  const on = <A extends unknown[]>(channel: string, cb: (...args: A) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
    ipc.on(channel, listener)
    return () => {
      ipc.removeListener(channel, listener)
    }
  }
  return {
    canvas: {
      list: (projectId) => ipc.invoke(HUB_IPC.canvasList, projectId),
      post: (projectId, path, title) => ipc.invoke(HUB_IPC.canvasPost, projectId, path, title),
      remove: (projectId, id) => ipc.invoke(HUB_IPC.canvasRemove, projectId, id),
      layout: (projectId, patch) => ipc.invoke(HUB_IPC.canvasLayout, projectId, patch),
      read: (projectId, id) => ipc.invoke(HUB_IPC.canvasRead, projectId, id),
      reveal: (projectId) => ipc.invoke(HUB_IPC.canvasReveal, projectId),
      setActive: (projectId) => ipc.invoke(HUB_IPC.canvasActive, projectId),
      onChanged: (cb) => on(HUB_IPC.canvasChanged, cb)
    },
    callSigns: {
      sync: (projectId, paneIds, prune) => ipc.invoke(HUB_IPC.callSignsSync, projectId, paneIds, prune),
      rename: (projectId, paneId, name) => ipc.invoke(HUB_IPC.callSignsRename, projectId, paneId, name),
      onChanged: (cb) => on(HUB_IPC.callSignsChanged, cb)
    },
    prompts: {
      list: () => ipc.invoke(HUB_IPC.promptsList),
      save: (input) => ipc.invoke(HUB_IPC.promptsSave, input),
      remove: (id) => ipc.invoke(HUB_IPC.promptsDelete, id),
      onChanged: (cb) => on(HUB_IPC.promptsChanged, cb)
    },
    keymap: {
      get: () => ipc.invoke(HUB_IPC.keymapGet),
      set: (file) => ipc.invoke(HUB_IPC.keymapSet, file)
    }
  }
}

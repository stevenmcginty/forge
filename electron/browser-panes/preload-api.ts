import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { BROWSER_IPC, type BrowserApi, type BrowserSurfaceInfo } from '@shared/browser'

/**
 * `window.forgeBrowser` — the renderer's half of the built-in browser. Exposed
 * by electron/preload.ts with its own `exposeInMainWorld`, beside `forgeHub`.
 *
 * `setBounds` and `setProject` are one-way sends: the surface reports its
 * placeholder every frame it moves, and a round trip per frame would be waste.
 */
export const browserApi: BrowserApi = {
  list: () => ipcRenderer.invoke(BROWSER_IPC.list),
  open: (req) => ipcRenderer.invoke(BROWSER_IPC.open, req),
  close: (id) => ipcRenderer.invoke(BROWSER_IPC.close, String(id ?? '')),
  navigate: (id, url) => ipcRenderer.invoke(BROWSER_IPC.navigate, String(id ?? ''), String(url ?? '')),
  history: (id, action) => ipcRenderer.invoke(BROWSER_IPC.history, String(id ?? ''), action),
  setBounds: (id, bounds) => ipcRenderer.send(BROWSER_IPC.bounds, String(id ?? ''), bounds),
  move: (id, rect) => ipcRenderer.invoke(BROWSER_IPC.move, String(id ?? ''), rect),
  setProject: (projectId) => ipcRenderer.send(BROWSER_IPC.project, String(projectId ?? '')),
  agent: (req) => ipcRenderer.invoke(BROWSER_IPC.agent, req),
  onChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, list: BrowserSurfaceInfo[]): void => cb(list)
    ipcRenderer.on(BROWSER_IPC.changed, listener)
    return () => {
      ipcRenderer.removeListener(BROWSER_IPC.changed, listener)
    }
  }
}

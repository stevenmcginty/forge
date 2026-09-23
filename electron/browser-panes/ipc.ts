import { app, ipcMain, type BrowserWindow } from 'electron'
import { VOICE_OWNER, type BrowserAgentReply, type BrowserOwner } from '@shared/browser'
import { getDataDir, getProjects } from '../store'
import { liveSessions } from '../pty-host'
import { askRendererTool } from '../voice-agent/ipc'
import { setBrainBrowserRunner } from './brain'
import { setBrowserLinkFile } from './env'
import { BrowserService, type BrowserServiceDeps } from './service'

/**
 * The Electron glue for Forge's built-in browser — deliberately thin. The
 * decisions live in ./agent-ops.ts, the hands in ./manager.ts, the assembly in
 * ./service.ts; this file only supplies the real data dir, the real pane list,
 * and the lifecycle hooks electron/main.ts calls.
 */

let service: BrowserService | null = null
/** Hooks other modules install, kept here so the order of registration does not matter. */
let nameCaller: ((owner: BrowserOwner, projectId: string | undefined, paneId: string) => BrowserOwner) | null = null
let shotHook: NonNullable<BrowserServiceDeps['onShot']> | null = null

/** A pane caller, named from the PTY host's own record of that pane, then by any installed namer (call-signs). */
function resolveFromPanes(caller: BrowserOwner): { owner: BrowserOwner; project?: string } {
  const paneId = caller.id.slice('pane:'.length)
  const live = liveSessions().find((s) => s.id === paneId)
  const project = live ? getProjects().find((p) => p.name === live.projectName)?.id : undefined
  let owner: BrowserOwner = live ? { ...caller, label: live.paneTitle || caller.label } : caller
  if (nameCaller) {
    try {
      owner = nameCaller(owner, project, paneId)
    } catch (err) {
      console.error('[browser] caller namer failed:', err)
    }
  }
  return { owner, ...(project ? { project } : {}) }
}

/** Build the service and register the renderer's handlers. Call once, with the other handlers. */
export function registerBrowserPanes(): void {
  if (service) return
  service = new BrowserService({
    dataDir: getDataDir(),
    downloadsDir: app.getPath('downloads'),
    resolveCaller: resolveFromPanes,
    onShot: (path, owner, id, project) => shotHook?.(path, owner, id, project),
    // A pane agent's open_agent_pane: the renderer runs the same tool the
    // main agent has, so the new agent opens as a Forge tab — never a window.
    appOp: async (op, args) => {
      const text = await askRendererTool(op, args)
      return { ok: !/^(FAILED|That failed|Forge did not answer|Forge could not be reached)/.test(text), text }
    }
  })
  service.registerIpc(ipcMain)
  setBrowserLinkFile(service.linkFile)
  setBrainBrowserRunner((op, args) => service?.run(op, args, VOICE_OWNER) ?? Promise.resolve(notReady()))
  service.start().catch((err) => console.error('[browser] link failed to start:', err))
}

function notReady(): BrowserAgentReply {
  return { ok: false, text: "Forge's browser is not running yet." }
}

/** The window views are laid into. Call after createWindow, and with null when it closes. */
export function setBrowserWindow(win: BrowserWindow | null): void {
  service?.setWindow(win)
}

/** Quit: close every view and remove the link file. */
export function disposeBrowserPanes(): void {
  service?.dispose()
  service = null
}

/**
 * Name a pane caller better than its title — call-signs. Gets the owner as the
 * PTY host named it, the pane's project id (when known) and its pane id.
 */
export function setBrowserCallerNamer(namer: (owner: BrowserOwner, projectId: string | undefined, paneId: string) => BrowserOwner): void {
  nameCaller = namer
}

/** Every browser screenshot, for the canvas board. */
export function setBrowserShotHook(hook: NonNullable<BrowserServiceDeps['onShot']>): void {
  shotHook = hook
}

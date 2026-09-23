import { join } from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import {
  BROWSER_IPC,
  USER_OWNER,
  VOICE_OWNER,
  normaliseBrowserUrl,
  type BrowserAgentReply,
  type BrowserAgentRequest,
  type BrowserHistoryAction,
  type BrowserOwner,
  type BrowserRect,
  type BrowserViewBounds
} from '@shared/browser'
import { BrowserAgentOps } from './agent-ops'
import { BrowserLink } from './link'
import { BrowserManager } from './manager'

/**
 * The browser, assembled: the manager (views + CDP), the ownership rules, the
 * authenticated pipe the agent CLIs call in on, and the renderer's IPC.
 *
 * Takes every environmental fact as a dependency — the data dir, where downloads
 * go, how a pane id becomes a name and a project — so scripts/browser-check.mjs
 * builds this exact object inside a bare Electron process. ./ipc.ts is the thin
 * layer that supplies the real ones from the store and the PTY host.
 */

export interface BrowserServiceDeps {
  dataDir: string
  downloadsDir: string
  /** Fill in a pane caller's label/agent/project (call-signs, pane titles). */
  resolveCaller?: (caller: BrowserOwner) => { owner: BrowserOwner; project?: string }
  /** A screenshot was taken — the canvas board hook. `project` is the tab's project id ('' = none). */
  onShot?: (path: string, owner: BrowserOwner, id: string, project: string) => void
}

export class BrowserService {
  readonly manager: BrowserManager
  readonly ops: BrowserAgentOps
  readonly link: BrowserLink
  private readonly deps: BrowserServiceDeps
  private window: BrowserWindow | null = null
  /** The project the window is showing — where tabs from callers with no project land. */
  private activeProject = ''
  /** Owner id → project, learned when a caller is resolved. */
  private readonly ownerProject = new Map<string, string>()

  constructor(deps: BrowserServiceDeps) {
    this.deps = deps
    const dir = join(deps.dataDir, 'browser')
    this.manager = new BrowserManager({
      dir,
      shotsDir: join(dir, 'shots'),
      downloadsDir: deps.downloadsDir,
      onChanged: (list) => {
        const win = this.window
        if (win && !win.isDestroyed()) win.webContents.send(BROWSER_IPC.changed, list)
      },
      onShot: (path, owner, id, project) => this.deps.onShot?.(path, owner, id, project),
      hostZoom: () => {
        const win = this.window
        return win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1
      }
    })
    this.ops = new BrowserAgentOps(this.manager, (owner) => this.ownerProject.get(owner.id) ?? this.activeProject)
    this.link = new BrowserLink(dir, (op, args, caller) => this.run(op, args, caller))
  }

  /** Where the bridge finds the pipe and token: FORGE_BROWSER_LINK_FILE. */
  get linkFile(): string {
    return this.link.linkFile
  }

  async start(): Promise<void> {
    await this.link.listen()
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win
    this.manager.setWindow(win)
  }

  /** One tool call from anyone. Pane callers are resolved to their name and project first. */
  run(op: string, args: Record<string, unknown>, caller: BrowserOwner): Promise<BrowserAgentReply> {
    let owner = caller
    if (caller.id.startsWith('pane:') && this.deps.resolveCaller) {
      try {
        const resolved = this.deps.resolveCaller(caller)
        owner = resolved.owner
        if (resolved.project) this.ownerProject.set(owner.id, resolved.project)
      } catch (err) {
        console.error('[browser] caller resolver failed:', err)
      }
    }
    return this.ops.run(op, args, owner)
  }

  /** The renderer's handlers. Call once. */
  registerIpc(ipc: IpcMain): void {
    ipc.handle(BROWSER_IPC.list, () => this.manager.infos())
    ipc.handle(BROWSER_IPC.open, async (_e, req: { url?: unknown; project?: unknown; rect?: BrowserRect }) => {
      const { url, error } = normaliseBrowserUrl(String(req?.url ?? ''))
      if (error) return { ok: false, text: error } satisfies BrowserAgentReply
      const project = typeof req?.project === 'string' ? req.project : this.activeProject
      const opened = await this.manager.open(USER_OWNER, url, '', project, req?.rect)
      return { ok: true, text: opened.text, id: opened.id } satisfies BrowserAgentReply
    })
    ipc.handle(BROWSER_IPC.close, async (_e, id: unknown) => {
      const key = String(id ?? '')
      this.ops.forget(key)
      return await this.manager.close(key)
    })
    ipc.handle(BROWSER_IPC.navigate, async (_e, id: unknown, raw: unknown) => {
      const { url, error } = normaliseBrowserUrl(String(raw ?? ''))
      if (error) return { ok: false, text: error } satisfies BrowserAgentReply
      const text = await this.manager.navigate(String(id ?? ''), url)
      return { ok: true, text, id: String(id ?? '') } satisfies BrowserAgentReply
    })
    ipc.handle(BROWSER_IPC.history, (_e, id: unknown, action: BrowserHistoryAction) =>
      this.manager.history(String(id ?? ''), action)
    )
    ipc.on(BROWSER_IPC.bounds, (_e, id: unknown, bounds: BrowserViewBounds | null) => {
      const sane = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every((n) => Number.isFinite(n))
      this.manager.setBounds(String(id ?? ''), sane ? bounds : null)
    })
    ipc.handle(BROWSER_IPC.move, (_e, id: unknown, rect: BrowserRect) => this.manager.move(String(id ?? ''), rect))
    ipc.on(BROWSER_IPC.project, (_e, project: unknown) => {
      this.activeProject = String(project ?? '')
    })
    // The voice hub: one owner, "Voice", with its own tabs like any agent.
    ipc.handle(BROWSER_IPC.agent, (_e, req: BrowserAgentRequest) =>
      this.ops.run(String(req?.op ?? ''), req?.args && typeof req.args === 'object' ? req.args : {}, VOICE_OWNER)
    )
  }

  dispose(): void {
    this.link.close()
    this.manager.dispose()
    this.window = null
  }
}

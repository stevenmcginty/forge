import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { isChatBotId } from '@shared/chatbots'
import type { ChatNavAction, ChatNewTabResult, ChatViewBounds } from '@shared/api'
import type { BrowserAgentReply } from '@shared/browser'
import type { Workspace } from '@shared/types'
import { getProjects, getWorkspace } from '../store'
import { layoutEngine } from '../layout-engine'
import { ChatAgentOps, openChatTabQuietly, type ChatCaller } from './agent-ops'
import { chatSignOut, chatStatus, watchChatStatus } from './signin'
import { ChatViews } from './views'

/**
 * The Electron glue for chat tabs — deliberately thin, like
 * ../browser-panes/ipc.ts. The pages are ./views.ts, the sign-in reading is
 * ./signin.ts; this file registers the renderer's channels and hands main.ts
 * the lifecycle hooks it calls.
 */

let views: ChatViews | null = null
let agentOps: ChatAgentOps | null = null
let window: BrowserWindow | null = null
let unwatch: (() => void) | null = null

/** Every chat leaf id in a layout. A chat tab's root is its one chat. */
function chatIdsOf(workspace: Workspace | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const tab of workspace?.tabs ?? []) if (tab.root?.type === 'chat') ids.add(tab.root.id)
  return ids
}

/** The project whose saved layout holds this chat leaf, or '' if none does. */
function projectOf(leafId: string): string {
  for (const p of getProjects()) {
    if (chatIdsOf(getWorkspace(p.id)).has(leafId)) return p.id
  }
  return ''
}

function validRect(rect: unknown): ChatViewBounds | null {
  if (!rect || typeof rect !== 'object') return null
  const r = rect as Record<string, unknown>
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const x = n(r['x'])
  const y = n(r['y'])
  const width = n(r['width'])
  const height = n(r['height'])
  if (x === null || y === null || width === null || height === null || width < 1 || height < 1) return null
  return { x, y, width, height }
}

/** Register the renderer's handlers. Call once, with the other handlers, after the layout engine is installed. */
export function registerChatPanes(): void {
  if (views) return
  const v = new ChatViews({ projectOf })
  views = v
  if (window) v.setWindow(window)
  agentOps = new ChatAgentOps({
    projects: () => getProjects().map((p) => ({ id: p.id, name: p.name })),
    workspace: (projectId) => layoutEngine()?.workspace(projectId) ?? getWorkspace(projectId),
    openChatTab: (projectId, bot) => {
      const engine = layoutEngine()
      return engine ? openChatTabQuietly(engine, projectId, bot) : { ok: false, error: 'Forge is still starting.' }
    },
    page: (leafId, bot) => v.agentPage(leafId, bot),
    openPage: (leafId) => v.openPage(leafId),
    signedIn: chatStatus
  })

  ipcMain.on(IPC.chatEnsure, (_e, leafId: unknown, bot: unknown) => {
    if (typeof leafId !== 'string' || !leafId || !isChatBotId(bot)) return
    v.ensure(leafId, bot)
  })
  ipcMain.on(IPC.chatBounds, (_e, leafId: unknown, rect: unknown) => {
    if (typeof leafId !== 'string' || !leafId) return
    v.bounds(leafId, validRect(rect))
  })
  ipcMain.on(IPC.chatNav, (_e, leafId: unknown, action: unknown) => {
    if (typeof leafId !== 'string' || !leafId) return
    if (action === 'back' || action === 'reload' || action === 'home') v.nav(leafId, action as ChatNavAction)
  })
  ipcMain.on(IPC.chatClose, (_e, leafId: unknown) => {
    if (typeof leafId === 'string' && leafId) v.close(leafId)
  })
  ipcMain.handle(IPC.chatNewTab, (_e, projectId: unknown, bot: unknown): ChatNewTabResult => {
    const engine = layoutEngine()
    if (!engine) return { ok: false, error: 'Forge is still starting. Try again in a moment.' }
    const result = engine.apply(String(projectId ?? ''), { op: 'newChatTab', projectId: String(projectId ?? ''), bot: String(bot ?? '') })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, tabId: result.workspace.activeTabId ?? '' }
  })
  ipcMain.handle(IPC.chatStatus, async (_e, bot: unknown): Promise<boolean> => (isChatBotId(bot) ? chatStatus(bot) : false))
  ipcMain.handle(IPC.chatSignOut, async (_e, bot: unknown): Promise<void> => {
    if (!isChatBotId(bot)) return
    await chatSignOut(bot)
    v.reloadBot(bot)
  })

  unwatch = watchChatStatus((event) => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC.chatStatusEvent, event)
  })
}

/**
 * One chat tool call (shared/chat-tools.ts) from any caller, already resolved
 * to its project by electron/browser-panes/service.ts. Never rejects.
 */
export function runChatOp(op: string, args: Record<string, unknown>, caller: ChatCaller): Promise<BrowserAgentReply> {
  if (!agentOps) return Promise.resolve({ ok: false, text: 'Forge\'s chat tabs are not ready yet — try again in a moment.' })
  return agentOps.run(op, args, caller)
}

/** The window pages are laid into. Call after createWindow, and with null when it closes. */
export function setChatWindow(win: BrowserWindow | null): void {
  window = win
  views?.setWindow(win)
}

/** A project's layout was just saved: close the pages of chats it no longer holds. */
export function pruneChatViews(projectId: string, workspace: Workspace | null): void {
  views?.prune(projectId, chatIdsOf(workspace))
}

/** Quit: close every page. */
export function disposeChatPanes(): void {
  unwatch?.()
  unwatch = null
  agentOps = null
  views?.dispose()
  views = null
}

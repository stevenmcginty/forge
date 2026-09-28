import {
  app,
  clipboard,
  Menu,
  shell,
  WebContentsView,
  type BaseWindow,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { BROWSER_PARTITION, normaliseBrowserUrl } from '@shared/browser'
import { IPC } from '@shared/ipc'
import { CHATBOTS, type ChatBotId } from '@shared/chatbots'
import type { ChatNavAction, ChatViewBounds, ChatViewState } from '@shared/api'
import { prepareBrowserSession } from '../browser-panes/manager'
import { chatUrl, forgetChat, setChatUrl } from './registry'
import type { ChatPage } from './agent-ops'

/**
 * The chat pages themselves: one WebContentsView per chat leaf, laid over the
 * placeholder src/components/ChatPane.tsx draws — the same trick the built-in
 * browser plays (electron/browser-panes/manager.ts), and for the same reason:
 * a real top-level page, with the site's own sign-in and everything the user
 * has in it.
 *
 * Every page lives in the browser's `persist:forge-browser` session, so one
 * sign-in covers the browser, every chat tab and Settings → Chatbots. Nothing
 * here changes that session: no user agent, no permission policy, no download
 * handler. Those are the browser's to set.
 *
 * Not a browser surface. A chat page is not in the surface list, not on the
 * board and not reachable by the browser tools. Agents reach it only through
 * the chat tools (shared/chat-tools.ts): `agentPage` below hands
 * ./agent-ops.ts a page to type a message into, send, and read the reply of —
 * in the open, on the tab Steve can watch. Nothing reads cookies or storage.
 *
 * A view is made the first time its pane is on screen and kept while its leaf
 * is in some project's layout — switching tabs only hides it, so a half-typed
 * message survives. It is closed when its leaf leaves the layout (`prune`,
 * from every place a workspace is saved) or its pane asks (`close`).
 */

/** Where a page waits while no pane shows it: off-screen-sized, so it lays out sensibly. */
const HIDDEN = { x: 0, y: 0, width: 1280, height: 800 }
/** How long one page script may take before the page is called not responding. */
const PAGE_SCRIPT_MS = 10_000

interface ChatView {
  view: WebContentsView
  bot: ChatBotId
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  /** The project whose layout holds this leaf, once a save has said so. */
  project: string
  error: string
}

export interface ChatViewsDeps {
  /** The project a chat leaf lives in, by scanning the saved layouts. Once per view. */
  projectOf: (leafId: string) => string
}

export class ChatViews {
  private readonly deps: ChatViewsDeps
  private readonly views = new Map<string, ChatView>()
  private window: BrowserWindow | null = null
  private offHost: (() => void) | null = null

  constructor(deps: ChatViewsDeps) {
    this.deps = deps
  }

  /* ------------------------------------------------------------ the window */

  /** The window views are laid into. Null detaches (window closing). */
  setWindow(win: BrowserWindow | null): void {
    if (this.window === win) return
    this.offHost?.()
    this.offHost = null
    const old = this.window
    this.window = win
    for (const cv of this.views.values()) {
      if (old && !old.isDestroyed()) {
        try {
          old.contentView.removeChildView(cv.view)
        } catch {
          /* already gone with the window */
        }
      }
      if (win && !win.isDestroyed()) {
        win.contentView.addChildView(cv.view)
        cv.view.setBounds(cv.bounds)
        cv.view.setVisible(cv.visible)
      }
    }
    if (win && !win.isDestroyed()) this.offHost = this.watchHost(win.webContents)
  }

  /**
   * A renderer that reloads or dies runs none of its panes' cleanups, so a page
   * would stay drawn over whatever comes back. Hide them all; the panes that
   * mount again show their own. Same as the browser's watchHost.
   */
  private watchHost(host: WebContents): () => void {
    const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) this.hideAll()
    }
    const onGone = (): void => this.hideAll()
    host.on('did-start-navigation', onNavigate)
    host.on('render-process-gone', onGone)
    return () => {
      if (host.isDestroyed()) return
      host.off('did-start-navigation', onNavigate)
      host.off('render-process-gone', onGone)
    }
  }

  hideAll(): void {
    for (const cv of this.views.values()) {
      cv.visible = false
      if (!cv.view.webContents.isDestroyed()) cv.view.setVisible(false)
    }
  }

  private hostZoom(): number {
    const win = this.window
    return win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1
  }

  /* ------------------------------------------------------------- the views */

  /** The leaf's page, made (and loaded) on first use. A crashed page gets a fresh view. */
  ensure(leafId: string, bot: ChatBotId): WebContentsView {
    const held = this.views.get(leafId)
    if (held && !held.view.webContents.isDestroyed() && !held.view.webContents.isCrashed()) {
      // A pane mounting again (a tab switch) starts with a blank bar: say it again.
      this.report(leafId)
      return held.view
    }
    if (held) this.drop(leafId)

    prepareBrowserSession(app.getPath('downloads'))
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    // An agent's chat_send waits for a reply on a tab nobody is looking at: a
    // throttled hidden page would hold the reply's words back until shown.
    wc.setBackgroundThrottling(false)
    const cv: ChatView = { view, bot, visible: false, bounds: { ...HIDDEN }, project: this.deps.projectOf(leafId), error: '' }
    this.views.set(leafId, cv)

    // The browser's popup policy: a script-sized popup ("Sign in with Google"
    // and friends) needs a real window that keeps window.opener, so it gets
    // one, in this same session. Anything else that wants a new tab goes to
    // Steve's own browser, so the pane stays on its chatbot.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const { url: safe, error } = normaliseBrowserUrl(url)
      if (error || !safe) return { action: 'deny' }
      if (disposition === 'new-window') {
        const parent = this.window && !this.window.isDestroyed() ? this.window : undefined
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { ...(parent ? { parent } : {}), autoHideMenuBar: true, backgroundColor: '#ffffff' }
        }
      }
      if (/^https?:/i.test(safe)) void shell.openExternal(safe)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (!/^(https?:|about:blank)/i.test(url)) event.preventDefault()
    })
    wc.on('context-menu', (_e, params) => this.pageMenu(wc, params))
    wc.on('render-process-gone', (_e, details) => {
      if (this.views.get(leafId)?.view !== view || details.reason === 'clean-exit') return
      cv.error = `Page crashed (${details.reason})`
      this.report(leafId)
    })
    // ERR_ABORTED (-3) is a redirect or a download, not a failure.
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      cv.error = desc || `Load failed (${code})`
      this.report(leafId)
    })
    const sync = (): void => {
      if (wc.isDestroyed()) return
      const url = wc.getURL()
      if (url && url !== 'about:blank') setChatUrl(leafId, url)
      this.report(leafId)
    }
    wc.on('did-navigate', () => {
      cv.error = ''
      sync()
    })
    wc.on('did-navigate-in-page', sync)
    wc.on('did-start-loading', () => this.report(leafId))
    wc.on('did-stop-loading', sync)

    // Added first, then sized: bounds set on a view not yet in a window are dropped.
    if (this.window && !this.window.isDestroyed()) this.window.contentView.addChildView(view)
    view.setBounds(cv.bounds)
    view.setVisible(false)
    void wc.loadURL(chatUrl(leafId) ?? CHATBOTS[bot].homeUrl).catch(() => undefined)
    return view
  }

  /** Where the placeholder is now, in CSS pixels. Null hides the page. */
  bounds(leafId: string, rect: ChatViewBounds | null): void {
    const cv = this.views.get(leafId)
    if (!cv) return
    if (!rect) {
      cv.visible = false
      if (!cv.view.webContents.isDestroyed()) cv.view.setVisible(false)
      return
    }
    const zoom = this.hostZoom()
    const next = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom))
    }
    cv.bounds = next
    cv.view.setBounds(next)
    if (!cv.visible) {
      cv.visible = true
      cv.view.setVisible(true)
    }
  }

  nav(leafId: string, action: ChatNavAction): void {
    const cv = this.views.get(leafId)
    const wc = cv?.view.webContents
    if (!cv || !wc || wc.isDestroyed()) return
    if (action === 'back') {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    } else if (action === 'reload') {
      // A crashed page cannot reload; a fresh view can.
      if (wc.isCrashed()) this.ensure(leafId, cv.bot)
      else wc.reload()
    } else if (action === 'home') {
      void wc.loadURL(CHATBOTS[cv.bot].homeUrl).catch(() => undefined)
    }
  }

  /** Close a leaf's page for good. */
  close(leafId: string): void {
    this.drop(leafId)
    forgetChat(leafId)
  }

  /**
   * A project's layout was saved: close the pages of its chat leaves that are
   * no longer in it. `liveIds` is every chat leaf id the project now holds.
   */
  prune(projectId: string, liveIds: Set<string>): void {
    for (const [leafId, cv] of this.views) {
      if (liveIds.has(leafId)) cv.project = projectId
      else if (cv.project === projectId) this.close(leafId)
    }
  }

  /** Every open page of one bot, reloaded — after a sign-out, so each shows the site's own login. */
  reloadBot(bot: ChatBotId): void {
    for (const [leafId, cv] of this.views) {
      if (cv.bot !== bot) continue
      const wc = cv.view.webContents
      if (wc.isDestroyed()) continue
      forgetChat(leafId)
      void wc.loadURL(CHATBOTS[bot].homeUrl).catch(() => undefined)
    }
  }

  /** The leaf's page, if it is open, for chat_list: where it is and what it is called. */
  openPage(leafId: string): { url: string; title: string } | null {
    const wc = this.views.get(leafId)?.view.webContents
    if (!wc || wc.isDestroyed()) return null
    return { url: wc.getURL(), title: wc.getTitle() }
  }

  /**
   * The leaf's page for an agent's chat tool (./agent-ops.ts), made and loading
   * if no pane has shown it yet — hidden until one does.
   */
  agentPage(leafId: string, bot: ChatBotId): ChatPage | null {
    let wc: WebContents
    try {
      wc = this.ensure(leafId, bot).webContents
    } catch {
      return null
    }
    const alive = (): boolean => !wc.isDestroyed() && !wc.isCrashed()
    const gone = (): Error => new Error('the chat page closed')
    return {
      alive,
      url: () => (alive() ? wc.getURL() : ''),
      run: async <T>(script: string): Promise<T> => {
        if (!alive()) throw gone()
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('the chat page is not responding')), PAGE_SCRIPT_MS)
        })
        try {
          return (await Promise.race([wc.executeJavaScript(script, true), late])) as T
        } finally {
          clearTimeout(timer)
        }
      },
      insertText: async (text: string) => {
        if (!alive()) throw gone()
        await wc.insertText(text)
      },
      pressEnter: () => {
        if (!alive()) return
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'char', keyCode: '\r' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      },
      load: async (url: string) => {
        if (!alive()) throw gone()
        await wc.loadURL(url).catch(() => undefined)
      },
      settled: (ms: number) =>
        new Promise<void>((resolve) => {
          if (!alive() || !wc.isLoading()) {
            resolve()
            return
          }
          const done = (): void => {
            clearTimeout(timer)
            if (!wc.isDestroyed()) wc.off('did-stop-loading', done)
            resolve()
          }
          const timer = setTimeout(done, ms)
          wc.once('did-stop-loading', done)
        })
    }
  }

  dispose(): void {
    this.offHost?.()
    this.offHost = null
    for (const leafId of [...this.views.keys()]) this.drop(leafId)
    this.window = null
  }

  /* --------------------------------------------------------------- helpers */

  private drop(leafId: string): void {
    const cv = this.views.get(leafId)
    if (!cv) return
    this.views.delete(leafId)
    try {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(cv.view)
    } catch {
      /* the window went first */
    }
    if (!cv.view.webContents.isDestroyed()) cv.view.webContents.close()
  }

  /** Tell the renderer what the pane's bar should say about its page. */
  private report(leafId: string): void {
    const cv = this.views.get(leafId)
    const win = this.window
    if (!cv || !win || win.isDestroyed()) return
    const wc = cv.view.webContents
    if (wc.isDestroyed()) return
    const state: ChatViewState = {
      leafId,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      error: cv.error
    }
    win.webContents.send(IPC.chatViewState, state)
  }

  /** Right-click in a chat page: the few things a browser's menu is used for. */
  private pageMenu(wc: WebContents, p: ContextMenuParams): void {
    const items: MenuItemConstructorOptions[] = []
    const link = p.linkURL ? normaliseBrowserUrl(p.linkURL) : null
    if (link && !link.error && /^https?:/i.test(link.url)) {
      const target = link.url
      items.push(
        { label: 'Open link in your browser', click: () => void shell.openExternal(target) },
        { label: 'Copy link address', click: () => clipboard.writeText(target) },
        { type: 'separator' }
      )
    }
    if (p.isEditable) items.push({ label: 'Cut', enabled: p.editFlags.canCut, click: () => wc.cut() })
    items.push({ label: 'Copy', enabled: p.editFlags.canCopy, click: () => wc.copy() })
    if (p.isEditable) items.push({ label: 'Paste', enabled: p.editFlags.canPaste, click: () => wc.paste() })
    items.push({ label: 'Select all', click: () => wc.selectAll() }, { type: 'separator' })
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Reload', click: () => wc.reload() }
    )
    const win: BaseWindow | null = this.window
    Menu.buildFromTemplate(items).popup(win && !win.isDestroyed() ? { window: win } : {})
  }
}

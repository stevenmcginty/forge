import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { session as electronSession, WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron'
import {
  ARTIFACT_PARTITION,
  BROWSER_DEFAULT_RECT,
  BROWSER_PARTITION,
  isArtifactUrl,
  normaliseBrowserUrl,
  type BrowserHistoryAction,
  type BrowserOwner,
  type BrowserRect,
  type BrowserSurfaceInfo,
  type BrowserSurfaceRecord,
  type BrowserViewBounds
} from '@shared/browser'
import { installArtifactScheme } from '../artifact-scheme'
import type { BrowserDriver } from './agent-ops'
import { BrowserSurfaceStore } from './store'
import {
  READ_SCRIPT,
  formatRead,
  refDomClickScript,
  refFocusScript,
  refPointScript,
  staleRef,
  type PageSnapshot
} from './snapshot'

/**
 * The browser surfaces themselves: one WebContentsView per tab, laid over the
 * placeholder the renderer draws, and driven through `webContents.debugger`
 * (the DevTools protocol) — no separate Chrome, no playwright.
 *
 * Every tab lives in the one `persist:forge-browser` session, so a sign-in done
 * once — by Steve, by hand, on any surface — is there for every agent. Views are
 * created lazily: a surface restored from disk loads nothing until something
 * shows it or an agent names it, so twenty saved tabs do not load twenty pages
 * at boot.
 *
 * A tab whose surface is not on screen still works for agents. Its view stays in
 * the window, hidden, sized to its last bounds (or a sensible default), with
 * background throttling off so timers and layout keep running. Measured on
 * Electron 43: a hidden view takes CDP keystrokes and scripts, but never acks a
 * CDP mouse event and has no surface for capturePage — so clicks on it are
 * dispatched on the element instead, and screenshots go through the protocol's
 * own capture, which works while the window is shown (not minimised). That is
 * what lets an agent browse while Steve is looking at something else.
 *
 * A canvas artifact (forge-artifact://…, see ../artifact-scheme.ts) opens as a
 * read-only view in a session of its own — ARTIFACT_PARTITION, in memory, with
 * the scheme handler and nothing else — so an agent's page never sees the
 * cookies of the shared one. A tab's session is fixed when its view is made, so
 * sending a tab from one kind of address to the other gives it a fresh view.
 *
 * Nothing here decides who may act on what — that is ./agent-ops.ts. This file
 * is the hands.
 */

const NAV_TIMEOUT_MS = 20_000
const SETTLE_MS = 5_000
const SETTLE_FIRST_MS = 250
const TYPE_DELAY_MS = 12
/** Longer than this is pasted as one insert rather than typed key by key. */
const TYPE_KEYWISE_MAX = 400
const HIDDEN_SIZE = { width: 1280, height: 800 }
/** A real mouse event on an on-screen view is acked in milliseconds; past this, fall back. */
const MOUSE_ACK_MS = 2_500
/** One screenshot route's budget before trying the other. */
const SHOT_MS = 8_000

interface Tab {
  view: WebContentsView | null
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  /** The view lives in ARTIFACT_PARTITION (it was made for a forge-artifact: address). */
  artifact: boolean
  /** Why the last main-frame load failed; '' once a page commits. */
  error: string
}

export interface BrowserManagerDeps {
  /** `<data dir>\browser` — surfaces.json lives here. */
  dir: string
  /** Where screenshots are written. */
  shotsDir: string
  /** Where downloads land, so an agent's click never opens a save dialog. */
  downloadsDir: string
  /** The surface list changed. Debounced. */
  onChanged: (list: BrowserSurfaceInfo[]) => void
  /** A screenshot was taken. The canvas board hook. `project` is the tab's project id. */
  onShot?: (path: string, owner: BrowserOwner, id: string, project: string) => void
  /** The renderer's zoom factor, so CSS-px bounds become window DIPs. */
  hostZoom?: () => number
  /** `<data dir>\canvas` — what artifact tabs may show. Without it they show nothing. */
  artifactRoot?: string
}

function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** "ERR_CONNECTION_REFUSED" → "Connection refused". */
function netReason(desc: string, code: number): string {
  const words = String(desc || '').replace(/^(net::)?ERR_/i, '').replace(/_/g, ' ').trim().toLowerCase()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : `Error ${code}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/** `work`, or null if it has not finished within `ms`. Some CDP calls never answer on a hidden view. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<null>((res) => (timer = setTimeout(() => res(null), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Wait for the page to stop loading, bounded. */
async function settle(wc: WebContents, limit = SETTLE_MS): Promise<void> {
  await sleep(SETTLE_FIRST_MS)
  if (wc.isDestroyed() || !wc.isLoading()) return
  await new Promise<void>((res) => {
    const timer = setTimeout(done, limit)
    function done(): void {
      clearTimeout(timer)
      if (!wc.isDestroyed()) wc.off('did-stop-loading', done)
      res()
    }
    wc.once('did-stop-loading', done)
  })
}

let sessionReady = false

/** One-time policy for the shared session: no permission prompts, no save dialogs. */
function prepareSession(ses: Session, downloadsDir: string): void {
  if (sessionReady) return
  sessionReady = true
  // An agent must never be the reason a camera or location prompt appears, and
  // a prompt nobody is looking at is worse than a refusal.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
  })
  ses.on('will-download', (_event, item) => {
    mkdirSync(downloadsDir, { recursive: true })
    item.setSavePath(join(downloadsDir, basename(item.getFilename() || 'download')))
  })
}

let artifactSessionReady = false

/**
 * The artifact tabs' session: the canvas on forge-artifact:, and no to every
 * permission and every download. Nothing an artifact does is kept — the
 * partition has no `persist:` prefix.
 */
function prepareArtifactSession(ses: Session, canvasRoot: string | undefined): void {
  if (artifactSessionReady) return
  artifactSessionReady = true
  if (canvasRoot) installArtifactScheme(ses.protocol, canvasRoot)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
}

export class BrowserManager implements BrowserDriver {
  private readonly deps: BrowserManagerDeps
  private readonly store: BrowserSurfaceStore
  private readonly tabs = new Map<string, Tab>()
  private window: BaseWindow | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: BrowserManagerDeps) {
    this.deps = deps
    this.store = new BrowserSurfaceStore(deps.dir)
  }

  /* ------------------------------------------------------------ the window */

  /** The window views are laid into. Null detaches (window closing). */
  setWindow(win: BaseWindow | null): void {
    if (this.window === win) return
    const old = this.window
    this.window = win
    for (const tab of this.tabs.values()) {
      if (!tab.view) continue
      if (old && !old.isDestroyed()) {
        try {
          old.contentView.removeChildView(tab.view)
        } catch {
          /* already gone with the window */
        }
      }
      if (win && !win.isDestroyed()) {
        win.contentView.addChildView(tab.view)
        tab.view.setBounds(tab.bounds)
        tab.view.setVisible(tab.visible)
      }
    }
  }

  /* ---------------------------------------------------------------- state */

  records(): BrowserSurfaceRecord[] {
    return this.store.all()
  }

  infos(): BrowserSurfaceInfo[] {
    return this.store.all().map((r) => {
      const wc = this.tabs.get(r.id)?.view?.webContents
      const live = wc && !wc.isDestroyed()
      const error = this.tabs.get(r.id)?.error
      return {
        ...r,
        loading: live ? wc.isLoading() : false,
        canGoBack: live ? wc.navigationHistory.canGoBack() : false,
        canGoForward: live ? wc.navigationHistory.canGoForward() : false,
        ...(error ? { error } : {})
      }
    })
  }

  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.deps.onChanged(this.infos())
    }, 40)
  }

  /* ------------------------------------------------------------ the views */

  /** The tab's view, created (and its page loaded) on first use. */
  private ensureView(id: string): WebContentsView | null {
    const record = this.store.get(id)
    if (!record) return null
    let tab = this.tabs.get(id)
    if (tab?.view && !tab.view.webContents.isDestroyed()) return tab.view

    const artifact = isArtifactUrl(record.url)
    const partition = artifact ? ARTIFACT_PARTITION : BROWSER_PARTITION
    const ses = electronSession.fromPartition(partition)
    if (artifact) prepareArtifactSession(ses, this.deps.artifactRoot)
    else prepareSession(ses, this.deps.downloadsDir)
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    wc.setBackgroundThrottling(false)

    // A popup becomes a navigation of this same tab: agents get predictable
    // pages, and nothing opens a window Forge does not manage.
    // An artifact view opens nothing and goes nowhere but other canvas files.
    wc.setWindowOpenHandler(({ url }) => {
      const { url: safe, error } = normaliseBrowserUrl(url)
      if (!artifact && !error && safe) void wc.loadURL(safe).catch(() => undefined)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (artifact ? !isArtifactUrl(url) : !/^(https?:|about:blank)/i.test(url)) event.preventDefault()
    })
    // "Failed" on the surface: a main-frame load that did not happen, until a
    // page does commit. ERR_ABORTED (-3) is a redirect or a download, not a failure.
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      const tab = this.tabs.get(id)
      if (tab) tab.error = netReason(desc, code)
      this.changed()
    })
    wc.on('did-navigate', () => {
      const tab = this.tabs.get(id)
      if (tab) tab.error = ''
    })
    const sync = (): void => {
      if (wc.isDestroyed()) return
      const url = wc.getURL()
      const title = wc.getTitle()
      const current = this.store.get(id)
      if (current && (current.url !== url || current.title !== title) && url) {
        this.store.patch(id, { url, title: title || current.title })
      }
      this.changed()
    }
    wc.on('page-title-updated', sync)
    wc.on('did-navigate', sync)
    wc.on('did-navigate-in-page', sync)
    wc.on('did-start-loading', () => this.changed())
    wc.on('did-stop-loading', sync)

    tab = tab ?? { view: null, visible: false, bounds: { x: 0, y: 0, ...HIDDEN_SIZE }, artifact, error: '' }
    tab.view = view
    tab.artifact = artifact
    tab.error = ''
    this.tabs.set(id, tab)
    // Added first, then sized: bounds set on a view that is not yet in a window
    // are dropped, and the page lays out at zero width.
    if (this.window && !this.window.isDestroyed()) this.window.contentView.addChildView(view)
    view.setBounds(tab.bounds)
    view.setVisible(tab.visible)

    if (record.url && record.url !== 'about:blank') void wc.loadURL(record.url).catch(() => undefined)
    return view
  }

  private wcFor(id: string): WebContents | null {
    const view = this.ensureView(id)
    const wc = view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** Is this tab's view actually being drawn — shown, in a window that is itself shown? */
  private onScreen(id: string): boolean {
    const win = this.window
    return Boolean(this.tabs.get(id)?.visible && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
  }

  /** Load a url, bounded, and say where we landed. */
  private async load(wc: WebContents, url: string): Promise<string> {
    let failure = ''
    const loading = wc.loadURL(url).catch((err: unknown) => {
      // ERR_ABORTED is a redirect or a download taking over, not a failure.
      const text = errText(err)
      if (!/ERR_ABORTED|\(-3\)/.test(text)) failure = text
    })
    await Promise.race([loading, sleep(NAV_TIMEOUT_MS)])
    if (failure) return `could not load ${hostOf(url)}: ${failure}`
    await settle(wc, 2_000)
    return ''
  }

  private where(wc: WebContents): string {
    const title = wc.getTitle()
    return `${wc.getURL()}${title ? ` — "${title}"` : ''}`
  }

  /* ----------------------------------------------------- renderer actions */

  /** Where the placeholder is now. Null hides the view (the surface scrolled away or unmounted). */
  setBounds(id: string, bounds: BrowserViewBounds | null): void {
    if (!bounds) {
      const tab = this.tabs.get(id)
      if (!tab) return
      tab.visible = false
      tab.view?.setVisible(false)
      return
    }
    const view = this.ensureView(id)
    const tab = this.tabs.get(id)
    if (!view || !tab) return
    const zoom = this.deps.hostZoom?.() ?? 1
    const next = {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom))
    }
    tab.bounds = next
    view.setBounds(next)
    if (!tab.visible) {
      tab.visible = true
      view.setVisible(true)
    }
    const scale = Number(bounds.scale ?? 1)
    if (Number.isFinite(scale) && scale > 0.2 && scale < 5) {
      const wc = view.webContents
      if (Math.abs(wc.getZoomFactor() - scale) > 0.01) wc.setZoomFactor(scale)
    }
  }

  move(id: string, rect: BrowserRect): boolean {
    const ok = this.store.patch(id, { rect })
    if (ok) this.changed()
    return ok
  }

  history(id: string, action: BrowserHistoryAction): boolean {
    const wc = this.wcFor(id)
    if (!wc) return false
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'stop') wc.stop()
    else return false
    return true
  }

  /* ------------------------------------------------------------ the driver */

  async open(owner: BrowserOwner, url: string, title: string, project: string, rect?: BrowserRect): Promise<{ id: string; text: string }> {
    const id = this.store.nextId()
    const now = Date.now()
    const count = this.store.all().length
    this.store.put({
      id,
      project,
      url,
      title: title || hostOf(url),
      owner,
      // Cascade new surfaces so a burst of opens does not stack them exactly.
      rect: rect ?? { ...BROWSER_DEFAULT_RECT, x: BROWSER_DEFAULT_RECT.x + (count % 8) * 36, y: BROWSER_DEFAULT_RECT.y + (count % 8) * 28 },
      createdAt: now,
      updatedAt: now
    })
    this.changed()
    const view = this.ensureView(id)
    if (!view) return { id, text: `Tab ${id} could not be created.` }
    const wc = view.webContents
    if (url === 'about:blank') return { id, text: `Opened tab ${id} (yours), blank. browser_open with id "${id}" and a url sends it somewhere.` }
    const failure = await this.firstLoad(wc)
    if (title) this.store.patch(id, { title })
    this.changed()
    if (failure) return { id, text: `Opened tab ${id}, but ${hostOf(url)} did not load: ${failure}. It is your tab; try browser_open again with id "${id}" or another address.` }
    return {
      id,
      text: `Opened tab ${id} (yours): ${this.where(wc)}. browser_read is the next call — it lists what you can click, numbered.`
    }
  }

  /** ensureView has started a load; wait for it, bounded. '' = it loaded. */
  private async firstLoad(wc: WebContents): Promise<string> {
    let failure = ''
    await Promise.race([
      new Promise<void>((res) => {
        const done = (): void => res()
        wc.once('did-finish-load', done)
        wc.once('did-fail-load', (_e, code, desc) => {
          if (code !== -3) failure = `${desc} (${code})`
          res()
        })
      }),
      sleep(NAV_TIMEOUT_MS)
    ])
    await settle(wc, 2_000)
    return failure
  }

  /** Close a tab's view but keep the tab; the next ensureView makes a fresh one. */
  private dropView(tab: Tab): void {
    const view = tab.view
    tab.view = null
    if (!view) return
    try {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view)
    } catch {
      /* the window went first */
    }
    const wc = view.webContents
    if (!wc.isDestroyed()) {
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach()
      } catch {
        /* detached already */
      }
      wc.close()
    }
  }

  async navigate(id: string, url: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (tab?.view && tab.artifact !== isArtifactUrl(url) && this.store.get(id)) {
      // A web page and a canvas artifact never share a session: a fresh view,
      // made in the right one, loading the new address.
      this.dropView(tab)
      this.store.patch(id, { url })
      const fresh = this.wcFor(id)
      if (!fresh) return `Tab ${id} is gone.`
      this.changed()
      const failure = await this.firstLoad(fresh)
      this.changed()
      if (failure) return `Tab ${id} could not load ${hostOf(url)}: ${failure}.`
      return `Tab ${id} is now on ${this.where(fresh)}. Read it again to see what is there.`
    }
    const wc = this.wcFor(id)
    if (!wc) return `Tab ${id} is gone.`
    const problem = await this.load(wc, url)
    if (problem) return `Tab ${id} ${problem}.`
    return `Tab ${id} is now on ${this.where(wc)}. Read it again to see what is there.`
  }

  /** CDP, attached on first use and re-attached if something detached it. */
  private async cdp<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      // Every tab behaves as the focused page, so several agents can type into
      // several tabs at once without any of them taking the keyboard from Steve.
      // Without this only the one WebContents holding window focus takes keys.
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    }
    return (await wc.debugger.sendCommand(method, params ?? {})) as T
  }

  private async evaluate<T>(wc: WebContents, expression: string): Promise<T> {
    const res = await this.cdp<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      wc,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true }
    )
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'page script failed')
    }
    return res.result?.value as T
  }

  async read(id: string): Promise<string> {
    const wc = this.wcFor(id)
    if (!wc) return `Tab ${id} is gone.`
    if (wc.isLoading()) await settle(wc)
    try {
      const snap = await this.evaluate<PageSnapshot>(wc, READ_SCRIPT)
      return formatRead(id, snap)
    } catch (err) {
      return `Tab ${id} could not be read: ${errText(err)}`
    }
  }

  async click(id: string, ref: number): Promise<string> {
    const wc = this.wcFor(id)
    if (!wc) return `Tab ${id} is gone.`
    let point: { x: number; y: number; label: string; w: number; h: number } | null
    try {
      point = await this.evaluate(wc, refPointScript(ref))
    } catch (err) {
      return `I could not find element ${ref} on tab ${id}: ${errText(err)}`
    }
    if (!point) return staleRef(ref)
    const tab = this.tabs.get(id)
    const box = tab?.bounds ?? { width: HIDDEN_SIZE.width, height: HIDDEN_SIZE.height }
    const zoom = wc.getZoomFactor() || 1
    const inView = point.w >= 1 && point.h >= 1 && point.x >= 0 && point.y >= 0 && point.x * zoom <= box.width && point.y * zoom <= box.height
    try {
      // A real mouse press at the element's middle when the page is on screen,
      // so a listener on a parent — most buttons on most sites — reacts as it
      // would to a hand. A view that is not on screen never acks mouse input,
      // so it gets the same sequence dispatched on the element instead.
      let pressed = false
      if (inView && this.onScreen(id)) {
        const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
        pressed =
          (await within(
            (async () => {
              await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
              await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
              await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
              return true
            })(),
            MOUSE_ACK_MS
          )) === true
      }
      if (!pressed) {
        const clicked = await this.evaluate<boolean>(wc, refDomClickScript(ref))
        if (!clicked) return staleRef(ref)
      }
    } catch (err) {
      return `I could not click "${point.label}" on tab ${id}: ${errText(err)}`
    }
    await settle(wc)
    return `Clicked "${point.label}" on tab ${id}. Now on ${this.where(wc)}. Read the page again to see what changed.`
  }

  private async key(wc: WebContents, key: string, code: string, vk: number, text?: string): Promise<void> {
    await this.cdp(wc, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      ...(text ? { text, unmodifiedText: text } : {})
    })
    await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }

  async type(id: string, ref: number | null, text: string, submit: boolean): Promise<string> {
    const wc = this.wcFor(id)
    if (!wc) return `Tab ${id} is gone.`
    let label = ''
    if (ref !== null) {
      try {
        const focused = await this.evaluate<{ label: string } | null>(wc, refFocusScript(ref))
        if (!focused) return staleRef(ref)
        label = focused.label
      } catch (err) {
        return `I could not find element ${ref} on tab ${id}: ${errText(err)}`
      }
    }
    try {
      if (text.length > TYPE_KEYWISE_MAX) {
        await this.cdp(wc, 'Input.insertText', { text })
      } else {
        for (const ch of text) {
          if (ch === '\n') await this.key(wc, 'Enter', 'Enter', 13, '\r')
          else await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
          if (ch !== '\n') await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
          await sleep(TYPE_DELAY_MS)
        }
      }
    } catch (err) {
      return `I could not type into ${label ? `"${label}"` : 'the page'} on tab ${id}: ${errText(err)}`
    }
    const into = label ? `into "${label}"` : 'where the focus was'
    if (!submit) return `Typed that ${into} on tab ${id}.`
    try {
      await this.key(wc, 'Enter', 'Enter', 13, '\r')
    } catch (err) {
      return `Typed it, but pressing Enter failed: ${errText(err)}`
    }
    await settle(wc)
    return `Typed that ${into} and pressed Enter on tab ${id}. Now on ${this.where(wc)}. Read the page again to see what changed.`
  }

  async screenshot(id: string, owner: BrowserOwner): Promise<{ path: string } | { error: string }> {
    const wc = this.wcFor(id)
    if (!wc) return { error: `Tab ${id} is gone.` }
    if (wc.isLoading()) await settle(wc)
    // An on-screen view photographs best through capturePage; a hidden one has
    // no display surface for that, but the protocol's own capture still works
    // while the window is shown. Each route is bounded: on a minimised window
    // neither answers, and an agent must hear that rather than wait forever.
    const viaCapture = async (): Promise<Buffer | null> => {
      const image = await within(wc.capturePage(undefined, { stayHidden: true }), SHOT_MS)
      return image && !image.isEmpty() ? image.toPNG() : null
    }
    const viaProtocol = async (): Promise<Buffer | null> => {
      const shot = await within(this.cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'png' }), SHOT_MS)
      return shot?.data ? Buffer.from(shot.data, 'base64') : null
    }
    const routes = this.onScreen(id) ? [viaCapture, viaProtocol] : [viaProtocol, viaCapture]
    let png: Buffer | null = null
    let why = ''
    for (const route of routes) {
      try {
        png = await route()
      } catch (err) {
        why = errText(err)
      }
      if (png) break
    }
    if (!png) {
      return {
        error: `Tab ${id} could not be photographed${why ? `: ${why}` : ''}. If Forge's window is minimised, pages cannot be drawn — browser_read still works.`
      }
    }
    mkdirSync(this.deps.shotsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(this.deps.shotsDir, `${id}-${stamp}.png`)
    writeFileSync(path, png)
    try {
      this.deps.onShot?.(path, owner, id, this.store.get(id)?.project ?? '')
    } catch (err) {
      console.error('[browser] onShot hook failed:', err)
    }
    return { path }
  }

  async close(id: string): Promise<boolean> {
    const tab = this.tabs.get(id)
    this.tabs.delete(id)
    if (tab?.view) {
      try {
        if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
      } catch {
        /* the window went first */
      }
      const wc = tab.view.webContents
      if (!wc.isDestroyed()) {
        try {
          if (wc.debugger.isAttached()) wc.debugger.detach()
        } catch {
          /* detached already */
        }
        wc.close()
      }
    }
    const removed = this.store.remove(id)
    this.changed()
    return removed
  }

  /** Close every view; the records stay on disk for next time. */
  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    for (const [, tab] of this.tabs) {
      const wc = tab.view?.webContents
      if (wc && !wc.isDestroyed()) wc.close()
    }
    this.tabs.clear()
    this.window = null
  }
}

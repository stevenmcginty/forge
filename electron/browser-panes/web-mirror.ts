import { app, BrowserWindow, type NativeImage } from 'electron'
import {
  BROWSER_MAX_SURFACES,
  BROWSER_PARTITION,
  USER_OWNER,
  isArtifactUrl,
  normaliseBrowserUrl,
  type BrowserSurfaceInfo,
  type BrowserSurfaceRecord
} from '@shared/browser'
import {
  BROWSER_CTRL_LETTERS,
  BROWSER_IDLE_MS,
  MAX_BROWSER_MIRRORS,
  type BrowserInputFrame,
  type BrowserKey,
  type BrowserMirrorHost,
  type BrowserMods,
  type BrowserNavFrame,
  type BrowserOpenedFrame,
  type BrowserServerFrame,
  type BrowserSink,
  type BrowserStateFrame,
  type BrowserTabSummary,
  type BrowserWatchFrame
} from '@shared/browser-mirror'
import { getProjects } from '../store'
import { browserService, setBrowserReadyHook } from './ipc'
import { prepareBrowserSession } from './manager'
import type { BrowserService } from './service'

/**
 * A desktop Browser tab in Forge Web: an offscreen copy of the tab's page,
 * sized to the browser's box, streamed as JPEG pictures and driven by the
 * browser's clicks, scrolls and keys. The wire is shared/browser-mirror.ts.
 *
 * Built like the chat mirror (electron/chat-panes/phone-mirror.ts), and for the
 * same reason: a hidden WebContentsView has no surface to capture and does not
 * ack input (see ./manager.ts), while an offscreen window paints whether or not
 * anything is on screen and takes `sendInputEvent`. The copy lives in
 * BROWSER_PARTITION, so a sign-in done here is a sign-in for every tab and
 * every agent at home. It opens at the tab's address and then lives its own
 * life: cookies are shared, scroll and half-typed forms are not.
 *
 * Input goes to the copy only: never the OS pointer or keyboard, and never the
 * desktop's own view of the tab.
 *
 * One copy per tab, shared by every socket watching it, at most
 * MAX_BROWSER_MIRRORS in all. A copy nobody is watching stops painting at once
 * and is closed after BROWSER_IDLE_MS, or at once when its tab closes.
 */

/** Paints a second while watched, as the chat copy. */
const FRAME_RATE = 10
const JPEG_QUALITY = 70
/** A frame this large (bytes, before base64) is re-encoded smaller, then dropped. */
const MAX_FRAME_BYTES = 512 * 1024
/** Unsent bytes on a socket past which a frame is skipped rather than queued behind the tunnel. */
const MAX_BACKLOG = 256 * 1024
/** How often a skipped frame is retried once the sockets have drained. */
const DRAIN_POLL_MS = 150

const ARTIFACT_REFUSAL = 'This tab is a Board page. It is not shown here yet.'

interface Copy {
  tabId: string
  win: BrowserWindow
  /** Every socket watching, by viewer id. Empty while idle. */
  sinks: Map<string, BrowserSink>
  width: number
  height: number
  seq: number
  last: Buffer | null
  /** A first page has finished loading. */
  started: boolean
  error: string | undefined
  /** A paint skipped for backlog, owed once the sockets drain. */
  owed: boolean
  drainTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  /** Input is performed in order. */
  queue: Promise<void>
  lastUsed: number
}

const copies = new Map<string, Copy>()
const tabListeners = new Set<(tabs: BrowserTabSummary[]) => void>()

/* --------------------------------------------------------------- the tabs */

function summary(info: BrowserSurfaceRecord): BrowserTabSummary {
  return {
    id: info.id,
    project: info.project,
    url: info.url,
    title: info.title,
    ownerId: info.owner.id,
    ownerLabel: info.owner.label,
    ownerAgent: info.owner.agent
  }
}

/** The service this module listens to — re-hooked if it was rebuilt. */
let hooked: BrowserService | null = null
let unhook: (() => void) | null = null

function onTabsChanged(list: BrowserSurfaceInfo[]): void {
  const ids = new Set(list.map((r) => r.id))
  for (const m of [...copies.values()]) {
    if (ids.has(m.tabId)) continue
    pushState(m, { error: 'That tab was closed on the desktop.' })
    destroy(m)
  }
  const tabs = list.map(summary)
  for (const listener of tabListeners) {
    try {
      listener(tabs)
    } catch {
      /* a socket that died is released by its own close */
    }
  }
}

/** The running browser service, with this module listening to its tab list. */
function service(): BrowserService | null {
  const s = browserService()
  if (s !== hooked) {
    unhook?.()
    unhook = s ? s.onTabsChanged(onTabsChanged) : null
    hooked = s
  }
  return s
}

/**
 * The service came up after a browser had asked for the tab list (Forge Web
 * started first): listen to it now, and send the list it has, rather than
 * leaving that browser on an empty strip until its next `browser:*` frame.
 */
function onServiceReady(): void {
  const s = service()
  if (!s || !tabListeners.size) return
  const tabs = s.manager.records().map(summary)
  for (const listener of tabListeners) {
    try {
      listener(tabs)
    } catch {
      /* a socket that died is released by its own close */
    }
  }
}

function record(tabId: string): BrowserSurfaceRecord | null {
  return service()?.manager.records().find((r) => r.id === tabId) ?? null
}

/* -------------------------------------------------------------- the copy */

function send(sink: BrowserSink, frame: BrowserServerFrame): void {
  try {
    sink.send(frame)
  } catch {
    /* a socket that died is released by its own close */
  }
}

function stateOf(m: Copy): BrowserStateFrame {
  const status = m.error ? 'error' : m.started ? 'live' : 'loading'
  const base: BrowserStateFrame = { type: 'browser:state', tabId: m.tabId, status, ...(m.error ? { error: m.error } : {}) }
  const wc = m.win.isDestroyed() ? null : m.win.webContents
  if (!wc || wc.isDestroyed()) return base
  return {
    ...base,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward()
  }
}

/** The copy's state to every watcher. `override` is a sentence for this one push (a refused address). */
function pushState(m: Copy, override?: { error: string }): void {
  const frame = { ...stateOf(m), ...(override ?? {}) }
  for (const sink of m.sinks.values()) send(sink, frame)
}

/** Only http(s) — or a blank tab, so a tab opened from the browser can be sent somewhere. */
function startUrl(url: string): { url: string } | { error: string } {
  if (isArtifactUrl(url)) return { error: ARTIFACT_REFUSAL }
  if (url === 'about:blank' || /^https?:\/\//i.test(url)) return { url }
  return { error: 'This tab is not a web page. It is not shown here.' }
}

function encode(image: NativeImage): Buffer | null {
  if (image.isEmpty()) return null
  let jpeg = image.toJPEG(JPEG_QUALITY)
  if (jpeg.length > MAX_FRAME_BYTES) jpeg = image.toJPEG(45)
  return jpeg.length > MAX_FRAME_BYTES ? null : jpeg
}

function onPaint(m: Copy, image: NativeImage): void {
  if (m.sinks.size === 0) return
  const ready = [...m.sinks.values()].filter((s) => s.backlog() <= MAX_BACKLOG)
  if (ready.length < m.sinks.size) owe(m)
  if (ready.length === 0) return
  const jpeg = encode(image)
  if (!jpeg) return
  if (m.last && m.last.equals(jpeg)) return
  m.last = jpeg
  m.seq += 1
  const frame: BrowserServerFrame = {
    type: 'browser:frame',
    tabId: m.tabId,
    seq: m.seq,
    jpeg: jpeg.toString('base64'),
    width: m.width,
    height: m.height
  }
  for (const sink of ready) send(sink, frame)
}

/** A frame was skipped for a full socket: ask for a fresh paint once every socket drains. */
function owe(m: Copy): void {
  m.owed = true
  if (m.drainTimer) return
  m.drainTimer = setInterval(() => {
    if (m.sinks.size === 0 || m.win.isDestroyed()) return stopDrain(m)
    if ([...m.sinks.values()].some((s) => s.backlog() > MAX_BACKLOG)) return
    stopDrain(m)
    if (m.owed) {
      m.owed = false
      m.last = null
      m.win.webContents.invalidate()
    }
  }, DRAIN_POLL_MS)
}

function stopDrain(m: Copy): void {
  if (m.drainTimer) clearInterval(m.drainTimer)
  m.drainTimer = null
}

function destroy(m: Copy): void {
  if (copies.get(m.tabId) === m) copies.delete(m.tabId)
  stopDrain(m)
  if (m.idleTimer) clearTimeout(m.idleTimer)
  m.idleTimer = null
  for (const sink of m.sinks.values()) console.log(`[browser-mirror] ${sink.who} stopped watching ${m.tabId} (closed)`)
  m.sinks.clear()
  if (!m.win.isDestroyed()) m.win.destroy()
}

/**
 * These copies are windows, and a window keeps Electron's `window-all-closed`
 * from firing (see the same guard in electron/chat-panes/phone-mirror.ts).
 * Whenever a window closes and nothing but offscreen copies is left — these or
 * the chat mirror's — these go too, and their closing lets the chat mirror's
 * own guard finish the job.
 */
let guarded = false
function guardQuit(): void {
  if (guarded) return
  guarded = true
  const check = (): void => {
    const left = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (copies.size > 0 && left.every((w) => w.webContents.isOffscreen())) disposeBrowserMirrors()
  }
  for (const win of BrowserWindow.getAllWindows()) win.once('closed', check)
  app.on('browser-window-created', (_event, win) => win.once('closed', check))
}

function create(tabId: string, url: string, frame: BrowserWatchFrame): Copy {
  guardQuit()
  prepareBrowserSession(app.getPath('downloads'))
  const win = new BrowserWindow({
    show: false,
    width: frame.width,
    height: frame.height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: { deviceScaleFactor: frame.dpr },
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  const m: Copy = {
    tabId,
    win,
    sinks: new Map(),
    width: frame.width,
    height: frame.height,
    seq: 0,
    last: null,
    started: false,
    error: undefined,
    owed: false,
    drainTimer: null,
    idleTimer: null,
    queue: Promise.resolve(),
    lastUsed: Date.now()
  }
  const wc = win.webContents
  wc.setFrameRate(FRAME_RATE)
  // No second window: a pop-up (a "Sign in with…" window, a new-tab link)
  // opens in this same copy instead, as a page. Only http(s) is followed.
  wc.setWindowOpenHandler(({ url: target }) => {
    const { url: safe, error } = normaliseBrowserUrl(target)
    if (!error && /^https?:\/\//i.test(safe)) void wc.loadURL(safe).catch(() => undefined)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, target) => {
    if (!/^(https?:|about:blank)/i.test(target)) event.preventDefault()
  })
  wc.on('paint', (_event, _dirty, image) => onPaint(m, image))
  wc.on('did-start-loading', () => {
    m.error = undefined
    pushState(m)
  })
  wc.on('did-stop-loading', () => {
    m.started = true
    pushState(m)
  })
  wc.on('did-navigate', () => pushState(m))
  wc.on('did-navigate-in-page', () => pushState(m))
  wc.on('page-title-updated', () => pushState(m))
  wc.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    // -3 is an aborted load: a redirect or the page navigating itself, not a failure.
    if (!isMainFrame || code === -3) return
    let host = failedUrl
    try {
      host = new URL(failedUrl).host || failedUrl
    } catch {
      /* the raw address will do */
    }
    m.error = `Can't reach ${host} (${description || `error ${code}`}).`
    pushState(m)
  })
  wc.on('render-process-gone', () => {
    m.error = 'The page stopped on the desktop. Leave the tab and come back to reload it.'
    pushState(m)
  })
  copies.set(tabId, m)
  void wc.loadURL(url).catch(() => {
    /* reported by did-fail-load */
  })
  return m
}

/** Room for one more copy: an idle one goes first; with every copy in use, none is made. */
function makeRoom(): boolean {
  if (copies.size < MAX_BROWSER_MIRRORS) return true
  const idle = [...copies.values()].filter((m) => m.sinks.size === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0]
  if (!idle) return false
  destroy(idle)
  return true
}

/** One socket stops watching; the last one out starts the idle grace. */
function leave(m: Copy, viewer: string): void {
  const sink = m.sinks.get(viewer)
  if (!sink) return
  m.sinks.delete(viewer)
  console.log(`[browser-mirror] ${sink.who} stopped watching ${m.tabId}`)
  if (m.sinks.size > 0) return
  m.lastUsed = Date.now()
  stopDrain(m)
  if (!m.win.isDestroyed()) m.win.webContents.stopPainting()
  if (m.idleTimer) clearTimeout(m.idleTimer)
  m.idleTimer = setTimeout(() => destroy(m), BROWSER_IDLE_MS)
}

/* ----------------------------------------------------------------- input */

function perform(m: Copy, task: (m: Copy) => Promise<void> | void): void {
  m.lastUsed = Date.now()
  m.queue = m.queue
    .then(async () => {
      if (m.win.isDestroyed()) return
      // Offscreen input needs the page to believe it has focus. This is the
      // offscreen view's own focus, not the OS's: no window comes forward.
      if (!m.win.webContents.isFocused()) m.win.webContents.focus()
      await task(m)
    })
    .catch(() => {
      /* one failed gesture must not stall the ones behind it */
    })
}

type Modifier = 'shift' | 'control' | 'alt'

function modifiersOf(mods: BrowserMods | undefined): Modifier[] {
  const out: Modifier[] = []
  if (mods?.shift) out.push('shift')
  if (mods?.ctrl) out.push('control')
  if (mods?.alt) out.push('alt')
  return out
}

function click(m: Copy, x: number, y: number, count: number, modifiers: Modifier[]): void {
  const wc = m.win.webContents
  wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
  // A double click arrives as it would from a mouse: a first click, then a
  // second whose clickCount is 2.
  for (let n = 1; n <= count; n++) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: n, modifiers })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: n, modifiers })
  }
}

/**
 * The wire's `dx`/`dy` are a DOM wheel's: positive scrolls the page down/right.
 * Chromium's own wheel delta is the other way round (positive is towards the
 * top — see the chat mirror's `scroll`), hence the negation.
 */
function scroll(m: Copy, x: number, y: number, dx: number, dy: number, modifiers: Modifier[]): void {
  m.win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -dx, deltaY: -dy, canScroll: true, modifiers })
}

/** BROWSER_KEYS as Electron's Accelerator key codes, which is what `sendInputEvent` takes. */
const KEY_CODES: Record<BrowserKey, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space'
}

/** The character a key types, for the `char` event between down and up. */
const KEY_CHARS: Partial<Record<BrowserKey, string>> = { Enter: '\r', Space: ' ' }

function key(m: Copy, name: string, mods: BrowserMods | undefined): void {
  const wc = m.win.webContents
  const modifiers = modifiersOf(mods)
  if ((BROWSER_CTRL_LETTERS as readonly string[]).includes(name)) {
    // Lower case on purpose: an upper-case key code implies shift.
    if (!mods?.ctrl) return
    wc.sendInputEvent({ type: 'keyDown', keyCode: name, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: name, modifiers })
    return
  }
  const code = KEY_CODES[name as BrowserKey]
  if (!code) return
  wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
  const char = KEY_CHARS[name as BrowserKey]
  if (char && !mods?.ctrl && !mods?.alt) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
}

/* ------------------------------------------------------------------ host */

function refuse(sink: BrowserSink, tabId: string, error: string): void {
  send(sink, { type: 'browser:state', tabId, status: 'error', error })
}

/** A watcher's copy, or null — input and nav are only ever taken from a socket watching that tab. */
function watched(tabId: string, viewer: string): Copy | null {
  const m = copies.get(tabId)
  return m && m.sinks.has(viewer) && !m.win.isDestroyed() ? m : null
}

function browserMirrorHost(): BrowserMirrorHost {
  return {
    tabs() {
      return service()?.manager.records().map(summary) ?? []
    },

    onTabs(listener) {
      service()
      tabListeners.add(listener)
      return () => {
        tabListeners.delete(listener)
      }
    },

    watch(frame, sink) {
      if (!service()) return refuse(sink, frame.tabId, "Forge's browser is not running yet.")
      const rec = record(frame.tabId)
      if (!rec) return refuse(sink, frame.tabId, 'That tab is not open on the desktop.')
      let m = copies.get(rec.id)
      if (!m || m.win.isDestroyed() || m.win.webContents.isCrashed()) {
        if (m) destroy(m)
        const start = startUrl(rec.url)
        if ('error' in start) return refuse(sink, rec.id, start.error)
        if (!makeRoom()) {
          return refuse(
            sink,
            rec.id,
            `Forge is already showing ${MAX_BROWSER_MIRRORS} Browser tabs to browsers. Leave one of them and try again.`
          )
        }
        m = create(rec.id, start.url, frame)
      }
      if (m.idleTimer) clearTimeout(m.idleTimer)
      m.idleTimer = null
      if (!m.sinks.has(sink.viewer)) console.log(`[browser-mirror] ${sink.who} is watching ${rec.id}`)
      m.sinks.set(sink.viewer, sink)
      m.lastUsed = Date.now()
      // One copy, one size: the latest box asked for wins.
      if (m.width !== frame.width || m.height !== frame.height) {
        m.width = frame.width
        m.height = frame.height
        m.win.setContentSize(frame.width, frame.height)
      }
      // The new socket has seen nothing yet: the state, then a fresh picture.
      m.last = null
      send(sink, stateOf(m))
      m.win.webContents.startPainting()
      m.win.webContents.invalidate()
    },

    unwatch(tabId, viewer) {
      const m = copies.get(tabId)
      if (m) leave(m, viewer)
    },

    input(frame: BrowserInputFrame, viewer) {
      const m = watched(frame.tabId, viewer)
      if (!m) return
      const modifiers = modifiersOf(frame.mods)
      switch (frame.kind) {
        case 'click':
          if (frame.x !== undefined && frame.y !== undefined) {
            const { x, y } = frame
            const count = frame.count ?? 1
            perform(m, (mm) => click(mm, x, y, count, modifiers))
          }
          return
        case 'scroll':
          if (frame.x !== undefined && frame.y !== undefined) {
            const { x, y } = frame
            const dx = frame.dx ?? 0
            const dy = frame.dy ?? 0
            perform(m, (mm) => scroll(mm, x, y, dx, dy, modifiers))
          }
          return
        case 'text':
          if (frame.text) {
            const text = frame.text
            perform(m, (mm) => mm.win.webContents.insertText(text))
          }
          return
        case 'key':
          if (frame.key) {
            const name = frame.key
            const mods = frame.mods
            perform(m, (mm) => key(mm, name, mods))
          }
          return
      }
    },

    nav(frame: BrowserNavFrame, viewer) {
      const m = watched(frame.tabId, viewer)
      if (!m) return
      const wc = m.win.webContents
      m.lastUsed = Date.now()
      switch (frame.action) {
        case 'back':
          if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
          return
        case 'forward':
          if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
          return
        case 'reload':
          wc.reload()
          return
        case 'stop':
          wc.stop()
          return
        case 'go': {
          const { url, error } = normaliseBrowserUrl(frame.url ?? '')
          if (error || !url) {
            pushState(m, { error: error || 'No address was given.' })
            return
          }
          void wc.loadURL(url).catch(() => {
            /* reported by did-fail-load */
          })
          return
        }
      }
    },

    async open(frame) {
      const reply = (fields: { tabId?: string; error?: string }): BrowserOpenedFrame => ({
        type: 'browser:opened',
        reqId: frame.reqId,
        ...fields
      })
      const s = service()
      if (!s) return reply({ error: "Forge's browser is not running yet." })
      let url = 'about:blank'
      if (frame.url) {
        const normal = normaliseBrowserUrl(frame.url)
        if (normal.error) return reply({ error: normal.error })
        url = normal.url
      }
      if (frame.project && !getProjects().some((p) => p.id === frame.project)) {
        return reply({ error: 'That project is not on the desktop.' })
      }
      if (s.manager.records().length >= BROWSER_MAX_SURFACES) {
        return reply({ error: `Forge already has ${BROWSER_MAX_SURFACES} tabs open. Close one and try again.` })
      }
      const opened = await s.manager.open(USER_OWNER, url, '', frame.project)
      console.log(`[browser-mirror] opened ${opened.id} for a browser`)
      return reply({ tabId: opened.id })
    },

    close(tabId) {
      const s = service()
      const rec = record(tabId)
      if (!s || !rec) return
      if (rec.owner.id !== USER_OWNER.id) {
        console.log(`[browser-mirror] refused to close ${tabId}: it is ${rec.owner.label}'s`)
        return
      }
      s.ops.forget(tabId)
      void s.manager.close(tabId)
    },

    release(viewer) {
      for (const m of [...copies.values()]) leave(m, viewer)
    }
  }
}

let shared: BrowserMirrorHost | null = null

/** The one host Forge Web (electron/web-host.ts) is handed. */
export function sharedBrowserMirrorHost(): BrowserMirrorHost {
  if (!shared) {
    shared = browserMirrorHost()
    setBrowserReadyHook(onServiceReady)
  }
  return shared
}

/** Forge Web is stopping: close every copy and stop listening to the tab list. */
export function disposeBrowserMirrors(): void {
  for (const m of [...copies.values()]) destroy(m)
  tabListeners.clear()
  unhook?.()
  unhook = null
  hooked = null
}

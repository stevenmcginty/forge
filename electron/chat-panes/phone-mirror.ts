import { app, BrowserWindow, type NativeImage } from 'electron'
import { BROWSER_PARTITION } from '@shared/browser'
import { CHATBOTS } from '@shared/chatbots'
import { prepareBrowserSession } from '../browser-panes/manager'
import {
  CHAT_IDLE_MS,
  MAX_CHAT_MIRRORS,
  type ChatInputFrame,
  type ChatMirrorHost,
  type ChatServerFrame,
  type ChatSink,
  type ChatStatus,
  type ChatWatchFrame
} from '@shared/chat-mirror'
import type { ChatLeaf } from '@shared/types'
import { chatUrl } from './registry'

/**
 * A chat tab on a phone: an offscreen copy of the chat page, sized to the
 * phone's pane, streamed as JPEG pictures and driven by the phone's taps.
 *
 * Why a copy and not the desktop's own view: the desktop's view is sized for
 * the desk, and a hidden WebContentsView has no surface to capture and does not
 * ack input (see electron/browser-panes/manager.ts). An offscreen window paints
 * whether or not anything is on screen, takes `sendInputEvent` — which is made
 * for exactly this — and at the phone's CSS width the site draws its own
 * mobile layout. It lives in the same `persist:forge-browser` session as the
 * desktop's chat, so it is the same account and the same conversations.
 *
 * Input goes to this page only: never the OS pointer or keyboard, so nothing
 * on Steve's screen moves (the screen Mirror's path, electron/mobile/input.ts,
 * is deliberately not used).
 *
 * One copy per chat per phone (keyed by the browser's device id, which survives
 * a reconnect), at most MAX_CHAT_MIRRORS in all. A copy nobody is watching
 * stops painting at once and is closed after CHAT_IDLE_MS, or at once when its
 * chat tab closes.
 */

/** Paints a second while watched. A chat page is mostly still; this is plenty for scrolling. */
const FRAME_RATE = 10
const JPEG_QUALITY = 70
/** A frame this large (bytes, before base64) is re-encoded smaller, then dropped. */
const MAX_FRAME_BYTES = 512 * 1024
/** Unsent bytes on the socket past which a frame is skipped rather than queued behind the tunnel. */
const MAX_BACKLOG = 256 * 1024
/** How often a skipped frame is retried once the socket has drained. */
const DRAIN_POLL_MS = 150

interface Mirror {
  key: string
  device: string
  leafId: string
  bot: ChatLeaf['bot']
  win: BrowserWindow
  /** The watching socket, or null while idle. */
  sink: ChatSink | null
  width: number
  height: number
  seq: number
  last: Buffer | null
  status: ChatStatus
  error: string | undefined
  /** A paint skipped for backlog, owed once the socket drains. */
  owed: boolean
  drainTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  /** Input is performed in order: focusing the composer is async, and the text must land after it. */
  queue: Promise<void>
  lastUsed: number
}

const mirrors = new Map<string, Mirror>()

const keyOf = (device: string, leafId: string): string => `${device}\n${leafId}`

function push(m: Mirror, frame: ChatServerFrame): void {
  try {
    m.sink?.send(frame)
  } catch {
    /* a socket that died is released by its own close */
  }
}

function setStatus(m: Mirror, status: ChatStatus, error?: string): void {
  m.status = status
  m.error = error
  push(m, { type: 'chat:state', leafId: m.leafId, status, ...(error ? { error } : {}) })
}

/** Only an https page is loaded; anything else the registry holds falls back to the bot's home. */
function startUrl(leafId: string, bot: ChatLeaf['bot']): string {
  const url = chatUrl(leafId)
  return url && url.startsWith('https://') ? url : CHATBOTS[bot].homeUrl
}

function encode(image: NativeImage): Buffer | null {
  if (image.isEmpty()) return null
  let jpeg = image.toJPEG(JPEG_QUALITY)
  if (jpeg.length > MAX_FRAME_BYTES) jpeg = image.toJPEG(45)
  return jpeg.length > MAX_FRAME_BYTES ? null : jpeg
}

function onPaint(m: Mirror, image: NativeImage): void {
  if (!m.sink) return
  if (m.sink.backlog() > MAX_BACKLOG) {
    owe(m)
    return
  }
  const jpeg = encode(image)
  if (!jpeg) return
  if (m.last && m.last.equals(jpeg)) return
  m.last = jpeg
  m.seq += 1
  push(m, {
    type: 'chat:frame',
    leafId: m.leafId,
    seq: m.seq,
    jpeg: jpeg.toString('base64'),
    width: m.width,
    height: m.height
  })
}

/** A frame was skipped for a full socket: ask for a fresh paint once it drains. */
function owe(m: Mirror): void {
  m.owed = true
  if (m.drainTimer) return
  m.drainTimer = setInterval(() => {
    if (!m.sink || m.win.isDestroyed()) return stopDrain(m)
    if (m.sink.backlog() > MAX_BACKLOG) return
    stopDrain(m)
    if (m.owed) {
      m.owed = false
      m.win.webContents.invalidate()
    }
  }, DRAIN_POLL_MS)
}

function stopDrain(m: Mirror): void {
  if (m.drainTimer) clearInterval(m.drainTimer)
  m.drainTimer = null
}

function destroy(m: Mirror): void {
  mirrors.delete(m.key)
  stopDrain(m)
  if (m.idleTimer) clearTimeout(m.idleTimer)
  m.idleTimer = null
  m.sink = null
  if (!m.win.isDestroyed()) m.win.destroy()
}

/**
 * These copies are windows, and a window keeps Electron's `window-all-closed`
 * from firing — which is what takes Forge down when its own window closes for
 * good (electron/main.ts). So whenever a window that is not one of these
 * closes and nothing but these is left, they go too, and the quit goes on as
 * if they had never existed. Armed once, on the first copy.
 */
let guarded = false
function guardQuit(): void {
  if (guarded) return
  guarded = true
  const ours = (win: BrowserWindow): boolean => [...mirrors.values()].some((m) => m.win === win)
  const check = (): void => {
    const left = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (mirrors.size > 0 && left.every(ours)) disposeChatMirrors()
  }
  for (const win of BrowserWindow.getAllWindows()) win.once('closed', check)
  app.on('browser-window-created', (_event, win) => win.once('closed', check))
}

function create(device: string, leaf: ChatLeaf, frame: ChatWatchFrame): Mirror {
  guardQuit()
  prepareBrowserSession(app.getPath('downloads'))
  const win = new BrowserWindow({
    show: false,
    width: frame.width,
    height: frame.height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: frame.dpr },
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  const m: Mirror = {
    key: keyOf(device, leaf.id),
    device,
    leafId: leaf.id,
    bot: leaf.bot,
    win,
    sink: null,
    width: frame.width,
    height: frame.height,
    seq: 0,
    last: null,
    status: 'loading',
    error: undefined,
    owed: false,
    drainTimer: null,
    idleTimer: null,
    queue: Promise.resolve(),
    lastUsed: Date.now()
  }
  const wc = win.webContents
  wc.setFrameRate(FRAME_RATE)
  // A chat site's pop-up (a share sheet, a sign-in window) has nowhere to show
  // on a phone. Sign-in happens at the desk, in the desktop's own chat view.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('paint', (_event, _dirty, image) => onPaint(m, image))
  wc.on('did-start-loading', () => {
    if (m.status !== 'live') setStatus(m, 'loading')
  })
  wc.on('did-finish-load', () => setStatus(m, 'live'))
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 is an aborted load: a redirect or the page navigating itself, not a failure.
    if (!isMainFrame || code === -3) return
    setStatus(m, 'error', `Can't reach ${CHATBOTS[m.bot].name} (${description || `error ${code}`}).`)
  })
  wc.on('render-process-gone', () => {
    setStatus(m, 'error', `${CHATBOTS[m.bot].name} stopped on the desktop. Leave the tab and come back to reload it.`)
  })
  mirrors.set(m.key, m)
  void wc.loadURL(startUrl(leaf.id, leaf.bot)).catch(() => {
    /* reported by did-fail-load */
  })
  return m
}

/** Room for one more copy: an idle one goes first; with every copy in use, none is made. */
function makeRoom(): boolean {
  if (mirrors.size < MAX_CHAT_MIRRORS) return true
  const idle = [...mirrors.values()].filter((m) => !m.sink).sort((a, b) => a.lastUsed - b.lastUsed)[0]
  if (!idle) return false
  destroy(idle)
  return true
}

function idle(m: Mirror): void {
  m.sink = null
  m.lastUsed = Date.now()
  stopDrain(m)
  if (!m.win.isDestroyed()) m.win.webContents.stopPainting()
  if (m.idleTimer) clearTimeout(m.idleTimer)
  m.idleTimer = setTimeout(() => destroy(m), CHAT_IDLE_MS)
}

/* ----------------------------------------------------------------- input */

function perform(m: Mirror, task: (m: Mirror) => Promise<void> | void): void {
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

function tap(m: Mirror, x: number, y: number): void {
  const wc = m.win.webContents
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/**
 * `dy` is the finger's travel down the picture in page pixels. Chromium's
 * wheel delta is positive towards the top of the page (the DOM's `deltaY` is
 * its negation), so a finger dragged down — which should bring earlier
 * messages into view — is a positive delta, unchanged.
 */
function scroll(m: Mirror, x: number, y: number, dy: number): void {
  m.win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, canScroll: true })
}

function key(m: Mirror, name: string): void {
  const wc = m.win.webContents
  wc.sendInputEvent({ type: 'keyDown', keyCode: name })
  if (name === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: name })
}

/**
 * The page's message box, focused with the caret at its end: the bot's own
 * selector first (shared/chatbots.ts), else the last visible textarea or
 * contenteditable on the page. Runs in the page's main world; it reads and
 * focuses, and changes nothing else.
 */
function focusScript(selector: string): string {
  return `(() => {
  const visible = (el) => el && el.getClientRects().length > 0
  let el = document.querySelector(${JSON.stringify(selector)})
  if (!visible(el)) {
    const all = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible)
    el = all[all.length - 1] || null
  }
  if (!el) return false
  el.focus()
  try {
    if (el instanceof HTMLTextAreaElement) {
      el.setSelectionRange(el.value.length, el.value.length)
    } else {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  } catch {}
  return true
})()`
}

async function focusComposer(m: Mirror): Promise<void> {
  const found: unknown = await m.win.webContents.executeJavaScript(focusScript(CHATBOTS[m.bot].composerSelector), true)
  if (found === true) return
  push(m, {
    type: 'chat:state',
    leafId: m.leafId,
    status: m.status,
    error: `Could not find ${CHATBOTS[m.bot].name}'s message box on that page.`
  })
}

/* ------------------------------------------------------------------ host */

/**
 * The half electron/web/server.ts calls. `findChat` answers whether a leaf id
 * is a chat tab this desktop has, and which bot — a watch for anything else is
 * refused, so a browser cannot open an arbitrary page through this.
 */
export function chatMirrorHost(findChat: (leafId: string) => ChatLeaf | null): ChatMirrorHost {
  return {
    watch(device, frame, sink) {
      const leaf = findChat(frame.leafId)
      if (!leaf) {
        sink.send({
          type: 'chat:state',
          leafId: frame.leafId,
          status: 'error',
          error: 'That chat tab is not open on the desktop.'
        })
        return
      }
      const key = keyOf(device, leaf.id)
      let m = mirrors.get(key)
      if (!m || m.win.isDestroyed()) {
        if (m) destroy(m)
        if (!makeRoom()) {
          sink.send({
            type: 'chat:state',
            leafId: leaf.id,
            status: 'error',
            error: `Forge is already showing ${MAX_CHAT_MIRRORS} chats to browsers. Leave one of them and try again.`
          })
          return
        }
        m = create(device, leaf, frame)
      }
      if (m.idleTimer) clearTimeout(m.idleTimer)
      m.idleTimer = null
      m.sink = sink
      m.lastUsed = Date.now()
      if (m.width !== frame.width || m.height !== frame.height) {
        m.width = frame.width
        m.height = frame.height
        m.win.setContentSize(frame.width, frame.height)
      }
      // The new socket has seen nothing yet: the state, then a fresh picture.
      m.last = null
      setStatus(m, m.status, m.error)
      m.win.webContents.startPainting()
      m.win.webContents.invalidate()
    },

    unwatch(device, leafId, viewer) {
      const m = mirrors.get(keyOf(device, leafId))
      if (m && m.sink?.viewer === viewer) idle(m)
    },

    focusComposer(device, leafId) {
      const m = mirrors.get(keyOf(device, leafId))
      if (m?.sink) perform(m, focusComposer)
    },

    input(device, frame: ChatInputFrame) {
      const m = mirrors.get(keyOf(device, frame.leafId))
      if (!m?.sink) return
      switch (frame.kind) {
        case 'tap':
          if (frame.x !== undefined && frame.y !== undefined) {
            const { x, y } = frame
            perform(m, (mm) => tap(mm, x, y))
          }
          return
        case 'scroll':
          if (frame.x !== undefined && frame.y !== undefined && frame.dy !== undefined) {
            const { x, y, dy } = frame
            perform(m, (mm) => scroll(mm, x, y, dy))
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
            perform(m, (mm) => key(mm, name))
          }
          return
      }
    },

    release(viewer) {
      for (const m of mirrors.values()) if (m.sink?.viewer === viewer) idle(m)
    }
  }
}

/** Close every copy whose chat tab has gone. Called whenever the workspace may have changed. */
export function pruneChatMirrors(findChat: (leafId: string) => ChatLeaf | null): void {
  for (const m of [...mirrors.values()]) if (!findChat(m.leafId)) destroy(m)
}

/** Forge Web is stopping: close every copy. */
export function disposeChatMirrors(): void {
  for (const m of [...mirrors.values()]) destroy(m)
}

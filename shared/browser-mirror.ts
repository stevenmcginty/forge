/**
 * The desktop's Browser tabs (shared/browser.ts), seen and used from Forge Web
 * in a desktop browser (the deck face, web/src/deck/).
 *
 * The point is signing in from far away: every Browser tab shares one session
 * partition (BROWSER_PARTITION), so a login done here is a login for every tab
 * and every agent at home, and the site sees the home PC, not the laptop.
 *
 * Built like the chat mirror (shared/chat-mirror.ts): while a browser has a tab
 * on screen, the desktop keeps an offscreen copy of that tab's page, sized to
 * the browser's box, in the same partition, and streams a picture of it down
 * the link as JPEG frames. Clicks, scrolls, keys and text come back as
 * `browser:input`, performed on that offscreen copy and nowhere else — never
 * the OS pointer or keyboard, so nothing on the desktop screen is touched.
 *
 * Version one is a copy, not the desktop's own view: the copy opens at the
 * tab's current address and then lives its own life. Cookies and logins are
 * shared; scroll position and half-typed forms are not.
 *
 * Carried as JSON with the JPEG in base64, like `chat:frame`.
 *
 * No React, no Electron, no DOM: the server, the web client and the checks all
 * import it.
 */

/** The `hello-ok.features` entry that says this desktop serves its Browser tabs to a browser. */
export const BROWSER_MIRROR_FEATURE = 'browser-mirror'

/* ------------------------------------------------------------ browser → desk */

/** "Tell me which tabs exist, and keep telling me." Answered at once with `browser:tabs`. */
export interface BrowserSubscribeFrame {
  type: 'browser:subscribe'
}

/** Stop the `browser:tabs` pushes (the Browser view closed). */
export interface BrowserUnsubscribeFrame {
  type: 'browser:unsubscribe'
}

/**
 * "Show me this tab, at this size." Sent when the tab comes on screen, again
 * whenever its box changes size, and again after a reconnect. `width`/`height`
 * are the picture's box in CSS pixels, which become the offscreen page's own
 * CSS size; `dpr` is how sharp to draw it.
 */
export interface BrowserWatchFrame {
  type: 'browser:watch'
  tabId: string
  width: number
  height: number
  dpr: number
}

/** The tab left the screen. The desktop stops drawing it, and closes the copy after BROWSER_IDLE_MS. */
export interface BrowserUnwatchFrame {
  type: 'browser:unwatch'
  tabId: string
}

export type BrowserInputKind = 'click' | 'scroll' | 'text' | 'key'

/** Named keys a browser may press. A closed list, never a keycode. */
export const BROWSER_KEYS = [
  'Enter',
  'Backspace',
  'Delete',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space'
] as const
export type BrowserKey = (typeof BROWSER_KEYS)[number]

/** Single letters a key frame may carry, only with `ctrl` held (select all, undo, cut, copy). */
export const BROWSER_CTRL_LETTERS = ['a', 'c', 'x', 'z', 'y'] as const

export interface BrowserMods {
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
}

/**
 * One gesture on the tab's page. `x`/`y` are in the page's CSS pixels (the
 * frame's `width`/`height` space). `click` is a left click (`count` 2 = double);
 * `scroll` carries `dx`/`dy` as a mouse wheel would, positive = content moves
 * up/left (the page scrolls down/right). `text` is typed as-is (also paste);
 * `key` is one of BROWSER_KEYS, or a BROWSER_CTRL_LETTERS letter with ctrl.
 */
export interface BrowserInputFrame {
  type: 'browser:input'
  tabId: string
  kind: BrowserInputKind
  x?: number
  y?: number
  count?: number
  dx?: number
  dy?: number
  text?: string
  key?: string
  mods?: BrowserMods
}

export type BrowserNavAction = 'back' | 'forward' | 'reload' | 'stop' | 'go'

/** Address bar and arrows. Acts on the offscreen copy. `url` only with `go`. */
export interface BrowserNavFrame {
  type: 'browser:nav'
  tabId: string
  action: BrowserNavAction
  url?: string
}

/**
 * Open a new tab on the desktop (a real Browser tab, owned by "You", so it is
 * there at home too). `reqId` comes back in `browser:opened`.
 */
export interface BrowserOpenFrame {
  type: 'browser:open'
  reqId: string
  /** Project id the tab belongs to; '' = every project. */
  project: string
  url?: string
}

/** Close a desktop tab. The desktop refuses a tab an agent owns. */
export interface BrowserCloseFrame {
  type: 'browser:close'
  tabId: string
}

export type BrowserClientFrame =
  | BrowserSubscribeFrame
  | BrowserUnsubscribeFrame
  | BrowserWatchFrame
  | BrowserUnwatchFrame
  | BrowserInputFrame
  | BrowserNavFrame
  | BrowserOpenFrame
  | BrowserCloseFrame

export const BROWSER_CLIENT_TYPES: ReadonlyArray<BrowserClientFrame['type']> = [
  'browser:subscribe',
  'browser:unsubscribe',
  'browser:watch',
  'browser:unwatch',
  'browser:input',
  'browser:nav',
  'browser:open',
  'browser:close'
]

/* ------------------------------------------------------------ desk → browser */

/** One desktop Browser tab, as the tab strip shows it. */
export interface BrowserTabSummary {
  id: string
  /** Project id; '' = shown in every project. */
  project: string
  url: string
  title: string
  /** 'user' for tabs Steve owns, 'voice', or the pane id of the agent that owns it. */
  ownerId: string
  /** Words for the owner: "You", "Voice", a pane's name. */
  ownerLabel: string
  /** CLI exe name for an agent owner's logo; '' otherwise. */
  ownerAgent: string
}

/** The whole tab list. Sent on subscribe and again whenever a tab opens, closes, or changes address or title. */
export interface BrowserTabsFrame {
  type: 'browser:tabs'
  tabs: BrowserTabSummary[]
}

/**
 * One picture of the tab's copy. `seq` rises by one per frame for this watch;
 * `width`/`height` are the page's CSS size the picture shows, which is what a
 * click is mapped back onto — the desktop may have clamped the size asked for.
 */
export interface BrowserFrameFrame {
  type: 'browser:frame'
  tabId: string
  seq: number
  /** JPEG bytes, base64. */
  jpeg: string
  width: number
  height: number
}

export type BrowserCopyStatus = 'loading' | 'live' | 'error'

/** The copy's own state, for the address bar and the status words. */
export interface BrowserStateFrame {
  type: 'browser:state'
  tabId: string
  status: BrowserCopyStatus
  /** A sentence for the person at the browser, with `error`. */
  error?: string
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

/** Answer to `browser:open`: the new tab's id, or `error` in words. */
export interface BrowserOpenedFrame {
  type: 'browser:opened'
  reqId: string
  tabId?: string
  error?: string
}

export type BrowserServerFrame = BrowserTabsFrame | BrowserFrameFrame | BrowserStateFrame | BrowserOpenedFrame

/* ---------------------------------------------------------------- limits */

/** The offscreen page's CSS size is held inside these, whatever a browser asks. */
export const BROWSER_MIN_SIDE = 200
export const BROWSER_MAX_WIDTH = 1920
export const BROWSER_MAX_HEIGHT = 1600
export const BROWSER_MAX_DPR = 2
/** The longest text one `text` carries (a pasted password, an address). */
export const MAX_BROWSER_TEXT = 8000
/** The longest address `go` or `open` carries. */
export const MAX_BROWSER_URL = 4096
/** The largest wheel step one `scroll` carries, either way, in page CSS pixels. */
export const MAX_BROWSER_SCROLL = 4000
/** Offscreen tab copies alive at once, across every browser. */
export const MAX_BROWSER_MIRRORS = 3
/** How long an unwatched copy is kept for the same browser to come back to. */
export const BROWSER_IDLE_MS = 60_000

/* ---------------------------------------------------------------- reading */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** A non-empty string no longer than `max`, or null. */
function idOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/** Only the modifiers held, as `true`; undefined when none is. */
function modsOf(value: unknown): BrowserMods | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const mods: BrowserMods = {
    ...(v.shift === true ? { shift: true } : {}),
    ...(v.ctrl === true ? { ctrl: true } : {}),
    ...(v.alt === true ? { alt: true } : {})
  }
  return Object.keys(mods).length > 0 ? mods : undefined
}

const TAB_ID_MAX = 64
const REQ_ID_MAX = 64
const PROJECT_MAX = 128
const NAV_ACTIONS: readonly BrowserNavAction[] = ['back', 'forward', 'reload', 'stop', 'go']

function readInput(v: Record<string, unknown>, tabId: string): BrowserInputFrame | null {
  const mods = modsOf(v.mods)
  const withMods = mods ? { mods } : {}
  switch (v.kind) {
    case 'click': {
      const x = num(v.x)
      const y = num(v.y)
      if (x === null || y === null) return null
      const count = Math.round(clamp(num(v.count) ?? 1, 1, 3))
      return {
        type: 'browser:input',
        tabId,
        kind: 'click',
        x: Math.round(clamp(x, 0, BROWSER_MAX_WIDTH)),
        y: Math.round(clamp(y, 0, BROWSER_MAX_HEIGHT)),
        count,
        ...withMods
      }
    }
    case 'scroll': {
      const x = num(v.x)
      const y = num(v.y)
      if (x === null || y === null) return null
      const dx = Math.round(clamp(num(v.dx) ?? 0, -MAX_BROWSER_SCROLL, MAX_BROWSER_SCROLL))
      const dy = Math.round(clamp(num(v.dy) ?? 0, -MAX_BROWSER_SCROLL, MAX_BROWSER_SCROLL))
      if (dx === 0 && dy === 0) return null
      return {
        type: 'browser:input',
        tabId,
        kind: 'scroll',
        x: Math.round(clamp(x, 0, BROWSER_MAX_WIDTH)),
        y: Math.round(clamp(y, 0, BROWSER_MAX_HEIGHT)),
        dx,
        dy,
        ...withMods
      }
    }
    case 'text': {
      if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_BROWSER_TEXT) return null
      return { type: 'browser:input', tabId, kind: 'text', text: v.text }
    }
    case 'key': {
      if (typeof v.key !== 'string') return null
      const named = (BROWSER_KEYS as readonly string[]).includes(v.key)
      const letter = mods?.ctrl === true && (BROWSER_CTRL_LETTERS as readonly string[]).includes(v.key)
      if (!named && !letter) return null
      return { type: 'browser:input', tabId, kind: 'key', key: v.key, ...withMods }
    }
    default:
      return null
  }
}

/**
 * A `browser:*` frame off the wire, checked and clamped, or null for anything
 * malformed. Total: never throws. Strings are bounded, numbers finite and held
 * inside the limits above, keys from BROWSER_KEYS (or a BROWSER_CTRL_LETTERS
 * letter with ctrl held) only, addresses no longer than MAX_BROWSER_URL. What
 * an address may *be* (http, https) is the desktop's call, not this one's.
 */
export function readBrowserClientFrame(value: unknown): BrowserClientFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'browser:subscribe':
      return { type: 'browser:subscribe' }
    case 'browser:unsubscribe':
      return { type: 'browser:unsubscribe' }
    case 'browser:open': {
      const reqId = idOf(v.reqId, REQ_ID_MAX)
      if (!reqId) return null
      if (v.project !== undefined && (typeof v.project !== 'string' || v.project.length > PROJECT_MAX)) return null
      const project = typeof v.project === 'string' ? v.project : ''
      if (v.url !== undefined && (typeof v.url !== 'string' || v.url.length > MAX_BROWSER_URL)) return null
      const url = typeof v.url === 'string' && v.url.trim() ? v.url.trim() : undefined
      return { type: 'browser:open', reqId, project, ...(url ? { url } : {}) }
    }
    default:
      break
  }
  const tabId = idOf(v.tabId, TAB_ID_MAX)
  if (!tabId) return null
  switch (v.type) {
    case 'browser:watch': {
      const width = num(v.width)
      const height = num(v.height)
      const dpr = num(v.dpr) ?? 1
      if (width === null || height === null) return null
      return {
        type: 'browser:watch',
        tabId,
        width: Math.round(clamp(width, BROWSER_MIN_SIDE, BROWSER_MAX_WIDTH)),
        height: Math.round(clamp(height, BROWSER_MIN_SIDE, BROWSER_MAX_HEIGHT)),
        dpr: Math.round(clamp(dpr, 1, BROWSER_MAX_DPR) * 100) / 100
      }
    }
    case 'browser:unwatch':
      return { type: 'browser:unwatch', tabId }
    case 'browser:close':
      return { type: 'browser:close', tabId }
    case 'browser:input':
      return readInput(v, tabId)
    case 'browser:nav': {
      if (typeof v.action !== 'string' || !(NAV_ACTIONS as readonly string[]).includes(v.action)) return null
      const action = v.action as BrowserNavAction
      if (action !== 'go') return { type: 'browser:nav', tabId, action }
      if (typeof v.url !== 'string' || v.url.length > MAX_BROWSER_URL || !v.url.trim()) return null
      return { type: 'browser:nav', tabId, action, url: v.url.trim() }
    }
    default:
      return null
  }
}

/* ------------------------------------------------------------ server ↔ host */

/**
 * Where one watch's frames go: the socket that asked. `backlog` is that
 * socket's unsent bytes, so the desktop can skip frames rather than queue them
 * behind a slow tunnel. `who` is the browser's name, for the log line.
 */
export interface BrowserSink {
  /** The socket's identity (`web-N`), so a stale socket's close cannot end a newer socket's watch. */
  viewer: string
  who: string
  send: (frame: BrowserServerFrame) => void
  backlog: () => number
}

/**
 * What electron/web/server.ts asks of the desktop for its Browser tabs. One
 * copy per tab, shared by every socket watching it; input and nav are only
 * taken from a socket that is watching that tab.
 */
export interface BrowserMirrorHost {
  /** The tab list right now. */
  tabs: () => BrowserTabSummary[]
  /** Called with the whole list whenever it changes. Returns the unsubscribe. */
  onTabs: (listener: (tabs: BrowserTabSummary[]) => void) => () => void
  watch: (frame: BrowserWatchFrame, sink: BrowserSink) => void
  unwatch: (tabId: string, viewer: string) => void
  input: (frame: BrowserInputFrame, viewer: string) => void
  nav: (frame: BrowserNavFrame, viewer: string) => void
  /** Open a real tab owned by "You". Resolves to the `browser:opened` answer. */
  open: (frame: BrowserOpenFrame) => Promise<BrowserOpenedFrame>
  /** Close a tab Steve owns; an agent's or Voice's is left alone. */
  close: (tabId: string) => void
  /** A socket went: every watch it held starts its idle grace. */
  release: (viewer: string) => void
}

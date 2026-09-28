/**
 * A chat tab (shared/chatbots.ts), seen and used from Forge Web.
 *
 * The chat sites cannot be framed inside the page, and their sign-ins live in
 * the desktop's browser session, so a phone cannot load them itself. Instead,
 * while a phone has a chat tab on screen, the desktop keeps an offscreen copy
 * of that chat page sized to the phone's pane — so the site draws its own
 * mobile layout — in the same `persist:forge-browser` session (same account,
 * same conversations), and streams a picture of it down the link as JPEG
 * frames. Taps, scrolls and text come back as `chat:input`, which the desktop
 * performs on that offscreen page and nowhere else: never the OS pointer or
 * keyboard, so nothing on Steve's screen is touched. See
 * electron/chat-panes/phone-mirror.ts for the desktop half.
 *
 * Carried as JSON with the JPEG in base64, for the reason `mirror-frame` gives
 * in shared/web.ts: one wire format, one parser.
 *
 * No React, no Electron, no DOM: the server, the web client and
 * scripts/chat-mirror-check.mjs all import it.
 */

/** The `hello-ok.features` entry that says this desktop serves chat tabs to a browser. */
export const CHAT_MIRROR_FEATURE = 'chat-mirror'

/* ------------------------------------------------------------ browser → desk */

/**
 * "Show me this chat, at this size." Sent when the chat comes on screen, again
 * whenever its box changes size, and again after a reconnect. `width`/`height`
 * are the picture's box in CSS pixels, which become the offscreen page's own
 * CSS size; `dpr` is how sharp to draw it.
 */
export interface ChatWatchFrame {
  type: 'chat:watch'
  leafId: string
  width: number
  height: number
  dpr: number
}

/** The chat left the screen. The desktop stops drawing it, and closes it after CHAT_IDLE_MS. */
export interface ChatUnwatchFrame {
  type: 'chat:unwatch'
  leafId: string
}

export type ChatInputKind = 'tap' | 'scroll' | 'text' | 'key'

/** The keys a phone may press on a chat page. A closed list, never a keycode. */
export const CHAT_KEYS = [
  'Enter',
  'Backspace',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
] as const
export type ChatKey = (typeof CHAT_KEYS)[number]

/**
 * One gesture on the chat page. `x`/`y` are in the page's CSS pixels (see
 * `mapToPage`); `dy` is a scroll in page CSS pixels, positive when the finger
 * moved down (the page scrolls back towards its top).
 */
export interface ChatInputFrame {
  type: 'chat:input'
  leafId: string
  kind: ChatInputKind
  x?: number
  y?: number
  dy?: number
  text?: string
  key?: string
}

/** Put the caret in the chat site's own message box, ready for a `text`. */
export interface ChatFocusComposerFrame {
  type: 'chat:focusComposer'
  leafId: string
}

export type ChatClientFrame = ChatWatchFrame | ChatUnwatchFrame | ChatInputFrame | ChatFocusComposerFrame

export const CHAT_CLIENT_TYPES: ReadonlyArray<ChatClientFrame['type']> = [
  'chat:watch',
  'chat:unwatch',
  'chat:input',
  'chat:focusComposer'
]

/* ------------------------------------------------------------ desk → browser */

/**
 * One picture of the chat page. `seq` rises by one per frame for this watch;
 * `width`/`height` are the page's CSS size the picture shows, which is what a
 * tap is mapped back onto — the desktop may have clamped the size asked for.
 */
export interface ChatFrameFrame {
  type: 'chat:frame'
  leafId: string
  seq: number
  /** JPEG bytes, base64. */
  jpeg: string
  width: number
  height: number
}

export type ChatStatus = 'loading' | 'live' | 'error'

export interface ChatStateFrame {
  type: 'chat:state'
  leafId: string
  status: ChatStatus
  /** A sentence for the person holding the phone, with `error`. */
  error?: string
}

export type ChatServerFrame = ChatFrameFrame | ChatStateFrame

/* ---------------------------------------------------------------- limits */

/** The offscreen page's CSS size is held inside these, whatever a browser asks. */
export const CHAT_MIN_SIDE = 200
export const CHAT_MAX_WIDTH = 1600
export const CHAT_MAX_HEIGHT = 2400
export const CHAT_MAX_DPR = 2
/** The longest phrase one `text` carries. */
export const MAX_CHAT_TEXT = 8000
/** The largest scroll one `scroll` carries, either way, in page CSS pixels. */
export const MAX_CHAT_SCROLL = 4000
/** Offscreen chat copies alive at once, across every phone. */
export const MAX_CHAT_MIRRORS = 3
/** How long an unwatched copy is kept for the same phone to come back to. */
export const CHAT_IDLE_MS = 60_000

/* ---------------------------------------------------------------- reading */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function leafIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
}

/**
 * A `chat:*` frame off the wire, checked and clamped, or null for anything
 * malformed. Total: never throws. Strings are bounded, numbers finite and held
 * inside the limits above, keys from CHAT_KEYS only.
 */
export function readChatClientFrame(value: unknown): ChatClientFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const leafId = leafIdOf(v.leafId)
  if (!leafId) return null
  switch (v.type) {
    case 'chat:watch': {
      const width = num(v.width)
      const height = num(v.height)
      const dpr = num(v.dpr) ?? 1
      if (width === null || height === null) return null
      return {
        type: 'chat:watch',
        leafId,
        width: Math.round(clamp(width, CHAT_MIN_SIDE, CHAT_MAX_WIDTH)),
        height: Math.round(clamp(height, CHAT_MIN_SIDE, CHAT_MAX_HEIGHT)),
        dpr: Math.round(clamp(dpr, 1, CHAT_MAX_DPR) * 100) / 100
      }
    }
    case 'chat:unwatch':
      return { type: 'chat:unwatch', leafId }
    case 'chat:focusComposer':
      return { type: 'chat:focusComposer', leafId }
    case 'chat:input': {
      switch (v.kind) {
        case 'tap': {
          const x = num(v.x)
          const y = num(v.y)
          if (x === null || y === null) return null
          return {
            type: 'chat:input',
            leafId,
            kind: 'tap',
            x: Math.round(clamp(x, 0, CHAT_MAX_WIDTH)),
            y: Math.round(clamp(y, 0, CHAT_MAX_HEIGHT))
          }
        }
        case 'scroll': {
          const x = num(v.x)
          const y = num(v.y)
          const dy = num(v.dy)
          if (x === null || y === null || dy === null || dy === 0) return null
          return {
            type: 'chat:input',
            leafId,
            kind: 'scroll',
            x: Math.round(clamp(x, 0, CHAT_MAX_WIDTH)),
            y: Math.round(clamp(y, 0, CHAT_MAX_HEIGHT)),
            dy: Math.round(clamp(dy, -MAX_CHAT_SCROLL, MAX_CHAT_SCROLL))
          }
        }
        case 'text': {
          if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_CHAT_TEXT) return null
          return { type: 'chat:input', leafId, kind: 'text', text: v.text }
        }
        case 'key': {
          if (typeof v.key !== 'string' || !(CHAT_KEYS as readonly string[]).includes(v.key)) return null
          return { type: 'chat:input', leafId, kind: 'key', key: v.key }
        }
        default:
          return null
      }
    }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- mapping */

export interface Size {
  width: number
  height: number
}

/**
 * Where a point on the picture lands on the page.
 *
 * `point` is relative to the picture's box (CSS px), `box` is that box's size,
 * and `page` is the page's CSS size the picture shows. The picture is drawn
 * `object-fit: contain`, so when the two shapes differ it is letterboxed and
 * centred; a point in the bars is on no part of the page and maps to null.
 */
export function mapToPage(point: { x: number; y: number }, box: Size, page: Size): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return null
  const scale = Math.min(box.width / page.width, box.height / page.height)
  const offX = (box.width - page.width * scale) / 2
  const offY = (box.height - page.height * scale) / 2
  const x = (point.x - offX) / scale
  const y = (point.y - offY) / scale
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null
  return { x: Math.min(page.width - 1, Math.round(x)), y: Math.min(page.height - 1, Math.round(y)) }
}

/** A distance on the picture (a finger's travel) as page CSS pixels. */
export function scaleToPage(distance: number, box: Size, page: Size): number {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return 0
  const scale = Math.min(box.width / page.width, box.height / page.height)
  return Math.round(distance / scale)
}

/* ------------------------------------------------------------ server ↔ host */

/**
 * Where one watch's frames go: the socket that asked. `backlog` is that
 * socket's unsent bytes, so the desktop can skip frames rather than queue them
 * behind a slow tunnel.
 */
export interface ChatSink {
  /** The socket's identity (`web-N`), so a stale socket's close cannot end a newer socket's watch. */
  viewer: string
  send: (frame: ChatServerFrame) => void
  backlog: () => number
}

/**
 * What electron/web/server.ts asks of the desktop for chat tabs. `device` is
 * the admitted browser's own id, which survives a reconnect — so a phone that
 * drops and comes back inside CHAT_IDLE_MS picks its copy up again.
 */
export interface ChatMirrorHost {
  watch: (device: string, frame: ChatWatchFrame, sink: ChatSink) => void
  unwatch: (device: string, leafId: string, viewer: string) => void
  focusComposer: (device: string, leafId: string) => void
  input: (device: string, frame: ChatInputFrame) => void
  /** A socket went: every watch it held starts its idle grace. */
  release: (viewer: string) => void
}

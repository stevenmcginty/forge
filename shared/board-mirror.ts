/**
 * The desktop's Board (the canvas gallery agents fill with `show_on_board`;
 * electron/canvas-board.ts, shared/hub.ts), seen from Forge Web in a desktop
 * browser (the deck face, web/src/deck/).
 *
 * Read-only. A browser subscribes to one project's board and gets the item
 * list, pushed again whenever an item is added, removed, renamed or reordered.
 * To show an item it asks for the file with `board:get`, and the desktop sends
 * the bytes back in `board:chunk` frames (base64 JSON, like `chat:frame`).
 * HTML artifacts are shown in a sandboxed iframe with no same-origin, so an
 * agent's page can never reach Forge Web's sign-in.
 *
 * No React, no Electron, no DOM: the server, the web client and the checks all
 * import it.
 */

import type { CanvasKind } from './hub'

/** The `hello-ok.features` entry that says this desktop serves its Board to a browser. */
export const BOARD_MIRROR_FEATURE = 'board-mirror'

/* ------------------------------------------------------------ browser → desk */

/**
 * "Show me this project's board, and keep me told." Answered at once with
 * `board:items`. One project per browser: a new subscribe replaces the old one.
 */
export interface BoardSubscribeFrame {
  type: 'board:subscribe'
  project: string
}

/** Stop the `board:items` pushes (the Board view closed). */
export interface BoardUnsubscribeFrame {
  type: 'board:unsubscribe'
}

/** Send me this item's file. `name` must be an item on that project's board. */
export interface BoardGetFrame {
  type: 'board:get'
  reqId: string
  project: string
  name: string
}

/** Stop sending a file I no longer need. */
export interface BoardCancelFrame {
  type: 'board:cancel'
  reqId: string
}

export type BoardClientFrame = BoardSubscribeFrame | BoardUnsubscribeFrame | BoardGetFrame | BoardCancelFrame

export const BOARD_CLIENT_TYPES: ReadonlyArray<BoardClientFrame['type']> = [
  'board:subscribe',
  'board:unsubscribe',
  'board:get',
  'board:cancel'
]

/* ------------------------------------------------------------ desk → browser */

/** One board item, as the gallery shows it. */
export interface BoardItemSummary {
  /** The file's name in the project's canvas folder. Unique and stable; the key for `board:get`. */
  name: string
  title: string
  kind: CanvasKind
  mime: string
  bytes: number
  /** Last write, epoch ms. */
  mtime: number
  /** Position in the board's order (0 = first). */
  order: number
}

/** The whole board for one project. Sent on subscribe and on every change. */
export interface BoardItemsFrame {
  type: 'board:items'
  project: string
  items: BoardItemSummary[]
}

/**
 * One piece of a file asked for with `board:get`. `seq` starts at 0; the first
 * piece carries `mime` and `total` (bytes). `done` is set on the last piece.
 */
export interface BoardChunkFrame {
  type: 'board:chunk'
  reqId: string
  seq: number
  /** Bytes, base64. */
  data: string
  done: boolean
  mime?: string
  total?: number
}

/** A `board:get` that cannot be served, in words for the person at the browser. */
export interface BoardErrorFrame {
  type: 'board:error'
  reqId: string
  error: string
}

export type BoardServerFrame = BoardItemsFrame | BoardChunkFrame | BoardErrorFrame

/* ---------------------------------------------------------------- limits */

/** Raw bytes per `board:chunk` (before base64). */
export const BOARD_CHUNK_BYTES = 256 * 1024
/** The largest file a browser may fetch. Bigger ones say "Open it on the desktop". */
export const BOARD_MAX_FETCH_BYTES = 50 * 1024 * 1024
/** Files being sent at once per browser; more wait their turn. */
export const BOARD_MAX_PARALLEL_GETS = 2
export const MAX_BOARD_NAME = 256
export const MAX_BOARD_PROJECT = 128
export const MAX_BOARD_REQ_ID = 64

/* ---------------------------------------------------------------- reading */

/** A non-empty string no longer than `max`, or null. */
function idOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/**
 * A `board:*` frame off the wire, checked, or null for anything malformed.
 * Total: never throws. Strings are non-empty and bounded by the MAX_* limits.
 * Whether `name` is really an item on that board is the desktop's call, not
 * this one's: it is looked up in the board's own list, never used as a path.
 */
export function readBoardClientFrame(value: unknown): BoardClientFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'board:subscribe': {
      const project = idOf(v.project, MAX_BOARD_PROJECT)
      return project ? { type: 'board:subscribe', project } : null
    }
    case 'board:unsubscribe':
      return { type: 'board:unsubscribe' }
    case 'board:get': {
      const reqId = idOf(v.reqId, MAX_BOARD_REQ_ID)
      const project = idOf(v.project, MAX_BOARD_PROJECT)
      const name = idOf(v.name, MAX_BOARD_NAME)
      return reqId && project && name ? { type: 'board:get', reqId, project, name } : null
    }
    case 'board:cancel': {
      const reqId = idOf(v.reqId, MAX_BOARD_REQ_ID)
      return reqId ? { type: 'board:cancel', reqId } : null
    }
    default:
      return null
  }
}

/* ------------------------------------------------------------ server ↔ host */

/** One board item's file, opened for reading in pieces. */
export interface BoardFileHandle {
  mime: string
  /** Size in bytes when it was opened. */
  total: number
  /** Up to `length` bytes from `offset`; fewer (or none) at the end of the file. */
  read: (offset: number, length: number) => Promise<Uint8Array>
  close: () => void
}

/**
 * What electron/web/server.ts asks of the desktop for its Board. Read-only:
 * nothing here adds, removes or moves an item.
 */
export interface BoardMirrorHost {
  /** One project's board right now (empty when it has none). */
  items: (project: string) => BoardItemSummary[]
  /** Called with the whole list whenever that project's board changes. Returns the unsubscribe. */
  onItems: (project: string, listener: (items: BoardItemSummary[]) => void) => () => void
  /** Open the file of the item called `name` on that board, or null when there is no such item. */
  open: (project: string, name: string) => Promise<BoardFileHandle | null>
}

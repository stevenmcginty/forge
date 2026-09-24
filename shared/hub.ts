/**
 * The hub's small backends, as the renderer and the main process both see
 * them: the canvas board and saved prompts (plus the keymap's on-disk shape).
 *
 * Everything here is data and pure functions — no fs, no DOM — so the same
 * rules run in electron/hub-store.ts, in the renderer, and in
 * scripts/canvas-check.mjs. None of it is part of the wire layout types in
 * shared/types.ts. A terminal's name is not here either: it is its tab's name
 * (shared/terminal-names.ts), which lives in the layout itself.
 */

/* ------------------------------------------------------------------ IPC */

/** Channel names. Kept here rather than in shared/ipc.ts so this feature is one import. */
export const HUB_IPC = {
  canvasList: 'hub:canvas:list',
  canvasChanged: 'hub:canvas:changed',
  canvasPost: 'hub:canvas:post',
  canvasRemove: 'hub:canvas:remove',
  canvasLayout: 'hub:canvas:layout',
  canvasRead: 'hub:canvas:read',
  canvasReveal: 'hub:canvas:reveal',
  canvasActive: 'hub:canvas:active',
  promptsList: 'hub:prompts:list',
  promptsSave: 'hub:prompts:save',
  promptsDelete: 'hub:prompts:delete',
  promptsChanged: 'hub:prompts:changed',
  keymapGet: 'hub:keymap:get',
  keymapSet: 'hub:keymap:set'
} as const

/** The pane environment variable every CLI can save files into. */
export const CANVAS_DIR_ENV = 'FORGE_CANVAS_DIR'

/* --------------------------------------------------------------- canvas */

export type CanvasKind = 'image' | 'video' | 'text' | 'html'

const CANVAS_EXT: Record<string, { kind: CanvasKind; mime: string }> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.md': { kind: 'text', mime: 'text/markdown' },
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.html': { kind: 'html', mime: 'text/html' }
}

/** What a file on the board is, by extension. Null = not board material (ignored). */
export function canvasKindOf(name: string): { kind: CanvasKind; mime: string } | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return CANVAS_EXT[name.slice(dot).toLowerCase()] ?? null
}

/** Where an item sits on the board. Absent = the board lays it out itself. */
export interface CanvasPlacement {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasItem {
  /** The file's name inside the project's canvas folder. Unique and stable. */
  id: string
  name: string
  /** Absolute path on disk. */
  path: string
  kind: CanvasKind
  mime: string
  bytes: number
  /** Last write, epoch ms. */
  mtime: number
  /** A title given by whoever posted it; else the file name without extension. */
  title: string
  /** Position in the board's order (0 = first). */
  order: number
  placement?: CanvasPlacement
}

export interface CanvasSnapshot {
  projectId: string
  /** The folder a CLI saves into (also `FORGE_CANVAS_DIR` in that project's panes). */
  dir: string
  items: CanvasItem[]
}

/** One push from main: what changed, plus the whole board after the change. */
export interface CanvasChange {
  projectId: string
  added: string[]
  removed: string[]
  changed: string[]
  snapshot: CanvasSnapshot
}

/** Saved beside the folder (`<dataDir>/canvas/<projectId>.board.json`). */
export interface CanvasBoardFile {
  version: 1
  order: string[]
  titles: Record<string, string>
  placements: Record<string, CanvasPlacement>
}

export interface CanvasLayoutPatch {
  /** New full order (ids not listed keep their relative order at the end). */
  order?: string[]
  placements?: Record<string, CanvasPlacement | null>
  titles?: Record<string, string | null>
}

/* -------------------------------------------------------- saved prompts */

export type SavedPromptTarget = 'active-pane' | 'composer'

export interface SavedPrompt {
  id: string
  title: string
  text: string
  /** A keymap combo ("Ctrl+Alt+P" style — see src/lib/keymap.ts). */
  hotkey?: string
  target: SavedPromptTarget
  /** Press Enter after typing it into the pane. Off unless asked for — the last look is Steve's. */
  submit?: boolean
  createdAt: number
  updatedAt: number
}

/** What a caller hands `save`: no id = a new prompt. */
export interface SavedPromptInput {
  id?: string
  title: string
  text: string
  hotkey?: string | null
  target?: SavedPromptTarget
  submit?: boolean
}

export const PROMPT_TITLE_MAX = 80
export const PROMPT_TEXT_MAX = 20000

/** Validate and normalise one prompt. `now`/`newId` are injected so tests are exact. */
export function normalisePrompt(
  input: SavedPromptInput,
  existing: SavedPrompt | undefined,
  now: number,
  newId: () => string
): { ok: true; prompt: SavedPrompt } | { ok: false; error: string } {
  const title = String(input?.title ?? '').trim()
  const text = String(input?.text ?? '')
  if (!title) return { ok: false, error: 'A saved prompt needs a title.' }
  if (title.length > PROMPT_TITLE_MAX) return { ok: false, error: `Keep the title under ${PROMPT_TITLE_MAX} characters.` }
  if (!text.trim()) return { ok: false, error: 'A saved prompt needs some text.' }
  if (text.length > PROMPT_TEXT_MAX) return { ok: false, error: `That prompt is longer than ${PROMPT_TEXT_MAX} characters.` }
  const target: SavedPromptTarget = input?.target === 'composer' ? 'composer' : 'active-pane'
  const hotkey = typeof input?.hotkey === 'string' && input.hotkey.trim() ? input.hotkey.trim() : undefined
  const prompt: SavedPrompt = {
    id: existing?.id ?? (input?.id && String(input.id).trim() ? String(input.id).trim() : newId()),
    title,
    text,
    target,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(hotkey ? { hotkey } : {}),
    ...(input?.submit ? { submit: true } : {})
  }
  return { ok: true, prompt }
}

/* --------------------------------------------------------------- keymap */

/** keymap.json. `overrides[id]` replaces that command's default keys; [] = unbound. */
export interface KeymapFile {
  version: 1
  overrides: Record<string, string[]>
}

/* ------------------------------------------------------ preload surface */

/** `window.forgeHub` — see electron/hub-preload.ts. Every member may be missing on a stale preload. */
export interface HubApi {
  canvas: {
    list(projectId: string): Promise<CanvasSnapshot>
    post(projectId: string, path: string, title?: string): Promise<{ ok: true; item: CanvasItem } | { ok: false; error: string }>
    remove(projectId: string, id: string): Promise<boolean>
    layout(projectId: string, patch: CanvasLayoutPatch): Promise<CanvasSnapshot>
    /** The file's bytes (≤ 256 MB) for a blob URL, or null. */
    read(projectId: string, id: string): Promise<{ mime: string; bytes: Uint8Array } | null>
    reveal(projectId: string): Promise<void>
    /** Which project new bridge-out media is posted to. */
    setActive(projectId: string | null): Promise<void>
    onChanged(cb: (change: CanvasChange) => void): () => void
  }
  prompts: {
    list(): Promise<SavedPrompt[]>
    save(input: SavedPromptInput): Promise<{ ok: true; prompt: SavedPrompt; prompts: SavedPrompt[] } | { ok: false; error: string }>
    remove(id: string): Promise<SavedPrompt[]>
    onChanged(cb: (prompts: SavedPrompt[]) => void): () => void
  }
  keymap: {
    get(): Promise<KeymapFile>
    set(file: KeymapFile): Promise<KeymapFile>
  }
}

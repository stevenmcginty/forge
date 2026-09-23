import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  canvasKindOf,
  type CanvasBoardFile,
  type CanvasChange,
  type CanvasItem,
  type CanvasLayoutPatch,
  type CanvasPlacement,
  type CanvasSnapshot
} from '@shared/hub'
import { safeId } from './hub-store'

/**
 * The canvas board: one folder per project under `<dataDir>/canvas/`, and
 * whatever image, clip or note lands in it shows up on the board.
 *
 *   <dataDir>/canvas/<projectId>/            the files (FORGE_CANVAS_DIR in panes)
 *   <dataDir>/canvas/<projectId>.board.json  order, titles, placements
 *
 * The folder is the API. Every CLI Forge runs — Claude, Codex, Gemini, a bare
 * PowerShell — can save a file, and none of them has to know anything else;
 * `FORGE_CANVAS_DIR` tells them where. The board file sits *beside* the folder,
 * not in it, so an agent listing the folder sees only what agents put there.
 * Nothing is ever written into a user's project folder.
 *
 * One recursive watcher on the root covers every project. Events are debounced
 * per project and answered with a rescan, and the rescan's diff is what goes to
 * the renderer — fs.watch's own event names are too unreliable (a save is often
 * rename+change+change) to be passed on as they come.
 *
 * No `electron` import: scripts/canvas-check.mjs drives this against a temp dir.
 */

const DEFAULT_DEBOUNCE_MS = 250
export const CANVAS_POST_MAX_BYTES = 512 * 1024 * 1024
export const CANVAS_READ_MAX_BYTES = 256 * 1024 * 1024

interface ScanEntry {
  bytes: number
  mtime: number
}

export interface CanvasBoardOptions {
  root: string
  debounceMs?: number
  onChange?: (change: CanvasChange) => void
}

export class CanvasBoard {
  readonly root: string
  private readonly debounceMs: number
  private readonly onChange: (change: CanvasChange) => void
  private readonly seen = new Map<string, Map<string, ScanEntry>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private watcher: FSWatcher | null = null

  constructor(opts: CanvasBoardOptions) {
    this.root = resolve(opts.root)
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.onChange = opts.onChange ?? (() => {})
    mkdirSync(this.root, { recursive: true })
  }

  /** The project's folder, created on demand. */
  dirFor(projectId: string): string {
    const dir = join(this.root, safeId(projectId))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** The whole board, read fresh off disk (and remembered as the baseline for the next diff). */
  list(projectId: string): CanvasSnapshot {
    const entries = this.scan(projectId)
    this.seen.set(safeId(projectId), entries)
    return this.snapshot(projectId, entries)
  }

  /** Re-read one project's folder and push the difference, if there is one. */
  rescan(projectId: string): CanvasChange | null {
    const key = safeId(projectId)
    const before = this.seen.get(key) ?? new Map<string, ScanEntry>()
    const after = this.scan(projectId)
    this.seen.set(key, after)
    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []
    for (const [id, e] of after) {
      const was = before.get(id)
      if (!was) added.push(id)
      else if (was.bytes !== e.bytes || was.mtime !== e.mtime) changed.push(id)
    }
    for (const id of before.keys()) if (!after.has(id)) removed.push(id)
    if (!added.length && !removed.length && !changed.length) return null
    const change: CanvasChange = { projectId: key, added, removed, changed, snapshot: this.snapshot(projectId, after) }
    this.emit(change)
    return change
  }

  /** Copy a file onto the board. The original is never touched. */
  post(projectId: string, srcPath: string, title?: string): { ok: true; item: CanvasItem } | { ok: false; error: string } {
    const src = resolve(String(srcPath ?? '').trim())
    if (!srcPath || !existsSync(src)) return { ok: false, error: `There is no file at ${srcPath}.` }
    let size = 0
    try {
      const st = statSync(src)
      if (!st.isFile()) return { ok: false, error: `${srcPath} is a folder, not a file.` }
      size = st.size
    } catch (err) {
      return { ok: false, error: `Cannot read ${srcPath}: ${(err as Error).message}` }
    }
    const kind = canvasKindOf(src)
    if (!kind) {
      return { ok: false, error: `The board shows images (png/jpg/webp/gif/svg), clips (mp4/webm) and notes (md/txt/html) — not ${extname(src) || 'that file'}.` }
    }
    if (size > CANVAS_POST_MAX_BYTES) return { ok: false, error: 'That file is over 512 MB — too big for the board.' }

    const dir = this.dirFor(projectId)
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 120) : ''
    // Already on this board (an agent saved it straight into the folder): just title it.
    const inside = resolve(join(src, '..')) === resolve(dir)
    let id = basename(src)
    if (!inside) {
      const stem = cleanTitle ? slug(cleanTitle) : basename(src, extname(src))
      id = freshName(dir, stem || 'canvas-item', extname(src).toLowerCase())
      const target = join(dir, id)
      const tmp = join(dir, `.${id}.tmp`)
      try {
        copyFileSync(src, tmp)
        renameSync(tmp, target)
      } catch (err) {
        try {
          unlinkSync(tmp)
        } catch {
          /* nothing to clean */
        }
        return { ok: false, error: `Could not copy it onto the board: ${(err as Error).message}` }
      }
    }
    if (cleanTitle) {
      const board = this.readBoard(projectId)
      board.titles[id] = cleanTitle
      this.writeBoard(projectId, board)
    }
    this.rescan(projectId)
    const item = this.list(projectId).items.find((i) => i.id === id)
    return item ? { ok: true, item } : { ok: false, error: 'The copy vanished before it could be listed.' }
  }

  remove(projectId: string, id: string): boolean {
    const path = this.itemPath(projectId, id)
    if (!path || !existsSync(path)) return false
    try {
      unlinkSync(path)
    } catch (err) {
      console.error('[canvas] remove failed', err)
      return false
    }
    this.rescan(projectId)
    return true
  }

  layout(projectId: string, patch: CanvasLayoutPatch): CanvasSnapshot {
    const board = this.readBoard(projectId)
    if (Array.isArray(patch?.order)) board.order = patch.order.filter((id) => typeof id === 'string')
    for (const [id, p] of Object.entries(patch?.placements ?? {})) {
      if (p === null) delete board.placements[id]
      else if (validPlacement(p)) board.placements[id] = { x: p.x, y: p.y, w: p.w, h: p.h }
    }
    for (const [id, t] of Object.entries(patch?.titles ?? {})) {
      if (t === null || !String(t).trim()) delete board.titles[id]
      else board.titles[id] = String(t).trim().slice(0, 120)
    }
    // Forget what belongs to files that are gone, so the board file cannot grow forever.
    const present = new Set(this.scan(projectId).keys())
    board.order = board.order.filter((id) => present.has(id))
    for (const id of Object.keys(board.placements)) if (!present.has(id)) delete board.placements[id]
    for (const id of Object.keys(board.titles)) if (!present.has(id)) delete board.titles[id]
    this.writeBoard(projectId, board)
    const snapshot = this.list(projectId)
    this.emit({ projectId: safeId(projectId), added: [], removed: [], changed: [], snapshot })
    return snapshot
  }

  read(projectId: string, id: string): { mime: string; bytes: Uint8Array } | null {
    const path = this.itemPath(projectId, id)
    const kind = canvasKindOf(id)
    if (!path || !kind || !existsSync(path)) return null
    try {
      if (statSync(path).size > CANVAS_READ_MAX_BYTES) return null
      return { mime: kind.mime, bytes: new Uint8Array(readFileSync(path)) }
    } catch {
      return null
    }
  }

  /**
   * Is a file with exactly these bytes already on any project's board?
   * Size first, hash only on a size match — the bridge-out watcher asks this
   * about every new image, and almost every answer is settled by the size.
   */
  hasContent(path: string): boolean {
    let size = -1
    try {
      size = statSync(path).size
    } catch {
      return false
    }
    let hash: string | null = null
    for (const project of safeReaddir(this.root)) {
      const dir = join(this.root, project)
      for (const name of safeReaddir(dir)) {
        if (!canvasKindOf(name)) continue
        const candidate = join(dir, name)
        try {
          if (statSync(candidate).size !== size) continue
          hash ??= sha1(path)
          if (sha1(candidate) === hash) return true
        } catch {
          /* raced with a delete */
        }
      }
    }
    return false
  }

  /* ------------------------------------------------------------ watching */

  watch(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        const rel = filename ? String(filename) : ''
        const project = rel.split(/[\\/]/)[0] ?? ''
        if (!project || project.endsWith('.json') || project.endsWith('.tmp')) return
        this.schedule(project)
      })
      this.watcher.on('error', (err) => console.error('[canvas] watcher error', err))
    } catch (err) {
      console.error('[canvas] cannot watch', this.root, err)
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private schedule(project: string): void {
    const existing = this.timers.get(project)
    if (existing) clearTimeout(existing)
    this.timers.set(
      project,
      setTimeout(() => {
        this.timers.delete(project)
        try {
          this.rescan(project)
        } catch (err) {
          console.error('[canvas] rescan failed', err)
        }
      }, this.debounceMs)
    )
  }

  /* ---------------------------------------------------------- internals */

  private emit(change: CanvasChange): void {
    try {
      this.onChange(change)
    } catch (err) {
      console.error('[canvas] change listener threw', err)
    }
  }

  private scan(projectId: string): Map<string, ScanEntry> {
    const dir = join(this.root, safeId(projectId))
    const out = new Map<string, ScanEntry>()
    for (const name of safeReaddir(dir)) {
      if (name.startsWith('.') || name.startsWith('~') || !canvasKindOf(name)) continue
      try {
        const st = statSync(join(dir, name))
        if (st.isFile()) out.set(name, { bytes: st.size, mtime: Math.round(st.mtimeMs) })
      } catch {
        /* raced with a delete */
      }
    }
    return out
  }

  private snapshot(projectId: string, entries: Map<string, ScanEntry>): CanvasSnapshot {
    const board = this.readBoard(projectId)
    const dir = join(this.root, safeId(projectId))
    const known = board.order.filter((id) => entries.has(id))
    const knownSet = new Set(known)
    const rest = [...entries.keys()]
      .filter((id) => !knownSet.has(id))
      .sort((a, b) => entries.get(a)!.mtime - entries.get(b)!.mtime || a.localeCompare(b))
    const items = [...known, ...rest].map((id, order): CanvasItem => {
      const e = entries.get(id)!
      const kind = canvasKindOf(id)!
      const placement = board.placements[id]
      return {
        id,
        name: id,
        path: join(dir, id),
        kind: kind.kind,
        mime: kind.mime,
        bytes: e.bytes,
        mtime: e.mtime,
        title: board.titles[id] ?? basename(id, extname(id)),
        order,
        ...(placement ? { placement } : {})
      }
    })
    return { projectId: safeId(projectId), dir, items }
  }

  private boardPath(projectId: string): string {
    return join(this.root, `${safeId(projectId)}.board.json`)
  }

  private readBoard(projectId: string): CanvasBoardFile {
    const empty: CanvasBoardFile = { version: 1, order: [], titles: {}, placements: {} }
    const p = this.boardPath(projectId)
    if (!existsSync(p)) return empty
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<CanvasBoardFile>
      return {
        version: 1,
        order: Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === 'string') : [],
        titles: raw.titles && typeof raw.titles === 'object' ? { ...raw.titles } : {},
        placements: raw.placements && typeof raw.placements === 'object' ? { ...raw.placements } : {}
      }
    } catch {
      return empty
    }
  }

  private writeBoard(projectId: string, board: CanvasBoardFile): void {
    const p = this.boardPath(projectId)
    const tmp = `${p}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8')
      renameSync(tmp, p)
    } catch (err) {
      console.error('[canvas] could not save the board layout', err)
    }
  }

  /** The item's path, or null for anything that is not a plain name inside the folder. */
  private itemPath(projectId: string, id: string): string | null {
    const name = String(id ?? '')
    if (!name || name !== basename(name) || name === '.' || name === '..' || name.includes(sep)) return null
    return join(this.root, safeId(projectId), name)
  }
}

/* ------------------------------------------------------ bridge-out feed */

/**
 * Media the forge-bridge makes outside a pane — the voice agent's own
 * make_image/edit_image/make_video land in `<dataDir>/bridge-out` — is posted
 * to the board of whichever project is open.
 *
 * A pane's bridge already copies its media straight into its own project's
 * folder (it inherits FORGE_CANVAS_DIR), and those files also land in
 * bridge-out. `hasContent` is what stops them being posted a second time,
 * possibly to the wrong project: anything already on any board is skipped.
 * Files present when the watcher starts are history, not news, and are left be.
 */
export class BridgeOutFeed {
  private watcher: FSWatcher | null = null
  private readonly baseline = new Set<string>()
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly dir: string
  private readonly board: CanvasBoard
  private readonly activeProject: () => string | null
  private readonly settleMs: number

  constructor(opts: { dir: string; board: CanvasBoard; activeProject: () => string | null; settleMs?: number }) {
    this.dir = resolve(opts.dir)
    this.board = opts.board
    this.activeProject = opts.activeProject
    this.settleMs = opts.settleMs ?? 1500
  }

  start(): void {
    if (this.watcher) return
    mkdirSync(this.dir, { recursive: true })
    for (const name of safeReaddir(this.dir)) this.baseline.add(name)
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        const name = filename ? String(filename) : ''
        if (!name || this.baseline.has(name) || !canvasKindOf(name) || canvasKindOf(name)?.kind === 'text') return
        this.consider(name)
      })
      this.watcher.on('error', (err) => console.error('[canvas] bridge-out watcher error', err))
    } catch (err) {
      console.error('[canvas] cannot watch bridge-out', err)
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }

  /** Wait for the file to stop growing, then post it once. Exposed for the check script. */
  consider(name: string, lastSize = -1): void {
    const existing = this.pending.get(name)
    if (existing) clearTimeout(existing)
    this.pending.set(
      name,
      setTimeout(() => {
        this.pending.delete(name)
        const path = join(this.dir, name)
        let size = -1
        try {
          size = statSync(path).size
        } catch {
          return // gone again (a tmp that was renamed)
        }
        if (size !== lastSize) {
          this.consider(name, size)
          return
        }
        this.baseline.add(name)
        const project = this.activeProject()
        if (!project || this.board.hasContent(path)) return
        const result = this.board.post(project, path)
        if (!result.ok) console.error('[canvas] could not post', name, result.error)
      }, this.settleMs)
    )
  }
}

/* ------------------------------------------------------------- helpers */

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function sha1(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

function slug(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
}

function freshName(dir: string, stem: string, ext: string): string {
  let name = `${stem}${ext}`
  let n = 2
  while (existsSync(join(dir, name))) {
    name = `${stem} -${n}${ext}`
    n += 1
  }
  return name
}

function validPlacement(p: unknown): p is CanvasPlacement {
  const q = p as CanvasPlacement
  return Boolean(q) && [q.x, q.y, q.w, q.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && q.w > 0 && q.h > 0
}

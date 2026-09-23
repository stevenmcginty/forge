import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BROWSER_DEFAULT_RECT,
  BROWSER_SURFACES_FILE,
  isBrowserTabId,
  type BrowserOwner,
  type BrowserRect,
  type BrowserSurfaceRecord,
  type BrowserSurfacesFile
} from '@shared/browser'

/**
 * The browser surfaces that outlive a restart: URL, title, owner and canvas
 * position, per project, in `<dir>\surfaces.json`.
 *
 * Plain Node, no Electron import, and the directory is a constructor argument —
 * so scripts/browser-check.mjs drives this exact class for the persistence
 * round trip. Writes are tmp-then-rename, debounced by the caller only in the
 * sense that every mutation writes once; the file is a few KB at most.
 *
 * A damaged file is not fatal: it reads as empty, and is left on disk untouched
 * until the next mutation replaces it, so a hand-edit gone wrong costs the
 * surfaces and nothing else.
 */

const EMPTY: BrowserSurfacesFile = { v: 1, nextId: 1, surfaces: [] }

function finite(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function cleanRect(raw: unknown): BrowserRect {
  const r = (raw ?? {}) as Partial<BrowserRect>
  return {
    x: finite(r.x, BROWSER_DEFAULT_RECT.x),
    y: finite(r.y, BROWSER_DEFAULT_RECT.y),
    w: Math.max(240, finite(r.w, BROWSER_DEFAULT_RECT.w)),
    h: Math.max(160, finite(r.h, BROWSER_DEFAULT_RECT.h))
  }
}

function cleanOwner(raw: unknown): BrowserOwner {
  const o = (raw ?? {}) as Partial<BrowserOwner>
  return {
    id: String(o.id ?? 'user').slice(0, 128) || 'user',
    label: String(o.label ?? '').slice(0, 60),
    agent: String(o.agent ?? '').slice(0, 40)
  }
}

/** One record from disk, or null when it is not one. */
export function cleanRecord(raw: unknown): BrowserSurfaceRecord | null {
  const r = (raw ?? {}) as Partial<BrowserSurfaceRecord>
  if (!isBrowserTabId(r.id)) return null
  const now = Date.now()
  return {
    id: r.id,
    project: String(r.project ?? ''),
    url: String(r.url ?? 'about:blank') || 'about:blank',
    title: String(r.title ?? '').slice(0, 300),
    owner: cleanOwner(r.owner),
    rect: cleanRect(r.rect),
    createdAt: finite(r.createdAt, now),
    updatedAt: finite(r.updatedAt, now)
  }
}

/** Parse the file's text. Anything unreadable is an empty list, never a throw. */
export function parseSurfacesFile(text: string | null): BrowserSurfacesFile {
  if (!text) return { ...EMPTY, surfaces: [] }
  let raw: Partial<BrowserSurfacesFile>
  try {
    raw = JSON.parse(text) as Partial<BrowserSurfacesFile>
  } catch {
    return { ...EMPTY, surfaces: [] }
  }
  const surfaces: BrowserSurfaceRecord[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw?.surfaces) ? raw.surfaces : []) {
    const rec = cleanRecord(item)
    if (!rec || seen.has(rec.id)) continue
    seen.add(rec.id)
    surfaces.push(rec)
  }
  // nextId never goes backwards past an id already on disk, so a restored tab
  // and a new one cannot share an id.
  const highest = surfaces.reduce((max, s) => Math.max(max, Number(s.id.slice(1))), 0)
  return { v: 1, nextId: Math.max(finite(raw?.nextId, 1), highest + 1), surfaces }
}

export class BrowserSurfaceStore {
  private readonly file: string
  private data: BrowserSurfacesFile

  constructor(dir: string) {
    this.file = join(dir, BROWSER_SURFACES_FILE)
    mkdirSync(dir, { recursive: true })
    this.data = parseSurfacesFile(existsSync(this.file) ? readFileSync(this.file, 'utf8') : null)
  }

  all(): BrowserSurfaceRecord[] {
    return this.data.surfaces.map((s) => ({ ...s, owner: { ...s.owner }, rect: { ...s.rect } }))
  }

  get(id: string): BrowserSurfaceRecord | null {
    const found = this.data.surfaces.find((s) => s.id === id)
    return found ? { ...found, owner: { ...found.owner }, rect: { ...found.rect } } : null
  }

  /** Mint the next id. Persisted with the next write, so ids never repeat. */
  nextId(): string {
    const id = `b${this.data.nextId}`
    this.data.nextId += 1
    return id
  }

  put(record: BrowserSurfaceRecord): void {
    const clean = cleanRecord(record)
    if (!clean) return
    const at = this.data.surfaces.findIndex((s) => s.id === clean.id)
    if (at === -1) this.data.surfaces.push(clean)
    else this.data.surfaces[at] = clean
    this.save()
  }

  patch(id: string, patch: Partial<Pick<BrowserSurfaceRecord, 'url' | 'title' | 'rect' | 'owner' | 'project'>>): boolean {
    const current = this.data.surfaces.find((s) => s.id === id)
    if (!current) return false
    this.put({ ...current, ...patch, updatedAt: Date.now() })
    return true
  }

  remove(id: string): boolean {
    const before = this.data.surfaces.length
    this.data.surfaces = this.data.surfaces.filter((s) => s.id !== id)
    if (this.data.surfaces.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[browser] could not save surfaces:', err)
    }
  }
}

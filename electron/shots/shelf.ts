import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

/**
 * The shots shelf — %APPDATA%\Forge\shots as a newest-first, self-pruning
 * folder of real PNG files.
 *
 * Behaviour is lifted from DictationMic's shots.py: every screenshot you take
 * and every image you copy is kept as a real file, newest few only, and the
 * same clipboard content is never caught twice.
 *
 * Deliberately free of any Electron import so scripts/shots-smoke.mjs can
 * drive it head-less — everything here is disk and bytes. The clipboard poller
 * that feeds it lives in electron/shots-watcher.ts.
 */

export const SHOT_EXTS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
export const DEFAULT_KEEP = 12
export const MIN_KEEP = 1
export const MAX_KEEP = 60

/** How many of Forge's own clipboard writes we remember and refuse to re-catch. */
const SUPPRESS_RING = 8

export interface ShotRecord {
  /** The file name — stable identity for React keys and delete calls. */
  id: string
  name: string
  path: string
  createdAt: number
  bytes: number
}

export type PinRejection = 'duplicate' | 'unsupported' | 'empty' | 'error'

export type PinResult = { ok: true; record: ShotRecord; pruned: string[] } | { ok: false; reason: PinRejection }

export function clampKeep(keep: number | undefined): number {
  const n = Math.round(Number(keep))
  if (!Number.isFinite(n)) return DEFAULT_KEEP
  return Math.min(MAX_KEEP, Math.max(MIN_KEEP, n))
}

/**
 * `shot-YYYYMMDD-HHMMSS` — sorts chronologically as text, reads as a date, and
 * is safe on every filesystem.
 */
export function shotStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `shot-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * Content identity for a caught image. Fed the *decoded bitmap* (plus its
 * dimensions) rather than an encoded file, so two encodings of the same pixels
 * are recognised as the same shot. sha1 over a 14 MB bitmap measures ~8ms,
 * which a 700ms poll can well afford — an exact hash beats a cheap approximate
 * one here, because a missed difference means a screenshot silently not caught.
 */
export function contentHash(meta: string, bytes: Uint8Array): string {
  return createHash('sha1').update(meta).update('|').update(bytes).digest('hex')
}

/**
 * Keep an adopted file's own name (it is how you recognise it in the tray) but
 * allow only characters that are safe everywhere, and keep it short.
 */
export function sanitiseStem(stem: string): string {
  const cleaned = stem
    .replace(/[^A-Za-z0-9 ._()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 60) || 'shot'
}

/**
 * Newest first. Ties are left untouched on purpose: Array#sort is stable, so a
 * record inserted at the head of the list stays ahead of anything else written
 * in the same millisecond.
 */
function byNewest(a: ShotRecord, b: ShotRecord): number {
  return b.createdAt - a.createdAt
}

export class ShotShelf {
  readonly folder: string
  private keep: number
  /** Newest first — the order the tray renders in. */
  private records: ShotRecord[] = []
  /** Content hash -> path, for everything currently on the shelf. */
  private pathByHash = new Map<string, string>()
  /** Whatever we last saw on the clipboard, caught or not. */
  private clipboardHash = ''
  /** Ring of hashes Forge itself published — never catch our own copies. */
  private suppressed: string[] = []

  constructor(folder: string, keep: number = DEFAULT_KEEP) {
    this.folder = folder
    this.keep = clampKeep(keep)
  }

  /* ------------------------------------------------------------- reading */

  list(): ShotRecord[] {
    return [...this.records]
  }

  get count(): number {
    return this.records.length
  }

  get keepCount(): number {
    return this.keep
  }

  /**
   * Adopt whatever is already in the folder (a previous run's shots). Pass
   * `hashOf` to seed dedupe from disk — nativeImage decodes a PNG back to the
   * exact bitmap it was written from, so a shot from last session is still
   * recognised when its image is on the clipboard now.
   */
  load(hashOf?: (path: string) => string): ShotRecord[] {
    mkdirSync(this.folder, { recursive: true })
    const found: ShotRecord[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.folder)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!SHOT_EXTS.includes(extname(name).toLowerCase())) continue
      const full = join(this.folder, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        found.push({ id: name, name, path: full, createdAt: st.mtimeMs, bytes: st.size })
      } catch {
        /* vanished mid-scan — fine */
      }
    }
    found.sort(byNewest)
    this.records = found
    this.pathByHash.clear()
    this.prune()
    if (hashOf) {
      for (const rec of this.records) {
        try {
          const h = hashOf(rec.path)
          if (h) this.pathByHash.set(h, rec.path)
        } catch {
          /* unreadable image — just means it could be caught again */
        }
      }
    }
    return this.list()
  }

  /* ------------------------------------------------------------- dedupe */

  /** True when this clipboard content is worth saving as a new shot. */
  shouldCatch(hash: string): boolean {
    if (!hash) return false
    if (hash === this.clipboardHash) return false
    if (this.pathByHash.has(hash)) return false
    return !this.suppressed.includes(hash)
  }

  /** Remember what is on the clipboard right now, caught or skipped. */
  noteClipboard(hash: string): void {
    this.clipboardHash = hash
  }

  /** Forge just put this image on the clipboard — never catch it back. */
  suppress(hash: string): void {
    if (!hash) return
    this.noteClipboard(hash)
    if (this.suppressed.includes(hash)) return
    this.suppressed.push(hash)
    if (this.suppressed.length > SUPPRESS_RING) this.suppressed.shift()
  }

  /* ------------------------------------------------------------ writing */

  setKeep(keep: number): string[] {
    const next = clampKeep(keep)
    if (next === this.keep) return []
    this.keep = next
    return this.prune()
  }

  /** PNG bytes off the clipboard -> a real file on the shelf. */
  pinBytes(bytes: Uint8Array, hash: string, now: Date = new Date()): PinResult {
    if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty' }
    if (!this.shouldCatch(hash)) return { ok: false, reason: 'duplicate' }
    const target = this.freshPath(shotStamp(now), '.png')
    try {
      this.writeAtomic(target, bytes)
    } catch (err) {
      console.error('[shots] could not write', target, err)
      return { ok: false, reason: 'error' }
    }
    this.noteClipboard(hash)
    this.pathByHash.set(hash, target)
    return { ok: true, record: this.adopt(target), pruned: this.prune() }
  }

  /** An image file dropped on the tray -> copied onto the shelf. */
  pinFile(src: string, hashOf?: (path: string) => string): PinResult {
    const ext = extname(src).toLowerCase()
    if (!SHOT_EXTS.includes(ext)) return { ok: false, reason: 'unsupported' }
    try {
      if (!statSync(src).isFile()) return { ok: false, reason: 'unsupported' }
    } catch {
      return { ok: false, reason: 'unsupported' }
    }
    const stem = sanitiseStem(basename(src, extname(src)))
    const target = this.freshPath(stem, ext)
    try {
      mkdirSync(this.folder, { recursive: true })
      copyFileSync(src, target)
    } catch (err) {
      console.error('[shots] could not adopt', src, err)
      return { ok: false, reason: 'error' }
    }
    if (hashOf) {
      try {
        const h = hashOf(target)
        if (h) this.pathByHash.set(h, target)
      } catch {
        /* not fatal */
      }
    }
    return { ok: true, record: this.adopt(target), pruned: this.prune() }
  }

  /** Delete one shot. Paths coming from the renderer are never trusted. */
  remove(path: string): boolean {
    if (!this.owns(path)) return false
    const full = resolve(path)
    try {
      unlinkSync(full)
    } catch {
      /* already gone — still drop it from the shelf */
    }
    this.forget(full)
    return true
  }

  /** Empty the shelf. Returns the paths that were removed. */
  clear(): string[] {
    const gone: string[] = []
    for (const rec of [...this.records]) {
      if (this.remove(rec.path)) gone.push(rec.path)
    }
    return gone
  }

  /** Trim to `keep`, oldest first. Returns the paths that were removed. */
  prune(): string[] {
    const gone: string[] = []
    while (this.records.length > this.keep) {
      const victim = this.records[this.records.length - 1]!
      try {
        unlinkSync(victim.path)
      } catch {
        /* best effort */
      }
      this.forget(victim.path)
      gone.push(victim.path)
    }
    return gone
  }

  /* ---------------------------------------------------------- internals */

  /** Is this path really one of ours? Guards against `..` from the renderer. */
  owns(path: string): boolean {
    if (!path) return false
    const full = resolve(path)
    return resolve(dirname(full)).toLowerCase() === resolve(this.folder).toLowerCase()
  }

  private forget(full: string): void {
    this.records = this.records.filter((r) => r.path !== full)
    for (const [hash, p] of this.pathByHash) {
      if (p === full) this.pathByHash.delete(hash)
    }
  }

  /** Stat a file we just wrote and slot it into the newest-first list. */
  private adopt(full: string): ShotRecord {
    let bytes = 0
    let createdAt = Date.now()
    try {
      const st = statSync(full)
      bytes = st.size
      createdAt = st.mtimeMs
    } catch {
      /* keep the optimistic values */
    }
    const name = basename(full)
    const record: ShotRecord = { id: name, name, path: full, createdAt, bytes }
    this.records = [record, ...this.records.filter((r) => r.path !== full)]
    this.records.sort(byNewest)
    return record
  }

  /** `stem.ext`, or `stem -2.ext` when a shot of that name already exists. */
  private freshPath(stem: string, ext: string): string {
    mkdirSync(this.folder, { recursive: true })
    let candidate = join(this.folder, `${stem}${ext}`)
    let n = 2
    while (existsSync(candidate)) {
      candidate = join(this.folder, `${stem} -${n}${ext}`)
      n += 1
    }
    return candidate
  }

  /** tmp + rename, so a half-written PNG never appears in the tray. */
  private writeAtomic(target: string, bytes: Uint8Array): void {
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, target)
  }
}

import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { MAX_PROJECT_FILE_BYTES, type WebProjectEntry } from '@shared/web'

/**
 * The read-only file browser behind Forge Web's "Files" view while the desktop
 * is on — the desktop half of `project-files` and `project-file`.
 *
 * ## Confinement is the whole job
 *
 * electron/web/fs-browse.ts walks the whole disk and reads names only. This
 * file reads *contents*, and so it is fenced where that one is not: every
 * answer is about something inside one project's folder, and "inside" is
 * decided on real paths, after every symlink and junction on the way has been
 * resolved. So:
 *
 *  - a path from the wire is always relative to the project's folder. An
 *    absolute one (`C:\…`, `\\server\…`, `/…`) is refused rather than
 *    re-rooted, because re-rooting would answer a question nobody asked;
 *  - a `..` segment is refused outright, before the disk is touched, rather
 *    than normalised away — a browser has no business spelling a climb, even
 *    one that would land back inside;
 *  - whatever survives is resolved with `realpath`, and anything whose real
 *    path is not under the project's own real path is refused. That is the
 *    check that catches a link inside the project pointing out of it, which
 *    no amount of string inspection could;
 *  - a link in a listing that points out of the project is left out of the
 *    list, so the browser is never offered a row it would be refused.
 *
 * As everywhere on this link, a refusal is a value carrying a sentence, never
 * a throw: a file that has gone, a folder Windows will not open, a binary file
 * tapped by mistake are ordinary events in a browser somebody is clicking
 * around in.
 *
 * Nothing here is Electron, for the reason fs-browse.ts gives:
 * scripts/web-io-check.mjs bundles it with the real server and points it at a
 * real temporary project.
 */

/**
 * How many entries one `project-files` answer may carry — folders first, so
 * the cap cuts files before it cuts anything to open. A `node_modules` is tens
 * of thousands; nobody scrolls that on a phone.
 */
export const MAX_PROJECT_ENTRIES = 1000

/**
 * How much of a file is sniffed for a NUL byte to call it binary — the same
 * heuristic, and the same 8000, git uses to decide whether to diff a file.
 */
const BINARY_SNIFF_BYTES = 8000

type Refusal = { ok: false; error: string }

function refuse(error: string): Refusal {
  return { ok: false, error }
}

/**
 * A wire path, as segments to join under a root — or the sentence that says
 * why it is not one. Accepts `/` or `\` as separators; '' and `.` are the
 * folder itself.
 */
export function projectPathSegments(raw: string): { ok: true; segments: string[] } | Refusal {
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) {
    return refuse('That path is absolute. Ask for a path inside the project instead.')
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  for (const segment of segments) {
    if (segment === '..') return refuse('That path climbs out of the project, so this desktop will not open it.')
    // A colon is an NTFS alternate data stream (`notes.txt:hidden`) or a
    // drive, and a control character is not in any name a person made.
    if ([...segment].some((ch) => ch === ':' || (ch.codePointAt(0) ?? 0) < 32)) {
      return refuse('That is not a file name this desktop will open.')
    }
  }
  return { ok: true, segments }
}

/** Is `target` the root itself or somewhere beneath it? Both already real paths. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === '') return true
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** A path relative to the root, spelled the wire's way: `/`-separated, '' for the root. */
function wirePath(rootReal: string, targetReal: string): string {
  return relative(rootReal, targetReal).split(sep).join('/')
}

/**
 * Resolve a wire path to a real path inside the project, or refuse.
 *
 * `base` is the folder the segments are relative to when it is not the project
 * itself — a git repository root sitting above the project, for a path the git
 * status list printed. The confinement is to `root` either way.
 */
async function resolveInside(
  root: string,
  raw: string,
  base?: string
): Promise<{ ok: true; rootReal: string; targetReal: string; path: string } | Refusal> {
  const parsed = projectPathSegments(raw)
  if (!parsed.ok) return parsed
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch {
    return refuse("That project's folder is not on this disk any more.")
  }
  let baseReal = rootReal
  if (base) {
    try {
      baseReal = await realpath(base)
    } catch {
      return refuse("That project's repository is not on this disk any more.")
    }
  }
  let targetReal: string
  try {
    targetReal = await realpath(join(baseReal, ...parsed.segments))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return refuse(
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'Nothing by that name in the project — it may have been moved or deleted.'
        : 'This desktop could not open that.'
    )
  }
  if (!inside(rootReal, targetReal)) {
    return refuse('That points outside the project folder, so this desktop will not open it.')
  }
  return { ok: true, rootReal, targetReal, path: wirePath(rootReal, targetReal) }
}

/** One folder inside a project, folders first, then files, by name. */
export async function listProjectFolder(
  root: string,
  raw: string
): Promise<{ ok: true; path: string; entries: WebProjectEntry[]; truncated: boolean } | Refusal> {
  const where = await resolveInside(root, raw)
  if (!where.ok) return where
  let dirents
  try {
    const st = await stat(where.targetReal)
    if (!st.isDirectory()) return refuse('That is a file, not a folder.')
    dirents = await readdir(where.targetReal, { withFileTypes: true })
  } catch {
    return refuse('This desktop could not read that folder.')
  }

  // Typed from the dirent where that is free; a link is followed, confined,
  // and dropped from the list when it leads out of the project or nowhere.
  const rows: { name: string; dir: boolean; full: string }[] = []
  for (const d of dirents) {
    const full = join(where.targetReal, d.name)
    let dir = d.isDirectory()
    let file = d.isFile()
    if (d.isSymbolicLink()) {
      try {
        const real = await realpath(full)
        if (!inside(where.rootReal, real)) continue
        const st = await stat(real)
        dir = st.isDirectory()
        file = st.isFile()
      } catch {
        continue
      }
    }
    if (dir || file) rows.push({ name: d.name, dir, full })
  }
  rows.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
  const kept = rows.slice(0, MAX_PROJECT_ENTRIES)
  const entries = await Promise.all(
    kept.map(async (row): Promise<WebProjectEntry> => {
      try {
        const st = await stat(row.full)
        return { name: row.name, dir: row.dir, size: row.dir ? 0 : st.size, mtime: Math.round(st.mtimeMs) }
      } catch {
        return { name: row.name, dir: row.dir, size: 0, mtime: 0 }
      }
    })
  )
  return { ok: true, path: where.path, entries, truncated: rows.length > kept.length }
}

/**
 * The longest prefix of `bytes` that does not end partway through a UTF-8
 * character, so a truncated file decodes cleanly instead of ending in U+FFFD.
 */
function cutToCharBoundary(bytes: Buffer): Buffer {
  let lead = bytes.length - 1
  // Back over at most three continuation bytes to the byte that starts the
  // last character.
  while (lead > 0 && bytes.length - lead <= 3 && (bytes[lead] & 0xc0) === 0x80) lead--
  if (lead < 0) return bytes
  const b = bytes[lead]
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
  return lead + need > bytes.length ? bytes.subarray(0, lead) : bytes
}

/**
 * One text file inside a project: the first MAX_PROJECT_FILE_BYTES as UTF-8,
 * `truncated` when there was more. A file with a NUL in its first 8000 bytes
 * is binary and refused.
 *
 * `base` — see `resolveInside`.
 */
export async function readProjectFile(
  root: string,
  raw: string,
  base?: string
): Promise<
  { ok: true; path: string; content: string; size: number; mtime: number; truncated: boolean } | Refusal
> {
  const where = await resolveInside(root, raw, base)
  if (!where.ok) return where
  let handle
  try {
    const st = await stat(where.targetReal)
    if (st.isDirectory()) return refuse('That is a folder, not a file.')
    if (!st.isFile()) return refuse('That is not a file this desktop can read.')
    handle = await open(where.targetReal, 'r')
    const want = Math.min(st.size, MAX_PROJECT_FILE_BYTES)
    const buffer = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const { bytesRead } = await handle.read(buffer, got, want - got, got)
      if (!bytesRead) break
      got += bytesRead
    }
    const bytes = buffer.subarray(0, got)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return refuse('That looks like a binary file, so there is no text in it to show.')
    }
    const truncated = st.size > got
    return {
      ok: true,
      path: where.path,
      content: (truncated ? cutToCharBoundary(bytes) : bytes).toString('utf8'),
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      truncated
    }
  } catch {
    return refuse('This desktop could not read that file.')
  } finally {
    await handle?.close().catch(() => {})
  }
}

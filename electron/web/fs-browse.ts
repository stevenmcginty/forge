import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { WebCrumb, WebDirEntry, WebFolder } from '@shared/web'

/**
 * The folder browser behind Forge Web's "Add project" — the desktop half.
 *
 * A browser three hundred miles away cannot be shown `dialog.showOpenDialog`,
 * which opens a window on a screen nobody is sitting at, so the picker is drawn
 * in the page and this is what feeds it: one folder at a time, names only.
 *
 * ## Why this is a file of its own rather than lines in web-host.ts
 *
 * Nothing here is Electron, and that is deliberate — it is the same split
 * `electron/web/server.ts`, `auth.ts` and `pin.ts` were made for, and it
 * buys the same thing: `scripts/web-e2e.mjs` bundles this function straight into
 * its harness and serves a real temporary directory tree to a real browser, so
 * the picker on screen is reading the shipped listing code rather than a
 * stand-in written to agree with it. `electron/web-host.ts` is where the
 * `WebServerHost` callback lives; this is only what it calls.
 *
 * ## What it will and will not do
 *
 * Every path arriving here came off the wire. It is past a verified Firebase ID
 * token and an approved device — see the reckoning on `WebRequest` in
 * shared/web.ts, which is honest that a browser this far in already has a shell
 * and so this is not a containment boundary — but "not a boundary" is not
 * licence to be careless. So:
 *
 *  - a relative path is refused rather than resolved, because resolving one
 *    would silently mean "relative to wherever Forge happens to have been
 *    started", which is a different folder on every launch and one nobody
 *    asked for;
 *  - a `name` to descend into must be a single plain segment, so the browser's
 *    "open this folder" cannot be spelled `..\..\..` and arrive somewhere the
 *    breadcrumb is not describing;
 *  - a folder that has gone, or that this account may not read, comes back as
 *    a sentence somebody can act on. A permission error thrown out of here
 *    would settle no promise and would reach the browser, at best, as "the
 *    desktop failed while handling that";
 *  - and no answer is ever the whole of a large folder. See MAX_FS_ENTRIES.
 *
 * Names only, and never contents. There is no frame on this protocol that
 * carries a file's bytes and this module must never become the reason there is.
 */

/**
 * How many entries one answer may carry.
 *
 * The cap the type declines to state — `WebRequest`'s `fs-list` says the number
 * lives here, the same arrangement `agents` has with MAX_PROBE_COMMANDS in
 * electron/web/server.ts, because a ceiling belongs beside the code that spends
 * the effort rather than in a file three consumers compile against.
 *
 * Five hundred, and the number that matters is on the other side of it: a
 * `node_modules` or a `C:\Windows\WinSxS` is tens of thousands of entries, and
 * serialising one of those whole would be several megabytes of JSON built on
 * the main thread, pushed down a tunnel, and parsed by a phone browser — for a
 * list nobody could read anyway. Five hundred is far more than a person scrolls
 * through to find a project and small enough that the cost of the worst folder
 * on the machine is bounded and dull. `truncated` says when it bit.
 */
export const MAX_FS_ENTRIES = 500

/**
 * Longest path this will act on, in characters.
 *
 * Windows' own traditional limit is 260, and a long-path-enabled system reaches
 * 32767 — so this is not a correctness rule, it is a ceiling on how much work
 * one frame may ask for. Two thousand is past any real folder and short enough
 * that a megabyte of `\`s is refused before it becomes a syscall.
 */
const MAX_PATH_CHARS = 2048

/** What the caller gets: a folder, or a sentence written for the person reading the tab. */
export type FolderResult = { ok: true; folder: WebFolder } | { ok: false; error: string }

/**
 * List one folder, or the drive roots when `path` is ''.
 *
 * `name`, when given, is one entry of the folder `path` names, appended here so
 * the browser never joins two strings and calls the result a path on a machine
 * it is not on. At the roots that name *is* a root (`C:\`), and it is checked
 * against the roots this machine actually has rather than being trusted to be
 * one — which is what stops a bare `C:` arriving and being resolved against
 * whatever directory Forge's process happens to be sitting in on that drive.
 */
export function listFolder(path: string, name = '', limit = MAX_FS_ENTRIES): FolderResult {
  const target = resolveTarget(path, name)
  if (!target.ok) return target
  if (target.roots) return { ok: true, folder: rootFolder(limit) }

  let dirents: Dirent[]
  try {
    dirents = readdirSync(target.path, { withFileTypes: true })
  } catch (err) {
    return { ok: false, error: describeFsError(err, target.path) }
  }

  /*
   * Sorted before it is cut, and cut before anything is stat'ed. The order is
   * the whole design of this function: folders first so the cap can never bury
   * the only rows a picker can be clicked on, and the `.git` probe — the one
   * syscall per entry in here — paid only for the entries that survive the cut,
   * so a folder of fifty thousand things costs fifty thousand *names* and five
   * hundred stats rather than fifty thousand of each.
   */
  const sorted = dirents.sort(compareDirents)
  const kept = sorted.slice(0, limit)
  const entries: WebDirEntry[] = kept.map((dirent) => {
    const dir = looksLikeDir(dirent, target.path)
    return { name: dirent.name, dir, repo: dir && isRepo(join(target.path, dirent.name)) }
  })

  return {
    ok: true,
    folder: {
      path: target.path,
      sep,
      crumbs: crumbsFor(target.path),
      entries,
      truncated: sorted.length > kept.length
    }
  }
}

/**
 * Is this a folder Forge may be pointed at as a project?
 *
 * Separate from the listing because it answers a different question at a
 * different moment: the listing is a browse, this is the click, and between the
 * two the folder can have been renamed, unplugged or replaced by a file. "The
 * browser was told about it a moment ago" is not a fact about the disk now.
 */
export function checkFolder(path: string): { ok: true; path: string } | { ok: false; error: string } {
  const clean = cleanPath(path)
  if (!clean) {
    return { ok: false, error: 'That is not a full path to a folder on this desktop.' }
  }
  let stats
  try {
    stats = statSync(clean)
  } catch (err) {
    return { ok: false, error: describeFsError(err, clean) }
  }
  if (!stats.isDirectory()) return { ok: false, error: `${clean} is a file, not a folder.` }
  return { ok: true, path: clean }
}

/* ------------------------------------------------------------------ inside */

type Target = { ok: true; roots: true; path: '' } | { ok: true; roots: false; path: string } | { ok: false; error: string }

/**
 * Turn what arrived on the wire into one absolute path, or a refusal.
 *
 * Total, and the only place either of the two inputs is believed at all.
 */
function resolveTarget(path: string, name: string): Target {
  const segment = name.trim()

  /*
   * The roots are their own case on both halves. '' means "list the drives",
   * and a name alongside it is a *root* rather than a segment — `C:\` has a
   * separator in it and could never pass the plain-segment test — so it is
   * matched against the drives this machine actually has rather than appended
   * to anything. That match is what stops a bare `C:` being resolved against
   * whatever directory Forge's process is sitting in on that drive.
   */
  if (!path) {
    if (!segment) return { ok: true, roots: true, path: '' }
    const root = driveRoots().find((candidate) => candidate.toLowerCase() === segment.toLowerCase())
    if (!root) return { ok: false, error: `${segment} is not a drive on this desktop.` }
    return { ok: true, roots: false, path: root }
  }

  if (segment && !isPlainSegment(segment)) {
    return { ok: false, error: 'That is not a folder name this desktop can open.' }
  }
  const clean = cleanPath(path)
  if (!clean) return { ok: false, error: 'That is not a full path to a folder on this desktop.' }
  return { ok: true, roots: false, path: segment ? join(clean, segment) : clean }
}

/**
 * An absolute path, normalised, or '' when it is not one.
 *
 * `resolve` after the absolute test rather than instead of it: `resolve` will
 * happily turn `src` into a path under Forge's own working directory, and a
 * picker that silently did that would show a folder nobody navigated to.
 */
function cleanPath(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed || trimmed.length > MAX_PATH_CHARS) return ''
  if (!isAbsolute(trimmed)) return ''
  return resolve(trimmed)
}

/** One ordinary name: no separator, no drive letter, and neither `.` nor `..`. */
function isPlainSegment(value: string): boolean {
  if (value === '.' || value === '..') return false
  return !/[\\/:]/.test(value)
}

/**
 * The drive roots, or `/` on anything that is not Windows.
 *
 * Twenty-six `existsSync` calls, which is the plainest way to ask and needs no
 * dependency and no `wmic` — a letter with nothing behind it answers false
 * immediately, and the whole sweep is a few milliseconds on a machine with the
 * usual two or three drives.
 */
export function driveRoots(): string[] {
  if (sep === '/') return ['/']
  const roots: string[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:${sep}`
    try {
      if (existsSync(root)) roots.push(root)
    } catch {
      /* a drive that will not answer is a drive that is not there */
    }
  }
  return roots
}

/** The roots as a folder, so the picker's first screen is the same shape as every other. */
function rootFolder(limit: number): WebFolder {
  const roots = driveRoots().slice(0, limit)
  return {
    path: '',
    sep,
    // No crumbs above the roots: there is nothing above them, and an empty
    // list is what tells the picker to draw its "This desktop" row as the top.
    crumbs: [],
    entries: roots.map((root) => ({ name: root, dir: true, repo: false })),
    truncated: false
  }
}

/**
 * This folder and every folder above it, root first.
 *
 * Built here rather than by the browser splitting `path` on `sep`, because that
 * split gets the root wrong on every platform in a different way — `C:` is not
 * `C:\`, and the first segment of a POSIX path is ''. `parse().root` and
 * repeated `dirname` are the library's own answer to that question.
 */
function crumbsFor(path: string): WebCrumb[] {
  const root = parse(path).root
  if (!root) return []
  const crumbs: WebCrumb[] = []
  let current = path
  while (current !== root) {
    const parent = resolve(current, '..')
    // A path that stops shrinking would spin here — a UNC share is the shape
    // that does it — so the loop trusts progress rather than assuming it.
    if (parent === current) break
    crumbs.unshift({ name: parse(current).base, path: current })
    current = parent
  }
  crumbs.unshift({ name: root, path: root })
  return crumbs
}

/**
 * Folders first, then everything else, each case-insensitively by name.
 *
 * `localeCompare` rather than `<`, so `Documents` and `desktop` sort where a
 * person expects them to rather than where their code points fall.
 */
function compareDirents(a: Dirent, b: Dirent): number {
  const aDir = a.isDirectory() || a.isSymbolicLink()
  const bDir = b.isDirectory() || b.isSymbolicLink()
  if (aDir !== bDir) return aDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * Is this entry something the picker can open?
 *
 * `readdir` answers for free for a real directory. A symlink — and on Windows a
 * junction, which is how `Documents` and half of a user profile are often
 * spelled — needs one `stat` to find out what it points at, and a broken one
 * throws, which is the honest answer of "not a folder you can open" rather than
 * something to propagate.
 */
function looksLikeDir(dirent: Dirent, parent: string): boolean {
  if (dirent.isDirectory()) return true
  if (!dirent.isSymbolicLink()) return false
  try {
    return statSync(join(parent, dirent.name)).isDirectory()
  } catch {
    return false
  }
}

/** A `.git` of either kind: a real repository, or a worktree's or submodule's file. */
function isRepo(path: string): boolean {
  try {
    return existsSync(join(path, '.git'))
  } catch {
    return false
  }
}

/**
 * What went wrong, as a sentence for somebody looking at a browser tab.
 *
 * The three codes worth naming are the three a person navigating with a mouse
 * will actually cause; everything else falls through to the message, which is
 * better than "failed" and is the only honest thing left to say.
 */
function describeFsError(err: unknown, path: string): string {
  const code = (err as { code?: string } | null)?.code ?? ''
  if (code === 'ENOENT') return `${path} is not there any more.`
  if (code === 'EACCES' || code === 'EPERM') return `Windows will not let Forge read ${path}.`
  if (code === 'ENOTDIR') return `${path} is a file, not a folder.`
  return `${path} could not be read (${err instanceof Error ? err.message : String(err)}).`
}

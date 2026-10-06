import { ipcMain, shell, type BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch as fsWatch,
  writeFileSync,
  type Dirent,
  type FSWatcher,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import {
  isMarkdownPath,
  READER_LIST_MAX_DEPTH,
  READER_LIST_MAX_ENTRIES,
  READER_MAX_BYTES,
  READER_RECENT_MAX,
  READER_SKIP_DIRS,
  type ReaderActionResult,
  type ReaderDoc,
  type ReaderEntry,
  type ReaderOpenRequest,
  type ReaderOpenSource,
  type ReaderWriteResult
} from '@shared/reader'

/**
 * The Markdown reader's main-process half: reading, listing, saving and
 * watching .md files, and the one route every "show Steve this file" takes.
 *
 * Every way a file reaches the reader goes through `openInReader` — the Read
 * view's own picker, a terminal link, an agent tool, a double-click in Explorer
 * — so the checks (absolute, existing, a file, a markdown extension) and the
 * recent list are decided once, here.
 *
 * Getting a double-click into a running Forge has two routes, because Forge
 * runs two ways:
 *
 *  - packaged (friends): Windows starts `Forge.exe "<file>"`. A cold start reads
 *    it from process.argv; a warm one arrives as `second-instance` argv.
 *  - from source (Steve's everyday Forge): `npm run dev` ignores arguments, so
 *    Windows starts `Open in Forge.vbs "<file>"` instead, which drops one request
 *    file into `<dataRoot>\reader-inbox\` and starts Forge if it is not running.
 *    Main drains that folder at boot and watches it from then on.
 *
 * The pure half (everything above the "electron" divider) takes plain paths and
 * returns plain values, so scripts/reader-check.mjs can drive it against a temp
 * dir with `electron` stubbed out.
 */

/** Explorer's double-click and the inbox both land here. */
const READER_INBOX_DIR = 'reader-inbox'
/** Main's pid, for `Open in Forge.vbs` to ask WMI whether Forge is up. */
const INBOX_PID_FILE = '.forge-pid'
/** Written by the VBS when it starts Forge; cleared at boot. See the VBS. */
const INBOX_LAUNCH_STAMP = '.forge-launch'
/** A finished request. The VBS writes `.tmp` and renames, so a half-written one is never read. */
const INBOX_REQUEST_EXT = '.req'

const RECENT_FILE = 'reader-recent.json'

/** Walking a whole drive by mistake should stop well before it hurts. */
const LIST_MAX_DIRS = 20_000

const WATCH_DEBOUNCE_MS = 150
/** An editor that replaces the file leaves a gap; wait this long, this often, for the new one. */
const REARM_RETRY_MS = 300
const REARM_RETRIES = 10
const MAX_WATCHES = 32

/** Requests waiting for a renderer that has not asked yet. A backstop, not a working limit. */
const MAX_PENDING = 50

const SOURCES: readonly ReaderOpenSource[] = ['windows', 'terminal', 'agent', 'app']

/* ===================================================================== pure */

function statOf(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Case-folded on Windows, where `C:\A.md` and `c:\a.md` are one file. */
function samePathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/**
 * The one gate for a path that names a file: absolute, existing, a regular file
 * with a markdown extension. Returns the resolved path, or a sentence saying why not.
 */
export function checkMarkdownFile(path: unknown): { path: string; stat: Stats } | { error: string } {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (!raw) return { error: 'No file was named.' }
  if (!isAbsolute(raw)) return { error: `Not an absolute path: ${raw}` }
  const abs = resolve(raw)
  if (!isMarkdownPath(abs)) return { error: `Not a markdown file: ${abs}` }
  const stat = statOf(abs)
  if (!stat) return { error: `File not found: ${abs}` }
  if (!stat.isFile()) return { error: `Not a file: ${abs}` }
  return { path: abs, stat }
}

/**
 * Every markdown file under `root`, newest first.
 *
 * Skips the build and dependency folders in READER_SKIP_DIRS and every
 * dot-directory, never follows a symlinked folder (no loops), goes at most
 * READER_LIST_MAX_DEPTH folders down and stops at READER_LIST_MAX_ENTRIES files.
 * An unreadable folder is skipped, not fatal; a root that is not a folder is [].
 */
export function listMarkdown(root: unknown): ReaderEntry[] {
  const raw = typeof root === 'string' ? root.trim() : ''
  if (!raw || !isAbsolute(raw)) return []
  const base = resolve(raw)
  if (!statOf(base)?.isDirectory()) return []

  const skip = new Set<string>(READER_SKIP_DIRS.map((d) => d.toLowerCase()))
  const out: ReaderEntry[] = []
  const stack: Array<[string, number]> = [[base, 0]]
  let dirs = 0

  while (stack.length > 0 && out.length < READER_LIST_MAX_ENTRIES && dirs < LIST_MAX_DIRS) {
    const [dir, depth] = stack.pop() as [string, number]
    dirs++
    let names: Dirent[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of names) {
      if (out.length >= READER_LIST_MAX_ENTRIES) break
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (depth >= READER_LIST_MAX_DEPTH) continue
        if (d.name.startsWith('.') || skip.has(d.name.toLowerCase())) continue
        stack.push([full, depth + 1])
      } else if (d.isFile() && isMarkdownPath(d.name)) {
        const stat = statOf(full)
        if (!stat) continue
        out.push({ path: full, rel: relative(base, full), mtimeMs: stat.mtimeMs, size: stat.size })
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** UTF-8, BOM dropped, CRLF folded to LF — what the reader shows and edits. */
function docFrom(path: string, bytes: Buffer, mtimeMs: number): ReaderDoc {
  const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes
  return { path, text: body.toString('utf8').replace(/\r\n/g, '\n'), mtimeMs, hash: hashOf(bytes) }
}

export function readMarkdown(path: unknown): ReaderDoc | { error: string } {
  const checked = checkMarkdownFile(path)
  if ('error' in checked) return checked
  if (checked.stat.size > READER_MAX_BYTES) {
    return { error: `Too large to open (${Math.round(checked.stat.size / 1024 / 1024)} MB, the limit is 5 MB).` }
  }
  try {
    const bytes = readFileSync(checked.path)
    return docFrom(checked.path, bytes, checked.stat.mtimeMs)
  } catch (err) {
    return { error: `Could not read it: ${(err as Error).message}` }
  }
}

/**
 * "This file uses CRLF": more CRLF line breaks than bare LF ones. A file with no
 * line breaks at all is LF, which is what a new line typed into it would be.
 */
function usesCrlf(text: string): boolean {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  if (crlf === 0) return false
  const lf = text.match(/\n/g)?.length ?? 0
  return crlf >= lf - crlf
}

/**
 * Save the reader's text over an existing markdown file.
 *
 * Refuses to overwrite a file that changed since the renderer read it: the hash
 * of what is on disk has to be `baseHash`, otherwise nothing is written and the
 * current contents come back as a conflict. The file keeps its own conventions —
 * a CRLF file stays CRLF (the renderer edits LF text) and a UTF-8 BOM stays put.
 * Written in place rather than through a temp file and a rename, so the file
 * keeps its identity, its attributes and any hard link to it.
 */
export function writeMarkdown(path: unknown, text: unknown, baseHash: unknown): ReaderWriteResult {
  const checked = checkMarkdownFile(path)
  if ('error' in checked) return { ok: false, error: checked.error }
  if (typeof text !== 'string') return { ok: false, error: 'Nothing to save.' }
  if (Buffer.byteLength(text, 'utf8') > READER_MAX_BYTES) return { ok: false, error: 'Too large to save (the limit is 5 MB).' }
  try {
    const current = readFileSync(checked.path)
    if (hashOf(current) !== String(baseHash ?? '')) {
      return { ok: false, conflict: true, doc: docFrom(checked.path, current, checked.stat.mtimeMs) }
    }
    const bom = hasUtf8Bom(current)
    const original = (bom ? current.subarray(3) : current).toString('utf8')
    const lf = text.replace(/\r\n/g, '\n')
    const body = usesCrlf(original) ? lf.replace(/\n/g, '\r\n') : lf
    const bytes = bom ? Buffer.concat([UTF8_BOM, Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8')
    writeFileSync(checked.path, bytes)
    const after = statOf(checked.path)
    return { ok: true, mtimeMs: after?.mtimeMs ?? Date.now(), hash: hashOf(bytes) }
  } catch (err) {
    return { ok: false, error: `Could not save it: ${(err as Error).message}` }
  }
}

/**
 * A path as it appears in text — a terminal line, an agent's reply — turned into
 * an existing markdown file, or null.
 *
 * Peels what wraps a path in prose: surrounding quotes or backticks, a trailing
 * `:line` or `:line:col`, and trailing sentence punctuation. A relative path is
 * taken against `baseDir` (a pane's working directory); with no `baseDir`, only
 * an absolute one can resolve.
 */
export function resolveMarkdownRef(text: unknown, baseDir?: unknown): string | null {
  let s = typeof text === 'string' ? text.trim() : ''
  for (let i = 0; i < 4; i++) {
    const before = s
    const wrapped = /^(["'`])([\s\S]*)\1$/.exec(s)
    if (wrapped) s = (wrapped[2] ?? '').trim()
    s = s.replace(/:\d+(?::\d+)?$/, '')
    if (s === before) break
  }
  if (!s) return null
  const base = typeof baseDir === 'string' && baseDir.trim() && isAbsolute(baseDir.trim()) ? baseDir.trim() : null
  const attempt = (candidate: string): string | null => {
    const abs = isAbsolute(candidate) ? resolve(candidate) : base ? resolve(base, candidate) : null
    if (!abs) return null
    const checked = checkMarkdownFile(abs)
    return 'error' in checked ? null : checked.path
  }
  return attempt(s) ?? (/[.,;:!?)\]]+$/.test(s) ? attempt(s.replace(/[.,;:!?)\]]+$/, '')) : null)
}

/**
 * One inbox request's bytes, as the path it names.
 *
 * `Open in Forge.vbs` writes UTF-16LE with a BOM (FileSystemObject's Unicode
 * mode); a hand-written request, or another tool's, may be UTF-8 with or
 * without one. All three are read here, so a path with non-ASCII in it survives.
 */
export function decodeInboxRequest(bytes: Buffer): string {
  let text: string
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le')
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    text = swapped.subarray(0, swapped.length - (swapped.length % 2)).swap16().toString('utf16le')
  } else if (hasUtf8Bom(bytes)) {
    text = bytes.subarray(3).toString('utf8')
  } else {
    text = bytes.toString('utf8')
  }
  const line = text
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? ''
}

/**
 * Take every finished request out of an inbox folder, oldest first: read it,
 * delete it, return the paths it named. Dot-files (the pid and launch stamp) and
 * `.tmp` files still being written are left alone. A request that cannot be
 * read is deleted anyway — leaving it would retry it on every change for ever.
 */
export function takeInboxRequests(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith(INBOX_REQUEST_EXT)).sort()) {
    const full = join(dir, name)
    try {
      const path = decodeInboxRequest(readFileSync(full))
      if (path) out.push(path)
    } catch (err) {
      console.error(`[reader] could not read inbox request ${name}:`, err)
    }
    try {
      unlinkSync(full)
    } catch {
      /* gone already, or locked for a moment — the next drain gets it */
    }
  }
  return out
}

/** The existing markdown files named on a command line, resolved against `cwd`. Flags are ignored. */
export function markdownArgs(argv: readonly string[], cwd: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-') || !isMarkdownPath(arg)) continue
    const checked = checkMarkdownFile(resolve(cwd, arg))
    if ('error' in checked) continue
    const key = samePathKey(checked.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(checked.path)
  }
  return out
}

/* ------------------------------------------------------------------ recent */

type RecentRecord = { path: string; openedAt: number }

function loadRecentRecords(dataRoot: string): RecentRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataRoot, RECENT_FILE), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is RecentRecord =>
        !!r && typeof (r as RecentRecord).path === 'string' && typeof (r as RecentRecord).openedAt === 'number'
    )
  } catch {
    return []
  }
}

/** The files opened lately, most recent first; files that have since gone are dropped. */
export function readRecent(dataRoot: string): ReaderEntry[] {
  const out: ReaderEntry[] = []
  for (const r of loadRecentRecords(dataRoot)) {
    const checked = checkMarkdownFile(r.path)
    if ('error' in checked) continue
    out.push({ path: checked.path, rel: basename(checked.path), mtimeMs: checked.stat.mtimeMs, size: checked.stat.size })
    if (out.length >= READER_RECENT_MAX) break
  }
  return out
}

export function rememberRecent(dataRoot: string, path: string, now = Date.now()): void {
  const key = samePathKey(path)
  const next = [
    { path, openedAt: now },
    ...loadRecentRecords(dataRoot).filter((r) => samePathKey(r.path) !== key && existsSync(r.path))
  ].slice(0, READER_RECENT_MAX)
  const file = join(dataRoot, RECENT_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
}

/* ------------------------------------------------------- Windows "Open with" */

const CLASSES = 'HKCU\\Software\\Classes'
const PROG_ID = 'Forge.Markdown'

type RegValue = { key: string; name: string | null; data: string }

/**
 * What the source-run Forge registers so "Open with" offers it for .md files.
 *
 * A ProgID of its own plus an OpenWithProgids entry per extension, and nothing
 * else: the `.md` default value and the UserChoice key are Steve's to set (he
 * picks "Always" himself), so neither is touched.
 *
 * The open command is wscript running `Open in Forge.vbs`, which would show up
 * in the Open-with list as "Windows Based Script Host". Two values ask for
 * "Forge" instead: `FriendlyAppName` on the verb, and the `Application` subkey's
 * `ApplicationName` (the shape Chrome's and Firefox's ProgIDs use).
 */
export function openWithValues(checkoutRoot: string, systemRoot: string): RegValue[] {
  const progId = `${CLASSES}\\${PROG_ID}`
  const wscript = join(systemRoot, 'System32', 'wscript.exe')
  const vbs = join(checkoutRoot, 'Open in Forge.vbs')
  const icon = join(checkoutRoot, 'build', 'icon.ico')
  return [
    { key: progId, name: null, data: 'Markdown document' },
    { key: `${progId}\\DefaultIcon`, name: null, data: `${icon},0` },
    { key: `${progId}\\Application`, name: 'ApplicationName', data: 'Forge' },
    { key: `${progId}\\shell\\open`, name: 'FriendlyAppName', data: 'Forge' },
    { key: `${progId}\\shell\\open\\command`, name: null, data: `"${wscript}" "${vbs}" "%1"` },
    { key: `${CLASSES}\\.md\\OpenWithProgids`, name: PROG_ID, data: '' },
    { key: `${CLASSES}\\.markdown\\OpenWithProgids`, name: PROG_ID, data: '' }
  ]
}

/**
 * The value `reg query` printed, or null when it printed none.
 *
 * A value line is four spaces, the name, four spaces, the type, and — unless the
 * data is empty — four spaces and the data.
 */
export function parseRegQuery(stdout: string): { type: string; data: string } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^ {4}(.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line)
    if (m) return { type: m[2] ?? '', data: m[3] ?? '' }
  }
  return null
}

function runReg(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const regExe = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((done) => {
    execFile(regExe, args, { windowsHide: true, timeout: 10_000 }, (err, stdout, stderr) => {
      done({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Register the source-run Forge with Explorer's "Open with", idempotently.
 *
 * Only the stable checkout run from source does this: a packaged Forge gets its
 * association from the NSIS installer (electron-builder.yml fileAssociations),
 * and the Forge Dev checkout must not point Explorer at itself. The decision is
 * made from FORGE_CHANNEL, which scripts/dev.mjs sets from .forge-profile —
 * never from app.isPackaged alone, which is false for the everyday Forge too.
 *
 * Each value is read first and written only when it differs, so an ordinary
 * start costs a handful of reads and writes nothing. Failures are logged and
 * never thrown: an "Open with" entry is not worth a startup.
 */
export async function registerMarkdownOpenWith(opts: {
  checkoutRoot: string
  channel: string | undefined
  packaged: boolean
}): Promise<'skipped' | 'done' | 'failed'> {
  if (process.platform !== 'win32' || opts.packaged || opts.channel !== 'stable') return 'skipped'
  if (!existsSync(join(opts.checkoutRoot, 'Open in Forge.vbs'))) {
    console.error(`[reader] not registering "Open with": no Open in Forge.vbs in ${opts.checkoutRoot}`)
    return 'skipped'
  }
  let failed = false
  try {
    for (const v of openWithValues(opts.checkoutRoot, process.env['SystemRoot'] || 'C:\\Windows')) {
      const nameArgs = v.name === null ? ['/ve'] : ['/v', v.name]
      const now = await runReg(['query', v.key, ...nameArgs])
      const seen = now.ok ? parseRegQuery(now.stdout) : null
      if (seen && seen.type === 'REG_SZ' && seen.data === v.data) continue
      const wrote = await runReg(['add', v.key, ...nameArgs, '/t', 'REG_SZ', '/d', v.data, '/f'])
      if (!wrote.ok) {
        failed = true
        console.error(`[reader] could not write ${v.key} ${v.name ?? '(default)'}: ${wrote.stderr.trim()}`)
      }
    }
  } catch (err) {
    console.error('[reader] "Open with" registration failed:', err)
    return 'failed'
  }
  return failed ? 'failed' : 'done'
}

/* ================================================================= electron */

let dataRoot = ''
let focusWindow: (() => void) | null = null
let target: BrowserWindow | null = null
/** True once the current page has called takePending — until it reloads or dies. */
let rendererReady = false
const pending: ReaderOpenRequest[] = []

function deliver(req: ReaderOpenRequest): void {
  const wc = target && !target.isDestroyed() ? target.webContents : null
  if (rendererReady && wc && !wc.isDestroyed()) {
    wc.send(IPC.readerOpen, req)
    return
  }
  pending.push(req)
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
}

function openFile(path: string, source: ReaderOpenSource, agent: string | undefined, focus: boolean): ReaderActionResult {
  const checked = checkMarkdownFile(path)
  if ('error' in checked) {
    console.error(`[reader] refused open (${source}): ${checked.error}`)
    return { ok: false, error: checked.error }
  }
  if (dataRoot) {
    try {
      rememberRecent(dataRoot, checked.path)
    } catch (err) {
      console.error('[reader] could not update the recent list:', err)
    }
  }
  deliver(agent ? { path: checked.path, source, agent } : { path: checked.path, source })
  if (focus) focusWindow?.()
  return { ok: true }
}

/**
 * Show a markdown file in the Read view. The one route in — main's own entry
 * points and job C's terminal links and agent tools all call this.
 *
 * Validated (absolute, existing, markdown), added to the recent list, then sent
 * to the renderer if it is listening or queued until it asks. A 'windows' open
 * also brings the window forward, out of the tray if need be.
 */
export function openInReader(path: string, source: ReaderOpenSource, agent?: string): ReaderActionResult {
  return openFile(path, source, agent, source === 'windows')
}

/**
 * The markdown files on a command line — Forge.exe's own at a cold start, or a
 * second instance's — handed to the reader as 'windows' opens. Never focuses:
 * at a cold start there is no window yet, and the second-instance handler
 * brings the window forward itself. Returns how many were opened.
 */
export function openReaderArgv(argv: readonly string[], cwd: string): number {
  let opened = 0
  for (const path of markdownArgs(argv, cwd)) {
    if (openFile(path, 'windows', undefined, false).ok) opened++
  }
  return opened
}

/* ---------------------------------------------------------------- watching */

type FileWatch = {
  path: string
  handle: FSWatcher | null
  timer: NodeJS.Timeout | null
  /** The handle saw a rename (an editor replacing the file) and must be re-made. */
  rearm: boolean
  retries: number
}

const watches = new Map<string, FileWatch>()

function notifyChanged(path: string): void {
  const wc = target && !target.isDestroyed() ? target.webContents : null
  if (wc && !wc.isDestroyed()) wc.send(IPC.readerChanged, path)
}

function closeHandle(w: FileWatch): void {
  try {
    w.handle?.close()
  } catch {
    /* best effort */
  }
  w.handle = null
}

function arm(w: FileWatch): void {
  try {
    const handle = fsWatch(w.path, (event) => {
      if (event === 'rename') w.rearm = true
      bump(w)
    })
    handle.on('error', () => {
      w.rearm = true
      bump(w)
    })
    w.handle = handle
  } catch {
    w.rearm = true
  }
}

function bump(w: FileWatch): void {
  if (w.timer) clearTimeout(w.timer)
  w.timer = setTimeout(() => settle(w), WATCH_DEBOUNCE_MS)
}

/**
 * The debounced end of a burst. A rename means the file we were watching may
 * have been swapped for a new one, so the handle is re-made on whatever is at
 * the path now — waiting a little for it if the editor has not put it back yet.
 */
function settle(w: FileWatch): void {
  w.timer = null
  if (watches.get(samePathKey(w.path)) !== w) return
  if (w.rearm || !w.handle) {
    closeHandle(w)
    if (!existsSync(w.path)) {
      if (w.retries < REARM_RETRIES) {
        w.retries++
        w.timer = setTimeout(() => settle(w), REARM_RETRY_MS)
        return
      }
      // Gone for good. Say so once — the renderer's read will report it — and let go.
      watches.delete(samePathKey(w.path))
      notifyChanged(w.path)
      return
    }
    w.rearm = false
    w.retries = 0
    arm(w)
  }
  notifyChanged(w.path)
}

function watchFile(path: unknown): ReaderActionResult {
  const checked = checkMarkdownFile(path)
  if ('error' in checked) return { ok: false, error: checked.error }
  const key = samePathKey(checked.path)
  if (watches.has(key)) return { ok: true }
  if (watches.size >= MAX_WATCHES) return { ok: false, error: 'Too many files are being watched.' }
  const w: FileWatch = { path: checked.path, handle: null, timer: null, rearm: false, retries: 0 }
  watches.set(key, w)
  arm(w)
  return { ok: true }
}

function unwatchFile(path: unknown): void {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (!raw || !isAbsolute(raw)) return
  const key = samePathKey(resolve(raw))
  const w = watches.get(key)
  if (!w) return
  watches.delete(key)
  if (w.timer) clearTimeout(w.timer)
  closeHandle(w)
}

function unwatchAll(): void {
  for (const w of watches.values()) {
    if (w.timer) clearTimeout(w.timer)
    closeHandle(w)
  }
  watches.clear()
}

/* -------------------------------------------------------------- the window */

/**
 * The window the reader talks to. Its page is "not ready" from every fresh
 * navigation (a reload, a dev rebuild) or crash until it calls takePending
 * again, so an open that lands in that gap is queued rather than sent into a
 * page that has no listener yet. The old page's file watches go with it.
 */
export function setReaderTarget(win: BrowserWindow | null): void {
  target = win
  rendererReady = false
  unwatchAll()
  if (!win) return
  const wc: WebContents = win.webContents
  const unready = (): void => {
    if (target?.webContents !== wc) return
    rendererReady = false
    unwatchAll()
  }
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) unready()
  })
  wc.on('render-process-gone', unready)
}

/* ------------------------------------------------------------------- inbox */

let inboxWatcher: FSWatcher | null = null
let inboxTimer: NodeJS.Timeout | null = null

function inboxDir(): string {
  return join(dataRoot, READER_INBOX_DIR)
}

function drainInbox(): void {
  for (const path of takeInboxRequests(inboxDir())) openFile(path, 'windows', undefined, true)
}

/**
 * `Open in Forge.vbs`'s other end. Call once, after the window exists (a
 * 'windows' open brings it forward).
 *
 * Writes main's pid where the VBS looks for it, clears the VBS's launch stamp
 * (Forge is up now), takes whatever requests piled up while Forge was starting,
 * and watches the folder for the rest.
 */
export function startReaderInbox(): void {
  if (!dataRoot || inboxWatcher) return
  const dir = inboxDir()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, INBOX_PID_FILE), String(process.pid), 'utf8')
    if (existsSync(join(dir, INBOX_LAUNCH_STAMP))) unlinkSync(join(dir, INBOX_LAUNCH_STAMP))
  } catch (err) {
    console.error('[reader] could not set up the inbox:', err)
    return
  }
  drainInbox()
  try {
    inboxWatcher = fsWatch(dir, (_event, name) => {
      if (name && !String(name).toLowerCase().endsWith(INBOX_REQUEST_EXT)) return
      if (inboxTimer) clearTimeout(inboxTimer)
      inboxTimer = setTimeout(() => {
        inboxTimer = null
        drainInbox()
      }, 100)
    })
    inboxWatcher.on('error', (err) => console.error('[reader] inbox watch failed:', err))
  } catch (err) {
    console.error('[reader] could not watch the inbox:', err)
  }
}

/* ---------------------------------------------------------------- handlers */

function asSource(value: unknown): ReaderOpenSource {
  return SOURCES.includes(value as ReaderOpenSource) ? (value as ReaderOpenSource) : 'app'
}

/**
 * The reader's IPC. `openMainWindow` is main's own restore-show-focus, used
 * only by inbox opens — never before the window has been created, because
 * startReaderInbox is called after createWindow.
 */
export function registerReaderHandlers(opts: { dataRoot: string; openMainWindow: () => void }): void {
  dataRoot = opts.dataRoot
  focusWindow = opts.openMainWindow

  ipcMain.handle(IPC.readerList, (_e, root: unknown): ReaderEntry[] => listMarkdown(root))
  ipcMain.handle(IPC.readerRead, (_e, path: unknown) => readMarkdown(path))
  ipcMain.handle(IPC.readerWrite, (_e, path: unknown, text: unknown, baseHash: unknown) =>
    writeMarkdown(path, text, baseHash)
  )
  ipcMain.handle(IPC.readerWatch, (_e, path: unknown) => watchFile(path))
  ipcMain.on(IPC.readerUnwatch, (_e, path: unknown) => unwatchFile(path))
  ipcMain.handle(IPC.readerRecent, (): ReaderEntry[] => (dataRoot ? readRecent(dataRoot) : []))
  // The renderer asking for a file it found itself: no focus, it is in front.
  ipcMain.handle(IPC.readerOpenRequest, (_e, path: unknown, source: unknown) =>
    openFile(typeof path === 'string' ? path : '', asSource(source), undefined, false)
  )
  ipcMain.handle(IPC.readerResolve, (_e, text: unknown, baseDir: unknown) => resolveMarkdownRef(text, baseDir))
  ipcMain.handle(IPC.readerTakePending, (e): ReaderOpenRequest[] => {
    const wc = target && !target.isDestroyed() ? target.webContents : null
    if (!wc || e.sender !== wc) return []
    rendererReady = true
    return pending.splice(0)
  })
  // The file's folder, never the file: openPath is ShellExecute, and the same
  // existing-directory rule as IPC.openPath applies to what it is handed.
  ipcMain.handle(IPC.readerReveal, async (_e, path: unknown): Promise<ReaderActionResult> => {
    const raw = typeof path === 'string' ? path.trim() : ''
    if (!raw || !isAbsolute(raw)) return { ok: false, error: 'No file was named.' }
    const dir = dirname(resolve(raw))
    if (!statOf(dir)?.isDirectory()) {
      console.error(`[shell] refused reader reveal — not an existing directory: ${dir}`)
      return { ok: false, error: `Folder not found: ${dir}` }
    }
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true }
  })
}

export function disposeReader(): void {
  unwatchAll()
  if (inboxTimer) clearTimeout(inboxTimer)
  inboxTimer = null
  try {
    inboxWatcher?.close()
  } catch {
    /* best effort */
  }
  inboxWatcher = null
  // Only our own pid: a second copy that lost the lock never wrote one, and a
  // newer Forge may already have replaced it.
  if (!dataRoot) return
  const pidFile = join(inboxDir(), INBOX_PID_FILE)
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile)
  } catch {
    /* not there */
  }
}

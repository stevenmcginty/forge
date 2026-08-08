import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { IPC } from '@shared/ipc'
import { stripAnsi, tailLines } from '@shared/ansi'
import { isSlotIndex, shareStamp, SHARE_CAPTURE_DEFAULT_LINES, SHARE_CAPTURE_MAX_LINES } from '@shared/share'
import type { SharePane, ShareSlotBody, ShareSnapshot, ShareWriteRequest, ShareWriteResult } from '@shared/types'
import { ShareStore } from './share-store'
import { getProjects } from './store'

/**
 * The SHARE section's eyes on one project.
 *
 * Only the active project, only while the section is open, and nothing is pushed
 * that has not changed. Shaped after electron/git-watcher.ts on purpose — a
 * module-level single watch, a settle timer, a hard floor between reads, a
 * hash-deduped push and a monotonic `seq` — because a second watcher inventing
 * its own answers to the same five questions is how two panels start disagreeing
 * about how busy a folder is.
 *
 * Three deliberate differences from git-watcher, all for the same reason: a read
 * here is five small `readFileSync`s rather than a spawned process.
 *
 *   • No in-flight guard and no trailing re-read. Reads are synchronous, so a
 *     trigger cannot arrive during one. There is nothing to overlap.
 *   • The floor is 500ms rather than 700ms.
 *   • No busy→idle trigger. Git needs one because an agent's commit is invisible
 *     to a `.git` watcher until it lands; `fs.watch` on `.forge/share` sees every
 *     write there is. Do not add one.
 *
 * This module holds no knowledge of the slot *format* — that is shared/share.ts,
 * and the disk half is electron/share-store.ts, which takes a directory rather
 * than reaching for one so that scripts/share-check.mjs can drive it head-less.
 * What is left here is the part that needs an `ipcMain` and a `WebContents`, and
 * it is kept small because it is the part no check script can reach.
 */

/** One `share_write` produces a `.tmp` create, a rename and a directory touch. */
const SETTLE_MS = 200

/** The hard floor between reads. Lower than git's — see the header. */
const MIN_GAP_MS = 500

/**
 * The backstop, for the cases `fs.watch` does not cover: a project on a network
 * share, in OneDrive, or a notification simply dropped. Skipped entirely while
 * the window is blurred, same as git's.
 */
const POLL_MS = 20_000

const MAX_FAILURES = 3
const FAILURE_BACKOFF_MS = 60_000

/** Where main reads a pane's output from, injected rather than imported. */
export interface ShareDeps {
  /** electron/pty-host.ts `getReplay` — the catch-up buffer for one session. */
  replayFor: (paneId: string) => string
}

type ShareWatch = {
  projectId: string
  cwd: string
  store: ShareStore
  target: WebContents
  win: BrowserWindow | null
  handle: FSWatcher | null
  settle: NodeJS.Timeout | null
  tick: NodeJS.Timeout | null
  lastReadAt: number
  failures: number
  snap: ShareSnapshot | null
  /** The last snapshot actually pushed, hashed. See pushSnapshot. */
  hash: string
}

/** One watch at a time. The rail only ever looks at one project. */
let watch: ShareWatch | null = null

/** Monotonic across watches, so a snapshot can never appear to go backwards. */
let seq = 0

let deps: ShareDeps = { replayFor: () => '' }

function nextSeq(): number {
  seq += 1
  return seq
}

/* ------------------------------------------------------------------- reading */

/**
 * Everything a change would be visible in, and nothing that moves on its own.
 *
 * Previews are excluded, and that is not an oversight: a preview is a pure
 * function of the body, so `updatedAt` and `bytes` already cover every way it
 * could differ. Including them would double the size of the hash to detect
 * nothing extra.
 */
function hashOf(snap: ShareSnapshot): string {
  return JSON.stringify({
    presence: snap.presence,
    error: snap.error ?? '',
    excluded: snap.excluded,
    filled: snap.filled,
    slots: snap.slots.map(
      (s) => `${s.index}\0${s.filled ? 1 : 0}\0${s.title}\0${s.bytes}\0${s.updatedAt}\0${s.author}\0${s.via}\0${s.truncated ? 1 : 0}\0${s.problem ?? ''}`
    ),
    panes: snap.panes.map((p) => `${p.paneId}\0${p.title}\0${p.profileId}`)
  })
}

function snapshotOf(projectId: string, cwd: string, store: ShareStore): ShareSnapshot {
  const slots = store.list()
  return {
    projectId,
    seq: nextSeq(),
    at: Date.now(),
    presence: existsSync(cwd) ? 'ok' : 'no-folder',
    root: store.root,
    excluded: store.excluded(),
    filled: slots.filter((s) => s.filled).length,
    slots,
    panes: store.readRoster()
  }
}

function pushSnapshot(w: ShareWatch, snap: ShareSnapshot): void {
  w.snap = snap
  const hash = hashOf(snap)
  if (hash === w.hash) return
  w.hash = hash
  if (!w.target.isDestroyed()) w.target.send(IPC.shareSnapshot, snap)
}

/**
 * Take a read now.
 *
 * `ensureExcluded` rides along on every read rather than being done once at
 * setup: a folder becomes a repository the moment somebody runs `git init` in the
 * pane next door, and the exclude line has to catch up. One `existsSync` and one
 * small `readFileSync`.
 */
function read(w: ShareWatch): void {
  if (watch !== w) return
  try {
    w.store.ensureExcluded()
    pushSnapshot(w, snapshotOf(w.projectId, w.cwd, w.store))
    w.failures = 0
  } catch (err) {
    console.error('[share] read failed:', err)
    w.failures += 1
  } finally {
    w.lastReadAt = Date.now()
  }
}

/** Coalesce a burst into one read, never sooner than the floor allows. */
function schedule(w: ShareWatch, force = false): void {
  if (w.settle) return
  const gap = w.failures >= MAX_FAILURES && !force ? FAILURE_BACKOFF_MS : MIN_GAP_MS
  const wait = force ? SETTLE_MS : Math.max(SETTLE_MS, w.lastReadAt + gap - Date.now())
  w.settle = setTimeout(() => {
    w.settle = null
    read(w)
  }, wait)
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * One non-recursive handle on `.forge/share`.
 *
 * Non-recursive because there are no subdirectories in there and never will be —
 * five files, a README and a roster. The folder may not exist yet when a project
 * is first watched, in which case this quietly does nothing and the backstop tick
 * attaches once `ensure()` has made it.
 */
function attach(w: ShareWatch): void {
  if (w.handle || w.failures >= MAX_FAILURES) return
  if (!existsSync(w.store.root)) return
  try {
    const handle = fsWatch(w.store.root, () => {
      if (watch === w) schedule(w)
    })
    handle.on('error', () => detach(w))
    w.handle = handle
  } catch {
    // An unwatchable folder is not a reason to fail; the tick keeps reading.
  }
}

function detach(w: ShareWatch): void {
  try {
    w.handle?.close()
  } catch {
    /* best effort */
  }
  w.handle = null
}

function stop(): void {
  const w = watch
  watch = null
  if (!w) return
  detach(w)
  if (w.settle) clearTimeout(w.settle)
  if (w.tick) clearInterval(w.tick)
  w.settle = null
  w.tick = null
}

function start(projectId: string, cwd: string, target: WebContents): { ok: boolean; error?: string } {
  stop()

  const store = new ShareStore(cwd)
  // This is the moment `.forge/share` comes into existence — the first time the
  // section is opened for a project, and never before. Everything else in here
  // reads.
  const ensured = store.ensure()
  if (!ensured.ok) return { ok: false, error: ensured.error }

  const w: ShareWatch = {
    projectId,
    cwd,
    store,
    target,
    win: BrowserWindow.fromWebContents(target),
    handle: null,
    settle: null,
    tick: null,
    lastReadAt: 0,
    failures: 0,
    snap: null,
    hash: ''
  }
  watch = w

  /*
   * Blurred, the backstop does nothing at all: a window nobody is looking at has
   * no reason to re-read five files for an answer nobody is reading.
   */
  w.tick = setInterval(() => {
    if (watch !== w) return
    if (w.win && !w.win.isDestroyed() && !w.win.isFocused()) return
    const backedOff = w.failures >= MAX_FAILURES
    if (Date.now() - w.lastReadAt < (backedOff ? FAILURE_BACKOFF_MS : POLL_MS)) return
    attach(w)
    read(w)
  }, POLL_MS)

  attach(w)
  read(w)
  return { ok: true }
}

/* ----------------------------------------------------------- store on demand */

/** The folder for a project id, resolved against main's own list. Never a path from the renderer. */
function pathFor(projectId: string): string | null {
  return getProjects().find((p) => p.id === projectId)?.path ?? null
}

/**
 * A store for this project, watched or not.
 *
 * The live watch's store is reused when the ids match so the two cannot disagree
 * about anything cached; otherwise one is built from main's own project list. A
 * path from the renderer is never used, here or anywhere in this file.
 */
function storeFor(projectId: string): ShareStore | null {
  const id = String(projectId ?? '')
  if (!id) return null
  if (watch?.projectId === id) return watch.store
  const cwd = pathFor(id)
  if (!cwd) return null
  return new ShareStore(cwd)
}

/**
 * Fold a fresh read into the answer of whatever just wrote.
 *
 * The `fs.watch` handle would push one a moment later anyway, but "a moment
 * later" is the window in which a rail shows a pre-write answer, and on a network
 * share the notification may not arrive at all. Same rule as GitActionResult: a
 * write answers with the state it produced.
 */
function withSnapshot(projectId: string, result: ShareWriteResult): ShareWriteResult {
  const w = watch
  if (!w || w.projectId !== projectId) return result
  const snap = snapshotOf(w.projectId, w.cwd, w.store)
  w.lastReadAt = Date.now()
  pushSnapshot(w, snap)
  return { ...result, snapshot: snap }
}

/* -------------------------------------------------------------------- capture */

/**
 * A pane's output, from main's own replay buffer.
 *
 * The fallback path, and honestly the rough one: the replay buffer is a stream of
 * cursor-addressed redraws, so a full-screen agent's screen comes out of it in
 * the order it was painted rather than the order it appears. The renderer's own
 * capture reads xterm's parsed grid instead and is what almost every capture
 * uses; this exists for a pane restored into a session whose terminal this window
 * has never had. The rail says which one it is about to use.
 */
function captureText(paneId: string, lines: number): string {
  const raw = deps.replayFor(String(paneId ?? ''))
  if (!raw) return ''
  const want = Number.isFinite(lines) && lines > 0 ? Math.min(lines, SHARE_CAPTURE_MAX_LINES) : SHARE_CAPTURE_DEFAULT_LINES
  return tailLines(stripAnsi(raw), want)
}

/* ----------------------------------------------------------------- handlers */

export function registerShareHandlers(injected?: Partial<ShareDeps>): void {
  if (injected?.replayFor) deps = { replayFor: injected.replayFor }

  ipcMain.handle(IPC.shareWatch, (e, req: { projectId?: unknown; cwd?: unknown }) => {
    const projectId = String(req?.projectId ?? '')
    const cwd = String(req?.cwd ?? '')
    if (!projectId || !cwd) return { ok: false, error: 'a project and a folder are both required' }
    const started = start(projectId, cwd, e.sender)
    // The window going away must not leave a watcher pushing into a dead pipe.
    e.sender.once('destroyed', () => {
      if (watch?.target === e.sender) stop()
    })
    return started
  })

  ipcMain.on(IPC.shareUnwatch, (_e, projectId: string) => {
    if (watch?.projectId === String(projectId ?? '')) stop()
  })

  ipcMain.handle(IPC.shareRefresh, (_e, projectId: string): ShareSnapshot | null => {
    const id = String(projectId ?? '')
    const store = storeFor(id)
    if (!store) return null
    // Bypasses the floor on purpose: this is a person pressing a button, and a
    // button that silently does nothing for half a second is a broken button.
    const snap = snapshotOf(id, pathFor(id) ?? store.projectPath, store)
    if (watch?.projectId === id) {
      watch.lastReadAt = Date.now()
      pushSnapshot(watch, snap)
    }
    return snap
  })

  ipcMain.handle(IPC.shareRead, (_e, req: { projectId?: unknown; index?: unknown }): ShareSlotBody | null => {
    const store = storeFor(String(req?.projectId ?? ''))
    if (!store || !isSlotIndex(req?.index)) return null
    return store.read(req.index as number)
  })

  ipcMain.handle(IPC.shareWrite, (_e, req: ShareWriteRequest & { projectId?: unknown }): ShareWriteResult => {
    const projectId = String(req?.projectId ?? '')
    const store = storeFor(projectId)
    if (!store) return { ok: false, error: 'That project is not open in Forge any more.' }
    const result = store.write({
      index: req?.index as number,
      title: String(req?.title ?? ''),
      body: String(req?.body ?? ''),
      author: String(req?.author ?? ''),
      via: req?.via ?? 'rail',
      ...(req?.append ? { append: true } : {}),
      ...(typeof req?.expectUpdatedAt === 'number' ? { expectUpdatedAt: req.expectUpdatedAt } : {})
    })
    return withSnapshot(projectId, result)
  })

  ipcMain.handle(IPC.shareClear, (_e, req: { projectId?: unknown; index?: unknown }): ShareWriteResult => {
    const projectId = String(req?.projectId ?? '')
    const store = storeFor(projectId)
    if (!store) return { ok: false, error: 'That project is not open in Forge any more.' }
    return withSnapshot(projectId, store.clear(req?.index as number))
  })

  ipcMain.handle(
    IPC.shareCapture,
    (
      _e,
      req: { projectId?: unknown; index?: unknown; paneId?: unknown; lines?: unknown; title?: unknown; author?: unknown }
    ): ShareWriteResult => {
      const projectId = String(req?.projectId ?? '')
      const store = storeFor(projectId)
      if (!store) return { ok: false, error: 'That project is not open in Forge any more.' }

      const lines = Number(req?.lines ?? SHARE_CAPTURE_DEFAULT_LINES)
      const text = captureText(String(req?.paneId ?? ''), lines)
      if (!text) {
        return { ok: false, error: 'There is nothing in that pane’s buffer to capture yet.' }
      }
      const author = String(req?.author ?? '')
      const at = Date.now()
      const body = [
        `Captured from **${author || 'a pane'}** at ${shareStamp(at)}, last ${tailLines(text, lines).split('\n').length} lines.`,
        '',
        '```text',
        text,
        '```',
        ''
      ].join('\n')

      return withSnapshot(
        projectId,
        store.write({ index: req?.index as number, title: String(req?.title ?? ''), body, author, via: 'capture' }, at)
      )
    }
  )

  ipcMain.on(IPC.shareRoster, (_e, projectId: string, panes: SharePane[]) => {
    storeFor(String(projectId ?? ''))?.writeRoster(Array.isArray(panes) ? panes : [])
  })

  ipcMain.on(IPC.shareReveal, (_e, projectId: string, index: number | null) => {
    const store = storeFor(String(projectId ?? ''))
    if (!store) return
    if (isSlotIndex(index)) {
      const path = store.slotPath(index)
      if (path && existsSync(path)) {
        shell.showItemInFolder(path)
        return
      }
    }
    void shell.openPath(store.root)
  })
}

/** Called from before-quit, beside the other watchers. */
export function disposeShareWatchers(): void {
  stop()
}

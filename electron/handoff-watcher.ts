import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { IPC } from '@shared/ipc'
import { isHandoffId } from '@shared/handoff'
import type { HandoffBody, HandoffRecord, HandoffStartRequest } from '@shared/types'
import { handoffDir, handoffPath, listHandoffs, markHandoff, readHandoff, startHandoff } from './handoff-store'
import { getProjects } from './store'

/**
 * Forge's eyes on one project's handoff packs.
 *
 * Shaped after electron/share-watcher.ts on purpose — a module-level single
 * watch, a settle timer, a hard floor between reads, a hash-deduped push —
 * because a second watcher inventing its own answers to the same questions is
 * how two panels start disagreeing about whether a pack is ready.
 *
 * The one thing it does that the share watcher does not: it *promotes*. A pack
 * Forge created is `open`, and the moment its body stops being the template the
 * watcher writes `status: ready` into the header itself. That decision is made
 * here, once, in main — so the renderer only ever sees a status that is already
 * true on disk, and two windows cannot disagree about whether the take-over
 * button should light up.
 *
 * This module holds no knowledge of the pack *format* — that is shared/handoff.ts
 * — and none of the disk layout, which is electron/handoff-store.ts, taking a
 * directory rather than reaching for one so scripts/handoff-check.mjs can drive
 * it head-less. What is left here is the part that needs an `ipcMain` and a
 * `WebContents`, and it is kept small because it is the part no check can reach.
 */

/** One write produces a `.tmp` create, a rename and a directory touch. */
const SETTLE_MS = 200

/** The hard floor between reads. Same as the share watcher's, for the same reason. */
const MIN_GAP_MS = 500

/** The backstop, for a project on a network share or in OneDrive. Blurred, it does nothing. */
const POLL_MS = 20_000

const MAX_FAILURES = 3
const FAILURE_BACKOFF_MS = 60_000

/** Where a project id becomes a folder. Injected so a check can drive this head-less. */
export interface HandoffDeps {
  pathFor: (projectId: string) => string | null
}

let deps: HandoffDeps = {
  pathFor: (projectId) => getProjects().find((p) => p.id === projectId)?.path ?? null
}

type HandoffWatch = {
  projectId: string
  cwd: string
  target: WebContents
  win: BrowserWindow | null
  handle: FSWatcher | null
  settle: NodeJS.Timeout | null
  tick: NodeJS.Timeout | null
  lastReadAt: number
  failures: number
  /** The last list actually pushed, hashed. See push. */
  hash: string
}

/** One watch at a time. A pane only ever hands off inside its own project. */
let watch: HandoffWatch | null = null

/* ------------------------------------------------------------------- reading */

/** Everything a change would be visible in, and nothing that moves on its own. */
function hashOf(records: HandoffRecord[]): string {
  return JSON.stringify(
    records.map(
      (r) =>
        `${r.id}\0${r.status}\0${r.title}\0${r.filled ? 1 : 0}\0${r.bytes}\0${r.updatedAt}\0${r.to}\0${r.toAgent}\0${r.toTitle}\0${r.origin}`
    )
  )
}

/**
 * The list, with `open → ready` settled first.
 *
 * The promotion is a *write*, which is why it happens here and not in the
 * renderer: the file is the truth, so a pack that is ready has to say so in its
 * own header, or the next process to read it would disagree with the window that
 * decided it.
 */
function collect(cwd: string): HandoffRecord[] {
  const records = listHandoffs(cwd)
  let promoted = false
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as HandoffRecord
    if (r.status !== 'open' || !r.filled) continue
    const next = markHandoff(cwd, r.id, { status: 'ready' })
    if (next) {
      records[i] = next
      promoted = true
    }
  }
  // The promotion rewrote a header, which changed an `updatedAt` the list above
  // was read before. Re-reading is cheaper than reasoning about which fields the
  // rewrite touched.
  return promoted ? listHandoffs(cwd) : records
}

function push(w: HandoffWatch, records: HandoffRecord[]): void {
  const hash = hashOf(records)
  if (hash === w.hash) return
  w.hash = hash
  if (!w.target.isDestroyed()) w.target.send(IPC.handoffChanged, w.projectId, records)
}

function read(w: HandoffWatch): void {
  if (watch !== w) return
  try {
    push(w, collect(w.cwd))
    w.failures = 0
  } catch (err) {
    console.error('[handoff] read failed:', err)
    w.failures += 1
  } finally {
    w.lastReadAt = Date.now()
  }
}

/** Coalesce a burst into one read, never sooner than the floor allows. */
function schedule(w: HandoffWatch, force = false): void {
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
 * One non-recursive handle on `.forge/handoff`.
 *
 * Non-recursive because there are no subdirectories in there and never will be —
 * one flat file per handoff. The folder may not exist until the first pack is
 * started, in which case this quietly does nothing and the backstop tick attaches
 * once there is something to attach to.
 */
function attach(w: HandoffWatch): void {
  if (w.handle || w.failures >= MAX_FAILURES) return
  const dir = handoffDir(w.cwd)
  if (!existsSync(dir)) return
  try {
    const handle = fsWatch(dir, () => {
      if (watch === w) schedule(w)
    })
    handle.on('error', () => detach(w))
    w.handle = handle
  } catch {
    // An unwatchable folder is not a reason to fail; the tick keeps reading.
  }
}

function detach(w: HandoffWatch): void {
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

function start(projectId: string, target: WebContents): { ok: boolean; error?: string } {
  const cwd = deps.pathFor(projectId)
  if (!cwd) return { ok: false, error: 'That project is not open in Forge any more.' }

  stop()

  const w: HandoffWatch = {
    projectId,
    cwd,
    target,
    win: BrowserWindow.fromWebContents(target),
    handle: null,
    settle: null,
    tick: null,
    lastReadAt: 0,
    failures: 0,
    hash: ''
  }
  watch = w

  // Blurred, the backstop does nothing at all: a window nobody is looking at has
  // no reason to re-read a folder for an answer nobody is reading.
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

/**
 * Fold a fresh read into the answer of whatever just wrote.
 *
 * The `fs.watch` handle would push one a moment later anyway, but "a moment
 * later" is the window in which a pane shows a pre-write answer, and on a network
 * share the notification may not arrive at all.
 */
function repush(projectId: string): void {
  const w = watch
  if (!w || w.projectId !== projectId) return
  w.lastReadAt = Date.now()
  push(w, collect(w.cwd))
}

/** The folder for a project id, resolved against main's own list. Never a path from the renderer. */
function pathFor(projectId: string): string | null {
  const id = String(projectId ?? '')
  if (!id) return null
  return deps.pathFor(id)
}

/* ----------------------------------------------------------------- handlers */

export function registerHandoffHandlers(injected?: Partial<HandoffDeps>): void {
  if (injected?.pathFor) deps = { pathFor: injected.pathFor }

  ipcMain.handle(IPC.handoffStart, (_e, projectId: string, req: HandoffStartRequest): HandoffRecord | null => {
    const cwd = pathFor(projectId)
    if (!cwd) return null
    const record = startHandoff(cwd, req ?? {})
    if (record) repush(String(projectId ?? ''))
    return record
  })

  ipcMain.handle(IPC.handoffList, (_e, projectId: string): HandoffRecord[] => {
    const cwd = pathFor(projectId)
    if (!cwd) return []
    return collect(cwd)
  })

  ipcMain.handle(IPC.handoffRead, (_e, projectId: string, id: string): HandoffBody | null => {
    const cwd = pathFor(projectId)
    if (!cwd || !isHandoffId(id)) return null
    return readHandoff(cwd, id)
  })

  ipcMain.handle(
    IPC.handoffMark,
    (
      _e,
      projectId: string,
      id: string,
      patch: Partial<Pick<HandoffRecord, 'status' | 'to' | 'toAgent' | 'toTitle'>>
    ): HandoffRecord | null => {
      const cwd = pathFor(projectId)
      if (!cwd || !isHandoffId(id)) return null
      const record = markHandoff(cwd, id, patch ?? {})
      if (record) repush(String(projectId ?? ''))
      return record
    }
  )

  ipcMain.handle(IPC.handoffWatch, (e, projectId: string) => {
    const started = start(String(projectId ?? ''), e.sender)
    // The window going away must not leave a watcher pushing into a dead pipe.
    e.sender.once('destroyed', () => {
      if (watch?.target === e.sender) stop()
    })
    return started
  })

  ipcMain.on(IPC.handoffUnwatch, (_e, projectId: string) => {
    if (watch?.projectId === String(projectId ?? '')) stop()
  })

  ipcMain.on(IPC.handoffReveal, (_e, projectId: string, id: string | null) => {
    const cwd = pathFor(projectId)
    if (!cwd) return
    if (isHandoffId(id)) {
      const path = handoffPath(cwd, id)
      if (path && existsSync(path)) {
        shell.showItemInFolder(path)
        return
      }
    }
    void shell.openPath(handoffDir(cwd))
  })
}

/** Called from before-quit, beside the other watchers. */
export function disposeHandoffWatchers(): void {
  stop()
}

import { watch as watchFs, type FSWatcher } from 'node:fs'
import { ipcMain, type WebContents } from 'electron'
import {
  ACTIVITY_PUSH_MS,
  ACTIVITY_SETTLE_MS,
  ACTIVITY_TAIL_BYTES,
  activityEntries,
  attribute,
  brakeDrops,
  newActivityStore,
  newBurstBrake,
  recordActivity,
  relativeTo,
  shouldIgnorePath,
  sweepActivity,
  transcriptTouches,
  type ActivityBusySpan,
  type ActivityStore,
  type BurstBrake
} from '@shared/activity'
import { IPC } from '@shared/ipc'
import { isSessionId } from '@shared/session'
import type { ActivityEntry, ActivityPane, ActivitySnapshot } from '@shared/types'
import { transcriptPath } from './bridge/claude-transcripts'
import { createTail, type Tail } from './jsonl-tail'

/**
 * Which agent is touching which file.
 *
 * Two halves that meet in one map, because no single mechanism can answer this
 * for every agent Forge runs.
 *
 * **Exact.** Claude Code keeps a transcript for every session at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and its `tool_use`
 * records name the file each Edit, Write, NotebookEdit or Read touched. Because
 * a tail is opened per `(paneId, sessionId)`, the pane and the path come out of
 * the same record — attribution is exact by construction rather than by
 * matching, and there is nothing to get wrong.
 *
 * **Inferred.** No other agent writes a transcript Forge can read, and a `Bash`
 * running `sed -i` is invisible even in Claude's. So the project folder is
 * watched, and a change is credited to whichever pane was working at that
 * instant. Three outcomes, and the last two matter more than the first:
 *
 *   - exactly one pane busy → credit it, marked inferred;
 *   - more than one busy → credit *nobody*. An ambiguous attribution is worse
 *     than an honest blank, because it looks exactly like a certain one;
 *   - none busy → drop the event. That is Steve saving a file in VS Code, and
 *     it is not agent activity.
 *
 * Main cannot see a terminal's output and the renderer cannot see the
 * filesystem, which is why `activity:busy` exists: each side tells the other the
 * half it alone knows.
 *
 * **Why this section defaults off.** It is the only part of Forge that watches a
 * project folder on its own initiative. Two independent defences keep that
 * affordable — an ignore list for the paths that are never interesting
 * (node_modules, .git, build output) and a burst brake for the load, because
 * fifty thousand ignored events still cost fifty thousand callbacks. The real
 * third defence is that nothing starts until the section is both enabled and
 * open.
 *
 * The rules themselves — the ignore list, the attribution outcomes, the brake,
 * exact-beats-inferred, the cap and the TTL — all live in shared/activity.ts,
 * pure and without a single Node import, so scripts/activity-check.mjs can drive
 * them directly. What is left in this file is wiring: handles, timers, and the
 * one map they all write into.
 */

/** One tail, following one pane's conversation. */
type PaneTail = {
  sessionId: string
  profileId: string
  tail: Tail
  /** Assistant messages already counted, so a re-read cannot double a file's hits. */
  seen: Set<string>
}

type ActivityWatch = {
  projectId: string
  cwd: string
  target: WebContents
  panes: ActivityPane[]
  /** Keyed by pane id. */
  tails: Map<string, PaneTail>
  folder: FSWatcher | null
  store: ActivityStore
  /** When each pane was last working, fed by the renderer over `activity:busy`. */
  busy: Map<string, ActivityBusySpan>
  /** Per-path coalescing of the two or three events one save produces. */
  settling: Map<string, NodeJS.Timeout>
  brake: BurstBrake
  stormy: boolean
  seq: number
  push: NodeJS.Timeout | null
  /**
   * The one push that takes the storm notice back down. Its own timer rather
   * than the throttle's, or an exact edit arriving mid-install would wait behind
   * a ten-second timer to be shown.
   */
  stormClear: NodeJS.Timeout | null
}

/** One watch at a time — the rail only ever looks at one project. */
let watch: ActivityWatch | null = null

/* ------------------------------------------------------------------- handlers */

export function registerActivityHandlers(): void {
  ipcMain.handle(IPC.activityWatch, (e, req: { projectId?: unknown; cwd?: unknown; panes?: unknown }) => {
    const projectId = String(req?.projectId ?? '')
    const cwd = String(req?.cwd ?? '')
    if (!projectId || !cwd) return { ok: false, error: 'a project and a folder are both required' }
    const panes = readPanes(req?.panes)
    /*
     * Replace the pane list, keep the watch. A split or a closed tab re-calls
     * this, and starting over would wipe a tree that is telling the truth.
     */
    if (watch && watch.projectId === projectId && watch.target === e.sender) {
      watch.panes = panes
      syncTails(watch)
      return { ok: true }
    }
    stop()
    watch = {
      projectId,
      cwd,
      target: e.sender,
      panes,
      tails: new Map(),
      folder: null,
      store: newActivityStore(),
      busy: new Map(),
      settling: new Map(),
      brake: newBurstBrake(),
      stormy: false,
      seq: 0,
      push: null,
      stormClear: null
    }
    syncTails(watch)
    attachFolder(watch)
    e.sender.once('destroyed', () => {
      if (watch?.target === e.sender) stop()
    })
    return { ok: true }
  })

  ipcMain.on(IPC.activityUnwatch, (_e, projectId: string) => {
    if (watch?.projectId === String(projectId ?? '')) stop()
  })

  /*
   * A busy edge. Recorded rather than acted on: the change this pane is about to
   * cause has not landed yet, and the whole point of keeping spans is that a
   * write arriving after the spinner stops can still be credited (ATTRIB_GRACE_MS).
   */
  ipcMain.on(IPC.activityBusy, (_e, projectId: string, paneId: string, busy: boolean) => {
    const w = watch
    if (!w || w.projectId !== String(projectId ?? '')) return
    const id = String(paneId ?? '')
    if (!id) return
    const now = Date.now()
    if (busy) {
      w.busy.set(id, { since: now, until: null })
      return
    }
    const span = w.busy.get(id)
    if (span) span.until = now
    else w.busy.set(id, { since: now, until: now })
  })

  ipcMain.on(IPC.activityClear, (_e, projectId: string) => {
    const w = watch
    if (!w || w.projectId !== String(projectId ?? '')) return
    w.store = newActivityStore()
    pushNow(w)
  })
}

export function disposeActivityWatchers(): void {
  stop()
}

function stop(): void {
  const w = watch
  watch = null
  if (!w) return
  for (const pane of w.tails.values()) pane.tail.stop()
  w.tails.clear()
  try {
    w.folder?.close()
  } catch {
    /* best effort */
  }
  w.folder = null
  for (const timer of w.settling.values()) clearTimeout(timer)
  w.settling.clear()
  if (w.push) clearTimeout(w.push)
  w.push = null
  if (w.stormClear) clearTimeout(w.stormClear)
  w.stormClear = null
}

function readPanes(value: unknown): ActivityPane[] {
  if (!Array.isArray(value)) return []
  const out: ActivityPane[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as { paneId?: unknown; profileId?: unknown; sessionId?: unknown }
    const paneId = String(p.paneId ?? '').trim()
    if (!paneId) continue
    const pane: ActivityPane = { paneId, profileId: String(p.profileId ?? '').trim() }
    // Anything that is not a real UUID could not name a transcript Claude Code
    // wrote, so it is dropped rather than turned into a path — the same rule the
    // planner watcher applies for the same reason.
    if (isSessionId(p.sessionId)) pane.sessionId = p.sessionId
    out.push(pane)
  }
  return out
}

/* ----------------------------------------------------------------- the exact half */

/**
 * Bring the set of open tails in line with the pane list.
 *
 * Diffed rather than rebuilt. A tail that is already following a pane's
 * transcript holds an offset and a set of counted uuids; dropping and reopening
 * it on every split would re-read the last half-megabyte and count every edit in
 * it a second time.
 */
function syncTails(w: ActivityWatch): void {
  const wanted = new Map<string, ActivityPane>()
  for (const pane of w.panes) {
    if (pane.sessionId) wanted.set(pane.paneId, pane)
  }

  for (const [paneId, open] of w.tails) {
    const pane = wanted.get(paneId)
    if (pane && pane.sessionId === open.sessionId) {
      open.profileId = pane.profileId
      continue
    }
    open.tail.stop()
    w.tails.delete(paneId)
  }

  for (const [paneId, pane] of wanted) {
    if (w.tails.has(paneId)) continue
    const seen = new Set<string>()
    const entry: PaneTail = {
      sessionId: pane.sessionId as string,
      profileId: pane.profileId,
      seen,
      tail: createTail({
        file: transcriptPath(w.cwd, pane.sessionId as string),
        label: 'activity',
        // The recent past, not the whole conversation. A pane that has been
        // going all week has a transcript hundreds of megabytes long, and every
        // edit in it older than the TTL would be swept the moment it arrived.
        initialTailBytes: ACTIVITY_TAIL_BYTES,
        onLine: (line) => onTranscriptLine(w, paneId, line)
      })
    }
    w.tails.set(paneId, entry)
    entry.tail.start()
  }
}

function onTranscriptLine(w: ActivityWatch, paneId: string, line: string): void {
  if (watch !== w) return
  const pane = w.tails.get(paneId)
  if (!pane) return

  for (const touch of transcriptTouches(line, pane.seen)) {
    const rel = relativeTo(w.cwd, touch.path)
    // Outside the project, or somewhere the tree never shows. An agent reading
    // its own config in ~/.claude is a real thing and is not this project's
    // activity.
    if (!rel || shouldIgnorePath(rel)) continue
    record(w, {
      path: rel,
      absPath: touch.path,
      paneId,
      profileId: pane.profileId,
      exactness: 'exact',
      kind: touch.kind,
      at: touch.at,
      hits: 1
    })
  }
}

/* -------------------------------------------------------------- the inferred half */

/**
 * One recursive handle for the whole project, not one per folder.
 *
 * Windows supports recursion natively through ReadDirectoryChangesW, which is
 * the only reason this is affordable: a project with two thousand folders costs
 * one handle rather than two thousand. The cost lands instead on the callback
 * rate, which is what the brake is for.
 */
function attachFolder(w: ActivityWatch): void {
  try {
    w.folder = watchFs(w.cwd, { recursive: true }, (_event, filename) => {
      if (watch !== w || !filename) return
      onFileEvent(w, String(filename))
    })
    w.folder.on('error', () => {
      // The folder went away, or the OS refused to keep watching it. The exact
      // half carries on regardless; there is nothing useful to retry here, and a
      // re-attach loop on a deleted folder is worse than a quiet stop.
      try {
        w.folder?.close()
      } catch {
        /* best effort */
      }
      w.folder = null
    })
  } catch {
    // A folder that is gone, or a filesystem with no recursive watch (a network
    // share). Not an error worth showing: the exact half still answers for every
    // Claude pane, which is most of what the panel is for.
    w.folder = null
  }
}

function onFileEvent(w: ActivityWatch, filename: string): void {
  const now = Date.now()
  if (brakeDrops(w.brake, now)) {
    if (w.brake.until > now) {
      // Drop the *whole* bucket, not just this event: half of a checkout
      // attributed to whoever happened to be working is a worse answer than
      // saying plainly that too much moved at once.
      for (const timer of w.settling.values()) clearTimeout(timer)
      w.settling.clear()
      schedulePush(w)
    }
    return
  }

  const rel = filename.replace(/\\/g, '/')
  if (shouldIgnorePath(rel)) return

  // Coalesce per path, and settle on the *first* instant of the burst: that is
  // when the write started, and it is the instant the busy spans should be asked
  // about. A save that takes 300ms must not be credited to a pane that only
  // started working halfway through it — which is what asking at the end would
  // do. So later events in the same window are dropped rather than resetting it.
  if (w.settling.has(rel)) return
  w.settling.set(
    rel,
    setTimeout(() => {
      w.settling.delete(rel)
      if (watch !== w) return
      settleFileEvent(w, rel, now)
    }, ACTIVITY_SETTLE_MS)
  )
}

function settleFileEvent(w: ActivityWatch, rel: string, at: number): void {
  // Claude panes are eligible for inference too — that is the `Bash`-edit case —
  // but only for a path no transcript has claimed. Guessing about a file we
  // already know the truth about can only make the answer worse.
  if (w.store.exact.has(rel.toLowerCase())) return

  const paneId = attribute(w.busy, at)
  if (paneId === null) return

  record(w, {
    path: rel,
    absPath: joinProject(w.cwd, rel),
    paneId,
    profileId: paneId ? profileOf(w, paneId) : '',
    exactness: 'inferred',
    // fs.watch cannot tell a create from a modify from a delete with any
    // reliability, so it says the honest thing: this file changed.
    kind: 'edit',
    at,
    hits: 1
  })
}

function profileOf(w: ActivityWatch, paneId: string): string {
  return w.panes.find((p) => p.paneId === paneId)?.profileId ?? ''
}

/** Absolute, backslashes — the form a drag onto a pane has to hand over. */
function joinProject(cwd: string, rel: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`
}

/* -------------------------------------------------------------------- pushing */

function record(w: ActivityWatch, entry: ActivityEntry): void {
  recordActivity(w.store, entry)
  schedulePush(w)
}

/**
 * Two snapshots a second at most, each carrying the whole tree.
 *
 * Deltas would be smaller and very much easier to get wrong — a dropped or
 * reordered one leaves the panel quietly showing something that was true a
 * minute ago. Four hundred small objects twice a second is nothing next to that.
 */
function schedulePush(w: ActivityWatch): void {
  if (w.push) return
  w.push = setTimeout(() => {
    w.push = null
    if (watch !== w) return
    pushNow(w)
  }, ACTIVITY_PUSH_MS)
}

function pushNow(w: ActivityWatch): void {
  const now = Date.now()
  sweepActivity(w.store, now)
  // Derived rather than remembered, so it clears itself: a flag set when the
  // brake tripped and cleared by the next event would stay on for ever after a
  // storm that nothing followed.
  w.stormy = w.brake.until > now

  const entries = activityEntries(w.store)
  w.seq += 1
  const snapshot: ActivitySnapshot = {
    projectId: w.projectId,
    seq: w.seq,
    entries,
    hasInferred: entries.some((e) => e.exactness === 'inferred'),
    truncated: w.store.truncated,
    stormy: w.stormy
  }
  if (!w.target.isDestroyed()) w.target.send(IPC.activityUpdate, snapshot)

  // And one more push when the cooldown lapses, so the "too many changes" strip
  // comes down even if the folder then goes completely quiet.
  if (w.stormy && !w.stormClear) {
    w.stormClear = setTimeout(
      () => {
        w.stormClear = null
        if (watch === w) pushNow(w)
      },
      w.brake.until - now + 50
    )
  }
}

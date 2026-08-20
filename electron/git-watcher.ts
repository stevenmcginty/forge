import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  GhState,
  GitActionRequest,
  GitActionResult,
  GitBranch,
  GitBranchCompare,
  GitSnapshot
} from '@shared/types'
import { ghOpenPrs, ghState, GH_POLL_MIN_GAP_MS, invalidateGhCaches } from './git/gh'
import { runGitAction } from './git/git-actions'
import { GIT_NET_TIMEOUT_MS, invalidateGitAvailable, runGit } from './git/git-run'
import { GH_UNKNOWN, GIT_MAX_BRANCHES, readStatus } from './git/git-status'
import { FOR_EACH_REF_FORMAT, parseForEachRef } from './git/porcelain'
import { getProjects, getSettings } from './store'
import { configureShelf, disposeShelf, flushShelves, noteBusy } from './git/git-shelf'

/**
 * The GIT section's eyes on one project.
 *
 * **The rule this module exists to keep**, stated before the mechanisms so they
 * can be read as consequences of it:
 *
 *   Only the active project is watched, and only while the section is switched
 *   on. Forge never fetches on a timer. Every other trigger is an event.
 *
 * The renderer calls `watch` from an effect keyed on the active project and on
 * whether the section is both enabled and open, so collapsing the section stops
 * every timer and closes every handle rather than merely hiding the panel. That
 * is also how main learns something the IPC surface has no field for: "open" is
 * expressed by watching, and "closed" by not.
 *
 * The triggers, and why there are five rather than one:
 *
 *  1. `fs.watch` on the *resolved* git directory. Two handles — the directory
 *     itself, which catches HEAD, index, MERGE_HEAD, FETCH_HEAD and packed-refs,
 *     and refs/heads for branch create and delete. Resolved, because `.git` is a
 *     file rather than a folder in a submodule or a linked worktree, and a
 *     watcher pointed at `<cwd>/.git` simply never fires for those.
 *
 *  2. A pane going busy → idle, pushed from the renderer as an explicit refresh.
 *     This is the one that matters most and the one a filesystem watcher cannot
 *     do: an agent editing the working tree touches nothing inside `.git`, so
 *     nothing above sees it. But the moment an agent *stops* is exactly when the
 *     answer changed and exactly when Steve looks at the rail. Forge therefore
 *     polls the work tree zero times and still updates within a second of an
 *     agent finishing.
 *
 *  3. Window focus, throttled — the same shape as watchFocusForSourceUpdate.
 *
 *  4. The refresh button, which ignores every throttle and invalidates the
 *     cached "is git installed" and "is gh logged in" answers.
 *
 *  5. A slow backstop tick, and only while the window is focused. This exists
 *     for what `fs.watch` cannot serve — network shares, OneDrive, an OS that
 *     quietly dropped a notification — which is why it has to exist even though
 *     it is the slow path.
 *
 * Fetching is never automatic on a timer. Ahead/behind is measured against the
 * remote-tracking ref as last fetched, and `fetchedAt` is on the snapshot so the
 * UI can say "fetched 6m ago" rather than presenting a stale number as current.
 * There is exactly one automatic fetch: when a project first becomes the watched
 * one and nothing has fetched it for ten minutes.
 *
 * **Nothing is pushed that has not changed.** The snapshot is hashed without its
 * sequence number, its timestamp or its fetch time, and an identical hash is
 * dropped on the floor. An idle project therefore produces no IPC traffic at all
 * while the backstop ticks behind it — which is the difference between a
 * background feature and a background nuisance.
 */

/** Coalesce the burst one git operation produces: index.lock, index, unlink. */
const SETTLE_MS = 250

/**
 * The hard floor between two reads of one project, whatever asked for them.
 *
 * Worst case during a rebase is roughly one and a half reads a second rather
 * than thirty. A trigger that arrives inside the floor is not dropped — it sets
 * a flag and gets one trailing read when the floor lifts, so the last event in a
 * burst is always the one the panel ends up showing.
 */
const MIN_GAP_MS = 700

/** The same floor on a repository that has already proved slow once. */
const SLOW_MIN_GAP_MS = 3_000

/** The backstop, for filesystems whose notifications cannot be trusted. */
const STATUS_POLL_MS = 15_000

/** And the backstop on a slow repository, where a read is the expensive thing. */
const SLOW_POLL_MS = 60_000

/** A focus-triggered read, at most this often. */
const FOCUS_MIN_GAP_MS = 5_000

/** Older than this and a project becoming active is worth one fetch. */
const FETCH_STALE_MS = 10 * 60 * 1000

/**
 * Consecutive failures before the watcher stops trying so often.
 *
 * The case this is written for is the project folder being deleted, renamed or
 * unmounted while Forge is looking at it: the handles die, every read fails, and
 * without a limit the tick re-attaches watchers to a path that is not there
 * several times a minute for as long as the app is open.
 */
const MAX_FAILURES = 3
const FAILURE_BACKOFF_MS = 60_000

/** What asked for a read. gh is only allowed to be asked by some of them. */
type Trigger = 'watch' | 'fs' | 'focus' | 'refresh' | 'tick'

type GitWatch = {
  projectId: string
  cwd: string
  target: WebContents
  win: BrowserWindow | null
  onFocus: (() => void) | null
  /** The resolved git directory, and refs/heads inside it. */
  handles: FSWatcher[]
  gitDir: string | null
  settle: NodeJS.Timeout | null
  tick: NodeJS.Timeout | null
  /** The strongest trigger waiting for the settle or the floor to lift. */
  queued: Trigger | null
  reading: boolean
  /** A trigger arrived mid-read: take exactly one more read afterwards. */
  trailing: boolean
  lastReadAt: number
  lastFocusAt: number
  failures: number
  snap: GitSnapshot | null
  /** The last snapshot actually pushed, hashed. See pushSnapshot. */
  hash: string
  /** When gh was last asked about this project. */
  ghAt: number
  /** The branch as of the last read, so a change can invalidate the PR data. */
  lastBranch: string | null
  fetched: boolean
}

/** One watch at a time. The rail only ever looks at one project. */
let watch: GitWatch | null = null

/** Monotonic across watches, so a snapshot can never appear to go backwards. */
let seq = 0

function nextSeq(): number {
  seq += 1
  return seq
}

/* --------------------------------------------------------------------- sinks */

/**
 * A second consumer of git snapshots — the browser client, when it arrives.
 *
 * Deliberately the same shape pty-host.ts gives terminal output, and for the
 * same reason: the phone sees the bytes the window sees because it rides the
 * window's own flush rather than opening a second route to the data. A sink
 * here sees the snapshots the panel sees, after the same suppression, stamped
 * with the same sequence number — so a second host cannot disagree with the
 * window about what the repository is doing, because it is being told by the
 * same sentence.
 *
 * Narrow on purpose: a sink is shown snapshots and nothing else. Watching,
 * refreshing and acting are ordinary exported functions below, which is what a
 * second host calls; it does not get to pretend to be a window.
 */
export interface GitSink {
  onSnapshot: (snapshot: GitSnapshot) => void
}

const sinks = new Set<GitSink>()

/** Register a sink. Returns the unsubscribe, in the repo's usual shape. */
export function addGitSink(sink: GitSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/* ------------------------------------------------------------------- reading */

/**
 * Everything a change would be visible in, and nothing that changes on its own.
 *
 * `seq` and `at` move on every read by construction, and `fetchedAt` moves
 * whenever anything in any pane fetches — none of the three is a reason to
 * repaint the panel, and including them would defeat the whole suppression.
 *
 * The field delimiter is a NUL, and it is written `\0` rather than pasted in as
 * the character itself. NUL is the right separator because it is the one byte a
 * branch name, a path or a status code cannot contain — it is what git's own
 * `--porcelain -z` separates records with. But a source file holding a raw NUL
 * is a *binary* file as far as git is concerned, and this one arrived in its own
 * commit as `Bin 0 -> 21962 bytes`: no diff, nothing to review, nothing to merge
 * by hand. The escape builds a byte-identical string and leaves the file
 * readable to the tools it is written for.
 */
function hashOf(snap: GitSnapshot): string {
  return JSON.stringify({
    presence: snap.presence,
    error: snap.error ?? '',
    branch: snap.branch,
    detached: snap.detached,
    unborn: snap.unborn,
    head: snap.head,
    upstream: snap.upstream,
    ahead: snap.ahead,
    behind: snap.behind,
    state: snap.state,
    remoteUrl: snap.remoteUrl,
    changed: snap.changed,
    staged: snap.staged,
    conflicted: snap.conflicted,
    truncated: snap.filesTruncated,
    files: snap.files.map((f) => `${f.xy}\0${f.path}`),
    branches: snap.branches.map((b) => `${b.name}\0${b.state}\0${b.ahead}\0${b.behind}\0${b.pr?.number ?? ''}`),
    gh: `${snap.gh.status}\0${snap.gh.login ?? ''}\0${snap.gh.currentPr?.number ?? ''}`,
    slow: snap.slow
  })
}

function pushSnapshot(w: GitWatch, snap: GitSnapshot): void {
  w.snap = snap
  const hash = hashOf(snap)
  if (hash === w.hash) return
  w.hash = hash
  if (!w.target.isDestroyed()) w.target.send(IPC.gitSnapshot, snap)
  /*
   * The sinks ride this push. They get no timer, no watch and no route to git
   * of their own — everything above this line decided *whether* there is
   * anything to say, and a second consumer that asked git itself would be a
   * second answer able to disagree with the panel.
   *
   * Each is isolated, the same way pty-host isolates its own: the window has
   * already been sent the snapshot by the time we are here, and one consumer
   * throwing must not stop the next one being told either.
   */
  for (const sink of sinks) {
    try {
      sink.onSnapshot(snap)
    } catch (err) {
      console.error('[git] sink failed:', err)
    }
  }
}

/** May this trigger spend a network round trip on gh? */
function ghAllowed(trigger: Trigger, branchChanged: boolean): boolean {
  if (trigger === 'fs') return branchChanged
  return trigger !== 'tick'
}

/**
 * Ask gh what GitHub knows, and fold it into the snapshot.
 *
 * Deliberately never able to fail the read it is attached to: gh being absent,
 * signed out, rate-limited or simply slow all leave the git half exactly as it
 * was. The rail's job is to work without GitHub, and this is where that promise
 * is either kept or quietly broken.
 */
async function withGh(w: GitWatch, snap: GitSnapshot): Promise<GitSnapshot> {
  const gh = await ghState(w.cwd, snap.slug, snap.branch)
  w.ghAt = Date.now()
  if (gh.status !== 'ready') return { ...snap, gh }

  const open = await ghOpenPrs(w.cwd)
  if (open.length === 0) return { ...snap, gh }

  const byBranch = new Map(open.map((pr) => [pr.headRefName, pr]))
  const branches = snap.branches.map((b) => {
    const pr = byBranch.get(b.name)
    return pr ? { ...b, pr } : b
  })
  return { ...snap, gh, branches }
}

/**
 * Where is this repository's git directory really?
 *
 * Asked once per watch, and only so the filesystem handles can be pointed at the
 * right folder. `.git` is a file containing `gitdir: …` in a submodule or a
 * linked worktree, and a watcher on `<cwd>/.git` in either of those never fires
 * at all — the project would then only ever update on the backstop, which looks
 * exactly like the feature being broken for that one project.
 */
async function resolveGitDir(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])
  if (!r.ok) return null
  const raw = r.out.trim().split(/\r?\n/)[0] ?? ''
  if (!raw) return null
  return process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw
}

async function read(w: GitWatch, trigger: Trigger): Promise<void> {
  const snap = await readStatus(w.projectId, w.cwd, w.snap, nextSeq())
  if (watch !== w) return

  /*
   * A folder that has gone away, or a git that is genuinely failing. Counted
   * rather than reacted to immediately: one failed read during a rebase is
   * normal, three in a row is the folder having been moved out from under us.
   */
  if (snap.presence === 'error' || snap.presence === 'no-folder') w.failures += 1
  else w.failures = 0

  const branchChanged = snap.branch !== w.lastBranch
  w.lastBranch = snap.branch

  if (snap.presence === 'ok' && w.gitDir === null) {
    w.gitDir = await resolveGitDir(w.cwd)
    if (watch !== w) return
    attach(w)
  }

  let next = snap
  if (
    snap.presence === 'ok' &&
    snap.slug &&
    ghAllowed(trigger, branchChanged) &&
    Date.now() - w.ghAt > GH_POLL_MIN_GAP_MS
  ) {
    next = await withGh(w, snap)
    if (watch !== w) return
  } else if (w.snap) {
    // Carry the last gh answer rather than blanking it: readStatus only knows
    // about git, and "we did not ask this time" must not render as "no PR".
    next = { ...snap, gh: w.snap.gh }
  }

  pushSnapshot(w, next)

  /*
   * The one automatic fetch, and the reason it is here rather than on a timer:
   * a project becoming the one you are looking at is an event, and ten minutes
   * of not having fetched is the only condition attached to it. Not awaited —
   * a fetch over a slow link would otherwise hold the settle machinery open for
   * half a minute — and it schedules its own re-read when it lands.
   */
  if (
    trigger === 'watch' &&
    !w.fetched &&
    next.presence === 'ok' &&
    next.remoteUrl &&
    !next.unborn &&
    (next.fetchedAt === null || Date.now() - next.fetchedAt > FETCH_STALE_MS)
  ) {
    w.fetched = true
    void runGit(w.cwd, ['fetch', '--prune', 'origin'], {
      timeoutMs: GIT_NET_TIMEOUT_MS,
      repoKey: next.repoRoot ?? w.cwd
    }).then(() => {
      if (watch === w) schedule(w, 'fs')
    })
  }
}

/* ---------------------------------------------------------------- scheduling */

/** Which of two waiting triggers the read should be credited to. */
function strongest(a: Trigger | null, b: Trigger): Trigger {
  if (a === null) return b
  const rank: Record<Trigger, number> = { tick: 0, fs: 1, focus: 2, watch: 3, refresh: 4 }
  return rank[b] > rank[a] ? b : a
}

function schedule(w: GitWatch, trigger: Trigger): void {
  w.queued = strongest(w.queued, trigger)
  if (w.settle) return
  w.settle = setTimeout(() => {
    w.settle = null
    void fire(w)
  }, SETTLE_MS)
}

/**
 * Take the read, or work out how long until it is allowed to be taken.
 *
 * Three gates in order: one read at a time, the hard floor since the last one,
 * and the failure back-off. Each re-arms rather than dropping the trigger, so a
 * burst always ends in exactly one read of the state the burst left behind.
 */
async function fire(w: GitWatch): Promise<void> {
  if (watch !== w) return

  if (w.reading) {
    w.trailing = true
    return
  }

  const floor = w.snap?.slow ? SLOW_MIN_GAP_MS : MIN_GAP_MS
  const backedOff = w.failures >= MAX_FAILURES && w.queued !== 'refresh'
  const gap = backedOff ? FAILURE_BACKOFF_MS : floor
  const wait = w.lastReadAt + gap - Date.now()
  if (wait > 0) {
    if (!w.settle) {
      w.settle = setTimeout(() => {
        w.settle = null
        void fire(w)
      }, wait)
    }
    return
  }

  const trigger = w.queued ?? 'fs'
  w.queued = null
  w.reading = true
  try {
    await read(w, trigger)
  } catch (err) {
    console.error('[git] read failed:', err)
    w.failures += 1
  } finally {
    w.reading = false
    w.lastReadAt = Date.now()
    if (watch === w && w.trailing) {
      w.trailing = false
      schedule(w, 'fs')
    }
  }
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Point the filesystem handles at the git directory.
 *
 * Two non-recursive handles rather than one recursive one: `<gitdir>` carries
 * HEAD, index, ORIG_HEAD, MERGE_HEAD, FETCH_HEAD and packed-refs, and
 * `<gitdir>/refs/heads` carries branches being created and deleted. A recursive
 * watch would also carry every loose object a commit writes, which is thousands
 * of events for one answer that has not changed shape.
 */
function attach(w: GitWatch): void {
  if (!w.gitDir || w.handles.length > 0) return
  if (w.failures >= MAX_FAILURES) return

  for (const dir of [w.gitDir, join(w.gitDir, 'refs', 'heads')]) {
    try {
      const handle = fsWatch(dir, () => {
        if (watch === w) schedule(w, 'fs')
      })
      handle.on('error', () => detach(w))
      w.handles.push(handle)
    } catch {
      // refs/heads does not exist in a repository before its first commit, and
      // the git directory itself can go away mid-life. Neither is worth a log
      // line; the backstop tick re-attaches when there is something to attach to.
    }
  }
}

function detach(w: GitWatch): void {
  for (const handle of w.handles) {
    try {
      handle.close()
    } catch {
      /* best effort */
    }
  }
  w.handles = []
}

function stop(): void {
  const w = watch
  watch = null
  if (!w) return
  detach(w)
  if (w.settle) clearTimeout(w.settle)
  if (w.tick) clearInterval(w.tick)
  if (w.win && !w.win.isDestroyed() && w.onFocus) w.win.off('focus', w.onFocus)
  w.settle = null
  w.tick = null
  w.onFocus = null
}

function start(projectId: string, cwd: string, target: WebContents): void {
  stop()

  const win = BrowserWindow.fromWebContents(target)
  const w: GitWatch = {
    projectId,
    cwd,
    target,
    win,
    onFocus: null,
    handles: [],
    gitDir: null,
    settle: null,
    tick: null,
    queued: null,
    reading: false,
    trailing: false,
    lastReadAt: 0,
    lastFocusAt: 0,
    failures: 0,
    snap: null,
    hash: '',
    ghAt: 0,
    lastBranch: null,
    fetched: false
  }
  watch = w

  if (win) {
    w.onFocus = () => {
      if (watch !== w) return
      if (Date.now() - w.lastFocusAt < FOCUS_MIN_GAP_MS) return
      w.lastFocusAt = Date.now()
      schedule(w, 'focus')
    }
    win.on('focus', w.onFocus)
  }

  /*
   * The backstop. Blurred, it does nothing at all: a window nobody is looking at
   * has no reason to spend a process on a question nobody is reading the answer
   * to, and the focus handler above covers the moment that changes.
   */
  w.tick = setInterval(() => {
    if (watch !== w) return
    if (w.win && !w.win.isDestroyed() && !w.win.isFocused()) return
    const period = w.snap?.slow ? SLOW_POLL_MS : STATUS_POLL_MS
    const backedOff = w.failures >= MAX_FAILURES
    if (Date.now() - w.lastReadAt < (backedOff ? FAILURE_BACKOFF_MS : period)) return
    attach(w)
    schedule(w, 'tick')
  }, STATUS_POLL_MS)

  schedule(w, 'watch')
}

/* ---------------------------------------------------------- reads on demand */

/** The folder for a project id, resolved against main's own list. Never a path from the renderer. */
function pathFor(projectId: string): string | null {
  return getProjects().find((p) => p.id === projectId)?.path ?? null
}

/**
 * A read that answers whoever asked, watched or not.
 *
 * The refresh button lives in the section header, which is on screen even while
 * the section is closed and therefore even while nothing is being watched. So
 * this resolves the folder itself rather than depending on a live watch, and
 * folds the answer back into the watch only when there is one to fold it into.
 */
async function readOnDemand(projectId: string, trigger: Trigger): Promise<GitSnapshot | null> {
  const w = watch
  if (w && w.projectId === projectId) {
    /*
     * A read already in flight is left to finish. Starting a second one would
     * have both of them clearing the same `reading` flag, and the loser would
     * leave it false while it was still running — after which the floor stops
     * being a floor. The trailing flag gets the button its fresh read a moment
     * later, and it arrives as a push rather than as this return value.
     */
    if (w.reading) {
      w.trailing = true
      return w.snap
    }
    // Bypasses the floor on purpose: this is a person pressing a button, and a
    // button that silently does nothing for the next 700ms is a broken button.
    w.queued = trigger
    w.reading = true
    try {
      await read(w, trigger)
    } finally {
      w.reading = false
      w.lastReadAt = Date.now()
      if (watch === w && w.trailing) {
        w.trailing = false
        schedule(w, 'fs')
      }
    }
    return w.snap
  }

  const cwd = pathFor(projectId)
  if (!cwd) return null
  return readStatus(projectId, cwd, null, nextSeq())
}

/* --------------------------------------------------------------- operations */

/*
 * Everything the GIT section can ask for, as ordinary functions.
 *
 * They take arguments that have already been made safe and hand back exactly
 * what the IPC handlers below hand back, because the handlers are now nothing
 * but coercion and a call. That is the whole point of the split: a second host
 * — the browser client — reaches the same code by calling it, rather than by
 * duplicating it and drifting.
 *
 * The `String(x ?? '')` at each boundary stays in the handler on purpose. The
 * renderer is untrusted input and that is where input is made safe; a second
 * host is a second untrusted boundary and does its own, at its own edge.
 */

/**
 * Watch one project, pushing to the given target.
 *
 * The target stays a `WebContents` rather than being made generic: a second
 * consumer arrives through `addGitSink` above, which is a narrower and more
 * honest thing to be than a pretend window.
 */
export function startWatch(projectId: string, cwd: string, target: WebContents): { ok: boolean; error?: string } {
  if (!projectId || !cwd) return { ok: false, error: 'a project and a folder are both required' }
  start(projectId, cwd, target)
  return { ok: true }
}

/** Stop watching, if this is the project being watched. */
export function unwatch(projectId: string): void {
  if (watch?.projectId === projectId) stop()
}

export async function gitRefresh(projectId: string): Promise<GitSnapshot | null> {
  if (!projectId) return null
  /*
   * The refresh button is the one gesture that means "something changed that
   * you could not have noticed" — git being installed since Forge started, or
   * `gh auth login` having just run in the pane next door. So it is the only
   * caller that throws away the cached answers to both.
   */
  invalidateGitAvailable()
  invalidateGhCaches()
  if (watch?.projectId === projectId) watch.ghAt = 0
  return readOnDemand(projectId, 'refresh')
}

export async function runAction(req: GitActionRequest): Promise<GitActionResult> {
  const result = await runGitAction(req)
  if (!result.snapshot) return result

  /*
   * The action module reads the repository but does not own the sequence
   * counter, so the snapshot is stamped here — one source of seq, no chance of
   * the panel appearing to go backwards after a button press. The gh half is
   * carried across from the watch **only when it is the same project**: git
   * actions know nothing about GitHub, and grafting another project's pull
   * request onto this one would be a confident lie.
   */
  const w = watch
  const carried = w && w.projectId === result.snapshot.projectId ? w.snap?.gh : undefined
  const snapshot: GitSnapshot = { ...result.snapshot, seq: nextSeq(), gh: carried ?? result.snapshot.gh }
  if (w && w.projectId === snapshot.projectId) {
    w.lastBranch = snapshot.branch
    pushSnapshot(w, snapshot)
  }
  return { ...result, snapshot }
}

export async function remoteBranches(projectId: string): Promise<GitBranch[]> {
  const cwd = watch?.projectId === projectId ? watch.cwd : pathFor(projectId)
  if (!cwd) return []
  const refs = await runGit(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${GIT_MAX_BRANCHES}`,
    `--format=${FOR_EACH_REF_FORMAT}`,
    'refs/remotes'
  ])
  if (!refs.ok) return []
  // origin/HEAD is a symbolic ref to whichever branch is the default; it is
  // not a branch anybody wants to see listed beside the branch it points at.
  return parseForEachRef(refs.out, true).filter((b) => !/\/HEAD$/.test(b.name))
}

/*
 * What a switch would do, asked before it is done rather than discovered
 * afterwards.
 *
 * `rev-list --left-right --count HEAD...refs/heads/<name>` is one process and
 * answers both halves at once: the left number is what HEAD has and the target
 * does not - the commits that would leave the working tree - and the right is
 * what the target has and HEAD does not. Two dots would answer a different and
 * much less useful question; the three are load-bearing.
 *
 * The ref is spelled out in full rather than passed as a bare name. A full
 * `refs/heads/` ref cannot quietly resolve to a tag or a remote-tracking
 * branch that happens to share the name, and it cannot begin with a hyphen and
 * be read as an option. This is a read rather than a write, but the argv
 * discipline in git-actions.ts is not worth keeping in one file and dropping
 * in the one beside it.
 */
export async function branchCompare(projectId: string, branch: string): Promise<GitBranchCompare | null> {
  const cwd = watch?.projectId === projectId ? watch.cwd : pathFor(projectId)
  if (!cwd || !branch) return null

  const unknown = (error: string): GitBranchCompare => ({ branch, leaving: 0, gaining: 0, error })

  /*
   * The live branch list, not the one the row was drawn from - the same rule
   * the switch itself follows. A row armed against a branch an agent deleted
   * in the pane next door says so, rather than measuring against nothing and
   * offering to move you there.
   */
  const known = watch?.projectId === projectId ? watch.snap?.branches : undefined
  if (known && !known.some((b) => b.name === branch && !b.remote)) {
    return unknown(`There is no local branch called ${branch}`)
  }

  const res = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...refs/heads/${branch}`])
  if (!res.ok) return unknown('git could not work out how far that is from here')

  const [left, right] = res.out.trim().split(/\s+/)
  const leaving = Number.parseInt(left ?? '', 10)
  const gaining = Number.parseInt(right ?? '', 10)
  if (!Number.isFinite(leaving) || !Number.isFinite(gaining)) {
    return unknown('git could not work out how far that is from here')
  }
  return { branch, leaving, gaining }
}

export async function ghRefresh(projectId: string): Promise<GhState> {
  const w = watch
  invalidateGhCaches()
  if (!w || w.projectId !== projectId || !w.snap || w.snap.presence !== 'ok' || !w.snap.slug) return GH_UNKNOWN
  const next = await withGh(w, w.snap)
  if (watch !== w) return next.gh
  pushSnapshot(w, { ...next, seq: nextSeq() })
  return next.gh
}

/* ----------------------------------------------------------------- handlers */

export function registerGitWatcherHandlers(): void {
  /*
   * The shelf rides the same busy edge the activity watcher records, for every
   * project rather than only the watched one. `ipcMain.on` allows a second
   * listener on the channel; this one never reads the activity watcher's state.
   */
  configureShelf({ enabled: () => getSettings().gitShelfEnabled, pathFor })
  ipcMain.on(IPC.activityBusy, (_e, projectId: string, _paneId: string, busy: boolean) => {
    noteBusy(String(projectId ?? ''), Boolean(busy))
  })

  ipcMain.handle(IPC.gitWatch, (e, req: { projectId?: unknown; cwd?: unknown }) => {
    const result = startWatch(String(req?.projectId ?? ''), String(req?.cwd ?? ''), e.sender)
    if (!result.ok) return result
    // The window going away must not leave a watcher pushing into a dead pipe.
    e.sender.once('destroyed', () => {
      if (watch?.target === e.sender) stop()
    })
    return result
  })

  ipcMain.on(IPC.gitUnwatch, (_e, projectId: string) => {
    unwatch(String(projectId ?? ''))
  })

  ipcMain.handle(IPC.gitRefresh, (_e, projectId: string): Promise<GitSnapshot | null> => {
    return gitRefresh(String(projectId ?? ''))
  })

  ipcMain.handle(IPC.gitAction, (_e, req: GitActionRequest): Promise<GitActionResult> => {
    return runAction(req)
  })

  ipcMain.handle(IPC.gitRemoteBranches, (_e, projectId: string): Promise<GitBranch[]> => {
    return remoteBranches(String(projectId ?? ''))
  })

  ipcMain.handle(
    IPC.gitBranchCompare,
    (_e, req: { projectId?: unknown; branch?: unknown }): Promise<GitBranchCompare | null> => {
      return branchCompare(String(req?.projectId ?? ''), String(req?.branch ?? '').trim())
    }
  )

  ipcMain.handle(IPC.gitGhRefresh, (_e, projectId: string): Promise<GhState> => {
    return ghRefresh(String(projectId ?? ''))
  })
}

export function disposeGitWatchers(): void {
  stop()
  // Whatever is armed goes now, best effort — a pane that went idle a moment
  // before Quit is exactly the work the shelf exists to catch.
  flushShelves()
  disposeShelf()
}

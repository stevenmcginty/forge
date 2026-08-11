import { MAX_REPLAY_BYTES, type WebHelloOkFrame, type WebSession } from '@shared/web'
import type { AgentProfile, GitSnapshot, Project, Workspace } from '@shared/types'

/**
 * The offline snapshot: the last picture this browser was handed, kept so a
 * desktop that is off does not look like a desktop that is broken.
 *
 * shared/web.ts is explicit about what this is made of and about what it is
 * deliberately *not*: "This frame plus one `replay` per attached session is also
 * the whole of the offline snapshot… There is no separate 'cache' frame, because
 * a cache the server has to build is a second source of truth for a picture the
 * client already received." So nothing is asked for. What arrives is written
 * down.
 *
 * ## The Phase 4 seam, now filled
 *
 * This is the *frozen* half of offline mode. The other half — GitHub mode: a
 * token, a file tree and an editor over the REST API, and commits landing on a
 * `forge-web/*` branch — is Phase 4 and lives in lib/github.ts and lib/repo.tsx.
 * The seam turned out to be exactly one field wide. Nothing about a transcript
 * changed, because a transcript and a repository are different things and the
 * frozen transcript is the one the desktop owns; what GitHub mode needed from
 * here was the one fact it cannot derive and cannot ask for with the desktop
 * off, which is *which repository a project is*. That is `slugs` below.
 *
 * Everything else GitHub mode caches — trees, file bodies, unsent edits — is its
 * own, under its own keys, in lib/repo.tsx. It is deliberately not folded in
 * here: this snapshot is a picture the desktop sent and can send again, and a
 * draft nobody has committed is neither.
 *
 * ## Why localStorage
 *
 * Not IndexedDB, and the ceiling is the reason it is a considered choice rather
 * than laziness: MAX_REPLAY_BYTES is 192KB per session, and localStorage's quota
 * is about 5MB per origin, so a handful of panes fits and a wall of them does
 * not. `writeSnapshot` therefore trims oldest-first and tolerates a quota
 * failure by dropping the cache rather than by throwing on a hot path. A tab
 * that cannot cache is a tab that shows "Forge is asleep" instead of the last
 * picture, which is a worse screen and not a broken one.
 */

const SNAPSHOT_KEY = 'forge-web-snapshot'

/**
 * Snapshot format. Bumped when the shape below changes; an older one is dropped.
 *
 * 2 added `profiles`. Without them the frozen view called `resolveProfile` with
 * an empty list, which falls back to a built-in — so every pane in the cached
 * picture drew the wrong agent badge and the wrong accent. `WebHelloOkFrame`
 * puts the profiles in the opening picture precisely because "a client without
 * them cannot render the workspace it was just handed", and that is no less
 * true of a workspace it is rendering from disk.
 *
 * 3 added `slugs`. GitHub mode has to name a repository with the desktop off,
 * and `GitSnapshot.slug` — the same `owner/repo` that gates every `gh` call in
 * electron/git/gh.ts — only ever arrives in a `git` push while the desktop is
 * awake. Without it the offline client can tell nobody which repository the
 * project it is drawing belongs to.
 */
const SNAPSHOT_VERSION = 3

/**
 * Total bytes of replay this cache will hold across every session.
 *
 * Four full buffers. Past that the oldest transcripts are dropped, because a
 * quota error would cost the *whole* snapshot — including the project list,
 * which is the part that makes the offline screen recognisable as Forge.
 */
const MAX_CACHED_REPLAY_BYTES = 4 * MAX_REPLAY_BYTES

export interface Snapshot {
  version: number
  /** ms epoch when the desktop last spoke. Drawn as "as of …" on the badge. */
  at: number
  desktopName: string
  appVersion: string
  projects: Project[]
  /** The launchable agents, so a frozen pane keeps its badge and its accent. */
  profiles: AgentProfile[]
  workspaces: Record<string, Workspace>
  sessions: WebSession[]
  /** sessionId → the last replay this browser was sent, newest last. */
  transcripts: Array<{ sessionId: string; data: string }>
  /**
   * projectId → `owner/repo`, or null for a project git has been read for whose
   * remote is not a github.com one.
   *
   * A *missing* key and a null value are different answers and GitHub mode says
   * different sentences for them: null is "that project has no GitHub remote",
   * missing is "this browser has never been told what git thinks of it". Merging
   * them would have a project with a perfectly good remote reading as broken
   * whenever the desktop went off before the first `git` push arrived.
   */
  slugs: Record<string, string | null>
}

export function loadSnapshot(): Snapshot | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SNAPSHOT_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Partial<Snapshot>
  if (snapshot.version !== SNAPSHOT_VERSION) return null
  if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.sessions)) return null
  return {
    version: SNAPSHOT_VERSION,
    at: typeof snapshot.at === 'number' ? snapshot.at : 0,
    desktopName: typeof snapshot.desktopName === 'string' ? snapshot.desktopName : '',
    appVersion: typeof snapshot.appVersion === 'string' ? snapshot.appVersion : '',
    projects: snapshot.projects,
    profiles: Array.isArray(snapshot.profiles) ? snapshot.profiles : [],
    workspaces: (snapshot.workspaces ?? {}) as Record<string, Workspace>,
    sessions: snapshot.sessions,
    transcripts: Array.isArray(snapshot.transcripts) ? snapshot.transcripts : [],
    slugs: (snapshot.slugs ?? {}) as Record<string, string | null>
  }
}

/**
 * Which GitHub repository a project is, as of the last `git` push.
 *
 * `undefined` when this browser has never been told — see the field's comment
 * for why that is not the same as `null`.
 */
export function slugFor(snapshot: Snapshot | null, projectId: string | null): string | null | undefined {
  if (!snapshot || !projectId) return undefined
  return Object.hasOwn(snapshot.slugs, projectId) ? snapshot.slugs[projectId] : undefined
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY)
  } catch {
    /* nothing to clear */
  }
}

/**
 * The picture, as `hello-ok` handed it over. Replaces everything except the
 * transcripts, which belong to sessions and outlive one connection.
 *
 * Hands back what it stored, so a caller that keeps the snapshot in state has it
 * without a second `loadSnapshot()` — a `JSON.parse` of everything this browser
 * has cached, for a value the write already had in its hands. Null means nothing
 * was stored and there is nothing to refresh from; see `write`.
 */
export function rememberPicture(frame: WebHelloOkFrame): Snapshot | null {
  const previous = loadSnapshot()
  return write({
    version: SNAPSHOT_VERSION,
    at: Date.now(),
    desktopName: frame.desktopName,
    appVersion: frame.appVersion,
    projects: frame.projects,
    profiles: frame.profiles,
    workspaces: frame.workspaces,
    sessions: frame.sessions,
    // Only the transcripts of sessions that still exist: a pane that closed on
    // the desktop is not one the frozen view should still be offering.
    transcripts: (previous?.transcripts ?? []).filter((t) => frame.sessions.some((s) => s.id === t.sessionId)),
    // Kept across a fresh picture, and only for projects that still exist. A
    // remote is a property of the repository rather than of this connection, so
    // re-connecting must not cost GitHub mode the one fact it needs.
    slugs: pruneSlugs(previous?.slugs ?? {}, frame.projects)
  })
}

/**
 * The one field GitHub mode needs out of a `git` push.
 *
 * Not the whole `GitSnapshot`: it carries `repoRoot`, every changed file's
 * absolute path on Steve's disk, and a per-project seq, none of which mean
 * anything with the desktop off — and writing desktop paths into localStorage to
 * keep them company would be a cost with no reader.
 *
 * Returns the snapshot it stored, and null when it stored nothing — either
 * because there is no snapshot to fold a remote into or because the remote is
 * already the one written down. The two cases are one answer on purpose: both
 * mean "the cache did not move", which is the only thing the caller can act on.
 * The git watcher fires on every file save, so this is the difference between a
 * new snapshot object per keystroke-triggered rebuild and one per actual change.
 */
export function rememberGit(snapshot: GitSnapshot): Snapshot | null {
  const cached = loadSnapshot()
  if (!cached) return null
  const slug = typeof snapshot.slug === 'string' && snapshot.slug ? snapshot.slug : null
  if (Object.hasOwn(cached.slugs, snapshot.projectId) && cached.slugs[snapshot.projectId] === slug) return null
  return write({ ...cached, at: Date.now(), slugs: { ...cached.slugs, [snapshot.projectId]: slug } })
}

/**
 * Are these two project lists the same list?
 *
 * Worth asking because the desktop answers a great many things with a `projects`
 * push whether or not the list changed — a click into a pane is a `focus-pane`,
 * and a `focus-pane` comes back with one — and every push that is acted on costs
 * a parse, a stringify and a synchronous `setItem` of the whole snapshot. The
 * comparison lives here, in one place, because the two halves that need it —
 * this file deciding whether to write, and the provider deciding whether to
 * replace the picture it is holding — must not be able to disagree about what
 * "unchanged" means.
 *
 * Compared as JSON rather than field by field, and the asymmetry is what makes
 * that safe: both lists are built by the same desktop and serialised by the same
 * JSON writer, so equal content produces equal text — and any doubt falls the
 * harmless way, because a list wrongly read as *changed* costs exactly what
 * every push costs today.
 */
export function sameProjects(a: Project[], b: Project[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

/** Project list, workspace and session-list pushes, folded into the snapshot. */
export function rememberProjects(projects: Project[]): void {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  // The same early return `rememberGit` makes, for the same reason: a push that
  // says what the cache already says is a full rewrite of up to five megabytes
  // for no change, on the main thread, while somebody is typing at a terminal.
  if (sameProjects(snapshot.projects, projects)) return
  write({ ...snapshot, at: Date.now(), projects, slugs: pruneSlugs(snapshot.slugs, projects) })
}

export function rememberWorkspace(projectId: string, workspace: Workspace): void {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  write({ ...snapshot, at: Date.now(), workspaces: { ...snapshot.workspaces, [projectId]: workspace } })
}

export function rememberSessions(sessions: WebSession[]): void {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  write({
    ...snapshot,
    at: Date.now(),
    sessions,
    transcripts: snapshot.transcripts.filter((t) => sessions.some((s) => s.id === t.sessionId))
  })
}

/**
 * What the attached panes have said, as of the last time they were read.
 *
 * The replay *plus* whatever live data arrived after it, because the frozen view
 * should show what was last on screen and not what was on screen at the moment
 * the tab attached. Held to MAX_REPLAY_BYTES per session — the same ceiling the
 * desktop sends — so the cache can never describe more scrollback than a live
 * attach would have given it.
 *
 * Every pane that has said something in one call, and that is the whole reason
 * it is plural rather than a function about one session. A snapshot is read and
 * written whole: one call is a `JSON.parse` of everything this browser has
 * cached, plus a `JSON.stringify` and a *synchronous* `localStorage.setItem` of
 * the same, which for a cache near its ceiling is most of a megabyte each way.
 * The flush that calls this runs every three seconds, so one call per pane meant
 * three complete round trips through the main thread every three seconds with
 * three busy panes open — a stutter somebody can feel under their own typing,
 * and the reason this file's timer exists in the first place.
 */
export function rememberTranscripts(entries: Snapshot['transcripts']): void {
  if (entries.length === 0) return
  const snapshot = loadSnapshot()
  if (!snapshot) return
  const fresh = entries.map(({ sessionId, data }) => ({
    sessionId,
    data: data.length > MAX_REPLAY_BYTES ? data.slice(data.length - MAX_REPLAY_BYTES) : data
  }))
  const replaced = new Set(fresh.map((t) => t.sessionId))
  const rest = snapshot.transcripts.filter((t) => !replaced.has(t.sessionId))
  // Newest last, exactly as writing them one at a time left them: `write` drops
  // oldest-first when the total is over MAX_CACHED_REPLAY_BYTES, so the order of
  // this array decides which transcript survives a cache that has filled up.
  write({ ...snapshot, at: Date.now(), transcripts: [...rest, ...fresh] })
}

export function transcriptFor(snapshot: Snapshot | null, sessionId: string): string {
  return snapshot?.transcripts.find((t) => t.sessionId === sessionId)?.data ?? ''
}

/** Drop remotes for projects the desktop no longer has. */
function pruneSlugs(slugs: Record<string, string | null>, projects: Project[]): Record<string, string | null> {
  const kept: Record<string, string | null> = {}
  for (const project of projects) {
    if (Object.hasOwn(slugs, project.id)) kept[project.id] = slugs[project.id]
  }
  return kept
}

/**
 * Write, trimming oldest transcripts first until it fits, and giving up quietly
 * rather than throwing into whatever was rendering.
 *
 * Hands back what is now on disk, which is not always what it was given: the
 * transcripts may have been trimmed, and a quota failure keeps the picture and
 * drops them entirely. A caller holding this in state gets the truth for free,
 * where re-reading it would cost a parse of what was just serialised. Null means
 * storage refused everything and there is no cache any more.
 */
function write(snapshot: Snapshot): Snapshot | null {
  const transcripts = [...snapshot.transcripts]
  let total = transcripts.reduce((sum, t) => sum + t.data.length, 0)
  while (transcripts.length > 0 && total > MAX_CACHED_REPLAY_BYTES) {
    total -= transcripts.shift()!.data.length
  }
  const next: Snapshot = { ...snapshot, transcripts }
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next))
    return next
  } catch {
    // Out of quota, or private mode. Drop the transcripts and keep the picture:
    // a project list with no scrollback is still a recognisable Forge, and a
    // failed write that left the *old* snapshot in place would be a frozen view
    // claiming to be newer than it is.
    const bare: Snapshot = { ...next, transcripts: [] }
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(bare))
      return bare
    } catch {
      clearSnapshot()
      return null
    }
  }
}

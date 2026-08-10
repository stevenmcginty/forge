import { MAX_REPLAY_BYTES, type WebHelloOkFrame, type WebSession } from '@shared/web'
import type { AgentProfile, Project, Workspace } from '@shared/types'

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
 * ## The Phase 4 seam
 *
 * This is the *frozen* half of offline mode, and it is all of Phase 3's share of
 * it. The other half — GitHub auth, a file tree and editor over the REST API,
 * and commits landing on a `forge-web/*` branch — is Phase 4 and is **not built
 * here**, deliberately (docs/forge-web.md, work plan). The seam is this module's
 * boundary: an offline screen reads `loadSnapshot()` and draws it read-only.
 * Phase 4 adds a second source beside it and a way to switch between "what the
 * desktop last looked like" and "what GitHub says the files are"; it does not
 * change what is written down here, because a transcript and a repo are
 * different things and the frozen transcript is the one the desktop owns.
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
 */
const SNAPSHOT_VERSION = 2

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
    transcripts: Array.isArray(snapshot.transcripts) ? snapshot.transcripts : []
  }
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
 */
export function rememberPicture(frame: WebHelloOkFrame): void {
  const previous = loadSnapshot()
  write({
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
    transcripts: (previous?.transcripts ?? []).filter((t) => frame.sessions.some((s) => s.id === t.sessionId))
  })
}

/** Project list, workspace and session-list pushes, folded into the snapshot. */
export function rememberProjects(projects: Project[]): void {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  write({ ...snapshot, at: Date.now(), projects })
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
 * One pane's transcript, as of the last time it was read.
 *
 * The replay *plus* whatever live data arrived after it, because the frozen view
 * should show what was last on screen and not what was on screen at the moment
 * the tab attached. Held to MAX_REPLAY_BYTES per session — the same ceiling the
 * desktop sends — so the cache can never describe more scrollback than a live
 * attach would have given it.
 */
export function rememberTranscript(sessionId: string, data: string): void {
  const snapshot = loadSnapshot()
  if (!snapshot) return
  const trimmed = data.length > MAX_REPLAY_BYTES ? data.slice(data.length - MAX_REPLAY_BYTES) : data
  const rest = snapshot.transcripts.filter((t) => t.sessionId !== sessionId)
  write({ ...snapshot, at: Date.now(), transcripts: [...rest, { sessionId, data: trimmed }] })
}

export function transcriptFor(snapshot: Snapshot | null, sessionId: string): string {
  return snapshot?.transcripts.find((t) => t.sessionId === sessionId)?.data ?? ''
}

/**
 * Write, trimming oldest transcripts first until it fits, and giving up quietly
 * rather than throwing into whatever was rendering.
 */
function write(snapshot: Snapshot): void {
  const transcripts = [...snapshot.transcripts]
  let total = transcripts.reduce((sum, t) => sum + t.data.length, 0)
  while (transcripts.length > 0 && total > MAX_CACHED_REPLAY_BYTES) {
    total -= transcripts.shift()!.data.length
  }
  const next: Snapshot = { ...snapshot, transcripts }
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next))
  } catch {
    // Out of quota, or private mode. Drop the transcripts and keep the picture:
    // a project list with no scrollback is still a recognisable Forge, and a
    // failed write that left the *old* snapshot in place would be a frozen view
    // claiming to be newer than it is.
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...next, transcripts: [] }))
    } catch {
      clearSnapshot()
    }
  }
}

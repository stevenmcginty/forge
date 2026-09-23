import { useSyncExternalStore } from 'react'
import { WEB_FEATURE_FILES } from '@shared/web'
import { useDeskFeature } from './features'

/**
 * The read-only look inside a project's folder on the desktop — the phone's
 * file viewer, answered by `project-files` / `project-file` (never `fs-list`,
 * which stays the folder picker).
 *
 * A tiny store rather than props, because the viewer is mounted once (from
 * App) and opened from wherever a file is named: the project sheet's "Files"
 * row, a changed file in the Git panel. Whoever wants it calls
 * `openLiveFiles`; `LiveFiles` is the only listener.
 */

export interface LiveFilesTarget {
  projectId: string
  /** Project-relative, `/`-separated; '' for the top folder. A file path opens the file. */
  path: string
  /** `path` is a `GitFileChange.path` (repo-relative) — the desktop maps it. Always a file. */
  git: boolean
  /** Bumped on every open, so opening the same place again starts from it again. */
  nonce: number
}

let target: LiveFilesTarget | null = null
let nonce = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Open the viewer on a project's folder — its top, a folder inside it, or one
 * file. `opts.git` says `path` came from the git status list (repo-relative).
 * On a desktop that does not announce `files` the viewer opens on a sentence
 * saying so rather than sending a request it knows will be refused.
 */
export function openLiveFiles(projectId: string, path?: string, opts?: { git?: boolean }): void {
  target = { projectId, path: normalise(path ?? ''), git: opts?.git === true, nonce: ++nonce }
  emit()
}

export function closeLiveFiles(): void {
  if (!target) return
  target = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function current(): LiveFilesTarget | null {
  return target
}

/** Where the viewer has been asked to open, or null while it is closed. */
export function useLiveFilesTarget(): LiveFilesTarget | null {
  return useSyncExternalStore(subscribe, current, current)
}

/**
 * Can the viewer be used against this desktop? For callers that want to draw
 * their entry point disabled ("Restart Forge on the desktop to use this")
 * rather than open a sheet that says so.
 */
export function useLiveFilesAvailable(): boolean {
  return useDeskFeature(WEB_FEATURE_FILES)
}

/** The sentence for a desktop too old to answer. */
export const LIVE_FILES_OLD_DESKTOP = 'Restart Forge on the desktop to use this.'

/* ----------------------------------------------------------------- paths */

export function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** The path to ask for next, per the contract: `listing.path ? listing.path + '/' + name : name`. */
export function childPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

/** The folder holding `path`; '' at the top. */
export function parentPath(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

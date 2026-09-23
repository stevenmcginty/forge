import { useEffect, useSyncExternalStore } from 'react'

/**
 * The active project's git branch, for the pane headers.
 *
 * Every pane in a project shares one working folder, so this is one value per
 * project, not per pane. It is taken from the snapshots the Git section's
 * watcher already pushes, and otherwise read once when the project comes up and
 * again when the window regains focus (at most once a minute) — a single
 * `git status`, never a watcher of its own.
 */

const branches = new Map<string, string | null>()
const listeners = new Set<() => void>()
const lastRead = new Map<string, number>()
let wired = false

function emit(): void {
  for (const cb of listeners) cb()
}

function wire(): void {
  if (wired) return
  wired = true
  window.forge.git.onSnapshot((s) => {
    const next = s.presence === 'ok' ? s.branch : null
    if (branches.get(s.projectId) === next) return
    branches.set(s.projectId, next)
    emit()
  })
}

function read(projectId: string): void {
  const at = Date.now()
  if (at - (lastRead.get(projectId) ?? 0) < 60_000) return
  lastRead.set(projectId, at)
  void window.forge.git
    .refresh(projectId)
    .then((s) => {
      if (!s) return
      const next = s.presence === 'ok' ? s.branch : null
      if (branches.get(projectId) === next) return
      branches.set(projectId, next)
      emit()
    })
    .catch(() => {
      /* no git, no chip */
    })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Mount once, in the shell: keeps the active project's branch fresh. */
export function useBranchReader(projectId: string | null): void {
  useEffect(() => {
    wire()
    if (!projectId) return undefined
    read(projectId)
    const onFocus = (): void => read(projectId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId])
}

export function useBranch(projectId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => (projectId ? (branches.get(projectId) ?? null) : null))
}

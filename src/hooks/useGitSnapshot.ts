import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitActionKind, GitActionResult, GitSnapshot } from '@shared/types'
import { isOpen } from '@/lib/railstack'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'

/**
 * Where the active project stands, kept live for as long as the section is
 * looking at it.
 *
 * Three things happen here and each is a rule from the plan made concrete.
 *
 * **The watch is keyed on the section being enabled *and* open.** Main has no
 * field on `git:watch` for "is the panel open", so the renderer says it by
 * watching or not watching: a closed section costs no handles, no timers and no
 * processes at all. The last snapshot stays in state while it is closed, so the
 * header keeps showing the branch it last knew rather than blanking — an honest
 * "this is what it was" beats an empty space.
 *
 * **A pane going busy → idle is the key trigger**, and the only one main could
 * not possibly have. An agent editing the working tree touches nothing inside
 * `.git`, so no filesystem watcher sees it; but the moment an agent stops is
 * exactly when the answer changed and exactly when Steve looks at the rail. The
 * settle beat after the falling edge is there because a write frequently lands
 * just after the output stops.
 *
 * **A snapshot older than the one in hand is dropped.** `seq` is monotonic in
 * main across every trigger, so an action's fresh read arriving before a slower
 * background read that was already in flight cannot make the panel go backwards.
 */

/** How long after an agent goes quiet before asking git what it did. */
const BUSY_SETTLE_MS = 800

export interface GitView {
  snap: GitSnapshot | null
  /** True while an action is running. The row disables itself rather than queueing. */
  running: boolean
  /** The last refusal or failure, in a sentence. Cleared by the next action. */
  error: string | null
  refresh: () => void
  run: (action: GitActionKind, opts?: { branch?: string; message?: string }) => Promise<GitActionResult>
  dismissError: () => void
}

export function useGitSnapshot(): GitView {
  const { state } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()

  const projectId = project?.id ?? ''
  const projectPath = project?.path ?? ''
  /*
   * Open in the rail *or* blown up into the panel. The panel draws the section's
   * body with the rail section closed underneath it perfectly often — expanding
   * a section you had no rail height for is the main reason the button exists —
   * so watching on `isOpen` alone would leave the panel showing a snapshot that
   * never updates.
   */
  const expanded = state.railExpanded === 'git'
  const watching = Boolean(
    projectId && state.settings.railGit && (isOpen(state.settings, 'git') || expanded)
  )

  const [snap, setSnap] = useState<GitSnapshot | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* The newest sequence number seen, per project. A ref because accepting a
   * snapshot must not depend on a re-render having happened first. */
  const seen = useRef<{ projectId: string; seq: number }>({ projectId: '', seq: 0 })

  const accept = useCallback((next: GitSnapshot | null): void => {
    if (!next) return
    const mark = seen.current
    if (next.projectId === mark.projectId && next.seq <= mark.seq) return
    seen.current = { projectId: next.projectId, seq: next.seq }
    setSnap(next)
  }, [])

  /* ------------------------------------------------------------- pushes in */

  useEffect(() => window.forge.git.onSnapshot((s) => {
    // Snapshots are addressed to a project, and the project can change between
    // a read starting in main and landing here.
    if (s.projectId === projectId) accept(s)
  }), [projectId, accept])

  /* ---------------------------------------------------------------- watch */

  useEffect(() => {
    // A project switch is a different repository, so the old answer is wrong
    // rather than merely stale — better a moment of nothing than a moment of
    // another folder's branch name.
    setSnap(null)
    setError(null)
    seen.current = { projectId: '', seq: 0 }
  }, [projectId])

  useEffect(() => {
    if (!watching || !projectPath) return
    void window.forge.git.watch({ projectId, cwd: projectPath }).then((r) => {
      if (!r.ok) console.warn('[git] watch refused:', r.error)
    })
    return () => window.forge.git.unwatch(projectId)
  }, [watching, projectId, projectPath])

  /* -------------------------------------------------------------- refresh */

  const refresh = useCallback((): void => {
    if (!projectId) return
    void window.forge.git.refresh(projectId).then(accept)
  }, [projectId, accept])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  /* --------------------------------------------------------- busy → idle */

  const paneIds = useMemo(
    () => workspace.tabs.flatMap((t) => collectLeaves(t.root).map((l) => l.id)),
    [workspace.tabs]
  )
  const paneRef = useRef(paneIds)
  paneRef.current = paneIds

  useEffect(() => {
    if (!watching) return
    let wasBusy = terminalHost.anyBusy(paneRef.current)
    let timer: number | null = null
    const off = terminalHost.subscribeBusy(() => {
      const busy = terminalHost.anyBusy(paneRef.current)
      if (wasBusy && !busy) {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          refreshRef.current()
        }, BUSY_SETTLE_MS)
      }
      wasBusy = busy
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [watching, projectId])

  /* --------------------------------------------------------------- action */

  const run = useCallback(
    async (action: GitActionKind, opts?: { branch?: string; message?: string }): Promise<GitActionResult> => {
      setError(null)
      setRunning(true)
      try {
        const result = await window.forge.git.action({
          projectId,
          action,
          ...(opts?.branch ? { branch: opts.branch } : {}),
          ...(opts?.message ? { message: opts.message } : {})
        })
        // Every action answers with a fresh read, failed ones included, so the
        // panel can never be left showing the state the button was drawn from.
        accept(result.snapshot ?? null)
        if (!result.ok) setError(result.error ?? 'That did not work')
        return result
      } finally {
        setRunning(false)
      }
    },
    [projectId, accept]
  )

  const dismissError = useCallback((): void => setError(null), [])

  return { snap, running, error, refresh, run, dismissError }
}

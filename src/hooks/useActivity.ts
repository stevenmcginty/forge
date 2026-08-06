import { useEffect, useMemo, useRef, useState } from 'react'
import { isClaudeCommand } from '@shared/agents'
import type { ActivityPane, ActivitySnapshot } from '@shared/types'
import { resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'

/**
 * The activity panel's half of the conversation with main.
 *
 * Three things go on here, and only the first is obvious:
 *
 *  1. **Listening.** Snapshots arrive whole, twice a second at most, and are
 *     discarded unless they are for the project on screen and newer than the one
 *     already held — a snapshot from a project we have just left arriving one
 *     tick late must not repaint the tree with somebody else's files.
 *
 *  2. **Telling main which panes exist**, with their session ids. Main cannot
 *     see the workspace; the renderer is the only side that knows a pane runs
 *     Claude and which conversation it is having, and that is the whole basis of
 *     exact attribution. Re-called when the pane set changes — main *diffs* the
 *     list rather than starting over, so splitting a pane does not wipe a tree
 *     that is telling the truth.
 *
 *  3. **Telling main when a pane is working.** This is the half main cannot see
 *     at all: it has no view of a terminal's output, so without these edges
 *     every change the folder watcher notices would be unattributable. One send
 *     per edge, and only for panes in the current list.
 *
 * `enabled` is the section's open state. Nothing is watched while the section is
 * closed — this is the one feature in Forge that watches a project folder on its
 * own initiative, and it should cost nothing at all when it is not being looked
 * at.
 */

const EMPTY: ActivitySnapshot = {
  projectId: '',
  seq: 0,
  entries: [],
  hasInferred: false,
  truncated: false,
  stormy: false
}

export interface ActivityView {
  snapshot: ActivitySnapshot
  /** How many panes could give exact attribution. Zero changes what the panel says. */
  claudePanes: number
  clear: () => void
}

export function useActivity(enabled: boolean): ActivityView {
  const { state } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY)

  const projectId = project?.id ?? ''
  const projectPath = project?.path ?? ''

  /*
   * Every pane in the project, with a session id only where there is genuinely a
   * transcript to read. A shell pane carries a session id too (every pane is
   * born with one) and handing that over would have main open a tail on a file
   * that will never exist — a directory watch and a poll per pane, for nothing.
   */
  const panes = useMemo<ActivityPane[]>(() => {
    const out: ActivityPane[] = []
    for (const tab of workspace.tabs) {
      for (const leaf of collectLeaves(tab.root)) {
        const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
        const pane: ActivityPane = { paneId: leaf.id, profileId: leaf.profileId }
        if (leaf.sessionId && isClaudeCommand(profile.command)) pane.sessionId = leaf.sessionId
        out.push(pane)
      }
    }
    return out
  }, [workspace.tabs, state.settings.agentProfiles])

  // The identity the watch effect keys on. Comparing the shape rather than the
  // array means a re-render that rebuilds an identical list does not tear the
  // watch down and put it back up.
  const paneKey = useMemo(
    () => panes.map((p) => `${p.paneId}:${p.profileId}:${p.sessionId ?? ''}`).join('|'),
    [panes]
  )

  const claudePanes = useMemo(() => panes.filter((p) => p.sessionId).length, [panes])

  /* ------------------------------------------------------------- listening */

  useEffect(() => {
    return window.forge.activity.onUpdate((next) => {
      setSnapshot((prev) => {
        if (next.projectId !== projectId) return prev
        if (next.projectId === prev.projectId && next.seq < prev.seq) return prev
        return next
      })
    })
  }, [projectId])

  // A project switch empties the panel immediately rather than leaving the old
  // project's files on screen until the new one's first snapshot arrives.
  useEffect(() => {
    setSnapshot(EMPTY)
  }, [projectId])

  /* ----------------------------------------------------------------- watch */

  useEffect(() => {
    if (!enabled || !projectId || !projectPath) return
    void window.forge.activity.watch({ projectId, cwd: projectPath, panes }).then((r) => {
      if (!r.ok) console.warn('[activity] watch refused:', r.error)
    })
    return () => window.forge.activity.unwatch(projectId)
    // `panes` is deliberately not a dependency: paneKey is its stable shape, and
    // depending on the array itself would re-watch on every render.
  }, [enabled, projectId, projectPath, paneKey])

  /* ------------------------------------------------------------ busy edges */

  const wasBusy = useRef(new Map<string, boolean>())

  useEffect(() => {
    if (!enabled || !projectId) {
      wasBusy.current.clear()
      return
    }

    const sync = (): void => {
      const seen = new Set<string>()
      for (const pane of panes) {
        seen.add(pane.paneId)
        const busy = terminalHost.isBusy(pane.paneId)
        if (wasBusy.current.get(pane.paneId) === busy) continue
        wasBusy.current.set(pane.paneId, busy)
        window.forge.activity.setBusy(projectId, pane.paneId, busy)
      }
      // A pane that has closed is a pane whose span must not go on collecting
      // changes it cannot have caused.
      for (const paneId of [...wasBusy.current.keys()]) {
        if (seen.has(paneId)) continue
        wasBusy.current.delete(paneId)
        window.forge.activity.setBusy(projectId, paneId, false)
      }
    }

    // Once now, so a pane that was already working when the section opened is
    // known before its next edge rather than after it.
    sync()
    return terminalHost.subscribeBusy(sync)
  }, [enabled, projectId, paneKey])

  return {
    snapshot: snapshot.projectId === projectId ? snapshot : EMPTY,
    claudePanes,
    clear: () => {
      if (!projectId) return
      window.forge.activity.clear(projectId)
      setSnapshot(EMPTY)
    }
  }
}

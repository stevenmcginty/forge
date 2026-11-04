import { collectLeaves } from '@shared/splitTree'
import type { Workspace } from '@shared/types'

/**
 * Claude Live's "Show me" (the contract's `show` event, and the desktop card's
 * button): lift one pane, by id, wherever it is — the same moves show_view
 * makes (src/lib/showView.ts `runShowView`), in its order: the project, then
 * the pane in it, then the agents view if a surface has the stage, then Forge
 * back on screen if it was away, then the keyboard into the pane. Unlike
 * show_view it leaves the layout alone: on the Wall the pane is already in
 * sight, in Full screen its tab comes to the front. The ring on it is the
 * Live UI's (src/components/live/LiveShowRing.tsx).
 *
 * The app is loaded on first use rather than imported, as show_view does, so
 * the check scripts can import `paneHome` headless.
 */

/** The project a pane lives in: the one on screen first, then any loaded one. Null when no loaded project has it. */
export function paneHome(
  workspaces: Readonly<Record<string, Pick<Workspace, 'tabs'>>>,
  paneId: string,
  onScreen: string | null
): string | null {
  const has = (ws: Pick<Workspace, 'tabs'> | undefined): boolean =>
    !!ws && ws.tabs.some((t) => collectLeaves(t.root).some((leaf) => leaf.id === paneId))
  if (onScreen && has(workspaces[onScreen])) return onScreen
  for (const [id, ws] of Object.entries(workspaces)) if (id !== onScreen && has(ws)) return id
  return null
}

/** Lift the pane. False when it is not open in any loaded project. Never rejects. */
export async function showPaneById(paneId: string): Promise<boolean> {
  try {
    const [{ readLiveApp }, { shellMode, surfacesNow }, { uiCommands }, { terminalHost }] = await Promise.all([
      import('@/state/AppState'),
      import('@/lib/shellSlots'),
      import('@/lib/uiCommands'),
      import('@/lib/terminals')
    ])
    const app = readLiveApp()
    const st = app?.get()
    if (!app || !st) return false
    const home = paneHome(st.workspaces, paneId, st.activeProjectId)
    if (!home) return false
    if (home !== st.activeProjectId) app.actions.selectProject(home)
    app.actions.revealPane(paneId)
    app.actions.focusPane(paneId)
    // A surface on the stage (the Browser, the Board) has the panes' room: back to the agents.
    const mode = shellMode.get()
    if (mode && surfacesNow().some((s) => s.id === mode)) uiCommands.run('set-mode', 'agents')
    try {
      await window.forge?.window?.revealIfAway?.({ maximise: false })
    } catch {
      /* an older preload: the switch stands without it */
    }
    // Timers, not rAF: frames stop while Forge is covered, and it may only now be coming up.
    window.setTimeout(() => terminalHost.focus(paneId), 60)
    return true
  } catch {
    return false
  }
}

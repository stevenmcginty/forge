import { isShellProfile } from '@shared/agents'
import { terminalName } from '@shared/terminal-names'
import type { AgentProfile, Workspace } from '@shared/types'
import { resolveProfile } from './agents'
import type { ActionPane } from './appactions'
import { collectLeaves } from './splitTree'
import { terminalHost } from './terminals'

/**
 * Every open terminal in a workspace, as the executor, the hub and Foreman see
 * it — one walk, three readers (VoiceAgent, useHubRuntime, Foreman), so the
 * numbering and the names cannot drift apart.
 *
 * Tabs in order, the panes inside each tab in order: the order the manifest
 * prints. Each pane is named by `terminalName` — its tab's name, or "Zeb 2".
 * `lastFocusedAt` is the voice agent's focus memory; the others have none.
 */
export function buildActionPanes(
  workspace: Workspace | null | undefined,
  profiles: AgentProfile[],
  lastFocusedAt: (paneId: string) => number = () => 0
): ActionPane[] {
  const out: ActionPane[] = []
  workspace?.tabs.forEach((tab, tabIndex) => {
    collectLeaves(tab.root).forEach((leaf, indexInTab) => {
      const profile = resolveProfile(profiles, leaf.profileId)
      const status = terminalHost.runtime(leaf.id).status
      out.push({
        paneId: leaf.id,
        tabId: tab.id,
        tabNumber: tabIndex + 1,
        tabTitle: tab.title,
        number: out.length + 1,
        name: terminalName(tab.title, leaf.title, indexInTab),
        profileId: profile.id,
        profileName: profile.name,
        // Reachable, not visible — a background tab's pane is 'idle' because
        // nothing has mounted it yet, and the runner will wake it.
        live: status !== 'exited' && status !== 'error',
        focused: leaf.id === tab.activePaneId && tab.id === workspace.activeTabId,
        agent: !isShellProfile(profile),
        lastFocusedAt: lastFocusedAt(leaf.id)
      })
    })
  })
  return out
}

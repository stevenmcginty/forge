import { useCallback } from 'react'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveWorkspace, useApp } from '@/state/AppState'

/**
 * Hand a written brief to a live agent, typed and never submitted.
 *
 * Lifted out of GitSection, unchanged, when the SHARE section needed the same
 * gesture: "here is some text, put it in front of an agent" is a rail-wide move
 * rather than a git one, and two copies of the rules below would be two copies
 * that drift the first time one of them is fixed.
 *
 * The pane is looked for in the order a person would expect it to be found: the
 * one you are in, then the tab you are looking at, then anywhere in the project.
 * Only live panes, and never a shell — a multi-sentence brief typed at a
 * PowerShell prompt is a very long command that does not exist.
 *
 * `paste`, not `type`: `type()` flattens newlines to spaces and charges the whole
 * thing to the take-back draft, which is right for a one-line command and wrong
 * for a brief. The frame in between is the DECSET 1004 race documented on
 * TerminalPane's file drop — an agent that has just been told the terminal lost
 * focus will drop the paste that follows it.
 *
 * And it never presses Enter. Every caller of this is a button in the rail, and a
 * button in the rail that submits work to an agent is a button that acts on its
 * own; the brief lands in the composer and the person reads it before it goes.
 *
 * `label` names the pane that gets opened when there is no usable one — 'Git',
 * 'Share' — so a brief is never dropped for want of somewhere to put it.
 */
export function useHandOff(label: string): (prompt: string) => void {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()

  return useCallback(
    (prompt: string): void => {
      if (!prompt) return
      const profiles = state.settings.agentProfiles
      const usable = (paneId: string, profileId: string): boolean =>
        terminalHost.runtime(paneId).status === 'live' && !isShellProfile(resolveProfile(profiles, profileId))

      const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null
      const inActive = activeTab ? collectLeaves(activeTab.root) : []
      const everywhere = workspace.tabs.flatMap((t) => collectLeaves(t.root))

      const current = inActive.find((l) => l.id === activeTab?.activePaneId)
      const target =
        (current && usable(current.id, current.profileId) ? current : null) ??
        inActive.find((l) => usable(l.id, l.profileId)) ??
        everywhere.find((l) => usable(l.id, l.profileId)) ??
        null

      if (target) {
        actions.revealPane(target.id)
        requestAnimationFrame(() => terminalHost.paste(target.id, prompt))
        return
      }

      actions.openAgentPane(label, prompt)
    },
    [actions, label, state.settings.agentProfiles, workspace]
  )
}

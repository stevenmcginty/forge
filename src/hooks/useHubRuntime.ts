import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { buildActionPanes } from '@/lib/actionPanes'
import { hubApi } from '@/lib/hubApi'
import { runSavedPrompt, setHubRuntime } from '@/lib/hubRuntime'
import type { NavPane } from '@/lib/hubnav'
import { getPrompts, subscribePrompts } from '@/lib/hubStores'
import type { KeyCommandDef } from '@/lib/keymap'
import { defineCommands, loadKeymapOverrides, setCommandHandler } from '@/lib/keymapRegistry'
import { relayComet } from '@/lib/relayComet'
import { agentCommandId, promptCommandId } from '@/lib/shortcutCommands'
import { terminalHost } from '@/lib/terminals'
import { useActiveWorkspace, useApp } from '@/state/AppState'

/**
 * Keeps the hub's backends in step with the app. Mounted exactly once, from
 * useShortcuts (which App mounts once):
 *
 *  - tells main which project is open, so bridge-out media lands on its board;
 *  - registers the hub runtime (panes by their one name, focus, typing) that
 *    the voice tools and the keymap use;
 *  - loads keymap.json and keeps two command sources current: one command per
 *    saved prompt (its hotkey as the default) and one "new pane" per agent
 *    profile (unbound until Steve binds it).
 */
export function useHubRuntime(): void {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const projectId = state.activeProjectId
  const prompts = useSyncExternalStore(subscribePrompts, getPrompts)
  const profiles = state.settings.agentProfiles

  /* ------------------------------------------------------- the pane list */

  // Each pane by its one name (shared/terminal-names.ts). `callSign` carries
  // the same name for the pane UI that still reads it until it moves to `name`.
  const panes = useMemo<NavPane[]>(
    () => buildActionPanes(workspace, profiles).map((p) => ({ ...p, callSign: p.name })),
    [workspace, profiles]
  )

  useEffect(() => {
    void hubApi()?.canvas.setActive(projectId).catch(() => {})
  }, [projectId])

  /* ------------------------------------------------------------ runtime */

  const live = useRef({ panes, workspace, projectId, actions })
  live.current = { panes, workspace, projectId, actions }

  useEffect(() => {
    setHubRuntime({
      panes: () => live.current.panes,
      focusedPaneId: () => {
        const ws = live.current.workspace
        return ws.tabs.find((t) => t.id === ws.activeTabId)?.activePaneId ?? null
      },
      activeProjectId: () => live.current.projectId,
      prompts: getPrompts,
      revealPane: (paneId) => {
        live.current.actions.revealPane(paneId)
        live.current.actions.focusPane(paneId)
      },
      focusTerminal: (paneId) => terminalHost.focus(paneId),
      typeIntoPane: (paneId, text, submit) => {
        if (terminalHost.runtime(paneId).status === 'exited') return false
        if (/[\r\n]/.test(text)) terminalHost.paste(paneId, text)
        else if (!terminalHost.type(paneId, text)) return false
        if (submit) terminalHost.submit(paneId)
        // The main agent (typed to, or talked to) just relayed words into a
        // pane: the comet shows them going from the bar to that pane.
        relayComet(paneId)
        return true
      }
    })
    return () => setHubRuntime(null)
  }, [])

  // One pane's agent sent to another (pane_send, in main): the comet flies
  // between them. Optional-chained — a stale preload has no onRelay.
  useEffect(() => window.forge?.pty?.onRelay?.((e) => relayComet(e.to, e.from)), [])

  /* ------------------------------------------------------------- keymap */

  useEffect(() => {
    void loadKeymapOverrides()
  }, [])

  useEffect(() => {
    const defs: KeyCommandDef[] = prompts.map((p) => ({
      id: promptCommandId(p.id),
      title: `Prompt: ${p.title}`,
      group: 'Saved prompts',
      defaultKeys: p.hotkey ? [p.hotkey] : [],
      scope: 'workspace'
    }))
    const offDefs = defineCommands('prompts', defs)
    const offHandlers = prompts.map((p) =>
      setCommandHandler(promptCommandId(p.id), () => {
        const current = getPrompts().find((x) => x.id === p.id)
        if (!current) return false
        runSavedPrompt(current, { source: 'keyboard' })
        return true
      })
    )
    return () => {
      offHandlers.forEach((off) => off())
      offDefs()
    }
  }, [prompts])

  useEffect(() => {
    const defs: KeyCommandDef[] = profiles.map((p) => ({
      id: agentCommandId(p.id),
      title: `New ${p.name} pane`,
      group: 'Agents',
      defaultKeys: [],
      scope: 'workspace'
    }))
    const offDefs = defineCommands('agents', defs)
    const offHandlers = profiles.map((p) =>
      setCommandHandler(agentCommandId(p.id), () => {
        live.current.actions.newTab(p.id)
        return true
      })
    )
    return () => {
      offHandlers.forEach((off) => off())
      offDefs()
    }
  }, [profiles])
}

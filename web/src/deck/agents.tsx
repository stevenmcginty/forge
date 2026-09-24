import { useMemo, type ReactNode } from 'react'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import type { AgentProfile, PaneLeaf, TerminalTab } from '@shared/types'
import { usePaneStatus } from '../lib/pane-status'
import { useForge, useProfiles, useWorkspace } from '../state'

/*
 * What the deck face knows about each agent in the project, shared by the top
 * bar's Agents menu and the Wall's tile labels, so both say the same word for
 * the same pane.
 */

export interface DeckAgent {
  leaf: PaneLeaf
  tab: TerminalTab
  profile: AgentProfile
  title: string
}

/** Every pane in the active project, tab by tab, in the order the desk has them. */
export function useDeckAgents(): {
  agents: DeckAgent[]
  /** The pane the dock talks to: the front tab's active pane (or its first). */
  current: DeckAgent | null
  tabCount: number
} {
  const workspace = useWorkspace()
  const profiles = useProfiles()
  return useMemo(() => {
    const agents = workspace.tabs.flatMap((tab) =>
      collectLeaves(tab.root).map((leaf) => {
        const profile = resolveProfile(profiles, leaf.profileId)
        return { leaf, tab, profile, title: paneDisplayTitle(profile, leaf.title) }
      })
    )
    const front = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null
    const inFront = front ? agents.filter((a) => a.tab.id === front.id) : []
    const current = inFront.find((a) => a.leaf.id === front?.activePaneId) ?? inFront[0] ?? null
    return { agents, current, tabCount: workspace.tabs.length }
  }, [workspace, profiles])
}

/**
 * A pane's condition, as the deck's StateChip names it. Always a shape and a
 * word; the colour only agrees with them.
 */
export type DeckAgentState = 'attention' | 'working' | 'idle' | 'dormant' | 'frozen'

export const STATE_WORD: Record<DeckAgentState, string> = {
  attention: 'Needs you',
  working: 'Working',
  idle: 'Idle',
  dormant: 'Not running',
  frozen: 'Frozen'
}

export function useAgentState(paneId: string | null): { state: DeckAgentState; word: string; detail?: string } {
  const { state } = useForge()
  const status = usePaneStatus(paneId)
  if (!paneId) return { state: 'dormant', word: STATE_WORD.dormant }
  if (state.stage.kind === 'offline') return { state: 'frozen', word: STATE_WORD.frozen }
  if (state.asking.has(paneId)) return { state: 'attention', word: STATE_WORD.attention }
  const alive = (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  if (!alive) return { state: 'dormant', word: STATE_WORD.dormant }
  if (status?.busy) return { state: 'working', word: STATE_WORD.working, detail: status.activity }
  return { state: 'idle', word: STATE_WORD.idle }
}

/**
 * The shapes: a diamond waits on you, a turning arc works, a ring is idle, a
 * bar has no process behind it, a square is the last picture of a sleeping desk.
 */
export function AgentStateGlyph({ state }: { state: DeckAgentState }): ReactNode {
  return (
    <svg className="dk-sglyph" data-state={state} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'attention' ? <path d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z" fill="currentColor" /> : null}
      {state === 'working' ? (
        <path d="M5 1.4 A3.6 3.6 0 1 1 1.4 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : null}
      {state === 'idle' ? <circle cx="5" cy="5" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'dormant' ? <rect x="1.4" y="4.2" width="7.2" height="1.6" rx="0.8" fill="currentColor" /> : null}
      {state === 'frozen' ? (
        <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      ) : null}
    </svg>
  )
}

/** The chip: shape, word, and — for a working agent — what it is doing, in its title. */
export function AgentStateChip({ paneId, compact = false }: { paneId: string; compact?: boolean }): ReactNode {
  const { state, word, detail } = useAgentState(paneId)
  return (
    <span className="dk-schip" data-state={state} data-compact={compact ? 'true' : undefined} title={detail ?? word}>
      <AgentStateGlyph state={state} />
      <span className="dk-schip__word">{word}</span>
    </span>
  )
}

/**
 * Bring a pane forward: its tab first, then the focus ring. Every step is a
 * request the desktop answers with a workspace push — nothing here moves the
 * picture itself. Resolves with the desktop's refusal, if it refused.
 */
export async function bringForward(
  actions: ReturnType<typeof useForge>['actions'],
  activeTabId: string | null,
  agent: DeckAgent
): Promise<string | null> {
  if (agent.tab.id !== activeTabId) {
    const refused = await actions.layout({ op: 'select-tab', tabId: agent.tab.id })
    if (refused) return refused
  }
  if (agent.leaf.id !== agent.tab.activePaneId || agent.tab.id !== activeTabId) {
    const refused = await actions.layout({ op: 'focus-pane', paneId: agent.leaf.id })
    if (refused) return refused
  }
  return null
}

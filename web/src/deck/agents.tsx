import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import '@/components/ActivityDot.css'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import type { AgentProfile, PaneLeaf, TerminalTab } from '@shared/types'
import { usePaneDone, usePaneStatus } from '../lib/pane-status'
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
  /** The pane's name: "Claude Code". */
  title: string
  /** Its tab's own name ("Wanda"), when that says more than `title`; else null. */
  tabName?: string | null
}

/**
 * A tab's name as the words' destination: "Wanda" beside "Claude Code". Null
 * when the tab has none, or its name is only the pane's own again.
 */
export function tabNameFor(tabTitle: string | undefined, paneTitle: string): string | null {
  const name = (tabTitle ?? '').trim()
  return name && name !== paneTitle ? name : null
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
        const title = paneDisplayTitle(profile, leaf.title)
        return { leaf, tab, profile, title, tabName: tabNameFor(tab.title, title) }
      })
    )
    const front = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null
    const inFront = front ? agents.filter((a) => a.tab.id === front.id) : []
    const current = inFront.find((a) => a.leaf.id === front?.activePaneId) ?? inFront[0] ?? null
    return { agents, current, tabCount: workspace.tabs.length }
  }, [workspace, profiles])
}

/**
 * A pane's condition, in the desktop StateChip's shapes and words
 * (src/components/shell/StateChip.tsx) so a pane reads the same at the desk
 * and in a browser. Always a shape and a word; the colour only agrees with
 * them.
 *
 *   working       the TUI is mid-turn               filled dot
 *   attention     settled on a question             diamond
 *   done          a long stretch just finished      tick, then Ready
 *   idle          quiet at its prompt               ring
 *   dormant       no process behind the pane        bar
 *   reconnecting  the link to the desktop dropped   dashed square outline
 *   frozen        no desktop: the cached picture    square outline
 *
 * The desktop's starting / exited / failed have no web source (the wire says
 * only whether a pane has a session), so a pane without one is "Not running".
 */
export type DeckAgentState = 'attention' | 'working' | 'done' | 'idle' | 'dormant' | 'reconnecting' | 'frozen'

export const STATE_WORD: Record<DeckAgentState, string> = {
  attention: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Ready',
  dormant: 'Not running',
  reconnecting: 'Reconnecting',
  frozen: 'Frozen'
}

const STATE_TITLE: Record<DeckAgentState, string> = {
  attention: 'Waiting for you',
  working: 'Working',
  done: 'Finished — the pane went quiet after a long stretch of work',
  idle: 'Ready — quiet at its prompt',
  dormant: 'No process behind this pane right now',
  reconnecting: 'The link dropped — this is where the pane had got to, and it repaints when it comes back',
  frozen: 'No desktop — the last picture this browser was sent'
}

export function useAgentState(paneId: string | null): { state: DeckAgentState; word: string; detail: string } {
  const { state } = useForge()
  const status = usePaneStatus(paneId)
  const done = usePaneDone(paneId)
  const say = (s: DeckAgentState, detail?: string): { state: DeckAgentState; word: string; detail: string } => ({
    state: s,
    word: STATE_WORD[s],
    detail: detail ?? STATE_TITLE[s]
  })
  if (!paneId) return say('dormant')
  if (state.stage.kind === 'offline') return say('frozen')
  if (state.connection.state !== 'live') return say('reconnecting')
  if (state.asking.has(paneId)) return say('attention')
  const alive = (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  if (!alive) return say('dormant')
  if (status?.busy) return say('working', status.activity)
  if (done) return say('done')
  return say('idle')
}

/**
 * The shapes, drawn as the desktop's StateGlyph draws them: filled dot, diamond,
 * tick, ring, bar — distinct in outline alone. The two link states are this
 * face's own: a square outline for the last picture of a sleeping desk, dashed
 * while the link is only down.
 */
export function AgentStateGlyph({ state }: { state: DeckAgentState }): ReactNode {
  return (
    <svg className="dk-sglyph" data-state={state} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'working' ? <circle cx="5" cy="5" r="3.6" fill="currentColor" /> : null}
      {state === 'attention' ? <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="currentColor" /> : null}
      {state === 'done' ? (
        <path
          d="M1.4 5.4 L4 7.8 L8.8 2.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {state === 'idle' ? <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'dormant' ? <rect x="1.5" y="4.2" width="7" height="1.6" rx="0.8" fill="currentColor" /> : null}
      {state === 'reconnecting' ? (
        <rect
          x="1.8"
          y="1.8"
          width="6.4"
          height="6.4"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeDasharray="1.8 1.4"
        />
      ) : null}
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
    <span className="dk-schip" data-state={state} data-compact={compact ? 'true' : undefined} title={detail}>
      <AgentStateGlyph state={state} />
      <span className="dk-schip__word">{word}</span>
    </span>
  )
}

/** How long the pulse holds after a burst of output (the desktop ActivityDot's). */
const PULSE_HOLD_MS = 620

/**
 * The desktop's ActivityDot for a browser: a small light that pulses when the
 * pane prints something. Fed by the same per-pane `data` stream the terminal
 * draws from (a catch-up replay is a repaint, not news, so it does not light
 * it). Motion and a halo, never a colour alone; the state chip beside it
 * carries the word. Driven straight on the DOM node, as the desktop's is:
 * output arrives in bursts, and a render per burst per tile is waste.
 * Its look is the desktop's own stylesheet (reduced motion: no pulse).
 */
export function OutputPulse({ paneId }: { paneId: string }): ReactNode {
  const { actions } = useForge()
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let timer: number | undefined
    const stop = actions.onData(paneId, (_data, replay) => {
      const dot = ref.current
      if (replay || !dot) return
      dot.classList.add('is-active')
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => dot.classList.remove('is-active'), PULSE_HOLD_MS)
    })
    return () => {
      stop()
      if (timer) window.clearTimeout(timer)
    }
  }, [actions, paneId])

  return <span ref={ref} className="activity-dot" aria-hidden="true" />
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

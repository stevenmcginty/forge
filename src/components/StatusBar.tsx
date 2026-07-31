import { type ReactNode } from 'react'
import { resolveProfile } from '@/lib/agents'
import { findLeaf } from '@/lib/splitTree'
import { useActiveProject, useActiveTab, useApp, usePaneCount } from '@/state/AppState'
import { AgentButton } from './AgentButton'
import { DictationPill } from './DictationPill'
import './StatusBar.css'

/** Thin bar of truth: where you are, how many shells are alive, what just happened. */
export function StatusBar(): ReactNode {
  const { state } = useApp()
  const project = useActiveProject()
  const tab = useActiveTab()
  const { used, max } = usePaneCount()

  const leaf = tab ? findLeaf(tab.root, tab.activePaneId) : null
  const profile = leaf ? resolveProfile(state.settings.agentProfiles, leaf.profileId) : null

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        {project ? (
          <>
            <span className="statusbar__dot" style={{ background: project.color }} />
            <span className="statusbar__project">{project.name}</span>
            <span className="statusbar__path mono truncate">{project.path}</span>
          </>
        ) : (
          <span className="statusbar__path mono">no project selected</span>
        )}
      </div>

      <div className="statusbar__center">
        {state.notice ? <span className="statusbar__notice">{state.notice}</span> : null}
      </div>

      <div className="statusbar__right">
        {/* The two microphones, as a pair. Tighter than the bar's own gap so
            they read as one control group — "talk to the agent" and "type into
            this pane" are the same decision, made twice a minute. The pill keeps
            the right-hand slot it has always had: it is the voice hub's dock,
            and dragging starts from a place your hand already knows. */}
        <div className="statusbar__voice">
          <AgentButton />
          <DictationPill />
        </div>
        <span className="statusbar__hint mono">Ctrl+T tab · Ctrl+W close · Alt+↑↓←→ focus</span>
        {profile ? (
          <span className="statusbar__agent mono" style={{ color: profile.accent }}>
            {profile.name}
          </span>
        ) : null}
        <span className="statusbar__sessions mono" title="Terminal panes across all projects / limit">
          {used}/{max}
        </span>
      </div>
    </footer>
  )
}

import type { ReactNode } from 'react'
import { useActiveProject } from '@/state/AppState'
import { EmptyState } from '../EmptyState'
import { RailSection } from './RailSection'
import './ActivitySection.css'

/**
 * Which agent is touching which file.
 *
 * **Slice 1 is the chrome only** — see the same note on GitSection. The two
 * halves that fill this land in slices 8 and 9: exact attribution read out of
 * Claude Code's own transcripts, and inferred attribution for every other agent
 * from a folder watcher plus which pane happened to be working.
 *
 * The section defaults off, and of everything in this feature it is the one that
 * most deserves to: it is the only part of Forge that watches a project folder
 * on its own initiative, and that should be a thing Steve turns on rather than a
 * thing he discovers.
 */
export function ActivitySection(): ReactNode {
  const project = useActiveProject()

  return (
    <RailSection id="activity" title="Activity" hint="Which agent is touching which file">
      <div className="asec">
        {project ? (
          <EmptyState
            icon="history"
            size="sm"
            title="Nothing touched yet"
            body="This fills in as your agents work."
          />
        ) : (
          <EmptyState icon="history" size="sm" title="No project" body="Select a project to watch its files." />
        )}
      </div>
    </RailSection>
  )
}

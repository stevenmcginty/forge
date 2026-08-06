import type { ReactNode } from 'react'
import { useActiveProject } from '@/state/AppState'
import { EmptyState } from '../EmptyState'
import { RailSection } from './RailSection'
import './GitSection.css'

/**
 * Where this project stands: branch, what has changed, whether it is pushed.
 *
 * **Slice 1 is the chrome only.** The section exists, takes its place in the
 * stack, opens, closes and drags to height like the other three — and says
 * plainly that it has nothing to tell you yet. The git service behind it lands
 * in slice 3; until then this is the shape of the hole it fills, which is worth
 * having on screen first so the layout is settled before there is data to blame.
 *
 * The one thing this section must never do, at any slice, is treat "no git" as a
 * fault. A folder with no repository is the state Forge was built for first and
 * the state most of Steve's folders are in; git is the addition, and every empty
 * state here says so in those words.
 */
export function GitSection(): ReactNode {
  const project = useActiveProject()

  return (
    <RailSection id="git" title="Git" hint="Branch, changes, and whether this project is pushed">
      <div className="gsec">
        {project ? (
          <EmptyState
            icon="branch"
            size="sm"
            title="Not reading git yet"
            body="This section is in place; the part that asks git about this folder lands next."
          />
        ) : (
          <EmptyState icon="branch" size="sm" title="No project" body="Select a project to see where it stands." />
        )}
      </div>
    </RailSection>
  )
}

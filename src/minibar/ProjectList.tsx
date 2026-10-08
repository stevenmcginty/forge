import type { ReactNode } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { Eyebrow, Sheet } from './Sheet'

/** The project pill's list: every project, with how many agents are running in it. */
export function ProjectList({
  state,
  onPick,
  onClose
}: {
  state: MiniBarState
  onPick: (id: string) => void
  onClose: () => void
}): ReactNode {
  return (
    <Sheet
      className="mb-projects"
      label="Projects"
      onClose={onClose}
      head={
        <>
          <Eyebrow>Projects</Eyebrow>
          <span className="mb-sheet__count">{state.projects.length}</span>
        </>
      }
    >
      <ul className="mb-sheet__body mb-rows">
        {state.projects.map((p) => {
          const here = p.id === state.project?.id
          return (
            <li key={p.id}>
              <button type="button" className="mb-row mb-projrow" data-here={here ? 'true' : undefined} aria-current={here ? 'true' : undefined} onClick={() => onPick(p.id)}>
                <span className="mb-projrow__tick" aria-hidden="true">
                  {here ? <Icon name="check" size={14} /> : null}
                </span>
                <span className="mb-projrow__name">{p.name}</span>
                <span className="mb-projrow__count" data-zero={p.running ? undefined : 'true'}>
                  {p.running ? `${p.running} running` : 'none running'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

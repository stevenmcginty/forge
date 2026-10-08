import type { ReactNode } from 'react'
import type { MiniBarAgent, MiniBarCall, MiniBarState } from '@shared/minibar'
import { STATUS_WORD } from './format'
import { AgentMark, StateMark } from './glyphs'
import { Eyebrow, Sheet } from './Sheet'

/**
 * Every agent in every project, grouped by project, each with its state and
 * its last line. Picking one switches project if it has to, aims the box at
 * that agent and opens its Peek.
 */
export function AllAgents({
  state,
  call,
  onClose
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  onClose: () => void
}): ReactNode {
  const groups = state.projects
    .map((p) => ({ project: p, agents: state.agents.filter((a) => a.projectId === p.id) }))
    .filter((g) => g.agents.length > 0)
  // The current project first, the rest as the host lists them.
  groups.sort((a, b) => Number(b.project.id === state.project?.id) - Number(a.project.id === state.project?.id))

  const pick = (a: MiniBarAgent): void => {
    if (a.projectId !== state.project?.id) call({ t: 'project', id: a.projectId })
    call({ t: 'target', to: { kind: 'pane', paneId: a.paneId } })
    call({ t: 'peek', paneId: a.paneId })
  }

  const target = state.target.kind === 'pane' ? state.target.paneId : null

  return (
    <Sheet
      className="mb-all"
      label="All agents"
      onClose={onClose}
      head={
        <>
          <Eyebrow>All agents</Eyebrow>
          <span className="mb-sheet__count">{state.agents.length}</span>
        </>
      }
    >
      {groups.length ? (
        <div className="mb-sheet__body">
          {groups.map(({ project, agents }) => (
            <section key={project.id} className="mb-group">
              <h3 className="mb-group__head">
                {project.name}
                {project.id === state.project?.id ? <span className="mb-group__here">this project</span> : null}
              </h3>
              <ul className="mb-rows">
                {agents.map((a) => (
                  <li key={a.paneId}>
                    <button type="button" className="mb-row mb-agentrow" data-status={a.status} data-target={a.paneId === target ? 'true' : undefined} onClick={() => pick(a)}>
                      <AgentMark brand={a.brand} size={20} />
                      <span className="mb-agentrow__name">{a.name}</span>
                      <span className="mb-statepill" data-status={a.status}>
                        <StateMark status={a.status} size={9} />
                        {STATUS_WORD[a.status]}
                      </span>
                      <span className="mb-agentrow__line">{a.line ?? ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="mb-sheet__empty">No agents running. Press + to start one.</p>
      )}
    </Sheet>
  )
}

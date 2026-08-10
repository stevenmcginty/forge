import { type CSSProperties, type ReactNode } from 'react'
import { collectLeaves } from '@/lib/splitTree'
import type { Project } from '@shared/types'
import { shortPath } from '../lib/paths'
import { useForge } from '../state'
import { GitPanel } from './GitPanel'

/**
 * The project rail, drawn with the desktop's own `.rail` and `.prow` classes.
 *
 * Read-only compared with the desktop's: there is no "add a project" here and
 * there cannot be, because adding one means picking a folder on a machine this
 * page is not on — and the protocol deliberately models no path a browser can
 * send (shared/web.ts: "Nothing on this wire chooses a cwd or an executable").
 * Selecting one is a `select-project` layout op, so the desk follows.
 *
 * The attention dot is `WebAttentionFrame`: which pane has settled on a
 * question, so a project you are not looking at can say that something in it is
 * waiting.
 */
export function Rail({ collapsed }: { collapsed: boolean }): ReactNode {
  const { state, actions } = useForge()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  const workspaces = state.picture?.workspaces ?? state.cached?.workspaces ?? {}
  const sessions = state.picture?.sessions ?? state.cached?.sessions ?? []

  const paneCount = (project: Project): number => {
    const workspace = workspaces[project.id]
    if (!workspace) return 0
    const ids = new Set(workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => leaf.id)))
    return sessions.filter((s) => ids.has(s.id)).length
  }

  const attention = (project: Project): boolean => {
    const workspace = workspaces[project.id]
    if (!workspace) return false
    return workspace.tabs.some((tab) => collectLeaves(tab.root).some((leaf) => state.asking.has(leaf.id)))
  }

  return (
    <div className="rail" data-collapsed={collapsed}>
      {/*
        No header when collapsed, for the reason ProjectRail.tsx gives about its
        own: "at 56px there is no header to speak of, and the dot column *is* the
        rail." The desktop still draws a bare one there because it holds the
        add-project button; this rail has no such button — a browser cannot pick
        a folder on somebody else's disk — so there is nothing left to draw.
      */}
      {collapsed ? null : (
        <div className="rail__head">
          <span className="eyebrow">Projects</span>
          <span className="rail__count mono">{projects.length}</span>
        </div>
      )}

      <div className="rail__list">
        {projects.map((project) => {
          const panes = paneCount(project)
          const select = (): void => actions.selectProject(project.id)
          return (
            <div
              key={project.id}
              className="prow"
              // A div with a role rather than a <button>, because the desktop's
              // row is a div and `.prow`'s layout assumes it: a button centres
              // its content, which pushes the name into the middle of the rail
              // and the path under it. The role and the key handler are the one
              // thing added — the desktop's row has neither, and a rail you
              // cannot tab through is not something to copy faithfully.
              role="button"
              tabIndex={0}
              data-active={project.id === state.projectId}
              data-attention={attention(project) ? 'true' : undefined}
              title={`${project.name} — ${project.path}`}
              style={{ '--prow-tint': project.color } as CSSProperties}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select()
                }
              }}
            >
              <span className="prow__dot" style={{ background: project.color }} />
              {collapsed ? (
                <span className="prow__initial">{project.name.slice(0, 1).toUpperCase()}</span>
              ) : (
                <>
                  <span className="prow__text">
                    <span className="prow__name truncate">{project.name}</span>
                    <span className="prow__path mono truncate">{shortPath(project.path)}</span>
                  </span>
                  <span className="prow__panes mono">{panes}</span>
                </>
              )}
            </div>
          )
        })}
        {projects.length === 0 ? (
          <p className="rail__empty">
            No projects on that desktop yet. Add one in Forge on the machine itself — a browser cannot pick a folder on
            somebody else’s disk.
          </p>
        ) : null}
      </div>

      <GitPanel collapsed={collapsed} />
    </div>
  )
}

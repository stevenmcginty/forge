import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_SESSIONS } from '@shared/ipc'
import { newSessionId } from '@shared/session'
import { paneStatusLabel, useAnyBusy, usePaneRuntime } from '@/hooks/usePaneRuntime'
import { resolveProfile } from '@/lib/agents'
import { ensurePlannerPane, plannerPaneId, sendGoal } from '@/lib/planner'
import { terminalHost } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'
import { ActivityDot } from '../ActivityDot'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { TasksBoard } from './TasksBoard'
import './TasksWorkspace.css'

/**
 * The delegation desk — the Tasks panel maximized into the main content area.
 * A React flag swaps it in for the terminal grid (the mosaicZoom precedent):
 * no window tricks, and the wall of terminals keeps running behind it because
 * terminalHost owns every pane independently of what React has mounted.
 *
 * Two regions: the planner terminal, live and full size ('tab' attach, real
 * refit), and the board. The terminal is the star exhibit — you watch the
 * foreman think on the left, and deal the resulting hands on the right. It is
 * a real session: click in and argue with the plan; every new ```tasks reply
 * supersedes the proposal.
 *
 * Entering and leaving is lossless by construction: attach on mount, detach
 * on unmount, never dispose. Esc leaves — unless the caret is in the
 * terminal, where Esc belongs to the agent.
 */
export function TasksWorkspace(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const sessionId = workspace.plannerSessionId ?? null
  const projectId = project?.id ?? null
  const paneId = projectId ? plannerPaneId(projectId) : ''

  const termRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [blocked, setBlocked] = useState(false)

  const runtime = usePaneRuntime(paneId)
  const busy = useAnyBusy(projectId ? [paneId] : [])

  // Everything the attach needs, in a ref, so settings churn never re-attaches.
  const attachCtx = useRef({ project, settings: state.settings, sessionId, actions })
  attachCtx.current = { project, settings: state.settings, sessionId, actions }

  /* --------------------------------------------------------------- attach */

  useLayoutEffect(() => {
    const el = termRef.current
    const ctx = attachCtx.current
    if (!projectId || !el || !ctx.project) return
    const id = plannerPaneId(projectId)

    // First maximize is allowed to create the pane — lazily, and inside the
    // session budget. An existing pane always re-attaches, budget or not.
    if (!terminalHost.has(id) && terminalHost.liveCount() >= MAX_SESSIONS) {
      setBlocked(true)
      return
    }
    setBlocked(false)

    let sid = ctx.sessionId
    if (!sid) {
      sid = newSessionId()
      ctx.actions.setPlannerSessionId(sid)
    }
    ensurePlannerPane(el, ctx.project, ctx.settings, sid)
    return () => terminalHost.detach(id)
  }, [projectId])

  /* ------------------------------------------------------------------ esc */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      // Esc typed at the terminal belongs to the agent — it is how you
      // interrupt Claude mid-thought. Only Esc from the rest of the desk
      // leaves. An open popover owns its own Esc, and this handler was
      // registered first, so it steps aside rather than racing it.
      if (stageRef.current?.contains(document.activeElement)) return
      if (document.querySelector('.popover')) return
      e.preventDefault()
      e.stopPropagation()
      actions.setTasksMaximized(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [actions])

  // The last project can be removed while the desk is up; there is nothing
  // left to show, so hand the floor back rather than render an empty desk.
  useEffect(() => {
    if (!project) actions.setTasksMaximized(false)
  }, [project, actions])

  if (!project) return null

  const profile = resolveProfile(state.settings.agentProfiles, 'claude')
  const statusLabel = busy ? 'planning' : paneStatusLabel(runtime)

  const onGoal = (goal: string): void => {
    if (blocked) {
      actions.setNotice(`Session limit reached (${MAX_SESSIONS}) — close a pane to wake the planner`)
      return
    }
    sendGoal(paneId, goal, (message) => actions.setNotice(message))
  }

  return (
    <div className="tasksdesk">
      <header className="tasksdesk__head">
        <button
          type="button"
          className="ghost-btn tasksdesk__back"
          title="Back to the terminals (Esc)"
          onClick={() => actions.setTasksMaximized(false)}
        >
          <Icon name="chevronLeft" size={13} />
          Terminals
        </button>
        <span className="eyebrow">Delegation desk</span>
        <span className="tasksdesk__project truncate">{project.name}</span>
        <span className="tasksdesk__esc mono">Esc</span>
      </header>

      <div className="tasksdesk__body">
        <div className="tasksdesk__stage" ref={stageRef}>
          <div className="tasksdesk__stagehead">
            <AgentBadge profile={profile} size="sm" />
            <span className="tasksdesk__stagetitle">Planner</span>
            <ActivityDot paneId={paneId} status={runtime.status} />
            {statusLabel ? <span className="tasksdesk__stagestatus mono">{statusLabel}</span> : null}
            <button
              type="button"
              className="ghost-btn tasksdesk__restart"
              title="Restart the planner shell — the conversation resumes, the scrollback starts fresh"
              onClick={() => void terminalHost.restart(paneId)}
            >
              <Icon name="restart" size={11} />
            </button>
          </div>
          <div className="tasksdesk__term" ref={termRef} onClick={() => terminalHost.focus(paneId)} />
          {blocked ? (
            <div className="tasksdesk__blocked">
              <p className="tasksdesk__blocked-note">
                Session limit reached ({MAX_SESSIONS}) — the planner needs a free slot. Close a pane, then come
                back.
              </p>
            </div>
          ) : null}
        </div>

        <aside className="tasksdesk__board" aria-label="Delegation board">
          <TasksBoard project={project} variant="desk" autoFocus onGoal={onGoal} />
        </aside>
      </div>
    </div>
  )
}

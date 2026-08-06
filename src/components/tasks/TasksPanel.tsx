import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { MAX_SESSIONS } from '@shared/ipc'
import { newSessionId } from '@shared/session'
import { useAnyBusy, usePaneRuntime } from '@/hooks/usePaneRuntime'
import { ensurePlannerPane, plannerPaneId, plannerStore, sendGoal } from '@/lib/planner'
import { terminalHost, type PaneStatus } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { RailSection } from '../rail/RailSection'
import { TasksBoard } from './TasksBoard'
import './TasksPanel.css'

/**
 * The delegation dock — the Tasks panel's everyday, rail-width state, and the
 * replacement for the old TaskTray. Three sizes of one thing:
 *
 *  - collapsed rail: a pip with the card count;
 *  - docked: composer, live proposal, card stack, and an honest signal of what
 *    the planner session is doing — growable by dragging its top edge;
 *  - maximized: the dock hands over to <TasksWorkspace> in the main area and
 *    shrinks to a slim "open on the desk" bar, so there is one composer and
 *    one card stack on screen at a time.
 *
 * The planner session itself is a real `claude` pane (see src/lib/planner.ts).
 * The dock creates it lazily on the first stated goal, hosting it in an
 * offscreen seed box — the terminal is only *seen* on the desk, but the pty
 * behind it is the same either way, and it survives every dock/maximize/
 * project switch because nothing here ever calls dispose.
 *
 * **The chrome moved out.** The header, the count, the collapse and the
 * drag-to-grow handle now belong to <RailSection>, which draws the same ones for
 * all four rail sections; the height that used to live in
 * `localStorage['forge:tasksDockHeight']` lives in `settings.railHeights.tasks`
 * (RailStack folds the old key in once, on first run after the update). The
 * local `minimized` flag is gone with them: closing the section is what it was
 * for, and that is now a rail-wide gesture rather than one this panel invents.
 *
 * **Two things must not follow the chrome out**, and both have bitten:
 *
 *  - The seed box renders outside the section's collapsible body, so it stays
 *    mounted while the section is closed. `ensurePlannerPane` spawns against a
 *    laid-out container; if the box unmounts on collapse, stating a goal fails
 *    silently with no pane and no error.
 *  - Turning the Tasks section *off* in Settings hides this component. It must
 *    not dispose the planner: the session belongs to the workspace, and removing
 *    the project is what kills it.
 */

/** The one-word answer to "what is the planner doing right now". */
function plannerSignal(status: PaneStatus, busy: boolean): { word: string; tone: string } | null {
  if (status === 'idle') return null // no session yet — the dock stays quiet
  if (busy) return { word: 'planning', tone: 'busy' }
  switch (status) {
    case 'starting':
      return { word: 'starting', tone: 'warm' }
    case 'live':
      return { word: 'ready', tone: 'ok' }
    case 'exited':
      return { word: 'ended', tone: 'dead' }
    default:
      return { word: 'failed', tone: 'dead' }
  }
}

export function TasksPanel(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const collapsed = state.settings.railCollapsed
  const tasks = workspace.tasks ?? []
  const proposal = useSyncExternalStore(plannerStore.subscribe, () => (project ? plannerStore.proposal(project.id) : null))

  const projectId = project?.id ?? null
  const projectPath = project?.path ?? null
  const sessionId = workspace.plannerSessionId ?? null
  const paneId = projectId ? plannerPaneId(projectId) : ''

  const runtime = usePaneRuntime(paneId)
  const busy = useAnyBusy(projectId ? [paneId] : [])
  const signal = plannerSignal(runtime.status, busy)

  const seedRef = useRef<HTMLDivElement | null>(null)

  // Plans arrive whether or not a board is mounted to show them — a collapsed
  // rail must not be a hole the planner's answer falls into.
  useEffect(() => plannerStore.prime(), [])

  /* --------------------------------------------------------------- watch
   *
   * Tail the planner session's transcript for this project. Keyed on the
   * session id, not the pane: the transcript exists on disk whether or not a
   * pane is up, which is what makes a plan from before a restart arrive the
   * moment Forge is back. Re-watching replaces, switching projects unwatches.
   */
  useEffect(() => {
    if (!projectId || !projectPath || !sessionId) return
    void window.forge.planner.watch({ projectId, cwd: projectPath, sessionId }).then((r) => {
      if (!r.ok) console.warn('[tasks] planner watch refused:', r.error)
    })
    return () => window.forge.planner.unwatch(projectId)
  }, [projectId, projectPath, sessionId])

  /* A project switch takes the old planner's wrapper out of the seed box.
   * Detach only — the session keeps running; dispose is removeProject's job. */
  useEffect(() => {
    if (!projectId) return
    const id = plannerPaneId(projectId)
    return () => terminalHost.detach(id)
  }, [projectId])

  /* ---------------------------------------------------------------- goal */

  const onGoal = useCallback(
    (goal: string): void => {
      if (!project) return
      const id = plannerPaneId(project.id)
      if (!terminalHost.has(id)) {
        if (terminalHost.liveCount() >= MAX_SESSIONS) {
          actions.setNotice(`Session limit reached (${MAX_SESSIONS}) — close a pane to wake the planner`)
          return
        }
        const host = seedRef.current
        if (!host) return
        const sid = sessionId ?? newSessionId()
        if (sid !== sessionId) actions.setPlannerSessionId(sid)
        ensurePlannerPane(host, project, state.settings, sid)
      }
      sendGoal(id, goal, (message) => actions.setNotice(message))
    },
    [actions, project, sessionId, state.settings]
  )

  /*
   * Dismiss no longer minimizes on Steve's behalf. Closing the section is a rail
   * gesture now, and a button that both discards a plan and collapses the panel
   * was doing two things under one label — the second of which he could not
   * undo without knowing the panel had a hidden state.
   */
  const clearTasks = useCallback((): void => {
    for (const task of tasks) actions.removeTask(task.id)
    if (project) plannerStore.discard(project.id)
  }, [actions, project, tasks])

  /* -------------------------------------------------------------- render */

  if (!project) return null

  if (collapsed) {
    if (tasks.length === 0 && !busy) return null
    return (
      <div
        className="taskspanel taskspanel--collapsed"
        data-busy={busy ? 'true' : undefined}
        title={
          busy
            ? 'The planner is thinking — open the rail to see the plan land'
            : `${tasks.length} task${tasks.length === 1 ? '' : 's'} waiting — open the rail to deal them onto agents`
        }
      >
        <Icon name="check" size={16} />
        {tasks.length > 0 ? <span className="tray__pip mono">{tasks.length}</span> : null}
      </div>
    )
  }

  // While the desk is open the dock steps back to a slim bar: one composer and
  // one card stack on screen at a time, and the bar is the way back.
  if (state.tasksMaximized) {
    return (
      <button
        type="button"
        className="taskspanel taskspanel--desk"
        title="The delegation desk is open — click to dock it back"
        onClick={() => actions.setTasksMaximized(false)}
      >
        <span className="eyebrow">Tasks</span>
        {tasks.length > 0 ? <span className="tray__count mono">{tasks.length}</span> : null}
        {signal ? (
          <span className="taskspanel__signal" data-tone={signal.tone}>
            <span className="taskspanel__signal-dot" aria-hidden="true" />
            {signal.word}
          </span>
        ) : null}
        <span className="taskspanel__deskmark mono">on the desk</span>
      </button>
    )
  }

  return (
    <>
      <RailSection
        id="tasks"
        title="Tasks"
        count={tasks.length}
        hint="State a goal, get cards, drag them onto agents"
        status={
          signal ? (
            <span className="taskspanel__signal" data-tone={signal.tone}>
              <span className="taskspanel__signal-dot" aria-hidden="true" />
              {signal.word}
            </span>
          ) : null
        }
        actions={
          <>
            {tasks.length > 0 || proposal ? (
              <button
                type="button"
                className="ghost-btn taskspanel__clear"
                title="Dismiss this planning run"
                onClick={clearTasks}
              >
                <Icon name="trash" size={12} />
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-btn taskspanel__max"
              title="Open the delegation desk — the planner terminal beside the board. Esc comes back."
              onClick={() => actions.setTasksMaximized(true)}
            >
              <Icon name="expand" size={12} />
            </button>
          </>
        }
      >
        <section className="taskspanel" aria-label="Tasks panel">
          <div className="taskspanel__body">
            <TasksBoard project={project} variant="dock" onGoal={onGoal} />
          </div>
        </section>
      </RailSection>

      {/*
        The planner's nursery: a real-sized, offscreen box the pane is born in
        when a goal is stated from the dock. The terminal is only *shown* on
        the desk, but the pty needs a laid-out container to spawn against —
        640×400 is the host's default pane geometry, so the shell's first
        prompt is already a sane width.

        Outside <RailSection> on purpose, so it survives the section being
        closed. Inside the collapsible body it would unmount on collapse, and
        the next goal stated after re-opening would find no host and do nothing
        at all — no pane, no error, no clue.
      */}
      <div ref={seedRef} className="taskspanel__seed" aria-hidden="true" />
    </>
  )
}

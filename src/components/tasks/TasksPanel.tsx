import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { MAX_SESSIONS } from '@shared/ipc'
import { newSessionId } from '@shared/session'
import { useAnyBusy, usePaneRuntime } from '@/hooks/usePaneRuntime'
import { ensurePlannerPane, plannerPaneId, plannerStore, sendGoal } from '@/lib/planner'
import { terminalHost, type PaneStatus } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
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
 */

/** How tall the dock is allowed to be dragged, in px. */
const DOCK_MIN_H = 200
const DOCK_MAX_H = 640
const DOCK_DEFAULT_H = 240
const DOCK_KEY = 'forge:tasksDockHeight'

function clampDock(h: number): number {
  const ceiling = Math.min(DOCK_MAX_H, Math.round(window.innerHeight * 0.6))
  return Math.min(Math.max(Math.round(h), DOCK_MIN_H), Math.max(DOCK_MIN_H, ceiling))
}

function loadDockHeight(): number {
  const raw = Number(localStorage.getItem(DOCK_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampDock(raw) : DOCK_DEFAULT_H
}

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
  const [minimized, setMinimized] = useState(false)
  const proposal = useSyncExternalStore(plannerStore.subscribe, () => (project ? plannerStore.proposal(project.id) : null))

  const projectId = project?.id ?? null
  const projectPath = project?.path ?? null
  const sessionId = workspace.plannerSessionId ?? null
  const paneId = projectId ? plannerPaneId(projectId) : ''

  const runtime = usePaneRuntime(paneId)
  const busy = useAnyBusy(projectId ? [paneId] : [])
  const signal = plannerSignal(runtime.status, busy)

  const seedRef = useRef<HTMLDivElement | null>(null)
  const [dockH, setDockH] = useState(loadDockHeight)
  const grow = useRef<{ pointerId: number; y: number; h: number } | null>(null)

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

  const clearTasks = useCallback((): void => {
    for (const task of tasks) actions.removeTask(task.id)
    if (project) plannerStore.discard(project.id)
    setMinimized(true)
  }, [actions, project, tasks])

  /* ---------------------------------------------------------------- grow */

  const onGrowDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    grow.current = { pointerId: e.pointerId, y: e.clientY, h: dockH }
  }

  const onGrowMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grow.current
    if (!g || g.pointerId !== e.pointerId) return
    // The dock grows upward: dragging the handle up makes it taller.
    setDockH(clampDock(g.h + (g.y - e.clientY)))
  }

  const onGrowUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!grow.current || grow.current.pointerId !== e.pointerId) return
    grow.current = null
    setDockH((h) => {
      localStorage.setItem(DOCK_KEY, String(h))
      return h
    })
  }

  /* -------------------------------------------------------------- render */

  if (!project) return null

  if (minimized) {
    return (
      <button
        type="button"
        className="taskspanel taskspanel--minimized"
        title="Show the Tasks panel"
        aria-label="Show the Tasks panel"
        onClick={() => setMinimized(false)}
      >
        <span className="eyebrow">Tasks</span>
        {tasks.length > 0 ? <span className="tray__count mono">{tasks.length}</span> : null}
        {signal ? (
          <span className="taskspanel__signal" data-tone={signal.tone}>
            <span className="taskspanel__signal-dot" aria-hidden="true" />
            {signal.word}
          </span>
        ) : null}
        <Icon name="chevronDown" size={12} />
      </button>
    )
  }

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
    <section
      className="taskspanel"
      aria-label="Tasks panel"
      style={{ '--dock-h': `${dockH}px` } as React.CSSProperties}
    >
      {/* Steve's "make the task panel bigger": drag the top edge. */}
      <div
        className="taskspanel__grow"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to grow the tasks panel"
        onPointerDown={onGrowDown}
        onPointerMove={onGrowMove}
        onPointerUp={onGrowUp}
        onPointerCancel={onGrowUp}
      />

      <header className="tray__head">
        <span className="eyebrow">Tasks</span>
        {tasks.length > 0 ? <span className="tray__count mono">{tasks.length}</span> : null}
        {signal ? (
          <span className="taskspanel__signal" data-tone={signal.tone}>
            <span className="taskspanel__signal-dot" aria-hidden="true" />
            {signal.word}
          </span>
        ) : null}
        <div className="tray__head-actions">
          {tasks.length > 0 || proposal ? (
            <button
              type="button"
              className="ghost-btn taskspanel__clear"
              title="Dismiss this planning run and minimize the Tasks panel"
              onClick={clearTasks}
            >
              <Icon name="trash" size={12} />
              <span>Dismiss</span>
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
          <button
            type="button"
            className="ghost-btn taskspanel__min"
            title="Minimize the Tasks panel"
            aria-label="Minimize the Tasks panel"
            onClick={() => setMinimized(true)}
          >
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      </header>

      <div className="taskspanel__body">
        <TasksBoard project={project} variant="dock" onGoal={onGoal} />
      </div>

      {/*
        The planner's nursery: a real-sized, offscreen box the pane is born in
        when a goal is stated from the dock. The terminal is only *shown* on
        the desk, but the pty needs a laid-out container to spawn against —
        640×400 is the host's default pane geometry, so the shell's first
        prompt is already a sane width.
      */}
      <div ref={seedRef} className="taskspanel__seed" aria-hidden="true" />
    </section>
  )
}

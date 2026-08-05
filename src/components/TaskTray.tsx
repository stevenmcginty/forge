import { useState, type ReactNode } from 'react'
import { MAX_TASK_TEXT } from '@shared/ipc'
import { TASK_DRAG_TYPE } from '@/lib/mosaicLayout'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './TaskTray.css'

/**
 * The delegation tray. Write a task once — typed or dictated — and it becomes
 * a card; drag the card onto a pane or a mosaic tile and its text is typed
 * into that agent, ready for Enter. The card is the whole mechanism: there is
 * no queue engine, no board, no scheduler behind it, on purpose — assigning
 * work is something Steve does by hand, physically, the same way files and
 * screenshots already land on terminals.
 *
 * Cards live on the project's workspace, so they persist with the layout and
 * each project keeps its own tray.
 */
export function TaskTray(): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const collapsed = state.settings.railCollapsed
  const tasks = workspace.tasks ?? []
  const project = state.projects.find((p) => p.id === state.activeProjectId) ?? null

  const [draft, setDraft] = useState('')
  const [planning, setPlanning] = useState(false)

  const add = (): void => {
    const text = draft.trim()
    if (!text) return
    actions.addTask(text)
    setDraft('')
  }

  /**
   * The tray's brain: hand the goal to `claude -p` (electron/task-planner.ts)
   * and file what comes back as cards. Added in reverse so the plan reads
   * top-to-bottom on a newest-first tray. Dealing the cards out stays yours.
   */
  const plan = async (): Promise<void> => {
    const goal = draft.trim()
    if (!goal || !project || planning) return
    setPlanning(true)
    try {
      const result = await window.forge.tasks.plan(goal, project.name, project.path)
      if (!result.ok) {
        actions.setNotice(result.error)
        return
      }
      for (const text of [...result.tasks].reverse()) actions.addTask(text)
      setDraft('')
      actions.setNotice(
        `Claude split that into ${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'} — drag them onto agents`
      )
    } finally {
      setPlanning(false)
    }
  }

  if (collapsed) {
    if (tasks.length === 0) return null
    return (
      <div
        className="tasktray tasktray--collapsed"
        title={`${tasks.length} task${tasks.length === 1 ? '' : 's'} waiting — open the rail to drag them onto agents`}
      >
        <Icon name="check" size={16} />
        <span className="tray__pip mono">{tasks.length}</span>
      </div>
    )
  }

  return (
    <section className="tasktray" aria-label="Task tray">
      <header className="tray__head">
        <span className="eyebrow">Tasks</span>
        {tasks.length > 0 ? <span className="tray__count mono">{tasks.length}</span> : null}
      </header>

      <div className="tasktray__compose" data-planning={planning ? 'true' : undefined}>
        <textarea
          className="tasktray__input"
          value={draft}
          rows={2}
          maxLength={MAX_TASK_TEXT}
          placeholder="State a goal — Plan has Claude split it into task cards. + files it as one card."
          spellCheck={false}
          disabled={planning}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter asks Claude to plan the goal; Ctrl+Enter files it verbatim
            // as one card; Shift+Enter is a newline in a longer brief.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (e.ctrlKey) add()
              else void plan()
            }
          }}
        />
        <div className="tasktray__acts">
          <button
            type="button"
            className="ghost-btn tasktray__plan"
            title="Have Claude break this goal into task cards"
            disabled={!draft.trim() || planning || !project}
            onClick={() => void plan()}
          >
            {planning ? 'Planning…' : 'Plan'}
          </button>
          <button
            type="button"
            className="ghost-btn tasktray__add"
            title="File this text as a single card, as written (Ctrl+Enter)"
            disabled={!draft.trim() || planning}
            onClick={add}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      </div>

      {tasks.length > 0 ? (
        <div className="tasktray__list">
          {tasks.map((t) => (
            <div
              key={t.id}
              className="taskcard"
              title={`${t.text}\n\nDrag onto a pane or tile to hand it to that agent`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TASK_DRAG_TYPE, t.id)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
            >
              <span className="taskcard__grip" aria-hidden="true">
                <Icon name="grip" size={11} />
              </span>
              <span className="taskcard__text">{t.text}</span>
              <button
                type="button"
                className="taskcard__kill"
                title="Remove this task"
                onClick={() => actions.removeTask(t.id)}
              >
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

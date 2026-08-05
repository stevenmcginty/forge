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

  const [draft, setDraft] = useState('')

  const add = (): void => {
    const text = draft.trim()
    if (!text) return
    actions.addTask(text)
    setDraft('')
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

      <div className="tasktray__compose">
        <textarea
          className="tasktray__input"
          value={draft}
          rows={2}
          maxLength={MAX_TASK_TEXT}
          placeholder="Write a task, drag it onto an agent"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter files the card; Shift+Enter is a newline in a longer brief.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          className="ghost-btn tasktray__add"
          title="Add this task to the tray"
          disabled={!draft.trim()}
          onClick={add}
        >
          <Icon name="plus" size={13} />
        </button>
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

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
 * A stated goal goes through plan mode first: the brain answers with a plan
 * in prose plus proposed briefs, shown for approval. Nothing becomes a card
 * until Deal — the plan is reviewable, prunable and refusable, because
 * delegation you didn't sign off on is just automation wearing your name.
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
  /**
   * Plan mode. A goal does not turn straight into cards any more: the brain
   * answers with a plan (prose + proposed briefs), it lands here, and it waits.
   * Prune the briefs you don't want, then Deal makes them real cards — or
   * Discard and nothing ever existed. The proposal is deliberately local state:
   * an unapproved plan is a conversation, not data, and it should not survive
   * a restart or follow the workspace around.
   */
  const [proposal, setProposal] = useState<{ plan: string | null; tasks: string[] } | null>(null)

  const add = (): void => {
    const text = draft.trim()
    if (!text) return
    actions.addTask(text)
    setDraft('')
  }

  /** The tray's brain: hand the goal to `claude -p` (electron/task-planner.ts). */
  const brain = state.settings.taskPlannerBrain
  const brainName = brain === 'gemini' ? 'Gemini' : 'Claude'

  const plan = async (): Promise<void> => {
    const goal = draft.trim()
    if (!goal || !project || planning) return
    if (brain === 'gemini' && !state.settings.geminiKey.trim()) {
      actions.setNotice('No Gemini key — add one in Settings › Models & keys, or switch the tray to Claude')
      return
    }
    setPlanning(true)
    try {
      const request =
        brain === 'gemini'
          ? ({ kind: 'gemini', key: state.settings.geminiKey.trim(), model: state.settings.geminiModel } as const)
          : ({ kind: 'claude' } as const)
      const result = await window.forge.tasks.plan(goal, project.name, project.path, request)
      if (!result.ok) {
        actions.setNotice(result.error)
        return
      }
      setProposal({ plan: result.plan ?? null, tasks: result.tasks })
      setDraft('')
    } finally {
      setPlanning(false)
    }
  }

  /** Approve the plan: the surviving briefs become cards, newest-first tray so
   *  they are added in reverse to read top-to-bottom. Dealing them out stays yours. */
  const deal = (): void => {
    if (!proposal) return
    for (const text of [...proposal.tasks].reverse()) actions.addTask(text)
    actions.setNotice(
      `${proposal.tasks.length} card${proposal.tasks.length === 1 ? '' : 's'} filed — drag them onto agents`
    )
    setProposal(null)
  }

  const dropProposed = (index: number): void => {
    if (!proposal) return
    const tasks = proposal.tasks.filter((_, i) => i !== index)
    if (tasks.length === 0) setProposal(null)
    else setProposal({ ...proposal, tasks })
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
        <div className="tray__head-actions">
          {/* The planner's brain, right where Plan lives — not buried in
              Settings. Claude needs no key; Gemini rides the voice brain's. */}
          <button
            type="button"
            className="ghost-btn tasktray__brain mono"
            title={`Planning with ${brainName} — click to switch to ${brain === 'gemini' ? 'Claude' : 'Gemini'}`}
            disabled={planning}
            onClick={() => actions.setTaskPlannerBrain(brain === 'gemini' ? 'claude' : 'gemini')}
          >
            {brainName}
          </button>
        </div>
      </header>

      <div className="tasktray__compose" data-planning={planning ? 'true' : undefined}>
        <textarea
          className="tasktray__input"
          value={draft}
          rows={2}
          maxLength={MAX_TASK_TEXT}
          placeholder={`State a goal — ${brainName} plans it out for your approval. + files it as one card.`}
          spellCheck={false}
          disabled={planning}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter asks the brain to plan the goal; Ctrl+Enter files it
            // verbatim as one card; Shift+Enter is a newline in a longer brief.
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
            title={`Have ${brainName} plan this goal — you approve before any card is made`}
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

      {proposal ? (
        <div className="tasktray__proposal" aria-label="Proposed plan">
          {proposal.plan ? <p className="tasktray__plantext">{proposal.plan}</p> : null}
          <div className="tasktray__proposed">
            {proposal.tasks.map((text, i) => (
              <div key={`${i}-${text.slice(0, 24)}`} className="taskcard taskcard--proposed" title={text}>
                <span className="taskcard__text">{text}</span>
                <button
                  type="button"
                  className="taskcard__kill"
                  title="Drop this brief from the plan"
                  onClick={() => dropProposed(i)}
                >
                  <Icon name="close" size={9} />
                </button>
              </div>
            ))}
          </div>
          <div className="tasktray__verdict">
            <button
              type="button"
              className="ghost-btn tasktray__deal"
              title="Approve the plan — these briefs become cards you deal onto agents"
              onClick={deal}
            >
              Deal {proposal.tasks.length} card{proposal.tasks.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="ghost-btn tasktray__discard"
              title="Throw the plan away — no cards are made"
              onClick={() => setProposal(null)}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}

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

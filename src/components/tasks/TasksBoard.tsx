import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Project, TaskCard } from '@shared/types'
import { MAX_TASK_TEXT } from '@shared/ipc'
import { TASK_DRAG_TYPE } from '@/lib/mosaicLayout'
import { plannerPaneId, plannerStore } from '@/lib/planner'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { Popover, PopoverRow, PopoverSection } from '../Popover'
import './TasksBoard.css'

/**
 * The delegation board — composer, plan under review, card stack. One
 * component, two rooms: the rail dock (`variant="dock"`) and the maximized
 * desk (`variant="desk"`) render exactly the same machinery so the two can
 * never disagree about what a card or a proposal is; the CSS reads the
 * variant off a data attribute and only changes the tailoring.
 *
 * The proposal lives in plannerStore, not here, so dock and desk share it.
 * Cards live on the workspace and move only through the existing reducers —
 * the card is the whole delegation mechanism, still.
 */
export function TasksBoard({
  project,
  variant,
  autoFocus,
  onGoal
}: {
  project: Project
  variant: 'dock' | 'desk'
  /** Desk only: land the caret in the composer on mount. */
  autoFocus?: boolean
  /** Hand a stated goal to the planner session. The parent owns the pane. */
  onGoal: (goal: string) => void
}): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const tasks = workspace.tasks ?? []

  const proposal = useSyncExternalStore(plannerStore.subscribe, () => plannerStore.proposal(project.id))

  const [draft, setDraft] = useState('')
  const [picker, setPicker] = useState<{ card: TaskCard; anchor: HTMLElement } | null>(null)

  /* ------------------------------------------------------------ composer */

  const stateGoal = (): void => {
    const goal = draft.trim()
    if (!goal) return
    onGoal(goal)
    setDraft('')
  }

  /** Ctrl+Enter: file the raw text as one card, as written — the escape hatch. */
  const fileRaw = (): void => {
    const text = draft.trim()
    if (!text) return
    actions.addTask(text)
    setDraft('')
  }

  /* ------------------------------------------------------------ proposal */

  const deal = (): void => {
    if (!proposal) return
    // Newest-first tray, so deal in reverse: the briefs read top-to-bottom.
    for (const text of [...proposal.tasks].reverse()) actions.addTask(text)
    actions.setNotice(
      `${proposal.tasks.length} card${proposal.tasks.length === 1 ? '' : 's'} filed — deal them onto agents`
    )
    plannerStore.discard(project.id)
  }

  /* ---------------------------------------------------------- delegation */

  /**
   * Hand a card to a pane without dragging — the delegate picker's pick.
   * Same semantics as a drop on the pane (TerminalPane.onDropTask): typed,
   * never submitted, card removed only when the text actually landed.
   */
  const delegate = (card: TaskCard, paneId: string): void => {
    setPicker(null)
    if (!terminalHost.type(paneId, `${card.text} `)) {
      actions.setNotice('That pane has no live shell to hand the task to')
      return
    }
    actions.removeTask(card.id)
    actions.revealPane(paneId)
    terminalHost.focus(paneId)
  }

  const plannerId = plannerPaneId(project.id)
  const targets = picker
    ? workspace.tabs.flatMap((tab) =>
        collectLeaves(tab.root)
          .filter((leaf) => leaf.id !== plannerId)
          .map((leaf) => {
            const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
            return {
              paneId: leaf.id,
              title: paneDisplayTitle(profile, leaf.title),
              tabTitle: tab.title,
              profile,
              live: (() => {
                const s = terminalHost.runtime(leaf.id).status
                return s === 'live' || s === 'starting'
              })()
            }
          })
      )
    : []

  /* -------------------------------------------------------------- render */

  return (
    <div className="tboard" data-variant={variant}>
      <div className="tboard__compose">
        <textarea
          className="tboard__input"
          value={draft}
          rows={variant === 'desk' ? 3 : 2}
          maxLength={MAX_TASK_TEXT}
          placeholder="State a goal — the planner thinks it through, you approve the cards. Ctrl+Enter files it as one card."
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter states the goal; Ctrl+Enter files it verbatim as one card;
            // Shift+Enter is a newline in a longer brief.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (e.ctrlKey) fileRaw()
              else stateGoal()
            }
          }}
        />
        <div className="tboard__acts">
          <button
            type="button"
            className="ghost-btn tboard__send"
            title="State this goal to the planner terminal (Enter)"
            disabled={!draft.trim()}
            onClick={stateGoal}
          >
            <Icon name="send" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn tboard__raw"
            title="File this text as a single card, as written (Ctrl+Enter)"
            disabled={!draft.trim()}
            onClick={fileRaw}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      </div>

      {proposal ? (
        <div className="tboard__proposal" aria-label="Proposed plan">
          <div className="tboard__proposal-head">
            <span className="eyebrow">Proposed plan</span>
            <span className="tboard__proposal-count mono">{proposal.tasks.length}</span>
          </div>
          {proposal.plan ? <p className="tboard__plantext">{proposal.plan}</p> : null}
          <div className="tboard__proposed">
            {proposal.tasks.map((text, i) => (
              <div key={`${i}-${text.slice(0, 24)}`} className="tcard tcard--proposed" title={text}>
                <span className="tcard__text">{text}</span>
                <button
                  type="button"
                  className="tcard__kill"
                  title="Drop this brief from the plan"
                  onClick={() => plannerStore.prune(project.id, i)}
                >
                  <Icon name="close" size={9} />
                </button>
              </div>
            ))}
          </div>
          <div className="tboard__verdict">
            <button
              type="button"
              className="ghost-btn tboard__deal"
              title="Approve the plan — these briefs become cards you deal onto agents"
              onClick={deal}
            >
              <Icon name="check" size={12} />
              Deal {proposal.tasks.length} card{proposal.tasks.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="ghost-btn tboard__discard"
              title="Throw the plan away — no cards are made. Argue with the planner and it will offer a new one."
              onClick={() => plannerStore.discard(project.id)}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {tasks.length > 0 ? (
        <div className="tboard__list">
          {tasks.map((card) => (
            <div
              key={card.id}
              className="tcard"
              title={`${card.text}\n\nDrag onto a pane or tile, or use the send button, to hand it to an agent`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TASK_DRAG_TYPE, card.id)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
            >
              <span className="tcard__grip" aria-hidden="true">
                <Icon name="grip" size={11} />
              </span>
              <span className="tcard__text">{card.text}</span>
              <span className="tcard__acts">
                <button
                  type="button"
                  className="tcard__delegate"
                  title="Hand this card to a pane"
                  onClick={(e) => setPicker({ card, anchor: e.currentTarget })}
                >
                  <Icon name="send" size={11} />
                </button>
                <button
                  type="button"
                  className="tcard__kill"
                  title="Remove this task"
                  onClick={() => actions.removeTask(card.id)}
                >
                  <Icon name="close" size={9} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : variant === 'desk' ? (
        <div className="tboard__empty">
          <p className="tboard__empty-note">
            No cards waiting. State a goal above — the planner answers in the terminal, and its plan lands here
            for your approval.
          </p>
        </div>
      ) : null}

      <Popover
        anchor={picker?.anchor ?? null}
        open={picker !== null}
        onClose={() => setPicker(null)}
        align="end"
        width={264}
        label="Hand this card to a pane"
      >
        <PopoverSection title="Hand to">
          {targets.length === 0 ? (
            <div className="tboard__picker-empty">No panes open in this project yet</div>
          ) : (
            targets.map((t) => (
              <PopoverRow key={t.paneId} onClick={() => picker && delegate(picker.card, t.paneId)}>
                <span className="tboard__picker-row" data-live={t.live ? 'true' : undefined}>
                  <AgentBadge profile={t.profile} size="sm" />
                  <span className="tboard__picker-name truncate">{t.title}</span>
                  <span className="tboard__picker-tab mono truncate">{t.tabTitle}</span>
                </span>
              </PopoverRow>
            ))
          )}
        </PopoverSection>
      </Popover>
    </div>
  )
}

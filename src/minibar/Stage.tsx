import type { ReactNode } from 'react'
import type { MiniBarCall, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { Activity } from './Activity'
import { AllAgents } from './AllAgents'
import { Chat } from './Chat'
import { OpenMenu } from './OpenMenu'
import { Peek } from './Peek'
import { ProjectList } from './ProjectList'
import { Toasts } from './Toasts'

/** The panels the stage can hold, one at a time. */
export type Panel = 'peek' | 'chat' | 'activity' | 'projects' | 'all' | 'open' | null

/**
 * The stage: the space above the bar where one panel opens at a time, with
 * the toasts stacked at its right. It holds nothing when nothing is open, so
 * the window shrinks back to the bar.
 */
export function Stage({
  state,
  call,
  api,
  panel,
  open,
  close,
  now,
  replyFor,
  onReplied,
  onReply,
  onChatHold
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  api: MiniBarViewApi
  panel: Panel
  open: (p: Panel) => void
  close: () => void
  now: number
  replyFor: string | null
  onReplied: () => void
  onReply: (paneId: string) => void
  onChatHold: (held: boolean) => void
}): ReactNode {
  const body = panelFor()
  const toasts = <Toasts state={state} call={call} api={api} onReply={onReply} />

  return (
    <div className="mb-stage" data-panel={panel ?? undefined} onKeyDown={(e) => e.key === 'Escape' && panel && close()}>
      {body ? (
        <div key={panel} className="mb-stage__slot" data-panel={panel ?? undefined}>
          {body}
        </div>
      ) : null}
      {toasts}
    </div>
  )

  function panelFor(): ReactNode {
    switch (panel) {
      case 'peek':
        return state.peek ? <Peek state={state} peek={state.peek} call={call} api={api} now={now} focusReply={replyFor === state.peek.paneId} onReplyFocused={onReplied} /> : null
      case 'chat':
        return <Chat state={state} onClose={close} onHold={onChatHold} />
      case 'activity':
        return <Activity state={state} call={call} now={now} onClose={close} />
      case 'projects':
        return (
          <ProjectList
            state={state}
            onPick={(id) => {
              if (id !== state.project?.id) call({ t: 'project', id })
              open(null)
            }}
            onClose={close}
          />
        )
      case 'all':
        return <AllAgents state={state} call={call} onClose={close} />
      case 'open':
        return <OpenMenu api={api} onClose={close} />
      default:
        return null
    }
  }
}

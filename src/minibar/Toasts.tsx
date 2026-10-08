import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MiniBarCall, MiniBarEvent, MiniBarState, MiniBarViewApi } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { agentById, eventHeadline, eventStatus, fmtDuration, projectName } from './format'
import { AgentMark, StateMark } from './glyphs'

const LEAVE_MS = 180

/**
 * The toasts: up to three cards at the right of the stage, the newest
 * nearest the bar, each sliding up as it lands. The host owns their life
 * (8 s, paused on hover, folded into the bell); this only draws what
 * `toasts` names, and lets a card sink away when it goes.
 */
export function Toasts({
  state,
  call,
  api,
  onReply
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  api: MiniBarViewApi
  onReply: (paneId: string) => void
}): ReactNode {
  const live = state.toasts
    .map((id) => state.events.find((e) => e.id === id))
    .filter((e): e is MiniBarEvent => e !== undefined)
    .slice(0, 3)

  // Cards that just left stay a moment, sinking, so the stack closes gently.
  const [leaving, setLeaving] = useState<MiniBarEvent[]>([])
  const last = useRef<MiniBarEvent[]>(live)
  const timers = useRef<number[]>([])
  const sig = live.map((e) => e.id).join('|')
  useEffect(() => {
    const ids = new Set(live.map((e) => e.id))
    const gone = last.current.filter((e) => !ids.has(e.id))
    last.current = live
    if (!gone.length) return
    setLeaving((l) => [...l.filter((e) => !ids.has(e.id)), ...gone])
    const t = window.setTimeout(() => setLeaving((l) => l.filter((e) => !gone.includes(e))), LEAVE_MS)
    timers.current.push(t)
    // `sig` stands for the list of ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  if (!live.length && !leaving.length) return null

  // Oldest at the top, newest at the foot, by the bar.
  const cards = [...leaving.map((e) => ({ e, out: true })), ...[...live].reverse().map((e) => ({ e, out: false }))]

  const unfold = (): void => {
    if (state.tucked) call({ t: 'tuck', on: false })
  }

  return (
    <div className="mb-toasts" aria-live="polite">
      {cards.map(({ e, out }) => (
        <Toast
          key={e.id}
          ev={e}
          out={out}
          project={projectName(state, e.projectId)}
          onPeek={() => {
            unfold()
            call({ t: 'peek', paneId: e.paneId })
          }}
          onReply={() => {
            unfold()
            onReply(e.paneId)
          }}
          onOpen={() => {
            const a = agentById(state, e.paneId)
            if (a) call({ t: 'reveal', projectId: a.projectId, tabId: a.tabId, paneId: a.paneId })
            void api.openMain()
          }}
          onDismiss={() => call({ t: 'dismissToast', id: e.id })}
        />
      ))}
    </div>
  )
}

function Toast({
  ev,
  out,
  project,
  onPeek,
  onReply,
  onOpen,
  onDismiss
}: {
  ev: MiniBarEvent
  out: boolean
  project: string
  onPeek: () => void
  onReply: () => void
  onOpen: () => void
  onDismiss: () => void
}): ReactNode {
  const status = eventStatus(ev.kind)
  const line = ev.kind === 'asking' ? (ev.prompt ?? ev.line) : ev.line
  return (
    <article className="mb-toast" data-kind={ev.kind} data-leaving={out ? 'true' : undefined} inert={out ? true : undefined}>
      <span className="mb-toast__seat">
        <AgentMark brand={ev.brand} size={26} />
        <span className="mb-toast__state" data-status={status}>
          <StateMark status={status} size={10} />
        </span>
      </span>
      <div className="mb-toast__main">
        <header className="mb-toast__head">
          <span className="mb-toast__title">{eventHeadline(ev.kind, ev.name)}</span>
          <span className="mb-toast__meta">
            {project}
            {ev.workedMs ? (
              <>
                <span className="mb-dot" aria-hidden="true" />
                {fmtDuration(ev.workedMs)}
              </>
            ) : null}
          </span>
        </header>
        {line ? <p className="mb-toast__line">{line}</p> : null}
        <footer className="mb-toast__acts">
          <button type="button" className="mb-btn mb-btn--sm" data-lead={ev.kind === 'asking' ? 'true' : undefined} onClick={onPeek}>
            {ev.kind === 'asking' ? 'Answer' : 'Peek'}
          </button>
          <button type="button" className="mb-btn mb-btn--sm" onClick={onReply}>
            Reply
          </button>
          <button type="button" className="mb-btn mb-btn--sm" onClick={onOpen}>
            Open
          </button>
        </footer>
      </div>
      <button type="button" className="mb-ibtn mb-ibtn--sm mb-toast__x" title="Dismiss — it stays in Activity" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={13} />
      </button>
    </article>
  )
}

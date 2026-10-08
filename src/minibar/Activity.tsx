import type { ReactNode } from 'react'
import type { MiniBarCall, MiniBarState } from '@shared/minibar'
import { eventHeadline, eventStatus, fmtAgo, fmtClock, fmtDuration, projectName, STATUS_WORD } from './format'
import { AgentMark, StateMark } from './glyphs'
import { Eyebrow, Sheet } from './Sheet'

/**
 * Activity (the bell): the last 30 events, newest first. Each row is a time,
 * the agent, what happened as a shape and a word, its project and its last
 * line. A row opens that agent's Peek. Opening the panel marks all as seen.
 */
export function Activity({
  state,
  call,
  now,
  onClose
}: {
  state: MiniBarState
  call: (c: MiniBarCall) => void
  now: number
  onClose: () => void
}): ReactNode {
  const events = state.events.slice(0, 30)
  return (
    <Sheet
      className="mb-activity"
      label="Activity"
      onClose={onClose}
      head={
        <>
          <Eyebrow>Activity</Eyebrow>
          <span className="mb-sheet__count">{events.length ? `${events.length} ${events.length === 1 ? 'event' : 'events'}` : ''}</span>
        </>
      }
    >
      {events.length ? (
        <ul className="mb-sheet__body mb-rows">
          {events.map((ev) => {
            const status = eventStatus(ev.kind)
            return (
              <li key={ev.id}>
                <button type="button" className="mb-row mb-evrow" data-status={status} onClick={() => call({ t: 'peek', paneId: ev.paneId })}>
                  <time className="mb-evrow__at" title={fmtAgo(ev.at, now)}>
                    {fmtClock(ev.at)}
                  </time>
                  <AgentMark brand={ev.brand} size={20} />
                  <span className="mb-evrow__main">
                    <span className="mb-evrow__head">
                      <span className="mb-evrow__title">{eventHeadline(ev.kind, ev.name)}</span>
                      <span className="mb-evrow__meta">
                        {projectName(state, ev.projectId)}
                        {ev.workedMs ? (
                          <>
                            <span className="mb-dot" aria-hidden="true" />
                            {fmtDuration(ev.workedMs)}
                          </>
                        ) : null}
                      </span>
                    </span>
                    {ev.prompt || ev.line ? <span className="mb-evrow__line">{ev.kind === 'asking' ? (ev.prompt ?? ev.line) : ev.line}</span> : null}
                  </span>
                  <span className="mb-statepill" data-status={status}>
                    <StateMark status={status} size={9} />
                    {STATUS_WORD[status]}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mb-sheet__empty">Nothing yet. When an agent finishes, asks or stops, it shows here.</p>
      )}
    </Sheet>
  )
}

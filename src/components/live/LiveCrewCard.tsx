import type { ReactNode } from 'react'
import { avatarHue, badgeFor, crewName, elapsed, clock, initial, isLiveJobFinished, type Badge } from './format'
import { Glyph } from './glyphs'
import type { LiveJob } from './types'

/** A state badge: the word in capitals and its shape. */
export function StateBadge({ badge }: { badge: Badge }): ReactNode {
  return (
    <span className="live-st" data-kind={badge.kind}>
      <Glyph name={badge.glyph} className={badge.spin ? 'live-spin' : undefined} />
      {badge.word}
    </span>
  )
}

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'md' }): ReactNode {
  return (
    <span className="live-ava" data-size={size ?? 'md'} style={{ background: avatarHue(name) }} aria-hidden="true">
      {initial(name)}
    </span>
  )
}

interface Props {
  job: LiveJob
  now: number
  onShow: (id: string) => void
  onStop: (id: string) => void
}

/**
 * One crew member: who, the state as word + shape, one line of status and a
 * mono peek at the last thing it did. The whole card is the "go to its pane"
 * button; Stop sits beside it, always visible, never on hover.
 */
export function LiveCrewCard({ job, now, onShow, onStop }: Props): ReactNode {
  const name = crewName(job)
  const badge = badgeFor(job)
  const finished = isLiveJobFinished(job.state)
  const last = job.steps[job.steps.length - 1]
  const status = job.summary || last?.text || job.title
  const sub = job.project ?? (job.paneName ? job.title : undefined)
  const canStop = !finished
  const peek = !finished && badge.kind !== 'needs' && last && last.text !== status ? last.text : undefined
  const where = job.paneName ? `Go to ${name}’s pane` : `Show ${name}`

  if (finished) {
    return (
      <div className="live-card" data-kind={badge.kind} data-compact="true" data-job-id={job.id}>
        <button type="button" className="live-card__main" onClick={() => onShow(job.id)} aria-label={`${where}: ${badge.word}. ${status}`}>
          <span className="live-card__top">
            <Avatar name={name} size="sm" />
            <span className="live-card__nm live-card__nm--row">
              <b>{name}</b>
              <span className="live-card__sub">{status}</span>
            </span>
            <StateBadge badge={badge} />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="live-card" data-kind={badge.kind} data-job-id={job.id} data-stop={canStop ? 'true' : undefined}>
      <button type="button" className="live-card__main" onClick={() => onShow(job.id)} aria-label={`${where}: ${badge.word}. ${status}`}>
        <span className="live-card__top">
          <Avatar name={name} />
          <span className="live-card__nm">
            <b>{name}</b>
            {sub ? <span className="live-card__sub">{sub}</span> : null}
          </span>
          <StateBadge badge={badge} />
        </span>
        <span className="live-card__status">{status}</span>
        {peek ? (
          <span className="live-peek">
            <span className="live-peek__text">{peek}</span>
            <span className="live-peek__time">
              {job.state === 'running' ? elapsed(now - job.createdAt) : clock(last!.at)}
            </span>
          </span>
        ) : null}
      </button>
      {canStop ? (
        <button type="button" className="live-card__stop" onClick={() => onStop(job.id)} aria-label={`Stop ${name}`}>
          <Glyph name="square" />
          Stop
        </button>
      ) : null}
    </div>
  )
}

import type { ReactNode } from 'react'
import { Avatar } from './LiveCrewCard'
import { ago, crewName } from './format'
import { Glyph } from './glyphs'
import type { LiveJob } from './types'

interface Props {
  job: LiveJob
  more: number
  now: number
  top: number
  arrow: number | null
  onYes: () => void
  onShow: () => void
  onLater: () => void
}

/**
 * A crew member who needs Steve speaks from beside her own card: what she
 * asked, a yes, a look, and a not-now. The yes is said to Forge as if spoken,
 * so the Conductor decides what "yes" means for this job; saying it works too.
 */
export function LiveNeedsYou({ job, more, now, top, arrow, onYes, onShow, onLater }: Props): ReactNode {
  const name = crewName(job)
  const last = job.steps[job.steps.length - 1]
  const asks = last?.text || job.summary || job.title
  const where = [job.project, ago(job.updatedAt, now)].filter(Boolean).join(' · ')
  return (
    <section
      className="live-fly"
      style={{ transform: `translate3d(0, ${Math.round(top)}px, 0)` }}
      aria-label={`${name} needs you`}
      aria-describedby={`live-fly-${job.id}`}
    >
      {arrow !== null ? <span className="live-fly__arrow" style={{ top: Math.round(arrow) }} aria-hidden="true" /> : null}
      <header className="live-fly__head">
        <Avatar name={name} />
        <span className="live-fly__who">
          <b>{name} needs you</b>
          <span>{where}</span>
        </span>
        <span className="live-st" data-kind="needs">
          <Glyph name="diamond" />
          Needs you
        </span>
      </header>
      <div className="live-fly__said" id={`live-fly-${job.id}`}>
        <Glyph name="speaker" />
        <p>
          <small>{name} asks</small>
          {asks}
        </p>
      </div>
      <div className="live-fly__acts">
        <button type="button" className="live-btn live-btn--go" onClick={onYes}>
          <Glyph name="up" />
          Yes, go ahead
        </button>
        <button type="button" className="live-btn" onClick={onShow}>
          <Glyph name="frame" />
          Show me
        </button>
        <button type="button" className="live-btn live-btn--ghost" onClick={onLater}>
          Later
        </button>
      </div>
      <p className="live-fly__hint">
        <Glyph name="mic" />
        or just say “yes” or “not now”
        {more > 0 ? <span className="live-fly__more">+{more} more waiting</span> : null}
      </p>
    </section>
  )
}

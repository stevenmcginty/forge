import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { LiveCrewCard, StateBadge } from './LiveCrewCard'
import { LiveNeedsYou } from './LiveNeedsYou'
import { badgeFor, clock, crewName, crewOf, forHowLong, nextOf, PHASE } from './format'
import { Glyph } from './glyphs'
import type { LiveJob, LivePhase, LiveTurn, LiveView } from './types'

/* ------------------------------------------------------------- presence */

/** Forge's presence: the orb, and its state as a word with a shape beside it. */
function Orb({ phase, size }: { phase: Exclude<LivePhase, 'off'>; size?: 'sm' }): ReactNode {
  return (
    <span className="live-orb" data-phase={phase} data-size={size} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <svg className="live-orb__arc" viewBox="0 0 62 62">
        <circle cx="31" cy="31" r="28" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="44 132" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function PhaseMark({ phase }: { phase: Exclude<LivePhase, 'off'> }): ReactNode {
  if (phase === 'speaking' || phase === 'hearing')
    return (
      <span className="live-eq" data-phase={phase} aria-hidden="true">
        <b />
        <b />
        <b />
        <b />
        <b />
      </span>
    )
  if (phase === 'thinking' || phase === 'starting') return <Glyph name={phase === 'starting' ? 'dashed' : 'arc'} className="live-spin" />
  return <span className="live-ear" aria-hidden="true" />
}

/* ------------------------------------------------------------------ now */

function NowSection({ job, next, now }: { job?: LiveJob; next?: LiveJob; now: number }): ReactNode {
  if (!job) {
    return (
      <section className="live-now live-sec" aria-label="What Forge is doing now">
        <div className="live-eyebrow">
          <Glyph name="dashed" />
          Now
        </div>
        <p className="live-now__free">Free. Ask for anything.</p>
        {next ? (
          <div className="live-steps">
            <div className="live-stp" data-kind="next">
              <span className="live-stp__dot" />
              <span className="live-stp__text">Then {lowerFirst(next.title)}</span>
            </div>
          </div>
        ) : null}
      </section>
    )
  }
  const steps = job.steps.slice(-3)
  const live = job.state === 'running'
  const last = steps[steps.length - 1]
  const badge = badgeFor(job)
  return (
    <section className="live-now live-sec" aria-label="What Forge is doing now">
      <div className="live-eyebrow">
        <Glyph name={live ? 'arc' : badge.glyph} className={live ? 'live-spin' : undefined} />
        Now
        {last ? <em>{forHowLong(now - last.at)}</em> : null}
      </div>
      <h3 className="live-now__title">{job.title}</h3>
      {!live ? (
        <div className="live-now__state">
          <StateBadge badge={badge} />
        </div>
      ) : null}
      {steps.length > 0 || next ? (
        <ol className="live-steps">
          {steps.map((s, i) => {
            const isLast = i === steps.length - 1
            const kind = isLast && live ? 'live' : 'done'
            return (
              <li key={`${s.at}:${i}`} className="live-stp" data-kind={kind}>
                <span className="live-stp__dot">{kind === 'done' ? <Glyph name="tick" /> : <i />}</span>
                <span className="live-stp__text">{s.text}</span>
                <time>{kind === 'live' ? 'Now' : clock(s.at)}</time>
              </li>
            )
          })}
          {next ? (
            <li className="live-stp" data-kind="next">
              <span className="live-stp__dot" />
              <span className="live-stp__text">Then {lowerFirst(next.title)}</span>
            </li>
          ) : null}
        </ol>
      ) : null}
    </section>
  )
}

function lowerFirst(s: string): string {
  return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/* ----------------------------------------------------------- transcript */

function Transcript({ turns }: { turns: LiveTurn[] }): ReactNode {
  const ref = useRef<HTMLOListElement | null>(null)
  useLayoutEffect(() => {
    // The crew list scrolls; open on the latest turn.
    const box = ref.current?.parentElement
    if (box) box.scrollTop = box.scrollHeight
  }, [turns.length])
  if (turns.length === 0) return <p className="live-empty">Nothing said yet. Just talk.</p>
  return (
    <ol ref={ref} className="live-talk" aria-label="The conversation">
      {turns.map((t) => (
        <li key={t.id} className="live-turn" data-who={t.who}>
          <span className="live-turn__who">
            {t.who === 'you' ? 'You' : 'Forge'}
            <time>{clock(t.at)}</time>
          </span>
          <p>{t.text}</p>
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------------ rail */

interface Props {
  view: LiveView
  phase: Exclude<LivePhase, 'off'>
  now: number
  onShow: (job: LiveJob) => void
}

const ARROW_AT = 70
const laterKey = (j: LiveJob): string => `${j.id}:${j.updatedAt}`

/**
 * The Conductor rail: who Forge is and what it is doing now, its crew as
 * cards, and the conversation folded into one line at the foot. A crew member
 * who needs Steve speaks from a flyout beside her card.
 */
export function LiveRail({ view, phase, now, onShow }: Props): ReactNode {
  const [reading, setReading] = useState(false)
  const [awaySeen, setAwaySeen] = useState<string[] | null>(null)
  const [later, setLater] = useState<string[]>([])
  const [fly, setFly] = useState<{ top: number; arrow: number | null }>({ top: 0, arrow: null })
  const [below, setBelow] = useState(0)
  const railRef = useRef<HTMLElement | null>(null)
  const crewRef = useRef<HTMLDivElement | null>(null)
  const flyRef = useRef<HTMLDivElement | null>(null)

  const crew = crewOf(view.jobs, view.now)
  const next = nextOf(view.jobs, view.now)
  const flyJob = view.needsYou.find((j) => !later.includes(laterKey(j)))
  const more = view.needsYou.length - (flyJob ? 1 : 0)
  // Put away until something new needs Steve: then the rail comes back by itself.
  const away = awaySeen !== null && view.needsYou.every((j) => awaySeen.includes(j.id))
  const look = PHASE[phase]
  const problem = view.error || view.status?.error

  const measure = useCallback(() => {
    const rail = railRef.current
    const list = crewRef.current
    if (!rail || !list) return
    const lr = list.getBoundingClientRect()
    // Cards out of sight below: say how many, so nothing hides behind a scroll.
    let hidden = 0
    if (!reading) for (const el of list.querySelectorAll<HTMLElement>('[data-job-id]')) if (el.getBoundingClientRect().top > lr.bottom - 24) hidden++
    setBelow((b) => (b === hidden ? b : hidden))
    if (!flyJob) return
    const rr = rail.getBoundingClientRect()
    const fh = flyRef.current?.offsetHeight ?? 220
    const card = reading ? null : list.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(flyJob.id)}"]`)
    const cr = card?.getBoundingClientRect()
    const shown = !!cr && cr.bottom > lr.top + 16 && cr.top < lr.bottom - 16
    const anchor = cr && shown ? cr.top - rr.top + Math.min(30, cr.height / 2) : lr.top - rr.top + 24
    // Never over the captions: the flyout rises above them if it must.
    const caps = rail.parentElement?.querySelector('.live-caps')?.getBoundingClientRect()
    const floor = caps && caps.height > 0 ? Math.min(rr.height, caps.top - rr.top - 10) : rr.height
    const minTop = 8 - rr.top
    const top = Math.max(minTop, Math.min(floor - fh, anchor - ARROW_AT))
    const arrow = shown ? Math.max(22, Math.min(fh - 22, anchor - top)) : null
    setFly((f) => (Math.abs(f.top - top) < 0.5 && f.arrow === arrow ? f : { top, arrow }))
  }, [flyJob, reading])

  const scrollOn = (): void => {
    const list = crewRef.current
    if (list) list.scrollBy({ top: Math.max(120, list.clientHeight * 0.75), behavior: 'smooth' })
  }

  useLayoutEffect(() => {
    measure()
  })

  useEffect(() => {
    const list = crewRef.current
    window.addEventListener('resize', measure)
    list?.addEventListener('scroll', measure, { passive: true })
    return () => {
      window.removeEventListener('resize', measure)
      list?.removeEventListener('scroll', measure)
    }
  }, [measure, away])

  if (away) {
    const needs = view.needsYou.length
    return (
      <button type="button" className="live-pill" onClick={() => setAwaySeen(null)} aria-label="Bring Forge back">
        <Orb phase={phase} size="sm" />
        <span className="live-pill__nm">
          <b>Forge</b>
          <span className="live-pill__word">{look.word}</span>
        </span>
        <span className="live-pill__count">{crew.length} crew</span>
        {problem ? (
          <span className="live-st" data-kind="problem">
            <Glyph name="warn" />
            Problem
          </span>
        ) : null}
        {needs > 0 ? (
          <span className="live-st" data-kind="needs">
            <Glyph name="diamond" />
            {needs} needs you
          </span>
        ) : null}
        <span className="live-pill__open">
          Open
          <Glyph name="fold" />
        </span>
      </button>
    )
  }

  return (
    <aside ref={railRef} className="live-rail" aria-label="Forge Live">
      <section className="live-who live-sec">
        <Orb phase={phase} />
        <div className="live-who__nm">
          <h2>Forge</h2>
          <div className="live-who__state" data-phase={phase} role="status" aria-live="polite">
            <PhaseMark phase={phase} />
            {look.word}
          </div>
          <div className="live-who__hint">{look.hint}</div>
        </div>
        <button
          type="button"
          className="live-who__away"
          onClick={() => setAwaySeen(view.needsYou.map((j) => j.id))}
          aria-label="Put the rail away"
        >
          Put away
          <Glyph name="fold" />
        </button>
        {problem ? (
          <p className="live-who__problem" role="alert">
            <Glyph name="warn" />
            <span>
              <b>Problem</b> {problem}
            </span>
          </p>
        ) : null}
      </section>

      <NowSection job={view.now} next={next} now={now} />

      <div className="live-crew">
        {reading ? (
          <div className="live-eyebrow live-crew__head">
            <Glyph name="voice" />
            Conversation · {view.turns.length}
          </div>
        ) : (
          <div className="live-eyebrow live-crew__head">
            Crew · {crew.length}
            <em>{crew.length > 0 ? 'click one to go to its pane' : ''}</em>
          </div>
        )}
        <div ref={crewRef} className="live-crew__list">
          {reading ? (
            <Transcript turns={view.turns} />
          ) : crew.length === 0 ? (
            <p className="live-empty">No crew out. Ask Forge to put someone on a job.</p>
          ) : (
            crew.map((job) => <LiveCrewCard key={job.id} job={job} now={now} onShow={() => onShow(job)} onStop={view.stopJob} />)
          )}
        </div>
        {below > 0 && !reading ? (
          <div className="live-crew__fade">
            <button type="button" className="live-crew__more" onClick={scrollOn}>
              {below} more below
              <Glyph name="fold" />
            </button>
          </div>
        ) : null}
      </div>

      <footer className="live-foot">
        <Glyph name="voice" />
        <span>
          Conversation · <b>{view.turns.length === 1 ? '1 turn' : `${view.turns.length} turns`}</b>
        </span>
        <button type="button" className="live-foot__open" onClick={() => setReading((r) => !r)} aria-pressed={reading}>
          {reading ? 'Back to crew' : 'Read it all'}
          <Glyph name="go" />
        </button>
      </footer>

      {flyJob ? (
        <div ref={flyRef} className="live-fly-wrap">
          <LiveNeedsYou
            job={flyJob}
            more={more}
            now={now}
            top={fly.top}
            arrow={fly.arrow}
            onYes={() => view.sendTyped(`Yes, ${crewName(flyJob)} can go ahead.`)}
            onShow={() => onShow(flyJob)}
            onLater={() => setLater((l) => [...l, laterKey(flyJob)])}
          />
        </div>
      ) : null}
    </aside>
  )
}

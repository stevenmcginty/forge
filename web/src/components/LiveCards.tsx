import { useState, type ReactNode } from 'react'
import { collectLeaves } from '@shared/splitTree'
import { liveJobStateWord, type LiveJob } from '@shared/live'
import type { Workspace } from '@shared/types'
import { dismissLiveCard, liveJobTap, useLiveCards } from '../deck/liveVoice'
import { goToVoiceNav } from '../deck/voiceAgent'
import { useForge } from '../state'
import './LiveCards.css'

/**
 * Claude Live's news as cards, on the phone and the deck, while Listen is on
 * with Claude Live (../deck/liveVoice.ts): the jobs waiting on him first,
 * then the ones just done or failed. No brain map and no rail — Steve wants
 * the phone kept to Listen, the captions and this list.
 *
 * Each card is a shape and a word for its state (never colour alone), the
 * job, its last line, and big buttons: Open (the job's pane, here), Stop (a
 * job the Conductor is running), OK (put it away). It floats over the
 * terminal above the bar; the bar and the terminal never move for it.
 */

/** Cards shown at once; the rest are counted. */
const SHOWN_MAX = 3

/** Where a pane is in the picture: its project and tab, for an Open that lands. */
function paneWhere(workspaces: Record<string, Workspace>, paneId: string): { projectId: string; tabId: string } | null {
  for (const projectId of Object.keys(workspaces)) {
    const tab = workspaces[projectId]?.tabs.find((t) => collectLeaves(t.root).some((leaf) => leaf.id === paneId))
    if (tab) return { projectId, tabId: tab.id }
  }
  return null
}

export function LiveCards({ face, place = 'bottom' }: { face: 'phone' | 'deck'; place?: 'top' | 'bottom' }): ReactNode {
  const { on, cards, working } = useLiveCards()
  const { state, actions } = useForge()
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<Record<string, string>>({})
  if (!on || (!cards.length && !working)) return null
  const shown = cards.slice(0, SHOWN_MAX)
  const more = cards.length - shown.length

  const open = (job: LiveJob): void => {
    const paneId = job.paneId
    if (!paneId) return
    const where = state.picture ? paneWhere(state.picture.workspaces, paneId) : null
    if (where && goToVoiceNav({ projectId: where.projectId, tabId: where.tabId, paneId })) return
    // No pane here to go to (or no deck to move): the desk shows it.
    void liveJobTap(job.id, 'show').then((why) => {
      if (why) actions.setNotice(why)
    })
  }

  const stop = (job: LiveJob): void => {
    setBusy(job.id)
    void liveJobTap(job.id, 'stop').then((why) => {
      setBusy(null)
      setSaid((prev) => ({ ...prev, [job.id]: why ?? 'Stopping…' }))
    })
  }

  return (
    <section className="lcards" data-face={face} data-place={place} aria-label="Claude Live jobs">
      {working ? (
        <div className="lcards__head">
          <svg className="lcards__spin" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" fill="none" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>
            Claude Live · {working} working{cards.length ? '' : ' — nothing needs you'}
          </span>
        </div>
      ) : null}
      {shown.map((job) => {
        const line = said[job.id] ?? job.summary ?? job.steps[job.steps.length - 1]?.text ?? ''
        const needs = job.state === 'needs-you'
        return (
          <article key={job.id} className="lcard" data-state={job.state}>
            <div className="lcard__top">
              <StateMark state={job.state} />
              <span className="lcard__word">{liveJobStateWord(job.state)}</span>
              <span className="lcard__title">{job.paneName ? `${job.paneName} · ${job.title}` : job.title}</span>
            </div>
            {line ? <p className="lcard__line">{line}</p> : null}
            <div className="lcard__acts">
              {job.paneId ? (
                <button type="button" className="lcard__btn" data-kind="open" onClick={() => open(job)}>
                  Open
                </button>
              ) : null}
              {needs && job.owner === 'conductor' ? (
                <button
                  type="button"
                  className="lcard__btn"
                  data-kind="stop"
                  disabled={busy === job.id}
                  aria-busy={busy === job.id || undefined}
                  onClick={() => stop(job)}
                >
                  Stop
                </button>
              ) : null}
              <button type="button" className="lcard__btn" data-kind="ok" onClick={() => dismissLiveCard(job)}>
                {needs ? 'Later' : 'OK'}
              </button>
            </div>
          </article>
        )
      })}
      {more > 0 ? <div className="lcards__more">+{more} more</div> : null}
    </section>
  )
}

/** One silhouette per state: a diamond with a bang (needs you), a tick (done), a triangle (failed). */
function StateMark({ state }: { state: LiveJob['state'] }): ReactNode {
  return (
    <svg className="lcard__mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {state === 'needs-you' ? (
        <>
          <path d="M8 1.2 14.8 8 8 14.8 1.2 8Z" fill="none" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M8 4.8v3.8" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11" r="0.9" />
        </>
      ) : state === 'done' ? (
        <path d="M3 8.4 6.4 11.6 13 4.6" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ) : state === 'failed' ? (
        <>
          <path d="M8 1.6 14.8 13.8H1.2Z" fill="none" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 6v3.6" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.6" r="0.85" />
        </>
      ) : (
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="1.6" />
      )}
    </svg>
  )
}

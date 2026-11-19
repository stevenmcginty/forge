import { useState, type ReactNode } from 'react'
import type { DatesWeeklyPatch } from '@shared/dates'
import { datesWeeklyApi } from '@/lib/datesApi'
import { useWeekly } from './datesStore'
import { hourWords, plainError, WEEKDAY_NAMES, weeklyWords } from './dateWords'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/**
 * The weekly check (docs/DATES.md, "Weekly check"), as furniture at the foot
 * of the left column: one line of plain status ("Checked Mon 23 Nov. Next check
 * Mon 30 Nov at 7:00."), Check now, and Change, which opens the on / off box
 * and the day and hour in place. A failed last run says so, with its reason,
 * marked by a triangle as well as the red.
 *
 * Nothing at all on a preload from before the weekly check.
 */
export function WeeklyCheck({ say }: { say: (text: string, tone?: 'danger') => void }): ReactNode {
  const weekly = useWeekly()
  const [editing, setEditing] = useState(false)
  const [running, setRunning] = useState(false)
  const api = datesWeeklyApi()
  if (!weekly || !api) return null
  const words = weeklyWords(weekly, new Date())

  const runNow = (): void => {
    setRunning(true)
    api.runNow().then(
      (result) => {
        setRunning(false)
        if (result.ok) say('The weekly check is running in a new agent tab.')
        else say(result.error || 'The weekly check did not start.', 'danger')
      },
      (err: unknown) => {
        setRunning(false)
        say(plainError(err), 'danger')
      }
    )
  }

  const set = (patch: DatesWeeklyPatch): void => {
    api.set(patch).catch((err: unknown) => say(plainError(err), 'danger'))
  }

  return (
    <section className="dweekly" data-tone={words.tone} aria-label="Weekly check">
      <div className="dweekly__head">Weekly check</div>
      <p className="dweekly__line">
        {words.tone === 'failed' ? (
          <svg className="dweekly__warn" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 1.8 15 14H1Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8 6.4v3.4M8 11.8v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : null}
        <span className="dweekly__state">{words.text}</span>
        {words.next ? <span> {words.next}</span> : null}
      </p>
      {words.error ? <p className="dweekly__error">{words.error}</p> : null}
      <div className="dweekly__acts">
        <button
          type="button"
          className="dweekly__btn"
          onClick={runNow}
          disabled={running}
          title="Open an agent now to look through your mail and accounts for new or changed dates"
        >
          {running ? 'Starting…' : 'Check now'}
        </button>
        <button type="button" className="dweekly__btn" data-tone="quiet" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Change'}
        </button>
      </div>
      {editing ? (
        <div className="dweekly__edit">
          <label className="dtoggle">
            <input type="checkbox" checked={weekly.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span className="dtoggle__box" />
            Check every week
          </label>
          <div className="dweekly__when">
            <select
              className="dfield__input dweekly__select"
              aria-label="Day"
              value={weekly.weekday}
              disabled={!weekly.enabled}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
            >
              {WEEKDAY_NAMES.map((name, i) => (
                <option key={name} value={i}>
                  {name}s
                </option>
              ))}
            </select>
            <span className="dweekly__at">at</span>
            <select
              className="dfield__input dweekly__select"
              aria-label="Hour"
              value={weekly.hour}
              disabled={!weekly.enabled}
              onChange={(e) => set({ hour: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourWords(h)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </section>
  )
}

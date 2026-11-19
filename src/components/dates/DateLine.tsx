import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dayLabel, urgencyOf, type DateItem } from '@shared/dates'
import { Icon } from '../Icon'
import { kindLabel, REPEAT_WORDS, remindWords, snoozeDay, stubOf, whenWords } from './dateWords'

/**
 * One date on the page.
 *
 * Closed, it is one line you can read in a glance: the day on a small stub,
 * what it is, which business and kind and money, when in plain words, and the
 * one thing to do about it — "Get an agent on it". A click anywhere else on the
 * line opens it: the facts (note, what to do, reminders) and the rest of the
 * actions (Done, Snooze, Edit, Delete). Delete asks first, in place.
 *
 * Two colours, two jobs: the stub wears its month's colour (set by the month
 * block it sits in), so it says *when*; the "when" words warm from quiet ink
 * to red as the day comes near (`urgencyOf`, on `data-urgency`), so they say
 * *act*. The words are always there; the colour only repeats them.
 */

export interface DateLineActions {
  agent(item: DateItem): void
  done(item: DateItem): void
  snooze(item: DateItem, until: string): void
  edit(item: DateItem): void
  remove(item: DateItem): void
}

export function DateLine({
  item,
  today,
  open,
  onToggle,
  act
}: {
  item: DateItem
  today: string
  open: boolean
  onToggle: () => void
  act: DateLineActions
}): ReactNode {
  const urgency = urgencyOf(item, today)
  const stub = stubOf(item.date)
  const thisYear = today.slice(0, 4)
  const panelId = `dline-${item.id}`
  const facts = [kindLabel(item.kind), item.group, item.amount].filter(Boolean)

  return (
    <li className="dline" data-urgency={urgency} data-open={open ? 'true' : undefined} data-estimated={item.estimated ? 'true' : undefined} id={`date-${item.id}`}>
      <div className="dline__row">
        <button type="button" className="dline__hit" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          <span className="dline__stub" aria-hidden="true">
            <span className="dline__wd">{stub.weekday}</span>
            <span className="dline__day">{stub.day}</span>
            <span className="dline__mon">
              {stub.month}
              {stub.year !== thisYear ? ` ’${stub.year.slice(2)}` : ''}
            </span>
          </span>
          <span className="dline__main">
            <span className="dline__title">{item.title}</span>
            <span className="dline__meta">
              {facts.map((f, i) => (
                <span key={i} className="dline__fact" data-first={i === 0 ? 'true' : undefined}>
                  {f}
                </span>
              ))}
              {item.repeat !== 'none' ? (
                <span className="dline__fact dline__repeat">
                  <Icon name="refresh" size={11} />
                  {REPEAT_WORDS[item.repeat].toLowerCase()}
                </span>
              ) : null}
            </span>
          </span>
          <span className="dline__when">
            <span className="dates-sr">{`${dayLabel(item.date)}, `}</span>
            {whenWords(item, today)}
          </span>
        </button>
        {urgency !== 'done' ? (
          <button type="button" className="dline__agent" onClick={() => act.agent(item)} title={`Open an agent with everything about "${item.title}"`}>
            <Icon name="sparkle" size={13} />
            <span>Get an agent on it</span>
          </button>
        ) : (
          <span />
        )}
        <span className="dline__chev" aria-hidden="true">
          <Icon name="chevronDown" size={13} />
        </span>
      </div>
      <div className="dline__fold" id={panelId} role="region" aria-label={`${item.title}: details`} hidden={!open}>
        {open ? <LineDetail item={item} today={today} act={act} /> : null}
      </div>
    </li>
  )
}

function LineDetail({ item, today, act }: { item: DateItem; today: string; act: DateLineActions }): ReactNode {
  const [snoozing, setSnoozing] = useState(false)
  const [pick, setPick] = useState('')
  const [arming, setArming] = useState(false)
  const keepRef = useRef<HTMLButtonElement | null>(null)
  const isDone = item.done

  useEffect(() => {
    if (arming) keepRef.current?.focus()
  }, [arming])

  return (
    <div className="dline__detail">
      <div className="dline__facts">
        {item.note ? (
          <section className="dline__block">
            <h4 className="dline__label">The facts</h4>
            <p className="dline__text">{item.note}</p>
          </section>
        ) : null}
        {item.action ? (
          <section className="dline__block">
            <h4 className="dline__label">What to do</h4>
            <p className="dline__text">{item.action}</p>
          </section>
        ) : null}
        {!item.note && !item.action ? (
          <p className="dline__quiet">No notes yet. Edit to add the facts — notice period, who to call, the account — so an agent has them too.</p>
        ) : null}
        <dl className="dline__list">
          <div>
            <dt>When</dt>
            <dd>
              {item.estimated ? 'About ' : ''}
              {dayLabel(item.date)}
              {item.endDate ? ` until ${dayLabel(item.endDate)}` : ''}
              {item.estimated ? ' (not confirmed)' : ''}
            </dd>
          </div>
          <div>
            <dt>Repeats</dt>
            <dd>{REPEAT_WORDS[item.repeat]}</dd>
          </div>
          <div>
            <dt>Reminders</dt>
            <dd>{remindWords(item.remindDays)}</dd>
          </div>
          {item.snoozedUntil && item.snoozedUntil > today ? (
            <div>
              <dt>Snoozed</dt>
              <dd>No reminders before {dayLabel(item.snoozedUntil)}</dd>
            </div>
          ) : null}
          {item.source === 'agent' ? (
            <div>
              <dt>Added by</dt>
              <dd>An agent</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="dline__acts">
        {arming ? (
          <div className="dline__confirm" role="group" aria-label="Delete this date?">
            <span className="dline__ask">Delete “{item.title}”? This cannot be undone.</span>
            <button type="button" className="dbtn" data-tone="danger" onClick={() => act.remove(item)}>
              <Icon name="trash" size={13} />
              Delete
            </button>
            <button type="button" className="dbtn" ref={keepRef} onClick={() => setArming(false)}>
              Keep it
            </button>
          </div>
        ) : snoozing ? (
          <div className="dline__confirm" role="group" aria-label="Snooze until">
            <span className="dline__ask">No reminders until…</span>
            <button type="button" className="dbtn" onClick={() => act.snooze(item, snoozeDay(today, 'week'))}>
              1 week
            </button>
            <button type="button" className="dbtn" onClick={() => act.snooze(item, snoozeDay(today, 'month'))}>
              1 month
            </button>
            <form
              className="dline__pick"
              onSubmit={(e) => {
                e.preventDefault()
                if (pick) act.snooze(item, pick)
              }}
            >
              <input type="date" className="dfield__input dline__pickinput" aria-label="Pick a day" min={snoozeDay(today, 'day')} value={pick} onChange={(e) => setPick(e.target.value)} />
              <button type="submit" className="dbtn" disabled={!pick}>
                Snooze to this day
              </button>
            </form>
            <button type="button" className="dbtn" data-tone="quiet" onClick={() => setSnoozing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            {!isDone ? (
              <button type="button" className="dbtn" data-tone="go" onClick={() => act.done(item)} title={item.repeat !== 'none' ? 'Moves it on to the next one' : 'Moves it to Done'}>
                <Icon name="check" size={13} />
                {item.repeat !== 'none' ? 'Done — roll on to the next' : 'Mark done'}
              </button>
            ) : null}
            {!isDone ? (
              <button type="button" className="dbtn" onClick={() => setSnoozing(true)}>
                <Icon name="history" size={13} />
                Snooze
              </button>
            ) : null}
            <button type="button" className="dbtn" onClick={() => act.edit(item)}>
              <Icon name="pencil" size={13} />
              Edit
            </button>
            <span className="dline__spacer" />
            <button type="button" className="dbtn" data-tone="quiet" onClick={() => setArming(true)}>
              <Icon name="trash" size={13} />
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )
}

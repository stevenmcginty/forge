import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DATE_KINDS,
  addDays,
  addMonths,
  attentionCount,
  bucketsOf,
  completeItem,
  dayLabel,
  daysLeft,
  humanWhen,
  statusOf,
  todayOf,
  type DateBucket,
  type DateItem,
  type DateKind,
  type DateRepeat
} from '@shared/dates'
import { buzz } from '../lib/haptics'
import { useForge } from '../state'
import { BottomSheet, SheetConfirm, SheetRow, SheetSection } from './BottomSheet'
import { DatesFormBody } from './DatesForm'
import { PhoneIcon } from './PhoneIcon'
import './DatesSheet.css'

/**
 * Dates on the phone (docs/DATES.md, "Phone"): a snapshot of renewals and
 * deadlines in one sheet, so a glance says what is late, what is close and
 * what can wait.
 *
 * One sheet, several steps, like the More sheet: the list (grouped by
 * `bucketsOf`, narrowed by chips), one line's facts and actions, snooze, the
 * delete question, and the add / edit form. Back (Esc, Android Back, the ‹)
 * steps back towards the list; the × and a drag close it.
 *
 * Data and writes only through `state.dates` and `actions.dates`. A write
 * resolves null or with a sentence to show; the new list arrives by itself.
 */

type Step =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'snooze'; id: string }
  | { name: 'delete'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'add' }

/** The step to open on. Only the dev preview passes one. */
export type DatesStart = { step: 'detail' | 'add' | 'snooze' | 'edit' | 'delete'; id?: string }

const REPEAT_WORDS: Record<DateRepeat, string> = {
  none: 'Does not repeat',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  yearly: 'Every year'
}

export function kindLabel(kind: DateKind): string {
  return DATE_KINDS.find((k) => k.id === kind)?.label ?? 'Other'
}

/** `humanWhen`, with "about" put where it reads naturally for a date that is not confirmed. */
function whenWords(item: DateItem, today: string): string {
  const when = humanWhen(item, today)
  if (!item.estimated || item.done) return when
  return when.startsWith('in ') ? `in about ${when.slice(3)}` : `about ${when}`
}

/** "30, 7 and 1 days before, and on the day". */
function reminderWords(days: readonly number[]): string {
  const before = days.filter((d) => d > 0)
  const onDay = days.includes(0)
  if (!before.length) return onDay ? 'On the day' : 'None'
  const list = before.length === 1 ? String(before[0]) : `${before.slice(0, -1).join(', ')} and ${before[before.length - 1]}`
  const unit = before.length === 1 && before[0] === 1 ? 'day' : 'days'
  return `${list} ${unit} before${onDay ? ', and on the day' : ''}`
}

/** Open lines that need Steve now: overdue, today, or within a week. */
function needsYou(item: DateItem, today: string): boolean {
  const status = statusOf(item, today)
  return status === 'overdue' || status === 'today' || (status === 'soon' && daysLeft(item, today) <= 7)
}

export function DatesSheet({ start }: { start?: DatesStart } = {}): ReactNode {
  const { state, actions } = useForge()
  const open = state.datesOpen
  const items = state.dates
  const today = todayOf(new Date())
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const desktop = state.picture?.desktopName || 'the desktop'

  const [step, setStep] = useState<Step>({ name: 'list' })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<{ group: string | null; kind: DateKind | null }>({ group: null, kind: null })
  const [showDone, setShowDone] = useState(false)
  /** Which write is in flight, so its button can say so. */
  const [busy, setBusy] = useState<string | null>(null)
  /** A write's refusal, shown on the step it came from. */
  const [stepError, setStepError] = useState<string | null>(null)
  const [agent, setAgent] = useState<{ id: string; phase: 'busy' | 'ok' | 'failed'; text: string } | null>(null)
  const [flash, setFlash] = useState<{ text: string; undoId?: string; seq: number } | null>(null)
  const [pickDay, setPickDay] = useState('')
  const formId = useId()

  // Every opening starts on the list (or the preview's step), with nothing left over.
  useEffect(() => {
    if (!open) return
    setStep(!start ? { name: 'list' } : start.step === 'add' ? { name: 'add' } : ({ name: start.step, id: start.id ?? '' } as Step))
    setStepError(null)
    setAgent(null)
    setFlash(null)
    setShowDone(false)
  }, [open, start])

  // The list is read on every connection; this covers a first open that beat it.
  const refresh = useRef(actions.dates.refresh)
  refresh.current = actions.dates.refresh
  const load = (): void => {
    setLoading(true)
    setLoadError(null)
    void refresh.current().then((error) => {
      setLoading(false)
      setLoadError(error)
    })
  }
  useEffect(() => {
    if (open && items === null && live) load()
    // `load` is a fresh closure each render; the trigger is opening, or the link coming back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live, items === null])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 5000)
    return () => window.clearTimeout(timer)
  }, [flash])

  const go = (next: Step): void => {
    setStep(next)
    setStepError(null)
    if (next.name === 'snooze') setPickDay('')
  }

  const item = 'id' in step ? (items?.find((i) => i.id === step.id) ?? null) : null
  // The line went (deleted elsewhere, or by us): back to the list rather than a blank step.
  useEffect(() => {
    if ('id' in step && items && !item) setStep({ name: 'list' })
  }, [step, items, item])

  const stepBack = (): void => {
    if (step.name === 'snooze' || step.name === 'delete' || step.name === 'edit') go({ name: 'detail', id: step.id })
    else go({ name: 'list' })
  }

  /** One write: busy while it runs, its sentence on failure, `then` on success. */
  const write = async (key: string, run: () => Promise<string | null>, then?: () => void): Promise<boolean> => {
    setBusy(key)
    setStepError(null)
    const error = await run()
    setBusy(null)
    if (error) {
      setStepError(error)
      buzz('error')
      return false
    }
    then?.()
    return true
  }

  const markDone = (line: DateItem): void => {
    const repeating = line.repeat !== 'none'
    const next = repeating ? completeItem(line).date : null
    void write('done', () => actions.dates.update(line.id, { done: true }), () => {
      go({ name: 'list' })
      setFlash({
        text: next ? `Done. Next one is ${dayLabel(next)}.` : `Done: ${line.title}`,
        undoId: repeating ? undefined : line.id,
        seq: Date.now()
      })
    })
  }

  const snoozeTo = (line: DateItem, until: string | null): void => {
    void write(`snooze:${until ?? 'off'}`, () => actions.dates.update(line.id, { snooze_until: until }), () =>
      go({ name: 'detail', id: line.id })
    )
  }

  const startAgent = (line: DateItem): void => {
    setAgent({ id: line.id, phase: 'busy', text: '' })
    void actions.dates.startAgent(line.id).then((error) => {
      if (error) buzz('error')
      setAgent({ id: line.id, phase: error ? 'failed' : 'ok', text: error ?? '' })
    })
  }

  /* -------------------------------------------------------------- the list */

  const groups = useMemo(() => distinct((items ?? []).map((i) => i.group).filter(Boolean)), [items])
  const kinds = useMemo(() => DATE_KINDS.filter((k) => (items ?? []).some((i) => i.kind === k.id)), [items])
  const shown = useMemo(
    () =>
      (items ?? []).filter(
        (i) => (filter.group === null || i.group === filter.group) && (filter.kind === null || i.kind === filter.kind)
      ),
    [items, filter]
  )
  const buckets = useMemo(() => bucketsOf(shown, today), [shown, today])
  const attention = items ? attentionCount(items, today) : 0
  const openCount = items ? items.filter((i) => statusOf(i, today) !== 'done').length : 0
  const filtered = filter.group !== null || filter.kind !== null

  const summary =
    items === null
      ? loadError
        ? 'Not loaded'
        : live
          ? 'Loading…'
          : 'Waiting for the desktop'
      : !items.length
        ? 'Renewals and deadlines'
        : attention > 0
          ? `${attention} ${attention === 1 ? 'needs' : 'need'} you this week · ${openCount} open`
          : `Nothing needs you this week · ${openCount} open`

  let body: ReactNode
  let footer: ReactNode = null
  let label = 'Dates'
  let title: ReactNode | undefined
  let subtitle: ReactNode = summary
  let back: { label: string; onClick: () => void } | undefined

  if (step.name === 'list' || (step.name !== 'add' && !item)) {
    // Nothing to add to until the list has come: a write would only fail.
    footer = items === null ? null : (
      <button type="button" className="bsbtn" data-tone="act" onClick={() => go({ name: 'add' })} data-testid="dates-add">
        <PhoneIcon name="plus" />
        Add a date
      </button>
    )
    body = (
      <div className="dates" data-testid="dates-list">
        {!live ? (
          <div className="pu-notice dates-note" role="status">
            <span className="pu-notice__mark">
              <PhoneIcon name="link-asleep" />
            </span>
            <div className="pu-notice__text">
              <span className="pu-notice__title">{items ? 'Showing the last list' : `Dates live on ${desktop}`}</span>
              <span className="pu-notice__body">
                {items ? `Not connected to ${desktop}. Changes need it back.` : 'They show here once it is connected.'}
              </span>
            </div>
          </div>
        ) : null}

        {items === null && loadError ? (
          <div className="pu-notice dates-note" data-tone="danger" role="alert">
            <span className="pu-notice__mark">
              <PhoneIcon name="alert" />
            </span>
            <div className="pu-notice__text">
              <span className="pu-notice__title">Couldn’t load your dates</span>
              <span className="pu-notice__body dates-note__whole">{loadError}</span>
              <span className="dates-note__act">
                <button type="button" className="pu-btn pu-btn--sm" onClick={load} disabled={loading}>
                  Try again
                </button>
              </span>
            </div>
          </div>
        ) : null}

        {items === null && !loadError && live ? <DatesSkeleton /> : null}

        {flash ? (
          <div key={flash.seq} className="pu-notice dates-note dates-flash" role="status">
            <span className="pu-notice__mark dates-ok">
              <PhoneIcon name="done" />
            </span>
            <div className="pu-notice__text">
              <span className="pu-notice__title">{flash.text}</span>
            </div>
            {flash.undoId ? (
              <button
                type="button"
                className="pu-btn pu-btn--sm pu-btn--quiet dates-flash__undo"
                onClick={() => {
                  const id = flash.undoId!
                  setFlash(null)
                  void actions.dates.update(id, { done: false })
                }}
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : null}

        {items && items.length === 0 ? (
          <div className="pu-empty dates-empty">
            <span className="pu-empty__icon">
              <DatesGlyph name="calendar" />
            </span>
            <h3 className="pu-empty__title">No dates yet</h3>
            <p className="pu-empty__body">Add a renewal or a deadline, and Forge tells you before it comes round.</p>
          </div>
        ) : null}

        {items && items.length > 0 && (groups.length > 1 || kinds.length > 1) ? (
          <div className="dates-chips" role="toolbar" aria-label="Narrow the list">
            {groups.length > 1
              ? groups.map((g) => (
                  <Chip
                    key={`g:${g}`}
                    label={g}
                    on={filter.group === g}
                    onClick={() => setFilter((f) => ({ ...f, group: f.group === g ? null : g }))}
                  />
                ))
              : null}
            {groups.length > 1 && kinds.length > 1 ? <span className="dates-chips__rule" aria-hidden="true" /> : null}
            {kinds.length > 1
              ? kinds.map((k) => (
                  <Chip
                    key={`k:${k.id}`}
                    label={k.label}
                    on={filter.kind === k.id}
                    onClick={() => setFilter((f) => ({ ...f, kind: f.kind === k.id ? null : k.id }))}
                  />
                ))
              : null}
          </div>
        ) : null}

        {filtered && items && items.length > 0 ? (
          <div className="dates-filtered">
            <span>
              {shown.length} of {items.length}
            </span>
            <button type="button" className="pu-btn pu-btn--sm pu-btn--quiet" onClick={() => setFilter({ group: null, kind: null })}>
              Show all
            </button>
          </div>
        ) : null}

        {items && items.length > 0 && shown.length === 0 ? (
          <div className="pu-empty dates-empty">
            <h3 className="pu-empty__title">Nothing matches</h3>
            <p className="pu-empty__body">No line has both of those.</p>
          </div>
        ) : null}

        {buckets.map((bucket) => (
          <Bucket
            key={bucket.key}
            bucket={bucket}
            today={today}
            folded={bucket.key === 'done' && !showDone}
            onUnfold={() => setShowDone(true)}
            onPick={(line) => go({ name: 'detail', id: line.id })}
          />
        ))}
      </div>
    )
  } else if (step.name === 'detail' && item) {
    const status = statusOf(item, today)
    label = item.title
    title = kindLabel(item.kind)
    subtitle = item.group || undefined
    back = { label: 'Dates', onClick: stepBack }
    const agentHere = agent && agent.id === item.id ? agent : null
    footer =
      status === 'done' ? null : (
        <div className="dates-foot">
          {agentHere && agentHere.phase !== 'busy' ? (
            <div className="pu-notice dates-note" data-tone={agentHere.phase === 'failed' ? 'danger' : undefined} role="status">
              <span className={`pu-notice__mark${agentHere.phase === 'ok' ? ' dates-ok' : ''}`}>
                <PhoneIcon name={agentHere.phase === 'ok' ? 'done' : 'alert'} />
              </span>
              <div className="pu-notice__text">
                <span className="pu-notice__title">{agentHere.phase === 'ok' ? 'Agent started' : 'The agent did not start'}</span>
                <span className="pu-notice__body">
                  {agentHere.phase === 'ok' ? `It is working in a new tab on ${desktop}.` : agentHere.text}
                </span>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="bsbtn"
            data-tone="act"
            disabled={agentHere?.phase === 'busy'}
            onClick={() => startAgent(item)}
            data-testid="dates-agent"
          >
            {agentHere?.phase === 'busy' ? <span className="pu-spinner" aria-hidden="true" /> : <DatesGlyph name="agent" />}
            {agentHere?.phase === 'busy' ? 'Starting…' : 'Get an agent on it'}
          </button>
        </div>
      )
    body = (
      <div className="dates dates-detail" data-testid="dates-detail">
        <div className="dates-hero">
          <h3 className="dates-hero__title">{item.title}</h3>
          <p className="dates-hero__when" data-status={status} data-near={needsYou(item, today) ? 'true' : undefined}>
            {status === 'overdue' || status === 'today' ? <span className="pu-bang" aria-hidden="true">!</span> : null}
            {status === 'done' ? <PhoneIcon name="done" className="dates-ok" /> : null}
            <span className="dates-hero__word">{status === 'done' ? 'Done' : whenWords(item, today)}</span>
            <span className="dates-hero__day">
              {item.estimated ? 'about ' : ''}
              {dayLabel(item.date)}
            </span>
          </p>
          {item.amount ? <p className="dates-hero__amount">{item.amount}</p> : null}
        </div>

        {stepError ? <ErrorNote text={stepError} /> : null}

        <div className="dates-acts">
          {status === 'done' ? (
            <button
              type="button"
              className="pu-btn"
              disabled={busy !== null}
              onClick={() => void write('reopen', () => actions.dates.update(item.id, { done: false }))}
            >
              {busy === 'reopen' ? <span className="pu-spinner" aria-hidden="true" /> : <DatesGlyph name="undo" />}
              Open again
            </button>
          ) : (
            <>
              <button type="button" className="pu-btn" disabled={busy !== null} onClick={() => markDone(item)} data-testid="dates-done">
                {busy === 'done' ? <span className="pu-spinner" aria-hidden="true" /> : <PhoneIcon name="done" />}
                Done
              </button>
              <button type="button" className="pu-btn" disabled={busy !== null} onClick={() => go({ name: 'snooze', id: item.id })}>
                <DatesGlyph name="snooze" />
                Snooze
              </button>
            </>
          )}
          <button type="button" className="pu-btn" disabled={busy !== null} onClick={() => go({ name: 'edit', id: item.id })}>
            <DatesGlyph name="pencil" />
            Edit
          </button>
        </div>

        {item.repeat !== 'none' && status !== 'done' ? (
          <p className="dates-hint">Done moves it on to {dayLabel(completeItem(item).date)}.</p>
        ) : null}

        {item.action ? (
          <Prose label="What to do" text={item.action} />
        ) : null}
        {item.note ? <Prose label="Note" text={item.note} /> : null}

        <section className="bssec" aria-label="Facts">
          <div className="bssec__title">Facts</div>
          <dl className="bssec__rows dates-facts">
            <Fact term="When" value={`${item.estimated ? 'About ' : ''}${dayLabel(item.date)}${item.estimated ? ' (not confirmed)' : ''}`} />
            {item.endDate ? <Fact term="Until" value={dayLabel(item.endDate)} /> : null}
            <Fact term="Repeats" value={REPEAT_WORDS[item.repeat]} />
            <Fact term="Alerts" value={reminderWords(item.remindDays)} />
            {item.snoozedUntil && item.snoozedUntil > today ? (
              <Fact term="Snoozed" value={`No alerts before ${dayLabel(item.snoozedUntil)}`} />
            ) : null}
          </dl>
        </section>

        <SheetSection>
          <SheetRow
            icon={<DatesGlyph name="trash" />}
            label="Delete"
            secondary="From the desktop and this phone"
            tone="danger"
            onClick={() => go({ name: 'delete', id: item.id })}
            testId="dates-delete"
          />
        </SheetSection>
      </div>
    )
  } else if (step.name === 'snooze' && item) {
    label = 'Snooze'
    subtitle = item.title
    back = { label: item.title, onClick: stepBack }
    const week = addDays(today, 7)
    const month = addMonths(today, 1)
    const earliest = addDays(today, 1)
    const snoozed = item.snoozedUntil && item.snoozedUntil > today
    const spin = (key: string): ReactNode => (busy === key ? <span className="pu-spinner" aria-hidden="true" /> : undefined)
    body = (
      <div className="dates" data-testid="dates-snooze">
        <p className="dates-lede">No alerts for this line before the day you choose. The date itself stays the same.</p>
        {stepError ? <ErrorNote text={stepError} /> : null}
        <SheetSection>
          <SheetRow label="1 week" secondary={dayLabel(week)} trailing={spin(`snooze:${week}`)} disabled={busy !== null} onClick={() => snoozeTo(item, week)} />
          <SheetRow label="1 month" secondary={dayLabel(month)} trailing={spin(`snooze:${month}`)} disabled={busy !== null} onClick={() => snoozeTo(item, month)} />
        </SheetSection>
        <SheetSection title="Pick a day">
          <form
            className="dates-pick"
            onSubmit={(e) => {
              e.preventDefault()
              if (pickDay) snoozeTo(item, pickDay)
            }}
          >
            <input
              className="pu-input"
              type="date"
              aria-label="Snooze until"
              min={earliest}
              value={pickDay}
              onChange={(e) => setPickDay(e.target.value)}
            />
            <button type="submit" className="pu-btn" disabled={!pickDay || busy !== null}>
              {spin(`snooze:${pickDay}`)}
              Snooze
            </button>
          </form>
        </SheetSection>
        {snoozed ? (
          <SheetSection>
            <SheetRow
              label="Stop snoozing"
              secondary={`Snoozed until ${dayLabel(item.snoozedUntil!)}`}
              trailing={spin('snooze:off')}
              disabled={busy !== null}
              onClick={() => snoozeTo(item, null)}
            />
          </SheetSection>
        ) : null}
      </div>
    )
  } else if (step.name === 'delete' && item) {
    label = 'Delete'
    title = null
    body = (
      <>
        {stepError ? <ErrorNote text={stepError} /> : null}
        <SheetConfirm
          question={`Delete “${item.title}”?`}
          detail="It goes from the desktop and this phone, with its alerts. This cannot be undone."
          confirmLabel={busy === 'delete' ? 'Deleting…' : 'Delete'}
          onCancel={stepBack}
          onConfirm={() => {
            if (busy) return
            const name = item.title
            void write('delete', () => actions.dates.update(item.id, { delete: true }), () => {
              go({ name: 'list' })
              setFlash({ text: `Deleted: ${name}`, seq: Date.now() })
            })
          }}
          testId="dates-delete-confirm"
        />
      </>
    )
  }

  if (step.name === 'add' || (step.name === 'edit' && item)) {
    const editing = step.name === 'edit' ? item : null
    label = editing ? 'Edit date' : 'New date'
    title = undefined
    subtitle = editing ? editing.title : 'A title and a day are enough'
    back = { label: editing ? editing.title : 'Dates', onClick: stepBack }
    footer = (
      <div className="dates-foot dates-foot--two">
        <button type="button" className="bsbtn" onClick={stepBack}>
          Cancel
        </button>
        <button type="submit" form={formId} className="bsbtn" data-tone="act" disabled={busy === 'save'} data-testid="dates-save">
          {busy === 'save' ? <span className="pu-spinner" aria-hidden="true" /> : null}
          {editing ? 'Save' : 'Add date'}
        </button>
      </div>
    )
    body = (
      <DatesFormBody
        key={editing?.id ?? 'new'}
        formId={formId}
        item={editing}
        groups={groups}
        error={stepError ? <ErrorNote text={stepError} /> : null}
        onSubmit={(result) => {
          if (result.kind === 'add') {
            const name = result.input.title
            void write('save', () => actions.dates.add(result.input), () => {
              go({ name: 'list' })
              setFlash({ text: `Added: ${name}`, seq: Date.now() })
            })
          } else if (editing) {
            if (!Object.keys(result.patch).length) {
              go({ name: 'detail', id: editing.id })
              return
            }
            void write('save', () => actions.dates.update(editing.id, result.patch), () => go({ name: 'detail', id: editing.id }))
          }
        }}
      />
    )
  }

  return (
    <BottomSheet
      open={open}
      onClose={actions.dates.close}
      onBack={step.name !== 'list' ? stepBack : undefined}
      label={label}
      title={title}
      subtitle={subtitle}
      back={back}
      footer={footer}
      testId="dates-sheet"
    >
      <div key={step.name} className="dates-step pu-in-fade">
        {body}
      </div>
    </BottomSheet>
  )
}

/* ------------------------------------------------------------------- parts */

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): ReactNode {
  return (
    <button type="button" className="pu-chip" aria-pressed={on} onClick={onClick}>
      <PhoneIcon name="check" className="pu-check" />
      {label}
    </button>
  )
}

/** One time bucket: a quiet label (with the "!" disc when it needs Steve), then its lines in one well. */
function Bucket({
  bucket,
  today,
  folded,
  onUnfold,
  onPick
}: {
  bucket: DateBucket
  today: string
  folded: boolean
  onUnfold: () => void
  onPick: (item: DateItem) => void
}): ReactNode {
  const urgent = bucket.key === 'overdue' || bucket.key === 'today'
  return (
    <section className="bssec dates-bucket" data-bucket={bucket.key} aria-label={`${bucket.label}, ${bucket.items.length}`}>
      <div className="bssec__title dates-bucket__title">
        {urgent ? <span className="pu-bang" aria-hidden="true">!</span> : null}
        <span>{bucket.label}</span>
        <span className="dates-bucket__count">{bucket.items.length}</span>
      </div>
      <div className="bssec__rows">
        {folded ? (
          <SheetRow
            label={`Show ${bucket.items.length} done`}
            secondary="Finished lines, newest first"
            onClick={onUnfold}
            chevron
            testId="dates-show-done"
          />
        ) : (
          bucket.items.map((line) => <Line key={line.id} item={line} today={today} onPick={() => onPick(line)} />)
        )}
      </div>
    </section>
  )
}

/** One line: the day as a calendar leaf, what and whose, and when on the right where the eye runs down. */
function Line({ item, today, onPick }: { item: DateItem; today: string; onPick: () => void }): ReactNode {
  const status = statusOf(item, today)
  const [, day, month] = dayLabel(item.date).split(' ')
  const meta = [item.group, item.amount].filter(Boolean).join(' · ') || kindLabel(item.kind)
  const ongoing = item.endDate && status === 'today'
  return (
    <button type="button" className="bsrow dates-line" data-status={status} data-near={needsYou(item, today) ? 'true' : undefined} onClick={onPick}>
      <span className="dates-leaf" aria-hidden="true">
        <span className="dates-leaf__day">{day}</span>
        <span className="dates-leaf__month">{month}</span>
      </span>
      <span className="bsrow__text">
        <span className="bsrow__label dates-line__title">{item.title}</span>
        <span className="bsrow__sub dates-line__meta">{ongoing ? `Until ${dayLabel(item.endDate!)}` : meta}</span>
      </span>
      <span className="dates-line__when">
        {status === 'done' ? <PhoneIcon name="done" className="dates-ok" /> : null}
        {status === 'done' ? 'Done' : whenWords(item, today)}
      </span>
    </button>
  )
}

function DatesSkeleton(): ReactNode {
  return (
    <section className="bssec dates-bucket" aria-label="Loading" aria-busy="true">
      <div className="bssec__title">
        <span className="pu-skeleton" style={{ width: 96 }} />
      </div>
      <div className="bssec__rows">
        {[64, 48, 56].map((w) => (
          <div key={w} className="bsrow dates-line" data-static="true">
            <span className="dates-leaf">
              <span className="pu-skeleton dates-leaf__ghost" />
            </span>
            <span className="bsrow__text">
              <span className="pu-skeleton" style={{ width: `${w + 20}%` }} />
              <span className="pu-skeleton" style={{ width: `${w - 10}%`, height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Fact({ term, value }: { term: string; value: string }): ReactNode {
  return (
    <div className="dates-fact">
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function Prose({ label, text }: { label: string; text: string }): ReactNode {
  return (
    <section className="bssec" aria-label={label}>
      <div className="bssec__title">{label}</div>
      <p className="bssec__rows dates-prose">{text}</p>
    </section>
  )
}

export function ErrorNote({ text }: { text: string }): ReactNode {
  return (
    <div className="pu-notice dates-note" data-tone="danger" role="alert">
      <span className="pu-notice__mark">
        <PhoneIcon name="alert" />
      </span>
      <div className="pu-notice__text">
        <span className="pu-notice__body dates-note__whole">{text}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ glyphs */

export type DatesGlyphName = 'calendar' | 'agent' | 'snooze' | 'pencil' | 'trash' | 'undo'

/**
 * The few glyphs Dates needs that PhoneIcon does not have, drawn on its grid
 * (24, 1.8 round stroke, currentColor) so they read as the same family.
 */
const GLYPHS: Record<DatesGlyphName, ReactNode> = {
  calendar: (
    <>
      <path d="M6.5 5.5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z" />
      <path d="M4.5 10h15M8.5 3.5v3.5M15.5 3.5v3.5" />
      <path d="M8.5 14h2M13.5 14h2" />
    </>
  ),
  agent: <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9Z M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" />,
  snooze: (
    <>
      <path d="M12 6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13Z" />
      <path d="M10 11h4l-4 4h4M4.5 6 7 3.8M19.5 6 17 3.8" />
    </>
  ),
  pencil: <path d="M14.5 5.5l4 4L9 19H5v-4Zm-2 2 4 4" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12h9l1-12" />
      <path d="M10.5 10.5v5M13.5 10.5v5" />
    </>
  ),
  undo: <path d="M9 7.5 5 11.5l4 4M5.5 11.5H14a4.5 4.5 0 0 1 0 9h-2" />
}

export function DatesGlyph({ name, size, className }: { name: DatesGlyphName; size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}

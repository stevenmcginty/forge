import { useId, useState, type ReactNode } from 'react'
import { DATE_KINDS, inputError, type DateItem, type DateKind, type DateRepeat } from '@shared/dates'
import type { WebDateChange, WebDateFields } from '@shared/web'
import { SheetRow, SheetSection, SheetSwitch } from './BottomSheet'
import { PhoneIcon } from './PhoneIcon'

/**
 * The add / edit form for one Dates line, as the body of the Dates sheet's
 * add and edit steps. Its buttons live in the sheet's pinned footer and reach
 * the form by its id (`form=`), so Save stays above the keyboard.
 *
 * Quick by default: a title and a day are enough to add a line. Everything
 * else folds behind "More details" (open from the start when editing). The
 * rules are `inputError`'s, so the phone refuses exactly what the store would.
 */

export type DatesFormResult =
  | { kind: 'add'; input: WebDateFields & { title: string; date: string } }
  | { kind: 'edit'; patch: WebDateChange }

const REPEATS: { id: DateRepeat; label: string }[] = [
  { id: 'none', label: 'Does not repeat' },
  { id: 'monthly', label: 'Every month' },
  { id: 'quarterly', label: 'Every 3 months' },
  { id: 'yearly', label: 'Every year' }
]

interface Fields {
  title: string
  date: string
  estimated: boolean
  kind: DateKind
  group: string
  amount: string
  endDate: string
  repeat: DateRepeat
  note: string
  action: string
}

function fieldsOf(item: DateItem | null): Fields {
  return {
    title: item?.title ?? '',
    date: item?.date ?? '',
    estimated: item?.estimated ?? false,
    kind: item?.kind ?? 'other',
    group: item?.group ?? '',
    amount: item?.amount ?? '',
    endDate: item?.endDate ?? '',
    repeat: item?.repeat ?? 'none',
    note: item?.note ?? '',
    action: item?.action ?? ''
  }
}

/** Only what changed, in the wire's field names. */
function patchOf(item: DateItem, f: Fields): WebDateChange {
  const patch: WebDateChange = {}
  if (f.title.trim() !== item.title) patch.title = f.title.trim()
  if (f.date !== item.date) patch.date = f.date
  if (f.estimated !== item.estimated) patch.estimated = f.estimated
  if (f.kind !== item.kind) patch.kind = f.kind
  if (f.group.trim() !== item.group) patch.group = f.group.trim()
  if (f.amount.trim() !== item.amount) patch.amount = f.amount.trim()
  if (f.endDate !== (item.endDate ?? '')) patch.end_date = f.endDate || null
  if (f.repeat !== item.repeat) patch.repeat = f.repeat
  if (f.note.trim() !== item.note) patch.note = f.note.trim()
  if (f.action.trim() !== item.action) patch.action = f.action.trim()
  return patch
}

function inputOf(f: Fields): WebDateFields & { title: string; date: string } {
  const input: WebDateFields & { title: string; date: string } = { title: f.title.trim(), date: f.date }
  if (f.estimated) input.estimated = true
  if (f.kind !== 'other') input.kind = f.kind
  if (f.group.trim()) input.group = f.group.trim()
  if (f.amount.trim()) input.amount = f.amount.trim()
  if (f.endDate) input.end_date = f.endDate
  if (f.repeat !== 'none') input.repeat = f.repeat
  if (f.note.trim()) input.note = f.note.trim()
  if (f.action.trim()) input.action = f.action.trim()
  return input
}

export function DatesFormBody({
  formId,
  item,
  groups,
  error,
  onSubmit
}: {
  formId: string
  /** The line being edited; null for a new one. */
  item: DateItem | null
  /** The groups already in the list, offered as one-tap answers. */
  groups: string[]
  /** The desktop's refusal of the last save, if any. */
  error: ReactNode
  onSubmit: (result: DatesFormResult) => void
}): ReactNode {
  const [f, setF] = useState<Fields>(() => fieldsOf(item))
  const [more, setMore] = useState(item !== null)
  const [tried, setTried] = useState(false)
  const ids = useId()
  const set = <K extends keyof Fields>(key: K, value: Fields[K]): void => setF((prev) => ({ ...prev, [key]: value }))

  const titleError = inputError({ title: f.title })
  // An empty day is the one case the store's sentence ("is not a real day") does not fit a date picker.
  const dateError = f.date ? inputError({ date: f.date }) : 'Pick a day.'
  const endError = f.endDate ? inputError({ endDate: f.endDate }, f.date || undefined) : null
  const show = (e: string | null): string | null => (tried ? e : null)

  return (
    <form
      id={formId}
      className="dates-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (titleError || dateError || endError) {
          if (endError && !titleError && !dateError) setMore(true)
          return
        }
        onSubmit(item ? { kind: 'edit', patch: patchOf(item, f) } : { kind: 'add', input: inputOf(f) })
      }}
    >
      {error}
      <div className="pu-field">
        <label className="pu-field__label" htmlFor={`${ids}t`}>
          What happens
        </label>
        <input
          id={`${ids}t`}
          className="pu-input"
          type="text"
          enterKeyHint="next"
          autoComplete="off"
          autoCapitalize="sentences"
          maxLength={120}
          placeholder="Shop lease ends"
          autoFocus={item === null}
          value={f.title}
          aria-invalid={show(titleError) ? true : undefined}
          onChange={(e) => set('title', e.target.value)}
        />
        {show(titleError) ? (
          <p className="pu-field__hint" data-tone="danger">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="pu-field">
        <label className="pu-field__label" htmlFor={`${ids}d`}>
          Day
        </label>
        <input
          id={`${ids}d`}
          className="pu-input"
          type="date"
          value={f.date}
          aria-invalid={show(dateError) ? true : undefined}
          onChange={(e) => set('date', e.target.value)}
        />
        {show(dateError) ? (
          <p className="pu-field__hint" data-tone="danger">
            {dateError}
          </p>
        ) : null}
      </div>

      <SheetSection>
        <SheetRow
          label="Not sure of the day"
          secondary={f.estimated ? 'Shows as “about”' : 'The day is confirmed'}
          role="switch"
          checked={f.estimated}
          trailing={<SheetSwitch on={f.estimated} />}
          onClick={() => set('estimated', !f.estimated)}
        />
        {!more ? (
          <SheetRow
            label="More details"
            secondary="Kind, group, money, repeat, notes"
            trailing={<PhoneIcon name="chevron-down" className="dates-form__fold" />}
            onClick={() => setMore(true)}
            testId="dates-more-details"
          />
        ) : null}
      </SheetSection>

      {more ? (
        <>
          <div className="pu-field">
            <span className="pu-field__label" id={`${ids}k`}>
              Kind
            </span>
            <div className="dates-form__chips" role="radiogroup" aria-labelledby={`${ids}k`}>
              {DATE_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className="pu-chip"
                  role="radio"
                  aria-checked={f.kind === k.id}
                  onClick={() => set('kind', k.id)}
                >
                  <PhoneIcon name="check" className="pu-check" />
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pu-field">
            <label className="pu-field__label" htmlFor={`${ids}g`}>
              Group
            </label>
            <input
              id={`${ids}g`}
              className="pu-input"
              type="text"
              autoComplete="off"
              placeholder="A business, a house, a car"
              value={f.group}
              onChange={(e) => set('group', e.target.value)}
            />
            {groups.length ? (
              <div className="dates-form__chips" aria-label="Groups in the list">
                {groups.map((g) => (
                  <button
                    key={g}
                    type="button"
                    className="pu-chip"
                    aria-pressed={f.group.trim() === g}
                    onClick={() => set('group', f.group.trim() === g ? '' : g)}
                  >
                    <PhoneIcon name="check" className="pu-check" />
                    {g}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="pu-field">
            <label className="pu-field__label" htmlFor={`${ids}a`}>
              Money
            </label>
            <input
              id={`${ids}a`}
              className="pu-input"
              type="text"
              autoComplete="off"
              placeholder="250 a month"
              value={f.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </div>

          <div className="pu-field">
            <label className="pu-field__label" htmlFor={`${ids}e`}>
              Last day
            </label>
            <input
              id={`${ids}e`}
              className="pu-input"
              type="date"
              min={f.date || undefined}
              value={f.endDate}
              aria-invalid={show(endError) ? true : undefined}
              onChange={(e) => set('endDate', e.target.value)}
            />
            <p className="pu-field__hint" data-tone={show(endError) ? 'danger' : undefined}>
              {show(endError) ?? 'Only for something that runs over days, like a holiday.'}
            </p>
          </div>

          <SheetSection title="Repeats">
            <div role="radiogroup" aria-label="Repeats">
              {REPEATS.map((r) => (
                <SheetRow key={r.id} label={r.label} role="radio" checked={f.repeat === r.id} onClick={() => set('repeat', r.id)} />
              ))}
            </div>
          </SheetSection>

          <div className="pu-field">
            <label className="pu-field__label" htmlFor={`${ids}w`}>
              What to do
            </label>
            <textarea
              id={`${ids}w`}
              className="pu-input"
              rows={2}
              placeholder="Get three quotes a month before"
              value={f.action}
              onChange={(e) => set('action', e.target.value)}
            />
          </div>

          <div className="pu-field">
            <label className="pu-field__label" htmlFor={`${ids}n`}>
              Note
            </label>
            <textarea
              id={`${ids}n`}
              className="pu-input"
              rows={3}
              placeholder="Notice rules, who to call"
              value={f.note}
              onChange={(e) => set('note', e.target.value)}
            />
          </div>
        </>
      ) : null}
    </form>
  )
}

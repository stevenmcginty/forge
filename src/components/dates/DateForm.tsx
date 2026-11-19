import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  DATE_KINDS,
  DATE_TITLE_MAX,
  DEFAULT_REMIND_DAYS,
  inputError,
  type DateItem,
  type DateKind,
  type DateRepeat
} from '@shared/dates'
import { datesApi } from '@/lib/datesApi'
import { Icon } from '../Icon'
import { plainError, REMIND_PRESETS, REPEAT_WORDS } from './dateWords'

/**
 * Add or edit one date, in a card over the page.
 *
 * Title and day are all it needs: they sit on top, the title has the focus,
 * and Enter saves. Everything else is optional and sits below a quiet rule —
 * kind, business, money, how long it lasts, whether it repeats, how early to
 * be reminded, and the facts an agent will need later.
 */

type Preset = (typeof REMIND_PRESETS)[number]['id'] | 'custom'

const REPEATS: DateRepeat[] = ['none', 'monthly', 'quarterly', 'yearly']

function presetOf(days: readonly number[]): Preset {
  const key = days.join(',')
  return REMIND_PRESETS.find((p) => p.days.join(',') === key)?.id ?? 'custom'
}

/** "60, 14, 1" as days, or null when any part is not a whole day 0 to 730. */
function parseDays(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean)
  if (parts.length === 0) return null
  const days = parts.map(Number)
  return days.every((d) => Number.isInteger(d) && d >= 0 && d <= 730) ? days : null
}

export function DateForm({
  initial,
  groups,
  onClose,
  onSaved
}: {
  /** The line being edited; absent for a new one. */
  initial: DateItem | null
  /** The groups already in use, offered as suggestions. */
  groups: string[]
  onClose: () => void
  onSaved: (item: DateItem, added: boolean) => void
}): ReactNode {
  const ids = useId()
  const cardRef = useRef<HTMLFormElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [date, setDate] = useState(initial?.date ?? '')
  const [kind, setKind] = useState<DateKind>(initial?.kind ?? 'other')
  const [group, setGroup] = useState(initial?.group ?? '')
  const [amount, setAmount] = useState(initial?.amount ?? '')
  const [spans, setSpans] = useState(Boolean(initial?.endDate))
  const [endDate, setEndDate] = useState(initial?.endDate ?? '')
  const [estimated, setEstimated] = useState(initial?.estimated ?? false)
  const [repeat, setRepeat] = useState<DateRepeat>(initial?.repeat ?? 'none')
  const initialDays = initial?.remindDays ?? [...DEFAULT_REMIND_DAYS]
  const [preset, setPreset] = useState<Preset>(presetOf(initialDays))
  const [custom, setCustom] = useState(presetOf(initialDays) === 'custom' ? initialDays.join(', ') : '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [action, setAction] = useState(initial?.action ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    titleRef.current?.focus()
    if (initial) titleRef.current?.select()
  }, [initial])

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (busy) return
    const cleanTitle = title.trim()
    if (!cleanTitle) return fail('A date needs a title.')
    if (!date) return fail('Pick the day it happens.')
    const end = spans && endDate ? endDate : ''
    const remindDays = preset === 'custom' ? parseDays(custom) : (REMIND_PRESETS.find((p) => p.id === preset)?.days ?? [...DEFAULT_REMIND_DAYS])
    if (!remindDays) return fail('Reminders are whole days before the date, for example 60, 14, 1.')
    const problem = inputError({ title: cleanTitle, date, ...(end ? { endDate: end } : {}) }, date)
    if (problem) return fail(problem)
    const api = datesApi()
    if (!api) return fail('Restart Forge to save dates.')
    const fields = { title: cleanTitle, date, kind, group: group.trim(), amount: amount.trim(), note: note.trim(), action: action.trim(), estimated, remindDays, repeat }
    setBusy(true)
    try {
      const saved = initial
        ? await api.update(initial.id, { ...fields, endDate: end || null })
        : await api.add({ ...fields, ...(end ? { endDate: end } : {}) })
      if (!saved) return fail('That date is no longer on the list.')
      onSaved(saved, !initial)
    } catch (err) {
      fail(plainError(err))
    } finally {
      setBusy(false)
    }
  }

  function fail(message: string): void {
    setError(message)
  }

  /** Esc closes; Tab stays inside the card; Ctrl+Enter saves from a note box. */
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key !== 'Tab' || !cardRef.current) return
    const focusable = [...cardRef.current.querySelectorAll<HTMLElement>('input, textarea, button, select')].filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="dform"
      onPointerDown={(e) => {
        // A stray click outside closes an untouched card; once something is typed it stays.
        if (e.target === e.currentTarget && !touched) onClose()
      }}
    >
      <form
        ref={cardRef}
        className="dform__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-head`}
        onSubmit={(e) => void submit(e)}
        onKeyDown={onKeyDown}
        onChange={() => {
          setTouched(true)
          if (error) setError(null)
        }}
        noValidate
      >
        <header className="dform__head">
          <h2 className="dform__title" id={`${ids}-head`}>
            {initial ? 'Edit date' : 'Add a date'}
          </h2>
          <button type="button" className="dform__x" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dform__scroll">
          <div className="dform__must">
            <label className="dfield dfield--title">
              <span className="dfield__label">What happens</span>
              <input
                ref={titleRef}
                className="dfield__input dfield__input--big"
                value={title}
                maxLength={DATE_TITLE_MAX}
                placeholder="Shop lease ends"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="dfield dfield--date">
              <span className="dfield__label">{spans ? 'From' : 'On'}</span>
              <input type="date" className="dfield__input dfield__input--big" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>

          <div className="dform__rule">
            <span>Optional</span>
          </div>

          <fieldset className="dfield dfield--wide">
            <legend className="dfield__label">Kind</legend>
            <div className="dchips">
              {DATE_KINDS.map((k) => (
                <label key={k.id} className="dchip">
                  <input type="radio" name={`${ids}-kind`} value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
                  <span>{k.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="dform__grid">
            <label className="dfield">
              <span className="dfield__label">Business or group</span>
              <input className="dfield__input" value={group} list={`${ids}-groups`} placeholder="Shop" onChange={(e) => setGroup(e.target.value)} />
              <datalist id={`${ids}-groups`}>
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <label className="dfield">
              <span className="dfield__label">Money</span>
              <input className="dfield__input" value={amount} placeholder="250 a month" onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>

          <div className="dform__grid">
            <div className="dfield">
              <label className="dtoggle">
                <input type="checkbox" checked={spans} onChange={(e) => setSpans(e.target.checked)} />
                <span className="dtoggle__box" aria-hidden="true" />
                <span>Lasts more than one day</span>
              </label>
              {spans ? (
                <label className="dfield dfield--inline">
                  <span className="dfield__label">Until</span>
                  <input type="date" className="dfield__input" value={endDate} min={date || undefined} onChange={(e) => setEndDate(e.target.value)} />
                </label>
              ) : null}
            </div>
            <div className="dfield">
              <label className="dtoggle">
                <input type="checkbox" checked={estimated} onChange={(e) => setEstimated(e.target.checked)} />
                <span className="dtoggle__box" aria-hidden="true" />
                <span>The day is a guess — show “about”</span>
              </label>
            </div>
          </div>

          <fieldset className="dfield dfield--wide">
            <legend className="dfield__label">Repeats</legend>
            <div className="dseg" style={{ '--n': REPEATS.length } as CSSProperties}>
              {REPEATS.map((r) => (
                <label key={r} className="dseg__opt">
                  <input type="radio" name={`${ids}-repeat`} value={r} checked={repeat === r} onChange={() => setRepeat(r)} />
                  <span>{REPEAT_WORDS[r]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="dfield dfield--wide">
            <legend className="dfield__label">Remind me</legend>
            <div className="dremind">
              {REMIND_PRESETS.map((p) => (
                <label key={p.id} className="dremind__opt">
                  <input type="radio" name={`${ids}-remind`} value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} />
                  <span className="dremind__name">{p.label}</span>
                  <span className="dremind__hint">{p.hint}</span>
                </label>
              ))}
              <label className="dremind__opt">
                <input type="radio" name={`${ids}-remind`} value="custom" checked={preset === 'custom'} onChange={() => setPreset('custom')} />
                <span className="dremind__name">Custom</span>
                <span className="dremind__hint">Days before, with commas</span>
              </label>
            </div>
            {preset === 'custom' ? (
              <input
                className="dfield__input dremind__custom"
                value={custom}
                placeholder="60, 14, 1, 0"
                aria-label="Days before the date to remind you, with commas"
                onChange={(e) => setCustom(e.target.value)}
              />
            ) : null}
          </fieldset>

          <label className="dfield dfield--wide">
            <span className="dfield__label">The facts</span>
            <textarea className="dfield__input dfield__area" rows={3} value={note} placeholder="Notice period, who to call, the policy or account number" onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="dfield dfield--wide">
            <span className="dfield__label">What to do when it comes up</span>
            <textarea className="dfield__input dfield__area" rows={2} value={action} placeholder="Get three quotes a month before" onChange={(e) => setAction(e.target.value)} />
          </label>
        </div>

        <footer className="dform__foot">
          <p className="dform__error" role="alert">
            {error ?? ''}
          </p>
          <button type="button" className="dbtn" data-tone="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dbtn dbtn--solid" disabled={busy}>
            {initial ? 'Save' : 'Add date'}
          </button>
        </footer>
      </form>
    </div>
  )
}

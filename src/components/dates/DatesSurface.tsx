import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  agentPrompt,
  attentionCount,
  bucketsOf,
  DATE_KINDS,
  dayLabel,
  daysLeft,
  humanWhen,
  sortItems,
  statusOf,
  type DateItem,
  type DateKind
} from '@shared/dates'
import { datesApi } from '@/lib/datesApi'
import type { SurfaceProps } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { useActions } from '@/state/AppState'
import { Icon } from '../Icon'
import { DateForm } from './DateForm'
import { DateLine, type DateLineActions } from './DateLine'
import { CalendarIcon } from './DatesGlyph'
import { useDates, useToday } from './datesStore'
import { nearnessOf, plainError, whenWords } from './dateWords'
import './dates.css'

/**
 * Dates — "the almanac on the wall".
 *
 * Steve opens it to know in two seconds what is close, what is late and what
 * can wait. The left column answers that in one sentence (how many need him
 * this week, or "All clear" and what is next), then lets him narrow the list by
 * business and by kind. The right side is a strip of the next six months with
 * every date on it as a dot, and under it the list itself, cut by time
 * (`bucketsOf`). A line is one glance; a click opens its facts and the rest of
 * its actions. The one thing to do about a line is always on it: "Get an agent
 * on it".
 *
 * Calm by default: muted ink, no colour, until a line is this week (amber
 * words), today (the accent) or late (red). The colour is the alarm; nothing
 * moves or blinks.
 */

const RIBBON_DAYS = 183
const NO_GROUP = '\u0000none'
const PANE_NAME_MAX = 40

type Notice = { id: number; text: string; tone?: 'danger' }
type FormState = { item: DateItem | null } | null

export function DatesSurface({ active }: SurfaceProps): ReactNode {
  const { items, missing } = useDates()
  const today = useToday()
  const actions = useActions()
  const [kind, setKind] = useState<DateKind | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(null)
  const [showDone, setShowDone] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const addRef = useRef<HTMLButtonElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastFocus = useRef<HTMLElement | null>(null)

  const all = useMemo(() => items ?? [], [items])
  const open = useMemo(() => all.filter((i) => statusOf(i, today) !== 'done'), [all, today])

  // The filter choices come from what is on the list, with how many open lines each has.
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of all) counts.set(i.group || NO_GROUP, (counts.get(i.group || NO_GROUP) ?? 0) + (statusOf(i, today) === 'done' ? 0 : 1))
    const named = [...counts.keys()].filter((g) => g !== NO_GROUP).sort((a, b) => a.localeCompare(b))
    // "No group" is only a choice when some lines have a group and some do not.
    if (named.length > 0 && counts.has(NO_GROUP)) named.push(NO_GROUP)
    return named.map((g) => ({ id: g, label: g === NO_GROUP ? 'No group' : g, count: counts.get(g) ?? 0 }))
  }, [all, today])
  const kinds = useMemo(
    () =>
      DATE_KINDS.map((k) => ({ ...k, count: open.filter((i) => i.kind === k.id).length, any: all.some((i) => i.kind === k.id) })).filter(
        (k) => k.any || k.id === kind
      ),
    [all, open, kind]
  )

  const shown = useMemo(
    () => all.filter((i) => (kind === null || i.kind === kind) && (group === null || (i.group || NO_GROUP) === group)),
    [all, kind, group]
  )
  const buckets = useMemo(() => bucketsOf(shown, today), [shown, today])
  const filtered = kind !== null || group !== null

  /* ------------------------------------------------------------ notices */

  const say = useCallback((text: string, tone?: 'danger') => setNotice({ id: Date.now(), text, ...(tone ? { tone } : {}) }), [])
  useEffect(() => {
    if (!notice) return undefined
    const t = setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), notice.tone ? 9000 : 5200)
    return () => clearTimeout(t)
  }, [notice])

  /* ------------------------------------------------------------ actions */

  const act: DateLineActions = useMemo(
    () => ({
      agent(item) {
        const name = item.title.length > PANE_NAME_MAX ? `${item.title.slice(0, PANE_NAME_MAX - 1).trimEnd()}…` : item.title
        const opened = actions.openAgentPane(name, agentPrompt(item, today), { submit: true, name })
        if (opened) uiCommands.run('set-mode', 'agents')
        else say('No agent could open: the tab or session limit is full. Close one and try again.', 'danger')
      },
      done(item) {
        const api = datesApi()
        if (!api) return
        api.complete(item.id).then(
          (next) => {
            if (!next) return say('That date is no longer on the list.', 'danger')
            if (next.done) say(`“${item.title}” is done.`)
            else say(`Done. The next “${item.title}” is ${dayLabel(next.date)} — ${humanWhen(next, today)}.`)
            setOpenId(next.done ? null : next.id)
          },
          (err: unknown) => say(plainError(err), 'danger')
        )
      },
      snooze(item, until) {
        const api = datesApi()
        if (!api) return
        api.snooze(item.id, until).then(
          (next) => {
            if (!next) return say('That date is no longer on the list.', 'danger')
            say(`Snoozed. No reminders for “${item.title}” before ${dayLabel(until)}.`)
          },
          (err: unknown) => say(plainError(err), 'danger')
        )
      },
      edit(item) {
        lastFocus.current = document.activeElement as HTMLElement | null
        setForm({ item })
      },
      remove(item) {
        const api = datesApi()
        if (!api) return
        api.remove(item.id).then(
          (gone) => {
            say(gone ? `Deleted “${item.title}”.` : 'That date was already gone.')
            setOpenId(null)
          },
          (err: unknown) => say(plainError(err), 'danger')
        )
      }
    }),
    [actions, say, today]
  )

  const openAdd = (): void => {
    lastFocus.current = document.activeElement as HTMLElement | null
    setForm({ item: null })
  }

  const closeForm = (): void => {
    setForm(null)
    const back = lastFocus.current
    requestAnimationFrame(() => (back && back.isConnected ? back : addRef.current)?.focus())
  }

  /** Bring one line into view (clearing the filters that might hide it) and focus it; `expand` opens it too. */
  const reveal = (id: string, expand = true): void => {
    setKind(null)
    setGroup(null)
    if (expand) setOpenId(id)
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`#date-${CSS.escape(id)}`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.querySelector<HTMLElement>('.dline__hit')?.focus({ preventScroll: true })
    })
  }

  /* -------------------------------------------------------------- render */

  if (missing) {
    return (
      <div className="dates" data-active={active ? 'true' : undefined}>
        <div className="dates__solo">
          <EmptyPlate title="Restart Forge to use Dates" body="This Forge started before Dates was added, so it cannot read the list yet. Quit Forge and start it again." />
        </div>
      </div>
    )
  }

  const loading = items === null
  const empty = !loading && all.length === 0

  return (
    <div className="dates" data-active={active ? 'true' : undefined}>
      <aside className="dates__side" aria-label="Dates summary and filters">
        <div className="dates__sidescroll">
          <div className="dates__brand">
            <CalendarIcon size={14} />
            <span>Dates</span>
          </div>
          {loading ? null : <Summary items={all} open={open} today={today} empty={empty} onReveal={reveal} />}
          <button ref={addRef} type="button" className="dbtn dates__add" data-tone="go" onClick={openAdd}>
            <Icon name="plus" size={14} />
            Add a date
          </button>

          {!empty && groups.length > 1 ? (
            <FilterList
              label="Business"
              all="Every business"
              allCount={open.length}
              options={groups}
              value={group}
              onChange={setGroup}
            />
          ) : null}
          {!empty && kinds.length > 1 ? (
            <FilterList
              label="Kind"
              all="Every kind"
              allCount={open.length}
              options={kinds.map((k) => ({ id: k.id, label: k.label, count: k.count }))}
              value={kind}
              onChange={(v) => setKind(v as DateKind | null)}
            />
          ) : null}
        </div>
      </aside>

      <section className="dates__page" aria-label="Dates">
        {empty ? (
          <div className="dates__solo">
            <EmptyPlate
              title="No dates yet"
              body="Put the dates that matter here — a lease that ends, insurance that renews, a web domain that runs out, a form that is due. Forge reminds you before each one, here and on your phone."
              action={
                <button type="button" className="dbtn dbtn--solid" onClick={openAdd}>
                  <Icon name="plus" size={14} />
                  Add your first date
                </button>
              }
              hint="A title and a day are enough. Or ask an agent: “add a date — van insurance renews on 14 March”."
            />
          </div>
        ) : (
          <>
            {!loading ? <Ribbon items={shown} today={today} onPick={reveal} /> : null}
            <div className="dates__scroll" ref={scrollRef}>
              {filtered ? (
                <div className="dates__filtered">
                  <span>
                    Showing {[group !== null ? groups.find((g) => g.id === group)?.label : null, kind !== null ? kinds.find((k) => k.id === kind)?.label : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <button
                    type="button"
                    className="dlink"
                    onClick={() => {
                      setKind(null)
                      setGroup(null)
                    }}
                  >
                    Show everything
                  </button>
                </div>
              ) : null}
              {!loading && buckets.length === 0 ? <p className="dates__none">Nothing here with these filters.</p> : null}
              {buckets.map((b) => {
                const isDone = b.key === 'done'
                const folded = isDone && !showDone
                return (
                  <section key={b.key} className="dbucket" data-bucket={b.key} aria-label={b.label}>
                    <h3 className="dbucket__head">
                      {isDone ? (
                        <button type="button" className="dbucket__fold" aria-expanded={!folded} onClick={() => setShowDone((v) => !v)}>
                          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} />
                          {b.label}
                          <span className="dbucket__count">{b.items.length}</span>
                        </button>
                      ) : (
                        <>
                          <span>{b.label}</span>
                          <span className="dbucket__count">{b.items.length}</span>
                        </>
                      )}
                    </h3>
                    {folded ? null : (
                      <ul className="dbucket__lines">
                        {b.items.map((item) => (
                          <DateLine
                            key={item.id}
                            item={item}
                            today={today}
                            open={openId === item.id}
                            onToggle={() => setOpenId((id) => (id === item.id ? null : item.id))}
                            act={act}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </section>

      <div className="dates__notice" role="status" aria-live="polite">
        {notice ? (
          <div key={notice.id} className="dnotice" data-tone={notice.tone}>
            <span>{notice.text}</span>
            <button type="button" className="dnotice__x" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ) : null}
      </div>

      {form ? (
        <DateForm
          initial={form.item}
          groups={groups.filter((g) => g.id !== NO_GROUP).map((g) => g.id)}
          onClose={closeForm}
          onSaved={(item, added) => {
            closeForm()
            say(added ? `Added “${item.title}” — ${whenWords(item, today)}.` : `Saved “${item.title}”.`)
            if (added) requestAnimationFrame(() => reveal(item.id, false))
            else setOpenId(item.id)
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- summary */

/**
 * The snapshot, in one sentence: how many need Steve this week, and the
 * breakdown — or, when nothing is close, "All clear" and what comes next.
 */
function Summary({
  items,
  open,
  today,
  empty,
  onReveal
}: {
  items: DateItem[]
  open: DateItem[]
  today: string
  empty: boolean
  onReveal: (id: string) => void
}): ReactNode {
  if (empty) {
    return (
      <div className="dsum" data-tone="calm">
        <p className="dsum__big">Nothing yet</p>
        <p className="dsum__line">Your renewals and deadlines will gather here.</p>
      </div>
    )
  }
  const count = attentionCount(items, today)
  const late = open.filter((i) => nearnessOf(i, today) === 'late').length
  const now = open.filter((i) => nearnessOf(i, today) === 'today').length
  const week = count - late - now
  const next = sortItems(open, today).find((i) => nearnessOf(i, today) === 'calm') ?? null
  const done = items.length - open.length

  return (
    <div className="dsum" data-tone={late > 0 ? 'late' : count > 0 ? 'near' : 'calm'}>
      {count > 0 ? (
        <>
          <p className="dsum__big">
            <span className="dsum__num">{count}</span>
            <span className="dsum__words">{count === 1 ? 'needs you' : 'need you'} this week</span>
          </p>
          <ul className="dsum__break">
            {late > 0 ? <li data-near="late">{late} overdue</li> : null}
            {now > 0 ? <li data-near="today">{now} today</li> : null}
            {week > 0 ? <li data-near="week">{week} in the next 7 days</li> : null}
          </ul>
        </>
      ) : (
        <>
          <p className="dsum__big">All clear</p>
          <p className="dsum__line">Nothing in the next 7 days.</p>
        </>
      )}
      {next ? (
        <button type="button" className="dsum__next" onClick={() => onReveal(next.id)}>
          <span className="dsum__nextlabel">{count > 0 ? 'After that' : 'Next up'}</span>
          <span className="dsum__nexttitle">{next.title}</span>
          <span className="dsum__nextwhen">{whenWords(next, today)}</span>
        </button>
      ) : null}
      <p className="dsum__tally">
        {open.length} open{done > 0 ? ` · ${done} done` : ''}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- filters */

function FilterList({
  label,
  all,
  allCount,
  options,
  value,
  onChange
}: {
  label: string
  all: string
  allCount: number
  options: { id: string; label: string; count: number }[]
  value: string | null
  onChange: (value: string | null) => void
}): ReactNode {
  return (
    <div className="dfilter" role="group" aria-label={label}>
      <div className="dfilter__head">{label}</div>
      <button type="button" className="dfilter__opt" aria-pressed={value === null} onClick={() => onChange(null)}>
        <span className="dfilter__name">{all}</span>
        <span className="dfilter__count">{allCount}</span>
      </button>
      {options.map((o) => (
        <button key={o.id} type="button" className="dfilter__opt" aria-pressed={value === o.id} onClick={() => onChange(value === o.id ? null : o.id)}>
          <span className="dfilter__name">{o.label}</span>
          <span className="dfilter__count">{o.count}</span>
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------- ribbon */

/**
 * The next six months as one strip: today at the left edge, a tick at the
 * start of each month, every open date a dot where it falls. Late ones gather
 * in a small red pen left of today; the ones past six months are a count at the
 * right end. It is a picture for the eye — the list below is the way in for the
 * keyboard — so a click on a dot simply opens that line.
 */
function Ribbon({ items, today, onPick }: { items: DateItem[]; today: string; onPick: (id: string) => void }): ReactNode {
  const open = items.filter((i) => statusOf(i, today) !== 'done')
  const late = open.filter((i) => nearnessOf(i, today) === 'late')
  const later = open.filter((i) => daysLeft(i, today) > RIBBON_DAYS && nearnessOf(i, today) !== 'today')
  const inside = sortItems(
    open.filter((i) => !late.includes(i) && !later.includes(i)),
    today
  )

  // Dots that would sit on top of each other stack upwards instead.
  const lanes = new Map<number, number>()
  const dots = inside.map((item) => {
    const d = Math.max(0, daysLeft(item, today))
    const slot = Math.round((d / RIBBON_DAYS) * 90)
    const lane = lanes.get(slot) ?? 0
    lanes.set(slot, lane + 1)
    return { item, x: (d / RIBBON_DAYS) * 100, lane: Math.min(lane, 3) }
  })

  // The first of each month inside the window, as a tick and a short name.
  const months: { x: number; label: string }[] = []
  const [y0, m0] = today.split('-').map(Number) as [number, number]
  for (let k = 1; k <= 7; k++) {
    const index = y0 * 12 + (m0 - 1) + k
    const first = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`
    const d = daysLeft({ date: first }, today)
    if (d > RIBBON_DAYS) break
    const [, , mon = ''] = dayLabel(first).split(' ')
    months.push({ x: (d / RIBBON_DAYS) * 100, label: index % 12 === 0 ? `${mon} ${Math.floor(index / 12)}` : mon })
  }

  return (
    <div className="dribbon" aria-hidden="true">
      <div className="dribbon__pen" data-count={late.length}>
        {late.slice(0, 6).map((item, i) => (
          <span key={item.id} className="dribbon__dot" data-near="late" style={{ left: `${28 + (i % 3) * 22}%`, bottom: `calc(var(--rib-base) + ${4 + Math.floor(i / 3) * 9}px)` }} title={`${item.title} — ${whenWords(item, today)}`} onClick={() => onPick(item.id)} />
        ))}
        <span className="dribbon__penlabel">{late.length > 0 ? 'Late' : ''}</span>
      </div>
      <div className="dribbon__track">
        <span className="dribbon__today">
          <span>Today</span>
        </span>
        {months.map((m) => (
          <span key={m.label} className="dribbon__month" style={{ left: `${m.x}%` }}>
            {/* A month that starts in the next few days would sit on "Today": tick only. */}
            {m.x > 4 ? <span>{m.label}</span> : null}
          </span>
        ))}
        {dots.map(({ item, x, lane }) => (
          <span
            key={item.id}
            className="dribbon__dot"
            data-near={nearnessOf(item, today)}
            style={{ left: `${x}%`, bottom: `calc(var(--rib-base) + ${4 + lane * 9}px)` }}
            title={`${item.title} — ${whenWords(item, today)}`}
            onClick={() => onPick(item.id)}
          />
        ))}
      </div>
      <div className="dribbon__later">{later.length > 0 ? `+${later.length} later` : ''}</div>
    </div>
  )
}

/* --------------------------------------------------------------- empty */

/** The house's empty plate (components/EmptyState.css), with the calendar on it. */
function EmptyPlate({ title, body, action, hint }: { title: string; body: string; action?: ReactNode; hint?: string }): ReactNode {
  return (
    <div className="dempty">
      <div className="dempty__plate">
        <CalendarIcon size={24} />
      </div>
      <h2 className="dempty__title">{title}</h2>
      <p className="dempty__body">{body}</p>
      {action ? <div className="dempty__action">{action}</div> : null}
      {hint ? <p className="dempty__hint">{hint}</p> : null}
    </div>
  )
}

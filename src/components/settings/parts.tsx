import { useId, useState, type ReactNode } from 'react'

/**
 * The settings page's furniture. Everything here is deliberately dumb — the
 * sections own all the behaviour — so that a section reads as a list of what it
 * offers rather than a wall of markup.
 */

/* ------------------------------------------------------------------ layout */

export function Section({
  title,
  blurb,
  children
}: {
  title: string
  blurb?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section className="sset" aria-label={title}>
      <header className="sset__head">
        <h2 className="sset__title">{title}</h2>
        {blurb ? <p className="sset__blurb">{blurb}</p> : null}
      </header>
      {children}
    </section>
  )
}

export function Card({
  title,
  hint,
  actions,
  tone = 'plain',
  children
}: {
  title?: string
  hint?: ReactNode
  actions?: ReactNode
  /** `warn` and `danger` wash the card; `quiet` is for placeholders. */
  tone?: 'plain' | 'quiet' | 'warn' | 'danger' | 'accent'
  children?: ReactNode
}): ReactNode {
  return (
    <div className="scard" data-tone={tone}>
      {title || actions ? (
        <div className="scard__head">
          {title ? <h3 className="scard__title">{title}</h3> : null}
          {actions ? <div className="scard__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
      {hint ? <p className="scard__hint">{hint}</p> : null}
    </div>
  )
}

/** A label on the left, a control on the right. The page's basic unit. */
export function Row({
  label,
  hint,
  htmlFor,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="srow">
      <div className="srow__text">
        {htmlFor ? (
          <label className="srow__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="srow__label">{label}</span>
        )}
        {hint ? <span className="srow__hint">{hint}</span> : null}
      </div>
      <div className="srow__control">{children}</div>
    </div>
  )
}

/* ----------------------------------------------------------------- controls */

/**
 * `disabled` is for a switch whose *on* position would not mean anything — the
 * one that has it today is Forge Web's "let a browser drive this desk", which
 * the desktop refuses outright until one of the two escalation locks is on. A
 * switch somebody can flip to a state the desktop then ignores is worse than no
 * switch: it reads as a granted permission. The row's hint says why, because a
 * greyed control with no sentence beside it is a puzzle rather than an answer.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-on={checked ? 'true' : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  )
}

export function Stepper({
  value,
  display,
  onChange,
  min,
  max,
  step = 1,
  label
}: {
  value: number
  display?: string
  onChange: (next: number) => void
  min: number
  max: number
  step?: number
  label: string
}): ReactNode {
  return (
    <div className="stepper">
      <button
        type="button"
        className="ghost-btn stepper__btn"
        aria-label={`${label} — less`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </button>
      <span className="stepper__value mono">{display ?? value}</span>
      <button
        type="button"
        className="ghost-btn stepper__btn"
        aria-label={`${label} — more`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </button>
    </div>
  )
}

/**
 * A text field that commits on blur and on Enter, and keeps its keystrokes to
 * itself — the global shortcut map is in the capture phase and would otherwise
 * read a typed "w" as close-pane.
 */
export function TextField({
  id,
  value,
  onCommit,
  placeholder,
  mono,
  password,
  spellCheck = false,
  disabled
}: {
  id?: string
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  mono?: boolean
  password?: boolean
  spellCheck?: boolean
  disabled?: boolean
}): ReactNode {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  // While the field is not being edited it tracks the store, so an import
  // button or a reset elsewhere shows up here immediately.
  const shown = editing ? draft : value

  return (
    <input
      id={id}
      className={`field__input${mono ? ' mono' : ''}`}
      type={password ? 'password' : 'text'}
      autoComplete="off"
      spellCheck={spellCheck}
      placeholder={placeholder}
      disabled={disabled}
      value={shown}
      onFocus={() => {
        setDraft(value)
        setEditing(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * An API-key field: masked by default, revealable, and always accompanied by
 * the truth about what is actually stored — a password dot pattern tells you
 * nothing about whether the key you pasted last week survived.
 */
export function KeyField({
  label,
  value,
  onCommit,
  placeholder,
  note,
  actions
}: {
  label: string
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  note?: ReactNode
  actions?: ReactNode
}): ReactNode {
  const [reveal, setReveal] = useState(false)
  const id = useId()

  return (
    <div className="skey">
      <div className="skey__top">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <span className="skey__state mono">{value ? maskKey(value) : 'not set'}</span>
      </div>
      <div className="skey__row">
        <TextField id={id} value={value} onCommit={onCommit} placeholder={placeholder} mono password={!reveal} />
        <button
          type="button"
          className="ghost-btn skey__toggle"
          onClick={() => setReveal((v) => !v)}
          title={reveal ? 'Hide' : 'Show'}
        >
          {reveal ? 'hide' : 'show'}
        </button>
      </div>
      {actions ? <div className="skey__actions">{actions}</div> : null}
      {note ? <p className="scard__hint">{note}</p> : null}
    </div>
  )
}

/** `AIza…4f7c` — enough to recognise a key by, not enough to use one. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return 'not set'
  if (k.length <= 8) return `••••${k.slice(-2)}`
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

/* -------------------------------------------------------------------- chips */

export type ChipTone = 'ok' | 'warn' | 'off' | 'soon' | 'danger'

export function StateChip({ tone, children }: { tone: ChipTone; children: ReactNode }): ReactNode {
  return (
    <span className="schip" data-tone={tone}>
      <span className="schip__dot" />
      {children}
    </span>
  )
}

/** A colour picker that is a row of swatches, plus the OS one for anything else. */
export function ColorPicker({
  value,
  onChange,
  palette,
  label
}: {
  value: string
  onChange: (next: string) => void
  palette: string[]
  label: string
}): ReactNode {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          className="swatch"
          aria-label={`${label}: ${c}`}
          data-selected={c.toLowerCase() === value.toLowerCase() ? 'true' : undefined}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch swatch--custom" title="Custom colour">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#c6ff4a'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label}: custom`}
        />
      </label>
    </div>
  )
}

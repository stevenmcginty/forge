import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import './BottomSheet.css'

/**
 * The phone's one menu shape: a sheet that rises from the bottom edge.
 *
 * Every menu on the phone is one of these, so the motion, the rows and the way
 * out are learned once — a grab handle, 56px rows (icon, label, an optional
 * second line), a scrim that closes it, Esc that closes it, and a drag down
 * that closes it. At desktop width the same component draws as a centred
 * panel, because a sheet pinned to the bottom of a 1440px window is a strip
 * nobody looks at.
 *
 * Portalled into `.app` rather than `<body>`, so the phone tokens (which are
 * scoped to `.app[data-mobile]`) and the theme reach it; the layer also carries
 * `.bsheet-layer`, which re-declares the tokens for the desktop-width panel.
 *
 * ## Back
 *
 * Every open sheet sits on a stack, and `closeTopSheet()` pops the newest one
 * the way Esc does — through its `onBack` when it has one (a sheet showing a
 * confirm step steps back to its list), through `onClose` otherwise. That is
 * the whole of the Android Back contract: a later change pushes a history entry
 * while `openSheetCount() > 0` and calls `closeTopSheet()` on `popstate`.
 */

interface SheetEntry {
  back: () => void
}

const stack: SheetEntry[] = []

/** Close (or step back in) the most recently opened sheet. False when none is open. */
export function closeTopSheet(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.back()
  return true
}

/** How many sheets are open right now. */
export function openSheetCount(): number {
  return stack.length
}

/** How long the exit animation runs before the sheet unmounts. Matches `--p-dur-sheet`'s exit. */
const EXIT_MS = 220
/** A drag further than this, or a flick faster than FLICK, closes the sheet. */
const DRAG_CLOSE_PX = 96
const FLICK_PX_PER_MS = 0.55

function appLayer(): HTMLElement {
  return (document.querySelector('.app[data-shell="app"]') as HTMLElement | null) ?? document.body
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function BottomSheet({
  open,
  onClose,
  onBack,
  label,
  title,
  subtitle,
  children,
  testId
}: {
  open: boolean
  onClose: () => void
  /** Esc and Android Back. Defaults to `onClose`; a multi-step sheet steps back instead. */
  onBack?: () => void
  /** The accessible name. Drawn as the heading too, unless `title` says otherwise. */
  label: string
  /** The visible heading. `null` draws none (the label still names the dialog). */
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  testId?: string
}): ReactNode {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const headingId = useId()

  // The latest handlers, for the stack entry and the key handler, without
  // re-registering on every render.
  const backRef = useRef<() => void>(onBack ?? onClose)
  backRef.current = onBack ?? onClose
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement
      setMounted(true)
      // Two frames: one to mount at the resting (hidden) position, one to move.
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  // On the stack while open, so Back closes the newest sheet first.
  useEffect(() => {
    if (!open) return
    const entry: SheetEntry = { back: () => backRef.current() }
    stack.push(entry)
    // Esc from anywhere, not only from inside the panel: a step that unmounts
    // the focused button (a confirm answered with Cancel) drops focus to <body>.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== entry) return
      e.preventDefault()
      entry.back()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const at = stack.indexOf(entry)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [open])

  // Focus moves into the sheet when it opens and back to whatever opened it
  // when it goes — without scrolling, and only if that thing is still there.
  useLayoutEffect(() => {
    if (!shown) return
    panelRef.current?.focus({ preventScroll: true })
  }, [shown])

  // A step inside the sheet (list → confirm → list) can unmount the focused
  // control; focus comes back to the panel rather than falling out to <body>.
  useEffect(() => {
    if (!shown) return
    const active = document.activeElement
    if (!active || active === document.body) panelRef.current?.focus({ preventScroll: true })
  }, [label, shown])

  useEffect(() => {
    if (mounted) return
    const opener = openerRef.current
    openerRef.current = null
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
  }, [mounted])

  const scrimArmed = useRef(false)

  /* ---------------------------------------------------------- drag to close */
  const [drag, setDrag] = useState(0)
  const dragRef = useRef<{ id: number; y: number; t: number; dy: number } | null>(null)

  const onDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // The desktop-width panel is centred, not docked: there is no edge to drag it to.
    if (e.button !== 0 || !e.currentTarget.closest('.app[data-mobile]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const now = performance.now()
    dragRef.current = { id: e.pointerId, y: e.clientY, t: now, dy: 0 }
  }, [])

  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const dy = Math.max(0, e.clientY - d.y)
    d.dy = dy
    setDrag(dy)
  }, [])

  const onDragEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    const elapsed = Math.max(1, performance.now() - d.t)
    const speed = d.dy / elapsed
    if (d.dy > DRAG_CLOSE_PX || (d.dy > 24 && speed > FLICK_PX_PER_MS)) closeRef.current()
    setDrag(0)
  }, [])

  /* ------------------------------------------------------------- keys */
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      backRef.current()
      return
    }
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (items.length === 0) {
      e.preventDefault()
      panel.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  if (!mounted) return null

  const heading = title === undefined ? label : title

  return createPortal(
    <div
      className="bsheet-layer"
      data-state={shown ? 'open' : 'closed'}
      data-dragging={drag > 0 ? 'true' : undefined}
      data-testid={testId}
    >
      <div
        className="bsheet__scrim"
        // Only a press that *starts* on the scrim closes the sheet. The finger
        // that opened it (a long-press on a tab) lifts over the scrim, and that
        // lift must not close what it has just opened.
        onPointerDown={() => {
          scrimArmed.current = true
        }}
        onClick={() => {
          if (scrimArmed.current) closeRef.current()
          scrimArmed.current = false
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="bsheet"
        role="dialog"
        aria-modal="true"
        aria-label={heading ? undefined : label}
        aria-labelledby={heading ? headingId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
      >
        <div
          className="bsheet__grab"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <span className="bsheet__handle" aria-hidden="true" />
          {heading ? (
            <div className="bsheet__head">
              <h2 id={headingId} className="bsheet__title">
                {heading}
              </h2>
              {subtitle ? <p className="bsheet__sub">{subtitle}</p> : null}
            </div>
          ) : null}
        </div>
        <div className="bsheet__body">{children}</div>
      </div>
    </div>,
    appLayer()
  )
}

/* ------------------------------------------------------------------ rows */

/**
 * One 56px row: icon, label, an optional second line, an optional trailing
 * control. A button when it has `onClick`, a link when it has `href`, a plain
 * row when it has neither (its trailing slot then holds the controls, as the
 * text-size stepper does).
 */
export function SheetRow({
  icon,
  label,
  secondary,
  trailing,
  onClick,
  href,
  disabled,
  tone,
  role,
  checked,
  testId
}: {
  icon?: ReactNode
  label: ReactNode
  secondary?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
  /** `danger` draws the label in red — always beside words that say what it destroys. */
  tone?: 'danger'
  /** `switch` for a toggle row; pair it with `checked`. */
  role?: 'switch'
  checked?: boolean
  testId?: string
}): ReactNode {
  const inner = (
    <>
      {icon ? <span className="bsrow__icon">{icon}</span> : null}
      <span className="bsrow__text">
        <span className="bsrow__label">{label}</span>
        {secondary ? <span className="bsrow__sub">{secondary}</span> : null}
      </span>
      {trailing ? <span className="bsrow__trail">{trailing}</span> : null}
    </>
  )
  if (href) {
    return (
      <a className="bsrow" data-tone={tone} href={href} rel="noopener" data-testid={testId}>
        {inner}
      </a>
    )
  }
  if (onClick) {
    return (
      <button
        type="button"
        className="bsrow"
        data-tone={tone}
        disabled={disabled}
        role={role}
        aria-checked={role === 'switch' ? !!checked : undefined}
        onClick={onClick}
        data-testid={testId}
      >
        {inner}
      </button>
    )
  }
  return (
    <div className="bsrow" data-static="true" data-tone={tone} aria-disabled={disabled || undefined} data-testid={testId}>
      {inner}
    </div>
  )
}

/** A group of rows under a quiet sentence-case label. */
export function SheetSection({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  return (
    <div className="bssec" role="group" aria-label={title}>
      {title ? <div className="bssec__title">{title}</div> : null}
      {children}
    </div>
  )
}

/** A drawn switch for a `role="switch"` row. The knob's side and the row's words carry the state. */
export function SheetSwitch({ on }: { on: boolean }): ReactNode {
  return (
    <span className="bsswitch" data-on={on ? 'true' : 'false'} aria-hidden="true">
      <span className="bsswitch__knob" />
    </span>
  )
}

/**
 * The confirm step a destructive row opens in place: a question, one line on
 * what it costs, and two full-width buttons. The safe answer takes focus.
 */
export function SheetConfirm({
  question,
  detail,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  testId
}: {
  question: ReactNode
  detail?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  testId?: string
}): ReactNode {
  return (
    <div className="bsconfirm" data-testid={testId}>
      <p className="bsconfirm__q">{question}</p>
      {detail ? <p className="bsconfirm__detail">{detail}</p> : null}
      <div className="bsconfirm__actions">
        <button type="button" className="bsbtn" autoFocus onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="bsbtn" data-tone="danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- glyphs */

export type SheetGlyphName = 'bell' | 'signOut' | 'textSize' | 'handoff' | 'autoStop' | 'link'

/**
 * The few glyphs the phone's sheets need that the desktop's icon set does not
 * have. Same grid (16×16) and stroke (1.4) as `@/components/Icon`, so the two
 * sets read as one family.
 */
const GLYPHS: Record<SheetGlyphName, ReactNode> = {
  bell: (
    <>
      <path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.4H2.8z" />
      <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
    </>
  ),
  signOut: (
    <>
      <path d="M9.4 3H4.2A1.2 1.2 0 0 0 3 4.2v7.6A1.2 1.2 0 0 0 4.2 13h5.2" />
      <path d="M7 8h6.6M11.2 5.4 13.8 8l-2.6 2.6" />
    </>
  ),
  textSize: (
    <>
      <path d="M1.8 12.8 5.4 3.6 9 12.8M3 9.8h4.8" />
      <path d="M10 12.8l2.1-5.4 2.1 5.4M10.7 11h2.8" />
    </>
  ),
  handoff: (
    <>
      <rect x="1.8" y="4" width="7.4" height="8" rx="1.6" />
      <path d="M6.4 8h7.6M11.4 5.4 14 8l-2.6 2.6" />
    </>
  ),
  autoStop: (
    <>
      <rect x="3.6" y="1.8" width="4" height="7" rx="2" />
      <path d="M1.8 7.2a3.8 3.8 0 0 0 7.6 0M5.6 11v2.8" />
      <path d="M11.8 9.4v4.4M14.2 9.4v4.4" />
    </>
  ),
  link: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.2 11.8a5.4 5.4 0 0 1 0-7.6M11.8 4.2a5.4 5.4 0 0 1 0 7.6" />
    </>
  )
}

export function SheetGlyph({ name, size = 20 }: { name: SheetGlyphName; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}

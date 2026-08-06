import { useRef, type PointerEvent, type ReactNode } from 'react'
import { RAIL_SECTION_DEFAULT_H } from '@shared/rail'
import type { RailSectionId } from '@shared/types'
import { clampSectionHeight } from '@shared/rail'
import { isOpen, sectionHeight, toggleOpen } from '@/lib/railstack'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import './RailSection.css'

/**
 * One section of the left rail: a header you can always see, and a body you can
 * open, close and drag taller.
 *
 * This is the chrome the rail's four sections used to each own a slightly
 * different version of. The project list had a `.rail__head` with a count and
 * two buttons; the tasks dock had a `.tray__head` with a count, a signal, three
 * buttons, a local `minimized` flag and a grow handle whose height lived in
 * localStorage. Both were reasonable on their own and neither could be reused,
 * which is how you end up with four headers that disagree about where the count
 * sits.
 *
 * So the header, the chevron, the count chip, the actions slot and the drag
 * handle live here once, and open/closed and height live in Settings alongside
 * every other piece of rail furniture — which means they ride the store's
 * existing debounced persist effect and there is no second persistence path to
 * keep honest.
 *
 * **A closed section is exactly its header.** That is the invariant the whole
 * stack rests on: however the heights below are dragged, every header stays
 * reachable without scrolling, so there is no arrangement of four sections that
 * loses one of them off the bottom.
 */
export function RailSection({
  id,
  title,
  count,
  hint,
  actions,
  status,
  growable = true,
  children
}: {
  id: RailSectionId
  title: string
  /** Shown as the header's chip. Null or 0 shows nothing — an empty section is quiet. */
  count?: number | null
  /** The header's `title` attribute. Says what the section is for, not what it says. */
  hint?: string
  /** Buttons pinned to the right of the header. Clicks here never toggle the section. */
  actions?: ReactNode
  /** A small live signal between the title and the actions — "planning", a branch name. */
  status?: ReactNode
  /**
   * False for a section whose body sizes itself. Projects is the only one: it
   * takes the rail's slack, so there is no height for a handle to drag.
   */
  growable?: boolean
  children: ReactNode
}): ReactNode {
  const { state, actions: appActions } = useApp()
  const open = isOpen(state.settings, id)
  const height = sectionHeight(state.settings, id, window.innerHeight)

  /*
   * The drag in flight. A ref rather than state because a pointermove that
   * re-rendered the whole rail on every frame would be paid for by every
   * terminal in the grid — the same reason src/lib/hubdrag.ts exists.
   */
  const grow = useRef<{ pointerId: number; y: number; h: number } | null>(null)

  const onGrowDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!open || height === null) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    grow.current = { pointerId: e.pointerId, y: e.clientY, h: height }
  }

  const onGrowMove = (e: PointerEvent<HTMLDivElement>): void => {
    const g = grow.current
    if (!g || g.pointerId !== e.pointerId) return
    // Sections grow upward: dragging the handle up makes the body taller. That
    // is the direction the tasks dock has always grown, and the sections below
    // it inherit the gesture rather than reversing it halfway down the rail.
    const next = clampSectionHeight(g.h + (g.y - e.clientY), window.innerHeight)
    appActions.setRailHeight(id, next)
  }

  const onGrowUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!grow.current || grow.current.pointerId !== e.pointerId) return
    grow.current = null
  }

  const toggle = (): void =>
    appActions.patchSettings({ railOpen: toggleOpen(state.settings.railOpen, id) })

  return (
    <section
      className="rsec"
      data-id={id}
      data-open={open ? 'true' : undefined}
      aria-label={title}
      style={height !== null ? ({ '--rsec-h': `${height}px` } as React.CSSProperties) : undefined}
    >
      {/*
        Only an open, growable section gets a handle. On a closed one there is
        nothing to resize, and leaving a live 5px grab strip on top of a 28px
        header would make the header itself hard to click.
      */}
      {open && growable && height !== null ? (
        <div
          className="rsec__grow"
          role="separator"
          aria-orientation="horizontal"
          title={`Drag to resize ${title}`}
          onPointerDown={onGrowDown}
          onPointerMove={onGrowMove}
          onPointerUp={onGrowUp}
          onPointerCancel={onGrowUp}
        />
      ) : null}

      <header className="rsec__head">
        <button
          type="button"
          className="rsec__toggle"
          aria-expanded={open}
          title={hint ?? `${open ? 'Collapse' : 'Expand'} ${title}`}
          onClick={toggle}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="rsec__chev" />
          <span className="eyebrow rsec__title">{title}</span>
          {typeof count === 'number' && count > 0 ? (
            <span className="rsec__count mono">{count}</span>
          ) : null}
        </button>

        {status ? <div className="rsec__status">{status}</div> : null}

        {/*
          Outside the toggle button rather than inside it: a <button> inside a
          <button> is invalid HTML and, more to the point, clicking "add project"
          should not also collapse the list you are adding to.
        */}
        {actions ? <div className="rsec__actions">{actions}</div> : null}
      </header>

      {open ? <div className="rsec__body">{children}</div> : null}
    </section>
  )
}

/** The height a section falls back to before it has ever been dragged. */
export { RAIL_SECTION_DEFAULT_H }

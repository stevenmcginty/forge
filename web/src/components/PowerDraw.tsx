import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { sortProjectsForPicker } from '@shared/project-order'
import type { Project } from '@shared/types'
import { collectLeaves } from '@/lib/splitTree'
import { Icon } from '@/components/Icon'
import { useBackClose } from '../lib/back-stack'
import { shortPath } from '../lib/paths'
import { useForge } from '../state'
import { openSheetCount } from './BottomSheet'
import './PowerDraw.css'

/**
 * PowerDraw: the phone's one-hand project switcher.
 *
 * A slim pill on the right edge, halfway up. A tap on it, or a pull to the
 * left, slides in a drum of projects from the right. The row in the middle is
 * the chosen one: full size, with its path, its panes and "! Asking" when a pane
 * there waits. The rows above and below shrink and fade as they leave the
 * middle. A tap on the middle row opens that project and puts the drum away;
 * that is the only way it opens one. A tap on any other row only glides it to
 * the middle.
 *
 * The ☰ and its project sheet stay as they are; this is the thumb's way in.
 *
 * The shrink is driven by the scroll, not by React: a rAF-throttled scroll
 * handler writes one number (`--d`, rows from the middle) on each row near the
 * view, and the CSS turns it into scale and opacity. React re-renders only
 * when the middle row changes.
 */

/** One row in the drum. Worked out from the picture by `PowerDraw`; fixtures in the preview. */
export interface DrumProject {
  id: string
  name: string
  path: string
  color: string
  panes: number
  /** A pane here is waiting on an answer. */
  asking: boolean
}

/** Row pitch in px. PowerDraw.css reads it as `--pdraw-row`; keep the two equal. */
const ROW_PX = 76
/** Rows further than this from the middle are drawn fully shrunk and are not updated per frame. */
const FAR = 3
/** Matches the exit transition in PowerDraw.css (`--p-dur-sheet`). */
const EXIT_MS = 280
/** A pull this far to the left on the handle opens the drum; this far right on the panel closes it. */
const PULL_OPEN_PX = 24
const DRAG_CLOSE_PX = 80
const FLICK_PX_PER_MS = 0.5
/** The keyboard is up when the visible window is this much shorter than its tallest at this width. */
const KEYBOARD_PX = 120

/* ------------------------------------------------------------ the wiring */

/**
 * The drum wired to Forge: projects live or cached (so it still works with the
 * desktop asleep), in the order every other picker uses.
 */
export function PowerDraw({
  open,
  onOpen,
  onClose,
  hidden
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The project sheet or the screen mirror is up: no handle. */
  hidden: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  const workspaces = state.picture?.workspaces ?? state.cached?.workspaces ?? {}
  const sessions = state.picture?.sessions ?? state.cached?.sessions ?? []

  const leavesOf = (project: Project): string[] =>
    (workspaces[project.id]?.tabs ?? []).flatMap((tab) => collectLeaves(tab.root).map((leaf) => leaf.id))

  const ordered = sortProjectsForPicker(projects, (project) => {
    const leaves = leavesOf(project)
    return {
      active: project.id === state.projectId,
      working: leaves.some((id) => {
        if (state.asking.has(id) || state.busy.has(id)) return true
        const fm = state.picture?.foreman?.[id]
        return Boolean(fm && (fm.status === 'starting' || fm.status === 'driving' || fm.status === 'waiting'))
      }),
      open: leaves.length > 0,
      pinned: Boolean(project.pinned)
    }
  })

  const drum: DrumProject[] = ordered.map((project) => {
    const leaves = new Set(leavesOf(project))
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      color: project.color,
      panes: sessions.filter((s) => leaves.has(s.id)).length,
      asking: [...leaves].some((id) => state.asking.has(id))
    }
  })

  const select = useCallback(
    (id: string) => {
      actions.selectProject(id)
      onClose()
    },
    [actions, onClose]
  )

  return (
    <PowerDrawView
      projects={drum}
      currentId={state.projectId}
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      onSelect={select}
      hidden={hidden}
    />
  )
}

/* ------------------------------------------------------------ the view */

export function PowerDrawView({
  projects,
  currentId,
  open,
  onOpen,
  onClose,
  onSelect,
  hidden = false
}: {
  projects: DrumProject[]
  currentId: string | null
  open: boolean
  onOpen: () => void
  onClose: () => void
  onSelect: (projectId: string) => void
  hidden?: boolean
}): ReactNode {
  const keyboardUp = useKeyboardUp()
  const sheetUp = useBottomSheetUp()
  const fullscreen = useDocumentFullscreen()
  const handleHidden = hidden || open || keyboardUp || sheetUp || fullscreen
  const othersAsking = projects.some((p) => p.asking && p.id !== currentId)

  /* ---------------------------------------------------------- open / close */

  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const wheelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement
      setMounted(true)
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

  useEffect(() => {
    if (mounted) return
    const opener = openerRef.current
    openerRef.current = null
    const active = document.activeElement
    if ((!active || active === document.body) && opener instanceof HTMLElement && opener.isConnected) {
      opener.focus({ preventScroll: true })
    }
  }, [mounted])

  useBackClose(open, onClose)

  /* ---------------------------------------------------------- the drum */

  const rowsRef = useRef<(HTMLButtonElement | null)[]>([])
  /** The `--d` last written per row, so a still row is not written again. */
  const lastD = useRef<number[]>([])
  const frame = useRef(0)
  /** The middle row, as the scroll handler last saw it. */
  const centreRef = useRef(-1)
  /** Positioning on open is not a person turning the drum: no tick for it. */
  const quiet = useRef(true)
  const [centre, setCentre] = useState(-1)

  const count = projects.length
  const indexAt = (scrollTop: number): number =>
    count === 0 ? -1 : Math.max(0, Math.min(count - 1, Math.round(scrollTop / ROW_PX)))

  /** Write each nearby row's distance from the middle, and note the middle row. */
  const paint = useCallback(() => {
    frame.current = 0
    const wheel = wheelRef.current
    if (!wheel) return
    const top = wheel.scrollTop
    const at = top / ROW_PX
    const rows = rowsRef.current
    const seen = lastD.current
    for (let i = 0; i < count; i += 1) {
      const el = rows[i]
      if (!el) continue
      const d = Math.min(FAR, Math.abs(i - at))
      const rounded = Math.round(d * 1000) / 1000
      if (seen[i] === rounded) continue
      seen[i] = rounded
      el.style.setProperty('--d', String(rounded))
    }
    const next = count === 0 ? -1 : Math.max(0, Math.min(count - 1, Math.round(at)))
    if (next !== centreRef.current) {
      const had = centreRef.current
      centreRef.current = next
      setCentre(next)
      if (had >= 0 && !quiet.current) tick()
    }
  }, [count])

  const onScroll = (): void => {
    quiet.current = false
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // On open, before first paint: straight to the open project. The pads above
  // and below the rows are half the wheel less half a row (PowerDraw.css), so
  // row i sits in the middle at scrollTop i × ROW_PX, and a resize moves nothing.
  useLayoutEffect(() => {
    if (!mounted) return
    const wheel = wheelRef.current
    if (!wheel) return
    quiet.current = true
    centreRef.current = -1
    lastD.current = []
    const start = Math.max(0, projects.findIndex((p) => p.id === currentId))
    wheel.scrollTop = start * ROW_PX
    paint()
    // Only on mount: a list that changes while open keeps its scroll (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  // The list changed under the drum (a project added or removed): redraw the
  // distances for the rows as they now stand.
  const ids = projects.map((p) => p.id).join('\n')
  useLayoutEffect(() => {
    if (!mounted) return
    lastD.current = []
    rowsRef.current.length = count
    paint()
  }, [ids, mounted, count, paint])

  // Focus into the panel once it is on screen: the middle row, or the panel.
  useLayoutEffect(() => {
    if (!shown) return
    const row = rowsRef.current[centreRef.current]
    ;(row ?? panelRef.current)?.focus({ preventScroll: true })
  }, [shown])

  const glideTo = (index: number): void => {
    const wheel = wheelRef.current
    if (!wheel || index < 0 || index >= count) return
    wheel.scrollTo({ top: index * ROW_PX, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  /* ---------------------------------------------------- swipe right to close */

  const [drag, setDrag] = useState(0)
  const dragRef = useRef<{ id: number; x: number; y: number; t: number; dx: number; on: boolean } | null>(null)
  const swallowClick = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== 'touch') return
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, on: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.on) {
      // Only a mostly-sideways pull to the right is a close; anything else
      // turns the drum or is a tap.
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2 || dx < 0) {
        if (Math.abs(dy) > 10) dragRef.current = null
        return
      }
      d.on = true
      d.x = e.clientX
      d.t = performance.now()
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    d.dx = Math.max(0, e.clientX - d.x)
    setDrag(d.dx)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    if (!d.on) return
    swallowClick.current = true
    window.setTimeout(() => (swallowClick.current = false), 0)
    const speed = d.dx / Math.max(1, performance.now() - d.t)
    if (d.dx > DRAG_CLOSE_PX || (d.dx > 24 && speed > FLICK_PX_PER_MS)) onClose()
    setDrag(0)
  }

  /* ---------------------------------------------------------- keys and taps */

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      if (openSheetCount() > 0) return
      e.preventDefault()
      onClose()
      return
    }
    const step =
      e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? -count : e.key === 'End' ? count : 0
    if (!step || count === 0) return
    e.preventDefault()
    const next = Math.max(0, Math.min(count - 1, (centreRef.current < 0 ? 0 : centreRef.current) + step))
    glideTo(next)
    rowsRef.current[next]?.focus({ preventScroll: true })
  }

  /**
   * The middle row opens its project; any other row only comes to the middle.
   * The middle is read from the scroll itself, not from state, so a tap during
   * a glide is judged by where the drum really is.
   */
  const onRow = (index: number): void => {
    if (swallowClick.current) return
    const wheel = wheelRef.current
    if (!wheel) return
    const at = wheel.scrollTop / ROW_PX
    if (indexAt(wheel.scrollTop) === index && Math.abs(at - index) < 0.35) {
      onSelect(projects[index].id)
      return
    }
    glideTo(index)
  }

  /* ---------------------------------------------------------- the handle */

  const pull = useRef<{ id: number; x: number; y: number; opened: boolean } | null>(null)
  const pulled = useRef(false)

  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    pull.current = { id: e.pointerId, x: e.clientX, y: e.clientY, opened: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* a pointer that already ended */
    }
  }
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = pull.current
    if (!p || p.id !== e.pointerId || p.opened) return
    const dx = e.clientX - p.x
    if (dx < -PULL_OPEN_PX && Math.abs(dx) > Math.abs(e.clientY - p.y)) {
      p.opened = true
      pulled.current = true
      window.setTimeout(() => (pulled.current = false), 400)
      onOpen()
    }
  }
  const onHandleEnd = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (pull.current?.id === e.pointerId) pull.current = null
  }

  const panelStyle: CSSProperties | undefined = drag > 0 ? { transform: `translateX(${drag}px)` } : undefined

  return (
    <>
      <button
        type="button"
        className="pdraw-handle"
        data-hidden={handleHidden ? 'true' : undefined}
        data-attention={othersAsking ? 'true' : undefined}
        aria-label={othersAsking ? 'Projects, one is asking' : 'Projects'}
        aria-expanded={open}
        aria-hidden={handleHidden ? true : undefined}
        tabIndex={handleHidden ? -1 : 0}
        onClick={() => {
          if (!pulled.current) onOpen()
        }}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleEnd}
        onPointerCancel={onHandleEnd}
        data-testid="powerdraw-handle"
      >
        <span className="pdraw-handle__pill" aria-hidden="true">
          <span className="pdraw-handle__grip" />
        </span>
        {othersAsking ? (
          <span className="pdraw-handle__ask" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>

      {mounted ? (
        <div
          className="pdraw-layer"
          data-state={shown ? 'open' : 'closed'}
          data-dragging={drag > 0 ? 'true' : undefined}
          data-testid="powerdraw"
        >
          <div className="pdraw__scrim" onClick={onClose} aria-hidden="true" />
          <div
            ref={panelRef}
            className="pdraw"
            role="dialog"
            aria-modal="true"
            aria-label="Projects"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            style={panelStyle}
          >
            <div className="pdraw__head" aria-hidden="true">
              <span>Projects</span>
              {count ? <span className="pdraw__count">{count}</span> : null}
            </div>

            {count === 0 ? (
              <p className="pdraw__empty">No projects yet</p>
            ) : (
              <>
                <div className="pdraw__band" aria-hidden="true" />
                <div
                  ref={wheelRef}
                  className="pdraw__wheel"
                  role="list"
                  aria-label="Projects"
                  onScroll={onScroll}
                  data-testid="powerdraw-wheel"
                >
                  <div className="pdraw__pad" aria-hidden="true" />
                  {projects.map((project, index) => {
                    const focused = index === centre
                    const isCurrent = project.id === currentId
                    return (
                      <div key={project.id} role="listitem" className="pdraw__item">
                        <button
                          ref={(el) => {
                            rowsRef.current[index] = el
                          }}
                          type="button"
                          className="pdrow"
                          data-focused={focused ? 'true' : undefined}
                          data-current={isCurrent ? 'true' : undefined}
                          data-attention={project.asking ? 'true' : undefined}
                          data-meta={project.asking || project.panes > 0 || isCurrent ? 'true' : undefined}
                          aria-current={isCurrent ? 'true' : undefined}
                          tabIndex={focused ? 0 : -1}
                          onClick={() => onRow(index)}
                          style={{ '--pj-color': project.color } as CSSProperties}
                          data-testid="powerdraw-row"
                          data-project={project.id}
                        >
                          <span className="pdrow__text">
                            <span className="pdrow__title">
                              <span className="pdrow__dot" aria-hidden="true" />
                              <span className="pdrow__name">{project.name}</span>
                            </span>
                            <span className="pdrow__path">{shortPath(project.path)}</span>
                            <span className="pdrow__meta">
                              {project.asking ? (
                                <span className="pdrow__ask">
                                  <span className="pdrow__ask-mark" aria-hidden="true">
                                    !
                                  </span>
                                  Asking
                                </span>
                              ) : null}
                              {project.panes > 0 ? (
                                <span className="pdrow__panes">
                                  {project.panes} {project.panes === 1 ? 'pane' : 'panes'}
                                </span>
                              ) : null}
                              {isCurrent ? (
                                <span className="pdrow__here">
                                  <Icon name="check" size={12} />
                                  Open
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span className="pdraw__sr">{focused ? ', tap to open' : ', tap to bring to the middle'}</span>
                        </button>
                      </div>
                    )
                  })}
                  <div className="pdraw__pad" aria-hidden="true" />
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------ helpers */

/** A light tick as the middle row changes. Not every browser has it, and some throw. */
function tick(): void {
  try {
    navigator.vibrate?.(6)
  } catch {
    /* no vibration here */
  }
}

function reducedMotion(): boolean {
  if (document.documentElement.dataset.reducedMotion === 'true') return true
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function editableFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(el.type)
}

/**
 * The on-screen keyboard is up: something that types has focus *and* the
 * visible window has shrunk. The page asks for `interactive-widget=resizes-content`,
 * so on Android the window itself shrinks; on iOS the visual viewport does.
 * Focus alone is not enough — Android's Back drops the keyboard and keeps it.
 */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => {
    let width = 0
    let tallest = 0
    const read = (): void => {
      const height = window.visualViewport?.height ?? window.innerHeight
      if (window.innerWidth !== width) {
        width = window.innerWidth
        tallest = 0
      }
      tallest = Math.max(tallest, height)
      setUp(editableFocused() && height < tallest - KEYBOARD_PX)
    }
    // Focus moves a tick before the window resizes, and focusout reports the old element.
    const soon = (): void => void window.setTimeout(read, 0)
    read()
    const vv = window.visualViewport
    window.addEventListener('resize', read)
    vv?.addEventListener('resize', read)
    document.addEventListener('focusin', soon)
    document.addEventListener('focusout', soon)
    return () => {
      window.removeEventListener('resize', read)
      vv?.removeEventListener('resize', read)
      document.removeEventListener('focusin', soon)
      document.removeEventListener('focusout', soon)
    }
  }, [])
  return up
}

/**
 * A bottom sheet is open. They portal a `.bsheet-layer` straight into the
 * phone's `.app` (BottomSheet.tsx), so its presence there is the answer; the
 * sheet stack itself has no subscription to listen to.
 */
function useBottomSheetUp(): boolean {
  const [up, setUp] = useState(false)
  useEffect(() => {
    const layer = (document.querySelector('.app[data-shell="app"]') as HTMLElement | null) ?? document.body
    const read = (): void => setUp(layer.querySelector(':scope > .bsheet-layer') !== null)
    read()
    const observer = new MutationObserver(read)
    observer.observe(layer, { childList: true })
    return () => observer.disconnect()
  }, [])
  return up
}

function useDocumentFullscreen(): boolean {
  const [full, setFull] = useState(false)
  useEffect(() => {
    const read = (): void =>
      setFull(
        Boolean(
          document.fullscreenElement ||
            (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
        )
      )
    read()
    document.addEventListener('fullscreenchange', read)
    document.addEventListener('webkitfullscreenchange', read)
    return () => {
      document.removeEventListener('fullscreenchange', read)
      document.removeEventListener('webkitfullscreenchange', read)
    }
  }, [])
  return full
}

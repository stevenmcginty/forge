import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { sortProjectsForPicker } from '@shared/project-order'
import type { Project } from '@shared/types'
import { collectLeaves } from '@/lib/splitTree'
import { Icon } from '@/components/Icon'
import { useBackClose } from '../lib/back-stack'
import { setDrawerSlot } from '../lib/drawer-slot'
import { shortPath } from '../lib/paths'
import { useForge } from '../state'
import { openSheetCount } from './BottomSheet'
import './PowerDraw.css'

/**
 * PowerDraw: the phone's one-hand project switcher.
 *
 * A slim pill on the right edge, halfway up. A tap on it, or a pull to the
 * left, slides in a card from the right, low on the screen where the thumb
 * already is: a heading, and under it a drum of projects that turns. The slot
 * in the middle of the drum is "this one": the row there stands upright and
 * full, with its panes and path. The rows above and below tip away round the
 * drum and dim a little, but every name stays readable. A tap on the middle
 * row opens that project and puts the card away; a tap on any other row turns
 * it to the middle.
 *
 * With three projects or more the drum goes all the way round, as a real one
 * does: the last project sits above the first. The picker order puts the open
 * project near the top of the list, so a drum with ends would open with an
 * empty top half; a round one never does.
 *
 * The drum is turned by hand, not by the browser's scroll: a finger drags it,
 * a flick spins it on, and it settles on a row on a critically damped spring,
 * so it never overshoots. Each frame writes a transform and an opacity on the
 * rows in view (compositor work, no layout), and React re-renders only when
 * the middle row changes.
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

/** Rows stand this far apart at the middle of the drum, measured round it. */
const ROW_PX = 56
/** The middle slot is taller than a row: it has room for the panes and the path. PowerDraw.css reads it as `--pdraw-band`. */
const BAND_PX = 76
/** So the two neighbours of the middle row stand this much further off. */
const SPREAD_PX = (BAND_PX - ROW_PX) / 2
/** One row turns the drum this far. */
const STEP_DEG = 15
const STEP_RAD = (STEP_DEG * Math.PI) / 180
const RADIUS_PX = ROW_PX / STEP_RAD
/** How far off the eye stands from the drum: rows round the back look this much smaller. */
const EYE_PX = 900
/** At most this many rows show above the middle one, and as many below. */
const HALF_MAX = 3
/** A flick spins the drum on by its speed times this. */
const FLING_S = 0.16
/**
 * Spring rates, per second. A fling's rate × FLING_S sits between 1 (it
 * would overshoot below) and 2 (it would speed up after the finger lifts).
 */
const RATE_FLING = 1.5 / FLING_S
const RATE_GLIDE = 16
/** The turn into place as the card comes in: a touch slower than the slide, so it lands still turning. */
const RATE_OPEN = 11
/** Matches the exit transition in PowerDraw.css (`--p-dur-sheet`). */
const EXIT_MS = 280
/** A pull this far to the left on the handle opens the drum; this far right on the card closes it. */
const PULL_OPEN_PX = 24
const DRAG_CLOSE_PX = 80
const FLICK_PX_PER_MS = 0.5
/** A pointer that moves less than this is a tap. */
const TAP_SLOP_PX = 8
/** The keyboard is up when the visible window is this much shorter than its tallest at this width. */
const KEYBOARD_PX = 120

/** How the drum is built for this many projects. */
interface Geometry {
  count: number
  /** It goes all the way round. */
  loop: boolean
  /** Rows shown each side of the middle one. */
  half: number
}

function geometryFor(count: number): Geometry {
  // A round drum needs every row it shows to be a different project.
  const loop = count >= 3
  const half = count <= 1 ? 0 : count === 2 ? 1 : Math.min(HALF_MAX, Math.floor((count - 1) / 2))
  return { count, loop, half }
}

function wrapIndex(n: number, count: number): number {
  return ((n % count) + count) % count
}

/** Rows from the middle to row `i`; the short way round when the drum is round. */
function offsetOf(i: number, pos: number, g: Geometry): number {
  const d = i - pos
  return g.loop ? d - g.count * Math.round(d / g.count) : d
}

/**
 * Where a row `d` rows from the middle sits on the drum, as seen from the
 * front: its height off the middle, and how much it shrinks across and, more,
 * top to bottom as it tips away. A flat 2D scale, not a 3D rotation, so the
 * names stay upright and sharp instead of leaning in perspective.
 */
function place(d: number): { y: number; sx: number; sy: number } {
  const angle = d * STEP_RAD
  const s = EYE_PX / (EYE_PX - RADIUS_PX * (Math.cos(angle) - 1))
  return {
    y: RADIUS_PX * Math.sin(angle) * s + SPREAD_PX * Math.max(-1, Math.min(1, d)),
    sx: s,
    sy: s * Math.cos(angle)
  }
}

/** The drum's window: the outer rows as they fade out, and no more. */
function wheelHeight(half: number): number {
  if (half === 0) return BAND_PX + 16
  return Math.round(2 * (place(half + 0.2).y + 16))
}

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

interface Gesture {
  id: number
  x: number
  y: number
  t: number
  mode: 'pending' | 'turn' | 'close' | 'none'
  /** It came down on the drum, not the heading. */
  inWheel: boolean
  /** It came down on a turning drum: it holds it, it does not choose. */
  caught: boolean
  startPos: number
  samples: { t: number; p: number }[]
  dx: number
}

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
  const layerRef = useRef<HTMLDivElement | null>(null)
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

  /*
   * The pane slot: the open pane's controls (view, keys, state, model) are
   * portalled in here by the session composer while the card is out.
   */
  const paneRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [closeSlot] = useState(() => () => closeRef.current())
  useEffect(() => {
    const el = paneRef.current
    if (!mounted || !el) return undefined
    setDrawerSlot({ el, close: closeSlot })
    return () => setDrawerSlot(null)
  }, [mounted, closeSlot])

  /* ---------------------------------------------------------- the drum */

  const count = projects.length
  const geo = geometryFor(count)
  const geoRef = useRef(geo)
  useLayoutEffect(() => {
    geoRef.current = geo
  })

  /** The row slots, in list order. */
  const rowsRef = useRef<(HTMLDivElement | null)[]>([])
  /** Each row's offset as last drawn, so a still row is not written again. */
  const lastD = useRef<number[]>([])
  const farRef = useRef<boolean[]>([])
  /** Each row's height off the middle as last drawn, on screen: for finding the row under a tap. */
  const drawnY = useRef<number[]>([])
  /** Where the drum stands, in rows: row i is in the middle at i. */
  const posRef = useRef(0)
  /** The row the drum turns to as the card comes in. */
  const startRef = useRef(0)
  const centreRef = useRef(-1)
  /** Turning into place on open is not a person turning the drum: no tick for it. */
  const quiet = useRef(true)
  const [centre, setCentre] = useState(-1)
  const motion = useRef<{ x0: number; v0: number; rate: number; t0: number; target: number } | null>(null)
  const frame = useRef(0)
  const wheelIdle = useRef(0)

  /** Put every row in view where the drum says, and note the middle row. */
  const paint = useCallback(() => {
    const g = geoRef.current
    const pos = posRef.current
    const rows = rowsRef.current
    for (let i = 0; i < g.count; i += 1) {
      const el = rows[i]
      if (!el) continue
      const d = offsetOf(i, pos, g)
      const a = Math.abs(d)
      const far = a > g.half + 0.5
      if (far !== farRef.current[i]) {
        farRef.current[i] = far
        if (far) el.setAttribute('data-far', 'true')
        else el.removeAttribute('data-far')
      }
      if (far) {
        drawnY.current[i] = Number.NaN
        continue
      }
      const r = Math.round(d * 1000) / 1000
      if (lastD.current[i] === r) continue
      lastD.current[i] = r
      const { y, sx, sy } = place(r)
      const ra = Math.abs(r)
      // Gently down to about .55 three rows out; then gone by the window's edge.
      const opacity = Math.max(0, Math.min(1, 1 - ra * 0.13, (g.half + 0.5 - ra) * 2.4))
      el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      el.style.opacity = opacity.toFixed(3)
      el.style.setProperty('--a', Math.min(1, ra).toFixed(3))
      drawnY.current[i] = y
    }
    const next = g.count === 0 ? -1 : wrapIndex(Math.round(pos), g.count)
    if (next !== centreRef.current) {
      const had = centreRef.current
      centreRef.current = next
      setCentre(next)
      if (had >= 0 && !quiet.current) tick()
    }
  }, [])

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    motion.current = null
  }, [])

  const settle = useCallback(
    (target: number) => {
      const g = geoRef.current
      posRef.current = g.loop && g.count > 0 ? wrapIndex(target, g.count) : target
      paint()
    },
    [paint]
  )

  /** Turn the drum to `target` (a whole row) on a critically damped spring, starting at `velocity` rows/s. */
  const runTo = useCallback(
    (target: number, velocity: number, rate: number) => {
      stop()
      const x0 = posRef.current - target
      if (reducedMotion() || Math.abs(x0) < 0.001) {
        settle(target)
        return
      }
      const m = { x0, v0: velocity, rate, t0: performance.now(), target }
      motion.current = m
      const step = (now: number): void => {
        if (motion.current !== m) return
        const t = Math.max(0, (now - m.t0) / 1000)
        let x = (m.x0 + (m.v0 + m.rate * m.x0) * t) * Math.exp(-m.rate * t)
        // Never past the row it is settling on.
        if (Math.sign(x) !== Math.sign(m.x0)) x = 0
        if (Math.abs(x) < 0.0015) {
          motion.current = null
          frame.current = 0
          settle(m.target)
          return
        }
        posRef.current = m.target + x
        paint()
        frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    [paint, settle, stop]
  )

  /** Turn to row `index`, the short way round. */
  const glideTo = (index: number): void => {
    const g = geoRef.current
    if (index < 0 || index >= g.count) return
    const pos = posRef.current
    runTo(Math.round(pos + offsetOf(index, pos, g)), 0, RATE_GLIDE)
  }

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      window.clearTimeout(wheelIdle.current)
    },
    []
  )

  // On open, before first paint: one row short of the open project, so the
  // drum can turn it into the middle as the card slides in.
  useLayoutEffect(() => {
    if (!mounted) return
    const g = geoRef.current
    stop()
    quiet.current = true
    centreRef.current = -1
    lastD.current = []
    farRef.current = []
    drawnY.current = []
    const start = Math.max(0, projects.findIndex((p) => p.id === currentId))
    startRef.current = start
    posRef.current = g.loop && !reducedMotion() ? start - 1 : start
    paint()
    // Only on mount: a list that changes while open keeps where it stands (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  // The list changed under the drum (a project added or removed): redraw every row.
  const ids = projects.map((p) => p.id).join('\n')
  useLayoutEffect(() => {
    if (!mounted) return
    const g = geoRef.current
    rowsRef.current.length = g.count
    lastD.current = []
    farRef.current = []
    drawnY.current = []
    if (g.count > 0 && !g.loop) posRef.current = Math.max(0, Math.min(g.count - 1, Math.round(posRef.current)))
    paint()
  }, [ids, mounted, paint])

  // On screen: turn into place, and focus the open project's row (or the card).
  useLayoutEffect(() => {
    if (!shown) return
    const start = startRef.current
    if (geoRef.current.count > 0 && Math.abs(posRef.current - start) > 0.001) runTo(start, 0, RATE_OPEN)
    const row = rowsRef.current[start]?.querySelector<HTMLButtonElement>('.pdrow')
    ;(row ?? panelRef.current)?.focus({ preventScroll: true })
  }, [shown, runTo])

  /** The middle row opens its project; any other row turns to the middle. */
  const onRow = (index: number): void => {
    const pos = posRef.current
    if (Math.abs(offsetOf(index, pos, geoRef.current)) < 0.35) {
      stop()
      onSelect(projects[index].id)
      return
    }
    quiet.current = false
    glideTo(index)
  }

  /** The row under a tap: on the middle slot, the middle row; elsewhere, the nearest drawn row. */
  const rowAt = (clientY: number): number => {
    const wheel = wheelRef.current
    if (!wheel) return -1
    const rect = wheel.getBoundingClientRect()
    const y = clientY - (rect.top + rect.height / 2)
    const aim = Math.abs(y) <= BAND_PX / 2 ? 0 : y
    let best = -1
    let gap = ROW_PX
    drawnY.current.forEach((at, i) => {
      if (Number.isNaN(at)) return
      const g = Math.abs(at - aim)
      if (g < gap) {
        gap = g
        best = i
      }
    })
    return best
  }

  const inBand = (clientY: number): boolean => {
    const wheel = wheelRef.current
    if (!wheel) return false
    const rect = wheel.getBoundingClientRect()
    return Math.abs(clientY - (rect.top + rect.height / 2)) <= BAND_PX / 2
  }

  /* ------------------------------------------- turn, flick, tap, swipe away */

  const gesture = useRef<Gesture | null>(null)

  const setPressed = (on: boolean): void => {
    const panel = panelRef.current
    if (!panel) return
    if (on) panel.setAttribute('data-press', 'true')
    else panel.removeAttribute('data-press')
  }

  const endCloseDrag = (): void => {
    const panel = panelRef.current
    if (panel) panel.style.transform = ''
    layerRef.current?.removeAttribute('data-dragging')
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const inWheel = wheelRef.current?.contains(e.target as Node) ?? false
    const caught = inWheel && motion.current !== null
    // A finger on the drum holds it where it is.
    if (inWheel) stop()
    const now = performance.now()
    gesture.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: now,
      mode: 'pending',
      inWheel,
      caught,
      startPos: posRef.current,
      samples: [{ t: now, p: posRef.current }],
      dx: 0
    }
    if (inWheel && !caught && inBand(e.clientY)) setPressed(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    if (g.mode === 'pending') {
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return
      setPressed(false)
      if (g.inWheel && Math.abs(dy) >= Math.abs(dx)) {
        g.mode = 'turn'
        g.y = e.clientY
        g.startPos = posRef.current
        quiet.current = false
      } else if (dx > 0 && dx > Math.abs(dy) * 1.2) {
        // A mostly-sideways pull to the right puts the card away.
        g.mode = 'close'
        g.x = e.clientX
        g.t = performance.now()
        layerRef.current?.setAttribute('data-dragging', 'true')
      } else {
        g.mode = 'none'
        return
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* a pointer that already ended */
      }
    }
    if (g.mode === 'turn') {
      const geom = geoRef.current
      let p = g.startPos - (e.clientY - g.y) / ROW_PX
      if (!geom.loop) {
        // Past either end the drum gives a little, then holds.
        const max = Math.max(0, geom.count - 1)
        if (p < 0) p *= 0.3
        else if (p > max) p = max + (p - max) * 0.3
      }
      posRef.current = p
      const now = performance.now()
      g.samples.push({ t: now, p })
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift()
      paint()
    } else if (g.mode === 'close') {
      g.dx = Math.max(0, e.clientX - g.x)
      const panel = panelRef.current
      if (panel) panel.style.transform = `translateX(${g.dx}px)`
    }
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    gesture.current = null
    setPressed(false)
    const cancelled = e.type === 'pointercancel'
    const geom = geoRef.current
    if (g.mode === 'turn') {
      const now = performance.now()
      const first = g.samples[0]
      const last = g.samples[g.samples.length - 1]
      const span = last.t - first.t
      // Rows a second; nothing if the finger stopped before it lifted.
      let v = !cancelled && span > 0 && now - last.t < 60 ? ((last.p - first.p) / span) * 1000 : 0
      v = Math.max(-40, Math.min(40, v))
      let target = Math.round(posRef.current + v * FLING_S)
      if (!geom.loop) target = Math.max(0, Math.min(geom.count - 1, target))
      runTo(target, v, RATE_FLING)
      return
    }
    if (g.mode === 'close') {
      endCloseDrag()
      const speed = g.dx / Math.max(1, performance.now() - g.t)
      if (!cancelled && (g.dx > DRAG_CLOSE_PX || (g.dx > 24 && speed > FLICK_PX_PER_MS))) onClose()
      return
    }
    if (!g.inWheel || geom.count === 0) return
    if (g.mode === 'pending' && !cancelled && !g.caught) {
      const index = rowAt(e.clientY)
      if (index >= 0) {
        onRow(index)
        return
      }
    }
    // Held mid-turn, or let go: settle on the nearest row.
    runTo(Math.round(posRef.current), 0, RATE_GLIDE)
  }

  /** A mouse wheel or a touchpad turns the drum too, and it settles when they stop. */
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    const g = geoRef.current
    if (g.count === 0) return
    stop()
    quiet.current = false
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    let p = posRef.current + px / ROW_PX
    if (!g.loop) p = Math.max(0, Math.min(g.count - 1, p))
    posRef.current = p
    paint()
    window.clearTimeout(wheelIdle.current)
    wheelIdle.current = window.setTimeout(() => runTo(Math.round(posRef.current), 0, RATE_GLIDE), 120)
  }

  /* ---------------------------------------------------------- keys */

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      if (openSheetCount() > 0) return
      e.preventDefault()
      onClose()
      return
    }
    const g = geoRef.current
    if (g.count === 0) return
    const base = motion.current?.target ?? Math.round(posRef.current)
    let next: number
    if (e.key === 'ArrowDown') next = base + 1
    else if (e.key === 'ArrowUp') next = base - 1
    else if (e.key === 'Home') next = base + offsetOf(0, base, g)
    else if (e.key === 'End') next = base + offsetOf(g.count - 1, base, g)
    else return
    e.preventDefault()
    if (!g.loop) next = Math.max(0, Math.min(g.count - 1, next))
    quiet.current = false
    runTo(next, 0, RATE_GLIDE)
    rowsRef.current[wrapIndex(next, g.count)]?.querySelector<HTMLButtonElement>('.pdrow')?.focus({ preventScroll: true })
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
          {/* A drum in little: a long rib in the middle, short ones round it. */}
          <span className="pdraw-handle__rib" />
          <span className="pdraw-handle__rib" data-mid="true" />
          <span className="pdraw-handle__rib" />
        </span>
        {othersAsking ? (
          <span className="pdraw-handle__ask" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>

      {mounted ? (
        <div
          ref={layerRef}
          className="pdraw-layer"
          data-state={shown ? 'open' : 'closed'}
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
            style={{ '--pdraw-band': `${BAND_PX}px` } as CSSProperties}
          >
            <div className="pdraw__head">
              <span className="pdraw__title" aria-hidden="true">
                Projects
                {count ? <span className="pdraw__count">{count}</span> : null}
              </span>
              <button
                type="button"
                className="pdraw__close"
                aria-label="Close projects"
                onClick={onClose}
                data-testid="powerdraw-close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {count === 0 ? (
              <p className="pdraw__empty">No projects yet</p>
            ) : (
              <div
                ref={wheelRef}
                className="pdraw__wheel"
                role="list"
                aria-label="Projects"
                onWheel={onWheel}
                style={{ height: wheelHeight(geo.half) }}
                data-testid="powerdraw-wheel"
              >
                <div
                  className="pdraw__glow"
                  aria-hidden="true"
                  style={{ '--pdraw-tint': projects[centre]?.color } as CSSProperties}
                />
                <div className="pdraw__band" aria-hidden="true" />
                {projects.map((project, index) => {
                  const focused = index === centre
                  const isCurrent = project.id === currentId
                  return (
                    <div
                      key={project.id}
                      ref={(el) => {
                        rowsRef.current[index] = el
                      }}
                      role="listitem"
                      className="pdraw__slot"
                    >
                      <button
                        type="button"
                        className="pdrow"
                        data-focused={focused ? 'true' : undefined}
                        data-current={isCurrent ? 'true' : undefined}
                        data-attention={project.asking ? 'true' : undefined}
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
                            {project.asking ? (
                              <span className="pdrow__ask">
                                <span className="pdrow__ask-mark" aria-hidden="true">
                                  !
                                </span>
                                Asking
                              </span>
                            ) : null}
                            {isCurrent ? (
                              <span className="pdrow__here">
                                <Icon name="check" size={12} />
                                Open
                              </span>
                            ) : null}
                          </span>
                          <span className="pdrow__sub">
                            {project.panes > 0 ? (
                              <>
                                <span className="pdrow__panes">
                                  {project.panes} {project.panes === 1 ? 'pane' : 'panes'}
                                </span>
                                <span className="pdrow__sep" aria-hidden="true">
                                  ·
                                </span>
                              </>
                            ) : null}
                            <span className="pdrow__path">{shortPath(project.path)}</span>
                          </span>
                        </span>
                        <span className="pdraw__sr">{focused ? ', tap to open' : ', tap to bring to the middle'}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* The open pane's controls land here (SessionComposer portals them in). */}
            <div ref={paneRef} className="pdraw__pane" data-testid="powerdraw-pane" />
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

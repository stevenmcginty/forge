import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { MosaicRect, MosaicTile as MosaicTileRect, PaneLeaf, Project, TerminalTab, Workspace } from '@shared/types'
import { isPaneDead, paneStatusLabel, usePaneRuntime } from '@/hooks/usePaneRuntime'
import { launchCommand, leafPermissionMode, paneDisplayTitle, permissionChip, resolveProfile } from '@/lib/agents'
import {
  MOSAIC_GAP,
  MOSAIC_MIN_H,
  MOSAIC_MIN_W,
  NO_EDGES,
  TAB_DRAG_TYPE,
  TASK_DRAG_TYPE,
  cascadeAt,
  clampResize,
  collides,
  columnsFor,
  contentBounds,
  emptyMosaic,
  freeSpot,
  nearestTile,
  normalise,
  othersOf,
  placeMissing,
  snapMove,
  snapResize,
  type MosaicDir,
  type MosaicEdges
} from '@/lib/mosaicLayout'
import { collectLeaves } from '@/lib/splitTree'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import { terminalHost, type PaneGeometry, type TerminalSpec } from '@/lib/terminals'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { ActivityDot } from './ActivityDot'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import './MosaicView.css'

/**
 * The mosaic: every pane in the project, from every tab, as a small live tile.
 *
 * The tiles are the real terminals — not snapshots, not a second render of the
 * scrollback. How they are drawn is the wall's one legibility setting, and it
 * applies to every tile at once (Settings → Appearance, or the Aa button in the
 * tab strip):
 *
 *   life-size  the default. Each tile is a window onto its terminal at scale 1:
 *              the same type size as tab view, cropped to the tile and anchored
 *              at the bottom-left, where the prompt and the live region are.
 *              Nothing is ever resized to achieve this — a ConPTY resize
 *              reflows destructively, and a glance must not rewrite a pane.
 *   scaled     each tile is a scale model — the PTY keeps the cols/rows it had
 *              in tab view and the whole picture is shrunk with a CSS
 *              transform, so nothing reflows and a full-screen TUI carries on
 *              drawing into the grid it always had. Truthful, and past four or
 *              five tiles, too small to read.
 *
 * Double-clicking a tile's header overrides the setting for that one tile,
 * either way — see MosaicTile.
 *
 * The wall has two layouts, per project:
 *
 *   auto    Forge places the tiles in a uniform grid. Nothing to arrange, and
 *           in scaled mode the type is the same size on every tile because they
 *           all scale against the biggest pane on the wall.
 *   custom  you place them. Drag a header, drag an edge, drop a whole tab out
 *           of the strip onto the wall. The first move or resize seeds custom
 *           mode from exactly where the auto grid had put everything, so
 *           crossing over is invisible; "Reset to grid" crosses back.
 *
 * Tiles are read-only. Click one and it blows up to full size in place, where
 * the keyboard works; Esc drops you back to the wall. Double-click a tile's
 * header and its terminal stops being a scale model and refits to the box for
 * real — see MosaicTile.
 */

/** One tile: a pane plus the tab it came from, which the header names. */
interface Cell {
  leaf: PaneLeaf
  tab: TerminalTab
}

/**
 * How far a zoomed pane may be blown up past life size.
 *
 * Zoom does not refit the PTY, so magnifying is the only way to make a pane
 * that was one of eight in a split actually readable — at natural scale it is a
 * postage stamp adrift in the middle of the window. The character grid is
 * untouched either way; the glyphs simply get bigger.
 *
 * Capped low deliberately. Scaling all the way to fit would put a 310px pane at
 * 2.7x — a 35px font, which is a novelty rather than a terminal. 1.5x is enough
 * to make the smallest pane comfortable and does not bind at all on a pane that
 * had a tab to itself.
 */
const ZOOM_MAX_SCALE = 1.5

/**
 * How long after the last size change a refitted tile actually refits its PTY.
 *
 * Refitting on every frame of a resize drag would send a `resize` down the pipe
 * sixty times a second and have the shell reflow into every intermediate width.
 * The box follows the pointer; the terminal catches up when you stop.
 */
const REFIT_SETTLE_MS = 120

/**
 * How far the pointer must travel before a press on a tile becomes a drag.
 *
 * Nothing at all happens below this: no wall is turned freeform, no box is
 * written. That matters because the header is also a double-click target, and
 * because a stray click on a tile you were only pointing at must not be the
 * thing that takes a project off the auto grid forever.
 */
const DRAG_THRESHOLD = 3

/** One live drag or resize. Lives in a ref: none of it belongs in React state. */
interface DragSession {
  paneId: string
  el: HTMLElement
  ghost: HTMLElement | null
  mode: 'move' | 'resize'
  edges: MosaicEdges
  /** Where the tile was when the pointer went down. */
  start: MosaicRect
  originX: number
  originY: number
  pointerX: number
  pointerY: number
  /** False until the pointer has moved far enough to mean it. */
  armed: boolean
  /** Every other tile's box, frozen for the duration — they cannot move. */
  others: MosaicRect[]
  /** Last box we were happy with; committed on release. */
  current: MosaicRect
  raf: number
  fit: boolean
  /** The wall was still on the auto grid when this drag started. */
  seed: Record<string, MosaicTileRect> | null
  onMove: (e: PointerEvent) => void
  onUp: (e: PointerEvent) => void
}

export function MosaicView({
  project,
  workspace,
  onNewTerminal
}: {
  project: Project
  workspace: Workspace
  onNewTerminal: () => void
}): ReactNode {
  const { state, actions } = useApp()

  const cells = useMemo<Cell[]>(
    () => workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab }))),
    [workspace.tabs]
  )

  const mosaic = workspace.mosaic ?? emptyMosaic()
  const custom = mosaic.mode === 'custom'

  /** The wall's default: refit every terminal to its tile at life-size type. */
  const lifesize = state.settings.mosaicText !== 'scaled'

  const zoomId = state.mosaicZoom
  const zoomCell = cells.find((c) => c.leaf.id === zoomId) ?? null

  // A zoom can outlive its pane (closed from a shortcut, or the tab went away).
  useEffect(() => {
    if (zoomId && !zoomCell) actions.setMosaicZoom(null)
  }, [actions, zoomCell, zoomId])

  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
  const [picked, setPicked] = useState<string | null>(null)
  /** The tile the user is typing into in place — null means the wall is read-only. */
  const [interactiveId, setInteractiveId] = useState<string | null>(null)
  const selectedId =
    (picked && cells.some((c) => c.leaf.id === picked) ? picked : null) ??
    activeTab?.activePaneId ??
    cells[0]?.leaf.id ??
    null

  const columns = columnsFor(cells.length)

  const wallRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [area, setArea] = useState({ width: 960, height: 600 })
  const [dropHint, setDropHint] = useState(false)

  /* The wall's viewport, which is what a fresh tile is sized against. */
  useEffect(() => {
    const el = wallRef.current
    if (!el) return
    const measure = (): void => {
      const width = el.clientWidth
      const height = el.clientHeight
      if (width < 8 || height < 8) return
      setArea((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * The size a tile gets when nobody has ever placed it: whatever the auto grid
   * would have given it. A dropped tab therefore lands looking like the wall it
   * landed on, rather than at some arbitrary default.
   */
  const defaultSize = useMemo(() => {
    const n = Math.max(1, cells.length)
    const cols = columnsFor(n)
    const rows = Math.ceil(n / cols)
    return {
      w: Math.max(MOSAIC_MIN_W, Math.round((area.width - MOSAIC_GAP * (cols - 1)) / cols)),
      h: Math.max(MOSAIC_MIN_H, Math.round((area.height - MOSAIC_GAP * (rows - 1)) / rows))
    }
  }, [area, cells.length])

  /*
   * One scale for the whole wall, taken from the largest pane on it.
   *
   * Scaling each tile to its own pane would give every tile a different text
   * size — a pane that was one of five in a split would come out twice as big
   * as one that had a tab to itself — and a wall you have to refocus on for
   * every tile is not a wall you can scan. Sizing everything against the
   * biggest pane keeps the type uniform and still tells the truth: a tile
   * showing a small pane simply covers less of its tile.
   *
   * Tiles the user has refitted (see MosaicTile) opt out entirely and are not
   * counted here, so refitting one tile never rescales the rest of the wall.
   */
  const reference = useMemo<PaneGeometry>(() => {
    let width = 1
    let height = 1
    for (const cell of cells) {
      const g = terminalHost.geometryFor(cell.leaf.id)
      if (g.width > width) width = g.width
      if (g.height > height) height = g.height
    }
    return { width, height }
    // Re-measured whenever the wall's membership changes — which is also the
    // only time a tile is mounted and could need a different scale.
  }, [cells])

  /* --------------------------------------------------------------- layout */

  /**
   * Every tile's box, including one for any pane nobody has placed yet — a
   * terminal opened while the wall was already freeform has to go *somewhere*,
   * and the first gap big enough for it is the least surprising somewhere.
   */
  const tiles = useMemo<Record<string, MosaicTileRect>>(() => {
    if (!custom) return {}
    return placeMissing(
      mosaic.tiles,
      cells.map((c) => c.leaf.id),
      () => defaultSize
    )
  }, [cells, custom, defaultSize, mosaic.tiles])

  // Persist the boxes we invented above, so they are the same after a restart.
  useEffect(() => {
    if (!custom) return
    const extra: Record<string, MosaicTileRect> = {}
    for (const [id, rect] of Object.entries(tiles)) if (!mosaic.tiles[id]) extra[id] = rect
    if (Object.keys(extra).length > 0) actions.setMosaicTiles(extra)
  }, [actions, custom, mosaic.tiles, tiles])

  const canvas = useMemo(() => contentBounds(tiles, area), [area, tiles])

  /** Where the tiles are on screen right now, in wall coordinates. */
  const measureRects = useCallback((): Record<string, MosaicTileRect> => {
    const wall = wallRef.current
    if (!wall) return {}
    const wr = wall.getBoundingClientRect()
    const out: Record<string, MosaicTileRect> = {}
    for (const el of wall.querySelectorAll<HTMLElement>('.mtile[data-pane-id]')) {
      const id = el.dataset['paneId']
      if (!id) continue
      const r = el.getBoundingClientRect()
      out[id] = normalise({
        x: r.left - wr.left + wall.scrollLeft,
        y: r.top - wr.top + wall.scrollTop,
        w: r.width,
        h: r.height
      })
    }
    return out
  }, [])

  /**
   * The wall as boxes, whichever mode it is in: the stored layout in custom
   * mode, and the grid's own measured positions in auto mode. That second case
   * is what makes crossing into custom mode invisible — the seed *is* what you
   * were already looking at.
   */
  const currentRects = useCallback((): Record<string, MosaicTileRect> => {
    if (custom) return tiles
    const measured = measureRects()
    const out: Record<string, MosaicTileRect> = {}
    for (const cell of cells) {
      out[cell.leaf.id] = measured[cell.leaf.id] ?? { x: 0, y: 0, ...defaultSize }
    }
    return out
  }, [cells, custom, defaultSize, measureRects, tiles])

  /* ----------------------------------------------------------- drag/resize */

  const wallPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const wall = wallRef.current
    if (!wall) return { x: 0, y: 0 }
    const r = wall.getBoundingClientRect()
    return { x: clientX - r.left + wall.scrollLeft, y: clientY - r.top + wall.scrollTop }
  }, [])

  const frame = useCallback((): void => {
    const s = dragRef.current
    if (!s) return
    s.raf = 0
    const dx = s.pointerX - s.originX
    const dy = s.pointerY - s.originY

    if (s.mode === 'move') {
      const snapped = snapMove({ x: s.start.x + dx, y: s.start.y + dy, w: s.start.w, h: s.start.h }, s.others)
      s.current = snapped
      s.el.style.transform = `translate3d(${snapped.x - s.start.x}px, ${snapped.y - s.start.y}px, 0)`
      // Overlapping is allowed *while* you drag — it is how you aim. The ghost
      // shows where the tile will actually be nudged to when you let go.
      const clash = collides(snapped, s.others)
      s.el.setAttribute('data-clash', clash ? 'true' : 'false')
      if (s.ghost) {
        if (clash) {
          const landing = freeSpot(snapped, s.others)
          s.ghost.style.display = 'block'
          s.ghost.style.transform = `translate3d(${landing.x}px, ${landing.y}px, 0)`
          s.ghost.style.width = `${landing.w}px`
          s.ghost.style.height = `${landing.h}px`
        } else {
          s.ghost.style.display = 'none'
        }
      }
      return
    }

    // Resize: the dragged edges move, the others stay put, and nothing is ever
    // allowed to end up smaller than a terminal.
    const rect: MosaicRect = { ...s.start }
    if (s.edges.left) {
      const nx = Math.min(s.start.x + s.start.w - MOSAIC_MIN_W, Math.max(0, s.start.x + dx))
      rect.x = nx
      rect.w = s.start.x + s.start.w - nx
    }
    if (s.edges.right) rect.w = Math.max(MOSAIC_MIN_W, s.start.w + dx)
    if (s.edges.top) {
      const ny = Math.min(s.start.y + s.start.h - MOSAIC_MIN_H, Math.max(0, s.start.y + dy))
      rect.y = ny
      rect.h = s.start.y + s.start.h - ny
    }
    if (s.edges.bottom) rect.h = Math.max(MOSAIC_MIN_H, s.start.h + dy)

    const settled = clampResize(snapResize(rect, s.others, s.edges), s.start, s.others, s.edges)
    // A clamp that cannot satisfy the minimum size means the edge has hit
    // something: hold the last good box rather than shove the tile aside.
    if (!collides(settled, s.others)) s.current = settled
    const c = s.current
    s.el.style.left = `${c.x}px`
    s.el.style.top = `${c.y}px`
    s.el.style.width = `${c.w}px`
    s.el.style.height = `${c.h}px`
  }, [])

  const beginDrag = useCallback(
    (paneId: string, e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize', edges: MosaicEdges): void => {
      if (e.button !== 0 || dragRef.current) return
      // Moving or resizing a tile while you are typing in it stops the typing.
      if (interactiveId) {
        terminalHost.blur(interactiveId)
        setInteractiveId(null)
      }
      const el = (e.currentTarget.closest('.mtile') as HTMLElement | null) ?? null
      if (!el) return
      // Deliberately no preventDefault on the press: it would suppress the
      // compatibility mouse events, and the header's double-click — the refit
      // gesture — is one of them. Selection is held off in CSS instead.
      e.stopPropagation()

      const rects = currentRects()
      const start = rects[paneId]
      if (!start) return

      const session: DragSession = {
        paneId,
        el,
        ghost: ghostRef.current,
        mode,
        edges,
        start,
        originX: e.clientX,
        originY: e.clientY,
        pointerX: e.clientX,
        pointerY: e.clientY,
        armed: false,
        others: othersOf(rects, paneId),
        current: start,
        raf: 0,
        fit: tiles[paneId]?.fit ?? false,
        seed: custom ? null : rects,
        onMove: () => {},
        onUp: () => {}
      }

      session.onMove = (ev: PointerEvent): void => {
        session.pointerX = ev.clientX
        session.pointerY = ev.clientY
        if (!session.armed) {
          const moved =
            Math.abs(ev.clientX - session.originX) + Math.abs(ev.clientY - session.originY) >= DRAG_THRESHOLD
          if (!moved) return
          session.armed = true
          // Arming a drag on an auto wall is also the moment it becomes a
          // custom one. Seeding from the measured grid means the tile under the
          // pointer does not move a pixel as the layout changes beneath it.
          if (session.seed) actions.setMosaicTiles(session.seed, { custom: true })
          session.el.setAttribute('data-dragging', session.mode)
        }
        if (session.raf === 0) session.raf = requestAnimationFrame(frame)
      }

      session.onUp = (): void => {
        dragRef.current = null
        window.removeEventListener('pointermove', session.onMove)
        window.removeEventListener('pointerup', session.onUp)
        window.removeEventListener('pointercancel', session.onUp)
        if (session.raf) cancelAnimationFrame(session.raf)
        // A press that never became a drag leaves no trace at all.
        if (!session.armed) return

        const final = session.mode === 'move' ? freeSpot(session.current, session.others) : session.current
        // Write the committed box straight onto the element before dispatching,
        // so the frame between release and re-render is already correct.
        session.el.style.transform = ''
        session.el.style.left = `${final.x}px`
        session.el.style.top = `${final.y}px`
        session.el.style.width = `${final.w}px`
        session.el.style.height = `${final.h}px`
        session.el.removeAttribute('data-dragging')
        session.el.removeAttribute('data-clash')
        if (session.ghost) session.ghost.style.display = 'none'

        const tile: MosaicTileRect = { ...final }
        if (session.fit) tile.fit = true
        actions.setMosaicTiles({ [session.paneId]: tile })
      }

      dragRef.current = session
      window.addEventListener('pointermove', session.onMove)
      window.addEventListener('pointerup', session.onUp)
      window.addEventListener('pointercancel', session.onUp)
    },
    [actions, currentRects, custom, frame, interactiveId, tiles]
  )

  // A drag must not outlive the view it started in.
  useEffect(() => {
    return () => {
      const s = dragRef.current
      if (!s) return
      dragRef.current = null
      window.removeEventListener('pointermove', s.onMove)
      window.removeEventListener('pointerup', s.onUp)
      window.removeEventListener('pointercancel', s.onUp)
      if (s.raf) cancelAnimationFrame(s.raf)
    }
  }, [])

  /*
   * Double-click a header: this one tile goes the other way from the wall.
   *
   * Flipped against the wall's current default rather than against `false`, so
   * a double-click always visibly changes the tile you double-clicked — in
   * life-size mode it turns that tile back into a scale model, in scaled mode
   * it fits it for real.
   */
  const toggleFit = useCallback(
    (paneId: string): void => {
      if (interactiveId) {
        terminalHost.blur(interactiveId)
        setInteractiveId(null)
      }
      const rects = currentRects()
      if (!custom) actions.setMosaicTiles(rects, { custom: true })
      actions.setMosaicFit(paneId, !(tiles[paneId]?.fit ?? lifesize))
    },
    [actions, currentRects, custom, interactiveId, lifesize, tiles]
  )

  /* ------------------------------------------------------ tab → wall drop */

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE)
      setDropHint(false)
      if (!tabId) return
      e.preventDefault()
      const tab = workspace.tabs.find((t) => t.id === tabId)
      if (!tab) return

      const ids = collectLeaves(tab.root).map((l) => l.id)
      // Seed the whole wall, not just the tab being dropped: everything else
      // has to stay exactly where it looks like it is.
      const base = currentRects()
      const others: MosaicRect[] = []
      for (const [id, rect] of Object.entries(base)) if (!ids.includes(id)) others.push(rect)

      const point = wallPoint(e.clientX, e.clientY)
      const wall = wallRef.current
      // Aim with the tile's top-left corner rather than its middle — that is
      // where the cursor is — and keep it far enough from the far edge that
      // what you dropped is still on screen when you let go.
      const maxX = Math.max(0, (wall?.scrollLeft ?? 0) + area.width - defaultSize.w)
      const maxY = Math.max(0, (wall?.scrollTop ?? 0) + area.height - defaultSize.h)
      const dropped = cascadeAt(
        ids.map((id) => ({ id, ...defaultSize })),
        { x: Math.min(maxX, Math.max(0, point.x - 24)), y: Math.min(maxY, Math.max(0, point.y - 12)) },
        others
      )
      actions.setMosaicTiles({ ...base, ...dropped }, { custom: true, wallTab: tabId })
    },
    [actions, area, currentRects, defaultSize, wallPoint, workspace.tabs]
  )

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropHint(true)
  }, [])

  const zoom = useCallback(
    (paneId: string) => {
      // Leaving the wall for the zoom or a tab is also leaving whatever tile
      // was being typed into — hand the caret back so the keyboard follows.
      if (interactiveId) terminalHost.blur(interactiveId)
      setInteractiveId(null)
      // Zooming *is* selecting: the pane becomes the app's current pane, so
      // Ctrl+W and friends act on the thing you are looking at.
      actions.revealPane(paneId)
      actions.setMosaicZoom(paneId)
    },
    [actions, interactiveId]
  )

  const openInTab = useCallback(
    (paneId: string) => {
      if (interactiveId) terminalHost.blur(interactiveId)
      setInteractiveId(null)
      actions.revealPane(paneId)
      actions.setViewMode('tabs')
    },
    [actions, interactiveId]
  )

  /**
   * Enter or leave a tile's in-place interactive mode: its terminal takes the
   * keyboard right there on the wall, without leaving the mosaic. One tile at a
   * time — entering a second hands focus over rather than leaving two live.
   * Like zoom, entering *is* selecting, so the app's current pane tracks the
   * tile you are talking to.
   */
  const toggleInteract = useCallback(
    (paneId: string) => {
      if (interactiveId === paneId) {
        terminalHost.blur(paneId)
        setInteractiveId(null)
        return
      }
      if (interactiveId) terminalHost.blur(interactiveId)
      actions.revealPane(paneId)
      setInteractiveId(paneId)
    },
    [actions, interactiveId]
  )

  /* ------------------------------------------------------- keyboard: wall */

  useEffect(() => {
    if (zoomCell) return
    // While a tile is being typed into, the keys belong to it — arrows must
    // reach the shell, not move the selection ring.
    if (interactiveId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (document.activeElement instanceof HTMLInputElement) return
      const index = cells.findIndex((c) => c.leaf.id === selectedId)
      if (index < 0) return

      if (e.key === 'Enter') {
        e.preventDefault()
        zoom(cells[index]!.leaf.id)
        return
      }

      const dir: MosaicDir | null =
        e.key === 'ArrowRight'
          ? 'right'
          : e.key === 'ArrowLeft'
            ? 'left'
            : e.key === 'ArrowDown'
              ? 'down'
              : e.key === 'ArrowUp'
                ? 'up'
                : null
      if (!dir) return
      e.preventDefault()

      // On a freeform wall the reading order means nothing, so the ring moves
      // by position — the same rule Alt+arrow uses between split panes.
      if (custom) {
        const next = nearestTile(tiles, cells[index]!.leaf.id, dir)
        if (next) setPicked(next)
        return
      }

      const step = dir === 'right' ? 1 : dir === 'left' ? -1 : dir === 'down' ? columns : -columns
      const next = index + step
      if (next < 0 || next >= cells.length) return
      setPicked(cells[next]!.leaf.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cells, columns, custom, interactiveId, selectedId, tiles, zoom, zoomCell])

  /* ---------------------------------------------------- keyboard: interact */

  useEffect(() => {
    if (!interactiveId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      // Same deal as a zoomed tile: a full-screen TUI owns Escape — in vim it
      // means "leave insert mode" — so it is only stolen when nobody is in one.
      if (terminalHost.isAltBuffer(interactiveId)) return
      e.preventDefault()
      e.stopPropagation()
      setInteractiveId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [interactiveId])

  // A pane being typed into can vanish (closed from a shortcut, its tab went
  // away). A stale id must not leave the wall keyboard-suspended.
  useEffect(() => {
    if (interactiveId && !cells.some((c) => c.leaf.id === interactiveId)) setInteractiveId(null)
  }, [cells, interactiveId])

  /* ------------------------------------------------------- keyboard: zoom */

  useEffect(() => {
    if (!zoomCell) return
    const paneId = zoomCell.leaf.id
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      // A full-screen TUI owns Escape — in vim it means "leave insert mode",
      // and stealing it would be unforgivable. Ctrl+G and the back button are
      // always there instead.
      if (terminalHost.isAltBuffer(paneId)) return
      e.preventDefault()
      e.stopPropagation()
      actions.setMosaicZoom(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [actions, zoomCell])

  /* ------------------------------------------------------------- render */

  if (cells.length === 0) {
    return (
      <div className="mosaic mosaic--empty">
        <EmptyState
          icon="viewMosaic"
          eyebrow={project.name}
          title="Nothing running yet"
          body="The mosaic shows every session in this project at once. Open one and it turns up here."
          action={
            <button type="button" className="cta-btn" onClick={onNewTerminal}>
              <Icon name="plus" size={14} />
              Open a terminal
            </button>
          }
          hint="Ctrl + G  ·  back to tabs"
        />
      </div>
    )
  }

  if (zoomCell) {
    return (
      <div className="mosaic mosaic--zoomed">
        <MosaicTile
          key={zoomCell.leaf.id}
          cell={zoomCell}
          project={project}
          reference={reference}
          lifesize={lifesize}
          zoomed
          selected={false}
          interactive={false}
          onZoom={zoom}
          onOpenInTab={openInTab}
          onBack={() => actions.setMosaicZoom(null)}
          onSelect={setPicked}
          onBeginDrag={beginDrag}
          onToggleFit={toggleFit}
          onToggleInteract={toggleInteract}
        />
      </div>
    )
  }

  return (
    <div className="mosaic">
      {/*
        No toolbar over the wall. Crossing from the grid into freeform must not
        move a single tile, and a strip of chrome appearing above them would
        push the whole wall down by its own height — so the one control the
        freeform wall needs (Reset to grid) lives in the tab strip, next to the
        view toggle, where there was already a row.
      */}
      <div
        ref={wallRef}
        className="mosaic__wall"
        data-custom={custom}
        data-dropping={dropHint || undefined}
        style={{ '--mosaic-cols': columns } as React.CSSProperties}
        onDragOver={onDragOver}
        onDragLeave={() => setDropHint(false)}
        onDrop={onDrop}
      >
        <div
          className="mosaic__canvas"
          style={custom ? { width: `${canvas.width}px`, height: `${canvas.height}px` } : undefined}
        >
          {cells.map((cell) => (
            <MosaicTile
              key={cell.leaf.id}
              cell={cell}
              project={project}
              reference={reference}
              lifesize={lifesize}
              zoomed={false}
              selected={cell.leaf.id === selectedId}
              interactive={interactiveId === cell.leaf.id}
              {...(custom && tiles[cell.leaf.id] ? { rect: tiles[cell.leaf.id]! } : {})}
              onZoom={zoom}
              onOpenInTab={openInTab}
              onSelect={setPicked}
              onBeginDrag={beginDrag}
              onToggleFit={toggleFit}
              onToggleInteract={toggleInteract}
            />
          ))}
          <div className="mosaic__ghost" ref={ghostRef} />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- tile */

/** The eight resize grips, and which edges each of them drags. */
const HANDLES: Array<{ key: string; edges: MosaicEdges }> = [
  { key: 'n', edges: { ...NO_EDGES, top: true } },
  { key: 's', edges: { ...NO_EDGES, bottom: true } },
  { key: 'w', edges: { ...NO_EDGES, left: true } },
  { key: 'e', edges: { ...NO_EDGES, right: true } },
  { key: 'nw', edges: { ...NO_EDGES, top: true, left: true } },
  { key: 'ne', edges: { ...NO_EDGES, top: true, right: true } },
  { key: 'sw', edges: { ...NO_EDGES, bottom: true, left: true } },
  { key: 'se', edges: { ...NO_EDGES, bottom: true, right: true } }
]

function MosaicTile({
  cell,
  project,
  reference,
  lifesize,
  zoomed,
  selected,
  interactive,
  rect,
  onZoom,
  onOpenInTab,
  onBack,
  onSelect,
  onBeginDrag,
  onToggleFit,
  onToggleInteract
}: {
  cell: Cell
  project: Project
  /** The wall's shared scaling reference — ignored when zoomed or refitted. */
  reference: PaneGeometry
  /** The wall's default: refit rather than scale. A tile may override it. */
  lifesize: boolean
  zoomed: boolean
  selected: boolean
  /** This tile is being typed into in place — see toggleInteract. */
  interactive: boolean
  /** Where this tile sits on a freeform wall. Absent = the auto grid places it. */
  rect?: MosaicTileRect
  onZoom: (paneId: string) => void
  onOpenInTab: (paneId: string) => void
  onBack?: () => void
  onSelect: (paneId: string) => void
  onBeginDrag: (
    paneId: string,
    e: ReactPointerEvent<HTMLElement>,
    mode: 'move' | 'resize',
    edges: MosaicEdges
  ) => void
  onToggleFit: (paneId: string) => void
  onToggleInteract: (paneId: string) => void
}): ReactNode {
  const { state, actions } = useApp()
  const workspaceTasks = useActiveWorkspace().tasks
  const paneId = cell.leaf.id
  const profile = resolveProfile(state.settings.agentProfiles, cell.leaf.profileId)
  const runtime = usePaneRuntime(paneId)
  const dead = isPaneDead(runtime)
  const permChip = permissionChip(profile, leafPermissionMode(cell.leaf))
  const [dropping, setDropping] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const naturalRef = useRef<HTMLDivElement | null>(null)

  const specRef = useRef<TerminalSpec>({
    cwd: project.path,
    bootstrapCommand: launchCommand(profile, leafPermissionMode(cell.leaf)),
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent,
    projectName: project.name,
    paneTitle: paneDisplayTitle(profile, cell.leaf.title),
    sessionId: cell.leaf.sessionId,
    repoUrl: project.repoUrl
  })
  specRef.current = {
    cwd: project.path,
    bootstrapCommand: launchCommand(profile, leafPermissionMode(cell.leaf)),
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent,
    projectName: project.name,
    paneTitle: paneDisplayTitle(profile, cell.leaf.title),
    sessionId: cell.leaf.sessionId,
    repoUrl: project.repoUrl
  }

  /*
   * The natural box is the pane's full-size geometry, pinned in pixels. The
   * terminal is attached into that and never resized; only the box's transform
   * changes. Read once per mount — a live pane's geometry does not move while
   * it is sitting in a tile.
   */
  const geometry = useMemo(() => terminalHost.geometryFor(paneId), [paneId])

  /**
   * Life-size: the tile is a scale-1 window onto the terminal, cropped to the
   * tile's box and anchored bottom-left, where the live region is. The
   * alternative is the scale model: the whole picture shrunk with a transform,
   * everything visible, at the price of type nobody can read past a few tiles.
   * Neither ever resizes the terminal — glancing at a pane must not reflow
   * somebody's vim, and a ConPTY reflow eats scrollback (see apply()).
   *
   * The wall's setting decides; a tile the user double-clicked has its own
   * answer in `rect.fit` and keeps it, remembered per project.
   *
   * A zoomed tile has no box, so it follows the wall's setting: in life-size
   * mode it genuinely refits to the big stage — the one deliberate,
   * near-tab-size resize left, because typing needs real cols — and in
   * scale-model mode it stays a scale model: magnified, never reflowed.
   */
  const refit = rect?.fit ?? lifesize

  useLayoutEffect(() => {
    const el = naturalRef.current
    if (!el) return
    /*
     * The box gets its pixels here, before the terminal goes into it — not a
     * frame later in apply().
     *
     * attachPeek fits a brand-new terminal against this element and spawns its
     * shell at whatever that measures, so the very first prompt is already the
     * right width. But `.mtile__natural` is absolutely positioned with no width
     * of its own, so the instant React creates it it is 0×0: the fit bailed out
     * on an unmeasurable box and every mosaic-born pane started life at xterm's
     * default 80×24. The real size then arrived a frame later and resized the
     * PTY out from under an agent that was already painting its first screen —
     * which is the torn welcome banner, half of it drawn at one width and half
     * reflowed into another. Sizing the box first makes that resize a no-op.
     */
    el.style.width = `${geometry.width}px`
    el.style.height = `${geometry.height}px`
    terminalHost.attachPeek(paneId, el, specRef.current)
    return () => terminalHost.detach(paneId)
  }, [geometry, paneId])

  /*
   * Nothing in the mosaic uses WebGL.
   *
   * Every surface here is scaled, and a scaled canvas is a resampled bitmap —
   * smeared shrunk, soft blown up — where xterm's DOM rows are real text that
   * Chromium re-rasterises crisply at whatever scale we hand it. It also
   * sidesteps the context ceiling entirely: a browser will not hand out sixteen
   * live WebGL contexts, and the ones it takes back it takes back mid-frame.
   * Measured, the DOM renderer holds 60fps with sixteen live tiles, so there is
   * nothing to buy back. WebGL belongs to tab view, where scale is always 1.
   */
  useEffect(() => {
    terminalHost.setWebgl(paneId, false)
    if (zoomed) terminalHost.focus(paneId)
  }, [paneId, zoomed])

  /*
   * In-place typing: while a tile is interactive the terminal takes the keyboard
   * right on the wall. Focused on entry, blurred on exit and on unmount — the
   * blur matters, or the tile would keep swallowing keystrokes that belong to
   * the wall again.
   */
  useEffect(() => {
    if (!interactive) return
    terminalHost.focus(paneId)
    return () => terminalHost.blur(paneId)
  }, [interactive, paneId])

  /*
   * Fit into whatever the tile ended up being.
   *
   * Written straight onto the DOM rather than through React state: a resize
   * drag changes this box sixty times a second, and a re-render per frame per
   * tile is the difference between a wall that tracks the pointer and one that
   * lurches. Reads are coalesced to one per frame for the same reason.
   */
  const against = zoomed ? geometry : reference
  useEffect(() => {
    const stage = stageRef.current
    const el = naturalRef.current
    if (!stage || !el) return
    let raf = 0
    let settle: number | null = null

    const apply = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (w < 4 || h < 4) return

      if (refit && zoomed) {
        // The one surface that truly refits: zoom is a deliberate act on one
        // pane, nearly tab-sized, and typing into it needs real cols and rows.
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        el.style.transform = 'none'
        el.style.opacity = '1'
        // The PTY catches up after the pointer stops — see REFIT_SETTLE_MS.
        if (settle !== null) clearTimeout(settle)
        settle = window.setTimeout(() => {
          settle = null
          terminalHost.fit(paneId)
        }, REFIT_SETTLE_MS)
        return
      }

      if (refit) {
        /*
         * Life-size on the wall is a *window*, not a refit: the terminal keeps
         * the exact cols and rows it had in tab view and the tile shows its
         * bottom-left corner at scale 1 — the bottom because that is where the
         * prompt and the live region are.
         *
         * This used to fit the terminal to the tile for real, which read
         * beautifully and quietly destroyed the pane: every column change
         * makes ConPTY reflow and re-emit its screen, and a mosaic↔tab round
         * trip ate a screenful of scrollback each time — measured at twenty
         * lines gone per flip, plus the prompt re-homed to mid-screen. A crop
         * costs a truncated right edge; a refit cost history. See the tab-copy
         * of this reasoning on attachPeek: glancing at a pane must never
         * rewrite it.
         */
        el.style.width = `${geometry.width}px`
        el.style.height = `${geometry.height}px`
        el.style.transform = `translate(0px, ${Math.min(0, h - geometry.height)}px)`
        el.style.opacity = '1'
        return
      }

      el.style.width = `${geometry.width}px`
      el.style.height = `${geometry.height}px`
      const cap = zoomed ? ZOOM_MAX_SCALE : 1
      const scale = Math.min(cap, w / against.width, h / against.height)
      /*
       * Tiles hang off the top-left, so the wall's terminals all start on the
       * same line and the eye can run down them. A zoomed pane is centred
       * instead: at natural scale a pane that was one of five in a split does
       * not come close to filling the area, and shoved into a corner that reads
       * as a layout bug rather than as the letterboxing it is.
       */
      const dx = zoomed ? Math.max(0, (w - geometry.width * scale) / 2) : 0
      const dy = zoomed ? Math.max(0, (h - geometry.height * scale) / 2) : 0
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`
      el.style.opacity = scale > 0 ? '1' : '0'
    }

    apply()
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        apply()
      })
    })
    ro.observe(stage)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (settle !== null) clearTimeout(settle)
      ro.disconnect()
    }
  }, [against, geometry, paneId, refit, zoomed])

  /*
   * Undo the zoom refit the moment the zoom ends, while the pane is still on
   * the wall. A zoom left the terminal at stage cols/rows; the crop branch
   * above has just put the box back at `geometry` pixels, so this fit lands it
   * back on the exact dims it had in tab view — meaning leaving the mosaic
   * re-attaches at an unchanged size and triggers no reflow at all. On a tile
   * that never zoomed the dims already match and this is a no-op (fit only
   * resizes on change, and the PTY flush skips repeats).
   *
   * Declared after the apply() effect on purpose: effects run in order, and
   * the box must be back at its natural size before the fit measures it.
   */
  useEffect(() => {
    if (zoomed || !refit) return
    terminalHost.fit(paneId)
  }, [paneId, refit, zoomed])

  /* --------------------------------------------------------- dropped files */

  /*
   * Same contract as a tab-view pane: a file dropped on a tile types its
   * quoted path into that tile's session. The tile has to speak for itself —
   * the wall's drag handlers only accept TAB_DRAG_TYPE, so a file drag over
   * the mosaic was declined on dragover and its drop never fired at all.
   * maybeFiles (lib/paths) carries the story of why acceptance is generous.
   */
  const acceptDrag = (e: ReactDragEvent): void => {
    if (!maybeFiles(e) && !e.dataTransfer.types.includes(TASK_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDropFiles = (e: ReactDragEvent): void => {
    // Unconditional: an unprevented file drop makes Chromium navigate the
    // window to the file, which would take the whole app down with it.
    e.preventDefault()
    setDropping(false)
    // A task card first: dealing work onto the wall is the tray's whole point.
    // Same contract as the pane version in TerminalPane — typed, flattened,
    // never submitted, card off the tray only once the text really landed.
    const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE)
    if (taskId) {
      const card = (workspaceTasks ?? []).find((t) => t.id === taskId)
      if (!card) return
      if (!zoomed && !interactive) onToggleInteract(paneId)
      terminalHost.focus(paneId)
      requestAnimationFrame(() => {
        if (terminalHost.type(paneId, `${card.text} `)) actions.removeTask(card.id)
        else actions.setNotice('That pane has no live shell to hand the task to')
      })
      return
    }
    const quoted = droppedFilePaths(e).map((p) => `"${p}"`)
    if (quoted.length === 0) return
    /*
     * Focus first, text a frame later — the path arrives as a bracketed
     * paste, and an agent that was just told its terminal lost focus (DECSET
     * 1004) will drop it. See the same dance in TerminalPane. On the wall,
     * taking focus *is* interactive mode: the tile you just handed a file to
     * is the tile you are now talking to, so it should also take the keys
     * for the Enter that usually follows. A zoomed tile is already focused.
     */
    if (!zoomed && !interactive) onToggleInteract(paneId)
    terminalHost.focus(paneId)
    requestAnimationFrame(() => terminalHost.paste(paneId, `${quoted.join(' ')} `))
  }

  const statusLabel = paneStatusLabel(runtime)
  const placed = !zoomed && rect
  /** This tile was pointed the other way from the rest of the wall by hand. */
  const override = !zoomed && refit !== lifesize

  return (
    <section
      className="mtile"
      data-pane-id={paneId}
      data-zoomed={zoomed}
      data-selected={selected}
      data-interactive={interactive ? 'true' : undefined}
      data-placed={placed ? 'true' : undefined}
      data-refit={refit ? 'true' : undefined}
      data-override={override ? 'true' : undefined}
      data-status={runtime.status}
      data-dropping={dropping ? 'true' : undefined}
      onDragEnter={acceptDrag}
      onDragOver={acceptDrag}
      onDragLeave={(e) => {
        // Ignore the flurry of leave events from crossing child elements.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={onDropFiles}
      style={
        {
          '--pane-accent': profile.accent,
          ...(placed ? { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` } : {})
        } as React.CSSProperties
      }
    >
      <header
        className="mtile__head"
        onPointerDown={(e) => {
          if (zoomed) return
          if ((e.target as HTMLElement).closest('button')) return
          onBeginDrag(paneId, e, 'move', NO_EDGES)
        }}
        onDoubleClick={(e) => {
          if (zoomed) return
          if ((e.target as HTMLElement).closest('button')) return
          onToggleFit(paneId)
        }}
        title={
          zoomed
            ? undefined
            : lifesize
              ? 'Double-click: show this one shrunk to fit instead of at full size'
              : 'Double-click: show this one at full size, cropped to the tile'
        }
      >
        {zoomed ? (
          <button type="button" className="ghost-btn mtile__back" title="Back to the mosaic (Esc)" onClick={onBack}>
            <Icon name="chevronLeft" size={12} />
            Mosaic
          </button>
        ) : (
          <AgentBadge profile={profile} size="sm" />
        )}

        <span className="mtile__title truncate">{paneDisplayTitle(profile, cell.leaf.title)}</span>
        {permChip ? (
          <span className="mtile__perm mono" data-danger={permChip.danger ? 'true' : undefined}>
            {permChip.label}
          </span>
        ) : null}
        {/* Only ever says how this tile differs from the wall — see toggleFit. */}
        {override ? <span className="mtile__refit mono">{refit ? 'full size' : 'scaled'}</span> : null}
        <span className="mtile__tab truncate">{cell.tab.title}</span>
        <ActivityDot paneId={paneId} status={runtime.status} />
        {statusLabel ? <span className="mtile__status mono">{statusLabel}</span> : null}

        <div className="mtile__actions">
          {dead ? (
            <button
              type="button"
              className="ghost-btn mtile__action"
              title="Relaunch this session"
              onClick={() => actions.restartPane(paneId)}
            >
              <Icon name="restart" size={12} />
            </button>
          ) : null}
          {zoomed ? null : (
            <button
              type="button"
              className="ghost-btn mtile__action"
              data-open={interactive ? 'true' : undefined}
              title={
                interactive
                  ? 'Stop typing in this tile (Esc)'
                  : 'Type in this tile without leaving the mosaic'
              }
              onClick={() => onToggleInteract(paneId)}
            >
              <Icon name="terminal" size={12} />
            </button>
          )}
          <button
            type="button"
            className="ghost-btn mtile__action"
            title="Open in tab view"
            onClick={() => onOpenInTab(paneId)}
          >
            <Icon name="expand" size={12} />
          </button>
        </div>
      </header>

      <div className="mtile__stage" ref={stageRef}>
        <div className="mtile__natural" ref={naturalRef} />
      </div>

      {/*
        On the wall the terminal is scenery: this sheet sits over it so a click
        zooms in rather than dropping a cursor into somebody's shell. Zoomed, it
        is gone and the terminal takes its own clicks again. Same for a tile
        being typed into — the whole point of interactive mode is that the
        terminal takes the clicks.
      */}
      {zoomed || interactive ? null : (
        <button
          type="button"
          className="mtile__hit"
          title={`Zoom in — ${paneDisplayTitle(profile, cell.leaf.title)}`}
          aria-label={`Zoom in on ${paneDisplayTitle(profile, cell.leaf.title)} in ${cell.tab.title}`}
          onPointerEnter={() => onSelect(paneId)}
          onFocus={() => onSelect(paneId)}
          onClick={() => onZoom(paneId)}
        />
      )}

      {zoomed
        ? null
        : HANDLES.map((handle) => (
            <div
              key={handle.key}
              className="mtile__grip"
              data-edge={handle.key}
              onPointerDown={(e) => onBeginDrag(paneId, e, 'resize', handle.edges)}
            />
          ))}
    </section>
  )
}

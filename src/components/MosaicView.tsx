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
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import { terminalHost, type PaneGeometry, type TerminalSpec } from '@/lib/terminals'
import { useForeman } from '@/state/Foreman'
import { askToClose } from './CloseConfirm'
import { enterOnce, reducedMotion, useFlipChildren } from '@/lib/motion'
import { usePaneActivity } from '@/lib/paneActivity'
import { useCallSign } from '@/hooks/useHub'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { ActivityDot } from './ActivityDot'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { StateChip } from './shell/StateChip'
import './MosaicView.css'

/**
 * The mosaic: every pane in the project, from every tab, as a small live tile.
 *
 * The tiles are the real terminals — not snapshots, not a second render of the
 * scrollback. How they are drawn is the wall's one legibility setting, and it
 * applies to every tile at once, and to the wall strip's tiles too (Settings →
 * Appearance, or the Aa button in the menu's Tools):
 *
 *   life-size  the default. Each tile is a window onto its terminal at scale 1:
 *              the same type size as Full screen, cropped to the tile and anchored
 *              at the bottom-left, where the prompt and the live region are.
 *              Nothing is ever resized to achieve this — a ConPTY resize
 *              reflows destructively, and a glance must not rewrite a pane.
 *   scaled     each tile is a scale model — the PTY keeps the cols/rows it had
 *              in Full screen and the whole picture is shrunk with a CSS
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
 *   custom  you place them. Drag a header, drag an edge. The first move or resize seeds custom
 *           mode from exactly where the auto grid had put everything, so
 *           crossing over is invisible; "Reset to grid" crosses back.
 *
 * Click a tile and that terminal goes full screen (the Full screen view — its
 * tab, splits and all, under the wall strip); Ctrl+G comes back. The
 * terminal button in a tile's header types into it right there on the wall
 * instead, at the pane's own cols and rows, however small the tile is; Esc or a
 * click on the empty wall stops. The X top-right closes the terminal.
 * Double-click a tile's header and its terminal stops being a scale model and
 * refits to the box for real — see MosaicTile.
 */

/** One tile: a pane plus the tab it came from, which the header names. */
export interface Cell {
  leaf: PaneLeaf
  tab: TerminalTab
}

/** Every pane in the workspace, from every tab, in tab order. */
export function cellsOf(tabs: TerminalTab[]): Cell[] {
  return tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab })))
}

/**
 * One scale for a whole row of scale-model tiles, taken from the largest pane
 * among them — see the note on `reference` in MosaicView.
 */
export function wallReference(cells: Cell[]): PaneGeometry {
  let width = 1
  let height = 1
  for (const cell of cells) {
    const g = terminalHost.geometryFor(cell.leaf.id)
    if (g.width > width) width = g.width
    if (g.height > height) height = g.height
  }
  return { width, height }
}

/**
 * Close one terminal from anywhere in the project — a Wall tile or a strip tile
 * — with the same actions the tab strip's X and the pane header's X used.
 *
 * `closePane` only ever acts inside the active tab (and closes the active tab
 * outright when it holds one pane), so a pane in another tab is revealed first
 * and the tab you were on is put back afterwards: closing a tile must not also
 * change what Full screen is showing. A pane alone in its tab closes the tab,
 * exactly as its old tab X did.
 *
 * An agent that is working — printing, mid-turn — or that Foreman is driving
 * is asked about first (CloseConfirm): one click, or a stray middle-click on a
 * strip tile, used to kill a job mid-task with no way back. An idle pane closes
 * at once.
 */
export function useCloseTerminal(): (paneId: string) => void {
  const { state, actions } = useApp()
  const foreman = useForeman()
  const workspace = useActiveWorkspace()
  return useCallback(
    (paneId: string) => {
      const tab = workspace.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId))
      if (!tab) return
      const close = (): void => {
        if (countLeaves(tab.root) === 1) {
          actions.closeTab(tab.id)
          return
        }
        const back = workspace.activeTabId
        actions.revealPane(paneId)
        actions.closePane(paneId)
        if (back && back !== tab.id) actions.selectTab(back)
      }
      const driven = foreman.paneState(paneId).status
      const why =
        driven === 'starting' || driven === 'driving' || driven === 'waiting'
          ? 'is being driven by Foreman'
          : terminalHost.isBusy(paneId)
            ? 'is working'
            : null
      if (!why) {
        close()
        return
      }
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      const name = paneDisplayTitle(resolveProfile(state.settings.agentProfiles, leaf?.profileId ?? ''), leaf?.title ?? '')
      // The question sits on the X that was pressed — or on the tile, for a
      // middle-click, which leaves no button with the focus.
      const tiles = Array.from(document.querySelectorAll<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`))
      const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const tile = tiles.find((t) => pressed && t.contains(pressed)) ?? tiles[0]
      const anchor =
        (pressed && tile?.contains(pressed) ? pressed : null) ??
        tile?.querySelector<HTMLElement>('[aria-label^="Close"]') ??
        tile ??
        document.body
      askToClose({ name, why, anchor, close })
    },
    [actions, foreman, state.settings.agentProfiles, workspace]
  )
}

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
  /** The tile's own text-mode override, carried through the move. */
  fit: boolean | undefined
  /** The wall was still on the auto grid when this drag started. */
  seed: Record<string, MosaicTileRect> | null
  onMove: (e: PointerEvent) => void
  onUp: (e: PointerEvent) => void
}

export function MosaicView({
  project,
  workspace,
  onNewTerminal,
  onOpenFull
}: {
  project: Project
  workspace: Workspace
  onNewTerminal: () => void
  /** Show this pane in Full screen — what a click on a tile does. */
  onOpenFull: (paneId: string) => void
}): ReactNode {
  const { state, actions } = useApp()
  const closeTerminal = useCloseTerminal()

  const cells = useMemo<Cell[]>(() => cellsOf(workspace.tabs), [workspace.tabs])

  const mosaic = workspace.mosaic ?? emptyMosaic()
  const custom = mosaic.mode === 'custom'

  /** The wall's default: refit every terminal to its tile at life-size type. */
  const lifesize = state.settings.mosaicText !== 'scaled'

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
  const canvasRef = useRef<HTMLDivElement | null>(null)
  // Tiles re-flow when one arrives or leaves; the survivors glide to their new
  // cells rather than jumping. Keyed on membership, never on a drag.
  useFlipChildren(canvasRef, cells.map((c) => c.leaf.id).join(','))
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [area, setArea] = useState({ width: 960, height: 600 })
  const [dropHint, setDropHint] = useState(false)

  // The camera follows the selection: a pane picked from the switcher, or by
  // voice, that is off the edge of a freeform wall glides into view.
  useEffect(() => {
    if (!selectedId || !custom) return
    const tile = wallRef.current?.querySelector<HTMLElement>(`.mtile[data-pane-id="${selectedId}"]`)
    tile?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
  }, [custom, selectedId])

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
  // Re-measured whenever the wall's membership changes — which is also the
  // only time a tile is mounted and could need a different scale.
  const reference = useMemo<PaneGeometry>(() => wallReference(cells), [cells])

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
        fit: tiles[paneId]?.fit,
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
        if (session.fit !== undefined) tile.fit = session.fit
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

  const openFull = useCallback(
    (paneId: string) => {
      // Leaving the wall is also leaving whatever tile was being typed into —
      // hand the caret back so the keyboard follows.
      if (interactiveId) terminalHost.blur(interactiveId)
      setInteractiveId(null)
      onOpenFull(paneId)
    },
    [interactiveId, onOpenFull]
  )

  /**
   * Enter or leave a tile's in-place interactive mode: its terminal takes the
   * keyboard right there on the wall, without leaving the mosaic. One tile at a
   * time — entering a second hands focus over rather than leaving two live.
   * Entering *is* selecting, so the app's current pane tracks the tile you are
   * talking to.
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

  /**
   * A press on the empty wall — between tiles, not on one — stops typing in the
   * tile that was taking the keys, the pointer's version of Esc. The wall's own
   * scrollbars are not "the wall": dragging one must not end the typing.
   */
  const leaveOnWall = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!interactiveId || e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.mtile')) return
      const wall = wallRef.current
      if (wall && target === wall) {
        const box = wall.getBoundingClientRect()
        if (e.clientX - box.left >= wall.clientWidth || e.clientY - box.top >= wall.clientHeight) return
      }
      terminalHost.blur(interactiveId)
      setInteractiveId(null)
    },
    [interactiveId]
  )

  /* ------------------------------------------------------- keyboard: wall */

  useEffect(() => {
    // While a tile is being typed into, the keys belong to it — arrows must
    // reach the shell, not move the selection ring.
    if (interactiveId) return
    // Settings, a sheet or the composer on top: the arrows belong to them.
    if (state.view !== 'terminals') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (document.activeElement?.closest('[data-shell-overlay]')) return
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLSelectElement
      )
        return
      const index = cells.findIndex((c) => c.leaf.id === selectedId)
      if (index < 0) return

      if (e.key === 'Enter') {
        e.preventDefault()
        openFull(cells[index]!.leaf.id)
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
  }, [cells, columns, custom, interactiveId, openFull, selectedId, state.view, tiles])

  /* ---------------------------------------------------- keyboard: interact */

  useEffect(() => {
    if (!interactiveId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      // A full-screen TUI owns Escape — in vim it means "leave insert mode" —
      // so it is only stolen when nobody is in one.
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

  /* ------------------------------------------------------------- render */

  if (cells.length === 0) {
    return (
      <div className="mosaic mosaic--empty">
        <EmptyState
          icon="viewMosaic"
          eyebrow={project.name}
          title="Nothing running yet"
          body="The Wall shows every session in this project at once. Open one and it turns up here."
          action={
            <button type="button" className="cta-btn" onClick={onNewTerminal}>
              <Icon name="plus" size={14} />
              Open a terminal
            </button>
          }
          hint="Ctrl + G  ·  full screen"
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
        freeform wall needs (Reset to grid) lives in the menu's Tools, beside
        the other terminal tools.
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
        onPointerDown={leaveOnWall}
      >
        <div
          ref={canvasRef}
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
              selected={cell.leaf.id === selectedId}
              interactive={interactiveId === cell.leaf.id}
              {...(custom && tiles[cell.leaf.id] ? { rect: tiles[cell.leaf.id]! } : {})}
              onOpenFull={openFull}
              onClose={closeTerminal}
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

/* ------------------------------------------------------------------- peek */

/**
 * A pane's live picture at a fixed size: the Wall's tiles and the wall strip's
 * both draw their terminal through this.
 *
 * The natural box is the pane's full-size geometry, pinned in pixels. The
 * terminal is attached into that (attachPeek) and never resized; only the box's
 * transform changes, so glancing at a pane can never reflow it.
 *
 * A pane can only be attached in one place at a time: whoever mounts a
 * PeekStage for a pane must not also be showing that pane full size.
 */
export function PeekStage({
  cell,
  project,
  refit,
  reference,
  interactive = false,
  className = 'mtile__stage'
}: {
  cell: Cell
  project: Project
  /** Life-size crop (true) or the scale model (false) — see below. */
  refit: boolean
  /** The shared scaling reference for scale-model tiles. */
  reference: PaneGeometry
  /** The terminal is being typed into in place — mouse coords get translated. */
  interactive?: boolean
  className?: string
}): ReactNode {
  const { state } = useApp()
  const paneId = cell.leaf.id
  const profile = resolveProfile(state.settings.agentProfiles, cell.leaf.profileId)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const naturalRef = useRef<HTMLDivElement | null>(null)

  const spec: TerminalSpec = {
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
  const specRef = useRef<TerminalSpec>(spec)
  specRef.current = spec

  /*
   * Read once per mount — a live pane's geometry does not move while it is
   * sitting in a tile.
   */
  const geometry = useMemo(() => terminalHost.geometryFor(paneId), [paneId])

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
   * Nothing on a peek uses WebGL.
   *
   * Every surface here is scaled, and a scaled canvas is a resampled bitmap —
   * smeared shrunk, soft blown up — where xterm's DOM rows are real text that
   * Chromium re-rasterises crisply at whatever scale we hand it. It also
   * sidesteps the context ceiling entirely: a browser will not hand out sixteen
   * live WebGL contexts, and the ones it takes back it takes back mid-frame.
   * Measured, the DOM renderer holds 60fps with sixteen live tiles, so there is
   * nothing to buy back. WebGL belongs to Full screen, where scale is always 1.
   */
  useEffect(() => {
    terminalHost.setWebgl(paneId, false)
  }, [paneId])

  /*
   * The mouse, on a terminal drawn smaller or larger than it really is.
   *
   * A scale model is a CSS transform, and xterm does not know: it turns a
   * pointer into a cell as (clientX − the screen's on-screen left) ÷ its
   * unscaled cell width (getCoords, @xterm/xterm src/browser/input/Mouse.ts),
   * so at half size a drag selects the cells at twice the distance from the
   * corner. Rather than give up the transform — the only way a wall of
   * terminals resizes at compositor speed and never reflows — every mouse event
   * aimed at this terminal has its clientX/clientY moved to where the same spot
   * would be at scale 1, before xterm reads it. Scale 1 means the screen's
   * on-screen width equals its layout width, and then nothing is touched.
   *
   * Window, capture phase: the first listener anywhere, so xterm's own —
   * including the document ones it adds for the duration of a selection drag,
   * which is why a press that started in here keeps being translated after the
   * pointer leaves the tile. Only coordinates change; the event, its target
   * and its default action are left exactly as they were. Nothing here writes
   * to the PTY, so selecting never claims the pane's grid.
   */
  useEffect(() => {
    if (!interactive) return
    const box = naturalRef.current
    if (!box) return
    let pressed = false
    const translate = (e: MouseEvent): void => {
      const inside = e.target instanceof Node && box.contains(e.target)
      if (e.type === 'mousedown' && inside) pressed = true
      const mine = inside || pressed
      if (e.type === 'mouseup' || (e.type === 'mousemove' && e.buttons === 0)) pressed = false
      if (!mine) return
      const screen = box.querySelector<HTMLElement>('.xterm-screen')
      if (!screen || screen.offsetWidth === 0 || screen.offsetHeight === 0) return
      const r = screen.getBoundingClientRect()
      const sx = r.width / screen.offsetWidth
      const sy = r.height / screen.offsetHeight
      if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return
      const x = r.left + (e.clientX - r.left) / sx
      const y = r.top + (e.clientY - r.top) / sy
      Object.defineProperty(e, 'clientX', { configurable: true, value: x })
      Object.defineProperty(e, 'clientY', { configurable: true, value: y })
    }
    const types = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'] as const
    for (const t of types) window.addEventListener(t, translate, true)
    return () => {
      for (const t of types) window.removeEventListener(t, translate, true)
    }
  }, [interactive])

  /*
   * Fit into whatever the tile ended up being.
   *
   * Written straight onto the DOM rather than through React state: a resize
   * drag changes this box sixty times a second, and a re-render per frame per
   * tile is the difference between a wall that tracks the pointer and one that
   * lurches. Reads are coalesced to one per frame for the same reason.
   */
  useEffect(() => {
    const stage = stageRef.current
    const el = naturalRef.current
    if (!stage || !el) return
    let raf = 0

    const apply = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (w < 4 || h < 4) return

      if (refit) {
        /*
         * Life-size is a *window*, not a refit: the terminal keeps the exact
         * cols and rows it had in Full screen and the tile shows its
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

      // The scale model hangs off the top-left, so a row of terminals all
      // start on the same line and the eye can run along them.
      el.style.width = `${geometry.width}px`
      el.style.height = `${geometry.height}px`
      const scale = Math.min(1, w / reference.width, h / reference.height)
      el.style.transform = `scale(${scale})`
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
      ro.disconnect()
    }
  }, [geometry, reference, refit])

  return (
    <div className={className} ref={stageRef}>
      <div className="mtile__natural" ref={naturalRef} />
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
  selected,
  interactive,
  rect,
  onOpenFull,
  onClose,
  onSelect,
  onBeginDrag,
  onToggleFit,
  onToggleInteract
}: {
  cell: Cell
  project: Project
  /** The wall's shared scaling reference — ignored when refitted. */
  reference: PaneGeometry
  /** The wall's default: refit rather than scale. A tile may override it. */
  lifesize: boolean
  selected: boolean
  /** This tile is being typed into in place — see toggleInteract. */
  interactive: boolean
  /** Where this tile sits on a freeform wall. Absent = the auto grid places it. */
  rect?: MosaicTileRect
  onOpenFull: (paneId: string) => void
  /** Close this terminal — the X top-right. */
  onClose: (paneId: string) => void
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
  const activity = usePaneActivity(paneId, runtime)
  const callSign = useCallSign(paneId)
  const dead = isPaneDead(runtime)
  const permChip = permissionChip(profile, leafPermissionMode(cell.leaf))
  const [dropping, setDropping] = useState(false)

  const tileRef = useRef<HTMLElement | null>(null)

  // Arrive with the one-time pop of a brand-new pane.
  useLayoutEffect(() => {
    const el = tileRef.current
    if (el) enterOnce(paneId, el)
  }, [paneId])

  /**
   * Life-size: the tile is a scale-1 window onto the terminal, cropped to the
   * tile's box and anchored bottom-left, where the live region is. The
   * alternative is the scale model: the whole picture shrunk with a transform,
   * everything visible, at the price of type nobody can read past a few tiles.
   * Neither ever resizes the terminal — glancing at a pane must not reflow
   * somebody's vim, and a ConPTY reflow eats scrollback (see PeekStage).
   *
   * The wall's setting decides; a tile the user double-clicked has its own
   * answer in `rect.fit` and keeps it, remembered per project.
   */
  const refit = rect?.fit ?? lifesize

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

  /* --------------------------------------------------------- dropped files */

  /*
   * Same contract as a Full screen pane: a file dropped on a tile types its
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
      if (!interactive) onToggleInteract(paneId)
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
     * for the Enter that usually follows.
     */
    if (!interactive) onToggleInteract(paneId)
    terminalHost.focus(paneId)
    requestAnimationFrame(() => terminalHost.paste(paneId, `${quoted.join(' ')} `))
  }

  const statusLabel = paneStatusLabel(runtime)
  const placed = rect
  /** This tile was pointed the other way from the rest of the wall by hand. */
  const override = refit !== lifesize
  const name = paneDisplayTitle(profile, cell.leaf.title)

  return (
    <section
      ref={tileRef}
      className="mtile"
      data-pane-id={paneId}
      data-flip={paneId}
      data-state={activity.state}
      data-selected={selected}
      data-interactive={interactive ? 'true' : undefined}
      data-placed={placed ? 'true' : undefined}
      data-refit={refit ? 'true' : undefined}
      data-override={override ? 'true' : undefined}
      data-status={runtime.status}
      data-dropping={dropping ? 'true' : undefined}
      data-tint={cell.tab.color ? 'true' : undefined}
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
          // The tab's own colour, when it was given one — the wall strip's tint, here too.
          ...(cell.tab.color ? { '--tab-tint': cell.tab.color } : {}),
          ...(placed ? { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` } : {})
        } as React.CSSProperties
      }
    >
      <header
        className="mtile__head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onBeginDrag(paneId, e, 'move', NO_EDGES)
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onToggleFit(paneId)
        }}
        title={
          lifesize
            ? 'Double-click: show this one shrunk to fit instead of at full size'
            : 'Double-click: show this one at full size, cropped to the tile'
        }
      >
        <AgentBadge profile={profile} size="sm" />

        <span className="mtile__title truncate">{callSign ?? name}</span>
        {permChip ? (
          <span className="mtile__perm mono" data-danger={permChip.danger ? 'true' : undefined}>
            {permChip.label}
          </span>
        ) : null}
        {/* Only ever says how this tile differs from the wall — see toggleFit. */}
        {override ? <span className="mtile__refit mono">{refit ? 'full size' : 'scaled'}</span> : null}
        <span className="mtile__tab truncate" title={statusLabel || undefined}>
          {callSign ? `${name} · ${cell.tab.title}` : cell.tab.title}
        </span>
        {/* The halo's word: which tile the keyboard is on, and how. */}
        {interactive || selected ? (
          <span className="pane__active">{interactive ? 'Typing' : 'Selected'}</span>
        ) : null}
        <StateChip activity={activity} compact />
        <ActivityDot paneId={paneId} status={runtime.status} />

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
          <button
            type="button"
            className="ghost-btn mtile__action"
            data-open={interactive ? 'true' : undefined}
            title={interactive ? 'Stop typing in this tile (Esc)' : 'Type in this tile without leaving the Wall'}
            onClick={() => onToggleInteract(paneId)}
          >
            <Icon name="terminal" size={12} />
          </button>
          <button
            type="button"
            className="ghost-btn mtile__action"
            title="Full screen"
            onClick={() => onOpenFull(paneId)}
          >
            <Icon name="expand" size={12} />
          </button>
        </div>

        {/* Always there, never under the hover fade: closing is the one action
            a tile must never hide. */}
        <button
          type="button"
          className="ghost-btn mtile__close"
          data-danger="true"
          aria-label={`Close ${name}`}
          title={`Close ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose(paneId)
          }}
        >
          <Icon name="close" size={11} />
        </button>
      </header>

      <PeekStage cell={cell} project={project} refit={refit} reference={reference} interactive={interactive} />

      {/*
        On the wall the terminal is scenery: this sheet sits over it so a click
        opens the pane full screen rather than dropping the press on whatever
        cell of the picture was under it. Typing in place (the header's
        terminal button), the sheet is gone and the terminal takes its own
        clicks again.
      */}
      {interactive ? null : (
        <button
          type="button"
          className="mtile__hit"
          title={`Click for full screen — ${name}`}
          aria-label={`Open ${name} in ${cell.tab.title} full screen`}
          onPointerEnter={() => onSelect(paneId)}
          onFocus={() => onSelect(paneId)}
          onClick={() => onOpenFull(paneId)}
        />
      )}

      {HANDLES.map((handle) => (
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

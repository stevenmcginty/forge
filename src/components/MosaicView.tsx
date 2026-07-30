import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { PaneLeaf, Project, TerminalTab, Workspace } from '@shared/types'
import { isPaneDead, paneStatusLabel, usePaneRuntime } from '@/hooks/usePaneRuntime'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost, type PaneGeometry, type TerminalSpec } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import { ActivityDot } from './ActivityDot'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import './MosaicView.css'

/**
 * The mosaic: every pane in the project, from every tab, as a small live tile.
 *
 * The tiles are the real terminals — not snapshots, not a second render of the
 * scrollback. Each one is laid out at the size it had in tab view and then
 * shrunk with a CSS transform, which is the whole trick: the PTY keeps its
 * cols/rows, so nothing reflows and a full-screen TUI carries on drawing into
 * the same grid it always had. You are looking at a scale model of the real
 * thing.
 *
 * Tiles are read-only. Click one and it blows up to full size in place, where
 * the keyboard works; Esc drops you back to the wall.
 */

/** One tile: a pane plus the tab it came from, which the header names. */
interface Cell {
  leaf: PaneLeaf
  tab: TerminalTab
}

/**
 * Column counts chosen so tiles stay roughly terminal-shaped as the wall fills
 * up, rather than growing ever-wider letterboxes.
 */
function columnsFor(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count <= 4) return 2
  if (count <= 6) return 3
  if (count <= 9) return 3
  return 4
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

  const zoomId = state.mosaicZoom
  const zoomCell = cells.find((c) => c.leaf.id === zoomId) ?? null

  // A zoom can outlive its pane (closed from a shortcut, or the tab went away).
  useEffect(() => {
    if (zoomId && !zoomCell) actions.setMosaicZoom(null)
  }, [actions, zoomCell, zoomId])

  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
  const [picked, setPicked] = useState<string | null>(null)
  const selectedId =
    (picked && cells.some((c) => c.leaf.id === picked) ? picked : null) ??
    activeTab?.activePaneId ??
    cells[0]?.leaf.id ??
    null

  const columns = columnsFor(cells.length)

  /*
   * One scale for the whole wall, taken from the largest pane on it.
   *
   * Scaling each tile to its own pane would give every tile a different text
   * size — a pane that was one of five in a split would come out twice as big
   * as one that had a tab to itself — and a wall you have to refocus on for
   * every tile is not a wall you can scan. Sizing everything against the
   * biggest pane keeps the type uniform and still tells the truth: a tile
   * showing a small pane simply covers less of its tile.
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

  const zoom = useCallback(
    (paneId: string) => {
      // Zooming *is* selecting: the pane becomes the app's current pane, so
      // Ctrl+W and friends act on the thing you are looking at.
      actions.revealPane(paneId)
      actions.setMosaicZoom(paneId)
    },
    [actions]
  )

  const openInTab = useCallback(
    (paneId: string) => {
      actions.revealPane(paneId)
      actions.setViewMode('tabs')
    },
    [actions]
  )

  /* ------------------------------------------------------- keyboard: wall */

  useEffect(() => {
    if (zoomCell) return
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

      const step =
        e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? columns : e.key === 'ArrowUp' ? -columns : 0
      if (step === 0) return
      e.preventDefault()
      const next = index + step
      if (next < 0 || next >= cells.length) return
      setPicked(cells[next]!.leaf.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cells, columns, selectedId, zoom, zoomCell])

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
          zoomed
          selected={false}
          onZoom={zoom}
          onOpenInTab={openInTab}
          onBack={() => actions.setMosaicZoom(null)}
          onSelect={setPicked}
        />
      </div>
    )
  }

  return (
    <div className="mosaic">
      <div className="mosaic__wall" style={{ '--mosaic-cols': columns } as React.CSSProperties}>
        {cells.map((cell) => (
          <MosaicTile
            key={cell.leaf.id}
            cell={cell}
            project={project}
            reference={reference}
            zoomed={false}
            selected={cell.leaf.id === selectedId}
            onZoom={zoom}
            onOpenInTab={openInTab}
            onSelect={setPicked}
          />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- tile */

function MosaicTile({
  cell,
  project,
  reference,
  zoomed,
  selected,
  onZoom,
  onOpenInTab,
  onBack,
  onSelect
}: {
  cell: Cell
  project: Project
  /** The wall's shared scaling reference — ignored when zoomed. */
  reference: PaneGeometry
  zoomed: boolean
  selected: boolean
  onZoom: (paneId: string) => void
  onOpenInTab: (paneId: string) => void
  onBack?: () => void
  onSelect: (paneId: string) => void
}): ReactNode {
  const { state, actions } = useApp()
  const paneId = cell.leaf.id
  const profile = resolveProfile(state.settings.agentProfiles, cell.leaf.profileId)
  const runtime = usePaneRuntime(paneId)
  const dead = isPaneDead(runtime)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const naturalRef = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState({ scale: 0, dx: 0, dy: 0 })

  const specRef = useRef<TerminalSpec>({
    cwd: project.path,
    bootstrapCommand: profile.command,
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent
  })
  specRef.current = {
    cwd: project.path,
    bootstrapCommand: profile.command,
    fontSize: state.settings.terminalFontSize,
    fontFamily: state.settings.terminalFontFamily,
    accent: profile.accent
  }

  /*
   * The natural box is the pane's full-size geometry, pinned in pixels. The
   * terminal is attached into that and never resized; only the box's transform
   * changes. Read once per mount — a live pane's geometry does not move while
   * it is sitting in a tile.
   */
  const geometry = useMemo(() => terminalHost.geometryFor(paneId), [paneId])

  useLayoutEffect(() => {
    const el = naturalRef.current
    if (!el) return
    el.style.width = `${geometry.width}px`
    el.style.height = `${geometry.height}px`
    terminalHost.attachPeek(paneId, el, specRef.current)
    return () => terminalHost.detach(paneId)
  }, [geometry, paneId])

  /*
   * Renderers: the zoomed tile gets WebGL, the wall does not. A browser only
   * hands out a dozen or so contexts per process, and sixteen tiles all asking
   * at once just means the losers get their context yanked mid-frame. The DOM
   * renderer is also the honest choice for a shrunken tile — real text scales,
   * a resampled canvas smears.
   */
  useEffect(() => {
    terminalHost.setWebgl(paneId, zoomed)
    if (zoomed) terminalHost.focus(paneId)
  }, [paneId, zoomed])

  /*
   * Fit into whatever the tile ended up being. On the wall we measure against
   * the shared reference so every tile lands on the same scale; zoomed, there
   * is only one tile, so it may fill the area with its own geometry — capped at
   * 1, because blowing a terminal up past life size just makes it blurry.
   */
  const against = zoomed ? geometry : reference
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (w < 4 || h < 4) return
      const scale = Math.min(1, w / against.width, h / against.height)
      /*
       * Tiles hang off the top-left, so the wall's terminals all start on the
       * same line and the eye can run down them. A zoomed pane is centred
       * instead: at natural scale a pane that was one of five in a split does
       * not come close to filling the area, and shoved into a corner that reads
       * as a layout bug rather than as the letterboxing it is.
       */
      const dx = zoomed ? Math.max(0, (w - geometry.width * scale) / 2) : 0
      const dy = zoomed ? Math.max(0, (h - geometry.height * scale) / 2) : 0
      setFit({ scale, dx, dy })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [against, geometry, zoomed])

  const statusLabel = paneStatusLabel(runtime)

  return (
    <section
      className="mtile"
      data-pane-id={paneId}
      data-zoomed={zoomed}
      data-selected={selected}
      data-status={runtime.status}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
    >
      <header className="mtile__head">
        {zoomed ? (
          <button type="button" className="ghost-btn mtile__back" title="Back to the mosaic (Esc)" onClick={onBack}>
            <Icon name="chevronLeft" size={12} />
            Mosaic
          </button>
        ) : (
          <AgentBadge profile={profile} size="sm" />
        )}

        <span className="mtile__title truncate">{paneDisplayTitle(profile, cell.leaf.title)}</span>
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
        <div
          className="mtile__natural"
          ref={naturalRef}
          style={{
            transform: `translate(${fit.dx}px, ${fit.dy}px) scale(${fit.scale})`,
            opacity: fit.scale > 0 ? 1 : 0
          }}
        />
      </div>

      {/*
        On the wall the terminal is scenery: this sheet sits over it so a click
        zooms in rather than dropping a cursor into somebody's shell. Zoomed, it
        is gone and the terminal takes its own clicks again.
      */}
      {zoomed ? null : (
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
    </section>
  )
}

import type { MosaicRect, MosaicState, MosaicTile } from '@shared/types'

/**
 * The geometry of the freeform mosaic wall.
 *
 * Everything here is pure arithmetic on boxes — no DOM, no React — so the rules
 * that decide where a tile lands can be tested on their own (scripts/mosaic-check.mjs)
 * rather than only by dragging things about and squinting.
 *
 * The wall's coordinate space is wall pixels: origin at the top-left of the
 * scrolling canvas, y growing downwards, unaffected by scroll position. A tile
 * is a plain {x, y, w, h}.
 *
 * Two rules hold everywhere:
 *
 *   1. Tiles never overlap. A move that would land on top of something is
 *      nudged to the nearest free spot; a resize that would grow into something
 *      is stopped at its edge.
 *   2. Edges land on an 8px lattice, unless they land on a *neighbour's* edge
 *      first — within 6px a tile is pulled flush against the tile beside it, so
 *      a wall built by hand still comes out aligned.
 */

/** The lattice every edge snaps to when nothing better is nearby. */
export const MOSAIC_GRID = 8

/** Below this a tile is a swatch, not a terminal. */
export const MOSAIC_MIN_W = 200
export const MOSAIC_MIN_H = 140

/** How close a neighbour's edge has to be to capture the one being dragged. */
export const MOSAIC_MAGNET = 6

/** The step between tiles when a whole tab is dropped on the wall at once. */
export const MOSAIC_CASCADE = 24

/** Breathing room left around a seeded grid, and below the lowest tile. */
export const MOSAIC_GAP = 8

/**
 * The drag type a tab carries when it is being pulled out of the strip.
 *
 * A custom MIME type rather than `text/plain` for two reasons: `dataTransfer`
 * will not let anything be *read* during dragover, so the only way the wall can
 * know a tab (rather than a file, or a selection) is overhead is to look at the
 * type list; and it means dropping a tab anywhere else in the app is a no-op
 * rather than a surprise.
 */
export const TAB_DRAG_TYPE = 'application/x-forge-tab'
/** A task card from the delegation tray, riding a drag. The payload is its id. */
export const TASK_DRAG_TYPE = 'application/x-forge-task'

export type MosaicDir = 'left' | 'right' | 'up' | 'down'

/** Which edges a resize is dragging. */
export interface MosaicEdges {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

export const NO_EDGES: MosaicEdges = { left: false, right: false, top: false, bottom: false }

export function emptyMosaic(): MosaicState {
  return { mode: 'auto', tiles: {}, wallTabs: [] }
}

/* ------------------------------------------------------------------ basics */

export function snapToGrid(v: number): number {
  return Math.round(v / MOSAIC_GRID) * MOSAIC_GRID
}

/** Whole pixels, never smaller than a terminal, never off the top or left. */
export function normalise(rect: MosaicRect): MosaicRect {
  const w = Math.max(MOSAIC_MIN_W, Math.round(rect.w))
  const h = Math.max(MOSAIC_MIN_H, Math.round(rect.h))
  return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), w, h }
}

/** Touching edges are not an overlap — flush tiles are the point of magnets. */
export function rectsOverlap(a: MosaicRect, b: MosaicRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function collides(rect: MosaicRect, others: MosaicRect[]): boolean {
  return others.some((o) => rectsOverlap(rect, o))
}

/** Everything on the wall except `paneId`, as bare boxes. */
export function othersOf(tiles: Record<string, MosaicRect>, paneId: string): MosaicRect[] {
  const out: MosaicRect[] = []
  for (const [id, r] of Object.entries(tiles)) if (id !== paneId) out.push(r)
  return out
}

/* ------------------------------------------------------------------ snapping */

function xTargets(others: MosaicRect[]): number[] {
  const out = [0]
  for (const o of others) out.push(o.x, o.x + o.w)
  return out
}

function yTargets(others: MosaicRect[]): number[] {
  const out = [0]
  for (const o of others) out.push(o.y, o.y + o.h)
  return out
}

/**
 * Place one axis of a moving tile: whichever of its two edges is nearest a
 * neighbour's edge wins the magnet; failing that the leading edge takes the
 * lattice.
 */
function snapAxis(lo: number, size: number, targets: number[]): number {
  let best: { pos: number; d: number } | null = null
  for (const t of targets) {
    const dLo = Math.abs(t - lo)
    if (dLo <= MOSAIC_MAGNET && (!best || dLo < best.d)) best = { pos: t, d: dLo }
    const dHi = Math.abs(t - (lo + size))
    if (dHi <= MOSAIC_MAGNET && (!best || dHi < best.d)) best = { pos: t - size, d: dHi }
  }
  return best ? best.pos : snapToGrid(lo)
}

/** One edge of a resize: a neighbour's edge if one is close, else the lattice. */
function snapEdge(v: number, targets: number[]): number {
  let best: { pos: number; d: number } | null = null
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d <= MOSAIC_MAGNET && (!best || d < best.d)) best = { pos: t, d }
  }
  return best ? best.pos : snapToGrid(v)
}

/** Snap a tile that is being *moved*: both axes, size unchanged. */
export function snapMove(rect: MosaicRect, others: MosaicRect[]): MosaicRect {
  return normalise({
    x: snapAxis(rect.x, rect.w, xTargets(others)),
    y: snapAxis(rect.y, rect.h, yTargets(others)),
    w: rect.w,
    h: rect.h
  })
}

/** Snap a tile that is being *resized*: only the edges under the pointer move. */
export function snapResize(rect: MosaicRect, others: MosaicRect[], edges: MosaicEdges): MosaicRect {
  const xs = xTargets(others)
  const ys = yTargets(others)
  let { x, y, w, h } = rect
  if (edges.left) {
    const nx = snapEdge(x, xs)
    w += x - nx
    x = nx
  }
  if (edges.right) w = snapEdge(x + w, xs) - x
  if (edges.top) {
    const ny = snapEdge(y, ys)
    h += y - ny
    y = ny
  }
  if (edges.bottom) h = snapEdge(y + h, ys) - y
  return normalise({ x, y, w, h })
}

/**
 * Stop a resize at the neighbours it is growing into.
 *
 * A resize is not nudged the way a move is — you are holding an edge, and
 * having the whole tile teleport out from under your hand would be absurd. The
 * edge simply stops. Only edges that are actually being dragged are clamped, so
 * pulling a tile's right side never quietly moves its left.
 *
 * `start` is where the tile was before the drag, and it is what decides which
 * side of the tile a neighbour is on. Asking that of the *proposed* box instead
 * is the subtle way to get this wrong: grow a tile downwards far enough and the
 * tile directly below it starts sharing rows with it, at which point it looks
 * like a neighbour blocking the right edge and the width collapses to nothing.
 *
 * Three passes, because growing in two directions at once can meet a tile that
 * is diagonally adjacent — clamping horizontally, then vertically against the
 * new width, then horizontally again against the new height. Each pass only
 * ever shrinks, so it settles.
 */
export function clampResize(
  rect: MosaicRect,
  start: MosaicRect,
  others: MosaicRect[],
  edges: MosaicEdges
): MosaicRect {
  let { x, y, w, h } = rect

  const clampH = (spanY: number, spanH: number): void => {
    for (const o of others) {
      if (!(spanY < o.y + o.h && o.y < spanY + spanH)) continue
      if (edges.right && o.x >= start.x + start.w && o.x < x + w) w = o.x - x
      if (edges.left && o.x + o.w <= start.x && o.x + o.w > x) {
        const nx = o.x + o.w
        w -= nx - x
        x = nx
      }
    }
  }

  const clampV = (spanX: number, spanW: number): void => {
    for (const o of others) {
      if (!(spanX < o.x + o.w && o.x < spanX + spanW)) continue
      if (edges.bottom && o.y >= start.y + start.h && o.y < y + h) h = o.y - y
      if (edges.top && o.y + o.h <= start.y && o.y + o.h > y) {
        const ny = o.y + o.h
        h -= ny - y
        y = ny
      }
    }
  }

  clampH(start.y, start.h)
  clampV(x, w)
  clampH(y, h)
  return normalise({ x, y, w, h })
}

/* --------------------------------------------------------------- collisions */

/**
 * The nearest place `rect` fits without touching anything.
 *
 * Candidates are the positions where the tile sits flush against a neighbour —
 * just left of it, just right of it, above, below — crossed on both axes, plus
 * where it was asked to go. That is a couple of hundred boxes for a realistic
 * wall, evaluated once on pointer-up, and it finds the nearest genuinely free
 * spot without any of the machinery of a packing engine. If every candidate is
 * taken (which needs a pathological wall), the tile drops below everything.
 */
export function freeSpot(rect: MosaicRect, others: MosaicRect[]): MosaicRect {
  const wanted = normalise(rect)
  if (!collides(wanted, others)) return wanted

  const xs = new Set<number>([wanted.x, 0])
  const ys = new Set<number>([wanted.y, 0])
  for (const o of others) {
    xs.add(Math.max(0, o.x - wanted.w))
    xs.add(o.x + o.w)
    ys.add(Math.max(0, o.y - wanted.h))
    ys.add(o.y + o.h)
  }

  let best: { rect: MosaicRect; d: number } | null = null
  for (const x of xs) {
    for (const y of ys) {
      const candidate = { x, y, w: wanted.w, h: wanted.h }
      if (collides(candidate, others)) continue
      const dx = x - wanted.x
      const dy = y - wanted.y
      const d = dx * dx + dy * dy
      if (!best || d < best.d) best = { rect: candidate, d }
    }
  }
  if (best) return best.rect

  // Nowhere free among the neighbours' edges: park it under the lot.
  let floor = 0
  for (const o of others) floor = Math.max(floor, o.y + o.h)
  return { x: wanted.x, y: floor + MOSAIC_GAP, w: wanted.w, h: wanted.h }
}

/* ------------------------------------------------------------- arrangement */

/** Column count for the auto grid — the wall's long-standing shape. */
export function columnsFor(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count <= 4) return 2
  if (count <= 6) return 3
  if (count <= 9) return 3
  return 4
}

/**
 * The auto grid as boxes. Used to seed custom mode when the wall was never
 * rendered (a tab dropped straight onto the view toggle); when it *was*
 * rendered, the real tiles are measured instead, so nothing moves at all.
 */
export function autoRects(ids: string[], area: { width: number; height: number }): Record<string, MosaicRect> {
  const out: Record<string, MosaicRect> = {}
  if (ids.length === 0) return out
  const cols = columnsFor(ids.length)
  const rows = Math.ceil(ids.length / cols)
  const w = Math.max(MOSAIC_MIN_W, Math.floor((area.width - MOSAIC_GAP * (cols - 1)) / cols))
  const h = Math.max(MOSAIC_MIN_H, Math.floor((area.height - MOSAIC_GAP * (rows - 1)) / rows))
  ids.forEach((id, i) => {
    out[id] = normalise({
      x: (i % cols) * (w + MOSAIC_GAP),
      y: Math.floor(i / cols) * (h + MOSAIC_GAP),
      w,
      h
    })
  })
  return out
}

/**
 * Drop a set of tiles at a point, stacked in a cascade so a tab with four panes
 * in it reads as four things rather than one. Each is then pushed to the
 * nearest free spot, so the cascade never buries what is already there.
 */
export function cascadeAt(
  items: Array<{ id: string; w: number; h: number }>,
  point: { x: number; y: number },
  others: MosaicRect[]
): Record<string, MosaicRect> {
  const out: Record<string, MosaicRect> = {}
  const taken = [...others]
  items.forEach((item, i) => {
    const wanted = snapMove(
      { x: point.x + i * MOSAIC_CASCADE, y: point.y + i * MOSAIC_CASCADE, w: item.w, h: item.h },
      taken
    )
    const placed = freeSpot(wanted, taken)
    out[item.id] = placed
    taken.push(placed)
  })
  return out
}

/**
 * Give every id a box, keeping the ones that already have one. A pane opened
 * while the wall is in custom mode has never been placed by anybody, so it
 * takes the first gap big enough for it rather than landing on somebody else.
 */
export function placeMissing(
  tiles: Record<string, MosaicTile>,
  ids: string[],
  size: (id: string) => { w: number; h: number }
): Record<string, MosaicTile> {
  const missing = ids.filter((id) => !tiles[id])
  if (missing.length === 0) return tiles
  const out: Record<string, MosaicTile> = { ...tiles }
  const taken = ids.filter((id) => out[id]).map((id) => out[id]!)
  for (const id of missing) {
    const { w, h } = size(id)
    const placed = freeSpot({ x: 0, y: 0, w, h }, taken)
    out[id] = placed
    taken.push(placed)
  }
  return out
}

/** The canvas the tiles need — at least the viewport, plus room to drop into. */
export function contentBounds(
  tiles: Record<string, MosaicRect>,
  area: { width: number; height: number }
): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const r of Object.values(tiles)) {
    width = Math.max(width, r.x + r.w)
    height = Math.max(height, r.y + r.h)
  }
  return { width: Math.max(area.width, width + MOSAIC_GAP), height: Math.max(area.height, height + MOSAIC_GAP) }
}

/**
 * The tile an arrow key should move the ring to: the nearest one whose centre
 * lies in that direction, sideways drift penalised. Same rule as Alt+arrow
 * between split panes — on a freeform wall, index order means nothing and
 * position means everything.
 */
export function nearestTile(tiles: Record<string, MosaicRect>, fromId: string, dir: MosaicDir): string | null {
  const self = tiles[fromId]
  if (!self) return null
  const ax = self.x + self.w / 2
  const ay = self.y + self.h / 2

  let best: { id: string; score: number } | null = null
  for (const [id, r] of Object.entries(tiles)) {
    if (id === fromId) continue
    const dx = r.x + r.w / 2 - ax
    const dy = r.y + r.h / 2 - ay
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (along <= 1) continue
    const across = Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    const score = along + across * 2
    if (!best || score < best.score) best = { id, score }
  }
  return best?.id ?? null
}

/* ------------------------------------------------------------- persistence */

function isRect(v: unknown): v is MosaicRect {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (['x', 'y', 'w', 'h'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
}

/**
 * Trust nothing that came off disk: a wall is a pile of numbers written by a
 * previous version of the app, and a NaN in one of them is an invisible tile.
 * Boxes for panes that no longer exist are dropped, which is also how the store
 * stays finite across a few hundred closed terminals.
 */
export function sanitiseMosaic(raw: unknown, livePaneIds: Set<string>, liveTabIds: Set<string>): MosaicState {
  const out = emptyMosaic()
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Partial<MosaicState>
  if (src.mode === 'custom') out.mode = 'custom'
  if (src.tiles && typeof src.tiles === 'object') {
    for (const [id, value] of Object.entries(src.tiles)) {
      if (!livePaneIds.has(id) || !isRect(value)) continue
      const tile: MosaicTile = normalise(value)
      if ((value as MosaicTile).fit === true) tile.fit = true
      out.tiles[id] = tile
    }
  }
  if (Array.isArray(src.wallTabs)) {
    out.wallTabs = src.wallTabs.filter((id): id is string => typeof id === 'string' && liveTabIds.has(id))
  }
  // A custom wall with nothing on it is just the grid with extra steps.
  if (out.mode === 'custom' && Object.keys(out.tiles).length === 0) return emptyMosaic()
  return out
}

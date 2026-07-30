/**
 * Geometry check for the freeform mosaic wall.
 *
 *   node scripts/mosaic-check.mjs
 *
 * The wall's rules are all arithmetic — snap here, nudge there, never overlap —
 * and arithmetic is exactly the kind of thing that looks right while you are
 * dragging a tile about and turns out to be wrong the one time two tiles are
 * flush. So the rules live in src/lib/mosaicLayout.ts with no DOM in them, and
 * this file holds them to it: magnets, collision nudging, resize clamping, the
 * cascade a dropped tab lands in, spatial ring navigation, and a round trip of
 * a saved layout through JSON and back.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const M = await import('../src/lib/mosaicLayout.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const show = (r) => (r ? `${r.x},${r.y} ${r.w}×${r.h}` : String(r))
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Nothing on a wall may ever sit on top of anything else. */
const noOverlaps = (rects) => {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (M.rectsOverlap(rects[i], rects[j])) return false
    }
  }
  return true
}

/* --------------------------------------------------------------- basics */

console.log('\nbasics')
ok(M.snapToGrid(11) === 8, 'snaps down to the lattice', String(M.snapToGrid(11)))
ok(M.snapToGrid(13) === 16, 'snaps up to the lattice', String(M.snapToGrid(13)))
ok(M.normalise({ x: -30, y: -1, w: 10, h: 10 }).x === 0, 'never off the left edge')
ok(M.normalise({ x: 0, y: 0, w: 10, h: 10 }).w === M.MOSAIC_MIN_W, 'never narrower than a terminal')
ok(M.normalise({ x: 0, y: 0, w: 10, h: 10 }).h === M.MOSAIC_MIN_H, 'never shorter than a terminal')
ok(
  !M.rectsOverlap({ x: 0, y: 0, w: 200, h: 200 }, { x: 200, y: 0, w: 200, h: 200 }),
  'flush tiles are not an overlap'
)
ok(
  M.rectsOverlap({ x: 0, y: 0, w: 200, h: 200 }, { x: 199, y: 0, w: 200, h: 200 }),
  'one pixel of overlap is an overlap'
)

/* -------------------------------------------------------------- snapping */

console.log('\nsnapping')
{
  const neighbour = { x: 400, y: 0, w: 240, h: 200 }
  // Right edge four pixels shy of the neighbour's left edge: magnet catches it.
  const snapped = M.snapMove({ x: 156, y: 3, w: 240, h: 160 }, [neighbour])
  ok(snapped.x + snapped.w === 400, 'a near edge pulls the tile flush', show(snapped))
  ok(snapped.y === 0, 'the other axis takes the wall edge', show(snapped))

  // Both edges out of magnet range on both axes, so the lattice has it.
  const far = M.snapMove({ x: 139, y: 100, w: 240, h: 160 }, [neighbour])
  ok(far.x === 136 && far.y === 104, 'out of range, the 8px lattice wins', show(far))

  // The magnet works off whichever edge is nearest, not just the leading one:
  // here the tile's *bottom* is 5px above the neighbour's, so it goes flush.
  const trailing = M.snapMove({ x: 800, y: 45, w: 240, h: 160 }, [neighbour])
  ok(trailing.y + 160 === 200, 'a trailing edge can win the magnet too', show(trailing))

  const leading = M.snapMove({ x: 643, y: 200, w: 240, h: 160 }, [neighbour])
  ok(leading.x === 640, "a tile's left edge snaps to a neighbour's right", show(leading))
}

{
  // Resize: only the dragged edge moves, and it snaps on its own.
  const neighbour = { x: 500, y: 0, w: 200, h: 400 }
  const edges = { ...M.NO_EDGES, right: true }
  const r = M.snapResize({ x: 0, y: 0, w: 497, h: 300 }, [neighbour], edges)
  ok(r.w === 500 && r.x === 0, 'a dragged right edge snaps, the left stays put', show(r))
}

/* ------------------------------------------------------------ collisions */

console.log('\ncollisions')
{
  const others = [
    { x: 0, y: 0, w: 300, h: 200 },
    { x: 300, y: 0, w: 300, h: 200 }
  ]
  // Dropped squarely on top of the second tile.
  const landed = M.freeSpot({ x: 310, y: 8, w: 300, h: 200 }, others)
  ok(!M.collides(landed, others), 'a dropped tile never lands on another', show(landed))
  ok(same(landed, { x: 310, y: 200, w: 300, h: 200 }), 'and takes the nearest free spot', show(landed))
}

{
  const others = [{ x: 0, y: 0, w: 300, h: 200 }]
  const untouched = { x: 400, y: 0, w: 300, h: 200 }
  ok(same(M.freeSpot(untouched, others), untouched), 'a tile that already fits is left alone')
}

{
  // Fenced in on every side that matters: the nudge falls through to the floor.
  const others = []
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) others.push({ x: x * 200, y: y * 140, w: 200, h: 140 })
  const landed = M.freeSpot({ x: 100, y: 100, w: 200, h: 140 }, others)
  ok(!M.collides(landed, others), 'a full wall still finds somewhere to put it', show(landed))
}

{
  // Growing right into a neighbour: the edge stops, the tile does not move.
  const others = [{ x: 500, y: 0, w: 200, h: 400 }]
  const edges = { ...M.NO_EDGES, right: true }
  const start = { x: 0, y: 0, w: 300, h: 300 }
  const clamped = M.clampResize({ x: 0, y: 0, w: 700, h: 300 }, start, others, edges)
  ok(clamped.x === 0 && clamped.w === 500, 'a resize stops at the neighbour it meets', show(clamped))
  ok(!M.collides(clamped, others), 'and does not overlap it')
}

{
  // Growing left into a neighbour: the left edge stops; the right edge stays.
  const others = [{ x: 0, y: 0, w: 300, h: 400 }]
  const edges = { ...M.NO_EDGES, left: true }
  const start = { x: 400, y: 0, w: 300, h: 300 }
  const clamped = M.clampResize({ x: 100, y: 0, w: 600, h: 300 }, start, others, edges)
  ok(clamped.x === 300 && clamped.x + clamped.w === 700, 'the far edge of a resize is never dragged along', show(clamped))
}

{
  /*
   * The bug this exists to keep dead: dragging the bottom-right corner of a
   * tile that has another tile directly *below* it. Grow far enough and the two
   * share rows, and a clamp that asks "does this neighbour span my rows?" of
   * the box it is building rather than the box it started from decides the tile
   * below is blocking the right edge — and the width collapses to the minimum.
   */
  const below = { x: 0, y: 400, w: 480, h: 400 }
  const start = { x: 0, y: 0, w: 480, h: 396 }
  const edges = { ...M.NO_EDGES, right: true, bottom: true }
  const clamped = M.clampResize({ x: 0, y: 0, w: 900, h: 730 }, start, [below], edges)
  ok(clamped.w === 900, 'a tile directly below never blocks the right edge', show(clamped))
  ok(clamped.h === 400, 'but it does stop the bottom edge', show(clamped))
  ok(!M.collides(clamped, [below]), 'and the result is clear of it')
}

{
  // Both edges growing into one diagonal neighbour: something has to give, and
  // whatever gives, the tiles must not end up on top of each other.
  const diagonal = { x: 500, y: 400, w: 400, h: 400 }
  const start = { x: 0, y: 0, w: 300, h: 300 }
  const edges = { ...M.NO_EDGES, right: true, bottom: true }
  const clamped = M.clampResize({ x: 0, y: 0, w: 800, h: 700 }, start, [diagonal], edges)
  ok(!M.collides(clamped, [diagonal]), 'a diagonal neighbour is still respected', show(clamped))
}

/* -------------------------------------------------------- placing things */

console.log('\nplacing')
{
  const others = [{ x: 0, y: 0, w: 300, h: 200 }]
  const dropped = M.cascadeAt(
    [
      { id: 'a', w: 300, h: 200 },
      { id: 'b', w: 300, h: 200 },
      { id: 'c', w: 300, h: 200 }
    ],
    { x: 320, y: 16 },
    others
  )
  const rects = Object.values(dropped)
  ok(rects.length === 3, 'a three-pane tab drops three tiles')
  ok(noOverlaps([...others, ...rects]), 'a dropped tab never buries what was there')
  ok(rects[0].x !== rects[1].x || rects[0].y !== rects[1].y, 'the tiles are cascaded, not stacked')
}

{
  const existing = { a: { x: 0, y: 0, w: 300, h: 200 } }
  const filled = M.placeMissing(existing, ['a', 'b', 'c'], () => ({ w: 300, h: 200 }))
  ok(same(filled.a, existing.a), 'a placed tile is never moved to make room')
  ok(filled.b && filled.c, 'a pane nobody placed still gets a box')
  ok(noOverlaps(Object.values(filled)), 'and it lands somewhere free', JSON.stringify(filled))
  ok(M.placeMissing(existing, ['a'], () => ({ w: 1, h: 1 })) === existing, 'nothing missing, nothing rebuilt')
}

{
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
  const rects = M.autoRects(ids, { width: 1200, height: 800 })
  ok(Object.keys(rects).length === 9, 'the auto grid seeds every tile')
  ok(noOverlaps(Object.values(rects)), 'and none of them overlap')
  ok(M.columnsFor(9) === 3 && M.columnsFor(16) === 4, 'column counts are the wall’s own')
}

{
  const bounds = M.contentBounds({ a: { x: 900, y: 700, w: 300, h: 200 } }, { width: 800, height: 600 })
  ok(bounds.width >= 1200 && bounds.height >= 900, 'the canvas grows to hold a tile dragged out', JSON.stringify(bounds))
  const small = M.contentBounds({ a: { x: 0, y: 0, w: 100, h: 100 } }, { width: 800, height: 600 })
  ok(small.width === 800 && small.height === 600, 'and never shrinks below the viewport')
}

/* ------------------------------------------------------------------ ring */

console.log('\nkeyboard ring')
{
  //  a  b
  //  c  d      — laid out by position, not by index
  const tiles = {
    a: { x: 0, y: 0, w: 300, h: 200 },
    b: { x: 320, y: 0, w: 300, h: 200 },
    c: { x: 0, y: 220, w: 300, h: 200 },
    d: { x: 320, y: 220, w: 300, h: 200 }
  }
  ok(M.nearestTile(tiles, 'a', 'right') === 'b', 'right goes right')
  ok(M.nearestTile(tiles, 'a', 'down') === 'c', 'down goes down')
  ok(M.nearestTile(tiles, 'd', 'left') === 'c', 'left goes left')
  ok(M.nearestTile(tiles, 'd', 'up') === 'b', 'up goes up')
  ok(M.nearestTile(tiles, 'b', 'right') === null, 'the edge of the wall is the edge')
  ok(M.nearestTile(tiles, 'nope', 'right') === null, 'a tile that is not there has no neighbours')
}

/* ----------------------------------------------------------- persistence */

console.log('\npersistence')
{
  const saved = {
    mode: 'custom',
    tiles: {
      a: { x: 16, y: 24, w: 320, h: 240, fit: true },
      b: { x: 352, y: 24, w: 320, h: 240 },
      gone: { x: 0, y: 0, w: 320, h: 240 },
      junk: { x: Number.NaN, y: 0, w: 320, h: 240 }
    },
    wallTabs: ['tab1', 'tab-that-closed']
  }
  const panes = new Set(['a', 'b', 'junk'])
  const tabs = new Set(['tab1'])
  const back = M.sanitiseMosaic(JSON.parse(JSON.stringify(saved)), panes, tabs)

  ok(back.mode === 'custom', 'a custom wall comes back custom')
  ok(same(back.tiles.a, { x: 16, y: 24, w: 320, h: 240 }), 'boxes survive the round trip exactly', show(back.tiles.a))
  ok(back.tiles.a.fit === true, 'and so does a refitted tile')
  ok(back.tiles.b.fit === undefined, 'a tile nobody refitted stays a scale model')
  ok(!back.tiles.gone, 'a box for a pane that no longer exists is dropped')
  ok(!back.tiles.junk, 'a box with a NaN in it is dropped')
  ok(back.wallTabs.length === 1 && back.wallTabs[0] === 'tab1', 'so is a marker for a tab that closed')

  ok(M.sanitiseMosaic(null, panes, tabs).mode === 'auto', 'no saved wall means the auto grid')
  ok(M.sanitiseMosaic('nonsense', panes, tabs).mode === 'auto', 'nor does junk become a wall')
  ok(
    M.sanitiseMosaic({ mode: 'custom', tiles: {}, wallTabs: [] }, panes, tabs).mode === 'auto',
    'a custom wall with nothing on it is just the grid'
  )
  ok(M.emptyMosaic().mode === 'auto' && M.emptyMosaic().wallTabs.length === 0, 'an empty wall is an auto one')
}

/* -------------------------------------------------------------- verdict */

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)

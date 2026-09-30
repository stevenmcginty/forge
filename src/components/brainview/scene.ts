import type { AgentProfile, PaneLeaf } from '@shared/types'

/**
 * The map's geometry: who sits where, and how a point in the scene lands on
 * the screen.
 *
 * The scene is a disc seen from above at an angle, like an orrery: Forge Brain
 * at the centre, each project a hub on a ring around it with its agents fanned
 * outward, and the way in — you, then the voice agent — on a short stem at the
 * front, where the ring leaves a gap for it. Links rise off the disc as arcs.
 * The only "3D" is a small camera sway and the perspective that goes with it:
 * enough for depth, never enough to lose your place.
 *
 * Pure: numbers in, numbers out. No DOM, no React.
 */

/* ------------------------------------------------------------------ model */

export interface MapAgent {
  /** `a:<paneId>` */
  key: string
  paneId: string
  projectId: string
  /** The terminal's one name ("Zeb", "Zeb 2"). */
  name: string
  profile: AgentProfile
  leaf: PaneLeaf
}

export interface MapProject {
  /** `p:<projectId>` */
  key: string
  id: string
  name: string
  color: string
  path: string
  repoUrl?: string
  agents: MapAgent[]
  /** The project on screen in Forge right now. */
  active: boolean
}

export type NodeKind = 'brain' | 'you' | 'voice' | 'project' | 'agent'

export interface WorldNode {
  key: string
  kind: NodeKind
  /** Disc coordinates in px: x right, z away from you, y up off the disc. */
  x: number
  y: number
  z: number
}


/** A box on the screen, px. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Where a project's label hangs off its hub: `lx, ly` is the point it touches
 * (relative to the hub, px at the node's own scale), and `fx, fy` which part of
 * the label touches it (0 = its left/top edge, 1 = its right/bottom edge), so
 * the DOM label keeps the same rule whatever its real width turns out to be.
 */
export interface LabelPlace {
  lx: number
  ly: number
  fx: number
  fy: number
  w: number
  h: number
}

/** One label box at rest, for the overlap check. */
export interface PlacedBox {
  key: string
  kind: 'project' | 'hub' | 'agent' | 'brain' | 'stem'
  /** Project key it belongs to ('' for the brain and the stem). */
  owner: string
  box: Rect
}

export interface Layout {
  nodes: Map<string, WorldNode>
  /**
   * Agents folded into their project's "+N not open", per project key. They
   * have a place in `nodes` (where they bloom to when the project is opened
   * out) but are drawn only then.
   */
  folded: Map<string, string[]>
  /** Labels, per project key. */
  labels: Map<string, LabelPlace>
  /** Which way (screen, unit vector) a project's folded agents bloom from its hub. */
  bloomDir: Map<string, { x: number; y: number }>
  /** One-line project labels: many projects on a small stage. */
  compact: boolean
  /** Screen centre of the disc. */
  cx: number
  cy: number
  /** The brain core's radius on screen, px. */
  coreR: number
  /** Disc px per ring unit, across and in depth. */
  ux: number
  uz: number
  /** Hub lanes, then the agents' first row, in ring units. */
  rings: number[]
  /** Angle range the projects occupy (radians), for the orbit hairlines. */
  arc: [number, number]
  /** Every label drawn at rest (folded agents excluded), and the ones that touch. */
  boxes: PlacedBox[]
  /** Folded agents' boxes when their project is opened out. */
  bloomBoxes: Map<string, PlacedBox[]>
  overlaps: number
  /** How much of the camera sway it can take without a label swinging off the stage, 0..1. */
  sway: number
}

/* -------------------------------------------------------------- the camera */

export interface Camera {
  /** Rotation about the vertical axis, radians. */
  yaw: number
  /** How far above the disc we look from, radians (0 = edge on, π/2 = straight down). */
  elevation: number
  /** Perspective distance, px. */
  focal: number
  cx: number
  cy: number
}

export interface Screen {
  x: number
  y: number
  /** Perspective scale: >1 nearer than the disc's centre, <1 further. */
  s: number
  /** Depth: bigger is further away. */
  d: number
}

export function projectPoint(cam: Camera, x: number, y: number, z: number): Screen {
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw)
  const x1 = x * cy + z * sy
  const z1 = -x * sy + z * cy
  const ce = Math.cos(cam.elevation)
  const se = Math.sin(cam.elevation)
  const up = y * ce + z1 * se
  const depth = -y * se + z1 * ce
  const s = cam.focal / (cam.focal + depth)
  return { x: cam.cx + x1 * s, y: cam.cy - up * s, s, d: depth }
}

/**
 * Inverse of projectPoint for a point on the disc (y = 0), with the camera at
 * rest (no yaw). Used to put things where they should land on the screen.
 */
export function unprojectGround(cam: Camera, sx: number, sy: number): { x: number; z: number; s: number } {
  const ce = Math.cos(cam.elevation)
  const se = Math.sin(cam.elevation)
  const dy = cam.cy - sy
  const den = se * cam.focal - dy * ce
  const z = den > 1e-6 ? (dy * cam.focal) / den : 0
  const s = cam.focal / (cam.focal + z * ce)
  return { x: (sx - cam.cx) / s, z, s }
}

/* -------------------------------------------------------------- the layout */

/**
 * How it is laid out, and why.
 *
 * The geometry is solved on the screen, where labels live, then put back on
 * the disc. Projects sit on the hub ring, spaced by *screen arc length* so the
 * top, the bottom and both sides get the same breathing room; each takes the
 * room its own footprint needs at the angle it lands on (a label is wide and
 * short, so it needs more ring at the top than at the sides), plus an equal
 * share of what is left. The stem (voice, then you) takes its slot at the
 * front like one more project. Every label sits on the brain's side of its
 * hub; live agents fan outward. Then every box is checked against every other;
 * anything touching gets more room and it is solved again. If a stage is too
 * small for full labels it tries one-line labels, then two staggered lanes.
 */

export interface LayoutInput {
  projects: MapProject[]
  /** Agent keys folded into their project's "+N not open". */
  collapsed: ReadonlySet<string>
  width: number
  height: number
  /** Space the header and footer take, px. */
  top: number
  bottom: number
  elevation: number
  focal: number
}

/** A label's DOM scale for a perspective scale (engine.place uses the same). */
export function labelScale(s: number): number {
  return 0.9 + (s - 1) * 1.2
}

/** The agent node's box around its point, px at scale 1 (disc, "!" flag, name, state). */
export const AGENT_BOX = { w: 104, up: 24, down: 58 }
const HUB_R = 16
const MARGIN = 10
const EDGE = 8

/**
 * A project label's size, px at scale 1. Estimated from the text (Bahnschrift,
 * measured in Forge): 12px caps at 0.08em tracking ≈ 8.1px a letter, 10px meta
 * ≈ 5.7px. The CSS caps the name at the same widths, so a label never
 * outgrows its estimate.
 */
export function projectLabelSize(name: string, agents: number, folded: number, active: boolean, compact: boolean): { w: number; h: number } {
  const chars = [...name].length
  const chip = folded > 0 ? 5.7 * `+${folded} not open`.length + 24 : 0
  if (compact) {
    const nameW = Math.min(NAME_MAX_COMPACT, 7.4 * chars + 2)
    const tag = folded > 0 ? 5.7 * `+${folded}`.length + 22 : 0
    return { w: nameW + (tag ? tag + 6 : 0) + 18, h: 24 }
  }
  const nameW = Math.min(NAME_MAX, 8.1 * chars + 2)
  const words = folded > 0 ? chip : 5.7 * (agents === 0 ? 'no agents' : `${agents} agents`).length
  const meta = words + (active ? 40 : 0)
  return { w: Math.max(nameW, meta) + 22, h: 42 }
}

export const NAME_MAX = 150
export const NAME_MAX_COMPACT = 124

interface Mode {
  compact: boolean
  lanes: 1 | 2
}

const MODES: Mode[] = [
  { compact: false, lanes: 1 },
  { compact: true, lanes: 1 },
  { compact: true, lanes: 2 }
]

export function layoutMap(input: LayoutInput): Layout {
  let best: Layout | null = null
  for (const mode of MODES) {
    const l = solve(input, mode)
    if (!best || l.overlaps < best.overlaps) best = l
    if (l.overlaps === 0) break
  }
  const l = best!
  l.sway = swayRoom(
    l.boxes.map((b) => b.box),
    l.cx,
    l.cy,
    input.elevation,
    input.top + EDGE,
    input.height - input.bottom - EDGE,
    input.width
  )
  return l
}

const overlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** The engine's camera sway at its widest (engine.ts: yaw sin·0.06 + pointer·0.035, elevation pointer·0.025). */
const SWAY_YAW = 0.06 + 0.035
const SWAY_EL = 0.025

/**
 * How much of the camera sway a layout can take, 0..1. The layout is solved at
 * rest, but a node far out to the side swings up and down the screen by tens
 * of px as the camera turns (yaw turns sideways distance into depth); one near
 * a bottom corner swung onto the legend. So the sway shrinks until the box
 * with the least room stays on the stage at the widest swing. Folded agents'
 * bloom spots are left out: the sway settles while you point at a project.
 */
function swayRoom(boxes: Rect[], cx: number, cy: number, elevation: number, T: number, Bt: number, W: number): number {
  const se = Math.sin(elevation)
  let k = 1
  for (const b of boxes) {
    const side = Math.max(Math.abs(b.x0 - cx), Math.abs(b.x1 - cx))
    const depth = Math.max(Math.abs(b.y0 - cy), Math.abs(b.y1 - cy))
    const dy = (side * Math.sin(SWAY_YAW) * se + (depth * SWAY_EL) / Math.tan(elevation)) * 1.1
    const dx = (depth / Math.max(0.2, se)) * Math.sin(SWAY_YAW) * 1.1
    if (dy > 0) k = Math.min(k, Math.min(b.y0 - T, Bt - b.y1) / dy)
    if (dx > 0) k = Math.min(k, Math.min(b.x0 - EDGE, W - EDGE - b.x1) / dx)
  }
  return Math.max(0, Math.min(1, k))
}

/** Box support: how far a box around a point reaches in direction (dx, dy). */
function reach(dx: number, dy: number, left: number, right: number, up: number, down: number): number {
  return (dx >= 0 ? dx * right : -dx * left) + (dy >= 0 ? dy * down : -dy * up)
}

interface Plan {
  theta: number[]
  lane: number[]
}

function solve(input: LayoutInput, mode: Mode): Layout {
  const { projects, collapsed, width: W, height: H, elevation, focal } = input
  const n = projects.length
  const T = input.top + EDGE
  const Bt = H - input.bottom - EDGE
  const se = Math.sin(elevation)
  const visible = projects.map((p) => p.agents.filter((a) => !collapsed.has(a.key)))
  const folds = projects.map((p) => p.agents.filter((a) => collapsed.has(a.key)))
  const sizes = projects.map((p, i) => projectLabelSize(p.name, p.agents.length, folds[i]!.length, p.active, mode.compact))

  let ux = Math.max(120, W * 0.3)
  let uz = Math.max(90, (Bt - T) * 0.36 / se)
  let cy = (T + Bt) / 2
  const cx = W / 2
  let coreShrink = 1
  const bump = new Array<number>(n).fill(1)
  let stemBump = 1

  let result: Layout | null = null
  for (let iter = 0; iter < 18; iter++) {
    const coreR = Math.max(30, Math.min(92, Math.min(ux, uz) * 0.4)) * coreShrink
    const cam: Camera = { yaw: 0, elevation, focal, cx, cy }
    const P = (theta: number, r: number): Screen => projectPoint(cam, Math.cos(theta) * r * ux, 0, Math.sin(theta) * r * uz)
    const brain = projectPoint(cam, 0, coreR * 0.2, 0)
    const laneGap = mode.lanes === 2 ? (Math.max(...sizes.map((s) => s.h)) + 14) / Math.max(40, uz * se) : 0
    const laneOf = (i: number): number => (mode.lanes === 2 && i % 2 === 1 ? 1 + laneGap : 1)

    // Ring-1 arc length, round from straight ahead (-π/2) the long way.
    const STEPS = 720
    const arcAt: number[] = [0]
    let prev = P(-Math.PI / 2, 1)
    for (let k = 1; k <= STEPS; k++) {
      const p = P(-Math.PI / 2 + (Math.PI * 2 * k) / STEPS, 1)
      arcAt.push(arcAt[k - 1]! + Math.hypot(p.x - prev.x, p.y - prev.y))
      prev = p
    }
    const perimeter = arcAt[STEPS]!
    const thetaAt = (len: number): number => {
      let lo = 0
      let hi = STEPS
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (arcAt[mid]! < len) lo = mid
        else hi = mid
      }
      const f = (len - arcAt[lo]!) / Math.max(1e-6, arcAt[hi]! - arcAt[lo]!)
      return -Math.PI / 2 + ((Math.PI * 2) * (lo + f)) / STEPS
    }

    const labelPlace = (i: number, hub: Screen): LabelPlace => {
      let ux1 = brain.x - hub.x
      let uy1 = brain.y - hub.y
      const len = Math.hypot(ux1, uy1) || 1
      ux1 /= len
      uy1 /= len
      const m = Math.max(Math.abs(ux1), Math.abs(uy1)) || 1
      const d = HUB_R + 4
      return { lx: ux1 * d, ly: uy1 * d, fx: (1 - ux1 / m) / 2, fy: (1 - uy1 / m) / 2, w: sizes[i]!.w, h: sizes[i]!.h }
    }
    const labelRect = (hub: Screen, lp: LabelPlace): Rect => {
      const sc = labelScale(hub.s)
      const x0 = hub.x + (lp.lx - lp.fx * lp.w) * sc
      const y0 = hub.y + (lp.ly - lp.fy * lp.h) * sc
      return { x0, y0, x1: x0 + lp.w * sc, y1: y0 + lp.h * sc }
    }
    const agentRect = (s: Screen): Rect => {
      const sc = labelScale(s.s)
      return { x0: s.x - (AGENT_BOX.w / 2) * sc, x1: s.x + (AGENT_BOX.w / 2) * sc, y0: s.y - AGENT_BOX.up * sc, y1: s.y + AGENT_BOX.down * sc }
    }

    /** Agent rows for project i at angle theta: world radius and angles of each visible agent. */
    const fan = (i: number, theta: number, count: number): { r: number; a: number }[] => {
      if (count === 0) return []
      const r0 = laneOf(i)
      const hub = P(theta, r0)
      let ox = hub.x - brain.x
      let oy = hub.y - brain.y
      const ol = Math.hypot(ox, oy) || 1
      ox /= ol
      oy /= ol
      const side = Math.abs(ox) > 0.8
      const rowsMax = side ? 3 : count <= 3 ? 1 : 3
      const perRow = Math.ceil(count / Math.min(rowsMax, count))
      const sc = labelScale(hub.s)
      const half = AGENT_BOX.w / 2
      const back = reach(-ox, -oy, half, half, AGENT_BOX.up, AGENT_BOX.down) * sc
      const fwd = reach(ox, oy, half, half, AGENT_BOX.up, AGENT_BOX.down) * sc
      const radialSpeed = Math.hypot(P(theta, r0 + 0.01).x - hub.x, P(theta, r0 + 0.01).y - hub.y) / 0.01
      const out: { r: number; a: number }[] = []
      let placed = 0
      for (let row = 0; placed < count; row++) {
        const d = Math.max(74, HUB_R + back + MARGIN) + row * (back + fwd + MARGIN)
        const r = r0 + d / radialSpeed
        const k = Math.min(perRow, count - placed)
        const a0 = P(theta - 0.005, r)
        const a1 = P(theta + 0.005, r)
        const tx = (a1.x - a0.x) / 0.01
        const ty = (a1.y - a0.y) / 0.01
        const sp = Math.hypot(tx, ty) || 1
        const ext = reach(Math.abs(tx / sp), Math.abs(ty / sp), half, half, AGENT_BOX.up, AGENT_BOX.down) + reach(Math.abs(tx / sp), Math.abs(ty / sp), half, half, AGENT_BOX.down, AGENT_BOX.up)
        const step = (ext * sc + MARGIN) / sp
        for (let j = 0; j < k; j++) out.push({ r, a: theta + (j - (k - 1) / 2) * step })
        placed += k
      }
      return out
    }

    /** Ring-1 arc px project i needs at angle theta. */
    const needOf = (i: number, theta: number): number => {
      const r0 = laneOf(i)
      const hub = P(theta, r0)
      const h1 = P(theta, 1)
      const e0 = P(theta - 0.005, 1)
      const e1 = P(theta + 0.005, 1)
      const tl = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1
      const tx = Math.abs((e1.x - e0.x) / tl)
      const ty = Math.abs((e1.y - e0.y) / tl)
      const rad1 = Math.hypot(h1.x - brain.x, h1.y - brain.y) || 1
      const lr = labelRect(hub, labelPlace(i, hub))
      const lcx = (lr.x0 + lr.x1) / 2
      const lcy = (lr.y0 + lr.y1) / 2
      const rho = Math.max(0.35, Math.hypot(lcx - brain.x, lcy - brain.y) / rad1)
      let need = (tx * (lr.x1 - lr.x0) + ty * (lr.y1 - lr.y0)) / rho
      need = Math.max(need, (HUB_R * 2) / (r0 === 1 ? 1 : 1))
      const spots = fan(i, theta, visible[i]!.length)
      if (spots.length) {
        let lo = Infinity
        let hi = -Infinity
        for (const s of spots) {
          const q = P(s.a, s.r)
          const along = (q.x - hub.x) * tx * Math.sign(e1.x - e0.x || 1) + (q.y - hub.y) * ty * Math.sign(e1.y - e0.y || 1)
          const b = agentRect(q)
          const half = (tx * (b.x1 - b.x0) + ty * (b.y1 - b.y0)) / 2
          lo = Math.min(lo, along - half)
          hi = Math.max(hi, along + half)
        }
        const rq = Math.hypot(P(spots[0]!.a, spots[0]!.r).x - brain.x, P(spots[0]!.a, spots[0]!.r).y - brain.y) / rad1
        need = Math.max(need, (hi - lo) / Math.max(1, rq))
      }
      const lanes = mode.lanes === 2 ? 0.55 : 1
      return (need * lanes + MARGIN) * bump[i]!
    }

    // The stem's slot: the voice agent's label at the front, and you below it.
    const stemNeed = (124 + MARGIN * 4) * stemBump

    // Allocate: needs, then equal gaps; a few rounds, since needs depend on where they land.
    const plan: Plan = { theta: projects.map((_, i) => -Math.PI / 2 + ((Math.PI * 2) * (i + 1)) / (n + 1)), lane: projects.map((_, i) => laneOf(i)) }
    let slack = 0
    for (let round = 0; round < 4; round++) {
      const needs = projects.map((_, i) => needOf(i, plan.theta[i]!))
      const total = needs.reduce((a, b) => a + b, 0) + stemNeed
      slack = perimeter - total
      const gap = Math.max(0, slack) / (n + 1)
      const squeeze = slack < 0 ? perimeter / total : 1
      let at = (stemNeed / 2) * squeeze
      for (let i = 0; i < n; i++) {
        at += gap + (needs[i]! / 2) * squeeze
        plan.theta[i] = n === 1 ? Math.PI / 2 : thetaAt(at)
        at += (needs[i]! / 2) * squeeze
      }
    }

    // Place everything.
    const nodes = new Map<string, WorldNode>()
    const labels = new Map<string, LabelPlace>()
    const boxes: PlacedBox[] = []
    const phantom: Rect[] = []
    nodes.set('brain', { key: 'brain', kind: 'brain', x: 0, y: coreR * 0.2, z: 0 })
    boxes.push({ key: 'brain', kind: 'brain', owner: '', box: { x0: brain.x - coreR * brain.s, x1: brain.x + coreR * brain.s, y0: brain.y - coreR * brain.s, y1: brain.y + coreR * brain.s } })
    boxes.push({ key: 'brain-label', kind: 'brain', owner: '', box: { x0: brain.x - 84, x1: brain.x + 84, y0: brain.y + coreR * brain.s + 14, y1: brain.y + coreR * brain.s + 54 } })
    const vz = -1.02 * uz
    const voice = projectPoint(cam, 0, 0, vz)
    nodes.set('voice', { key: 'voice', kind: 'voice', x: 0, y: 0, z: vz })
    const vs = labelScale(voice.s)
    boxes.push({ key: 'voice', kind: 'stem', owner: '', box: { x0: voice.x - 62 * vs, x1: voice.x + 62 * vs, y0: voice.y - 18 * vs, y1: voice.y + 56 * vs } })
    const youY = Math.min(Bt - 40, voice.y + 56 * vs + 70)
    const youG = unprojectGround(cam, cx, youY)
    const you = projectPoint(cam, 0, 0, youG.z)
    nodes.set('you', { key: 'you', kind: 'you', x: 0, y: 0, z: youG.z })
    const ys = labelScale(you.s)
    boxes.push({ key: 'you', kind: 'stem', owner: '', box: { x0: you.x - 32 * ys, x1: you.x + 32 * ys, y0: you.y - 16 * ys, y1: you.y + 38 * ys } })
    // The stem line itself, voice to you: nothing may sit on it.
    boxes.push({ key: 'stem-line', kind: 'stem', owner: '', box: { x0: cx - 8, x1: cx + 8, y0: brain.y + coreR * brain.s + 54, y1: voice.y } })

    let agentRing = 0
    let agentRingN = 0
    projects.forEach((project, i) => {
      const theta = plan.theta[i]!
      const r0 = laneOf(i)
      const hub = P(theta, r0)
      nodes.set(project.key, { key: project.key, kind: 'project', x: Math.cos(theta) * r0 * ux, y: 0, z: Math.sin(theta) * r0 * uz })
      const lp = labelPlace(i, hub)
      labels.set(project.key, { lx: lp.lx, ly: lp.ly, fx: lp.fx, fy: lp.fy, w: lp.w, h: lp.h })
      boxes.push({ key: project.key, kind: 'project', owner: project.key, box: labelRect(hub, lp) })
      const hs = labelScale(hub.s)
      boxes.push({ key: `${project.key}#hub`, kind: 'hub', owner: project.key, box: { x0: hub.x - HUB_R * hs, x1: hub.x + HUB_R * hs, y0: hub.y - HUB_R * hs, y1: hub.y + HUB_R * hs } })
      const spots = fan(i, theta, visible[i]!.length)
      visible[i]!.forEach((agent, j) => {
        const s = spots[j]!
        nodes.set(agent.key, { key: agent.key, kind: 'agent', x: Math.cos(s.a) * s.r * ux, y: 0, z: Math.sin(s.a) * s.r * uz })
        boxes.push({ key: agent.key, kind: 'agent', owner: project.key, box: agentRect(P(s.a, s.r)) })
        if (j === 0) {
          agentRing += s.r
          agentRingN++
        }
      })
      // Room kept for one live agent even when none is: opening one should not reshape the map.
      const ph = fan(i, theta, 1)[0]!
      phantom.push(agentRect(P(ph.a, ph.r)))
    })

    // Touching boxes: give the projects between them more room.
    let overlaps = 0
    const idx = new Map(projects.map((p, i) => [p.key, i]))
    const bumped = new Set<number>()
    let fitBad = false
    for (let a = 0; a < boxes.length; a++) {
      const A = boxes[a]!
      if (A.box.x0 < EDGE || A.box.x1 > W - EDGE || A.box.y0 < T || A.box.y1 > Bt) {
        overlaps++
        fitBad = true
      }
      for (let b = a + 1; b < boxes.length; b++) {
        const B = boxes[b]!
        if (A.owner && A.owner === B.owner && (A.kind === 'hub' || B.kind === 'hub') && (A.kind === 'project' || B.kind === 'project')) continue
        if (!overlap(A.box, B.box)) continue
        overlaps++
        const ia = idx.get(A.owner)
        const ib = idx.get(B.owner)
        if (ia !== undefined && ib !== undefined) {
          const lo = Math.min(ia, ib)
          const hi = Math.max(ia, ib)
          const inner = hi - lo <= n - (hi - lo)
          for (let k = 0; k < n; k++) if (inner ? k >= lo && k <= hi : k <= lo || k >= hi) bumped.add(k)
        } else if (ia !== undefined || ib !== undefined) {
          const k = (ia ?? ib)!
          const other = ia !== undefined ? B : A
          if (other.kind === 'brain') coreShrink *= 0.93
          else stemBump *= 1.12
          bumped.add(k)
        }
      }
    }

    // Fit the stage: scale the disc so everything, and the room kept for agents, fills it.
    const all = [...boxes.map((b) => b.box), ...phantom]
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const b of all) {
      x0 = Math.min(x0, b.x0)
      x1 = Math.max(x1, b.x1)
      y0 = Math.min(y0, b.y0)
      y1 = Math.max(y1, b.y1)
    }
    const halfW = Math.max(cx - x0, x1 - cx)
    const fx = (W / 2 - EDGE - 40) / Math.max(1, halfW - 40)
    const fz = (Bt - T - 60) / Math.max(1, y1 - y0 - 60)
    const shift = (T + Bt) / 2 - (y0 + y1) / 2

    const rings = mode.lanes === 2 ? [1, 1 + laneGap] : [1]
    rings.push(agentRingN ? agentRing / agentRingN : 1.45)
    const arc: [number, number] = n ? [Math.min(...plan.theta) - 0.12, Math.max(...plan.theta) + 0.12] : [0, Math.PI]
    const layout: Layout = {
      nodes,
      folded: new Map(),
      labels,
      bloomDir: new Map(),
      compact: mode.compact,
      cx,
      cy,
      coreR,
      ux,
      uz,
      rings,
      arc,
      boxes,
      bloomBoxes: new Map(),
      overlaps,
      sway: 1
    }
    result = layout
    const fitting = Math.abs(fx - 1) > 0.015 || Math.abs(fz - 1) > 0.015 || Math.abs(shift) > 2
    if (fitting && iter < 12) {
      ux *= Math.max(0.6, Math.min(1.6, fx))
      uz *= Math.max(0.6, Math.min(1.6, fz))
      cy += shift
      continue
    }
    if (overlaps === 0 || slack < 0 || iter >= 17) break
    if (fitBad && bumped.size === 0) {
      ux *= 0.97
      uz *= 0.97
    }
    for (const k of bumped) bump[k] = bump[k]! * 1.12
  }

  const layout = result!
  bloom(layout, projects, folds, elevation, focal, T, Bt, W)
  return layout
}

/**
 * Where each project's folded agents go when it is opened out: rings around
 * the hub, starting straight outward and working round, taking the first spots
 * clear of everything (then clear of its own things and the stem, if it must).
 */
function bloom(layout: Layout, projects: MapProject[], folds: MapAgent[][], elevation: number, focal: number, T: number, Bt: number, W: number): void {
  const cam: Camera = { yaw: 0, elevation, focal, cx: layout.cx, cy: layout.cy }
  const brainS = projectPoint(cam, 0, layout.coreR * 0.2, 0)
  const fixed = layout.boxes.filter((b) => b.kind === 'brain' || b.kind === 'stem')
  projects.forEach((project, i) => {
    const list = folds[i]!
    if (list.length === 0) return
    const node = layout.nodes.get(project.key)!
    const hub = projectPoint(cam, node.x, node.y, node.z)
    let ox = hub.x - brainS.x
    let oy = hub.y - brainS.y
    const ol = Math.hypot(ox, oy) || 1
    ox /= ol
    oy /= ol
    const own = layout.boxes.filter((b) => b.owner === project.key)
    const others = layout.boxes.filter((b) => b.owner && b.owner !== project.key)
    const taken: Rect[] = []
    const out: PlacedBox[] = []
    const base = Math.atan2(oy, ox)
    const sc = labelScale(hub.s)
    const rowGap = (AGENT_BOX.up + AGENT_BOX.down) * sc + 6
    const tryPass = (strict: 0 | 1 | 2, want: number): { x: number; y: number }[] => {
      const got: { x: number; y: number }[] = []
      for (let ring = 0; ring < 7 && got.length < want; ring++) {
        const d = 92 * sc + ring * rowGap * 0.78
        const step = ((AGENT_BOX.w + 8) * sc) / d
        const spots: number[] = [0]
        for (let j = 1; j * step < Math.PI; j++) spots.push(j, -j)
        for (const j of spots) {
          if (got.length >= want) break
          const a = base + j * step
          const x = hub.x + Math.cos(a) * d
          const y = hub.y + Math.sin(a) * d
          const g = unprojectGround(cam, x, y)
          const s2 = labelScale(g.s)
          const r: Rect = { x0: x - (AGENT_BOX.w / 2) * s2, x1: x + (AGENT_BOX.w / 2) * s2, y0: y - AGENT_BOX.up * s2, y1: y + AGENT_BOX.down * s2 }
          if (r.x0 < EDGE || r.x1 > W - EDGE || r.y0 < T || r.y1 > Bt) continue
          if (taken.some((t) => overlap(t, r))) continue
          if (strict < 2 && [...own, ...fixed].some((b) => overlap(b.box, r))) continue
          if (strict < 1 && others.some((b) => overlap(b.box, r))) continue
          taken.push(r)
          got.push({ x, y })
        }
      }
      return got
    }
    let spots = tryPass(0, list.length)
    if (spots.length < list.length) spots = spots.concat(tryPass(1, list.length - spots.length))
    if (spots.length < list.length) spots = spots.concat(tryPass(2, list.length - spots.length))
    let mx = 0
    let my = 0
    list.forEach((agent, j) => {
      const p = spots[j] ?? { x: hub.x + ox * 90, y: hub.y + oy * 90 }
      const g = unprojectGround(cam, p.x, p.y)
      layout.nodes.set(agent.key, { key: agent.key, kind: 'agent', x: g.x, y: 0, z: g.z })
      out.push({ key: agent.key, kind: 'agent', owner: project.key, box: taken[j] ?? { x0: p.x, x1: p.x, y0: p.y, y1: p.y } })
      mx += p.x - hub.x
      my += p.y - hub.y
    })
    const ml = Math.hypot(mx, my) || 1
    layout.bloomDir.set(project.key, { x: mx / ml, y: my / ml })
    layout.folded.set(
      project.key,
      list.map((a) => a.key)
    )
    layout.bloomBoxes.set(project.key, out)
  })
}

/* ---------------------------------------------------------------- colours */

export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * A computed CSS colour ("rgb(1, 2, 3)", "rgba(…)", "color(srgb 0.1 0.2 0.3)")
 * or a hex, as numbers. Anything unreadable is a mid grey, never a throw.
 */
export function parseColor(input: string): Rgb {
  const s = input.trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(s)
  if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255 }
  return { r: 128, g: 128, b: 128 }
}

export function rgba(c: Rgb, a: number): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

/** Mix `a` toward `b` by `t` (0 = a). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

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

export interface Layout {
  nodes: Map<string, WorldNode>
  /** Agents that did not fit, per project key. */
  overflow: Map<string, number>
  /** Screen centre of the disc. */
  cx: number
  cy: number
  /** The brain core's radius on screen, px. */
  coreR: number
  /** Disc px per ring unit, across and in depth. */
  ux: number
  uz: number
  /** Where the hub ring and the agents' rows sit, in ring units. */
  rings: number[]
  /** Angle range the projects occupy (radians), for the orbit hairlines. */
  arc: [number, number]
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

/* -------------------------------------------------------------- the layout */

/** The stem's gap in the ring, each side of straight ahead. */
const GAP = (40 * Math.PI) / 180
/** Hub ring, then the agents' first and second rows. */
const RINGS = [1, 1.62, 2.02]
const MAX_ROWS = 2

export interface LayoutInput {
  projects: MapProject[]
  width: number
  height: number
  /** Space the header and footer take, px. */
  top: number
  bottom: number
  elevation: number
  focal: number
}

export function layoutMap(input: LayoutInput): Layout {
  // As big as one row of agents allows; a project that needs a second row
  // shrinks the whole map to make room for it.
  const one = placeAll(input, RINGS[1]! + 0.34, 1)
  const rMax = one.secondRow ? RINGS[2]! + 0.3 : RINGS[1]! + 0.34
  const first = one.secondRow ? placeAll(input, rMax, 1).layout : one.layout
  // Then fit what was actually drawn to the stage: the back of the disc is
  // foreshortened and the front has the stem, so the plain estimate leaves
  // the top empty. Measure, scale to fill, and centre.
  const box = (layout: Layout): { top: number; bottom: number } => {
    const cam: Camera = { yaw: 0, elevation: input.elevation, focal: input.focal, cx: layout.cx, cy: layout.cy }
    let top = Infinity
    let bottom = -Infinity
    for (const n of layout.nodes.values()) {
      const p = projectPoint(cam, n.x, n.y, n.z)
      top = Math.min(top, p.y - (n.kind === 'brain' ? layout.coreR : 30))
      bottom = Math.max(bottom, p.y + (n.kind === 'brain' ? layout.coreR + 50 : 60))
    }
    return { top, bottom }
  }
  const b = box(first)
  const usable = Math.max(240, input.height - input.top - input.bottom)
  const scale = Math.max(0.7, Math.min(1.35, usable / Math.max(1, b.bottom - b.top)))
  const fitted = placeAll(input, rMax, scale).layout
  const f = box(fitted)
  const shift = input.top + usable / 2 - (f.top + f.bottom) / 2
  fitted.cy += shift
  return fitted
}

/** Room a node's label needs, px: across, and stacked. */
const LABEL_W = 110
const LABEL_H = 78

function placeAll(
  { projects, width, height, top, bottom, elevation }: LayoutInput,
  rMax: number,
  scale: number
): { layout: Layout; secondRow: boolean } {
  const cx = width / 2
  const usableH = Math.max(240, height - top - bottom)
  const cy = top + usableH / 2
  const se = Math.sin(elevation)
  // Fit the outer row inside the stage: across it is the width, in depth the
  // disc is foreshortened by the elevation.
  const uz = Math.max(60, ((usableH / 2 - 30) / (rMax * se * 1.08)) * scale)
  const ux = Math.max(80, Math.min(uz * 1.55, (width / 2 - 72) / rMax))
  const coreR = Math.max(36, Math.min(92, Math.min(ux, uz) * 0.4))

  /** The angle between neighbours on ring `r` at angle `a` so their labels clear each other. */
  const stepAt = (r: number, a: number): number => {
    const tx = -Math.sin(a) * ux
    const ty = Math.cos(a) * uz * se
    const len = Math.hypot(tx, ty) || 1
    const need = 1 / Math.hypot(tx / len / LABEL_W, ty / len / LABEL_H)
    return need / (r * len)
  }

  const nodes = new Map<string, WorldNode>()
  const overflow = new Map<string, number>()
  nodes.set('brain', { key: 'brain', kind: 'brain', x: 0, y: coreR * 0.2, z: 0 })
  // The stem: straight ahead is -z.
  nodes.set('voice', { key: 'voice', kind: 'voice', x: 0, y: 0, z: -1.02 * uz })
  nodes.set('you', { key: 'you', kind: 'you', x: 0, y: 0, z: -Math.min(1.8, rMax - 0.12) * uz })

  // Straight ahead is -π/2; the projects go round from one side of the gap to
  // the other, the long way.
  const start = -Math.PI / 2 + GAP
  const span = Math.PI * 2 - GAP * 2
  const weights = projects.map((p) => 1 + 0.7 * Math.min(p.agents.length, 8))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let secondRow = false

  let cursor = start
  projects.forEach((project, i) => {
    const share = (span * weights[i]!) / total
    // One project alone sits at the back, not off to one side.
    const angle = projects.length === 1 ? Math.PI / 2 : cursor + share / 2
    cursor += share
    nodes.set(project.key, {
      key: project.key,
      kind: 'project',
      x: Math.cos(angle) * RINGS[0]! * ux,
      y: 0,
      z: Math.sin(angle) * RINGS[0]! * uz
    })

    const agents = project.agents
    let placed = 0
    for (let row = 0; row < MAX_ROWS && placed < agents.length; row++) {
      const r = RINGS[row + 1]!
      const step = stepAt(r, angle)
      // A step of clear air to each neighbour: n labels span (n - 1) steps.
      const fits = Math.max(1, Math.floor(Math.min(share, Math.PI * 0.9) / step))
      const inRow = Math.min(fits, agents.length - placed)
      if (row === 1) secondRow = true
      for (let j = 0; j < inRow; j++) {
        const a = angle + (j - (inRow - 1) / 2) * step
        const agent = agents[placed + j]!
        nodes.set(agent.key, {
          key: agent.key,
          kind: 'agent',
          x: Math.cos(a) * r * ux,
          y: 0,
          z: Math.sin(a) * r * uz
        })
      }
      placed += inRow
    }
    if (placed < agents.length) overflow.set(project.key, agents.length - placed)
  })

  return { layout: { nodes, overflow, cx, cy, coreR, ux, uz, rings: RINGS, arc: [start, start + span] }, secondRow }
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

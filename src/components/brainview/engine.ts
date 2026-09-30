import type { BrainStatus } from '@shared/brain'
import { ActivityTracker, type Sampled, type Transition } from './activity'
import { layoutMap, mix, projectPoint, rgba, type Camera, type Layout, type MapProject, type Rgb, type Screen } from './scene'

/**
 * The map's moving parts: one canvas, one requestAnimationFrame loop, and the
 * DOM nodes it keeps in place.
 *
 * Everything that moves every frame is here and nowhere near React: the camera
 * sway, the brain core turning, the bolts flying into it, the pulses travelling
 * the links, and the transforms that keep each node's label on its point. React
 * draws the labels once and re-renders only when a state word changes.
 *
 * Cost is bounded by construction: the core is 300 points, pulses are capped at
 * 48, flow particles at 60, bolts at 10. The loop runs only while the map is
 * open, the window is visible and no terminal is opened over it; with reduced
 * motion there is no loop at all — one still frame per change.
 */

export interface Palette {
  accent: Rgb
  ink: Rgb
  muted: Rgb
  warn: Rgb
  ok: Rgb
  bg: Rgb
  dark: boolean
}

export type BrainMood = 'off' | 'starting' | 'idle' | 'busy' | 'asking' | 'error'

export interface VoiceInfo {
  phase: string
  capturing: boolean
}

type PulseShape = 'dot' | 'diamond' | 'tick'

interface Pulse {
  route: string[]
  t: number
  speed: number
  shape: PulseShape
  color: Rgb
}

interface Bolt {
  pts: { x: number; y: number }[]
  t: number
  color: Rgb
}

interface Flash {
  at: number
  color: Rgb
}

const MAX_PULSES = 48
const MAX_FLOW = 60
const MAX_BOLTS = 10
/** A pane that starts working this soon after the brain was busy counts as sent by it. */
const DELEGATION_WINDOW_MS = 20_000
const SAMPLE_MS = 250
const ELEVATION = (58 * Math.PI) / 180
const FOCAL = 1900

export interface EngineHooks {
  /** Some agent's state word changed: re-render the labels. */
  onStates(): void
}

/* --------------------------------------------------------- the brain core */

interface CorePoint {
  x: number
  y: number
  z: number
}

interface Core {
  pts: CorePoint[]
  pairs: [number, number][]
}

let coreCache: Core | null = null

/** The cloud never changes, so it is built once per session, on first open. */
function theCore(): Core {
  coreCache ??= makeCore()
  return coreCache
}

/** A brain-shaped cloud: two hemispheres with a fissure, folded surface. Deterministic. */
function makeCore(): Core {
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
  const pts: CorePoint[] = []
  while (pts.length < 300) {
    const u = rnd() * 2 - 1
    const th = rnd() * Math.PI * 2
    const q = Math.sqrt(1 - u * u)
    let x = q * Math.cos(th)
    const y = u
    let z = q * Math.sin(th)
    // The longitudinal fissure: nothing right on the midline.
    if (Math.abs(x) < 0.07) continue
    x += Math.sign(x) * 0.07
    const fold = 1 + 0.07 * Math.sin(9 * Math.atan2(z, x) + 5 * y) * Math.cos(6 * y)
    const flat = y < -0.35 ? 0.78 : 1
    x *= 1.12 * fold
    z *= 1.0 * fold
    pts.push({ x, y: y * 0.86 * fold * flat, z })
  }
  // Each point to its two nearest neighbours (within reach), no duplicates.
  const pairs: [number, number][] = []
  const seen = new Set<number>()
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    let best = -1
    let bestD = 0.1
    let next = -1
    let nextD = 0.1
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue
      const b = pts[j]!
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
      if (d < bestD) {
        next = best
        nextD = bestD
        best = j
        bestD = d
      } else if (d < nextD) {
        next = j
        nextD = d
      }
    }
    for (const j of [best, next]) {
      if (j < 0) continue
      const k = Math.min(i, j) * 1000 + Math.max(i, j)
      if (seen.has(k)) continue
      seen.add(k)
      pairs.push([i, j])
    }
  }
  return { pts, pairs }
}

/* --------------------------------------------------------------- engine */

export class MapEngine {
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  private w = 0
  private h = 0
  private top = 0
  private bottom = 0
  private projects: MapProject[] = []
  private layout: Layout | null = null
  private palette: Palette | null = null
  private cam: Camera = { yaw: 0, elevation: ELEVATION, focal: FOCAL, cx: 0, cy: 0 }
  private screens = new Map<string, Screen>()
  private els = new Map<string, HTMLElement>()
  private reveal: string | null = null
  private focus = 0
  private card: { el: HTMLElement; key: string; w: number; h: number; ro: ResizeObserver } | null = null
  private tracker = new ActivityTracker()
  private paneIds: string[] = []
  private projectOf = new Map<string, MapProject>()
  private knownPanes: Set<string> | null = null
  private pulses: Pulse[] = []
  private bolts: Bolt[] = []
  private flashes = new Map<string, Flash>()
  private core = theCore()
  private coreAngle = 0.6
  private coreSpin = 0.2
  private coreFlash = 0
  private firing: { pair: number; at: number }[] = []
  private brain: BrainStatus | null = null
  private brainBusyAt = 0
  private voice: VoiceInfo = { phase: 'off', capturing: false }
  private hover: string | null = null
  private pointer = { x: 0, y: 0 }
  private parallax = { x: 0, y: 0 }
  private swayPhase = 0
  private swaySpeed = 1
  /** The share of the sway the layout allows (Layout.sway), eased so a relayout never jolts the camera. */
  private swayScale = 1
  private raf = 0
  private sampleTimer = 0
  private last = 0
  private lastSample = 0
  private boltClock = 0
  private voiceClock = 0
  private running = false
  private paused = false
  private motion = true
  private destroyed = false
  private broken = false
  private clock = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: EngineHooks
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas unavailable')
    this.ctx = ctx
    this.onVisibility = this.onVisibility.bind(this)
    this.frame = this.frame.bind(this)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  /* ------------------------------------------------------------- inputs */

  setMotion(on: boolean): void {
    if (this.motion === on) return
    this.motion = on
    if (!on) {
      this.pulses = []
      this.bolts = []
      this.firing = []
      this.cam.yaw = 0
    }
    this.kick()
  }

  setSize(w: number, h: number, top: number, bottom: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = w
    this.h = h
    this.top = top
    this.bottom = bottom
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
    this.relayout()
    this.kick()
  }

  setPalette(p: Palette): void {
    this.palette = p
    this.kick()
  }

  setModel(projects: MapProject[]): void {
    this.projects = projects
    this.projectOf.clear()
    const ids: string[] = []
    for (const p of projects) for (const a of p.agents) {
      ids.push(a.paneId)
      this.projectOf.set(a.paneId, p)
    }
    this.paneIds = ids
    // A pane that appears while the map is open: sent by the brain if it was
    // just busy, otherwise simply opened.
    if (this.knownPanes && this.motion) {
      for (const p of projects) for (const a of p.agents) {
        if (this.knownPanes.has(a.paneId)) continue
        const route = this.brainRecentlyBusy() ? ['brain', p.key, a.key] : [p.key, a.key]
        this.pulse(route, 'dot', this.colorOf(p.color))
      }
    }
    this.knownPanes = new Set(ids)
    // States first: which agents fold away decides the layout.
    this.tracker.sample(this.paneIds, Date.now())
    this.relayout()
    this.sample(Date.now())
    // New nodes need their words even when nothing moved.
    this.hooks.onStates()
    this.kick()
  }

  setBrain(status: BrainStatus | null): void {
    const before = this.brain
    this.brain = status
    const mood = this.mood()
    if (mood === 'busy') this.brainBusyAt = Date.now()
    if (before && status && this.motion) {
      // Something new was handed to the brain.
      if ((status.queued ?? 0) > (before.queued ?? 0)) this.pulse(['you', 'brain'], 'dot', this.palette?.accent ?? { r: 200, g: 255, b: 80 })
      if ((status.confirms?.length ?? 0) > (before.confirms?.length ?? 0))
        this.pulse(['brain', 'you'], 'diamond', this.palette?.warn ?? { r: 255, g: 180, b: 60 })
    }
    this.kick()
  }

  /** The brain said something for the voice agent to say or know. */
  brainSays(): void {
    if (!this.motion) return
    this.pulse(['brain', 'voice'], 'dot', this.palette?.accent ?? { r: 200, g: 255, b: 80 })
  }

  setVoice(v: VoiceInfo): void {
    this.voice = v
    this.kick()
  }

  setHover(key: string | null): void {
    this.hover = key
  }

  setPointer(nx: number, ny: number): void {
    this.pointer.x = nx
    this.pointer.y = ny
  }

  /** A terminal is open over the map: stop drawing what nobody can see. */
  setPaused(on: boolean): void {
    this.paused = on
    if (on) this.stopLoop()
    else this.kick()
  }

  bindNode(key: string, el: HTMLElement | null): void {
    if (el) this.els.set(key, el)
    else this.els.delete(key)
    if (!el) return
    const s = this.screens.get(key)
    if (s) this.place(key, el, s)
    this.showPlaced(key, el)
  }

  /**
   * Open a project out (its folded "not open" agents bloom round its hub and
   * everything else dims), or close it again with null.
   */
  setReveal(key: string | null): void {
    if (this.reveal === key) return
    this.reveal = key
    if (!this.motion) this.focus = key ? 1 : 0
    for (const [k, el] of this.els) this.showPlaced(k, el)
    this.kick()
  }

  /** The project key a node key belongs to (null for the brain and the stem). */
  private ownerOf(key: string): string | null {
    if (key.startsWith('p:')) return key
    if (!key.startsWith('a:')) return null
    return this.projectOf.get(key.slice(2))?.key ?? null
  }

  /** Drawn right now: placed, and not folded away (unless its project is open). */
  private shown(key: string): boolean {
    const layout = this.layout
    if (!layout || !layout.nodes.has(key)) return false
    if (!key.startsWith('a:')) return true
    const owner = this.ownerOf(key)
    const folded = owner ? layout.folded.get(owner) : undefined
    return !folded || !folded.includes(key) || this.reveal === owner
  }

  /** Nodes not placed, or folded away, are not drawn (never at 0,0); the rest dim while another project is open. */
  private showPlaced(key: string, el: HTMLElement): void {
    el.style.visibility = this.shown(key) ? '' : 'hidden'
    const owner = this.ownerOf(key)
    const dim = this.reveal !== null && owner !== null && owner !== this.reveal
    if ((el.dataset['dim'] === 'true') !== dim) {
      if (dim) el.dataset['dim'] = 'true'
      else delete el.dataset['dim']
    }
    const lp = key.startsWith('p:') ? this.layout?.labels.get(key) : undefined
    if (lp) {
      el.style.setProperty('--lx', `${lp.lx.toFixed(1)}px`)
      el.style.setProperty('--ly', `${lp.ly.toFixed(1)}px`)
      el.style.setProperty('--fx', lp.fx.toFixed(3))
      el.style.setProperty('--fy', lp.fy.toFixed(3))
    }
  }

  /** How strongly a project's canvas marks are drawn: full, or dimmed while another is open. */
  private alphaOf(projectKey: string): number {
    if (!this.reveal || projectKey === this.reveal) return 1
    return 1 - 0.72 * this.focus
  }

  /** The hover card: kept beside `key`'s point, on whichever side has room. */
  bindCard(el: HTMLElement | null, key: string | null): void {
    this.card?.ro.disconnect()
    this.card = null
    if (!el || !key) return
    const card = { el, key, w: el.offsetWidth, h: el.offsetHeight, ro: new ResizeObserver(() => {
      card.w = el.offsetWidth
      card.h = el.offsetHeight
      this.placeCard()
    }) }
    card.ro.observe(el)
    this.card = card
    this.placeCard()
  }

  screenOf(key: string): Screen | null {
    return this.screens.get(key) ?? null
  }

  stateOf(paneId: string): Sampled {
    return this.tracker.get(paneId)
  }

  mood(): BrainMood {
    const b = this.brain
    if (!b || !b.enabled) return 'off'
    return b.state
  }

  start(): void {
    this.running = true
    this.sampleTimer = window.setInterval(() => {
      // The loop samples on its own while it runs; this covers a still map.
      if (this.raf === 0) this.sample(Date.now())
    }, 1000)
    this.kick()
  }

  destroy(): void {
    this.destroyed = true
    this.running = false
    this.stopLoop()
    window.clearInterval(this.sampleTimer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.card?.ro.disconnect()
    this.card = null
    this.els.clear()
  }

  /* ------------------------------------------------------------ the loop */

  private onVisibility(): void {
    if (document.hidden) this.stopLoop()
    else this.kick()
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Draw: continuously when moving, once when still. */
  private kick(): void {
    if (!this.running || this.destroyed) return
    if (!this.motion || this.paused || document.hidden) {
      if (!this.paused) this.safeDraw(performance.now(), 0)
      return
    }
    if (this.raf) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame(now: number): void {
    this.raf = 0
    if (!this.running || this.paused || document.hidden || !this.motion) return
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000))
    this.last = now
    if (!this.safeDraw(now, dt)) return
    this.raf = requestAnimationFrame(this.frame)
  }

  /**
   * Draw, and never let a drawing bug escape: this runs inside React effects
   * (a still frame is drawn on the spot), and an exception there would take
   * the whole renderer down. A broken map stops animating and says so once.
   */
  private safeDraw(now: number, dt: number): boolean {
    if (this.broken) return false
    try {
      this.drawFrame(now, dt)
      return true
    } catch (err) {
      this.broken = true
      this.stopLoop()
      console.error('[brain map] drawing stopped:', err)
      return false
    }
  }

  private sample(now: number): void {
    this.lastSample = now
    const moved = this.tracker.sample(this.paneIds, now)
    if (moved.length === 0) return
    // An agent opened, or went back to not open: it folds out of or into its project.
    if (moved.some((t) => t.from === 'dormant' || t.to === 'dormant')) this.relayout()
    if (this.motion) for (const t of moved) this.onTransition(t)
    this.hooks.onStates()
    // A still map has to be redrawn for the new ring.
    if (!this.motion) this.kick()
  }

  private onTransition(t: Transition): void {
    const project = this.projectOf.get(t.paneId)
    if (!project) return
    const agent = `a:${t.paneId}`
    const pal = this.palette
    if (!pal) return
    const color = this.colorOf(project.color)
    if (t.to === 'working' && t.from !== 'working') {
      const route = this.brainRecentlyBusy() ? ['brain', project.key, agent] : [project.key, agent]
      this.pulse(route, 'dot', color)
    } else if (t.to === 'attention') {
      // Needs you: up through the brain (when there is one) to you.
      const route = this.mood() === 'off' ? [agent, project.key, 'you'] : [agent, project.key, 'brain', 'you']
      this.pulse(route, 'diamond', pal.warn)
    } else if (t.to === 'done') {
      this.pulse([agent, project.key, 'brain'], 'tick', mix(color, pal.ink, 0.35))
    }
  }

  private brainRecentlyBusy(): boolean {
    return this.mood() === 'busy' || Date.now() - this.brainBusyAt < DELEGATION_WINDOW_MS
  }

  private pulse(route: string[], shape: PulseShape, color: Rgb): void {
    if (!this.motion) return
    if (this.pulses.length >= MAX_PULSES) this.pulses.shift()
    this.pulses.push({ route, t: 0, speed: 1.7, shape, color })
    this.kick()
  }

  private colorOf(hex: unknown): Rgb {
    const m = typeof hex === 'string' ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null
    if (!m) return this.palette?.accent ?? { r: 160, g: 160, b: 160 }
    const h = m[1]!
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }

  private relayout(): void {
    if (this.w <= 0 || this.h <= 0) return
    const collapsed = new Set<string>()
    for (const p of this.projects) for (const a of p.agents) if (this.tracker.get(a.paneId).state === 'dormant') collapsed.add(a.key)
    this.layout = layoutMap({
      projects: this.projects,
      collapsed,
      width: this.w,
      height: this.h,
      top: this.top,
      bottom: this.bottom,
      elevation: ELEVATION,
      focal: FOCAL
    })
    this.cam.cx = this.layout.cx
    this.cam.cy = this.layout.cy
    const root = this.canvas.parentElement
    root?.style.setProperty('--core-r', `${Math.round(this.layout.coreR)}px`)
    if (root) root.dataset['compact'] = this.layout.compact ? 'true' : 'false'
    // Nothing left over from the last layout is drawn: a stale point used to draw a ring with no label.
    for (const key of [...this.screens.keys()]) if (!this.layout.nodes.has(key)) this.screens.delete(key)
    for (const [key, el] of this.els) this.showPlaced(key, el)
  }

  /* ------------------------------------------------------------- drawing */

  private drawFrame(now: number, dt: number): void {
    const layout = this.layout
    const pal = this.palette
    if (!layout || !pal) return
    this.clock += dt
    const wall = Date.now()
    if (dt > 0 && wall - this.lastSample >= SAMPLE_MS) this.sample(wall)

    // The camera: a slow sway that settles while you point at something, and
    // a touch of parallax from the pointer.
    if (this.motion) {
      const target = this.hover ? 0 : 1
      this.swaySpeed += (target - this.swaySpeed) * Math.min(1, dt * 2.5)
      this.swayPhase += dt * this.swaySpeed * ((Math.PI * 2) / 36)
      this.parallax.x += (this.pointer.x - this.parallax.x) * Math.min(1, dt * 2)
      this.parallax.y += (this.pointer.y - this.parallax.y) * Math.min(1, dt * 2)
      // Scaled by what the layout can take, so no label sways onto the legend.
      this.swayScale += ((this.layout?.sway ?? 1) - this.swayScale) * Math.min(1, dt * 2)
      this.cam.yaw = (Math.sin(this.swayPhase) * 0.06 + this.parallax.x * 0.035) * this.swayScale
      this.cam.elevation = ELEVATION - this.parallax.y * 0.025 * this.swayScale
    }
    const focusTarget = this.reveal ? 1 : 0
    this.focus = this.motion && dt > 0 ? this.focus + (focusTarget - this.focus) * Math.min(1, dt * 8) : focusTarget

    // Project every node, and move its label there.
    for (const node of layout.nodes.values()) {
      const s = projectPoint(this.cam, node.x, node.y, node.z)
      this.screens.set(node.key, s)
      const el = this.els.get(node.key)
      if (el) this.place(node.key, el, s)
    }
    this.placeCard()

    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    const add = pal.dark ? 'lighter' : 'source-over'

    this.drawOrbits(ctx, layout, pal)
    this.drawLobes(ctx, pal)
    this.drawLinks(ctx, pal)
    ctx.globalCompositeOperation = add
    this.drawFlow(ctx, pal)
    ctx.globalCompositeOperation = 'source-over'
    this.drawHubs(ctx, pal)
    this.drawAgentRings(ctx, pal, now)
    this.drawStem(ctx, pal, now, dt)
    this.drawCore(ctx, layout, pal, now, dt)
    ctx.globalCompositeOperation = add
    this.drawBolts(ctx, dt)
    this.drawPulses(ctx, dt)
    ctx.globalCompositeOperation = 'source-over'
    this.drawFlashes(ctx, now)
  }

  /** Keep a label on its point: translate, a hint of depth scale, stacking by depth. */
  private place(key: string, el: HTMLElement, s: Screen): void {
    const scale = 0.9 + (s.s - 1) * 1.2
    el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`
    // The open project's nodes stay above the dimmed rest.
    el.style.zIndex = String(Math.round(2000 - s.d) + (this.reveal && this.ownerOf(key) === this.reveal ? 1000 : 0))
  }

  private placeCard(): void {
    const c = this.card
    if (!c) return
    const s = this.screens.get(c.key)
    if (!s) return
    const reach = (c.key === 'brain' && this.layout ? this.layout.coreR * 1.2 : 34) * s.s
    let x = s.x + reach
    if (x + c.w > this.w - 12) x = s.x - reach - c.w
    // A project's card keeps clear of its own label and of the agents blooming out of it.
    const lp = c.key.startsWith('p:') ? this.layout?.labels.get(c.key) : undefined
    if (lp) {
      const sc = 0.9 + (s.s - 1) * 1.2
      const lx0 = s.x + (lp.lx - lp.fx * lp.w) * sc
      const lx1 = lx0 + lp.w * sc
      const dir = this.layout?.bloomDir.get(c.key)?.x ?? (s.x < this.w / 2 ? -1 : 1)
      const right = Math.max(lx1, s.x + reach) + 12
      const left = Math.min(lx0, s.x - reach) - 12 - c.w
      x = dir > 0 ? left : right
      if (x < 12) x = right
      if (x + c.w > this.w - 12) x = left
    }
    x = Math.max(12, Math.min(this.w - 12 - c.w, x))
    const y = Math.max(this.top + 8, Math.min(this.h - this.bottom - c.h - 8, s.y - c.h / 2))
    c.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
  }

  private curve(a: string, b: string): { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number } | null {
    const layout = this.layout
    if (!layout) return null
    const na = layout.nodes.get(a)
    const nb = layout.nodes.get(b)
    const sa = this.screens.get(a)
    const sb = this.screens.get(b)
    if (!na || !nb || !sa || !sb) return null
    const dist = Math.hypot(na.x - nb.x, na.z - nb.z)
    const lift = dist * (na.kind === 'agent' || nb.kind === 'agent' ? 0.14 : 0.3)
    const c = projectPoint(this.cam, (na.x + nb.x) / 2, (na.y + nb.y) / 2 + lift, (na.z + nb.z) / 2)
    return { x0: sa.x, y0: sa.y, cx: c.x, cy: c.y, x1: sb.x, y1: sb.y }
  }

  private stroke(ctx: CanvasRenderingContext2D, a: string, b: string): boolean {
    const c = this.curve(a, b)
    if (!c) return false
    ctx.beginPath()
    ctx.moveTo(c.x0, c.y0)
    ctx.quadraticCurveTo(c.cx, c.cy, c.x1, c.y1)
    ctx.stroke()
    return true
  }

  private drawOrbits(ctx: CanvasRenderingContext2D, layout: Layout, pal: Palette): void {
    ctx.lineWidth = 1
    const ring = (r: number, from: number, to: number, alpha: number, dash: number[]): void => {
      ctx.setLineDash(dash)
      ctx.strokeStyle = rgba(pal.ink, alpha)
      ctx.beginPath()
      const steps = 72
      for (let i = 0; i <= steps; i++) {
        const a = from + ((to - from) * i) / steps
        const p = projectPoint(this.cam, Math.cos(a) * r * layout.ux, 0, Math.sin(a) * r * layout.uz)
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }
    const [a0, a1] = layout.arc
    ring(layout.rings[0]!, a0, a1, pal.dark ? 0.1 : 0.14, [2, 5])
    ring(layout.rings[1]!, a0 - 0.08, a1 + 0.08, pal.dark ? 0.05 : 0.08, [1, 7])
    ring(0.52, 0, Math.PI * 2, pal.dark ? 0.06 : 0.1, [])
    ctx.setLineDash([])
  }

  /** Each project's region: one fat translucent stroke through its hub and agents. */
  private drawLobes(ctx: CanvasRenderingContext2D, pal: Palette): void {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const p of this.projects) {
      const hub = this.screens.get(p.key)
      if (!hub) continue
      ctx.beginPath()
      ctx.moveTo(hub.x, hub.y)
      ctx.lineTo(hub.x + 0.01, hub.y)
      for (const a of p.agents) {
        const s = this.screens.get(a.key)
        if (!s || !this.shown(a.key)) continue
        ctx.moveTo(hub.x, hub.y)
        ctx.lineTo(s.x, s.y)
      }
      ctx.lineWidth = 58 * hub.s
      ctx.strokeStyle = rgba(this.colorOf(p.color), (pal.dark ? (p.active ? 0.085 : 0.055) : p.active ? 0.12 : 0.08) * this.alphaOf(p.key))
      ctx.stroke()
    }
  }

  private drawLinks(ctx: CanvasRenderingContext2D, pal: Palette): void {
    ctx.lineCap = 'round'
    const brainOn = this.mood() !== 'off'
    for (const p of this.projects) {
      const color = this.colorOf(p.color)
      const k = this.alphaOf(p.key)
      ctx.lineWidth = p.active ? 1.6 : 1.1
      ctx.setLineDash(brainOn ? [] : [3, 5])
      ctx.strokeStyle = rgba(color, (p.active ? 0.5 : 0.3) * (brainOn ? 1 : 0.7) * k)
      this.stroke(ctx, 'brain', p.key)
      ctx.setLineDash([])
      for (const a of p.agents) {
        if (!this.shown(a.key)) continue
        const state = this.tracker.get(a.paneId).state
        const live = state === 'working' || state === 'attention' || state === 'done'
        ctx.lineWidth = live ? 1.6 : 1
        if (state === 'dormant' || state === 'exited' || state === 'failed') ctx.setLineDash([2, 4])
        ctx.strokeStyle =
          state === 'attention' ? rgba(pal.warn, 0.6 * k) : rgba(color, (live ? 0.6 : state === 'dormant' ? 0.3 : 0.32) * k)
        this.stroke(ctx, p.key, a.key)
        ctx.setLineDash([])
      }
    }
    // The stem: you → voice → brain.
    ctx.lineWidth = 1.2
    ctx.strokeStyle = rgba(pal.ink, 0.22)
    this.stroke(ctx, 'you', 'voice')
    ctx.strokeStyle = rgba(pal.accent, 0.3)
    this.stroke(ctx, 'voice', 'brain')
  }

  private pointOn(a: string, b: string, u: number): { x: number; y: number } | null {
    const c = this.curve(a, b)
    if (!c) return null
    const v = 1 - u
    return { x: v * v * c.x0 + 2 * v * u * c.cx + u * u * c.x1, y: v * v * c.y0 + 2 * v * u * c.cy + u * u * c.y1 }
  }

  /** A route position: t runs 0..route.length-1 across its segments. */
  private along(route: string[], t: number): { x: number; y: number } | null {
    const seg = Math.min(route.length - 2, Math.max(0, Math.floor(t)))
    const u = Math.min(1, Math.max(0, t - seg))
    return this.pointOn(route[seg]!, route[seg + 1]!, u)
  }

  /** Working agents: a slow current running from the brain out to them. */
  private drawFlow(ctx: CanvasRenderingContext2D, pal: Palette): void {
    let n = 0
    for (const p of this.projects) {
      const color = this.colorOf(p.color)
      for (const a of p.agents) {
        if (this.tracker.get(a.paneId).state !== 'working') continue
        for (let k = 0; k < 2 && n < MAX_FLOW; k++, n++) {
          const seed = (a.paneId.charCodeAt(a.paneId.length - 1) % 17) / 17
          const t = ((this.clock * 0.3 + seed + k * 0.5) % 1) * 2
          const route = ['brain', p.key, a.key]
          for (let j = 0; j < 4; j++) {
            const q = this.along(route, t - j * 0.035)
            if (!q) continue
            ctx.fillStyle = rgba(j === 0 ? mix(color, pal.ink, 0.3) : color, (0.55 - j * 0.12) * (pal.dark ? 1 : 1.2))
            ctx.beginPath()
            ctx.arc(q.x, q.y, 2.1 - j * 0.35, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }
  }

  private drawHubs(ctx: CanvasRenderingContext2D, pal: Palette): void {
    for (const p of this.projects) {
      const s = this.screens.get(p.key)
      if (!s) continue
      const color = this.colorOf(p.color)
      // A project with nothing live to show is quieter: smaller, softer dot.
      const quiet = !p.agents.some((a) => this.tracker.get(a.paneId).state !== 'dormant')
      const k = this.alphaOf(p.key) * (quiet ? 0.6 : 1)
      const r = (quiet ? 5 : 6.5) * s.s
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 4)
      g.addColorStop(0, rgba(color, (pal.dark ? 0.35 : 0.25) * k))
      g.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(s.x, s.y, r * 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = rgba(color, Math.max(0.3, k))
      ctx.beginPath()
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = 1.2
      ctx.strokeStyle = rgba(color, 0.55 * k)
      ctx.beginPath()
      ctx.arc(s.x, s.y, r + 4.5 * s.s, 0, Math.PI * 2)
      ctx.stroke()
      if (p.active) {
        ctx.strokeStyle = rgba(pal.ink, 0.5)
        ctx.setLineDash([2, 3])
        ctx.beginPath()
        ctx.arc(s.x, s.y, r + 9 * s.s, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }

  /** The state, as a shape around each agent's disc. */
  private drawAgentRings(ctx: CanvasRenderingContext2D, pal: Palette, now: number): void {
    const spin = this.motion ? now / 1000 : 0
    for (const p of this.projects) {
      const color = this.colorOf(p.color)
      ctx.globalAlpha = this.alphaOf(p.key)
      for (const a of p.agents) {
        const s = this.screens.get(a.key)
        if (!s || !this.shown(a.key)) continue
        const scale = 0.9 + (s.s - 1) * 1.2
        const r = 23 * scale
        const state = this.tracker.get(a.paneId).state
        ctx.lineWidth = 1.2
        if (state === 'working') {
          // A moving ring: two arcs chasing each other round.
          const g = ctx.createRadialGradient(s.x, s.y, r * 0.6, s.x, s.y, r * 1.9)
          g.addColorStop(0, rgba(color, pal.dark ? 0.22 : 0.16))
          g.addColorStop(1, rgba(color, 0))
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(s.x, s.y, r * 1.9, 0, Math.PI * 2)
          ctx.fill()
          ctx.lineWidth = 2.4
          ctx.strokeStyle = rgba(mix(color, pal.ink, pal.dark ? 0.15 : 0), 0.95)
          const a0 = spin * 3.2
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, a0, a0 + 1.4)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, a0 + Math.PI, a0 + Math.PI + 1.4)
          ctx.stroke()
          ctx.lineWidth = 1
          ctx.strokeStyle = rgba(color, 0.3)
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
          ctx.stroke()
        } else if (state === 'attention') {
          // Needs you: a diamond, breathing.
          const k = this.motion ? 1 + 0.08 * Math.sin(now / 260) : 1
          const d = r * 1.16 * k
          ctx.lineWidth = 2
          ctx.strokeStyle = rgba(pal.warn, 0.95)
          ctx.fillStyle = rgba(pal.warn, pal.dark ? 0.1 : 0.12)
          ctx.beginPath()
          ctx.moveTo(s.x, s.y - d)
          ctx.lineTo(s.x + d, s.y)
          ctx.lineTo(s.x, s.y + d)
          ctx.lineTo(s.x - d, s.y)
          ctx.closePath()
          ctx.fill()
          ctx.stroke()
        } else if (state === 'done') {
          ctx.lineWidth = 2
          ctx.strokeStyle = rgba(mix(color, pal.ink, 0.4), 0.9)
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
          ctx.stroke()
        } else if (state === 'starting') {
          ctx.setLineDash([3, 3])
          ctx.lineDashOffset = -spin * 12
          ctx.strokeStyle = rgba(color, 0.6)
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.lineDashOffset = 0
        } else if (state === 'dormant' || state === 'exited' || state === 'failed') {
          ctx.setLineDash([1.5, 4])
          ctx.strokeStyle = rgba(pal.muted, 0.55)
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
        } else {
          // Ready: a still, quiet ring.
          ctx.strokeStyle = rgba(color, 0.42)
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }
  }

  /** You and the voice agent: rings that breathe while it listens, spread while it speaks. */
  private drawStem(ctx: CanvasRenderingContext2D, pal: Palette, now: number, dt: number): void {
    ctx.globalAlpha = 1
    const v = this.screens.get('voice')
    const you = this.screens.get('you')
    if (!v || !you) return
    const phase = this.voice.phase
    const on = phase !== 'off'
    const r = 22 * (0.9 + (v.s - 1) * 1.2)
    ctx.lineWidth = 1.3
    ctx.setLineDash(on ? [] : [2, 4])
    ctx.strokeStyle = rgba(on ? pal.accent : pal.muted, on ? 0.7 : 0.5)
    ctx.beginPath()
    ctx.arc(v.x, v.y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    if (this.motion && (phase === 'speaking' || phase === 'listening' || phase === 'thinking')) {
      const speed = phase === 'speaking' ? 1.1 : phase === 'thinking' ? 0.8 : 0.45
      for (let i = 0; i < 3; i++) {
        const k = (now / 1000) * speed + i / 3
        const f = k - Math.floor(k)
        ctx.strokeStyle = rgba(pal.accent, (1 - f) * (phase === 'listening' ? 0.25 : 0.45))
        ctx.beginPath()
        ctx.arc(v.x, v.y, r + f * 22, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    // Steve talking: words travelling up the stem.
    if (this.motion && this.voice.capturing) {
      this.voiceClock += dt
      if (this.voiceClock > 0.55) {
        this.voiceClock = 0
        this.pulse(['you', 'voice'], 'dot', pal.accent)
      }
    }
    if (this.motion && phase === 'speaking') {
      this.voiceClock += dt
      if (this.voiceClock > 0.8) {
        this.voiceClock = 0
        this.pulse(['voice', 'you'], 'dot', pal.accent)
      }
    }
    const ry = 18 * (0.9 + (you.s - 1) * 1.2)
    ctx.strokeStyle = rgba(pal.ink, 0.35)
    ctx.beginPath()
    ctx.arc(you.x, you.y, ry, 0, Math.PI * 2)
    ctx.stroke()
  }

  private drawCore(ctx: CanvasRenderingContext2D, layout: Layout, pal: Palette, now: number, dt: number): void {
    const s = this.screens.get('brain')
    if (!s) return
    const mood = this.mood()
    const R = layout.coreR * s.s
    const cx = s.x
    const cy = s.y
    const off = mood === 'off' || mood === 'error'
    const base = off ? pal.muted : mood === 'asking' ? mix(pal.accent, pal.warn, 0.6) : pal.accent
    const spinTarget = mood === 'off' ? 0.04 : mood === 'busy' ? 0.9 : mood === 'asking' ? 0.3 : mood === 'starting' ? 0.5 : 0.22
    this.coreSpin += (spinTarget - this.coreSpin) * Math.min(1, dt * 1.5)
    if (this.motion) this.coreAngle += dt * this.coreSpin
    this.coreFlash = Math.max(0, this.coreFlash - dt * 1.6)
    const energy = (off ? 0.25 : mood === 'busy' ? 1 : 0.6) + this.coreFlash * 0.6

    // The glow it sits in.
    const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.1)
    glow.addColorStop(0, rgba(base, (pal.dark ? 0.2 : 0.14) * energy))
    glow.addColorStop(1, rgba(base, 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, R * 2.1, 0, Math.PI * 2)
    ctx.fill()

    // A tilted orbit round it, with a spark riding it.
    ctx.lineWidth = 1
    ctx.strokeStyle = rgba(base, 0.28)
    ctx.beginPath()
    ctx.ellipse(cx, cy + R * 0.08, R * 1.5, R * 0.42, -0.12, 0, Math.PI * 2)
    ctx.stroke()
    if (!off) {
      const a = this.coreAngle * 2.2
      const sx = cx + Math.cos(a) * R * 1.5 * Math.cos(-0.12) - Math.sin(a) * R * 0.42 * Math.sin(-0.12)
      const sy = cy + R * 0.08 + Math.cos(a) * R * 1.5 * Math.sin(-0.12) + Math.sin(a) * R * 0.42 * Math.cos(-0.12)
      ctx.fillStyle = rgba(mix(base, pal.ink, 0.4), 0.9)
      ctx.beginPath()
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }

    // The brain itself: the cloud turned, tipped toward us, and projected.
    const ca = Math.cos(this.coreAngle)
    const sa = Math.sin(this.coreAngle)
    const tilt = 0.32
    const ct = Math.cos(tilt)
    const st = Math.sin(tilt)
    const pts = this.core.pts
    const px = new Float32Array(pts.length)
    const py = new Float32Array(pts.length)
    const pz = new Float32Array(pts.length)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      const x1 = p.x * ca + p.z * sa
      const z1 = -p.x * sa + p.z * ca
      const y2 = p.y * ct - z1 * st
      const z2 = p.y * st + z1 * ct
      const persp = 3.2 / (3.2 + z2)
      px[i] = cx + x1 * R * 0.86 * persp
      py[i] = cy - y2 * R * 0.86 * persp
      pz[i] = z2
    }
    const add = pal.dark ? 'lighter' : 'source-over'
    ctx.globalCompositeOperation = add
    ctx.lineWidth = 0.8
    // Batched into depth bands: five strokes, not four hundred.
    const pairs = this.core.pairs
    const BANDS = 5
    for (let band = 0; band < BANDS; band++) {
      ctx.beginPath()
      for (let k = 0; k < pairs.length; k++) {
        const [i, j] = pairs[k]!
        const near = 1 - ((pz[i]! + pz[j]!) / 2 + 1) / 2
        if (Math.min(BANDS - 1, Math.floor(near * BANDS)) !== band) continue
        ctx.moveTo(px[i]!, py[i]!)
        ctx.lineTo(px[j]!, py[j]!)
      }
      ctx.strokeStyle = rgba(base, (0.1 + ((band + 0.5) / BANDS) * 0.32) * energy)
      ctx.stroke()
    }
    // Synapses firing: brief bright links, more of them the busier it is.
    if (this.motion && !off) {
      const rate = mood === 'busy' ? 26 : mood === 'starting' ? 10 : 3
      if (Math.random() < rate * dt) this.firing.push({ pair: Math.floor(Math.random() * pairs.length), at: now })
      this.firing = this.firing.filter((f) => now - f.at < 420)
      ctx.lineWidth = 1.6
      for (const f of this.firing) {
        const [i, j] = pairs[f.pair]!
        const life = 1 - (now - f.at) / 420
        ctx.strokeStyle = rgba(mix(base, pal.ink, 0.5), life * 0.9)
        ctx.beginPath()
        ctx.moveTo(px[i]!, py[i]!)
        ctx.lineTo(px[j]!, py[j]!)
        ctx.stroke()
      }
    }
    for (let band = 0; band < BANDS; band++) {
      const near = (band + 0.5) / BANDS
      ctx.fillStyle = rgba(near > 0.6 ? mix(base, pal.ink, 0.25) : base, (0.25 + near * 0.75) * Math.min(1, energy + 0.2))
      const size = 0.7 + near * 1.5
      ctx.beginPath()
      for (let i = 0; i < pts.length; i++) {
        const k = 1 - (pz[i]! + 1) / 2
        if (Math.min(BANDS - 1, Math.floor(k * BANDS)) !== band) continue
        ctx.rect(px[i]! - size / 2, py[i]! - size / 2, size, size)
      }
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'

    // Bolts flying in: now and then when idle, a stream when busy.
    if (this.motion && !off) {
      const rate = mood === 'busy' ? 3.2 : mood === 'starting' ? 1.5 : 0.35
      this.boltClock += dt * rate
      if (this.boltClock >= 1) {
        this.boltClock = 0
        this.spawnBolt(cx, cy, R, mix(base, pal.ink, pal.dark ? 0.35 : 0))
      }
    }
  }

  private spawnBolt(cx: number, cy: number, R: number, color: Rgb): void {
    if (this.bolts.length >= MAX_BOLTS) return
    // Short and close in, inside the core's own glow. They used to start 2.3-3 core
    // radii out, among the project labels, where a two-segment zigzag caught on a
    // diagonal read as a stray "┘" bracket.
    const a = Math.random() * Math.PI * 2
    const from = R * (1.3 + Math.random() * 0.3)
    const to = R * 0.8
    const pts: { x: number; y: number }[] = []
    const n = 5
    for (let i = 0; i <= n; i++) {
      const r = from + ((to - from) * i) / n
      const jag = i === 0 || i === n ? 0 : (i % 2 === 0 ? 1 : -1) * R * (0.03 + Math.random() * 0.04)
      pts.push({
        x: cx + Math.cos(a) * r - Math.sin(a) * jag,
        y: cy + Math.sin(a) * r * 0.8 + Math.cos(a) * jag
      })
    }
    this.bolts.push({ pts, t: 0, color })
  }

  private drawBolts(ctx: CanvasRenderingContext2D, dt: number): void {
    if (this.bolts.length === 0) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const next: Bolt[] = []
    for (const b of this.bolts) {
      b.t += dt / 0.42
      if (b.t >= 1) {
        this.coreFlash = Math.min(1, this.coreFlash + 0.35)
        continue
      }
      next.push(b)
      const head = b.t
      const tail = Math.max(0, head - 0.45)
      const pts = b.pts
      const n = pts.length - 1
      const at = (f: number): { x: number; y: number } => {
        const k = Math.min(n - 1e-6, f * n)
        const i = Math.floor(k)
        const u = k - i
        return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * u, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * u }
      }
      const path = (): void => {
        ctx.beginPath()
        const p0 = at(tail)
        ctx.moveTo(p0.x, p0.y)
        for (let i = Math.ceil(tail * n); i < head * n; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
        const p1 = at(head)
        ctx.lineTo(p1.x, p1.y)
      }
      ctx.lineWidth = 4
      ctx.strokeStyle = rgba(b.color, 0.16)
      path()
      ctx.stroke()
      ctx.lineWidth = 1.4
      ctx.strokeStyle = rgba(b.color, 0.95)
      path()
      ctx.stroke()
    }
    this.bolts = next
  }

  private drawPulses(ctx: CanvasRenderingContext2D, dt: number): void {
    if (this.pulses.length === 0) return
    const next: Pulse[] = []
    for (const p of this.pulses) {
      p.t += dt * p.speed
      const end = p.route.length - 1
      if (p.t >= end) {
        const last = p.route[end]!
        this.flashes.set(last, { at: performance.now(), color: p.color })
        if (last === 'brain') this.coreFlash = Math.min(1, this.coreFlash + 0.6)
        continue
      }
      next.push(p)
      // Ease within each segment so a pulse leaves and lands gently.
      const seg = Math.floor(p.t)
      const u = p.t - seg
      const eased = seg + u * u * (3 - 2 * u)
      for (let j = 9; j >= 1; j--) {
        const q = this.along(p.route, Math.max(0, eased - j * 0.03))
        if (!q) continue
        ctx.fillStyle = rgba(p.color, (1 - j / 10) * 0.5)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 2.6 * (1 - j / 12), 0, Math.PI * 2)
        ctx.fill()
      }
      const h = this.along(p.route, eased)
      if (!h) continue
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, 14)
      g.addColorStop(0, rgba(p.color, 0.55))
      g.addColorStop(1, rgba(p.color, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(h.x, h.y, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = rgba(p.color, 1)
      ctx.strokeStyle = rgba(p.color, 1)
      if (p.shape === 'diamond') {
        ctx.beginPath()
        ctx.moveTo(h.x, h.y - 5)
        ctx.lineTo(h.x + 5, h.y)
        ctx.lineTo(h.x, h.y + 5)
        ctx.lineTo(h.x - 5, h.y)
        ctx.closePath()
        ctx.fill()
      } else if (p.shape === 'tick') {
        ctx.lineWidth = 2.2
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(h.x - 4.5, h.y + 0.5)
        ctx.lineTo(h.x - 1.2, h.y + 3.8)
        ctx.lineTo(h.x + 5, h.y - 3.6)
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.arc(h.x, h.y, 3.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    this.pulses = next
  }

  /** A ring spreading from wherever a pulse just landed. */
  private drawFlashes(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.flashes.size === 0) return
    ctx.lineWidth = 1.6
    for (const [key, f] of this.flashes) {
      const life = (now - f.at) / 700
      const s = this.screens.get(key)
      if (life >= 1 || !s) {
        this.flashes.delete(key)
        continue
      }
      const base = key === 'brain' && this.layout ? this.layout.coreR * s.s : 22 * s.s
      ctx.strokeStyle = rgba(f.color, (1 - life) * 0.7)
      ctx.beginPath()
      ctx.arc(s.x, s.y, base + life * 26, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}


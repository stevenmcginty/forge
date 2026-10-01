import { useEffect, useRef, type ReactNode } from 'react'
import { reducedMotion, usePresence } from '@/lib/motion'

/**
 * A copy of the desktop's src/components/DictationEdge.tsx for the deck face,
 * so the web bar's edge moves exactly as the desktop bar's does. Copied, not
 * imported: the desktop file's neighbours (DictationCueView, DictationCue.css)
 * belong to the desktop app's own stores and styles. Only the names changed —
 * the canvas is `.dk-edge` and its colours are the deck's `--dk-dict-*` and
 * `--dk-agent-*` (./voicebar.css) — plus where the level comes from: the
 * browser's own microphone (lib/voice-level.ts, 20 reports a second) or the
 * voice agent's (./voiceAgent.ts), not the desktop's sidecar.
 *
 * What follows is the desktop's own description.
 *
 * The voice bar's edge, as the synthesizer.
 *
 * While a dictation goes into the bar (its mic button, or the Dictate key while
 * the bar is on screen), the bar's whole outline becomes a living ribbon: a
 * smooth closed wave hugging the border, its swell fed by the mic level — the
 * newest level at the mic button's end and older ones further round — so as
 * Steve talks the swell travels round the bar from the button. Silence is a
 * gentle breathing pulse with a slow wave moving round it, never still, never
 * hair-like: every point is smoothed with its neighbours and drawn as one curve.
 *
 *   starting   the edge draws itself in from the button end, then a light runs round
 *   listening  ripples round the edge with the voice
 *   finishing  the ripples run out and settle
 *   sending    the edge drains back to the button with the "Sending… 1.5 s" clock
 *
 * Layers, back to front: a low glow along the crest, a softer ribbon half a beat
 * behind (depth), the ribbon itself with its colour flowing round the edge
 * (faster as he talks), a fine line riding its crest, then the rim and a bright
 * thin core line on it. Presence comes from the core line and the contrast, not
 * from reach: the ribbon stays within ~7px of the border and the glow is faint,
 * so everything near the bar stays clickable.
 *
 * Fluid: each 10 Hz level report is eased in over its interval, then followed
 * with a ~50 ms attack and ~250 ms release; the waves are read from a history
 * resampled at 120 Hz, between samples, so they glide at one speed whatever
 * the frame rate. Phase changes ease (the voice's amplitude, the draw-in, the
 * drain) instead of switching; at rest the shimmer breathes.
 *
 * One canvas, laid over the bar and a few pixels past it, pointer-events none.
 * Its box is measured on resize only; each frame is canvas drawing and nothing
 * else — no layout reads, no React state. The loop runs only while there is a
 * phase to show, and stops when it has faded out. Reduced motion: a steady
 * ring and core line whose glow follows the voice, redrawn ten times a second.
 *
 * Colours come from --edge-a/b/c and --edge-core (./voicebar.css): indigo →
 * violet → lavender for dictation, lime → citrus → pale for the agent. Never red
 * or green against each other: Steve is red-green colourblind. The words inside
 * the bar still say the state.
 */

/** Where the edge is: the desktop's DictationCueView `CuePhase`. */
export type CuePhase = 'starting' | 'listening' | 'finishing' | 'sending'
/** The two levels the edge can follow, 0..1: the microphone, and the agent's voice as it speaks. */
export type ReadLevels = () => { mic: number; out: number }

/** The level is resampled at this rate into the history the waves are read from. */
const SAMPLE_HZ = 120
const SAMPLE_MS = 1000 / SAMPLE_HZ
/** 3.5 s of voice: enough for the slower agent wave to reach the far end of the widest bar. */
const HISTORY = 420
/** How often the browser's level moves (voice-level.ts samples every 50 ms); each change is eased in over this long. */
const REPORT_MS = 50
/** The glow: three soft passes, all within the old reach (width, alpha). */
const GLOW: ReadonlyArray<readonly [number, number]> = [
  [9, 0.03],
  [5.5, 0.055],
  [3, 0.11]
]
/** Pixels of edge between two points of the ribbon's crest. */
const SPACING = 4
/**
 * The two voices the edge can carry. Dictation is the star: violet, taller,
 * quicker. The agent (Jarvis listening or speaking) is the lesser one: its own
 * volt, half the height and glow, slower. The same idea, clearly not the same
 * mode. Colours come from --edge-a/b/c on the canvas (DictationCue.css).
 */
const VARIANTS = {
  /** `speed`: pixels of edge per millisecond the wave travels. */
  dictation: { height: 1, glow: 1, speed: 0.5, pace: 1 },
  agent: { height: 0.5, glow: 0.5, speed: 0.32, pace: 0.6 }
} as const
export type EdgeVariant = keyof typeof VARIANTS
const TAU = Math.PI * 2
const DRAW_IN_MS = 700

/** cubic-bezier(0.25, 1, 0.5, 1)'s shape: quick out, long settle, no overshoot. */
function easeOutQuart(x: number): number {
  return 1 - (1 - x) ** 4
}

type Rgb = [number, number, number]

interface Geometry {
  /** The canvas, CSS pixels. */
  cw: number
  ch: number
  /** The bar's border box inside it. */
  x0: number
  y0: number
  w: number
  h: number
  r: number
  /** Room outside the border for the bars and the glow. */
  pad: number
  perimeter: number
  /** Per bar: where on the border, which way is out, how far round from the button end, and where round the whole edge. */
  xs: Float32Array
  ys: Float32Array
  nxs: Float32Array
  nys: Float32Array
  dist: Float32Array
  frac: Float32Array
  /** A per-bar constant so neighbours do not move in lockstep. */
  seed: Float32Array
}

/**
 * Walk the rounded rectangle from the middle of its right end (the mic button),
 * clockwise: down the right side, along the bottom, up the left, along the top,
 * and back down to the start.
 */
function measure(cw: number, ch: number, pad: number, w: number, h: number, radius: number): Geometry {
  const x0 = pad
  const y0 = pad
  const x1 = pad + w
  const y1 = pad + h
  const r = Math.max(0, Math.min(radius, h / 2, w / 2))
  const midY = y0 + h / 2
  const halfSide = Math.max(0, h / 2 - r)
  const arc = (r * Math.PI) / 2
  const straightW = Math.max(0, w - 2 * r)
  const straightH = Math.max(0, h - 2 * r)

  type Seg = { len: number; at: (u: number) => [number, number, number, number] }
  const line =
    (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) =>
    (u: number): [number, number, number, number] => [ax + (bx - ax) * u, ay + (by - ay) * u, nx, ny]
  const corner =
    (cx: number, cy: number, from: number) =>
    (u: number): [number, number, number, number] => {
      const a = from + (u * Math.PI) / 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      return [cx + r * c, cy + r * s, c, s]
    }
  const segs: Seg[] = [
    { len: halfSide, at: line(x1, midY, x1, y1 - r, 1, 0) },
    { len: arc, at: corner(x1 - r, y1 - r, 0) },
    { len: straightW, at: line(x1 - r, y1, x0 + r, y1, 0, 1) },
    { len: arc, at: corner(x0 + r, y1 - r, Math.PI / 2) },
    { len: straightH, at: line(x0, y1 - r, x0, y0 + r, -1, 0) },
    { len: arc, at: corner(x0 + r, y0 + r, Math.PI) },
    { len: straightW, at: line(x0 + r, y0, x1 - r, y0, 0, -1) },
    { len: arc, at: corner(x1 - r, y0 + r, (3 * Math.PI) / 2) },
    { len: halfSide, at: line(x1, y0 + r, x1, midY, 1, 0) }
  ]
  const perimeter = segs.reduce((n, s) => n + s.len, 0)
  const count = Math.max(8, Math.floor(perimeter / SPACING))
  const xs = new Float32Array(count)
  const ys = new Float32Array(count)
  const nxs = new Float32Array(count)
  const nys = new Float32Array(count)
  const dist = new Float32Array(count)
  const frac = new Float32Array(count)
  const seed = new Float32Array(count)
  let seg = 0
  let segStart = 0
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) * (perimeter / count)
    while (seg < segs.length - 1 && s > segStart + segs[seg]!.len) {
      segStart += segs[seg]!.len
      seg++
    }
    const cur = segs[seg]!
    const [x, y, nx, ny] = cur.at(cur.len > 0 ? Math.min(1, (s - segStart) / cur.len) : 0)
    xs[i] = x
    ys[i] = y
    nxs[i] = nx
    nys[i] = ny
    dist[i] = Math.min(s, perimeter - s)
    frac[i] = s / perimeter
    seed[i] = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1
  }
  return { cw, ch, x0, y0, w, h, r, pad, perimeter, xs, ys, nxs, nys, dist, frac, seed }
}

function parseColor(value: string, fallback: Rgb): Rgb {
  const v = value.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(v)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return fallback
}

const rgba = (c: Rgb, a: number): string =>
  `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`

export function DictationEdge({
  phase,
  endsAt = null,
  readLevels,
  compact = false,
  variant = 'dictation',
  feed = 'mic'
}: {
  /** Null: nothing is being dictated; the edge fades and its loop stops. */
  phase: CuePhase | null
  /** The send countdown's end, while `phase` is sending. */
  endsAt?: number | null
  readLevels: ReadLevels
  /** The slim top bar: less room above and below it. */
  compact?: boolean
  variant?: EdgeVariant
  /** Which level moves it while `phase` is listening: the mic, or the agent's voice as it speaks. */
  feed?: 'mic' | 'out'
}): ReactNode {
  const { mounted, closing } = usePresence(phase !== null, 260)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const live = useRef({ phase, endsAt, readLevels, feed })
  live.current = { phase: phase ?? live.current.phase, endsAt: endsAt ?? live.current.endsAt, readLevels, feed }
  /** When the phase last changed, for the draw-in and the drain. */
  const since = useRef<{ phase: CuePhase | null; at: number; drainFrom: number }>({ phase: null, at: 0, drainFrom: 1500 })
  if (phase !== since.current.phase && phase !== null) {
    since.current = { phase, at: performance.now(), drainFrom: endsAt ? Math.max(1, endsAt - Date.now()) : 1500 }
  }
  /** Room outside the border: the bars reach about 8px past it (6 on the slim top bar), the glow a little more. */
  const pad = compact ? 10 : 12

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const still = reducedMotion()
    const tune = VARIANTS[variant]
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let geo: Geometry | null = null
    let rim: Path2D | null = null
    /** The same outline as two runs from the button end, one each way round: the partial edge. */
    let runCw: Path2D | null = null
    let runCcw: Path2D | null = null
    let stops: [Rgb, Rgb, Rgb] = [
      [109, 123, 255],
      [165, 139, 255],
      [211, 196, 255]
    ]
    let core: Rgb = [241, 237, 255]
    let frame = 0

    const readColours = (): void => {
      const cs = getComputedStyle(canvas)
      stops = [
        parseColor(cs.getPropertyValue('--edge-a'), stops[0]),
        parseColor(cs.getPropertyValue('--edge-b'), stops[1]),
        parseColor(cs.getPropertyValue('--edge-c'), stops[2])
      ]
      core = parseColor(cs.getPropertyValue('--edge-core'), core)
    }

    const resize = (): void => {
      const cs = getComputedStyle(host)
      const bl = parseFloat(cs.borderLeftWidth) || 0
      const bt = parseFloat(cs.borderTopWidth) || 0
      const w = host.offsetWidth
      const h = host.offsetHeight
      if (w < 2 || h < 2) return
      const cw = w + pad * 2
      const ch = h + pad * 2
      canvas.style.left = `${-(pad + bl)}px`
      canvas.style.top = `${-(pad + bt)}px`
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const radius = parseFloat(cs.borderTopLeftRadius) || h / 2
      geo = measure(cw, ch, pad, w, h, radius)
      rim = new Path2D()
      const inset = 0.5
      rim.roundRect(geo.x0 - inset, geo.y0 - inset, geo.w + inset * 2, geo.h + inset * 2, geo.r + inset)
      runCw = new Path2D()
      runCcw = new Path2D()
      const n = geo.xs.length
      const x1 = geo.x0 + geo.w
      const midY = geo.y0 + geo.h / 2
      runCw.moveTo(x1, midY)
      runCcw.moveTo(x1, midY)
      for (let i = 0; i < n; i++) runCw.lineTo(geo.xs[i]!, geo.ys[i]!)
      for (let i = n - 1; i >= 0; i--) runCcw.lineTo(geo.xs[i]!, geo.ys[i]!)
      readColours()
    }

    /*
     * The level, made fluid. The desktop's sidecar reports ten times a second, so
     * each new reading is first eased in over one report interval (no stairs),
     * then followed with a fast attack (~50 ms) and a slow release (~250 ms).
     */
    let level = 0
    let fromRaw = 0
    let toRaw = 0
    let rawAt = 0
    /** How much of the voice the edge shows: eases between phases instead of switching. */
    let amp = 0
    /** How much of the edge is drawn, eased on the way in. */
    let reachShown = 0
    /** Where the gradient is round the edge: flows faster as he talks. */
    let flow = 0
    /** The level, resampled at a fixed rate so the wave travels at one speed whatever the frame rate. */
    const history = new Float32Array(HISTORY)
    let head = 0
    let carry = 0
    let last = 0

    const input = (now: number): number => {
      const { phase: ph, readLevels: read, feed: from } = live.current
      // A gentle curve: quiet speech still swells visibly; loud never clips flat.
      const raw = ph === 'listening' ? Math.min(1, (read()[from] * 2.4) ** 0.7) : 0
      const eased = fromRaw + (toRaw - fromRaw) * easeOutQuart(Math.min(1, (now - rawAt) / REPORT_MS))
      if (raw !== toRaw) {
        fromRaw = eased
        toRaw = raw
        rawAt = now
      }
      return eased
    }

    /** Per point round the edge, this frame: the raw swell, then smoothed along the edge. */
    let rawOff = new Float32Array(0)
    let off = new Float32Array(0)

    /**
     * A closed smooth curve through points pushed out from the border along
     * its normal by `offset` (plus `gap`): quadratic segments through the
     * midpoints, so it is round everywhere — a ribbon's crest, not a comb.
     */
    const crest = (g: Geometry, offset: Float32Array, gap: number, scale: number): Path2D => {
      const p = new Path2D()
      const n = g.xs.length
      const px = (i: number): number => g.xs[i]! + g.nxs[i]! * (gap + offset[i]! * scale)
      const py = (i: number): number => g.ys[i]! + g.nys[i]! * (gap + offset[i]! * scale)
      p.moveTo((px(n - 1) + px(0)) / 2, (py(n - 1) + py(0)) / 2)
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        p.quadraticCurveTo(px(i), py(i), (px(i) + px(j)) / 2, (py(i) + py(j)) / 2)
      }
      p.closePath()
      return p
    }

    /** The band between the border and a crest: filled even-odd, so the bar's inside stays clear. */
    const band = (g: Geometry, outer: Path2D): Path2D => {
      const p = new Path2D(outer)
      p.roundRect(g.x0 - 0.5, g.y0 - 0.5, g.w + 1, g.h + 1, g.r + 0.5)
      return p
    }

    /**
     * Colour round the edge: a conic sweep from the bar's middle, turned by
     * `flow`. Built once a frame at full strength; each layer that wears it
     * sets its own strength with globalAlpha, so a frame makes one gradient,
     * not three.
     */
    const sweep = (g: Geometry): CanvasGradient => {
      const grad = ctx.createConicGradient(flow * TAU, g.cw / 2, g.ch / 2)
      const [a, b, c] = stops
      grad.addColorStop(0, rgba(a, 1))
      grad.addColorStop(0.33, rgba(b, 1))
      grad.addColorStop(0.66, rgba(c, 1))
      grad.addColorStop(1, rgba(a, 1))
      return grad
    }

    const draw = (now: number): void => {
      const g = geo
      if (!g || !rim || !runCw || !runCcw) return
      const { phase: ph } = live.current
      const dt = last ? Math.min(64, now - last) : 16
      last = now
      const t = now * tune.pace
      if (++frame % 60 === 0) readColours()

      const target = input(now)
      level += (target - level) * (1 - Math.exp(-dt / (target > level ? 50 : 250)))
      const ampTarget = ph === 'listening' ? 1 : ph === 'starting' ? 0.4 : 0.15
      amp += (ampTarget - amp) * (1 - Math.exp(-dt / 220))
      flow += dt * (0.00004 + 0.0002 * level) * tune.pace

      // Resample: SAMPLE_HZ fixed steps, whatever the frame rate.
      carry += dt
      while (carry >= SAMPLE_MS) {
        carry -= SAMPLE_MS
        history[head] = level
        head = (head + 1) % HISTORY
      }

      // How much of the edge shows: drawn in from the button end on the press
      // (ease-out-quart), drained back to it by the send countdown (the clock's pace).
      const s = since.current
      let reach = 1
      if (ph === 'starting') reach = easeOutQuart(Math.min(1, (now - s.at) / DRAW_IN_MS))
      else if (ph === 'sending') {
        const endAt = live.current.endsAt
        reach = endAt ? Math.max(0, Math.min(1, (endAt - Date.now()) / s.drainFrom)) : 0
      }
      reachShown += (reach - reachShown) * (1 - Math.exp(-dt / 70))
      const whole = reachShown > 0.995
      const reachDist = (reachShown * g.perimeter) / 2 + 0.5

      // The swell at every point: a breathing idle pulse with a slow wave
      // travelling round it, and on top the voice as it was when this part of
      // the wave left the mic button.
      const n = g.xs.length
      if (rawOff.length !== n) {
        rawOff = new Float32Array(n)
        off = new Float32Array(n)
      }
      const breath = 0.5 + 0.5 * Math.sin(t * 0.0026)
      const lap = ph === 'starting' ? ((now - s.at) / 1500) % 1 : -1
      for (let i = 0; i < n; i++) {
        const d = g.dist[i]!
        const f = g.frac[i]!
        const back = Math.min(HISTORY - 2, (d / tune.speed) * (SAMPLE_HZ / 1000))
        const k0 = Math.floor(back)
        const a0 = history[(head - 1 - k0 + HISTORY * 2) % HISTORY]!
        const a1 = history[(head - 2 - k0 + HISTORY * 2) % HISTORY]!
        const voice = a0 + (a1 - a0) * (back - k0)
        const swell = 0.5 + 0.5 * Math.sin(f * TAU * 3 - t * 0.0014)
        const idle = (0.24 + 0.16 * breath) * (0.2 + 0.8 * swell)
        // Crests that roll round the edge, a second, slower set across them.
        const roll = 0.5 + 0.5 * Math.sin(f * TAU * 9 - t * 0.0045)
        const cross = 0.6 + 0.4 * Math.sin(f * TAU * 4 + t * 0.0021)
        const ripple = 0.15 + 0.85 * roll * cross
        let v = idle + voice * amp * ripple * 1.5
        if (lap >= 0) {
          const gap = Math.abs(((f - lap + 1.5) % 1) - 0.5)
          v += 0.45 * Math.exp(-gap * gap * 90)
        }
        // Past the drawn-in / drained part the ribbon tapers to nothing.
        const edgeIn = Math.max(0, Math.min(1, (reachDist - d) / 24))
        rawOff[i] = Math.min(1, v) * edgeIn * edgeIn * (3 - 2 * edgeIn)
      }
      // Low-pass along the edge (a circular box blur, twice): liquid, never spiky.
      for (let pass = 0; pass < 2; pass++) {
        const src = pass === 0 ? rawOff : off
        const dst = pass === 0 ? off : rawOff
        const R = 2
        let acc = 0
        for (let j = -R; j <= R; j++) acc += src[(j + n) % n]!
        for (let i = 0; i < n; i++) {
          dst[i] = acc / (2 * R + 1)
          acc += src[(i + R + 1) % n]! - src[(i - R + n) % n]!
        }
      }
      const shape = rawOff

      ctx.clearRect(0, 0, g.cw, g.ch)
      const edge = (): void => {
        if (whole) ctx.stroke(rim!)
        else if (reachShown > 0.002) {
          ctx.setLineDash([reachDist, g.perimeter * 2])
          ctx.stroke(runCw!)
          ctx.stroke(runCcw!)
          ctx.setLineDash([])
        }
      }
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'

      const maxH = (compact ? 4.5 : 6.5) * tune.height
      const main = crest(g, shape, 0.5, maxH)

      // 1. A low glow along the crest, in the lead colour: presence, not reach.
      const glow = (0.4 + 0.5 * level * amp) * tune.glow
      for (const [lw, a] of GLOW) {
        ctx.lineWidth = lw
        ctx.strokeStyle = rgba(stops[0], a * glow)
        ctx.stroke(main)
      }

      // 2. Depth: a softer second ribbon, the same wave half a beat behind and a
      //    little shorter, in the companion colours.
      const depthShape = off
      const lag = Math.round(n / 22)
      for (let i = 0; i < n; i++) depthShape[i] = shape[(i + lag) % n]!
      const colours = sweep(g)
      ctx.fillStyle = colours
      ctx.globalAlpha = variant === 'agent' ? 0.2 : 0.28
      ctx.fill(band(g, crest(g, depthShape, 0.5, maxH)), 'evenodd')

      // 3. The ribbon itself, its colour flowing round the edge.
      ctx.globalAlpha = Math.min(1, (variant === 'agent' ? 0.5 : 0.68) + 0.2 * level * amp)
      ctx.fill(band(g, main), 'evenodd')

      // 4. Its crest, a fine bright line that rides the wave.
      ctx.lineWidth = 1.1
      ctx.strokeStyle = colours
      ctx.globalAlpha = variant === 'agent' ? 0.6 : 0.9
      ctx.stroke(main)
      ctx.globalAlpha = 1

      // 5. The rim in the companion colour, and the bright thin core line on it.
      ctx.lineWidth = 2
      ctx.strokeStyle = rgba(stops[1], variant === 'agent' ? 0.6 : 0.85)
      edge()
      ctx.lineWidth = 1
      ctx.strokeStyle = rgba(core, (variant === 'agent' ? 0.55 : 0.8) + 0.2 * level * amp)
      edge()
    }

    /** Reduced motion: a steady ring and its core line, the glow following the voice. */
    const drawStill = (): void => {
      const g = geo
      if (!g || !rim) return
      const target = input(performance.now())
      level += (target - level) * 0.5
      ctx.clearRect(0, 0, g.cw, g.ch)
      ctx.lineWidth = 9
      ctx.strokeStyle = rgba(stops[0], (0.06 + 0.14 * level) * tune.glow)
      ctx.stroke(rim)
      ctx.lineWidth = variant === 'agent' ? 2 : 3
      ctx.strokeStyle = rgba(stops[1], 0.9)
      ctx.stroke(rim)
      ctx.lineWidth = 1
      ctx.strokeStyle = rgba(core, 0.85)
      ctx.stroke(rim)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    /*
     * The loop: at most one draw per 60 Hz frame (a 120 Hz screen would
     * otherwise pay for the ribbon twice as often for no visible gain), and
     * none at all while the window is hidden.
     */
    let raf = 0
    let timer = 0
    let drawnAt = 0
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      if (now - drawnAt < 15) return
      drawnAt = now
      draw(now)
    }
    const run = (): void => {
      if (document.hidden) return
      if (still) {
        if (timer) return
        drawStill()
        timer = window.setInterval(drawStill, 100)
      } else if (!raf) {
        raf = requestAnimationFrame(loop)
      }
    }
    const rest = (): void => {
      cancelAnimationFrame(raf)
      raf = 0
      window.clearInterval(timer)
      timer = 0
    }
    const onVisibility = (): void => (document.hidden ? rest() : run())
    run()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      rest()
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
    }
  }, [mounted, pad, variant, compact])

  if (!mounted) return null
  return (
    <canvas
      ref={canvasRef}
      className="dk-edge"
      data-variant={variant}
      data-closing={closing ? 'true' : undefined}
      aria-hidden="true"
    />
  )
}

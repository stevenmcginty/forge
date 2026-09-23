import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ThemeCore } from '@shared/types'
import { useBackdrop, useBackdropImage, type BackdropId } from '@/lib/backdrop'
import { reducedMotion } from '@/lib/motion'
import { useActiveProject, useApp } from '@/state/AppState'
import { alpha, findTheme, mix } from '@/theme/themes'
import './Backdrop.css'

/**
 * The room the panes live in.
 *
 * Every built-in backdrop is drawn in code from the theme's own colours — the
 * stars and ridges of a light theme are a daylight version of the same scene —
 * and tinted by the active project's colour, so switching project changes the
 * light in the room the way CNVS switches canvases.
 *
 * Static by default. Everything is painted once (a canvas for the stars, an SVG
 * for the ridges, gradients for the rest) and then left alone; the only motion
 * is the optional drift, a single compositor-only transform that pauses while
 * the window is hidden and never runs under reduced motion. Panes are opaque, so
 * none of this ever has to be re-blurred behind a terminal.
 */
export function Backdrop(): ReactNode {
  const { state } = useApp()
  const project = useActiveProject()
  const settings = useBackdrop()
  const image = useBackdropImage()
  const core = findTheme(state.settings.themeId, state.settings.customThemes)
  const tint = project?.color && /^#[0-9a-f]{6}$/i.test(project.color) ? project.color : core.accent
  const hidden = useDocumentHidden()
  const drift = settings.drift && !reducedMotion()

  const id: BackdropId = settings.id === 'image' && !image ? 'ridgeline' : settings.id
  const pal = useMemo(() => palette(core, tint), [core, tint])

  return (
    <div
      className="backdrop"
      data-id={id}
      data-appearance={core.appearance}
      data-drift={drift ? 'true' : undefined}
      data-hidden={hidden ? 'true' : undefined}
      aria-hidden="true"
      style={{ background: pal.base } as React.CSSProperties}
    >
      <div
        className="backdrop__art"
        style={
          settings.blur > 0
            ? ({ filter: `blur(${settings.blur}px)`, transform: 'scale(1.06)' } as React.CSSProperties)
            : undefined
        }
      >
        {id === 'deepfield' ? <DeepField pal={pal} /> : null}
        {id === 'nebula' ? <Nebula pal={pal} /> : null}
        {id === 'ridgeline' ? <Ridgeline pal={pal} /> : null}
        {id === 'calm' ? <Calm pal={pal} /> : null}
        {id === 'image' && image ? (
          <div className="backdrop__image" style={{ backgroundImage: `url("${image}")` }} />
        ) : null}
      </div>
      {settings.dim > 0 ? (
        <div className="backdrop__dim" style={{ background: alpha(core.bg, settings.dim) }} />
      ) : null}
      {/* Fades the top edge into the title bar, where Windows paints its own
          window buttons in the theme's background colour. */}
      <div className="backdrop__top" style={{ background: `linear-gradient(${core.bg}, ${alpha(core.bg, 0)})` }} />
    </div>
  )
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const on = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return hidden
}

/* ---------------------------------------------------------------- palette */

interface Palette {
  light: boolean
  base: string
  bg: string
  tint: string
  accent: string
  info: string
  warm: string
  violet: string
  star: string
  starCool: string
  starWarm: string
  skyTop: string
  skyMid: string
  horizon: string
  ridges: string[]
}

function palette(core: ThemeCore, tint: string): Palette {
  const light = core.appearance === 'light'
  const bg = core.bg
  const info = core.info
  const horizon = light ? mix(bg, info, 0.1) : mix(bg, info, 0.42)
  return {
    light,
    base: bg,
    bg,
    tint,
    accent: core.accent,
    info,
    warm: core.warn,
    violet: core.ansi[5] ?? info,
    star: light ? alpha(core.text, 0.18) : '#f4f7ff',
    starCool: light ? alpha(info, 0.22) : '#aecbff',
    starWarm: light ? alpha(core.warn, 0.22) : '#ffe2b8',
    skyTop: light ? mix(bg, info, 0.16) : mix(bg, '#000000', 0.25),
    skyMid: light ? mix(bg, '#ffffff', 0.4) : mix(bg, info, 0.2),
    horizon,
    ridges: light
      ? [mix(bg, info, 0.2), mix(bg, info, 0.3), mix(mix(bg, info, 0.42), core.text, 0.08), mix(info, core.text, 0.42), mix(info, core.text, 0.62)]
      : [mix(horizon, bg, 0.32), mix(horizon, bg, 0.5), mix(horizon, bg, 0.66), mix(bg, horizon, 0.14), mix(bg, '#000000', 0.35)]
  }
}

/* ------------------------------------------------------------------ stars */

/** mulberry32: a tiny seeded generator, so the sky is the same every launch. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface StarOpts {
  density: number
  /** Fraction of the height the stars may occupy, from the top. */
  sky: number
  /** Draw a faint diagonal band of extra stars (the galaxy's disc). */
  band: boolean
  seed: number
}

/**
 * Painted once per size into a canvas a little larger than the window (so the
 * drift has margin), at device resolution. Redrawn on resize, debounced.
 */
function Stars({ pal, opts }: { pal: Palette; opts: StarOpts }): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  useEffect(() => {
    let t: number | undefined
    const on = (): void => {
      window.clearTimeout(t)
      t = window.setTimeout(() => setSize({ w: window.innerWidth, h: window.innerHeight }), 220)
    }
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('resize', on)
      window.clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = size.w + 64
    const h = size.h + 64
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const rand = rng(opts.seed)
    const skyH = h * opts.sky
    const count = Math.round(((w * skyH) / 2600) * opts.density)

    const dot = (x: number, y: number, r: number, color: string, a: number, glow: boolean): void => {
      ctx.globalAlpha = a
      if (glow) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4)
        g.addColorStop(0, color)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, r * 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    for (let i = 0; i < count; i++) {
      const x = rand() * w
      // Thinner toward the horizon, so a ridgeline sky fades out instead of stopping.
      const y = Math.pow(rand(), opts.sky < 1 ? 1.35 : 1) * skyH
      const p = rand()
      const r = p > 0.985 ? 1.25 + rand() * 0.6 : p > 0.9 ? 0.8 + rand() * 0.35 : 0.35 + rand() * 0.45
      const hue = rand()
      const color = hue > 0.86 ? pal.starCool : hue > 0.78 ? pal.starWarm : pal.star
      const a = (p > 0.9 ? 0.75 : 0.28 + rand() * 0.45) * (1 - (y / Math.max(1, skyH)) * 0.45)
      dot(x, y, r, color, a, p > 0.985)
    }

    if (opts.band) {
      // A soft diagonal river of faint stars, from lower left to upper right.
      const bandCount = Math.round(count * 0.9)
      for (let i = 0; i < bandCount; i++) {
        const t = rand()
        const spread = (rand() - 0.5 + (rand() - 0.5)) * h * 0.16
        const x = t * w
        const y = h * 0.92 - t * h * 0.78 + spread
        if (y < 0 || y > skyH) continue
        dot(x, y, 0.3 + rand() * 0.35, pal.star, 0.12 + rand() * 0.22, false)
      }
    }
    ctx.globalAlpha = 1
  }, [opts.band, opts.density, opts.seed, opts.sky, pal, size])

  return <canvas ref={ref} className="backdrop__stars" />
}

/* -------------------------------------------------------------- the scenes */

function DeepField({ pal }: { pal: Palette }): ReactNode {
  const glow = pal.light ? 0.12 : 0.3
  return (
    <>
      <div
        className="backdrop__layer"
        style={{
          background: [
            `radial-gradient(120% 90% at 18% 108%, ${alpha(pal.tint, glow)}, transparent 60%)`,
            `radial-gradient(90% 70% at 92% -8%, ${alpha(pal.info, glow * 0.55)}, transparent 62%)`,
            `radial-gradient(60% 45% at 58% 46%, ${alpha(pal.violet, glow * 0.18)}, transparent 70%)`,
            `linear-gradient(180deg, ${pal.skyTop}, ${pal.bg} 55%, ${mix(pal.bg, pal.tint, pal.light ? 0.04 : 0.05)})`
          ].join(', ')
        }}
      />
      <Stars pal={pal} opts={{ density: pal.light ? 0.35 : 1, sky: 1, band: true, seed: 7 }} />
    </>
  )
}

function Nebula({ pal }: { pal: Palette }): ReactNode {
  const k = pal.light ? 0.16 : 0.3
  return (
    <>
      <div className="backdrop__layer" style={{ background: `linear-gradient(160deg, ${pal.skyTop}, ${pal.bg})` }} />
      <div
        className="backdrop__layer backdrop__clouds"
        style={{
          background: [
            `radial-gradient(38% 42% at 24% 34%, ${alpha(pal.tint, k)}, transparent 70%)`,
            `radial-gradient(34% 38% at 74% 28%, ${alpha(pal.violet, k * 0.8)}, transparent 70%)`,
            `radial-gradient(46% 40% at 62% 78%, ${alpha(pal.info, k * 0.75)}, transparent 72%)`,
            `radial-gradient(26% 24% at 40% 62%, ${alpha(pal.warm, k * 0.35)}, transparent 70%)`
          ].join(', ')
        }}
      />
      <Stars pal={pal} opts={{ density: pal.light ? 0.25 : 0.55, sky: 1, band: false, seed: 19 }} />
    </>
  )
}

function Calm({ pal }: { pal: Palette }): ReactNode {
  return (
    <div
      className="backdrop__layer"
      style={{
        background: [
          `radial-gradient(80% 60% at 50% -10%, ${alpha(pal.tint, pal.light ? 0.08 : 0.1)}, transparent 70%)`,
          `radial-gradient(120% 90% at 50% 120%, ${alpha('#000000', pal.light ? 0.04 : 0.35)}, transparent 70%)`,
          `linear-gradient(180deg, ${pal.bg}, ${mix(pal.bg, pal.info, pal.light ? 0.06 : 0.06)})`
        ].join(', ')
      }}
    />
  )
}

/**
 * Mountains at dusk: five ridges of seeded noise, each paler and bluer the
 * further away it is (the air between you and a far ridge is the colour of the
 * sky), pines along the two nearest, and the last light low on the horizon.
 */
function Ridgeline({ pal }: { pal: Palette }): ReactNode {
  const W = 1600
  const H = 900
  const layers = useMemo(() => {
    const rand = rng(42)
    return pal.ridges.map((color, i) => {
      const base = 470 + i * 74
      const amp = 70 + i * 16
      const waves = Array.from({ length: 5 }, (_, k) => ({
        f: (0.9 + rand() * 1.6) * (k + 1) * 0.0022,
        p: rand() * Math.PI * 2,
        a: amp / (k + 1.2)
      }))
      const ys: number[] = []
      for (let x = 0; x <= W; x += 8) {
        let y = base
        for (const w of waves) y -= Math.sin(x * w.f + w.p) * w.a
        // Rock is not smooth: a little jitter on the far ridges, more up close.
        y += (rand() - 0.5) * (1.5 + i * 1.5)
        ys.push(y)
      }
      let d = `M0 ${H} L0 ${ys[0]!.toFixed(1)}`
      ys.forEach((y, j) => {
        d += ` L${j * 8} ${y.toFixed(1)}`
      })
      d += ` L${W} ${H} Z`

      let trees = ''
      if (i >= 3) {
        const n = i === 4 ? 70 : 46
        for (let t = 0; t < n; t++) {
          const x = rand() * W
          const y = ys[Math.min(ys.length - 1, Math.round(x / 8))]! + 4
          const th = (i === 4 ? 26 : 16) + rand() * (i === 4 ? 30 : 16)
          const tw = th * 0.34
          // Three stacked tiers make a spruce; one triangle makes a paper hat.
          for (let tier = 0; tier < 3; tier++) {
            const top = y - th + tier * th * 0.26
            const bottom = y - th * 0.18 + tier * th * 0.12
            const half = tw * (0.55 + tier * 0.28)
            trees += `M${(x - half).toFixed(1)} ${bottom.toFixed(1)} L${x.toFixed(1)} ${top.toFixed(1)} L${(x + half).toFixed(1)} ${bottom.toFixed(1)} Z `
          }
        }
      }
      return { d, trees, color }
    })
  }, [pal.ridges])

  const mist = pal.light ? alpha('#ffffff', 0.45) : alpha(pal.horizon, 0.55)
  return (
    <>
      <div
        className="backdrop__layer"
        style={{
          background: [
            `radial-gradient(70% 34% at 30% 62%, ${alpha(pal.warm, pal.light ? 0.12 : 0.16)}, transparent 70%)`,
            `linear-gradient(180deg, ${pal.skyTop} 0%, ${pal.skyMid} 42%, ${pal.horizon} 64%)`
          ].join(', ')
        }}
      />
      <Stars pal={pal} opts={{ density: pal.light ? 0 : 0.8, sky: 0.62, band: false, seed: 3 }} />
      {pal.light ? null : (
        <div
          className="backdrop__moon"
          style={{
            background: `radial-gradient(circle, ${alpha('#fffaf0', 0.92)} 0 17%, ${alpha('#fff4dc', 0.5)} 19%, ${alpha('#fff4dc', 0.12)} 26%, ${alpha('#fff4dc', 0.04)} 45%, transparent 70%)`
          }}
        />
      )}
      <svg className="backdrop__ridges" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="bd-mist" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={mist} stopOpacity="0" />
            <stop offset="1" stopColor={mist} stopOpacity="1" />
          </linearGradient>
        </defs>
        {layers.map((l, i) => (
          <g key={i}>
            <path d={l.d} fill={l.color} />
            {l.trees ? <path d={l.trees} fill={l.color} /> : null}
            {i < layers.length - 1 ? (
              <rect x="0" y={470 + i * 74 - 20} width={W} height="90" fill="url(#bd-mist)" opacity={0.35 - i * 0.06} />
            ) : null}
          </g>
        ))}
      </svg>
    </>
  )
}

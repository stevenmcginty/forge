import { useEffect, useRef, type ReactNode } from 'react'
import { reducedMotion } from '@/lib/motion'
import type { HubLook } from './hubView'

/**
 * The hub's presence: a calm waveform.
 *
 * Three sine strands under a raised-cosine envelope, so the line always tapers
 * to nothing at both ends and only the middle breathes. The amplitude follows
 * the voice that is live — his mic while it listens, the reply while it speaks —
 * smoothed so it swells rather than jitters. Thinking is a single soft crest
 * travelling across; connecting, a lit segment running along a flat line; muted,
 * offline and error lie flat (the word beside it says which).
 *
 * One small canvas, drawn in a rAF loop only while the state moves, stopped
 * whenever the window is hidden, and never animated under reduced motion —
 * there it draws one still frame of the state and stops.
 */

const MOVING: ReadonlySet<HubLook> = new Set(['listening', 'speaking', 'thinking', 'connecting'])

export function Waveform({
  look,
  read,
  width,
  height,
  strands = 3,
  className
}: {
  look: HubLook
  /** Levels 0–1, read every frame. */
  read: () => { mic: number; out: number }
  /** CSS px; omit to fill the parent's width. */
  width?: number
  height: number
  strands?: number
  className?: string
}): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const readRef = useRef(read)
  readRef.current = read

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let w = width ?? canvas.parentElement?.clientWidth ?? 200
    const h = height
    const size = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    size()

    // Colours come from CSS, so a theme (or a light appearance) repaints it.
    const style = getComputedStyle(canvas)
    const ink = style.color || '#c6ff4a'
    // The faint strands: `--wave-dim`, resolved through border-color (the
    // canvas has no border) so a color-mix() arrives as a plain rgb().
    const dim = style.borderTopColor || 'rgba(255,255,255,0.25)'

    let level = 0
    let raf = 0
    let running = false
    const still = reducedMotion()

    const draw = (t: number): void => {
      ctx.clearRect(0, 0, w, h)
      const mid = h / 2
      const levels = readRef.current()
      const target = look === 'listening' ? levels.mic : look === 'speaking' ? levels.out : 0
      level += ((still ? 0.55 : Math.min(1, target * 1.6)) - level) * 0.18

      if (look === 'listening' || look === 'speaking') {
        const amp = h * 0.44 * (0.08 + level * 0.92)
        for (let s = strands - 1; s >= 0; s--) {
          const freq = 1.6 + s * 0.7
          const speed = (look === 'speaking' ? 3.2 : 2.3) + s * 0.9
          const phase = still ? s : (t / 1000) * speed + s * 1.9
          const k = s === 0 ? 1 : 0.62 - s * 0.14
          ctx.beginPath()
          for (let x = 0; x <= w; x += 1.5) {
            const u = x / w
            const env = Math.sin(Math.PI * u) ** 2
            const y = mid + amp * k * env * Math.sin(Math.PI * 2 * freq * u + phase)
            if (x === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.strokeStyle = s === 0 ? ink : dim
          ctx.globalAlpha = s === 0 ? 1 : 0.8
          ctx.lineWidth = s === 0 ? Math.max(1.4, h / 14) : 1
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        return
      }

      // Flat states: one hairline, and for the moving ones a lit mark on it.
      ctx.beginPath()
      ctx.moveTo(w * 0.04, mid)
      ctx.lineTo(w * 0.96, mid)
      ctx.strokeStyle = dim
      ctx.lineWidth = 1
      if (look === 'muted') ctx.setLineDash([3, 4])
      ctx.stroke()
      ctx.setLineDash([])

      if (look === 'thinking') {
        const cx = still ? w / 2 : w * (0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t / 520)))
        const spread = w * 0.11
        ctx.beginPath()
        for (let x = 0; x <= w; x += 1.5) {
          const g = Math.exp(-(((x - cx) / spread) ** 2))
          const y = mid - h * 0.3 * g * Math.cos(((x - cx) / spread) * 1.4)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = ink
        ctx.lineWidth = Math.max(1.4, h / 14)
        ctx.stroke()
      } else if (look === 'connecting') {
        const u = still ? 0.5 : ((t / 900) % 1.3) - 0.15
        const x0 = w * Math.max(0.04, u)
        const x1 = w * Math.min(0.96, u + 0.22)
        if (x1 > x0) {
          ctx.beginPath()
          ctx.moveTo(x0, mid)
          ctx.lineTo(x1, mid)
          ctx.strokeStyle = ink
          ctx.lineWidth = Math.max(1.4, h / 14)
          ctx.stroke()
        }
      } else if (look === 'error') {
        ctx.beginPath()
        ctx.moveTo(w * 0.3, mid)
        ctx.lineTo(w * 0.7, mid)
        ctx.strokeStyle = ink
        ctx.lineWidth = Math.max(1.4, h / 14)
        ctx.stroke()
      }
    }

    const loop = (t: number): void => {
      draw(t)
      raf = requestAnimationFrame(loop)
    }
    const start = (): void => {
      if (running || still || !MOVING.has(look) || document.hidden) return
      running = true
      raf = requestAnimationFrame(loop)
    }
    const stop = (): void => {
      running = false
      cancelAnimationFrame(raf)
    }
    const onVisibility = (): void => (document.hidden ? stop() : start())

    draw(performance.now())
    start()
    document.addEventListener('visibilitychange', onVisibility)

    let ro: ResizeObserver | null = null
    if (width === undefined && canvas.parentElement) {
      ro = new ResizeObserver(() => {
        const next = canvas.parentElement?.clientWidth ?? w
        if (Math.abs(next - w) < 1) return
        w = next
        size()
        draw(performance.now())
      })
      ro.observe(canvas.parentElement)
    }

    return () => {
      stop()
      ro?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [look, width, height, strands])

  return (
    <canvas
      ref={ref}
      className={className ? `wave ${className}` : 'wave'}
      data-look={look}
      aria-hidden="true"
    />
  )
}

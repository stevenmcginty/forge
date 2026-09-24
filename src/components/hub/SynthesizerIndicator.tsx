import { useEffect, useRef, type ReactNode } from 'react'
import { reducedMotion } from '@/lib/motion'
import type { HubLook } from './hubView'

const MOVING_LOOKS: ReadonlySet<HubLook> = new Set(['listening', 'speaking', 'thinking', 'connecting'])

const BAR_WEIGHTS = [0.65, 1.15, 1.45, 1.1, 0.7]
const BAR_PHASES = [0.0, 1.3, 2.7, 4.1, 5.5]

export function SynthesizerIndicator({
  look,
  readLevels,
  width = 24,
  height = 14,
  className
}: {
  look: HubLook
  readLevels: () => { mic: number; out: number }
  width?: number
  height?: number
  className?: string
}): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const readRef = useRef(readLevels)
  readRef.current = readLevels

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const w = width
    const h = height
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    let levelMic = 0
    let levelOut = 0
    let raf = 0
    let running = false
    const still = reducedMotion()

    const barCount = 5
    const barW = 2.4
    const barGap = 2
    const totalBarsW = barCount * barW + (barCount - 1) * barGap
    const startX = Math.round((w - totalBarsW) / 2)
    const midY = h / 2

    const draw = (t: number): void => {
      ctx.clearRect(0, 0, w, h)

      const style = getComputedStyle(canvas)
      const color = style.color || '#c6ff4a'
      ctx.fillStyle = color

      const levels = readRef.current()
      levelMic += (levels.mic - levelMic) * 0.22
      levelOut += (levels.out - levelOut) * 0.22

      if (still) {
        // Reduced motion: static aesthetic equalizer baseline
        const staticHeights = [4, 8, 12, 7, 4]
        for (let i = 0; i < barCount; i++) {
          const bh = Math.min(h - 2, staticHeights[i])
          const x = startX + i * (barW + barGap)
          drawBar(ctx, x, midY - bh / 2, barW, bh)
        }
        return
      }

      if (look === 'listening') {
        for (let i = 0; i < barCount; i++) {
          const breath = 0.22 + 0.14 * Math.sin(t * 0.005 + BAR_PHASES[i])
          const voice = levelMic * BAR_WEIGHTS[i] * 2.5 * (0.8 + 0.3 * Math.sin(t * 0.015 + BAR_PHASES[i] * 1.7))
          const factor = Math.min(1.0, Math.max(breath, voice))
          const bh = Math.max(3, Math.round(factor * (h - 2)))
          const x = startX + i * (barW + barGap)
          drawBar(ctx, x, midY - bh / 2, barW, bh)
        }
        return
      }

      if (look === 'speaking') {
        for (let i = 0; i < barCount; i++) {
          const pulse = 0.25 + 0.15 * Math.sin(t * 0.008 + BAR_PHASES[i])
          const voice = levelOut * BAR_WEIGHTS[i] * 2.6 * (0.8 + 0.35 * Math.cos(t * 0.018 + BAR_PHASES[i]))
          const factor = Math.min(1.0, Math.max(pulse, voice))
          const bh = Math.max(3, Math.round(factor * (h - 2)))
          const x = startX + i * (barW + barGap)
          drawBar(ctx, x, midY - bh / 2, barW, bh)
        }
        return
      }

      if (look === 'thinking') {
        const sweepPos = ((t / 320) % (barCount + 1)) - 0.5
        for (let i = 0; i < barCount; i++) {
          const dist = Math.abs(i - sweepPos)
          const factor = Math.max(0.2, Math.exp(-(dist * dist) * 1.5))
          const bh = Math.max(2.5, Math.round(factor * (h - 2)))
          const x = startX + i * (barW + barGap)
          drawBar(ctx, x, midY - bh / 2, barW, bh)
        }
        return
      }

      if (look === 'connecting') {
        const bounce = 0.5 + 0.5 * Math.sin(t * 0.006)
        const activeIdx = Math.floor(bounce * (barCount - 0.01))
        for (let i = 0; i < barCount; i++) {
          const bh = i === activeIdx ? Math.round(h * 0.75) : 2.5
          const x = startX + i * (barW + barGap)
          drawBar(ctx, x, midY - bh / 2, barW, bh)
        }
        return
      }

      // Offline / muted / error / idle: subtle minimal dots
      for (let i = 0; i < barCount; i++) {
        const bh = 2.5
        const x = startX + i * (barW + barGap)
        drawBar(ctx, x, midY - bh / 2, barW, bh)
      }
    }

    const loop = (t: number): void => {
      draw(t)
      raf = requestAnimationFrame(loop)
    }

    const start = (): void => {
      if (running || still || !MOVING_LOOKS.has(look) || document.hidden) return
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

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [look, width, height])

  return (
    <canvas
      ref={ref}
      className={className ? `synth-indicator ${className}` : 'synth-indicator'}
      data-look={look}
      aria-hidden="true"
    />
  )
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = w / 2
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.fill()
  }
}

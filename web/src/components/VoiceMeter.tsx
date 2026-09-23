import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The live picture of the microphone while a dictation records: five bars,
 * each one band of the voice, the low band in the middle and the higher ones
 * fanning out either side, so a word moves the whole row and a pause lets it
 * settle. It is what says "I can hear you" — a pulse alone said only "on".
 *
 * Drawn straight onto the bars' transforms from the recording's AnalyserNode,
 * one animation frame at a time, so React never re-renders for sound.
 */

const BARS = 5
/** Where each band is shown: low in the middle, then out to both edges. */
const ORDER = [3, 1, 0, 2, 4]
/** Above this is hiss; speech lives in the bottom few kilohertz. */
const TOP_HZ = 4500

/**
 * `analyser` is the recording's own (lib/voice-level.ts), so the bars, the
 * silence check and the auto-stop all hear the one microphone the same way.
 */
export function VoiceMeter({ analyser }: { analyser: AnalyserNode | null }): ReactNode {
  const bars = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const binHz = analyser.context.sampleRate / analyser.fftSize
    const usable = Math.max(BARS, Math.min(data.length, Math.round(TOP_HZ / binHz)))
    const shown = new Float32Array(BARS)
    let frame = 0
    const draw = (): void => {
      analyser.getByteFrequencyData(data)
      const per = usable / BARS
      for (let band = 0; band < BARS; band++) {
        const from = Math.floor(band * per)
        const to = Math.max(from + 1, Math.floor((band + 1) * per))
        let sum = 0
        for (let i = from; i < to; i++) sum += data[i]
        const level = Math.min(1, (sum / (to - from) / 255) * 1.5)
        // Rise at once, fall gently: a syllable lands, then drains away.
        shown[band] = level > shown[band] ? level : shown[band] * 0.82
        const el = bars.current[ORDER.indexOf(band)]
        if (el) el.style.transform = `scaleY(${(0.16 + shown[band] * 0.84).toFixed(3)})`
      }
      frame = window.requestAnimationFrame(draw)
    }
    frame = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(frame)
  }, [analyser])

  return (
    <span className="voicemeter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className="voicemeter__bar"
          ref={(el) => {
            bars.current[i] = el
          }}
        />
      ))}
    </span>
  )
}

/** One bar of the phone's waveform, and the gap after it, in CSS px. */
const WAVE_BAR = 3
const WAVE_PITCH = 6
/** How often a new bar joins the right-hand end. */
const WAVE_STEP_MS = 70

/**
 * The phone's recording picture: the last few seconds of the voice as a strip
 * of bars that runs the width of the box, newest on the right, sliding left as
 * it listens — the voice-memo picture, so a pause reads as a gap and a word as
 * a ridge. Before the first sound it is a row of dots: the track is there.
 *
 * Canvas, not spans: sixty bars redrawn every frame is one draw call here and
 * sixty style writes the other way. It reads the recording's own AnalyserNode,
 * the one the silence check hears, so the picture and the check agree. The colour
 * is the element's own `color`, so the theme and the cancel state reach it
 * through CSS. The bars keep moving under reduced motion — they are the
 * information, not the dressing — but stop sliding between steps.
 */
export function VoiceWave({ analyser }: { analyser: AnalyserNode | null }): ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const g = el.getContext('2d')
    if (!g) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let ratio = 1
    const size = (): void => {
      ratio = Math.min(3, window.devicePixelRatio || 1)
      width = el.clientWidth
      height = el.clientHeight
      el.width = Math.max(1, Math.round(width * ratio))
      el.height = Math.max(1, Math.round(height * ratio))
    }
    size()
    const resize = new ResizeObserver(size)
    resize.observe(el)

    const data = analyser ? new Uint8Array(analyser.fftSize) : null
    const history: number[] = []
    let loud = 0
    let lastStep = performance.now()
    let frame = 0

    const draw = (now: number): void => {
      if (analyser && data) {
        // Loudness, not pitch: the RMS of the waveform itself, so a voice and
        // a whistle of the same volume draw the same ridge. Square-rooted,
        // because speech sits low on a linear scale; gated, so hiss is a dot.
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        const level = rms < 0.01 ? 0 : Math.min(1, Math.sqrt(rms) * 1.7)
        // Rise at once, fall gently — the same feel as the five-bar meter.
        loud = level > loud ? level : loud * 0.8
      }
      const bars = Math.ceil(width / WAVE_PITCH) + 1
      while (now - lastStep >= WAVE_STEP_MS) {
        lastStep += WAVE_STEP_MS
        history.push(analyser ? loud : 0)
        if (history.length > bars) history.splice(0, history.length - bars)
      }
      const slide = still ? 0 : ((now - lastStep) / WAVE_STEP_MS) * WAVE_PITCH
      const color = getComputedStyle(el).color
      g.setTransform(ratio, 0, 0, ratio, 0, 0)
      g.clearRect(0, 0, width, height)
      g.fillStyle = color
      const mid = height / 2
      for (let i = 0; i < bars; i++) {
        // i = 0 is the newest bar, at the right edge.
        const x = width - WAVE_BAR - i * WAVE_PITCH - slide
        if (x < -WAVE_BAR) break
        const value = history[history.length - 1 - i] ?? 0
        const h = Math.max(WAVE_BAR, Math.round(value * height))
        // Older bars fade toward the left edge, so the strip reads as time.
        g.globalAlpha = Math.max(0.22, Math.min(1, 0.22 + (x / width) * 0.95))
        g.beginPath()
        g.roundRect(x, mid - h / 2, WAVE_BAR, h, WAVE_BAR / 2)
        g.fill()
      }
      g.globalAlpha = 1
      frame = window.requestAnimationFrame(draw)
    }
    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      resize.disconnect()
    }
  }, [analyser])

  return <canvas ref={canvas} className="voicewave" aria-hidden="true" />
}

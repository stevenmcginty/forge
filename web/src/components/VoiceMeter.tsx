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

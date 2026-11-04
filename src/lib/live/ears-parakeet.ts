import { bargeIn } from '@/lib/bargein'
import type { Ears, EarsHandlers } from './ears'

/**
 * Claude Live's fallback ears: the local Parakeet sidecar in conversation
 * mode (`liveEars: 'parakeet'`, or no OpenAI key). The same start VoiceAgent
 * makes — `{ conversation: true, pauseCut }` — so a phrase ends after the
 * Agent silence window.
 *
 * Half duplex, as the sidecar has no echo canceller: it is shut while Forge
 * speaks (an open one would transcribe the reply and answer it) and opened
 * again when Forge falls silent. While it is shut, the echo-cancelled level
 * detector in src/lib/bargein.ts listens instead — duck on a suspicious frame,
 * barge-in on a confirmed voice — so talking over Forge still stops it, and
 * the sidecar reopens at once to take down what he says.
 *
 * The sidecar sends finished phrases only: no partial captions, and the end of
 * speech is when the phrase arrives. A thought said with a breath in it may
 * come as two phrases; the controller joins them (`joinsTurnInFlight`).
 */

/**
 * Live's Parakeet ears are open: the sidecar's phrases are Live's, and
 * dictation (src/hooks/useDictation.ts) must not also type them into the
 * focused pane. Module state, like barMode's agent voice, so the dictation
 * hook needs nothing from the Live controller.
 */
let holding = false

/** True while Live's Parakeet ears hold the sidecar's phrases. */
export function liveEarsHoldPhrases(): boolean {
  return holding
}

/** The Agent silence window, clamped the way VoiceAgent clamps it, in seconds. */
export function parakeetPauseCut(silenceMs: number): number {
  return Math.min(2000, Math.max(500, silenceMs || 800)) / 1000
}

export class ParakeetEars implements Ears {
  readonly kind = 'parakeet' as const
  readonly fullDuplex = false
  private handlers: EarsHandlers | null = null
  private offPhrase: (() => void) | null = null
  private offStatus: (() => void) | null = null
  private running = false
  private speaking = false
  private readonly pauseCut: number

  constructor(silenceMs: number) {
    this.pauseCut = parakeetPauseCut(silenceMs)
  }

  async start(handlers: EarsHandlers): Promise<void> {
    const stt = window.forge?.stt
    if (!stt) throw new Error('This Forge build has no speech engine — restart Forge')
    this.handlers = handlers
    this.running = true
    holding = true
    this.offPhrase = stt.onPhrase(({ text }) => {
      // A phrase the sidecar had already cut can land after stop(): while
      // Forge speaks it is Forge, not him.
      if (!this.running || this.speaking) return
      const said = (text ?? '').trim()
      if (said) this.handlers?.onTurn(said, Date.now())
    })
    this.offStatus = stt.onStatus((s) => {
      if (this.running && s.error?.msg) this.handlers?.onError(s.error.msg)
    })
    const status = await stt.start({ conversation: true, pauseCut: this.pauseCut })
    if (status.error?.msg) {
      this.stop()
      throw new Error(status.error.msg)
    }
  }

  stop(): void {
    if (!this.running && !this.offPhrase) return
    this.running = false
    holding = false
    this.offPhrase?.()
    this.offStatus?.()
    this.offPhrase = null
    this.offStatus = null
    if (bargeIn.running) bargeIn.disarm()
    void window.forge?.stt?.stop()
  }

  setSpeaking(speaking: boolean): void {
    if (!this.running || speaking === this.speaking) return
    this.speaking = speaking
    const stt = window.forge?.stt
    if (speaking) {
      void stt?.stop()
      void bargeIn.arm({
        onDuck: () => this.handlers?.onMaybeSpeech?.(true),
        onRelease: () => this.handlers?.onMaybeSpeech?.(false),
        onInterrupt: () => this.handlers?.onSpeechStart()
      })
      return
    }
    if (bargeIn.running) bargeIn.disarm()
    void stt?.start({ conversation: true, pauseCut: this.pauseCut })
  }
}

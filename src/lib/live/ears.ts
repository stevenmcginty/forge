/**
 * Claude Live's ears: one interface, two engines behind it.
 *
 *   ears-openai.ts    OpenAI realtime transcription over WebRTC, server-side
 *                     semantic VAD, on an always-open echo-cancelled mic. Full
 *                     duplex: he can talk over Forge and be heard.
 *   ears-parakeet.ts  the local Parakeet sidecar in conversation mode. Half
 *                     duplex: the sidecar is shut while Forge speaks, and an
 *                     echo-cancelled level detector (src/lib/bargein.ts)
 *                     stands in for it so talking over Forge still stops it.
 *
 * The controller (src/state/live/LiveController.tsx) never cares which.
 */

export type EarsKind = 'openai' | 'parakeet'

export interface EarsHandlers {
  /** He started talking. With Forge speaking this is barge-in. */
  onSpeechStart(): void
  /** The words of what he is saying now, so far. '' clears the caption. */
  onPartial(text: string): void
  /**
   * A finished turn. `eosAt` is when the ears decided he had stopped
   * (Date.now() ms) — the start of every latency measurement.
   */
  onTurn(text: string, eosAt: number): void
  /** Something worth saying in words; the ears may still be running. */
  onError(message: string): void
  /**
   * Half-duplex ears only: a sound while Forge speaks that may be him.
   * `true` = get quiet, `false` = it was noise, come back up.
   */
  onMaybeSpeech?(ducked: boolean): void
}

export interface Ears {
  readonly kind: EarsKind
  /** True when the mic hears him while Forge speaks. */
  readonly fullDuplex: boolean
  /** Open the mic. Rejects with a sayable message when it cannot. */
  start(handlers: EarsHandlers): Promise<void>
  /** Close the mic. Idempotent. */
  stop(): void
  /** Forge has something to say (true) or has fallen silent (false). */
  setSpeaking(speaking: boolean): void
}

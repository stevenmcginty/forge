import type { ForgeApi } from '@shared/api'
import { OPENAI_ROLLOVER_AT_MS, type RealtimeOpenAIConnectResult } from '@shared/realtime'
import { micError } from '@/lib/realtime/errors'
import type { Ears, EarsHandlers } from './ears'

/**
 * Claude Live's default ears: an OpenAI realtime *transcription* session over
 * WebRTC (electron/realtime/tokens.ts `connectOpenAITranscription` — OpenAI
 * only listens, Claude answers).
 *
 * The mic is getUserMedia with Chromium's echo canceller on, open for the
 * whole session; Forge's own voice plays through the renderer's AudioContext
 * (src/lib/tts.ts), so the canceller has it as the reference and what goes up
 * is Steve, not Forge. Server-side semantic VAD decides when he has finished
 * a thought — `speech_started` is barge-in, `speech_stopped` is the end of
 * speech every latency is measured from, and the `completed` transcript (by
 * item id: they may arrive out of order) is the turn. Deltas are the caption.
 *
 * The handshake goes through main, like GPT Realtime's: page script never
 * holds the key or the client secret. OpenAI closes a session at 60 minutes,
 * so at 55 a fresh call is opened on the same mic and the old one dropped.
 */

/** Where the SDP offer goes. Injected for Forge Web; on the desktop, the preload bridge. */
export type TranscribeConnect = (req: { sdp: string }) => Promise<RealtimeOpenAIConnectResult | undefined>

type TranscribeBridge = Pick<ForgeApi['realtime'], 'openaiTranscribeConnect'>

/**
 * The desktop bridge: `realtime.openaiTranscribeConnect` (shared/api.ts), the
 * preload method that calls `connectOpenAITranscription` in main. Null on a
 * stale preload or off the desktop — the controller then uses Parakeet. Read
 * through ForgeApi's own type rather than `window.forge`, because Forge Web's
 * bundle, which imports this file, declares no `window.forge`.
 */
function desktopConnect(): TranscribeConnect | null {
  const rt = typeof window === 'undefined' ? undefined : (window as unknown as { forge?: { realtime?: TranscribeBridge } }).forge?.realtime
  const fn = rt?.openaiTranscribeConnect
  return typeof fn === 'function' ? (req) => fn.call(rt, req) : null
}

/** Can this build open OpenAI ears at all (key aside)? */
export function openAIEarsAvailable(): boolean {
  return desktopConnect() !== null
}

interface OaiEvent {
  type: string
  item_id?: string
  delta?: string
  transcript?: string
  error?: { message?: string }
}

interface Call {
  pc: RTCPeerConnection
  dc: RTCDataChannel
}

const OPEN_TIMEOUT_MS = 20_000

export class OpenAIEars implements Ears {
  readonly kind = 'openai' as const
  readonly fullDuplex = true
  private readonly connectCall: TranscribeConnect | null
  private handlers: EarsHandlers | null = null
  private stream: MediaStream | null = null
  private call: Call | null = null
  private rollover: number | null = null
  private stopped = false
  private reopened = false
  /** Partial text per item, and when the VAD said each one stopped. */
  private readonly partial = new Map<string, string>()
  private readonly stoppedAt = new Map<string, number>()
  private current: string | null = null

  constructor(connect?: TranscribeConnect) {
    this.connectCall = connect ?? desktopConnect()
  }

  async start(handlers: EarsHandlers): Promise<void> {
    this.handlers = handlers
    this.stopped = false
    if (!this.connectCall) throw new Error('This Forge build cannot open OpenAI ears — restart Forge')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      throw micError(err)
    }
    if (this.stopped) return this.stop()
    try {
      this.call = await this.open()
    } catch (err) {
      this.stop()
      throw err
    }
    this.armRollover()
  }

  stop(): void {
    this.stopped = true
    if (this.rollover !== null) window.clearTimeout(this.rollover)
    this.rollover = null
    this.close(this.call)
    this.call = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.partial.clear()
    this.stoppedAt.clear()
    this.current = null
  }

  /** Full duplex: the mic stays open while Forge speaks. */
  setSpeaking(): void {}

  /** One WebRTC call on the shared mic stream: offer through main, answer back, event channel open. */
  private async open(): Promise<Call> {
    const stream = this.stream
    const connect = this.connectCall
    if (!stream || !connect) throw new Error('OpenAI ears are not running')
    const pc = new RTCPeerConnection()
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)
    const dc = pc.createDataChannel('oai-events')
    const call: Call = { pc, dc }
    dc.onmessage = (e: MessageEvent<string>) => {
      if (this.call !== call) return
      try {
        this.onEvent(JSON.parse(e.data) as OaiEvent)
      } catch {
        /* not JSON — ignore */
      }
    }
    let timer = 0
    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve()
      dc.onclose = () => reject(new Error('OpenAI ears closed their event channel'))
      timer = window.setTimeout(() => reject(new Error('OpenAI ears did not open their event channel')), OPEN_TIMEOUT_MS)
    })
    void opened.catch(() => undefined)
    pc.onconnectionstatechange = () => {
      if (this.stopped || this.call !== call) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void this.reopen('OpenAI ears disconnected')
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const answer = await connect({ sdp: offer.sdp ?? '' })
      if (!answer) throw new Error('This Forge build cannot open OpenAI ears — restart Forge')
      if (!answer.ok) throw new Error(answer.error)
      if (this.stopped) throw new Error('Live stopped while the ears were opening')
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await opened
      return call
    } catch (err) {
      this.close(call)
      throw err
    } finally {
      window.clearTimeout(timer)
    }
  }

  private close(call: Call | null): void {
    if (!call) return
    call.dc.onmessage = null
    call.dc.onclose = null
    call.pc.onconnectionstatechange = null
    try {
      call.dc.close()
    } catch {
      /* already closed */
    }
    try {
      call.pc.close()
    } catch {
      /* already closed */
    }
  }

  private armRollover(): void {
    if (this.rollover !== null) window.clearTimeout(this.rollover)
    this.rollover = window.setTimeout(() => void this.reopen(null), OPENAI_ROLLOVER_AT_MS)
  }

  /**
   * A fresh call on the same mic, then the old one dropped. For the 55-minute
   * rollover (`why` null), and once after a dropped connection; a second drop
   * is reported instead of retried forever.
   */
  private async reopen(why: string | null): Promise<void> {
    if (this.stopped) return
    if (why) {
      if (this.reopened) {
        this.handlers?.onError(`${why} — press Listen to try again`)
        return
      }
      this.reopened = true
    }
    const old = this.call
    try {
      const next = await this.open()
      if (this.stopped) return this.close(next)
      this.call = next
      this.close(old)
      this.armRollover()
    } catch (err) {
      this.handlers?.onError(err instanceof Error ? err.message : String(err))
    }
  }

  private onEvent(ev: OaiEvent): void {
    const h = this.handlers
    if (!h || this.stopped) return
    const id = ev.item_id ?? ''
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.current = id || null
        if (id) this.partial.set(id, '')
        h.onSpeechStart()
        h.onPartial('')
        break
      case 'input_audio_buffer.speech_stopped':
        if (id) this.stoppedAt.set(id, Date.now())
        break
      case 'conversation.item.input_audio_transcription.delta': {
        if (!id || !ev.delta) break
        const text = (this.partial.get(id) ?? '') + ev.delta
        this.partial.set(id, text)
        if (id === this.current) h.onPartial(text.trim())
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const eosAt = this.stoppedAt.get(id) ?? Date.now()
        this.partial.delete(id)
        this.stoppedAt.delete(id)
        if (id === this.current) this.current = null
        const text = (ev.transcript ?? '').trim()
        if (text) h.onTurn(text, eosAt)
        else h.onPartial('')
        break
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.partial.delete(id)
        this.stoppedAt.delete(id)
        if (id === this.current) this.current = null
        h.onPartial('')
        h.onError("I didn't catch that — say it again?")
        break
      case 'error':
        h.onError(ev.error?.message ? `OpenAI ears: ${ev.error.message}` : 'OpenAI ears reported an error')
        break
      default:
        break
    }
  }
}

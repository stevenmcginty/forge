import { OPENAI_ROLLOVER_AT_MS } from '@shared/realtime'
import type {
  RealtimeCaption,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeState,
  RealtimeToolAnswer
} from './session'
import { toOpenAITools } from './tools'
import { micError } from './errors'

/**
 * GPT Realtime (and its mini) over WebRTC.
 *
 * The browser does the hard parts: getUserMedia with echo cancellation, the
 * Opus stream up, the model's voice down into an <audio> element. Only the
 * handshake leaves the renderer — the SDP offer goes to main, which mints a
 * client secret with the stored key and posts the offer to /v1/realtime/calls
 * itself (electron/realtime/tokens.ts). Session config (voice, instructions,
 * tools, semantic VAD, truncation) rides on that client secret, so nothing
 * needs a session.update here.
 *
 * Events arrive on the `oai-events` data channel. Function calls come in
 * `response.done` as `function_call` items; each is answered with a
 * `function_call_output` item and one `response.create` once all are in.
 * Semantic VAD with interrupt_response is on for the whole session: talking
 * over it stops it, no push-to-talk (hands-free).
 *
 * OpenAI closes a session at 60 minutes; at 55 this tells the controller,
 * which rolls over to a fresh session seeded with a summary.
 */

interface OaiEvent {
  type: string
  item_id?: string
  delta?: string
  transcript?: string
  response?: { output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> }
  error?: { message?: string }
}

function analyserLevel(an: AnalyserNode | null, buf: Float32Array<ArrayBuffer> | null): number {
  if (!an || !buf) return 0
  an.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
  return Math.min(1, Math.sqrt(sum / buf.length) * 4)
}

export class OpenAIRealtimeSession implements RealtimeSession {
  readonly provider: 'gpt-realtime' | 'gpt-realtime-mini'
  private readonly opts: RealtimeSessionOptions
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private micAn: AnalyserNode | null = null
  private outAn: AnalyserNode | null = null
  private micBuf: Float32Array<ArrayBuffer> | null = null
  private outBuf: Float32Array<ArrayBuffer> | null = null
  private rolloverTimer: number | null = null
  private stopped = false
  private muted = false
  private userCaptions = new Map<string, RealtimeCaption>()
  private botCaptions = new Map<string, RealtimeCaption>()

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts
    this.provider = opts.provider === 'gpt-realtime-mini' ? 'gpt-realtime-mini' : 'gpt-realtime'
  }

  private current: RealtimeState = 'connecting'

  private state(s: RealtimeState, detail?: string): void {
    this.current = s
    if (!this.stopped || s === 'closed') this.opts.events.onState(s, detail)
  }

  /**
   * stop() ran while start() was waiting (Listen pressed off during
   * "Starting…"): release whatever start() made since, and go no further — a
   * start that carried on would be a hidden session behind an Off switch (V1).
   */
  private bailIfStopped(): void {
    if (!this.stopped) return
    this.release()
    throw new Error('Voice session stopped while starting')
  }

  async start(): Promise<void> {
    this.state('connecting')
    const bridge = window.forge.realtime
    if (!bridge) throw new Error('This Forge build has no realtime bridge — restart Forge')

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch (err) {
      throw micError(err)
    }
    this.bailIfStopped()
    const pc = new RTCPeerConnection()
    this.pc = pc
    this.ctx = new AudioContext()
    this.micAn = this.ctx.createAnalyser()
    this.micAn.fftSize = 512
    this.micBuf = new Float32Array(this.micAn.fftSize)
    this.ctx.createMediaStreamSource(this.stream).connect(this.micAn)

    this.audio = document.createElement('audio')
    this.audio.autoplay = true
    pc.ontrack = (e) => {
      const remote = e.streams[0]
      if (!remote || !this.audio || !this.ctx) return
      this.audio.srcObject = remote
      this.outAn = this.ctx.createAnalyser()
      this.outAn.fftSize = 512
      this.outBuf = new Float32Array(this.outAn.fftSize)
      this.ctx.createMediaStreamSource(remote).connect(this.outAn)
    }
    for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (e: MessageEvent<string>) => {
      try {
        this.onEvent(JSON.parse(e.data) as OaiEvent)
      } catch {
        /* not JSON — ignore */
      }
    }
    let openTimer = 0
    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve()
      // Closed before it opened (stop() while starting): do not wait out the timer.
      dc.onclose = () => reject(new Error('GPT Realtime closed its event channel'))
      openTimer = window.setTimeout(() => reject(new Error('GPT Realtime did not open its event channel')), 20_000)
    })
    // Awaited below; this only stops an early failure elsewhere in start()
    // leaving the timeout as an unhandled rejection.
    void opened.catch(() => undefined)
    pc.onconnectionstatechange = () => {
      if (this.stopped) return
      // 'disconnected' is often a blip ICE recovers from by itself; only a
      // connection that is really gone is worth a new session.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.opts.events.onExpiring('GPT Realtime disconnected')
      }
    }

    try {
      await this.connect(bridge, pc, opened)
    } finally {
      window.clearTimeout(openTimer)
    }
    this.state('listening')
    this.rolloverTimer = window.setTimeout(
      () => this.opts.events.onExpiring('GPT Realtime sessions end at 60 minutes'),
      OPENAI_ROLLOVER_AT_MS
    )
  }

  /** The SDP handshake through main, then the event channel opening. */
  private async connect(
    bridge: NonNullable<typeof window.forge.realtime>,
    pc: RTCPeerConnection,
    opened: Promise<void>
  ): Promise<void> {
    const offer = await pc.createOffer()
    this.bailIfStopped()
    await pc.setLocalDescription(offer)
    this.bailIfStopped()
    const answer = await bridge.openaiConnect({
      model: this.opts.model,
      voice: this.opts.voice,
      instructions: this.opts.instructions,
      tools: toOpenAITools(this.opts.tools),
      sdp: offer.sdp ?? ''
    })
    this.bailIfStopped()
    if (!answer.ok) throw new Error(answer.error)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    this.bailIfStopped()
    await opened
    this.bailIfStopped()
  }

  private send(event: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event))
  }

  private caption(map: Map<string, RealtimeCaption>, role: 'user' | 'assistant', id: string, text: string, final: boolean): void {
    const prev = map.get(id)
    const next: RealtimeCaption = { id: `o-${id}`, role, text: final ? text : (prev?.text ?? '') + text, final }
    if (final) map.delete(id)
    else map.set(id, next)
    this.opts.events.onCaption(next)
  }

  private onEvent(ev: OaiEvent): void {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.state('listening')
        break
      case 'input_audio_buffer.speech_stopped':
      case 'response.created':
        this.state('thinking')
        break
      case 'output_audio_buffer.started':
        this.state('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.state('listening')
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.item_id && ev.delta) this.caption(this.userCaptions, 'user', ev.item_id, ev.delta, false)
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.item_id) this.caption(this.userCaptions, 'user', ev.item_id, ev.transcript ?? '', true)
        break
      case 'response.output_audio_transcript.delta':
        if (ev.item_id && ev.delta) this.caption(this.botCaptions, 'assistant', ev.item_id, ev.delta, false)
        break
      case 'response.output_audio_transcript.done':
        if (ev.item_id) this.caption(this.botCaptions, 'assistant', ev.item_id, ev.transcript ?? '', true)
        break
      case 'response.done': {
        const calls = (ev.response?.output ?? []).filter((o) => o.type === 'function_call' && o.call_id)
        if (calls.length) void this.answerCalls(calls)
        // A reply with no audio (or none left to play) is back to listening.
        else if (this.current === 'thinking') this.state('listening')
        break
      }
      case 'error':
        // Most are recoverable (a cancel with nothing to cancel); say it, do not die.
        console.warn('[realtime] OpenAI error:', ev.error?.message)
        break
    }
  }

  private async answerCalls(calls: Array<{ call_id?: string; name?: string; arguments?: string }>): Promise<void> {
    this.state('thinking')
    const images: Array<NonNullable<RealtimeToolAnswer['image']>> = []
    for (const call of calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      } catch {
        /* a malformed call is answered as a failure below by the handler */
      }
      const answer = await this.opts.events.onToolCall({ id: call.call_id!, name: call.name ?? '', args })
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.call_id, output: answer.text }
      })
      if (answer.image) images.push(answer.image)
    }
    for (const image of images) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: `data:${image.mime};base64,${image.base64}` }]
        }
      })
    }
    this.send({ type: 'response.create' })
  }

  sendText(text: string): void {
    const body = text.trim()
    if (!body) return
    this.opts.events.onCaption({ id: `o-typed-${Date.now().toString(36)}`, role: 'user', text: body, final: true })
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] }
    })
    this.send({ type: 'response.create' })
  }

  sendContext(text: string, respond = false): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] }
    })
    if (respond) this.send({ type: 'response.create' })
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' })
    this.send({ type: 'output_audio_buffer.clear' })
    this.state('listening')
  }

  levels(): { mic: number; out: number } {
    return { mic: this.muted ? 0 : analyserLevel(this.micAn, this.micBuf), out: analyserLevel(this.outAn, this.outBuf) }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.release()
    this.opts.events.onState('closed')
  }

  /** Close the connection, the mic and the meters — whatever exists yet. */
  private release(): void {
    if (this.rolloverTimer !== null) window.clearTimeout(this.rolloverTimer)
    this.rolloverTimer = null
    try {
      this.dc?.close()
      this.pc?.close()
    } catch {
      /* already closed */
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    if (this.audio) this.audio.srcObject = null
    void this.ctx?.close().catch(() => undefined)
    this.pc = null
    this.dc = null
    this.stream = null
    this.ctx = null
  }
}

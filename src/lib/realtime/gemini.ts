import { GEMINI_LIVE_WS_URL } from '@shared/realtime'
import workletUrl from './pcm-worklet.js?url&no-inline'
import type {
  RealtimeCaption,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeState,
  RealtimeToolAnswer,
  RealtimeToolCall
} from './session'
import { toGeminiTools } from './tools'
import { micError } from './errors'
import { LiveTraceCounters, liveTrace, serverMessageTypes } from './live-trace'

/**
 * Gemini Live over its WebSocket, straight from the renderer.
 *
 * Main mints a single-use ephemeral token (electron/realtime/tokens.ts); the
 * renderer opens the socket with it — the CSP allows `wss:` — and streams the
 * microphone as 16 kHz PCM through an AudioWorklet, playing the 24 kHz PCM
 * that comes back through another. Gemini does its own voice activity
 * detection, so talking over it is barge-in with no button (hands-free).
 *
 * A day-long session is two settings and one habit:
 *  - `contextWindowCompression` (sliding window), without which an audio
 *    session ends at 15 minutes;
 *  - `sessionResumption`, whose handle lets a new socket pick the same
 *    conversation back up — which is needed about every ten minutes, when the
 *    server sends `goAway` before recycling the connection.
 * Each reconnect mints a fresh token, so an expired thirty-minute token never
 * strands a long session. Only when a resume fails does the controller get
 * `onExpiring` and roll over with a text summary.
 *
 * Wire shapes are from https://ai.google.dev/api/live (checked 2026-09-23).
 */

const MAX_RECONNECTS = 3

function b64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function bufferFromB64(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** The setup message. Exported for scripts/realtime-check.mjs. */
export function buildGeminiSetup(
  opts: Pick<RealtimeSessionOptions, 'model' | 'voice' | 'instructions' | 'tools'>,
  resumeHandle: string | null
): Record<string, unknown> {
  return {
    setup: {
      model: `models/${opts.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } }
      },
      systemInstruction: { parts: [{ text: opts.instructions }] },
      tools: toGeminiTools(opts.tools),
      // Server-side VAD stays on (the default): hands-free, no push-to-talk.
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  }
}

interface GeminiServerMessage {
  setupComplete?: unknown
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> }
    turnComplete?: boolean
    interrupted?: boolean
    generationComplete?: boolean
    inputTranscription?: { text?: string }
    outputTranscription?: { text?: string }
  }
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
}

export class GeminiLiveSession implements RealtimeSession {
  readonly provider = 'gemini-live' as const
  private readonly opts: RealtimeSessionOptions
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private capture: AudioWorkletNode | null = null
  private player: AudioWorkletNode | null = null
  private handle: string | null = null
  private ready = false
  private stopped = false
  private muted = false
  private reconnects = 0
  private micLevel = 0
  private outLevel = 0
  /** Set by a manual interrupt: drop the rest of this turn's audio. */
  private dropping = false
  /**
   * The model is still sending this turn's audio: from its first modelTurn to
   * generationComplete / turnComplete. Gemini generates faster than real time,
   * so a reply is usually done generating while it is still playing — and an
   * interrupt then must not drop the NEXT reply's audio (V2).
   */
  private generating = false
  /** Audio handed to the player that it has not yet reported drained. */
  private queued = false
  /** Tool calls asked for and not yet answered. */
  private toolsPending = 0
  private current: RealtimeState = 'connecting'
  private userCaption: RealtimeCaption | null = null
  private botCaption: RealtimeCaption | null = null
  private seq = 0
  /** Dev-only [realtime] evidence in dev.log (./live-trace.ts). */
  private readonly trace = new LiveTraceCounters(() => this.traceState())
  private openedAt = 0

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts
  }

  private traceState(): string {
    const track = this.stream?.getAudioTracks()[0]
    const t = track ? `track enabled=${track.enabled} muted=${track.muted} ${track.readyState}` : 'no track'
    return `ctx=${this.ctx?.state ?? 'none'}@${this.ctx?.sampleRate ?? 0}Hz ${t} ws=${this.ws?.readyState ?? 'none'} ready=${this.ready} muted=${this.muted}`
  }

  private state(s: RealtimeState, detail?: string): void {
    this.current = s
    if (!this.stopped || s === 'closed') this.opts.events.onState(s, detail)
  }

  /**
   * stop() ran while start() was waiting (Listen pressed off during
   * "Starting…"): release whatever start() made since, and go no further. A
   * start that carried on would be a hidden session — live mic, spoken
   * replies, tools still firing — behind a switch that says Off (V1).
   */
  private bailIfStopped(): void {
    if (!this.stopped) return
    this.release()
    throw new Error('Voice session stopped while starting')
  }

  async start(): Promise<void> {
    this.state('connecting')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      throw micError(err)
    }
    this.bailIfStopped()
    this.ctx = new AudioContext()
    const ctx = this.ctx
    ctx.onstatechange = () => liveTrace(`audio context ${ctx.state}`)
    liveTrace(`audio context created state=${ctx.state} rate=${ctx.sampleRate}Hz; mic sent as 16000Hz audio/pcm`)
    await this.ctx.audioWorklet.addModule(workletUrl)
    this.bailIfStopped()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(this.ctx, 'forge-pcm-capture', { processorOptions: { targetRate: 16000 } })
    this.capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => this.onMicChunk(e.data)
    source.connect(this.capture)
    this.player = new AudioWorkletNode(this.ctx, 'forge-pcm-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { sourceRate: 24000 }
    })
    this.player.port.onmessage = (e: MessageEvent<{ level?: number; drained?: boolean; started?: boolean }>) => {
      if (typeof e.data.level === 'number') this.outLevel = Math.min(1, e.data.level * 3)
      if (e.data.started) {
        liveTrace(`playback started; audio context ${this.ctx?.state ?? 'none'}`)
        this.state('speaking')
      }
      if (e.data.drained) {
        this.outLevel = 0
        this.queued = false
        this.state('listening')
      }
    }
    this.player.connect(this.ctx.destination)
    liveTrace(`worklets connected; ${this.traceState()}`)
    this.trace.start()
    await this.connect()
  }

  /** Open (or re-open) the socket and wait for setupComplete. */
  private async connect(): Promise<void> {
    const res = await window.forge.realtime?.geminiToken()
    this.bailIfStopped()
    if (!res) throw new Error('This Forge build has no realtime bridge — restart Forge')
    if (!res.ok) throw new Error(res.error)
    const ws = new WebSocket(`${GEMINI_LIVE_WS_URL}?access_token=${encodeURIComponent(res.token)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.ready = false
    await new Promise<void>((resolve, reject) => {
      let settled = false
      ws.onopen = () => {
        this.openedAt = Date.now()
        const setup = buildGeminiSetup(this.opts, this.handle)
        const body = setup.setup as { tools?: Array<{ functionDeclarations?: unknown[] }> }
        const nTools = (body.tools ?? []).reduce((n, t) => n + (t.functionDeclarations?.length ?? 0), 0)
        liveTrace(
          `ws open; setup sent model=${this.opts.model} voice=${this.opts.voice} tools=${nTools} resume=${this.handle ? 'yes' : 'no'}`
        )
        ws.send(JSON.stringify(setup))
      }
      ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
        const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
        let msg: GeminiServerMessage
        try {
          msg = JSON.parse(text) as GeminiServerMessage
        } catch {
          liveTrace(`server frame not JSON (${typeof e.data === 'string' ? 'text' : 'binary'}, ${text.length} chars)`)
          return
        }
        this.trace.server(serverMessageTypes(msg as Record<string, unknown>))
        if (msg.setupComplete !== undefined && !settled) {
          liveTrace(`setupComplete after ${Date.now() - this.openedAt} ms`)
          settled = true
          this.ready = true
          this.reconnects = 0
          this.state('listening')
          resolve()
        }
        this.onMessage(msg)
      }
      ws.onerror = () => {
        liveTrace('ws error')
        if (!settled) {
          settled = true
          reject(new Error('Could not open the Gemini Live connection'))
        }
      }
      ws.onclose = (e) => {
        liveTrace(`ws close code=${e.code} reason=${e.reason ? e.reason.slice(0, 160) : '-'} clean=${e.wasClean} settled=${settled}`)
        if (!settled) {
          settled = true
          reject(new Error(`Gemini Live closed the connection${e.reason ? ` — ${e.reason}` : ` (${e.code})`}`))
          return
        }
        if (this.ws === ws) void this.onDropped(e.reason || `code ${e.code}`)
      }
    })
  }

  /** The socket went away mid-session: resume on a new one if we can. */
  private async onDropped(reason: string): Promise<void> {
    this.ready = false
    if (this.stopped) return
    if (!this.handle || this.reconnects >= MAX_RECONNECTS) {
      this.opts.events.onExpiring(`Gemini Live disconnected (${reason})`)
      return
    }
    this.reconnects++
    this.state('connecting', 'Reconnecting…')
    try {
      await this.connect()
    } catch (err) {
      if (this.stopped) return
      this.opts.events.onExpiring(err instanceof Error ? err.message : String(err))
    }
  }

  private onMicChunk(data: { pcm: ArrayBuffer; level: number }): void {
    this.micLevel = this.muted ? 0 : Math.min(1, data.level * 4)
    const ws = this.ws
    const why = !this.ready ? 'not-ready' : this.muted ? 'muted' : !ws || ws.readyState !== WebSocket.OPEN ? 'ws-closed' : null
    this.trace.mic(data.level, data.pcm.byteLength, why === null, why ?? undefined)
    if (why || !ws) return
    ws.send(
      JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64FromBuffer(data.pcm) } } })
    )
  }

  private caption(role: 'user' | 'assistant', chunk: string, final: boolean): void {
    const slot = role === 'user' ? 'userCaption' : 'botCaption'
    let c = this[slot]
    if (!c && !chunk) return
    if (!c) c = { id: `g${Date.now().toString(36)}-${++this.seq}`, role, text: '', final: false }
    c = { ...c, text: c.text + chunk, final }
    this.opts.events.onCaption(c)
    this[slot] = final ? null : c
  }

  private onMessage(msg: GeminiServerMessage): void {
    const sc = msg.serverContent
    if (sc) {
      if (sc.inputTranscription?.text) this.caption('user', sc.inputTranscription.text, false)
      if (sc.modelTurn || sc.outputTranscription?.text) {
        // The model has started answering, so his turn is over.
        if (this.userCaption) this.caption('user', '', true)
      }
      if (sc.outputTranscription?.text) this.caption('assistant', sc.outputTranscription.text, false)
      if (sc.modelTurn) this.generating = true
      for (const part of sc.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data
        if (data && !this.dropping && (part.inlineData?.mimeType ?? '').startsWith('audio/pcm')) {
          const pcm = bufferFromB64(data)
          this.trace.audioChunk(pcm.byteLength)
          this.queued = true
          this.player?.port.postMessage({ pcm }, [pcm])
        }
      }
      if (sc.generationComplete) this.generating = false
      if (sc.interrupted) {
        this.player?.port.postMessage({ flush: true })
        this.dropping = false
        this.generating = false
        this.queued = false
        if (this.botCaption) this.caption('assistant', '', true)
        this.state('listening')
      }
      if (sc.turnComplete) {
        this.dropping = false
        this.generating = false
        if (this.userCaption) this.caption('user', '', true)
        if (this.botCaption) this.caption('assistant', '', true)
        // A turn with nothing to say (an action done, and the persona's "say
        // nothing") has no playback to end Thinking… — so the turn's end does (V3).
        if (!this.queued && this.toolsPending === 0 && this.current === 'thinking') this.state('listening')
      }
    }
    if (msg.toolCall?.functionCalls?.length) {
      this.state('thinking')
      for (const fc of msg.toolCall.functionCalls) {
        void this.answerTool({ id: String(fc.id ?? ''), name: String(fc.name ?? ''), args: fc.args ?? {} })
      }
    }
    for (const id of msg.toolCallCancellation?.ids ?? []) this.opts.events.onToolCancelled?.(id)
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.handle = msg.sessionResumptionUpdate.newHandle
    }
    if (msg.goAway) {
      // The server is about to recycle this connection. Move to a new one now,
      // on the latest resume handle, rather than waiting to be cut off.
      const old = this.ws
      this.ws = null
      old?.close()
      void this.onDropped('connection recycled')
    }
  }

  private async answerTool(call: RealtimeToolCall): Promise<void> {
    this.toolsPending++
    let answer: RealtimeToolAnswer
    try {
      answer = await this.opts.events.onToolCall(call)
    } finally {
      this.toolsPending--
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: call.id, name: call.name, response: { result: answer.text, ok: answer.ok } }]
        }
      })
    )
    if (answer.image) {
      ws.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  { text: 'The screenshot you asked for:' },
                  { inlineData: { mimeType: answer.image.mime, data: answer.image.base64 } }
                ]
              }
            ],
            turnComplete: true
          }
        })
      )
    }
  }

  sendText(text: string): void {
    const body = text.trim()
    if (!body || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.opts.events.onCaption({ id: `g${Date.now().toString(36)}-${++this.seq}`, role: 'user', text: body, final: true })
    liveTrace(`sent realtimeInput.text (${body.length} chars)`)
    this.ws.send(JSON.stringify({ realtimeInput: { text: body } }))
  }

  sendContext(text: string, respond = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    liveTrace(`sent clientContent note (${text.length} chars) turnComplete=${respond}`)
    this.ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text: `[Forge note] ${text}` }] }], turnComplete: respond }
      })
    )
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted
    if (muted && this.ws?.readyState === WebSocket.OPEN) {
      // Tells the server's VAD the stream paused, so it does not wait on silence.
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    }
  }

  interrupt(): void {
    // The Live API has no client-side cancel: barge-in is speech. A button
    // press flushes what is queued and, while the model is still generating,
    // drops the rest of this turn's audio. Once it has finished generating
    // there is no rest to drop, and a `dropping` left set would silence the
    // next reply: only turnComplete / interrupted clear it (V2).
    this.dropping = this.generating
    this.queued = false
    this.player?.port.postMessage({ flush: true })
    this.outLevel = 0
    if (this.botCaption) this.caption('assistant', '', true)
    this.state('listening')
  }

  levels(): { mic: number; out: number } {
    return { mic: this.micLevel, out: this.outLevel }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.trace.stop()
    liveTrace('session stopped')
    this.release()
    this.opts.events.onState('closed')
  }

  /** Close the socket, the mic and the audio graph — whatever exists yet. */
  private release(): void {
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      /* already gone */
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.capture?.disconnect()
    this.player?.disconnect()
    void this.ctx?.close().catch(() => undefined)
    this.stream = null
    this.ctx = null
    this.capture = null
    this.player = null
    this.micLevel = 0
    this.outLevel = 0
  }
}

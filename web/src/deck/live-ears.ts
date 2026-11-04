import workletUrl from '@/lib/realtime/pcm-worklet.js?url&no-inline'
import { OPENAI_ROLLOVER_AT_MS } from '@shared/realtime'
import { MAX_FILE_CHUNK_BYTES, type WebRequest, type WebResult } from '@shared/web'
import { micError } from '@/lib/realtime/errors'
import { b64FromBytes, joinFrames } from './claudeVoice'
import { voiceFailureWords } from './voice-words'

/**
 * Claude Live's ears in Forge Web (./liveVoice.ts), two of them behind one
 * shape:
 *
 *   OpenAIPhoneEars  an OpenAI realtime transcription session over WebRTC
 *                    from this browser: server-side semantic VAD on an
 *                    always-open, echo-cancelled mic, deltas as the caption.
 *                    src/lib/live/ears-openai.ts (the desk's) restated for
 *                    this page — that one reaches for the desktop's preload.
 *                    The SDP offer goes to the desktop (`voice-claude`
 *                    `ears`), which mints the secret with its own key.
 *   PcmEars          Claude's level VAD (./claudeVoice.ts's numbers) and the
 *                    desktop's transcription: for a desktop with no OpenAI key.
 */

export interface EarsHandlers {
  /** He started talking. With Forge speaking this is barge-in. */
  onSpeechStart(): void
  /** The words so far of what he is saying now. '' clears the caption. */
  onPartial(text: string): void
  /** A finished turn; `eosAt` is when the ears decided he had stopped (Date.now() ms). */
  onTurn(text: string, eosAt: number): void
  /** Something to say in words. One that says "press Listen" means the ears are gone. */
  onError(message: string): void
}

export interface PhoneEars {
  start(handlers: EarsHandlers): Promise<void>
  stop(): void
  /** Forge has something to say (true) or has fallen silent (false). */
  setSpeaking(speaking: boolean): void
  /** The mic level, 0–1. */
  level(): number
}

type Ask = (body: WebRequest) => Promise<WebResult>

/** The SDP offer to the desktop, OpenAI's answer back. */
export type EarsConnect = (sdp: string) => Promise<{ ok: true; sdp: string } | { ok: false; error: string }>

export const NOT_HEARD_WORDS = "I didn't catch that — say it again?"

/* --------------------------------------------------------------- OpenAI */

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

/**
 * The phone's OpenAI ears. OpenAI closes a session at 60 minutes, so at 55 a
 * fresh call opens on the same mic and the old one is dropped; a dropped
 * connection is retried once, then reported.
 */
export class OpenAIPhoneEars implements PhoneEars {
  private readonly connect: EarsConnect
  private readonly ctx: AudioContext
  private handlers: EarsHandlers | null = null
  private stream: MediaStream | null = null
  private meter: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private call: Call | null = null
  private rollover: number | null = null
  private stopped = false
  private reopened = false
  private readonly partial = new Map<string, string>()
  private readonly stoppedAt = new Map<string, number>()
  private current: string | null = null
  /** The offer went to the desktop: a failure from here is the ears', not the mic's. */
  offered = false

  constructor(connect: EarsConnect, ctx: AudioContext) {
    this.connect = connect
    this.ctx = ctx
  }

  async start(handlers: EarsHandlers): Promise<void> {
    this.handlers = handlers
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      throw micError(err)
    }
    if (this.stopped) return this.stop()
    // A level for the bar's synth; nothing is played from it.
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.meter = this.ctx.createAnalyser()
    this.meter.fftSize = 512
    this.source.connect(this.meter)
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
    this.source?.disconnect()
    this.meter?.disconnect()
    this.source = null
    this.meter = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.partial.clear()
    this.stoppedAt.clear()
    this.current = null
  }

  /** Full duplex: the mic stays open while Forge speaks; the browser's echo canceller has it. */
  setSpeaking(): void {}

  level(): number {
    const a = this.meter
    if (!a) return 0
    const data = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += v * v
    return Math.min(1, Math.sqrt(sum / data.length) * 4)
  }

  private async open(): Promise<Call> {
    const stream = this.stream
    if (!stream) throw new Error('The ears are not running')
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
      this.offered = true
      const answer = await this.connect(offer.sdp ?? '')
      if (!answer.ok) throw new Error(answer.error)
      if (this.stopped) throw new Error('Listen stopped while the ears were opening')
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
      this.handlers?.onError(`${err instanceof Error ? err.message : String(err)} — press Listen to try again`)
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
        h.onError(NOT_HEARD_WORDS)
        break
      case 'error':
        h.onError(ev.error?.message ? `OpenAI ears: ${ev.error.message}` : 'OpenAI ears reported an error')
        break
      default:
        break
    }
  }
}

/* ------------------------------------------------------------------ PCM */

/* Claude's hearing numbers (./claudeVoice.ts). */
const FRAME_MS = 100
const START_FRAMES = 2
const BARGE_FRAMES = 3
const END_SILENCE_MS = 800
const MIN_VOICED_FRAMES = 3
const PRE_ROLL_FRAMES = 3
const MAX_TURN_FRAMES = 600
const SLICE_FRAMES = Math.min(10, Math.floor(MAX_FILE_CHUNK_BYTES / 3200))
const START_RATIO = 3
const START_MIN = 0.02
const HOLD_RATIO = 0.6
const BARGE_RATIO = 2.5
const FLOOR_MAX = 0.03

interface PcmTurn {
  id: string
  frames: number
  pending: Int16Array[]
  seq: number
  voiced: number
  quietMs: number
  sends: Array<Promise<WebResult>>
}

/**
 * The fallback ears: Claude's level VAD on this page's mic (16 kHz frames
 * from the voice hub's worklet), the turn uploaded while he talks (`append`)
 * and transcribed on the desktop at the pause (`done` → `voice-heard`). No
 * partial captions: the words come at the end.
 */
export class PcmEars implements PhoneEars {
  private readonly ask: Ask
  private readonly ctx: AudioContext
  private handlers: EarsHandlers | null = null
  private stream: MediaStream | null = null
  private capture: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stopped = false
  private speaking = false
  private micLevel = 0
  private floor = 0.005
  private over = 0
  private preRoll: Int16Array[] = []
  private turn: PcmTurn | null = null
  private seq = 0

  constructor(ask: Ask, ctx: AudioContext) {
    this.ask = ask
    this.ctx = ctx
  }

  async start(handlers: EarsHandlers): Promise<void> {
    this.handlers = handlers
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      throw micError(err)
    }
    if (this.stopped) return this.stop()
    await this.ctx.audioWorklet.addModule(workletUrl)
    if (this.stopped) return this.stop()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(this.ctx, 'forge-pcm-capture', { processorOptions: { targetRate: 16000 } })
    this.capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => this.onFrame(e.data)
    this.source.connect(this.capture)
  }

  stop(): void {
    this.stopped = true
    this.dropTurn()
    this.source?.disconnect()
    this.capture?.disconnect()
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.source = null
    this.capture = null
    this.stream = null
    this.micLevel = 0
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking
  }

  level(): number {
    return this.micLevel
  }

  private onFrame(data: { pcm: ArrayBuffer; level: number }): void {
    if (this.stopped) return
    const frame = new Int16Array(data.pcm)
    const level = data.level
    this.micLevel = Math.min(1, level * 4)
    const start = Math.max(START_MIN, this.floor * START_RATIO)
    const turn = this.turn
    if (turn) {
      turn.frames++
      turn.pending.push(frame)
      if (level >= start * HOLD_RATIO) {
        turn.voiced++
        turn.quietMs = 0
        if (turn.voiced === MIN_VOICED_FRAMES) this.handlers?.onSpeechStart()
      } else {
        turn.quietMs += FRAME_MS
      }
      if (turn.pending.length >= SLICE_FRAMES) this.sendSlice(turn)
      if (turn.quietMs >= END_SILENCE_MS || turn.frames >= MAX_TURN_FRAMES) this.endTurn(turn)
      return
    }
    // Its own voice is in the mic while it talks: only louder, longer speech is him.
    const needed = this.speaking ? start * BARGE_RATIO : start
    if (level >= needed) this.over++
    else {
      this.over = 0
      if (!this.speaking) this.floor = Math.min(FLOOR_MAX, this.floor * 0.95 + level * 0.05)
    }
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
    if (this.over >= (this.speaking ? BARGE_FRAMES : START_FRAMES)) {
      const frames = this.preRoll
      const voiced = this.over
      this.preRoll = []
      this.over = 0
      this.turn = { id: `lt${Date.now().toString(36)}-${++this.seq}`, frames: frames.length, pending: [...frames], seq: 0, voiced, quietMs: 0, sends: [] }
      if (voiced >= MIN_VOICED_FRAMES) this.handlers?.onSpeechStart()
    }
  }

  private sendSlice(turn: PcmTurn): void {
    if (!turn.pending.length) return
    const data = b64FromBytes(joinFrames(turn.pending))
    turn.pending = []
    turn.sends.push(this.ask({ kind: 'voice-claude', op: 'append', turnId: turn.id, seq: turn.seq++, data }))
  }

  private dropTurn(): void {
    const turn = this.turn
    this.turn = null
    if (turn && turn.seq > 0) void this.ask({ kind: 'voice-claude', op: 'cancel', turnId: turn.id })
  }

  private endTurn(turn: PcmTurn): void {
    this.turn = null
    if (turn.voiced < MIN_VOICED_FRAMES) {
      if (turn.seq > 0) void this.ask({ kind: 'voice-claude', op: 'cancel', turnId: turn.id })
      return
    }
    const eosAt = Date.now()
    this.sendSlice(turn)
    void this.hear(turn, eosAt)
  }

  private async hear(turn: PcmTurn, eosAt: number): Promise<void> {
    const sent = await Promise.all(turn.sends)
    if (this.stopped) return
    const refused = sent.find((r) => r.kind === 'failed')
    if (refused) {
      this.handlers?.onError(`${voiceFailureWords(refused, 'claude-live')} — press Listen to try again`)
      return
    }
    const res = await this.ask({ kind: 'voice-claude', op: 'done', turnId: turn.id, chunks: turn.seq })
    if (this.stopped) return
    if (res.kind !== 'voice-heard') {
      this.handlers?.onError(NOT_HEARD_WORDS)
      return
    }
    const text = res.text.trim()
    if (text) this.handlers?.onTurn(text, eosAt)
    else this.handlers?.onPartial('')
  }
}

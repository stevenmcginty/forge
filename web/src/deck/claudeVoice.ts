import workletUrl from '@/lib/realtime/pcm-worklet.js?url&no-inline'
import { MAX_FILE_CHUNK_BYTES, type WebRequest, type WebResult, type WebVoiceClaudeEvent } from '@shared/web'
import { micError } from '@/lib/realtime/errors'
import type { RealtimeSessionEvents, RealtimeState } from '@/lib/realtime/session'
import { echoOverlap, ECHO_WINDOW_MS, speakable } from '@/lib/speech'
import { voiceFailureWords } from './voice-words'

/**
 * Claude as the deck's voice agent: "the browser hears, Claude on the desktop
 * thinks, the desktop's Edge voice speaks — here".
 *
 * Not a realtime audio session, so the hands-free half is this file's:
 *
 *   hear    the mic through the voice hub's own capture worklet
 *           (src/lib/realtime/pcm-worklet.js: 16 kHz Int16, ~100 ms frames and
 *           a level). A level over the room's noise floor starts a turn (with
 *           the frames just before it, so the first word is whole); END_SILENCE_MS
 *           under it ends the turn. The samples go up while he talks
 *           (`voice-claude` `append`), so at the pause only the last slice and
 *           the transcription are left.
 *   think   the desktop transcribes (`done` → `voice-heard`), this page drops
 *           its own echo, the session's caption hook ends the conversation on
 *           a stop phrase, and anything else is `say`d to Claude. The reply
 *           streams back over `events`.
 *   speak   sentence by sentence (`takeSentences`, the desk's rule), each one the
 *           desktop's Edge voice as MP3 (`speak`), played here; the browser's
 *           own speechSynthesis only when Edge fails for a sentence.
 *   barge   speech while it thinks or talks — louder than its own echo while
 *           it talks — stops the playback and interrupts Claude's turn; the
 *           conversation carries on.
 *
 * `stop()` releases everything: the mic, the audio graph, the playback, the
 * wait on `events`, and the desktop session (`close`).
 */

type Ask = (body: WebRequest) => Promise<WebResult>

export interface ClaudeVoiceEvents extends RealtimeSessionEvents {
  /** How many tools Claude is running on the desktop — the watchdog does not call that quiet. */
  onActivity?(toolsRunning: number): void
}

/** One worklet frame. */
const FRAME_MS = 100
/** Voice this long starts a turn. */
const START_FRAMES = 2
/** While it talks, voice has to last longer (and be louder) to be him, not its echo. */
const BARGE_FRAMES = 3
/** A pause this long ends the turn. */
const END_SILENCE_MS = 800
/** Under this much voice in a turn it was a knock or a cough, not a turn. */
const MIN_VOICED_FRAMES = 3
/** Frames kept from before the onset, so the first word is not clipped. */
const PRE_ROLL_FRAMES = 3
/** A turn is cut here even if he has not paused (60 s). */
const MAX_TURN_FRAMES = 600
/** Frames per `append`: one second, 32 KB raw — under MAX_FILE_CHUNK_BYTES. */
const SLICE_FRAMES = Math.min(10, Math.floor(MAX_FILE_CHUNK_BYTES / 3200))
/** The start threshold: this many times the noise floor, and never under START_MIN. */
const START_RATIO = 3
const START_MIN = 0.02
/** Voice continues while the level stays over this share of the start threshold. */
const HOLD_RATIO = 0.6
/** How much louder than the start threshold barge-in must be while it talks. */
const BARGE_RATIO = 2.5
/** The noise floor never climbs past this, so a loud room still hears him. */
const FLOOR_MAX = 0.03
/** Sentences fetched ahead of the one playing. */
const SPEECH_AHEAD = 2
const FAILED_TURN_WORDS = 'That one did not go through.'
const NOT_HEARD_WORDS = 'I did not catch that.'

interface Turn {
  id: string
  frames: Int16Array[]
  /** Frames not yet sent. */
  pending: Int16Array[]
  seq: number
  voiced: number
  quietMs: number
  sends: Array<Promise<WebResult>>
}

interface Line {
  text: string
  audio: Promise<AudioBuffer | null> | null
}

/** A sentence end: `.`, `!` or `?` (and a closing quote) with whitespace after it. */
const SENTENCE_END = /[.!?]["')\]]?(?=\s)/
/** Longest run allowed to wait for a full stop. */
const SENTENCE_MAX = 220

/**
 * The finished sentences at the front of a growing reply, and the rest to
 * keep. src/lib/tts.ts's `takeSpeechChunks`, restated: that module reaches for
 * the desktop's preload and cannot be built into this page.
 */
export function takeSentences(buffer: string): { chunks: string[]; rest: string } {
  const chunks: string[] = []
  let rest = buffer
  for (;;) {
    const hit = SENTENCE_END.exec(rest)
    let cut = hit ? hit.index + hit[0].length : -1
    if (cut < 0) {
      if (rest.length <= SENTENCE_MAX) break
      const window = rest.slice(0, SENTENCE_MAX)
      const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '))
      cut = soft > 0 ? soft + 1 : SENTENCE_MAX
    }
    const head = rest.slice(0, cut).trim()
    rest = rest.slice(cut)
    if (head) chunks.push(head)
  }
  return { chunks, rest }
}

function b64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function bytesFromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function joinFrames(frames: Int16Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Int16Array(total)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return new Uint8Array(out.buffer)
}

export class ClaudeVoiceSession {
  private readonly ask: Ask
  private readonly events: ClaudeVoiceEvents

  private stopped = false
  private opened = false
  private muted = false
  private phase: RealtimeState = 'connecting'

  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private capture: AudioWorkletNode | null = null
  private analyser: AnalyserNode | null = null
  private micLevel = 0

  /* hearing */
  private floor = 0.005
  private over = 0
  private preRoll: Int16Array[] = []
  private turn: Turn | null = null
  private turnSeq = 0
  /** Heard turns are said in the order he said them. */
  private hearing: Promise<void> = Promise.resolve()

  /* the reply */
  /** A turn has been said and its `result` has not come back. */
  private replying = false
  /** Deltas not yet a whole sentence. */
  private buffer = ''
  private replySeq = 0
  private replyText = ''
  private toolsRunning = 0
  /** Results still due from turns he talked over: their events are not this reply's. */
  private staleResults = 0
  /** The last `say` in flight: an interrupt waits for it, or it would land before the turn does. */
  private saying: Promise<unknown> = Promise.resolve()
  private interrupting: Promise<unknown> = Promise.resolve()

  /* speaking */
  private lines: Line[] = []
  private playing: AudioBufferSourceNode | null = null
  private utterance: SpeechSynthesisUtterance | null = null
  private talking = false
  /** Bumped by every barge-in and stop: a sentence fetched before it is not played. */
  private speechGen = 0
  private lastSpoken = ''
  private lastSpokenAt = 0

  constructor(opts: { ask: Ask; events: ClaudeVoiceEvents }) {
    this.ask = opts.ask
    this.events = opts.events
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.setPhase('connecting')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      throw micError(err)
    }
    this.bailIfStopped()
    const ctx = new AudioContext()
    this.ctx = ctx
    await ctx.audioWorklet.addModule(workletUrl)
    this.bailIfStopped()
    const source = ctx.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(ctx, 'forge-pcm-capture', { processorOptions: { targetRate: 16000 } })
    this.capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => this.onFrame(e.data)
    source.connect(this.capture)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
    this.bailIfStopped()

    const res = await this.ask({ kind: 'voice-claude', op: 'open' })
    if (this.stopped) {
      if (res.kind === 'ok') void this.ask({ kind: 'voice-claude', op: 'close' })
      this.bailIfStopped()
    }
    if (res.kind !== 'ok') {
      this.release()
      throw new Error(
        res.kind === 'failed' ? voiceFailureWords(res) : 'The desktop answered with something this page does not understand.'
      )
    }
    this.opened = true
    void this.pollEvents()
    this.setPhase('listening')
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.release()
    this.events.onState('closed')
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.dropTurn()
  }

  /** Stop the reply now: the playback and Claude's turn. */
  interrupt(): void {
    this.bargeIn()
  }

  /** A typed turn, said like a spoken one. */
  sendText(text: string): void {
    const said = text.trim()
    if (said) this.hearing = this.hearing.then(() => this.say(said))
  }

  /** The desktop adds the app context to each turn itself (electron/web-host.ts). */
  sendContext(): void {
    /* nothing to send */
  }

  levels(): { mic: number; out: number } {
    let out = 0
    const a = this.analyser
    if (a && this.talking) {
      const data = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += v * v
      out = Math.min(1, Math.sqrt(sum / data.length) * 3)
    }
    return { mic: this.muted ? 0 : this.micLevel, out }
  }

  private bailIfStopped(): void {
    if (!this.stopped) return
    this.release()
    throw new Error('Voice session stopped while starting')
  }

  /** The mic, the audio graph, the playback, and the desktop session — whatever exists. */
  private release(): void {
    this.stopSpeech()
    this.turn = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.capture?.disconnect()
    this.analyser?.disconnect()
    void this.ctx?.close().catch(() => undefined)
    this.stream = null
    this.ctx = null
    this.capture = null
    this.analyser = null
    this.micLevel = 0
    if (this.opened) {
      this.opened = false
      void this.ask({ kind: 'voice-claude', op: 'close' })
    }
  }

  private fail(reason: string): void {
    if (this.stopped) return
    this.stopped = true
    this.release()
    this.events.onState('error', reason)
  }

  private setPhase(next: RealtimeState): void {
    if (this.phase === next || this.stopped) return
    this.phase = next
    this.events.onState(next)
  }

  /** Where the conversation is, when nothing is being heard or said. */
  private settle(): void {
    if (this.stopped || this.talking || this.lines.length) return
    this.setPhase(this.replying ? 'thinking' : 'listening')
  }

  /* -------------------------------------------------------------- hearing */

  private onFrame(data: { pcm: ArrayBuffer; level: number }): void {
    if (this.stopped || !this.opened) return
    const frame = new Int16Array(data.pcm)
    const level = data.level
    this.micLevel = Math.min(1, level * 4)
    if (this.muted) {
      this.over = 0
      this.preRoll = []
      return
    }
    const start = Math.max(START_MIN, this.floor * START_RATIO)
    const turn = this.turn
    if (turn) {
      turn.frames.push(frame)
      turn.pending.push(frame)
      if (level >= start * HOLD_RATIO) {
        turn.voiced++
        turn.quietMs = 0
        // Enough voice to be him: whatever it was saying or working on stops.
        if (turn.voiced === MIN_VOICED_FRAMES && (this.talking || this.lines.length || this.replying)) this.bargeIn()
      } else {
        turn.quietMs += FRAME_MS
      }
      if (turn.pending.length >= SLICE_FRAMES) this.sendSlice(turn)
      if (turn.quietMs >= END_SILENCE_MS || turn.frames.length >= MAX_TURN_FRAMES) this.endTurn(turn)
      return
    }
    // Its own voice is in the mic while it talks: only louder, longer speech is him.
    const talking = this.talking
    const needed = talking ? start * BARGE_RATIO : start
    if (level >= needed) this.over++
    else {
      this.over = 0
      if (!talking) this.floor = Math.min(FLOOR_MAX, this.floor * 0.95 + level * 0.05)
    }
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
    if (this.over >= (talking ? BARGE_FRAMES : START_FRAMES)) this.beginTurn()
  }

  private beginTurn(): void {
    const frames = this.preRoll
    // Voiced: the frames that were over the line, not the quiet lead-in kept with them.
    const voiced = this.over
    this.preRoll = []
    this.over = 0
    const id = `t${Date.now().toString(36)}-${++this.turnSeq}`
    this.turn = { id, frames: [...frames], pending: [...frames], seq: 0, voiced, quietMs: 0, sends: [] }
    // He is talking: the idle clock starts again (voiceAgent.ts re-arms on a caption).
    this.events.onCaption({ id: `u-${id}`, role: 'user', text: '', final: false })
    if (this.turn.voiced >= MIN_VOICED_FRAMES && (this.talking || this.lines.length || this.replying)) this.bargeIn()
  }

  private sendSlice(turn: Turn): void {
    if (!turn.pending.length) return
    const data = b64FromBytes(joinFrames(turn.pending))
    turn.pending = []
    turn.sends.push(this.ask({ kind: 'voice-claude', op: 'append', turnId: turn.id, seq: turn.seq++, data }))
  }

  /** A turn that was not one: dropped here and on the desktop. */
  private dropTurn(): void {
    const turn = this.turn
    this.turn = null
    if (turn && turn.seq > 0) void this.ask({ kind: 'voice-claude', op: 'cancel', turnId: turn.id })
  }

  private endTurn(turn: Turn): void {
    this.turn = null
    if (turn.voiced < MIN_VOICED_FRAMES) {
      if (turn.seq > 0) void this.ask({ kind: 'voice-claude', op: 'cancel', turnId: turn.id })
      return
    }
    this.sendSlice(turn)
    this.setPhase('thinking')
    const heard = this.hear(turn)
    this.hearing = this.hearing.then(async () => {
      const text = await heard
      if (text) await this.say(text, `u-${turn.id}`)
      else this.settle()
    })
  }

  /** The turn's words, from the desktop — or '' for nothing worth saying. */
  private async hear(turn: Turn): Promise<string> {
    const sent = await Promise.all(turn.sends)
    if (this.stopped) return ''
    const refused = sent.find((r) => r.kind === 'failed')
    if (refused) {
      this.fail(voiceFailureWords(refused))
      return ''
    }
    const res = await this.ask({ kind: 'voice-claude', op: 'done', turnId: turn.id, chunks: turn.seq })
    if (this.stopped) return ''
    if (res.kind !== 'voice-heard') {
      // One turn not heard is not the end of the conversation: say so and listen on.
      this.queueSpeech(NOT_HEARD_WORDS)
      return ''
    }
    const text = res.text.trim()
    // Its own words come back through the mic (the desk's rule, src/lib/speech.ts).
    const recent = Date.now() - this.lastSpokenAt < ECHO_WINDOW_MS || this.talking
    if (recent && text.split(/\s+/).length >= 3 && echoOverlap(text, this.lastSpoken) >= 0.7) return ''
    return text
  }

  /* ---------------------------------------------------------------- reply */

  private async say(text: string, captionId = `u-typed-${Date.now().toString(36)}`): Promise<void> {
    if (this.stopped) return
    // His words, final: voiceAgent.ts ends the conversation here on a stop phrase.
    this.events.onCaption({ id: captionId, role: 'user', text, final: true })
    if (this.stopped) return
    // A barge-in's interrupt lands first, so the old turn's end is not this one's.
    await this.interrupting
    if (this.stopped) return
    this.replying = true
    this.buffer = ''
    this.replyText = ''
    this.replySeq++
    this.setPhase('thinking')
    const sent = this.ask({ kind: 'voice-claude', op: 'say', text })
    this.saying = sent
    const res = await sent
    if (this.stopped) return
    if (res.kind === 'failed') this.fail(voiceFailureWords(res))
  }

  private async pollEvents(): Promise<void> {
    while (!this.stopped) {
      const res = await this.ask({ kind: 'voice-claude', op: 'events' })
      if (this.stopped) return
      if (res.kind !== 'voice-claude-events') {
        this.fail(
          res.kind === 'failed' ? `Lost Claude on the desktop: ${voiceFailureWords(res)}` : 'The desktop answered with something this page does not understand.'
        )
        return
      }
      for (const event of res.events) {
        this.onEvent(event)
        if (this.stopped) return
      }
      if (!res.open) {
        this.fail('Claude closed on the desktop.')
        return
      }
    }
  }

  private onEvent(event: WebVoiceClaudeEvent): void {
    if (event.type === 'closed') {
      this.fail(event.reason)
      return
    }
    // A turn he talked over: everything up to its end belongs to it. (A
    // session that dies mid-turn ends it with `error` and no `result`.)
    if (this.staleResults > 0) {
      if (event.type === 'result' || event.type === 'error') this.staleResults--
      return
    }
    // Anything from Claude is not quiet: the watchdog starts again.
    if (this.replying) this.events.onActivity?.(this.toolsRunning)
    switch (event.type) {
      case 'delta': {
        if (!this.replying) return
        this.buffer += event.text
        const { chunks, rest } = takeSentences(this.buffer)
        this.buffer = rest
        for (const chunk of chunks) this.queueSpeech(chunk)
        return
      }
      case 'assistant':
        if (!this.replying) return
        this.replyText = this.replyText ? `${this.replyText}\n${event.text}` : event.text
        this.events.onCaption({ id: `a-${this.replySeq}`, role: 'assistant', text: this.replyText, final: false })
        return
      case 'tool':
        this.toolsRunning = event.phase === 'start' ? this.toolsRunning + 1 : Math.max(0, this.toolsRunning - 1)
        this.events.onActivity?.(this.toolsRunning)
        return
      case 'result':
      case 'error': {
        if (!this.replying) return
        this.replying = false
        this.toolsRunning = 0
        this.events.onActivity?.(0)
        const tail = this.buffer.trim()
        this.buffer = ''
        if (tail) this.queueSpeech(tail)
        const ok = event.type === 'result' && event.ok
        if (!ok && !this.replyText) this.queueSpeech(FAILED_TURN_WORDS)
        this.events.onCaption({
          id: `a-${this.replySeq}`,
          role: 'assistant',
          text: this.replyText || (ok ? '' : FAILED_TURN_WORDS),
          final: true
        })
        this.settle()
        return
      }
    }
  }

  /** Barge-in: the playback stops, and Claude's turn with it; the conversation stays. */
  private bargeIn(): void {
    this.stopSpeech()
    if (this.replying) {
      this.replying = false
      this.staleResults++
      this.buffer = ''
      this.toolsRunning = 0
      this.events.onActivity?.(0)
      this.interrupting = this.saying.then(() => this.ask({ kind: 'voice-claude', op: 'interrupt' }))
    }
    this.setPhase('listening')
  }

  /* ------------------------------------------------------------- speaking */

  private queueSpeech(text: string): void {
    const clean = speakable(text)
    if (!clean || this.stopped) return
    this.lines.push({ text: clean, audio: null })
    this.fetchAhead()
    void this.pump()
  }

  private fetchAhead(): void {
    for (const line of this.lines.slice(0, SPEECH_AHEAD)) {
      if (!line.audio) line.audio = this.fetchSpeech(line.text)
    }
  }

  /** One sentence as the desktop's Edge voice, decoded — or null, and the browser's own voice says it. */
  private async fetchSpeech(text: string): Promise<AudioBuffer | null> {
    const res = await this.ask({ kind: 'voice-claude', op: 'speak', text })
    const ctx = this.ctx
    if (res.kind !== 'voice-speech' || !ctx) return null
    try {
      return await ctx.decodeAudioData(bytesFromB64(res.audio).buffer)
    } catch {
      return null
    }
  }

  private async pump(): Promise<void> {
    if (this.talking || this.stopped) return
    const line = this.lines[0]
    if (!line) {
      this.settle()
      return
    }
    this.talking = true
    const gen = this.speechGen
    line.audio ??= this.fetchSpeech(line.text)
    const audio = await line.audio
    if (gen !== this.speechGen || this.stopped) return
    this.lines.shift()
    this.fetchAhead()
    this.setPhase('speaking')
    this.lastSpoken = line.text
    const done = (): void => {
      if (gen !== this.speechGen) return
      this.playing = null
      this.utterance = null
      this.talking = false
      this.lastSpokenAt = Date.now()
      void this.pump()
    }
    const ctx = this.ctx
    if (audio && ctx && this.analyser) {
      const node = ctx.createBufferSource()
      node.buffer = audio
      node.connect(this.analyser)
      node.onended = done
      this.playing = node
      node.start()
      return
    }
    if (typeof speechSynthesis === 'undefined') {
      done()
      return
    }
    const utterance = new SpeechSynthesisUtterance(line.text)
    utterance.onend = done
    utterance.onerror = done
    this.utterance = utterance
    speechSynthesis.speak(utterance)
  }

  /** Silence now, and nothing queued. */
  private stopSpeech(): void {
    this.speechGen++
    this.lines = []
    const node = this.playing
    this.playing = null
    if (node) {
      node.onended = null
      try {
        node.stop()
      } catch {
        /* never started */
      }
    }
    if (this.utterance && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
    this.utterance = null
    if (this.talking) this.lastSpokenAt = Date.now()
    this.talking = false
  }
}

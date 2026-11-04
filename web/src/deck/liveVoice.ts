import { useSyncExternalStore } from 'react'
import type { LiveEvent, LiveJob, LiveJobAction, LiveStatus } from '@shared/live'
import type { WebRequest, WebResult, WebVoiceClaudeEvent } from '@shared/web'
import {
  ACK_AFTER_MS,
  appendCaption,
  BARGE_DUCK_LEVEL,
  BARGE_STOP_MS,
  buildLatencySample,
  endLines,
  isEcho,
  newsGapOpen,
  queueNews,
  rememberLine,
  shouldAck,
  takeNews,
  type QueuedNews,
  type SpokenLine,
  type TurnClock
} from '@/lib/live/turns'
import type { RealtimeSessionEvents, RealtimeState } from '@/lib/realtime/session'
import { speakable } from '@/lib/speech'
import { bytesFromB64 } from './claudeVoice'
import { OpenAIPhoneEars, PcmEars, type EarsHandlers, type PhoneEars } from './live-ears'
import { LIVE_ACK_LINES, liveCardsOf, takeClauses } from './live-words'
import { updateDesktopWords, voiceFailureWords } from './voice-words'

/**
 * Claude Live in Forge Web (the phone and the deck): the desktop's one Live
 * voice brain, heard and spoken here. `voice-claude` with agent `claude-live`
 * (shared/web.ts) — the brains, the Conductor and the job ledger all stay on
 * the desktop (electron/live/), and this page is ears, mouth and cards.
 *
 *   ears    an OpenAI realtime transcription session from this browser
 *           (./live-ears.ts, the desk's client restated): semantic VAD, the
 *           browser's echo canceller, deltas as live captions. The SDP offer
 *           goes to the desktop (`ears`), which mints the secret with its
 *           key; the key never comes here. No OpenAI key (or the local ears
 *           picked in Settings): the level VAD Claude uses, and the desktop
 *           transcribes.
 *   think   each finished turn is `say`d under this page's own turn id; the
 *           reply's pieces come back over `events` as `{ type: 'live' }`.
 *   mouth   clause by clause, first clause first (`takeClauses`), each one
 *           Kokoro on the desktop as WAV (`speak`), the next fetched while
 *           this one plays, all through one AudioContext. "One sec." when
 *           nothing has sounded ACK_AFTER_MS after he stopped (the clips are
 *           made once, at the start).
 *   barge   his voice while it talks ducks it at once and stops it
 *           BARGE_STOP_MS later, and cancels the turn; jobs keep running.
 *   news    needs-you and done lines from the ledger are spoken at a gap,
 *           never over him or over a reply (src/lib/live/turns.ts), and the
 *           ledger feeds the cards (`useLiveCards`).
 *
 * The latency of every spoken turn goes back to the desktop (`latency`),
 * which logs `[live] web latency …`.
 */

type Ask = (body: WebRequest) => Promise<WebResult>

export interface LiveVoiceEvents extends RealtimeSessionEvents {
  /** Anything from the brain: the watchdog does not call it quiet. */
  onActivity?(toolsRunning: number): void
}

/** Clauses fetched ahead of the one playing. */
const SPEECH_AHEAD = 2
/** An empty caption this soon after speech started is the ears clearing it, not "nothing was said". */
const HEARD_NOTHING_MS = 50
/** News waiting for a gap is looked at again this often. */
const NEWS_RETRY_MS = 500
const FAILED_TURN_WORDS = 'That one did not go through.'

/* ---------------------------------------------------------------- cards */

export interface LiveCardsState {
  /** Live is open in this browser. */
  on: boolean
  /** The jobs worth a card: waiting on him first, then the newest finished. */
  cards: LiveJob[]
  /** Jobs working now. */
  working: number
  status: LiveStatus | null
}

const NO_CARDS: LiveCardsState = { on: false, cards: [], working: 0, status: null }
let cardsState: LiveCardsState = NO_CARDS
let ledgerJobs: LiveJob[] = []
/** `${id}:${updatedAt}` of cards he put away: a job that moves again comes back. */
const dismissed = new Set<string>()
const cardListeners = new Set<() => void>()
/** The open session's ask, for the cards' buttons. */
let cardAsk: Ask | null = null

function publishCards(patch: Partial<LiveCardsState>): void {
  const next = { ...cardsState, ...patch }
  next.cards = liveCardsOf(ledgerJobs, Date.now(), dismissed)
  next.working = ledgerJobs.filter((j) => j.state === 'running' || j.state === 'queued').length
  cardsState = next
  cardListeners.forEach((fn) => fn())
}

function subscribeCards(fn: () => void): () => void {
  cardListeners.add(fn)
  return () => cardListeners.delete(fn)
}

/** The cards, for the phone's and the deck's list. */
export function useLiveCards(): LiveCardsState {
  return useSyncExternalStore(subscribeCards, () => cardsState, () => cardsState)
}

/** A Live job still open (working, waiting, or waiting on him): quiet is not the end of the conversation. */
export function liveJobsOpen(): boolean {
  return cardsState.on && ledgerJobs.some((j) => j.state === 'running' || j.state === 'queued' || j.state === 'needs-you')
}

/** Put a card away. It comes back if the job moves again. */
export function dismissLiveCard(job: LiveJob): void {
  dismissed.add(`${job.id}:${job.updatedAt}`)
  publishCards({})
}

/** A tap on a card's Stop (or the desk's Show): answered with null, or the sentence why not. */
export async function liveJobTap(jobId: string, action: LiveJobAction): Promise<string | null> {
  const ask = cardAsk
  if (!ask) return 'Claude Live is not open here.'
  const res = await ask({ kind: 'voice-claude', op: 'job', jobId, action })
  if (res.kind === 'ok') return null
  return res.kind === 'failed' ? voiceFailureWords(res, 'claude-live') : 'The desktop answered with something this page does not understand.'
}

/* -------------------------------------------------------------- session */

interface Line {
  text: string
  kind: 'reply' | 'ack' | 'news'
  /** The turn a reply or ack is for. */
  turnId?: string
  audio: Promise<AudioBuffer | null> | null
}

interface Turn {
  id: string
  clock: TurnClock
  /** The reply so far, for the caption. */
  reply: string
  /** Reply text not yet a chunk. */
  buffer: string
  chunks: number
  ended: boolean
  logged: boolean
  ackTimer: number | null
}

export class LiveVoiceSession {
  private readonly ask: Ask
  private readonly events: LiveVoiceEvents

  private stopped = false
  private opened = false
  private muted = false
  private phase: RealtimeState = 'connecting'

  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private ears: PhoneEars | null = null

  /* hearing */
  private hearing = false
  private hearingAt = 0
  private heardEndAt: number | null = null
  private hearSeq = 0
  private bargeTimer: number | null = null

  /* the turn */
  private turn: Turn | null = null
  private turnSeq = 0
  private saying: Promise<unknown> = Promise.resolve()
  private interrupting: Promise<unknown> = Promise.resolve()

  /* speaking */
  private lines: Line[] = []
  private playing: AudioBufferSourceNode | null = null
  private utterance: SpeechSynthesisUtterance | null = null
  private talking = false
  private speechGen = 0
  private spoken: SpokenLine[] = []
  private readonly acks = new Map<string, AudioBuffer>()
  private lastAck: string | undefined
  private acksFilling = false

  /* news */
  private news: QueuedNews[] = []
  private newsTimer: number | null = null

  constructor(opts: { ask: Ask; events: LiveVoiceEvents }) {
    this.ask = opts.ask
    this.events = opts.events
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.setPhase('connecting')
    // One context for every clause, ack and news line; made first, while his tap on Listen is fresh.
    const ctx = new AudioContext()
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.gain.connect(this.analyser)
    this.analyser.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
    this.bailIfStopped()

    const res = await this.ask({ kind: 'voice-claude', op: 'open', agent: 'claude-live' })
    if (this.stopped) {
      if (res.kind === 'ok') void this.ask({ kind: 'voice-claude', op: 'close' })
      this.bailIfStopped()
    }
    if (res.kind !== 'ok') {
      this.release()
      throw new Error(
        res.kind === 'failed' ? voiceFailureWords(res, 'claude-live') : 'The desktop answered with something this page does not understand.'
      )
    }
    this.opened = true
    cardAsk = this.ask
    ledgerJobs = []
    publishCards({ on: true, status: null })
    void this.pollEvents()

    this.ears = await this.openEars()
    this.bailIfStopped()
    void this.fillAcks()
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
    if (muted) this.events.onCaption({ id: `u-h${this.hearSeq}`, role: 'user', text: '', final: false })
    else this.tryNews()
  }

  interrupt(): void {
    this.bargeIn()
  }

  sendText(text: string): void {
    const said = text.trim()
    if (said) void this.startTurn(said, undefined)
  }

  /** The desktop gives the voice brain the app state itself (electron/live/). */
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
    return { mic: this.muted ? 0 : (this.ears?.level() ?? 0), out }
  }

  private bailIfStopped(): void {
    if (!this.stopped) return
    this.release()
    throw new Error('Voice session stopped while starting')
  }

  private release(): void {
    this.stopSpeech()
    this.clearTurn()
    this.bargeTimer = clear(this.bargeTimer)
    this.newsTimer = clear(this.newsTimer)
    this.news = []
    this.ears?.stop()
    this.ears = null
    this.gain?.disconnect()
    this.analyser?.disconnect()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.gain = null
    this.analyser = null
    if (cardAsk === this.ask) cardAsk = null
    ledgerJobs = []
    publishCards({ on: false, status: null })
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

  /** Where the conversation is when nothing is being said. */
  private settle(): void {
    if (this.stopped || this.talking || this.lines.length) return
    this.setPhase(this.turn && !this.turn.ended ? 'thinking' : 'listening')
  }

  /* ----------------------------------------------------------------- ears */

  /**
   * OpenAI's ears when the desktop will open them; otherwise the PCM path.
   * A mic that will not open is the one failure that ends it here.
   */
  private async openEars(): Promise<PhoneEars> {
    const handlers = this.earsHandlers()
    const ctx = this.ctx
    if (!ctx) throw new Error('Voice session stopped while starting')
    // A desktop from before Claude Live opened plain Claude for `open` and does not know `ears`.
    let stale = false
    const openai = new OpenAIPhoneEars(async (sdp) => {
      const res = await this.ask({ kind: 'voice-claude', op: 'ears', sdp })
      if (res.kind === 'voice-connect') return { ok: true, sdp: res.sdp }
      if (res.kind === 'failed' && res.code === 'bad-frame' && /not a voice-claude op/i.test(res.message)) stale = true
      return { ok: false, error: res.kind === 'failed' ? res.message || 'The desktop opened no ears.' : 'The desktop opened no ears.' }
    }, ctx)
    try {
      await openai.start(handlers)
      return openai
    } catch (err) {
      openai.stop()
      // Before the offer went out, the mic itself failed: say so.
      if (!openai.offered) throw err
      if (stale) throw new Error(updateDesktopWords('claude-live'))
      console.warn('[live] OpenAI ears not used here:', err instanceof Error ? err.message : err)
    }
    this.bailIfStopped()
    const pcm = new PcmEars(this.ask, ctx)
    await pcm.start(handlers)
    return pcm
  }

  private earsHandlers(): EarsHandlers {
    return {
      onSpeechStart: () => {
        if (this.stopped || this.muted) return
        this.hearing = true
        this.hearingAt = Date.now()
        this.hearSeq++
        this.events.onCaption({ id: `u-h${this.hearSeq}`, role: 'user', text: '', final: false })
        if (this.busy()) this.duckThenBarge()
      },
      onPartial: (text) => {
        if (this.stopped || this.muted) return
        // '' straight after the start is the ears clearing the caption; later, nothing came of it.
        if (text) this.hearingAt = Date.now()
        else if (Date.now() - this.hearingAt > HEARD_NOTHING_MS) this.hearing = false
        this.events.onCaption({ id: `u-h${this.hearSeq}`, role: 'user', text, final: false })
      },
      onTurn: (text, eosAt) => {
        if (this.stopped) return
        this.hearing = false
        this.heardEndAt = eosAt
        if (this.muted) return
        // Its own words through the mic: not him.
        if (isEcho(text, this.spoken, Date.now())) {
          this.unduck()
          this.events.onCaption({ id: `u-h${this.hearSeq}`, role: 'user', text: '', final: false })
          this.tryNews()
          return
        }
        void this.startTurn(text, eosAt, `u-h${this.hearSeq}`)
      },
      onError: (message) => {
        if (this.stopped) return
        if (/press Listen/i.test(message)) {
          this.fail(message)
          return
        }
        this.hearing = false
        if (/catch that/i.test(message)) this.queueSpeech(message, 'reply')
        else console.warn('[live] ears:', message)
      }
    }
  }

  /** Something of its own is going on: a reply on its way, or words coming out. */
  private busy(): boolean {
    return this.talking || this.lines.length > 0 || (this.turn !== null && !this.turn.ended)
  }

  /** His voice over it: quiet at once, stopped a beat later (the desk's BARGE_STOP_MS). */
  private duckThenBarge(): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(BARGE_DUCK_LEVEL, this.ctx.currentTime, 0.015)
    if (this.bargeTimer !== null) return
    this.bargeTimer = window.setTimeout(() => {
      this.bargeTimer = null
      if (this.hearing) this.bargeIn()
      else this.unduck()
    }, BARGE_STOP_MS)
  }

  private unduck(): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.03)
  }

  /* ---------------------------------------------------------------- turns */

  private async startTurn(text: string, eosAt: number | undefined, captionId = `u-typed-${Date.now().toString(36)}`): Promise<void> {
    if (this.stopped) return
    // A new turn talks over whatever was going on.
    if (this.busy()) this.bargeIn()
    this.events.onCaption({ id: captionId, role: 'user', text, final: true })
    // voiceAgent.ts may have ended the conversation on a stop phrase.
    if (this.stopped) return
    const id = `lv${Date.now().toString(36)}-${++this.turnSeq}`
    const turn: Turn = {
      id,
      clock: { turnId: id, ...(eosAt !== undefined ? { eosAt } : {}), sentAt: Date.now(), ack: false },
      reply: '',
      buffer: '',
      chunks: 0,
      ended: false,
      logged: false,
      ackTimer: null
    }
    this.turn = turn
    this.setPhase('thinking')
    if (eosAt !== undefined) {
      turn.ackTimer = window.setTimeout(() => this.maybeAck(turn), Math.max(0, ACK_AFTER_MS - (Date.now() - eosAt)))
    }
    await this.interrupting
    if (this.stopped || this.turn !== turn) return
    turn.clock.sentAt = Date.now()
    const sent = this.ask({ kind: 'voice-claude', op: 'say', text, turnId: id })
    this.saying = sent
    const res = await sent
    if (this.stopped) return
    if (res.kind === 'failed') this.fail(voiceFailureWords(res, 'claude-live'))
  }

  private maybeAck(turn: Turn): void {
    turn.ackTimer = null
    if (this.stopped || this.turn !== turn || turn.clock.eosAt === undefined) return
    const ready = LIVE_ACK_LINES.filter((l) => this.acks.has(l))
    const audioStarted = turn.clock.firstAudioAt !== undefined || this.talking
    if (!shouldAck({ now: Date.now(), eosAt: turn.clock.eosAt, audioStarted, ready: ready.length, acked: turn.clock.ack })) return
    const at = this.lastAck ? LIVE_ACK_LINES.indexOf(this.lastAck) : -1
    let line: string | undefined
    for (let i = 1; i <= LIVE_ACK_LINES.length && !line; i++) {
      const pick = LIVE_ACK_LINES[(at + i) % LIVE_ACK_LINES.length]!
      if (this.acks.has(pick)) line = pick
    }
    if (!line) return
    this.lastAck = line
    turn.clock.ack = true
    this.lines.unshift({ text: line, kind: 'ack', turnId: turn.id, audio: Promise.resolve(this.acks.get(line) ?? null) })
    void this.pump()
  }

  private clearTurn(): void {
    const turn = this.turn
    this.turn = null
    if (turn?.ackTimer != null) window.clearTimeout(turn.ackTimer)
  }

  /** The ack clips, made once in Kokoro's voice, one at a time, while nothing else is being said. */
  private async fillAcks(): Promise<void> {
    if (this.acksFilling) return
    this.acksFilling = true
    try {
      for (const line of LIVE_ACK_LINES) {
        if (this.stopped) return
        if (this.acks.has(line)) continue
        if (this.busy()) return
        const audio = await this.fetchSpeech(line)
        if (audio) this.acks.set(line, audio)
      }
    } finally {
      this.acksFilling = false
    }
  }

  /* --------------------------------------------------------------- events */

  private async pollEvents(): Promise<void> {
    while (!this.stopped) {
      const res = await this.ask({ kind: 'voice-claude', op: 'events' })
      if (this.stopped) return
      if (res.kind !== 'voice-claude-events') {
        this.fail(
          res.kind === 'failed'
            ? `Lost Claude Live on the desktop: ${voiceFailureWords(res, 'claude-live')}`
            : 'The desktop answered with something this page does not understand.'
        )
        return
      }
      for (const event of res.events) {
        this.onEvent(event)
        if (this.stopped) return
      }
      if (!res.open) {
        this.fail('Claude Live closed on the desktop.')
        return
      }
    }
  }

  private onEvent(event: WebVoiceClaudeEvent): void {
    if (event.type === 'closed') {
      this.fail(event.reason)
      return
    }
    if (event.type === 'live') this.onLive(event.event)
  }

  private onLive(event: LiveEvent): void {
    switch (event.type) {
      case 'say': {
        const turn = this.turn
        if (!turn || turn.id !== event.turnId || turn.ended) return
        // It has started answering: a tool it runs after the first clause is not quiet.
        this.events.onActivity?.(event.final ? 0 : 1)
        if (event.text) {
          turn.clock.firstTextAt ??= Date.now()
          turn.reply = appendCaption(turn.reply, event.text)
          this.events.onCaption({ id: `a-${turn.id}`, role: 'assistant', text: turn.reply, final: false })
          turn.buffer += event.text
          const { chunks, rest } = takeClauses(turn.buffer, turn.chunks === 0)
          turn.buffer = rest
          for (const chunk of chunks) {
            turn.chunks++
            this.queueSpeech(chunk, 'reply', turn.id)
          }
        }
        if (event.final) this.flushTurn(turn)
        return
      }
      case 'turn-end': {
        const turn = this.turn
        if (!turn || turn.id !== event.turnId || turn.ended) return
        this.flushTurn(turn)
        turn.ended = true
        if (turn.ackTimer !== null) window.clearTimeout(turn.ackTimer)
        turn.ackTimer = null
        const failed = !event.ok && !turn.reply.trim()
        if (failed) this.queueSpeech(FAILED_TURN_WORDS, 'reply', turn.id)
        this.events.onCaption({
          id: `a-${turn.id}`,
          role: 'assistant',
          // The reason is shown, not said: "There is no Anthropic key…" is for reading.
          text: failed ? (event.error ? `${FAILED_TURN_WORDS} ${event.error}` : FAILED_TURN_WORDS) : turn.reply,
          final: true
        })
        this.events.onActivity?.(0)
        if (!this.talking && !this.lines.length) this.logTurn(turn)
        this.settle()
        this.tryNews()
        return
      }
      case 'news':
        this.news = queueNews(this.news, {
          id: event.id,
          ...(event.jobId ? { jobId: event.jobId } : {}),
          text: event.text,
          urgency: event.urgency,
          at: Date.now()
        })
        this.tryNews()
        return
      case 'ledger':
        ledgerJobs = event.snapshot.jobs
        publishCards({})
        return
      case 'status':
        publishCards({ status: event.status })
        return
      case 'show':
        return
    }
  }

  /** The rest of a reply, spoken: there will be no more of it. */
  private flushTurn(turn: Turn): void {
    const tail = turn.buffer.trim()
    turn.buffer = ''
    if (tail) {
      turn.chunks++
      this.queueSpeech(tail, 'reply', turn.id)
    }
  }

  /** One turn's latency to the desktop's log, once. Typed turns have no end of speech to measure from. */
  private logTurn(turn: Turn): void {
    if (turn.logged) return
    turn.logged = true
    const sample = buildLatencySample(turn.clock)
    if (sample) void this.ask({ kind: 'voice-claude', op: 'latency', sample })
  }

  /** Speak the news if there is a gap now; look again soon if there is not. */
  private tryNews(): void {
    this.newsTimer = clear(this.newsTimer)
    if (this.stopped || !this.news.length) return
    const open =
      !this.muted &&
      newsGapOpen({
        now: Date.now(),
        hearing: this.hearing,
        heardEndAt: this.heardEndAt,
        speaking: this.talking || this.lines.length > 0,
        turnBusy: this.turn !== null && !this.turn.ended
      })
    if (!open) {
      this.newsTimer = window.setTimeout(() => this.tryNews(), NEWS_RETRY_MS)
      return
    }
    const next = takeNews(this.news)
    if (!next) return
    this.news = next.rest
    this.queueSpeech(next.say, 'news')
  }

  /** Barge-in: the playback stops and the turn's reply with it; the jobs and the conversation carry on. */
  private bargeIn(): void {
    this.bargeTimer = clear(this.bargeTimer)
    this.stopSpeech()
    this.unduck()
    const turn = this.turn
    if (turn && !turn.ended) {
      this.logTurn(turn)
      this.interrupting = this.saying.then(() => this.ask({ kind: 'voice-claude', op: 'interrupt' }))
      this.events.onActivity?.(0)
    }
    this.clearTurn()
    this.setPhase('listening')
  }

  /* ------------------------------------------------------------- speaking */

  private queueSpeech(text: string, kind: Line['kind'], turnId?: string): void {
    const clean = speakable(text)
    if (!clean || this.stopped) return
    this.lines.push({ text: clean, kind, ...(turnId ? { turnId } : {}), audio: null })
    this.fetchAhead()
    void this.pump()
  }

  private fetchAhead(): void {
    for (const line of this.lines.slice(0, SPEECH_AHEAD)) {
      if (!line.audio) line.audio = this.fetchSpeech(line.text)
    }
  }

  /** One clause in Kokoro's voice from the desktop, decoded — or null, and the browser's own voice says it. */
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
    this.ears?.setSpeaking(true)
    const gen = this.speechGen
    line.audio ??= this.fetchSpeech(line.text)
    const audio = await line.audio
    if (gen !== this.speechGen || this.stopped) return
    this.lines.shift()
    this.fetchAhead()
    this.setPhase('speaking')
    this.spoken = rememberLine(this.spoken, line.text)
    this.stampAudio(line)
    const done = (): void => {
      if (gen !== this.speechGen) return
      this.playing = null
      this.utterance = null
      this.talking = false
      this.spoken = endLines(this.spoken, Date.now())
      const turn = this.turn
      if (!this.lines.length) {
        this.ears?.setSpeaking(false)
        if (turn?.ended) this.logTurn(turn)
        this.tryNews()
        void this.fillAcks()
      }
      void this.pump()
    }
    const ctx = this.ctx
    if (audio && ctx && this.gain) {
      const node = ctx.createBufferSource()
      node.buffer = audio
      node.connect(this.gain)
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

  /** The turn's clock: the first sound for it (an ack counts), and the first of the reply itself. */
  private stampAudio(line: Line): void {
    const turn = this.turn
    if (!turn || line.turnId !== turn.id) return
    const now = Date.now()
    turn.clock.firstAudioAt ??= now
    if (line.kind === 'reply') turn.clock.firstReplyAudioAt ??= now
  }

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
    this.spoken = endLines(this.spoken, Date.now())
    this.talking = false
    this.ears?.setSpeaking(false)
  }
}

function clear(t: number | null): null {
  if (t !== null) window.clearTimeout(t)
  return null
}

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { LiveEvent, LiveJob, LiveStatus } from '@shared/live'
import type { LiveEars, Settings, VoiceEngine } from '@shared/types'
import { DEFAULT_KOKORO_VOICE } from '@shared/tts'
import { liveCardFor, liveCardWho, livePushLine, type LiveCardAnswer } from '@shared/live-card'
import type { LivePhase, LiveShowing, LiveTurn, LiveView } from '@/components/live/types'
import { joinsTurnInFlight } from '@/lib/brainConfirmVoice'
import type { Ears, EarsHandlers, EarsKind } from '@/lib/live/ears'
import { OpenAIEars, openAIEarsAvailable } from '@/lib/live/ears-openai'
import { ParakeetEars } from '@/lib/live/ears-parakeet'
import { LiveMouth, type MouthItem } from '@/lib/live/mouth'
import { showPaneById } from '@/lib/live/showPane'
import {
  ACK_AFTER_MS,
  appendCaption,
  BARGE_DUCK_LEVEL,
  BARGE_STOP_MS,
  buildLatencySample,
  endLines,
  isEcho,
  jobsView,
  joinPhrases,
  livePhase,
  newsGapOpen,
  queueNews,
  rememberLine,
  shouldAck,
  takeNews,
  upsertTurn,
  type QueuedNews,
  type SpokenLine,
  type TurnClock
} from '@/lib/live/turns'
import { speaker } from '@/lib/speech'
import { ACK_LINES, nextAck, voiceSpeaker, type VoiceConfig } from '@/lib/tts'
import { shallowEqual, useAppSelector } from '@/state/AppState'

/**
 * Claude Live's voice shell (docs/live-agent-plan.md §1): the provider and
 * `useLive()`, the one view the Live UI (src/components/live/) and the bar
 * read. It does not go through src/state/VoiceAgent.tsx.
 *
 *   ears    always-open mic, semantic end of turn (src/lib/live/ears-*.ts)
 *   brains  in main, over `window.forge.live` (shared/live.ts): a finished
 *           turn goes up with `ask`, the reply comes back as `say` pieces
 *   mouth   Kokoro, clause-streamed, with a spoken ack when nothing has been
 *           heard 600 ms after he stopped (src/lib/live/mouth.ts)
 *
 * Barge-in stops only the speech: duck at once, stop 150 ms later, and
 * `cancelTurn` the reply; the Conductor's jobs keep running. News from the
 * ledger waits for a gap — never over him, never within a second of him
 * stopping — "needs you" first. Every spoken turn's latency goes to main's
 * dev log (`logLatency`).
 *
 * The runtime is a plain object outside React (one per provider) and the
 * view a `useSyncExternalStore` snapshot of it, so a caption delta re-renders
 * the Live UI and nothing else.
 */

export type { LivePhase, LiveShowing, LiveTurn }

/** The brief's LiveView, with Promise-returning actions, plus what the shell knows besides. */
export interface LiveControllerView extends LiveView {
  start(): Promise<void>
  stop(): Promise<void>
  toggle(): Promise<void>
  sendTyped(text: string): Promise<void>
  stopJob(id: string): Promise<void>
  showJob(id: string): Promise<void>
  /** Stop what Forge is saying now (and the reply it belongs to). Jobs are not touched. */
  interrupt(): void
  /**
   * The Dictate key is taking down words for a pane: until `false`, what the
   * ears hear is not a turn and not a barge-in (the realtime brains' V5 rule).
   */
  setHeld(held: boolean): void
  /** Why the last Listen-on failed, until the next one. A running Live reports through `error`. */
  startError?: string
  /** What Forge is showing (the contract's `show` event, for a pane). For LiveSurface's `showing` prop. */
  showing: LiveShowing | null
  /** Which ears are open, while Live runs. */
  ears?: EarsKind
}

/* --------------------------------------------------------------- settings */

interface LiveSettings {
  liveEars: LiveEars
  hasOpenAIKey: boolean
  agentSilenceMs: number
  voiceEngine: VoiceEngine
  hasGeminiKey: boolean
  voiceEdgeVoice: string
  voiceTtsVoice: string
  voiceTtsModel: string
  voiceReplyVoice: string
  kokoroVoice: string
}

function selectLiveSettings(state: { settings: Settings }): LiveSettings {
  const s = state.settings
  return {
    liveEars: s.liveEars,
    hasOpenAIKey: (s.openaiKey ?? '').trim().length > 0,
    agentSilenceMs: s.agentSilenceMs,
    voiceEngine: s.voiceEngine,
    hasGeminiKey: (s.geminiKey ?? '').trim().length > 0,
    voiceEdgeVoice: s.voiceEdgeVoice,
    voiceTtsVoice: s.voiceTtsVoice,
    voiceTtsModel: s.voiceTtsModel,
    voiceReplyVoice: s.voiceReplyVoice,
    kokoroVoice: s.kokoroVoice || DEFAULT_KOKORO_VOICE
  }
}

/** Kokoro first, the rest of the configured chain behind it — the same shape VoiceAgent gives Claude Voice. */
function voiceConfigOf(s: LiveSettings): VoiceConfig {
  return {
    engine: s.voiceEngine,
    hasKey: s.hasGeminiKey,
    edgeVoice: s.voiceEdgeVoice,
    geminiVoice: s.voiceTtsVoice,
    ttsModel: s.voiceTtsModel,
    localVoice: s.voiceReplyVoice,
    kokoroVoice: s.kokoroVoice
  }
}

/* ---------------------------------------------------------------- runtime */

interface Shell {
  running: boolean
  starting: boolean
  speaking: boolean
  hearing: boolean
  thinking: boolean
  turns: LiveTurn[]
  caption: LiveView['caption']
  jobs: LiveJob[]
  status?: LiveStatus
  error?: string
  showing: LiveShowing | null
  ears?: EarsKind
  startError?: string
}

const INITIAL: Shell = {
  running: false,
  starting: false,
  speaking: false,
  hearing: false,
  thinking: false,
  turns: [],
  caption: {},
  jobs: [],
  showing: null
}

interface InFlight {
  id: string
  parts: string[]
  sentAt: number
  voiced: boolean
  answering: boolean
  ended: boolean
}

interface Clock extends TurnClock {
  acked: boolean
  ended: boolean
  logged: boolean
}

/** How often the gap for news (and the ack priming) is looked at. Timers, not rAF: rAF stops when Forge is covered. */
const TICK_MS = 250
/** A "speech started" with no turn after this long was a noise: stop showing "hearing". */
const HEARING_STALE_MS = 15_000
/** Between tries to make the ack clips while Kokoro warms. */
const PRIME_RETRY_MS = 5_000
/** Turn ids remembered as cancelled, so a late `say` for one is dropped. */
const CANCELLED_KEPT = 50
/** A pane Forge showed while Live is off keeps its ring this long (no rail to say "done looking" from). */
const SHOW_OFF_MS = 15_000

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function liveApi(): Window['forge']['live'] | undefined {
  return typeof window === 'undefined' ? undefined : window.forge?.live
}

let turnSeq = 0
function newTurnId(): string {
  turnSeq += 1
  return `lt-${Date.now().toString(36)}-${turnSeq}`
}

const forgeTurnId = (turnId: string): string => `${turnId}:forge`

class LiveRuntime {
  private shell: Shell = INITIAL
  private readonly listeners = new Set<() => void>()
  private settings: LiveSettings | null = null
  private mouth: LiveMouth | null = null
  private ears: Ears | null = null
  private offEvents: (() => void) | null = null
  private offCard: (() => void) | null = null
  private showTimer: number | null = null
  private ticket = 0
  private tick: number | null = null
  private bargeTimer: number | null = null
  private hearingTimer: number | null = null
  private inFlight: InFlight | null = null
  private readonly clocks = new Map<string, Clock>()
  private readonly cancelled = new Set<string>()
  private readonly replyText = new Map<string, string>()
  private lines: SpokenLine[] = []
  private news: QueuedNews[] = []
  private hearing = false
  private held = false
  private heardEndAt: number | null = null
  private lastAck: string | undefined
  private primedAt = 0

  /* ----------------------------------------------------- store plumbing */

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  readonly snapshot = (): Shell => this.shell

  private patch(p: Partial<Shell>): void {
    this.shell = { ...this.shell, ...p }
    for (const cb of [...this.listeners]) cb()
  }

  private config(): VoiceConfig {
    return voiceConfigOf(this.settings ?? selectLiveSettings({ settings: {} as Settings }))
  }

  configure(settings: LiveSettings): void {
    this.settings = settings
  }

  /* ---------------------------------------------------------- lifecycle */

  /** Mounted: the ledger and status are read even while Live is off, so the UI has jobs to show. */
  attach(): void {
    this.mouth = new LiveMouth(() => this.config(), {
      onBusy: (busy) => this.onMouthBusy(busy),
      onStart: (item, at) => this.onMouthStart(item, at),
      onEnd: (item, spoke) => this.onMouthEnd(item, spoke),
      onNotice: (msg) => this.patch({ error: msg })
    })
    const live = liveApi()
    if (!live) return
    this.offEvents = live.onEvent((e) => this.onEvent(e))
    // A tap on the desktop card (shared/live-card.ts), passed back by main.
    const card = typeof window === 'undefined' ? undefined : window.forge?.liveCard
    if (typeof card?.onChoice === 'function') this.offCard = card.onChoice((a) => this.onCardChoice(a))
    void live
      .ledger()
      .then((snap) => this.patch({ jobs: snap.jobs }))
      .catch(() => undefined)
    void live
      .status()
      .then((status) => this.patch({ status }))
      .catch(() => undefined)
  }

  detach(): void {
    void this.stop()
    this.offEvents?.()
    this.offEvents = null
    this.offCard?.()
    this.offCard = null
    if (this.showTimer !== null) window.clearTimeout(this.showTimer)
    this.showTimer = null
    this.mouth?.dispose()
    this.mouth = null
  }

  async start(): Promise<void> {
    if (this.shell.running || this.shell.starting) return
    const live = liveApi()
    if (!live) {
      this.patch({ error: 'This Forge build has no Claude Live — restart Forge' })
      return
    }
    const ticket = ++this.ticket
    this.patch({ starting: true, error: undefined, startError: undefined })
    try {
      const status = await live.start()
      if (ticket !== this.ticket) return
      this.patch({ status })
      const { ears, note } = await this.openEars()
      if (ticket !== this.ticket) {
        ears.stop()
        return
      }
      this.ears = ears
      this.news = []
      this.patch({ running: true, starting: false, ears: ears.kind, error: note ?? status.error })
      this.tick = window.setInterval(() => this.onTick(), TICK_MS)
      this.primeAcks()
    } catch (err) {
      if (ticket !== this.ticket) return
      // Not `live.stop()`: that ends every Conductor job, and the ears failing is no reason to.
      this.patch({ starting: false, running: false, error: errText(err), startError: errText(err) })
    }
  }

  /**
   * Listen off: the ears and the mouth stop, nothing else. Deliberately not
   * `live.stop()`: main's stop ends every Conductor job ("Claude Live was
   * turned off"), and jobs keep running while the mic is off. Main stops the
   * brains when Forge quits (electron/live/index.ts `disposeLive`).
   */
  async stop(): Promise<void> {
    this.ticket += 1
    this.ears?.stop()
    this.ears = null
    if (this.tick !== null) window.clearInterval(this.tick)
    this.tick = null
    this.clearBarge()
    this.clearHearing()
    const turn = this.inFlight
    if (turn && !turn.ended) this.cancelTurn(turn.id)
    this.inFlight = null
    this.mouth?.cancel()
    this.news = []
    this.hearing = false
    this.patch({ running: false, starting: false, speaking: false, hearing: false, thinking: false, caption: {}, ears: undefined })
  }

  async toggle(): Promise<void> {
    if (this.shell.running || this.shell.starting) await this.stop()
    else await this.start()
  }

  /**
   * OpenAI ears when picked, keyed and wired in this build; otherwise
   * Parakeet. OpenAI failing to open falls back to Parakeet, said in words.
   */
  private async openEars(): Promise<{ ears: Ears; note?: string }> {
    const s = this.settings
    const silence = s?.agentSilenceMs ?? 800
    const handlers = this.earsHandlers()
    let note: string | undefined
    if (s?.liveEars !== 'parakeet') {
      if (!s?.hasOpenAIKey) note = 'No OpenAI key, so Live is listening with Parakeet'
      else if (!openAIEarsAvailable()) note = 'This build cannot open OpenAI ears yet, so Live is listening with Parakeet'
      else {
        const openai = new OpenAIEars()
        try {
          await openai.start(handlers)
          return { ears: openai }
        } catch (err) {
          openai.stop()
          note = `OpenAI ears could not start (${errText(err)}), so Live is listening with Parakeet`
        }
      }
    }
    const parakeet = new ParakeetEars(silence)
    await parakeet.start(handlers)
    return note ? { ears: parakeet, note } : { ears: parakeet }
  }

  private earsHandlers(): EarsHandlers {
    return {
      onSpeechStart: () => this.onSpeechStart(),
      onPartial: (text) => {
        if (!this.held) this.patch({ caption: { ...this.shell.caption, you: text || undefined } })
      },
      onTurn: (text, eosAt) => this.onHeard(text, eosAt),
      onError: (message) => this.patch({ error: message }),
      onMaybeSpeech: (ducked) => this.mouth?.duck(ducked ? BARGE_DUCK_LEVEL : 1)
    }
  }

  /* ------------------------------------------------------------ hearing */

  private clearBarge(): void {
    if (this.bargeTimer !== null) window.clearTimeout(this.bargeTimer)
    this.bargeTimer = null
  }

  private clearHearing(): void {
    if (this.hearingTimer !== null) window.clearTimeout(this.hearingTimer)
    this.hearingTimer = null
  }

  /** He started talking. Over Forge, that is barge-in: duck now, stop in 150 ms. */
  private onSpeechStart(): void {
    if (!this.shell.running || this.held) return
    this.hearing = true
    this.clearHearing()
    this.hearingTimer = window.setTimeout(() => {
      this.hearing = false
      this.patch({ hearing: false })
    }, HEARING_STALE_MS)
    this.patch({ hearing: true })
    const mouth = this.mouth
    if (!mouth?.active || this.bargeTimer !== null) return
    mouth.duck(BARGE_DUCK_LEVEL)
    this.bargeTimer = window.setTimeout(() => {
      this.bargeTimer = null
      this.interrupt()
    }, BARGE_STOP_MS)
  }

  /** Stop the speech, and the reply it belongs to if that is still being written. Jobs are not touched. */
  interrupt(): void {
    const saying = this.mouth?.saying
    this.mouth?.cancel()
    const turn = this.inFlight
    if (turn && !turn.ended) this.cancelTurn(turn.id)
    else if (saying?.turnId) this.finishForgeTurn(saying.turnId)
  }

  /** A finished turn from the ears. */
  private onHeard(text: string, eosAt: number): void {
    const now = Date.now()
    this.hearing = false
    this.heardEndAt = now
    this.clearHearing()
    this.patch({ hearing: false, caption: { ...this.shell.caption, you: undefined } })
    if (!this.shell.running || this.held) return
    // Forge's own words through the speakers: never a turn.
    if (isEcho(text, this.lines, now) || speaker.heardItself(text, now)) return
    const prev = this.inFlight
    let parts = [text]
    if (prev && !prev.ended) {
      if (joinsTurnInFlight({ voiced: prev.voiced, sinceSent: now - prev.sentAt, answering: prev.answering }, true)) {
        // The rest of the sentence in flight: one turn, sent again whole.
        // Its latency is the joined turn's, not a sample of its own.
        parts = [...prev.parts, text]
        this.clocks.delete(prev.id)
        this.cancelTurn(prev.id)
        this.patch({ turns: this.shell.turns.filter((t) => t.id !== prev.id && t.id !== forgeTurnId(prev.id)) })
      } else {
        this.cancelTurn(prev.id)
      }
    }
    void this.ask(parts, { eosAt, voiced: true })
  }

  /* -------------------------------------------------------------- turns */

  private async ask(parts: string[], opts: { eosAt?: number; voiced: boolean; typed?: boolean }): Promise<void> {
    const live = liveApi()
    const text = joinPhrases(parts)
    if (!live || !text) return
    const id = newTurnId()
    const sentAt = Date.now()
    this.inFlight = { id, parts, sentAt, voiced: opts.voiced, answering: false, ended: false }
    const clock: Clock = { turnId: id, sentAt, ack: false, acked: false, ended: false, logged: false }
    if (opts.eosAt !== undefined) clock.eosAt = opts.eosAt
    this.clocks.set(id, clock)
    this.patch({
      thinking: true,
      turns: upsertTurn(this.shell.turns, { id, who: 'you', text, at: sentAt, final: true })
    })
    if (opts.eosAt !== undefined) {
      const wait = Math.max(0, opts.eosAt + ACK_AFTER_MS - Date.now())
      window.setTimeout(() => this.maybeAck(id), wait)
    }
    try {
      await live.ask(id, text, opts.typed ? { typed: true } : undefined)
    } catch (err) {
      this.onTurnEnd(id, false, errText(err))
    }
  }

  private maybeAck(turnId: string): void {
    const c = this.clocks.get(turnId)
    const mouth = this.mouth
    if (!c || c.eosAt === undefined || !mouth || !this.shell.running || this.cancelled.has(turnId) || this.hearing) return
    const ready = voiceSpeaker.readyAcks(this.config())
    if (!shouldAck({ now: Date.now(), eosAt: c.eosAt, audioStarted: c.firstAudioAt !== undefined, ready: ready.length, acked: c.acked })) return
    const line = nextAck(ready, this.lastAck)
    if (!line || !mouth.ack(turnId, line)) return
    c.acked = true
    this.lastAck = line
  }

  /** Cancel a reply: nothing more of it is said, main is told, the latency so far is logged. */
  private cancelTurn(turnId: string): void {
    this.cancelled.add(turnId)
    if (this.cancelled.size > CANCELLED_KEPT) {
      const oldest = this.cancelled.values().next().value
      if (oldest !== undefined) this.cancelled.delete(oldest)
    }
    this.mouth?.dropTurn(turnId)
    void liveApi()?.cancelTurn(turnId).catch(() => undefined)
    const c = this.clocks.get(turnId)
    if (c) c.ended = true
    this.logLatency(turnId)
    this.finishForgeTurn(turnId)
    if (this.inFlight?.id === turnId) {
      this.inFlight = null
      this.patch({ thinking: false })
    }
  }

  /** Mark Forge's turn as final, at whatever was said. */
  private finishForgeTurn(turnId: string): void {
    this.replyText.delete(turnId)
    const id = forgeTurnId(turnId)
    const turn = this.shell.turns.find((t) => t.id === id)
    if (turn && !turn.final) this.patch({ turns: upsertTurn(this.shell.turns, { ...turn, final: true }) })
  }

  private onSay(turnId: string, piece: string, final: boolean): void {
    if (this.cancelled.has(turnId)) return
    const now = Date.now()
    const c = this.clocks.get(turnId)
    if (c && c.firstTextAt === undefined) c.firstTextAt = now
    if (this.inFlight?.id === turnId) this.inFlight.answering = true
    const text = appendCaption(this.replyText.get(turnId), piece)
    this.replyText.set(turnId, text)
    const id = forgeTurnId(turnId)
    const prev = this.shell.turns.find((t) => t.id === id)
    const spokenChars = prev?.spokenChars ?? 0
    this.patch({
      turns: upsertTurn(this.shell.turns, { id, who: 'forge', text, at: prev?.at ?? now, spokenChars, final: false }),
      caption: { ...this.shell.caption, forge: text, forgeSpokenChars: spokenChars }
    })
    if (this.shell.running) {
      this.mouth?.pushReply(turnId, piece)
      if (final) this.mouth?.endReply(turnId)
    }
  }

  private onTurnEnd(turnId: string, ok: boolean, error?: string): void {
    if (this.cancelled.has(turnId)) return
    const c = this.clocks.get(turnId)
    if (c) c.ended = true
    this.mouth?.endReply(turnId)
    const saidNothing = !this.replyText.get(turnId)?.trim()
    this.finishForgeTurn(turnId)
    if (this.inFlight?.id === turnId) {
      this.inFlight = null
      this.patch({ thinking: false })
    }
    if (!ok) {
      this.patch({ error: error || 'That turn failed' })
      // Never dead air: a turn that failed before saying a word says so.
      if (saidNothing && this.shell.running) this.mouth?.say("Sorry, that didn't work.")
    }
    if (!this.mouth?.holds(turnId)) this.logLatency(turnId)
  }

  private logLatency(turnId: string): void {
    const c = this.clocks.get(turnId)
    if (!c || c.logged) return
    c.logged = true
    this.clocks.delete(turnId)
    const sample = buildLatencySample(c)
    if (sample) liveApi()?.logLatency(sample)
  }

  /* -------------------------------------------------------------- mouth */

  private onMouthBusy(busy: boolean): void {
    this.ears?.setSpeaking(busy)
    if (!busy) this.lines = endLines(this.lines, Date.now())
    this.patch({ speaking: busy })
  }

  private onMouthStart(item: MouthItem, at: number): void {
    this.lines = rememberLine(endLines(this.lines, at), item.text)
    const turnId = item.turnId
    if (!turnId) return
    const c = this.clocks.get(turnId)
    if (c) {
      if (c.firstAudioAt === undefined) {
        c.firstAudioAt = at
        c.ack = item.kind === 'ack'
      }
      if (item.kind === 'reply' && c.firstReplyAudioAt === undefined) {
        c.firstReplyAudioAt = at
        // Every part of the sample is known once the reply itself is heard.
        this.logLatency(turnId)
      }
    }
    if (item.kind !== 'reply' || item.endChar === undefined) return
    const id = forgeTurnId(turnId)
    const turn = this.shell.turns.find((t) => t.id === id)
    if (!turn) return
    this.patch({
      turns: upsertTurn(this.shell.turns, { ...turn, spokenChars: item.endChar }),
      caption: { ...this.shell.caption, forgeSpokenChars: item.endChar }
    })
  }

  private onMouthEnd(item: MouthItem, _spoke: boolean): void {
    this.lines = endLines(this.lines, Date.now())
    const turnId = item.turnId
    if (!turnId || this.mouth?.holds(turnId)) return
    const c = this.clocks.get(turnId)
    if (c?.ended) this.logLatency(turnId)
  }

  /* --------------------------------------------------------------- news */

  private onTick(): void {
    const mouth = this.mouth
    if (!this.shell.running || !mouth) return
    const now = Date.now()
    const busy = !!this.inFlight && !this.inFlight.ended
    if (this.news.length && newsGapOpen({ now, hearing: this.hearing, heardEndAt: this.heardEndAt, speaking: mouth.active, turnBusy: busy })) {
      const next = takeNews(this.news)
      if (next) {
        this.news = next.rest
        mouth.say(next.say)
        this.patch({ turns: upsertTurn(this.shell.turns, { id: `news:${next.ids[0]}`, who: 'forge', text: next.say, at: now, final: true }) })
      }
    }
    if (!mouth.active && !busy && !this.hearing && now - this.primedAt >= PRIME_RETRY_MS) this.primeAcks()
  }

  /** Make the ack clips in Kokoro while nothing is being said (main's Kokoro queue is serial). */
  private primeAcks(): void {
    const config = this.config()
    if (voiceSpeaker.readyAcks(config).length >= ACK_LINES.length) return
    this.primedAt = Date.now()
    void voiceSpeaker.primeAcks(config)
  }

  /* ------------------------------------------------------------- events */

  private onEvent(e: LiveEvent): void {
    switch (e.type) {
      case 'say':
        this.onSay(e.turnId, e.text, e.final)
        return
      case 'turn-end':
        this.onTurnEnd(e.turnId, e.ok, e.error)
        return
      case 'news':
        // The desktop card first: main shows it only while Forge is away, Listen on or off.
        this.offerCard(e)
        if (!this.shell.running) return
        this.news = queueNews(this.news, { id: e.id, jobId: e.jobId, text: e.text, urgency: e.urgency, at: Date.now() })
        return
      case 'ledger':
        this.patch({ jobs: e.snapshot.jobs })
        return
      case 'show':
        this.onShow(e.target, e.note)
        return
      case 'status':
        this.patch({ status: e.status })
        return
    }
  }

  setHeld(held: boolean): void {
    if (held === this.held) return
    this.held = held
    if (held && this.shell.caption.you) this.patch({ caption: { ...this.shell.caption, you: undefined } })
  }

  /* ------------------------------------------------------ show and card */

  /**
   * "Show me": the pane is lifted (project, tab, agents view, Forge back on
   * screen, keyboard in) and ringed. With Live off there is no rail to say
   * "done looking" from, so the ring goes by itself after SHOW_OFF_MS.
   */
  private onShow(target: Extract<LiveEvent, { type: 'show' }>['target'], note?: string): void {
    if (target.kind === 'view') {
      void import('@/lib/showView').then(({ runShowView }) => runShowView({ view: target.view })).catch(() => undefined)
      return
    }
    const showing: LiveShowing = note ? { paneId: target.paneId, note } : { paneId: target.paneId }
    this.patch({ showing })
    void showPaneById(target.paneId).then((ok) => {
      if (!ok) this.patch({ error: 'That pane is not open any more' })
    })
    if (this.showTimer !== null) window.clearTimeout(this.showTimer)
    this.showTimer = null
    if (this.shell.running) return
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null
      if (!this.shell.running && this.shell.showing === showing) this.patch({ showing: null })
    }, SHOW_OFF_MS)
  }

  private offerCard(e: Extract<LiveEvent, { type: 'news' }>): void {
    const card = typeof window === 'undefined' ? undefined : window.forge?.liveCard
    if (typeof card?.offer !== 'function') return
    const offer = liveCardFor(e, this.shell.jobs)
    if (offer) card.offer(offer)
  }

  /** A tap on the desktop card: what the rail's flyout does for the same button. */
  private onCardChoice(a: LiveCardAnswer): void {
    if (!a || !a.jobId) return
    if (a.choice === 'push') {
      const job = this.shell.jobs.find((j) => j.id === a.jobId)
      void this.sendTyped(livePushLine(liveCardWho(job)))
    } else if (a.choice === 'show') {
      void this.jobAction(a.jobId, 'show')
    }
  }

  /* ------------------------------------------------------------ actions */

  async sendTyped(text: string): Promise<void> {
    const said = text.trim()
    if (!said) return
    const prev = this.inFlight
    if (prev && !prev.ended) this.cancelTurn(prev.id)
    await this.ask([said], { voiced: false, typed: true })
  }

  async jobAction(id: string, action: 'stop' | 'show'): Promise<void> {
    const live = liveApi()
    if (!live) return
    try {
      const result = await live.jobAction(id, action)
      if (!result.ok) this.patch({ error: result.error || `Could not ${action} that job` })
    } catch (err) {
      this.patch({ error: errText(err) })
    }
  }
}

/* ------------------------------------------------------------------ React */

type LiveActions = Pick<LiveControllerView, 'start' | 'stop' | 'toggle' | 'sendTyped' | 'stopJob' | 'showJob' | 'interrupt' | 'setHeld'>

interface LiveCtx {
  runtime: LiveRuntime
  actions: LiveActions
}

const LiveContext = createContext<LiveCtx | null>(null)

export function LiveControllerProvider({ children }: { children: ReactNode }): ReactNode {
  const [runtime] = useState(() => new LiveRuntime())
  const settings = useAppSelector(selectLiveSettings, shallowEqual)
  useEffect(() => {
    runtime.configure(settings)
  }, [runtime, settings])
  useEffect(() => {
    runtime.attach()
    return () => runtime.detach()
  }, [runtime])
  const ctx = useMemo<LiveCtx>(
    () => ({
      runtime,
      actions: {
        start: () => runtime.start(),
        stop: () => runtime.stop(),
        toggle: () => runtime.toggle(),
        sendTyped: (text) => runtime.sendTyped(text),
        stopJob: (id) => runtime.jobAction(id, 'stop'),
        showJob: (id) => runtime.jobAction(id, 'show'),
        interrupt: () => runtime.interrupt(),
        setHeld: (held) => runtime.setHeld(held)
      }
    }),
    [runtime]
  )
  return <LiveContext.Provider value={ctx}>{children}</LiveContext.Provider>
}

/** What the voice bar's engine needs of Live: the phase and the controls, without the captions. */
export interface LiveControls extends LiveActions {
  phase: LivePhase
  startError?: string
  ears?: EarsKind
}

/**
 * Live for the voice bar's engine (src/state/VoiceHubController.tsx): only
 * the phase, the start error and the ears, so a caption delta does not
 * re-render the hub. Must be inside <LiveControllerProvider>.
 */
export function useLiveControls(): LiveControls {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLiveControls must be used inside <LiveControllerProvider>')
  const { runtime, actions } = ctx
  const phase = useSyncExternalStore(runtime.subscribe, () => livePhase(runtime.snapshot()))
  const startError = useSyncExternalStore(runtime.subscribe, () => runtime.snapshot().startError)
  const ears = useSyncExternalStore(runtime.subscribe, () => runtime.snapshot().ears)
  return useMemo<LiveControls>(() => {
    const out: LiveControls = { phase, ...actions }
    if (startError) out.startError = startError
    if (ears) out.ears = ears
    return out
  }, [phase, startError, ears, actions])
}

/** Claude Live's view. Must be inside <LiveControllerProvider>. */
export function useLive(): LiveControllerView {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used inside <LiveControllerProvider>')
  const { runtime, actions } = ctx
  const shell = useSyncExternalStore(runtime.subscribe, runtime.snapshot)
  return useMemo<LiveControllerView>(() => {
    const jobs = jobsView(shell.jobs)
    const phase: LivePhase = livePhase(shell)
    const view: LiveControllerView = {
      phase,
      working: jobs.working,
      turns: shell.turns,
      caption: shell.caption,
      jobs: shell.jobs,
      needsYou: jobs.needsYou,
      showing: shell.showing,
      ...actions
    }
    if (jobs.now) view.now = jobs.now
    if (shell.status) view.status = shell.status
    if (shell.error) view.error = shell.error
    if (shell.ears) view.ears = shell.ears
    if (shell.startError) view.startError = shell.startError
    return view
  }, [shell, actions])
}

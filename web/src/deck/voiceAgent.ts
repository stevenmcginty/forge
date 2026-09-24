import { useSyncExternalStore } from 'react'
import type { WebRequest, WebResult, WebVoiceSetup } from '@shared/web'
import { endedNote, stopPhraseOf, stuckAfterMs, stuckReason, type ConversationEnd } from '@/lib/realtime/conversation'
import { GeminiLiveSession, type GeminiTokenGetter } from '@/lib/realtime/gemini'
import type { RealtimeCaption, RealtimeState, RealtimeToolAnswer, RealtimeToolCall } from '@/lib/realtime/session'
import { buildRolloverSummary } from '@/lib/realtime/summary'
import { toolLabel } from '@/lib/toolLabels'
import { voiceFailureWords, type WebVoicePhase } from './voice-words'

/**
 * Listen, on the deck face: the desktop's main voice agent, run in this
 * browser.
 *
 * The session is the voice hub's own `GeminiLiveSession` (src/lib/realtime/
 * gemini.ts), not a copy: this page's microphone and speakers, Gemini's server
 * VAD, so it is hands-free — a pause sends the turn, the reply is spoken, it
 * listens again by itself, and talking over it is barge-in. What makes it the
 * SAME agent comes from the desktop over the Forge Web socket:
 *
 *   voice-setup    persona, voice, tools and app context, built by the desktop
 *                  renderer with the functions the voice hub uses
 *   voice-token    a single-use ephemeral token per connect (the key stays in
 *                  the desktop's main process)
 *   voice-tool     each tool call, run there by the same `runRealtimeTool`
 *   voice-context  polled while live; a change is told to the model, at most
 *                  every `contextMinGapMs` — ContextTracker's rule
 *
 * The conversation ends the way the desk's does (src/state/VoiceHubController
 * .tsx): "that's all" / "stop listening", a second press, or `idleTimeoutMs`
 * listening to quiet; Connecting… or Thinking… that never moves on is ended by
 * the same watchdog. A session Gemini cannot resume rolls over into a new one
 * carrying a short summary. An older desktop answers "does not understand",
 * and the switch says to update it.
 *
 * A module store, like ./dictation.ts, so the session outlives the switch
 * moving between the top bar and the dock. DeckKeys (./VoiceBar.tsx) owns its
 * lifetime: leaving the deck face stops it.
 */

export interface VoiceLink {
  request: (body: WebRequest) => Promise<WebResult>
}

export interface WebVoiceState {
  phase: WebVoicePhase
  /** One line: why it failed. Set only in `error`. */
  error: string | null
  /** Why the last conversation ended, until the next one opens. */
  ended: string | null
  /** The mic is held shut (D is recording). */
  muted: boolean
  /** The newest caption, for the bar's voice line: who spoke and what, as it grows. */
  caption: { role: 'user' | 'assistant'; text: string } | null
  /** The newest tool call in words ("Opening tabs", then what it said), until the next conversation. */
  lastAction: { label: string; status: 'running' | 'ok' | 'failed' } | null
}

const PROVIDER = 'gemini-live' as const
const LABEL = 'Gemini Live'
const CONTEXT_POLL_MS = 5000
const MAX_CAPTIONS = 40
const MAX_ACTIONS = 20

let state: WebVoiceState = { phase: 'off', error: null, ended: null, muted: false, caption: null, lastAction: null }
const listeners = new Set<() => void>()

/**
 * What the bar shows beside the phase: the newest caption and tool call.
 * Display only. It tells the listeners and nothing else, so a caption never
 * re-arms the idle clock or the watchdog the way `set` does.
 */
function show(patch: Pick<Partial<WebVoiceState>, 'caption' | 'lastAction'>): void {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

function set(patch: Partial<WebVoiceState>): void {
  const next = { ...state, ...patch }
  if (
    next.phase === state.phase &&
    next.error === state.error &&
    next.ended === state.ended &&
    next.muted === state.muted
  ) {
    return
  }
  state = next
  listeners.forEach((fn) => fn())
  onPhase()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useWebVoice(): WebVoiceState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/** The page can run it at all: a secure page with a microphone and AudioWorklet. */
export function webVoiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined'
  )
}

/* ---------------------------------------------------------------- session */

let link: VoiceLink | null = null
let session: GeminiLiveSession | null = null
/** Bumped by every start and stop, so a late answer for an old session lands nowhere. */
let run = 0
let rolling = false
let setup: WebVoiceSetup | null = null
let captions: RealtimeCaption[] = []
let actions: Array<{ label: string; status: 'running' | 'ok' | 'failed' }> = []
let toolsRunning = 0
let lastContext = ''
let lastContextAt = 0
let contextTimer: number | null = null
let idleTimer: number | null = null
let stuckTimer: number | null = null
let stopTimer: number | null = null

/** DeckKeys hands over the current link whenever it changes: a reconnect may replace it. */
export function setVoiceLink(next: VoiceLink | null): void {
  link = next
}

async function ask(body: WebRequest): Promise<WebResult> {
  if (!link) return { kind: 'failed', code: 'no-window', message: 'Not connected to the desktop.' }
  return link.request(body)
}

function clearTimer(t: number | null): null {
  if (t !== null) window.clearTimeout(t)
  return null
}

function clearTimers(): void {
  if (contextTimer !== null) window.clearInterval(contextTimer)
  contextTimer = null
  idleTimer = clearTimer(idleTimer)
  stuckTimer = clearTimer(stuckTimer)
  stopTimer = clearTimer(stopTimer)
}

/** A changed context, at most every `contextMinGapMs` — ContextTracker.take's rule. */
function takeContext(text: string, now: number, minGapMs: number): string | null {
  if (!text || text === lastContext) return null
  if (minGapMs && now - lastContextAt < minGapMs) return null
  lastContext = text
  lastContextAt = now
  return text
}

/* The idle clock and the watchdog, re-armed on every phase change. */
function onPhase(): void {
  stuckTimer = clearTimer(stuckTimer)
  const live = session
  if (!live) {
    idleTimer = clearTimer(idleTimer)
    return
  }
  const ms = stuckAfterMs({ phase: state.phase, toolRunning: toolsRunning > 0 })
  if (ms !== null) {
    const stuck = state.phase === 'connecting' ? 'connecting' : 'thinking'
    stuckTimer = window.setTimeout(() => {
      if (session !== live) return
      fail(stuckReason(LABEL, stuck, ms))
    }, ms)
  }
  if (state.phase === 'listening') armIdle()
  else idleTimer = clearTimer(idleTimer)
}

/** Quiet while listening for `idleTimeoutMs` ends the conversation. Anything he says restarts it. */
function armIdle(): void {
  idleTimer = clearTimer(idleTimer)
  const ms = setup?.idleTimeoutMs
  if (!ms || !session || state.phase !== 'listening') return
  idleTimer = window.setTimeout(() => endConversation({ kind: 'idle', ms }), ms)
}

function upsertCaption(c: RealtimeCaption): void {
  const i = captions.findIndex((x) => x.id === c.id)
  captions = i >= 0 ? captions.map((x, j) => (j === i ? c : x)) : [...captions, c].slice(-MAX_CAPTIONS)
  const text = c.text.trim()
  if (text) show({ caption: { role: c.role, text } })
}

/** A tool's name while it runs, as words: "Opening tabs". */
function runningWords(name: string): string {
  return toolLabel(name).replace(/^./, (ch) => ch.toUpperCase())
}

/** A tool's answer as words: its first line, without the OK:/FAILED: marker. */
function answerWords(name: string, answer: RealtimeToolAnswer): string {
  const first = (answer.text.split('\n')[0] ?? '').replace(/^(OK|FAILED):\s*/, '').trim()
  if (first) return first
  return answer.ok ? runningWords(name) : `${runningWords(name)} failed`
}

/** VoiceHubController's `onUserCaption`: a stop phrase ends it; one still growing waits a beat. */
function onUserCaption(c: RealtimeCaption): void {
  stopTimer = clearTimer(stopTimer)
  if (state.phase === 'listening') armIdle()
  const stop = stopPhraseOf(c.text)
  if (!stop) return
  if (c.final) {
    endConversation({ kind: 'phrase', phrase: stop })
    return
  }
  stopTimer = window.setTimeout(() => {
    stopTimer = null
    endConversation({ kind: 'phrase', phrase: stop })
  }, 700)
}

/** One tool call, run on the desktop. A failure is an answer the model can say. */
async function relayTool(call: RealtimeToolCall): Promise<RealtimeToolAnswer> {
  const entry = { label: call.name, status: 'running' as 'running' | 'ok' | 'failed' }
  actions = [...actions, entry].slice(-MAX_ACTIONS)
  toolsRunning++
  onPhase()
  show({ lastAction: { label: runningWords(call.name), status: 'running' } })
  try {
    const res = await ask({ kind: 'voice-tool', name: call.name, args: call.args })
    const answer: RealtimeToolAnswer =
      res.kind === 'voice-tool'
        ? res.answer
        : res.kind === 'failed'
          ? { ok: false, text: `FAILED: ${voiceFailureWords(res)}` }
          : { ok: false, text: 'FAILED: the desktop answered with something this page does not understand.' }
    entry.label = `${call.name}: ${answer.text.split('\n')[0]}`
    entry.status = answer.ok ? 'ok' : 'failed'
    // Only the newest call speaks for the bar: an older one finishing late does not.
    if (actions[actions.length - 1] === entry) {
      show({ lastAction: { label: answerWords(call.name, answer), status: entry.status } })
    }
    return answer
  } finally {
    toolsRunning--
    onPhase()
  }
}

const getToken: GeminiTokenGetter = async () => {
  const res = await ask({ kind: 'voice-token', provider: PROVIDER })
  if (res.kind === 'voice-token') return { ok: true, token: res.token, expiresAt: res.expiresAt }
  if (res.kind === 'failed') return { ok: false, error: voiceFailureWords(res) }
  return { ok: false, error: 'The desktop answered with something this page does not understand.' }
}

function fromState(st: RealtimeState): WebVoicePhase {
  return st === 'closed' ? 'off' : st
}

/** Close whatever is live, and every clock with it. */
function teardown(): void {
  const old = session
  session = null
  clearTimers()
  old?.stop()
}

function fail(reason: string): void {
  run++
  teardown()
  set({ phase: 'error', error: reason })
}

async function open(carryover: string | null): Promise<void> {
  const mine = ++run
  set({ phase: 'connecting', error: null, ended: null })
  const res = await ask({ kind: 'voice-setup', provider: PROVIDER, ...(carryover ? { carryover } : {}) })
  if (mine !== run) return
  if (res.kind !== 'voice-setup') {
    set({
      phase: 'error',
      error:
        res.kind === 'failed' ? voiceFailureWords(res) : 'The desktop answered with something this page does not understand.'
    })
    return
  }
  setup = res.setup
  const live: GeminiLiveSession = new GeminiLiveSession({
    provider: PROVIDER,
    model: res.setup.model,
    voice: res.setup.voice,
    instructions: res.setup.instructions,
    tools: res.setup.tools,
    getToken,
    events: {
      onState: (st, detail) => {
        if (session !== live) return
        if (st === 'closed') {
          if (!rolling) set({ phase: 'off' })
          return
        }
        set(st === 'error' && detail ? { phase: 'error', error: detail } : { phase: fromState(st) })
      },
      onCaption: (c) => {
        if (session !== live) return
        upsertCaption(c)
        if (c.role === 'user') onUserCaption(c)
      },
      // A session that is no longer the one the switch shows runs nothing (V1).
      onToolCall: (call) =>
        session === live ? relayTool(call) : Promise.resolve({ ok: false, text: 'This voice session has ended; nothing was done.' }),
      onExpiring: (reason) => {
        if (session === live) void rollover(reason)
      }
    }
  })
  session = live
  // The watchdog runs from here: a socket that never sets up must not sit on Connecting.
  onPhase()
  try {
    await live.start()
    // Listen went off (or a newer start began) while this one was starting.
    if (mine !== run || session !== live) {
      live.stop()
      return
    }
    live.setMuted(state.muted)
    // What is open on the desktop right now, before his first word.
    lastContext = ''
    lastContextAt = 0
    const first = takeContext(res.setup.context, Date.now(), 0)
    if (first) live.sendContext(first, false)
    contextTimer = window.setInterval(() => void pollContext(live), CONTEXT_POLL_MS)
    onPhase()
  } catch (err) {
    live.stop()
    if (mine !== run || session !== live) return
    session = null
    clearTimers()
    set({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

async function pollContext(live: GeminiLiveSession): Promise<void> {
  const res = await ask({ kind: 'voice-context' })
  if (session !== live || res.kind !== 'voice-context') return
  const fresh = takeContext(res.text, Date.now(), setup?.contextMinGapMs ?? 0)
  if (fresh) live.sendContext(fresh, false)
}

/** Gemini could not resume: a new session, carrying a short account of this one. */
async function rollover(reason: string): Promise<void> {
  if (!session || rolling) return
  rolling = true
  const summary = buildRolloverSummary(captions, actions)
  teardown()
  try {
    await open(summary || null)
  } catch (err) {
    set({ phase: 'error', error: `Voice session ended: ${reason} (${err instanceof Error ? err.message : String(err)})` })
  } finally {
    rolling = false
  }
}

/** The conversation closes, and says why. */
function endConversation(end: ConversationEnd): void {
  run++
  teardown()
  show({ caption: null })
  set({ phase: 'off', error: null, ended: endedNote(end) })
}

/* -------------------------------------------------------------- the API */

export function startWebVoice(): void {
  if (session || state.phase === 'connecting') return
  captions = []
  actions = []
  show({ caption: null, lastAction: null })
  void open(null)
}

/** Listen pressed off, or the deck face left. */
export function stopWebVoice(): void {
  if (!session && state.phase !== 'connecting' && state.phase !== 'error') return
  if (state.phase === 'error' && !session) {
    set({ phase: 'off', error: null })
    return
  }
  endConversation({ kind: 'press' })
}

export function toggleWebVoice(): void {
  if (state.phase === 'off' || state.phase === 'error') startWebVoice()
  else stopWebVoice()
}

/** Hold the mic shut while D records, so the model does not hear the dictation (V5). */
export function holdWebVoiceMic(held: boolean): void {
  if (state.muted === held) return
  session?.setMuted(held)
  set({ muted: held })
}

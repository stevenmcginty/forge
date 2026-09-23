import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { OPENAI_SESSION_LIMIT_MS, providerSpec, resolveVoice } from '@shared/realtime'
import { agentBrainSpec, isRealtimeBrain as isRealtimeBrainId, migrateAgentBrain, type AgentBrainId } from '@shared/agent-brain'
import type { VoiceHubProvider } from '@shared/types'
import { CONTEXT_MIN_GAP_MS, ContextTracker } from '@/lib/realtime/context'
import {
  endedNote,
  idleRemainingMs,
  normaliseIdleTimeout,
  stopPhraseOf,
  type ConversationEnd
} from '@/lib/realtime/conversation'
import { dictateToPane } from '@/lib/realtime/dictate'
import { errorReasonOf, type ErrorSource } from '@/lib/realtime/errors'
import { micState } from '@/lib/realtime/micstate'
import { currentVoiceAgentToolDeps } from '@/lib/agenttools'
import { buildStateSection } from '@/lib/appmanifest'
import {
  DISCUSSION_REFUSAL,
  discussionGate,
  discussionNote,
  isGoCommand,
  planRanNote,
  type PlannedCall
} from '@/lib/realtime/discussion'
import { GeminiLiveSession } from '@/lib/realtime/gemini'
import { OpenAIRealtimeSession } from '@/lib/realtime/openai'
import { buildRealtimeInstructions } from '@/lib/realtime/persona'
import { providerAvailability, resolveAgentBrain } from '@/lib/realtime/provider'
import type {
  RealtimeCaption,
  RealtimeProviderId,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeState,
  RealtimeToolAnswer,
  RealtimeToolCall
} from '@/lib/realtime/session'
import { buildRolloverSummary } from '@/lib/realtime/summary'
import { REALTIME_TOOLS, realtimeResultLabel, realtimeToolLabel, runRealtimeTool } from '@/lib/realtime/tools'
import { useApp } from './AppState'
import { useVoiceAgent, type AgentPhase } from './VoiceAgent'

/**
 * The voice hub's engine: one controller, one hook, whichever brain is on.
 *
 * Two paths, kept apart, and this file only picks between them:
 *
 *  - **Realtime** (Gemini Live, GPT Realtime, GPT Realtime mini): a live
 *    two-way audio session from src/lib/realtime/, bring-your-own-key. Tools
 *    are answered in the renderer by src/lib/realtime/tools.ts, which goes
 *    through the same implementations the Claude brain uses.
 *  - **Claude** (the default, and the fallback when the chosen provider has
 *    no key): the existing VoiceAgent — Parakeet in, the Claude Agent SDK
 *    brain, Edge TTS out — driven through its own context, untouched.
 *
 * The UI reads one API either way: `useVoiceHubController()`. The shape is
 * written up for the designers in the B1 API note; the short version is
 * phase, captions, recent actions, levels, and start/stop/mute/interrupt/ask.
 *
 * While a realtime session is live the VoiceAgent is disarmed, so Parakeet's
 * "hey Jarvis" wake mode cannot fire a second brain at the same sentence. It
 * is NOT re-armed when the live session ends (B11): one Listen switch, one
 * conversation, and "off" means the microphone is off — not quietly handed to
 * a different brain the switch no longer shows. The dictation hotkey is not
 * touched — it never went through the agent.
 *
 * The conversation (B11) is the same on every brain: one press opens it, end
 * of speech sends, the reply is spoken, the mic re-opens by itself, and it
 * closes on "that's all" / "stop listening", a second press, or
 * `agentIdleTimeoutMs` of quiet (src/lib/realtime/conversation.ts). The words
 * for all of it — "Listening again", "Conversation ended — …" — are listenNote.
 */

export type HubPhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface HubCaption {
  id: string
  role: 'user' | 'assistant'
  text: string
  final: boolean
  at: number
}

export interface HubAction {
  id: string
  tool: string
  label: string
  /** `planned`: kept by discussion mode, runs when he says go. */
  status: 'running' | 'ok' | 'failed' | 'planned'
  detail?: string
  at: number
}

export interface VoiceHubController {
  phase: HubPhase
  /** The brain actually in use (a missing key means 'claude'). */
  provider: VoiceHubProvider
  requestedProvider: VoiceHubProvider
  fallbackReason: string | null
  realtime: boolean
  availability: Record<VoiceHubProvider, boolean>
  error: string | null
  muted: boolean
  captions: HubCaption[]
  actions: HubAction[]
  sessionStartedAt: number | null
  sessionLimitMs: number | null
  notice: string | null
  /**
   * Hands-free: no key to hold. Always true on a realtime provider (server
   * VAD is on for the whole session); on Claude it is the wake word setting.
   */
  handsFree: boolean
  setHandsFree(on: boolean): void
  /**
   * Discussion mode: talk and plan, run nothing that changes Forge until "go".
   * Realtime only — `discussionAvailable` is false on the Claude path.
   */
  discussionMode: boolean
  discussionAvailable: boolean
  setDiscussionMode(on: boolean): void
  /** Run the kept plan now — the same as him saying "go". */
  go(): void
  /** 0–1 each. Call from requestAnimationFrame; never re-renders. */
  readLevels(): { mic: number; out: number }
  start(): void
  stop(): void
  toggle(): void
  setMuted(muted: boolean): void
  interrupt(): void
  /** Alias of `ask(text, { via: 'typed' })`, kept for older callers. */
  askText(text: string): void

  /* ------------------------------------------------ the main agent (B7) */
  /** The ONE Agent brain setting, after the no-key fallback; and its name. */
  brain: AgentBrainId
  brainLabel: string
  /**
   * One turn for the main agent. Realtime: into the live session (opened if
   * off). Parakeet brains: VoiceAgent's pipeline. `via: 'voice'` is a finished
   * Parakeet phrase — do not also put it on the transcript bus.
   */
  ask(text: string, opts?: { via?: 'typed' | 'voice' }): void
  /** Raw text into one pane, no brain. Multi-line is pasted; `submit` presses Enter. */
  dictateTo(paneId: string, text: string, opts?: { submit?: boolean }): Promise<{ ok: boolean; summary: string }>
  /** The recogniser (or the live session) is really recording right now. */
  capturing: boolean
  /** Asked to listen, not recording yet — show "Starting…". Capture follows by itself. */
  starting: boolean
  /**
   * The mic state in words: Listening, Listening again (the first listen after
   * a reply, B11), Starting…, Thinking…, Speaking, Waiting for "Hey Jarvis",
   * Mic on · not recording, Muted, Off, "Conversation ended — <why>", or the
   * error reason.
   */
  listenNote: string
  /** Short words for the pill: "Gemini: key refused". Full text is `error`. */
  errorReason: string | null
}

const MAX_CAPTIONS = 40
const MAX_ACTIONS = 20
const NOTICE_MS = 6000

let actionSeq = 0
const actionId = (): string => `a${Date.now().toString(36)}-${++actionSeq}`

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fromAgentPhase(phase: AgentPhase, armed: boolean): HubPhase {
  switch (phase) {
    case 'off':
      return 'off'
    case 'warming':
      return 'connecting'
    case 'replied':
      return 'listening'
    case 'error':
      // A failed turn is an amber blip inside a conversation that is still
      // open (VoiceAgent says the failure out loud and keeps listening), so
      // the Listen switch must not flick off for it. The reason still shows:
      // errorReason / listenNote carry the turn's error.
      return armed ? 'listening' : 'off'
    default:
      return phase
  }
}

function fromRealtimeState(state: RealtimeState): HubPhase {
  return state === 'closed' ? 'off' : state
}

function createSession(
  provider: RealtimeProviderId,
  opts: Omit<RealtimeSessionOptions, 'provider'>
): RealtimeSession {
  return provider === 'gemini-live'
    ? new GeminiLiveSession({ ...opts, provider })
    : new OpenAIRealtimeSession({ ...opts, provider })
}

const VoiceHubContext = createContext<VoiceHubController | null>(null)

export function VoiceHubControllerProvider({ children }: { children: ReactNode }): ReactNode {
  const { state, actions: app } = useApp()
  const agent = useVoiceAgent()
  const s = state.settings

  // The ONE setting. A settings.json from before it existed migrates the way
  // main does (shared/agent-brain.ts), so the first render already agrees.
  const requestedBrain: AgentBrainId = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const pickedBrain = resolveAgentBrain(requestedBrain, s)
  const resolved: { provider: VoiceHubProvider; fallbackReason: string | null } = {
    provider: pickedBrain.realtime ?? 'claude',
    fallbackReason: pickedBrain.fallbackReason
  }
  const availability = useMemo(
    () => providerAvailability({ geminiKey: s.geminiKey, openaiKey: s.openaiKey }),
    [s.geminiKey, s.openaiKey]
  )

  /* -------------------------------------------------------- realtime state */

  const sessionRef = useRef<RealtimeSession | null>(null)
  const [liveProvider, setLiveProvider] = useState<RealtimeProviderId | null>(null)
  const [rtPhase, setRtPhase] = useState<HubPhase>('off')
  const [rtError, setRtError] = useState<string | null>(null)
  const [muted, setMutedState] = useState(false)
  const mutedRef = useRef(false)
  const [captions, setCaptions] = useState<HubCaption[]>([])
  const captionsRef = useRef<HubCaption[]>([])
  const [rtActions, setRtActions] = useState<HubAction[]>([])
  const actionsRef = useRef<HubAction[]>([])
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null)
  const [notice, setNoticeState] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const [discussionMode, setDiscussionState] = useState(false)
  const discussionRef = useRef(false)
  const planRef = useRef<Array<PlannedCall & { actionId: string }>>([])
  const rollingRef = useRef(false)
  /** Why the last live conversation ended, until the next one opens (B11). */
  const [rtEnded, setRtEnded] = useState<string | null>(null)
  /** A stop phrase heard in a caption that is still growing: ends it if it stays one. */
  const stopTimerRef = useRef<number | null>(null)
  /** The last thing typed into the live session, so it is never taken for a spoken "that's all". */
  const typedRtRef = useRef<string | null>(null)
  /** Assigned below, once the conversation's end exists; read at call time. */
  const endConversationRef = useRef<(end: ConversationEnd) => void>(() => undefined)
  const pendingTextRef = useRef<string | null>(null)
  /** What the live session was last told about the app. */
  const contextRef = useRef(new ContextTracker())
  /** Assigned below, once startRealtime exists; read at call time. */
  const rolloverRef = useRef<(reason: string) => Promise<void>>(async () => undefined)

  // Read by callbacks that outlive a render.
  const settingsRef = useRef(s)
  settingsRef.current = s
  const agentRef = useRef(agent)
  agentRef.current = agent
  const liveProviderRef = useRef(liveProvider)
  liveProviderRef.current = liveProvider

  const setNotice = useCallback((text: string | null): void => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setNoticeState(text)
    noticeTimer.current = text ? window.setTimeout(() => setNoticeState(null), NOTICE_MS) : null
  }, [])

  const upsertCaption = useCallback((c: RealtimeCaption): void => {
    const list = captionsRef.current
    const i = list.findIndex((x) => x.id === c.id)
    const next: HubCaption = { ...c, at: i >= 0 ? list[i]!.at : Date.now() }
    const updated = i >= 0 ? list.map((x, j) => (j === i ? next : x)) : [...list, next].slice(-MAX_CAPTIONS)
    captionsRef.current = updated
    setCaptions(updated)
  }, [])

  const upsertAction = useCallback((a: HubAction): void => {
    const list = actionsRef.current
    const i = list.findIndex((x) => x.id === a.id)
    const updated = i >= 0 ? list.map((x, j) => (j === i ? a : x)) : [...list, a].slice(-MAX_ACTIONS)
    actionsRef.current = updated
    setRtActions(updated)
  }, [])

  /** Run one tool and keep the recent-actions list in step with it. */
  const runTracked = useCallback(
    async (name: string, args: Record<string, unknown>, existingId?: string): Promise<RealtimeToolAnswer> => {
      const id = existingId ?? actionId()
      const at = Date.now()
      upsertAction({ id, tool: name, label: `${realtimeToolLabel(name, args)}…`, status: 'running', at })
      const answer = await runRealtimeTool(name, args)
      upsertAction({
        id,
        tool: name,
        label: realtimeResultLabel(name, answer),
        status: answer.ok ? 'ok' : 'failed',
        detail: answer.text.split('\n')[0],
        at
      })
      return answer
    },
    [upsertAction]
  )

  const onToolCall = useCallback(
    async (call: RealtimeToolCall): Promise<RealtimeToolAnswer> => {
      if (discussionGate(discussionRef.current, call.name) === 'plan') {
        const id = actionId()
        planRef.current.push({ name: call.name, args: call.args, actionId: id })
        upsertAction({
          id,
          tool: call.name,
          label: `Planned: ${realtimeToolLabel(call.name, call.args)}`,
          status: 'planned',
          at: Date.now()
        })
        return { ok: false, text: DISCUSSION_REFUSAL }
      }
      return runTracked(call.name, call.args)
    },
    [runTracked, upsertAction]
  )

  /** "Go": discussion off, the kept plan run in order, the model told what ran. */
  const runGo = useCallback(async (): Promise<void> => {
    if (!discussionRef.current) return
    discussionRef.current = false
    setDiscussionState(false)
    const plan = planRef.current.splice(0)
    const results: Array<{ call: PlannedCall; text: string }> = []
    for (const step of plan) {
      const answer = await runTracked(step.name, step.args, step.actionId)
      results.push({ call: step, text: answer.text })
    }
    sessionRef.current?.sendContext(planRanNote(results), true)
  }, [runTracked])

  /** A Parakeet conversation still open ends before a live one opens: one microphone, one brain. */
  const pauseAgent = useCallback((): void => {
    const a = agentRef.current
    if (!a.armed) return
    // While it is talking the first press only silences it (barge-in).
    if (a.phase === 'speaking') a.toggleAgent()
    a.toggleAgent()
  }, [])

  /**
   * A user caption from the live session: his turn, for the trace, and — when
   * it is "that's all" / "stop listening" — the end of the conversation. The
   * audio already went to the model (it streams), so this is as early as the
   * words can be known; a caption still growing waits a beat so "that's all
   * the files" is not taken for a goodbye.
   */
  const onUserCaption = useCallback((c: RealtimeCaption): void => {
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
    const typed = c.final && typedRtRef.current !== null && c.text.trim() === typedRtRef.current
    if (typed) typedRtRef.current = null
    if (c.final && import.meta.env.DEV) console.info(`[hub] event=turn-sent via=${typed ? 'typed' : 'voice'} chars=${c.text.trim().length}`)
    const stop = typed ? null : stopPhraseOf(c.text)
    if (!stop) return
    if (c.final) {
      endConversationRef.current({ kind: 'phrase', phrase: stop })
      return
    }
    stopTimerRef.current = window.setTimeout(() => {
      stopTimerRef.current = null
      endConversationRef.current({ kind: 'phrase', phrase: stop })
    }, 700)
  }, [])

  const startRealtime = useCallback(
    async (provider: RealtimeProviderId, carryover: string | null): Promise<void> => {
      const spec = providerSpec(provider)
      const cfg = settingsRef.current
      const vendor = spec.vendor ?? 'openai'
      let instructions = buildRealtimeInstructions(carryover)
      if (discussionRef.current) instructions += `\n\n${discussionNote(true)}`

      const session: RealtimeSession = createSession(provider, {
        model: spec.model,
        voice: resolveVoice(vendor, cfg.voiceHubVoice?.[vendor]),
        instructions,
        tools: REALTIME_TOOLS,
        events: {
          onState: (st, detail) => {
            if (sessionRef.current !== session) return
            if (st === 'closed') {
              if (!rollingRef.current) setRtPhase('off')
              return
            }
            setRtPhase(fromRealtimeState(st))
            if (st === 'error' && detail) setRtError(detail)
          },
          onCaption: (c) => {
            if (sessionRef.current !== session) return
            upsertCaption(c)
            if (c.role === 'user') onUserCaption(c)
            if (c.final && c.role === 'user' && discussionRef.current && isGoCommand(c.text)) void runGo()
          },
          onToolCall,
          onToolCancelled: (id) => {
            const hit = actionsRef.current.find((a) => a.status === 'running' && a.id === id)
            if (hit) upsertAction({ ...hit, status: 'failed', label: `${hit.label} (cancelled)` })
          },
          onExpiring: (reason) => {
            if (sessionRef.current === session) void rolloverRef.current(reason)
          }
        }
      })

      sessionRef.current = session
      setLiveProvider(provider)
      setRtError(null)
      setRtPhase('connecting')
      pauseAgent()
      try {
        await session.start()
        if (sessionRef.current !== session) return
        session.setMuted(mutedRef.current)
        setSessionStartedAt(Date.now())
        // What is open right now, before his first word. Changes follow,
        // throttled, from the effect below.
        contextRef.current.reset()
        const ctxText = currentVoiceAgentToolDeps()?.getAppContext?.()
        if (ctxText && contextRef.current.take(ctxText)) session.sendContext(ctxText, false)
        const pending = pendingTextRef.current
        pendingTextRef.current = null
        if (pending) session.sendText(pending)
      } catch (err) {
        if (sessionRef.current !== session) return
        session.stop()
        sessionRef.current = null
        setLiveProvider(null)
        setRtPhase('error')
        setRtError(errText(err))
        pendingTextRef.current = null
      }
    },
    [onToolCall, onUserCaption, pauseAgent, runGo, upsertAction, upsertCaption]
  )

  /** A new session carrying a summary of the old one — the 60-minute cap. */
  rolloverRef.current = async (reason: string): Promise<void> => {
    const old = sessionRef.current
    if (!old || rollingRef.current) return
    rollingRef.current = true
    setNotice('Refreshing the voice session — carrying the conversation over')
    const deps = currentVoiceAgentToolDeps()
    let appState = ''
    try {
      if (deps) appState = buildStateSection(await deps.getSnapshot())
    } catch {
      /* the summary is still worth having without it */
    }
    const summary = buildRolloverSummary(captionsRef.current, actionsRef.current, { appState })
    sessionRef.current = null
    old.stop()
    try {
      await startRealtime(old.provider, summary)
      setNotice(sessionRef.current ? 'Session refreshed — the conversation carried over' : `Voice session ended: ${reason}`)
    } finally {
      rollingRef.current = false
    }
  }

  const stopRealtime = useCallback((): void => {
    const session = sessionRef.current
    sessionRef.current = null
    session?.stop()
    setLiveProvider(null)
    setRtPhase('off')
    setSessionStartedAt(null)
    pendingTextRef.current = null
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
  }, [])

  // Nothing outlives the provider: a session left open is a microphone left open.
  useEffect(
    () => () => {
      const session = sessionRef.current
      sessionRef.current = null
      session?.stop()
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
    },
    []
  )

  /* ---------------------------------------------------------- claude path */

  const realtimeLive = liveProvider !== null
  // A Parakeet conversation still open when the brain setting moves to a live
  // one is still the conversation the switch shows, until it ends (B11).
  const usingRealtime = realtimeLive || (resolved.provider !== 'claude' && !agent.armed)
  const pendingSubmitRef = useRef<string | null>(null)

  // The composer's submit reads its own draft, so set it and submit on the
  // render where the draft has landed.
  useEffect(() => {
    const pending = pendingSubmitRef.current
    if (pending !== null && agent.draftPhrase === pending) {
      pendingSubmitRef.current = null
      agent.submitPhrase()
    }
  }, [agent, agent.draftPhrase])

  const claudeCaptions = useMemo<HubCaption[]>(() => {
    const out: HubCaption[] = []
    for (const turn of agent.turns.slice(-MAX_CAPTIONS / 2)) {
      if (turn.kind !== 'note') out.push({ id: `${turn.id}-u`, role: 'user', text: turn.said, final: true, at: turn.at })
      const reply =
        turn.kind === 'note'
          ? turn.said
          : turn.kind === 'command'
            ? turn.outcomes.map((o) => o.summary).join('; ')
            : (turn.reply?.say ?? turn.reply?.understood ?? '')
      if (reply) {
        out.push({
          id: `${turn.id}-a`,
          role: 'assistant',
          text: reply,
          final: turn.kind !== 'brain' || turn.phase !== 'thinking',
          at: turn.at
        })
      }
    }
    return out
  }, [agent.turns])

  const claudeActions = useMemo<HubAction[]>(() => {
    const out: HubAction[] = []
    for (const turn of agent.turns) {
      if (turn.kind === 'note') continue
      for (const [i, o] of (turn.outcomes ?? []).entries()) {
        out.push({ id: `${turn.id}-${i}`, tool: 'run_app_action', label: o.summary, status: o.ok ? 'ok' : 'failed', at: turn.at })
      }
    }
    if (agent.toolActivity.on && agent.toolActivity.label) {
      out.push({
        id: 'claude-tool',
        tool: 'claude',
        label: agent.toolActivity.label,
        status: agent.toolActivity.failed ? 'failed' : 'running',
        at: Date.now()
      })
    }
    return out.slice(-MAX_ACTIONS)
  }, [agent.turns, agent.toolActivity])

  /* ------------------------------------------------------------ the API */

  const start = useCallback((): void => {
    if (sessionRef.current) return
    const cfg = settingsRef.current
    const pick = resolveAgentBrain(cfg.agentBrain ?? migrateAgentBrain(cfg.voiceHubProvider, cfg.voiceBrain), cfg)
    // A new conversation: the last one's "ended because" is history now.
    setRtEnded(null)
    if (import.meta.env.DEV) console.info(`[hub] event=open brain=${pick.brain}`)
    if (!pick.realtime) {
      // A Parakeet brain: arm AND capture now. Arming alone, with the wake
      // word on, only monitors for "hey Jarvis" — the Listening-but-deaf bug.
      const a = agentRef.current
      if (a.listenNow) a.listenNow()
      else if (!a.armed) a.toggleAgent()
      return
    }
    captionsRef.current = []
    setCaptions([])
    void startRealtime(pick.realtime, null)
  }, [startRealtime])

  /**
   * The conversation closes (B11), whichever brain it is on: a stop phrase,
   * the idle clock, or a second press. Why is kept, in words, for listenNote.
   */
  const endConversation = useCallback(
    (end: ConversationEnd): void => {
      if (sessionRef.current || liveProviderRef.current) {
        setRtEnded(endedNote(end))
        if (import.meta.env.DEV) console.info(`[hub] event=ended why=${end.kind}${end.kind === 'phrase' ? ` phrase="${end.phrase}"` : ''}`)
        stopRealtime()
        return
      }
      // A realtime start that failed leaves no session to stop, only its error.
      // Clear it, or "back to dictation" is a dead click and the dock stays live.
      setRtPhase('off')
      const a = agentRef.current
      if (!a.armed) return
      if (a.endConversation) {
        a.endConversation(end)
        return
      }
      if (a.phase === 'speaking') a.toggleAgent()
      a.toggleAgent()
    },
    [stopRealtime]
  )
  endConversationRef.current = endConversation

  const stop = useCallback((): void => endConversation({ kind: 'press' }), [endConversation])

  const phase: HubPhase = usingRealtime ? rtPhase : fromAgentPhase(agent.phase, agent.armed)

  const toggle = useCallback((): void => {
    if (phase === 'off' || phase === 'error') start()
    else stop()
  }, [phase, start, stop])

  const setMuted = useCallback(
    (on: boolean): void => {
      setMutedState(on)
      mutedRef.current = on
      if (sessionRef.current) {
        sessionRef.current.setMuted(on)
        return
      }
      // Claude: there is no mic track to mute — muting is not listening.
      const a = agentRef.current
      if (on && a.armed) {
        if (a.phase === 'speaking') a.toggleAgent()
        a.toggleAgent()
      } else if (!on && !a.armed) a.toggleAgent()
    },
    []
  )

  const interrupt = useCallback((): void => {
    if (sessionRef.current) {
      sessionRef.current.interrupt()
      return
    }
    if (agentRef.current.phase === 'speaking') agentRef.current.toggleAgent()
  }, [])

  const ask = useCallback(
    (text: string, opts?: { via?: 'typed' | 'voice' }): void => {
      const body = text.trim()
      if (!body) return
      if (sessionRef.current) {
        if (discussionRef.current && isGoCommand(body)) {
          upsertCaption({ id: `typed-${Date.now().toString(36)}`, role: 'user', text: body, final: true })
          void runGo()
          return
        }
        if (opts?.via !== 'voice') typedRtRef.current = body
        sessionRef.current.sendText(body)
        return
      }
      if (resolved.provider !== 'claude') {
        // Typed while off: open the session and send it once audio is up.
        if (opts?.via !== 'voice') typedRtRef.current = body
        pendingTextRef.current = body
        start()
        return
      }
      // A Parakeet brain (Claude, or a JSON text brain): straight into the
      // VoiceAgent pipeline. The composer route below is only for a stale ctx.
      const a = agentRef.current
      if (a.ask) {
        void a.ask(body, { via: opts?.via ?? 'typed' })
        return
      }
      pendingSubmitRef.current = body
      a.setDraftPhrase(body)
    },
    [resolved.provider, runGo, start, upsertCaption]
  )

  const askText = useCallback((text: string): void => ask(text, { via: 'typed' }), [ask])

  /**
   * Raw text into a pane — Dictate mode and the "→ Everest" target. No brain.
   * The same helper types "type this into Everest: …" said in a conversation.
   */
  const dictateTo = useCallback(
    (paneId: string, text: string, opts?: { submit?: boolean }): Promise<{ ok: boolean; summary: string }> =>
      dictateToPane(paneId, text, opts),
    []
  )

  /* -------------------------------------------- live context (realtime)
   * At session start the manifest goes up with the session (startRealtime);
   * after that, a changed app is told at most every CONTEXT_MIN_GAP_MS. */
  useEffect(() => {
    if (!liveProvider) return undefined
    const timer = window.setInterval(() => {
      const session = sessionRef.current
      const text = currentVoiceAgentToolDeps()?.getAppContext?.()
      if (!session || !text) return
      const fresh = contextRef.current.take(text, Date.now(), CONTEXT_MIN_GAP_MS)
      if (fresh) session.sendContext(fresh, false)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [liveProvider])

  const setDiscussionMode = useCallback((on: boolean): void => {
    if (discussionRef.current === on) return
    discussionRef.current = on
    setDiscussionState(on)
    if (!on) {
      // Switched off by hand, not by "go": the kept plan is dropped, not run.
      for (const step of planRef.current.splice(0)) {
        const hit = actionsRef.current.find((a) => a.id === step.actionId)
        if (hit) upsertAction({ ...hit, status: 'failed', label: `${hit.label} (dropped)` })
      }
    }
    sessionRef.current?.sendContext(discussionNote(on))
  }, [upsertAction])

  const go = useCallback((): void => {
    void runGo()
  }, [runGo])

  const setHandsFree = useCallback(
    (on: boolean): void => {
      // Realtime is always hands-free; the Claude path's hands-free is the wake word.
      if (usingRealtime) return
      app.patchSettings({ voiceWakeWord: on })
    },
    [app, usingRealtime]
  )

  const readLevels = useCallback((): { mic: number; out: number } => {
    const session = sessionRef.current
    if (session) return session.levels()
    const a = agentRef.current
    // The Claude path has a mic meter but no output meter: speaking is a steady half.
    return { mic: Math.min(1, a.levelRef.current ?? 0), out: a.phase === 'speaking' ? 0.5 : 0 }
  }, [])

  const provider: VoiceHubProvider = liveProvider ?? resolved.provider

  /* --------------------------------------------- the conversation (B11)
   *
   * Open: a live session that has not ended, or an armed Parakeet agent. The
   * clock that closes it runs only while it is listening — a reply being
   * thought about or spoken is not quiet — and restarts on everything that is
   * not quiet: his phrase landing, a caption of his, a reply starting or ending.
   * "Listening again" is the first listen after a reply, until he speaks. */
  const open = usingRealtime ? realtimeLive && rtPhase !== 'off' && rtPhase !== 'error' : agent.armed
  const busy = phase === 'thinking' || phase === 'speaking'
  const idleMs = normaliseIdleTimeout(s.agentIdleTimeoutMs)
  // A ref, written in the same commit the clock effect below reads it in: the
  // clock must never count from a moment before the conversation opened.
  const lastActivityRef = useRef(Date.now())
  const [activityTick, setActivityTick] = useState(0)
  const markActivity = useCallback((): void => {
    lastActivityRef.current = Date.now()
    setActivityTick((n) => n + 1)
  }, [])
  const [again, setAgain] = useState(false)
  const prevPhaseRef = useRef<HubPhase>('off')
  const prevOpenRef = useRef(false)

  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    const opened = open && !prevOpenRef.current
    prevOpenRef.current = open
    if (!open) {
      setAgain(false)
      return
    }
    const wasBusy = prev === 'thinking' || prev === 'speaking'
    if (opened || busy !== wasBusy || prev === 'off') markActivity()
    if (busy) setAgain(false)
    const trace = (event: string): void => {
      if (import.meta.env.DEV) console.info(`[hub] event=${event}`)
    }
    if (phase === 'speaking' && prev !== 'speaking') trace('reply-start')
    if (prev === 'speaking' && phase !== 'speaking') trace('reply-end')
    if (wasBusy && phase === 'listening') {
      setAgain(true)
      trace('listening-again')
    }
  }, [phase, open, busy, markActivity])

  // His words landing count as not-quiet, and end "Listening again".
  const lastUser = usingRealtime ? [...captions].reverse().find((c) => c.role === 'user') : undefined
  const userSig = usingRealtime ? (lastUser ? `${lastUser.id}:${lastUser.text.length}` : '') : String(agent.turns.length)
  const prevUserSig = useRef(userSig)
  useEffect(() => {
    if (prevUserSig.current === userSig) return
    prevUserSig.current = userSig
    if (!open) return
    markActivity()
    setAgain(false)
  }, [userSig, open, markActivity])

  useEffect(() => {
    const lastActivityAt = lastActivityRef.current
    const left = idleRemainingMs({ open, listening: phase === 'listening', timeoutMs: idleMs, lastActivityAt, now: Date.now() })
    if (left === null) return undefined
    const timer = window.setTimeout(() => endConversationRef.current({ kind: 'idle', ms: idleMs }), left)
    return () => window.clearTimeout(timer)
  }, [open, phase, idleMs, activityTick])

  /* ------------------------------------------- honest mic state (B7) */
  let errorSource: ErrorSource = 'brain'
  let errorText: string | null = null
  if (usingRealtime) {
    errorSource = providerSpec(provider).vendor === 'gemini' ? 'gemini' : 'openai'
    errorText = rtError && rtPhase === 'error' ? rtError : null
  } else {
    // The last brain turn's failure, when it is the newest thing that happened.
    const last = agent.turns[agent.turns.length - 1]
    const turnError = last && last.kind === 'brain' && last.phase === 'error' ? (last.error ?? null) : null
    const sttErr = agent.recogniser?.error ?? agent.sttError
    errorSource = sttErr
      ? 'parakeet'
      : pickedBrain.brain === 'gemini-flash'
        ? 'gemini'
        : pickedBrain.brain === 'groq'
          ? 'groq'
          : pickedBrain.brain === 'openrouter'
            ? 'openrouter'
            : pickedBrain.brain === 'codex-cli'
              ? 'codex'
              : pickedBrain.brain === 'gemini-cli'
                ? 'gemini-cli'
                : 'claude'
    errorText = sttErr ?? turnError
  }
  const errorReason = errorReasonOf(errorSource, errorText)
  const { capturing, starting, listenNote } = micState({
    realtime: usingRealtime,
    phase: usingRealtime ? rtPhase : agent.phase,
    muted,
    armed: agent.armed,
    recogniser: agent.recogniser ?? null,
    errorReason,
    again: open && again,
    ended: open ? null : usingRealtime ? rtEnded : (agent.ended ?? null)
  })
  const brainLabel = agentBrainSpec(pickedBrain.brain).label

  // Dev evidence: one line per state change. Main copies `[hub]` lines into
  // dev.log (electron/renderer-log.ts), so a live "it did nothing" leaves a trail.
  const traceLine = `[hub] phase=${phase} capturing=${capturing} starting=${starting} brain=${pickedBrain.brain} requested=${requestedBrain}${liveProvider ? ` live=${liveProvider}` : ''} armed=${agent.armed} errorReason=${errorReason ?? '-'} listenNote=${listenNote}`
  useEffect(() => {
    if (import.meta.env.DEV) console.info(traceLine)
  }, [traceLine])

  const value = useMemo<VoiceHubController>(
    () => ({
      phase,
      provider,
      requestedProvider: isRealtimeBrainId(requestedBrain) ? requestedBrain : 'claude',
      fallbackReason: liveProvider ? null : resolved.fallbackReason,
      realtime: usingRealtime,
      availability,
      error: usingRealtime ? rtError : agent.sttError,
      muted,
      captions: usingRealtime ? captions : claudeCaptions,
      actions: usingRealtime ? rtActions : claudeActions,
      sessionStartedAt: usingRealtime ? sessionStartedAt : null,
      sessionLimitMs: liveProvider && liveProvider !== 'gemini-live' ? OPENAI_SESSION_LIMIT_MS : null,
      notice,
      handsFree: usingRealtime ? true : s.voiceWakeWord,
      setHandsFree,
      discussionMode,
      discussionAvailable: usingRealtime,
      setDiscussionMode,
      go,
      readLevels,
      start,
      stop,
      toggle,
      setMuted,
      interrupt,
      askText,
      brain: pickedBrain.brain,
      brainLabel,
      ask,
      dictateTo,
      capturing,
      starting,
      listenNote,
      errorReason
    }),
    [
      pickedBrain.brain,
      brainLabel,
      ask,
      dictateTo,
      capturing,
      starting,
      listenNote,
      errorReason,
      phase,
      provider,
      requestedBrain,
      s.voiceWakeWord,
      liveProvider,
      resolved.fallbackReason,
      usingRealtime,
      availability,
      rtError,
      agent.sttError,
      muted,
      captions,
      claudeCaptions,
      rtActions,
      claudeActions,
      sessionStartedAt,
      notice,
      setHandsFree,
      discussionMode,
      setDiscussionMode,
      go,
      readLevels,
      start,
      stop,
      toggle,
      setMuted,
      interrupt,
      askText
    ]
  )

  return <VoiceHubContext.Provider value={value}>{children}</VoiceHubContext.Provider>
}

export function useVoiceHubController(): VoiceHubController {
  const ctx = useContext(VoiceHubContext)
  if (!ctx) throw new Error('useVoiceHubController must be used inside <VoiceHubControllerProvider>')
  return ctx
}

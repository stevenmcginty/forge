import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import { isShellProfile } from '@shared/agents'
import {
  isSttSetupError,
  type AgentProfile,
  type CompanionUtteranceEvent,
  type SttStatus,
  type VoiceReplyMode
} from '@shared/types'
import { agentMemory } from '@/lib/agentmemory'
import { claimsCompletedAction, companionReplyText } from '@/lib/brainjson'
import { earconListening } from '@/lib/earcon'
import { speaker } from '@/lib/speech'
import { chooseEngine, pickVaried, voiceSpeaker, type VoiceConfig } from '@/lib/tts'
import { resolveProfile } from '@/lib/agents'
import { buildManifest, type ManifestSnapshot } from '@/lib/appmanifest'
import {
  paneLabel,
  runAppAction,
  type ActionContext,
  type ActionOutcome,
  type ActionPane,
  type ActionRunner,
  type AppAction
} from '@/lib/appactions'
import { makeId } from '@/lib/ids'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { terminalHost, type PaneStatus } from '@/lib/terminals'
import { transcriptBus, typedTranscript } from '@/lib/transcriptSource'
import { parseUtterance } from '@/lib/voicecommands'
import {
  brainStatusLabel,
  getActiveBrain,
  type BrainContext,
  type BrainReply,
  type BrainStatus,
  type BrainTurn
} from '@/lib/voicebrain'
import { useActiveProject, useApp, VOICE_PANEL_MAX, VOICE_PANEL_MIN } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverRow, PopoverSection } from './Popover'
import './VoicePanel.css'

/**
 * The voice agent panel — talk to Forge, and talk about what to build.
 *
 * Two paths through one input:
 *
 *  1. Commands ("open up three tabs of kimmy") are matched by the deterministic
 *     grammar and executed immediately, through the very same AppState actions
 *     the buttons use. No model, no key, no latency, works offline.
 *  2. Everything else goes to the active brain — Gemini when a key is set,
 *     otherwise the stub, which echoes and says so. A brain may return actions
 *     too; they run through the same executor, so it can never do more than the
 *     grammar could.
 *
 * The transcript arrives via `transcriptBus`, fed by the text box and, while
 * agent mode is on, by dictation. Replies are written and — unless Settings says
 * otherwise — spoken, which is why so much of this file is about the microphone
 * being shut at the right moments.
 */

interface TurnBase {
  id: string
  said: string
  at: number
}

interface CommandTurn extends TurnBase {
  kind: 'command'
  actions: AppAction[]
  outcomes: ActionOutcome[]
}

interface BrainTurnState extends TurnBase {
  kind: 'brain'
  phase: 'thinking' | 'done' | 'error'
  reply?: BrainReply
  error?: string
  /** The draft prompt as the user has edited it. */
  draft: string
  outcomes?: ActionOutcome[]
}

/** A one-line note from the agent itself — "held, nothing sent". */
interface NoteTurn extends TurnBase {
  kind: 'note'
  tone: 'ok' | 'warn'
}

type Turn = CommandTurn | BrainTurnState | NoteTurn

/**
 * Agent mode, as a state machine.
 *
 *   off      nothing is armed; the button is a grey circle
 *   warming  the sidecar is loading Parakeet (3–6s the first time)
 *   listening the mic is open and the ring is driven by real levels
 *   thinking a phrase is with the brain; after 5s it starts counting out loud
 *   speaking the agent is talking back — and the microphone is SHUT
 *   replied  a brief flash, then straight back to listening
 *   error    an amber blip, then straight back to listening
 *
 * The whole point is that `listening` is the resting state: every other state
 * returns to it by itself. Steve tapped once to start a conversation, not to
 * dictate one phrase.
 *
 * `speaking` is the one that must not be got wrong. The microphone is a foot
 * from the speakers, so while the agent talks the sidecar is stopped and any
 * phrase that still arrives is dropped. Without that, Forge transcribes its own
 * reply, answers it, and talks to itself until you close the app.
 */
type AgentPhase = 'off' | 'warming' | 'listening' | 'thinking' | 'speaking' | 'replied' | 'error'

/** How long the flash states hold before falling back to listening. */
const REPLIED_MS = 900
const ERROR_MS = 1800
/** Silence counts as a dead circle after this, so start showing the clock. */
const THINKING_PATIENCE_MS = 5000

/** Spoken brakes — these hold a prompt that is about to be submitted. */
const CANCEL_WORDS = /^(?:wait|stop|no|nope|hold|hold on|cancel|don't|dont|abort|scratch that)\b/i

/**
 * What Forge itself says when the brain falls over.
 *
 * A pool rather than a constant, and never the same one twice running. One
 * fixed sentence on every failure is the sameness that made the old voice
 * sound like a machine reading a card, and this is the only line Forge writes
 * for itself often enough for him to notice.
 */
const BRAIN_FAILED = [
  'That one did not go through. Say it again?',
  'Something broke on the way to the model. Try me again.',
  'No luck there — give it another go.',
  'The model did not answer. Once more?'
]

/**
 * Phases that mean the microphone has just been given back.
 *
 * A short blip marks the handover instead of a spoken announcement. Coming from
 * `off` is not in the list: arming is a deliberate tap and it needs no sound.
 */
const HANDS_BACK: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['speaking', 'replied', 'error', 'thinking', 'warming'])

interface PaneOption {
  paneId: string
  tabId: string
  tabTitle: string
  title: string
  profile: AgentProfile
  status: PaneStatus
}

export function VoicePanel(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()

  const open = state.settings.voicePanelOpen
  const [turns, setTurns] = useState<Turn[]>([])
  const [draftPhrase, setDraftPhrase] = useState('')
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const logRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  /** The last thing he typed, so echo rejection never eats his own keystrokes. */
  const lastTypedRef = useRef<string | null>(null)

  /* --------------------------------------------------------- agent mode
   *
   * One button, one idea: tap it and you are *in a conversation*. It arms
   * routing (while it is on and this panel is open, dictated phrases are the
   * agent's rather than the focused pane's — the rule lives in useDictation),
   * it starts the sidecar, and crucially it re-arms the sidecar every time the
   * engine's own silence timeout ends a phrase. Without that last part the mic
   * quietly dies after ten seconds and you are talking to nobody.
   *
   * The engine is driven by IPC rather than through useDictation on purpose:
   * that hook owns the global dictation hotkey, and a second copy of it would
   * mean every press of Right Ctrl toggled twice and cancelled itself out.
   */

  const armed = state.agentListening
  const armedRef = useRef(armed)
  armedRef.current = armed

  const [phase, setPhase] = useState<AgentPhase>('off')
  const [stt, setStt] = useState<SttStatus>({ phase: 'off', level: 0, error: null, ready: false })
  const sttRef = useRef(stt)
  sttRef.current = stt
  /** Live mic level, read by the ring's rAF loop without re-rendering. */
  const levelRef = useRef(0)
  /** Non-null while a phrase is with the brain. */
  const thinkingSince = useRef<number | null>(null)
  const [thinkingFor, setThinkingFor] = useState(0)
  const flashTimer = useRef<number | null>(null)
  const rearmTimer = useRef<number | null>(null)

  /* ------------------------------------------------------------ speaking */

  const replyMode = state.settings.voiceReplyMode
  const speaksAloud = replyMode !== 'text'

  /**
   * Which engine, which voice, which model — the whole of what the speaker
   * needs, snapshotted per render and read through a ref so `sayAloud` does not
   * have to be rebuilt (and the transcript subscription torn down) every time a
   * setting changes.
   */
  const voiceConfig = useMemo<VoiceConfig>(
    () => ({
      engine: state.settings.voiceEngine,
      hasKey: state.settings.geminiKey.trim().length > 0,
      geminiVoice: state.settings.voiceTtsVoice,
      ttsModel: state.settings.voiceTtsModel,
      localVoice: state.settings.voiceReplyVoice
    }),
    [
      state.settings.voiceEngine,
      state.settings.geminiKey,
      state.settings.voiceTtsVoice,
      state.settings.voiceTtsModel,
      state.settings.voiceReplyVoice
    ]
  )
  const voiceConfigRef = useRef(voiceConfig)
  voiceConfigRef.current = voiceConfig

  /**
   * Can anything speak at all?
   *
   * Not the same question as "is speechSynthesis present" any more: with a
   * Gemini key the agent has a voice even on a machine with no SAPI voices
   * installed, and the reply-mode buttons must not be greyed out on it.
   */
  const canSpeak = speaker.available || chooseEngine(voiceConfig) === 'gemini'

  /** True from just before the first syllable to just after the last. */
  const speakingRef = useRef(false)
  const [speaking, setSpeaking] = useState(false)

  const noticeRef = useRef(actions.setNotice)
  noticeRef.current = actions.setNotice

  /**
   * Say something, with the microphone shut for the duration.
   *
   * The stop/start around the utterance is the anti-feedback loop; `speakingRef`
   * is the second belt, because a phrase the sidecar had already cut can still
   * be delivered after `stop()`.
   *
   * Neural speech makes the *shape* of this matter more, not less. The request
   * takes a couple of seconds, and the whole of that time counts as speaking:
   * the mic is shut the moment there is something to say, not when the first
   * sample arrives, because a sidecar re-armed in the gap would hear the reply
   * and answer it. `voiceSpeaker` owns the engine chain — Gemini, then the local
   * voice if that cannot run — so this never has to care which one is talking.
   */
  const sayAloud = useCallback(
    async (key: string, text: string): Promise<void> => {
      if (!speaksAloud || !text.trim()) return
      const config = voiceConfigRef.current
      if (!speaker.available && chooseEngine(config) !== 'gemini') return
      speakingRef.current = true
      setSpeaking(true)
      if (armedRef.current) setPhase('speaking')
      void window.forge.stt.stop()
      try {
        // Keyed by turn: a re-render cannot make it say the same thing twice.
        await voiceSpeaker.speakOnce(key, text, config, (msg) => noticeRef.current(msg))
      } finally {
        // A short tail: the sidecar cuts a phrase on silence, so the last word
        // can land a beat after the audio stops.
        await new Promise((r) => window.setTimeout(r, 220))
        speakingRef.current = false
        setSpeaking(false)
      }
    },
    [speaksAloud]
  )

  useEffect(() => {
    let alive = true
    void window.forge.stt.status().then((s) => {
      if (alive) setStt(s)
    })
    const off = window.forge.stt.onStatus((s) => {
      levelRef.current = s.level
      setStt(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /** Move to a flash state, then fall back to listening by itself. */
  const flash = useCallback((to: AgentPhase, ms: number) => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    setPhase(to)
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null
      if (!armedRef.current) return
      setPhase(sttRef.current.phase === 'starting' ? 'warming' : 'listening')
    }, ms)
  }, [])

  /**
   * The loop. Parakeet stops itself after `sttAutoStopSeconds` of silence, which
   * is right for dictation and wrong for a conversation — so in agent mode an
   * idle engine is immediately asked to listen again. The small delay keeps a
   * refusing sidecar from becoming a spin.
   */
  useEffect(() => {
    if (!armed || speaking) return undefined
    if (stt.phase !== 'idle' && stt.phase !== 'off') return undefined
    if (stt.error && isSttSetupError(stt.error.kind)) return undefined
    const timer = window.setTimeout(() => void window.forge.stt.start(), 260)
    rearmTimer.current = timer
    return () => window.clearTimeout(timer)
  }, [armed, speaking, stt.phase, stt.error])

  // The button's resting appearance follows the engine, except while a flash, a
  // think or an utterance is deliberately holding it somewhere else.
  useEffect(() => {
    if (!armed) {
      setPhase('off')
      return
    }
    if (thinkingSince.current !== null || flashTimer.current !== null || speaking) return
    setPhase(stt.phase === 'starting' ? 'warming' : 'listening')
  }, [armed, speaking, stt.phase])

  /**
   * The handover blip.
   *
   * This is what "returning to listening" sounds like now. It used to be a
   * spoken sentence — the same words every time — and that was the single most
   * robotic thing the agent did. 120 ms of quiet sine says it better, and it
   * only fires coming *back* from a turn, never on the tap that arms the agent
   * (`HANDS_BACK`), so a session does not open with a noise.
   */
  const previousPhase = useRef<AgentPhase>('off')
  useEffect(() => {
    const before = previousPhase.current
    previousPhase.current = phase
    if (phase !== 'listening' || !HANDS_BACK.has(before)) return
    if (state.settings.voiceEarcons) earconListening()
  }, [phase, state.settings.voiceEarcons])

  const toggleAgent = useCallback(() => {
    // Barge-in: pressing the button while it is talking shuts it up first, and
    // does not also turn the agent off. Interrupting is a conversation move.
    //
    // `voiceSpeaker.cancel()` does three things — stops the sound, aborts the
    // TTS request that has not come back yet, and discards a reply already in
    // the air. All three are needed: with a neural voice "it is talking" starts
    // a second or two before any sound, and a clip that arrived after he
    // interrupted would otherwise play over him.
    if (speakingRef.current) {
      voiceSpeaker.cancel()
      speakingRef.current = false
      setSpeaking(false)
      return
    }
    const next = !armedRef.current
    actions.setAgentListening(next)
    if (next) {
      setPhase('warming')
      void window.forge.stt.start()
    } else {
      thinkingSince.current = null
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = null
      if (rearmTimer.current) window.clearTimeout(rearmTimer.current)
      voiceSpeaker.cancel()
      setPhase('off')
      void window.forge.stt.stop()
    }
  }, [actions])

  // Closing the panel disarms, so it never reopens secretly pointed at the
  // agent. The sidecar is left alone: the pill may still be dictating into a
  // pane, and that is not this panel's business to stop.
  useEffect(() => {
    if (!open && armed) actions.setAgentListening(false)
  }, [open, armed, actions])

  // Esc leaves the conversation — the same key that closes everything else.
  useEffect(() => {
    if (!open || !armed) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      toggleAgent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, armed, toggleAgent])

  // "still thinking… 12s" — Gemini can take a minute on a real draft, and a
  // circle that says nothing for a minute looks broken.
  useEffect(() => {
    if (phase !== 'thinking') {
      setThinkingFor(0)
      return undefined
    }
    const tick = window.setInterval(() => {
      const since = thinkingSince.current
      if (since !== null) setThinkingFor(Math.floor((Date.now() - since) / 1000))
    }, 500)
    return () => window.clearInterval(tick)
  }, [phase])

  /* --------------------------------------------------------------- brain */

  const brain = useMemo(
    () =>
      getActiveBrain({
        voiceBrain: state.settings.voiceBrain,
        anthropicKey: state.settings.anthropicKey,
        geminiKey: state.settings.geminiKey,
        geminiModel: state.settings.geminiModel,
        openrouterKey: state.settings.openrouterKey,
        openrouterModel: state.settings.openrouterModel
      }),
    [
      state.settings.voiceBrain,
      state.settings.anthropicKey,
      state.settings.geminiKey,
      state.settings.geminiModel,
      state.settings.openrouterKey,
      state.settings.openrouterModel
    ]
  )
  const status: BrainStatus = brain.ready()

  // Agent memory (M7). Warmed here so the brain context can be built without an
  // await; everything that decides what to remember lives in lib/agentmemory.ts.
  useEffect(() => void agentMemory.prime(project?.id ?? null), [project?.id])

  /* ------------------------------------------------- state for the agent */

  const workspace = project ? state.workspaces[project.id] : undefined
  const activeTab = workspace?.tabs.find((t) => t.id === workspace.activeTabId) ?? null
  const paneCount = useMemo(() => {
    let n = 0
    for (const ws of Object.values(state.workspaces)) for (const tab of ws.tabs) n += countLeaves(tab.root)
    return n
  }, [state.workspaces])

  /**
   * Which pane he was in, and when.
   *
   * "the claude one" with three Claude panes open is a genuine ambiguity, and
   * the executor refuses to guess — but "the one I was just in" is a real
   * answer, so focus order is remembered here. A monotonic counter, not a clock:
   * all that matters is the ordering.
   */
  const focusSeq = useRef(0)
  const focusedAt = useRef<Map<string, number>>(new Map())
  const focusedPaneId = activeTab?.activePaneId ?? null
  useEffect(() => {
    if (!focusedPaneId) return
    focusSeq.current += 1
    focusedAt.current.set(focusedPaneId, focusSeq.current)
  }, [focusedPaneId])

  /**
   * Every open terminal, numbered the way the manifest numbers them and the way
   * Steve says them out loud. Built once, then used for both — the numbering
   * cannot drift because there is only one walk.
   */
  const panes = useMemo<ActionPane[]>(() => {
    if (!workspace) return []
    const out: ActionPane[] = []
    workspace.tabs.forEach((tab, tabIndex) => {
      for (const leaf of collectLeaves(tab.root)) {
        const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
        const status = terminalHost.runtime(leaf.id).status
        out.push({
          paneId: leaf.id,
          tabId: tab.id,
          tabNumber: tabIndex + 1,
          tabTitle: tab.title,
          number: out.length + 1,
          title: leaf.title.trim() || profile.name,
          profileId: profile.id,
          profileName: profile.name,
          // Reachable, not visible — a background tab's pane is 'idle' because
          // nothing has mounted it yet, and the runner will wake it.
          live: status !== 'exited' && status !== 'error',
          focused: leaf.id === tab.activePaneId && tab.id === workspace.activeTabId,
          agent: !isShellProfile(profile),
          lastFocusedAt: focusedAt.current.get(leaf.id) ?? 0
        })
      }
    })
    return out
    // paneCount changes whenever a pane is added or removed; the rest is state.
  }, [workspace, state.settings.agentProfiles, paneCount, focusedPaneId])

  // Snapshotted every render and read through a ref, so the transcript
  // subscription never has to be torn down and rebuilt.
  const ctxRef = useRef<ActionContext | null>(null)
  ctxRef.current = {
    panes,
    autoRelay: state.settings.voiceAutoRelay,
    projects: state.projects.map((p) => ({ id: p.id, name: p.name })),
    profiles: state.settings.agentProfiles,
    defaultProfileId: project?.defaultProfileId ?? state.settings.agentProfiles[0]?.id ?? 'pwsh',
    activeProjectId: project?.id ?? null,
    activeProjectName: project?.name ?? null,
    loadedProjectIds: Object.keys(state.workspaces),
    tabs: (workspace?.tabs ?? []).map((t) => ({ id: t.id, title: t.title })),
    activeTabId: workspace?.activeTabId ?? null,
    focusedPaneId: activeTab?.activePaneId ?? null,
    paneCount,
    panesInActiveTab: activeTab ? countLeaves(activeTab.root) : 0,
    maxSessions: MAX_SESSIONS,
    maxPanesPerTab: MAX_PANES_PER_TAB
  }

  /**
   * Prompts that have been typed into a pane and are waiting out their grace
   * beat before Enter is pressed. A spoken "wait" or a click on the chip empties
   * this; anything still in it when the timer fires goes.
   */
  const holds = useRef(new Set<() => void>())
  const cancelAllHolds = useCallback((): number => {
    const n = holds.current.size
    for (const cancel of [...holds.current]) cancel()
    holds.current.clear()
    return n
  }, [])
  const [holding, setHolding] = useState(0)

  /**
   * The countdown before something irreversible happens.
   *
   * Resolves true if it was stopped ("wait", or a click on the chip) and false
   * if it ran out. Both the auto-relay Enter and a bulk tab close hang off this,
   * because they are the same promise to Steve: you have a beat to change your
   * mind, and I will tell you what I am about to do.
   */
  const graceBeat = useCallback((ms: number): Promise<boolean> => {
    const wait = Math.max(0, ms)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (wasHeld: boolean): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        holds.current.delete(cancel)
        setHolding(holds.current.size)
        resolve(wasHeld)
      }
      const cancel = (): void => finish(true)
      const timer = window.setTimeout(() => finish(false), wait)
      holds.current.add(cancel)
      setHolding(holds.current.size)
    })
  }, [])

  /** The last thing said when something failed, so it is not said again. */
  const lastFailure = useRef<string | undefined>(undefined)

  const runnerRef = useRef<ActionRunner | null>(null)
  runnerRef.current = {
    newTab: (profileId) => actions.newTab(profileId),
    splitPane: (paneId, direction, profileId) => actions.splitPane(paneId, direction, profileId),
    closePane: (paneId) => actions.closePane(paneId),
    closeTab: (tabId) => actions.closeTab(tabId),
    selectProject: (projectId) => actions.selectProject(projectId),
    selectTab: (tabId) => actions.selectTab(tabId),
    renameTab: (tabId, title) => actions.renameTab(tabId, title),
    setViewMode: (mode) => actions.setViewMode(mode),
    openSettings: (section) => actions.openSettings(section as Parameters<typeof actions.openSettings>[0]),
    // Media generation goes to the main process, which holds the key, writes
    // into the project's assets/generated/ and puts the result in the tray.
    makeImage: async (request) => {
      const res = await window.forge.voice.makeImage({ ...request, projectPath: project?.path })
      if (!res.ok) return { ok: false, summary: mediaFailure(res.error), requested: request.count, done: 0 }
      const made = res.paths.length
      return {
        ok: true,
        summary:
          `Made ${made} ${made === 1 ? 'image' : 'images'} in assets/generated` +
          `${res.adopted > 0 ? ' — also in the shot tray' : ''}${res.note ? ` (${res.note})` : ''}`,
        requested: request.count,
        done: made,
        paths: res.paths
      }
    },
    // Same road as makeImage, but Veo takes one to three minutes rather than
    // six seconds, so the provisional chip the executor writes says so and this
    // only replaces it when the file is actually on disk. Nothing is adopted
    // into the shot shelf: that holds still images.
    makeVideo: async (request) => {
      const res = await window.forge.voice.makeVideo({ ...request, projectPath: project?.path })
      if (!res.ok) return { ok: false, summary: mediaFailure(res.error), requested: 1, done: 0 }
      return {
        ok: true,
        summary: `Video saved to assets/generated${res.note ? ` (${res.note})` : ''}`,
        requested: 1,
        done: res.paths.length,
        paths: res.paths
      }
    },
    editImage: async (request) => {
      const res = await window.forge.voice.editImage({ ...request, projectPath: project?.path })
      if (!res.ok) return { ok: false, summary: mediaFailure(res.error), requested: 1, done: 0 }
      return {
        ok: true,
        summary: `Edited image saved to assets/generated${res.adopted > 0 ? ' — also in the shot tray' : ''}`,
        requested: 1,
        done: res.paths.length,
        paths: res.paths
      }
    },
    recallMemory: () => agentMemory.recall(project?.id ?? null),
    forgetMemory: () => agentMemory.forget(project?.id ?? null),

    /**
     * Deliver a prompt to a terminal.
     *
     * The text always goes in immediately — that part is safe and Steve can see
     * it land. The Enter is what waits: the pane is brought to the front, the
     * chip counts down, and for `voiceRelayGraceMs` a spoken "wait" (or a click
     * on the chip) can still hold it. Nothing is submitted to a plain shell, and
     * nothing is submitted at all unless Settings says so — by then the executor
     * has already decided that and passed `submit` false with a reason.
     */
    sendPrompt: async ({ pane, text, submit, holdReason, flesh }) => {
      const label = paneLabel(pane)
      // Bring it forward first. A pane in a background tab has no terminal at
      // all until it is mounted, so this is what makes it exist.
      if (workspace && workspace.activeTabId !== pane.tabId) actions.selectTab(pane.tabId)
      actions.focusPane(pane.paneId)
      if (!(await waitForShell(pane.paneId))) {
        return {
          ok: false,
          summary: `${label} did not come up in time — open its tab and try again`,
          requested: 1,
          done: 0
        }
      }
      if (!terminalHost.type(pane.paneId, text)) {
        return { ok: false, summary: `${label} would not take the text — is its shell still alive?`, requested: 1, done: 0 }
      }
      terminalHost.focus(pane.paneId)
      terminalHost.scrollToBottom(pane.paneId)

      const prefix = flesh ? 'Fleshed out and typed into' : 'Typed into'
      if (!submit) {
        return {
          ok: true,
          summary: `${prefix} ${label} — ${holdReason ?? 'press Enter there to run it'}`,
          requested: 1,
          done: 1
        }
      }

      const held = await graceBeat(state.settings.voiceRelayGraceMs)

      if (held) {
        return { ok: true, summary: `${prefix} ${label} — held, not sent. Press Enter there yourself.`, requested: 1, done: 1 }
      }
      if (!terminalHost.submit(pane.paneId)) {
        return { ok: false, summary: `${prefix} ${label}, but its shell went away before I could send it`, requested: 1, done: 0 }
      }
      return { ok: true, summary: `Sent to ${label}`, requested: 1, done: 1 }
    },

    /** Bulk close, behind the same countdown a submitted prompt gets. */
    closeMany: async ({ tabIds, label }) => {
      const held = await graceBeat(state.settings.voiceRelayGraceMs)
      if (held) {
        return { ok: true, summary: `Held — ${tabIds.length} tabs left alone`, requested: tabIds.length, done: 0 }
      }
      for (const id of tabIds) actions.closeTab(id)
      return {
        ok: true,
        summary: `Closed ${tabIds.length} tabs (${label})`,
        requested: tabIds.length,
        done: tabIds.length
      }
    },

    /**
     * Make a folder and put it in the rail.
     *
     * Creating is the main process's job (it owns the allow-list); adding it to
     * the rail is this one's, and it goes through the same dispatch the folder
     * picker uses, so a spoken project and a picked one are the same thing.
     */
    createProject: async ({ name, parentDir }) => {
      const res = await window.forge.makeProjectFolder(parentDir ? { name, parentDir } : { name })
      if (!res.ok) return { ok: false, summary: res.error, requested: 1, done: 0 }
      const existing = state.projects.find((p) => p.path.toLowerCase() === res.path.toLowerCase())
      if (existing) {
        actions.selectProject(existing.id)
        return { ok: true, summary: `${existing.name} was already in the rail — switched to it`, requested: 1, done: 1 }
      }
      actions.addProjectPath(res.path, res.name)
      return { ok: true, summary: `Created “${res.name}” in ${res.path} and opened it`, requested: 1, done: 1 }
    }
  }

  const manifestRef = useRef<string>('')
  manifestRef.current = useMemo(() => {
    const snapshot: ManifestSnapshot = {
      appVersion: state.info?.version ?? null,
      projects: state.projects.map((p) => ({ name: p.name, path: p.path, active: p.id === project?.id })),
      profiles: state.settings.agentProfiles,
      // Built from the same `panes` array the executor resolves against, so the
      // "Terminal 3" the model is shown is the "Terminal 3" it will get.
      tabs: (workspace?.tabs ?? []).map((tab, i) => ({
        number: i + 1,
        title: tab.title,
        active: tab.id === workspace?.activeTabId,
        panes: panes
          .filter((p) => p.tabId === tab.id)
          .map((p) => ({
            number: p.number,
            title: p.title,
            profileName: p.profileName,
            status: terminalHost.runtime(p.paneId).status,
            focused: p.focused,
            agent: p.agent
          }))
      })),
      paneCount,
      maxSessions: MAX_SESSIONS,
      maxPanesPerTab: MAX_PANES_PER_TAB,
      view: {
        railCollapsed: state.settings.railCollapsed,
        voicePanelWidth: state.settings.voicePanelWidth,
        terminalFontSize: state.settings.terminalFontSize,
        shell: state.info?.shell ?? state.settings.shell
      }
    }
    return buildManifest(snapshot)
  }, [
    state.info,
    state.projects,
    state.settings.agentProfiles,
    state.settings.railCollapsed,
    state.settings.voicePanelWidth,
    state.settings.terminalFontSize,
    state.settings.shell,
    workspace,
    project?.id,
    paneCount
  ])

  // Conversation so far, for multi-turn context.
  const historyRef = useRef<BrainTurn[]>([])
  historyRef.current = turns.flatMap((turn): BrainTurn[] => {
    const mine: BrainTurn = { role: 'user', text: turn.said }
    if (turn.kind === 'note') return [{ role: 'agent', text: turn.said }]
    if (turn.kind === 'command') {
      return [mine, { role: 'agent', text: turn.outcomes.map((o) => o.summary).join('; ') }]
    }
    const said = turn.reply?.say ?? turn.reply?.understood
    return said ? [mine, { role: 'agent', text: said }] : [mine]
  })

  /* ------------------------------------------------------------- executor */

  /**
   * `onResolved` exists for the asynchronous actions only. Generating an image
   * takes seconds, so `runAppAction` hands back a provisional "Generating…"
   * outcome plus a promise; when it settles the chip is replaced in place rather
   * than the card sitting there lying about what happened.
   */
  const runActions = useCallback(
    (list: AppAction[], onResolved?: (index: number, outcome: ActionOutcome) => void): ActionOutcome[] => {
      let ctx = ctxRef.current
      const runner = runnerRef.current
      if (!ctx || !runner) return []
      const out: ActionOutcome[] = []
      for (const [i, action] of list.entries()) {
        const outcome = runAppAction(action, ctx, runner)
        out.push(outcome)
        if (outcome.pending && onResolved) {
          const index = i
          void outcome.pending.then(
            (settled) => onResolved(index, settled),
            (err: unknown) =>
              onResolved(index, {
                ok: false,
                summary: mediaFailure(err instanceof Error ? err.message : String(err)),
                requested: outcome.requested,
                done: 0
              })
          )
        }
        // Later actions in the same breath must see the earlier ones' effect.
        if (action.kind === 'open_tabs') {
          ctx = { ...ctx, paneCount: ctx.paneCount + outcome.done }
        } else if (action.kind === 'open_panes') {
          ctx = {
            ...ctx,
            paneCount: ctx.paneCount + outcome.done,
            panesInActiveTab: ctx.panesInActiveTab + outcome.done
          }
        } else if (action.kind === 'close_pane') {
          ctx = { ...ctx, paneCount: Math.max(0, ctx.paneCount - outcome.done) }
        }
      }
      return out
    },
    []
  )

  /** Replace one chip on a turn once its slow action has settled. */
  const patchOutcome = useCallback((turnId: string, index: number, outcome: ActionOutcome): void => {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== turnId || t.kind === 'note') return t
        const current = t.outcomes
        if (!current || !current[index]) return t
        const next = [...current]
        next[index] = outcome
        return { ...t, outcomes: next }
      })
    )
  }, [])

  /* ---------------------------------------------------- transcript intake */

  /**
   * One phrase, all the way through: brake, grammar, brain.
   *
   * Resolves with the line that answers it — the same words that get read out.
   * That return value exists for the Companion: a phrase arriving from the
   * phone has to be answered *back to the phone*, and the only honest answer is
   * the one Forge actually gave. `silent` is for exactly that case: he is not
   * at the machine, so talking to an empty room helps nobody.
   */
  const runPhrase = useCallback(
    async (said: string, opts?: { silent?: boolean }): Promise<string> => {
      const id = makeId('turn')
      const speak = async (key: string, text: string): Promise<void> => {
        if (opts?.silent) return
        await sayAloud(key, text)
      }

      // 0a — anything heard while the agent was talking is the agent. The
      // sidecar is stopped for the duration, but a phrase it had already cut
      // can still arrive; dropping it here is what stops Forge answering itself.
      // A typed phrase from the phone is never the agent, so it is let through.
      if (speakingRef.current && !opts?.silent) return ''

      // 0b — and the same phrase arriving a beat *after* it stopped talking is
      // still the agent. The sidecar cuts on silence, so its words land once the
      // room is quiet, by which time the guard above has lifted. Anything Steve
      // typed is exempt: it came from the keyboard, whatever it says.
      if (!opts?.silent && said !== lastTypedRef.current && speaker.heardItself(said)) return ''
      if (said === lastTypedRef.current) lastTypedRef.current = null

      // 0 — the brake. While a prompt is counting down into a terminal, "wait"
      // means stop that, not "start a new conversation about waiting".
      if (holds.current.size > 0 && CANCEL_WORDS.test(said.trim())) {
        const n = cancelAllHolds()
        const held = n === 1 ? 'Held — not sent. It is typed in, waiting for you.' : `Held ${n} prompts — none sent.`
        setTurns((prev) => [...prev, { id, said: held, at: Date.now(), kind: 'note', tone: 'warn' }])
        return held
      }

      // 1 — plain commands never touch a model.
      const ctx = ctxRef.current
      const hit = ctx ? parseUtterance(said, ctx) : null
      if (hit) {
        const outcomes = runActions(hit.actions, (index, outcome) => patchOutcome(id, index, outcome))
        setTurns((prev) => [
          ...prev,
          { id, said, at: Date.now(), kind: 'command', actions: hit.actions, outcomes }
        ])
        void agentMemory.record({ projectId: ctx?.activeProjectId ?? null, utterance: said, at: Date.now(), outcomes })
        // A command's outcome is its own answer — "Opened 3 Claude Code tabs" is
        // exactly what he wants to hear, and it needed no model to say it.
        const spoken = outcomes.map((o) => o.summary).join('. ')
        if (spoken) await speak(id, spoken)
        return spoken
      }

      // 2 — everything else is a conversation with the brain.
      thinkingSince.current = Date.now()
      if (armedRef.current) setPhase('thinking')
      setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'brain', phase: 'thinking', draft: '' }])

      const context: BrainContext = {
        projectName: ctx?.activeProjectName ?? undefined,
        projectPath: project?.path,
        recentTranscript: [...historyRef.current.filter((t) => t.role === 'user').map((t) => t.text), said],
        manifest: manifestRef.current,
        history: [...historyRef.current],
        projectMemory: agentMemory.cached(ctx?.activeProjectId ?? null)
      }

      return brain
        .interpret(said, context)
        .then(async (reply) => {
          thinkingSince.current = null
          if (armedRef.current && !speaksAloud) flash('replied', REPLIED_MS)
          // A send_prompt with no text of its own means "the draft in this same
          // reply" — the model is told to write the brief once, not twice.
          const list = (reply.actions ?? []).map((action) =>
            action.kind === 'send_prompt' && !action.text.trim() && reply.draftPrompt
              ? { ...action, text: reply.draftPrompt }
              : action
          )
          let outcomes = list.length
            ? runActions(list, (index, outcome) => patchOutcome(id, index, outcome))
            : undefined
          // "Opening three Claude Code terminals for you." with an empty
          // actions array is a lie, and a silent one. Contradict it.
          if (!list.length && claimsCompletedAction(reply.say ?? reply.understood)) {
            outcomes = [
              {
                ok: false,
                summary: 'It said it did that, but sent no action — say it again',
                requested: 1,
                done: 0
              }
            ]
          }
          setTurns((prev) =>
            prev.map((t) =>
              t.id === id && t.kind === 'brain'
                ? { ...t, phase: 'done', reply, draft: reply.draftPrompt ?? '', outcomes }
                : t
            )
          )
          void agentMemory.record({ projectId: ctx?.activeProjectId ?? null, utterance: said, at: Date.now(), reply, outcomes })
          // What gets read out, and only this: the one line meant for him, plus
          // anything it actually needs to ask. Not the drafted prompt (a page of
          // markdown), not `understood` (which is on screen right next to it),
          // and not the outcome chips — reading out what he can already see is
          // exactly the "on and on" he complained about.
          const parts = [reply.say, ...(reply.questions ?? [])].filter(Boolean)
          const answer = parts.join(' ')
          await speak(id, answer)
          return answer || reply.understood || ''
        })
        .catch(async (err: unknown) => {
          thinkingSince.current = null
          // An amber blip, and the conversation carries on. A brain that failed
          // is not a reason to stop listening to him.
          if (armedRef.current) flash('error', ERROR_MS)
          setTurns((prev) =>
            prev.map((t) =>
              t.id === id && t.kind === 'brain'
                ? { ...t, phase: 'error', error: err instanceof Error ? err.message : String(err) }
                : t
            )
          )
          // Never the same words twice running: this is the one line Forge
          // writes for itself often enough for the repetition to grate.
          const failed = pickVaried(BRAIN_FAILED, lastFailure.current)
          lastFailure.current = failed
          await speak(`${id}:error`, failed)
          return failed
        })
    },
    [brain, cancelAllHolds, flash, patchOutcome, project?.path, runActions, sayAloud, speaksAloud]
  )

  const handlePhrase = useCallback((said: string) => void runPhrase(said), [runPhrase])

  // One subscription for every source that ever registers with the bus — which
  // is how M3's dictation joins in without this component changing.
  useEffect(() => transcriptBus.onPhrase(handlePhrase), [handlePhrase])

  /* ------------------------------------------------------- the phone (M9) */

  /**
   * A message typed on the phone, answered by the same agent.
   *
   * Two levels, and the difference is honest rather than hidden. If the phone
   * names the project that is already open, this *is* the voice pipeline —
   * grammar, brain, executor, chips in the panel, memory written — and the
   * answer that comes back is the answer Forge gave. If it names any other
   * project, Forge cannot open its tabs from here: the executor drives the
   * panes of the active project only, and quietly running "open three
   * terminals" against the wrong project would be worse than saying no. So
   * that case goes to the brain with *that* project's memory, comes back with
   * words and any drafted brief, and says plainly what it did not do.
   *
   * It never speaks aloud. He is holding the phone, not sitting here.
   */
  const handleUtterance = useCallback(
    async (e: CompanionUtteranceEvent): Promise<void> => {
      const say = async (text: string): Promise<void> => {
        await window.forge.companion.reply(e.itemId, text.trim() || 'Done.')
      }
      const text = e.text.trim()
      if (!text) return

      // Level 1 — the project on screen. The whole pipeline, unchanged.
      if (project && e.projectId === project.id) {
        try {
          await say(await runPhrase(text, { silent: true }))
        } catch (err) {
          await say(`That did not work: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      // Level 2 — a project that is not open. Words, drafts and memory, but no
      // actions, and it says so instead of pretending.
      try {
        const memory = await agentMemory.prime(e.projectId)
        const reply = await brain.interpret(text, {
          projectName: e.projectName,
          recentTranscript: [text],
          manifest: manifestRef.current,
          projectMemory: memory
        })
        await say(companionReplyText(reply, e.projectName))
        void agentMemory.record({ projectId: e.projectId, utterance: text, at: Date.now(), reply })
      } catch (err) {
        await say(`The brain failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [brain, project, runPhrase]
  )

  useEffect(() => window.forge.companion.onUtterance((e) => void handleUtterance(e)), [handleUtterance])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [turns, open])

  useEffect(() => {
    if (open) composerRef.current?.focus()
  }, [open])

  /* ------------------------------------------------------------- resizing */

  const width = dragWidth ?? state.settings.voicePanelWidth

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = state.settings.voicePanelWidth
      let latest = startW

      const clamp = (n: number): number => Math.min(VOICE_PANEL_MAX, Math.max(VOICE_PANEL_MIN, n))
      const onMove = (ev: PointerEvent): void => {
        latest = clamp(startW + (startX - ev.clientX))
        setDragWidth(latest)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        setDragWidth(null)
        actions.setVoicePanelWidth(latest)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [actions, state.settings.voicePanelWidth]
  )

  /* --------------------------------------------------------------- panes */

  // Derived from the same numbered list the agent uses, so the popover and the
  // spoken "terminal two" can never disagree about which pane that is.
  const panesRef = useRef(panes)
  panesRef.current = panes
  const profilesRef = useRef(state.settings.agentProfiles)
  profilesRef.current = state.settings.agentProfiles
  const paneOptions = useCallback(
    (): PaneOption[] =>
      panesRef.current.map((p) => ({
        paneId: p.paneId,
        tabId: p.tabId,
        tabTitle: p.tabTitle,
        title: `${p.number}. ${p.title}`,
        profile: resolveProfile(profilesRef.current, p.profileId),
        status: terminalHost.runtime(p.paneId).status
      })),
    []
  )

  /** Type a draft into a pane. Never appends Enter — Steve presses that. */
  const sendToPane = useCallback(
    (option: PaneOption, text: string): void => {
      const body = text.replace(/[\r\n]+$/, '')
      if (!body.trim()) {
        actions.setNotice('Nothing to send — the draft is empty')
        return
      }
      const runtime = terminalHost.runtime(option.paneId)
      if (runtime.status !== 'live' && runtime.status !== 'starting') {
        actions.setNotice(`${option.title} has no live shell`)
        return
      }
      if (workspace && workspace.activeTabId !== option.tabId) actions.selectTab(option.tabId)
      actions.focusPane(option.paneId)
      terminalHost.paste(option.paneId, body)
      terminalHost.focus(option.paneId)
      actions.setNotice(`Draft typed into ${option.title} — press Enter there to run it`)
    },
    [actions, workspace]
  )

  /* ---------------------------------------------------------------- send */

  const submitPhrase = useCallback((): void => {
    const text = draftPhrase.trim()
    if (!text) return
    setDraftPhrase('')
    // Barge-in, the same move the button makes. The intake drops phrases that
    // arrive while Forge is talking, because a microphone hears Forge — but a
    // typed sentence is unambiguously him, and without this it vanished with
    // no chip and no error while the agent finished its own sentence.
    //
    // Through `voiceSpeaker`, not `speaker`: with the neural engine "it is
    // talking" begins a second or two before any sound, and only this stops the
    // sound, aborts the request in flight and discards a clip that lands late.
    if (speakingRef.current) {
      voiceSpeaker.cancel()
      speakingRef.current = false
      setSpeaking(false)
    }
    // Interrupting ends the sentence, so nothing that follows is an echo.
    speaker.forgetLastSpoken()
    lastTypedRef.current = text
    typedTranscript.push(text)
  }, [draftPhrase])

  /* --------------------------------------------------------------- render */

  if (!open) {
    // Stays mounted so the conversation survives a collapse.
    return <aside className="voice" data-open="false" aria-hidden="true" />
  }

  return (
    <aside className="voice" data-open="true" style={{ width }} aria-label="Voice agent">
      <div
        className="voice__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize voice panel"
        onPointerDown={onResizeDown}
        onDoubleClick={() => actions.setVoicePanelWidth(380)}
      />

      <header className="voice__head">
        <span className="voice__mark" title="The voice agent — say what you want and it does it">
          <Icon name="mic" size={14} />
        </span>
        <h2 className="voice__title">Voice Agent</h2>
        <BrainChip status={status} brainName={brain.name} />
        <span className="voice__spacer" />
        <ReplyModeToggle
          mode={replyMode}
          canSpeak={canSpeak}
          onPick={(next) => actions.patchSettings({ voiceReplyMode: next })}
        />
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Voice settings — brain, keys and model (Ctrl+,)"
          aria-label="Voice settings"
          onClick={() => actions.openSettings('models')}
        >
          <Icon name="gear" size={13} />
        </button>
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Hide the voice agent (Ctrl+Shift+G)"
          aria-label="Hide the voice agent"
          onClick={() => actions.toggleVoicePanel()}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      {/*
        Why the settings live elsewhere: this panel used to hold an expandable
        settings section, and scrolled down inside it there was no way back out —
        the gear that opened it was off the top of the panel and nothing else
        said "done". A one-line status that links to the real Settings page
        cannot trap anybody.
      */}
      {!status.ok ? (
        <button
          type="button"
          className="voice__degraded"
          onClick={() => actions.openSettings('models')}
          title="Open Models & APIs"
        >
          <span className="voice__degraded-text">
            {status.detail ?? 'No model key — spoken commands still work'}
          </span>
          <span className="voice__degraded-go">Set it up →</span>
        </button>
      ) : null}

      <AgentButton
        phase={phase}
        armed={armed}
        levelRef={levelRef}
        thinkingFor={thinkingFor}
        holding={holding}
        sttError={stt.error?.msg ?? null}
        onToggle={toggleAgent}
        onHold={cancelAllHolds}
      />

      {/*
        Voice-only mode is a different panel, not a decorated one. If the agent
        is talking to you, the transcript and the text box are just furniture in
        front of your terminals — so they go, and one line of status stays.
      */}
      {replyMode === 'voice' ? <LastLine turns={turns} /> : null}

      {/* Not `hidden`: .voice__log sets `display: flex`, which wins over the
          attribute's default `display: none`. Unmounting is unambiguous. */}
      {replyMode === 'voice' ? (
        <div className="voice__voiceonly">
          Spoken replies only. Switch to <span className="mono">Aa</span> in the header to see the conversation.
        </div>
      ) : (
      <div className="voice__log" ref={logRef}>
        {turns.length === 0 ? (
          <EmptyState
            icon="voice"
            size="sm"
            eyebrow={status.ok ? 'listening' : 'commands only'}
            title="Tell it what you want"
            body="Say “open three Kimi tabs” and it just does it — or describe what you want built and it drafts the prompt for you to fire at an agent."
          />
        ) : (
          turns.map((turn) =>
            turn.kind === 'note' ? (
              <NoteCard key={turn.id} turn={turn} />
            ) : turn.kind === 'command' ? (
              <CommandCard key={turn.id} turn={turn} />
            ) : (
              <TurnCard
                key={turn.id}
                turn={turn}
                paneOptions={paneOptions}
                onSend={sendToPane}
                onEdit={(draft) =>
                  setTurns((prev) =>
                    prev.map((t) => (t.id === turn.id && t.kind === 'brain' ? { ...t, draft } : t))
                  )
                }
              />
            )
          )
        )}
      </div>
      )}

      {replyMode !== 'voice' ? (
      <div className="voice__composer">
        <textarea
          ref={composerRef}
          className="voice__input"
          rows={2}
          spellCheck={false}
          placeholder="type what you'd say…"
          value={draftPhrase}
          onChange={(e) => setDraftPhrase(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submitPhrase()
            }
          }}
        />
        <div className="voice__composer-foot">
          <span className="voice__composer-hint">Enter to send · Shift+Enter for a new line</span>
          {/* "Say it" read like the agent would speak back. It does not — this
              is the same door the microphone uses, so it is just Send. */}
          <button
            type="button"
            className="cta-btn voice__say"
            disabled={!draftPhrase.trim()}
            onClick={submitPhrase}
          >
            Send
            <Icon name="send" size={13} />
          </button>
        </div>
      </div>
      ) : null}
    </aside>
  )
}

/* ------------------------------------------------------------- dispatch */

/**
 * Wait for a pane's shell to exist.
 *
 * Selecting a tab is a React state change: the pane mounts on the next render,
 * xterm is created, and only then does the PTY spawn and report `live`. Typing
 * into the gap would put the prompt nowhere at all, so this polls for a couple
 * of seconds — long enough for a cold pwsh, short enough to say so if the shell
 * never arrives.
 */
async function waitForShell(paneId: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = terminalHost.runtime(paneId).status
    if (status === 'live' || status === 'starting') return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => window.setTimeout(r, 80))
  }
}

/* ---------------------------------------------------------------- failures */

/**
 * A provider's error is a paragraph aimed at an agent; an outcome chip is one
 * line. Keep the first sentence — which is where the actual reason lives ("out
 * of quota", "refused the key") — and drop the advice that follows it.
 */
function mediaFailure(error: string): string {
  const first = (error ?? '').split('\n')[0]?.trim() || (error ?? '').trim() || 'Image generation failed'
  return first.length > 180 ? `${first.slice(0, 177)}…` : first
}

/* -------------------------------------------------------- reply mode */

const REPLY_MODES: Array<{ id: VoiceReplyMode; label: string; hint: string }> = [
  { id: 'text', label: 'Aa', hint: 'Written replies only' },
  { id: 'both', label: 'Aa+', hint: 'Written and spoken' },
  { id: 'voice', label: '♪', hint: 'Spoken only — hides the log and the text box' }
]

/** Three-way switch, in the header where the mic used to be. */
function ReplyModeToggle({
  mode,
  canSpeak,
  onPick
}: {
  mode: VoiceReplyMode
  canSpeak: boolean
  onPick: (mode: VoiceReplyMode) => void
}): ReactNode {
  return (
    <div className="replymode" role="group" aria-label="How the agent replies">
      {REPLY_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="replymode__btn"
          data-on={m.id === mode ? 'true' : undefined}
          aria-pressed={m.id === mode}
          disabled={m.id !== 'text' && !canSpeak}
          title={canSpeak ? m.hint : 'Nothing can speak — add a Gemini key, or install a Windows voice'}
          onClick={() => onPick(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** Voice-only mode's whole transcript: the most recent thing that happened. */
function LastLine({ turns }: { turns: Turn[] }): ReactNode {
  const last = turns[turns.length - 1]
  let text = 'Nothing yet — tap the circle and talk.'
  let tone: 'idle' | 'ok' | 'warn' = 'idle'
  if (last?.kind === 'command') {
    text = last.outcomes.map((o) => o.summary).join(' · ') || last.said
    tone = last.outcomes.every((o) => o.ok) ? 'ok' : 'warn'
  } else if (last?.kind === 'note') {
    text = last.said
    tone = last.tone
  } else if (last?.kind === 'brain') {
    text =
      last.phase === 'thinking'
        ? 'thinking…'
        : last.phase === 'error'
          ? (last.error ?? 'that failed')
          : (last.reply?.say ?? last.reply?.understood ?? '—')
    tone = last.phase === 'error' ? 'warn' : 'ok'
  }
  return (
    <div className="voice__lastline" data-tone={tone} title={text}>
      {text}
    </div>
  )
}

/* ----------------------------------------------------------- agent button */

/** What the circle says about itself, by state. */
const AGENT_LABEL: Record<AgentPhase, { title: string; sub: string }> = {
  off: { title: 'Agent', sub: 'Tap to talk to your agent' },
  warming: { title: 'Warming up', sub: 'loading the speech engine…' },
  listening: { title: 'Listening', sub: 'say what you want — tap to stop' },
  thinking: { title: 'Thinking', sub: 'working on it…' },
  speaking: { title: 'Speaking', sub: 'mic off while I talk — tap to interrupt' },
  replied: { title: 'Answered', sub: 'still listening' },
  error: { title: 'That failed', sub: 'still listening — try again' }
}

/**
 * The hero. One big round button that says, without a manual, "this is the
 * agent, and it is either on or it is not".
 *
 * The ring is driven straight from the mic level inside a rAF loop rather than
 * through React state: levels arrive ten times a second and the panel has a
 * conversation in it. Nothing here re-renders while you speak.
 */
function AgentButton({
  phase,
  armed,
  levelRef,
  thinkingFor,
  holding,
  sttError,
  onToggle,
  onHold
}: {
  phase: AgentPhase
  armed: boolean
  levelRef: React.RefObject<number>
  thinkingFor: number
  holding: number
  sttError: string | null
  onToggle: () => void
  onHold: () => number
}): ReactNode {
  const ringRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const ring = ringRef.current
    if (!ring) return undefined
    if (phase !== 'listening') {
      ring.style.transform = ''
      ring.style.opacity = ''
      return undefined
    }
    let raf = 0
    let smoothed = 0
    const frame = (t: number): void => {
      // A slow breathe underneath, so silence still looks alive.
      const breathe = 0.06 + 0.04 * Math.sin(t / 620)
      const level = Math.max(breathe, Math.min(1, levelRef.current * 1.9))
      smoothed += (level - smoothed) * 0.28
      ring.style.transform = `scale(${(1 + smoothed * 0.22).toFixed(3)})`
      ring.style.opacity = (0.35 + smoothed * 0.65).toFixed(3)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [phase, levelRef])

  const label = AGENT_LABEL[phase]
  // Never a silent dead circle: past five seconds it starts counting out loud.
  const sub =
    phase === 'thinking' && thinkingFor >= THINKING_PATIENCE_MS / 1000
      ? `still thinking… ${thinkingFor}s`
      : phase === 'error' && sttError
        ? sttError
        : label.sub

  return (
    <div className="agentdial" data-phase={phase}>
      <button
        type="button"
        className="agentdial__btn"
        data-phase={phase}
        aria-pressed={armed}
        aria-label={armed ? 'Stop talking to the agent' : 'Talk to your agent'}
        title={armed ? 'Agent mode is on — tap or press Esc to stop' : 'Tap to talk to your agent'}
        onClick={onToggle}
      >
        <span className="agentdial__ring" ref={ringRef} aria-hidden="true" />
        <span className="agentdial__spin" aria-hidden="true" />
        <span className="agentdial__core" aria-hidden="true">
          <Icon name={armed ? 'voice' : 'mic'} size={26} />
        </span>
      </button>
      <div className="agentdial__labels">
        <span className="agentdial__title">{label.title}</span>
        <span className="agentdial__sub">{sub}</span>
      </div>
      {holding > 0 ? (
        <button type="button" className="agentdial__hold" onClick={() => onHold()}>
          {holding === 1 ? 'Sending a prompt…' : `Sending ${holding} prompts…`} tap or say “wait” to hold
        </button>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- chip */

function BrainChip({ status, brainName }: { status: BrainStatus; brainName: string }): ReactNode {
  return (
    <span
      className="voice__chip"
      data-ok={status.ok ? 'true' : 'false'}
      title={`${brainName} brain — ${status.detail ?? brainStatusLabel(status)}`}
    >
      <span className="voice__chip-dot" />
      {brainStatusLabel(status)}
    </span>
  )
}

/* --------------------------------------------------------------- outcomes */

function OutcomeChips({ outcomes }: { outcomes: ActionOutcome[] }): ReactNode {
  return (
    <div className="voice__chips">
      {outcomes.map((outcome, i) => (
        <span key={i} className="action-chip" data-ok={outcome.ok ? 'true' : 'false'}>
          <Icon name={outcome.ok ? 'check' : 'close'} size={11} />
          {outcome.summary}
        </span>
      ))}
    </div>
  )
}

function CommandCard({ turn }: { turn: CommandTurn }): ReactNode {
  return (
    <article className="turn">
      <p className="turn__said">{turn.said}</p>
      <OutcomeChips outcomes={turn.outcomes} />
    </article>
  )
}

/** The agent speaking for itself — "held, nothing sent". */
function NoteCard({ turn }: { turn: NoteTurn }): ReactNode {
  return (
    <article className="turn turn--note" data-tone={turn.tone}>
      <p className="turn__note">{turn.said}</p>
    </article>
  )
}

/* ------------------------------------------------------------------- turn */

function TurnCard({
  turn,
  paneOptions,
  onSend,
  onEdit
}: {
  turn: BrainTurnState
  paneOptions: () => PaneOption[]
  onSend: (option: PaneOption, text: string) => void
  onEdit: (draft: string) => void
}): ReactNode {
  const sendRef = useRef<HTMLButtonElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(turn.draft).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  const options = pickerOpen ? paneOptions() : []

  return (
    <article className="turn">
      <p className="turn__said">{turn.said}</p>

      {turn.phase === 'thinking' ? (
        <div className="turn__reply turn__reply--thinking">
          <span className="turn__pending mono">thinking…</span>
        </div>
      ) : null}

      {turn.phase === 'error' ? (
        <div className="turn__reply turn__reply--error">
          <div className="eyebrow turn__label">Brain failed</div>
          <p className="turn__error mono">{turn.error}</p>
        </div>
      ) : null}

      {turn.phase === 'done' && turn.reply ? (
        <div className="turn__reply">
          <header className="turn__reply-head">
            <span className="eyebrow turn__label">What I understood</span>
            <span className="turn__confidence mono" data-level={turn.reply.confidence}>
              {turn.reply.confidence}
            </span>
          </header>
          <p className="turn__understood">{turn.reply.understood}</p>

          {turn.reply.say ? <p className="turn__say">{turn.reply.say}</p> : null}

          {turn.outcomes?.length ? <OutcomeChips outcomes={turn.outcomes} /> : null}

          {turn.reply.questions?.length ? (
            <>
              <div className="eyebrow turn__label">Questions</div>
              <ul className="turn__questions">
                {turn.reply.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          ) : null}

          {turn.reply.draftPrompt !== undefined || turn.draft ? (
            <>
              <div className="eyebrow turn__label">Draft prompt</div>
              <textarea
                className="turn__draft mono"
                spellCheck={false}
                value={turn.draft}
                onChange={(e) => onEdit(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />

              <div className="turn__actions">
                <button type="button" className="ghost-btn turn__action" onClick={copy}>
                  {copied ? <Icon name="check" size={13} /> : null}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  ref={sendRef}
                  type="button"
                  className="ghost-btn turn__action turn__action--send"
                  disabled={!turn.draft.trim()}
                  onClick={() => setPickerOpen(true)}
                >
                  Send to pane
                  <Icon name="send" size={13} />
                </button>
              </div>
            </>
          ) : null}

          <Popover
            anchor={sendRef.current}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            align="end"
            side="top"
            width={268}
            label="Send draft to pane"
          >
            <PopoverSection title="Send draft to">
              {options.length === 0 ? (
                <div className="popover__hint">No panes open in this project yet.</div>
              ) : (
                options.map((option) => {
                  const live = option.status === 'live' || option.status === 'starting'
                  return (
                    <PopoverRow
                      key={option.paneId}
                      disabled={!live}
                      onClick={() => {
                        onSend(option, turn.draft)
                        setPickerOpen(false)
                      }}
                    >
                      <AgentBadge profile={option.profile} size="sm" />
                      <span className="turn__pane-title truncate">{option.title}</span>
                      <span className="turn__pane-tab mono truncate">{option.tabTitle}</span>
                      {live ? null : <span className="turn__pane-dead mono">{option.status}</span>}
                    </PopoverRow>
                  )
                })
              )}
            </PopoverSection>
            <div className="popover__hint">Typed in without Enter — read it, then run it yourself.</div>
          </Popover>
        </div>
      ) : null}
    </article>
  )
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import { isShellProfile } from '@shared/agents'
import {
  isSttSetupError,
  type AgentProfile,
  type CompanionUtteranceEvent,
  type SttStatus,
  type VoiceAgentEvent,
  type VoiceReplyMode
} from '@shared/types'
import {
  agentBrainAvailable,
  interruptAgentBrain,
  onAgentBrainEvent,
  sendUtterance,
  startAgentBrain,
  stopAgentBrain
} from '@/lib/agentbrain'
import { registerVoiceAgentTools } from '@/lib/agenttools'
import { agentMemory } from '@/lib/agentmemory'
import { bargeIn } from '@/lib/bargein'
import { claimsCompletedAction, companionReplyText } from '@/lib/brainjson'
import { earconListening } from '@/lib/earcon'
import { speaker } from '@/lib/speech'
import { chooseEngine, pickVaried, takeSpeechChunks, voiceSpeaker, type VoiceConfig } from '@/lib/tts'
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
import { parseDictation, parseUtterance } from '@/lib/voicecommands'
import {
  getActiveBrain,
  type BrainContext,
  type BrainReply,
  type BrainStatus,
  type BrainTurn
} from '@/lib/voicebrain'
import { useActiveProject, useApp } from '@/state/AppState'

/**
 * The voice agent, as one engine.
 *
 * This used to live inside VoicePanel.tsx, which was fine while the panel was
 * the only place you could talk to it. It is not: the floating Voice Hub shows
 * the same conversation, the same round button and the same composer, and two
 * copies of that logic would mean two subscriptions to the transcript bus, two
 * sidecar re-arm loops and — the one Steve would actually hear — two voices
 * saying the same sentence over each other.
 *
 * So there is exactly one of everything, here, mounted once at the app root:
 *
 *   • one `transcriptBus.onPhrase` subscription
 *   • one `stt.onStatus` subscription and one re-arm effect
 *   • one `companion.onUtterance` subscription
 *   • one `sayAloud`, keyed by turn id, over `voiceSpeaker.speakOnce`
 *
 * Every surface — the right-hand panel, the floating pill, the hub card — is a
 * *view* of this. They render the same turns and call the same callbacks, so
 * having both open at once cannot double anything: there is nothing to double.
 *
 * Two paths through one input, unchanged from M4:
 *
 *  1. Commands ("open up three tabs of kimmy") are matched by the deterministic
 *     grammar and executed immediately, through the very same AppState actions
 *     the buttons use. No model, no key, no latency, works offline.
 *  2. Everything else goes to the active brain — Gemini when a key is set,
 *     otherwise the stub, which echoes and says so. A brain may return actions
 *     too; they run through the same executor, so it can never do more than the
 *     grammar could.
 *
 * Step 2 now forks, and the fork is the whole of what changed here:
 *
 *   • The JSON brains (gemini, openrouter, groq, stub) are unchanged. One
 *     request, one reply object, actions run through `runActions`, the words
 *     read out when it is all back.
 *   • The **claude** brain is a persistent Claude Agent SDK session in the main
 *     process (src/lib/agentbrain.ts). It streams, and it runs its own actions
 *     through the tool bridge (src/lib/agenttools.ts) rather than handing back
 *     a list for this file to execute. So it is routed *around* `interpret()`,
 *     not through it: a stream squeezed into a one-shot signature is a stream
 *     you have to wait for the end of, which is precisely the two-second
 *     silence sentence-by-sentence speech exists to remove.
 *
 * Both forks end at the same mouth and the same turn log, and the grammar still
 * runs first for both — an app command costs nothing whichever brain is on.
 */

interface TurnBase {
  id: string
  said: string
  at: number
}

export interface CommandTurn extends TurnBase {
  kind: 'command'
  actions: AppAction[]
  outcomes: ActionOutcome[]
}

export interface BrainTurnState extends TurnBase {
  kind: 'brain'
  phase: 'thinking' | 'done' | 'error'
  reply?: BrainReply
  error?: string
  /** The draft prompt as the user has edited it. */
  draft: string
  outcomes?: ActionOutcome[]
}

/** A one-line note from the agent itself — "held, nothing sent". */
export interface NoteTurn extends TurnBase {
  kind: 'note'
  tone: 'ok' | 'warn'
}

export type Turn = CommandTurn | BrainTurnState | NoteTurn

/**
 * One turn with the Claude session, while it is happening.
 *
 * Held in a ref and mutated by the event stream rather than kept in state:
 * every field here is written many times a second by `delta`, and none of it is
 * rendered from this object — what the card shows goes out through `onText`,
 * which is the caller's business, at the caller's pace.
 */
interface ClaudeRun {
  /** The turn id, which is also the mouth's dedupe key prefix. */
  id: string
  /** The phone: answered in text, never out loud. */
  silent: boolean
  /** Deltas that are not yet a whole sentence. Never spoken until they are. */
  buffer: string
  /** The authoritative text, one entry per assistant block. */
  said: string[]
  /** How many chunks have gone to the mouth, so no two share a key. */
  chunk: number
  /** Talked over. Nothing more from this turn reaches the mouth. */
  aborted: boolean
  onText?: (text: string) => void
  /** Why it ended badly, or null for the ordinary end. Undefined until it ends. */
  error?: string | null
  /** Resolves the moment the event stream has finished this turn. A turn that
   * is superseded is awaited on this before the next one is installed, so the
   * superseded turn's unwound `result` lands on *it*, not on the new turn. */
  done: Promise<void>
  /** Ends the turn. The first reason given wins; later ones are ignored. */
  finish: (error?: string) => void
}

/**
 * How long a single Claude turn may take before it is written off.
 *
 * Generous on purpose — the session can spend minutes on a real piece of work
 * and it is still talking to him about it. This is not a timeout in the usual
 * sense: it is the guarantee that `runPhrase` always resolves, because the
 * phone is waiting on that promise for its reply and a hung turn would leave
 * it waiting for ever.
 */
const CLAUDE_TURN_TIMEOUT_MS = 5 * 60_000

/**
 * How long a superseded turn's unwinding may take before the next turn is
 * installed anyway.
 *
 * When a new utterance supersedes one still with the model, `interruptAgentBrain`
 * unwinds the old turn — and the SDK reports that unwind as an error `result`
 * with no text. That result must land on the *old* run, not the new one, so the
 * new turn waits on the old run's `done` here. The wait is bounded: an
 * interrupt normally settles in a few hundred milliseconds, and a session that
 * emits nothing must not stall the new turn waiting for it.
 */
const INTERRUPT_UNWIND_MS = 5_000

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
export type AgentPhase = 'off' | 'warming' | 'listening' | 'thinking' | 'speaking' | 'replied' | 'error'

/**
 * How far the reply drops the instant somebody talks over it.
 *
 * Not zero. Silence would be indistinguishable from the agent having stopped,
 * and the whole point of ducking is that it is reversible — if the noise turns
 * out to have been a door, the sentence has to still be there to come back to.
 * A fifth of the volume is quiet enough to talk over comfortably and loud
 * enough to prove it did not crash. See src/lib/bargein.ts.
 */
const DUCK_LEVEL = 0.2

/** How long the flash states hold before falling back to listening. */
const REPLIED_MS = 900
const ERROR_MS = 1800
/** Silence counts as a dead circle after this, so start showing the clock. */
export const THINKING_PATIENCE_MS = 5000

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
 * Is this Escape ours to act on?
 *
 * Escape has to be listened for in the *capture* phase, because by the time it
 * has bubbled to the window a terminal or a text box has usually swallowed it —
 * which is how the voice agent's documented "Esc leaves the conversation" quietly
 * stopped working whenever the focus was in a pane.
 *
 * Capturing it, though, means taking it off whatever has focus, and Escape
 * inside a terminal belongs to the program running there: stealing it would
 * break vim, which is not a trade anybody would accept for a floating card. So
 * the rule is the obvious one — if you are typing in a terminal, Escape is the
 * terminal's; anywhere else (including inside the hub itself), it is ours.
 */
export function escapeIsOurs(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false
  const target = e.target
  if (!(target instanceof Element)) return true
  return !target.closest('.xterm') || !!target.closest('.vhub')
}

export interface PaneOption {
  paneId: string
  tabId: string
  tabTitle: string
  title: string
  profile: AgentProfile
  status: PaneStatus
}

export interface VoiceAgentCtx {
  /* ------------------------------------------------------------ the dial */
  phase: AgentPhase
  armed: boolean
  toggleAgent(): void
  /** Live mic level, read by the ring's rAF loop without re-rendering. */
  levelRef: RefObject<number>
  thinkingFor: number
  sttError: string | null
  /** Prompts counting down into a terminal, and the brake that holds them. */
  holding: number
  cancelAllHolds(): number

  /* --------------------------------------------------------- the log */
  turns: Turn[]
  editDraft(turnId: string, draft: string): void
  paneOptions(): PaneOption[]
  sendToPane(option: PaneOption, text: string): void

  /* ---------------------------------------------------- the composer */
  draftPhrase: string
  setDraftPhrase(text: string): void
  submitPhrase(): void

  /* ----------------------------------------------------------- status */
  brainName: string
  brainStatus: BrainStatus
  /**
   * `voiceClaudeModel`: which model the Claude session runs, as an alias rather
   * than a pinned id (see shared/types.ts). Only the Claude brain has one — the
   * others name their model in Settings — so a surface shows it off `brainName`.
   */
  brainModel: string
  setBrainModel(model: string): void
  replyMode: VoiceReplyMode
  setReplyMode(mode: VoiceReplyMode): void
  canSpeak: boolean
  /**
   * The sidecar is sitting on an open microphone waiting for "hey Jarvis"
   * rather than taking dictation. Together with `capturing` this is the whole
   * of what a surface needs to tell calm monitoring apart from active
   * listening — they look identical in `phase`, which says `listening` for both.
   */
  wakeMode: boolean
  /** Audio is actually going to the speech engine right now. */
  capturing: boolean
  /**
   * Buffer mode: every phrase is held verbatim and nothing is acted on until
   * "stop dictation" (or leaving the agent) lets it all out as one prompt.
   */
  dictating: boolean
  /** Everything held since dictation began, as one live string. */
  dictationBuffer: string
}

/**
 * Exported for one caller only: the overlay window (src/overlay/OverlayApp.tsx).
 *
 * The overlay is a second *renderer* showing this same conversation, and it
 * must never run a second engine — so instead of a provider it builds a
 * `VoiceAgentCtx` out of the snapshot relayed from this window and provides
 * *that*. Every part in VoiceSurface.tsx then works there unchanged, because
 * all of them take their data from the context and nothing else.
 *
 * Exporting the context rather than the provider is the point: there is no way
 * to get a second `VoiceAgentProvider` out of this module, so the overlay
 * cannot accidentally become an agent.
 */
export const VoiceAgentContext = createContext<VoiceAgentCtx | null>(null)

export function VoiceAgentProvider({ children }: { children: ReactNode }): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()

  const [turns, setTurns] = useState<Turn[]>([])
  const [draftPhrase, setDraftPhrase] = useState('')

  /** The last thing he typed, so echo rejection never eats his own keystrokes. */
  const lastTypedRef = useRef<string | null>(null)

  /* --------------------------------------------------------- agent mode
   *
   * One button, one idea: tap it and you are *in a conversation*. It arms
   * routing (while it is on and an agent surface is open, dictated phrases are
   * the agent's rather than the focused pane's — the rule lives in
   * useDictation), it starts the sidecar, and crucially it re-arms the sidecar
   * every time the engine's own silence timeout ends a phrase. Without that
   * last part the mic quietly dies after ten seconds and you are talking to
   * nobody.
   *
   * The engine is driven by IPC rather than through useDictation on purpose:
   * that hook owns the global dictation hotkey, and a second copy of it would
   * mean every press of Right Ctrl toggled twice and cancelled itself out.
   */

  const armed = state.agentListening
  const armedRef = useRef(armed)
  armedRef.current = armed

  /**
   * Always-listening, as a setting rather than as a session state.
   *
   * Read through a ref by everything that opens the microphone, so wake mode
   * cannot be on in Settings and off in the sidecar because one call site was
   * missed. It is deliberately *not* `armed && voiceWakeWord`: arming is a
   * `setState` and the tap that arms starts the sidecar in the same breath,
   * before `armed` has come back true.
   */
  const wakeWord = state.settings.voiceWakeWord
  const wakeWordRef = useRef(wakeWord)
  wakeWordRef.current = wakeWord

  /* ------------------------------------------------------------ dictation
   *
   * Buffer mode, toggled by voice ("start/stop dictation"). The refs are the
   * source of truth inside `runPhrase` and the state is the mirror for the
   * surfaces: `runPhrase` runs long after the render that set it, and a
   * `setState` that has not committed yet would re-buffer the very flush it
   * was told to make. The pair is why begin/end are one call, not two.
   */

  const [dictating, setDictating] = useState(false)
  const dictatingRef = useRef(false)
  const [dictationBuffer, setDictationBuffer] = useState('')
  const dictationBufferRef = useRef('')

  const beginDictation = useCallback(() => {
    dictatingRef.current = true
    setDictating(true)
  }, [])

  const endDictation = useCallback(() => {
    dictatingRef.current = false
    setDictating(false)
  }, [])

  const [phase, setPhase] = useState<AgentPhase>('off')
  const [stt, setStt] = useState<SttStatus>({ phase: 'off', level: 0, error: null, ready: false })
  const sttRef = useRef(stt)
  sttRef.current = stt
  const levelRef = useRef(0)
  /** Non-null while a phrase is with the brain. */
  const thinkingSince = useRef<number | null>(null)
  const [thinkingFor, setThinkingFor] = useState(0)
  const flashTimer = useRef<number | null>(null)
  const rearmTimer = useRef<number | null>(null)

  /* ------------------------------------------------------------ speaking */

  const replyMode = state.settings.voiceReplyMode
  const speaksAloud = replyMode !== 'text'
  const speaksAloudRef = useRef(speaksAloud)
  speaksAloudRef.current = speaksAloud

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
      edgeVoice: state.settings.voiceEdgeVoice,
      geminiVoice: state.settings.voiceTtsVoice,
      ttsModel: state.settings.voiceTtsModel,
      localVoice: state.settings.voiceReplyVoice
    }),
    [
      state.settings.voiceEngine,
      state.settings.geminiKey,
      state.settings.voiceEdgeVoice,
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
   * neural engine resolved the agent has a voice even on a machine with no
   * SAPI voices installed, and the reply-mode buttons must not be greyed out.
   */
  const canSpeak = speaker.available || chooseEngine(voiceConfig) !== 'local'

  /** True from just before the first syllable to just after the last. */
  const speakingRef = useRef(false)
  const [speaking, setSpeaking] = useState(false)

  /**
   * Whether to open the AEC'd microphone while speaking.
   *
   * Read through a ref so `sayAloud` is not rebuilt — and therefore the
   * transcript subscription not torn down — every time the switch is flipped.
   */
  const bargeInRef = useRef(state.settings.voiceBargeIn)
  bargeInRef.current = state.settings.voiceBargeIn

  // A reply that was mid-sentence when the switch went off should not be left
  // ducked at a fifth of its volume with nothing listening to bring it back.
  useEffect(() => {
    if (!state.settings.voiceBargeIn && bargeIn.running) {
      bargeIn.disarm()
      voiceSpeaker.duck(1)
    }
  }, [state.settings.voiceBargeIn])

  const noticeRef = useRef(actions.setNotice)
  noticeRef.current = actions.setNotice

  /**
   * Open the microphone the way this moment wants it opened.
   *
   * Every start the agent makes goes through here. Dictation's own start (the
   * hotkey, in useDictation) does not and must not: that one is push-to-talk
   * and passes no options at all, which is what keeps it bit-for-bit what it
   * always was.
   *
   * `conversation: true` is the whole of why the agent and dictation differ on
   * the same microphone: the sidecar waits out thinking pauses — a few seconds
   * of silence — before it decides the phrase is over, instead of cutting at
   * the ~1 s dictation gap that splits "go outside and open the Gemini app…
   * and make me some buses" into fragments. The agent gets the whole sentence;
   * dictation keeps its snappy cuts.
   */
  const startListening = useCallback((): void => {
    void window.forge.stt.start(
      wakeWordRef.current ? { mode: 'wake', conversation: true } : { conversation: true }
    )
  }, [])

  /**
   * The Claude turn in flight, if any. Declared here because the mouth's
   * barge-in handler has to be able to stop it — see `runMouth`.
   */
  const claudeRun = useRef<ClaudeRun | null>(null)

  /* --------------------------------------------------------------- the mouth
   *
   * One mouth, one queue, and the queue is what makes streaming possible.
   *
   * The JSON brains hand over a finished reply, so for them this is a queue of
   * one and behaves exactly as the old single-shot `sayAloud` did. The Claude
   * session streams, and chunks are pushed as sentences complete — so it starts
   * talking on the first sentence rather than after the last, while the
   * microphone stays shut and barge-in stays armed *for the whole reply* rather
   * than being torn down and rebuilt in the gap between sentences.
   */

  /** Chunks waiting their turn, in the order they must be said. */
  const speakQueue = useRef<{ key: string; text: string }[]>([])
  /** Set while more chunks may still arrive: the drain waits instead of ending. */
  const speakOpen = useRef(false)
  /** Wakes the drain the instant there is something to say. */
  const speakWake = useRef<(() => void) | null>(null)
  /** The running drain, so a caller can wait for the mouth to fall silent. */
  const speakRun = useRef<Promise<void> | null>(null)

  /** More is coming — hold the mouth open between chunks. */
  const openMouth = useCallback((): void => {
    speakOpen.current = true
  }, [])

  /** Nothing more is coming. The drain says what it has, then stops. */
  const closeMouth = useCallback((): void => {
    speakOpen.current = false
    speakWake.current?.()
  }, [])

  /** Barge-in: throw away everything not yet said. */
  const dropSpeech = useCallback((): void => {
    speakQueue.current = []
    speakOpen.current = false
    speakWake.current?.()
  }, [])

  /**
   * Say the queue, with the microphone shut for the duration.
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
  const runMouth = useCallback(async (): Promise<void> => {
    speakingRef.current = true
    setSpeaking(true)
    if (armedRef.current) setPhase('speaking')
    void window.forge.stt.stop()

    /*
     * Full duplex, the GPT-Live way.
     *
     * The sidecar is still stopped above — it has no echo cancellation and an
     * open one would transcribe this reply and answer it. What replaces it
     * for the duration is a *different* microphone: Chromium's, with the
     * WebRTC AEC on, which subtracts what the speakers are playing before we
     * see the signal. It transcribes nothing. It answers one question ten
     * times a second — is somebody talking? — and that is a question no
     * amount of Forge's own voice can make it answer wrong.
     *
     * So `speaking` stops meaning "deaf". Talking over the agent works the
     * way talking over a person works, which is the whole of what was asked
     * for. See src/lib/bargein.ts for the two thresholds.
     */
    let interrupted = false
    if (bargeInRef.current) {
      void bargeIn.arm({
        onDuck: () => voiceSpeaker.duck(DUCK_LEVEL),
        onRelease: () => voiceSpeaker.duck(1),
        onInterrupt: () => {
          interrupted = true
          voiceSpeaker.cancel()
          // The Claude session is still generating into a mouth that has
          // stopped. Kill the generation, not the session: the conversation
          // survives being talked over, this sentence does not — and the
          // sentences already queued behind it go with it, or he would be
          // answered a paragraph he interrupted ten seconds ago.
          const run = claudeRun.current
          if (run) run.aborted = true
          if (agentBrainAvailable()) void interruptAgentBrain().catch(() => undefined)
          dropSpeech()
          // The sentence was cut off, so nothing that follows is an echo of
          // it — the same reasoning as interrupting by typing, and without
          // this the echo guard would eat his first words for being too
          // similar to the reply he just talked over.
          speaker.forgetLastSpoken()
          // Hand the microphone straight back rather than waiting out the
          // re-arm debounce. He is already mid-sentence; every millisecond
          // here is a syllable of his that nothing is listening to.
          if (armedRef.current) startListening()
          // ...and in wake mode, handing it back is not enough: the session
          // that comes up is *monitoring*, so without this he would have to
          // say "hey Jarvis" again to finish the sentence he interrupted with.
          if (armedRef.current && wakeWordRef.current) wantFollowUp.current = true
        }
      })
    }

    try {
      for (;;) {
        if (interrupted) break
        const next = speakQueue.current.shift()
        if (!next) {
          if (!speakOpen.current) break
          // Nothing ready, but the turn is not over: wait for the next chunk
          // rather than shutting the mouth and re-opening it a beat later. The
          // timeout is a backstop — `closeMouth` and `pushSpeech` both wake it.
          await new Promise<void>((resolve) => {
            speakWake.current = resolve
            window.setTimeout(resolve, 120)
          })
          speakWake.current = null
          continue
        }
        // Keyed by turn (and by chunk within it): a re-render — or a second
        // surface showing the same conversation — cannot make it say the same
        // thing twice.
        await voiceSpeaker.speakOnce(next.key, next.text, voiceConfigRef.current, (msg) => noticeRef.current(msg))
      }
    } finally {
      bargeIn.disarm()
      speakQueue.current = []
      speakOpen.current = false
      // A short tail: the sidecar cuts a phrase on silence, so the last word
      // can land a beat after the audio stops.
      //
      // Skipped when he interrupted, and that exception is the point. There
      // is no trailing echo to wait out — the audio was cancelled — and 220ms
      // of deafness after somebody starts talking is 220ms taken off the
      // front of their sentence.
      if (!interrupted) await new Promise((r) => window.setTimeout(r, 220))
      speakingRef.current = false
      setSpeaking(false)
    }
  }, [dropSpeech, startListening])

  /**
   * Start the drain if it is not already running, and wake it if it is.
   *
   * The restart at the end matters: a chunk pushed during the 220ms tail would
   * otherwise sit in a queue nobody was draining any more.
   */
  const pump = useCallback((): void => {
    if (speakRun.current) {
      speakWake.current?.()
      return
    }
    speakRun.current = runMouth().finally(() => {
      speakRun.current = null
      if (speakQueue.current.length) pump()
    })
  }, [runMouth])

  /** Hand one finished chunk to the mouth. Silent when nothing can speak. */
  const pushSpeech = useCallback(
    (key: string, text: string): void => {
      if (!speaksAloudRef.current || !text.trim()) return
      if (!speaker.available && chooseEngine(voiceConfigRef.current) === 'local') return
      speakQueue.current.push({ key, text })
      pump()
    },
    [pump]
  )

  /** Say one whole thing and wait for it to be said. The one-shot brains' mouth. */
  const sayAloud = useCallback(
    async (key: string, text: string): Promise<void> => {
      if (!speaksAloud || !text.trim()) return
      pushSpeech(key, text)
      closeMouth()
      await speakRun.current
    },
    [closeMouth, pushSpeech, speaksAloud]
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
   *
   * OFF IN WAKE MODE, and that is the point of wake mode. A wake session never
   * auto-stops: the silence timeout ends the *capture* and the microphone stays
   * open, monitoring, for as long as the agent is armed. The sidecar loops
   * itself, so this poll would be a second thing starting sessions — and it is
   * this poll, cycling an idle engine through warming → listening every few
   * seconds, that turned the handover blip into the metronome described on
   * `HANDS_BACK`. The gate is on the *session's* mode rather than on the
   * setting, so the poll is still there to restart the sidecar after the mouth
   * stopped it (a stop drops the session back to `phrase`), which is what makes
   * wake mode survive every reply.
   */
  useEffect(() => {
    if (!armed || speaking) return undefined
    if (wakeWord && stt.mode === 'wake') return undefined
    if (stt.phase !== 'idle' && stt.phase !== 'off') return undefined
    if (stt.error && isSttSetupError(stt.error.kind)) return undefined
    const timer = window.setTimeout(() => startListening(), 260)
    rearmTimer.current = timer
    return () => window.clearTimeout(timer)
  }, [armed, speaking, startListening, stt.phase, stt.error, stt.mode, wakeWord])

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

  /*
   * There used to be a handover blip here — a 120 ms sine every time the phase
   * fell back to `listening` after a turn. It replaced a spoken announcement
   * and was an improvement on THAT, but in a real conversation "after a turn"
   * is after every single exchange, and Steve's verdict was "it keeps
   * beeping". A person you are talking to does not chime when they finish a
   * sentence. So the only blip left is the wake acknowledgment below — the one
   * sound that carries information he cannot see (a foot from the keyboard,
   * eyes elsewhere, did it hear "hey Jarvis" or not) and the only one that
   * fires because *he* did something rather than because a state machine
   * changed lanes.
   */

  /**
   * "Hey Jarvis" landed.
   *
   * Watched as a *change* in the count, never as a value: a wake is
   * instantaneous, there is no un-wake to pair it with, and the counter is the
   * only thing there is to latch onto (see SttStatus.wakeCount). The blip is the
   * same one the handover uses — it is the same promise, that the microphone is
   * his now — and unlike the poll-driven one it only ever sounds because
   * somebody said the words.
   */
  const lastWakeCount = useRef(stt.wakeCount ?? 0)
  useEffect(() => {
    const count = stt.wakeCount ?? 0
    if (count === lastWakeCount.current) return
    lastWakeCount.current = count
    if (!armedRef.current) return
    if (state.settings.voiceEarcons) earconListening()
    // Not while it is talking: the phase belongs to the reply until the mouth
    // is finished with it, and barge-in is what ends that.
    if (!speakingRef.current) setPhase('listening')
  }, [stt.wakeCount, state.settings.voiceEarcons])

  /**
   * The follow-up window.
   *
   * A conversation is not a series of unrelated commands, and having to say
   * "hey Jarvis" again to answer a question it just asked is the thing that
   * makes a wake word feel like a vending machine. So after a reply the sidecar
   * is told to capture once, without the wake word.
   *
   * Once, and never in a loop: a capture that hears nothing auto-stops back to
   * monitoring by itself, which is exactly the behaviour that makes this safe to
   * fire and forget. The flag is cleared before the call, so a status change
   * arriving mid-flight cannot fire a second one.
   */
  const wantFollowUp = useRef(false)
  useEffect(() => {
    if (!armed) {
      wantFollowUp.current = false
      return
    }
    if (!wantFollowUp.current || speaking) return
    if (stt.mode !== 'wake' || stt.phase !== 'listening' || stt.capturing) return
    wantFollowUp.current = false
    void window.forge.stt.capture()
  }, [armed, speaking, stt.mode, stt.phase, stt.capturing])

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
      // The same move as talking over it: whatever is still being generated
      // was going to be said out loud, and he has just said he does not want
      // to hear it.
      const run = claudeRun.current
      if (run) run.aborted = true
      if (agentBrainAvailable()) void interruptAgentBrain().catch(() => undefined)
      dropSpeech()
      speakingRef.current = false
      setSpeaking(false)
      return
    }
    const next = !armedRef.current
    actions.setAgentListening(next)
    if (next) {
      setPhase('warming')
      startListening()
    } else {
      thinkingSince.current = null
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = null
      if (rearmTimer.current) window.clearTimeout(rearmTimer.current)
      voiceSpeaker.cancel()
      dropSpeech()
      setPhase('off')
      void window.forge.stt.stop()
    }
  }, [actions, dropSpeech, startListening])

  /*
   * There used to be an auto-disarm here.
   *
   * The rule was "losing every agent surface disarms", and it made sense while
   * the agent was a thing you opened: with nothing on screen there was nowhere
   * for a phrase to go, so an armed agent with a docked hub would have been
   * sending every sentence into a terminal by surprise.
   *
   * It is deleted, because it directly contradicts what the agent is for now.
   * Steve: "everything that I say needs to go into forge... everything I say to
   * forge in the forge agent is meant for forge". The switch is the switch. It
   * is not undone by docking the hub, by closing the card, by clicking on
   * Chrome, or by minimising the app — all four of which used to silently stop
   * the agent listening, and three of which are things you do *because* you
   * want to carry on talking to it while you work somewhere else.
   *
   * So arming is now the only thing that arms and the button is the only thing
   * that disarms. `agentSurfaceOpen` still exists and still answers what it
   * always answered — is any of this on screen — it just no longer decides
   * whether the microphone is live — which is why this file no longer imports
   * it at all.
   */

  // Esc leaves the conversation — the same key that closes everything else.
  // Except while the hub card is open, where Esc means "collapse the card"
  // first; VoiceHub owns that press, and a second one lands here.
  const hubExpanded = state.settings.voiceHub.mode === 'expanded'
  // No `surfaceOpen` in the condition any more: the agent can be armed with the
  // hub docked now, and that is precisely the state you would most want one
  // keypress out of.
  useEffect(() => {
    if (!armed || hubExpanded) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (!escapeIsOurs(e)) return
      e.preventDefault()
      toggleAgent()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed, hubExpanded, toggleAgent])

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
        openrouterModel: state.settings.openrouterModel,
        groqKey: state.settings.groqKey,
        groqModel: state.settings.groqModel
      }),
    [
      state.settings.voiceBrain,
      state.settings.anthropicKey,
      state.settings.geminiKey,
      state.settings.geminiModel,
      state.settings.openrouterKey,
      state.settings.openrouterModel,
      state.settings.groqKey,
      state.settings.groqModel
    ]
  )
  const brainStatus: BrainStatus = brain.ready()
  const brainModel = state.settings.voiceClaudeModel

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
        return {
          ok: false,
          summary: `${label} would not take the text — is its shell still alive?`,
          requested: 1,
          done: 0
        }
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
        return {
          ok: true,
          summary: `${prefix} ${label} — held, not sent. Press Enter there yourself.`,
          requested: 1,
          done: 1
        }
      }
      if (!terminalHost.submit(pane.paneId)) {
        return {
          ok: false,
          summary: `${prefix} ${label}, but its shell went away before I could send it`,
          requested: 1,
          done: 0
        }
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

  /**
   * The app as a model should read it.
   *
   * One object, two readers. The JSON brains get it rendered into the ~3,000
   * token manifest below; the Claude session gets the *same* object rendered by
   * `buildStateSection` when it calls `get_app_state`. Two constructions of
   * "which pane is Terminal 2" would eventually disagree, and the whole point
   * of the numbering is that Steve, the model and the executor mean the same
   * pane by it.
   */
  const snapshot = useMemo<ManifestSnapshot>(() => {
    return {
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
        voiceHub: state.settings.voiceHub.mode,
        terminalFontSize: state.settings.terminalFontSize,
        shell: state.info?.shell ?? state.settings.shell
      }
    }
  }, [
    state.info,
    state.projects,
    state.settings.agentProfiles,
    state.settings.railCollapsed,
    state.settings.voiceHub.mode,
    state.settings.terminalFontSize,
    state.settings.shell,
    workspace,
    project?.id,
    paneCount
  ])
  // Read by the tool bridge, which is registered once and outlives every
  // render: a snapshot captured at registration time would be answering about a
  // Forge from ten minutes ago.
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const manifestRef = useRef<string>('')
  manifestRef.current = useMemo(() => buildManifest(snapshot), [snapshot])

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

  /* --------------------------------------------------------- claude session */

  /**
   * Which fork step 2 takes. Read through a ref by the intake, so changing the
   * brain in Settings does not tear down the transcript subscription.
   */
  const usingClaude = state.settings.voiceBrain === 'claude'
  const usingClaudeRef = useRef(usingClaude)
  usingClaudeRef.current = usingClaude

  const projectPathRef = useRef(project?.path ?? null)
  projectPathRef.current = project?.path ?? null
  const projectIdRef = useRef(project?.id ?? null)
  projectIdRef.current = project?.id ?? null

  /**
   * The brain's half of the conversation with the app.
   *
   * Registered once, at mount, with accessors rather than values — the session
   * outlives every render. It is registered whether or not claude is the
   * selected brain: the cost is one IPC subscription, and the alternative is a
   * tool bridge that arrives a render *after* the first utterance that needed
   * it.
   */
  useEffect(() => {
    if (!agentBrainAvailable()) return undefined
    return registerVoiceAgentTools({
      getSnapshot: () => snapshotRef.current,
      // Straight through the executor every other path uses — including the
      // grace beat on a submitted prompt, so a spoken "wait" holds the brain's
      // send_prompt exactly as it holds the grammar's.
      runAction: (action) =>
        runActions([action])[0] ?? {
          ok: false,
          summary: 'The executor was not ready — try that again',
          requested: 1,
          done: 0
        },
      getProjectMemory: () => agentMemory.prime(projectIdRef.current),
      // Written through the same append the learning loop uses, so there is
      // still exactly one writer to the file. It lands under preferences
      // because that is where an entry Steve actually asked for belongs — the
      // last thing pruning gives up — and re-priming afterwards keeps the warm
      // copy the other brains read in step with what is now on disk.
      remember: async (note) => {
        const projectId = projectIdRef.current
        if (!projectId) return false
        await window.forge.memory.append(projectId, 'preferences', note)
        await agentMemory.prime(projectId)
        return true
      }
    })
  }, [runActions])

  /**
   * The brain, as it happens.
   *
   * `delta` drives the mouth and nothing else; `assistant` is the authoritative
   * text and drives everything written down. That split is the contract in
   * src/lib/agentbrain.ts, and it matters: the deltas of a turn that also called
   * tools arrive in several runs, and treating any one `assistant` block as the
   * whole reply would silently drop the rest.
   */
  const handleBrainEvent = useCallback(
    (event: VoiceAgentEvent): void => {
      const run = claudeRun.current
      if (!run) return
      switch (event.type) {
        case 'delta': {
          if (run.silent || run.aborted) return
          run.buffer += event.text
          const { chunks, rest } = takeSpeechChunks(run.buffer)
          run.buffer = rest
          for (const chunk of chunks) {
            openMouth()
            pushSpeech(`${run.id}:s${run.chunk++}`, chunk)
          }
          return
        }
        case 'assistant':
          run.said.push(event.text)
          run.onText?.(run.said.join('\n'))
          return
        case 'tool':
          // Working, not talking. Only when the mouth is idle: a tool call in
          // the middle of a spoken reply must not blank the speaking phase.
          if (event.phase === 'start' && armedRef.current && !speakingRef.current) setPhase('thinking')
          return
        case 'result':
          // The SDK's own summary is the fallback, for the turn that acted and
          // said nothing — there is still something to tell the phone.
          if (!run.said.length && event.text.trim()) run.said.push(event.text.trim())
          // A turn HE ended is not a turn that failed. Interrupting — talking
          // over it, typing, tapping the button — unwinds the SDK's turn, and
          // the SDK reports that unwinding as an error result. Treating it as
          // one had the agent saying "that one did not go through, say it
          // again?" every single time Steve barged in, which he heard as the
          // brain failing constantly. It ended because he moved on: clean end.
          run.finish(run.aborted ? undefined : event.ok ? undefined : event.text.trim() || 'That turn did not come back')
          return
        case 'error':
          // Same shape: an error that lands on a turn he already cancelled is
          // the cancellation echoing back, not news worth speaking.
          run.finish(run.aborted ? undefined : event.message)
          return
      }
    },
    [openMouth, pushSpeech]
  )

  useEffect(() => {
    if (!agentBrainAvailable()) return undefined
    return onAgentBrainEvent(handleBrainEvent)
  }, [handleBrainEvent])

  /** True once a session has been opened and not yet stopped. */
  const sessionOpen = useRef(false)

  // Disarming ends the session. The next utterance opens a fresh one — a voice
  // agent nobody is talking to has no reason to hold a subprocess.
  useEffect(() => {
    if (armed || !sessionOpen.current) return
    sessionOpen.current = false
    void stopAgentBrain().catch(() => undefined)
  }, [armed])

  /**
   * One turn with the Claude session, start to finish.
   *
   * Resolves with what it said, once it has finished saying it — the same
   * contract `interpret()` + `speak()` gives the other fork, so `runPhrase`
   * treats both the same and the phone gets a real answer either way.
   */
  const runClaudeTurn = useCallback(
    async (
      id: string,
      said: string,
      opts: { silent?: boolean; onText?: (text: string) => void }
    ): Promise<string> => {
      if (!agentBrainAvailable()) {
        throw new Error('The voice session is unavailable — the preload bundle is stale. Rebuild and restart.')
      }
      // One session, one mouth: a turn that arrives while another is in flight
      // replaces it. The newer thing he said is the one he meant — so the old
      // one is unwound and settled with whatever it had managed to say, not
      // failed. It was superseded, which is not the same as broken, and the
      // difference is audible: a failure says so out loud.
      const previous = claudeRun.current
      if (previous) {
        previous.aborted = true
        await interruptAgentBrain().catch(() => undefined)
        // The SDK unwinds the superseded turn as an error result. That result
        // must land on IT, not on the new run below — the event handler reads
        // `claudeRun.current`, which is still `previous` until this await
        // returns. Waiting here is what stops a barge-in from killing the very
        // sentence that followed it. See INTERRUPT_UNWIND_MS.
        await Promise.race([
          previous.done,
          new Promise<void>((r) => window.setTimeout(r, INTERRUPT_UNWIND_MS))
        ])
        // A session that never emitted the unwind: settle it here so its own
        // turn resolves instead of hanging on a result that is not coming.
        if (previous.error === undefined) previous.finish()
      }

      let settle: (() => void) | null = null
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      const run: ClaudeRun = {
        id,
        silent: opts.silent === true,
        buffer: '',
        said: [],
        chunk: 0,
        aborted: false,
        onText: opts.onText,
        done,
        finish: (error?: string) => {
          if (run.error === undefined) run.error = error ?? null
          settle?.()
        }
      }
      claudeRun.current = run

      const watchdog = window.setTimeout(() => {
        if (agentBrainAvailable()) void interruptAgentBrain().catch(() => undefined)
        run.finish(run.aborted ? undefined : 'The brain did not come back')
      }, CLAUDE_TURN_TIMEOUT_MS)

      try {
        if (!sessionOpen.current) {
          sessionOpen.current = true
          try {
            // A session that could not be opened says so in its status rather
            // than throwing — and waiting five minutes for events that will
            // never come is not how he should find out.
            const status = await startAgentBrain(projectPathRef.current ?? undefined)
            if (status.error) throw new Error(status.error)
          } catch (err) {
            sessionOpen.current = false
            throw err
          }
        }
        await sendUtterance(said)
        await done
      } finally {
        window.clearTimeout(watchdog)
        if (claudeRun.current === run) claudeRun.current = null
        // Whatever was left in the buffer never made a full sentence. Say it
        // anyway: a reply that ends without a full stop is still a reply.
        const tail = run.buffer.trim()
        if (tail && !run.silent && !run.aborted) pushSpeech(`${run.id}:s${run.chunk++}`, tail)
        closeMouth()
        await speakRun.current
      }

      if (run.error) throw new Error(run.error)
      return run.said.join('\n').trim()
    },
    [closeMouth, pushSpeech]
  )

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

      // 0c — dictation. While it is on, nothing is acted on: every phrase is
      // held verbatim, and only "stop dictation" (or leaving the agent) lets
      // it out, all at once, through the exact pipeline below. This is what
      // stops a long prompt being cut into premature turns by the sidecar's
      // silence cuts. Phone messages ride `silent`, so they never enter the
      // buffer — he is dictating at the machine, not on the phone.
      if (!opts?.silent) {
        const dictCmd = parseDictation(said)
        if (dictatingRef.current) {
          if (dictCmd === 'stop') {
            const buffered = dictationBufferRef.current
            endDictation()
            setDictationBuffer('')
            if (buffered.trim()) return runPhrase(buffered)
            return ''
          }
          // A second "start" is a no-op: already holding.
          if (dictCmd === 'start') return ''
          const next = dictationBufferRef.current ? `${dictationBufferRef.current} ${said}` : said
          dictationBufferRef.current = next
          setDictationBuffer(next)
          return ''
        }
        if (dictCmd === 'start') {
          dictationBufferRef.current = ''
          setDictationBuffer('')
          beginDictation()
          setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'note', tone: 'ok' }])
          const line = 'Dictation on. Every word is held — say stop dictation to send it all.'
          void speak(`${id}:dictate`, line)
          return ''
        }
        // "stop dictation" when it is already off: say so once, on the card.
        if (dictCmd === 'stop') {
          setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'note', tone: 'warn' }])
          return 'Not in dictation.'
        }
      }

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
        setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'command', actions: hit.actions, outcomes }])
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

      /** What a failed turn looks like, whichever brain failed. */
      const failed = async (err: unknown): Promise<string> => {
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
        const line = pickVaried(BRAIN_FAILED, lastFailure.current)
        lastFailure.current = line
        await speak(`${id}:error`, line)
        return line
      }

      // 2a — the Claude session. It streams (so it is spoken sentence by
      // sentence, from here, as it is written) and it runs its own actions
      // through the tool bridge, so there is no actions array to execute and
      // nothing to contradict: `claimsCompletedAction` guards the JSON brains
      // against announcing an action they never sent, and a real tool call is
      // not that kind of claim.
      if (usingClaudeRef.current) {
        try {
          const text = await runClaudeTurn(id, said, {
            silent: opts?.silent,
            onText: (partial) =>
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === id && t.kind === 'brain'
                    ? { ...t, reply: { understood: partial, confidence: 'high' } }
                    : t
                )
              )
          })
          thinkingSince.current = null
          if (armedRef.current && !speaksAloud) flash('replied', REPLIED_MS)
          const reply: BrainReply = { understood: text, confidence: 'high' }
          setTurns((prev) =>
            prev.map((t) => (t.id === id && t.kind === 'brain' ? { ...t, phase: 'done', reply } : t))
          )
          void agentMemory.record({
            projectId: ctx?.activeProjectId ?? null,
            utterance: said,
            at: Date.now(),
            reply
          })
          // Hands-free follow-up: he answered a question, he can answer the
          // next one without saying the wake word again.
          if (!opts?.silent && wakeWordRef.current && armedRef.current) wantFollowUp.current = true
          return text
        } catch (err) {
          return failed(err)
        }
      }

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
          let outcomes = list.length ? runActions(list, (index, outcome) => patchOutcome(id, index, outcome)) : undefined
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
              t.id === id && t.kind === 'brain' ? { ...t, phase: 'done', reply, draft: reply.draftPrompt ?? '', outcomes } : t
            )
          )
          void agentMemory.record({
            projectId: ctx?.activeProjectId ?? null,
            utterance: said,
            at: Date.now(),
            reply,
            outcomes
          })
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
        .catch(failed)
    },
    [
      brain,
      cancelAllHolds,
      flash,
      patchOutcome,
      project?.path,
      runActions,
      runClaudeTurn,
      sayAloud,
      speaksAloud
    ]
  )

  const handlePhrase = useCallback((said: string) => void runPhrase(said), [runPhrase])

  // One subscription for every source that ever registers with the bus — which
  // is how dictation joins in without any surface changing. It is registered
  // here, once, rather than in a panel: two subscriptions would run every phrase
  // through the brain twice and speak both answers.
  useEffect(() => transcriptBus.onPhrase(handlePhrase), [handlePhrase])

  // Leaving the agent mid-dictation must not lose what was held: it goes out as
  // one last prompt, because a conversation he was composing when he tapped
  // "stand down" is still a conversation he was having.
  useEffect(() => {
    if (armed || !dictatingRef.current) return
    const buffered = dictationBufferRef.current
    endDictation()
    setDictationBuffer('')
    if (buffered.trim()) void runPhrase(buffered)
  }, [armed, endDictation, runPhrase])

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

        // The Claude session has no `interpret()` to call — it is a
        // conversation, not a request — so the same caveat is put to it in
        // words, at the top of the message. It has the tools to act, and the
        // sentence is what stops it acting on the wrong project's terminals.
        if (usingClaudeRef.current) {
          const answer = await runClaudeTurn(
            makeId('turn'),
            `[From Steve's phone, about the project "${e.projectName}". That project is NOT the one open in Forge, ` +
              `so do not open, close or type into any terminal — the panes you can see belong to a different project. ` +
              `Answer in words, and say plainly if something has to wait until he opens it.]\n\n${text}`,
            { silent: true }
          )
          await say(answer)
          void agentMemory.record({
            projectId: e.projectId,
            utterance: text,
            at: Date.now(),
            reply: { understood: answer, confidence: 'high' }
          })
          return
        }

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
    [brain, project, runClaudeTurn, runPhrase]
  )

  useEffect(() => window.forge.companion.onUtterance((e) => void handleUtterance(e)), [handleUtterance])

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

  const editDraft = useCallback((turnId: string, draft: string): void => {
    setTurns((prev) => prev.map((t) => (t.id === turnId && t.kind === 'brain' ? { ...t, draft } : t)))
  }, [])

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
      // And stop what is still being written, for the same reason: he has
      // moved on, and the rest of that reply was only ever going to be said
      // out loud over the top of his next one.
      const run = claudeRun.current
      if (run) run.aborted = true
      if (agentBrainAvailable()) void interruptAgentBrain().catch(() => undefined)
      dropSpeech()
      speakingRef.current = false
      setSpeaking(false)
    }
    // Interrupting ends the sentence, so nothing that follows is an echo.
    speaker.forgetLastSpoken()
    lastTypedRef.current = text
    typedTranscript.push(text)
  }, [draftPhrase, dropSpeech])

  const setReplyMode = useCallback(
    (mode: VoiceReplyMode) => actions.patchSettings({ voiceReplyMode: mode }),
    [actions]
  )

  // Nothing to restart here: the host reads the setting again at the next turn
  // boundary (electron/voice-agent/host.ts), so switching mid-sentence lets the
  // sentence finish in the model that started it.
  const setBrainModel = useCallback(
    (model: string) => actions.patchSettings({ voiceClaudeModel: model }),
    [actions]
  )

  const value = useMemo<VoiceAgentCtx>(
    () => ({
      phase,
      armed,
      toggleAgent,
      levelRef,
      thinkingFor,
      sttError: stt.error?.msg ?? null,
      holding,
      cancelAllHolds,
      turns,
      editDraft,
      paneOptions,
      sendToPane,
      draftPhrase,
      setDraftPhrase,
      submitPhrase,
      brainName: brain.name,
      brainStatus,
      brainModel,
      setBrainModel,
      replyMode,
      setReplyMode,
      canSpeak,
      // Straight off the sidecar's status rather than off the setting: what a
      // surface has to draw is what the microphone is actually doing, and the
      // two differ for a beat every time a session is opened or closed.
      wakeMode: stt.mode === 'wake',
      capturing: stt.capturing ?? stt.phase === 'listening',
      dictating,
      dictationBuffer
    }),
    [
      phase,
      armed,
      toggleAgent,
      thinkingFor,
      stt.error,
      holding,
      cancelAllHolds,
      turns,
      editDraft,
      paneOptions,
      sendToPane,
      draftPhrase,
      submitPhrase,
      brain.name,
      brainStatus,
      brainModel,
      setBrainModel,
      replyMode,
      setReplyMode,
      canSpeak,
      stt.mode,
      stt.capturing,
      stt.phase,
      dictating,
      dictationBuffer
    ]
  )

  return <VoiceAgentContext.Provider value={value}>{children}</VoiceAgentContext.Provider>
}

export function useVoiceAgent(): VoiceAgentCtx {
  const ctx = useContext(VoiceAgentContext)
  if (!ctx) throw new Error('useVoiceAgent must be used inside <VoiceAgentProvider>')
  return ctx
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

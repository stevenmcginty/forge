import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ClaudePermissionMode, LayoutNode, PaneLeaf } from '@shared/types'
import type { EffortLevel } from '@shared/agents'
import {
  agentModels,
  commandExe,
  effortLevels,
  effortRefusal,
  effortSlash,
  matchAgentModel,
  modePickerSlash,
  modeRefusal,
  modelRefusal,
  modelSlash,
  permissionModes,
  permissionSpec,
  tabsToPermissionMode
} from '@shared/agents'
import { badgeColor, isShellProfile, resolveProfile } from '@/lib/agents'
import { noKeys, optionKeys, readPaneAsk, sendAnswerKeys } from '../lib/answer-send'
import {
  isDictationSupported,
  startRecording,
  transcribeOnDesktop,
  type Recording,
  type VoiceMode,
  type VoiceState
} from '../lib/dictate'
import { isImageFile, uploadFileChunks } from '../lib/file'
import { packImage } from '../lib/image'
import { useMobile } from '../lib/mobile'
import { requestPaneView, usePaneStatus, usePaneView, type PaneFace } from '../lib/pane-status'
import { getClaudeView, setClaudeView } from '../lib/view-pref'
import { matchVoiceCommand, type VoiceCommandMatch } from '../lib/voice-commands'
import { watchLevel, type LevelMonitor } from '../lib/voice-level'
import { getVoiceAutoStop } from '../lib/voice-prefs'
import type { PermissionMode } from '@/lib/rich'
import { onDraftInsert, useForge, useProfiles, useWorkspace } from '../state'
import { AgentStatus } from './AgentStatus'
import { AnswerCard } from './AnswerCard'
import { BACK_TAB, Composer, type VoiceControls } from './Composer'
import { ModelChip } from './ModelChip'
import { ListenSwitch } from '../deck/ListenSwitch'

/**
 * The one text box for this browser, with the agent's status strip over it.
 *
 * Panes paint the terminal; this is the app's input. It always talks to the
 * focused pane — the same pane a click in the display selects — so a split
 * still has one box, not one per sliver. Each pane keeps its own draft, so
 * switching panes mid-sentence does not hand the sentence to another agent.
 */

/** How long the TUI gets to finish taking a pasted image path before the words arrive. */
const SETTLE_AFTER_IMAGE_MS = 400
/** The gap between the words and the Enter that sends them. */
const SETTLE_BEFORE_ENTER_MS = 120
/** The gap between Shift+Tab presses while walking a permission cycle. */
const SETTLE_BETWEEN_TABS_MS = 80

/** The Forge rung the status strip is reporting, plus Claude's extra `auto`. */
function liveRung(mode: PermissionMode | undefined): ClaudePermissionMode | 'auto' | null {
  if (mode === 'default' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'accept-edits') return 'acceptEdits'
  if (mode === 'auto') return 'auto'
  return null
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Interrupt: what `esc to interrupt` asks for, on every agent the strip reads busy. */
const ESC = '\x1b'

/** The most a round trip to the desktop's ears may take before the button gives up. */
const TRANSCRIBE_TIMEOUT_MS = 75_000

/** How long dictated words sit in the box, with Undo, before they send. */
const REVIEW_MS = 1500

const IDLE: VoiceState = { phase: 'idle' }
const KEYS_PREF = 'forge.phone.terminal-keys'

function savedKeysShown(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(KEYS_PREF) === 'shown'
  } catch {
    return false
  }
}

/** Foreman states in which it is driving the pane and takes words in its ear. */
const FOREMAN_DRIVING = new Set(['starting', 'driving', 'waiting'])

function findLeaf(node: LayoutNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.a, id) ?? findLeaf(node.b, id)
}

function countLeaves(node: LayoutNode): number {
  return node.type === 'leaf' ? 1 : countLeaves(node.a) + countLeaves(node.b)
}

export function SessionComposer({
  face,
  lead
}: {
  /**
   * The desktop-browser face (web/src/deck): the box becomes the deck's one-row
   * bar, led by `lead` (the project pill) and the Listen switch. Absent: the
   * phone, exactly as before.
   */
  face?: 'deck'
  lead?: ReactNode
} = {}): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const mobile = useMobile()

  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  const paneId = tab?.activePaneId ?? null
  const alive = paneId !== null && (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  const canType = live && alive && paneId !== null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(profiles, leaf.profileId) : null
  const status = usePaneStatus(paneId)
  const view = usePaneView(paneId)
  const project = state.picture?.projects?.find((p) => p.id === state.projectId)?.name ?? ''
  const asking = paneId !== null && state.asking.has(paneId)
  const prompt = paneId ? (state.prompts[paneId] ?? '') : ''
  const busy = Boolean(status?.busy)
  const isAgent = Boolean(profile && !isShellProfile(profile))
  /** Claude Code and Gemini CLI pick a numbered row on its digit; the rest walk to it. */
  const exe = profile ? commandExe(profile.command) : ''
  const digits = exe === 'claude' || exe === 'gemini'
  const foreman = paneId ? state.picture?.foreman?.[paneId] : undefined
  /** Foreman is driving this pane: the box talks to Foreman, not to the PTY. */
  const foremanOn = Boolean(foreman && FOREMAN_DRIVING.has(foreman.status))

  /*
   * One draft per pane. The ref is the same map, kept current the instant it
   * is written, for the async voice and send paths that outlive a render.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftsRef = useRef(drafts)
  const draft = paneId ? (drafts[paneId] ?? '') : ''
  const setDraftFor = useCallback((pane: string, value: string) => {
    draftsRef.current = { ...draftsRef.current, [pane]: value }
    setDrafts((all) => (all[pane] === value ? all : { ...all, [pane]: value }))
  }, [])

  /** A send in flight: Send stays disabled until the upload and the write are done. */
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null)
  const sendingRef = useRef(false)

  const [voice, setVoiceState] = useState<VoiceState>(IDLE)
  const voiceRef = useRef<VoiceState>(IDLE)
  const setVoice = useCallback((next: VoiceState) => {
    voiceRef.current = next
    setVoiceState(next)
  }, [])
  /**
   * Why the last dictation came to nothing, kept until the next one starts, so
   * the deck's Listen switch can say "failed" and "Why?". The notice is raised
   * exactly as before; this only remembers its words.
   */
  const [voiceFault, setVoiceFault] = useState<string | null>(null)
  const voiceFailed = useCallback(
    (message: string) => {
      setVoiceFault(message)
      actions.setNotice(message)
    },
    [actions]
  )
  const recording = useRef<Recording | null>(null)
  /** The recording's loudness, for the meter, the silence check and auto-stop. */
  const levelRef = useRef<LevelMonitor | null>(null)
  const [voiceLevel, setVoiceLevel] = useState<LevelMonitor | null>(null)
  /** Bumped whenever a round trip is abandoned, so a late answer cannot repaint the button. */
  const voiceRun = useRef(0)
  /** The microphone is being opened (the browser may be asking permission). */
  const starting = useRef(false)
  /** A stop or cancel that arrived while the microphone was still opening. */
  const pendingEnd = useRef<'stop' | 'cancel' | null>(null)
  /** The press that started this recording is being held (hold-to-talk). */
  const holdRef = useRef(false)
  const reviewTimer = useRef(0)
  /** Bumped to focus the box — only ever after a gesture. */
  const [focusSignal, setFocusSignal] = useState(0)

  /*
   * A skill or command tapped in the project sheet: "/name " goes to the front
   * of this pane's draft (a slash command only means anything first), taking
   * the place of one already there, and the box takes focus so it can be read,
   * finished and sent.
   */
  useEffect(
    () =>
      onDraftInsert((text) => {
        if (!paneId) return false
        const before = draftsRef.current[paneId] ?? ''
        const rest = before.replace(/^\s+/, '').replace(/^\/\S+\s*/, '')
        setDraftFor(paneId, rest ? `${text.replace(/\s*$/, ' ')}${rest}` : text)
        setFocusSignal((n) => n + 1)
        return true
      }),
    [paneId, setDraftFor]
  )

  /**
   * Stop was pressed and the agent has not stopped yet. Cleared by the strip
   * reading idle — the only proof an interrupt landed — or by a pane change.
   */
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!busy) setStopping(false)
  }, [busy])
  useEffect(() => setStopping(false), [paneId])

  /*
   * A desktop moves the focus into the box when the pane changes under it; a
   * phone never does, because there that pops the keyboard over what Steve
   * was reading. Never on mount or reconnect — only on a real pane change.
   */
  const shownPane = useRef<string | null>(null)
  useEffect(() => {
    const was = shownPane.current
    shownPane.current = paneId
    if (!mobile && was !== null && paneId !== null && was !== paneId) setFocusSignal((n) => n + 1)
  }, [paneId, mobile])

  const takePane = useCallback(() => {
    if (paneId && canType) actions.claim(paneId)
  }, [actions, canType, paneId])

  const sendFile = useCallback(
    async (file: File, pane: string) => {
      try {
        if (isImageFile(file)) {
          try {
            const packed = await packImage(file)
            const result = await actions.request({
              kind: 'paste-image',
              sessionId: pane,
              mime: packed.mime,
              data: packed.data
            })
            if (result.kind === 'failed') actions.setNotice(result.message)
            return
          } catch {
            // If downscaling failed, fall back to chunked file upload
          }
        }
        await uploadFileChunks(file, pane, actions.request)
      } catch (err) {
        actions.setNotice(err instanceof Error ? err.message : `Could not send "${file.name}".`)
      }
    },
    [actions]
  )

  /**
   * Words and attachments to the pane — or, while Foreman drives it, words to
   * Foreman. One send at a time: `sending` holds the button until the upload
   * and the write are both done, so a second tap cannot send it twice.
   */
  const sendText = useCallback(
    async (raw: string, files: File[]) => {
      if (!canType || !paneId) return
      const text = raw.replace(/\s+$/, '')
      if (!text && !files.length) return
      if (sendingRef.current) return
      sendingRef.current = true
      setSending({ done: 0, total: files.length })
      try {
        if (foremanOn) {
          // Foreman is typing into this pane; raw bytes from here would land
          // in the middle of its work. Words go in its ear instead.
          if (files.length) actions.setNotice('Foreman takes words only — the attachment was not sent.')
          if (text) {
            const refused = await actions.foremanSay(paneId, text)
            if (refused) {
              actions.setNotice(refused)
              if (!draftsRef.current[paneId]) setDraftFor(paneId, text)
            }
          }
          return
        }
        // Attachments first: the TUI takes each as a paste into its own box, and the
        // words after it become the message that refers to them.
        if (files.length) {
          for (let i = 0; i < files.length; i++) {
            setSending({ done: i + 1, total: files.length })
            await sendFile(files[i]!, paneId)
          }
          // The TUI is still taking the pasted path into its box; words landing
          // in the same instant get folded into that paste.
          await pause(SETTLE_AFTER_IMAGE_MS)
        }
        if (text) {
          // A newline in this box is a line in the prompt, not a submit. Bracketed
          // paste is how the TUI takes a multi-line draft as one message; a bare
          // `\n` down the PTY is Enter, and would send the first line alone.
          actions.write(paneId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
          // Enter is its own keystroke, a beat after the words — never in the
          // same write. Claude Code's input reads one burst holding text and a
          // `\r` as a paste and turns the `\r` into a newline, so the message sat
          // in its box unsent. The desktop's own `submit()` keeps the carriage
          // return separate for the same reason.
          // A beat on the phone is not a beat at the desktop: a tunnel stall
          // holds the words and lets the Enter catch up, and the two land in
          // one burst. So the Enter waits for the desktop's answer to a claim
          // sent after the words — frames are handled in order, so an answer
          // means the words are already in the pane — and only then its beat.
          await actions.request({ kind: 'claim', sessionId: paneId })
          await pause(SETTLE_BEFORE_ENTER_MS)
          actions.write(paneId, '\r')
        }
        takePane()
      } finally {
        sendingRef.current = false
        setSending(null)
      }
    },
    [actions, canType, foremanOn, paneId, sendFile, setDraftFor, takePane]
  )

  /** The review countdown is over or overtaken: no timer, and the phase says so. */
  const endReview = useCallback(() => {
    window.clearTimeout(reviewTimer.current)
    if (voiceRef.current.phase === 'review') setVoice(IDLE)
  }, [setVoice])

  /** Send: the draft is taken and the box cleared at once, before any upload. */
  const sendDraft = useCallback(
    (files: File[]) => {
      if (!canType || !paneId || sendingRef.current) return
      endReview()
      const text = draftsRef.current[paneId] ?? ''
      setDraftFor(paneId, '')
      void sendText(text, files)
    },
    [canType, endReview, paneId, sendText, setDraftFor]
  )

  const sendRaw = useCallback(
    (data: string) => {
      if (!canType || !paneId || !data) return
      actions.write(paneId, data)
      takePane()
    },
    [actions, canType, paneId, takePane]
  )

  /**
   * What the async voice path needs to know *now*, not at the render that
   * started it: a transcription takes seconds, and the pane, its busy state
   * and its question can all move in that time.
   */
  const latest = useRef({
    canType,
    paneId,
    busy,
    asking,
    prompt,
    digits,
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
    sendDraft,
    sendRaw
  })
  latest.current = {
    canType,
    paneId,
    busy,
    asking,
    prompt,
    digits,
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
    sendDraft,
    sendRaw
  }

  /**
   * A dictation that was a command: act on it and say what was heard. The
   * notice is the only proof on a phone that "stop" was not typed.
   */
  const runVoiceCommand = useCallback(
    ({ command, heard }: VoiceCommandMatch) => {
      const now = latest.current
      const said = `Heard “${heard}”`
      if (command.kind === 'stop') {
        now.sendRaw(ESC)
        setStopping(true)
        actions.setNotice(`${said} — stopped`)
        return
      }
      if (command.kind === 'tab') {
        const tabs = now.tabs
        const at = tabs.findIndex((t) => t.id === now.activeTabId)
        if (tabs.length < 2 || at < 0) {
          actions.setNotice(`${said} — there is only one tab`)
          return
        }
        const next = tabs[(at + command.step + tabs.length) % tabs.length]!
        void actions.layout({ op: 'select-tab', tabId: next.id })
        actions.setNotice(`${said} — ${next.title || 'next tab'}`)
        return
      }
      const ask = readPaneAsk(now.paneId ?? '', now.prompt)
      const pick = command.kind === 'no' ? noKeys(ask, now.digits) : optionKeys(ask, command.n, now.digits)
      if (!pick) {
        actions.setNotice(`${said} — this question has no option ${command.kind === 'option' ? command.n : ''}`.trim())
        return
      }
      void sendAnswerKeys(pick.keys, now.sendRaw)
      actions.setNotice(`${said} — chose ${pick.label}`)
    },
    [actions]
  )

  /** Words in the box, a 1.5 s countdown, then the same send a tap on Send makes. */
  const startReview = useCallback(
    (pane: string, text: string) => {
      window.clearTimeout(reviewTimer.current)
      setVoice({ phase: 'review', text, endsAt: Date.now() + REVIEW_MS })
      reviewTimer.current = window.setTimeout(() => {
        if (voiceRef.current.phase !== 'review') return
        setVoice(IDLE)
        const now = latest.current
        if (!now.canType || now.paneId !== pane) {
          actions.setNotice('Not sent — the words are waiting in the box.')
          return
        }
        now.sendDraft([])
      }, REVIEW_MS)
    },
    [actions, setVoice]
  )

  /** Undo: no send; the words stay in the box, and the box takes the focus to edit them. */
  const undoReview = useCallback(() => {
    if (voiceRef.current.phase !== 'review') return
    window.clearTimeout(reviewTimer.current)
    setVoice(IDLE)
    setFocusSignal((n) => n + 1)
  }, [setVoice])

  /** Let go of the microphone and its meter, without deciding what happens to the audio. */
  const dropLevel = useCallback(() => {
    levelRef.current?.close()
    levelRef.current = null
    setVoiceLevel(null)
  }, [])

  /**
   * The mic, stopped: this browser's microphone, the desktop's ears.
   *
   * The audio goes to the desktop as `dictate` chunks and the words come back.
   * Nothing is recognised in the browser (the Web Speech API was, and went
   * silent on Android as often as it worked) and nothing needs the desktop's
   * own microphone, which is the one the CLIs' `/voice` listens to and is
   * miles from a phone.
   *
   * A recording that never came near speech is not uploaded — that is the
   * Bluetooth-routed mic, which Whisper hears as "Thank you." A short whole
   * utterance that is a command ("stop", "yes", "option two") acts at once.
   * Anything else lands in the box for REVIEW_MS with Undo, then sends.
   */
  const finishVoice = useCallback(async () => {
    const current = recording.current
    recording.current = null
    const monitor = levelRef.current
    levelRef.current = null
    setVoiceLevel(null)
    const pane = latest.current.paneId
    if (!current || !pane) {
      monitor?.close()
      // Released before the microphone had even opened: stop it the moment it does.
      if (starting.current) pendingEnd.current = 'stop'
      else if (voiceRef.current.phase !== 'review') setVoice(IDLE)
      return
    }
    const run = ++voiceRun.current
    const stillMine = (): boolean => voiceRun.current === run
    setVoice({ phase: 'transcribing', startedAt: Date.now() })
    let reviewing = false
    try {
      const audio = await current.stop()
      const silent = monitor?.silent() ?? false
      monitor?.close()
      if (!stillMine()) return
      if (audio.size === 0) {
        voiceFailed('Nothing was recorded.')
        return
      }
      if (silent) {
        voiceFailed('I heard nothing — check the mic (is it on Bluetooth?)')
        return
      }
      const text = await Promise.race([
        transcribeOnDesktop(audio, pane, actions.request),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('The desktop took too long to answer.')), TRANSCRIBE_TIMEOUT_MS)
        )
      ])
      if (!stillMine()) return
      if (!text) {
        voiceFailed('The desktop heard nothing in that.')
        return
      }
      const now = latest.current
      if (now.paneId !== pane) return
      const command = matchVoiceCommand(text, { busy: now.busy, asking: now.asking })
      if (command) {
        runVoiceCommand(command)
        return
      }
      const before = draftsRef.current[pane] ?? ''
      const words = before.trim() ? `${before.replace(/\s+$/, '')} ${text}` : text
      setDraftFor(pane, words)
      reviewing = true
      startReview(pane, words)
    } catch (err) {
      if (stillMine()) voiceFailed(err instanceof Error ? err.message : 'Dictation failed.')
    } finally {
      if (stillMine() && !reviewing) setVoice(IDLE)
    }
  }, [actions, runVoiceCommand, setDraftFor, setVoice, startReview, voiceFailed])
  const finishVoiceRef = useRef(finishVoice)
  finishVoiceRef.current = finishVoice

  /** A press on an idle mic: open the microphone and record. */
  const startVoice = useCallback(async () => {
    const pane = latest.current.paneId
    if (!latest.current.canType || !pane) return
    if (recording.current || starting.current) return
    // Transcribing has its own Cancel; a press on the mic is not a way out.
    if (voiceRef.current.phase === 'transcribing') return
    // Dictating over a review keeps its words: the new ones join them.
    if (voiceRef.current.phase === 'review') endReview()
    setVoiceFault(null)
    holdRef.current = false
    pendingEnd.current = null
    starting.current = true
    const run = voiceRun.current
    try {
      const started = await startRecording(() => {
        actions.setNotice('Ten minutes is the most one recording takes — sending what was said.')
        void finishVoiceRef.current()
      }, { sessionId: pane, request: actions.request })
      starting.current = false
      const end = pendingEnd.current
      pendingEnd.current = null
      if (voiceRun.current !== run || latest.current.paneId !== pane || end === 'cancel') {
        started.cancel()
        return
      }
      recording.current = started
      // Auto-stop is opt-in, and never cuts off a finger that is still holding.
      const monitor = watchLevel(
        started.stream,
        getVoiceAutoStop()
          ? () => {
              if (!holdRef.current && recording.current === started) void finishVoiceRef.current()
            }
          : undefined
      )
      levelRef.current = monitor
      setVoiceLevel(monitor)
      setVoice({ phase: 'recording', mode: holdRef.current ? 'hold' : 'tap', startedAt: Date.now() })
      if (end === 'stop') void finishVoiceRef.current()
    } catch (err) {
      starting.current = false
      pendingEnd.current = null
      voiceFailed(err instanceof Error ? err.message : 'Could not open the microphone.')
    }
  }, [actions, endReview, setVoice, voiceFailed])

  /** The press became a hold, or a hold fell back to a tap. */
  const setVoiceMode = useCallback(
    (mode: VoiceMode) => {
      holdRef.current = mode === 'hold'
      const current = voiceRef.current
      if (current.phase === 'recording' && current.mode !== mode) setVoice({ ...current, mode })
    },
    [setVoice]
  )

  /** Cancel: the recording is thrown away, or the transcription abandoned. Nothing is sent. */
  const cancelVoice = useCallback(() => {
    if (starting.current) {
      pendingEnd.current = 'cancel'
      return
    }
    if (voiceRef.current.phase === 'review') {
      undoReview()
      return
    }
    recording.current?.cancel()
    recording.current = null
    dropLevel()
    voiceRun.current++
    setVoice(IDLE)
  }, [dropLevel, setVoice, undoReview])

  // A pane that goes, or a tab that is switched, does not keep a microphone
  // open, does not keep the button lit for a recording that is gone, and does
  // not send a review into the pane it left — the words stay in its draft.
  useEffect(() => {
    return () => {
      recording.current?.cancel()
      recording.current = null
      dropLevel()
      window.clearTimeout(reviewTimer.current)
      voiceRun.current++
      setVoice(IDLE)
      setVoiceFault(null)
    }
  }, [paneId, dropLevel, setVoice])

  const voiceControls = useMemo<VoiceControls | undefined>(
    () =>
      isDictationSupported()
        ? {
            start: () => void startVoice(),
            mode: setVoiceMode,
            stop: () => void finishVoice(),
            cancel: cancelVoice,
            undo: undoReview
          }
        : undefined,
    [cancelVoice, finishVoice, setVoiceMode, startVoice, undoReview]
  )

  /**
   * An effort level, picked for this pane.
   *
   * The composer only offers the picker when `effortLevels` is non-empty;
   * what a pick does is the dialect question `effortSlash` answers. A Claude
   * or Grok pane takes `/effort <level>` typed as words and Enter as its own
   * keystroke a beat later — the same two-write rhythm `sendDraft` uses,
   * because a slash command that arrives holding its own `\r` reads as a paste
   * and sits in the TUI's box unsent.
   */
  const sendEffort = useCallback(
    async (level: EffortLevel) => {
      if (!canType || !paneId || !profile) return
      const type = effortSlash(profile.command)
      if (!type) {
        actions.setNotice(effortRefusal(profile.command))
        return
      }
      actions.write(paneId, type(level))
      // The same wait `sendText` makes: the desktop has the command before its Enter.
      await actions.request({ kind: 'claim', sessionId: paneId })
      await pause(SETTLE_BEFORE_ENTER_MS)
      actions.write(paneId, '\r')
      takePane()
    },
    [actions, canType, paneId, profile, takePane]
  )

  /**
   * A model, picked for this pane from that CLI's own list.
   *
   * Claude and Grok take `/model <id>` typed as words and Enter a beat later,
   * the same two-write rhythm as effort. A CLI with no dialect gets a sentence
   * rather than keystrokes into a menu this browser cannot see.
   */
  const sendModel = useCallback(
    async (id: string) => {
      if (!canType || !paneId || !profile) return
      const type = modelSlash(profile.command)
      if (!type) {
        actions.setNotice(modelRefusal(profile.command))
        return
      }
      actions.write(paneId, type(id))
      await pause(SETTLE_BEFORE_ENTER_MS)
      actions.write(paneId, '\r')
      takePane()
    },
    [actions, canType, paneId, profile, takePane]
  )

  /**
   * A permission rung, picked for this pane from that CLI's own list.
   *
   * Claude and Grok walk Shift+Tab from the mode the status strip reports to
   * the one that was picked. Codex has no cycle — `/permissions` opens its
   * own menu. A rung that is launch-only (Claude bypass) is a sentence, not
   * a keystroke into a cycle that will never land there.
   */
  const sendMode = useCallback(
    async (mode: ClaudePermissionMode) => {
      if (!canType || !paneId || !profile) return
      const command = profile.command
      const picker = modePickerSlash(command)
      if (picker) {
        actions.write(paneId, picker)
        await pause(SETTLE_BEFORE_ENTER_MS)
        actions.write(paneId, '\r')
        takePane()
        return
      }
      const from = liveRung(status?.mode)
      const steps = tabsToPermissionMode(command, from, mode)
      if (steps === null) {
        const spec = permissionSpec(command, mode)
        actions.setNotice(
          from === null
            ? 'This pane has not printed its mode yet.'
            : spec
              ? `${spec.label} has to be chosen when the pane opens.`
              : modeRefusal(command)
        )
        return
      }
      if (steps === 0) return
      for (let i = 0; i < steps; i++) {
        actions.write(paneId, BACK_TAB)
        if (i < steps - 1) await pause(SETTLE_BETWEEN_TABS_MS)
      }
      takePane()
    },
    [actions, canType, paneId, profile, status?.mode, takePane]
  )

  /**
   * Stop: Esc down the PTY, the key every agent's own footer names for this
   * (`esc to interrupt`). Pressing it again while "Stopping…" sends it again.
   */
  const sendStop = () => {
    sendRaw(ESC)
    setStopping(true)
  }

  // Above the early returns: a hook below them is skipped for a project with no
  // tabs, and React unmounts the whole page ("Rendered fewer hooks").
  const [keysShown, setKeysShown] = useState(savedKeysShown)

  if (offline && state.offlineMode === 'github') return null
  if (!tab) return null

  const to = profile ? (project ? `${profile.name} · ${project}` : profile.name) : undefined
  const reason = offline
    ? 'The desktop is asleep'
    : !live
      ? 'Reconnecting…'
      : !alive
        ? 'This pane has closed'
        : 'Reconnecting…'
  const roster = profile && !isShellProfile(profile) ? agentModels(profile.command) : []
  const levels = profile && !isShellProfile(profile) ? effortLevels(profile.command) : []
  const ladder = profile && !isShellProfile(profile) ? permissionModes(profile.command) : []
  const rung = liveRung(status?.mode)
  const currentModeId = rung === 'auto' || rung === null ? null : rung
  const currentModelId = matchAgentModel(roster, status?.model)?.id ?? null

  const activeView: PaneFace = view ?? (isAgent ? getClaudeView() : 'term')
  const nextView: PaneFace = isAgent ? (activeView === 'chat' ? 'feed' : activeView === 'feed' ? 'term' : 'chat') : 'term'

  /*
   * The phone's Send becomes Stop while an agent works — a shell has no busy
   * signal to read, so it keeps the key row's Ctrl and Esc instead. Not while
   * the pane is asking: the answer card is how that gets answered, and Esc
   * there is "No".
   */
  const canStop = mobile && isAgent && canType && busy && !asking

  /*
   * A pane whose process has gone: it can be started again in the same place
   * (a fresh pane of the same profile beside it, then the dead one closed —
   * both existing layout ops), or put away.
   */
  const dead = live && paneId !== null && leaf !== null && !alive
  const leaves = tab ? countLeaves(tab.root) : 1
  const startAgain = async (): Promise<void> => {
    if (!paneId || !leaf) return
    const refused = await actions.layout({
      op: 'create-pane',
      paneId,
      profileId: leaf.profileId,
      permissionMode: leaf.permissionMode
    })
    if (refused) {
      actions.setNotice(refused)
      return
    }
    const stuck = await actions.layout({ op: 'close-pane', paneId })
    if (stuck) actions.setNotice(stuck)
  }
  const putAway = async (): Promise<void> => {
    if (!paneId || !tab) return
    // A split keeps its living panes: only the dead one goes.
    const refused =
      leaves > 1
        ? await actions.layout({ op: 'close-pane', paneId })
        : await actions.layout({ op: 'close-tab', tabId: tab.id })
    if (refused) actions.setNotice(refused)
  }

  const onFlipView = () => {
    if (!paneId) return
    requestPaneView(paneId, nextView)
    if (isAgent) setClaudeView(nextView)
  }

  const toggleKeys = () => {
    const next = !keysShown
    setKeysShown(next)
    try {
      window.localStorage.setItem(KEYS_PREF, next ? 'shown' : 'hidden')
    } catch {
      // Storage can be unavailable in private browsing; this tap still works.
    }
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('forge:fit-terminals')))
  }

  /*
   * The phone's model chip, in the status strip rather than on the box: words
   * for the model, the effort picked here and the mode in force. Agents only —
   * a shell has none of the three.
   */
  const chip =
    mobile && isAgent && paneId && (roster.length || levels.length || ladder.length) ? (
      <ModelChip
        paneId={paneId}
        agentName={profile?.name ?? 'This pane'}
        models={roster}
        currentModelId={currentModelId}
        modelText={status?.model}
        onModel={roster.length ? (id) => void sendModel(id) : undefined}
        effortLevels={levels}
        onEffort={levels.length ? (level) => void sendEffort(level) : undefined}
        modes={ladder}
        currentModeId={currentModeId}
        modeText={rung === 'auto' ? 'Auto' : undefined}
        onMode={ladder.length ? (mode) => void sendMode(mode) : undefined}
        disabled={!canType}
      />
    ) : undefined

  return (
    // `data-view` is the face on screen, defaulted the way the pane defaults
    // it, so the phone's key row and status strip trade places on the same face
    // the pane shows — never on a guess.
    <div className="session-composer" data-view={activeView} data-keys={keysShown ? 'shown' : 'hidden'}>
      {profile ? (
        <AgentStatus
          profile={profile}
          status={status}
          live={canType}
          view={activeView}
          onFlipView={isAgent ? onFlipView : undefined}
          keysShown={keysShown}
          onToggleKeys={toggleKeys}
          chip={chip}
        />
      ) : null}
      {mobile && asking && paneId ? (
        <AnswerCard
          // A new question is a new card: the sent state belongs to the old one.
          key={`${paneId}\n${prompt}`}
          paneId={paneId}
          agentName={profile?.name ?? 'This pane'}
          prompt={prompt}
          digits={digits}
          live={canType}
          onWrite={sendRaw}
          onShowTerminal={activeView !== 'term' ? () => requestPaneView(paneId, 'term') : undefined}
        />
      ) : null}
      {dead ? (
        <div className="composer-dead" role="group" aria-label="This pane has closed">
          <p className="composer-dead__text">{profile?.name ?? 'This pane'} has closed.</p>
          <div className="composer-dead__actions">
            <button type="button" className="composer-dead__btn" data-kind="primary" onClick={() => void startAgain()}>
              Start again
            </button>
            <button type="button" className="composer-dead__btn" onClick={() => void putAway()}>
              {leaves > 1 ? 'Close pane' : 'Close tab'}
            </button>
          </div>
        </div>
      ) : null}
      <Composer
        draft={draft}
        disabled={!canType}
        disabledReason={reason}
        to={to}
        onDraft={(value) => {
          if (paneId) setDraftFor(paneId, value)
        }}
        onSend={sendDraft}
        onRaw={sendRaw}
        onStop={canStop ? sendStop : undefined}
        stopping={stopping}
        models={roster}
        currentModelId={currentModelId}
        onModel={roster.length ? (id) => void sendModel(id) : undefined}
        effortLevels={levels}
        onEffort={levels.length ? (level) => void sendEffort(level) : undefined}
        modes={ladder}
        currentModeId={currentModeId}
        onMode={ladder.length ? (mode) => void sendMode(mode) : undefined}
        onFocus={takePane}
        autoFocus={false}
        focusSignal={focusSignal}
        placeholder={
          foremanOn
            ? 'Tell Foreman…'
            : mobile && profile
              ? isAgent
                ? `Talk to ${profile.name.split(' ')[0]}…`
                : 'Type a command…'
              : undefined
        }
        tintedPlaceholder={mobile && !foremanOn && isAgent && profile ? profile.name.split(' ')[0] : undefined}
        placeholderTint={profile ? badgeColor(profile) : undefined}
        sending={sending}
        onNotice={actions.setNotice}
        voice={voiceControls}
        voiceState={voice}
        voiceLevel={voiceLevel}
        onShowChat={isAgent && activeView === 'term' ? onFlipView : undefined}
        bar={face === 'deck'}
        lead={
          face === 'deck' ? (
            <>
              {lead}
              <ListenSwitch state={voice} controls={voiceControls} fault={voiceFault} disabled={!canType} />
            </>
          ) : undefined
        }
      />
    </div>
  )
}

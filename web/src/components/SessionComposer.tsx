import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { isDictationSupported, startRecording, transcribeOnDesktop, type Recording } from '../lib/dictate'
import { isImageFile, uploadFileChunks } from '../lib/file'
import { packImage } from '../lib/image'
import { useMobile } from '../lib/mobile'
import { requestPaneView, usePaneStatus, usePaneView, type PaneFace } from '../lib/pane-status'
import { getClaudeView, setClaudeView } from '../lib/view-pref'
import type { PermissionMode } from '@/lib/rich'
import { useForge, useProfiles, useWorkspace } from '../state'
import { AgentStatus } from './AgentStatus'
import { AnswerCard } from './AnswerCard'
import { BACK_TAB, Composer } from './Composer'

/**
 * The one text box for this browser, with the agent's status strip over it.
 *
 * Panes paint the terminal; this is the app's input. It always talks to the
 * focused pane — the same pane a click in the display selects — so a split
 * still has one box, not one per sliver.
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

/** Where the mic button is in its round trip: quiet, taking the words down, or waiting for them. */
type VoicePhase = 'idle' | 'recording' | 'transcribing'

function findLeaf(node: LayoutNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.a, id) ?? findLeaf(node.b, id)
}

export function SessionComposer(): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const [draft, setDraft] = useState('')
  const sendingFiles = useRef(false)
  const [voice, setVoice] = useState<VoicePhase>('idle')
  const recording = useRef<Recording | null>(null)
  /** The microphone while it records, so the button can draw what it hears. */
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null)
  /** Bumped whenever a round trip is abandoned, so a late answer cannot repaint the button. */
  const voiceRun = useRef(0)

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
  const mobile = useMobile()
  const asking = paneId !== null && state.asking.has(paneId)
  const prompt = paneId ? (state.prompts[paneId] ?? '') : ''
  const busy = Boolean(status?.busy)
  /**
   * Stop was pressed and the agent has not stopped yet. Cleared by the strip
   * reading idle — the only proof an interrupt landed — or by a pane change.
   */
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!busy) setStopping(false)
  }, [busy])
  useEffect(() => setStopping(false), [paneId])

  const sendFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || !canType || !paneId || sendingFiles.current) return
      sendingFiles.current = true
      try {
        for (const file of files) {
          try {
            if (isImageFile(file)) {
              try {
                const packed = await packImage(file)
                const result = await actions.request({
                  kind: 'paste-image',
                  sessionId: paneId,
                  mime: packed.mime,
                  data: packed.data
                })
                if (result.kind === 'failed') actions.setNotice(result.message)
                continue
              } catch {
                // If downscaling failed, fall back to chunked file upload
              }
            }
            await uploadFileChunks(file, paneId, actions.request)
          } catch (err) {
            actions.setNotice(err instanceof Error ? err.message : `Could not send "${file.name}".`)
          }
        }
      } finally {
        sendingFiles.current = false
      }
    },
    [actions, canType, paneId]
  )

  const takePane = useCallback(() => {
    if (paneId && canType) actions.claim(paneId)
  }, [actions, canType, paneId])

  const sendText = useCallback(
    async (raw: string, files: File[]) => {
      if (!canType || !paneId) return
      const text = raw.replace(/\s+$/, '')
      if (!text && !files.length) return
      // Attachments first: the TUI takes each as a paste into its own box, and the
      // words after it become the message that refers to them.
      if (files.length) {
        await sendFiles(files)
        // The TUI is still taking the pasted path into its box; words landing
        // in the same instant get folded into that paste.
        await pause(SETTLE_AFTER_IMAGE_MS)
      }
      if (text) {
        // A newline in this box is a line in the prompt, not a submit. Bracketed
        // paste is how the TUI takes a multi-line draft as one message; a bare
        // `\n` down the PTY is Enter, and would send the first line alone.
        actions.write(paneId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
        setDraft('')
        // Enter is its own keystroke, a beat after the words — never in the
        // same write. Claude Code's input reads one burst holding text and a
        // `\r` as a paste and turns the `\r` into a newline, so the message sat
        // in its box unsent. The desktop's own `submit()` keeps the carriage
        // return separate for the same reason.
        await pause(SETTLE_BEFORE_ENTER_MS)
        actions.write(paneId, '\r')
      }
      takePane()
    },
    [actions, canType, paneId, sendFiles, takePane]
  )

  const sendDraft = useCallback((files: File[]) => sendText(draft, files), [draft, sendText])

  /**
   * The mic button: this browser's microphone, the desktop's ears.
   *
   * First press records; second press stops, ships the audio to the desktop
   * as `dictate` chunks, and the words come back and go down the same path a
   * typed message takes — words, a beat, Enter. Nothing is recognised in the
   * browser (the Web Speech API was, and went silent on Android as often as
   * it worked) and nothing needs the desktop's own microphone, which is the
   * one the CLIs' `/voice` listens to and is miles from a phone.
   */
  const finishVoice = useCallback(async () => {
    const current = recording.current
    recording.current = null
    setVoiceStream(null)
    if (!current || !paneId) {
      setVoice('idle')
      return
    }
    const run = ++voiceRun.current
    const stillMine = (): boolean => voiceRun.current === run
    setVoice('transcribing')
    try {
      const audio = await current.stop()
      if (!stillMine()) return
      if (audio.size === 0) {
        actions.setNotice('Nothing was recorded.')
        return
      }
      const text = await Promise.race([
        transcribeOnDesktop(audio, paneId, actions.request),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('The desktop took too long to answer.')), TRANSCRIBE_TIMEOUT_MS)
        )
      ])
      if (!stillMine()) return
      if (!text) {
        actions.setNotice('The desktop heard nothing in that.')
        return
      }
      setDraft('')
      await sendText(text, [])
    } catch (err) {
      if (stillMine()) actions.setNotice(err instanceof Error ? err.message : 'Dictation failed.')
    } finally {
      if (stillMine()) setVoice('idle')
    }
  }, [actions, paneId, sendText])

  const sendVoice = useCallback(async () => {
    if (!canType || !paneId) return
    if (recording.current) {
      await finishVoice()
      return
    }
    if (voice !== 'idle') {
      // A press while the button is lit and nothing is recording is a stuck
      // light — a stop that never came back, a desktop that never answered.
      // The press is the way out: abandon that round trip and go quiet.
      voiceRun.current++
      setVoice('idle')
      return
    }
    try {
      const started = await startRecording(() => {
        actions.setNotice('Ten minutes is the most one recording takes — sending what was said.')
        void finishVoice()
      })
      recording.current = started
      setVoiceStream(started.stream)
      setVoice('recording')
    } catch (err) {
      actions.setNotice(err instanceof Error ? err.message : 'Could not open the microphone.')
    }
  }, [actions, canType, finishVoice, paneId, voice])

  // A pane that goes, or a tab that is switched, does not keep a microphone
  // open — and does not keep the button lit for a recording that is gone.
  useEffect(() => {
    return () => {
      recording.current?.cancel()
      recording.current = null
      setVoiceStream(null)
      voiceRun.current++
      setVoice('idle')
    }
  }, [paneId])

  const sendRaw = useCallback(
    (data: string) => {
      if (!canType || !paneId || !data) return
      actions.write(paneId, data)
      takePane()
    },
    [actions, canType, paneId, takePane]
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

  const isAgent = profile && !isShellProfile(profile)
  const activeView: PaneFace = view ?? (isAgent ? getClaudeView() : 'term')
  const nextView: PaneFace = isAgent ? (activeView === 'chat' ? 'feed' : activeView === 'feed' ? 'term' : 'chat') : 'term'

  /*
   * The phone's Send becomes Stop while an agent works — a shell has no busy
   * signal to read, so it keeps the key row's Ctrl and Esc instead. Not while
   * the pane is asking: the answer card is how that gets answered, and Esc
   * there is "No".
   */
  const canStop = mobile && Boolean(isAgent) && canType && busy && !asking
  /** Claude Code and Gemini CLI pick a numbered row on its digit; the rest walk to it. */
  const exe = profile ? commandExe(profile.command) : ''
  const digits = exe === 'claude' || exe === 'gemini'

  const onFlipView = () => {
    if (!paneId) return
    requestPaneView(paneId, nextView)
    if (isAgent) setClaudeView(nextView)
  }

  return (
    <div className="session-composer" data-view={view}>
      {profile ? (
        <AgentStatus
          profile={profile}
          status={status}
          live={canType}
          view={activeView}
          onFlipView={isAgent ? onFlipView : undefined}
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
      <Composer
        draft={draft}
        disabled={!canType}
        disabledReason={reason}
        to={to}
        onDraft={setDraft}
        onSend={(files) => void sendDraft(files)}
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
        autoFocus={canType}
        onNotice={actions.setNotice}
        onVoice={isDictationSupported() ? () => void sendVoice() : undefined}
        voicePhase={voice}
        voiceStream={voiceStream}
      />
    </div>
  )
}

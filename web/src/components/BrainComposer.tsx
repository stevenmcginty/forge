import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BRAIN_SEND_MAX, type BrainStatus } from '@shared/brain'
import {
  isDictationSupported,
  startRecording,
  transcribeOnDesktop,
  type Recording,
  type VoiceMode,
  type VoiceState
} from '../lib/dictate'
import { useMobile } from '../lib/mobile'
import { announcePaneSent } from '../lib/pane-sent'
import { watchLevel, type LevelMonitor } from '../lib/voice-level'
import { getVoiceAutoStop } from '../lib/voice-prefs'
import { useForge } from '../state'
import { Composer, type VoiceControls } from './Composer'

/**
 * The box under Forge Brain: the phone's own composer — the mic disc, dictated
 * words that wait 1.5 s with Undo before they go, Stop while it works — aimed
 * at the brain rather than at the focused pane.
 *
 * Words go through `brain-send`, never typed down the pane: the desktop types
 * them at once when the brain is free and queues them while it works, which
 * raw keystrokes into a busy TUI would not. Keys (Esc, arrows, Enter) and Stop
 * are the pane's own, written straight down it — they answer what is on its
 * screen, and a queue would deliver them too late.
 */

const IDLE: VoiceState = { phase: 'idle' }
/** How long dictated words sit in the box, with Undo, before they send. The pane box's number. */
const REVIEW_MS = 1500
/** The most a round trip to the desktop's ears may take before the button gives up. */
const TRANSCRIBE_TIMEOUT_MS = 75_000
/** How long Stop spins before it offers a second Esc to a brain still working. */
const STOP_AGAIN_MS = 3000
const ESC = '\x1b'

/** The draft outlives the sheet: closing it to look at a pane does not throw a sentence away. */
let keptDraft = ''

export function BrainComposer({
  status,
  focusSignal = 0
}: {
  status: BrainStatus
  /** Focus the box each time this changes (the deck, on open). Never on the phone. */
  focusSignal?: number
}): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  const paneId = status.paneId
  const running = status.state !== 'off' && status.state !== 'error' && status.state !== 'starting'
  const canSend = live && running && paneId !== null
  const busy = status.state === 'busy'

  const [draft, setDraftState] = useState(keptDraft)
  const draftRef = useRef(draft)
  const setDraft = useCallback((value: string) => {
    keptDraft = value
    draftRef.current = value
    setDraftState(value)
  }, [])
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null)
  const sendingRef = useRef(false)

  /* ---------------------------------------------------------------- send */

  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      const words = text.replace(/\s+$/, '')
      if (!words || !paneId) return false
      if (words.length > BRAIN_SEND_MAX) {
        actions.setNotice(`That is too long for Forge Brain — ${BRAIN_SEND_MAX.toLocaleString()} characters at most.`)
        return false
      }
      const refused = await actions.brain({ kind: 'brain-send', text: words })
      if (refused) {
        actions.setNotice(refused)
        return false
      }
      // The one-tick bubble, at once; two ticks once the transcript has it.
      announcePaneSent(paneId, words)
      return true
    },
    [actions, paneId]
  )

  const sendDraft = useCallback(
    (files: File[]) => {
      if (!canSend || sendingRef.current) return
      endReviewRef.current()
      if (files.length) actions.setNotice('Forge Brain takes words only — the attachment was not sent.')
      const text = draftRef.current
      if (!text.trim()) return
      sendingRef.current = true
      setSending({ done: 0, total: 0 })
      setDraft('')
      void sendText(text).then((ok) => {
        sendingRef.current = false
        setSending(null)
        // Refused: the words come back, unless something new was typed meanwhile.
        if (!ok && !draftRef.current) setDraft(text)
      })
    },
    [actions, canSend, sendText, setDraft]
  )

  const sendRaw = useCallback(
    (data: string) => {
      if (live && paneId && data) actions.write(paneId, data)
    },
    [actions, live, paneId]
  )

  /* ---------------------------------------------------------------- stop */

  const [stopPhase, setStopPhase] = useState<'idle' | 'stopping' | 'again'>('idle')
  useEffect(() => {
    if (!busy) setStopPhase('idle')
  }, [busy])
  useEffect(() => {
    if (stopPhase !== 'stopping') return undefined
    const timer = window.setTimeout(() => setStopPhase('again'), STOP_AGAIN_MS)
    return () => window.clearTimeout(timer)
  }, [stopPhase])
  const sendStop = (): void => {
    if (stopPhase === 'stopping') return
    sendRaw(ESC)
    setStopPhase('stopping')
  }

  /* ------------------------------------------------------------ dictation
   *
   * The pane box's road, cut to what the brain needs: this browser records,
   * the desktop hears, the words land in the box for REVIEW_MS with Undo and
   * then go through `brain-send`. Over words typed by hand they join and wait
   * for Send. A recording that never came near speech is not uploaded.
   */

  const [voice, setVoiceState] = useState<VoiceState>(IDLE)
  const voiceRef = useRef<VoiceState>(IDLE)
  const setVoice = useCallback((next: VoiceState) => {
    voiceRef.current = next
    setVoiceState(next)
  }, [])
  const recording = useRef<Recording | null>(null)
  const levelRef = useRef<LevelMonitor | null>(null)
  const [voiceLevel, setVoiceLevel] = useState<LevelMonitor | null>(null)
  const voiceRun = useRef(0)
  const starting = useRef(false)
  const pendingEnd = useRef<'stop' | 'cancel' | null>(null)
  const holdRef = useRef(false)
  const reviewTimer = useRef(0)
  const [focus, setFocus] = useState(0)

  const latest = useRef({ canSend, paneId, sendDraft })
  latest.current = { canSend, paneId, sendDraft }

  const endReview = useCallback(() => {
    window.clearTimeout(reviewTimer.current)
    if (voiceRef.current.phase === 'review') setVoice(IDLE)
  }, [setVoice])
  const endReviewRef = useRef(endReview)
  endReviewRef.current = endReview

  const undoReview = useCallback(() => {
    if (voiceRef.current.phase !== 'review') return
    window.clearTimeout(reviewTimer.current)
    setVoice(IDLE)
    setFocus((n) => n + 1)
  }, [setVoice])

  const dropLevel = useCallback(() => {
    levelRef.current?.close()
    levelRef.current = null
    setVoiceLevel(null)
  }, [])

  const finishVoice = useCallback(async () => {
    const current = recording.current
    recording.current = null
    const monitor = levelRef.current
    levelRef.current = null
    setVoiceLevel(null)
    const pane = latest.current.paneId
    if (!current || !pane) {
      monitor?.close()
      if (starting.current) pendingEnd.current = 'stop'
      else if (voiceRef.current.phase !== 'review') setVoice(IDLE)
      return
    }
    const run = ++voiceRun.current
    const mine = (): boolean => voiceRun.current === run
    setVoice({ phase: 'transcribing', startedAt: Date.now() })
    let reviewing = false
    try {
      const audio = await current.stop()
      const silent = monitor?.silent() ?? false
      monitor?.close()
      if (!mine()) return
      if (audio.size === 0) {
        actions.setNotice('Nothing was recorded.')
        return
      }
      if (silent) {
        actions.setNotice('I heard nothing — check the mic (is it on Bluetooth?)')
        return
      }
      const text = await Promise.race([
        transcribeOnDesktop(audio, pane, actions.request),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('The desktop took too long to answer.')), TRANSCRIBE_TIMEOUT_MS)
        )
      ])
      if (!mine()) return
      if (!text) {
        actions.setNotice('The desktop heard nothing in that.')
        return
      }
      const before = draftRef.current
      const words = before.trim() ? `${before.replace(/\s+$/, '')} ${text}` : text
      setDraft(words)
      if (before.trim()) {
        actions.setNotice('Added to your message — not sent. Tap Send when it is ready.')
        return
      }
      reviewing = true
      setVoice({ phase: 'review', text: words, endsAt: Date.now() + REVIEW_MS })
      reviewTimer.current = window.setTimeout(() => {
        if (voiceRef.current.phase !== 'review') return
        setVoice(IDLE)
        if (!latest.current.canSend) {
          actions.setNotice('Not sent — the words are waiting in the box.')
          return
        }
        latest.current.sendDraft([])
      }, REVIEW_MS)
    } catch (err) {
      if (mine()) actions.setNotice(err instanceof Error && err.message ? err.message : 'Dictation failed.')
    } finally {
      if (mine() && !reviewing) setVoice(IDLE)
    }
  }, [actions, setDraft, setVoice])
  const finishRef = useRef(finishVoice)
  finishRef.current = finishVoice

  const startVoice = useCallback(async () => {
    const pane = latest.current.paneId
    if (!latest.current.canSend || !pane) return
    if (recording.current || starting.current) return
    if (voiceRef.current.phase === 'transcribing') return
    endReviewRef.current()
    holdRef.current = false
    pendingEnd.current = null
    starting.current = true
    const run = voiceRun.current
    try {
      const started = await startRecording(() => {
        actions.setNotice('Ten minutes is the most one recording takes — sending what was said.', true)
        void finishRef.current()
      }, { sessionId: pane, request: actions.request })
      starting.current = false
      const end = pendingEnd.current
      pendingEnd.current = null
      if (voiceRun.current !== run || end === 'cancel') {
        started.cancel()
        return
      }
      recording.current = started
      const monitor = watchLevel(
        started.stream,
        getVoiceAutoStop()
          ? () => {
              if (!holdRef.current && recording.current === started) void finishRef.current()
            }
          : undefined
      )
      levelRef.current = monitor
      setVoiceLevel(monitor)
      setVoice({ phase: 'recording', mode: holdRef.current ? 'hold' : 'tap', startedAt: Date.now() })
      if (end === 'stop') void finishRef.current()
    } catch (err) {
      starting.current = false
      pendingEnd.current = null
      actions.setNotice(err instanceof Error ? err.message : 'Could not open the microphone.')
    }
  }, [actions, setVoice])

  const setVoiceMode = useCallback(
    (mode: VoiceMode) => {
      holdRef.current = mode === 'hold'
      const current = voiceRef.current
      if (current.phase === 'recording' && current.mode !== mode) setVoice({ ...current, mode })
    },
    [setVoice]
  )

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

  // Closing the sheet, or the brain's pane changing under it, lets go of the
  // microphone and sends nothing: the words stay in the kept draft.
  useEffect(
    () => () => {
      recording.current?.cancel()
      recording.current = null
      dropLevel()
      window.clearTimeout(reviewTimer.current)
      voiceRun.current++
      setVoice(IDLE)
    },
    [paneId, dropLevel, setVoice]
  )

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

  const reason = offline
    ? 'The desktop is asleep'
    : !live
      ? 'Reconnecting…'
      : status.state === 'starting' || (status.enabled && !paneId)
        ? 'Forge Brain is starting…'
        : status.state === 'error'
          ? 'Forge Brain has stopped'
          : 'Forge Brain is off'

  return (
    <Composer
      draft={draft}
      disabled={!canSend}
      disabledReason={reason}
      onDraft={setDraft}
      onSend={sendDraft}
      onRaw={sendRaw}
      onStop={canSend && busy ? sendStop : undefined}
      stopping={stopPhase !== 'idle'}
      stopAgain={stopPhase === 'again'}
      autoFocus={false}
      focusSignal={focus + focusSignal}
      placeholder={busy ? 'Queue a message…' : 'Message Forge Brain'}
      sending={sending}
      onNotice={actions.setNotice}
      voice={voiceControls}
      voiceState={voice}
      voiceLevel={voiceLevel}
      bar={!mobile}
    />
  )
}

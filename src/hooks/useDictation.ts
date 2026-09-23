import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isSttSetupError, type SttStatus } from '@shared/types'
import { agentVoiceAlways, agentVoiceNow } from '@/components/hub/barMode'
import { insertPhrase, resolveInsertTarget, type InsertTarget } from '@/lib/dictation'
import { earconDictationOff, earconDictationOn } from '@/lib/earcon'
import { formatCombo } from '@/lib/keymap'
import { bindCommandKeys, getKeymapView, keyForCommand, setCommandHandler, subscribeKeymap } from '@/lib/keymapRegistry'
import { TALK_AGENT_ID, TALK_DICTATE_ID } from '@/lib/shortcutCommands'
import { attachTalkKey, type GestureIntent } from '@/lib/stt-gesture'
import { terminalHost } from '@/lib/terminals'
import { dictationTranscript, transcriptBus } from '@/lib/transcriptSource'
import { useActiveTab, useApp } from '@/state/AppState'

/**
 * Dictation, from the renderer's side: subscribe to the sidecar's status, route
 * each finished phrase to whatever has focus, and own the toggle hotkey.
 *
 * The hotkey is a *renderer* listener on purpose. Steve's DictationMic already
 * owns Right Ctrl globally via a system hook; registering an Electron
 * globalShortcut for the same key would have the two apps fighting over every
 * press. A window listener only fires while a Forge window is focused, which is
 * exactly the scope we want.
 *
 * The *gestures* are DictationMic's: tap toggles, hold is push-to-talk, combos
 * never fire. When Jarvis is armed the same key talks to him (capture / release)
 * instead of opening a second dictation session on top of his.
 *
 * There are two such keys, both captured here the same way (a window listener
 * in the capture phase, so they work with focus inside an xterm pane):
 *
 *   Dictate key  settings.sttHotkey, default Right Ctrl — everything above.
 *   Agent key    keymap.json's `voice.talk.agent`, default Right Shift — the
 *                main agent listens (hub.start / hub.stop through the handlers
 *                HubLayer registers), whichever way the Dictate ⇄ Agent switch
 *                is set, and without flipping it.
 *
 * This is the *engine*, and it must run exactly once: it holds a phrase
 * subscription and a hotkey listener, so a second copy would insert every
 * dictated sentence into the terminal twice and make each press of Right Ctrl
 * toggle twice — i.e. do nothing. Components call `useDictation` from
 * src/state/Dictation.tsx, which is one instance of this shared out.
 */

const OFF: SttStatus = { phase: 'off', level: 0, error: null, ready: false }
const TALK_KEYS_MIGRATED = 'forge.talkKeys.migrated'

export interface Dictation {
  status: SttStatus
  /** True when the sidecar needs the user to fix a path before it can work. */
  needsSetup: boolean
  listening: boolean
  toggle: () => void
  /** Drop the sidecar so saved paths take effect; `force` respawns at once. */
  reload: (force?: boolean) => void
}

export function useDictationEngine(): Dictation {
  const { state, actions } = useApp()
  const tab = useActiveTab()
  const [status, setStatus] = useState<SttStatus>(OFF)

  /** Where phrases went at the moment listening began — see resolveInsertTarget. */
  const remembered = useRef<InsertTarget>({ kind: 'none' })
  const activePaneId = tab?.activePaneId ?? null
  const activePaneRef = useRef<string | null>(activePaneId)
  activePaneRef.current = activePaneId

  const phaseRef = useRef(status.phase)
  phaseRef.current = status.phase
  const statusRef = useRef(status)
  statusRef.current = status

  const noticeRef = useRef(actions.setNotice)
  noticeRef.current = actions.setNotice
  const patchRef = useRef(actions.patchSettings)
  patchRef.current = actions.patchSettings
  /** Dictate mode's "press Enter after each phrase". Off means exactly the old typing. */
  const autoSendRef = useRef(state.settings.dictateAutoSend)
  autoSendRef.current = state.settings.dictateAutoSend

  /* ------------------------------------------------------------- routing
   *
   * Two places a phrase can go, and now exactly one thing decides: IS THE AGENT
   * ARMED. On, and the words are the agent's. Off, and they are dictation into
   * whatever pane you are looking at, which is what this hook has always done.
   *
   * It used to also require an agent surface to be on screen — first the voice
   * panel, then the floating hub. That condition is gone, and deliberately.
   * Steve, asked what should decide whether something was meant for Forge:
   * "everything that I say needs to go into forge... it's all going to be
   * relevant to forge". The switch is the switch, and a switch that quietly
   * flips itself back when you dock the hub or click on Chrome is not one.
   *
   * The two microphones stay two microphones, which is the other half of what
   * he said — dictation "works slightly different". Right Ctrl still opens the
   * mic for a pane; arming the agent still routes to the agent. What changed is
   * only that the agent's claim no longer expires when its window is not
   * visible.
   *
   * The registration is the switch. While it holds, dictation is a source on
   * the transcript bus and the agent picks phrases up like any other source;
   * while it does not, the bus has never heard of dictation and insertPhrase
   * does what M3 always did. Nothing can reach both.
   */

  const toAgent = state.agentListening
  const toAgentRef = useRef(toAgent)
  toAgentRef.current = toAgent

  useEffect(() => {
    if (!toAgent) return undefined
    return transcriptBus.register(dictationTranscript)
  }, [toAgent])

  /* --------------------------------------------------------- subscriptions */

  useEffect(() => {
    let alive = true
    void window.forge.stt.status().then((s) => {
      if (alive) setStatus(s)
    })
    const offStatus = window.forge.stt.onStatus(setStatus)
    return () => {
      alive = false
      offStatus()
    }
  }, [])

  useEffect(() => {
    return window.forge.stt.onPhrase(({ text }) => {
      // The agent's turn: hand it to the bus and stop. No insertion, so a phrase
      // aimed at the agent cannot also land in the pane behind the panel.
      if (toAgentRef.current) {
        dictationTranscript.push(text)
        return
      }
      // The bar's Agent mode: the main agent is asked, nothing is typed.
      if (agentVoiceNow()?.phrase(text)) return
      // Prefer where focus is *now*; fall back to where it was when the user
      // started talking, because clicking the pill moved it.
      let target = resolveInsertTarget(activePaneRef.current)
      if (target.kind === 'none') target = remembered.current
      const outcome = insertPhrase(text, target)
      if (outcome === 'clipboard') noticeRef.current('Dictated text copied to the clipboard')
      if (outcome === 'terminal' && target.kind === 'terminal' && autoSendRef.current) terminalHost.submit(target.paneId)
    })
  }, [])

  /**
   * Errors that are *not* a setup problem — a busy microphone, a bad phrase —
   * would otherwise be invisible: the pill goes back to idle looking fine while
   * the words went nowhere. Say them once in the status bar.
   */
  const lastErrorKey = useRef<string | null>(null)
  useEffect(() => {
    const err = status.error
    const key = err ? `${err.kind}:${err.msg}` : null
    if (key === lastErrorKey.current) return
    lastErrorKey.current = key
    if (err && !isSttSetupError(err.kind)) noticeRef.current(err.msg)
  }, [status.error])

  /* ---------------------------------------------------------------- earcons
   *
   * A beep when the mic opens and a beep when it shuts, so the hotkey answers
   * for itself. Right Ctrl is pressed while looking at a terminal, not at the
   * status bar, and a toggle you have to go and *look at* is one you press
   * twice.
   *
   * Driven off the phase rather than off `toggle`, for three reasons:
   *
   *   • the pill, the hub and the hotkey all end up here, so they cannot drift
   *     apart — clicking sounds exactly like pressing the key, which is what
   *     was asked for, and it is true by construction rather than by three
   *     call sites remembering to do the same thing;
   *   • the sidecar is spawned lazily and the model takes a few seconds to
   *     load the first time. A beep on the keypress would be a promise the mic
   *     had not kept yet; this one lands when it is genuinely open;
   *   • dictation stops itself after `sttAutoStopSeconds` of silence, and that
   *     is precisely the case where he has no idea it went off. The falling
   *     beep covers it, and nothing else could.
   *
   * `finishing` is deliberately not treated as still-on: the mic is shut by
   * then and only the tail phrase is still being transcribed, so the sound
   * belongs at the edge out of `listening`.
   */

  const capturing = status.phase === 'listening'
  const wasCapturing = useRef<boolean | null>(null)
  /**
   * Did *we* open this mic?
   *
   * The agent shares the sidecar, and while it is armed it re-starts listening
   * after every auto-stop. Beeping on that would turn the pair into the
   * metronome VoiceAgent's HANDS_BACK note describes — an armed agent in an
   * empty room, chirping every few seconds at nobody. So an agent-owned session
   * gets no opening beep, and this flag makes sure it gets no closing one
   * either: the beeps are always a matched pair or absent entirely.
   */
  const ourSession = useRef(false)

  useEffect(() => {
    const before = wasCapturing.current
    wasCapturing.current = capturing
    if (before === null || before === capturing) return // first look is not a change
    if (capturing) {
      ourSession.current = !toAgentRef.current
      if (ourSession.current) earconDictationOn()
      return
    }
    if (!ourSession.current) return
    ourSession.current = false
    earconDictationOff()
  }, [capturing])

  /* --------------------------------------------------------------- actions */

  const startDictation = useCallback((): void => {
    if (phaseRef.current === 'finishing') return
    remembered.current = resolveInsertTarget(activePaneRef.current)
    void window.forge.stt.start().then(setStatus)
  }, [])

  /**
   * One key, two jobs — but never both at once.
   *
   * Off, this is DictationMic: tap toggles, hold is push-to-talk, words land
   * in the focused pane. On (Jarvis armed), the same key talks to him. A
   * plain `start()` here would drop a wake session back to phrase mode and
   * every “hey Jarvis” would go missing; `release` ends a capture without
   * killing the session.
   */
  const applyIntent = useCallback((intent: GestureIntent): void => {
    if (toAgentRef.current) {
      const st = statusRef.current
      if (intent === 'ptt-end') {
        void window.forge.stt.release()
        return
      }
      if (st.mode === 'wake') {
        if (intent === 'toggle' && st.capturing) {
          void window.forge.stt.release()
          return
        }
        void window.forge.stt.capture()
        return
      }
      if (st.phase === 'off' || st.phase === 'idle' || st.phase === 'starting') {
        void window.forge.stt.start({ conversation: true }).then(setStatus)
      }
      return
    }

    // The bar's Agent mode: a live provider takes the key for its own session.
    // A dictation already open still stops the ordinary way.
    const busy = phaseRef.current === 'listening' || phaseRef.current === 'finishing'
    if (!busy && agentVoiceNow()?.key(intent)) return

    if (intent === 'ptt-end') {
      if (phaseRef.current === 'listening') void window.forge.stt.stop()
      return
    }
    if (intent === 'ptt-start') {
      if (phaseRef.current === 'listening' || phaseRef.current === 'finishing') return
      startDictation()
      return
    }
    if (phaseRef.current === 'listening') {
      void window.forge.stt.stop()
      return
    }
    startDictation()
  }, [startDictation])

  const toggle = useCallback(() => applyIntent('toggle'), [applyIntent])

  const reload = useCallback((force?: boolean) => {
    void window.forge.stt.reload(force).then(setStatus)
  }, [])

  /**
   * The Agent key. Reuses the Agent-mode route HubLayer registers (its `key`
   * starts the hub when off and stops it on a tap when on), but reads it
   * whatever the bar's mode is, and never changes the mode.
   *
   * Hold-to-talk's release on a Parakeet brain (the agent is armed) ends the
   * capture at once, so the phrase goes to the brain without waiting for the
   * silence timer. A dictation still open is closed first: one microphone at
   * a time.
   */
  const applyAgentIntent = useCallback((intent: GestureIntent): void => {
    const voice = agentVoiceAlways()
    if (intent === 'ptt-end') {
      if (toAgentRef.current) void window.forge.stt.release()
      voice?.key(intent)
      return
    }
    if (!voice) {
      noticeRef.current('The main agent is not ready yet')
      return
    }
    if (!toAgentRef.current && phaseRef.current === 'listening') void window.forge.stt.stop()
    voice.key(intent)
  }, [])

  /** A hold on the Agent key that became Shift+letter: take back the start it made. */
  const cancelAgentHold = useCallback((): void => {
    agentVoiceAlways()?.key('toggle')
  }, [])

  /* -------------------------------------------------------------- hotkeys */

  const hotkey = state.settings.sttHotkey
  const agentKey = useSyncExternalStore(subscribeKeymap, () => keyForCommand(TALK_AGENT_ID))

  // The Dictate key lives in settings.sttHotkey; the keymap registry lists it,
  // checks it for clashes and rebinds it through here.
  useEffect(
    () => bindCommandKeys(TALK_DICTATE_ID, hotkey ? [hotkey] : [], (keys) => patchRef.current({ sttHotkey: keys[0] ?? '' })),
    [hotkey]
  )

  /**
   * One-time move for the old single talk key. Right Shift was that key in
   * older Forge profiles, and it is now the Agent key's default: keep Right
   * Shift for the agent (what it did while Jarvis was armed) and give Dictate
   * its own default, Right Ctrl. Runs once per profile; a later choice stands.
   */
  const ready = state.ready
  useEffect(() => {
    if (!ready) return
    try {
      if (localStorage.getItem(TALK_KEYS_MIGRATED)) return
      localStorage.setItem(TALK_KEYS_MIGRATED, '1')
    } catch {
      /* no storage: the check below is still safe to repeat */
    }
    const agent = getKeymapView().commands.find((c) => c.id === TALK_AGENT_ID)
    if (hotkey === 'ShiftRight' && agent && !agent.customised && agent.defaultKeys[0] === 'ShiftRight') {
      patchRef.current({ sttHotkey: 'ControlRight' })
    }
    // Only the first ready settings decide this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  useEffect(() => attachTalkKey(window, hotkey, () => phaseRef.current === 'listening', applyIntent), [hotkey, applyIntent])
  useEffect(
    () => (agentKey ? attachTalkKey(window, agentKey, () => toAgentRef.current, applyAgentIntent, cancelAgentHold) : undefined),
    [agentKey, applyAgentIntent, cancelAgentHold]
  )

  // The palette (and anything else that runs commands by id) can press either key.
  useEffect(() => {
    const offDictate = setCommandHandler(TALK_DICTATE_ID, () => applyIntent('toggle'))
    const offAgent = setCommandHandler(TALK_AGENT_ID, () => applyAgentIntent('toggle'))
    return () => {
      offDictate()
      offAgent()
    }
  }, [applyIntent, applyAgentIntent])

  return useMemo<Dictation>(
    () => ({
      status,
      needsSetup: status.phase === 'error' && !!status.error && isSttSetupError(status.error.kind),
      listening: status.phase === 'listening',
      toggle,
      reload
    }),
    [status, toggle, reload]
  )
}

/** Human label for a hotkey code, for the pill's tooltip and the settings row. */
export function hotkeyLabel(code: string): string {
  return formatCombo(code)
}

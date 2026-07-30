import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isSttSetupError, type SttStatus } from '@shared/types'
import { insertPhrase, resolveInsertTarget, type InsertTarget } from '@/lib/dictation'
import { dictationTranscript, transcriptBus } from '@/lib/transcriptSource'
import { agentSurfaceOpen } from '@/lib/voicehub'
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
 * This is the *engine*, and it must run exactly once: it holds a phrase
 * subscription and a hotkey listener, so a second copy would insert every
 * dictated sentence into the terminal twice and make each press of Right Ctrl
 * toggle twice — i.e. do nothing. Components call `useDictation` from
 * src/state/Dictation.tsx, which is one instance of this shared out.
 */

const OFF: SttStatus = { phase: 'off', level: 0, error: null, ready: false }

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

  const noticeRef = useRef(actions.setNotice)
  noticeRef.current = actions.setNotice

  /* ------------------------------------------------------------- routing
   *
   * Two places a phrase can go, and exactly one rule for choosing: an agent
   * surface on screen *and* the mic armed means the words are meant for the
   * agent; anything else means they are meant for whatever you are looking at.
   *
   * "Agent surface" is the part the floating hub changed. It used to be "the
   * voice panel is open", which was the same question while the panel was the
   * only place the round button lived. The hub carries that button too, so a
   * pill floating over the terminals with agent mode on has to route the same
   * way — otherwise arming it there would quietly type his half of the
   * conversation into whatever pane was behind it.
   *
   * The registration is the switch. While it holds, dictation is a source on
   * the transcript bus and the agent picks phrases up like any other source;
   * while it does not, the bus has never heard of dictation and insertPhrase
   * does what M3 always did. Nothing can reach both.
   */

  const toAgent = agentSurfaceOpen(state.settings) && state.agentListening
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
      // Prefer where focus is *now*; fall back to where it was when the user
      // started talking, because clicking the pill moved it.
      let target = resolveInsertTarget(activePaneRef.current)
      if (target.kind === 'none') target = remembered.current
      const outcome = insertPhrase(text, target)
      if (outcome === 'clipboard') noticeRef.current('Dictated text copied to the clipboard')
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

  /* --------------------------------------------------------------- actions */

  const toggle = useCallback(() => {
    const phase = phaseRef.current
    if (phase === 'listening') {
      void window.forge.stt.stop()
      return
    }
    if (phase === 'finishing') return // let the last phrase land
    remembered.current = resolveInsertTarget(activePaneRef.current)
    void window.forge.stt.start().then(setStatus)
  }, [])

  const reload = useCallback((force?: boolean) => {
    void window.forge.stt.reload(force).then(setStatus)
  }, [])

  /* --------------------------------------------------------------- hotkey */

  const hotkey = state.settings.sttHotkey

  useEffect(() => {
    if (!hotkey) return
    const bareModifier = /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(hotkey)
    // A lone modifier only counts once nothing else was pressed while it was
    // held — otherwise Ctrl+Shift+C would start dictating on the way out.
    let armed = false

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== hotkey) {
        armed = false
        return
      }
      if (!bareModifier) {
        e.preventDefault()
        e.stopPropagation()
        toggle()
        return
      }
      if (!e.repeat) armed = true
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== hotkey || !bareModifier) return
      if (!armed) return
      armed = false
      toggle()
    }

    const disarm = (): void => {
      armed = false
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', disarm, true)
    window.addEventListener('blur', disarm)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', disarm, true)
      window.removeEventListener('blur', disarm)
    }
  }, [hotkey, toggle])

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
  const named: Record<string, string> = {
    ControlRight: 'Right Ctrl',
    ControlLeft: 'Left Ctrl',
    AltRight: 'Right Alt',
    AltLeft: 'Left Alt',
    ShiftRight: 'Right Shift',
    ShiftLeft: 'Left Shift',
    ScrollLock: 'Scroll Lock',
    Pause: 'Pause'
  }
  return named[code] ?? code
}

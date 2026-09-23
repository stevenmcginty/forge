import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { setCommandHandler } from '@/lib/keymapRegistry'
import { registerSurface, setComposerRoute, setDockVoice, useShellMode } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { useVoiceHubController } from '@/state/VoiceHubController'
import { BoardArrival } from './BoardArrival'
import { BoardSurface } from './BoardSurface'
import { CheatSheet } from './CheatSheet'
import { composerAim } from './hubView'
import { NavBeacon } from './NavBeacon'
import { TalkSurface } from './TalkSurface'
import { VoicePill } from './VoicePill'
import './hub.css'
import './PaneName.css'

/**
 * The voice hub's UI, plugged into D1's shell — everything the old floating
 * VoiceHub card and the always-on-top overlay orb used to be, and more:
 *
 *   dock socket   the voice pill (setDockVoice)
 *   composer      typed lines go to the voice brain while live talk is on
 *                 (setComposerRoute); the composer itself lives in ./Composer
 *   surfaces      Board (beside the agents) and Talk (the whole stage)
 *   overlays      the arrival beacon on a pane picked by name, the "new on the
 *                 board" tile, the keyboard cheat sheet
 *   keys          `voice.mode.toggle` (Dictate ⇄ Live) and `app.cheatSheet`
 *
 * The engine stays headless in VoiceHubControllerProvider; nothing here can
 * run a second copy of it.
 */

registerSurface({ id: 'board', title: 'Board', placement: 'beside', order: 20, render: BoardSurface })
registerSurface({ id: 'talk', title: 'Talk', placement: 'full', order: 30, render: TalkSurface })
setDockVoice(VoicePill)

export function HubLayer(): ReactNode {
  const { state, actions } = useApp()
  const hub = useVoiceHubController()
  const dictation = useDictation()
  const mode = useShellMode()
  const [cheat, setCheat] = useState(false)
  const closeCheat = useCallback(() => setCheat(false), [])

  const live = useRef({ hub, dictation })
  live.current = { hub, dictation }

  /* ------------------------------------------------ composer → voice brain */

  useEffect(() => {
    setComposerRoute(({ text }) => {
      const h = live.current.hub
      if (h.phase === 'off' || composerAim() !== 'hub') return false
      h.askText(text)
      return true
    })
    return () => setComposerRoute(null)
  }, [])

  /* ---------------------------------------------------------------- keys */

  useEffect(() => {
    const offMode = setCommandHandler('voice.mode.toggle', () => {
      const { hub: h, dictation: d } = live.current
      if (h.phase !== 'off') {
        h.stop()
        return
      }
      // One microphone at a time: dictation stops before live talk opens.
      if (d.listening) d.toggle()
      h.start()
    })
    const offCheat = setCommandHandler('app.cheatSheet', () => setCheat((v) => !v))
    const onCheat = (): void => setCheat((v) => !v)
    window.addEventListener(HUB_CHEAT_SHEET_EVENT, onCheat)
    return () => {
      offMode()
      offCheat()
      window.removeEventListener(HUB_CHEAT_SHEET_EVENT, onCheat)
    }
  }, [])

  /* -------------------------------------------- the old card → Talk
   *
   * Ctrl+Shift+G and the top bar's expand button still flip the stored hub
   * card (`settings.voiceHub.mode`) — they are not this file's to rewire. The
   * card is gone, so its "expanded" now means the Talk surface, both ways:
   * opening Talk by any route lights the button, and leaving Talk puts the
   * card back in its dock. The floating pill is retired, so `floating` (what
   * the card minimises to) is treated as docked.
   */
  const hubMode = state.settings.voiceHub.mode
  const lastShell = useRef<string | null>(mode)
  useEffect(() => {
    if (!state.ready) return
    if (hubMode === 'expanded' && mode !== 'talk') uiCommands.run('set-mode', 'talk')
    else if (hubMode === 'floating') {
      actions.setVoiceHub({ mode: 'docked' })
      if (mode === 'talk') uiCommands.run('set-mode', 'agents')
    }
    // Only the hub mode's own changes drive this half.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, state.ready])

  useEffect(() => {
    const was = lastShell.current
    lastShell.current = mode
    if (!state.ready || was === mode) return
    if (mode === 'talk' && hubMode !== 'expanded') actions.setVoiceHub({ mode: 'expanded' })
    else if (was === 'talk' && hubMode === 'expanded') actions.setVoiceHub({ mode: 'docked' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, state.ready])

  return (
    <>
      <NavBeacon />
      <BoardArrival />
      <CheatSheet open={cheat} onClose={closeCheat} />
    </>
  )
}

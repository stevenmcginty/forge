import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { setCommandHandler } from '@/lib/keymapRegistry'
import { registerSurface } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { useVoiceHubController } from '@/state/VoiceHubController'
import { setAgentVoice } from './barMode'
import { BoardArrival } from './BoardArrival'
import { BoardSurface } from './BoardSurface'
import { CheatSheet } from './CheatSheet'
import { hubAsk, type HubView } from './hubView'
import { NavBeacon } from './NavBeacon'
import './hub.css'
import './PaneName.css'

/**
 * The voice hub's UI, plugged into D1's shell:
 *
 *   composer      the one bar — type to Forge, or flip Listen on and talk to
 *                 it hands-free; it lives in ./Composer (Listen is ./VoicePill)
 *   surfaces      Board (beside the agents). There is no Talk page any more:
 *                 the bar is where you talk to Forge, so "go to talk" (and
 *                 Ctrl+Shift+G) puts you in the bar.
 *   overlays      the arrival beacon on a pane picked by name, the "new on the
 *                 board" tile, the keyboard cheat sheet
 *   keys          `app.cheatSheet`
 *   agent voice   the Listen key (Right Shift) and any phrase meant for the
 *                 agent go to the main agent (setAgentVoice, read by
 *                 useDictation). The Dictate key (Right Alt) stays raw
 *                 dictation into the focused pane.
 *
 * The engine stays headless in VoiceHubControllerProvider; nothing here can
 * run a second copy of it.
 */

registerSurface({ id: 'board', title: 'Board', placement: 'beside', order: 20, render: BoardSurface })

export function HubLayer(): ReactNode {
  const { state, actions } = useApp()
  const hub = useVoiceHubController() as HubView
  const dictation = useDictation()
  const [cheat, setCheat] = useState(false)
  const closeCheat = useCallback(() => setCheat(false), [])

  const live = useRef({ hub, dictation })
  live.current = { hub, dictation }

  /* ------------------------------------------------ agent-mode voice */

  useEffect(() => {
    setAgentVoice({
      key: (intent) => {
        const h = live.current.hub
        // Push-to-talk's release: a live session keeps listening, and an armed
        // Claude agent takes its own release before it ever gets here.
        if (intent === 'ptt-end') return true
        if (h.phase === 'off' || h.phase === 'error') h.start()
        else if (intent === 'toggle') h.stop()
        return true
      },
      phrase: (text) => {
        hubAsk(live.current.hub, text, 'voice')
        return true
      }
    })
    return () => setAgentVoice(null)
  }, [])

  /* ---------------------------------------------------------------- keys */

  useEffect(() => {
    const offCheat = setCommandHandler('app.cheatSheet', () => setCheat((v) => !v))
    const onCheat = (): void => setCheat((v) => !v)
    window.addEventListener(HUB_CHEAT_SHEET_EVENT, onCheat)
    return () => {
      offCheat()
      window.removeEventListener(HUB_CHEAT_SHEET_EVENT, onCheat)
    }
  }, [])

  /* ------------------------------------------- the old card → the bar
   *
   * Ctrl+Shift+G still flips the stored hub card (`settings.voiceHub.mode`) —
   * it is not this file's to rewire. The card and the Talk page are gone, so
   * "expanded" now means "put me in the bar": the card folds straight back to
   * docked and the bar takes the keyboard. `floating` is treated as docked.
   */
  const hubMode = state.settings.voiceHub.mode
  useEffect(() => {
    if (!state.ready) return
    if (hubMode === 'expanded') {
      actions.setVoiceHub({ mode: 'docked' })
      uiCommands.run('focus-composer')
    } else if (hubMode === 'floating') actions.setVoiceHub({ mode: 'docked' })
    // Only the hub mode's own changes drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, state.ready])

  return (
    <>
      <NavBeacon />
      <BoardArrival />
      <CheatSheet open={cheat} onClose={closeCheat} />
    </>
  )
}

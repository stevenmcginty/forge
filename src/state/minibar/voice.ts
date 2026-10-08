import { useMemo } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { listenState, useHubView } from '@/components/hub/hubView'
import { useKeymap } from '@/hooks/useHub'
import { TALK_AGENT_ID } from '@/lib/shortcutCommands'
import { useApp } from '@/state/AppState'
import type { MiniBarPart } from './part'

/**
 * The mini bar's voice: dictation into its box, the mic button, Listen and the
 * talk keys (docs/MINI-BAR.md, 4.4 and 5.5).
 *
 * For now it only reports: no dictation, Listen as the hub has it, no keymap,
 * and the configured talk keys. It takes no calls yet.
 */
export function useMiniVoice(): MiniBarPart {
  const { state } = useApp()
  const hub = useHubView()
  const keymap = useKeymap()
  const ls = listenState(hub)
  const listenOn = ls.on
  const speaking = ls.look === 'speaking'
  const muted = hub.muted
  const dictateKey = state.settings.sttHotkey || 'AltRight'
  const listenKey = keymap.commands.find((c) => c.id === TALK_AGENT_ID)?.keys[0] ?? 'ShiftRight'

  return useMemo(() => {
    const slice: Partial<MiniBarState> = {
      dictation: { phase: 'off' },
      listen: { on: listenOn, speaking, muted },
      keymap: [],
      talkKeys: { dictate: dictateKey, listen: listenKey }
    }
    return { slice, handle: () => false }
  }, [listenOn, speaking, muted, dictateKey, listenKey])
}

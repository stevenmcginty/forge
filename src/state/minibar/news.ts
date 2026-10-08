import { useMemo } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { useApp } from '@/state/AppState'
import type { MiniBarPart } from './part'

/**
 * The mini bar's news: done / asking / stopped events, the toasts, Activity,
 * Peek, the chat with Forge and spoken updates (docs/MINI-BAR.md, 4.9 to 4.11).
 *
 * For now it only reports: nothing has happened, nothing to peek at, and the
 * "Speak updates" setting. It takes no calls yet.
 */
export function useMiniNews(): MiniBarPart {
  const { state } = useApp()
  const speakUpdates = state.settings.miniSpeakUpdates !== false

  return useMemo(() => {
    const slice: Partial<MiniBarState> = {
      events: [],
      unseen: 0,
      toasts: [],
      peek: null,
      thread: [],
      speakUpdates
    }
    return { slice, handle: () => false }
  }, [speakUpdates])
}

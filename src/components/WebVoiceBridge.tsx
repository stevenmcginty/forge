import { useEffect, useRef } from 'react'
import { answerWebVoiceAsk } from '@/lib/realtime/web-bridge'
import { useApp } from '@/state/AppState'

/**
 * A browser running the voice agent, asking for the renderer's half — the
 * setup bundle, a tool call, or the app context. Renders nothing; the answers
 * are src/lib/realtime/web-bridge.ts's.
 *
 * Every step of `window.forge?.web?.onVoiceAsk?.(...)` is optional-chained for
 * the reason WebProjectRemoveBridge gives: a preload from before this existed
 * has no such member, and a TypeError here would blank the renderer.
 */
export function WebVoiceBridge(): null {
  const { state } = useApp()
  // Read when an ask lands, so a settings change does not re-subscribe.
  const settings = useRef(state.settings)
  settings.current = state.settings

  useEffect(() => {
    const unsubscribe = window.forge?.web?.onVoiceAsk?.((ask) => {
      void answerWebVoiceAsk(ask, settings.current).then((reply) => window.forge?.web?.voiceResult?.(reply))
    })
    return () => unsubscribe?.()
  }, [])

  return null
}

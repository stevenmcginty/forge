import { useMemo } from 'react'
import type { VoiceConfig } from '@/lib/tts'
import { useApp } from '@/state/AppState'

/**
 * The voice Forge Brain's replies are read in: the one Settings → Voice picks
 * for the voice agent (Edge or Gemini neural, the local voice as the last
 * resort), built the way VoiceSection's sample button builds it.
 */
export function useBrainVoice(): VoiceConfig {
  const { state } = useApp()
  const s = state.settings
  return useMemo(
    () => ({
      engine: s.voiceEngine,
      hasKey: s.geminiKey.trim().length > 0,
      edgeVoice: s.voiceEdgeVoice,
      geminiVoice: s.voiceTtsVoice,
      ttsModel: s.voiceTtsModel,
      localVoice: s.voiceReplyVoice
    }),
    [s.voiceEngine, s.geminiKey, s.voiceEdgeVoice, s.voiceTtsVoice, s.voiceTtsModel, s.voiceReplyVoice]
  )
}

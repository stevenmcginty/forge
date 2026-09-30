import { useState, type ReactNode } from 'react'
import { BRAIN_VOICE_DEFAULT, BRAIN_VOICE_FALLBACKS } from '@shared/brain'
import { EDGE_VOICES } from '@shared/tts'
import { voiceSpeaker } from '@/lib/tts'
import { useApp } from '@/state/AppState'
import { Row } from './parts'

/**
 * Forge Brain's own voice (`settings.brainVoice`): an Edge neural voice apart
 * from the voice agents', so Steve can hear which one is talking. English
 * voices only, British first; "Play sample" says a line in it the way the
 * brain's replies are said — Edge, never the built-in SAPI voice, and "Voice
 * unavailable" in words when no neural voice answers.
 *
 * Self-contained: mounted by the Forge Brain settings page.
 */

const SAMPLE_LINE = "Right, I've had a look across your projects. Two agents are working and one needs you."

/** English Edge voices, British first; the rest of the list keeps its order. */
const VOICES = [...EDGE_VOICES]
  .filter((v) => v.name.startsWith('en-'))
  .sort((a, b) => Number(!b.name.startsWith('en-GB-')) - Number(!a.name.startsWith('en-GB-')))

export function BrainVoicePicker(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const voice = s.brainVoice || BRAIN_VOICE_DEFAULT
  const [sampling, setSampling] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const sample = (): void => {
    setSampling(true)
    setUnavailable(false)
    void voiceSpeaker
      .speak(SAMPLE_LINE, {
        engine: 'edge',
        hasKey: false,
        edgeVoice: voice,
        geminiVoice: '',
        ttsModel: '',
        localVoice: '',
        edgeVoices: [voice, ...BRAIN_VOICE_FALLBACKS.filter((v) => v !== voice)],
        neuralOnly: true
      })
      .then((said) => setUnavailable(!said.spoke && said.engine === 'none'))
      .finally(() => setSampling(false))
  }

  return (
    <Row
      label="Forge Brain's voice"
      hint={unavailable ? 'Voice unavailable — no neural voice answered. Replies stay in the chat.' : 'Its own voice, so you know it is the brain talking'}
      htmlFor="brain-voice"
    >
      <select
        id="brain-voice"
        className="select"
        value={voice}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => actions.patchSettings({ brainVoice: e.target.value })}
      >
        {VOICES.map((v) => (
          <option key={v.name} value={v.name}>
            {`${v.label} — ${v.character.toLowerCase()}${v.name === BRAIN_VOICE_DEFAULT ? ' (default)' : ''}`}
          </option>
        ))}
      </select>
      <button type="button" className="ghost-btn" disabled={sampling} onClick={sample}>
        {sampling ? 'Speaking…' : 'Play sample'}
      </button>
    </Row>
  )
}

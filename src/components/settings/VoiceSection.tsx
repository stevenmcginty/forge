import type { ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { DictationSetup } from '../DictationSetup'
import { Card, Row, Section, Stepper, Toggle } from './parts'
import { SpeechEngineCard } from './SpeechEngineCard'

/**
 * Dictation and the voice agent's own settings.
 *
 * The engine card comes first because it is the thing that is either working or
 * not; the paths below it are the fix when it is not.
 */
export function VoiceSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section
      title="Voice"
      blurb="Dictation runs on this machine — the model, the microphone and the transcription never leave it."
    >
      <SpeechEngineCard />

      <Card title="Dictation" hint="Push the toggle key, talk, and the words are typed into the focused pane.">
        <DictationSetup />
      </Card>

      <Card
        title="Voice agent"
        hint="The panel itself is Ctrl+Shift+G. Relay hands a finished agent turn back to the voice agent without you having to ask."
      >
        <Row label="Auto-relay finished turns" hint="Off means you decide what gets sent back">
          <Toggle
            checked={s.voiceAutoRelay}
            onChange={(on) => actions.patchSettings({ voiceAutoRelay: on })}
            label="Auto-relay finished turns"
          />
        </Row>

        <Row label="Quiet before a turn counts as finished" hint="An agent that pauses to think is not done">
          <Stepper
            label="Relay grace period"
            value={s.voiceRelayGraceMs}
            display={`${(s.voiceRelayGraceMs / 1000).toFixed(1)}s`}
            min={0}
            max={30_000}
            step={500}
            onChange={(ms) => actions.patchSettings({ voiceRelayGraceMs: ms })}
          />
        </Row>

        <Row label="Per-project memory" hint="Remember what the voice agent learned about each project">
          <span className="ssoon">coming soon</span>
        </Row>
      </Card>
    </Section>
  )
}

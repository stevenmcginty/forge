import { useEffect, useState, type ReactNode } from 'react'
import type { VoiceReplyMode } from '@shared/types'
import { chooseVoice, speaker } from '@/lib/speech'
import { useApp } from '@/state/AppState'
import { DictationSetup } from '../DictationSetup'
import { Card, Row, Section, Stepper, TextField, Toggle } from './parts'
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

        <Row
          label="New projects go in"
          hint="Where a spoken “create a project called…” puts the folder. Blank means your Desktop."
        >
          <TextField
            value={s.projectsRoot}
            mono
            placeholder="(Desktop)"
            onCommit={(next) => actions.patchSettings({ projectsRoot: next.trim() })}
          />
        </Row>

        <Row label="Per-project memory" hint="Remember what the voice agent learned about each project">
          <span className="ssoon">coming soon</span>
        </Row>
      </Card>

      <SpokenRepliesCard />
    </Section>
  )
}

const MODES: Array<{ id: VoiceReplyMode; label: string; hint: string }> = [
  { id: 'text', label: 'Written', hint: 'Replies appear in the panel only' },
  { id: 'both', label: 'Written + spoken', hint: 'Both — the default' },
  { id: 'voice', label: 'Spoken only', hint: 'Hides the transcript and the text box' }
]

/**
 * Talking back.
 *
 * The voice list is populated asynchronously on Windows: Chromium returns an
 * empty array on the first call and fires `voiceschanged` once SAPI has been
 * enumerated, so this listens rather than reading once and believing it.
 */
function SpokenRepliesCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const [voices, setVoices] = useState(() => speaker.voices())

  useEffect(() => {
    if (!speaker.available) return undefined
    const refresh = (): void => setVoices(speaker.voices())
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh)
  }, [])

  const picked = chooseVoice(voices, s.voiceReplyVoice)

  return (
    <Card
      title="Spoken replies"
      hint="Speech comes from the voices installed on this PC — nothing is sent anywhere to say it. Drafted prompts are never read aloud."
    >
      <Row label="How the agent replies" hint="Also switchable from the voice panel's header">
        <div className="seg" role="group" aria-label="Reply mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="seg__btn"
              data-on={s.voiceReplyMode === m.id ? 'true' : undefined}
              aria-pressed={s.voiceReplyMode === m.id}
              disabled={m.id !== 'text' && !speaker.available}
              title={m.hint}
              onClick={() => actions.patchSettings({ voiceReplyMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Voice" hint={picked ? `Now using ${picked.name}` : 'No speech voices are installed on this PC'}>
        <select
          className="field__input"
          value={s.voiceReplyVoice}
          disabled={voices.length === 0}
          onChange={(e) => actions.patchSettings({ voiceReplyVoice: e.target.value })}
        >
          <option value="">Best available</option>
          {voices.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Try it" hint="Say something in the chosen voice">
        <button
          type="button"
          className="ghost-btn"
          disabled={voices.length === 0}
          onClick={() => void speaker.speak('Right. Three Claude Code terminals open.', { voiceName: s.voiceReplyVoice })}
        >
          Speak a test line
        </button>
      </Row>
    </Card>
  )
}

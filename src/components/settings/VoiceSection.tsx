import { useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_EDGE_VOICE,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  EDGE_VOICES,
  TTS_MODELS,
  TTS_SAMPLE_LINE,
  TTS_VOICES
} from '@shared/tts'
import type { Settings, VoiceEngine, VoiceReplyMode } from '@shared/types'
import { AGENT_BRAINS, agentBrainSpec, isRealtimeBrain, migrateAgentBrain } from '@shared/agent-brain'
import { GEMINI_VOICES, OPENAI_VOICES, providerSpec, resolveVoice } from '@shared/realtime'
import { brainHasKey } from '@/lib/realtime/provider'
import { chooseVoice, speaker } from '@/lib/speech'
import { earconListening } from '@/lib/earcon'
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/lib/voicebrain'
import { voiceSpeaker, type VoiceConfig } from '@/lib/tts'
import { useApp } from '@/state/AppState'
import { DictationSetup } from '../DictationSetup'
import { Card, KeyField, Row, Section, Stepper, TextField, Toggle } from './parts'
import '../hub/VoiceSettings.css'
import { SpeechEngineCard } from './SpeechEngineCard'
import { BrainTestButton } from './BrainTest'

/**
 * Dictation and the voice agent's own settings.
 *
 * The engine card comes first because it is the thing that is either working or
 * not; the paths below it are the fix when it is not.
 *
 * One thing this page has to keep saying out loud: a spoken turn is three
 * different providers, not one. Hearing you is Parakeet, on this machine.
 * Thinking is whichever brain is set in Models & APIs. Talking back is Gemini
 * or Windows. They are chosen independently, and the only reason to know that
 * is that picking Groq as your brain does not — cannot — change the voice, and
 * a page that lists a Gemini model under a card called "Voice agent" reads like
 * it just ignored you. Hence the brain row below and the "voice, not the brain"
 * hints further down: nothing here changes what thinks.
 */
export function VoiceSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section
      title="Voice"
      blurb="Hearing you happens on this machine — the model, the microphone and the transcription never leave it. Thinking and talking back are set separately."
    >
      <LiveTalkCard />

      <SpeechEngineCard />

      <Card title="Dictation" hint="Tap the talk key to start or stop. Hold it to push-to-talk. Words land in the focused pane.">
        <DictationSetup />
      </Card>

      <Card
        title="Wake word"
        hint="Say “hey Jarvis” and the agent activates on its own — no hotkey. Dictation and its toggle key work exactly as before, whether this is on or off."
      >
        <Row
          label="Listen for “hey Jarvis”"
          hint="Keeps the mic open in the STT sidecar at about 1% CPU, just listening for the phrase, until it hears it."
        >
          <Toggle
            checked={s.voiceWakeWord}
            onChange={(on) => actions.patchSettings({ voiceWakeWord: on })}
            label="Listen for “hey Jarvis”"
          />
        </Row>
        <p className="scard__hint">
          Needs the <span className="mono">openwakeword</span> package in the STT Python environment set up under
          Dictation above.
        </p>
      </Card>

      <Card
        title="Voice agent"
        hint="The Talk view is Ctrl+Shift+G. Relay hands a finished agent turn back to the voice agent without you having to ask."
      >
        <Row
          label="Thinking model"
          hint="What actually answers you: the Agent brain at the top of this page. Its key and model live in Models & APIs."
        >
          <div className="seg" role="group" aria-label="Thinking model">
            <span className="field__input" style={{ pointerEvents: 'none' }}>
              {describeBrain(s)}
            </span>
            <button
              type="button"
              className="ghost-btn"
              title="Open Models & APIs"
              onClick={() => actions.setSettingsSection('models')}
            >
              Change
            </button>
          </div>
        </Row>

        <Row
          label="Let me talk over it"
          hint="Keeps an echo-cancelled mic open while the agent speaks, so interrupting it out loud works. Turn off if your speakers bleed into your mic."
        >
          <Toggle
            checked={s.voiceBargeIn}
            onChange={(on) => actions.patchSettings({ voiceBargeIn: on })}
            label="Let me talk over it"
          />
        </Row>

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

        <Row
          label="Let the model rewrite the project summary"
          hint="Memory is kept for free from what you say and what runs. This adds one small API call every tenth exchange to keep the summary tidy."
        >
          <Toggle
            checked={s.memoryLlmSummarize}
            onChange={(on) => actions.patchSettings({ memoryLlmSummarize: on })}
            label="Let the model rewrite the project summary"
          />
        </Row>
      </Card>

      <SpokenRepliesCard />
    </Section>
  )
}

/**
 * Live talk: which brain the voice hub uses, what it costs, its key and its
 * voice — all on one card, so picking a provider never means a trip to
 * another page and back.
 *
 * Claude is the free default and the fallback: a provider without its key
 * simply runs on Claude + Parakeet until one is added, and the tile says so
 * in words. The realtime providers speak in their own voice, so the Spoken
 * replies card below only applies to Claude.
 */
function LiveTalkCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const brain = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const brainSpec = agentBrainSpec(brain)
  // A realtime brain speaks in its own voice; the key rows below are for it.
  const vendor = isRealtimeBrain(brain) ? providerSpec(brain).vendor : null
  const keyed = brainHasKey(brain, s)
  const voices = vendor === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES
  const voice = vendor ? resolveVoice(vendor, s.voiceHubVoice[vendor]) : null

  return (
    <Card
      title="Agent brain"
      hint="Who answers the bottom bar — in Agent mode it hears you hands-free, and it can open agent panes, type into them and browse inside Forge. One setting for every brain."
    >
      <div className="lt-grid" role="radiogroup" aria-label="Agent brain">
        {AGENT_BRAINS.map((b) => {
          const on = brain === b.id
          const has = brainHasKey(b.id, s)
          const word = b.key === null ? 'Free' : has ? 'Key set' : 'Needs a key'
          return (
            <div key={b.id} className="lt-tilewrap">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                className="lt-tile"
                data-on={on ? 'true' : undefined}
                data-ready={has ? 'true' : undefined}
                onClick={() => actions.patchSettings({ agentBrain: b.id })}
              >
                <span className="lt-tile__top">
                  <span className="lt-tile__radio" aria-hidden="true">
                    {on ? '●' : '○'}
                  </span>
                  <span className="lt-tile__name">{b.id === 'claude' ? 'Claude + Parakeet' : b.label}</span>
                  <span className="lt-tile__state" data-tone={b.key === null ? 'free' : has ? 'ok' : 'need'}>
                    {word}
                  </span>
                </span>
                <span className="lt-tile__model mono">{isRealtimeBrain(b.id) ? providerSpec(b.id).model : b.auth}</span>
                <span className="lt-tile__cost">{b.note}</span>
              </button>
              <BrainTestButton target={{ kind: 'brain', id: b.id }} />
            </div>
          )
        })}
      </div>

      {!keyed ? (
        <p className="lt-fallback" role="status">
          <span aria-hidden="true">◆</span> No {brainSpec.auth} yet — {brainSpec.label} falls back to Claude + Parakeet
          (free) until you add one{vendor ? ' below' : ' in Models & APIs'}.
        </p>
      ) : null}

      {vendor === 'gemini' ? (
        <KeyField
          label="Gemini API key"
          value={s.geminiKey}
          onCommit={actions.setGeminiKey}
          placeholder="AIza…"
          note="The same key the rest of Forge's Gemini features use. Forge's main process mints a short-lived token for each session; the key never reaches the page."
        />
      ) : null}
      {vendor === 'openai' ? (
        <KeyField
          label="OpenAI API key"
          value={s.openaiKey}
          onCommit={(key) => actions.patchSettings({ openaiKey: key.trim() })}
          placeholder="sk-…"
          note="An API platform key with billing — a ChatGPT subscription does not cover it. It stays in Forge's main process; each session gets a short-lived secret."
        />
      ) : null}

      {vendor && voice ? (
        <div className="lt-voices">
          <span className="lt-voices__label">
            Voice <span className="lt-voices__now">{voice}</span>
            <span className="lt-voices__hint">{vendor === 'openai' ? 'marin and cedar sound best' : 'shared with Gemini TTS'}</span>
          </span>
          <div className="lt-voices__list" role="radiogroup" aria-label="Voice">
            {voices.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === voice}
                className="lt-voice"
                data-on={v === voice ? 'true' : undefined}
                onClick={() => actions.patchSettings({ voiceHubVoice: { ...s.voiceHubVoice, [vendor]: v } })}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Row
        label="Silence that sends"
        hint="Agent mode is hands-free: when you stop talking for this long, what you said goes to the agent by itself and the mic stays open for the next turn."
      >
        <Stepper
          value={s.agentSilenceMs}
          display={`${(s.agentSilenceMs / 1000).toFixed(1)} s`}
          onChange={(v) => actions.patchSettings({ agentSilenceMs: v })}
          min={500}
          max={2000}
          step={100}
          label="Silence that sends"
        />
      </Row>
      <Row label="Auto-send dictation" hint="Dictate mode: press Enter in the pane after each phrase. Off means you press Enter yourself.">
        <Toggle
          checked={s.dictateAutoSend}
          onChange={(on) => actions.patchSettings({ dictateAutoSend: on })}
          label="Auto-send dictation"
        />
      </Row>
      <Row
        label="Agents use Forge's browser only"
        hint="Claude panes Forge opens cannot use Claude-in-Chrome or Playwright; web tasks go to Forge's built-in browser. Takes effect for new panes."
      >
        <Toggle
          checked={s.agentsForgeBrowserOnly}
          onChange={(on) => actions.patchSettings({ agentsForgeBrowserOnly: on })}
          label="Agents use Forge's browser only"
        />
      </Row>
    </Card>
  )
}

/**
 * The brain, in one line, the way the hub's own badge says it.
 *
 * It names the model and not just the provider because "Groq" alone is exactly
 * the ambiguity this row exists to kill — and it says when a key is missing,
 * since an unkeyed brain answers with a stub and looks broken rather than
 * unconfigured.
 */
function describeBrain(s: Settings): string {
  const id = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const label = agentBrainSpec(id).label
  if (!brainHasKey(id, s)) return `${label} · no key yet — Claude answers`
  switch (id) {
    case 'groq':
      return `Groq · ${s.groqModel?.trim() || DEFAULT_GROQ_MODEL}`
    case 'openrouter':
      return `OpenRouter · ${s.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL}`
    case 'gemini-flash':
      return `Gemini Flash · ${s.geminiModel?.trim() || DEFAULT_GEMINI_MODEL}`
    case 'claude':
      return `Claude · ${s.voiceClaudeModel || 'opus'}`
    default:
      return label
  }
}

const MODES: Array<{ id: VoiceReplyMode; label: string; hint: string }> = [
  { id: 'text', label: 'Written', hint: 'Replies appear in the panel only' },
  { id: 'both', label: 'Written + spoken', hint: 'Both — the default' },
  { id: 'voice', label: 'Spoken only', hint: 'Hides the transcript and the text box' }
]

const ENGINES: Array<{ id: VoiceEngine; label: string; hint: string }> = [
  { id: 'edge', label: 'Neural — free', hint: 'Microsoft’s Edge voices. No key, no quota — the default' },
  { id: 'gemini', label: 'Neural — Gemini', hint: 'Google’s voices. Needs the Gemini key, and a free key runs out after a few sentences a minute' },
  { id: 'local', label: 'Built-in', hint: 'Windows’ own voices. No key, no network — and it sounds like it' }
]

/**
 * Talking back.
 *
 * Two engines, and the card is honest about which one is doing the talking. The
 * neural one is the point — Steve's verdict on the built-in voices was that
 * they sound robotic, and he was right — but it needs a key and the network, so
 * the built-in one is always there underneath and takes over by itself when the
 * good one cannot run.
 *
 * The local voice list is populated asynchronously on Windows: Chromium returns
 * an empty array on the first call and fires `voiceschanged` once SAPI has been
 * enumerated, so this listens rather than reading once and believing it.
 */
function SpokenRepliesCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const [voices, setVoices] = useState(() => speaker.voices())
  /** The voice a sample is currently being fetched for, so the button can say so. */
  const [sampling, setSampling] = useState('')

  useEffect(() => {
    if (!speaker.available) return undefined
    const refresh = (): void => setVoices(speaker.voices())
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh)
  }, [])

  const picked = chooseVoice(voices, s.voiceReplyVoice)
  const hasKey = s.geminiKey.trim().length > 0
  const neural = s.voiceEngine === 'edge' || (s.voiceEngine === 'gemini' && hasKey)
  const config: VoiceConfig = {
    engine: s.voiceEngine,
    hasKey,
    edgeVoice: s.voiceEdgeVoice,
    geminiVoice: s.voiceTtsVoice,
    ttsModel: s.voiceTtsModel,
    localVoice: s.voiceReplyVoice
  }

  /**
   * Play a line in one voice, without changing the setting.
   *
   * Auditioning has to be free of consequences — the whole point is hearing
   * three of them back to back before picking. So the config is overridden for
   * this one call rather than saved.
   */
  const sample = (voice: string): void => {
    setSampling(voice || DEFAULT_TTS_VOICE)
    void voiceSpeaker
      .speak(TTS_SAMPLE_LINE, { ...config, geminiVoice: voice }, (msg) => actions.setNotice(msg))
      .finally(() => setSampling(''))
  }

  /** The same audition, for the free engine's voices. */
  const sampleEdge = (voice: string): void => {
    setSampling(voice || DEFAULT_EDGE_VOICE)
    void voiceSpeaker
      .speak(TTS_SAMPLE_LINE, { ...config, engine: 'edge', edgeVoice: voice }, (msg) => actions.setNotice(msg))
      .finally(() => setSampling(''))
  }

  /**
   * Picking the Gemini engine also pins its voice. Load-bearing, not a
   * nicety: the store treats "engine gemini, no voice picked" as the stale
   * pre-Edge default and migrates it to Edge on the next load — so a
   * deliberate choice of Gemini has to write a voice name to survive.
   */
  const pickEngine = (id: VoiceEngine): void => {
    if (id === 'gemini' && !s.voiceTtsVoice.trim()) {
      actions.patchSettings({ voiceEngine: id, voiceTtsVoice: DEFAULT_TTS_VOICE })
      return
    }
    actions.patchSettings({ voiceEngine: id })
  }

  return (
    <Card
      title="Spoken replies"
      hint={
        neural
          ? 'The agent speaks with a neural voice — it reads out whatever your chosen brain wrote, and does not think for itself. Only the words it is about to say leave this machine — never the transcript, never a drafted prompt.'
          : 'Speech comes from the voices installed on this PC — nothing is sent anywhere to say it. Drafted prompts are never read aloud.'
      }
    >
      <Row label="How the agent replies" hint="Also switchable from the voice hub's header">
        <div className="seg" role="group" aria-label="Reply mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="seg__btn"
              data-on={s.voiceReplyMode === m.id ? 'true' : undefined}
              aria-pressed={s.voiceReplyMode === m.id}
              disabled={m.id !== 'text' && !speaker.available && !neural}
              title={m.hint}
              onClick={() => actions.patchSettings({ voiceReplyMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Row>

      <Row
        label="Which voice engine"
        hint={
          s.voiceEngine === 'gemini' && !hasKey
            ? 'No Gemini key yet — the built-in voice is speaking until there is one'
            : 'A neural engine that fails falls to the other neural engine first, and only then to the built-in voice — so the voice stays human unless the network itself is gone'
        }
      >
        <div className="seg" role="group" aria-label="Voice engine">
          {ENGINES.map((e) => (
            <button
              key={e.id}
              type="button"
              className="seg__btn"
              data-on={s.voiceEngine === e.id ? 'true' : undefined}
              aria-pressed={s.voiceEngine === e.id}
              title={e.hint}
              onClick={() => pickEngine(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </Row>

      {s.voiceEngine === 'edge' ? (
        <>
          <Row
            label="Neural voice"
            hint="Microsoft’s Edge voices — free, no key, no quota. Sonia, warm and British, is the default."
          >
            <select
              className="field__input"
              value={s.voiceEdgeVoice}
              onChange={(e) => actions.patchSettings({ voiceEdgeVoice: e.target.value })}
            >
              <option value="">Default — Sonia (warm, British)</option>
              {EDGE_VOICES.map((v) => (
                <option key={v.name} value={v.name}>
                  {`${v.label} — ${v.character.toLowerCase()}`}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Hear it" hint="Says a real reply, so you are judging the thing you will actually hear">
            <button
              type="button"
              className="ghost-btn"
              disabled={sampling !== ''}
              onClick={() => sampleEdge(s.voiceEdgeVoice)}
            >
              {sampling ? 'Speaking…' : 'Hear a sample'}
            </button>
          </Row>

          <Row label="Compare three" hint="Plays without changing the setting above">
            <div className="seg" role="group" aria-label="Sample an Edge voice">
              {[
                ['en-GB-SoniaNeural', 'Sonia'],
                ['en-IE-EmilyNeural', 'Emily'],
                ['en-US-AriaNeural', 'Aria']
              ].map(([name, label]) => (
                <button
                  key={name}
                  type="button"
                  className="seg__btn"
                  disabled={sampling !== ''}
                  title={`Hear ${label}`}
                  onClick={() => sampleEdge(name as string)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </>
      ) : null}

      {s.voiceEngine === 'gemini' ? (
        <>
          <Row
            label="Neural voice"
            hint={`Google’s own description of each. ${DEFAULT_TTS_VOICE} — the only one they call warm — is the default.`}
          >
            <select
              className="field__input"
              value={s.voiceTtsVoice}
              onChange={(e) => actions.patchSettings({ voiceTtsVoice: e.target.value })}
            >
              <option value="">{`Default — ${DEFAULT_TTS_VOICE} (warm)`}</option>
              {TTS_VOICES.map((v) => (
                <option key={v.name} value={v.name}>
                  {`${v.name} — ${v.character.toLowerCase()}`}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Hear it" hint="Says a real reply, so you are judging the thing you will actually hear">
            <button
              type="button"
              className="ghost-btn"
              disabled={sampling !== ''}
              onClick={() => sample(s.voiceTtsVoice)}
            >
              {sampling ? 'Speaking…' : 'Hear a sample'}
            </button>
          </Row>

          {/*
            Auditioning three at a time is how you actually choose a voice —
            one at a time, going back to the picker in between, tells you
            nothing. These three are the natural, unhurried end of the list:
            warm, soft and breezy. Clicking one does not select it.
          */}
          <Row label="Compare three" hint="Plays without changing the setting above">
            <div className="seg" role="group" aria-label="Sample a voice">
              {['Sulafat', 'Achernar', 'Aoede'].map((name) => (
                <button
                  key={name}
                  type="button"
                  className="seg__btn"
                  disabled={sampling !== ''}
                  title={`Hear ${name}`}
                  onClick={() => sample(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Voice model"
            hint="The model that does the talking, not the thinking — these are Google's only, whatever brain you picked. Newest is quickest, and Forge falls to the next one when a model is out of quota."
          >
            <select
              className="field__input"
              value={s.voiceTtsModel}
              onChange={(e) => actions.patchSettings({ voiceTtsModel: e.target.value })}
            >
              <option value="">{`Default — ${DEFAULT_TTS_MODEL}`}</option>
              {TTS_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${m.label} — ${m.hint}`}
                </option>
              ))}
            </select>
          </Row>
        </>
      ) : null}

      <Row
        label="Built-in voice"
        hint={
          voices.length === 0
            ? 'No speech voices are installed on this PC'
            : neural
              ? `${picked?.name ?? 'None'} — the standby, used only when the neural voice cannot run`
              : picked
                ? `Now using ${picked.name}`
                : 'No speech voices are installed on this PC'
        }
      >
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

      {neural ? null : (
        <Row label="Try it" hint="Say a line in the chosen voice">
          <button
            type="button"
            className="ghost-btn"
            disabled={voices.length === 0}
            onClick={() => void speaker.speak(TTS_SAMPLE_LINE, { voiceName: s.voiceReplyVoice })}
          >
            Hear a sample
          </button>
        </Row>
      )}

      {/*
        The agent used to *say* it was ready for the next thing — the same
        sentence every time, and the single most robotic thing it did. This is
        what replaced it.
      */}
      <Row label="Blip when it hands back" hint="A soft two-note tone instead of announcing that it is listening again">
        <Toggle
          checked={s.voiceEarcons}
          onChange={(on) => {
            actions.patchSettings({ voiceEarcons: on })
            if (on) earconListening()
          }}
          label="Blip when it hands back"
        />
      </Row>
    </Card>
  )
}

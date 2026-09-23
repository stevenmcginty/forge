import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, EDGE_VOICES, TTS_MODELS, TTS_SAMPLE_LINE, TTS_VOICES } from '@shared/tts'
import type { Settings, VoiceEngine } from '@shared/types'
import { isRealtimeBrain, migrateAgentBrain } from '@shared/agent-brain'
import { providerSpec, resolveVoice } from '@shared/realtime'
import { hotkeyLabel } from '@/hooks/useDictation'
import { chooseVoice, speaker } from '@/lib/speech'
import { earconListening } from '@/lib/earcon'
import { voiceSpeaker, type VoiceConfig } from '@/lib/tts'
import { useApp } from '@/state/AppState'
import { MainAgentCard } from './MainAgent'
import { Card, Row, Section, TextField, Toggle } from './parts'
import { SpeechEngineCard } from './SpeechEngineCard'

/**
 * Voice & Agent — the first and biggest page in Settings.
 *
 * The bar at the bottom of the deck is Forge's main agent, and this page is
 * about it, in the order you meet it:
 *
 *   1. Main agent    who answers the bar (the ONE `agentBrain` setting),
 *                    one card per engine — MainAgent.tsx
 *   2. Conversation  talking to it hands-free: the pause that ends your turn,
 *                    when it stops listening, talking over it, spoken replies
 *   3. Dictation     Parakeet into a pane: the talk key, auto-send, the wake
 *                    word, and the engine's files
 *   4. Speech engine whether Parakeet is installed
 *   5. Voice         which voice speaks the replies
 *   6. Habits        relay, where new projects go, the project summary
 *
 * Plain choices rather than sliders: three or four named values you can read
 * at a glance, plus the stored value when it is none of them.
 *
 * Every setting the old Voice and Models pages carried for the agent is on one
 * of these cards; the brain-specific ones (Claude's model, a realtime voice, a
 * text brain's model id) live on that brain's own card.
 */
export function VoiceSection(): ReactNode {
  return (
    <Section
      title="Voice & Agent"
      blurb="The bar at the bottom is Forge’s main agent. It knows every project, tab and pane, and it can open agents, type into them, browse and take you places — inside Forge, whichever engine answers."
    >
      <MainAgentCard />
      <ConversationCard />
      <DictationCard />
      <SpeechEngineCard />
      <VoiceOutCard />
      <HabitsCard />
    </Section>
  )
}

/* ---------------------------------------------------------------- choices */

interface ChoiceOption {
  value: number
  label: string
}

/**
 * A handful of named values in one segmented control. A stored value that is
 * none of them (set by hand, or by an older build) shows as its own segment,
 * selected, so the control never lies about what is saved.
 */
function Choice({
  label,
  value,
  options,
  onChange,
  custom,
  disabled
}: {
  label: string
  value: number
  options: ChoiceOption[]
  onChange: (next: number) => void
  custom: (v: number) => string
  disabled?: boolean
}): ReactNode {
  const all = options.some((o) => o.value === value) || disabled ? options : [...options, { value, label: custom(value) }]
  return (
    <div className="seg va-choice" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {all.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="seg__btn"
          aria-checked={!disabled && o.value === value}
          data-on={!disabled && o.value === value ? 'true' : undefined}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------- conversation */

const PAUSES: ChoiceOption[] = [
  { value: 500, label: 'Quick · 0.5 s' },
  { value: 800, label: 'Normal · 0.8 s' },
  { value: 1200, label: 'Relaxed · 1.2 s' },
  { value: 2000, label: 'Slow · 2 s' }
]

/** Planned: `agentIdleTimeoutMs`, added by a later engine job. Shown now, disabled, so the row's place is settled. */
const IDLE_TIMEOUTS: ChoiceOption[] = [
  { value: 60_000, label: '1 min' },
  { value: 120_000, label: '2 min' },
  { value: 300_000, label: '5 min' },
  { value: 0, label: 'Never' }
]

/**
 * Talking to the main agent the way you talk to a person: it hears you out,
 * answers, and keeps listening — no button per turn.
 */
function ConversationCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  // TODO(agentIdleTimeoutMs): read and write the real field once the engine
  // job adds it to Settings; until then the row is shown and disabled.
  const idleTimeout = 120_000

  return (
    <Card title="Conversation" hint="In Agent mode the mic stays open between turns: you talk, it answers, it listens again.">
      <Row label="Pause that ends your turn" hint="How long you can stop talking before what you said goes to the agent">
        <Choice
          label="Pause that ends your turn"
          value={s.agentSilenceMs}
          options={PAUSES}
          custom={(v) => `${(v / 1000).toFixed(1)} s`}
          onChange={(v) => actions.patchSettings({ agentSilenceMs: v })}
        />
      </Row>

      <Row label="Stop listening after" hint="Minutes of silence before it goes back to sleep — coming next">
        <Choice
          label="Stop listening after"
          value={idleTimeout}
          options={IDLE_TIMEOUTS}
          custom={(v) => `${Math.round(v / 60_000)} min`}
          onChange={() => undefined}
          disabled
        />
      </Row>

      <Row label="Talk over a reply to stop it" hint="Barge-in. Turn off if your speakers bleed into the mic.">
        <Toggle checked={s.voiceBargeIn} onChange={(on) => actions.patchSettings({ voiceBargeIn: on })} label="Talk over a reply to stop it" />
      </Row>

      <Row label="Speak replies" hint="Off, the agent answers in writing only">
        <Toggle
          checked={s.voiceReplyMode !== 'text'}
          onChange={(on) => actions.patchSettings({ voiceReplyMode: on ? 'both' : 'text' })}
          label="Speak replies"
        />
      </Row>
    </Card>
  )
}

/* -------------------------------------------------------------- dictation */

const DICTATE_STOPS: ChoiceOption[] = [
  { value: 5, label: '5 s' },
  { value: 10, label: '10 s' },
  { value: 30, label: '30 s' },
  { value: 0, label: 'Never' }
]

/** The talk keys Forge can listen for (the same list the dictation pill offers). */
const TALK_KEYS = ['ControlRight', 'ControlLeft', 'AltRight', 'ShiftRight', 'ScrollLock', 'Pause', 'F8', 'F9'] as const

function DictationCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Card
      title="Dictation"
      hint="Parakeet hears you on this machine — the audio never leaves it. Tap the talk key to start or stop; hold it to push-to-talk. Words land in the pane."
    >
      <Row label="Talk key" hint="Works in every pane and in the bar" htmlFor="va-talk-key">
        <select
          id="va-talk-key"
          className="select mono"
          value={s.sttHotkey}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => actions.patchSettings({ sttHotkey: e.target.value })}
        >
          {TALK_KEYS.includes(s.sttHotkey as (typeof TALK_KEYS)[number]) ? null : (
            <option value={s.sttHotkey}>{hotkeyLabel(s.sttHotkey)}</option>
          )}
          {TALK_KEYS.map((code) => (
            <option key={code} value={code}>
              {hotkeyLabel(code)}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Auto-send dictation" hint="Dictate mode: press Enter in the pane after each phrase. Off, you press Enter yourself.">
        <Toggle
          checked={s.dictateAutoSend}
          onChange={(on) => actions.patchSettings({ dictateAutoSend: on })}
          label="Auto-send dictation"
        />
      </Row>

      <Row label="Stop dictating after" hint="Silence that closes the mic in Dictate mode">
        <Choice
          label="Stop dictating after"
          value={s.sttAutoStopSeconds}
          options={DICTATE_STOPS}
          custom={(v) => `${v} s`}
          onChange={(v) => actions.patchSettings({ sttAutoStopSeconds: v })}
        />
      </Row>

      <Row label="Ready when Forge opens" hint="Loads Parakeet at start-up, so the first press opens the mic at once">
        <Toggle
          checked={s.sttWarmStart}
          onChange={(on) => {
            actions.patchSettings({ sttWarmStart: on })
            if (on) void window.forge.stt.warm()
          }}
          label="Ready when Forge opens"
        />
      </Row>

      <Row
        label="Wake word — “Hey Jarvis”"
        hint="Off by default. On, saying it starts the agent with no key — the mic stays open at about 1% CPU (needs openwakeword)."
      >
        <Toggle
          checked={s.voiceWakeWord}
          onChange={(on) => actions.patchSettings({ voiceWakeWord: on })}
          label="Wake word Hey Jarvis"
        />
      </Row>

      <EngineFiles />
    </Card>
  )
}

/**
 * The speech engine's two paths, folded away: they are the fix when Parakeet
 * cannot start, not something anybody sets on a working machine.
 *
 * The write is awaited before the reload, as in DictationSetup: the sidecar
 * reads its paths from the store when it spawns, so respawning first would
 * bring it up on the old ones.
 */
function EngineFiles(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const [python, setPython] = useState(s.sttPython)
  const [modelDir, setModelDir] = useState(s.sttModelDir)
  useEffect(() => setModelDir(s.sttModelDir), [s.sttModelDir])
  const dirty = python.trim() !== s.sttPython || modelDir.trim() !== s.sttModelDir

  const save = (force: boolean): void => {
    if (!dirty && !force) return
    const patch = { sttPython: python.trim(), sttModelDir: modelDir.trim() }
    if (dirty) actions.patchSettings(patch)
    void (async () => {
      if (dirty) await window.forge.store.setSettings(patch)
      await window.forge.stt.reload(force)
    })()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Enter') save(false)
  }

  return (
    <details className="sfold">
      <summary className="sfold__summary">
        <span className="sfold__chev" aria-hidden="true">
          ›
        </span>
        Engine files
        <span className="sfold__note">only if dictation cannot start</span>
      </summary>
      <div className="sfold__body">
        <Row label="Python interpreter" hint="Empty uses the speech engine Forge ships" htmlFor="va-stt-python">
          <input
            id="va-stt-python"
            className="field__input mono"
            value={python}
            spellCheck={false}
            placeholder="(Forge’s own)"
            onChange={(e) => setPython(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => save(false)}
          />
        </Row>
        <Row label="Parakeet model folder" htmlFor="va-stt-model">
          <input
            id="va-stt-model"
            className="field__input mono"
            value={modelDir}
            spellCheck={false}
            placeholder="…\models\parakeet-tdt-0.6b-v2"
            onChange={(e) => setModelDir(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => save(false)}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={() =>
              void window.forge.pickFolder().then((folder) => {
                if (folder) setModelDir(folder)
              })
            }
          >
            Browse…
          </button>
        </Row>
        <Row label="Restart the speech engine" hint="Saves the paths above and starts Parakeet again">
          <button type="button" className="ghost-btn" onClick={() => save(true)}>
            {dirty ? 'Save & restart' : 'Restart'}
          </button>
        </Row>
      </div>
    </details>
  )
}

/* -------------------------------------------------------------- voice out */

const ENGINES: Array<{ id: VoiceEngine; label: string; hint: string }> = [
  { id: 'edge', label: 'Neural — free', hint: 'Microsoft’s Edge voices. No key, no quota — the default' },
  { id: 'gemini', label: 'Neural — Gemini', hint: 'Google’s voices. Needs the Gemini key; a free key runs out after a few sentences a minute' },
  { id: 'local', label: 'Built-in', hint: 'Windows’ own voices. No key, no network — and it sounds like it' }
]

/**
 * Talking back. The engines only read out what the brain wrote — they never
 * think. A live (realtime) brain speaks in its own voice instead, picked on its
 * card; the line at the top says so, so a change here is never a mystery.
 *
 * Local voices arrive asynchronously on Windows (Chromium returns [] first and
 * fires `voiceschanged` once SAPI is enumerated), so this listens.
 */
function VoiceOutCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const [voices, setVoices] = useState(() => speaker.voices())
  const [sampling, setSampling] = useState(false)

  useEffect(() => {
    if (!speaker.available) return undefined
    const refresh = (): void => setVoices(speaker.voices())
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh)
  }, [])

  const brain = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const live = isRealtimeBrain(brain) ? providerSpec(brain) : null
  const liveVoice = live?.vendor ? resolveVoice(live.vendor, s.voiceHubVoice[live.vendor]) : null

  const hasKey = s.geminiKey.trim().length > 0
  const picked = chooseVoice(voices, s.voiceReplyVoice)
  const config: VoiceConfig = {
    engine: s.voiceEngine,
    hasKey,
    edgeVoice: s.voiceEdgeVoice,
    geminiVoice: s.voiceTtsVoice,
    ttsModel: s.voiceTtsModel,
    localVoice: s.voiceReplyVoice
  }

  const sample = (): void => {
    setSampling(true)
    const done = (): void => setSampling(false)
    if (s.voiceEngine === 'local') {
      void speaker.speak(TTS_SAMPLE_LINE, { voiceName: s.voiceReplyVoice })
      setTimeout(done, 1500)
      return
    }
    void voiceSpeaker.speak(TTS_SAMPLE_LINE, config, (msg) => actions.setNotice(msg)).finally(done)
  }

  /**
   * Picking the Gemini engine also pins its voice. Load-bearing: the store
   * treats "engine gemini, no voice picked" as the stale pre-Edge default and
   * migrates it to Edge on the next load.
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
      title="Voice"
      hint="Only the words about to be spoken leave this machine to be voiced — never the transcript, never a drafted prompt."
    >
      {live && liveVoice ? (
        <p className="va-note" role="note">
          <span className="va-note__mark" aria-hidden="true">
            ◆
          </span>
          {live.label} speaks in its own voice — <strong>{liveVoice}</strong>, set on its card above. The voice below is
          for the other engines.
        </p>
      ) : null}

      <Row
        label="Voice engine"
        hint={
          s.voiceEngine === 'gemini' && !hasKey
            ? 'No Gemini key yet — the built-in voice speaks until there is one'
            : 'If a neural engine fails, the other one takes over, then the built-in voice'
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

      <Row label="Voice" hint={voiceHint(s, picked?.name ?? null, voices.length)} htmlFor="va-voice">
        {s.voiceEngine === 'edge' ? (
          <select
            id="va-voice"
            className="select"
            value={s.voiceEdgeVoice}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ voiceEdgeVoice: e.target.value })}
          >
            <option value="">Sonia — warm, British (default)</option>
            {EDGE_VOICES.map((v) => (
              <option key={v.name} value={v.name}>
                {`${v.label} — ${v.character.toLowerCase()}`}
              </option>
            ))}
          </select>
        ) : s.voiceEngine === 'gemini' ? (
          <select
            id="va-voice"
            className="select"
            value={s.voiceTtsVoice}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ voiceTtsVoice: e.target.value })}
          >
            <option value="">{`${DEFAULT_TTS_VOICE} — warm (default)`}</option>
            {TTS_VOICES.map((v) => (
              <option key={v.name} value={v.name}>
                {`${v.name} — ${v.character.toLowerCase()}`}
              </option>
            ))}
          </select>
        ) : (
          <LocalVoiceSelect id="va-voice" voices={voices} />
        )}
        <button
          type="button"
          className="ghost-btn"
          disabled={sampling || (s.voiceEngine === 'local' && voices.length === 0)}
          onClick={sample}
        >
          {sampling ? 'Speaking…' : 'Hear it'}
        </button>
      </Row>

      <Row label="Blip when it hands back" hint="A soft two-note tone when it is listening again, instead of saying so">
        <Toggle
          checked={s.voiceEarcons}
          onChange={(on) => {
            actions.patchSettings({ voiceEarcons: on })
            if (on) earconListening()
          }}
          label="Blip when it hands back"
        />
      </Row>

      <details className="sfold">
        <summary className="sfold__summary">
          <span className="sfold__chev" aria-hidden="true">
            ›
          </span>
          Fallback voice{s.voiceEngine === 'gemini' ? ' and Gemini voice model' : ''}
          <span className="sfold__note">used when the network is gone</span>
        </summary>
        <div className="sfold__body">
          {s.voiceEngine !== 'local' ? (
            <Row
              label="Built-in voice"
              hint={voices.length === 0 ? 'No speech voices are installed on this PC' : `${picked?.name ?? 'None'} — the standby when a neural voice cannot run`}
              htmlFor="va-local-voice"
            >
              <LocalVoiceSelect id="va-local-voice" voices={voices} />
            </Row>
          ) : (
            <p className="scard__hint">The built-in voice is already the one speaking.</p>
          )}
          {s.voiceEngine === 'gemini' ? (
            <Row
              label="Gemini voice model"
              hint="The model that does the talking, not the thinking. Forge falls to the next one when a model is out of quota."
              htmlFor="va-tts-model"
            >
              <select
                id="va-tts-model"
                className="select"
                value={s.voiceTtsModel}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => actions.patchSettings({ voiceTtsModel: e.target.value })}
              >
                <option value="">{`${DEFAULT_TTS_MODEL} (default)`}</option>
                {TTS_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.label} — ${m.hint}`}
                  </option>
                ))}
              </select>
            </Row>
          ) : null}
        </div>
      </details>
    </Card>
  )
}

function voiceHint(s: Settings, localName: string | null, localCount: number): string {
  if (s.voiceEngine === 'edge') return 'Microsoft’s neural voices — free, no key'
  if (s.voiceEngine === 'gemini') return 'Google’s neural voices'
  if (localCount === 0) return 'No speech voices are installed on this PC'
  return localName ? `Now using ${localName}` : 'The best installed voice'
}

function LocalVoiceSelect({ id, voices }: { id: string; voices: ReadonlyArray<{ name: string }> }): ReactNode {
  const { state, actions } = useApp()
  return (
    <select
      id={id}
      className="select"
      value={state.settings.voiceReplyVoice}
      disabled={voices.length === 0}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => actions.patchSettings({ voiceReplyVoice: e.target.value })}
    >
      <option value="">Best available</option>
      {voices.map((v) => (
        <option key={v.name} value={v.name}>
          {v.name}
        </option>
      ))}
    </select>
  )
}

/* ----------------------------------------------------------------- habits */

const RELAY_GRACES: ChoiceOption[] = [
  { value: 1000, label: '1 s' },
  { value: 2500, label: '2.5 s' },
  { value: 5000, label: '5 s' },
  { value: 10_000, label: '10 s' }
]

function HabitsCard(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  return (
    <Card title="Habits">
      <Row label="Report back when a pane finishes" hint="Hands a finished agent turn back to the main agent without you asking">
        <Toggle checked={s.voiceAutoRelay} onChange={(on) => actions.patchSettings({ voiceAutoRelay: on })} label="Report back when a pane finishes" />
      </Row>
      <Row label="Quiet before a pane counts as finished" hint="An agent that pauses to think is not done">
        <Choice
          label="Quiet before a pane counts as finished"
          value={s.voiceRelayGraceMs}
          options={RELAY_GRACES}
          custom={(v) => `${(v / 1000).toFixed(1)} s`}
          onChange={(ms) => actions.patchSettings({ voiceRelayGraceMs: ms })}
        />
      </Row>
      <Row label="New projects go in" hint="Where “create a project called…” puts the folder. Blank means your Desktop.">
        <TextField value={s.projectsRoot} mono placeholder="(Desktop)" onCommit={(next) => actions.patchSettings({ projectsRoot: next.trim() })} />
      </Row>
      <Row
        label="Let the model tidy the project summary"
        hint="Memory is kept for free from what you say and what runs. This adds one small API call every tenth exchange."
      >
        <Toggle
          checked={s.memoryLlmSummarize}
          onChange={(on) => actions.patchSettings({ memoryLlmSummarize: on })}
          label="Let the model tidy the project summary"
        />
      </Row>
    </Card>
  )
}

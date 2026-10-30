import { useEffect, useState, type ReactNode } from 'react'
import { CLAUDE_AGENT_MODELS, EFFORT_LEVELS, sanitiseBrainAgentEffort, sanitiseBrainAgentModel } from '@shared/agents'
import { BRAIN_CONTEXT_WARN_PCT, BRAIN_ENGINE_NAME, BRAIN_MODELS, sanitiseBrainModel } from '@shared/brain'
import { useKeymap } from '@/hooks/useHub'
import { useApp, type SettingsSection } from '@/state/AppState'
import { openBrainMap } from '../brainview'
import { BrainVoicePicker } from '../settings/BrainVoicePicker'
import { Card, Row, Section, StateChip, Stepper, Toggle, type ChipTone } from '../settings/parts'
import { ContextRing, useBrainContext } from './BrainContext'
import { EnginePicker } from './BrainIntro'
import { freshStartBrain, pickBrainEngine, startBrainFeed, turnBrainOff, turnBrainOn, useBrain } from './brainStore'
import './Brain.css'

/**
 * Settings → Forge Brain: on or off, and who runs it. The brain in the top bar
 * opens its map; talking to it is the voice agent box with "Forge Brain" picked.
 */

/** This section's id (SettingsPage lists it). */
export const BRAIN_SETTINGS: SettingsSection = 'brain'

const WORD: Record<string, { tone: ChipTone; word: string }> = {
  off: { tone: 'off', word: 'Off' },
  starting: { tone: 'soon', word: 'Starting' },
  idle: { tone: 'ok', word: 'Ready' },
  busy: { tone: 'ok', word: 'Working' },
  asking: { tone: 'warn', word: 'Needs you' },
  error: { tone: 'danger', word: 'Stopped' }
}

export function BrainSettings(): ReactNode {
  const { state, actions } = useApp()
  const { status } = useBrain()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => startBrainFeed(), [])
  const combo = useKeymap().commands.find((c) => c.id === 'ui.toggle-brain')?.keys[0]

  const on = Boolean(status?.enabled)
  const chip = WORD[on && status ? status.state : 'off']!
  const engine = status?.engine ?? state.settings.brainEngine
  const context = useBrainContext()
  const warnAt = state.settings.brainContextWarnPct ?? BRAIN_CONTEXT_WARN_PCT
  const autoAt = state.settings.brainAutoFreshPct ?? 0
  const nowPct = status?.contextPct
  const nowWords = typeof nowPct === 'number' ? `Now ${nowPct}% full.` : 'How full it is now is not known yet.'
  const [freshing, setFreshing] = useState(false)

  const freshStart = async (): Promise<void> => {
    setFreshing(true)
    setError(null)
    const why = await freshStartBrain()
    if (why) setError(why)
    setFreshing(false)
  }

  const flip = async (next: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    if (next) {
      const why = await turnBrainOn()
      if (why) setError(why)
      if (!state.settings.brainIntroSeen) actions.patchSettings({ brainIntroSeen: true })
    } else await turnBrainOff()
    setBusy(false)
  }

  return (
    <Section
      title="Forge Brain"
      blurb="One agent for the whole of Forge. It sees every project and pane, opens agents and hands them work, tells you when they finish, and changes settings when you ask. Talk to it by picking Forge Brain as the voice agent; the brain in the top bar shows its map. Forge works just the same with it off."
    >
      <Card
        title="On or off"
        actions={<StateChip tone={chip.tone}>{chip.word}</StateChip>}
        hint={status?.error && on ? `Last problem: ${status.error}` : undefined}
      >
        <Row label="Forge Brain" hint={on ? `Running on ${BRAIN_ENGINE_NAME[engine]}. Turning it off stops its terminal.` : 'Off until you turn it on.'}>
          <Toggle checked={on} disabled={busy || !status} label="Forge Brain" onChange={(next) => void flip(next)} />
        </Row>
        <Row
          label="The map"
          hint={`Every project and agent around the brain. The brain in the top bar opens it${combo ? `, or ${combo}` : ''}. To talk to it, pick Forge Brain as the voice agent.`}
        >
          <button
            type="button"
            className="ghost-btn"
            disabled={!on}
            onClick={() => {
              actions.closeSettings()
              openBrainMap()
            }}
          >
            Open
          </button>
        </Row>
        {error ? <p className="brainsettings__error" role="alert">× {error}</p> : null}
      </Card>
      <Card
        title="Context window"
        actions={on ? <ContextRing view={context} /> : undefined}
        hint="A long conversation fills the brain's context window. Past your line Forge tells you once, with a fresh start: the brain writes HANDOFF.md, then starts a new conversation that reads it first. The panes it opened still report back."
      >
        <Row label="Tell me at" hint="How full, in percent, before the one notice.">
          <Stepper
            label="Tell me at"
            value={warnAt}
            display={`${warnAt}%`}
            min={5}
            max={95}
            step={5}
            onChange={(next) => actions.patchSettings({ brainContextWarnPct: next })}
          />
        </Row>
        <Row label="Fresh start" hint={freshing ? 'Writing the handoff, then starting fresh…' : 'Now, whatever the number says.'}>
          <button type="button" className="ghost-btn" disabled={!on || freshing || status?.state === 'error'} onClick={() => void freshStart()}>
            Fresh start
          </button>
        </Row>
        <Row
          label="Fresh start by itself at"
          hint={`How full, in percent, before the brain writes its handoff and starts again by itself, once it is idle. 0 = never. ${on ? nowWords : ''}`.trim()}
        >
          <Stepper
            label="Fresh start by itself at"
            value={autoAt}
            display={autoAt > 0 ? `${autoAt}% full` : 'Never'}
            min={0}
            max={95}
            step={5}
            onChange={(next) => actions.patchSettings({ brainAutoFreshPct: next })}
          />
        </Row>
      </Card>
      <Card
        title="Who runs it"
        hint="Switching while it is on starts it again on the new one, with a new conversation. An option this PC cannot run says why."
      >
        <EnginePicker value={engine} unavailable={status?.unavailable ?? {}} disabled={!status} onPick={(e) => void pickBrainEngine(e)} />
        {engine === 'claude' ? (
          <Row label="Model" hint="Changing it while the brain is on restarts it on that model and keeps the conversation." htmlFor="brain-model">
            <select
              id="brain-model"
              className="select"
              value={sanitiseBrainModel(state.settings.brainModel)}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => actions.patchSettings({ brainModel: e.target.value })}
            >
              {BRAIN_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${m.name} — ${m.note}`}
                </option>
              ))}
            </select>
          </Row>
        ) : null}
      </Card>
      <Card
        title="Agents it opens"
        hint="Applies only to Claude Code agents Forge Brain opens, unless you name another agent or model. Panes you open yourself, voice agents and pane agents do not change. A pane that resumes keeps the model it was on."
      >
        <Row label="Model" htmlFor="brain-agent-model">
          <select
            id="brain-agent-model"
            className="select"
            value={sanitiseBrainAgentModel(state.settings.brainAgentModel)}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ brainAgentModel: e.target.value })}
          >
            {CLAUDE_AGENT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {`${m.label} — ${m.note}`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Effort" htmlFor="brain-agent-effort">
          <select
            id="brain-agent-effort"
            className="select"
            value={sanitiseBrainAgentEffort(state.settings.brainAgentEffort)}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.patchSettings({ brainAgentEffort: e.target.value })}
          >
            {EFFORT_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {`${l.label} — ${l.note}`}
              </option>
            ))}
          </select>
        </Row>
      </Card>
      <Card title="Voice" hint="Replies are spoken in this voice when Forge Brain is your voice agent.">
        <BrainVoicePicker />
      </Card>
    </Section>
  )
}

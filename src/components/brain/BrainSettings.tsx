import { useEffect, useState, type ReactNode } from 'react'
import { BRAIN_ENGINE_NAME } from '@shared/brain'
import { useKeymap } from '@/hooks/useHub'
import { useApp, type SettingsSection } from '@/state/AppState'
import { openBrainMap } from '../brainview'
import { Card, Row, Section, StateChip, Toggle, type ChipTone } from '../settings/parts'
import { EnginePicker } from './BrainIntro'
import { pickBrainEngine, startBrainFeed, turnBrainOff, turnBrainOn, useBrain } from './brainStore'
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
        title="Who runs it"
        hint="Switching while it is on starts it again on the new one, with a new conversation. An option this PC cannot run says why."
      >
        <EnginePicker value={engine} unavailable={status?.unavailable ?? {}} disabled={!status} onPick={(e) => void pickBrainEngine(e)} />
      </Card>
    </Section>
  )
}

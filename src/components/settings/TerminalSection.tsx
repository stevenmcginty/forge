import type { ReactNode } from 'react'
import { earconTaskDone } from '@/lib/earcon'
import { useApp } from '@/state/AppState'
import { Card, Row, Section, Toggle } from './parts'

/**
 * How panes behave, and what the agents in them may reach.
 *
 * Whether a finished terminal says so, and whether the agents Forge launches
 * may drive a browser other than Forge's own. Both are about panes, not voice.
 */
export function TerminalSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section title="Panes" blurb="How panes behave, and what the agents in them may reach.">
      <Card title="Completion sound">
        <Row
          label="Chime when a terminal finishes"
          hint="A soft blip, only while Forge is not the focused window — up for a clean exit, down when it needs you."
        >
          <Toggle
            checked={s.terminalExitChime}
            onChange={(on) => {
              actions.patchSettings({ terminalExitChime: on })
              if (on) earconTaskDone()
            }}
            label="Chime when a terminal finishes"
          />
        </Row>
      </Card>
      <Card title="Browsing">
        <Row
          label="Agents use Forge’s browser only"
          hint="Claude panes Forge opens cannot use Claude-in-Chrome, Playwright or other browser tools; web work goes to Forge’s built-in browser. Takes effect for new panes."
        >
          <Toggle
            checked={s.agentsForgeBrowserOnly}
            onChange={(on) => actions.patchSettings({ agentsForgeBrowserOnly: on })}
            label="Agents use Forge’s browser only"
          />
        </Row>
      </Card>
    </Section>
  )
}

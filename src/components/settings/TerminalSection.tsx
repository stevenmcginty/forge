import type { ReactNode } from 'react'
import { earconTaskDone } from '@/lib/earcon'
import { useApp } from '@/state/AppState'
import { Card, Row, Section, Toggle } from './parts'

/**
 * How panes behave.
 *
 * One setting today — whether a finished terminal says so. It has its own page
 * rather than a row on Voice's because this is not a voice thing: it is a
 * "did the thing you were waiting on end" thing, and that is about panes.
 */
export function TerminalSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  return (
    <Section title="Terminal" blurb="How panes behave.">
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
    </Section>
  )
}

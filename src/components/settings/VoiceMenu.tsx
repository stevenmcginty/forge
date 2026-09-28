import type { ReactNode } from 'react'
import {
  AGENT_BRAINS,
  defaultVoiceMenu,
  moveVoiceMenu,
  normaliseVoiceMenu,
  setVoiceMenuShown
} from '@shared/agent-brain'
import { useApp } from '@/state/AppState'
import { Card, Row, Toggle } from './parts'

/**
 * Which agents the desktop voice picker shows before More, and in what order.
 * The Main agent card still lists every engine. This card is only the menu.
 */
export function VoiceMenuCard(): ReactNode {
  const { state, actions } = useApp()
  const menu = normaliseVoiceMenu(state.settings.voiceMenu)

  return (
    <Card
      title="Voice menu"
      hint="The picker shows the ticked agents first, in this order. More shows the rest."
      actions={
        <button type="button" className="sbtn" onClick={() => actions.patchSettings({ voiceMenu: defaultVoiceMenu() })}>
          Reset
        </button>
      }
    >
      {menu.map((entry, index) => {
        const label = AGENT_BRAINS.find((brain) => brain.id === entry.id)?.label ?? entry.id
        return (
          <Row key={entry.id} label={label}>
            <button
              type="button"
              className="sbtn"
              aria-label={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => actions.patchSettings({ voiceMenu: moveVoiceMenu(menu, index, -1) })}
            >
              Up
            </button>
            <button
              type="button"
              className="sbtn"
              aria-label={`Move ${label} down`}
              disabled={index === menu.length - 1}
              onClick={() => actions.patchSettings({ voiceMenu: moveVoiceMenu(menu, index, 1) })}
            >
              Down
            </button>
            <Toggle
              checked={entry.shown}
              label={`Show ${label} first`}
              onChange={(shown) => actions.patchSettings({ voiceMenu: setVoiceMenuShown(menu, entry.id, shown) })}
            />
          </Row>
        )
      })}
    </Card>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, Row, Section, Stepper, Toggle } from './parts'

/**
 * The screenshot shelf's settings — moved here from the tray, which is a good
 * place to *look* at shots and a bad place to keep a preferences panel.
 */
export function ShotsSection(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    void window.forge.shots.list().then((shots) => setCount(shots.length))
    return window.forge.shots.onUpdated((shots) => setCount(shots.length))
  }, [])

  return (
    <Section
      title="Screenshots"
      blurb="Every screenshot you take and every image you copy lands on the shelf as a real PNG, ready to drag onto an agent."
    >
      <Card>
        <Row label="Catch screenshots &amp; copied images" hint="Watches the clipboard while Forge is running">
          <Toggle checked={s.catchShots} onChange={actions.setCatchShots} label="Catch screenshots" />
        </Row>
        <Row label="Keep newest" hint="Older shots are deleted from disk, not just hidden">
          <Stepper
            label="Shots kept"
            value={s.shotsKeep}
            min={1}
            max={60}
            onChange={actions.setShotsKeep}
            display={`${s.shotsKeep}`}
          />
        </Row>
      </Card>

      <Card
        title="On disk"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={() => void window.forge.shots.openFolder()}>
            <Icon name="folder" size={12} />
            Open folder
          </button>
        }
        hint={
          <>
            The shelf is a real folder — <span className="mono">%APPDATA%\Forge\shots</span>. Clearing the tray deletes
            the files.
          </>
        }
      >
        <Row label="On the shelf now">
          <span className="mono srow__readout">{count === null ? '…' : `${count} shot${count === 1 ? '' : 's'}`}</span>
        </Row>
      </Card>
    </Section>
  )
}

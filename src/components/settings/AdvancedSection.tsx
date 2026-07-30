import { useEffect, useState, type ReactNode } from 'react'
import type { SttStatus } from '@shared/types'
import { usePaneCount, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, Row, Section, StateChip } from './parts'

/**
 * Where things live and what state they are in. No knobs that belong somewhere
 * else, and nothing here that cannot be explained in one line.
 */
export function AdvancedSection(): ReactNode {
  const { state, actions } = useApp()
  const { used, max } = usePaneCount()
  const [stt, setStt] = useState<SttStatus | null>(null)

  useEffect(() => {
    void window.forge.stt.status().then(setStt)
    return window.forge.stt.onStatus(setStt)
  }, [])

  const info = state.info

  return (
    <Section title="Advanced" blurb="Where Forge keeps things, and what it is doing right now.">
      <Card
        title="Data folder"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={() => actions.openDataDir()}>
            <Icon name="folder" size={12} />
            Open
          </button>
        }
        hint={
          <>
            Settings, projects, layouts, screenshots and any downloaded speech model. It is all plain JSON and real
            files — edit them by hand if you prefer. <span className="mono">FORGE_DATA_DIR</span> moves the lot, which
            is how a second copy of Forge runs side by side without touching this one.
          </>
        }
      >
        <Row label="Location">
          <span className="mono srow__readout truncate">{info?.dataDir ?? '…'}</span>
        </Row>
      </Card>

      <Card title="Right now">
        <Row label="Terminal sessions" hint="A hard ceiling — panes past it are refused, not queued">
          <span className="mono srow__readout">
            {used} of {max}
          </span>
        </Row>
        <Row label="Dictation sidecar" hint="Spawned lazily, on the first time you dictate">
          <StateChip tone={sttTone(stt)}>{stt?.phase ?? 'off'}</StateChip>
        </Row>
        <Row label="Voice brain">
          <span className="mono srow__readout">
            {state.settings.voiceBrain}
            {state.settings.voiceBrain === 'gemini' && !state.settings.geminiKey ? ' (no key — using stub)' : ''}
          </span>
        </Row>
      </Card>

      <Card title="Versions">
        <dl className="sversions">
          <div>
            <dt>Forge</dt>
            <dd className="mono">{info?.version ?? '…'}</dd>
          </div>
          <div>
            <dt>Electron</dt>
            <dd className="mono">{info?.electron ?? '…'}</dd>
          </div>
          <div>
            <dt>Chromium</dt>
            <dd className="mono">{info?.chrome ?? '…'}</dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd className="mono">{info?.node ?? '…'}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd className="mono">{info?.platform ?? '…'}</dd>
          </div>
          <div>
            <dt>Shell</dt>
            <dd className="mono truncate">{info?.shell ?? '…'}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Colour in terminals" tone="quiet">
        <p className="scard__hint">
          Forge answers OSC 10/11 colour queries with the current theme&rsquo;s terminal background and foreground, so
          an agent that probes the terminal picks the right half of its own theme instead of rendering white on white.
          If a tool still gets it wrong, <span className="mono">$env:NO_COLOR=1</span> in that pane turns colour off
          entirely.
        </p>
      </Card>
    </Section>
  )
}

function sttTone(stt: SttStatus | null): 'ok' | 'warn' | 'off' {
  if (!stt) return 'off'
  if (stt.error) return 'warn'
  if (stt.phase === 'off') return 'off'
  return 'ok'
}

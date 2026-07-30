import { useEffect, useState, type ReactNode } from 'react'
import type { CompanionStatus, SttStatus } from '@shared/types'
import { usePaneCount, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, Row, Section, StateChip, Toggle } from './parts'

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

      <CompanionCard />

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

/* ------------------------------------------------------- forge companion */

/**
 * The phone link's switch and its one honest status line.
 *
 * Deliberately the whole UI: turning it on is not enough to make it work, and
 * pretending otherwise with a sign-in form here would be the dead end. The
 * Firebase project, the rules and the credentials are a one-time setup that
 * lives in companion/GO-LIVE.md, and the status line says which step you are
 * stuck on rather than a bare "off".
 *
 * `enabled` is the only field this card writes. Everything else is read from
 * the main process, which is also the only thing that can start the sync.
 */
function CompanionCard(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<CompanionStatus | null>(null)

  useEffect(() => {
    void window.forge.companion.status().then(setStatus)
    return window.forge.companion.onStatus(setStatus)
  }, [])

  const on = state.settings.companionEnabled
  const configured = status?.configured ?? false

  return (
    <Card
      title="Phone companion"
      tone="quiet"
      hint={
        <>
          A phone web app that can see your projects and send you a message back. Off, unconfigured and holding no
          credentials until you set it up — nothing here makes a network call on its own. The setup is a Firebase
          project and about ten minutes: see <span className="mono">companion/GO-LIVE.md</span> in the Forge checkout.
        </>
      }
    >
      <Row label="Enable" hint="Off by default. On its own this only allows the link — it does not create one.">
        <Toggle
          checked={on}
          onChange={(next) => actions.patchSettings({ companionEnabled: next })}
          label="Enable the phone companion"
        />
      </Row>
      <Row label="Status">
        <StateChip tone={companionTone(on, status)}>{status?.state ?? 'off'}</StateChip>
      </Row>
      {status?.detail || !configured ? (
        <p className="scard__hint">
          {status?.detail ||
            (on
              ? 'No Firebase project configured yet, so there is nothing to connect to. Follow GO-LIVE.md, then sign in.'
              : 'Switched off.')}
        </p>
      ) : null}
    </Card>
  )
}

function companionTone(enabled: boolean, status: CompanionStatus | null): 'ok' | 'warn' | 'off' {
  if (!enabled) return 'off'
  if (!status || !status.configured) return 'warn'
  return status.state === 'live' ? 'ok' : 'warn'
}

function sttTone(stt: SttStatus | null): 'ok' | 'warn' | 'off' {
  if (!stt) return 'off'
  if (stt.error) return 'warn'
  if (stt.phase === 'off') return 'off'
  return 'ok'
}

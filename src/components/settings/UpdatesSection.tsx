import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { isNewer, latestSourceLabel, relativeTime, TOOL_SPECS } from '@shared/tools'
import type { ToolId, ToolLatest, ToolProbe, ToolSpec, UpdateStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, Row, Section, StateChip, Toggle, type ChipTone } from './parts'

/**
 * What is installed, what is available, and one button per row that puts the
 * real update command in a real terminal.
 *
 * The design decision worth defending: **the Update button does not run
 * anything.** It opens a pane titled `update: PowerShell`, types
 * `winget upgrade Microsoft.PowerShell` into it, and stops with the cursor at
 * the end of the line. You press Enter.
 *
 * That is not timidity, it is where the responsibility belongs. Installing
 * software is the one action on this page with consequences outside Forge, and
 * a settings button is a bad place to hide it — but a *terminal* is exactly the
 * right place for it, because the output, the prompts and the failure are all
 * things you were going to need to see anyway. The button removes the typing,
 * not the decision. `updatesAutoRun` flips it for anyone who disagrees.
 *
 * Installed and latest are fetched separately and on purpose: the local probes
 * come back in milliseconds and the network ones do not, so the page is never
 * blank waiting on registry.npmjs.org.
 */
export function UpdatesSection(): ReactNode {
  const { state, actions } = useApp()
  const [probes, setProbes] = useState<ToolProbe[] | null>(null)
  const [latest, setLatest] = useState<Map<ToolId, ToolLatest>>(new Map())
  const [checking, setChecking] = useState<Set<ToolId>>(new Set())
  const [checkedAt, setCheckedAt] = useState(0)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.forge.tools.probe().then(setProbes)
    void window.forge.updates.status().then(setUpdate)
    return window.forge.updates.onStatus(setUpdate)
  }, [])

  // Whatever the main process already has cached, without asking it to go and
  // fetch anything: arriving on this tab should not cost three HTTPS requests.
  useEffect(() => {
    void window.forge.tools.latest(null, false).then((rows) => {
      setLatest(new Map(rows.map((r) => [r.id, r])))
      setCheckedAt(Math.max(0, ...rows.map((r) => r.checkedAt)))
    })
  }, [])

  const check = useCallback(async (ids: ToolId[] | null) => {
    const marking = ids ?? TOOL_SPECS.map((t) => t.id)
    setChecking((prev) => new Set([...prev, ...marking]))
    try {
      const rows = await window.forge.tools.latest(ids, true)
      setLatest((prev) => {
        const next = new Map(prev)
        for (const row of rows) next.set(row.id, row)
        return next
      })
      setCheckedAt(Date.now())
    } finally {
      setChecking((prev) => {
        const next = new Set(prev)
        for (const id of marking) next.delete(id)
        return next
      })
    }
  }, [])

  const rechecking = checking.size > 0

  return (
    <Section
      title="Updates & tools"
      blurb="The command-line tools Forge runs in its panes, and Forge itself. Nothing on this page installs anything on its own."
    >
      <Card
        title="Installed tools"
        actions={
          <>
            <button
              type="button"
              className="ghost-btn sbtn"
              title="Re-read every version from this machine"
              onClick={() => void window.forge.tools.probe(true).then(setProbes)}
            >
              <Icon name="restart" size={12} />
              Re-probe
            </button>
            <button
              type="button"
              className="ghost-btn sbtn"
              disabled={rechecking}
              title="Ask winget and the npm registry what the latest versions are"
              onClick={() => void check(null)}
            >
              <Icon name="restart" size={12} />
              {rechecking ? 'Checking…' : 'Check all'}
            </button>
          </>
        }
        hint={
          <>
            Latest versions come from <span className="mono">winget</span> and{' '}
            <span className="mono">registry.npmjs.org</span> — two calls per check, no data sent, nothing installed.
            Last checked {relativeTime(checkedAt)}. Offline simply means the right-hand column stays empty.
          </>
        }
      >
        <ul className="stool">
          {TOOL_SPECS.map((spec) => (
            <ToolRow
              key={spec.id}
              spec={spec}
              probe={probes?.find((p) => p.id === spec.id) ?? null}
              latest={latest.get(spec.id) ?? null}
              busy={checking.has(spec.id)}
              onCheck={() => void check([spec.id])}
              onUpdate={() => actions.openToolPane(`update: ${spec.name}`, spec.updateCommand ?? '')}
            />
          ))}
        </ul>
      </Card>

      <Card
        title="Update commands"
        tone="quiet"
        hint="Turning this on means a single click in Settings can start installing software. It is off because the command deserves a look before it runs — especially winget's, which may ask about a licence agreement."
      >
        <Row
          label="Press Enter for me"
          hint={
            state.settings.updatesAutoRun
              ? 'The update command runs the moment the pane opens'
              : 'The command is typed and left unsubmitted — you press Enter'
          }
        >
          <Toggle
            checked={state.settings.updatesAutoRun}
            onChange={(next) => actions.patchSettings({ updatesAutoRun: next })}
            label="Run update commands automatically"
          />
        </Row>
      </Card>

      <ForgeUpdateCard status={update} version={state.info?.version ?? ''} />
    </Section>
  )
}

/* ------------------------------------------------------------------- a row */

function ToolRow({
  spec,
  probe,
  latest,
  busy,
  onCheck,
  onUpdate
}: {
  spec: ToolSpec
  probe: ToolProbe | null
  latest: ToolLatest | null
  busy: boolean
  onCheck: () => void
  onUpdate: () => void
}): ReactNode {
  const installed = probe?.version ?? null
  const behind = isNewer(latest?.latest, installed)
  const canUpdate = Boolean(spec.updateCommand) && probe?.found === true

  return (
    <li className="stool__row" data-behind={behind ? 'true' : undefined}>
      <div className="stool__text">
        <span className="stool__name">{spec.name}</span>
        <span className="stool__blurb">{spec.blurb}</span>
      </div>

      <div className="stool__versions">
        <span className="stool__version mono" title={probe?.path ?? ''}>
          {installedLabel(probe)}
        </span>
        <span className="stool__arrow" aria-hidden="true">
          →
        </span>
        <span className="stool__version stool__version--latest mono">{latestLabel(spec, latest, busy)}</span>
      </div>

      <StateChip tone={tone(probe, latest, behind)}>{chip(probe, latest, behind)}</StateChip>

      <div className="stool__actions">
        {spec.latest.source === 'npm' || spec.latest.source === 'winget' ? (
          <button
            type="button"
            className="ghost-btn sbtn"
            disabled={busy}
            title={`Check ${latestSourceLabel(spec.latest.source)} for a newer ${spec.name}`}
            onClick={onCheck}
          >
            Check
          </button>
        ) : null}
        {canUpdate ? (
          <button
            type="button"
            className="ghost-btn sbtn stool__update"
            data-behind={behind ? 'true' : undefined}
            title={`Open a pane with “${spec.updateCommand}” typed in it`}
            onClick={onUpdate}
          >
            <Icon name="terminal" size={12} />
            Update
          </button>
        ) : null}
      </div>
    </li>
  )
}

function installedLabel(probe: ToolProbe | null): string {
  if (!probe) return '…'
  if (!probe.found) return 'not installed'
  return probe.version ?? (probe.error ? 'installed' : '…')
}

function latestLabel(spec: ToolSpec, latest: ToolLatest | null, busy: boolean): string {
  if (busy) return 'checking…'
  if (spec.latest.source === 'local') return 'managed locally'
  if (!latest) return '—'
  if (latest.latest) return latest.latest
  return latest.error ?? '—'
}

function tone(probe: ToolProbe | null, latest: ToolLatest | null, behind: boolean): ChipTone {
  if (!probe) return 'off'
  if (!probe.found) return 'off'
  if (behind) return 'warn'
  if (latest?.latest && probe.version) return 'ok'
  return 'soon'
}

function chip(probe: ToolProbe | null, latest: ToolLatest | null, behind: boolean): string {
  if (!probe) return '…'
  if (!probe.found) return 'not found'
  if (behind) return 'update'
  if (latest?.latest && probe.version) return 'current'
  return 'installed'
}

/* -------------------------------------------------------------- forge itself */

/**
 * Forge's own updates, told honestly.
 *
 * In a dev run this card says so and stops, because a checkout does not update
 * itself and a card implying otherwise would be the beginning of a very bad
 * afternoon. In a packaged build it repeats what the banner says, plus the one
 * thing the banner has no room for: Forge is not code-signed, and an unsigned
 * app replacing its own executable is a shape Windows is entitled to be
 * suspicious of.
 */
function ForgeUpdateCard({ status, version }: { status: UpdateStatus | null; version: string }): ReactNode {
  const phase = status?.phase ?? 'unsupported'
  const dev = phase === 'unsupported'

  return (
    <Card
      title="Forge itself"
      tone={dev ? 'quiet' : 'plain'}
      actions={
        dev ? null : (
          <button type="button" className="ghost-btn sbtn" onClick={() => void window.forge.updates.check()}>
            <Icon name="restart" size={12} />
            Check now
          </button>
        )
      }
      hint={
        <>
          Forge is <strong>not code-signed</strong> — there is no certificate behind it. Windows SmartScreen will warn
          about the downloaded installer the same way it warned about the first one, and on a machine with{' '}
          <span className="mono">Smart App Control</span> switched on, an unsigned auto-update can be blocked outright
          with no dialog at all. If that happens, download the release by hand or run from source. Signing is the only
          real fix, and it is the right one for anything actually distributed —{' '}
          <span className="mono">GIVE-TO-A-FRIEND.md</span> has the detail.
        </>
      }
    >
      <Row label="This build">
        <span className="mono srow__readout">{version || '…'}</span>
      </Row>
      <Row
        label="Updates"
        hint={
          dev
            ? 'A checkout updates itself with git, not with an installer'
            : 'Checked on launch and every six hours. Nothing downloads until you say so.'
        }
      >
        <StateChip tone={forgeTone(phase)}>{forgeLabel(status)}</StateChip>
      </Row>
      {status?.error ? <p className="scard__hint">{status.error}</p> : null}
      {status?.simulated ? (
        <p className="scard__hint">
          <span className="mono">FORGE_FAKE_UPDATE</span> is set, so this is a simulation — no release feed is being
          contacted and nothing can be installed.
        </p>
      ) : null}
    </Card>
  )
}

function forgeTone(phase: UpdateStatus['phase']): ChipTone {
  if (phase === 'error') return 'danger'
  if (phase === 'available' || phase === 'ready') return 'warn'
  if (phase === 'unsupported') return 'soon'
  return 'ok'
}

function forgeLabel(status: UpdateStatus | null): string {
  switch (status?.phase) {
    case 'checking':
      return 'checking'
    case 'available':
      return `${status.version} available`
    case 'downloading':
      return `downloading ${status.percent ?? 0}%`
    case 'ready':
      return 'ready to install'
    case 'error':
      return 'check failed'
    case 'idle':
      return 'up to date'
    default:
      return 'dev build'
  }
}

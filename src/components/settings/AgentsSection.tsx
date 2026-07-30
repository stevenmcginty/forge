import { useState, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode, ProfileKind } from '@shared/types'
import {
  ACCENT_PALETTE,
  PERMISSION_MODES,
  deriveBadge,
  isShellProfile,
  launchCommand,
  makeCustomProfile,
  supportsPermissionModes
} from '@/lib/agents'
import { useApp } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { Card, ColorPicker, Row, Section, StateChip, TextField, Toggle } from './parts'

/**
 * The launch-profile editor.
 *
 * A profile is the whole answer to "what happens when I open a pane": the
 * command typed into a fresh PowerShell, the badge it wears, whether Claude's
 * MCP bridge is registered, and — for Claude specifically — how much it is
 * allowed to do without asking. All of that used to be editable only by hand in
 * settings.json.
 *
 * Shells and agents are listed separately because they are different kinds of
 * thing, not different rows of the same list.
 */
export function AgentsSection(): ReactNode {
  const { state, actions } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const profiles = state.settings.agentProfiles
  const shells = profiles.filter((p) => isShellProfile(p))
  const agents = profiles.filter((p) => !isShellProfile(p))

  const create = (kind: ProfileKind): void => {
    const profile = makeCustomProfile(
      kind === 'shell' ? 'Shell' : 'New agent',
      kind === 'shell' ? '' : '',
      ACCENT_PALETTE[3]
    )
    profile.kind = kind
    actions.saveProfile(profile)
    setEditing(profile.id)
  }

  return (
    <Section
      title="Agents"
      blurb="Every pane is a real PowerShell. A profile just decides what gets typed into it — which is why the prompt is still there when an agent exits."
    >
      <Card
        title="Shell"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={() => create('shell')}>
            <Icon name="plus" size={12} />
            New shell
          </button>
        }
      >
        <ul className="sprof">
          {shells.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              open={editing === p.id}
              onToggle={() => setEditing(editing === p.id ? null : p.id)}
            />
          ))}
        </ul>
      </Card>

      <Card
        title="Agents"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={() => create('agent')}>
            <Icon name="plus" size={12} />
            New agent
          </button>
        }
        hint={
          <>
            The command runs inside the pane's shell, so anything you can type works —{' '}
            <span className="mono">claude --resume</span>, a batch file, a conda activation followed by a launcher.
          </>
        }
      >
        <ul className="sprof">
          {agents.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              open={editing === p.id}
              onToggle={() => setEditing(editing === p.id ? null : p.id)}
            />
          ))}
        </ul>
      </Card>
    </Section>
  )
}

/* ------------------------------------------------------------------ one row */

function ProfileRow({
  profile,
  open,
  onToggle
}: {
  profile: AgentProfile
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { state, actions } = useApp()
  const shell = isShellProfile(profile)
  const claude = supportsPermissionModes(profile)
  const mode = profile.permissionMode ?? 'default'
  const inUse = state.projects.filter((p) => p.defaultProfileId === profile.id).length

  const patch = (next: Partial<AgentProfile>): void => actions.saveProfile({ ...profile, ...next })

  return (
    <li className="sprof__item" data-open={open ? 'true' : undefined}>
      <button type="button" className="sprof__row" aria-expanded={open} onClick={onToggle}>
        <AgentBadge profile={profile} size="md" />
        <span className="sprof__name truncate">{profile.name}</span>
        <span className="sprof__cmd mono truncate">{profile.command || 'plain shell'}</span>
        {claude && mode !== 'default' ? (
          <StateChip tone={mode === 'bypass' ? 'danger' : 'warn'}>{modeLabel(mode)}</StateChip>
        ) : null}
        {profile.builtin ? <span className="eyebrow sprof__lock">built-in</span> : null}
        <Icon name="chevronDown" size={13} className="sprof__chev" />
      </button>

      {open ? (
        <div className="sprof__edit">
          <Row label="Name" htmlFor={`prof-name-${profile.id}`}>
            <TextField
              id={`prof-name-${profile.id}`}
              value={profile.name}
              onCommit={(name) =>
                patch({
                  name: name.trim() || profile.name,
                  // A badge left at its derived value keeps following the name;
                  // one that has been set by hand is left alone.
                  badge: profile.badge === deriveBadge(profile.name) ? deriveBadge(name) : profile.badge
                })
              }
            />
          </Row>

          <Row
            label="Command"
            hint={shell ? 'Empty means a bare prompt' : 'Typed into the fresh shell'}
            htmlFor={`prof-cmd-${profile.id}`}
          >
            <TextField
              id={`prof-cmd-${profile.id}`}
              value={profile.command}
              onCommit={(command) => patch({ command: command.trim() })}
              placeholder={shell ? '(nothing)' : 'claude'}
              mono
            />
          </Row>

          <Row label="Badge" hint="Two letters" htmlFor={`prof-badge-${profile.id}`}>
            <TextField
              id={`prof-badge-${profile.id}`}
              value={profile.badge}
              onCommit={(badge) => patch({ badge: badge.trim().slice(0, 2).toUpperCase() || deriveBadge(profile.name) })}
              mono
            />
          </Row>

          <Row label="Accent" hint={shell ? 'Shells wear a neutral badge regardless' : 'Badge and focus ring'}>
            <ColorPicker
              value={profile.accent}
              palette={ACCENT_PALETTE}
              onChange={(accent) => patch({ accent })}
              label={`${profile.name} accent`}
            />
          </Row>

          <Row label="Kind" hint="Which group it appears under">
            <select
              className="select"
              value={shell ? 'shell' : 'agent'}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => patch({ kind: e.target.value as ProfileKind })}
            >
              <option value="shell">Shell</option>
              <option value="agent">Agent</option>
            </select>
          </Row>

          {!shell ? (
            <Row label="Cross-agent bridge" hint="Register Forge's Gemini MCP server at launch">
              <Toggle
                checked={profile.mcpBridge === true}
                onChange={(on) => patch({ mcpBridge: on })}
                label={`${profile.name} MCP bridge`}
              />
            </Row>
          ) : null}

          {claude ? (
            <>
              <Row label="Permission mode" hint="The default for panes opened with this profile">
                <select
                  className="select"
                  value={mode}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => patch({ permissionMode: e.target.value as ClaudePermissionMode })}
                >
                  {PERMISSION_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </select>
              </Row>
              <div className="sprof__preview">
                <span className="eyebrow">launches</span>
                <code className="mono sprof__cmdline">{launchCommand(profile) || '(plain shell)'}</code>
              </div>
              {mode === 'bypass' ? (
                <p className="sprof__warn">
                  Bypass means Claude never asks. It can edit, delete and run anything your account can, in whatever
                  folder the pane is open on. Panes launched this way are badged{' '}
                  <span className="mono">BYPASS</span> so you always know which ones they are.
                </p>
              ) : null}
            </>
          ) : null}

          <div className="sprof__foot">
            {inUse > 0 ? (
              <span className="sprof__usage">
                default profile for {inUse} project{inUse === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="sprof__usage" />
            )}
            <button type="button" className="ghost-btn sbtn" onClick={() => actions.duplicateProfile(profile.id)}>
              Duplicate
            </button>
            <button
              type="button"
              className="ghost-btn sbtn"
              data-danger="true"
              disabled={profile.builtin}
              title={profile.builtin ? 'Built-in profiles can be edited but not deleted' : `Delete ${profile.name}`}
              onClick={() => actions.deleteProfile(profile.id)}
            >
              <Icon name="trash" size={12} />
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function modeLabel(mode: ClaudePermissionMode): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode
}

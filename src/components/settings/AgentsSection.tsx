import { useState, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode, CommandPresence, ProfileKind } from '@shared/types'
import { installCommandFor, toolSpecForCommand } from '@shared/tools'
import {
  ACCENT_PALETTE,
  deriveBadge,
  isShellProfile,
  launchCommand,
  makeCustomProfile,
  permissionSpec,
  profilePermissionModes,
  supportsPermissionModes
} from '@/lib/agents'
import { useCommandPresence } from '@/hooks/useCommandPresence'
import { useApp } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { Card, ColorPicker, Row, Section, StateChip, TextField, Toggle } from './parts'

/**
 * The launch-profile editor.
 *
 * A profile is the whole answer to "what happens when I open a pane": the
 * command typed into a fresh PowerShell, the badge it wears, whether Claude's
 * MCP bridge is registered, and — for the agents that have a permission ladder
 * (Claude Code, Codex) — how much it is allowed to do without asking. All of
 * that used to be editable only by hand in settings.json.
 *
 * Shells and agents are listed separately because they are different kinds of
 * thing, not different rows of the same list.
 *
 * Every agent row also answers the question this page used to leave to a pane
 * and a red error: *is that CLI even on this machine?* The answer is the same
 * PATH walk the first-run welcome does (electron/agent-probe.ts), and where it
 * is "no", the row carries the command that fixes it — typed into a real
 * terminal by Updates & tools' rules, never run behind your back.
 */
export function AgentsSection(): ReactNode {
  const { state, actions } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const profiles = state.settings.agentProfiles
  const shells = profiles.filter((p) => isShellProfile(p))
  const agents = profiles.filter((p) => !isShellProfile(p))
  const probe = useCommandPresence(agents.map((p) => p.command))
  const notInstalled = agents.filter((p) => probe.missing(p.command)).length

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
          <>
            <button
              type="button"
              className="ghost-btn sbtn"
              title="Look again for each of these commands on your PATH"
              onClick={probe.recheck}
            >
              <Icon name="restart" size={12} />
              Re-check
            </button>
            <button type="button" className="ghost-btn sbtn" onClick={() => create('agent')}>
              <Icon name="plus" size={12} />
              New agent
            </button>
          </>
        }
        hint={
          <>
            The command runs inside the pane's shell, so anything you can type works —{' '}
            <span className="mono">claude --resume</span>, a batch file, a conda activation followed by a launcher.
            {notInstalled > 0 ? (
              <>
                {' '}
                {notInstalled === 1 ? 'One of these is' : `${notInstalled} of these are`} not installed — open the row
                to install {notInstalled === 1 ? 'it' : 'them'}. A pane opened on a missing agent still works; it is
                just a shell, and it says so rather than erroring.
              </>
            ) : null}
          </>
        }
      >
        <ul className="sprof">
          {agents.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              presence={probe.of(p.command)}
              onRecheck={probe.recheck}
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
  presence = null,
  onRecheck,
  open,
  onToggle
}: {
  profile: AgentProfile
  /** Null for a shell, and until the probe answers. */
  presence?: CommandPresence | null
  onRecheck?: () => void
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { state, actions } = useApp()
  const shell = isShellProfile(profile)
  const ladder = supportsPermissionModes(profile)
  const mode = profile.permissionMode ?? 'default'
  const inUse = state.projects.filter((p) => p.defaultProfileId === profile.id).length
  const bypassSpec = permissionSpec(profile.command, 'bypass')
  const bypassLabel = bypassSpec?.label ?? 'Bypass'
  const bypassChip = bypassSpec?.chip ?? 'BYPASS'

  const patch = (next: Partial<AgentProfile>): void => actions.saveProfile({ ...profile, ...next })

  return (
    <li className="sprof__item" data-open={open ? 'true' : undefined}>
      <button type="button" className="sprof__row" aria-expanded={open} onClick={onToggle}>
        <AgentBadge profile={profile} size="md" />
        <span className="sprof__name truncate">{profile.name}</span>
        <span className="sprof__cmd mono truncate">{profile.command || 'plain shell'}</span>
        {ladder && mode !== 'default' ? (
          <StateChip tone={mode === 'bypass' ? 'danger' : 'warn'}>{modeLabel(profile.command, mode)}</StateChip>
        ) : null}
        {presence ? (
          <StateChip tone={presence.found ? 'ok' : presence.unknown ? 'off' : 'warn'}>
            {presence.found ? 'installed' : presence.unknown ? 'not checked' : 'not installed'}
          </StateChip>
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

          {!shell ? <PresenceRow profile={profile} presence={presence} onRecheck={onRecheck} /> : null}

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

          {ladder ? (
            <>
              <Row label="Permission mode" hint="The default for panes opened with this profile">
                <select
                  className="select"
                  value={mode}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => patch({ permissionMode: e.target.value as ClaudePermissionMode })}
                >
                  {profilePermissionModes(profile).map((m) => (
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
                  {bypassLabel} means {profile.name} never asks. It can edit, delete and run anything your account
                  can, in whatever folder the pane is open on. Panes launched this way are badged{' '}
                  <span className="mono">{bypassChip}</span> so you always know which ones they are.
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

/* --------------------------------------------------------- is it even here? */

/**
 * What this profile launches, and whether it exists.
 *
 * The Install button follows the rule the whole app follows for installing
 * things (see UpdatesSection): it opens a pane, types the command, and stops.
 * You press Enter. What is new here is only that you no longer have to know
 * which page to go to, or which package a CLI is published under, to find that
 * out — the row you were already looking at knows.
 */
function PresenceRow({
  profile,
  presence,
  onRecheck
}: {
  profile: AgentProfile
  presence: CommandPresence | null
  onRecheck?: () => void
}): ReactNode {
  const { state, actions } = useApp()
  const tool = toolSpecForCommand(profile.command, state.settings.customTools)
  const install = tool ? installCommandFor(tool) : null

  const detail = !presence
    ? 'looking…'
    : presence.unknown
      ? 'Not a plain command, so there is nothing to look up — this one is launched as written.'
      : presence.found
        ? presence.path
        : `${presence.exe} is not on your PATH`

  return (
    <Row
      label="On this machine"
      hint={
        presence && !presence.found && !presence.unknown
          ? 'A pane opened on this profile explains itself instead of erroring'
          : 'Where the command resolves to, walking PATH the way the shell would'
      }
    >
      <div className="sprof__presence">
        <span className="mono sprof__presence-path" title={detail ?? ''}>
          {detail}
        </span>
        {presence && !presence.found && !presence.unknown && install ? (
          <button
            type="button"
            className="ghost-btn sbtn"
            title={`Open a pane with “${install}” typed in it`}
            onClick={() => actions.openToolPane(`install: ${tool?.name ?? profile.name}`, install)}
          >
            <Icon name="terminal" size={12} />
            Install
          </button>
        ) : null}
        {presence && !presence.found && !presence.unknown && !install ? (
          <button
            type="button"
            className="ghost-btn sbtn"
            title="Add a row for it in Updates & tools, and Forge can install and track it"
            onClick={() => actions.openSettings('updates')}
          >
            Updates &amp; tools
          </button>
        ) : null}
        {onRecheck ? (
          <button type="button" className="ghost-btn sbtn" title="Look again" onClick={onRecheck}>
            <Icon name="restart" size={12} />
          </button>
        ) : null}
      </div>
    </Row>
  )
}

/** Codex and Claude spell the same rung differently, so the label needs the command. */
function modeLabel(command: string, mode: ClaudePermissionMode): string {
  return permissionSpec(command, mode)?.label ?? mode
}

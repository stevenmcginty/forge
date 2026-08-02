import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode } from '@shared/types'
import {
  ACCENT_PALETTE,
  effectivePermissionMode,
  makeCustomProfile,
  permissionSpec,
  profilePermissionModes,
  splitProfiles,
  supportsPermissionModes
} from '@/lib/agents'
import { useCommandPresence } from '@/hooks/useCommandPresence'
import { useApp } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './AgentChooser.css'

interface Props {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  /** One click here opens the pane. */
  onPick: (profileId: string, permissionMode?: ClaudePermissionMode) => void
  title?: string
  align?: 'start' | 'end' | 'center'
  /** Marks the row that is currently in effect (e.g. project default). */
  selectedId?: string
}

/**
 * The quick chooser: every profile, one click each, split into Shell and Agents
 * because those are two different intentions. Also the place a new custom
 * profile gets created (name + command is all it takes), and — for Claude — the
 * place a single pane can be opened in a different permission mode than the
 * profile's default, without changing the profile.
 */
export function AgentChooser({
  anchor,
  open,
  onClose,
  onPick,
  title = 'Open terminal with',
  align = 'start',
  selectedId
}: Props): ReactNode {
  const { state, actions } = useApp()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [accent, setAccent] = useState(ACCENT_PALETTE[3]!)
  /** Profile id whose permission submenu is showing. */
  const [modeFor, setModeFor] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      setCreating(false)
      setModeFor(null)
      setName('')
      setCommand('')
    }
  }, [open])

  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  const commit = (): void => {
    if (!name.trim()) return
    const profile = makeCustomProfile(name, command, accent)
    actions.saveProfile(profile)
    onPick(profile.id)
    onClose()
  }

  const pick = (profile: AgentProfile, mode?: ClaudePermissionMode): void => {
    onPick(profile.id, mode)
    onClose()
  }

  const { shells, agents } = splitProfiles(state.settings.agentProfiles)

  // Asked while the popover is open — a chooser that offers Codex on a machine
  // without Codex is the exact moment the fact is worth having. Nothing is
  // disabled by it: opening the pane is still allowed, and now says why.
  const probe = useCommandPresence(open ? agents.map((p) => p.command) : [])

  const row = (profile: AgentProfile): ReactNode => {
    const ladder = supportsPermissionModes(profile)
    const mode = effectivePermissionMode(profile)
    const spec = permissionSpec(profile.command, mode)
    const missing = probe.missing(profile.command)
    return (
      <div className="agent-chooser__line" key={profile.id}>
        <PopoverRow selected={profile.id === selectedId} onClick={() => pick(profile)}>
          <AgentBadge profile={profile} />
          <span className="agent-chooser__name truncate">{profile.name}</span>
          {missing ? (
            <span
              className="agent-chooser__missing"
              title={`${profile.command} is not on this machine — the pane will open as a shell and tell you how to install it`}
            >
              not installed
            </span>
          ) : spec && spec.chip ? (
            <span className="agent-chooser__mode mono" data-danger={spec.danger ? 'true' : undefined}>
              {spec.chip}
            </span>
          ) : (
            <span className="agent-chooser__cmd mono truncate">{profile.command || 'shell'}</span>
          )}
        </PopoverRow>
        {ladder ? (
          <button
            type="button"
            className="ghost-btn agent-chooser__modes"
            title={`Open ${profile.name} in a different permission mode`}
            aria-expanded={modeFor === profile.id}
            onClick={() => setModeFor(modeFor === profile.id ? null : profile.id)}
          >
            <Icon name="chevronDown" size={12} />
          </button>
        ) : null}

        {modeFor === profile.id ? (
          <div className="agent-chooser__submenu" role="group" aria-label={`${profile.name} permission mode`}>
            {profilePermissionModes(profile).map((m) => (
              <button
                key={m.id}
                type="button"
                className="agent-chooser__mode-row"
                data-danger={m.danger ? 'true' : undefined}
                data-selected={m.id === mode ? 'true' : undefined}
                onClick={() => pick(profile, m.id)}
              >
                <span className="agent-chooser__mode-name">{m.label}</span>
                <span className="agent-chooser__mode-note">{m.note}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} width={288} label={title}>
      {shells.length > 0 ? <PopoverSection title="Shell">{shells.map(row)}</PopoverSection> : null}

      {agents.length > 0 ? (
        <>
          {shells.length > 0 ? <PopoverDivider /> : null}
          <PopoverSection title={title === 'Open terminal with' ? 'Agents' : title}>{agents.map(row)}</PopoverSection>
        </>
      ) : null}

      <PopoverDivider />

      {!creating ? (
        <PopoverRow onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          <span className="agent-chooser__name">New profile…</span>
        </PopoverRow>
      ) : (
        <PopoverSection title="New profile">
          <div className="field">
            <label className="field__label" htmlFor="agent-name">
              Name
            </label>
            <input
              id="agent-name"
              ref={nameRef}
              className="field__input"
              value={name}
              placeholder="Codex"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="agent-command">
              Command
            </label>
            <input
              id="agent-command"
              className="field__input mono"
              value={command}
              placeholder="codex --resume"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
              }}
            />
          </div>
          <div className="swatches">
            {ACCENT_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                aria-label={`Accent ${c}`}
                data-selected={c === accent ? 'true' : undefined}
                style={{ background: c }}
                onClick={() => setAccent(c)}
              />
            ))}
          </div>
          <div className="popover__hint">
            Typed into a fresh PowerShell, so the prompt survives when the agent exits. Leave the command empty for a
            plain shell.
          </div>
          <div className="popover__actions">
            <button type="button" className="ghost-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="cta-btn" disabled={!name.trim()} onClick={commit}>
              Create &amp; open
            </button>
          </div>
        </PopoverSection>
      )}
    </Popover>
  )
}

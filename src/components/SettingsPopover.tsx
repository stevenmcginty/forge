import { useState, type ReactNode } from 'react'
import { ACCENT_PALETTE, makeCustomProfile } from '@/lib/agents'
import { useApp } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { DictationSetup } from './DictationSetup'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './SettingsPopover.css'

/**
 * Settings: terminal typography, the agent-profile roster, and a pointer at
 * %APPDATA%\Forge for anyone who would rather edit JSON.
 */
export function SettingsPopover({
  anchor,
  open,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}): ReactNode {
  const { state, actions } = useApp()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  const size = state.settings.terminalFontSize

  const commit = (): void => {
    if (!name.trim()) return
    actions.saveProfile(makeCustomProfile(name, command, ACCENT_PALETTE[3]))
    setName('')
    setCommand('')
    setCreating(false)
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" width={300} label="Settings">
      <PopoverSection title="Terminal">
        <div className="setting-row">
          <span className="setting-row__label">Font size</span>
          <div className="stepper">
            <button
              type="button"
              className="ghost-btn stepper__btn"
              aria-label="Smaller"
              onClick={() => actions.setFontSize(size - 1)}
            >
              −
            </button>
            <span className="stepper__value mono">{size}</span>
            <button
              type="button"
              className="ghost-btn stepper__btn"
              aria-label="Larger"
              onClick={() => actions.setFontSize(size + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-row__label">Shell</span>
          <span className="setting-row__value mono truncate">{state.info?.shell ?? 'pwsh.exe'}</span>
        </div>
      </PopoverSection>

      <PopoverDivider />

      <PopoverSection title="Agent profiles">
        {state.settings.agentProfiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <AgentBadge profile={p} size="sm" />
            <span className="profile-row__name truncate">{p.name}</span>
            <span className="profile-row__cmd mono truncate">{p.command || 'shell'}</span>
            {p.builtin ? (
              <span className="profile-row__lock eyebrow">built-in</span>
            ) : (
              <button
                type="button"
                className="ghost-btn profile-row__del"
                data-danger="true"
                title={`Delete ${p.name}`}
                onClick={() => actions.deleteProfile(p.id)}
              >
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        ))}

        {creating ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="settings-agent-name">
                Name
              </label>
              <input
                id="settings-agent-name"
                className="field__input"
                autoFocus
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
              <label className="field__label" htmlFor="settings-agent-cmd">
                Command
              </label>
              <input
                id="settings-agent-cmd"
                className="field__input mono"
                value={command}
                placeholder="codex"
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commit()
                }}
              />
            </div>
            <div className="popover__actions">
              <button type="button" className="ghost-btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="button" className="cta-btn" disabled={!name.trim()} onClick={commit}>
                Add profile
              </button>
            </div>
          </>
        ) : (
          <PopoverRow onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            <span className="profile-row__name">New profile…</span>
          </PopoverRow>
        )}
      </PopoverSection>

      <PopoverDivider />

      <PopoverSection title="Dictation">
        <DictationSetup compact />
      </PopoverSection>

      <PopoverDivider />

      <PopoverRow onClick={() => actions.openDataDir()}>
        <Icon name="folder" size={14} />
        <span className="profile-row__name">Open data folder</span>
      </PopoverRow>
      <div className="popover__hint">
        Profiles, projects and layouts live in <span className="mono">%APPDATA%\Forge</span> as plain JSON — edit
        them by hand if you like.
      </div>

      {state.info ? (
        <div className="settings__version mono">
          Forge {state.info.version} · Electron {state.info.electron} · Node {state.info.node}
        </div>
      ) : null}
    </Popover>
  )
}

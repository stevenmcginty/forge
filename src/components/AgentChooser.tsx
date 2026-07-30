import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { ACCENT_PALETTE, makeCustomProfile } from '@/lib/agents'
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
  onPick: (profileId: string) => void
  title?: string
  align?: 'start' | 'end' | 'center'
  /** Marks the row that is currently in effect (e.g. project default). */
  selectedId?: string
}

/**
 * The quick chooser: every agent profile, one click each. Also the place a new
 * custom profile gets created (name + command is all it takes).
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
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      setCreating(false)
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

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} width={272} label={title}>
      <PopoverSection title={title}>
        {state.settings.agentProfiles.map((profile: AgentProfile) => (
          <PopoverRow
            key={profile.id}
            selected={profile.id === selectedId}
            onClick={() => {
              onPick(profile.id)
              onClose()
            }}
          >
            <AgentBadge profile={profile} />
            <span className="agent-chooser__name truncate">{profile.name}</span>
            <span className="agent-chooser__cmd mono truncate">{profile.command || 'shell'}</span>
          </PopoverRow>
        ))}
      </PopoverSection>

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
            Typed into a fresh PowerShell, so the prompt survives when the agent exits.
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

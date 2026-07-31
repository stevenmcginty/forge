import { useState } from 'react'
import { PERMISSION_MODES, isClaudeCommand, isPermissionMode } from '@shared/agents'
import type { AgentProfile, ClaudePermissionMode, Project } from '@shared/types'

/**
 * The phone's answer to the desktop's AgentChooser: which agent, and — when
 * that agent is Claude — which permission mode the tab is born in.
 *
 * A bottom sheet rather than a menu, for the same reason the update sheet is
 * one: it lands where the thumb already is, and every row is a full-width
 * 48px target instead of a popover item sized for a mouse.
 *
 * Two rules the desktop chooser also follows:
 *
 *  - **The permission section only exists for Claude.** The flags mean nothing
 *    to a PowerShell prompt (see `isClaudeCommand`), so offering them there
 *    would be offering a choice that does nothing.
 *  - **Bypass never looks like the other three.** It is the one mode that can
 *    do anything the user can, so it is red where it sits, red when it is
 *    picked, and it turns the confirm button red with it.
 */

export interface NewTabSheetProps {
  project: Project
  /** The desktop's profiles, straight off `hello-ok`. */
  profiles: AgentProfile[]
  onCancel: () => void
  /** `permissionMode` is absent for anything that is not Claude. */
  onOpen: (profileId: string, permissionMode?: ClaudePermissionMode) => void
}

export function NewTabSheet({ project, profiles, onCancel, onOpen }: NewTabSheetProps): React.JSX.Element {
  // The project's default is the preselection, exactly as tapping "New tab"
  // used to be. Its *mode* is the profile's own, never a hard 'default' —
  // sending 'default' at a profile configured for plan mode would quietly
  // override it, which is the opposite of preselecting what would happen.
  const initial = profiles.find((p) => p.id === project.defaultProfileId) ?? profiles[0] ?? null
  const [profileId, setProfileId] = useState(initial?.id ?? '')
  const [mode, setMode] = useState<ClaudePermissionMode>(initial ? modeOf(initial) : 'default')

  const chosen = profiles.find((p) => p.id === profileId) ?? null
  const modal = chosen ? isClaudeCommand(chosen.command) : false

  const pick = (profile: AgentProfile): void => {
    setProfileId(profile.id)
    setMode(modeOf(profile))
  }

  return (
    <div className="sheet-scrim" onClick={onCancel}>
      <div className="sheet" role="dialog" aria-label="New tab" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>New tab</strong>
          <span className="sheet-version">{project.name}</span>
        </div>

        <div className="pick-scroll">
          <div className="pick-group" role="radiogroup" aria-label="Agent">
            <span className="pick-label">Agent</span>
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={profile.id === profileId}
                className="pick-row"
                data-selected={profile.id === profileId ? 'true' : undefined}
                onClick={() => pick(profile)}
              >
                <span className="pane-badge" style={{ background: profile.accent }}>
                  {profile.badge || '··'}
                </span>
                <span className="pick-text">
                  <span className="pick-name">{profile.name}</span>
                </span>
                <span className="pick-tick" aria-hidden="true">
                  ✓
                </span>
              </button>
            ))}
            {profiles.length === 0 && <span className="pick-note">The desktop offered no profiles.</span>}
          </div>

          {modal && (
            <div className="pick-group" role="radiogroup" aria-label="Permissions">
              <span className="pick-label">Permissions</span>
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === mode}
                  className="pick-row"
                  data-selected={m.id === mode ? 'true' : undefined}
                  data-danger={m.danger ? 'true' : undefined}
                  onClick={() => setMode(m.id)}
                >
                  <span className="pick-text">
                    <span className="pick-name">{m.label}</span>
                    <span className="pick-note">{m.note}</span>
                  </span>
                  <span className="pick-tick" aria-hidden="true">
                    ✓
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={modal && mode === 'bypass' ? 'primary primary-danger' : 'primary'}
          disabled={!chosen}
          onClick={() => chosen && onOpen(chosen.id, modal ? mode : undefined)}
        >
          {modal && mode === 'bypass' ? 'Open tab in Bypass' : 'Open tab'}
        </button>

        <button type="button" className="sheet-close" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The mode a profile would launch in on its own — the honest preselection. */
function modeOf(profile: AgentProfile): ClaudePermissionMode {
  if (!isClaudeCommand(profile.command)) return 'default'
  return isPermissionMode(profile.permissionMode) ? profile.permissionMode : 'default'
}

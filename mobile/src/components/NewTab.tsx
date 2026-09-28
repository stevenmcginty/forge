import { useState } from 'react'
import { isPermissionMode, permissionModes } from '@shared/agents'
import { CHATBOT_ORDER, CHATBOTS, type ChatBotId } from '@shared/chatbots'
import type { AgentProfile, ClaudePermissionMode, Project } from '@shared/types'
import { ChatBotTile } from './ChatBadge'

/**
 * The phone's answer to the desktop's AgentChooser: which agent, and — when
 * that agent has a permission ladder — which mode the tab is born in.
 *
 * A bottom sheet rather than a menu, for the same reason the update sheet is
 * one: it lands where the thumb already is, and every row is a full-width
 * 48px target instead of a popover item sized for a mouse.
 *
 * Two rules the desktop chooser also follows:
 *
 *  - **The permission section only exists for agents that have one.** The flags
 *    mean nothing to a PowerShell prompt or to Gemini (see `permissionModes`),
 *    so offering them there would be offering a choice that does nothing.
 *  - **Bypass never looks like the other three.** It is the one mode that can
 *    do anything the user can, so it is red where it sits, red when it is
 *    picked, and it turns the confirm button red with it.
 */

export interface NewTabSheetProps {
  project: Project
  /** The desktop's profiles, straight off `hello-ok`. */
  profiles: AgentProfile[]
  onCancel: () => void
  /** `permissionMode` is absent for anything with no permission ladder. */
  onOpen: (profileId: string, permissionMode?: ClaudePermissionMode) => void
  /**
   * Opens a chat tab (shared/chatbots.ts). Given, the sheet offers a
   * "Chatbots" group under the agents; absent — a desktop that cannot show a
   * chat on a phone — it offers none.
   */
  onChat?: (bot: ChatBotId) => void
}

export function NewTabSheet({ project, profiles, onCancel, onOpen, onChat }: NewTabSheetProps): React.JSX.Element {
  // The project's default is the preselection, exactly as tapping "New tab"
  // used to be. Its *mode* is the profile's own, never a hard 'default' —
  // sending 'default' at a profile configured for plan mode would quietly
  // override it, which is the opposite of preselecting what would happen.
  const initial = profiles.find((p) => p.id === project.defaultProfileId) ?? profiles[0] ?? null
  const [profileId, setProfileId] = useState(initial?.id ?? '')
  const [mode, setMode] = useState<ClaudePermissionMode>(initial ? modeOf(initial) : 'default')
  // A chatbot picked instead of an agent. One choice in the sheet, so picking
  // either kind clears the other.
  const [bot, setBot] = useState<ChatBotId | null>(null)

  const chosen = bot ? null : (profiles.find((p) => p.id === profileId) ?? null)
  // Each agent spells its own ladder, and something Forge has no flags for
  // offers none at all — so the section is driven by the list, not by a name.
  const modes = chosen ? permissionModes(chosen.command) : []
  const modal = modes.length > 0

  const pick = (profile: AgentProfile): void => {
    setBot(null)
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
                aria-checked={!bot && profile.id === profileId}
                className="pick-row"
                data-selected={!bot && profile.id === profileId ? 'true' : undefined}
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

          {onChat && (
            <div className="pick-group" role="radiogroup" aria-label="Chatbots">
              <span className="pick-label">Chatbots</span>
              {CHATBOT_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={bot === id}
                  className="pick-row"
                  data-selected={bot === id ? 'true' : undefined}
                  onClick={() => setBot(id)}
                >
                  <ChatBotTile bot={id} />
                  <span className="pick-text">
                    <span className="pick-name">{CHATBOTS[id].name}</span>
                  </span>
                  <span className="chat-kind">Chat</span>
                  <span className="pick-tick" aria-hidden="true">
                    ✓
                  </span>
                </button>
              ))}
            </div>
          )}

          {modal && (
            <div className="pick-group" role="radiogroup" aria-label="Permissions">
              <span className="pick-label">Permissions</span>
              {modes.map((m) => (
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
          disabled={!chosen && !bot}
          onClick={() => {
            if (bot) onChat?.(bot)
            else if (chosen) onOpen(chosen.id, modal ? mode : undefined)
          }}
        >
          {bot ? `Open ${CHATBOTS[bot].name} chat` : modal && mode === 'bypass' ? 'Open tab in Bypass' : 'Open tab'}
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
  if (permissionModes(profile.command).length === 0) return 'default'
  return isPermissionMode(profile.permissionMode) ? profile.permissionMode : 'default'
}

import { useEffect, useState, type ReactNode } from 'react'
import type { AgentProfile, ClaudePermissionMode, CommandPresence } from '@shared/types'
import {
  effectivePermissionMode,
  permissionSpec,
  profilePermissionModes,
  splitProfiles,
  supportsPermissionModes
} from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { Popover, PopoverRow, PopoverSection } from '@/components/Popover'
import { useForge, useProfiles } from '../state'

/**
 * "Open a terminal with…", drawn with the desktop chooser's own `.agent-chooser`
 * classes and its `AgentBadge` and `Popover` primitives.
 *
 * One thing the desktop's has and this one does not, on purpose: **creating a
 * profile**. A profile is a command line, and there is no frame on this wire
 * that carries one — `WebLayoutOp` names a `profileId` the desktop resolves
 * against its own settings, because "nothing on this wire chooses a cwd or an
 * executable". Adding a create form here would mean adding that frame, which is
 * the one thing the protocol's shape refuses.
 *
 * The permission-mode submenu, on the other hand, is here, and it is literally
 * the desktop's: the rungs, their words, their order and which of them is the
 * dangerous one all come out of `profilePermissionModes`, which reads the same
 * `PERMISSION_FAMILIES` table the desk reads. A browser therefore cannot offer a
 * mode this machine would spell differently or refuse to launch. It was left out
 * of the first release on the grounds that nobody had asked for it from a
 * browser; somebody has, and the ladder was never the expensive part —
 * `WebLayoutOp.permissionMode` was already on the wire and already passed
 * through, so all this component had to grow was a second argument on `onPick`
 * carrying the rung the click chose. Leave that argument off and the profile's
 * own default still applies, exactly as it did before.
 *
 * What it keeps is the part that earns its place: the "is this actually
 * installed" column, asked over the `agents` request while the popover is open.
 * A chooser that offers Codex on a machine without Codex is the exact moment the
 * fact is worth having.
 */
export function AgentChooser({
  anchor,
  open,
  onClose,
  onPick,
  title = 'Open terminal with',
  align = 'start',
  selectedId
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  /** One click here opens the pane; the mode, when given, is that open only. */
  onPick: (profileId: string, permissionMode?: ClaudePermissionMode) => void
  title?: string
  align?: 'start' | 'end' | 'center'
  selectedId?: string
}): ReactNode {
  const { actions } = useForge()
  const { shells, agents } = splitProfiles(useProfiles())
  const [presence, setPresence] = useState<CommandPresence[]>([])
  /** Profile id whose permission submenu is showing. */
  const [modeFor, setModeFor] = useState<string | null>(null)

  // A popover that was closed with a ladder hanging open would reopen showing
  // it, which reads as "this is where you left off" for a menu nobody left off
  // anywhere. The desktop's chooser forgets the same thing on the same edge.
  useEffect(() => {
    if (!open) setModeFor(null)
  }, [open])

  /**
   * The command lines to ask about, as one string, so the effect below re-asks
   * when the *set* changes rather than on every push that rebuilds the array.
   * A PATH probe per frame from the desktop would be this chooser making the
   * machine slower the busier it gets.
   */
  const probeKey = agents
    .map((p) => p.command)
    .filter(Boolean)
    .join('\n')

  useEffect(() => {
    if (!open || !probeKey) return
    let cancelled = false
    void actions.request({ kind: 'agents', commands: probeKey.split('\n') }).then((result) => {
      if (cancelled || result.kind !== 'agents') return
      setPresence(result.commands)
    })
    return () => {
      cancelled = true
    }
  }, [open, probeKey, actions])

  const missing = (command: string): boolean => {
    const found = presence.find((p) => p.command === command)
    // `unknown` is the honest third state: a command line that cannot be
    // resolved against PATH must not be labelled "not installed", because that
    // would be a confident lie about a profile that works perfectly.
    return Boolean(found && !found.found && !found.unknown)
  }

  const pick = (profile: AgentProfile, mode?: ClaudePermissionMode): void => {
    onPick(profile.id, mode)
    onClose()
  }

  const row = (profile: AgentProfile): ReactNode => {
    const ladder = supportsPermissionModes(profile)
    // The rung this row would launch on if you simply clicked it — which is what
    // the submenu ticks, and what the chip beside the name is naming.
    const mode = effectivePermissionMode(profile)
    const spec = permissionSpec(profile.command, mode)
    return (
      <div className="agent-chooser__line" key={profile.id}>
        <PopoverRow selected={profile.id === selectedId} onClick={() => pick(profile)}>
          <AgentBadge profile={profile} />
          <span className="agent-chooser__name truncate">{profile.name}</span>
          {missing(profile.command) ? (
            <span
              className="agent-chooser__missing"
              title={`${profile.command} is not on that machine — the pane will open as a shell and tell you how to install it`}
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
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} width={286} label={title}>
      <PopoverSection title={title}>{shells.map(row)}</PopoverSection>
      {agents.length > 0 ? <PopoverSection title="Agents">{agents.map(row)}</PopoverSection> : null}
    </Popover>
  )
}

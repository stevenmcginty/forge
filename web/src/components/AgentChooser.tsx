import { useEffect, useState, type ReactNode } from 'react'
import type { AgentProfile, CommandPresence } from '@shared/types'
import { splitProfiles } from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Popover, PopoverRow, PopoverSection } from '@/components/Popover'
import { useForge, useProfiles } from '../state'

/**
 * "Open a terminal with…", drawn with the desktop chooser's own `.agent-chooser`
 * classes and its `AgentBadge` and `Popover` primitives.
 *
 * Two things the desktop's has and this one does not, both on purpose:
 *
 *  - **Creating a profile.** A profile is a command line, and there is no frame
 *    on this wire that carries one — `WebLayoutOp` names a `profileId` the
 *    desktop resolves against its own settings, because "nothing on this wire
 *    chooses a cwd or an executable". Adding a create form here would mean
 *    adding that frame, which is the one thing the protocol's shape refuses.
 *  - **The permission-mode submenu.** `WebLayoutOp.permissionMode` exists and is
 *    passed through, so the capability is on the wire; the ladder UI is the
 *    desktop's and is not worth a second implementation until somebody asks for
 *    it from a browser. The profile's own default applies meanwhile.
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
  onPick: (profileId: string) => void
  title?: string
  align?: 'start' | 'end' | 'center'
  selectedId?: string
}): ReactNode {
  const { actions } = useForge()
  const { shells, agents } = splitProfiles(useProfiles())
  const [presence, setPresence] = useState<CommandPresence[]>([])

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

  const row = (profile: AgentProfile): ReactNode => (
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
      {missing(profile.command) ? (
        <span
          className="agent-chooser__missing"
          title={`${profile.command} is not on that machine — the pane will open as a shell and tell you how to install it`}
        >
          not installed
        </span>
      ) : (
        <span className="agent-chooser__cmd mono truncate">{profile.command || 'shell'}</span>
      )}
    </PopoverRow>
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} width={286} label={title}>
      <PopoverSection title={title}>{shells.map(row)}</PopoverSection>
      {agents.length > 0 ? <PopoverSection title="Agents">{agents.map(row)}</PopoverSection> : null}
    </Popover>
  )
}

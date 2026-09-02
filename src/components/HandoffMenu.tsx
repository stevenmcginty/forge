import type { ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { resolveProfile } from '@/lib/agents'
import type { HandoffTarget } from '@/lib/handoffview'
import { AgentBadge } from './AgentBadge'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './HandoffMenu.css'

/**
 * Who takes this pane's work over.
 *
 * Two groups, and the split is the point: above the divider are the agents that
 * already exist — the one this work came from, the one this tab always uses,
 * the ones open in other panes — and below it are the ones Forge would have to
 * start. Handing work to a running agent is instant; starting a new one costs a
 * pane and a boot, so it is never the first thing offered.
 *
 * The ordering itself is `handoffTargets` in src/lib/handoffview.ts, held to it
 * by scripts/handoff-check.mjs. This component draws the list and nothing else.
 */
export function HandoffMenu({
  anchor,
  open,
  onClose,
  targets,
  profiles,
  autoSend,
  onPick
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  targets: HandoffTarget[]
  profiles: AgentProfile[]
  /** Does this tab let Forge press Enter? Only changes what the hint says. */
  autoSend: boolean
  onPick: (target: HandoffTarget) => void
}): ReactNode {
  const existing = targets.filter((t) => t.kind !== 'new')
  const fresh = targets.filter((t) => t.kind === 'new')

  const row = (target: HandoffTarget): ReactNode => (
    <PopoverRow key={target.key} selected={target.kind === 'back'} onClick={() => onPick(target)}>
      <AgentBadge profile={resolveProfile(profiles, target.profileId)} size="sm" />
      <span className="hdmenu__name truncate">{target.label}</span>
      {target.note ? (
        <span className="hdmenu__note mono">{target.note}</span>
      ) : (
        <span className="hdmenu__agent mono">{target.agent}</span>
      )}
    </PopoverRow>
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" width={296} label="Hand off to">
      <PopoverSection title="Hand off to">
        {existing.length === 0 ? (
          <div className="popover__hint">No other agent is running in this project.</div>
        ) : (
          existing.map(row)
        )}
      </PopoverSection>
      {fresh.length === 0 ? null : (
        <>
          <PopoverDivider />
          <PopoverSection title="Or start one">{fresh.map(row)}</PopoverSection>
        </>
      )}
      <div className="popover__hint">
        {autoSend
          ? 'This agent is asked to write a handoff pack, and Forge presses Enter — this tab has auto-send on.'
          : 'This agent is asked to write a handoff pack. The prompt is typed here, never submitted — you press Enter.'}
      </div>
    </Popover>
  )
}

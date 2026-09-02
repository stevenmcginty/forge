import type { ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import type { HandoffTarget } from '@shared/handoffview'
import { resolveProfile } from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from '@/components/Popover'

/**
 * Who takes this pane's work over, in a browser.
 *
 * The desktop's src/components/HandoffMenu.tsx, drawn from the same rows: the
 * order is `handoffTargets` in shared/handoffview.ts and neither surface is
 * allowed a second opinion about it. Above the divider are the agents that
 * already exist — the one this work came from, the one this tab always uses,
 * the ones open in other panes — and below it the ones Forge would have to
 * start.
 *
 * A copy of the component rather than an import of the desktop's, and the
 * difference is what the two ends can honestly say. The desktop's rows act
 * through `useHandoffFlow` and can fail locally; a browser's row is a request
 * that travels, so this one has an in-flight state (rows disabled, a hint
 * saying the desktop was asked) and shows the desktop's refusal *in the menu*
 * rather than nowhere. `.hdmenu__*` and `.popover__*` are the same classes, so
 * the two read alike.
 */
export function HandoffMenu({
  anchor,
  open,
  onClose,
  targets,
  profiles,
  autoSend,
  busy,
  error,
  onPick
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  targets: HandoffTarget[]
  profiles: AgentProfile[]
  /** Does this tab let Forge press Enter? Only changes what the hint says. */
  autoSend: boolean
  /** A `handoff-start` is on the wire. Rows are dead until it is answered. */
  busy: boolean
  /** The desktop's refusal sentence, or ''. Shown here, never as a dialog. */
  error: string
  onPick: (target: HandoffTarget) => void
}): ReactNode {
  const existing = targets.filter((t) => t.kind !== 'new')
  const fresh = targets.filter((t) => t.kind === 'new')

  const row = (target: HandoffTarget): ReactNode => (
    <PopoverRow key={target.key} selected={target.kind === 'back'} disabled={busy} onClick={() => onPick(target)}>
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
      {/*
        The desktop's own words, and the one sentence that is this client's:
        a refusal. It replaces the hint rather than sitting under it — the hint
        describes what a click would do, and after a refusal nothing was done.
      */}
      {error ? (
        <div className="popover__hint hdmenu__error" role="alert">
          {error}
        </div>
      ) : busy ? (
        <div className="popover__hint">Asking the desktop…</div>
      ) : (
        <div className="popover__hint">
          {autoSend
            ? 'This agent is asked to write a handoff pack, and Forge presses Enter — this tab has auto-send on.'
            : 'This agent is asked to write a handoff pack. The prompt is typed here, never submitted — you press Enter.'}
        </div>
      )}
    </Popover>
  )
}

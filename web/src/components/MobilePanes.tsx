import { useEffect, useState, type ReactNode } from 'react'
import type { LayoutNode } from '@shared/types'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { AgentBadge } from '@/components/AgentBadge'
import { useForge, useProfiles } from '../state'
import { PaneView } from './PaneView'

/**
 * A tab's panes, one at a time, for a screen the width of a hand.
 *
 * The desktop's split tree is still the truth — `SplitView` draws it to scale
 * on anything wide enough — but a 2×2 grid at 390px is four unreadable
 * postage stamps. Here every leaf is drawn full-size in the same box and all but
 * one are hidden, and a strip of chips above them says which. Hidden rather
 * than unmounted for the reason `Workspace` gives about tabs: an xterm that is
 * unmounted is disposed, and comes back with a detach, an attach and a replay.
 * `fit()` refuses to measure a box under 8px, so a hidden pane does not resize
 * its PTY to nothing while it waits.
 *
 * Picking a chip is `focus-pane`, the same op a click on a pane sends, so the
 * desk's caret follows the thumb — and the pane this browser is then typing
 * into becomes the one whose grid it owns (electron/pty/grid-owner.ts), at
 * this phone's width. That is the whole reason a phone can read it at all.
 *
 * `viewing` is local on purpose and is the one place this file steps ahead of
 * the desk: the chip moves at once and the op is sent behind it. A pane switch
 * is the most frequent gesture on this layout, and a beat of dead time on each
 * is what made the tab strip feel broken before it learned to say "asked for".
 * The desk's answer — `activePaneId` in the next push — resets it, so the two
 * cannot stay apart.
 */
export function MobilePanes({
  node,
  activePaneId,
  onScreen
}: {
  node: LayoutNode
  activePaneId: string
  onScreen: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const profiles = useProfiles()
  const leaves = collectLeaves(node)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'

  const [viewing, setViewing] = useState(activePaneId)
  // The desk's answer wins, whichever answer it is.
  useEffect(() => setViewing(activePaneId), [activePaneId])
  const shown = leaves.some((l) => l.id === viewing) ? viewing : activePaneId

  const pick = (paneId: string): void => {
    setViewing(paneId)
    if (live) void actions.layout({ op: 'focus-pane', paneId })
  }

  return (
    <div className="mpanes">
      {leaves.length > 1 ? (
        <div className="mpanes__chips" role="tablist" aria-label="Panes in this tab">
          {leaves.map((leaf, i) => {
            const profile = resolveProfile(profiles, leaf.profileId)
            return (
              <button
                key={leaf.id}
                type="button"
                role="tab"
                className="mpanes__chip"
                aria-selected={leaf.id === shown}
                data-active={leaf.id === shown}
                data-working={state.asking.has(leaf.id) ? 'true' : undefined}
                onClick={() => pick(leaf.id)}
              >
                <AgentBadge profile={profile} size="sm" />
                <span className="truncate">{paneDisplayTitle(profile, leaf.title) || `Pane ${i + 1}`}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div className="mpanes__body">
        {leaves.map((leaf) => (
          <div className="mpanes__slot" key={leaf.id} data-active={leaf.id === shown}>
            <PaneView
              leaf={leaf}
              focused={leaf.id === activePaneId}
              onlyPane={leaves.length === 1}
              onScreen={onScreen && leaf.id === shown}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

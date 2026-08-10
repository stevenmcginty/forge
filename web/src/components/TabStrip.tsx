import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TerminalTab } from '@shared/types'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { useForge, useProfiles, useWorkspace } from '../state'
import { AgentChooser } from './AgentChooser'
import { CommandsButton, SkillsButton } from './Flyouts'

/**
 * The tab strip, in the desktop's own `.tabstrip` / `.tab` classes.
 *
 * Every gesture here is a request. Selecting a tab sends `select-tab`, closing
 * one sends `close-tab`, and neither touches local state: what moves the strip
 * is the `workspace` push that comes back, because the desktop renderer owns the
 * split tree and is the one thing that persists it (decision 5). That is why
 * there is no `setActiveTab` anywhere in this file, and why clicking a tab on a
 * frozen desktop does nothing rather than lying about it.
 *
 * Absent, deliberately: renaming, tab colours, drag reordering and the mosaic
 * toggle. `WEB_LAYOUT_OPS` has seven verbs and none of them is any of those —
 * the browser can create, close, select, split, focus and switch project, and a
 * strip that offered more would be offering something the wire cannot carry.
 */
export function TabStrip(): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const project = (state.picture?.projects ?? state.cached?.projects ?? []).find((p) => p.id === state.projectId)

  return (
    <div className="tabstrip" role="tablist" aria-label="Terminal tabs">
      <div className="tabstrip__tabs">
        {workspace.tabs.map((tab) => (
          <Tab key={tab.id} tab={tab} active={tab.id === workspace.activeTabId} />
        ))}
      </div>

      <button
        ref={newTabRef}
        type="button"
        className="ghost-btn tabstrip__new"
        title={live ? 'New terminal tab' : 'The desktop is not answering, so it cannot open a tab'}
        disabled={!live}
        onClick={() => setChooserOpen(true)}
      >
        <Icon name="plus" size={14} />
      </button>

      <div className="tabstrip__spacer" />

      <SkillsButton />
      <CommandsButton />

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId) => void actions.layout({ op: 'create-tab', profileId })}
        selectedId={project?.defaultProfileId}
      />
    </div>
  )
}

function Tab({ tab, active }: { tab: TerminalTab; active: boolean }): ReactNode {
  const { state, actions } = useForge()
  const profiles = useProfiles()
  const leaves = collectLeaves(tab.root)
  const badges = leaves.slice(0, 3).map((leaf) => resolveProfile(profiles, leaf.profileId))
  const primary = badges[0] ?? null
  // Agent tabs inherit the profile accent; an explicit tab colour still wins —
  // the same rule, in the same order, as the desktop's strip.
  const agentTint = primary && !isShellProfile(primary) ? primary.accent : undefined
  const tint = tab.color ?? agentTint
  const asking = leaves.some((leaf) => state.asking.has(leaf.id))

  return (
    <div
      className="tab"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-tint={tint ? 'true' : undefined}
      data-working={asking ? 'true' : undefined}
      title={asking ? `${tab.title} — a pane in here is waiting on an answer` : tab.title}
      style={
        {
          ...(tint ? { '--tab-tint': tint } : {}),
          ...(tab.textColor ? { '--tab-text-tint': tab.textColor } : {})
        } as CSSProperties
      }
      onPointerDown={() => {
        if (!active) void actions.layout({ op: 'select-tab', tabId: tab.id })
      }}
    >
      <div className="tab__badges">
        {badges.map((profile, index) => (
          <AgentBadge key={`${profile.id}-${index}`} profile={profile} size="sm" />
        ))}
        {leaves.length > 3 ? <span className="tab__more mono">+{leaves.length - 3}</span> : null}
      </div>

      <span className="tab__title truncate">{tab.title}</span>

      <button
        type="button"
        className="ghost-btn tab__close"
        data-danger="true"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          void actions.layout({ op: 'close-tab', tabId: tab.id })
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

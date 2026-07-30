import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TerminalTab, WorkspaceViewMode } from '@shared/types'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { resolveProfile } from '@/lib/agents'
import {
  useActiveProject,
  useActiveTab,
  useActiveWorkspace,
  useApp,
  usePaneCount,
  useViewMode
} from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { AgentChooser } from './AgentChooser'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { MosaicView } from './MosaicView'
import { SplitView } from './SplitView'
import './TerminalGrid.css'

/**
 * The terminal area: a tab strip over the active tab's pane tree, plus the two
 * empty states that lead into it.
 */
export function TerminalGrid(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const tab = useActiveTab()
  const viewMode = useViewMode()
  const { used, max } = usePaneCount()

  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  // Ctrl+T pops the same chooser as the + button.
  useEffect(() => {
    const open = (): void => {
      if (project) setChooserOpen(true)
    }
    window.addEventListener(NEW_TAB_EVENT, open)
    return () => window.removeEventListener(NEW_TAB_EVENT, open)
  }, [project])

  if (!state.ready) return <div className="grid grid--booting" />

  if (!project) {
    return (
      <div className="grid">
        <EmptyState
          icon="folder"
          eyebrow="Forge"
          title="No projects yet"
          body="Add a folder and Forge gives it its own terminal workspace — shells, Claude Code, Kimi, side by side."
          action={
            <button type="button" className="cta-btn" onClick={() => void actions.addProject()}>
              <Icon name="plus" size={14} />
              Add a project folder
            </button>
          }
        />
      </div>
    )
  }

  const atLimit = used >= max

  return (
    <div className="grid">
      <div className="tabstrip" role="tablist" aria-label="Terminal tabs">
        <div className="tabstrip__tabs">
          {workspace.tabs.map((t, index) => (
            <Tab
              key={t.id}
              tab={t}
              index={index}
              active={t.id === workspace.activeTabId}
              dragFrom={dragFrom}
              setDragFrom={setDragFrom}
            />
          ))}
        </div>

        <button
          ref={newTabRef}
          type="button"
          className="ghost-btn tabstrip__new"
          title={atLimit ? `Session limit reached (${max})` : 'New terminal tab (Ctrl+T)'}
          disabled={atLimit}
          onClick={() => setChooserOpen(true)}
        >
          <Icon name="plus" size={14} />
        </button>

        <div className="tabstrip__spacer" />

        <ViewToggle mode={viewMode} />
      </div>

      <div className="grid__body">
        {viewMode === 'mosaic' ? (
          <MosaicView project={project} workspace={workspace} onNewTerminal={() => setChooserOpen(true)} />
        ) : tab ? (
          <SplitView
            node={tab.root}
            project={project}
            activePaneId={tab.activePaneId}
            onlyPane={countLeaves(tab.root) === 1}
          />
        ) : (
          <EmptyState
            icon="terminal"
            eyebrow={project.name}
            title="No terminals open"
            body={
              <>
                Open one in <span className="mono">{project.path}</span>. Panes split, and every agent runs in a
                real PowerShell.
              </>
            }
            action={
              <button type="button" className="cta-btn" disabled={atLimit} onClick={() => setChooserOpen(true)}>
                <Icon name="plus" size={14} />
                Open a terminal
              </button>
            }
            hint="Ctrl + T"
          />
        )}
      </div>

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => actions.newTab(profileId, permissionMode)}
        selectedId={project.defaultProfileId}
      />
    </div>
  )
}

/* ----------------------------------------------------------- view toggle */

/**
 * Tabs or mosaic. Two states, so it is a segmented control rather than a menu:
 * the choice is always visible and switching it is one click, because you will
 * be doing it constantly.
 */
function ViewToggle({ mode }: { mode: WorkspaceViewMode }): ReactNode {
  const { actions } = useApp()
  const options: Array<{ value: WorkspaceViewMode; icon: 'viewTabs' | 'viewMosaic'; label: string }> = [
    { value: 'tabs', icon: 'viewTabs', label: 'Tab view' },
    { value: 'mosaic', icon: 'viewMosaic', label: 'Mosaic — every session as a live tile' }
  ]

  return (
    <div className="viewtoggle" role="group" aria-label="Terminal view">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="viewtoggle__btn"
          data-active={option.value === mode}
          aria-pressed={option.value === mode}
          title={`${option.label} (Ctrl+G)`}
          onClick={() => actions.setViewMode(option.value)}
        >
          <Icon name={option.icon} size={13} />
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------- tab */

function Tab({
  tab,
  index,
  active,
  dragFrom,
  setDragFrom
}: {
  tab: TerminalTab
  index: number
  active: boolean
  dragFrom: number | null
  setDragFrom: (i: number | null) => void
}): ReactNode {
  const { state, actions } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tab.title)

  const leaves = collectLeaves(tab.root)
  const badges = leaves.slice(0, 3).map((leaf) => resolveProfile(state.settings.agentProfiles, leaf.profileId))

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== tab.title) actions.renameTab(tab.id, next)
  }

  return (
    <div
      className="tab"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-dragover={dragFrom !== null && dragFrom !== index ? 'true' : undefined}
      draggable={!editing}
      onDragStart={(e) => {
        setDragFrom(index)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDragFrom(null)}
      onDragOver={(e) => {
        if (dragFrom === null || dragFrom === index) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (dragFrom !== null && dragFrom !== index) actions.moveTab(dragFrom, index)
        setDragFrom(null)
      }}
      onPointerDown={() => {
        if (!active) actions.selectTab(tab.id)
      }}
      onDoubleClick={() => {
        setDraft(tab.title)
        setEditing(true)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) actions.closeTab(tab.id)
      }}
    >
      <div className="tab__badges">
        {badges.map((p, i) => (
          <AgentBadge key={`${p.id}-${i}`} profile={p} size="sm" />
        ))}
        {leaves.length > 3 ? <span className="tab__more mono">+{leaves.length - 3}</span> : null}
      </div>

      {editing ? (
        <input
          className="tab__title-input"
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(tab.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="tab__title truncate">{tab.title}</span>
      )}

      <button
        type="button"
        className="ghost-btn tab__close"
        data-danger="true"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          actions.closeTab(tab.id)
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

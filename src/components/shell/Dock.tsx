import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaneLeaf, TerminalTab } from '@shared/types'
import { useCallSigns } from '@/hooks/useHub'
import { usePaneRuntime } from '@/hooks/usePaneRuntime'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { usePaneActivity } from '@/lib/paneActivity'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useUiCommand } from '@/lib/uiCommands'
import { useActiveProject, useActiveWorkspace, useApp, usePaneCount, useViewMode } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { Composer } from '../hub/Composer'
import { Icon } from '../Icon'
import { RailStack } from '../rail/RailStack'
import { Sheet, toggleSheet } from './Sheet'
import { StateChip } from './StateChip'
import './Dock.css'

/**
 * The dock: one bar along the deck's bottom edge, and nothing else.
 *
 * The bar (./hub/Composer) is the only place you talk to Forge: the project
 * you are in at its left (it opens the project sheet — every project, with its
 * tasks, git, activity and share sections), the Listen switch, the text, and
 * where the text goes. The panes live on the Wall and in the tabs; the
 * references that used to sit in a Tools pill (Skills, Commands, tab colours,
 * Wall text) are in the top bar's "…" menu and in the palette (Ctrl+K). The
 * panes switcher is still one key away (Ctrl+Shift+E).
 *
 * It floats over the backdrop, below the stage, so it never covers a terminal
 * and its glass only ever blurs a still picture.
 */
export function Dock(): ReactNode {
  const project = useActiveProject()
  return (
    <div className="dock" role="toolbar" aria-label="Dock">
      {project ? (
        <Composer lead={<ProjectPill />} />
      ) : (
        <div className="dock__composer dock__composer--idle">
          <ProjectPill />
          Add a project to start
        </div>
      )}
      <ProjectSheet />
      <PanesSheet />
    </div>
  )
}

/* ------------------------------------------------------------ project pill */

/** The project you are in, as the bar's first word; opens the project sheet. */
function ProjectPill(): ReactNode {
  const project = useActiveProject()
  const open = useShellSheet() === 'projects'
  useUiCommand('open-project-sheet', () => shellSheet.set('projects'))
  useUiCommand('close-project-sheet', () => {
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  })
  useUiCommand('toggle-project-sheet', () => toggleSheet('projects'))

  return (
    <button
      type="button"
      className="dock__project comp__project"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="projects"
      aria-expanded={open}
      title="Projects (Ctrl+Shift+B)"
      style={{ '--project': project?.color ?? 'var(--accent)' } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('projects')}
    >
      <span className="dock__project-dot" aria-hidden="true" />
      <span className="dock__project-name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={11} className="dock__chev" />
    </button>
  )
}

function ProjectSheet(): ReactNode {
  const { state } = useApp()
  // Picking a project is the end of the errand: the sheet goes, the way a menu
  // does, and the deck changes under it.
  const projectId = state.activeProjectId
  const lastProject = useRef(projectId)
  useEffect(() => {
    if (lastProject.current === projectId) return
    lastProject.current = projectId
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  }, [projectId])
  // The rail's own sections carry their headers and add buttons; the sheet
  // adds nothing above them.
  return (
    <Sheet id="projects" className="sheet--projects" label="Projects" keepOpen={state.railExpanded !== null}>
      <div className="sheet__rail">
        <RailStack />
      </div>
    </Sheet>
  )
}

/* -------------------------------------------------------------- panes pill */

interface Row {
  leaf: PaneLeaf
  tab: TerminalTab
}

function PanesSheet(): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const viewMode = useViewMode()
  const { used, max } = usePaneCount()
  const open = useShellSheet() === 'panes'
  // No pill in the dock any more: the switcher answers to its keys and the palette.
  useUiCommand('open-panes-switcher', () => shellSheet.set('panes'))
  useUiCommand('close-panes-switcher', () => {
    if (shellSheet.get() === 'panes') shellSheet.set(null)
  })
  useUiCommand('toggle-panes-switcher', () => toggleSheet('panes'))
  const { map: callSigns } = useCallSigns()
  const rows = useMemo<Row[]>(
    () => workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab }))),
    [workspace.tabs]
  )
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null
  const currentId = activeTab?.activePaneId ?? null
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Only on opening: moving the cursor must not snap back to the current pane.
  const openedAt = useRef({ rows, currentId })
  openedAt.current = { rows, currentId }
  useEffect(() => {
    if (!open) return
    const { rows: list, currentId: here } = openedAt.current
    const i = list.findIndex((r) => r.leaf.id === here)
    setCursor(i < 0 ? 0 : i)
    requestAnimationFrame(() => listRef.current?.focus())
  }, [open])

  const pick = (row: Row): void => {
    shellSheet.set(null)
    actions.revealPane(row.leaf.id)
    requestAnimationFrame(() => terminalHost.focus(row.leaf.id))
  }

  return (
    <Sheet id="panes" className="sheet--panes" label="Panes">
      <header className="sheet__head">
        <span className="sheet__eyebrow">Panes</span>
        <span className="sheet__count mono">
          {rows.length} here · {used}/{max} in all
        </span>
        <div className="sheet__seg" role="group" aria-label="View">
          <button
            type="button"
            data-active={viewMode === 'tabs' ? 'true' : undefined}
            onClick={() => actions.setViewMode('tabs')}
            title="Full screen — one terminal (its tab's splits too) under the wall strip (Ctrl+G)"
          >
            Full screen
          </button>
          <button
            type="button"
            data-active={viewMode === 'mosaic' ? 'true' : undefined}
            onClick={() => actions.setViewMode('mosaic')}
            title="Wall — every pane at once (Ctrl+G)"
          >
            Wall
          </button>
        </div>
      </header>
      <div
        ref={listRef}
        className="sheet__list"
        role="listbox"
        aria-label="Panes"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setCursor((c) => (rows.length ? (c + step + rows.length) % rows.length : 0))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            const row = rows[cursor]
            if (row) pick(row)
            return
          }
          if (/^[1-9]$/.test(e.key)) {
            const row = rows[Number(e.key) - 1]
            if (row) {
              e.preventDefault()
              pick(row)
            }
          }
        }}
      >
        {rows.length === 0 ? <div className="sheet__empty">No panes yet in this project.</div> : null}
        {rows.map((row, i) => (
          <PaneRow
            key={row.leaf.id}
            row={row}
            index={i}
            callSign={callSigns[row.leaf.id] ?? null}
            current={row.leaf.id === currentId}
            cursor={i === cursor}
            showTab={workspace.tabs.length > 1}
            profiles={state.settings.agentProfiles}
            onHover={() => setCursor(i)}
            onPick={() => pick(row)}
          />
        ))}
      </div>
      <footer className="sheet__foot">
        <button
          type="button"
          className="cta-btn sheet__new"
          onClick={() => {
            shellSheet.set(null)
            window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT))
          }}
        >
          <Icon name="plus" size={13} />
          New agent
        </button>
        <span className="sheet__keys mono">↑↓ pick · 1–9 jump · Enter go</span>
      </footer>
    </Sheet>
  )
}

function PaneRow({
  row,
  index,
  callSign,
  current,
  cursor,
  showTab,
  profiles,
  onHover,
  onPick
}: {
  row: Row
  index: number
  callSign: string | null
  current: boolean
  cursor: boolean
  showTab: boolean
  profiles: Parameters<typeof resolveProfile>[0]
  onHover: () => void
  onPick: () => void
}): ReactNode {
  const profile = resolveProfile(profiles, row.leaf.profileId)
  const runtime = usePaneRuntime(row.leaf.id)
  const activity = usePaneActivity(row.leaf.id, runtime)
  const title = paneDisplayTitle(profile, row.leaf.title)
  return (
    <button
      type="button"
      role="option"
      aria-selected={cursor}
      className="prow"
      data-current={current ? 'true' : undefined}
      data-cursor={cursor ? 'true' : undefined}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
      onPointerEnter={onHover}
      onClick={onPick}
    >
      <span className="prow__num mono">{index + 1}</span>
      <AgentBadge profile={profile} size="sm" />
      <span className="prow__name truncate">{callSign ?? title}</span>
      <span className="prow__kind truncate">
        {callSign ? title : title === profile.name ? '' : profile.name}
        {showTab ? ` · ${row.tab.title}` : ''}
      </span>
      <StateChip activity={activity} />
      {current ? <span className="prow__here">here</span> : null}
    </button>
  )
}

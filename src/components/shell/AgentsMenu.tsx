import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaneLeaf, TerminalTab } from '@shared/types'
import { paneNameInTab } from '@shared/workspace'
import { usePaneRuntime } from '@/hooks/usePaneRuntime'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { resolveProfile } from '@/lib/agents'
import { usePaneActivity } from '@/lib/paneActivity'
import { shellSheet, useShellMode, useShellSheet } from '@/lib/shellSlots'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useActiveProject, useActiveWorkspace, useApp, usePaneCount, useViewMode } from '@/state/AppState'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { Sheet, toggleSheet } from './Sheet'
import { StateChip } from './StateChip'
import './Dock.css'

/**
 * The top bar's Agents menu: every agent in the project, by name, with its
 * state as a word and a shape, and "here" on the one on screen. Picking one
 * opens it Full screen (bringing the agents back if the browser or the board
 * was up). It replaced the "N agents" count and the wall strip that used to
 * sit over Full screen, so Full screen is one terminal and nothing else.
 *
 * It is the old panes switcher, dropped from the top bar instead of risen from
 * the dock — the same shell sheet ('panes'), so Ctrl+Shift+E, the palette and
 * the … menu's "Every pane" all open it.
 */
export function AgentsMenu(): ReactNode {
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const open = useShellSheet() === 'panes'
  const n = workspace.tabs.reduce((sum, t) => sum + collectLeaves(t.root).length, 0)
  if (!project) return null

  return (
    <span className="agentsmenu">
      <button
        type="button"
        className="deckbar__agentsbtn"
        data-open={open ? 'true' : undefined}
        data-sheet-toggle="panes"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Every agent in this project — pick one to open it Full screen (Ctrl+Shift+E)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleSheet('panes')}
      >
        <span className="deckbar__agentsword">Agents</span>
        <span className="deckbar__agentsn">{n}</span>
        <Icon name="chevronDown" size={11} className="deckbar__agentschev" />
      </button>
      <PanesSheet />
    </span>
  )
}

interface Row {
  leaf: PaneLeaf
  tab: TerminalTab
}

function PanesSheet(): ReactNode {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const viewMode = useViewMode()
  const surface = useShellMode()
  const { used, max } = usePaneCount()
  const open = useShellSheet() === 'panes'
  useUiCommand('open-panes-switcher', () => shellSheet.set('panes'))
  useUiCommand('close-panes-switcher', () => {
    if (shellSheet.get() === 'panes') shellSheet.set(null)
  })
  useUiCommand('toggle-panes-switcher', () => toggleSheet('panes'))
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

  // Picking an agent opens it Full screen, over whatever mode was up.
  const pick = (row: Row): void => {
    shellSheet.set(null)
    actions.revealPane(row.leaf.id)
    actions.setViewMode('tabs')
    if (surface) uiCommands.run('set-mode', 'agents')
    requestAnimationFrame(() => requestAnimationFrame(() => terminalHost.focus(row.leaf.id)))
  }

  return (
    <Sheet id="panes" className="sheet--panes" label="Agents">
      <header className="sheet__head">
        <span className="sheet__eyebrow">Agents</span>
        <span className="sheet__count mono">
          {rows.length} here · {used}/{max} in all
        </span>
        <div className="sheet__seg" role="group" aria-label="View">
          <button
            type="button"
            data-active={viewMode === 'tabs' ? 'true' : undefined}
            aria-pressed={viewMode === 'tabs'}
            onClick={() => actions.setViewMode('tabs')}
            title="Full screen — one terminal (its tab's splits too), the whole stage (Ctrl+G)"
          >
            Full screen
          </button>
          <button
            type="button"
            data-active={viewMode === 'mosaic' ? 'true' : undefined}
            aria-pressed={viewMode === 'mosaic'}
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
        aria-label="Agents"
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
        {rows.length === 0 ? <div className="sheet__empty">No agents yet in this project.</div> : null}
        {rows.map((row, i) => (
          <PaneRow
            key={row.leaf.id}
            row={row}
            index={i}
            current={row.leaf.id === currentId}
            cursor={i === cursor}
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
          disabled={used >= max}
          onClick={() => {
            shellSheet.set(null)
            window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT))
          }}
        >
          <Icon name="plus" size={13} />
          New agent
        </button>
        <span className="sheet__keys mono">↑↓ pick · 1–9 jump · Enter open</span>
      </footer>
    </Sheet>
  )
}

function PaneRow({
  row,
  index,
  current,
  cursor,
  profiles,
  onHover,
  onPick
}: {
  row: Row
  index: number
  current: boolean
  cursor: boolean
  profiles: Parameters<typeof resolveProfile>[0]
  onHover: () => void
  onPick: () => void
}): ReactNode {
  const profile = resolveProfile(profiles, row.leaf.profileId)
  const runtime = usePaneRuntime(row.leaf.id)
  const activity = usePaneActivity(row.leaf.id, runtime)
  // The terminal's one name ("Zeb", "Zeb 2") — see shared/terminal-names.ts.
  const name = paneNameInTab(row.tab, row.leaf.id)
  return (
    <button
      type="button"
      role="option"
      aria-selected={cursor}
      aria-current={current ? 'true' : undefined}
      className="prow"
      data-current={current ? 'true' : undefined}
      data-cursor={cursor ? 'true' : undefined}
      style={{ '--pane-accent': profile.accent } as React.CSSProperties}
      onPointerEnter={onHover}
      onClick={onPick}
    >
      <span className="prow__num mono">{index + 1}</span>
      <AgentBadge profile={profile} size="sm" />
      <span className="prow__name truncate">{name}</span>
      <span className="prow__kind truncate">{profile.name}</span>
      <StateChip activity={activity} />
      {current ? <span className="prow__here">here</span> : null}
    </button>
  )
}

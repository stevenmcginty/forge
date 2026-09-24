import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import type { PaneLeaf, TerminalTab } from '@shared/types'
import { AgentChooser } from '../components/AgentChooser'
import { TabStrip } from '../components/TabStrip'
import { useActiveProject, useForge, useProfiles, useWorkspace } from '../state'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { DeckView } from './view'

interface Row {
  leaf: PaneLeaf
  tab: TerminalTab
}

/**
 * The panes sheet — src/components/shell/Dock.tsx's PanesSheet, dropped from
 * the top bar's chip instead of risen from the dock, because the tabs moved in
 * here: the deck's top bar is being redrawn, and a strip of tabs is the one
 * thing that must not crowd whatever it becomes.
 *
 * Top to bottom: the tab strip itself (the same `TabStrip` the wide page always
 * had — select, close behind its confirm, +, Skills, Commands), then every pane
 * in this project as a numbered row with its state in words, then New agent.
 * ↑↓ and Enter move through the rows, 1–9 jump.
 */
export function PanesSheet({ view, onView }: { view: DeckView; onView: (view: DeckView) => void }): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const project = useActiveProject()
  const open = useDeckSheet() === 'panes'
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const rows = useMemo<Row[]>(
    () => workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab }))),
    [workspace.tabs]
  )
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null
  const currentId = activeTab?.activePaneId ?? null
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const newRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)

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

  const pick = async (row: Row): Promise<void> => {
    deckSheet.set(null)
    if (!live) return
    if (row.tab.id !== activeTab?.id) {
      const refused = await actions.layout({ op: 'select-tab', tabId: row.tab.id })
      if (refused) return actions.setNotice(refused)
    }
    if (row.leaf.id !== row.tab.activePaneId || row.tab.id !== activeTab?.id) {
      const refused = await actions.layout({ op: 'focus-pane', paneId: row.leaf.id })
      if (refused) actions.setNotice(refused)
    }
  }

  return (
    <>
      <DeckSheet id="panes" className="dk-sheet--panes" label="Tabs and panes">
        <header className="dk-sheet__head">
          <span className="dk-sheet__eyebrow">Panes</span>
          <span className="dk-sheet__count mono">
            {rows.length} in {project?.name ?? 'this project'}
          </span>
          <div className="dk-seg" role="group" aria-label="View">
            <button type="button" data-active={view === 'tabs' ? 'true' : undefined} aria-pressed={view === 'tabs'} onClick={() => onView('tabs')}>
              Tabs
            </button>
            <button type="button" data-active={view === 'wall' ? 'true' : undefined} aria-pressed={view === 'wall'} onClick={() => onView('wall')}>
              Wall
            </button>
          </div>
        </header>

        <div className="dk-sheet__tabs">
          <TabStrip />
        </div>

        <div
          ref={listRef}
          className="dk-sheet__list"
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
              if (row) void pick(row)
              return
            }
            if (/^[1-9]$/.test(e.key)) {
              const row = rows[Number(e.key) - 1]
              if (row) {
                e.preventDefault()
                void pick(row)
              }
            }
          }}
        >
          {rows.length === 0 ? <div className="dk-sheet__empty">No panes yet in this project.</div> : null}
          {rows.map((row, i) => {
            const profile = resolveProfile(profiles, row.leaf.profileId)
            const title = paneDisplayTitle(profile, row.leaf.title)
            const here = row.leaf.id === currentId
            const asking = state.asking.has(row.leaf.id)
            const alive = (state.picture?.sessions ?? []).some((s) => s.id === row.leaf.id)
            return (
              <button
                key={row.leaf.id}
                type="button"
                role="option"
                aria-selected={i === cursor}
                className="dk-prow"
                data-current={here ? 'true' : undefined}
                data-cursor={i === cursor ? 'true' : undefined}
                style={{ '--pane-accent': profile.accent } as CSSProperties}
                onPointerEnter={() => setCursor(i)}
                onClick={() => void pick(row)}
              >
                <span className="dk-prow__num mono">{i + 1}</span>
                <AgentBadge profile={profile} size="sm" />
                <span className="dk-prow__name truncate">{title}</span>
                <span className="dk-prow__kind truncate">
                  {title === profile.name ? '' : profile.name}
                  {workspace.tabs.length > 1 ? `${title === profile.name ? '' : ' · '}${row.tab.title}` : ''}
                </span>
                <span className="dk-prow__state" data-state={asking ? 'attention' : alive ? 'idle' : 'dormant'}>
                  <PaneStateGlyph state={asking ? 'attention' : alive ? 'idle' : 'dormant'} />
                  {asking ? 'Needs you' : alive ? 'Running' : 'Not started'}
                </span>
                {here ? <span className="dk-prow__here">here</span> : <span />}
              </button>
            )
          })}
        </div>

        <footer className="dk-sheet__foot">
          <button
            ref={newRef}
            type="button"
            className="cta-btn dk-sheet__new"
            disabled={!live}
            title={live ? 'Open a new agent or terminal in this project' : 'The desktop is not answering, so it cannot open one'}
            onClick={() => setChooserOpen(true)}
          >
            <Icon name="plus" size={13} />
            New agent
          </button>
          <span className="dk-sheet__keys mono">↑↓ pick · 1–9 jump · Enter go</span>
        </footer>
      </DeckSheet>

      <AgentChooser
        anchor={newRef.current}
        open={chooserOpen && open}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => {
          setChooserOpen(false)
          deckSheet.set(null)
          void actions.layout({ op: 'create-tab', profileId, permissionMode })
        }}
        selectedId={project?.defaultProfileId}
      />
    </>
  )
}

/** The deck's StateChip shapes (src/components/shell/StateChip.tsx), for the three states this page can know. */
function PaneStateGlyph({ state }: { state: 'attention' | 'idle' | 'dormant' }): ReactNode {
  return (
    <svg className="dk-prow__glyph" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'attention' ? <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="currentColor" /> : null}
      {state === 'idle' ? <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'dormant' ? <rect x="1.5" y="4.2" width="7" height="1.6" rx="0.8" fill="currentColor" /> : null}
    </svg>
  )
}

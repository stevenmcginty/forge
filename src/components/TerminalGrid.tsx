import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_TABS_PER_PROJECT } from '@shared/ipc'
import type { TerminalTab, WorkspaceViewMode } from '@shared/types'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { ACCENT_PALETTE, TAB_TEXT_PALETTE, resolveProfile } from '@/lib/agents'
import { TAB_DRAG_TYPE } from '@/lib/mosaicLayout'
import { terminalHost } from '@/lib/terminals'
import {
  useActiveProject,
  useActiveTab,
  useActiveWorkspace,
  useApp,
  useMosaic,
  usePaneCount,
  useViewMode
} from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { AgentChooser } from './AgentChooser'
import { CommandsButton } from './CommandsFlyout'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { MosaicView } from './MosaicView'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import { SkillsButton } from './SkillsFlyout'
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
  const mosaic = useMosaic()
  const { used, max } = usePaneCount()

  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  const atTabLimit = workspace.tabs.length >= MAX_TABS_PER_PROJECT

  // Ctrl+T pops the same chooser as the + button — and meets the same ceiling.
  useEffect(() => {
    const open = (): void => {
      if (!project) return
      if (atTabLimit) {
        actions.setNotice(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs`)
        return
      }
      setChooserOpen(true)
    }
    window.addEventListener(NEW_TAB_EVENT, open)
    return () => window.removeEventListener(NEW_TAB_EVENT, open)
  }, [project, atTabLimit, actions])

  /*
   * Tab text colours reach the terminals from here rather than from
   * TerminalPane, because in mosaic view there are no panes — there are tiles,
   * and TerminalPane is not mounted at all. This is the one component that is
   * up in both views and knows every tab, so it is the one that paints.
   */
  const tabs = workspace.tabs
  const tinted = state.settings.tabTextColours
  useEffect(() => {
    for (const t of tabs) {
      for (const leaf of collectLeaves(t.root)) {
        // Off means null, not "no call": flipping the switch has to repaint the
        // terminals that are already coloured, not merely stop colouring new ones.
        terminalHost.setForeground(leaf.id, tinted ? (t.textColor ?? null) : null)
      }
    }
  }, [tabs, tinted])

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
              onWall={mosaic.wallTabs.includes(t.id)}
              dragFrom={dragFrom}
              setDragFrom={setDragFrom}
            />
          ))}
        </div>

        <button
          ref={newTabRef}
          type="button"
          className="ghost-btn tabstrip__new"
          title={
            atLimit
              ? `Session limit reached (${max})`
              : atTabLimit
                ? `A project holds at most ${MAX_TABS_PER_PROJECT} tabs`
                : 'New terminal tab (Ctrl+T)'
          }
          disabled={atLimit}
          onClick={() => {
            // Still clickable at the tab cap: the press is how you find out
            // there is one, rather than a button that quietly went dead.
            if (atTabLimit) {
              actions.setNotice(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs`)
              return
            }
            setChooserOpen(true)
          }}
        >
          <Icon name="plus" size={14} />
        </button>

        <div className="tabstrip__spacer" />

        {/* The wall's legibility switch, next to the toggle that gets you there. */}
        {viewMode === 'mosaic' ? <MosaicTextToggle /> : null}

        {/*
          The freeform wall's one control, parked here rather than over the
          tiles: the mosaic must not gain a toolbar the moment you drag
          something, or every tile shifts down by the height of it.
        */}
        {viewMode === 'mosaic' && mosaic.mode === 'custom' ? (
          <button
            type="button"
            className="ghost-btn tabstrip__reset"
            title="Freeform wall — drag a header to move it, an edge to resize it, double-click a header to refit its terminal. Click here to put every tile back in the grid."
            onClick={() => actions.resetMosaicLayout()}
          >
            <Icon name="restart" size={11} />
            Reset to grid
          </button>
        ) : null}

        {/* The two references, next to the switches rather than in Settings:
            what `claude` understands changes weekly, what it *knows* is a
            folder you curate, and the moment you want either is the moment you
            are looking at a pane. Skills first — it is the one you feed. */}
        <SkillsButton />

        <CommandsButton />

        <TabTintToggle />

        <ViewToggle mode={viewMode} />
      </div>

      <div className="grid__body">
        {viewMode === 'mosaic' ? (
          <MosaicView
            project={project}
            workspace={workspace}
            onNewTerminal={() => {
              if (atTabLimit) {
                actions.setNotice(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs`)
                return
              }
              setChooserOpen(true)
            }}
          />
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

/* ------------------------------------------------------ mosaic text size */

/**
 * Full-size text on the wall, or whole terminals shrunk to fit.
 *
 * Lives in the tab strip rather than in Settings alone because it is the answer
 * to "why can I not read this", and the place you ask that is while looking at
 * the wall. Settings → Appearance has the same switch for anyone who goes
 * looking there first.
 */
function MosaicTextToggle(): ReactNode {
  const { state, actions } = useApp()
  const lifesize = state.settings.mosaicText !== 'scaled'

  return (
    <button
      type="button"
      className="ghost-btn tabstrip__text"
      data-on={lifesize ? 'true' : undefined}
      aria-pressed={lifesize}
      title={
        lifesize
          ? 'Full-size text: every tile is a window onto its terminal at the same type size as tab view, cropped to the tile with the latest output showing. Click to shrink whole terminals to fit instead.'
          : 'Shrunk to fit: every tile keeps its terminal’s full width and shrinks the picture, so nothing reflows and the text gets smaller with every tile you add. Click for full-size text.'
      }
      onClick={() => actions.setMosaicText(lifesize ? 'scaled' : 'lifesize')}
    >
      <span className="tabstrip__aa">Aa</span>
      {lifesize ? 'Full size' : 'Shrink to fit'}
    </button>
  )
}

/* ------------------------------------------------------- tab text colours */

/**
 * Every tab's terminal colour, on or off, in one click.
 *
 * The tints are excellent for telling four Claudes apart and a distraction when
 * you are reading one of them closely, and that flips several times an hour —
 * so it is a switch in the strip, not a setting you go and find. It hides the
 * colours rather than clearing them: each tab keeps whatever it was painted,
 * the right-click palettes still work while it is off, and turning it back on
 * restores the lot. Nothing to redo, so nothing to fear about pressing it.
 */
function TabTintToggle(): ReactNode {
  const { state, actions } = useApp()
  const on = state.settings.tabTextColours

  return (
    <button
      type="button"
      className="ghost-btn tabstrip__tint"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      title={
        on
          ? 'Tab text colours are on: each tab’s terminals print in its own colour. Click to put every terminal back to the default text colour — the colours are kept, not cleared.'
          : 'Tab text colours are off: every terminal prints in the default text colour. Click to bring each tab’s colour back.'
      }
      onClick={() => actions.setTabTextColours(!on)}
    >
      <Icon name="palette" size={12} />
    </button>
  )
}

/* ----------------------------------------------------------- view toggle */

/** How long a dragged tab has to hover the mosaic button before it flips. */
const HOVER_FLIP_MS = 400

/**
 * Tabs or mosaic. Two states, so it is a segmented control rather than a menu:
 * the choice is always visible and switching it is one click, because you will
 * be doing it constantly.
 *
 * The mosaic button is also a spring-loaded drop target: hold a dragged tab
 * over it and the view flips under the pointer, so pulling a tab out of the
 * strip and onto the wall is one gesture even when you started in tab view.
 * 400ms, because anything shorter flips the app out from under a tab merely
 * being dragged past it.
 */
function ViewToggle({ mode }: { mode: WorkspaceViewMode }): ReactNode {
  const { actions } = useApp()
  const flipRef = useRef<number | null>(null)
  const [springing, setSpringing] = useState(false)

  const cancelFlip = (): void => {
    if (flipRef.current !== null) clearTimeout(flipRef.current)
    flipRef.current = null
    setSpringing(false)
  }

  useEffect(() => cancelFlip, [])

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
          data-springing={option.value === 'mosaic' && springing ? 'true' : undefined}
          aria-pressed={option.value === mode}
          title={`${option.label} (Ctrl+G)`}
          onClick={() => actions.setViewMode(option.value)}
          onDragOver={(e) => {
            if (option.value !== 'mosaic' || mode === 'mosaic') return
            if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (flipRef.current !== null) return
            setSpringing(true)
            flipRef.current = window.setTimeout(() => {
              flipRef.current = null
              setSpringing(false)
              actions.setViewMode('mosaic')
            }, HOVER_FLIP_MS)
          }}
          onDragLeave={cancelFlip}
          onDrop={cancelFlip}
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
  onWall,
  dragFrom,
  setDragFrom
}: {
  tab: TerminalTab
  index: number
  active: boolean
  /** This tab's panes were placed on the freeform wall by hand. */
  onWall: boolean
  dragFrom: number | null
  setDragFrom: (i: number | null) => void
}): ReactNode {
  const { state, actions } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tab.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  const leaves = collectLeaves(tab.root)
  const badges = leaves.slice(0, 3).map((leaf) => resolveProfile(state.settings.agentProfiles, leaf.profileId))

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== tab.title) actions.renameTab(tab.id, next)
  }

  const rename = (): void => {
    setDraft(tab.title)
    setEditing(true)
  }

  return (
    <div
      ref={ref}
      className="tab"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-tint={tab.color ? 'true' : undefined}
      title="Double-click to rename · Right-click for colours"
      style={
        {
          ...(tab.color ? { '--tab-tint': tab.color } : {}),
          ...(tab.textColor ? { '--tab-text-tint': tab.textColor } : {})
        } as React.CSSProperties
      }
      data-onwall={onWall ? 'true' : undefined}
      data-dragover={dragFrom !== null && dragFrom !== index ? 'true' : undefined}
      draggable={!editing}
      onDragStart={(e) => {
        setDragFrom(index)
        // Two jobs for one drag: within the strip it reorders, and over the
        // mosaic it puts this tab's panes on the wall. The payload is what the
        // wall reads; `dragFrom` is what the strip reads.
        e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id)
        e.dataTransfer.effectAllowed = 'copyMove'
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
      onDoubleClick={rename}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!active) actions.selectTab(tab.id)
        setMenuOpen(true)
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

      {/* Hollow while colours are off, so the strip never claims a colour the
          terminals are not actually printing in. */}
      {tab.textColor ? (
        <span
          className="tab__textdot"
          data-off={state.settings.tabTextColours ? undefined : 'true'}
          title={
            state.settings.tabTextColours
              ? `This tab’s terminals print in ${tab.textColor}`
              : `This tab is painted ${tab.textColor} — tab text colours are off`
          }
          aria-label="Terminal text colour"
        />
      ) : null}

      {onWall ? (
        <span className="tab__wall" title="On the mosaic wall" aria-label="On the mosaic wall">
          <Icon name="viewMosaic" size={10} />
        </span>
      ) : null}

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

      <TabMenu tab={tab} anchor={ref.current} open={menuOpen} onClose={() => setMenuOpen(false)} onRename={rename} />
    </div>
  )
}

/* -------------------------------------------------------------- tab menu */

/**
 * Right-click a tab: two colours, a rename and a close.
 *
 * They are deliberately separate colours rather than one that drives both. A
 * tab's colour is how you find it in the strip; its terminal colour is how you
 * know which session you are typing into once you are looking at the terminal
 * and the strip is out of mind. Wanting one without the other is the normal
 * case — two Claudes on the same project, one tinted so you cannot confuse
 * them — so neither implies the other.
 */
function TabMenu({
  tab,
  anchor,
  open,
  onClose,
  onRename
}: {
  tab: TerminalTab
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  onRename: () => void
}): ReactNode {
  const { actions } = useApp()

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={264} label="Tab colours">
      <PopoverSection title="Tab colour">
        <Swatches
          label="Tab colour"
          value={tab.color ?? null}
          onPick={(color) => actions.paintTab(tab.id, { color })}
        />
      </PopoverSection>

      <PopoverSection title="Terminal text">
        {/* The auto-assigned tints, so a new tab's colour is one of the swatches. */}
        <Swatches
          label="Terminal text colour"
          palette={TAB_TEXT_PALETTE}
          value={tab.textColor ?? null}
          onPick={(textColor) => actions.paintTab(tab.id, { textColor })}
        />
        <div className="popover__hint">
          Repaints this tab’s terminals. New tabs pick their own colour so no two look alike; this overrides it.
          Output that picks its own colour — Claude’s highlights, a diff, an error — keeps it.
        </div>
      </PopoverSection>

      <PopoverDivider />

      <PopoverRow
        onClick={() => {
          onClose()
          onRename()
        }}
      >
        <span className="tab__menu-name">Rename…</span>
      </PopoverRow>
      <PopoverRow
        danger
        onClick={() => {
          onClose()
          actions.closeTab(tab.id)
        }}
      >
        <span className="tab__menu-name">Close tab</span>
      </PopoverRow>
    </Popover>
  )
}

/**
 * The palette, a custom well, and a way back out.
 *
 * "None" first and always present: a colour you cannot remove is a colour you
 * will not risk trying, and the whole feature is only useful if it is cheap to
 * change your mind.
 */
function Swatches({
  value,
  onPick,
  label,
  palette = ACCENT_PALETTE
}: {
  value: string | null
  onPick: (color: string | null) => void
  label: string
  palette?: string[]
}): ReactNode {
  return (
    <div className="swatches" role="group" aria-label={label}>
      <button
        type="button"
        className="swatch swatch--none"
        aria-label={`${label}: none`}
        title="No colour"
        data-selected={value === null ? 'true' : undefined}
        onClick={() => onPick(null)}
      />
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          className="swatch"
          aria-label={`${label}: ${c}`}
          data-selected={value?.toLowerCase() === c.toLowerCase() ? 'true' : undefined}
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
      <label className="swatch swatch--custom" title="Custom colour">
        <input
          type="color"
          value={value ?? '#c6ff4a'}
          aria-label={`${label}: custom`}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  )
}

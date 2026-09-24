import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Project, TerminalTab, Workspace } from '@shared/types'
import { paneNameInTab } from '@shared/workspace'
import { usePaneRuntime } from '@/hooks/usePaneRuntime'
import { ACCENT_PALETTE, TAB_TEXT_PALETTE, resolveProfile, splitProfiles } from '@/lib/agents'
import { PATH_DRAG_TYPE, TASK_DRAG_TYPE } from '@/lib/mosaicLayout'
import { usePaneActivity } from '@/lib/paneActivity'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import { reducedMotion } from '@/lib/motion'
import { terminalHost } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import { ActivityDot } from '../ActivityDot'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { PeekStage, cellsOf, useCloseTerminal, wallReference, type Cell } from '../MosaicView'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from '../Popover'
import { Toggle } from '../settings/parts'
import { StateChip } from './StateChip'
import './WallStrip.css'

/**
 * The wall strip: every terminal in the project as a small live tile, in one
 * row across the top of the stage — over Full screen, and over the browser or
 * the board. It is what replaced the tab strip: the tabs are still there (a tab
 * is still one job, and its splits still show together in Full screen), but you
 * pick a terminal, not a tab.
 *
 * A click on a tile shows that pane in Full screen; the X closes it; a right-
 * click has its tab's colours, settings and name. The Wall button (and Ctrl+G)
 * goes back to every terminal at full stage size.
 *
 * The tiles are the real terminals, drawn through the Wall's own PeekStage and
 * following the Wall's text setting (life-size crop or scale model). A pane can
 * only be attached in one place at a time, so a pane that is on screen below
 * the strip — in Full screen — is drawn here as a marker, not a second picture.
 *
 * A tile takes a drop the way a pane does: a file (from Explorer, the rail, or
 * a Board tile — over the board the strip holds the only terminals on screen)
 * types its quoted path at the prompt, and a task card types its brief.
 */
export function WallStrip({
  project,
  workspace,
  onScreen,
  onOpen,
  onWall
}: {
  project: Project
  workspace: Workspace
  /** Panes attached full size below the strip right now: no peek for them. */
  onScreen: string[]
  /** Show this pane in Full screen. */
  onOpen: (paneId: string) => void
  /** Every terminal at once: the Wall. */
  onWall: () => void
}): ReactNode {
  const { state } = useApp()
  const close = useCloseTerminal()
  const cells = useMemo<Cell[]>(() => cellsOf(workspace.tabs), [workspace.tabs])
  const reference = useMemo(() => wallReference(cells), [cells])
  const lifesize = state.settings.mosaicText !== 'scaled'
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
  const activePaneId = activeTab?.activePaneId ?? null
  const rowRef = useRef<HTMLDivElement | null>(null)

  // A mouse wheel over the row scrolls it sideways. Not React's onWheel: that
  // one is passive, and the page must not also scroll.
  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || row.scrollWidth <= row.clientWidth) return
      row.scrollLeft += e.deltaY
      e.preventDefault()
    }
    row.addEventListener('wheel', onWheel, { passive: false })
    return () => row.removeEventListener('wheel', onWheel)
  }, [])

  // The pane you are on is never the one scrolled out of sight.
  useEffect(() => {
    if (!activePaneId) return
    const tile = rowRef.current?.querySelector<HTMLElement>(`.wstrip__tile[data-pane-id="${activePaneId}"]`)
    tile?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activePaneId, cells.length])

  return (
    <nav className="wstrip" aria-label="Every terminal">
      <div className="wstrip__tiles" ref={rowRef}>
        {cells.map((cell) => (
          <StripTile
            key={cell.leaf.id}
            cell={cell}
            project={project}
            reference={reference}
            lifesize={lifesize}
            active={cell.leaf.id === activePaneId}
            onScreen={onScreen.includes(cell.leaf.id)}
            tasks={workspace.tasks}
            onOpen={onOpen}
            onClose={close}
          />
        ))}
      </div>
      <button type="button" className="ghost-btn wstrip__wall" title="Wall — every terminal at once (Ctrl+G)" onClick={onWall}>
        <Icon name="viewMosaic" size={14} />
        <span className="wstrip__wall-word">Wall</span>
      </button>
    </nav>
  )
}

/* ------------------------------------------------------------------ tile */

function StripTile({
  cell,
  project,
  reference,
  lifesize,
  active,
  onScreen,
  tasks,
  onOpen,
  onClose
}: {
  cell: Cell
  project: Project
  reference: ReturnType<typeof wallReference>
  lifesize: boolean
  /** The active tab's current pane — the one the keyboard is on. */
  active: boolean
  /** Shown full size below the strip, so drawn as a marker here. */
  onScreen: boolean
  /** The project's task tray, for a card dropped on the tile. */
  tasks: Workspace['tasks']
  onOpen: (paneId: string) => void
  onClose: (paneId: string) => void
}): ReactNode {
  const { state, actions } = useApp()
  const paneId = cell.leaf.id
  const profile = resolveProfile(state.settings.agentProfiles, cell.leaf.profileId)
  const runtime = usePaneRuntime(paneId)
  const activity = usePaneActivity(paneId, runtime)
  // The terminal's one name ("Zeb", "Zeb 2") — see shared/terminal-names.ts.
  const name = paneNameInTab(cell.tab, paneId)
  const ref = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(cell.tab.title)
  const [dropping, setDropping] = useState(false)

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== cell.tab.title) actions.renameTab(cell.tab.id, next)
  }

  /* ------------------------------------------------------- dropped files */

  // Same contract as TerminalPane. maybeFiles (lib/paths) carries the story of
  // why acceptance is generous.
  const acceptDrag = (e: React.DragEvent): void => {
    const types = e.dataTransfer.types
    if (!maybeFiles(e) && !types.includes(PATH_DRAG_TYPE) && !types.includes(TASK_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDrop = (e: React.DragEvent): void => {
    // Unconditional: an unprevented file drop makes Chromium navigate the
    // window to the file, which would take the whole app down with it.
    e.preventDefault()
    setDropping(false)
    // A task card: typed, flattened, never submitted; off the tray only once
    // the text really landed.
    const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE)
    if (taskId) {
      const card = (tasks ?? []).find((t) => t.id === taskId)
      if (!card) return
      actions.revealPane(paneId)
      terminalHost.focus(paneId)
      requestAnimationFrame(() => {
        if (terminalHost.type(paneId, `${card.text} `)) actions.removeTask(card.id)
        else actions.setNotice('That pane has no live shell to hand the task to')
      })
      return
    }
    // A Board tile or a rail row rides as a path; Explorer's as files.
    const tracked = e.dataTransfer.getData(PATH_DRAG_TYPE)
    const quoted = tracked ? [`"${tracked}"`] : droppedFilePaths(e).map((p) => `"${p}"`)
    if (quoted.length === 0) return
    // Focus first, text a frame later — the path arrives as a bracketed paste,
    // and an agent that was just told its terminal lost focus (DECSET 1004)
    // drops it. The tile handed the file becomes the pane you are on.
    actions.revealPane(paneId)
    terminalHost.focus(paneId)
    requestAnimationFrame(() => terminalHost.paste(paneId, `${quoted.join(' ')} `))
  }

  return (
    <div
      ref={ref}
      className="wstrip__tile"
      data-pane-id={paneId}
      data-active={active ? 'true' : undefined}
      data-onscreen={onScreen ? 'true' : undefined}
      data-state={activity.state}
      data-status={runtime.status}
      data-tint={cell.tab.color ? 'true' : undefined}
      data-dropping={dropping ? 'true' : undefined}
      onDragEnter={acceptDrag}
      onDragOver={acceptDrag}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={onDrop}
      style={
        {
          '--pane-accent': profile.accent,
          // The tab's own colour, when it was given one (right-click → Tab colour).
          ...(cell.tab.color ? { '--tab-tint': cell.tab.color } : {})
        } as React.CSSProperties
      }
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) onClose(paneId)
      }}
    >
      {/* The whole tile is the button; the header's own controls sit above it. */}
      <button
        type="button"
        className="wstrip__hit"
        aria-label={`Open ${name} full screen`}
        title={`${name} · ${profile.name} — click for full screen, right-click for the tab's colours and settings`}
        onClick={() => onOpen(paneId)}
      />

      <div className="wstrip__head">
        <AgentBadge profile={profile} size="sm" />
        {editing ? (
          <input
            className="wstrip__rename"
            value={draft}
            autoFocus
            spellCheck={false}
            aria-label="Tab name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(cell.tab.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <span className="wstrip__name truncate">{name}</span>
        )}
        <StateChip activity={activity} compact />
        <ActivityDot paneId={paneId} status={runtime.status} />
        <button
          type="button"
          className="ghost-btn wstrip__close"
          data-danger="true"
          aria-label={`Close ${name}`}
          title={`Close ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose(paneId)
          }}
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      {onScreen ? (
        <div className="wstrip__stage wstrip__here">
          <span className="wstrip__here-word">On screen</span>
        </div>
      ) : (
        <PeekStage cell={cell} project={project} refit={lifesize} reference={reference} className="wstrip__stage" />
      )}

      <TabMenu
        tab={cell.tab}
        anchor={ref.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onRename={() => {
          setDraft(cell.tab.title)
          setEditing(true)
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------- tab menu */

/**
 * Right-click a strip tile: its tab's two colours, the tab's own settings, a
 * rename and a close. (Moved here with the tab strip's retirement; the tab is
 * still the unit these belong to.)
 *
 * The colours are deliberately separate rather than one that drives both. A
 * tab's colour is how you find it in the strip; its terminal colour is how you
 * know which session you are typing into once you are looking at the terminal
 * and the strip is out of mind. Wanting one without the other is the normal
 * case — two Claudes on the same project, one tinted so you cannot confuse
 * them — so neither implies the other.
 *
 * The settings below them belong to the tab because a tab is one job. The
 * project answers for the folder; the tab answers for the work going on in it,
 * and "leave it to the project" stays the first option on both selects so the
 * tab is never forced to hold an opinion it does not have.
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
  const { state, actions } = useApp()
  const { agents, shells } = splitProfiles(state.settings.agentProfiles)
  const settings = tab.settings

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={288} label="Tab settings">
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

      <PopoverSection title="Settings">
        <div className="field">
          <label className="field__label" htmlFor={`tab-agent-${tab.id}`}>
            New panes open as
          </label>
          {/* Agents first, shells last: splitting to get a prompt is the rarer
              want, and the list is read top-down. */}
          <select
            id={`tab-agent-${tab.id}`}
            className="select"
            value={settings?.defaultProfileId ?? ''}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.setTabSettings(tab.id, { defaultProfileId: e.target.value || undefined })}
          >
            <option value="">Project default</option>
            {[...agents, ...shells].map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`tab-handoff-${tab.id}`}>
            Hand off to
          </label>
          {/* Agents only. A handoff is a brief written for somebody who can read
              it, and a shell cannot. */}
          <select
            id={`tab-handoff-${tab.id}`}
            className="select"
            value={settings?.handoffTargetId ?? ''}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => actions.setTabSettings(tab.id, { handoffTargetId: e.target.value || undefined })}
          >
            <option value="">Ask each time</option>
            {agents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="tab__menu-toggle">
          <span className="tab__menu-name">Send handoffs without asking</span>
          <Toggle
            checked={settings?.handoffAutoSend === true}
            label="Send handoffs without asking"
            // Off is written as absent, not as `false`: the two mean the same
            // thing to every reader, and one of them keeps the file clean.
            onChange={(on) => actions.setTabSettings(tab.id, { handoffAutoSend: on || undefined })}
          />
        </div>
        <div className="popover__hint">
          Forge presses Enter on the handoff prompts for you. Off, you read them first.
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

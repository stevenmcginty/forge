import { useRef, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { ACCENT_PALETTE, resolveProfile } from '@/lib/agents'
import { shortPath } from '@/lib/paths'
import { countLeaves } from '@/lib/splitTree'
import { useApp } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import './ProjectRail.css'

/**
 * The left rail: every project Forge knows about. Each one owns its own
 * terminal workspace, so selecting a project swaps the whole grid while its
 * shells keep running in the background.
 *
 * **One way to add a project, not two.** The + in the header is it. There used
 * to be a dashed "Add project" button pinned to the foot as well, which meant
 * the rail carried the same action twice for anyone with projects already —
 * clutter, and a permanent strip of chrome charged against the list. The empty
 * state still spells it out, because that is the one moment the + needs
 * explaining rather than just being there.
 */
export function ProjectRail(): ReactNode {
  const { state, actions } = useApp()
  const collapsed = state.settings.railCollapsed
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  return (
    <div className="rail" data-collapsed={collapsed}>
      <header className="rail__head">
        {collapsed ? null : (
          <>
            <span className="eyebrow">Projects</span>
            <span className="rail__count mono">{state.projects.length}</span>
          </>
        )}
        <button
          type="button"
          className="ghost-btn rail__head-add"
          title="Add project folder"
          onClick={() => void actions.addProject()}
        >
          <Icon name="plus" size={14} />
        </button>
      </header>

      <div className="rail__list">
        {state.projects.length === 0 ? (
          collapsed ? null : (
            <EmptyState
              icon="folder"
              size="sm"
              title="No projects"
              body="Point Forge at a folder to get started."
              action={
                <button type="button" className="cta-btn" onClick={() => void actions.addProject()}>
                  Add project
                </button>
              }
            />
          )
        ) : (
          state.projects.map((project, index) => (
            <ProjectRow
              key={project.id}
              project={project}
              index={index}
              collapsed={collapsed}
              active={project.id === state.activeProjectId}
              dragFrom={dragFrom}
              setDragFrom={setDragFrom}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- row */

function ProjectRow({
  project,
  index,
  collapsed,
  active,
  dragFrom,
  setDragFrom
}: {
  project: Project
  index: number
  collapsed: boolean
  active: boolean
  dragFrom: number | null
  setDragFrom: (i: number | null) => void
}): ReactNode {
  const { state, actions } = useApp()
  const rowRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const workspace = state.workspaces[project.id]
  const panes = workspace ? workspace.tabs.reduce((n, t) => n + countLeaves(t.root), 0) : 0
  const profile = resolveProfile(state.settings.agentProfiles, project.defaultProfileId)

  return (
    <div
      ref={rowRef}
      className="prow"
      data-active={active}
      data-dragover={dragFrom !== null && dragFrom !== index ? 'true' : undefined}
      /*
       * The project's colour, handed to CSS once and spent in several places:
       * the dot, the seam, the selected row's wash, the pane-count chip. Set
       * here rather than on each of them so the row has one colour and cannot
       * disagree with itself, and so a colour change from the menu repaints the
       * lot in a single style write.
       */
      style={{ '--prow-tint': project.color } as React.CSSProperties}
      draggable
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
        if (dragFrom !== null && dragFrom !== index) actions.moveProject(dragFrom, index)
        setDragFrom(null)
      }}
      onClick={() => actions.selectProject(project.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
      title={collapsed ? `${project.name} — ${project.path}` : project.path}
    >
      <span className="prow__dot" style={{ background: project.color }} />

      {collapsed ? (
        <span className="prow__initial">{project.name.slice(0, 1).toUpperCase()}</span>
      ) : (
        <>
          <span className="prow__text">
            <span className="prow__name truncate">{project.name}</span>
            <span className="prow__path mono truncate">{shortPath(project.path)}</span>
          </span>

          <AgentBadge profile={profile} size="sm" />

          {panes > 0 ? <span className="prow__panes mono">{panes}</span> : null}

          <button
            ref={menuRef}
            type="button"
            className="ghost-btn prow__menu"
            title="Project settings"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(true)
            }}
          >
            <Icon name="dots" size={14} />
          </button>
        </>
      )}

      <ProjectMenu
        anchor={menuRef.current ?? rowRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        project={project}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ menu */

function ProjectMenu({
  anchor,
  open,
  onClose,
  project
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  project: Project
}): ReactNode {
  const { state, actions } = useApp()
  const [name, setName] = useState(project.name)
  const [confirmRemove, setConfirmRemove] = useState(false)

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={276} label="Project settings">
      <PopoverSection title="Project">
        <div className="field">
          <label className="field__label" htmlFor={`pname-${project.id}`}>
            Name
          </label>
          <input
            id={`pname-${project.id}`}
            className="field__input"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim()
              if (next && next !== project.name) actions.updateProject(project.id, { name: next })
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                const next = name.trim()
                if (next) actions.updateProject(project.id, { name: next })
                onClose()
              }
            }}
          />
        </div>
        <div className="swatches">
          {ACCENT_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              aria-label={`Colour ${c}`}
              data-selected={c === project.color ? 'true' : undefined}
              style={{ background: c }}
              onClick={() => actions.updateProject(project.id, { color: c })}
            />
          ))}
        </div>
      </PopoverSection>

      <PopoverSection title="Default agent">
        {state.settings.agentProfiles.map((p) => (
          <PopoverRow
            key={p.id}
            selected={p.id === project.defaultProfileId}
            onClick={() => actions.updateProject(project.id, { defaultProfileId: p.id })}
          >
            <AgentBadge profile={p} size="sm" />
            <span className="prow__menu-name truncate">{p.name}</span>
            {p.id === project.defaultProfileId ? <Icon name="check" size={13} /> : null}
          </PopoverRow>
        ))}
      </PopoverSection>

      <PopoverDivider />

      <PopoverRow
        onClick={() => {
          actions.revealProject(project.id)
          onClose()
        }}
      >
        <Icon name="folder" size={14} />
        <span className="prow__menu-name">Reveal in Explorer</span>
      </PopoverRow>

      {confirmRemove ? (
        <>
          <div className="popover__hint">
            Removes {project.name} from Forge and closes its shells. The folder itself is untouched.
          </div>
          <div className="popover__actions">
            <button type="button" className="ghost-btn" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ghost-btn"
              data-danger="true"
              onClick={() => {
                actions.removeProject(project.id)
                onClose()
              }}
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <PopoverRow danger onClick={() => setConfirmRemove(true)}>
          <Icon name="trash" size={14} />
          <span className="prow__menu-name">Remove project…</span>
        </PopoverRow>
      )}
    </Popover>
  )
}

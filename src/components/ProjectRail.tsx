import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { useAnyBusy } from '@/hooks/usePaneRuntime'
import { ACCENT_PALETTE, resolveProfile } from '@/lib/agents'
import { shortPath } from '@/lib/paths'
import { collectLeaves } from '@/lib/splitTree'
import { useApp } from '@/state/AppState'
import { AddProjectMenu } from './AddProjectMenu'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import { RailSection } from './rail/RailSection'
import './ProjectRail.css'

/**
 * The left rail's first section: every project Forge knows about. Each one owns
 * its own terminal workspace, so selecting a project swaps the whole grid while
 * its shells keep running in the background.
 *
 * **Two buttons, one job each.** The + opens a folder that already exists; the
 * folder-plus next to it makes a brand-new one from a name (see
 * AddProjectMenu). There used to be a dashed "Add project" button pinned to the
 * foot as well, which meant the rail carried the same action twice for anyone
 * with projects already — clutter, and a permanent strip of chrome charged
 * against the list. The empty state spells the two buttons out, because that is
 * the one moment they need explaining rather than just being there.
 *
 * **The header moved.** The count and those two buttons used to live in a
 * `.rail__head` this component drew for itself; they are now handed to
 * <RailSection>, which draws the same header for all four sections. What is left
 * here is the list. The collapsed rail is the exception and still renders bare:
 * at 56px there is no header to speak of, and the dot column *is* the rail.
 *
 * This is also the only section that cannot be switched off, and the only one
 * with no height of its own — it takes the stack's slack. Both facts live in
 * src/lib/railstack.ts rather than here.
 */
export function ProjectRail(): ReactNode {
  const { state, actions } = useApp()
  const collapsed = state.settings.railCollapsed
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [addMenu, setAddMenu] = useState<{ open: boolean; anchor: HTMLElement | null }>({
    open: false,
    anchor: null
  })

  const openAddMenu = (e: MouseEvent<HTMLElement>): void =>
    setAddMenu({ open: true, anchor: e.currentTarget })

  const list = (
    <div className="rail__list">
      {state.projects.length === 0 ? (
        collapsed ? null : (
          <EmptyState
            icon="folder"
            size="sm"
            title="No projects"
            body="Create a new project, or open a folder you already have."
            action={
              <button type="button" className="cta-btn" onClick={openAddMenu}>
                Create project
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
  )

  const menu = (
    <AddProjectMenu
      anchor={addMenu.anchor}
      open={addMenu.open}
      onClose={() => setAddMenu((m) => ({ ...m, open: false }))}
    />
  )

  /*
   * Collapsed, the section chrome would be 28px of header saying "PROJECTS"
   * above a column of coloured dots that already says it better. So the narrow
   * rail keeps the shape it has always had, and the two add buttons stay with
   * the list rather than moving into a header that is not being drawn.
   */
  if (collapsed) {
    return (
      <div className="rail" data-collapsed="true">
        <header className="rail__head">
          <div className="rail__head-actions">
            <button type="button" className="ghost-btn rail__head-new" title="New project" onClick={openAddMenu}>
              <Icon name="folderPlus" size={14} />
            </button>
          </div>
        </header>
        {list}
        {menu}
      </div>
    )
  }

  return (
    <RailSection
      id="projects"
      title="Projects"
      count={state.projects.length}
      hint="Every folder Forge knows about"
      growable={false}
      actions={
        <>
          <button type="button" className="ghost-btn rail__head-new" title="New project" onClick={openAddMenu}>
            <Icon name="folderPlus" size={14} />
          </button>
          <button
            type="button"
            className="ghost-btn rail__head-add"
            title="Open existing folder"
            onClick={() => void actions.addProject()}
          >
            <Icon name="plus" size={14} />
          </button>
        </>
      }
    >
      <div className="rail">
        {list}
        {menu}
      </div>
    </RailSection>
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
  const paneIds = workspace ? workspace.tabs.flatMap((t) => collectLeaves(t.root).map((l) => l.id)) : []
  const panes = paneIds.length
  const profile = resolveProfile(state.settings.agentProfiles, project.defaultProfileId)

  /*
   * "One or more of this project's terminals is still working." Every pane in
   * every tab counts, not just the visible one — the whole point is to answer
   * for a project you are not currently looking at. The hook always runs; the
   * setting only decides whether the answer is allowed to show.
   */
  const working = useAnyBusy(paneIds) && state.settings.railBusyRing

  return (
    <div
      ref={rowRef}
      className="prow"
      data-active={active}
      data-working={working ? 'true' : undefined}
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
      title={`${collapsed ? `${project.name} — ${project.path}` : project.path}${
        working ? ' · working' : ''
      }`}
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

          <span className="prow__panes mono">{panes}</span>

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
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)

  /*
   * The project as of this render, so the effect below can read it without
   * listing every field of it as a dependency. It wants to run when the menu
   * opens and at no other moment — including, pointedly, not when the URL it
   * is about to write lands back on the project.
   */
  const projectRef = useRef(project)
  projectRef.current = project

  /* Has Steve touched the field since this open? Detection defers to him. */
  const editedRef = useRef(false)

  const commitRepoUrl = (value: string): void => {
    editedRef.current = true
    actions.setProjectRepoUrl(project.id, value)
  }

  /**
   * "You already have a repo — here it is."
   *
   * A project that has no URL recorded gets one asked of git the moment its
   * menu opens, so the common case (an agent ran `gh repo create` in a tab an
   * hour ago) needs nothing typed at all. Only on open, and only when the field
   * is empty at that moment: detection is a first-fill, not a policy, so a URL
   * Steve deletes stays deleted for as long as the menu is up and a URL he
   * typed by hand is never second-guessed.
   *
   * Two things can happen while git is being asked, and both win over the
   * answer: the menu closes (`live`), or the field is edited (`editedRef`).
   * Neither is unlikely — the ask is a process spawn away.
   */
  useEffect(() => {
    if (!open) return
    editedRef.current = false
    const { id, path, repoUrl: known } = projectRef.current
    setRepoUrl(known ?? '')
    if (known) return
    let live = true
    void window.forge.gitRemoteOrigin(path).then((found) => {
      if (!live || !found || editedRef.current) return
      setRepoUrl(found)
      actions.setProjectRepoUrl(id, found)
    })
    return () => {
      live = false
    }
  }, [open])

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

      <PopoverSection title="Repository">
        <div className="field">
          <label className="field__label" htmlFor={`prepo-${project.id}`}>
            URL
          </label>
          <input
            id={`prepo-${project.id}`}
            className="field__input mono"
            value={repoUrl}
            spellCheck={false}
            placeholder="https://github.com/you/repo"
            onChange={(e) => {
              editedRef.current = true
              setRepoUrl(e.target.value)
            }}
            onBlur={() => commitRepoUrl(repoUrl)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                commitRepoUrl(repoUrl)
                onClose()
              }
            }}
          />
        </div>
        {repoUrl ? null : (
          <div className="popover__hint">Left empty, each pane asks git for the origin itself.</div>
        )}
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

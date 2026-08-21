import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { collectLeaves } from '@/lib/splitTree'
import type { CommandsFeed, SlashCommand } from '@shared/commands'
import type { SkillsList } from '@shared/skills'
import { Icon } from '@/components/Icon'
import type { Project } from '@shared/types'
import { shortPath } from '../lib/paths'
import { useMobile } from '../lib/mobile'
import { useForge, useWorkspace } from '../state'
import { FolderPicker } from './FolderPicker'
import { GitPanel } from './GitPanel'

/**
 * The project rail, drawn with the desktop's own `.rail` and `.prow` classes.
 *
 * Selecting a project is a `select-project` layout op, so the desk follows.
 *
 * **Adding one is now here too**, and this comment used to say at length that it
 * could not be: adding a project meant picking a folder on a machine this page
 * is not on, and the protocol modelled no path a browser could send. The second
 * half of that was true and has been changed on purpose — `fs-list` and
 * `project-add` exist, and the reckoning about what that does and does not cost
 * is on `WebRequest` in shared/web.ts. The first half was never an argument for
 * anything: a native folder picker opens on the desktop's screen, which is
 * precisely the screen the person adding the project is not sitting at. So the
 * folders are browsed in the page — see `FolderPicker` — and the desktop's own
 * `addProjectPath` is what actually adds one.
 *
 * The attention dot is `WebAttentionFrame`: which pane has settled on a
 * question, so a project you are not looking at can say that something in it is
 * waiting.
 */
export function Rail({ collapsed }: { collapsed: boolean }): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  const workspaces = state.picture?.workspaces ?? state.cached?.workspaces ?? {}
  const sessions = state.picture?.sessions ?? state.cached?.sessions ?? []
  const addRef = useRef<HTMLButtonElement | null>(null)
  const [picking, setPicking] = useState(false)
  /**
   * Adding a project reaches the desktop's disk and then its renderer, so it is
   * offered only while there is a desktop on the end of the socket. The frozen
   * picture draws the button and refuses it rather than hiding it, for the
   * reason the whole offline view exists: Forge asleep should not look like
   * Forge missing a feature.
   */
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'

  const paneCount = (project: Project): number => {
    const workspace = workspaces[project.id]
    if (!workspace) return 0
    const ids = new Set(workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => leaf.id)))
    return sessions.filter((s) => ids.has(s.id)).length
  }

  const attention = (project: Project): boolean => {
    const workspace = workspaces[project.id]
    if (!workspace) return false
    return workspace.tabs.some((tab) => collectLeaves(tab.root).some((leaf) => state.asking.has(leaf.id)))
  }

  return (
    <div className="rail" data-collapsed={collapsed}>
      {/*
        Collapsed, the header keeps its button and loses its words — which is
        exactly what the desktop's does, and ProjectRail.css already centres
        `.rail__head` and drops its padding at 56px for that very purpose. This
        used to draw nothing at all when collapsed, on the reasoning
        ProjectRail.tsx gives about its own rail ("at 56px there is no header to
        speak of, and the dot column *is* the rail") — which was fine while
        there was no button to lose. It is not fine now: `useNarrow` collapses
        this rail by *window* below 640px, so on a phone there is no toggle to
        press, and hiding the header there would take Add project away from the
        one screen most likely to be nowhere near the desk.
      */}
      <div className="rail__head">
        {collapsed ? null : (
          <>
            <span className="eyebrow">Projects</span>
            <span className="rail__count mono">{projects.length}</span>
          </>
        )}
        <span className="rail__head-actions">
          <button
            ref={addRef}
            type="button"
            className="ghost-btn rail__head-add"
            title={live ? 'Add a project from a folder on that desktop' : 'The desktop is not answering right now'}
            aria-label="Add project"
            data-testid="add-project"
            disabled={!live}
            onClick={() => setPicking((v) => !v)}
          >
            <Icon name="plus" size={14} />
          </button>
        </span>
      </div>

      <div className="rail__list">
        {projects.map((project) => {
          const panes = paneCount(project)
          const select = (): void => actions.selectProject(project.id)
          return (
            <div
              key={project.id}
              className="prow"
              // A div with a role rather than a <button>, because the desktop's
              // row is a div and `.prow`'s layout assumes it: a button centres
              // its content, which pushes the name into the middle of the rail
              // and the path under it. The role and the key handler are the one
              // thing added — the desktop's row has neither, and a rail you
              // cannot tab through is not something to copy faithfully.
              role="button"
              tabIndex={0}
              data-active={project.id === state.projectId}
              data-attention={attention(project) ? 'true' : undefined}
              title={`${project.name} — ${project.path}`}
              style={{ '--prow-tint': project.color } as CSSProperties}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select()
                }
              }}
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
                  <span className="prow__panes mono">{panes}</span>
                </>
              )}
            </div>
          )
        })}
        {projects.length === 0 ? (
          <p className="rail__empty">
            {live
              ? 'No projects on that desktop yet. Press + above to look through its folders and pick one.'
              : 'No projects on that desktop yet. Adding one needs the desktop awake, because the folder is on it.'}
          </p>
        ) : null}
      </div>

      <GitPanel collapsed={collapsed} />

      {mobile ? (
        <>
          <MobileSkills />
          <MobileCommands />
        </>
      ) : null}

      <FolderPicker anchor={addRef.current} open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

/* ------------------------------------------------------- drawer references
 *
 * The tab strip's two flyouts are hidden on a phone — styles.css says why —
 * but the lists themselves are not desk-only: the protocol carries exactly one
 * verb for each (`{ kind: 'skills' }`, `{ kind: 'commands' }`, both reads) and
 * one tap that types the name into the focused pane, which is the same honest
 * surface Flyouts.tsx offers. The drawer is where this face already keeps its
 * references, so the lists live here as rail sections rather than as popovers
 * anchored to pills in a scrolling strip.
 */

/** Where a typed name lands: the active pane of the active tab, as Flyouts has it. */
function useFocusedPaneId(): string | null {
  const workspace = useWorkspace()
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  if (!tab) return null
  const leaves = collectLeaves(tab.root)
  return leaves.find((leaf) => leaf.id === tab.activePaneId)?.id ?? leaves[0]?.id ?? null
}

function MobileSkills(): ReactNode {
  const { state, actions } = useForge()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<SkillsList | null>(null)
  const [error, setError] = useState('')
  const paneId = useFocusedPaneId()
  const live = state.connection.state === 'live'

  useEffect(() => {
    if (!open || !live) return
    let cancelled = false
    void actions.request({ kind: 'skills' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'skills') setList(result.skills)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [open, live, actions])

  const rows = [
    ...(list?.skills ?? []).filter((s) => s.enabled).map((s) => ({ key: s.name, name: s.name, description: s.description, types: `/${s.name} ` })),
    ...(list?.machineSkills ?? []).map((s) => ({ key: `m:${s.name}`, name: s.name, description: s.description, types: `/${s.name} ` })),
    ...(list?.externalSkills ?? []).map((s) => ({ key: s.id, name: s.title || s.name, description: s.description, types: s.command }))
  ]

  return (
    <section className="rsec" data-open={open ? 'true' : undefined}>
      <div className="rsec__head">
        <button type="button" className="rsec__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="rsec__chev">
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          </span>
          <span className="rsec__title eyebrow">Skills</span>
        </button>
        {rows.length ? <span className="rsec__count mono">{rows.length}</span> : null}
      </div>
      {open ? (
        /* The desktop flyout's own classes, so the rows read identically — only
         * their height is restated for a thumb, in styles.css. */
        <div className="rsec__body">
          <div className="sfly">
            {error ? <p className="sfly__hint">{error}</p> : null}
            {!list && !error ? <p className="sfly__hint">Reading skills…</p> : null}
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                className="srow"
                data-enabled="true"
                title={row.description || row.name}
                disabled={!paneId}
                onClick={() => {
                  if (!paneId) return
                  actions.write(paneId, row.types)
                }}
              >
                <span className="srow__text">
                  <span className="srow__name truncate">{row.name}</span>
                  <span className="srow__desc truncate">{row.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function MobileCommands(): ReactNode {
  const { state, actions } = useForge()
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<CommandsFeed | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const paneId = useFocusedPaneId()
  const live = state.connection.state === 'live'

  useEffect(() => {
    if (!open || !live) return
    let cancelled = false
    void actions.request({ kind: 'commands' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'commands') setFeed(result.feed)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [open, live, actions])

  // The reference runs past one screen; the filter is why the desktop's flyout
  // stays usable, so it comes along rather than being trimmed as chrome.
  const needle = query.trim().toLowerCase()
  const commands: SlashCommand[] = (feed?.commands ?? []).filter(
    (command) => !needle || command.name.toLowerCase().includes(needle) || command.summary.toLowerCase().includes(needle)
  )

  return (
    <section className="rsec" data-open={open ? 'true' : undefined}>
      <div className="rsec__head">
        <button type="button" className="rsec__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="rsec__chev">
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          </span>
          <span className="rsec__title eyebrow">Commands</span>
        </button>
        {feed?.installed ? <span className="rsec__count mono">{feed.installed}</span> : null}
      </div>
      {open ? (
        <div className="rsec__body">
          <div className="cfly">
            <div className="cfly__search">
              <span className="cfly__search-slash mono">/</span>
              <input
                className="cfly__input"
                placeholder="Filter"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="cfly__scroll">
              {error ? <p className="cfly__empty">{error}</p> : null}
              {!feed && !error ? <p className="cfly__empty">Reading the command reference…</p> : null}
              {feed && commands.length === 0 ? <p className="cfly__empty">Nothing matches that.</p> : null}
              {commands.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  className="crow"
                  title={command.detail || command.summary}
                  disabled={!paneId}
                  onClick={() => {
                    if (!paneId) return
                    // Typed, never submitted — the same contract the desktop's
                    // flyout honours, so a command lands at the prompt for a
                    // human to read and press Enter on.
                    actions.write(paneId, `/${command.name} `)
                  }}
                >
                  <span className="crow__main">
                    <span className="crow__sig mono truncate">
                      /{command.name} {command.args}
                    </span>
                    <span className="truncate">{command.summary}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

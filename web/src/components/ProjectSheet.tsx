import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import type { CommandsFeed } from '@shared/commands'
import type { SkillsList } from '@shared/skills'
import type { GitActionKind, GitFileChange, GitSnapshot, Project } from '@shared/types'
import { WEB_FEATURE_FILES, WEB_FEATURE_PROJECT_REMOVE } from '@shared/web'
import { branchLabel, changeLetter, COMMIT_MESSAGE_MAX, fileName, groupChanges, sinceLabel } from '@/lib/gitview'
import { collectLeaves } from '@/lib/splitTree'
import { Icon } from '@/components/Icon'
import { useBackClose } from '../lib/back-stack'
import { useDeskFeature } from '../lib/features'
import { openLiveFiles } from '../lib/live-files'
import { shortPath } from '../lib/paths'
import { insertIntoDraft, useForge } from '../state'
import { BottomSheet, openSheetCount, SheetRow, SheetSection } from './BottomSheet'
import { AlertGlyph } from './Connection'
import { FolderPicker, type AddedProject } from './FolderPicker'
import './Sheets.phone.css'
import './ProjectSheet.css'

/**
 * The phone's project sheet: the ☰ opens it, full height from the left edge.
 *
 * It replaces the desk's rail on a phone, which was a 300px column with a hole
 * in the middle and three tracked-caps toggles at the bottom. Top to bottom:
 *
 *   1. Projects — 56px rows: dot, name, short path, "2 panes" only when there
 *      are some, an amber "!" when a pane there is asking. The current one sits
 *      on a raised row with a ringed dot. A tap selects and closes; the "⋯" at
 *      the end of each row holds New agent here, Files and Remove from Forge.
 *      A filter appears past eight projects.
 *   2. Add a project… — a full row, the Wave B choice sheet behind it, and the
 *      new project selected with the agent chooser open when it lands.
 *   3. The current project's tools — Git at a glance (closed by default; the
 *      header alone answers "where is this branch"), Files, Skills, Commands.
 *
 * Changes, Skills and Commands open as pages inside the sheet rather than as
 * boxes that scroll inside a scroll. Back — the header's, Esc, or Android's —
 * steps out of a page before it closes the sheet.
 */

type Page = 'main' | 'changes' | 'skills' | 'commands'

const PAGE_TITLE: Record<Page, string> = {
  main: 'Projects',
  changes: 'Changes',
  skills: 'Skills',
  commands: 'Commands'
}

/** Past this many projects the list grows a filter. */
const FILTER_AFTER = 8
/** How long a just-added project is waited for in the `projects` push. */
const ADD_WAIT_MS = 15_000
/** A drag further than this to the left, or a flick, closes the sheet. */
const DRAG_CLOSE_PX = 80
const FLICK_PX_PER_MS = 0.5
/** Matches the exit transition in ProjectSheet.css. */
const EXIT_MS = 280

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Said wherever a newer desktop feature is missing. */
const RESTART = 'Restart Forge on the desktop to use this'

export function ProjectSheet({
  open,
  onClose,
  onNewAgent
}: {
  open: boolean
  onClose: () => void
  /** Select `projectId`, close this sheet and open the agent chooser — one step. */
  onNewAgent: (projectId: string) => void
}): ReactNode {
  const { state, actions } = useForge()
  const projects = state.picture?.projects ?? state.cached?.projects ?? []
  const workspaces = state.picture?.workspaces ?? state.cached?.workspaces ?? {}
  const sessions = state.picture?.sessions ?? state.cached?.sessions ?? []
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const desktop = state.picture?.desktopName || 'the desktop'
  const current = projects.find((p) => p.id === state.projectId) ?? null

  const [page, setPage] = useState<Page>('main')
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  /** Removed here, not yet gone from the `projects` push. */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())

  /* ---------------------------------------------------------- open / close */

  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const headingId = useId()

  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement
      setPage('main')
      setQuery('')
      setMounted(true)
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useLayoutEffect(() => {
    if (shown) panelRef.current?.focus({ preventScroll: true })
  }, [shown])

  // Focus goes back to the ☰ only if nothing else has taken it — the composer
  // after a skill, or the agent chooser after "New agent here", keep theirs.
  useEffect(() => {
    if (mounted) return
    const opener = openerRef.current
    openerRef.current = null
    const active = document.activeElement
    if ((!active || active === document.body) && opener instanceof HTMLElement && opener.isConnected) {
      opener.focus({ preventScroll: true })
    }
  }, [mounted])

  // A page inside the sheet is its own layer: Back leaves the page first.
  useBackClose(open, onClose)
  useBackClose(open && page !== 'main', () => setPage('main'))

  // The page's content changes under the focus; keep focus inside the sheet.
  useEffect(() => {
    if (!shown) return
    const active = document.activeElement
    if (!active || active === document.body) panelRef.current?.focus({ preventScroll: true })
  }, [page, shown])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        // A sheet over this one answers its own Esc.
        if (openSheetCount() > 0) return
        e.preventDefault()
        if (page !== 'main') setPage('main')
        else onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose, page]
  )

  /* ------------------------------------------------------ swipe left to close */

  const [drag, setDrag] = useState(0)
  const dragRef = useRef<{ id: number; x: number; y: number; t: number; dx: number; on: boolean } | null>(null)
  /** A drag just ended; the click that follows it is not a tap. */
  const swallowClick = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== 'touch') return
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, on: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.on) {
      // Only a mostly-sideways pull to the left is a close; anything else is a
      // scroll or a tap and belongs to the list.
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2 || dx > 0) {
        if (Math.abs(dy) > 10) dragRef.current = null
        return
      }
      d.on = true
      d.x = e.clientX
      d.t = performance.now()
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    d.dx = Math.min(0, e.clientX - d.x)
    setDrag(d.dx)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    if (!d.on) return
    swallowClick.current = true
    window.setTimeout(() => (swallowClick.current = false), 0)
    const speed = -d.dx / Math.max(1, performance.now() - d.t)
    if (-d.dx > DRAG_CLOSE_PX || (-d.dx > 24 && speed > FLICK_PX_PER_MS)) onClose()
    setDrag(0)
  }

  /* ------------------------------------------------------ one flow for a new project */

  const pending = useRef<{ known: Set<string>; at: number } | null>(null)

  const onAdded = (added: AddedProject): void => {
    if ('projectId' in added) {
      onNewAgent(added.projectId)
      return
    }
    // The desktop answers `ok` without naming the project; the push that
    // follows does. Whatever id appears that was not on the list is it.
    pending.current = { known: new Set(projects.map((p) => p.id)), at: Date.now() }
  }

  useEffect(() => {
    const wait = pending.current
    if (!wait) return
    if (Date.now() - wait.at > ADD_WAIT_MS) {
      pending.current = null
      return
    }
    const fresh = projects.find((p) => !wait.known.has(p.id))
    if (!fresh) return
    pending.current = null
    onNewAgent(fresh.id)
  }, [projects, onNewAgent])

  // Forget an optimistic removal once the desktop's list agrees.
  useEffect(() => {
    if (removed.size === 0) return
    const still = [...removed].filter((id) => projects.some((p) => p.id === id))
    if (still.length !== removed.size) setRemoved(new Set(still))
  }, [projects, removed])

  /* ------------------------------------------------------------ the rows */

  const paneCount = (project: Project): number => {
    const workspace = workspaces[project.id]
    if (!workspace) return 0
    const ids = new Set(workspace.tabs.flatMap((tab) => collectLeaves(tab.root).map((leaf) => leaf.id)))
    return sessions.filter((s) => ids.has(s.id)).length
  }

  const asking = (project: Project): boolean => {
    const workspace = workspaces[project.id]
    if (!workspace) return false
    return workspace.tabs.some((tab) => collectLeaves(tab.root).some((leaf) => state.asking.has(leaf.id)))
  }

  const visible = projects.filter((p) => !removed.has(p.id))
  const needle = query.trim().toLowerCase()
  const listed = needle
    ? visible.filter((p) => p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle))
    : visible

  const select = (id: string): void => {
    if (swallowClick.current) return
    actions.selectProject(id)
    onClose()
  }

  const menuProject = menuFor ? (projects.find((p) => p.id === menuFor) ?? null) : null

  return (
    <>
      {mounted ? (
        <div
          className="pjs-layer"
          data-state={shown ? 'open' : 'closed'}
          data-dragging={drag < 0 ? 'true' : undefined}
          data-testid="project-sheet"
        >
          <div className="pjs__scrim" onClick={onClose} aria-hidden="true" />
          <div
            ref={panelRef}
            className="pjs"
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            style={drag < 0 ? { transform: `translateX(${drag}px)` } : undefined}
          >
            <header className="pjs__head">
              {page !== 'main' ? (
                <button
                  type="button"
                  className="pjs__icon-btn"
                  aria-label="Back to projects"
                  onClick={() => setPage('main')}
                >
                  <Icon name="chevronLeft" size={20} />
                </button>
              ) : null}
              <h2 id={headingId} className="pjs__title">
                {PAGE_TITLE[page]}
                {page === 'main' && visible.length ? <span className="pjs__count">{visible.length}</span> : null}
              </h2>
              <button
                type="button"
                className="pjs__icon-btn"
                aria-label="Close"
                onClick={onClose}
                data-testid="project-sheet-close"
              >
                <Icon name="close" size={18} />
              </button>
            </header>

            <div className="pjs__body" key={page} data-page={page}>
              {page === 'main' ? (
                <>
                  {visible.length > FILTER_AFTER ? (
                    <label className="pjs__filter">
                      <SearchGlyph />
                      <input
                        className="pjs__filter-input"
                        type="search"
                        placeholder="Filter projects"
                        aria-label="Filter projects"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        enterKeyHint="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        data-testid="project-filter"
                      />
                    </label>
                  ) : null}

                  <div className="pjs__list" role="list" aria-label="Projects">
                    {listed.map((project) => {
                      const panes = paneCount(project)
                      const waits = asking(project)
                      const isCurrent = project.id === state.projectId
                      return (
                        <div
                          key={project.id}
                          className="pjrow"
                          role="listitem"
                          data-current={isCurrent ? 'true' : undefined}
                          data-testid="project-row"
                          data-project={project.id}
                          style={{ '--pj-color': project.color } as CSSProperties}
                        >
                          <button
                            type="button"
                            className="pjrow__main"
                            aria-current={isCurrent ? 'true' : undefined}
                            onClick={() => select(project.id)}
                          >
                            <span className="pjrow__dot" aria-hidden="true" />
                            <span className="pjrow__text">
                              <span className="pjrow__name">{project.name}</span>
                              <span className="pjrow__path">{shortPath(project.path)}</span>
                            </span>
                            {panes > 0 ? (
                              <span className="pjrow__panes">
                                {panes} {panes === 1 ? 'pane' : 'panes'}
                              </span>
                            ) : null}
                            {waits ? (
                              <span className="pjrow__ask" title="A pane here is waiting for you">
                                <span aria-hidden="true">!</span>
                                <span className="pjs__sr">, a pane here is waiting for you</span>
                              </span>
                            ) : null}
                            {isCurrent ? <span className="pjs__sr">, open now</span> : null}
                          </button>
                          <button
                            type="button"
                            className="pjrow__more"
                            aria-label={`Options for ${project.name}`}
                            onClick={() => setMenuFor(project.id)}
                            data-testid="project-more"
                          >
                            <Icon name="dots" size={18} />
                          </button>
                        </div>
                      )
                    })}
                    {needle && listed.length === 0 ? (
                      <p className="psheet__note">No project matches “{query.trim()}”.</p>
                    ) : null}
                    {visible.length === 0 ? (
                      <p className="psheet__note">
                        {live
                          ? `No projects on ${desktop} yet.`
                          : `No projects on ${desktop} yet. Adding one needs the desktop awake, because the folder is on it.`}
                      </p>
                    ) : null}
                  </div>

                  <div className="pjs__add">
                    <SheetRow
                      icon={
                        <span className="pjs__add-ring">
                          <Icon name="plus" size={16} />
                        </span>
                      }
                      label="Add a project…"
                      secondary={live ? `A folder on ${desktop}` : 'The desktop is not answering'}
                      disabled={!live}
                      onClick={() => setPicking(true)}
                      testId="add-project"
                    />
                  </div>

                  {current ? (
                    <SheetSection title={`In ${current.name}`}>
                      <ProjectGit projectId={current.id} open={open} onShowChanges={() => setPage('changes')} />
                      <FilesRow projectId={current.id} live={live} />
                      <SheetRow
                        icon={<Icon name="sparkle" size={20} />}
                        label="Skills"
                        secondary="Put a skill in the text box"
                        trailing={<Icon name="chevronRight" size={16} />}
                        onClick={() => setPage('skills')}
                        testId="open-skills"
                      />
                      <SheetRow
                        icon={<Icon name="terminal" size={20} />}
                        label="Commands"
                        secondary="Put a slash command in the text box"
                        trailing={<Icon name="chevronRight" size={16} />}
                        onClick={() => setPage('commands')}
                        testId="open-commands"
                      />
                    </SheetSection>
                  ) : null}
                </>
              ) : null}

              {page === 'changes' && current ? <ChangesPage projectId={current.id} /> : null}
              {page === 'skills' ? <SkillsPage live={live} onPlaced={onClose} /> : null}
              {page === 'commands' ? <CommandsPage live={live} onPlaced={onClose} /> : null}
            </div>
          </div>
        </div>
      ) : null}

      <ProjectMenu
        project={menuProject}
        live={live}
        onClose={() => setMenuFor(null)}
        onNewAgent={(id) => {
          setMenuFor(null)
          onNewAgent(id)
        }}
        onRemoved={(id) => {
          setRemoved((all) => new Set([...all, id]))
          setMenuFor(null)
        }}
      />

      <FolderPicker anchor={null} open={picking} onClose={() => setPicking(false)} onAdded={onAdded} />
    </>
  )
}

/* ------------------------------------------------------------ the ⋯ sheet */

function ProjectMenu({
  project,
  live,
  onClose,
  onNewAgent,
  onRemoved
}: {
  project: Project | null
  live: boolean
  onClose: () => void
  onNewAgent: (projectId: string) => void
  onRemoved: (projectId: string) => void
}): ReactNode {
  const { actions } = useForge()
  const canRemove = useDeskFeature(WEB_FEATURE_PROJECT_REMOVE)
  const canFiles = useDeskFeature(WEB_FEATURE_FILES)
  const [step, setStep] = useState<'list' | 'confirm'>('list')
  const [preview, setPreview] = useState<{ name: string; panes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** The last project shown, so the sheet keeps its words while it slides away. */
  const [shownProject, setShownProject] = useState<Project | null>(project)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!project) return
    setShownProject(project)
    setStep('list')
    setPreview(null)
    setError('')
    setBusy(false)
    busyRef.current = false
  }, [project])

  const p = project ?? shownProject
  if (!p) return null

  const askRemove = (): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void actions.request({ kind: 'project-remove-preview', projectId: p.id }).then((result) => {
      busyRef.current = false
      setBusy(false)
      if (result.kind === 'project-remove-preview') {
        setPreview({ name: result.name, panes: result.panes })
        setStep('confirm')
        return
      }
      setError(result.kind === 'failed' ? result.message : 'That could not be checked.')
    })
  }

  const remove = (): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void actions.request({ kind: 'project-remove', projectId: p.id }).then((result) => {
      busyRef.current = false
      setBusy(false)
      if (result.kind === 'ok') {
        actions.setNotice(`Removed ${preview?.name ?? p.name} from Forge. The folder is still on the desktop.`)
        onRemoved(p.id)
        return
      }
      setError(result.kind === 'failed' ? result.message : 'That project could not be removed.')
    })
  }

  const name = preview?.name ?? p.name
  const panes = preview?.panes ?? 0
  const alert = error ? (
    <p className="psheet__error" role="alert">
      <AlertGlyph />
      <span>{error}</span>
    </p>
  ) : null

  return (
    <BottomSheet
      open={project !== null}
      onClose={onClose}
      onBack={step === 'confirm' ? () => setStep('list') : undefined}
      label={step === 'confirm' ? `Remove ${name} from Forge` : name}
      title={step === 'confirm' ? null : undefined}
      subtitle={step === 'confirm' ? undefined : <span className="mono">{shortPath(p.path)}</span>}
      testId="project-menu"
    >
      {step === 'confirm' ? (
        <div className="bsconfirm" data-testid="remove-confirm">
          <p className="bsconfirm__q">Remove “{name}” from Forge?</p>
          <p className="bsconfirm__detail">
            The folder stays on your PC. You can add it back any time.
            {panes > 0 ? (
              <span className="pjs__consequence" data-testid="remove-panes">
                Its {panes === 1 ? 'open pane' : `${panes} open panes`} will close.
              </span>
            ) : null}
          </p>
          {alert}
          <div className="bsconfirm__actions pjs__confirm-actions">
            <button
              type="button"
              className="bsbtn"
              data-tone="danger"
              disabled={busy}
              onClick={remove}
              data-testid="remove-go"
            >
              {busy ? 'Removing…' : 'Remove from Forge'}
            </button>
            <button type="button" className="bsbtn" autoFocus disabled={busy} onClick={() => setStep('list')}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <SheetSection>
            <SheetRow
              icon={<Icon name="plus" size={20} />}
              label="New agent here"
              secondary={live ? 'Choose an agent or a shell to start in this folder' : 'The desktop is not answering'}
              disabled={!live}
              onClick={() => onNewAgent(p.id)}
              testId="menu-new-agent"
            />
            <SheetRow
              icon={<Icon name="folder" size={20} />}
              label="Files"
              secondary={canFiles ? 'Read the files in this folder' : RESTART}
              disabled={!live || !canFiles}
              onClick={() => {
                onClose()
                openLiveFiles(p.id)
              }}
              testId="menu-files"
            />
          </SheetSection>
          <SheetSection>
            <SheetRow
              icon={<Icon name="trash" size={20} />}
              label="Remove from Forge…"
              secondary={
                !canRemove
                  ? RESTART
                  : busy
                    ? 'Checking what is open…'
                    : 'Takes it off this list. The folder stays on your PC.'
              }
              tone={canRemove && live ? 'danger' : undefined}
              disabled={!canRemove || !live || busy}
              onClick={askRemove}
              testId="menu-remove"
            />
          </SheetSection>
          {alert}
        </>
      )}
    </BottomSheet>
  )
}

function FilesRow({ projectId, live }: { projectId: string; live: boolean }): ReactNode {
  const ready = useDeskFeature(WEB_FEATURE_FILES)
  return (
    <SheetRow
      icon={<Icon name="folder" size={20} />}
      label="Files"
      secondary={ready ? 'Read the files in this project' : RESTART}
      trailing={ready ? <Icon name="chevronRight" size={16} /> : undefined}
      disabled={!live || !ready}
      onClick={() => openLiveFiles(projectId)}
      testId="open-files"
    />
  )
}

/* ------------------------------------------------------------------ git */

/*
 * A `git-status` or `git-action` is answered with the snapshot itself, and a
 * desktop only *pushes* one when its watcher sees the folder change. The rail
 * lived long enough to catch that push; a sheet opened for a moment does not,
 * so the answers are kept here too and the newer of the two is drawn.
 */
const answeredGit = new Map<string, GitSnapshot>()
const gitListeners = new Set<() => void>()

function rememberGit(snapshot: GitSnapshot): void {
  answeredGit.set(snapshot.projectId, snapshot)
  for (const listener of gitListeners) listener()
}

function subscribeGit(listener: () => void): () => void {
  gitListeners.add(listener)
  return () => {
    gitListeners.delete(listener)
  }
}

function useGitSnapshot(projectId: string): GitSnapshot | null {
  const { state } = useForge()
  const answered = useSyncExternalStore(subscribeGit, () => answeredGit.get(projectId) ?? null)
  const pushed = state.git[projectId] ?? null
  if (!pushed || !answered) return pushed ?? answered
  return answered.seq > pushed.seq ? answered : pushed
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "↑2 ↓1", "Up to date", "Not on origin yet" — where the branch stands, in numbers or words. */
function upstreamWords(snap: GitSnapshot): string {
  switch (snap.state) {
    case 'ahead':
      return `↑${snap.ahead}`
    case 'behind':
      return `↓${snap.behind}`
    case 'diverged':
      return `↑${snap.ahead} ↓${snap.behind}`
    case 'synced':
      return 'Up to date'
    case 'unpublished':
      return 'Not on origin yet'
    case 'gone':
      return 'Upstream deleted'
    default:
      return ''
  }
}

/** One line under the branch: upstream, then what has changed. */
function gitLine(snap: GitSnapshot): string {
  if (snap.presence === 'no-repo') return 'Not a git repository'
  if (snap.presence === 'no-git') return 'Git is not installed on the desktop'
  if (snap.presence === 'no-folder') return 'The folder is missing on the desktop'
  if (snap.presence === 'error') return snap.error || 'Git could not be read'
  const parts = [upstreamWords(snap), snap.changed ? `${snap.changed} changed` : 'No changes']
  if (snap.conflicted) parts.push(plural(snap.conflicted, 'conflict'))
  return parts.filter(Boolean).join(' · ')
}

function ProjectGit({
  projectId,
  open,
  onShowChanges
}: {
  projectId: string
  open: boolean
  onShowChanges: () => void
}): ReactNode {
  const { state, actions } = useForge()
  const [expanded, setExpanded] = useState(false)
  const [running, setRunning] = useState<GitActionKind | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const snap = useGitSnapshot(projectId)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'

  // The opening read, per project, while the sheet is up. Pushes on `git` keep
  // it current after that.
  useEffect(() => {
    if (!open || !live) return
    let cancelled = false
    void actions.request({ kind: 'git-status', projectId }).then((result) => {
      if (result.kind === 'git') rememberGit(result.snapshot)
      if (cancelled) return
      const unsupported = result.kind === 'failed' && result.code === 'unsupported'
      setNote(unsupported ? result.message : '')
      setError(result.kind === 'failed' && !unsupported ? result.message : '')
    })
    return () => {
      cancelled = true
    }
  }, [projectId, open, live, actions])

  const run = (action: GitActionKind): void => {
    if (running) return
    setRunning(action)
    setError('')
    void actions
      .request({ kind: 'git-action', projectId, action })
      .then((result) => {
        if (result.kind === 'git') rememberGit(result.snapshot)
        if (result.kind === 'failed') setError(result.message)
      })
      .finally(() => setRunning(null))
  }

  const ok = snap?.presence === 'ok'
  const noRemote = !snap?.remoteUrl
  const stuck = Boolean(snap?.detached || snap?.unborn)
  const can = {
    fetch: live && ok && !running && !noRemote,
    pull: live && ok && !running && !noRemote && !stuck && snap?.state !== 'unpublished',
    push: live && ok && !running && !noRemote && !stuck
  }
  const doing: Record<'fetch' | 'pull' | 'push', [string, string]> = {
    fetch: ['Fetch', 'Fetching…'],
    pull: ['Pull', 'Pulling…'],
    push: ['Push', 'Pushing…']
  }

  const branch = snap ? branchLabel(snap) || 'Git' : 'Git'
  const line = snap ? gitLine(snap) : note || (live ? 'Reading git…' : 'The desktop is not answering')
  const hint =
    !snap || !ok
      ? ''
      : noRemote
        ? 'This repository has no origin yet'
        : snap.unborn
          ? 'There are no commits here yet'
          : snap.detached
            ? 'HEAD is detached. Switch to a branch first'
            : snap.fetchedAt
              ? `Fetched ${sinceLabel(snap.fetchedAt)}`
              : 'Never fetched'

  return (
    <div className="pjgit" data-open={expanded ? 'true' : undefined} data-testid="project-git">
      <button
        type="button"
        className="bsrow pjgit__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid="git-toggle"
      >
        <span className="bsrow__icon">
          <Icon name="branch" size={20} />
        </span>
        <span className="bsrow__text">
          <span className="bsrow__label pjgit__branch">{branch}</span>
          <span className="bsrow__sub" data-testid="git-line">
            {line}
            {snap?.conflicted ? <span className="pjs__sr">. Conflicts need resolving</span> : null}
          </span>
        </span>
        <span className="bsrow__trail pjgit__chev" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>

      {expanded ? (
        <div className="pjgit__body">
          {ok ? (
            <>
              <div className="pjgit__sync">
                <div className="pjseg" role="group" aria-label="Sync with origin">
                  {(['fetch', 'pull', 'push'] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="pjseg__btn"
                      disabled={!can[action]}
                      aria-busy={running === action ? 'true' : undefined}
                      onClick={() => run(action)}
                      data-testid={`git-${action}`}
                    >
                      {doing[action][running === action ? 1 : 0]}
                    </button>
                  ))}
                </div>
                {hint ? <p className="pjgit__hint">{hint}</p> : null}
              </div>
              {snap && snap.changed > 0 ? (
                <SheetRow
                  icon={<Icon name="file" size={20} />}
                  label={plural(snap.changed, 'changed file')}
                  secondary={
                    snap.conflicted
                      ? `${plural(snap.conflicted, 'conflict')} · commit from here`
                      : 'See them, and commit from here'
                  }
                  trailing={<Icon name="chevronRight" size={16} />}
                  onClick={onShowChanges}
                  testId="git-changes"
                />
              ) : null}
            </>
          ) : null}
          {error ? (
            <p className="psheet__error" role="alert">
              <AlertGlyph />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** What a change letter means, in a word — the letter's shape plus this, never its colour. */
const CHANGE_WORD: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'New file'
}

/** `changeLetter`, with a space read as "no change in this column" (unstaged ` M` had no letter). */
function letterFor(file: GitFileChange): string {
  return changeLetter(file.xy.replace(/ /g, '.'))
}

function ChangesPage({ projectId }: { projectId: string }): ReactNode {
  const { state, actions } = useForge()
  const snap = useGitSnapshot(projectId)
  const canFiles = useDeskFeature(WEB_FEATURE_FILES)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  if (!snap || snap.presence !== 'ok') {
    return <p className="psheet__note">{snap ? gitLine(snap) : 'Reading git…'}</p>
  }

  const conflicted = snap.conflicted > 0
  const canCommit = live && !running && !conflicted && snap.changed > 0 && message.trim().length > 0

  const commit = (): void => {
    if (!canCommit) return
    setRunning(true)
    setError('')
    void actions
      .request({ kind: 'git-action', projectId, action: 'commit', message: message.trim() })
      .then((result) => {
        if (result.kind === 'git') rememberGit(result.snapshot)
        if (result.kind === 'failed') setError(result.message)
        else setMessage('')
      })
      .finally(() => setRunning(false))
  }

  return (
    <>
      <p className="pjs__lede">
        <span className="mono">{branchLabel(snap)}</span> · {gitLine(snap)}
      </p>
      {groupChanges(snap.files).map((group) => (
        <div className="pjchg__group" key={group.dir || '.'}>
          <div className="pjchg__dir">{group.dir || 'Top folder'}</div>
          {group.files.map((file) => {
            const letter = letterFor(file)
            const word = CHANGE_WORD[letter] ?? 'Changed'
            const detail = [
              word,
              file.staged && !file.unstaged ? 'staged' : '',
              file.from ? `from ${fileName(file.from)}` : ''
            ]
              .filter(Boolean)
              .join(' · ')
            const inner = (
              <>
                <span className="pjchg__letter" data-letter={letter} aria-hidden="true">
                  {letter}
                </span>
                <span className="bsrow__text">
                  <span className="bsrow__label pjchg__name">{fileName(file.path)}</span>
                  <span className="bsrow__sub">{detail}</span>
                </span>
                {canFiles ? (
                  <span className="bsrow__trail" aria-hidden="true">
                    <Icon name="chevronRight" size={16} />
                  </span>
                ) : null}
              </>
            )
            return canFiles ? (
              <button
                key={file.path}
                type="button"
                className="bsrow pjchg"
                onClick={() => openLiveFiles(projectId, file.path, { git: true })}
                data-testid="change-row"
              >
                {inner}
              </button>
            ) : (
              <div key={file.path} className="bsrow pjchg" data-static="true" data-testid="change-row">
                {inner}
              </div>
            )
          })}
        </div>
      ))}
      {snap.filesTruncated ? (
        <p className="psheet__note">Git listed more files than fit here; the counts above are still true.</p>
      ) : null}

      <form
        className="pjcommit"
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
      >
        <label className="pfield__label" htmlFor="pjcommit-msg">
          Commit everything
        </label>
        <input
          id="pjcommit-msg"
          className="pfield__input"
          placeholder={conflicted ? 'Resolve the conflicts first' : 'What changed'}
          maxLength={COMMIT_MESSAGE_MAX}
          value={message}
          disabled={conflicted || !live || running}
          enterKeyHint="done"
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="submit" className="bsbtn" data-wide="true" disabled={!canCommit}>
          {running ? 'Committing…' : 'Stage all and commit'}
        </button>
        {error ? (
          <p className="psheet__error" role="alert">
            <AlertGlyph />
            <span>{error}</span>
          </p>
        ) : null}
      </form>
    </>
  )
}

/* ------------------------------------------------------ skills and commands */

/** Put `text` in the focused pane's draft and close the sheet, or say why not. */
function usePlace(onPlaced: () => void): (text: string) => void {
  const { actions } = useForge()
  return (text: string) => {
    const typed = text.endsWith(' ') ? text : `${text} `
    if (insertIntoDraft(typed)) onPlaced()
    else actions.setNotice('Open a pane first, then pick it again.')
  }
}

function PageFilter({
  value,
  onChange,
  label
}: {
  value: string
  onChange: (v: string) => void
  label: string
}): ReactNode {
  return (
    <label className="pjs__filter">
      <SearchGlyph />
      <input
        className="pjs__filter-input"
        type="search"
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function SkillsPage({ live, onPlaced }: { live: boolean; onPlaced: () => void }): ReactNode {
  const { actions } = useForge()
  const place = usePlace(onPlaced)
  const [list, setList] = useState<SkillsList | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!live) return
    let cancelled = false
    void actions.request({ kind: 'skills' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'skills') setList(result.skills)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [live, actions])

  const rows = [
    ...(list?.skills ?? [])
      .filter((s) => s.enabled)
      .map((s) => ({ key: s.name, name: s.name, description: s.description, types: `/${s.name}` })),
    ...(list?.machineSkills ?? []).map((s) => ({
      key: `m:${s.name}`,
      name: s.name,
      description: s.description,
      types: `/${s.name}`
    })),
    ...(list?.externalSkills ?? []).map((s) => ({
      key: s.id,
      name: s.title || s.name,
      description: s.description,
      types: s.command
    }))
  ]
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle))
    : rows

  return (
    <>
      {rows.length > FILTER_AFTER ? <PageFilter value={query} onChange={setQuery} label="Filter skills" /> : null}
      {!live ? <p className="psheet__note">The desktop is not answering, so its skills cannot be read.</p> : null}
      {error ? <p className="psheet__note">{error}</p> : null}
      {live && !list && !error ? (
        <div className="psheet__busy">
          Reading skills…
          <span className="pbar" data-on="true" aria-hidden="true" />
        </div>
      ) : null}
      {list && rows.length === 0 ? <p className="psheet__note">No skills are switched on at the desk.</p> : null}
      {list && rows.length > 0 && shown.length === 0 ? <p className="psheet__note">Nothing matches that.</p> : null}
      {shown.map((row) => (
        <SheetRow
          key={row.key}
          label={<SlashName text={row.types.trim()} />}
          secondary={row.description ? <span className="pjs__clamp">{row.description}</span> : undefined}
          onClick={() => place(row.types)}
          testId="skill-row"
        />
      ))}
    </>
  )
}

function CommandsPage({ live, onPlaced }: { live: boolean; onPlaced: () => void }): ReactNode {
  const { actions } = useForge()
  const place = usePlace(onPlaced)
  const [feed, setFeed] = useState<CommandsFeed | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!live) return
    let cancelled = false
    void actions.request({ kind: 'commands' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'commands') setFeed(result.feed)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [live, actions])

  const needle = query.trim().toLowerCase().replace(/^\//, '')
  const commands = (feed?.commands ?? []).filter(
    (c) => !needle || c.name.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle)
  )

  return (
    <>
      <PageFilter value={query} onChange={setQuery} label="Filter commands" />
      {!live ? <p className="psheet__note">The desktop is not answering, so its commands cannot be read.</p> : null}
      {error ? <p className="psheet__note">{error}</p> : null}
      {live && !feed && !error ? (
        <div className="psheet__busy">
          Reading the command list…
          <span className="pbar" data-on="true" aria-hidden="true" />
        </div>
      ) : null}
      {feed && commands.length === 0 ? <p className="psheet__note">Nothing matches that.</p> : null}
      {commands.map((command) => (
        <SheetRow
          key={command.name}
          label={<SlashName text={`/${command.name}`} args={command.args} />}
          secondary={command.summary ? <span className="pjs__clamp">{command.summary}</span> : undefined}
          onClick={() => place(`/${command.name}`)}
          testId="command-row"
        />
      ))}
    </>
  )
}

/** "/name" with the slash dimmed, so the name reads first; arguments in code type after it. */
function SlashName({ text, args }: { text: string; args?: string }): ReactNode {
  const slash = text.startsWith('/')
  return (
    <span className="pjs__slash">
      {slash ? <span className="pjs__slash-mark">/</span> : null}
      {slash ? text.slice(1) : text}
      {args ? <span className="pjs__args">{args}</span> : null}
    </span>
  )
}

/** A magnifier on the icon grid (16×16, stroke 1.4) — the set has none. */
function SearchGlyph(): ReactNode {
  return (
    <svg
      className="pjs__filter-icon"
      width={18}
      height={18}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 13.6 13.6" />
    </svg>
  )
}

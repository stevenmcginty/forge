import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WebFolder } from '@shared/web'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import { shortPath } from '../lib/paths'
import { useForge } from '../state'

/**
 * "Add project", for somebody who is not at the desk.
 *
 * One popover, two roads — the same two the desk has, side by side instead of
 * behind two buttons. It opens on the choice ("create a new folder" / "use an
 * existing folder"), because the person on a phone three hundred miles away is
 * as likely to be starting something as resuming something:
 *
 *   **New folder** is the desk's AddProjectMenu form: a name, and a parent
 *   chosen from the same closed allow-list (Desktop, Documents, the Settings
 *   projects root). It travels as `project-create` — a *name and a key*, never
 *   a path — and the fence in electron/projectfolder.ts is what turns it into
 *   a folder, exactly as it does for the desk's form and the voice agent. An
 *   existing folder is refused with its path attached, so "Open it instead" is
 *   an explicit act here just as it is at the desk.
 *
 *   **Existing folder** is the browser-side picker below. The desktop's own
 *   button opens `dialog.showOpenDialog` — a native folder picker, on a screen
 *   nobody far away is looking at — so this browses the desktop's folders in
 *   the page instead: one `fs-list` request per screen, and a `project-add` at
 *   the end of it. Both are settled decisions rather than conveniences; the
 *   reckoning about a browser naming paths at all is on `WebRequest` in
 *   shared/web.ts.
 *
 * **Nothing in here composes a path.** Every string this sends back is one the
 * desktop handed over — a `crumbs` entry, `folder.path`, an entry `name` for
 * the desktop to append itself, or a `parentDir` key — because a browser has no
 * idea whether the machine it is looking at spells a path with `\` or `/`,
 * where a drive root ends, or what its separator does at one. The breadcrumb is
 * drawn from `crumbs` for exactly that reason: slicing `folder.path` on `sep`
 * would be the same string surgery in a costume, and it gets the root wrong on
 * both platforms in different ways.
 *
 * *Shortening* one for a line of text is a different act and stays allowed —
 * `shortPath` is what the rail already draws a project with, and the worst a
 * wrong guess there can do is put an ellipsis in the wrong place. The rule is
 * about what is sent back, not about what is drawn.
 */

/** The `parentDir` keys the desktop's allow-list understands. */
type ParentKey = 'desktop' | 'documents' | 'projectsroot'

/** Which screen of the popover is up. */
type View = 'choose' | 'create' | 'browse'

export function FolderPicker({
  anchor,
  open,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}): ReactNode {
  const { state, actions } = useForge()
  const [view, setView] = useState<View>('choose')
  const [folder, setFolder] = useState<WebFolder | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const projects = state.picture?.projects ?? []

  /* ------------------------------------------------------------ new folder */

  const nameRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState<ParentKey>('desktop')
  /** `project-exists` came back: the sentence, and the path to open instead. */
  const [existing, setExisting] = useState('')
  const projectsRoot = state.picture?.projectsRoot ?? ''

  /**
   * Which navigation is the current one.
   *
   * A folder on a spinning disk, or one behind a tunnel with a phone's latency
   * on it, can answer after the folder somebody clicked next — and a picker
   * that painted whichever reply landed last would put the wrong screen under
   * their finger. Every answer checks it is still the one being waited for.
   */
  const trip = useRef(0)

  const go = useCallback(
    (path: string, name?: string): void => {
      const mine = ++trip.current
      setBusy(true)
      setError('')
      void actions.request({ kind: 'fs-list', path, ...(name ? { name } : {}) }).then((result) => {
        if (mine !== trip.current) return
        setBusy(false)
        if (result.kind === 'folder') {
          setFolder(result.folder)
          return
        }
        // A refusal is an ordinary event here — a folder that has been renamed,
        // one Windows will not open — so it is a line under the list and the
        // screen somebody was on stays where it is, rather than a dead end.
        setError(result.kind === 'failed' ? result.message : 'That folder could not be read.')
      })
    },
    [actions]
  )

  // A fresh popover every time it opens: the choice screen, a blank name, the
  // default location, no stale error. The form's default parent is the same one
  // the desk's form picks — the nominated projects root when there is one.
  useEffect(() => {
    if (!open) return
    setView('choose')
    setFolder(null)
    setError('')
    setExisting('')
    setName('')
    setParentDir(projectsRoot ? 'projectsroot' : 'desktop')
    // Deliberately only on open: a `projectsRoot` change mid-form is a settings
    // edit at the desk, and yanking the selection out from under the person
    // typing would be worse than defaulting once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /**
   * Where the browse view opens.
   *
   * Inside the project this browser is looking at, when there is one: its
   * folder's siblings are overwhelmingly where the next project is, and it
   * saves four clicks down from `C:\`. The path comes from `Project.path`,
   * which the desktop sent in `hello-ok` — still not a string this page built.
   * With no project at all there is nothing to be near, so it opens at the
   * drive roots, which is what '' means.
   */
  const browse = (): void => {
    setView('browse')
    setError('')
    // Emptied first, so a picker reopened after a walk somewhere else starts
    // where it says it starts. Left as it was, the previous folder would be on
    // screen — with "Use this folder" pointing at it — for as long as the first
    // request took, which is the one moment somebody is most likely to click.
    setFolder(null)
    const near = projects.find((p) => p.id === state.projectId) ?? projects[0]
    go(near?.path ?? '')
  }

  const compose = (): void => {
    setView('create')
    setError('')
    setExisting('')
    // After the view has painted, or there is nothing to focus yet.
    setTimeout(() => nameRef.current?.select(), 0)
  }

  /**
   * Put a folder the desktop already named on the rail — the shared tail of
   * both roads: "Use this folder" in the browse view, and "Open it instead"
   * when a new name turned out to already exist.
   *
   * The rail's own answer first, and it is not a shortcut: the desktop would
   * take this perfectly well and land on the project it already has (that is
   * what `addProjectPath` does with a folder it recognises), but the browser
   * would then say "added" about a rail that did not change. Comparing the
   * paths the desktop itself sent is enough to say the true thing instead.
   */
  const addPath = (path: string): void => {
    if (!path || busy) return
    const already = projects.find((p) => p.path.toLowerCase() === path.toLowerCase())
    if (already) {
      actions.selectProject(already.id)
      actions.setNotice(`${already.name} is already in the rail.`)
      onClose()
      return
    }
    setBusy(true)
    setError('')
    void actions.request({ kind: 'project-add', path }).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        // Nothing is added to any list here. The desktop performs it, and the
        // `projects` push that follows is what redraws this page — decision 5,
        // the same as every layout gesture.
        // `shortPath`, the same helper the rail names a project with, because a
        // full Windows path is three wrapped lines of toast on a phone and the
        // last two segments are the part anybody reads.
        actions.setNotice(`Added ${shortPath(path)} on the desktop.`)
        onClose()
        return
      }
      setError(result.kind === 'failed' ? result.message : 'That folder could not be added.')
    })
  }

  /** The "New folder" form's submit: one `project-create`, three answers. */
  const create = (): void => {
    const leaf = name.trim()
    if (!leaf || busy) return
    setBusy(true)
    setError('')
    setExisting('')
    void actions.request({ kind: 'project-create', name: leaf, parentDir }).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        // Created *and* on the rail — the desktop does both as one act, and the
        // `projects` push is what redraws this page.
        actions.setNotice(`Created ${leaf} on the desktop.`)
        onClose()
        return
      }
      if (result.kind === 'project-exists') {
        setError(result.message)
        setExisting(result.path)
        return
      }
      setError(result.kind === 'failed' ? result.message : 'That folder could not be created.')
    })
  }

  /**
   * Keep the end of the breadcrumb on screen.
   *
   * The line scrolls sideways rather than wrapping, and a deep path overflows
   * it after four or five steps — so left alone it shows the drive letter and
   * hides the folder somebody is actually standing in, which is the one step
   * that answers "where am I". Scrolled to the end, it reads like a path: the
   * near steps in view, the far ones a swipe away.
   */
  const crumbBar = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const bar = crumbBar.current
    if (bar) bar.scrollLeft = bar.scrollWidth
  }, [folder])

  const rows = folder?.entries ?? []

  /** The ‹ back to the choice screen, drawn the same on both inner views. */
  const back = (title: string): ReactNode => (
    <div className="picker__top">
      <button type="button" className="ghost-btn picker__back" onClick={() => setView('choose')} disabled={busy}>
        <Icon name="chevronLeft" size={12} />
        Back
      </button>
      <span className="eyebrow">{title}</span>
    </div>
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={340} label="Add project">
      <div className="picker" data-testid="folder-picker">
        {view === 'choose' ? (
          <div className="picker__choices">
            <button type="button" className="picker__choice" data-testid="add-project-new" onClick={compose}>
              <Icon name="plus" size={14} />
              <span className="picker__choice-text">
                <span className="picker__choice-name">Create a new folder</span>
                <span className="picker__choice-hint">An empty folder, added straight to the rail.</span>
              </span>
            </button>
            <button type="button" className="picker__choice" data-testid="add-project-existing" onClick={browse}>
              <Icon name="folder" size={14} />
              <span className="picker__choice-text">
                <span className="picker__choice-name">Use an existing folder</span>
                <span className="picker__choice-hint">Browse the folders on that desktop.</span>
              </span>
            </button>
          </div>
        ) : null}

        {view === 'create' ? (
          <>
            {back('New project')}
            <div className="field">
              <label className="field__label" htmlFor="picker-name">
                Name
              </label>
              <input
                id="picker-name"
                ref={nameRef}
                className="field__input"
                value={name}
                spellCheck={false}
                disabled={busy}
                placeholder="my-project"
                onChange={(e) => {
                  setName(e.target.value)
                  if (error) setError('')
                  if (existing) setExisting('')
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') create()
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="picker-parent">
                Create in
              </label>
              <select
                id="picker-parent"
                className="field__input"
                value={parentDir}
                disabled={busy}
                onChange={(e) => setParentDir(e.target.value as ParentKey)}
              >
                {/* The same list, in the same order, as the desk's own form. */}
                {projectsRoot ? (
                  <option value="projectsroot" title={projectsRoot}>
                    Projects — {shortPath(projectsRoot, 2)}
                  </option>
                ) : null}
                <option value="desktop">Desktop</option>
                <option value="documents">Documents</option>
              </select>
            </div>
            {error ? (
              <p className="picker__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="popover__actions">
              {existing ? (
                <button type="button" className="ghost-btn" disabled={busy} onClick={() => addPath(existing)}>
                  Open it instead
                </button>
              ) : null}
              <button
                type="button"
                className="cta-btn"
                data-testid="create-project"
                disabled={!name.trim() || busy}
                onClick={create}
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </>
        ) : null}

        {view === 'browse' ? (
          <>
            {back('Existing folder')}
            <nav className="picker__crumbs" aria-label="Folders above this one" ref={crumbBar}>
              <button type="button" className="picker__crumb" onClick={() => go('')} disabled={busy}>
                This desktop
              </button>
              {(folder?.crumbs ?? []).map((crumb) => (
                <span className="picker__crumb-step" key={crumb.path}>
                  <Icon name="chevronRight" size={10} />
                  <button type="button" className="picker__crumb" onClick={() => go(crumb.path)} disabled={busy}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>

            <div className="picker__list" data-testid="folder-picker-list">
              {rows.map((entry) =>
                entry.dir ? (
                  <button
                    type="button"
                    className="picker__row"
                    key={entry.name}
                    disabled={busy}
                    onClick={() => go(folder?.path ?? '', entry.name)}
                  >
                    <Icon name="folder" size={13} />
                    <span className="picker__name truncate">{entry.name}</span>
                    {/*
                      The one adornment on a row, and it is the one that makes forty
                      folders readable: a `.git` in it means this is very probably
                      the thing being looked for rather than somewhere on the way to
                      it.
                    */}
                    {entry.repo ? <span className="picker__repo eyebrow">repo</span> : null}
                  </button>
                ) : (
                  /*
                    Files are drawn and cannot be clicked. Leaving them out entirely
                    would make a folder full of source look empty, which is exactly
                    the moment somebody needs to recognise where they are — and a
                    file is not something this picker can do anything with.
                  */
                  <div className="picker__row" data-file="true" key={entry.name}>
                    <Icon name="file" size={13} />
                    <span className="picker__name truncate">{entry.name}</span>
                  </div>
                )
              )}
              {!busy && folder && rows.length === 0 ? <p className="picker__note">This folder is empty.</p> : null}
              {busy && !folder ? <p className="picker__note">Reading the desktop…</p> : null}
              {folder?.truncated ? (
                <p className="picker__note">
                  This folder holds more than one answer can carry — these are the first {rows.length}, folders first.
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="picker__error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="picker__foot">
              <span className="picker__here mono truncate" title={folder?.path || 'The drives on that desktop'}>
                {folder?.path || 'The drives on that desktop'}
              </span>
              <button
                type="button"
                className="cta-btn picker__use"
                disabled={!folder?.path || busy}
                onClick={() => addPath(folder?.path ?? '')}
              >
                <Icon name="plus" size={13} />
                Use this folder
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Popover>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WebFolder } from '@shared/web'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import { shortPath } from '../lib/paths'
import { useForge } from '../state'

/**
 * "Add project", for somebody who is not at the desk.
 *
 * The desktop's button opens `dialog.showOpenDialog` — a native folder picker,
 * on a screen nobody three hundred miles away is looking at — so this browses
 * the desktop's folders in the page instead: one `fs-list` request per screen,
 * and a `project-add` at the end of it. Both are settled decisions rather than
 * conveniences; the reckoning about a browser naming paths at all is on
 * `WebRequest` in shared/web.ts.
 *
 * **Nothing in here composes a path.** Every string this sends back is one the
 * desktop handed over — a `crumbs` entry, `folder.path`, or an entry `name` for
 * the desktop to append itself — because a browser has no idea whether the
 * machine it is looking at spells a path with `\` or `/`, where a drive root
 * ends, or what its separator does at one. The breadcrumb is drawn from
 * `crumbs` for exactly that reason: slicing `folder.path` on `sep` would be the
 * same string surgery in a costume, and it gets the root wrong on both
 * platforms in different ways.
 *
 * *Shortening* one for a line of text is a different act and stays allowed —
 * `shortPath` is what the rail already draws a project with, and the worst a
 * wrong guess there can do is put an ellipsis in the wrong place. The rule is
 * about what is sent back, not about what is drawn.
 */
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
  const [folder, setFolder] = useState<WebFolder | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const projects = state.picture?.projects ?? []

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

  /**
   * Where the picker opens.
   *
   * Inside the project this browser is looking at, when there is one: its
   * folder's siblings are overwhelmingly where the next project is, and it
   * saves four clicks down from `C:\`. The path comes from `Project.path`,
   * which the desktop sent in `hello-ok` — still not a string this page built.
   * With no project at all there is nothing to be near, so it opens at the
   * drive roots, which is what '' means.
   */
  useEffect(() => {
    if (!open) return
    // Emptied first, so a picker reopened after a walk somewhere else starts
    // where it says it starts. Left as it was, the previous folder would be on
    // screen — with "Use this folder" pointing at it — for as long as the first
    // request took, which is the one moment somebody is most likely to click.
    setFolder(null)
    setError('')
    const near = projects.find((p) => p.id === state.projectId) ?? projects[0]
    go(near?.path ?? '')
    // Deliberately only on open: re-running this because a `projects` push
    // arrived would drag somebody back to the start of the walk they are
    // halfway through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const add = (): void => {
    if (!folder?.path || busy) return
    /*
     * The rail's own answer first, and it is not a shortcut: the desktop would
     * take this perfectly well and land on the project it already has (that is
     * what `addProjectPath` does with a folder it recognises), but the browser
     * would then say "added" about a rail that did not change. Comparing the
     * paths the desktop itself sent is enough to say the true thing instead.
     */
    const existing = projects.find((p) => p.path.toLowerCase() === folder.path.toLowerCase())
    if (existing) {
      actions.selectProject(existing.id)
      actions.setNotice(`${existing.name} is already in the rail.`)
      onClose()
      return
    }
    setBusy(true)
    setError('')
    void actions.request({ kind: 'project-add', path: folder.path }).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        // Nothing is added to any list here. The desktop performs it, and the
        // `projects` push that follows is what redraws this page — decision 5,
        // the same as every layout gesture.
        // `shortPath`, the same helper the rail names a project with, because a
        // full Windows path is three wrapped lines of toast on a phone and the
        // last two segments are the part anybody reads.
        actions.setNotice(`Added ${shortPath(folder.path)} on the desktop.`)
        onClose()
        return
      }
      setError(result.kind === 'failed' ? result.message : 'That folder could not be added.')
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

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="start" width={340} label="Add project">
      <div className="picker" data-testid="folder-picker">
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
          <button type="button" className="cta-btn picker__use" disabled={!folder?.path || busy} onClick={add}>
            <Icon name="plus" size={13} />
            Use this folder
          </button>
        </div>
      </div>
    </Popover>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import type { ReaderEntry } from '@shared/reader'
import type { SurfaceProps } from '@/lib/shellSlots'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { ReaderList } from './ReaderList'
import { ReaderPage } from './ReaderPage'
import { chooseDefault, readerApi, useReaderState } from './readerStore'
import './reader.css'

/**
 * The Read mode: the project's Markdown on the left, one file on the right.
 *
 * With nothing chosen yet it opens the last file read, else the project's
 * HANDOFF.md, else its README.md, else says how files get here.
 */

function Welcome({ restart, hasFiles }: { restart: boolean; hasFiles: boolean }): ReactNode {
  return (
    <section className="rpage rwelcome" aria-label="Read">
      <div className="rpage__scroll reader__scroll">
        <div className="rwelcome__body">
          <span className="rwelcome__glyph" aria-hidden="true">
            <Icon name="book" size={26} />
          </span>
          <h2 className="rwelcome__title">Nothing open yet</h2>
          <p className="rwelcome__lede">
            {restart
              ? 'Read needs a restart of Forge before it can open files.'
              : 'Markdown files open here to read — plans, handoffs, reports — and to edit when you need to.'}
          </p>
          <ul className="rwelcome__ways">
            <li>
              <span className="rwelcome__way" aria-hidden="true">
                <Icon name="file" size={15} />
              </span>
              <span>
                <strong>Double-click a .md file</strong> in Windows, with Forge as its app.
              </span>
            </li>
            <li>
              <span className="rwelcome__way" aria-hidden="true">
                <Icon name="terminal" size={15} />
              </span>
              <span>
                <strong>
                  <kbd>Ctrl</kbd>+click a .md path
                </strong>{' '}
                in a terminal.
              </span>
            </li>
            <li>
              <span className="rwelcome__way" aria-hidden="true">
                <Icon name="sparkle" size={14} />
              </span>
              <span>
                <strong>An agent sends one.</strong> A small card at the bottom right offers to open it.
              </span>
            </li>
          </ul>
          {hasFiles ? <p className="rwelcome__hint">Or pick one from the list on the left.</p> : null}
        </div>
      </div>
    </section>
  )
}

export function ReadSurface({ active }: SurfaceProps): ReactNode {
  const { state } = useApp()
  const reader = useReaderState()
  const project = state.projects.find((p) => p.id === state.activeProjectId) ?? null
  const root = project?.path ?? null
  const [entries, setEntries] = useState<ReaderEntry[] | null>(null)
  const [recent, setRecent] = useState<ReaderEntry[] | null>(null)
  const missing = !readerApi()

  useEffect(() => {
    const api = readerApi()
    setEntries(null)
    if (!api || !root) {
      setEntries([])
      return undefined
    }
    let live = true
    api.list(root).then(
      (list) => {
        if (live) setEntries(list)
      },
      () => {
        if (live) setEntries([])
      }
    )
    return () => {
      live = false
    }
  }, [root])

  // Recent changes every time a file is opened, by any route.
  useEffect(() => {
    const api = readerApi()
    if (!api) {
      setRecent([])
      return undefined
    }
    let live = true
    api.recent().then(
      (list) => {
        if (live) setRecent(list)
      },
      () => {
        if (live) setRecent([])
      }
    )
    return () => {
      live = false
    }
  }, [reader.current])

  useEffect(() => {
    if (reader.current || entries === null || recent === null) return
    const pick =
      recent[0]?.path ??
      entries.find((e) => /^handoff\.md$/i.test(e.rel))?.path ??
      entries.find((e) => /^readme\.md$/i.test(e.rel))?.path
    if (pick) chooseDefault(pick)
  }, [reader.current, entries, recent])

  const open = (path: string): void => {
    const api = readerApi()
    if (!api) return
    // Through main, like every other route, so it lands in Recent and comes back on onOpen.
    void api.open(path, 'app')
  }

  return (
    <div className="reader" data-active={active ? 'true' : undefined}>
      <aside className="reader__side" aria-label="Markdown files">
        <ReaderList entries={entries} recent={recent ?? []} current={reader.current} projectName={project?.name ?? null} onOpen={open} />
      </aside>
      {reader.current && !missing ? (
        <ReaderPage path={reader.current} projectRoot={root} projectName={project?.name ?? null} active={active} />
      ) : (
        <Welcome restart={missing} hasFiles={!!entries?.length} />
      )}
    </div>
  )
}

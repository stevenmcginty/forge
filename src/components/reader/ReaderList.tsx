import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ReaderEntry } from '@shared/reader'
import { Icon } from '../Icon'
import { baseName, dirName, shortAge, useNow } from './readerFormat'
import { samePath } from './readerStore'

/**
 * The left column: a filter, the project's markdown grouped by folder (root
 * files first, then each folder, collapsible), and the files opened lately.
 *
 * The open file is marked three ways — a pointer shape, heavier type and a
 * raised row — and never by colour alone.
 */

interface Group {
  folder: string
  files: ReaderEntry[]
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

function folderOf(rel: string): string {
  const r = rel.replace(/\\/g, '/')
  const i = r.lastIndexOf('/')
  return i > 0 ? r.slice(0, i) : ''
}

/** A deep folder said short, by its last two parts — the ones that tell siblings apart: `…/fable-5/references`. */
function shortFolder(folder: string): string {
  const parts = folder.split('/')
  if (folder.length <= 26 || parts.length < 3) return folder
  return `…/${parts.slice(-2).join('/')}`
}

/** Past this many files the folders start folded, so Recent stays in reach. */
const FOLD_PAST = 24

function groupEntries(entries: ReaderEntry[]): Group[] {
  const map = new Map<string, ReaderEntry[]>()
  for (const e of entries) {
    const folder = folderOf(e.rel)
    const list = map.get(folder)
    if (list) list.push(e)
    else map.set(folder, [e])
  }
  return [...map.entries()]
    .map(([folder, files]) => ({ folder, files: files.sort((a, b) => byName(baseName(a.rel), baseName(b.rel))) }))
    .sort((a, b) => (a.folder === '' ? -1 : b.folder === '' ? 1 : byName(a.folder, b.folder)))
}

function matches(e: ReaderEntry, q: string): boolean {
  return !q || e.rel.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)
}

function Row({
  entry,
  label,
  hint,
  current,
  now,
  nested,
  onOpen
}: {
  entry: ReaderEntry
  label: string
  hint?: string
  current: boolean
  now: number
  nested?: boolean
  onOpen: (path: string) => void
}): ReactNode {
  return (
    <button
      type="button"
      className="rlist__row"
      data-current={current ? 'true' : undefined}
      data-nested={nested ? 'true' : undefined}
      aria-current={current ? 'true' : undefined}
      title={current ? `${entry.path} — open now` : entry.path}
      onClick={() => onOpen(entry.path)}
    >
      <span className="rlist__mark" aria-hidden="true" />
      <span className="rlist__name truncate">{label}</span>
      {hint ? <span className="rlist__hint truncate">{hint}</span> : null}
      <span className="rlist__age mono">{shortAge(entry.mtimeMs, now)}</span>
    </button>
  )
}

export function ReaderList({
  entries,
  recent,
  current,
  projectName,
  onOpen
}: {
  /** null while the first list is loading. */
  entries: ReaderEntry[] | null
  recent: ReaderEntry[]
  current: string | null
  projectName: string | null
  onOpen: (path: string) => void
}): ReactNode {
  const [filter, setFilter] = useState('')
  // Folders flipped from their default: folded when the project is small, unfolded when it is big.
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set())
  const now = useNow(60000)
  const scroll = useRef<HTMLDivElement | null>(null)
  const q = filter.trim().toLowerCase()

  const groups = useMemo(() => groupEntries((entries ?? []).filter((e) => matches(e, q))), [entries, q])
  const shownRecent = useMemo(() => recent.filter((e) => matches(e, q)).slice(0, 12), [recent, q])
  const projectCount = groups.reduce((n, g) => n + g.files.length, 0)
  const folded = (entries?.length ?? 0) > FOLD_PAST

  // The open file's folder unfolds when it becomes the open file.
  const currentFolder = useMemo(() => {
    const hit = entries?.find((e) => samePath(e.path, current))
    return hit ? folderOf(hit.rel) : null
  }, [entries, current])
  useEffect(() => {
    if (!currentFolder) return
    setFlipped((prev) => {
      if (prev.has(currentFolder) === folded) return prev
      const next = new Set(prev)
      if (folded) next.add(currentFolder)
      else next.delete(currentFolder)
      return next
    })
  }, [currentFolder, folded])

  // Bring the open file into view when it changes (an agent, a terminal click).
  useEffect(() => {
    const row = scroll.current?.querySelector<HTMLElement>('[aria-current="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [current, entries])

  const toggle = (folder: string): void =>
    setFlipped((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })

  return (
    <div className="rlist">
      <div className="rlist__filter">
        <input
          type="search"
          className="rlist__input"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.stopPropagation()
              setFilter('')
            }
          }}
        />
        {filter ? (
          <button type="button" className="rlist__clear" aria-label="Clear the filter" onClick={() => setFilter('')}>
            ×
          </button>
        ) : null}
      </div>

      <div className="rlist__scroll reader__scroll" ref={scroll}>
        <section className="rlist__section" aria-label="This project">
          <h3 className="rlist__eyebrow">
            <span className="truncate" title={projectName ?? undefined}>
              This project
            </span>
            {entries ? <span className="rlist__count mono">{projectCount}</span> : null}
          </h3>
          {entries === null ? (
            <p className="rlist__quiet">Looking for Markdown…</p>
          ) : projectCount === 0 ? (
            <p className="rlist__quiet">{q ? 'No file matches.' : projectName ? 'No Markdown files in this project.' : 'No project open.'}</p>
          ) : (
            groups.map((g) => {
              const open = !g.folder || q !== '' || flipped.has(g.folder) === folded
              return (
                <div key={g.folder || '.'} className="rlist__group">
                  {g.folder ? (
                    <button
                      type="button"
                      className="rlist__folder"
                      aria-expanded={open}
                      title={`${g.folder}/ — ${open ? 'fold' : 'unfold'}`}
                      onClick={() => toggle(g.folder)}
                    >
                      <span className="rlist__chev" data-open={open ? 'true' : undefined} aria-hidden="true">
                        <Icon name="chevronRight" size={11} />
                      </span>
                      <span className="rlist__foldername truncate">{shortFolder(g.folder)}/</span>
                      {!open ? <span className="rlist__count mono">{g.files.length}</span> : null}
                    </button>
                  ) : null}
                  {open
                    ? g.files.map((e) => (
                        <Row
                          key={e.path}
                          entry={e}
                          label={baseName(e.rel)}
                          current={samePath(e.path, current)}
                          now={now}
                          nested={!!g.folder}
                          onOpen={onOpen}
                        />
                      ))
                    : null}
                </div>
              )
            })
          )}
        </section>

        {shownRecent.length ? (
          <section className="rlist__section" aria-label="Recent">
            <h3 className="rlist__eyebrow">
              <span>Recent</span>
            </h3>
            {shownRecent.map((e) => (
              <Row
                key={e.path}
                entry={e}
                label={baseName(e.path)}
                hint={baseName(dirName(e.path))}
                current={samePath(e.path, current)}
                now={now}
                onOpen={onOpen}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

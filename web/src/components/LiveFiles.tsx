import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAX_PROJECT_FILE_BYTES, type WebProjectEntry, type WebResult } from '@shared/web'
import { Icon } from '@/components/Icon'
import { formatFileSize } from '../lib/file'
import {
  childPath,
  closeLiveFiles,
  LIVE_FILES_OLD_DESKTOP,
  parentPath,
  useLiveFilesAvailable,
  useLiveFilesTarget,
  type LiveFilesTarget
} from '../lib/live-files'
import { useForge } from '../state'
import { BottomSheet } from './BottomSheet'
import { AlertGlyph } from './Connection'
import './LiveFiles.css'

/**
 * A project's folder on the desktop, read-only, in a full-height sheet: a list
 * of folders and files (56px rows, breadcrumbs a thumb can hit), and one file
 * at a time in a monospace view with line numbers and sideways scroll for long
 * lines. Nothing here writes; the wire has no verb for it.
 *
 * Back (Esc, Android Back) walks up — file → its folder → the folder above —
 * and closes the sheet only from the top.
 */

type View =
  /** `probe`: opened on a path that may be a file; a refused listing is tried as a file. */
  | { kind: 'folder'; path: string; probe?: boolean }
  | { kind: 'file'; path: string; git: boolean }

interface Listing {
  path: string
  entries: WebProjectEntry[]
  truncated: boolean
}

interface OpenFile {
  path: string
  content: string
  size: number
  mtime: number
  truncated: boolean
}

/** "512 KB" — the desktop's cap on one file, said as a round number. */
const CAP = `${Math.round(MAX_PROJECT_FILE_BYTES / 1024)} KB`

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'failed'; message: string }

function failure(result: WebResult, fallback: string): string {
  return result.kind === 'failed' && result.message ? result.message : fallback
}

function firstView(target: LiveFilesTarget): View {
  if (target.git) return { kind: 'file', path: target.path, git: true }
  return target.path ? { kind: 'folder', path: target.path, probe: true } : { kind: 'folder', path: '' }
}

export function LiveFiles(): ReactNode {
  const target = useLiveFilesTarget()
  const available = useLiveFilesAvailable()
  const { state, actions } = useForge()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'

  // The last target is held through the exit animation, so the sheet does not
  // empty itself on the way down.
  const [shown, setShown] = useState<LiveFilesTarget | null>(target)
  const [view, setView] = useState<View | null>(target ? firstView(target) : null)
  const [folder, setFolder] = useState<Load<Listing>>({ state: 'loading' })
  const [file, setFile] = useState<Load<OpenFile>>({ state: 'loading' })
  const [again, setAgain] = useState(0)

  useEffect(() => {
    if (!target) return
    setShown(target)
    setView(firstView(target))
  }, [target])

  const projectId = shown?.projectId ?? ''
  const request = actions.request
  const ready = available && live && !!projectId && !!view

  useEffect(() => {
    if (!ready || !view) return
    let gone = false
    if (view.kind === 'folder') {
      setFolder({ state: 'loading' })
      void request({ kind: 'project-files', projectId, ...(view.path ? { path: view.path } : {}) }).then((result) => {
        if (gone) return
        if (result.kind === 'project-files') {
          setFolder({ state: 'ok', value: { path: result.path, entries: result.entries, truncated: result.truncated } })
          return
        }
        // Opened on a path that turned out not to be a folder: read it as a file.
        if (view.probe && result.kind === 'failed' && result.code === 'failed') {
          setView({ kind: 'file', path: view.path, git: false })
          return
        }
        setFolder({ state: 'failed', message: failure(result, 'The desktop did not list that folder.') })
      })
    } else {
      setFile({ state: 'loading' })
      void request({ kind: 'project-file', projectId, path: view.path, ...(view.git ? { git: true } : {}) }).then(
        (result) => {
          if (gone) return
          if (result.kind === 'project-file') {
            setFile({
              state: 'ok',
              value: {
                path: result.path,
                content: result.content,
                size: result.size,
                mtime: result.mtime,
                truncated: result.truncated
              }
            })
            return
          }
          setFile({ state: 'failed', message: failure(result, 'The desktop did not send that file.') })
        }
      )
    }
    return () => {
      gone = true
    }
  }, [ready, view, projectId, request, again])

  const project = (state.picture?.projects ?? state.cached?.projects ?? []).find((p) => p.id === projectId)
  const projectName = project?.name ?? 'Project'

  // Where the file view's crumbs and Back lead: the answer's own project-relative
  // path once it has come (a git path may have been spelled from the repo root).
  const filePath = view?.kind === 'file' ? (file.state === 'ok' ? file.value.path : view.path) : ''
  const folderPath = view?.kind === 'folder' ? view.path : parentPath(filePath)

  const goFolder = (path: string): void => setView({ kind: 'folder', path })

  const back = (): void => {
    if (!view) return closeLiveFiles()
    if (view.kind === 'file') return goFolder(folderPath)
    if (view.path) return goFolder(parentPath(view.path))
    closeLiveFiles()
  }

  let body: ReactNode
  if (!available) {
    body = <Blocked icon="restart" text={LIVE_FILES_OLD_DESKTOP} detail="This desktop runs an older Forge that cannot show its files yet." />
  } else if (!live) {
    body = <Blocked icon="restart" text="Files need the desktop connected." detail="They are read from the desktop as you open them, so there is nothing to show while it is away." />
  } else if (view?.kind === 'file') {
    body = <FileBody load={file} onRetry={() => setAgain((n) => n + 1)} onBack={() => goFolder(folderPath)} />
  } else {
    body = (
      <FolderBody
        load={folder}
        onOpen={(entry, at) =>
          entry.dir ? goFolder(childPath(at, entry.name)) : setView({ kind: 'file', path: childPath(at, entry.name), git: false })
        }
        onRetry={() => setAgain((n) => n + 1)}
      />
    )
  }

  return (
    <BottomSheet
      open={target !== null}
      onClose={closeLiveFiles}
      onBack={back}
      label={`Files · ${projectName}`}
      title={
        <span className="lf__title">
          <span className="lf__title-name">{projectName}</span>
          <span className="lf__title-note">Read-only</span>
        </span>
      }
      testId="live-files"
    >
      {available && live ? (
        <Crumbs
          project={projectName}
          folder={folderPath}
          file={view?.kind === 'file' ? filePath.slice(filePath.lastIndexOf('/') + 1) : ''}
          onGo={goFolder}
        />
      ) : null}
      {body}
    </BottomSheet>
  )
}

/* ------------------------------------------------------------ crumbs */

function Crumbs({
  project,
  folder,
  file,
  onGo
}: {
  project: string
  folder: string
  file: string
  onGo: (path: string) => void
}): ReactNode {
  const parts = folder ? folder.split('/') : []
  const ref = useRef<HTMLElement | null>(null)
  // The deepest crumb is the one being read: keep it in view.
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [folder, file])
  const last = file ? -1 : parts.length - 1
  return (
    <nav className="lf__crumbs" aria-label="Folder" ref={ref} data-testid="live-files-crumbs">
      <button
        type="button"
        className="lf__crumb"
        aria-current={!file && parts.length === 0 ? 'page' : undefined}
        onClick={() => onGo('')}
      >
        <Icon name="folder" size={14} />
        {project}
      </button>
      {parts.map((part, i) => (
        <span key={`${i}-${part}`} className="lf__crumb-step">
          <span className="lf__sep" aria-hidden="true">
            /
          </span>
          <button
            type="button"
            className="lf__crumb"
            aria-current={i === last ? 'page' : undefined}
            onClick={() => onGo(parts.slice(0, i + 1).join('/'))}
          >
            {part}
          </button>
        </span>
      ))}
      {file ? (
        <span className="lf__crumb-step">
          <span className="lf__sep" aria-hidden="true">
            /
          </span>
          <span className="lf__crumb" data-file="true" aria-current="page">
            {file}
          </span>
        </span>
      ) : null}
    </nav>
  )
}

/* ------------------------------------------------------------ folder */

function FolderBody({
  load,
  onOpen,
  onRetry
}: {
  load: Load<Listing>
  onOpen: (entry: WebProjectEntry, at: string) => void
  onRetry: () => void
}): ReactNode {
  if (load.state === 'loading') return <Loading text="Reading the folder…" />
  if (load.state === 'failed') return <Failed message={load.message} onRetry={onRetry} />
  const { path, entries, truncated } = load.value
  if (entries.length === 0) return <p className="lf__empty">This folder is empty.</p>
  return (
    <div className="lf__list" data-testid="live-files-list">
      {entries.map((entry) => (
        <button
          key={entry.name}
          type="button"
          className="lf__row"
          data-kind={entry.dir ? 'folder' : 'file'}
          onClick={() => onOpen(entry, path)}
        >
          <span className="lf__row-icon" aria-hidden="true">
            <Icon name={entry.dir ? 'folder' : 'file'} size={18} />
          </span>
          <span className="lf__row-text">
            <span className="lf__row-name">{entry.name}</span>
            <span className="lf__row-sub">
              {entry.dir ? 'Folder' : `${formatFileSize(entry.size)} · ${ago(entry.mtime)}`}
            </span>
          </span>
          {entry.dir ? (
            <span className="lf__row-chev" aria-hidden="true">
              <Icon name="chevronRight" size={14} />
            </span>
          ) : null}
        </button>
      ))}
      {truncated ? (
        <p className="lf__note">This folder has more than {entries.length} things in it; the rest are not listed.</p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- file */

function FileBody({
  load,
  onRetry,
  onBack
}: {
  load: Load<OpenFile>
  onRetry: () => void
  onBack: () => void
}): ReactNode {
  const text = load.state === 'ok' ? load.value.content : ''
  const gutter = useMemo(() => {
    if (!text) return '1'
    let lines = text.split('\n').length
    // A final newline ends the last line; it does not start another.
    if (text.endsWith('\n')) lines -= 1
    const out: string[] = []
    for (let i = 1; i <= Math.max(1, lines); i++) out.push(String(i))
    return out.join('\n')
  }, [text])

  if (load.state === 'loading') return <Loading text="Reading the file…" />
  if (load.state === 'failed') {
    return <Failed message={load.message} onRetry={onRetry} backLabel="Back to the folder" onBack={onBack} />
  }
  const file = load.value
  return (
    <div className="lf__file" data-testid="live-files-file">
      <p className="lf__meta">
        <span className="lf__path">{file.path}</span>
        <span className="lf__meta-facts">
          {formatFileSize(file.size)} · {ago(file.mtime)}
        </span>
      </p>
      {file.truncated ? (
        <p className="lf__note" data-testid="live-files-truncated">
          Truncated at {CAP} — showing the first {CAP} of {formatFileSize(file.size)}.
        </p>
      ) : null}
      <div className="lf__code" role="region" aria-label={file.path} tabIndex={0}>
        <pre className="lf__gutter" aria-hidden="true">
          {gutter}
        </pre>
        <pre className="lf__text">{text.endsWith('\n') ? text.slice(0, -1) : text || ' '}</pre>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- states */

function Loading({ text }: { text: string }): ReactNode {
  return (
    <div className="lf__state" role="status">
      <p className="lf__state-text">{text}</p>
      <span className="pbar" data-on="true" aria-hidden="true" />
    </div>
  )
}

function Failed({
  message,
  onRetry,
  backLabel,
  onBack
}: {
  message: string
  onRetry: () => void
  backLabel?: string
  onBack?: () => void
}): ReactNode {
  return (
    <div className="lf__state">
      <p className="lf__error" role="alert">
        <AlertGlyph />
        <span>{message}</span>
      </p>
      <div className="lf__actions">
        {onBack ? (
          <button type="button" className="bsbtn" onClick={onBack}>
            {backLabel}
          </button>
        ) : null}
        <button type="button" className="bsbtn" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  )
}

function Blocked({ icon, text, detail }: { icon: 'restart'; text: string; detail: string }): ReactNode {
  return (
    <div className="lf__state" data-testid="live-files-blocked">
      <span className="lf__state-mark" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p className="lf__state-title">{text}</p>
      <p className="lf__state-text">{detail}</p>
    </div>
  )
}

function ago(at: number): string {
  const ms = Math.max(0, Date.now() - at)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days} d ago`
  return new Date(at).toLocaleDateString()
}

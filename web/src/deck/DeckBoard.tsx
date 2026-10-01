import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon'
import { BOARD_MAX_FETCH_BYTES, BOARD_MIRROR_FEATURE, type BoardItemSummary } from '@shared/board-mirror'
import { fetchBoardFile, subscribeBoard } from '../lib/client'
import { useDeskFeature } from '../lib/features'
import { renderMarkdown } from '../lib/markdown'
import { useActiveProject, useForge } from '../state'
import { deckSheet } from './sheet'
import './DeckBoard.css'

/*
 * The deck's Board view: what the agents put on the project's Board
 * (shared/board-mirror.ts), as a gallery in the Board's order, and one item at
 * a time in a viewer that fills the Board's box — pictures whole, clips with
 * their controls, notes as formatted text, pages live in a sandbox. Read-only.
 *
 * Files are fetched only when wanted: a picture's card fetches it once it
 * scrolls near the screen, the viewer fetches what it opens. Pictures are kept
 * as data: addresses, because Forge Web's hosted policy (firebase.json) lets an
 * <img> load data: but not blob:.
 */

/** A picture bigger than this is not fetched for its card; it shows its kind instead. */
const THUMB_MAX_BYTES = 8 * 1024 * 1024
/** Pictures kept for the cards and the viewer; the least recently used go first. */
const PICTURE_CACHE_SIZE = 40

/**
 * What a page from the Board may do in Forge Web: run its own inline script
 * and style, show data:/blob: pictures — and nothing else. No network, no form,
 * no base. As strict as the desktop's (electron/artifact-scheme.ts
 * `artifactCsp`), less the artifact: scheme Forge Web has no use for. The
 * frame's sandbox (scripts only, no same-origin) does the rest.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

const KIND: Record<BoardItemSummary['kind'], { word: string; icon: IconName }> = {
  image: { word: 'Picture', icon: 'image' },
  video: { word: 'Clip', icon: 'camera' },
  text: { word: 'Notes', icon: 'note' },
  html: { word: 'Page', icon: 'globe' }
}

function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} bytes`
}

function titleOf(item: BoardItemSummary): string {
  return item.title.trim() || item.name
}

function isMarkdown(item: BoardItemSummary): boolean {
  return /markdown/i.test(item.mime) || /\.(md|markdown)$/i.test(item.name)
}

/** The page with the policy as its first word, so it binds before any script runs. */
function withPagePolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`
  const at = /^\s*(<!doctype[^>]*>)?/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + meta + html.slice(at)
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('This browser could not read the picture.'))
    reader.readAsDataURL(blob)
  })
}

function errorWords(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

type Progress = (received: number, total: number) => void

/**
 * The pictures fetched so far, as data: addresses, keyed by project, name and
 * last write — a picture rewritten on the desktop is a new key. A fetch in
 * flight is shared by every card and viewer that wants it.
 */
class PictureCache {
  private done = new Map<string, string>()
  private pending = new Map<string, { promise: Promise<string>; listeners: Set<Progress> }>()
  private stop = new AbortController()

  static key(project: string, item: BoardItemSummary): string {
    return `${project}\n${item.name}\n${item.mtime}`
  }

  get(key: string): string | null {
    return this.done.get(key) ?? null
  }

  load(project: string, item: BoardItemSummary, onProgress?: Progress): Promise<string> {
    const key = PictureCache.key(project, item)
    const have = this.done.get(key)
    if (have) {
      // Used again: to the back of the queue.
      this.done.delete(key)
      this.done.set(key, have)
      return Promise.resolve(have)
    }
    const waiting = this.pending.get(key)
    if (waiting) {
      if (onProgress) waiting.listeners.add(onProgress)
      return waiting.promise
    }
    const listeners = new Set<Progress>(onProgress ? [onProgress] : [])
    const promise = fetchBoardFile(
      project,
      item.name,
      (received, total) => {
        for (const listener of listeners) listener(received, total)
      },
      this.stop.signal
    )
      .then(({ blob }) => readDataUrl(blob.type ? blob : new Blob([blob], { type: item.mime })))
      .then((url) => {
        this.done.set(key, url)
        while (this.done.size > PICTURE_CACHE_SIZE) {
          const oldest = this.done.keys().next().value
          if (oldest === undefined) break
          this.done.delete(oldest)
        }
        return url
      })
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key)
      })
    this.pending.set(key, { promise, listeners })
    return promise
  }

  /** The Board closed: stop every fetch and let the pictures go. */
  dispose(): void {
    this.stop.abort()
    this.stop = new AbortController()
    this.pending.clear()
    this.done.clear()
  }
}

export function DeckBoard(): ReactNode {
  const { state } = useForge()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const supported = useDeskFeature(BOARD_MIRROR_FEATURE)
  const project = useActiveProject()
  const projectId = project?.id ?? ''

  const [board, setBoard] = useState<{ project: string; items: BoardItemSummary[] } | null>(null)
  const [open, setOpen] = useState<{ project: string; name: string } | null>(null)
  const [cache] = useState(() => new PictureCache())
  const galleryRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => cache.dispose(), [cache])

  useEffect(() => {
    if (!supported || !projectId) return undefined
    return subscribeBoard(projectId, (items) => setBoard({ project: projectId, items }))
  }, [supported, projectId])

  const items = board?.project === projectId ? [...board.items].sort((a, b) => a.order - b.order) : null
  const openName = open?.project === projectId ? open.name : null
  const newest = items && items.length > 1 ? items.reduce((a, b) => (b.mtime > a.mtime ? b : a)).name : null

  const close = (): void => {
    const name = openName
    setOpen(null)
    // Back to the card it was opened from, so the keyboard carries on there.
    window.requestAnimationFrame(() => {
      const cards = galleryRef.current?.querySelectorAll<HTMLElement>('[data-name]') ?? []
      for (const card of cards) if (card.dataset.name === name) card.focus({ preventScroll: false })
    })
  }

  if (!supported) {
    return (
      <div className="dk-board">
        <p className="dk-board__empty">Update the desktop to see the Board here.</p>
      </div>
    )
  }

  if (!projectId) {
    return (
      <div className="dk-board">
        <p className="dk-board__empty">Pick a project to see its Board.</p>
      </div>
    )
  }

  if (openName !== null) {
    return (
      <div className="dk-board">
        <BoardViewer
          project={projectId}
          items={items ?? []}
          name={openName}
          cache={cache}
          live={live}
          onPick={(name) => setOpen({ project: projectId, name })}
          onClose={close}
        />
      </div>
    )
  }

  return (
    <div className="dk-board">
      <div className="dk-board__head">
        <span className="dk-board__heading">
          <Icon name="image" size={13} />
          Board
        </span>
        <span className="dk-board__count">
          {items ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : ''}
          {project?.name ? ` in ${project.name}` : ''}
        </span>
        {!live ? <span className="dk-board__offline">Reconnecting</span> : null}
      </div>

      {items === null ? (
        <p className="dk-board__empty">
          {live ? 'Asking the desktop for the Board…' : 'The link to your PC dropped. The Board comes back when it reconnects.'}
        </p>
      ) : items.length === 0 ? (
        <p className="dk-board__empty">Nothing on the board for this project yet.</p>
      ) : (
        <div ref={galleryRef} className="dk-board__gallery" role="list" aria-label="Board items">
          {items.map((item) => (
            <BoardCard
              key={item.name}
              project={projectId}
              item={item}
              cache={cache}
              live={live}
              newest={item.name === newest}
              onOpen={() => setOpen({ project: projectId, name: item.name })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ cards */

function BoardCard({
  project,
  item,
  cache,
  live,
  newest,
  onOpen
}: {
  project: string
  item: BoardItemSummary
  cache: PictureCache
  live: boolean
  newest: boolean
  onOpen: () => void
}): ReactNode {
  const kind = KIND[item.kind] ?? KIND.text
  const title = titleOf(item)
  return (
    <div className="dk-board__cell" role="listitem">
      <button
        type="button"
        className="dk-board__card"
        data-name={item.name}
        title={`Open ${title}`}
        aria-label={`${kind.word}: ${title}, ${sizeWords(item.bytes)}${newest ? ', newest' : ''}`}
        onClick={onOpen}
      >
        <span className="dk-board__thumb" data-kind={item.kind}>
          {item.kind === 'image' && item.bytes <= THUMB_MAX_BYTES ? (
            <PictureThumb project={project} item={item} cache={cache} live={live} />
          ) : (
            <span className="dk-board__kind">
              <Icon name={kind.icon} size={26} />
              <span>{kind.word}</span>
            </span>
          )}
          {newest ? <span className="dk-board__newest">Newest</span> : null}
        </span>
        <span className="dk-board__meta">
          <span className="dk-board__title truncate">{title}</span>
          <span className="dk-board__sub">
            <Icon name={kind.icon} size={11} />
            {kind.word} · {sizeWords(item.bytes)}
          </span>
        </span>
      </button>
    </div>
  )
}

/** A picture's card: fetched once it is near the screen, and only while the link is up. */
function PictureThumb({
  project,
  item,
  cache,
  live
}: {
  project: string
  item: BoardItemSummary
  cache: PictureCache
  live: boolean
}): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const key = PictureCache.key(project, item)
  const [near, setNear] = useState(false)
  const [got, setGot] = useState<{ key: string; url: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || near) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  const url = got?.key === key ? got.url : cache.get(key)

  useEffect(() => {
    if (!near || !live || url) return undefined
    let gone = false
    cache
      .load(project, item)
      .then((next) => {
        if (!gone) setGot({ key, url: next })
      })
      .catch((error: unknown) => {
        if (!gone && !isAbort(error)) setFailed(key)
      })
    return () => {
      gone = true
    }
  }, [near, live, url, key, cache, project, item])

  return (
    <span ref={ref} className="dk-board__pic">
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span className="dk-board__kind">
          <Icon name="image" size={26} />
          <span>{failed === key ? "Can't load" : 'Picture'}</span>
        </span>
      )}
    </span>
  )
}

/* ----------------------------------------------------------------- viewer */

type Loaded =
  | { key: string; phase: 'loading'; received: number; total: number }
  | { key: string; phase: 'picture'; url: string }
  | { key: string; phase: 'clip'; url: string }
  | { key: string; phase: 'text'; text: string }
  | { key: string; phase: 'error'; message: string }

/** One item's file, fetched for the viewer; fetched again when the desktop rewrites it. */
function useBoardFile(project: string, item: BoardItemSummary | null, cache: PictureCache, live: boolean): Loaded | null {
  const key = item ? PictureCache.key(project, item) : ''
  const name = item?.name ?? ''
  const kind = item?.kind
  const mime = item?.mime ?? ''
  const bytes = item?.bytes ?? 0
  const tooBig = bytes > BOARD_MAX_FETCH_BYTES
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  /** The key whose file is on screen: a re-pushed list or a reconnect does not fetch it again. */
  const readyKey = useRef('')
  /** The clip's blob: address, let go when another replaces it or the viewer closes. */
  const clipUrl = useRef('')

  useEffect(
    () => () => {
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current)
    },
    []
  )

  useEffect(() => {
    if (!item || !kind || tooBig || !live || readyKey.current === key) return undefined
    const stop = new AbortController()
    const progress: Progress = (received, total) => {
      if (!stop.signal.aborted) setLoaded({ key, phase: 'loading', received, total: total || bytes })
    }
    const fail = (error: unknown): void => {
      if (stop.signal.aborted || isAbort(error)) return
      setLoaded({ key, phase: 'error', message: errorWords(error, 'The desktop could not send that file.') })
    }
    const ready = (next: Loaded): void => {
      if (stop.signal.aborted) return
      readyKey.current = key
      setLoaded(next)
    }
    if (kind === 'image') {
      cache
        .load(project, item, progress)
        .then((url) => ready({ key, phase: 'picture', url }))
        .catch(fail)
    } else {
      fetchBoardFile(project, name, progress, stop.signal)
        .then(async ({ blob }) => {
          if (kind === 'video') {
            if (stop.signal.aborted) return
            const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mime }))
            if (clipUrl.current) URL.revokeObjectURL(clipUrl.current)
            clipUrl.current = url
            ready({ key, phase: 'clip', url })
          } else {
            ready({ key, phase: 'text', text: await blob.text() })
          }
        })
        .catch(fail)
    }
    return () => stop.abort()
    // Not on `item` itself: every push of the list is new objects, and a fetch
    // half done must not start again for that. `key` carries what can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kind, name, mime, bytes, tooBig, live, project, cache])

  if (!item) return null
  if (tooBig) {
    return {
      key,
      phase: 'error',
      message: `This ${(KIND[item.kind]?.word ?? 'file').toLowerCase()} is ${sizeWords(item.bytes)}, too big to send here. Open it on the desktop.`
    }
  }
  if (loaded?.key === key) return loaded
  // A picture already fetched for its card is shown at once.
  const have = item.kind === 'image' ? cache.get(key) : null
  return have ? { key, phase: 'picture', url: have } : { key, phase: 'loading', received: 0, total: item.bytes }
}

function BoardViewer({
  project,
  items,
  name,
  cache,
  live,
  onPick,
  onClose
}: {
  project: string
  items: BoardItemSummary[]
  name: string
  cache: PictureCache
  live: boolean
  onPick: (name: string) => void
  onClose: () => void
}): ReactNode {
  const index = items.findIndex((i) => i.name === name)
  const item = index >= 0 ? items[index]! : null
  const loaded = useBoardFile(project, item, cache, live)
  const [clipFailed, setClipFailed] = useState('')
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const canStep = item !== null && items.length > 1

  const step = (by: number): void => {
    if (!canStep) return
    const next = items[(index + by + items.length) % items.length]
    if (next) onPick(next.name)
  }

  // Esc closes, the arrows walk the Board — unless a field, a clip, a sheet
  // or a popover has the keys.
  const keys = useRef({ step, onClose })
  useEffect(() => {
    keys.current = { step, onClose }
  })
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (deckSheet.get() || document.querySelector('.popover')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        keys.current.onClose()
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(target instanceof HTMLMediaElement)) {
        e.preventDefault()
        keys.current.step(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const kind = item ? (KIND[item.kind] ?? KIND.text) : null
  const title = item ? titleOf(item) : ''

  let body: ReactNode
  if (!item) {
    body = <p className="dk-board__notice">This item was removed.</p>
  } else if (!loaded || loaded.phase === 'loading') {
    const total = loaded?.phase === 'loading' ? loaded.total : item.bytes
    const received = loaded?.phase === 'loading' ? loaded.received : 0
    const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
    body = live ? (
      <div className="dk-board__notice" role="status">
        <p>
          Loading {sizeWords(total)}… {received > 0 ? `${pct}% here` : 'asking the desktop'}
        </p>
        <progress className="dk-board__progress" max={100} value={pct} aria-hidden="true" />
      </div>
    ) : (
      <p className="dk-board__notice">The link to your PC dropped. It loads when it reconnects.</p>
    )
  } else if (loaded.phase === 'error') {
    body = (
      <p className="dk-board__notice" role="alert">
        {loaded.message}
      </p>
    )
  } else if (loaded.phase === 'picture') {
    body = <img className="dk-board__picture" src={loaded.url} alt={title} draggable={false} />
  } else if (loaded.phase === 'clip') {
    body =
      clipFailed === loaded.url ? (
        <p className="dk-board__notice" role="alert">
          This browser could not play the clip here. Open it on the desktop.
        </p>
      ) : (
        <video
          key={loaded.url}
          className="dk-board__clip"
          src={loaded.url}
          controls
          playsInline
          onError={() => setClipFailed(loaded.url)}
        />
      )
  } else if (item.kind === 'html') {
    body = (
      <iframe
        key={loaded.key}
        className="dk-board__frame"
        title={title}
        sandbox="allow-scripts"
        srcDoc={withPagePolicy(loaded.text)}
        referrerPolicy="no-referrer"
      />
    )
  } else if (isMarkdown(item)) {
    body = (
      <div className="dk-board__read">
        <div className="dk-board__prose">{renderMarkdown(loaded.text)}</div>
      </div>
    )
  } else {
    body = (
      <div className="dk-board__read">
        <pre className="dk-board__plain">{loaded.text}</pre>
      </div>
    )
  }

  return (
    <div className="dk-board__viewer">
      <div className="dk-board__bar">
        <button
          ref={closeRef}
          type="button"
          className="dk-board__btn dk-board__btn--word"
          title="Back to the Board (Esc)"
          onClick={onClose}
        >
          <Icon name="close" size={12} />
          Close
        </button>
        <span className="dk-board__name">
          {kind ? (
            <span className="dk-board__tag">
              <Icon name={kind.icon} size={11} />
              {kind.word}
            </span>
          ) : null}
          <span className="dk-board__title truncate">{item ? title : name}</span>
        </span>
        {canStep ? (
          <span className="dk-board__steps">
            <button
              type="button"
              className="dk-board__btn"
              aria-label="Previous (Left arrow)"
              title="Previous (←)"
              onClick={() => step(-1)}
            >
              <Icon name="chevronLeft" size={14} />
            </button>
            <span className="dk-board__where">
              {index + 1} of {items.length}
            </span>
            <button
              type="button"
              className="dk-board__btn"
              aria-label="Next (Right arrow)"
              title="Next (→)"
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" size={14} />
            </button>
          </span>
        ) : null}
      </div>
      <div className="dk-board__stage" data-kind={item?.kind}>
        {body}
      </div>
    </div>
  )
}

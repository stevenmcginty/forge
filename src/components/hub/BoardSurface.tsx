import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { ARTIFACT_SCHEME } from '@shared/browser'
import type { CanvasItem } from '@shared/hub'
import { useCanvasFeed, type CanvasFeed } from '@/hooks/useHub'
import { HUB_FOCUS_EVENT, type HubFocusDetail } from '@/lib/hubnav'
import { getHubRuntime } from '@/lib/hubRuntime'
import { PATH_DRAG_TYPE } from '@/lib/mosaicLayout'
import { popIn, useFlipChildren } from '@/lib/motion'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import type { SurfaceProps } from '@/lib/shellSlots'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { ArtifactView, artifactAddress, HtmlThumb, isMarkdown, MarkdownBody, useArtifactRead, type ArtifactActions } from './ArtifactView'
import './BoardSurface.css'

/**
 * The board: a calm gallery of what the agents made, newest first.
 *
 * It shares the stage with the agents (placement `beside`), because the
 * point of a picture on the board is usually to hand it to one of them:
 * drag a tile onto a pane and its path lands at the prompt, exactly as a
 * file dragged out of Explorer would; or press "→ Everest" to paste it into
 * the pane you are in. The newest piece is shown large, the rest in an even
 * grid; a click opens it as an artifact beside the panes — HTML live in a
 * sandbox, markdown formatted, pictures whole — arrows walk the board, Esc
 * comes back.
 *
 * Files come from `useCanvasFeed` — anything an agent or a bridge tool saves
 * into the project's canvas folder appears here by itself, and anything you
 * drop on the board is copied in.
 */

/**
 * Same as electron/canvas-board.ts CANVAS_MAX_BYTES (and the bridge's
 * MAX_BYTES): past it main will not read the file, so a tile says so instead
 * of waiting for it forever.
 */
export const BOARD_MAX_BYTES = 256 * 1024 * 1024

/** How close together an arrival and a "show the board" must be to count as one. */
const REVEAL_MS = 4000

export function BoardSurface({ active }: SurfaceProps): ReactNode {
  const { state, actions } = useApp()
  const pid = state.activeProjectId
  const feed = useCanvasFeed()
  // The feed starts empty on every visit; until it has read the folder, the
  // board shows what it showed last time rather than "nothing on the board".
  const loaded = feed.dir !== ''
  useEffect(() => {
    if (pid && loaded) lastShown.set(pid, feed.items)
  }, [pid, loaded, feed.items])
  const source = loaded ? feed.items : pid ? lastShown.get(pid) : undefined
  const waiting = source === undefined && feed.available && Boolean(pid)
  const items = useMemo(() => [...(source ?? [])].sort((a, b) => b.mtime - a.mtime), [source])
  const open = useSyncExternalStore(openStore.subscribe, openStore.get)
  const setOpen = openStore.set
  const [dropping, setDropping] = useState(false)
  const [seeded, setSeeded] = useState<string[]>([])
  const gridRef = useRef<HTMLDivElement | null>(null)
  useFlipChildren(gridRef, items.map((i) => i.id).join('|'))

  const openIndex = open ? items.findIndex((i) => i.id === open) : -1
  useEffect(() => {
    // Only once the board has loaded: an empty list is "not read yet", not "gone".
    if (open && openIndex < 0 && items.length) setOpen(null)
  }, [open, openIndex, items.length, setOpen])

  // Something arrived while you were elsewhere (BoardArrival noted it): the
  // board opens on it — not behind whatever artifact was left open — and it
  // wears its NEW tag.
  const arrivalsVersion = useSyncExternalStore(arrivals.subscribe, arrivals.version)
  useEffect(() => {
    if (!pid) return
    const ids = arrivals.take(pid)
    if (!ids.length) return
    setOpen(null)
    setSeeded(ids)
  }, [pid, arrivalsVersion, setOpen])

  // Already here, and "show it on the board" (voice, a tool) posts something:
  // the arrival and the focus event come in either order, close together.
  const lastFocus = useRef(0)
  const lastArrival = useRef(0)
  useEffect(() => {
    const on = (e: Event): void => {
      if ((e as CustomEvent<HubFocusDetail>).detail?.kind !== 'canvas') return
      lastFocus.current = Date.now()
      if (Date.now() - lastArrival.current < REVEAL_MS) setOpen(null)
    }
    window.addEventListener(HUB_FOCUS_EVENT, on)
    return () => window.removeEventListener(HUB_FOCUS_EVENT, on)
  }, [setOpen])
  const addedKey = feed.justAdded.join('|')
  useEffect(() => {
    if (!addedKey) return
    lastArrival.current = Date.now()
    if (Date.now() - lastFocus.current < REVEAL_MS) setOpen(null)
  }, [addedKey, setOpen])

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDropping(false)
    // A tile dragged within the board is not a new file.
    if (e.dataTransfer.types.includes(PATH_DRAG_TYPE)) return
    const paths = droppedFilePaths(e)
    for (const p of paths) {
      const r = await feed.post(p)
      if (!r.ok) actions.setNotice(r.error)
    }
  }

  return (
    <div
      className="board"
      data-dropping={dropping ? 'true' : undefined}
      onDragOver={(e) => {
        if (!maybeFiles(e) || e.dataTransfer.types.includes(PATH_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <header className="board__head">
        <span className="board__eyebrow">Board</span>
        <span className="board__count">
          {waiting ? '' : `${items.length} ${items.length === 1 ? 'piece' : 'pieces'}`}
        </span>
        <span className="board__dir mono truncate" title={feed.dir}>
          {feed.dir}
        </span>
        <button type="button" className="board__btn" onClick={() => feed.reveal()} disabled={!feed.available}>
          <Icon name="folder" size={13} />
          Open folder
        </button>
      </header>

      {waiting ? null : items.length === 0 ? (
        <div className="board__empty">
          <span className="board__empty-mark" aria-hidden="true">
            <Icon name="image" size={22} />
          </span>
          <p className="board__empty-title">Nothing on the board yet</p>
          <p className="board__empty-text">
            Ask an agent to make an image, or say “show it on the board”. Anything saved into this project’s board
            folder appears here by itself — and you can drop files straight onto the board.
          </p>
        </div>
      ) : (
        <div className="board__grid" ref={gridRef}>
          {items.map((item, i) => (
            <Tile
              key={item.id}
              item={item}
              hero={i === 0}
              fresh={feed.justAdded.includes(item.id) || seeded.includes(item.id)}
              feed={feed}
              active={active}
              onOpen={() => setOpen(item.id)}
            />
          ))}
        </div>
      )}

      {openIndex >= 0 ? (
        <OpenArtifact
          item={items[openIndex]!}
          index={openIndex}
          count={items.length}
          feed={feed}
          onStep={(d) => setOpen(items[(openIndex + d + items.length) % items.length]!.id)}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {dropping ? (
        <div className="board__drop" aria-hidden="true">
          <span>Drop to put it on the board</span>
        </div>
      ) : null}
    </div>
  )
}

/** What each project's board showed last, so coming back draws it at once. */
const lastShown = new Map<string, CanvasItem[]>()

/* ------------------------------------------------------------------ media */

/**
 * Can this window draw pictures and clips straight from forge-artifact:?
 * Only when index.html's CSP lists the scheme under img-src and media-src.
 * Then main streams the file from disk and nothing crosses IPC; until then
 * (or if the scheme fails for one file) the bytes are read over IPC instead —
 * asynchronously, once per version of a file, shared by every tile showing it.
 */
let schemeMedia: boolean | null = null
function schemeMediaAllowed(): boolean {
  if (schemeMedia !== null) return schemeMedia
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  const allows = (directive: string): boolean =>
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .some((parts) => parts[0] === directive && parts.includes(`${ARTIFACT_SCHEME}:`))
  schemeMedia = allows('img-src') && allows('media-src')
  return schemeMedia
}

interface BlobEntry {
  path: string
  mtime: number
  bytes: number
  refs: number
  used: number
  pending: Promise<string | null>
}

/**
 * blob: URLs read over IPC, kept after their tiles unmount so the next visit
 * does not read every picture again. Idle entries past the budget, and any old
 * version of a file, are revoked.
 */
const blobs = new Map<string, BlobEntry>()
const BLOB_BUDGET = 160 * 1024 * 1024

function acquireBlob(item: CanvasItem, objectUrl: CanvasFeed['objectUrl']): BlobEntry {
  const key = `${item.path}@${item.mtime}`
  let entry = blobs.get(key)
  if (!entry) {
    const made: BlobEntry = { path: item.path, mtime: item.mtime, bytes: item.bytes, refs: 0, used: 0, pending: Promise.resolve(null) }
    made.pending = objectUrl(item.id).then(
      (u) => {
        const kept = blobs.get(key) === made
        if (!u || !kept) {
          if (u) URL.revokeObjectURL(u)
          if (kept) blobs.delete(key)
          return null
        }
        return u
      },
      () => {
        if (blobs.get(key) === made) blobs.delete(key)
        return null
      }
    )
    blobs.set(key, made)
    entry = made
  }
  entry.refs += 1
  entry.used = Date.now()
  return entry
}

function releaseBlob(entry: BlobEntry): void {
  entry.refs = Math.max(0, entry.refs - 1)
  entry.used = Date.now()
  const newest = new Map<string, number>()
  for (const e of blobs.values()) newest.set(e.path, Math.max(newest.get(e.path) ?? 0, e.mtime))
  const idle = [...blobs.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].used - b[1].used)
  let total = idle.reduce((n, [, e]) => n + e.bytes, 0)
  for (const [key, e] of idle) {
    const stale = e.mtime < (newest.get(e.path) ?? 0)
    if (!stale && total <= BLOB_BUDGET) continue
    blobs.delete(key)
    total -= e.bytes
    void e.pending.then((u) => u && URL.revokeObjectURL(u))
  }
}

/**
 * Where to draw an image or clip from: the scheme when the window allows it,
 * else a shared blob. `failed` once neither worked; `tooBig` past the limit
 * (never tried). Nothing is fetched until `load`.
 */
function useItemMedia(item: CanvasItem, feed: CanvasFeed, load: boolean): { src: string | null; failed: boolean; tooBig: boolean; onError: () => void } {
  const version = `${item.path}@${item.mtime}`
  const isMedia = item.kind === 'image' || item.kind === 'video'
  const tooBig = item.bytes > BOARD_MAX_BYTES
  const [schemeBroken, setSchemeBroken] = useState<string | null>(null)
  const [failedVersion, setFailedVersion] = useState<string | null>(null)
  const [blob, setBlob] = useState<{ version: string; url: string } | null>(null)
  const viaScheme = schemeMediaAllowed() && schemeBroken !== version
  const { objectUrl } = feed

  useEffect(() => {
    if (!isMedia || !load || tooBig || viaScheme) return undefined
    let live = true
    const entry = acquireBlob(item, objectUrl)
    void entry.pending.then((u) => {
      if (!live) return
      if (u) setBlob({ version, url: u })
      else setFailedVersion(version)
    })
    return () => {
      live = false
      releaseBlob(entry)
    }
    // item is read through `version` (path + mtime): a file rewritten in place gets a fresh picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, isMedia, load, tooBig, viaScheme, objectUrl])

  const src = !isMedia || !load || tooBig ? null : viaScheme ? `${artifactAddress(item)}?v=${item.mtime}` : blob?.version === version ? blob.url : null
  const onError = (): void => {
    if (viaScheme) setSchemeBroken(version)
    else setFailedVersion(version)
  }
  return { src, failed: failedVersion === version, tooBig, onError }
}

function Unshown({ word, text }: { word: string; text: string }): ReactNode {
  return (
    <span className="bprev bprev--text bprev--fail" role="note">
      <span className="bprev__kind">{word}</span>
      <span className="bprev__body">{text}</span>
    </span>
  )
}

export function Preview({ item, feed, large = false, load = true }: { item: CanvasItem; feed: CanvasFeed; large?: boolean; load?: boolean }): ReactNode {
  const { src, failed, tooBig, onError } = useItemMedia(item, feed, load)
  if (tooBig) {
    return <Unshown word="Too big to show" text={`${size(item.bytes)} — the board shows files up to 256 MB. Open it in its own app.`} />
  }
  if (failed) return <Unshown word="Could not load" text="The file could not be read from the board’s folder." />
  if (!load) return <span className="bprev bprev--wait" />
  if (item.kind === 'image') {
    return src ? (
      <img className="bprev bprev--img" src={src} alt={item.title} draggable={false} decoding="async" onError={onError} />
    ) : (
      <span className="bprev bprev--wait" />
    )
  }
  if (item.kind === 'video') {
    return src ? (
      <video
        className="bprev bprev--img"
        src={src}
        muted
        loop
        playsInline
        preload={large ? 'auto' : 'metadata'}
        controls={large}
        autoPlay={large}
        onError={onError}
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(e) => {
          if (!large) e.currentTarget.pause()
        }}
      />
    ) : (
      <span className="bprev bprev--wait" />
    )
  }
  if (item.kind === 'html') return <HtmlThumb item={item} />
  return <TextPreview item={item} feed={feed} />
}

/** markdown: formatted; text: the words. (html draws its own still thumbnail from the scheme.) */
function TextPreview({ item, feed }: { item: CanvasItem; feed: CanvasFeed }): ReactNode {
  const { text, failed } = useArtifactRead(item, feed)
  if (failed) return <Unshown word="Could not load" text="The file could not be read from the board’s folder." />
  if (text === null) return <span className="bprev bprev--wait" />
  if (isMarkdown(item)) {
    return (
      <span className="bprev bprev--text bprev--md">
        <MarkdownBody source={text.slice(0, 2400)} className="artifact__md--thumb" />
      </span>
    )
  }
  return (
    <span className="bprev bprev--text">
      <span className="bprev__kind">Text</span>
      <span className="bprev__body">{text.slice(0, 900)}</span>
    </span>
  )
}

/** True once the element has come near the screen, and from then on. */
function useNearScreen(ref: RefObject<HTMLElement | null>, eager: boolean): boolean {
  const [near, setNear] = useState(eager)
  useEffect(() => {
    if (near) return undefined
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return undefined
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near, ref])
  return near
}

function Tile({
  item,
  hero,
  fresh,
  feed,
  active,
  onOpen
}: {
  item: CanvasItem
  hero: boolean
  fresh: boolean
  feed: CanvasFeed
  active: boolean
  onOpen: () => void
}): ReactNode {
  const ref = useRef<HTMLElement | null>(null)
  const [isNew, setIsNew] = useState(fresh)
  // A tile far down the board loads nothing until it is scrolled near.
  const near = useNearScreen(ref, hero)

  // A new arrival pops in and wears a NEW tag for a few seconds.
  useEffect(() => {
    if (!fresh) return undefined
    setIsNew(true)
    if (ref.current && active) popIn(ref.current, { from: 0.9, lift: 16 })
    const t = window.setTimeout(() => setIsNew(false), 6000)
    return () => window.clearTimeout(t)
  }, [fresh, active])

  return (
    <article
      ref={ref}
      className="btile"
      data-flip={item.id}
      data-hero={hero ? 'true' : undefined}
      data-kind={item.kind}
      draggable
      onDragStart={(e) => {
        // Lands on a pane exactly like a row dragged out of the rail.
        e.dataTransfer.setData(PATH_DRAG_TYPE, item.path)
        e.dataTransfer.setData('text/plain', item.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <button type="button" className="btile__frame" onClick={onOpen} title={`Open ${item.title}`}>
        <Preview item={item} feed={feed} load={near} />
      </button>
      {isNew ? <span className="btile__new">New</span> : null}
      <footer className="btile__foot">
        <span className="btile__title truncate">{item.title}</span>
        <span className="btile__meta mono">
          {isMarkdown(item) ? 'markdown' : KIND_WORD[item.kind]} · {size(item.bytes)} · {ago(item.mtime)}
        </span>
      </footer>
      <ItemActions item={item} feed={feed} />
    </article>
  )
}

const KIND_WORD: Record<CanvasItem['kind'], string> = { image: 'image', video: 'video', text: 'text', html: 'page' }

/* -------------------------------------------------------------- actions */

/** How long a pressed trash button waits for the second press that deletes. */
const REMOVE_ARM_MS = 3000

function useItemActions(item: CanvasItem, feed: CanvasFeed): ArtifactActions {
  const { actions } = useApp()
  const tab = useActiveTab()
  const paneId = tab?.activePaneId ?? null
  const rt = getHubRuntime()
  const pane = paneId ? rt?.panes().find((p) => p.paneId === paneId) : null
  const paneName = pane ? pane.name : null
  const [copied, setCopied] = useState(false)
  const [removeArmed, setRemoveArmed] = useState(false)

  useEffect(() => {
    if (!removeArmed) return undefined
    const t = window.setTimeout(() => setRemoveArmed(false), REMOVE_ARM_MS)
    return () => window.clearTimeout(t)
  }, [removeArmed])

  const copy = useCallback(async (): Promise<void> => {
    let what = 'path'
    try {
      if (item.kind === 'image') {
        const file = await feed.objectUrl(item.id)
        if (file) {
          const blob = await (await fetch(file)).blob()
          URL.revokeObjectURL(file)
          // The clipboard takes PNG; anything else goes as its path.
          if (blob.type === 'image/png') {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            what = 'image'
          }
        }
      }
    } catch {
      what = 'path'
    }
    if (what === 'path') await window.forge.clipboard.writeText(item.path)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
    actions.setNotice(what === 'image' ? `Copied “${item.title}” as a picture` : `Copied the path of “${item.title}”`)
  }, [actions, feed, item])

  const toPane = (): void => {
    if (!paneId) {
      actions.setNotice('Open a pane first — the path is pasted into the pane you are in')
      return
    }
    // Focus first, text a frame later — the path arrives as a bracketed paste,
    // and an agent that was just told its terminal lost focus (DECSET 1004)
    // drops it. The same order as a drop on a pane (TerminalPane, MosaicView).
    terminalHost.focus(paneId)
    requestAnimationFrame(() => terminalHost.paste(paneId, `"${item.path}" `))
    // Wherever that pane is drawn — full size, on the Wall, or in the wall strip over the board.
    document
      .querySelectorAll<HTMLElement>(
        `.pane[data-pane-id="${paneId}"], .mtile[data-pane-id="${paneId}"], .wstrip__tile[data-pane-id="${paneId}"]`
      )
      .forEach((target) => {
        target.dataset['hit'] = 'true'
        window.setTimeout(() => delete target.dataset['hit'], 900)
      })
  }

  // The first press arms the button; the second, within a few seconds, deletes.
  // The file goes from the board's folder for good, and agents often wrote it
  // nowhere else, so it is never one click.
  const remove = (): void => {
    if (!removeArmed) {
      setRemoveArmed(true)
      return
    }
    setRemoveArmed(false)
    void feed.remove(item.id).then(
      (gone) => {
        if (!gone) actions.setNotice(`Could not delete “${item.title}” — it may be open in another app`)
      },
      () => actions.setNotice(`Could not delete “${item.title}”`)
    )
  }

  return { toPane, paneName, copy: () => void copy(), copied, remove, removeArmed }
}

function ItemActions({ item, feed }: { item: CanvasItem; feed: CanvasFeed }): ReactNode {
  const a = useItemActions(item, feed)
  return (
    <div className="bacts bacts--compact" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="bact bact--primary"
        onClick={a.toPane}
        title={a.paneName ? `Paste its path into ${a.paneName}` : 'Paste its path into the pane you are in'}
      >
        <span aria-hidden="true">→</span>
        <span className="truncate">{a.paneName ?? 'Pane'}</span>
      </button>
      <button type="button" className="bact" onClick={a.copy} title={item.kind === 'image' ? 'Copy the picture (or its path)' : 'Copy its path'}>
        <Icon name={a.copied ? 'check' : 'clipboard'} size={12} />
      </button>
      <button type="button" className="bact" onClick={() => void window.forge.openPath(item.path)} title="Open in its own app">
        <Icon name="expand" size={12} />
      </button>
      <button
        type="button"
        className="bact bact--quiet"
        data-armed={a.removeArmed ? 'true' : undefined}
        data-danger={a.removeArmed ? 'true' : undefined}
        title={a.removeArmed ? 'Press again to delete the file for good' : 'Take it off the board (deletes the file from the board’s folder)'}
        aria-label={a.removeArmed ? `Press again to delete ${item.title}` : `Delete ${item.title}`}
        onClick={a.remove}
      >
        <Icon name="trash" size={12} />
        {a.removeArmed ? <span>Delete?</span> : null}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- artifact */

/**
 * Which piece is open, kept outside the component so leaving the board (for
 * the agents, the browser) and coming back finds it still open.
 */
const openStore = (() => {
  let value: string | null = null
  const listeners = new Set<() => void>()
  return {
    get: (): string | null => value,
    set: (next: string | null): void => {
      if (next === value) return
      value = next
      for (const l of listeners) l()
    },
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }
  }
})()

/**
 * Arrivals the board has not shown yet, per project. BoardArrival (always
 * mounted) notes what lands while you are elsewhere; the board takes them when
 * it opens — closing an artifact left open from before, so the new piece is
 * what you see — and marks them NEW.
 */
const arrivals = (() => {
  const pending = new Map<string, string[]>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    note: (projectId: string, ids: string[]): void => {
      if (!projectId || !ids.length) return
      pending.set(projectId, [...new Set([...(pending.get(projectId) ?? []), ...ids])])
      version += 1
      for (const l of listeners) l()
    },
    take: (projectId: string): string[] => {
      const ids = pending.get(projectId) ?? []
      pending.delete(projectId)
      return ids
    },
    version: (): number => version,
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }
  }
})()

/** For BoardArrival: these landed on this project's board while it was not on screen. */
export const noteBoardArrivals = arrivals.note

function OpenArtifact({
  item,
  index,
  count,
  feed,
  onStep,
  onClose
}: {
  item: CanvasItem
  index: number
  count: number
  feed: CanvasFeed
  onStep: (delta: number) => void
  onClose: () => void
}): ReactNode {
  const acts = useItemActions(item, feed)
  return (
    <ArtifactView
      item={item}
      feed={feed}
      index={index}
      count={count}
      media={<Preview key={item.id} item={item} feed={feed} large />}
      actions={acts}
      onStep={onStep}
      onClose={onClose}
    />
  )
}

/* ---------------------------------------------------------------- words */

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

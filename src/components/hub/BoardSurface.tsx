import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CanvasItem } from '@shared/hub'
import { useCanvasFeed, type CanvasFeed } from '@/hooks/useHub'
import { getHubRuntime } from '@/lib/hubRuntime'
import { PATH_DRAG_TYPE } from '@/lib/mosaicLayout'
import { popIn, useFlipChildren } from '@/lib/motion'
import { droppedFilePaths, maybeFiles } from '@/lib/paths'
import type { SurfaceProps } from '@/lib/shellSlots'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { ArtifactView, HtmlThumb, isMarkdown, MarkdownBody, useArtifactText, type ArtifactActions } from './ArtifactView'
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
export function BoardSurface({ active }: SurfaceProps): ReactNode {
  const { actions } = useApp()
  const feed = useCanvasFeed()
  const items = useMemo(() => [...feed.items].sort((a, b) => b.mtime - a.mtime), [feed.items])
  const open = useSyncExternalStore(openStore.subscribe, openStore.get)
  const setOpen = openStore.set
  const [dropping, setDropping] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)
  useFlipChildren(gridRef, items.map((i) => i.id).join('|'))

  const openIndex = open ? items.findIndex((i) => i.id === open) : -1
  useEffect(() => {
    // Only once the board has loaded: an empty list is "not read yet", not "gone".
    if (open && openIndex < 0 && items.length) setOpen(null)
  }, [open, openIndex, items.length, setOpen])

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
          {items.length} {items.length === 1 ? 'piece' : 'pieces'}
        </span>
        <span className="board__dir mono truncate" title={feed.dir}>
          {feed.dir}
        </span>
        <button type="button" className="board__btn" onClick={() => feed.reveal()} disabled={!feed.available}>
          <Icon name="folder" size={13} />
          Open folder
        </button>
      </header>

      {items.length === 0 ? (
        <div className="board__empty">
          <span className="board__empty-mark" aria-hidden="true">
            <Icon name="image" size={22} />
          </span>
          <p className="board__empty-title">Nothing on the board yet</p>
          <p className="board__empty-text">
            Ask an agent to make an image, or say “show it on the canvas”. Anything saved into this project’s canvas
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
              fresh={feed.justAdded.includes(item.id)}
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

/* ------------------------------------------------------------------ tiles */

/** A blob: URL for one item, made on mount and revoked on unmount. */
function useItemUrl(item: CanvasItem, feed: CanvasFeed): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const { objectUrl } = feed
  useEffect(() => {
    if (item.kind !== 'image' && item.kind !== 'video') return undefined
    let live = true
    let made: string | null = null
    void objectUrl(item.id).then((u) => {
      if (!live) {
        if (u) URL.revokeObjectURL(u)
        return
      }
      made = u
      setUrl(u)
    })
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
    // mtime: a file rewritten in place gets a fresh picture.
  }, [item.id, item.kind, item.mtime, objectUrl])
  return url
}

export function Preview({ item, feed, large = false }: { item: CanvasItem; feed: CanvasFeed; large?: boolean }): ReactNode {
  const url = useItemUrl(item, feed)
  if (item.kind === 'image') {
    return url ? <img className="bprev bprev--img" src={url} alt={item.title} draggable={false} /> : <span className="bprev bprev--wait" />
  }
  if (item.kind === 'video') {
    return url ? (
      <video
        className="bprev bprev--img"
        src={url}
        muted
        loop
        playsInline
        controls={large}
        autoPlay={large}
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(e) => {
          if (!large) e.currentTarget.pause()
        }}
      />
    ) : (
      <span className="bprev bprev--wait" />
    )
  }
  return <TextPreview item={item} feed={feed} />
}

/** html: a still, script-free render; markdown: formatted; text: the words. */
function TextPreview({ item, feed }: { item: CanvasItem; feed: CanvasFeed }): ReactNode {
  const text = useArtifactText(item, feed)
  if (text === null) return <span className="bprev bprev--wait" />
  if (item.kind === 'html') return <HtmlThumb html={text} title={item.title} />
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
        <Preview item={item} feed={feed} />
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

function useItemActions(item: CanvasItem, feed: CanvasFeed): ArtifactActions {
  const { actions } = useApp()
  const tab = useActiveTab()
  const paneId = tab?.activePaneId ?? null
  const rt = getHubRuntime()
  const pane = paneId ? rt?.panes().find((p) => p.paneId === paneId) : null
  const paneName = pane ? (pane.callSign ?? `panel ${pane.number}`) : null
  const [copied, setCopied] = useState(false)

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
    terminalHost.paste(paneId, `"${item.path}" `)
    requestAnimationFrame(() => terminalHost.focus(paneId))
    const target = document.querySelector<HTMLElement>(`.pane[data-pane-id="${paneId}"], .mtile[data-pane-id="${paneId}"]`)
    if (target) {
      target.dataset['hit'] = 'true'
      window.setTimeout(() => delete target.dataset['hit'], 900)
    }
  }

  return { toPane, paneName, copy: () => void copy(), copied, remove: () => void feed.remove(item.id) }
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
      <button type="button" className="bact bact--quiet" title="Take it off the board (deletes the file from the canvas folder)" onClick={a.remove}>
        <Icon name="trash" size={12} />
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

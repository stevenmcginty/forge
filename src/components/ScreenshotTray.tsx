import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Shot } from '@shared/types'
import { droppedFilePaths } from '@/lib/paths'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './ScreenshotTray.css'

const TOAST_MS = 2200

/**
 * The shelf. Every screenshot you take (Win+Shift+S, PrtScn) and every image
 * you copy lands here as a real PNG — newest first, oldest pruned. Straight
 * from DictationMic: unseen shots wear a volt ring until you have looked at
 * them, a thumbnail drags out as a real file, and clicking one copies it.
 */
export function ScreenshotTray(): ReactNode {
  const { state } = useApp()
  const tab = useActiveTab()
  const collapsed = state.settings.railCollapsed

  const [shots, setShots] = useState<Shot[]>([])
  const [unseen, setUnseen] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [busy, setBusy] = useState(false)

  /** Ids we have already seen, so a reload is not a fresh alarm. */
  const known = useRef<Set<string> | null>(null)
  const looked = useRef(false)
  const stripRef = useRef<HTMLDivElement | null>(null)

  /* --------------------------------------------------------- subscription */

  useEffect(() => {
    const receive = (next: Shot[]): void => {
      setShots(next)
      const ids = new Set(next.map((s) => s.id))
      if (known.current === null) {
        // The first payload is the shelf as it was on disk — not news.
        known.current = ids
        return
      }
      const fresh = next.filter((s) => !known.current!.has(s.id)).map((s) => s.id)
      known.current = ids
      if (fresh.length > 0) {
        looked.current = false
        setUnseen((prev) => [...fresh, ...prev.filter((id) => ids.has(id))])
      }
    }

    const unsubscribe = window.forge.shots.onUpdated(receive)
    void window.forge.shots.list().then(receive)
    return unsubscribe
  }, [])

  /* ---------------------------------------------------------- scroll edges */

  /**
   * Mark which way there is more to see, so the strip can fade that edge. A
   * vertical wheel is also translated into a horizontal scroll — spinning the
   * wheel over a row of thumbnails and having nothing happen is maddening.
   */
  const measureEdges = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    el.dataset['moreLeft'] = el.scrollLeft > 2 ? 'true' : 'false'
    el.dataset['moreRight'] = el.scrollLeft < max - 2 ? 'true' : 'false'
  }, [])

  useEffect(() => {
    measureEdges()
  }, [measureEdges, shots, collapsed])

  // Registered by hand rather than as a React prop: React attaches wheel
  // listeners passively, and a passive listener cannot preventDefault.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [shots.length, collapsed])

  /* ---------------------------------------------------------------- toast */

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(t)
  }, [toast])

  /* -------------------------------------------------------------- actions */

  /** Looking at the tray is enough to clear the badge. */
  const markSeen = useCallback(() => {
    looked.current = true
    setUnseen((prev) => (prev.length === 0 ? prev : []))
  }, [])

  const copyShot = useCallback(
    async (shot: Shot) => {
      const ok = await window.forge.shots.copy(shot.path)
      if (!ok) {
        setToast('that shot has gone')
        return
      }
      // Land the path in the terminal you were last working in, so an agent can
      // be pointed at the file without you typing it out.
      const paneId = tab?.activePaneId ?? null
      if (paneId) {
        terminalHost.paste(paneId, `"${shot.path}" `)
        terminalHost.focus(paneId)
        setToast('copied — Ctrl+V, or use the path dropped in the pane')
      } else {
        setToast('copied — Ctrl+V to paste it')
      }
    },
    [tab?.activePaneId]
  )

  const removeShot = useCallback(async (shot: Shot) => {
    setShots(await window.forge.shots.remove(shot.path))
  }, [])

  const clearAll = useCallback(async () => {
    setShots(await window.forge.shots.clear())
    setToast('shelf cleared')
  }, [])

  /* ---------------------------------------------------------- drop inward */

  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDropping(false)
    const paths = droppedFilePaths(e)
    if (paths.length === 0) return
    setBusy(true)
    void window.forge.shots.adopt(paths).then((n) => {
      setBusy(false)
      markSeen()
      setToast(n > 0 ? `${n} ${n === 1 ? 'image' : 'images'} added to the shelf` : 'no images in that drop')
    })
  }

  /* --------------------------------------------------------------- render */

  if (collapsed) {
    return (
      <div
        className="tray tray--collapsed"
        data-unseen={unseen.length > 0 ? 'true' : undefined}
        title={
          shots.length === 0
            ? 'Screenshots you take will land here'
            : `${shots.length} shot${shots.length === 1 ? '' : 's'} — open the rail to see them`
        }
        onPointerEnter={markSeen}
      >
        <Icon name="camera" size={16} />
        {shots.length > 0 ? <span className="tray__pip mono">{shots.length}</span> : null}
      </div>
    )
  }

  return (
    <section
      className="tray"
      aria-label="Screenshot tray"
      data-dropping={dropping ? 'true' : undefined}
      onPointerEnter={markSeen}
      onFocusCapture={markSeen}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header className="tray__head">
        <span className="eyebrow">Shots</span>
        <span className="tray__count mono">{shots.length}</span>
        {unseen.length > 0 ? <span className="tray__badge mono">{unseen.length} new</span> : null}
        <div className="tray__head-actions">
          {shots.length > 0 ? (
            <button
              type="button"
              className="ghost-btn tray__act"
              title="Delete every shot on the shelf"
              onClick={() => void clearAll()}
            >
              Clear all
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-btn tray__act"
            title="Open the shots folder"
            onClick={() => void window.forge.shots.openFolder()}
          >
            <Icon name="folder" size={13} />
          </button>
        </div>
      </header>

      {shots.length === 0 ? (
        <div className="tray__body">
          <div className="tray__tiles" aria-hidden="true">
            <span className="tray__tile" />
            <span className="tray__tile" />
            <span className="tray__tile" />
          </div>
          <p className="tray__note">
            {state.settings.catchShots ? (
              <>
                Screenshots you take land here
                <span className="tray__hint mono">Win + Shift + S</span>
              </>
            ) : (
              'Catching screenshots is switched off in settings'
            )}
          </p>
        </div>
      ) : (
        <div
          className="tray__strip"
          ref={stripRef}
          data-busy={busy ? 'true' : undefined}
          onScroll={measureEdges}
        >
          {shots.map((shot) => (
            <Thumb
              key={shot.id}
              shot={shot}
              unseen={unseen.includes(shot.id)}
              onCopy={() => void copyShot(shot)}
              onRemove={() => void removeShot(shot)}
            />
          ))}
        </div>
      )}

      {toast ? <div className="tray__toast">{toast}</div> : null}
    </section>
  )
}

/* ------------------------------------------------------------------ thumb */

function Thumb({
  shot,
  unseen,
  onCopy,
  onRemove
}: {
  shot: Shot
  unseen: boolean
  onCopy: () => void
  onRemove: () => void
}): ReactNode {
  const stamp = new Date(shot.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dims = shot.width > 0 ? `${shot.width} x ${shot.height}` : 'image'
  const weight =
    shot.bytes >= 1024 * 1024 ? `${(shot.bytes / 1048576).toFixed(1)} MB` : `${Math.round(shot.bytes / 1024)} KB`

  return (
    <div className="shot" data-unseen={unseen ? 'true' : undefined}>
      <button
        type="button"
        className="shot__btn"
        title={`${shot.name}\n${dims} · ${weight} · ${stamp}\nClick to copy · drag out as a file`}
        draggable
        onDragStart={(e) => {
          // Hand the drag to the OS: startDrag replaces the web drag with a real
          // shell file drag, which is what makes a drop into a Claude Code pane,
          // Explorer or a browser work.
          e.preventDefault()
          window.forge.shots.startDrag(shot.path)
        }}
        onClick={onCopy}
      >
        {shot.thumb ? <img className="shot__img" src={shot.thumb} alt={shot.name} draggable={false} /> : null}
        <span className="shot__stamp mono">{stamp}</span>
      </button>
      <button
        type="button"
        className="shot__kill"
        title="Remove this shot"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        <Icon name="close" size={9} />
      </button>
    </div>
  )
}

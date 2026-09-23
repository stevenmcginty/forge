import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCanvasFeed } from '@/hooks/useHub'
import { usePresence } from '@/lib/motion'
import { useShellMode } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { Preview } from './BoardSurface'
import './BoardArrival.css'

/**
 * Something new on the board while you are looking elsewhere: a small tile
 * rises at the bottom right with its picture and one button to go and see.
 * It sinks by itself after a few seconds; on the board itself the new tile
 * announces itself instead, so this stays quiet there.
 */
const SHOW_MS = 7000

export function BoardArrival(): ReactNode {
  const feed = useCanvasFeed()
  const mode = useShellMode()
  const [shown, setShown] = useState<{ id: string; count: number } | null>(null)
  const announced = useRef('')

  const key = feed.justAdded.join('|')
  useEffect(() => {
    if (!key || key === announced.current) return undefined
    announced.current = key
    if (mode === 'board') return undefined
    setShown({ id: feed.justAdded[0]!, count: feed.justAdded.length })
    const t = window.setTimeout(() => setShown(null), SHOW_MS)
    return () => window.clearTimeout(t)
    // mode is read, not watched: switching to the board must not re-announce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (mode === 'board') setShown(null)
  }, [mode])

  const item = shown ? feed.items.find((i) => i.id === shown.id) : null
  const { mounted, closing } = usePresence(!!item, 200)
  const last = useRef(item)
  if (item) last.current = item
  const view = item ?? last.current
  if (!mounted || !view) return null

  return (
    <div className="barrive" data-state={closing ? 'closing' : 'open'} role="status" aria-live="polite">
      <span className="barrive__thumb">
        <Preview item={view} feed={feed} />
      </span>
      <span className="barrive__text">
        <span className="barrive__eyebrow">
          New on the board{shown && shown.count > 1 ? ` · ${shown.count}` : ''}
        </span>
        <span className="barrive__title truncate">{view.title}</span>
      </span>
      <button
        type="button"
        className="barrive__show"
        onClick={() => {
          setShown(null)
          uiCommands.run('set-mode', 'board')
        }}
      >
        Show
      </button>
      <button type="button" className="barrive__x" aria-label="Dismiss" onClick={() => setShown(null)}>
        ×
      </button>
    </div>
  )
}

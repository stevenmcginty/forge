import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePresence } from '@/lib/motion'
import { useApp } from '@/state/AppState'

/**
 * The app's one-line notices ("Session limit reached", "Dictated text copied"),
 * which used to sit in the status bar, as a tile that rises at the bottom right
 * in the dock's own chrome and sinks again when app state clears it (4.2s).
 *
 * The text is held through the exit animation, so the tile does not go blank
 * while it fades.
 */
export function DeckToast(): ReactNode {
  const { state } = useApp()
  const notice = state.notice
  const [shown, setShown] = useState(notice)
  const { mounted, closing } = usePresence(notice !== null, 200)
  const key = useRef(0)

  useEffect(() => {
    if (notice === null) return
    key.current++
    setShown(notice)
  }, [notice])

  if (!mounted || !shown) return null
  return (
    <div className="dtoast" data-state={closing ? 'closing' : 'open'} role="status" aria-live="polite" key={key.current}>
      <span className="dtoast__mark" aria-hidden="true" />
      <span className="dtoast__text">{shown}</span>
    </div>
  )
}

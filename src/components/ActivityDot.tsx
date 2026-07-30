import { useEffect, useRef, type ReactNode } from 'react'
import { terminalHost, type PaneStatus } from '@/lib/terminals'
import './ActivityDot.css'

const ACTIVITY_HOLD_MS = 620

/**
 * The little "this shell is saying something" light.
 *
 * It drives itself: the pulse is added and removed straight on the DOM node
 * rather than through React state, because output arrives in bursts and a
 * re-render per burst — times sixteen tiles — is exactly the kind of thing that
 * makes a mosaic feel expensive.
 */
export function ActivityDot({ paneId, status }: { paneId: string; status: PaneStatus }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let timer: number | undefined
    const unsub = terminalHost.subscribeActivity(paneId, () => {
      const dot = ref.current
      if (!dot) return
      dot.classList.add('is-active')
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => dot.classList.remove('is-active'), ACTIVITY_HOLD_MS)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [paneId])

  return <span ref={ref} className="activity-dot" data-status={status} aria-hidden="true" />
}

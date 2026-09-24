import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { formatCombo } from '@/lib/keymap'
import { keyForCommand, runCommand, subscribeKeymap } from '@/lib/keymapRegistry'
import './PaneCarousel.css'

/** How long the arrows stay up after the mouse last moved over the stage. */
const AWAKE_MS = 1500

/**
 * Full screen's carousel: two faint chevrons on the stage's left and right
 * edges that step to the previous and next terminal, wrapping at both ends.
 *
 * They are the keyboard's Previous / Next panel (Ctrl+PageUp / Ctrl+PageDown,
 * or whatever Steve rebound them to) with a mouse on them: a click runs that
 * very command, so the order is the Agents menu's (tabs in order, each tab's
 * panes in order), the switch is the one the menu and the voice tools make,
 * and focus lands in the new terminal the same way. There is no second notion
 * of "the pane you are on" here.
 *
 * Nearly invisible at rest; they wake while the mouse moves over the stage and
 * settle again after a moment. They sit in the stage's gutter, clear of the
 * terminal's glyphs and of xterm's scrollbar on the right (PaneCarousel.css
 * has the geometry). Not drawn with only one terminal — there is nowhere to go.
 */
export function PaneCarousel({
  rootRef,
  count
}: {
  /** The stage the terminals sit on: moving over it wakes the arrows. */
  rootRef: RefObject<HTMLElement | null>
  /** Terminals in the project — the carousel's length. */
  count: number
}): ReactNode {
  const [awake, setAwake] = useState(false)
  const awakeRef = useRef(false)
  const prevKey = useSyncExternalStore(subscribeKeymap, () => keyForCommand('pane.prev'))
  const nextKey = useSyncExternalStore(subscribeKeymap, () => keyForCommand('pane.next'))
  const enabled = count > 1

  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return
    let timer: number | null = null
    const sleep = (): void => {
      timer = null
      awakeRef.current = false
      setAwake(false)
    }
    const wake = (): void => {
      if (!awakeRef.current) {
        awakeRef.current = true
        setAwake(true)
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(sleep, AWAKE_MS)
    }
    root.addEventListener('pointermove', wake, { passive: true })
    root.addEventListener('pointerleave', sleep)
    return () => {
      root.removeEventListener('pointermove', wake)
      root.removeEventListener('pointerleave', sleep)
      if (timer !== null) window.clearTimeout(timer)
      awakeRef.current = false
    }
  }, [rootRef, enabled])

  if (!enabled) return null

  const arrow = (side: 'prev' | 'next'): ReactNode => {
    const key = side === 'prev' ? prevKey : nextKey
    const label = side === 'prev' ? 'Previous agent' : 'Next agent'
    return (
      <button
        type="button"
        className="pcar__btn"
        data-side={side}
        aria-label={label}
        title={key ? `${label} (${formatCombo(key)})` : label}
        // Keep the keyboard in the terminal: the command focuses the new one.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runCommand(side === 'prev' ? 'pane.prev' : 'pane.next')}
      >
        <svg className="pcar__chev" viewBox="0 0 5 26" aria-hidden="true">
          <path d={side === 'prev' ? 'M4.25 1L0.75 13l3.5 12' : 'M0.75 1l3.5 12-3.5 12'} />
        </svg>
      </button>
    )
  }

  return (
    <div className="pcar" data-awake={awake ? 'true' : undefined}>
      {arrow('prev')}
      {arrow('next')}
    </div>
  )
}

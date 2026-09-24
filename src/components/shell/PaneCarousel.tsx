import { useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { formatCombo } from '@/lib/keymap'
import { keyForCommand, runCommand, subscribeKeymap } from '@/lib/keymapRegistry'
import './PaneCarousel.css'

export interface PaneCarouselProps {
  /** The stage the terminals sit on (kept for caller compatibility). */
  rootRef?: RefObject<HTMLElement | null>
  /** Terminals in the project — the carousel's length. */
  count: number
}

/**
 * Full screen's carousel: left and right navigation arrows that step to the
 * previous and next terminal, wrapping at both ends.
 *
 * They are the keyboard's Previous / Next panel (Ctrl+PageUp / Ctrl+PageDown,
 * or whatever Steve rebound them to) with a mouse on them: a click runs that
 * very command, so the order is the Agents menu's (tabs in order, each tab's
 * panes in order), the switch is the one the menu and the voice tools make,
 * and focus lands in the new terminal the same way.
 *
 * Consistently visible and easily identifiable floating glass paddles that sit
 * cleanly at the stage edges without being visually intrusive or distracting.
 * Not drawn with only one terminal — there is nowhere to go.
 */
export function PaneCarousel({
  count
}: PaneCarouselProps): ReactNode {
  const prevKey = useSyncExternalStore(subscribeKeymap, () => keyForCommand('pane.prev'))
  const nextKey = useSyncExternalStore(subscribeKeymap, () => keyForCommand('pane.next'))
  const enabled = count > 1

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
        <svg className="pcar__chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          {side === 'prev' ? (
            <path d="M10 3.5L5.5 8l4.5 4.5" />
          ) : (
            <path d="M6 3.5L10.5 8 6 12.5" />
          )}
        </svg>
      </button>
    )
  }

  return (
    <div className="pcar">
      {arrow('prev')}
      {arrow('next')}
    </div>
  )
}

import type { ReactNode } from 'react'
import { useForge } from '../state'
import './WaitingPill.css'

/**
 * "! 2 waiting" — every pane in every project that has settled on a question.
 *
 * The one cross-project signal that is on screen while the page is: the OS
 * notification only fires while the tab is hidden, and the drawer's per-project
 * dot sits inside a drawer that is shut. A tap goes to the next waiting pane
 * (`nextWaiting`, the same jump a notification tap makes), and repeated taps
 * cycle through them.
 *
 * A shape and words, not a colour: the "!" in its filled circle and the count
 * say it on their own, for a reader who cannot tell amber from green.
 *
 * Standalone so the top bar can be rearranged around it without touching it.
 * On a phone narrower than 375px the word drops and "! 2" stays, so the
 * project name beside it keeps room to be read; the label still says it all.
 */
export function WaitingPill(): ReactNode {
  const { state, actions } = useForge()
  const count = state.waiting.length
  if (count === 0) return null
  return (
    <button
      type="button"
      className="waitpill"
      data-testid="waiting-pill"
      aria-label={`${count} ${count === 1 ? 'pane is' : 'panes are'} waiting on you — go to the next one`}
      title="Go to the next pane waiting on you"
      onClick={actions.nextWaiting}
    >
      <span className="waitpill__face">
        <span className="waitpill__bang" aria-hidden="true">
          !
        </span>
        <span className="waitpill__text">
          {count}
          <span className="waitpill__word"> waiting</span>
        </span>
      </span>
    </button>
  )
}

/** The count on the ☰ button: the same number, for a drawer that is shut. */
export function WaitingBadge(): ReactNode {
  const { state } = useForge()
  const count = state.waiting.length
  if (count === 0) return null
  return (
    <span className="waitbadge" data-testid="waiting-badge" aria-hidden="true">
      {count > 9 ? '9+' : count}
    </span>
  )
}

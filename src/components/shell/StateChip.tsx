import type { ReactNode } from 'react'
import { ACTIVITY_WORD, activityClock, type PaneActivity } from '@/lib/paneActivity'
import './StateChip.css'

/**
 * A pane's state, said three ways at once: a shape, a word, and a colour — in
 * that order of importance, because the colour is the one Steve cannot rely on.
 * "Working 12m", "Needs you", "Done", "Ready".
 */
export function StateChip({ activity, compact = false }: { activity: PaneActivity; compact?: boolean }): ReactNode {
  const clock = activityClock(activity)
  return (
    <span className="statechip" data-state={activity.state} title={titleFor(activity, clock)}>
      <StateGlyph state={activity.state} />
      <span className="statechip__word">{ACTIVITY_WORD[activity.state]}</span>
      {clock && !compact ? <span className="statechip__clock">{clock}</span> : null}
    </span>
  )
}

function titleFor(activity: PaneActivity, clock: string): string {
  switch (activity.state) {
    case 'working':
      return clock ? `Working for ${clock}` : 'Working'
    case 'attention':
      return clock ? `Waiting for you for ${clock}` : 'Waiting for you'
    case 'done':
      return 'Finished — the pane went quiet after a long stretch of work'
    case 'idle':
      return 'Ready — quiet at its prompt'
    case 'starting':
      return 'Starting'
    case 'dormant':
      return 'Not opened yet this session — it starts when its tab is shown'
    case 'exited':
      return 'The process exited'
    case 'failed':
      return 'The pane failed to start'
  }
}

/** Filled dot, diamond, tick, ring, dotted ring, dash, square — distinct in outline alone. */
export function StateGlyph({ state }: { state: PaneActivity['state'] }): ReactNode {
  return (
    <svg className="statechip__glyph" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'working' ? <circle cx="5" cy="5" r="3.6" fill="currentColor" /> : null}
      {state === 'attention' ? <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="currentColor" /> : null}
      {state === 'done' ? (
        <path d="M1.4 5.4 L4 7.8 L8.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {state === 'idle' ? <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'starting' ? (
        <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
      ) : null}
      {state === 'dormant' ? <rect x="1.5" y="4.2" width="7" height="1.6" rx="0.8" fill="currentColor" /> : null}
      {state === 'exited' || state === 'failed' ? <rect x="1.6" y="1.6" width="6.8" height="6.8" rx="1" fill="currentColor" /> : null}
    </svg>
  )
}

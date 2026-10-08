import type { ReactNode } from 'react'
import type { AgentStatus, MiniBarCall, MiniBarState } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { STATUS_WORD } from './format'
import { BellGlyph, GripGlyph, StateMark, StopSquare } from './glyphs'

/** The states worth a count on the pill, in the order they are read. */
const COUNTED: AgentStatus[] = ['asking', 'done', 'working', 'waiting', 'stopped']

/**
 * Tucked: the bar folded to a pill at the same spot (spec 4.12) —
 * `( :: forge · ?1 ✓2 ◌3 · mic )`. Counts per state, each with its shape;
 * the mic still dictates; a press on the middle unfolds the bar. Toasts and
 * spoken updates carry on above it.
 */
export function Pill({ state, call }: { state: MiniBarState; call: (c: MiniBarCall) => void }): ReactNode {
  const counts = COUNTED.map((s) => ({ s, n: state.agents.filter((a) => a.status === s).length })).filter((c) => c.n > 0)
  const recording = state.dictation.phase === 'listening'
  const said = counts.map((c) => `${c.n} ${STATUS_WORD[c.s].toLowerCase()}`).join(', ')

  return (
    <div className="mb-pill">
      <span className="mb-grip mb-grip--pill" title="Drag to move">
        <GripGlyph />
      </span>
      <button
        type="button"
        className="mb-pill__body"
        title="Unfold the bar"
        aria-label={`Unfold the bar. ${state.project?.name ?? ''}${said ? `: ${said}` : ''}`}
        onClick={() => call({ t: 'tuck', on: false })}
      >
        <span className="mb-pill__name">{state.project?.name ?? 'Forge'}</span>
        {counts.length ? <span className="mb-pill__seam" aria-hidden="true" /> : null}
        {counts.map((c) => (
          <span key={c.s} className="mb-pill__count" data-status={c.s} title={`${c.n} ${STATUS_WORD[c.s]}`}>
            <StateMark status={c.s} size={10} />
            {c.n}
          </span>
        ))}
        {state.unseen > 0 ? (
          <span className="mb-pill__news" title={`${state.unseen} new in Activity`}>
            <BellGlyph />
            {state.unseen}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="mb-mic mb-mic--pill"
        data-look={recording ? 'rec' : state.dictation.phase === 'writing' ? 'busy' : 'idle'}
        aria-pressed={recording}
        title={recording ? 'Stop dictating' : 'Dictate'}
        aria-label={recording ? 'Stop dictating' : 'Dictate'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => call({ t: 'dictate' })}
      >
        <span className="mb-mic__glyph">{recording ? <StopSquare /> : <Icon name="mic" size={15} />}</span>
      </button>
    </div>
  )
}

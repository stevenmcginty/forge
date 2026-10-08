import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { MiniBarState } from '@shared/minibar'
import { Icon } from '@/components/Icon'
import { fmtClock } from './format'
import { Sheet } from './Sheet'

/**
 * Chat with Forge: the last ten turns, "You" and "Forge", newest at the
 * foot, beside the bar where the next one is typed. Unlike the big bar's
 * captions nothing fades; the panel itself steps away 20 s after the last
 * turn unless the pointer rests on it or Listen is on (MiniBarView).
 */
export function Chat({
  state,
  onClose,
  onHold
}: {
  state: MiniBarState
  onClose: () => void
  onHold: (held: boolean) => void
}): ReactNode {
  const turns = state.thread.slice(-10)
  const list = useRef<HTMLOListElement | null>(null)
  const last = turns[turns.length - 1]?.at ?? 0
  useLayoutEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last, turns.length])

  const word = state.listen.on ? (state.listen.speaking ? 'Speaking' : state.listen.muted ? 'Muted' : 'Listening') : null

  return (
    <Sheet
      className="mb-chat"
      label="Chat with Forge"
      onClose={onClose}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
      head={
        <>
          <span className="mb-chat__mark" aria-hidden="true">
            <Icon name="forge" size={15} />
          </span>
          <span className="mb-peek__who">
            <span className="mb-peek__name">Forge</span>
            <span className="mb-peek__meta">Ask anything; Forge can act on every project</span>
          </span>
          {word ? (
            <span className="mb-statepill" data-status="working" data-listen="true">
              <span className="mb-live" aria-hidden="true" />
              {word}
            </span>
          ) : null}
        </>
      }
    >
      {turns.length ? (
        <ol ref={list} className="mb-sheet__body mb-chat__list">
          {turns.map((t, i) => (
            <li key={`${t.at}-${i}`} className="mb-turn" data-who={t.who}>
              <span className="mb-turn__who">{t.who === 'you' ? 'You' : 'Forge'}</span>
              <p className="mb-turn__text">{t.text}</p>
              <time className="mb-turn__at">{fmtClock(t.at)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mb-sheet__empty">Nothing yet. Type below, or press Listen and talk.</p>
      )}
    </Sheet>
  )
}

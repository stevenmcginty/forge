import type { ReactNode } from 'react'
import { splitSpoken } from './format'
import type { LivePhase, LiveView } from './types'

interface Props {
  caption: LiveView['caption']
  phase: LivePhase
}

/**
 * What was just said, rising out of the bar: Steve's words on a small YOU
 * line, Forge's big underneath — the words the voice has reached bright, the
 * rest still dim, a caret at the voice. Nothing to press; they come and go
 * with the view.
 */
export function LiveCaptions({ caption, phase }: Props): ReactNode {
  const you = caption.you?.trim()
  const forge = caption.forge?.trim()
  if (!you && !forge) return null
  const hearing = phase === 'hearing'
  const parts = forge ? splitSpoken(forge, caption.forgeSpokenChars) : null
  const speaking = phase === 'speaking' && parts !== null && parts.rest.length > 0
  return (
    <div className="live-caps" role="region" aria-label="Live captions">
      {you ? (
        <p className="live-cap live-cap--you" data-hearing={hearing ? 'true' : undefined}>
          <span className="live-cap__who">You</span>
          <span className="live-cap__text">
            {you}
            {hearing ? <span className="live-caret live-caret--you" aria-hidden="true" /> : null}
          </span>
        </p>
      ) : null}
      {parts ? (
        <p className="live-cap live-cap--forge">
          <span className="live-cap__who">Forge</span>
          <span className="live-cap__text">
            {parts.lead ? <span className="live-cap__next">… </span> : null}
            <span className="live-cap__said">{parts.said}</span>
            {speaking ? <span className="live-caret" aria-hidden="true" /> : null}
            {parts.rest ? <span className="live-cap__next">{parts.rest}</span> : null}
          </span>
        </p>
      ) : null}
    </div>
  )
}

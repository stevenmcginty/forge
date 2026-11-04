import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  LIVE_CARD_DONE_MS,
  LIVE_CARD_WORDS,
  liveCardChoices,
  liveCardHeadline,
  type LiveCardChoice,
  type LiveCardOffer
} from '@shared/live-card'
import { applyTheme, findTheme } from '@/theme/themes'
import { useClickThrough } from './useClickThrough'
import '@/components/shell/deck-tokens.css'
import './LiveCardApp.css'

/** The card itself; the rest of the window lets clicks through. */
const LIVECARD_SOLID = '.lcard'

/** A glyph beside each word, so no state or button is told by colour alone. */
const CHOICE_GLYPH: Record<LiveCardChoice, string> = { push: '▶', show: '◎', later: '–' }

/**
 * The #livecard window's whole tree (src/main.tsx), no providers: Claude
 * Live's desktop card (electron/live-card-window.ts, shared/live-card.ts).
 * "Lena needs you" stays until he answers; "Lena is done" fades after
 * LIVE_CARD_DONE_MS. A new card replaces the one up. The window never takes
 * focus; every button is a plain click, nothing is hover-only.
 */
export function LiveCardApp(): ReactNode {
  const api = window.forge.liveCard
  const [offer, setOffer] = useState<LiveCardOffer | null>(null)
  const offerRef = useRef<LiveCardOffer | null>(null)
  offerRef.current = offer

  useLayoutEffect(() => {
    document.documentElement.dataset['livecardView'] = 'true'
  }, [])
  useClickThrough(LIVECARD_SOLID, api?.setClickThrough)
  useEffect(() => {
    void window.forge.store
      .snapshot()
      .then((s) => applyTheme(findTheme(s.settings.themeId, s.settings.customThemes)))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (typeof api?.onShow !== 'function') return undefined
    return api.onShow((next) => setOffer(next))
  }, [api])

  // "Done" news goes by itself; "needs you" waits for him.
  useEffect(() => {
    if (!offer || offer.urgency !== 'done') return undefined
    const id = offer.id
    const t = window.setTimeout(() => {
      if (offerRef.current?.id !== id) return
      setOffer(null)
      api?.done()
    }, LIVE_CARD_DONE_MS)
    return () => window.clearTimeout(t)
  }, [offer, api])

  if (!api || !offer) return null

  const choose = (choice: LiveCardChoice): void => {
    const answer = offer.jobId ? { id: offer.id, jobId: offer.jobId, choice } : { id: offer.id, choice }
    setOffer(null)
    api.answer(answer)
  }
  const needs = offer.urgency === 'needs-you'

  return (
    <div className="lcard" data-urgency={offer.urgency} role="alert" aria-live="assertive">
      <div className="lcard__head">
        <span className="lcard__mark" aria-hidden="true">
          {needs ? '◆' : '✓'}
        </span>
        <span className="lcard__state">{needs ? 'Needs you' : 'Done'}</span>
        <span className="lcard__from">Claude Live</span>
      </div>
      <p className="lcard__title">{liveCardHeadline(offer)}</p>
      <p className="lcard__text">{offer.text}</p>
      <div className="lcard__acts">
        {liveCardChoices(offer).map((choice) => (
          <button key={choice} type="button" className="lcard__btn" data-choice={choice} onClick={() => choose(choice)}>
            <span aria-hidden="true">{CHOICE_GLYPH[choice]}</span>
            {LIVE_CARD_WORDS[choice]}
          </button>
        ))}
      </div>
    </div>
  )
}

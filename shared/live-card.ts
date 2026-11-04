import type { LiveJob, LiveNewsUrgency } from './live'

/**
 * Claude Live's desktop card (electron/live-card-window.ts, the #livecard
 * window): while Forge is minimised or not in front, a crew member who needs
 * Steve — or has finished — pops a small card at the top right of the screen.
 * "Lena needs you — Push it / Show me / Later". The spoken line still plays.
 *
 * The main renderer offers the card (it hears the `news` events, it knows the
 * ledger); main decides whether Forge is away and shows it; a tap goes back
 * through main to the main renderer, which does what the rail's flyout does.
 * Dependency-free: shared by main, the card and the main renderer.
 */

/** Only these become cards; 'info' never does. */
export type LiveCardUrgency = Exclude<LiveNewsUrgency, 'info'>

export interface LiveCardOffer {
  /** The news id; a second offer with the same id is the same card. */
  id: string
  jobId?: string
  /** Who: the crew member's name ("Lena"), or "Forge". */
  who: string
  /** The news line, as spoken. */
  text: string
  urgency: LiveCardUrgency
  /** The job has a pane, so "Show me" can lift it. */
  canShow: boolean
}

export type LiveCardChoice = 'push' | 'show' | 'later'

export interface LiveCardAnswer {
  id: string
  jobId?: string
  choice: LiveCardChoice
}

/** The buttons' words. Never colour alone: each also has its own place and glyph on the card. */
export const LIVE_CARD_WORDS: Record<LiveCardChoice, string> = {
  push: 'Push it',
  show: 'Show me',
  later: 'Later'
}

/** A finished card fades after this long; one that needs him stays until he answers. */
export const LIVE_CARD_DONE_MS = 12_000

/** The name the rail gives a crew member (src/components/live/format.ts `crewName`). */
export function liveCardWho(job: Pick<LiveJob, 'paneName' | 'owner' | 'title'> | undefined): string {
  if (!job) return 'Forge'
  if (job.paneName) return job.paneName
  if (job.owner === 'operator') return 'Operator'
  if (job.owner === 'conductor') return 'Forge'
  return job.title || 'Forge'
}

/** A `news` event as a card, or null when it is not one (info, or no words). */
export function liveCardFor(
  news: { id: string; jobId?: string; text: string; urgency: LiveNewsUrgency },
  jobs: readonly LiveJob[]
): LiveCardOffer | null {
  if (news.urgency !== 'needs-you' && news.urgency !== 'done') return null
  const text = String(news.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const job = news.jobId ? jobs.find((j) => j.id === news.jobId) : undefined
  const offer: LiveCardOffer = {
    id: String(news.id),
    who: liveCardWho(job),
    text: text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text,
    urgency: news.urgency,
    canShow: Boolean(job?.paneId)
  }
  if (news.jobId) offer.jobId = news.jobId
  return offer
}

/** "Lena needs you" / "Lena is done" — the card's head line. */
export function liveCardHeadline(offer: Pick<LiveCardOffer, 'who' | 'urgency'>): string {
  return offer.urgency === 'needs-you' ? `${offer.who} needs you` : `${offer.who} is done`
}

/**
 * The card's buttons, in order. "Push it" says yes for him, so it needs a job
 * waiting on him; "Show me" needs a pane; "Later" is always there.
 */
export function liveCardChoices(offer: Pick<LiveCardOffer, 'urgency' | 'jobId' | 'canShow'>): LiveCardChoice[] {
  const out: LiveCardChoice[] = []
  if (offer.urgency === 'needs-you' && offer.jobId) out.push('push')
  if (offer.canShow) out.push('show')
  out.push('later')
  return out
}

/** What "Push it" says to the voice brain — the rail flyout's "Yes, go ahead" line, word for word. */
export function livePushLine(who: string): string {
  return `Yes, ${who} can go ahead.`
}

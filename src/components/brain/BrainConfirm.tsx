import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BrainConfirmRequest } from '@shared/brain'
import { usePresence } from '@/lib/motion'
import { WarnShape } from './BrainContext'
import { startBrainFeed, useBrain } from './brainStore'
import './BrainConfirm.css'

/** The risk in words — BrainMap's `RISK_WORD`, the same three. */
const RISK_WORD: Record<string, string> = { low: 'Low risk', medium: 'Some risk', high: 'High risk' }

/**
 * Forge Brain wants a yes before it does something (shared/brain.ts
 * `BrainConfirmRequest`), on every screen: the terminals, the Wall, the
 * browser, the Board, the map, Settings.
 *
 * The Yes and No used to live only inside the Brain map, behind a badge on the
 * top bar's icon. Steve said "Yeah" out loud, never saw them, and the question
 * timed out as a no. So the oldest one waiting is a notice tile here — a
 * warning triangle, "Forge Brain asks", what it will do, the risk in words,
 * Yes and No — with "+N more" when others wait behind it. It is also said
 * aloud and answered by voice (src/state/VoiceAgent.tsx).
 *
 * In the notice corner, above the dock: a native page (the browser, a chat
 * tab) only trims its bottom edge for a `.dtoast` there (browser/overlays.ts),
 * where a tile anywhere else would be drawn under it. Mounted once, by App.
 * The gate runs whether Forge Brain is on or off, so nothing here reads
 * `status.enabled`. No keyboard shortcut and no focus taken: the terminals own
 * the keys.
 */
export function BrainConfirm(): ReactNode {
  const { status } = useBrain()
  useEffect(() => startBrainFeed(), [])

  const list: BrainConfirmRequest[] = Array.isArray(status?.confirms) ? status.confirms : []
  const first = list[0] ?? null
  const more = Math.max(0, list.length - 1)

  /** The question a press has answered: its buttons stay off until the status moves on. */
  const [sent, setSent] = useState<string | null>(null)

  // Held through the exit animation, so the tile does not go blank while it fades.
  const { mounted, closing } = usePresence(first !== null, 200)
  const [shown, setShown] = useState<{ ask: BrainConfirmRequest; more: number } | null>(null)
  useEffect(() => {
    if (first) setShown({ ask: first, more })
  }, [first, more])

  const answer = (id: string, allow: boolean): void => {
    setSent(id)
    const send = window.forge.brain?.confirm
    void (send ? send({ id, allow }) : Promise.resolve(false))
      // Not taken (it had already timed out, or this preload has no brain): the status says what is true.
      .then((taken) => {
        if (!taken) setSent((cur) => (cur === id ? null : cur))
      })
      .catch(() => setSent((cur) => (cur === id ? null : cur)))
  }

  if (!mounted || !shown) return null
  const { ask } = shown
  const what = ask.summary?.trim() || ask.tool || 'An action'
  const busy = closing || sent === ask.id
  // To the body, like the context notice: one tile over every page.
  return createPortal(
    <div
      className="dtoast bconf"
      key={ask.id}
      data-state={closing ? 'closing' : 'open'}
      data-risk={ask.risk}
      role="alert"
      // A press must not pull the keyboard out of the terminal he is typing in.
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="bconf__mark" aria-hidden="true">
        <WarnShape />
      </span>
      <span className="bconf__text">
        <span className="bconf__title">Forge Brain asks</span>
        <span className="bconf__what" title={what}>
          {what}
        </span>
        <span className="bconf__meta">
          <span className="bconf__risk">{RISK_WORD[ask.risk] ?? 'Asks first'}</span>
          {shown.more > 0 ? <span className="bconf__more">+{shown.more} more</span> : null}
        </span>
      </span>
      <span className="bconf__btns">
        <button type="button" className="bconf__btn bconf__btn--yes" disabled={busy} onClick={() => answer(ask.id, true)}>
          Yes
        </button>
        <button type="button" className="bconf__btn" disabled={busy} onClick={() => answer(ask.id, false)}>
          No
        </button>
      </span>
    </div>,
    document.body
  )
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForge } from '../state'
import './BrainConfirm.css'

/** The risk in words — the desktop toast's, the same three. */
const RISK_WORD: Record<string, string> = { low: 'Low risk', medium: 'Some risk', high: 'High risk' }

/**
 * Forge Brain wants a yes before it does something (`BrainStatus.confirms`,
 * shared/brain.ts) — the desktop's toast, on this browser. The question waits
 * two minutes and then counts as a no, and the person who can answer it may be
 * holding only the phone.
 *
 * The oldest one waiting: a warning triangle, "Forge Brain asks", what it will
 * do, the risk in words, Yes and No, and "+N more" when others wait behind it.
 * Only this card: Forge Web draws no brain icon, map or chat.
 *
 *   phone   over the top of the display, full width, where AskBanner sits (and
 *           over it: this one has a clock on it). Thumb-sized buttons, and a
 *           short buzz when a new question lands.
 *   deck    a compact tile, top centre, under the bar.
 *
 * The buttons go off after a press until the desktop's `brain` push takes the
 * question away; a refusal ("no longer waiting", a dropped link) is said on
 * the card and they come back.
 */
export function BrainConfirm({ face }: { face: 'phone' | 'deck' }): ReactNode {
  const { state, actions } = useForge()
  const list = state.brainConfirms
  const first = list[0] ?? null

  /** The question a press has answered. */
  const [sent, setSent] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ id: string; why: string } | null>(null)

  // A new question on the phone: a short buzz, once per question. Guarded — a
  // browser with no vibration, or one that has not been touched yet, ignores it.
  const buzzed = useRef(new Set<string>())
  useEffect(() => {
    let fresh = false
    for (const c of list) {
      if (buzzed.current.has(c.id)) continue
      buzzed.current.add(c.id)
      fresh = true
    }
    if (!fresh || face !== 'phone') return
    try {
      navigator.vibrate?.([40, 60, 40])
    } catch {
      // Not allowed here: the card is the announcement.
    }
  }, [list, face])

  if (!first) return null

  const answer = (allow: boolean): void => {
    const id = first.id
    setSent(id)
    setRefused(null)
    void actions.brainConfirm(id, allow).then((why) => {
      if (!why) return
      setSent((cur) => (cur === id ? null : cur))
      setRefused({ id, why })
    })
  }

  const what = first.summary?.trim() || first.tool || 'An action'
  const more = list.length - 1
  const busy = sent === first.id
  return (
    <div className="bconfirm" key={first.id} data-face={face} data-risk={first.risk} role="alert" data-testid="brain-confirm">
      <div className="bconfirm__head">
        <span className="bconfirm__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M12 3 22 20.5H2Z" />
            <path d="M12 10v5M12 17.6v.1" />
          </svg>
        </span>
        <span className="bconfirm__text">
          <span className="bconfirm__title">Forge Brain asks</span>
          <span className="bconfirm__what">{what}</span>
          <span className="bconfirm__meta">
            <span className="bconfirm__risk">{RISK_WORD[first.risk] ?? 'Asks first'}</span>
            {more > 0 ? <span className="bconfirm__more">+{more} more</span> : null}
          </span>
          {refused?.id === first.id ? <span className="bconfirm__refused">× {refused.why}</span> : null}
        </span>
      </div>
      <div className="bconfirm__btns">
        <button type="button" className="bconfirm__btn bconfirm__btn--yes" disabled={busy} onClick={() => answer(true)}>
          Yes
        </button>
        <button type="button" className="bconfirm__btn" disabled={busy} onClick={() => answer(false)}>
          No
        </button>
      </div>
    </div>
  )
}

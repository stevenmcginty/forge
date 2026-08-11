import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MobileApprovalEvent } from '@shared/types'
import './ApprovalPrompt.css'

/**
 * "A phone calling itself 'Pixel 8' wants to connect."
 *
 * The desktop half of tap-to-pair. The phone is showing a word pair; this card
 * shows the same pair in large type and asks Steve to compare them, because a
 * glance-comparison of two words is a check a human actually performs and a
 * six-digit code is not. Allow lets that device into a shell on this machine,
 * and the card says so in one sentence rather than a wall of warning nobody
 * reads.
 *
 * ## It used to be two doors
 *
 * Forge Web asked the same question through this same card, and does not any
 * more: a browser is admitted by a verified Firebase ID token for the one
 * configured account plus the desktop's unlock PIN, with no prompt at this desk
 * at all (electron/web/auth.ts). The reason the split is gone rather than
 * merely unused is that the argument for one card was that the *question* was
 * identical — "are these the same two words?" — and there is no longer a second
 * question to be identical to. What is left is honestly Forge Mobile's card, so
 * it says so; nothing is renamed, because this is still the one place that
 * question is asked.
 *
 * Three deliberate choices, all unchanged:
 *
 *  - **Deny takes default focus.** Enter, Space or Escape all land on no; yes
 *    requires reaching for it. Any prompt whose easiest reflex is Allow will
 *    eventually be allowed by reflex.
 *  - Meaning is carried by text and position, never by colour alone — Steve is
 *    red-green colourblind, and a green-tick/red-cross pair would read as two
 *    grey buttons.
 *  - The card holds no state of its own beyond the current question. Main owns
 *    the timeout and withdraws the prompt (`open: false`) when the question is
 *    moot — answered elsewhere, timed out, or the phone gave up — so nothing
 *    here can be answered late onto the wrong socket. A newly opened question
 *    replaces whatever is on screen, which is already what two phones asking at
 *    once does; the displaced question is not lost so much as unanswered, and
 *    main times it out as a deny.
 */

export function ApprovalPrompt(): ReactNode {
  const [ask, setAsk] = useState<MobileApprovalEvent | null>(null)
  const denyRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    return window.forge.mobile.onApproval((e) => {
      setAsk((current) => {
        if (e.open) return e
        return current && current.requestId === e.requestId ? null : current
      })
    })
  }, [])

  useEffect(() => {
    if (ask) denyRef.current?.focus()
  }, [ask])

  const answer = useCallback(
    (allow: boolean) => {
      if (!ask) return
      window.forge.mobile.approvalResult(ask.requestId, allow)
      setAsk(null)
    },
    [ask]
  )

  if (!ask) return null

  const words = ask.words
  const deviceName = ask.deviceName
  const known = ask.known

  return (
    <div className="approval" role="alertdialog" aria-modal="true" aria-label="A phone wants to connect">
      <div
        className="approval__card"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') answer(false)
        }}
      >
        <div className="eyebrow approval__eyebrow">Forge Mobile</div>
        <h1 className="approval__title">
          {known ? 'A device you paired is asking again' : 'A phone wants to connect'}
        </h1>
        <p className="approval__body">
          {known ? (
            <>
              <strong className="approval__name">“{deviceName}”</strong> is already in your paired list and is
              asking to reconnect — usually because this computer’s address on the network changed while it was away.
              Its screen should be showing:
            </>
          ) : (
            <>
              A phone calling itself <strong className="approval__name">“{deviceName}”</strong> is asking to pair.
              Its screen should be showing:
            </>
          )}
        </p>
        <div className="approval__words mono" aria-label={`The words ${words}`}>
          {words}
        </div>
        <p className="approval__grant">
          Allow gives that phone a permanent key to your terminals — it can type into your shells as you.
          If the words don’t match, or you weren’t pairing a phone just now, deny it.
        </p>
        <div className="approval__actions">
          <button ref={denyRef} type="button" className="approval__deny" onClick={() => answer(false)}>
            Deny
          </button>
          <button type="button" className="cta-btn approval__allow" onClick={() => answer(true)}>
            Allow — pair this phone
          </button>
        </div>
      </div>
    </div>
  )
}

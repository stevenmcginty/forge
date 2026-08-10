import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { APPROVAL_TIMEOUT_MS } from '@shared/web'
import type { MobileApprovalEvent, WebApprovalEvent } from '@shared/types'
import './ApprovalPrompt.css'

/**
 * "A phone calling itself 'Pixel 8' wants to connect."
 * "A browser calling itself 'Chrome on Windows' wants in."
 *
 * The desktop half of tap-to-pair, for both doors. The far end is showing a
 * word pair; this card shows the same pair in large type and asks Steve to
 * compare them, because a glance-comparison of two words is a check a human
 * actually performs and a six-digit code is not. Allow lets that device into a
 * shell on this machine, and the card says so in one sentence rather than a
 * wall of warning nobody reads.
 *
 * One card for two features rather than two cards, and that is the point: the
 * question is identical — *are these the same two words?* — and a second prompt
 * with its own layout, its own focus rules and its own idea of which button is
 * safe is exactly how one of them ends up with Allow under the Enter key. What
 * differs between the two is wording, and wording is all that differs here.
 *
 * Four deliberate choices:
 *
 *  - **Deny takes default focus.** Enter, Space or Escape all land on no; yes
 *    requires reaching for it. Any prompt whose easiest reflex is Allow will
 *    eventually be allowed by reflex.
 *  - Meaning is carried by text and position, never by colour alone — Steve is
 *    red-green colourblind, and a green-tick/red-cross pair would read as two
 *    grey buttons.
 *  - The card holds no state of its own beyond the current question. Main owns
 *    the timeout and withdraws the prompt (`open: false`) when the question is
 *    moot — answered elsewhere, timed out, or the far end gave up — so nothing
 *    here can be answered late onto the wrong socket. A withdrawal is matched
 *    on *both* the source and the request id: two features minting their own
 *    ids independently could collide, and a stale close must not eat a live
 *    question belonging to the other door.
 *  - A newly opened question replaces whatever is on screen. That is already
 *    what two phones asking at once does, and the displaced question is not
 *    lost so much as unanswered — main times it out as a deny, which is the
 *    only acceptable answer to a question nobody looked at.
 */

/**
 * The question on screen, whichever door it came through.
 *
 * `askedAt` is the renderer's own clock reading of when the event arrived, and
 * it is what the countdown runs from. Neither approval event carries a deadline
 * — main sets one at the instant it broadcasts (`APPROVAL_TIMEOUT_MS` in
 * shared/web.ts and shared/mobile.ts, the same two minutes) — so this is that
 * deadline plus one IPC hop, which is the honest approximation and errs by
 * showing slightly *more* time than remains rather than less.
 */
type Ask =
  | { source: 'mobile'; askedAt: number; event: MobileApprovalEvent }
  | { source: 'web'; askedAt: number; event: WebApprovalEvent }

export function ApprovalPrompt(): ReactNode {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const denyRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const stopMobile = window.forge.mobile.onApproval((e) => {
      setAsk((current) => {
        if (e.open) return { source: 'mobile', askedAt: Date.now(), event: e }
        return current && current.source === 'mobile' && current.event.requestId === e.requestId ? null : current
      })
    })
    const stopWeb = window.forge.web.onApproval((e) => {
      setAsk((current) => {
        if (e.open) return { source: 'web', askedAt: Date.now(), event: e }
        return current && current.source === 'web' && current.event.requestId === e.requestId ? null : current
      })
    })
    return () => {
      stopMobile()
      stopWeb()
    }
  }, [])

  useEffect(() => {
    if (ask) denyRef.current?.focus()
  }, [ask])

  // Only ticks while a question is up, and only for the door whose expiry the
  // card shows.
  useEffect(() => {
    if (ask?.source !== 'web') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ask])

  const answer = useCallback(
    (allow: boolean) => {
      if (!ask) return
      if (ask.source === 'web') window.forge.web.approvalResult(ask.event.requestId, allow)
      else window.forge.mobile.approvalResult(ask.event.requestId, allow)
      setAsk(null)
    },
    [ask]
  )

  if (!ask) return null

  const words = ask.event.words
  const deviceName = ask.event.deviceName
  const web = ask.source === 'web'
  const known = ask.source === 'mobile' && ask.event.known
  const secondsLeft = Math.max(0, Math.ceil((ask.askedAt + APPROVAL_TIMEOUT_MS - now) / 1000))

  return (
    <div
      className="approval"
      role="alertdialog"
      aria-modal="true"
      aria-label={web ? 'A browser wants to connect' : 'A phone wants to connect'}
    >
      <div
        className="approval__card"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') answer(false)
        }}
      >
        <div className="eyebrow approval__eyebrow">{web ? 'Forge Web' : 'Forge Mobile'}</div>
        <h1 className="approval__title">
          {web ? 'A browser wants in' : known ? 'A device you paired is asking again' : 'A phone wants to connect'}
        </h1>
        <p className="approval__body">
          {web ? (
            <>
              A browser calling itself <strong className="approval__name">“{deviceName}”</strong> has signed in and is
              asking to reach these terminals. Its screen should be showing:
            </>
          ) : known ? (
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
        {/* Which account asked. It is always the one account this desktop
            admits — a token for any other is refused before a prompt is ever
            raised — so this is here to be recognised rather than checked, and
            it is the uid because that is what the token actually verified as. */}
        {web && ask.event.uid && (
          <p className="approval__account">
            Signed in as <span className="mono">{ask.event.uid}</span>
          </p>
        )}
        <p className="approval__grant">
          {web ? (
            <>
              Allow lets that browser open and type into your shells, from wherever it is, until you revoke it in
              Settings › Forge Web. If the words don’t match the ones on the browser’s screen, or you weren’t opening
              Forge in a browser just now, deny it.
            </>
          ) : (
            <>
              Allow gives that phone a permanent key to your terminals — it can type into your shells as you.
              If the words don’t match, or you weren’t pairing a phone just now, deny it.
            </>
          )}
        </p>
        {web && (
          <p className="approval__ttl">
            {secondsLeft > 0
              ? `This question denies itself in ${secondsLeft}s if nobody answers it.`
              : 'Time is up — this has been denied.'}
          </p>
        )}
        <div className="approval__actions">
          <button ref={denyRef} type="button" className="approval__deny" onClick={() => answer(false)}>
            Deny
          </button>
          <button type="button" className="cta-btn approval__allow" onClick={() => answer(true)}>
            {web ? 'Allow — let this browser in' : 'Allow — pair this phone'}
          </button>
        </div>
      </div>
    </div>
  )
}

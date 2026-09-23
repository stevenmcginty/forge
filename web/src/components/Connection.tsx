import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS, WEB_PROTO, type WebRefusal } from '@shared/web'
import { Icon, type IconName } from '@/components/Icon'
import { useMobile } from '../lib/mobile'
import { useForge } from '../state'
import './Sheets.phone.css'

/**
 * The connection screens — the part of this client that is not a spinner.
 *
 * shared/web.ts is blunt about why these are several values rather than one
 * error string: "These are different sentences on screen and different recovery paths
 * — sign in again, sign in as somebody else, wait for a human, ask a human,
 * update the page, come back later — so they are different values rather than
 * one `error: string`. A client that collapses them into 'connection failed' has
 * thrown away the only thing that tells the user what to do next."
 *
 * So `recovery` below is a table over `WebRefusal`, exhaustive by the compiler
 * rather than by inspection, and every screen carries the *desktop's* sentence
 * plus the one thing this page can offer to do about it. The desktop writes the
 * diagnosis; the browser writes the prescription. Neither invents the other's.
 */

interface Recovery {
  title: string
  icon: IconName
  /** What the person should do, in the browser's own words. */
  hint: string
  /** The one button, when there is one worth offering. */
  action?: 'retry' | 'sign-out' | 'reload'
}

/** What a `proto` refusal says about the desktop, when the desktop is new enough to say it. */
interface DesktopSide {
  proto?: number
  appVersion?: string
}

function recovery(reason: WebRefusal, email: string, desktop: DesktopSide = {}): Recovery {
  // Every hint below has one job, and it is *not* to restate the desktop's
  // sentence — that is already on screen, verbatim, directly above it. The hint
  // says the thing the desktop cannot know: which account this page is holding,
  // whether a retry can possibly help, and what the button is about to do.
  const signedInAs = email ? `Signed in as ${email}. ` : ''
  switch (reason) {
    case 'bad-token':
      return {
        title: 'That sign-in was not accepted',
        icon: 'gear',
        hint: `${signedInAs}This page already re-presented a freshly minted token once and was refused again, so the account itself needs signing in.`,
        action: 'sign-out'
      }
    case 'wrong-account':
      return {
        title: 'Wrong account',
        icon: 'gear',
        // Never a retry: a correct credential for the wrong desktop would loop
        // forever on a credential that is not going to stop being valid, which
        // is exactly what this value exists to prevent.
        hint: `${signedInAs}Nothing is wrong with that credential — it is simply not the one this machine admits, so retrying would loop on it forever.`,
        action: 'sign-out'
      }
    case 'not-approved':
      return {
        title: 'This browser did not identify itself',
        icon: 'restart',
        // The one thing the desktop cannot say, because it is a fact about this
        // page: the id is minted in browser storage and sent on every `hello`,
        // so a blank one is a page whose storage was unavailable rather than a
        // browser anybody has judged. Retrying would send the same blank id.
        hint: 'Reloading mints a fresh id for this browser. If it says the same thing afterwards, this browser is refusing the page any storage to keep one in — private browsing, or blocked site data.',
        action: 'reload'
      }
    case 'proto': {
      // A desktop new enough to say which protocol it speaks settles which half
      // is old, and the two halves have different cures: a reload fixes this
      // page, and only a restart at the desk fixes the desktop — a Reload button
      // there would fetch the same page and be refused the same way.
      const theirs = desktop.proto
      const version = desktop.appVersion ? ` (it is on Forge ${desktop.appVersion})` : ''
      if (typeof theirs === 'number' && theirs < WEB_PROTO) {
        return {
          title: 'The desktop is older than this page',
          icon: 'restart',
          hint: `Restart Forge on the desktop${version} so it updates, then try again.`,
          action: 'retry'
        }
      }
      if (typeof theirs === 'number' && theirs > WEB_PROTO) {
        return {
          title: 'This page is older than the desktop',
          icon: 'restart',
          hint: 'Reload to pick up the current page.',
          action: 'reload'
        }
      }
      return {
        title: 'This page and that Forge speak different protocols',
        icon: 'restart',
        hint: 'Reload to pick up the current bundle. If it says the same thing afterwards, the desktop is the older half and needs updating.',
        action: 'reload'
      }
    }
    case 'busy':
      return {
        title: 'The desktop cannot take this connection yet',
        icon: 'restart',
        hint: 'It is up, but not ready — still starting, or holding too many sockets. This page will try again on its own.',
        action: 'retry'
      }
    // Both are drawn by `PinPrompt` rather than by `Refused`, because a question
    // is not a failure — `lib/client.ts` intercepts them into the `pin`
    // connection state before this table is ever reached. They are still in it:
    // leaving them out would mean a desktop that somehow sent one on a path this
    // page did not expect fell through to nothing at all.
    case 'pin-required':
    case 'pin-invalid':
      return {
        title: 'This desktop wants its unlock PIN',
        icon: 'key',
        hint: `The ${PIN_MIN_DIGITS}-to-${PIN_MAX_DIGITS} digit PIN set in Forge's settings on that PC. Try again to be asked for it.`,
        action: 'retry'
      }
  }
}

/* ------------------------------------------------------------------ shell */

/**
 * The doorway every pre-workspace screen stands in: sign-in, connecting, the
 * PIN, every refusal.
 *
 * At a desk it is the centred card it always was. On a phone it is the same
 * markup inside a phone-faced `.app` (so the phone tokens reach it), and
 * Sheets.phone.css lays it out for a thumb: the heading block in the calm upper
 * part of the screen, and the fields and the one button at the bottom, where
 * the thumb already is.
 */
export function GateFrame({
  reason,
  onSubmit,
  children
}: {
  /** Stamped on the element so a screen is identifiable as itself, not as "an error". */
  reason: string
  /** Makes the card a form. */
  onSubmit?: (event: FormEvent) => void
  children: ReactNode
}): ReactNode {
  const mobile = useMobile()
  const card = onSubmit ? (
    <form className="gate__card" data-reason={reason} onSubmit={onSubmit}>
      {children}
    </form>
  ) : (
    <div className="gate__card" data-reason={reason}>
      {children}
    </div>
  )
  const gate = <div className="gate">{card}</div>
  if (!mobile) return gate
  return (
    <div className="app" data-shell="gate" data-mobile="true" data-ready="true">
      {gate}
    </div>
  )
}

/**
 * The heading block: mark, title, and the lines under it. A pass-through at a
 * desk (`display: contents`), the upper half of the screen on a phone.
 */
export function GateLead({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="gate__lead">
      <div className="gate__mark">
        <Icon name={icon} size={22} />
      </div>
      <h1 className="gate__title">{title}</h1>
      {children}
    </div>
  )
}

/** A circled "!" — the shape that goes with every error line, so red is never the only thing saying it. */
export function AlertGlyph(): ReactNode {
  return (
    <svg
      className="alert-glyph"
      width={18}
      height={18}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M8 4.8v3.8M8 11.1v.1" />
    </svg>
  )
}

/** An error line: the glyph and the sentence. */
export function GateError({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="gate__error" role="alert">
      <AlertGlyph />
      <span>{children}</span>
    </p>
  )
}

/* -------------------------------------------------------------- the screens */

/** How long a connect may take before the screen says it is still trying, and why it might be. */
const SLOW_MS = 5000

export function Connecting({ note }: { attempt: number; note?: string }): ReactNode {
  const { state, actions } = useForge()
  const desktop = state.picture?.desktopName || state.cached?.desktopName || ''
  const [slow, setSlow] = useState(false)

  // Counted from the moment this page started reaching for the socket — not
  // per attempt, because "attempt 5" is the retry loop's business and "it has
  // been a while" is the person's.
  useEffect(() => {
    setSlow(false)
    if (note) return
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  // No attempt counter and no "reconnecting": a dead port fails its first dial
  // inside half a second, so the retry number says nothing a person can use.
  const line = note ?? (slow ? `Still trying… ${desktop || 'The desktop'} may be asleep.` : `Reaching ${desktop || 'the desktop'}…`)

  return (
    <GateFrame reason="connecting">
      <GateLead icon="forge" title="Connecting">
        <p className="gate__body" aria-live="polite">
          {line}
        </p>
        <span className="pbar gate__progress" data-on="true" role="progressbar" aria-label="Connecting" />
      </GateLead>
      <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} />
    </GateFrame>
  )
}

/**
 * The escape hatch every pre-workspace screen needs and two of them lacked.
 *
 * A browser signed in as the wrong account used to be stuck at exactly the two
 * places that account cannot get past — this desktop's PIN prompt, and a
 * connect that will never succeed — with no way out short of clearing site
 * data, because the sign-out button lives in the workspace those screens stand
 * in front of. One person lending another their sign-in "to test" is precisely
 * how a browser ends up here, so the way back is named after what it does.
 */
export function SwitchAccount({
  email,
  onSignOut,
  compact
}: {
  email: string
  onSignOut: () => void
  compact?: boolean
}): ReactNode {
  const mobile = useMobile()
  if (!email) return null
  if (mobile && !compact) {
    // Its own line on a phone, with a button a thumb can hit, rather than a
    // link buried mid-sentence in small print.
    return (
      <div className="gate__account">
        <span className="gate__account-who">
          Signed in as <span className="gate__account-email">{email}</span>
        </span>
        <button type="button" className="gate__switch" onClick={onSignOut}>
          Use a different account
        </button>
      </div>
    )
  }
  const inner = (
    <>
      Signed in as <span className="mono">{email}</span> —{' '}
      <button type="button" className="gate__switch" onClick={onSignOut}>
        sign in as a different account
      </button>
    </>
  )
  return compact ? <span className="offline__account">{inner}</span> : <p className="gate__hint">{inner}</p>
}

export function Refused({
  reason,
  message,
  retryAfterMs,
  desktopProto,
  desktopVersion
}: {
  reason: WebRefusal
  message: string
  retryAfterMs?: number
  /** `proto` only: the protocol the desktop speaks, when it said (`WebRefusedFrame.proto`). */
  desktopProto?: number
  /** `proto` only: the desktop's Forge version, when it said (`WebRefusedFrame.appVersion`). */
  desktopVersion?: string
}): ReactNode {
  const { state, actions } = useForge()
  const plan = recovery(reason, state.session?.email ?? '', { proto: desktopProto, appVersion: desktopVersion })

  return (
    <GateFrame reason={reason}>
      <GateLead icon={plan.icon} title={plan.title}>
        {/* The desktop's own sentence, first and verbatim. It knows which of the
            eight refusals this is and why; this page only knows what to do next. */}
        {message ? <p className="gate__body">{message}</p> : null}
        <p className="gate__hint">{plan.hint}</p>
        {retryAfterMs ? (
          <p className="gate__hint">Worth trying again in about {Math.ceil(retryAfterMs / 1000)}s.</p>
        ) : null}
      </GateLead>
      {plan.action === 'retry' ? (
        <button type="button" className="cta-btn gate__go" onClick={() => actions.retry()}>
          Try again
        </button>
      ) : null}
      {plan.action === 'sign-out' ? (
        <button type="button" className="cta-btn gate__go" onClick={() => actions.signOut()}>
          Sign in again
        </button>
      ) : null}
      {plan.action === 'reload' ? (
        <button type="button" className="cta-btn gate__go" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      ) : null}
    </GateFrame>
  )
}

/**
 * "This desktop asks for its unlock PIN."
 *
 * A text box rather than an apology, because nothing has gone wrong: the desktop
 * has a PIN set and the first `hello` of every sign-in deliberately carries
 * none, so this screen is the ordinary second half of getting in rather than a
 * failure anybody has to recover from.
 *
 * The same screen serves the second visit, with the desktop's sentence about the
 * PIN that did not open the door above it — deliberately not two screens,
 * because the thing to do next is identical and a person who mistyped four
 * digits should not have to navigate back to where they were.
 *
 * There is no "trust this browser" and no recovery code, and neither is an
 * omission. shared/web.ts: the PIN "is not a device credential — it is the thing
 * that says the person holding the account is the person who set it up — so a
 * browser that has answered it once still answers it on the next connection".
 */
export function PinPrompt({
  message,
  invalid,
  retryAfterMs
}: {
  message: string
  invalid: boolean
  /** The desktop's own lockout, when the last answer spent one. */
  retryAfterMs?: number
}): ReactNode {
  const { state, actions } = useForge()
  const [pin, setPin] = useState('')
  // The lockout counts down here rather than being a static "about Ns", because
  // the box is disabled while it runs and a frozen number over a dead form
  // reads as broken rather than as waiting.
  const [wait, setWait] = useState(retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 0)
  const waiting = wait > 0

  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => setWait((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (waiting || pin.length < PIN_MIN_DIGITS) return
    actions.submitPin(pin)
    // Dropped the moment it is handed over, exactly as `lib/client.ts` drops it
    // after one `hello`: a page holds a PIN for as long as it takes to send it
    // and no longer.
    setPin('')
  }

  return (
    <GateFrame reason="pin" onSubmit={submit}>
      <GateLead icon="key" title="Enter the desktop’s PIN">
        {/* The desktop's own sentence, verbatim, exactly as `Refused` shows it:
            it is the half that knows whether this is the first ask or a wrong
            answer, and this page only knows what the box is for. */}
        {invalid ? (
          <GateError>{message || 'That PIN did not open the door.'}</GateError>
        ) : (
          <p className="gate__body">{message || `The ${PIN_MIN_DIGITS}-to-${PIN_MAX_DIGITS} digit PIN set on the desktop.`}</p>
        )}
      </GateLead>

      {/* The username half of the pair a password manager saves, so the phone
          can offer the PIN in one tap. Not the email: the account's own password
          is saved under that, and a PIN saved under the same name would
          overwrite it. One fixed name, so the entry saved on the first visit is
          the one offered on every later one. */}
      <input
        className="gate__username"
        type="text"
        name="username"
        autoComplete="username"
        value="Forge desktop PIN"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
      />

      <label className="gate__field">
        <span className="eyebrow gate__label">Unlock PIN</span>
        <input
          className="gate__input gate__input--pin mono"
          /* Masked, because this one is typed in a coffee shop as often as at
             a desk, and unlike a rotating code it is the same digits tomorrow. */
          type="password"
          name="password"
          /* `current-password`, with the username field above, is what lets the
             phone's password manager save the PIN and fill it next time; `numeric`
             is what gives it a number pad. Neither is decoration on a screen
             somebody is using one-handed. */
          autoComplete="current-password"
          inputMode="numeric"
          maxLength={PIN_MAX_DIGITS}
          autoFocus
          data-testid="pin-input"
          value={pin}
          disabled={waiting}
          /* Digits only, and never more than the protocol allows, because
             that is the whole of what `isValidPin` on the desktop accepts —
             a box that took a stray space would spend a lockout strike on a
             keystroke rather than on a wrong PIN. */
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS))}
        />
      </label>

      {/* Reserved for the "Use fingerprint" button a later change adds. Empty,
          it takes no room. */}
      <div className="gate__slot" data-slot="passkey" />

      {/* The lockout the desktop itself imposed — every strike against it was
          a wrong PIN sent from here, so this page closes the till while it
          runs rather than posting digits it knows will be refused. */}
      {waiting ? <p className="gate__hint">Too many tries — the desktop has locked the door for another {wait}s.</p> : null}

      <button type="submit" className="cta-btn gate__go" disabled={waiting || pin.length < PIN_MIN_DIGITS}>
        Unlock
      </button>
      <p className="gate__hint">
        The PIN set in Forge’s settings on that PC. It is asked for on every connection, so a phone that closed the tab
        asks again.
      </p>
      {/* The one screen a wrong account is guaranteed to reach and cannot get
          past: the PIN being asked for is the *desktop's* PIN, so no digits
          this person knows will open a desktop that is not theirs. */}
      <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} />
    </GateFrame>
  )
}

/** The database could not be read at all. Not the same as "the desktop is off". */
export function Unreachable({ error }: { error: string }): ReactNode {
  const { state, actions } = useForge()
  return (
    <GateFrame reason="unreachable">
      <GateLead icon="gear" title="Could not look up the desktop">
        <p className="gate__body">{error}</p>
        <p className="gate__hint">
          Nothing here says the desktop is off — only that this page could not find out either way.
        </p>
      </GateLead>
      <button type="button" className="cta-btn gate__go" onClick={() => actions.refind()}>
        Look again
      </button>
      <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} />
    </GateFrame>
  )
}

/** No `/config.json`, so there is no Firebase project and nothing to try. */
export function Unconfigured({ error }: { error: string }): ReactNode {
  return (
    <GateFrame reason="unconfigured">
      <GateLead icon="gear" title="This deployment is not configured">
        <p className="gate__body">{error}</p>
        <p className="gate__hint">
          Forge Web reads its Firebase project from <span className="mono">/config.json</span> beside this bundle.
          Deploy one and reload.
        </p>
      </GateLead>
    </GateFrame>
  )
}

import { useState, type FormEvent, type ReactNode } from 'react'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS, type WebRefusal } from '@shared/web'
import { Icon, type IconName } from '@/components/Icon'
import { useForge } from '../state'

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

function recovery(reason: WebRefusal, email: string): Recovery {
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
    case 'proto':
      return {
        title: 'This page and that Forge speak different protocols',
        icon: 'restart',
        hint: 'Reload to pick up the current bundle. If it says the same thing afterwards, the desktop is the older half and needs updating.',
        action: 'reload'
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
        icon: 'gear',
        hint: `The ${PIN_MIN_DIGITS}-to-${PIN_MAX_DIGITS} digit PIN set in Forge's settings on that PC. Try again to be asked for it.`,
        action: 'retry'
      }
  }
}

/* ------------------------------------------------------------------ shell */

function Screen({
  reason,
  title,
  icon,
  children
}: {
  /** Stamped on the element so a screen is identifiable as itself, not as "an error". */
  reason: string
  title: string
  icon: IconName
  children: ReactNode
}): ReactNode {
  return (
    <div className="gate">
      <div className="gate__card" data-reason={reason}>
        <div className="gate__mark">
          <Icon name={icon} size={22} />
        </div>
        <h1 className="gate__title">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- the screens */

export function Connecting({ attempt, note }: { attempt: number; note?: string }): ReactNode {
  return (
    <Screen reason="connecting" title="Connecting" icon="forge">
      <p className="gate__body">
        {note ?? (attempt > 0 ? `Reconnecting to the desktop (attempt ${attempt + 1})…` : 'Looking for the desktop…')}
      </p>
      <div className="gate__pulse" aria-hidden="true" />
    </Screen>
  )
}

export function Refused({
  reason,
  message,
  retryAfterMs
}: {
  reason: WebRefusal
  message: string
  retryAfterMs?: number
}): ReactNode {
  const { state, actions } = useForge()
  const plan = recovery(reason, state.session?.email ?? '')

  return (
    <Screen reason={reason} title={plan.title} icon={plan.icon}>
      {/* The desktop's own sentence, first and verbatim. It knows which of the
          eight refusals this is and why; this page only knows what to do next. */}
      {message ? <p className="gate__body">{message}</p> : null}
      <p className="gate__hint">{plan.hint}</p>
      {retryAfterMs ? (
        <p className="gate__hint mono">Worth trying again in about {Math.ceil(retryAfterMs / 1000)}s.</p>
      ) : null}
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
    </Screen>
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
export function PinPrompt({ message, invalid }: { message: string; invalid: boolean }): ReactNode {
  const { actions } = useForge()
  const [pin, setPin] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pin.length < PIN_MIN_DIGITS) return
    actions.submitPin(pin)
    // Dropped the moment it is handed over, exactly as `lib/client.ts` drops it
    // after one `hello`: a page holds a PIN for as long as it takes to send it
    // and no longer.
    setPin('')
  }

  return (
    <div className="gate">
      <form className="gate__card" data-reason="pin" onSubmit={submit}>
        <div className="gate__mark">
          <Icon name="gear" size={22} />
        </div>
        <h1 className="gate__title">Enter the desktop’s PIN</h1>
        {/* The desktop's own sentence, verbatim, exactly as `Refused` shows it:
            it is the half that knows whether this is the first ask or a wrong
            answer, and this page only knows what the box is for. */}
        <p className={invalid ? 'gate__error' : 'gate__body'}>
          {message || `The ${PIN_MIN_DIGITS}-to-${PIN_MAX_DIGITS} digit PIN set on the desktop.`}
        </p>

        <label className="gate__field">
          <span className="eyebrow">Unlock PIN</span>
          <input
            className="gate__input mono"
            /* Masked, because this one is typed in a coffee shop as often as at
               a desk, and unlike a rotating code it is the same digits tomorrow. */
            type="password"
            /* `one-time-code` is what makes a phone offer to fill it rather than
               offering the password for this site, and `numeric` is what gives
               it a number pad. Neither is decoration on a screen somebody is
               using one-handed. */
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={PIN_MAX_DIGITS}
            autoFocus
            data-testid="pin-input"
            value={pin}
            /* Digits only, and never more than the protocol allows, because
               that is the whole of what `isValidPin` on the desktop accepts —
               a box that took a stray space would spend a lockout strike on a
               keystroke rather than on a wrong PIN. */
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS))}
          />
        </label>

        <button type="submit" className="cta-btn gate__go" disabled={pin.length < PIN_MIN_DIGITS}>
          Unlock
        </button>
        <p className="gate__hint">
          This is the PIN set in Forge’s settings on that PC, and it is asked for on every connection.
        </p>
      </form>
    </div>
  )
}

/** The database could not be read at all. Not the same as "the desktop is off". */
export function Unreachable({ error }: { error: string }): ReactNode {
  const { actions } = useForge()
  return (
    <Screen reason="unreachable" title="Could not look up the desktop" icon="gear">
      <p className="gate__body">{error}</p>
      <p className="gate__hint">
        Nothing here says the desktop is off — only that this page could not find out either way.
      </p>
      <button type="button" className="cta-btn gate__go" onClick={() => actions.refind()}>
        Look again
      </button>
    </Screen>
  )
}

/** No `/config.json`, so there is no Firebase project and nothing to try. */
export function Unconfigured({ error }: { error: string }): ReactNode {
  return (
    <Screen reason="unconfigured" title="This deployment is not configured" icon="gear">
      <p className="gate__body">{error}</p>
      <p className="gate__hint">
        Forge Web reads its Firebase project from <span className="mono">/config.json</span> beside this bundle. Deploy
        one and reload.
      </p>
    </Screen>
  )
}

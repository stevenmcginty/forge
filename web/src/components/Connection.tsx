import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { APPROVAL_TIMEOUT_MS, TOTP_DIGITS, TRUST_WINDOW_MS, type WebRefusal } from '@shared/web'
import { Icon, type IconName } from '@/components/Icon'
import { useForge } from '../state'

/**
 * The connection screens — the part of this client that is not a spinner.
 *
 * shared/web.ts is blunt about why these are seven values rather than one error
 * string: "These are different sentences on screen and different recovery paths
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
  action?: 'retry' | 'sign-out' | 'reload' | 'forget'
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
        title: 'This browser has not been approved',
        icon: 'panel',
        hint: 'Nobody has said no — nobody has been asked. Open Forge on the desktop, switch on "Accept new browsers", then try again.',
        action: 'retry'
      }
    case 'declined':
      return {
        title: 'The desktop said no',
        icon: 'close',
        hint: 'Asking again raises a new prompt rather than retrying this one, so it needs somebody at the desk either way.',
        action: 'retry'
      }
    case 'timed-out':
      return {
        title: 'Nobody answered',
        icon: 'restart',
        hint: 'The question expired on the desktop. Trying again asks it afresh.',
        action: 'retry'
      }
    case 'revoked':
      return {
        title: 'This browser was removed',
        icon: 'close',
        // "The page should forget its device id and stop reconnecting; a revoked
        // device that keeps knocking is a prompt storm."
        hint: 'It was approved once and has since been revoked in the desktop’s settings. Forgetting this browser lets it ask to be let in again — somebody at the desk has to allow it.',
        action: 'forget'
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
    // Both are drawn by `TotpPrompt` rather than by `Refused`, because a
    // question is not a failure. They are still in this table: leaving them out
    // would mean a desktop that somehow sent one on a path this page did not
    // expect fell through to nothing at all.
    case 'totp-required':
    case 'totp-invalid':
      return {
        title: 'This desktop wants a code',
        icon: 'gear',
        hint: 'Open your authenticator app and try again with the code it is showing.',
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

/**
 * "Steve is being asked about you. Hold on."
 *
 * The word pair is in large type because comparing it against the desktop's
 * prompt is the entire anti-confusion device — shared/web.ts: "the browser shows
 * the pair in large type, the desktop shows the same pair in its prompt, and the
 * human is told to compare them. Without it, a stranger who guessed the hostname
 * could make a prompt appear at the moment Steve happened to be approving his
 * own laptop, and Allow would go to the wrong device."
 *
 * The string is rendered exactly as sent. There is no second word list here, and
 * there must not be: two lists is how the two screens end up showing different
 * words.
 */
export function Pending({ words, expiresAt }: { words: string; expiresAt: number }): ReactNode {
  const [left, setLeft] = useState(() => remaining(expiresAt))
  useEffect(() => {
    setLeft(remaining(expiresAt))
    const timer = window.setInterval(() => setLeft(remaining(expiresAt)), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  return (
    <Screen reason="pending" title="Waiting to be let in" icon="panel">
      <p className="gate__body">Forge is asking on the desktop. Check that it is showing these two words:</p>
      <p className="gate__words mono" data-testid="approval-words">
        {words}
      </p>
      <p className="gate__hint">
        {left > 0
          ? `The question expires in ${formatLeft(left)}.`
          : `Nobody has ${APPROVAL_TIMEOUT_MS / 60_000} minutes to answer — this one has run out.`}
      </p>
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
      {plan.action === 'forget' ? (
        <button type="button" className="cta-btn gate__go" onClick={() => actions.forgetThisBrowser()}>
          Forget this browser and ask again
        </button>
      ) : null}
    </Screen>
  )
}

/**
 * "This desktop wants a code."
 *
 * A text box rather than an apology, because nothing has gone wrong: the
 * desktop has a second factor enrolled and this browser has not shown one yet.
 * The same screen serves the second visit, with the desktop's sentence about
 * the code that did not work above it — deliberately not two screens, because
 * the thing to do next is identical and a person who mistyped six digits should
 * not have to navigate back to where they were.
 *
 * "Trust this browser" is what stops this being a daily event: inside the
 * window (TRUST_WINDOW_MS) the desktop stops asking, and revoking the browser
 * in Settings ends that in the same act, because it is a field on the same row.
 */
export function TotpPrompt({ message, invalid }: { message: string; invalid: boolean }): ReactNode {
  const { actions } = useForge()
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(true)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!code.trim()) return
    actions.submitTotp(code.trim(), trust)
    setCode('')
  }

  return (
    <div className="gate">
      <form className="gate__card" data-reason="totp" onSubmit={submit}>
        <div className="gate__mark">
          <Icon name="gear" size={22} />
        </div>
        <h1 className="gate__title">Enter your code</h1>
        {/* The desktop's own sentence, verbatim, exactly as `Refused` shows it:
            it is the half that knows whether this is the first ask or a wrong
            answer, and this page only knows what the box is for. */}
        <p className={invalid ? 'gate__error' : 'gate__body'}>
          {message || `The ${TOTP_DIGITS}-digit code from your authenticator app.`}
        </p>

        <label className="gate__field">
          <span className="eyebrow">Code</span>
          <input
            className="gate__input mono"
            type="text"
            /* `one-time-code` is what makes a phone offer the code from its own
               notification, and `numeric` is what gives it a number pad. Neither
               is decoration on a screen somebody is using one-handed. */
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            data-testid="totp-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>

        <label className="gate__check">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          <span>Trust this browser for {TRUST_WINDOW_MS / (24 * 60 * 60_000)} days</span>
        </label>

        <button type="submit" className="cta-btn gate__go" disabled={!code.trim()}>
          Continue
        </button>
        <p className="gate__hint">
          Lost the app? A recovery code works here instead — each one works once.
        </p>
      </form>
    </div>
  )
}

/**
 * `declined` and `timed-out` are states of their own in `WebApprovalState`, not
 * shades of `refused`, so they get their own screens — a human said no, or
 * nobody was there, and those are not the same news.
 */
export function Declined({ message }: { message: string }): ReactNode {
  const { actions } = useForge()
  return (
    <Screen reason="declined" title="The desktop said no" icon="close">
      <p className="gate__body">{message || 'Somebody at the desk declined this browser.'}</p>
      <p className="gate__hint">Asking again raises a new prompt, with new words, rather than retrying this one.</p>
      <button type="button" className="cta-btn gate__go" onClick={() => actions.retry()}>
        Ask again
      </button>
    </Screen>
  )
}

export function TimedOut({ message }: { message: string }): ReactNode {
  const { actions } = useForge()
  return (
    <Screen reason="timed-out" title="Nobody answered" icon="restart">
      <p className="gate__body">{message || 'The question expired on the desktop.'}</p>
      <p className="gate__hint">Try again when somebody is at the machine — the words are minted fresh each time.</p>
      <button type="button" className="cta-btn gate__go" onClick={() => actions.retry()}>
        Ask again
      </button>
    </Screen>
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

/* ---------------------------------------------------------------- helpers */

function remaining(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now())
}

function formatLeft(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

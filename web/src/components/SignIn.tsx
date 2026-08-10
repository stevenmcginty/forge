import { useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'

/**
 * One account, one machine, one human (docs/forge-web.md, "what is deliberately
 * not here"). So this is an email, a password and nothing else: no provider
 * buttons, no sign-up flow, no password reset — the account already exists,
 * because the Companion made it.
 *
 * The sign-up fallback is still in `Auth.signIn`, silently, for the very first
 * use on a fresh Firebase project. It is not a second button here for the reason
 * `companion/web/js/auth.js` gives: without the `EMAIL_EXISTS` branch a typo in
 * the password produces "couldn't sign in, couldn't sign up" and nobody can tell
 * which half was wrong.
 */
export function SignIn({ error }: { error: string }): ReactNode {
  const { actions } = useForge()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFailure('')
    void actions
      .signIn(email.trim(), password)
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__mark">
          <Icon name="forge" size={22} />
        </div>
        <h1 className="gate__title">Forge</h1>
        <p className="gate__body">Sign in with the account this desktop is paired to.</p>

        <label className="gate__field">
          <span className="eyebrow">Email</span>
          <input
            className="gate__input"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="gate__field">
          <span className="eyebrow">Password</span>
          <input
            className="gate__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {failure || error ? <p className="gate__error">{failure || error}</p> : null}

        <button type="submit" className="cta-btn gate__go" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

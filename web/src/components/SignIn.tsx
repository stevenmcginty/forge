import { useState, type FormEvent, type ReactNode } from 'react'
import { useForge } from '../state'
import { GateError, GateFrame, GateLead } from './Connection'

/**
 * Email is the key to one PC. It must match Settings → Account (or Forge Web)
 * on that computer. A new email creates the account; the desktop still has to
 * turn browser access on before this page can find a machine.
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
    <GateFrame reason="sign-in" onSubmit={submit}>
      <GateLead icon="forge" title="Forge">
        {/* One line. The account *is* the machine — a different email finds a
            different PC — and that is the only thing worth saying before the
            fields. */}
        <p className="gate__body">Sign in with the email saved on your PC.</p>
      </GateLead>

      <label className="gate__field">
        <span className="eyebrow gate__label">Email</span>
        <input
          className="gate__input"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="gate__field">
        <span className="eyebrow gate__label">Password</span>
        <input
          className="gate__input"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {failure || error ? <GateError>{failure || error}</GateError> : null}

      <button type="submit" className="cta-btn gate__go" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </GateFrame>
  )
}

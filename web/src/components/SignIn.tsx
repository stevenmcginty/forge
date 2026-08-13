import { useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'

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
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__mark">
          <Icon name="forge" size={22} />
        </div>
        <h1 className="gate__title">Forge</h1>
        <p className="gate__body">
          Sign in with <em>your</em> Forge email — the same one saved on the PC you want. A different email is a
          different machine.
        </p>

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

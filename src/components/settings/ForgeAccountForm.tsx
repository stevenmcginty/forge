import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { WebStatus } from '@shared/types'
import { StateChip } from './parts'

/**
 * Email + password for the Forge account. One form, four surfaces: first-run
 * welcome, the existing-user prompt, Settings → Account, Settings → Forge Web.
 *
 * The password is posted once and dropped. What lands on disk is a refresh
 * token, written by main. This component never sees that token.
 */
export function ForgeAccountForm({
  onSignedIn
}: {
  onSignedIn?: (created: boolean) => void
}): ReactNode {
  const [status, setStatus] = useState<WebStatus | null>(null)
  const [email, setEmail] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(false)

  useEffect(() => {
    void window.forge.web.status().then(setStatus)
    return window.forge.web.onStatus(setStatus)
  }, [])

  const signIn = useCallback(async () => {
    const address = emailTouched ? email.trim() : (status?.session.email ?? email).trim()
    setError('')
    setCreated(false)
    setBusy(true)
    try {
      const result = await window.forge.web.signIn(address, password)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setCreated(result.created)
      setPassword('')
      const next = await window.forge.web.status()
      setStatus(next)
      onSignedIn?.(result.created)
    } finally {
      setBusy(false)
    }
  }, [email, emailTouched, password, status?.session.email, onSignedIn])

  const signOut = useCallback(async () => {
    setError('')
    setCreated(false)
    setStatus(await window.forge.web.signOut())
  }, [])

  if (!status) return <p className="scard__hint">Checking the account…</p>

  const session = status.session
  const emailValue = emailTouched ? email : session.email

  if (session.signedIn) {
    return (
      <div className="web-url">
        <code className="web-address">{session.email}</code>
        <StateChip tone="ok">Signed in</StateChip>
        <button type="button" className="sbtn sbtn--danger" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="web-signin">
        <label className="web-field">
          <span className="field__label">Email</span>
          <input
            className="field__input"
            type="email"
            autoComplete="username"
            spellCheck={false}
            placeholder="you@example.com"
            value={emailValue}
            onChange={(e) => {
              setEmailTouched(true)
              setEmail(e.target.value)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void signIn()
            }}
          />
        </label>
        <label className="web-field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            autoComplete="current-password"
            placeholder="at least 6 characters, never saved"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void signIn()
            }}
          />
        </label>
        <button
          type="button"
          className="sbtn sbtn--go web-signin__go"
          disabled={busy || !emailValue.trim() || !password}
          onClick={() => void signIn()}
        >
          {busy ? 'Signing in…' : 'Save account'}
        </button>
      </div>
      {error ? <p className="web-error">{error}</p> : null}
      {created ? (
        <p className="web-note">That email was new, so this created the account. Use the same email on the website.</p>
      ) : null}
    </div>
  )
}

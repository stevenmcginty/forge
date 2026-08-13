import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { WebStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { ForgeAccountForm } from './settings/ForgeAccountForm'
import { Icon } from './Icon'
import './Onboarding.css'

/**
 * For an install that already finished first-run but never signed a Forge
 * account in. David and Adam: projects stay, this card is the missing key.
 *
 * Hidden when the welcome is still up, when they already signed in, or after
 * Later. Settings → Account keeps the same form permanently.
 */
export function AccountPrompt(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<WebStatus | null>(null)

  useEffect(() => {
    if (!state.ready) return
    void window.forge.web.status().then(setStatus)
    return window.forge.web.onStatus(setStatus)
  }, [state.ready])

  const dismiss = useCallback(() => {
    actions.patchSettings({ webAccountPromptDismissed: true })
  }, [actions])

  const open =
    state.ready &&
    state.settings.onboarded &&
    !state.settings.webAccountPromptDismissed &&
    status !== null &&
    !status.session.signedIn

  if (!open) return null

  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-label="Your Forge account">
      <div className="onboard__card">
        <button type="button" className="ghost-btn onboard__dismiss" aria-label="Later" onClick={dismiss}>
          <Icon name="close" size={12} />
        </button>
        <header className="onboard__head">
          <div className="onboard__mark">
            <Icon name="user" size={20} />
          </div>
          <div>
            <div className="eyebrow onboard__eyebrow">One step left</div>
            <h1 className="onboard__title">Your Forge account</h1>
          </div>
        </header>
        <p className="onboard__lede">
          Nothing here is reset. Your projects stay. This email is the name a browser uses to find{' '}
          <em>this</em> PC — not someone else&apos;s. Password is sent once and never stored.
        </p>
        <ForgeAccountForm onSignedIn={dismiss} />
        <footer className="onboard__foot">
          <button type="button" className="onboard__foot-hint" onClick={dismiss}>
            Later — I only use this machine
          </button>
          <button
            type="button"
            className="cta-btn"
            onClick={() => {
              dismiss()
              actions.openSettings('account')
            }}
          >
            Open Settings
          </button>
        </footer>
      </div>
    </div>
  )
}

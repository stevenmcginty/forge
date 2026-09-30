import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'
import { GateDetails, SwitchAccount } from './Connection'

/**
 * Signed in, and this account has never published a desktop.
 *
 * Not "Forge is asleep". Asleep is a machine we have already seen, off for the
 * moment. This is an email with no PC behind it — the friend who created an
 * account and opened the website before their desktop published a tunnel.
 *
 * Or a mistyped email: sign-in falls through to sign-up for an address Firebase
 * has never seen (lib/auth.ts), and this is exactly where that lands. So when
 * this very sign-in made the account, the first line says so, and the way back
 * is the "Use a different account" button already on this screen — no question
 * before sign-up, so a right email and password still take no extra tap.
 */
export function Unpaired({ message }: { message: string }): ReactNode {
  const { state, actions } = useForge()
  const email = state.session?.email ?? ''
  const created = Boolean(state.session?.created) && !!email
  return (
    <div className="gate">
      <div className="gate__card" data-reason="unpaired" data-testid="unpaired">
        <div className="gate__mark">
          <Icon name="globe" size={22} />
        </div>
        <h1 className="gate__title">No PC found for this account</h1>
        {created ? (
          <p className="gate__body" data-testid="unpaired-created">
            <Icon name="user" size={14} /> New account made for <span className="mono">{email}</span>. Wrong email?
            Use a different account.
          </p>
        ) : null}
        <p className="gate__hint">
          On your PC, open Forge Settings: save this same email under Account, and turn on browser access under Forge
          Web. Then tap Look again.
        </p>
        {message ? <GateDetails>{message}</GateDetails> : null}
        <button type="button" className="cta-btn gate__go" onClick={() => actions.refind()}>
          Look again
        </button>
        <SwitchAccount email={email} onSignOut={actions.signOut} />
      </div>
    </div>
  )
}

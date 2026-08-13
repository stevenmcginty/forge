import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'
import { SwitchAccount } from './Connection'

/**
 * Signed in, and this account has never published a desktop.
 *
 * Not "Forge is asleep". Asleep is a machine we have already seen, off for the
 * moment. This is an email with no PC behind it — the friend who created an
 * account and opened the website before their desktop published a tunnel.
 */
export function Unpaired({ message }: { message: string }): ReactNode {
  const { state, actions } = useForge()
  return (
    <div className="gate">
      <div className="gate__card" data-reason="unpaired" data-testid="unpaired">
        <div className="gate__mark">
          <Icon name="globe" size={22} />
        </div>
        <h1 className="gate__title">No PC is publishing for this account</h1>
        <p className="gate__body">{message}</p>
        <p className="gate__hint">
          On that computer: Settings → Account (save this same email), then Settings → Forge Web → Turn on browser
          access. The tunnel chip must say live. Then come back here.
        </p>
        <button type="button" className="cta-btn gate__go" onClick={() => actions.refind()}>
          Look again
        </button>
        <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} />
      </div>
    </div>
  )
}

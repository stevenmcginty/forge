import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useMobile } from '../lib/mobile'
import { useForge } from '../state'
import { GateDetails, GateFrame, GateLead, SwitchAccount } from './Connection'

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
 *
 * Drawn in the same doorway as every other screen before the workspace
 * (`GateFrame`), so on a phone it wears the phone face like its neighbours.
 */
export function Unpaired({ message }: { message: string }): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  const email = state.session?.email ?? ''
  const created = Boolean(state.session?.created) && !!email
  return (
    <GateFrame reason="unpaired" testId="unpaired">
      <GateLead icon="globe" title="No PC found for this account" glyph="link-quiet">
        {created ? (
          <p className="gate__body" data-testid="unpaired-created">
            <Icon name="user" size={14} /> New account made for <span className="mono">{email}</span>. Wrong email?
            Use a different account.
          </p>
        ) : null}
        {mobile ? (
          // Three steps a person does at the PC, numbered, rather than one
          // sentence holding all three.
          <ol className="gate__steps">
            <li>Open Forge Settings on your PC.</li>
            <li>Under Account, save this same email.</li>
            <li>Under Forge Web, turn on browser access.</li>
          </ol>
        ) : (
          <p className="gate__hint">
            On your PC, open Forge Settings: save this same email under Account, and turn on browser access under Forge
            Web. Then tap Look again.
          </p>
        )}
        {message ? <GateDetails>{message}</GateDetails> : null}
      </GateLead>
      <button type="button" className="cta-btn gate__go" onClick={() => actions.refind()}>
        Look again
      </button>
      <SwitchAccount email={email} onSignOut={actions.signOut} />
    </GateFrame>
  )
}

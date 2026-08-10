import { type ReactNode } from 'react'
import { Connecting, Declined, Pending, Refused, TimedOut, Unconfigured, Unreachable } from './components/Connection'
import { SignIn } from './components/SignIn'
import { Workspace } from './components/Workspace'
import { useForge } from './state'

/**
 * Which screen this tab is showing, and nothing else.
 *
 * Two axes, in this order, because they answer different questions:
 *
 *  1. **`stage`** — can this page get to a desktop at all? Configuration,
 *     sign-in, the rendezvous read, and the frozen view when the answer is no.
 *  2. **`connection`** — given that there is a desktop, where does this browser
 *     stand with it? That is `WebApprovalState`'s vocabulary, and every value in
 *     it is a different screen with a different recovery.
 *
 * The one crossing between them is deliberate: an `offline` stage still draws
 * the whole workspace, from the cache, because Forge asleep must not look like
 * Forge broken.
 */
export function App(): ReactNode {
  const { state } = useForge()

  switch (state.stage.kind) {
    case 'loading':
      return <Connecting attempt={0} note="Starting…" />
    case 'unconfigured':
      return <Unconfigured error={state.stage.error} />
    case 'signed-out':
      return <SignIn error={state.stage.error} />
    case 'finding':
      return <Connecting attempt={0} note="Looking for the desktop…" />
    case 'unreachable':
      return <Unreachable error={state.stage.error} />
    case 'offline':
      // The frozen, badged picture. Drawn by the same components as the live
      // one, from the cache rather than from a socket.
      return <Workspace />
    case 'connected':
      break
  }

  switch (state.connection.state) {
    case 'live':
      return <Workspace />
    case 'connecting':
      return <Connecting attempt={state.connection.attempt} />
    case 'pending':
      return <Pending words={state.connection.words} expiresAt={state.connection.expiresAt} />
    case 'declined':
      return <Declined message={state.connection.message} />
    case 'timed-out':
      return <TimedOut message={state.connection.message} />
    case 'refused':
      return (
        <Refused
          reason={state.connection.reason}
          message={state.connection.message}
          retryAfterMs={state.connection.retryAfterMs}
        />
      )
    case 'offline':
      // A `shutdown` frame arrived on a live socket. `stage` follows it, so this
      // is one render at most — but it must not be a blank one.
      return <Workspace />
  }
}

import { type ReactNode } from 'react'
import { Connecting, PinPrompt, Refused, Unconfigured, Unreachable } from './components/Connection'
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
 *     stand with it? That is `WebConnectionState`'s vocabulary, and every value
 *     in it is a different screen with a different recovery.
 *
 * The one crossing between them is deliberate: an `offline` stage still draws
 * the whole workspace, from the cache, because Forge asleep must not look like
 * Forge broken. `connecting` crosses the same way once there is a picture to
 * cross with, and for a reason that is cheaper to state than to discover:
 * `lib/client.ts` announces `connecting` at the top of every `open()` and on
 * every scheduled retry, so a socket that so much as flinched used to replace
 * the entire application with a spinner — which unmounted every `PaneView`,
 * disposed every xterm, detached every pane, and bought each of them a fresh
 * catch-up buffer on the way back in. The full-page gate is therefore only for a
 * browser that has never seen this desktop; after that a reconnect is a badge
 * and a read-only keyboard, which is what `Workspace` draws.
 *
 * There is no third axis for GitHub mode, and that is the point of it being a
 * *mode*: `Workspace` swaps what is inside the grid when `offlineMode` says so,
 * and everything around it — the titlebar, the offline strip, the rail, the
 * theme — is the same furniture either way. A screen of its own here would have
 * made decision 9 and decision 10 two applications instead of two halves of one.
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
      // The workspace, badged, for anybody who has already seen one. See above.
      return state.picture ? <Workspace /> : <Connecting attempt={state.connection.attempt} />
    case 'pin':
      return <PinPrompt message={state.connection.message} invalid={state.connection.invalid} />
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

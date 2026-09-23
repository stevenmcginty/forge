import { type ReactNode } from 'react'
import {
  Connecting,
  hostSkew,
  PasskeyOffer,
  PinPrompt,
  Refused,
  Unconfigured,
  Unreachable,
  VersionSkew
} from './components/Connection'
import { LiveFiles } from './components/LiveFiles'
import { SignIn } from './components/SignIn'
import { Unpaired } from './components/Unpaired'
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
  // Mounted beside whatever screen is up rather than inside Workspace: the
  // fingerprint offer and the live file viewer are sheets that open on their
  // own events, and each renders nothing until it has something to show.
  return (
    <>
      <Screen />
      <PasskeyOffer />
      <LiveFiles />
    </>
  )
}

function Screen(): ReactNode {
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
    case 'offline': {
      // Awake and publishing, but on another protocol: not asleep, and the
      // frozen view would say it was. Say which side is older instead.
      const skew = hostSkew(state.stage.record)
      if (skew) return <VersionSkew record={skew} />
      // A machine we have already seen stays the frozen workspace. An account
      // that has never published a host is a different sentence — not asleep,
      // unpaired — and a workspace here would look like login failed.
      if (!state.stage.record && !state.cached) {
        return <Unpaired message={state.stage.message} />
      }
      return <Workspace />
    }
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
      return (
        <PinPrompt
          message={state.connection.message}
          invalid={state.connection.invalid}
          retryAfterMs={state.connection.retryAfterMs}
          passkey={state.connection.passkey}
          afterPasskey={state.connection.afterPasskey}
        />
      )
    case 'refused':
      return (
        <Refused
          reason={state.connection.reason}
          message={state.connection.message}
          retryAfterMs={state.connection.retryAfterMs}
          desktopProto={state.connection.proto}
          desktopVersion={state.connection.appVersion}
        />
      )
    case 'offline':
      // A `shutdown` frame arrived on a live socket. `stage` follows it, so this
      // is one render at most — but it must not be a blank one.
      return <Workspace />
  }
}

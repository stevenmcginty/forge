import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOBILE_PORT, type MobileSession } from '@shared/mobile'
import { Link, deviceId, type LinkPicture, type LinkState } from './lib/link'
import { forgetToken, pairTokenOf, readOrigin, readToken, toOrigin, writeOrigin, writeToken } from './lib/secure'
import { canScan, scanPairingCode } from './lib/scan'
import { Browser, leavesOf } from './components/Browser'
import { PaneView, paneListeners } from './components/PaneView'
import { UpdateSheet } from './components/Update'
import { CURRENT_VERSION_NAME } from './lib/update'

/**
 * Forge Mobile.
 *
 * One socket, three screens: connect → projects/tabs → a terminal. The Link is
 * built once and kept for the life of the app, because a phone that rebuilds
 * its socket on every render is a phone that never finishes connecting.
 */

type Screen = { at: 'browse'; projectId: string | null } | { at: 'pane'; session: MobileSession; title: string }

export function App(): React.JSX.Element {
  const [state, setState] = useState<LinkState>('idle')
  const [detail, setDetail] = useState('')
  const [picture, setPicture] = useState<LinkPicture | null>(null)
  const [notice, setNotice] = useState('')
  const [screen, setScreen] = useState<Screen>({ at: 'browse', projectId: null })
  const [address, setAddress] = useState(() => readOrigin())
  const [code, setCode] = useState('')
  // Scan guidance is state of its own, not a `notice`: notices self-dismiss
  // after 4s, and "go to Android Settings and re-allow the camera" must stay
  // on screen until it has been acted on or superseded.
  const [hint, setHint] = useState('')
  const [showUpdate, setShowUpdate] = useState(false)

  // Built once. The callbacks below close over setState only, which React
  // guarantees is stable, so the Link never needs rebuilding.
  const link = useMemo(
    () =>
      new Link({
        onState: (next, why) => {
          setState(next)
          setDetail(why)
        },
        onPicture: setPicture,
        onData: (id, data, replay) => paneListeners.get(id)?.(data, replay),
        onExit: (id) => {
          paneListeners.get(id)?.('\r\n\x1b[2m— the shell exited —\x1b[0m\r\n', false)
          // Leaving a dead terminal on screen is worse than going back to a
          // list that tells the truth.
          setScreen((current) => (current.at === 'pane' && current.session.id === id ? { at: 'browse', projectId: null } : current))
        },
        onPaired: writeToken,
        onNotice: setNotice
      }),
    []
  )

  /** Reconnect on boot if we already know a desktop and hold a token. */
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true

    // A `forge://pair?…` deep link (Phase 4) or a pasted QR payload arrives in
    // the URL; it carries both the address and a single-use code.
    const fromUrl = new URLSearchParams(window.location.search).get('pair') ?? ''
    const origin = toOrigin(fromUrl || readOrigin(), MOBILE_PORT)
    const pairCode = pairTokenOf(fromUrl)
    const token = pairCode || readToken()
    if (origin && token) {
      writeOrigin(origin)
      setAddress(origin)
      link.connect({ origin, token, deviceId: deviceId(), deviceName: deviceName() })
    }
  }, [link])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const pair = useCallback((): void => {
    const origin = toOrigin(address, MOBILE_PORT)
    const token = pairTokenOf(code) || code.trim()
    if (!origin || !token) {
      setNotice('Both the address and the pairing code are needed.')
      return
    }
    setHint('')
    writeOrigin(origin)
    setAddress(origin)
    link.connect({ origin, token, deviceId: deviceId(), deviceName: deviceName() })
  }, [address, code, link])

  /**
   * The camera path: one scan of the desktop's QR carries the address and the
   * single-use code, so pairing is one tap and a point. The payload goes
   * through the same `toOrigin`/`pairTokenOf` a typed value does — and both
   * must decode, or the scan is refused. Accepting anything looser would let
   * a random QR (every URL is one scan away) be "paired against" as if it
   * were a desktop, and fail looking like a network problem.
   */
  const scan = useCallback(async (): Promise<void> => {
    setHint('')
    const outcome = await scanPairingCode()
    if (outcome.at === 'cancelled') return
    if (outcome.at === 'denied') {
      setHint(
        'The camera is switched off for Forge. Allow it under Android Settings → Apps → Forge → Permissions, then scan again — or type the two fields below; they still work.'
      )
      return
    }
    if (outcome.at === 'failed') {
      setHint('The camera could not read a code. Try again, or type the two fields below.')
      return
    }
    const origin = toOrigin(outcome.text, MOBILE_PORT)
    const token = pairTokenOf(outcome.text)
    if (!origin || !token) {
      setHint('That QR is not a Forge pairing code. Scan the one the desktop shows after Settings → Forge Mobile → Pair a phone.')
      return
    }
    writeOrigin(origin)
    setAddress(origin)
    setCode('')
    link.connect({ origin, token, deviceId: deviceId(), deviceName: deviceName() })
  }, [link])

  const forget = useCallback((): void => {
    link.disconnect()
    forgetToken()
    setPicture(null)
    setScreen({ at: 'browse', projectId: null })
    setNotice('This phone is no longer paired.')
  }, [link])

  /* ------------------------------------------------------------- rendering */

  if (!picture) {
    // The update sheet is reachable from here too, deliberately: if a bad
    // build ever ships, "the desktop is unreachable" must not also mean "the
    // fix is unreachable".
    return (
      <>
        <Connect
          state={state}
          detail={detail}
          address={address}
          code={code}
          notice={notice}
          hint={hint}
          onAddress={setAddress}
          onCode={setCode}
          onPair={pair}
          onScan={() => void scan()}
          onUpdate={() => setShowUpdate(true)}
        />
        {showUpdate && <UpdateSheet onClose={() => setShowUpdate(false)} />}
      </>
    )
  }

  return (
    <div className="app">
      <StatusStrip
        state={state}
        detail={detail}
        version={picture.appVersion}
        onForget={forget}
        onUpdate={() => setShowUpdate(true)}
      />

      {screen.at === 'pane' ? (
        <PaneView
          link={link}
          session={screen.session}
          title={screen.title}
          fontSize={13}
          onBack={() => setScreen({ at: 'browse', projectId: projectOfSession(picture, screen.session.id) })}
        />
      ) : (
        <Browser
          picture={picture}
          projectId={screen.projectId}
          onOpenProject={(projectId) => setScreen({ at: 'browse', projectId })}
          onOpenPane={(session, title) => setScreen({ at: 'pane', session, title })}
          onNewTab={(projectId) => {
            link.op({ op: 'create-tab', projectId })
            setNotice('Asked the desktop for a new tab…')
          }}
          onBack={() => setScreen({ at: 'browse', projectId: null })}
        />
      )}

      {showUpdate && <UpdateSheet onClose={() => setShowUpdate(false)} />}
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

/* ------------------------------------------------------------- sub-screens */

function StatusStrip({
  state,
  detail,
  version,
  onForget,
  onUpdate
}: {
  state: LinkState
  detail: string
  version: string
  onForget: () => void
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <div className={`status status-${state}`}>
      <span className="status-dot" />
      <span className="status-text">
        {state === 'live' ? `Forge ${version}` : detail || state}
      </span>
      {/* The app's own version, not the desktop's — tapping it is how the
          APK checks for and installs a newer self. */}
      <button type="button" className="status-version" onClick={onUpdate}>
        v{CURRENT_VERSION_NAME}
      </button>
      <button type="button" className="status-forget" onClick={onForget}>
        Unpair
      </button>
    </div>
  )
}

function Connect({
  state,
  detail,
  address,
  code,
  notice,
  hint,
  onAddress,
  onCode,
  onPair,
  onScan,
  onUpdate
}: {
  state: LinkState
  detail: string
  address: string
  code: string
  notice: string
  hint: string
  onAddress: (value: string) => void
  onCode: (value: string) => void
  onPair: () => void
  onScan: () => void
  onUpdate: () => void
}): React.JSX.Element {
  const busy = state === 'connecting' || state === 'retrying'
  // The camera is the primary path where there is one (the APK); the browser
  // route cannot scan (see canScan in lib/scan.ts) and keeps its typed flow.
  const scannable = canScan()
  return (
    <div className="connect">
      <h1>Forge</h1>
      <p className="connect-lead">
        On the desktop, open <strong>Settings → Forge Mobile</strong>, turn the link on and tap
        <strong> Pair a phone</strong>.{' '}
        {scannable
          ? 'The QR code it shows carries the desktop address and the pairing code — one scan fills in both.'
          : 'Then type what it shows you here.'}
      </p>

      {scannable && (
        <>
          <button type="button" className="primary" disabled={busy} onClick={onScan}>
            {busy ? 'Connecting…' : 'Scan the code on your desktop'}
          </button>
          {hint && <p className="connect-detail">{hint}</p>}
          <div className="connect-or">
            <span>or type it in</span>
          </div>
        </>
      )}

      <label className="field">
        <span>Desktop address</span>
        <input
          value={address}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={`192.168.1.10:${MOBILE_PORT}`}
          onChange={(e) => onAddress(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Pairing code</span>
        <input
          value={code}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="From Settings › Forge Mobile"
          onChange={(e) => onCode(e.target.value)}
        />
      </label>

      <button type="button" className={scannable ? 'ghost' : 'primary'} disabled={busy} onClick={onPair}>
        {busy ? 'Connecting…' : 'Pair'}
      </button>

      {(detail || notice) && <p className="connect-detail">{notice || detail}</p>}

      <button type="button" className="connect-version" onClick={onUpdate}>
        Forge Mobile v{CURRENT_VERSION_NAME} · check for updates
      </button>
    </div>
  )
}

/* ----------------------------------------------------------------- helpers */

/**
 * Which project a session belongs to, so Back lands where you came from rather
 * than at the top of the project list.
 *
 * A pane's id *is* its PTY session id (see PaneLeaf in shared/types.ts), which
 * is what makes this a lookup rather than a join.
 */
function projectOfSession(picture: LinkPicture, sessionId: string): string | null {
  for (const [projectId, workspace] of Object.entries(picture.workspaces)) {
    for (const tab of workspace.tabs) {
      if (leavesOf(tab.root).some((leaf) => leaf.id === sessionId)) return projectId
    }
  }
  return null
}

/**
 * A name for the desktop's device list. `navigator.userAgentData` is the modern
 * source and Android Chrome has it; the UA string is the fallback, and "Phone"
 * is the answer when neither says anything useful.
 */
function deviceName(): string {
  const brands = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  if (brands?.platform) return brands.platform
  const match = /\(([^)]+)\)/.exec(navigator.userAgent)
  return match?.[1]?.split(';').pop()?.trim() || 'Phone'
}

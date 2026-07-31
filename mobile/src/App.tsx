import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MOBILE_PORT, type MobileSession } from '@shared/mobile'
import { Link, deviceId, type LinkPicture, type LinkState } from './lib/link'
import { forgetToken, pairTokenOf, readOrigin, readToken, toOrigin, writeOrigin, writeToken } from './lib/secure'
import { canScan, scanPairingCode } from './lib/scan'
import { Browser, leavesOf } from './components/Browser'
import { PaneView, paneListeners } from './components/PaneView'
import { UpdateSheet } from './components/Update'
import { CURRENT_VERSION_NAME, startAutoCheck, updateStore } from './lib/update'

/**
 * Forge Mobile.
 *
 * One socket, three screens: connect → projects/tabs → a terminal. The Link is
 * built once and kept for the life of the app, because a phone that rebuilds
 * its socket on every render is a phone that never finishes connecting.
 *
 * The connect screen has two shapes. An APK built by scripts/apk-build.mjs is
 * *stamped* with its desktop's tunnel address, so its first run is one button:
 * Connect, then a word pair to approve at the desk — nothing typed, nothing
 * read off a screen. The QR and typed paths stay behind "Other ways to
 * connect", because they remain the whole story for an unstamped build, a
 * second desktop, or a camera that will not cooperate.
 */

/**
 * The stamped desktop, normalised by the same `toOrigin` every other address
 * source goes through — the stamp is trusted to be an origin, not proven to be
 * one. '' (browser builds, unstamped APKs) simply means the one-tap screen
 * never exists.
 */
const BAKED = toOrigin(__BAKED_ORIGIN__, MOBILE_PORT)

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
  // Whether there is a newer APK, asked and answered without the user's
  // involvement. This is the fix for a real complaint: the update control
  // existed on every screen and was still undiscoverable, because "v0.2.0" in
  // a pill reads as a label, and nothing ever volunteered that a new version
  // was out. See startAutoCheck.
  const updatePhase = useSyncExternalStore(updateStore.subscribe, () => updateStore.getState().phase)
  const updateReady = updatePhase === 'available' || updatePhase === 'ready'

  useEffect(() => startAutoCheck(), [])
  // Mirrors the secure store, because readToken() is module state and React
  // cannot see it change. What it decides: a stamped, unpaired APK gets the
  // one-tap screen; everything else gets the form.
  const [hasToken, setHasToken] = useState(() => readToken() !== '')
  // "Other ways to connect" — the QR and typed paths, folded away rather than
  // deleted on a stamped build. Sticky until the user leaves it, so a failed
  // manual attempt does not bounce them back to the one-tap screen.
  const [manual, setManual] = useState(false)
  // Whether words were on screen this attempt. It is how a close after the
  // prompt (Steve said no) reads differently from a close before it (the
  // desktop is not accepting new phones) — the two need different sentences,
  // and the desktop's close code alone does not distinguish them.
  const [sawWords, setSawWords] = useState(false)

  // Built once. The callbacks below close over setState only, which React
  // guarantees is stable, so the Link never needs rebuilding.
  const link = useMemo(
    () =>
      new Link({
        onState: (next, why) => {
          setState(next)
          setDetail(why)
          if (next === 'awaiting') setSawWords(true)
        },
        onPicture: setPicture,
        onData: (id, data, replay) => paneListeners.get(id)?.(data, replay),
        onExit: (id) => {
          paneListeners.get(id)?.('\r\n\x1b[2m— the shell exited —\x1b[0m\r\n', false)
          // Leaving a dead terminal on screen is worse than going back to a
          // list that tells the truth.
          setScreen((current) => (current.at === 'pane' && current.session.id === id ? { at: 'browse', projectId: null } : current))
        },
        onPaired: (token) => {
          writeToken(token)
          setHasToken(true)
        },
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

  /**
   * The one-tap path. No code and no QR: an empty token makes the Link send
   * `requestPair`, the desktop raises its prompt, and everything after that
   * arrives as state — 'awaiting' with the words, then either a pairing or a
   * sentence explaining why not.
   */
  const approve = useCallback((): void => {
    setSawWords(false)
    writeOrigin(BAKED)
    setAddress(BAKED)
    link.connect({ origin: BAKED, token: '', deviceId: deviceId(), deviceName: deviceName() })
  }, [link])

  /** Walk away from the waiting screen. The desktop's prompt times out on its own. */
  const abandon = useCallback((): void => {
    link.disconnect()
    setSawWords(false)
  }, [link])

  const forget = useCallback((): void => {
    link.disconnect()
    forgetToken()
    setHasToken(false)
    setPicture(null)
    setScreen({ at: 'browse', projectId: null })
    setNotice('This phone is no longer paired.')
  }, [link])

  /* ------------------------------------------------------------- rendering */

  if (!picture) {
    // A stamped, unpaired APK opens on one button. A paired phone that is
    // merely reconnecting, an unstamped build, and anyone who chose "Other
    // ways to connect" all get the form instead — a paired phone must never
    // see a button that would ask the desktop to pair it again.
    const oneTap = BAKED !== '' && !hasToken && !manual
    // The update sheet is reachable from here too, deliberately: if a bad
    // build ever ships, "the desktop is unreachable" must not also mean "the
    // fix is unreachable".
    return (
      <>
        {oneTap ? (
          <FirstRun
            state={state}
            detail={detail}
            sawWords={sawWords}
            onConnect={approve}
            onCancel={abandon}
            onManual={() => {
              // Leave any pending approval behind before showing the form —
              // two simultaneous ways of asking is two prompts on the desktop.
              abandon()
              setManual(true)
            }}
            updateReady={updateReady}
            onUpdate={() => setShowUpdate(true)}
          />
        ) : (
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
            updateReady={updateReady}
            onUpdate={() => setShowUpdate(true)}
            onOneTap={BAKED !== '' && !hasToken ? () => setManual(false) : undefined}
          />
        )}
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
        updateReady={updateReady}
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
          onNewTab={(projectId, profileId, permissionMode) => {
            link.op({ op: 'create-tab', projectId, profileId, ...(permissionMode ? { permissionMode } : {}) })
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
  updateReady,
  onForget,
  onUpdate
}: {
  state: LinkState
  detail: string
  version: string
  updateReady: boolean
  onForget: () => void
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <div className={`status status-${state}`}>
      <span className="status-dot" />
      <span className="status-text">
        {state === 'live' ? `Forge ${version}` : detail || state}
      </span>
      {/* The app's own version, not the desktop's — tapping it is how the APK
          checks for and installs a newer self.
          When there is something to install it stops being a version label and
          says so in words. Not a coloured dot: Steve is red-green colourblind,
          and a badge that only differs by hue is a badge he cannot see. */}
      <button
        type="button"
        className={`status-version${updateReady ? ' is-update' : ''}`}
        onClick={onUpdate}
      >
        {updateReady ? 'Update' : `v${CURRENT_VERSION_NAME}`}
      </button>
      <button type="button" className="status-forget" onClick={onForget}>
        Unpair
      </button>
    </div>
  )
}

/**
 * The stamped APK's first run. One decision on screen at a time: a Connect
 * button, then the word pair, then — only if something went wrong — a sentence
 * saying exactly what and a way to try again.
 *
 * This is the screen Steve stares at wondering whether it worked, so every
 * state says what happens next, and no state spins forever: the Link bounds
 * the wait with APPROVAL_TIMEOUT_MS and reports 'expired' when nobody answers.
 * Refusal, denial and expiry are all carried by words, never by colour alone.
 */
function FirstRun({
  state,
  detail,
  sawWords,
  onConnect,
  onCancel,
  onManual,
  onUpdate,
  updateReady
}: {
  state: LinkState
  detail: string
  sawWords: boolean
  onConnect: () => void
  onCancel: () => void
  onManual: () => void
  onUpdate: () => void
  updateReady: boolean
}): React.JSX.Element {
  if (state === 'awaiting') {
    // The words arrive as one string and are shown exactly as sent — the
    // desktop minted them; this screen only has to make them legible from
    // arm's length while Steve looks across at the prompt.
    const words = detail.split(' ')
    return (
      <div className="connect">
        <p className="approve-title">Approve this on your desktop</p>
        <div className="approve-words">
          {/* Keyed by position, not by word: nothing stops the pair being the
              same word twice, and a duplicate key would drop one of them. */}
          {words.map((word, at) => (
            <span key={at} className="approve-word">
              {word}
            </span>
          ))}
        </div>
        <p className="connect-lead approve-lead">
          Forge on your desktop is asking about this phone and showing the same two words. Check they
          match, then choose <strong>Allow</strong> there. This screen moves on by itself.
        </p>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    )
  }

  const busy = state === 'connecting' || state === 'retrying'
  // Three distinct endings, three distinct truths. `sawWords` is what tells a
  // "no" after the prompt apart from a door that never opened.
  let trouble = ''
  let coach = ''
  if (state === 'refused') {
    if (sawWords) {
      trouble = detail || 'The desktop said no to this phone.'
      coach = 'If that was a mis-tap, Connect asks again with fresh words.'
    } else {
      trouble = detail || 'The desktop is not accepting new phones right now.'
      coach = 'At the desk, flick "Accept new phones" under Settings › Forge Mobile, then tap Connect again.'
    }
  } else if (state === 'expired') {
    trouble = detail || 'Nobody answered on the desktop, so those words have expired.'
    coach = 'Tap Connect for a fresh pair when you are back at the desk.'
  }

  return (
    <div className="connect">
      <h1>Forge</h1>
      <p className="connect-lead">
        This app was built for your desktop and already knows its address. One tap asks it to let this
        phone in — nothing to type, nothing to scan.
      </p>
      <button type="button" className="primary" disabled={busy} onClick={onConnect}>
        {busy ? 'Reaching your desktop…' : 'Connect'}
      </button>
      {busy && detail && <p className="connect-detail">{detail}</p>}
      {trouble && (
        <>
          <p className="connect-detail">{trouble}</p>
          <p className="connect-lead">{coach}</p>
        </>
      )}
      <button type="button" className="connect-version" onClick={onManual}>
        Other ways to connect
      </button>
      <button
        type="button"
        className={`connect-version${updateReady ? ' is-update' : ''}`}
        onClick={onUpdate}
      >
        {updateReady
          ? 'A newer Forge Mobile is ready · tap to update'
          : `Forge Mobile v${CURRENT_VERSION_NAME} · check for updates`}
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
  onUpdate,
  onOneTap,
  updateReady
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
  /** Present only on a stamped, unpaired build: the way back to one-tap connect. */
  onOneTap?: () => void
  updateReady: boolean
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

      {onOneTap && (
        <button type="button" className="connect-version" onClick={onOneTap}>
          Back to one-tap connect
        </button>
      )}

      <button
        type="button"
        className={`connect-version${updateReady ? ' is-update' : ''}`}
        onClick={onUpdate}
      >
        {updateReady
          ? 'A newer Forge Mobile is ready · tap to update'
          : `Forge Mobile v${CURRENT_VERSION_NAME} · check for updates`}
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

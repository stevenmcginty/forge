import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MOBILE_PORT, MOBILE_PROTO, type MobileSession } from '@shared/mobile'
import { isClaudeCommand } from '@shared/agents'
import { Link, deviceId, type LinkPicture, type LinkState } from './lib/link'
import {
  forgetToken,
  pairTokenOf,
  readDesktopName,
  readOrigin,
  readToken,
  toOrigin,
  writeDesktopName,
  writeOrigin,
  writeToken
} from './lib/secure'
import { canScan, scanPairingCode } from './lib/scan'
import { servedFromOrigin, shouldOfferInstall } from './lib/pwa'
import { Browser, leavesOf } from './components/Browser'
import { PaneView, paneListeners } from './components/PaneView'
import { TvConnect } from './components/TvConnect'
import { TvDashboard } from './components/TvDashboard'
import { homingLine, useDesktopHoming, type KnownDesktop } from './lib/homing'
import { isTv } from './lib/tv'
import { simDevice } from './lib/sim'
import { tvBridge } from './lib/tv-bridge'
import { mirrorListeners } from './lib/mirror'
import { UpdateSheet } from './components/Update'
import { CURRENT_VERSION_NAME, startAutoUpdate, updateStore } from './lib/update'

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
  // The last desktop reached, or — first run on the browser/PWA routes — the
  // address this very page was served from, which is that desktop by
  // definition. See servedFromOrigin in lib/pwa.ts.
  const [address, setAddress] = useState(() => readOrigin() || servedFromOrigin())
  const [code, setCode] = useState('')
  // Scan guidance is state of its own, not a `notice`: notices self-dismiss
  // after 4s, and "go to Android Settings and re-allow the camera" must stay
  // on screen until it has been acted on or superseded.
  const [hint, setHint] = useState('')
  const [showUpdate, setShowUpdate] = useState(false)
  // Whether there is a newer APK, asked and answered without the user's
  // involvement — and, since startAutoUpdate, fetched and offered to the
  // installer without it either. The pill is what is left over for the cases
  // Android will not let an app do on its own: the install grant, and a
  // confirmation the user declined.
  const updatePhase = useSyncExternalStore(updateStore.subscribe, () => updateStore.getState().phase)
  const updateReady = updatePhase === 'available' || updatePhase === 'ready'

  useEffect(() => startAutoUpdate(), [])
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

  // The latest picture, readable from the once-built Link callbacks below —
  // state is what renders, the ref is for handlers that outlive any render.
  const pictureRef = useRef<LinkPicture | null>(null)
  /**
   * The paired desktop's own name, mirrored out of the secure store the same
   * way `hasToken` is, because that store is module state React cannot watch.
   * It is how a device recognises the desktop it belongs to at an address it
   * has never seen before — see lib/homing.ts.
   */
  const [knownName, setKnownName] = useState(() => readDesktopName())
  /**
   * The address currently being dialled, saved only once it answers.
   *
   * Writing it at dial time — which is what every other route here does, and
   * what this one used to do — is fine when a human just typed the address, and
   * wrong when the television picked it off a broadcast: a machine on the wifi
   * answering "I am Forge" would overwrite the remembered address of the real
   * desktop merely by being asked. So the discovered address earns its place in
   * the store by completing a hello, not by being dialled.
   */
  const dialling = useRef('')

  // Built once. The callbacks below close over setState only, which React
  // guarantees is stable, so the Link never needs rebuilding.
  const link = useMemo(
    () =>
      new Link({
        onState: (next, why) => {
          setState(next)
          setDetail(why)
          if (next === 'awaiting') setSawWords(true)
          // An address that has answered a hello is an address worth keeping.
          // One that was refused is not, and must not be left lying around to
          // be written by whatever connects next.
          if (next === 'live' && dialling.current) {
            writeOrigin(dialling.current)
            setAddress(dialling.current)
            dialling.current = ''
          }
          if (next === 'refused' || next === 'expired' || next === 'idle') dialling.current = ''
        },
        onPicture: (next) => {
          pictureRef.current = next
          setPicture(next)
          // Learned rather than configured, and re-learned on every connection
          // so a renamed computer is a renamed computer here too.
          if (next.desktopName && next.desktopName !== readDesktopName()) {
            writeDesktopName(next.desktopName)
            setKnownName(next.desktopName)
          }
        },
        onData: (id, data, replay) => paneListeners.get(id)?.(data, replay),
        onExit: (id, exitCode) => {
          paneListeners.get(id)?.('\r\n\x1b[2m— the shell exited —\x1b[0m\r\n', false)
          // Crosses the TV bridge already named: the native layer has no
          // picture to resolve an id against. Inert where nothing listens.
          tvBridge.emit({ kind: 'session-exit', session: sessionNameOf(pictureRef.current, id), exitCode })
          // Leaving a dead terminal on screen is worse than going back to a
          // list that tells the truth.
          setScreen((current) => (current.at === 'pane' && current.session.id === id ? { at: 'browse', projectId: null } : current))
        },
        onPaired: (token) => {
          writeToken(token)
          setHasToken(true)
        },
        /**
         * The saved credential is dead — revoked at the desk, or this desktop's
         * settings no longer hold this device. Throwing it away is the honest
         * move and the useful one: what is left is an unpaired device, which is
         * a state both routes already know how to get out of. A television
         * drops back to its search-and-ask screen, and a stamped phone gets its
         * one-tap button back.
         *
         * Only ever fired for a device token, never for a mistyped pairing
         * code — see onTokenRejected in lib/link.ts.
         */
        onTokenRejected: () => {
          forgetToken()
          setHasToken(false)
          setKnownName('')
        },
        onNotice: setNotice,
        // Straight across the bridge: the Link already validated the id, and
        // the native YouTube layer is the only consumer there will ever be.
        onTvPlay: (video) => tvBridge.emit({ kind: 'tv-play', video }),
        // Same shape as onData above, and for the same reason: these callbacks
        // are built once, before any screen exists, so they route through a
        // module-level seam rather than through props. At most one screen on
        // this device is ever mirroring, so it is a slot rather than a map.
        onMirrorSignal: (data) => mirrorListeners.signal?.(data),
        onMirrorStop: (reason) => mirrorListeners.stop?.(reason)
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
    // The remembered name goes with the credential it was learned on. A
    // television still homing in on a desktop it can no longer open would be
    // announcing a reunion it cannot deliver.
    setKnownName('')
    setPicture(null)
    setScreen({ at: 'browse', projectId: null })
    setSawWords(false)
    setNotice(isTv() ? 'This television is no longer paired.' : 'This phone is no longer paired.')
  }, [link])

  /**
   * The desktop this device is paired to, if it is paired at all.
   *
   * Held here rather than built during render so the search below is handed the
   * same object each time: it feeds an effect that asks the network and dials on
   * its own, and an identity that changed every render would restart that effect
   * every render.
   *
   * No longer a television's privilege. A phone loses its desktop to exactly the
   * same expired DHCP lease, and used to have exactly one way out of it: walk to
   * the desk and scan the QR code again. The rule that keeps this safe is not
   * "only a TV may do it" — it is `pickDesktop` below, which is the same rule
   * either way.
   */
  const known = useMemo<KnownDesktop | null>(() => {
    if (!hasToken) return null
    return { name: knownName, origin: toOrigin(address, MOBILE_PORT) }
  }, [address, hasToken, knownName])

  /**
   * Dial a desktop this device chose — from the television's list, or by finding
   * the one it is paired to at a new address.
   *
   * The one rule: the saved token rides along only to the address it was issued
   * at. Anywhere else — a desktop found on the network, however convincing its
   * name — is dialled with nothing, so the far end has to raise its own prompt
   * and a human has to press Allow. A credential here is a shell, and an answer
   * to a broadcast is not evidence of anything.
   */
  const pickDesktop = useCallback(
    (picked: string): void => {
      const origin = toOrigin(picked, MOBILE_PORT)
      if (!origin) return
      setSawWords(false)
      dialling.current = origin
      const token = known && origin === known.origin ? readToken() : ''
      link.connect({ origin, token, deviceId: deviceId(), deviceName: deviceName() })
    },
    [known, link]
  )

  /**
   * The television's search-and-choose screen is showing.
   *
   * Two things need to agree about this, so it is worked out once: what gets
   * rendered further down, and whether the network is worth asking. A shared
   * build with no address stamped into it has nowhere else to get one, and
   * anybody who chose "Type the address instead" is taken at their word.
   */
  const tvSearchScreen = isTv() && BAKED === '' && !manual

  /**
   * One search for the whole app, wherever it happens to be.
   *
   * At this level rather than inside a screen because the moment that matters
   * most is the one where no connect screen exists: a phone that was happily
   * live when the desktop's address changed keeps its picture, keeps showing the
   * project list, and quietly retries a dead address behind it. A search that
   * only ran on a connect screen would never run then — which is precisely why
   * the television healed itself and the phone did not.
   *
   * Worth asking when this device is not currently watching a desktop *and*
   * there is an answer it could use: a paired device of any shape needs to know
   * whether the desktop it belongs to has moved, and an unpaired television
   * needs the list to choose from. An unpaired phone has a QR code and a text
   * field and nowhere to put a discovered desktop, so it stays off the air
   * rather than broadcasting on somebody's wifi for no reason.
   */
  const homing = useDesktopHoming({
    state,
    known,
    proto: MOBILE_PROTO,
    active: state !== 'live' && (known !== null || tvSearchScreen),
    onPick: pickDesktop
  })

  /**
   * What the phone says about a link that is not up.
   *
   * '' whenever the Link's own words are the better ones on their own — a
   * refusal, an expiry, an approval nobody's search asked for — and a sentence
   * about the search whenever they are not. See homingLine in lib/homing.ts for
   * why "Reconnecting in 15s…" by itself is not good enough.
   */
  const searchLine = homingLine({ state, detail, known, homing })

  /* ------------------------------------------------------------- rendering */

  if (!picture) {
    // A television with no address baked into it — the shared build, installed
    // by somebody this desktop has never met — asks the network instead of
    // asking a person to type an IP with a D-pad. A stamped TV build keeps its
    // one-button screen, and anyone who chose "Type the address instead" is
    // taken at their word; everything else on a television lands here.
    //
    // Including a television that is already paired, which is the case this
    // used to get wrong. Being paired and being connected are different facts,
    // and a paired television whose desktop is simply not home was shown the
    // phone's pairing form — an address and a code, to be entered with a
    // D-pad, for a pairing it already had. It read as "Forge has forgotten
    // me", so that is what everyone concluded. What it should say is who it is
    // waiting for, and then go and find them.
    if (tvSearchScreen) {
      return (
        <TvConnect
          state={state}
          detail={detail}
          proto={MOBILE_PROTO}
          known={known}
          homing={homing}
          onPick={pickDesktop}
          onCancel={abandon}
          onType={() => {
            abandon()
            setManual(true)
          }}
          onForget={forget}
        />
      )
    }

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
            searchLine={searchLine}
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

  // A TV is a monitor with a remote, not a phone: one wall instead of
  // screens, walked with a D-pad and watched, never typed into. Connecting
  // still uses the phone screens above — pairing is the one interaction a TV
  // cannot do without.
  if (isTv()) {
    return <TvDashboard link={link} picture={picture} state={state} detail={detail} notice={notice} />
  }

  return (
    <div className="app">
      <StatusStrip
        state={state}
        detail={detail}
        searchLine={searchLine}
        version={picture.appVersion}
        updateReady={updateReady}
        onForget={forget}
        onUpdate={() => setShowUpdate(true)}
      />

      {/*
        A line, not a toast. Notices self-dismiss after four seconds because
        they are things that just happened; this is a condition that lasts, and
        one that has to be readable at the exact moment somebody is tapping a
        button that is not working. It sits directly under the status strip so
        it is the first thing below "Forge 1.x" — the place a phone already
        looks when it wonders whether the desktop is there.

        Words, not colour: the palette is the strip's own waiting amber, and
        every bit of the meaning is in the sentence.
      */}
      {picture.desktop && (
        <p className="desktop-banner" role="status">
          <strong>The desktop is restarting its window.</strong> Panes below are still live and still scrolling; taps
          start working again when it comes back.
        </p>
      )}

      {screen.at === 'pane' ? (
        <PaneView
          link={link}
          /*
           * The live row, not the one captured when the pane was opened. The
           * desktop owns this PTY's grid and pushes a fresh session list every
           * time it moves one (see the `onResize` sink in
           * electron/mobile-host.ts), and the whole point of that push is the
           * cols/rows on it — which a snapshot taken minutes ago would throw
           * away. The snapshot stays the fallback for the beat between a pane
           * dying and `onExit` walking this screen back to the list.
           */
          session={picture.sessions.find((s) => s.id === screen.session.id) ?? screen.session}
          title={screen.title}
          fontSize={13}
          onBack={() => setScreen({ at: 'browse', projectId: projectOfSession(picture, screen.session.id) })}
          /*
           * Foreman's controls, resolved here because the pane screen knows a
           * session and the op needs a project. Every draw of the state comes
           * off the picture — the phone never guesses what the desktop said.
           */
          foreman={picture.foreman[screen.session.id]}
          drivable={sessionIsClaude(picture, screen.session.id)}
          canTakeOver={Boolean(sessionLeafOf(picture, screen.session.id)?.sessionId)}
          onForeman={(on, seed) => {
            const projectId = projectOfSession(picture, screen.session.id)
            if (!projectId) return
            if (on) link.foremanStart(projectId, screen.session.id, seed)
            else link.foremanStop(projectId, screen.session.id)
          }}
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
          onSendToTv={(video) => {
            link.tvPlay(video)
            // Optimistic, and honestly so: the desktop relays without
            // answering, so the only thing this phone can truthfully claim is
            // that it asked. If nothing is listening the desktop says so, and
            // that arrives as a notice through the same strip.
            setNotice('Sent to the TV.')
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
  searchLine,
  version,
  updateReady,
  onForget,
  onUpdate
}: {
  state: LinkState
  detail: string
  /**
   * What the search has to say, and '' when it has nothing. It wins over the
   * Link's own `detail` because the two are answers to different questions:
   * `detail` says when the next attempt is, and this says whether the address
   * being attempted is one the desktop still lives at.
   */
  searchLine: string
  version: string
  updateReady: boolean
  onForget: () => void
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <div className={`status status-${state}`}>
      <span className="status-dot" />
      <span className="status-text">
        {state === 'live' ? `Forge ${version}` : searchLine || detail || state}
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
  searchLine,
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
  /**
   * The search's sentence, or '' when it has nothing to say.
   *
   * A phone that is already paired reaches this screen too — the picture only
   * exists once a hello has been answered, so a phone whose desktop moved
   * overnight opens on a pairing form it does not need. Saying which desktop is
   * missing, and that this phone is out looking for it, is the difference
   * between that form reading as "Forge has forgotten you" and reading as "your
   * desktop is not on this wifi yet".
   */
  searchLine: string
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
  // An iPhone in a Safari tab, on an origin where installing would actually
  // work. See shouldOfferInstall in lib/pwa.ts.
  const offerInstall = shouldOfferInstall()
  return (
    <div className="connect">
      <h1>Forge</h1>

      {/*
        Above the pairing fields rather than below them, because the order is
        load-bearing: iOS gives a home-screen web app its own storage container,
        separate from Safari's. A phone paired in the tab and *then* installed
        arrives at this same screen again with nothing carried over, which reads
        as the pairing having failed. Installing first costs one extra tap and
        makes that impossible.
      */}
      {offerInstall && (
        <p className="connect-install">
          <strong>On iPhone, install this first.</strong> Tap Share, then <strong>Add to Home Screen</strong>, and open
          Forge from the icon. Pair inside that app — iOS keeps its storage separate from Safari's, so a phone paired in
          this tab would arrive unpaired in the installed one.
        </p>
      )}

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

      {/* A notice is something that just happened and self-dismisses, so it
          goes first; after that the search's sentence beats the Link's, for the
          reason given on `searchLine` above. */}
      {(notice || searchLine || detail) && <p className="connect-detail">{notice || searchLine || detail}</p>}

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
/** The layout leaf behind a pane id, or null for a pane no tab names. */
function sessionLeafOf(picture: LinkPicture, sessionId: string): { profileId: string; sessionId?: string } | null {
  for (const workspace of Object.values(picture.workspaces)) {
    for (const tab of workspace.tabs) {
      const leaf = leavesOf(tab.root).find((l) => l.id === sessionId)
      if (leaf) return leaf
    }
  }
  return null
}

/** Whether this pane's profile is Claude Code — the panes Foreman can drive. */
function sessionIsClaude(picture: LinkPicture, sessionId: string): boolean {
  const leaf = sessionLeafOf(picture, sessionId)
  if (!leaf) return false
  const profile = picture.profiles.find((p) => p.id === leaf.profileId)
  return isClaudeCommand(profile?.command ?? '')
}

function projectOfSession(picture: LinkPicture, sessionId: string): string | null {
  for (const [projectId, workspace] of Object.entries(picture.workspaces)) {
    for (const tab of workspace.tabs) {
      if (leavesOf(tab.root).some((leaf) => leaf.id === sessionId)) return projectId
    }
  }
  return null
}

/**
 * "Project · pane" for the TV bridge, resolved while the leaf still exists —
 * an exited session leaves its pane behind in the layout, which is what makes
 * this lookup work at exactly the moment it is needed.
 */
function sessionNameOf(picture: LinkPicture | null, sessionId: string): string {
  if (!picture) return 'A pane'
  for (const [projectId, workspace] of Object.entries(picture.workspaces)) {
    for (const tab of workspace.tabs) {
      for (const leaf of leavesOf(tab.root)) {
        if (leaf.id !== sessionId) continue
        const project = picture.projects.find((p) => p.id === projectId)
        const profile = picture.profiles.find((p) => p.id === leaf.profileId)
        const pane = leaf.title || profile?.name || 'pane'
        return project ? `${project.name} · ${pane}` : pane
      }
    }
  }
  return 'A pane'
}

/**
 * A name for the desktop's device list. `navigator.userAgentData` is the modern
 * source and Android Chrome has it; the UA string is the fallback, and "Phone"
 * is the answer when neither says anything useful.
 *
 * A television says so. The name is what the approval prompt puts in front of
 * whoever is deciding whether to press Allow, and on a Fire TV every automatic
 * source answers with a build string ("AFTKA") that identifies the device to
 * nobody. "TV" is the word the person at the desk is thinking.
 *
 * The desk's preview says which phone it is playing (lib/sim.ts): a frame has
 * a desktop UA, and "Windows" in the device list is a lie about what this view
 * of the app is for. The name is also how the Devices view recognises its own
 * frames checking in.
 */
function deviceName(): string {
  return isTv() ? `TV (${hardwareName()})` : hardwareName()
}

function hardwareName(): string {
  const sim = simDevice()
  if (sim) return sim === 'ios' ? 'Preview · iPhone' : 'Preview · Android'
  const brands = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  if (brands?.platform) return brands.platform
  const match = /\(([^)]+)\)/.exec(navigator.userAgent)
  return match?.[1]?.split(';').pop()?.trim() || 'Phone'
}

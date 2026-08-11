import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toDataURL } from 'qrcode'
import { normaliseNgrokDomain } from '@shared/mobile'
import type { ForgeTvStatus, MobileDeviceRecord, MobilePairOffer, MobileStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Card, maskKey, Row, Section, StateChip, TextField, Toggle, type ChipTone } from './parts'

/**
 * Forge Mobile — your terminals, from your phone.
 *
 * The panel's job is to answer four questions in order, because they are the
 * order someone actually asks them in:
 *
 *   1. Is it on?           the switch, and what it is listening on
 *   2. What do I type?     the reachable addresses, because `0.0.0.0` is not one
 *      — and, once, the ngrok card: paste the authtoken and the account's
 *      auto-assigned domain, and the answer becomes one URL, forever
 *   3. How do I pair?      "Accept new phones" first — arm it, open the app on
 *      the phone, tap Allow on the prompt that appears here. Nothing typed,
 *      nothing read off a screen; the tap replaces the code, not the
 *      authorisation. The QR card stays below it as the fallback for a phone
 *      that has no stamped address (a browser, an old build).
 *   4. Which phones?       the device list, and the button that removes one
 *   5. And the telly?      Forge TV, at the bottom, because it is a different
 *      device with a different answer: no pairing QR a remote could scan, no
 *      tunnel, just an APK built on demand against this machine's LAN address
 *      and a URL to type into the television's Downloader app.
 *
 * One naming rule, learned the hard way: the phone's field is called
 * **Desktop address**, so every card here that shows a value destined for that
 * field calls it the same thing. "Public address" here and "Desktop address"
 * there read as two different questions, and Steve answered neither.
 *
 * The authtoken field is write-only: what was saved is shown masked and is
 * never rendered back in full, because a settings page is exactly where a
 * screen-share lingers.
 *
 * Everything destructive is one tap and takes effect immediately: revoking a
 * device closes its live socket rather than waiting for it to reconnect, and
 * turning the switch off closes the server and every socket at once. That is
 * deliberate — a settings page that can only *schedule* a revocation is not a
 * kill switch, and this is the page you open when a phone has gone missing.
 */

/** How long a freshly minted pairing code stays on screen, in seconds. */
function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** `9:42` — the accept window is minutes long, so seconds alone would mislead. */
function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function MobileSection(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [tv, setTv] = useState<ForgeTvStatus | null>(null)
  const [offer, setOffer] = useState<Extract<MobilePairOffer, { ok: true }> | null>(null)
  const [qr, setQr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [domainError, setDomainError] = useState('')
  // Which URL was copied, not merely that one was: two cards on this page have
  // a Copy button now, and a boolean would flash "Copied" on both.
  const [copied, setCopied] = useState('')

  useEffect(() => {
    void window.forge.mobile.status().then(setStatus)
    return window.forge.mobile.onStatus(setStatus)
  }, [])

  // A separate stream from the one above, because a running build changes this
  // line by line for minutes and nothing else on this page does.
  useEffect(() => {
    void window.forge.mobile.tvStatus().then(setTv)
    return window.forge.mobile.onTvStatus(setTv)
  }, [])

  // Two countdowns share this clock: the pairing code's TTL and the accept
  // window. When the window lapses, `armed` flips false and the tick stops.
  const acceptUntil = status?.acceptUntil ?? 0
  const armed = acceptUntil > now

  // Main owns `mobileAcceptUntil` (it arms, disarms, and expires it), but the
  // renderer's debounced full-object settings save would write a stale copy
  // straight back over it — the same hazard the tunnel fields dodge with
  // patchSettings below. Mirror what main reports, so a manual disarm cannot
  // be silently re-armed by an unrelated settings change a moment later.
  useEffect(() => {
    if (status && state.settings.mobileAcceptUntil !== status.acceptUntil) {
      actions.patchSettings({ mobileAcceptUntil: status.acceptUntil })
    }
  }, [status, state.settings.mobileAcceptUntil, actions])

  // Only ticks while something on this page changes second by second.
  useEffect(() => {
    if (!offer && !armed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [offer, armed])

  // A code that has expired is worse than no code: it looks usable and is not.
  useEffect(() => {
    if (offer && secondsLeft(offer.expiresAt, now) === 0) setOffer(null)
  }, [offer, now])

  // The QR is derived state: it exists exactly as long as the offer does, so
  // expiry and Cancel clear it through the same `offer` path — a QR outliving
  // its code would look scannable and pair nothing. Encoding happens here, on
  // this machine; the link embeds the pairing credential and must never go to
  // some QR-rendering service. Dark modules on a light ground with a real
  // quiet zone, whatever theme the card is drawn in — inverted codes fail on
  // many scanner libraries, and a margin-less code fails on most.
  useEffect(() => {
    if (!offer?.link) {
      setQr('')
      return
    }
    let stale = false
    toDataURL(offer.link, {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 256,
      color: { dark: '#000000', light: '#ffffff' }
    })
      .then((url) => {
        if (!stale) setQr(url)
      })
      .catch(() => {
        if (!stale) setQr('')
      })
    return () => {
      stale = true
    }
  }, [offer?.link])

  const toggle = useCallback(async (on: boolean) => {
    setBusy(true)
    setError('')
    try {
      setStatus(on ? await window.forge.mobile.start() : await window.forge.mobile.stop())
      if (!on) setOffer(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleAccept = useCallback(async (on: boolean) => {
    setError('')
    setNow(Date.now())
    setStatus(await window.forge.mobile.setAccept(on))
  }, [])

  const pair = useCallback(async () => {
    setError('')
    const result = await window.forge.mobile.pair()
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNow(Date.now())
    setOffer(result)
  }, [])

  const cancelPairing = useCallback(async () => {
    await window.forge.mobile.pairCancel()
    setOffer(null)
  }, [])

  const revoke = useCallback(async (device: MobileDeviceRecord) => {
    setStatus(await window.forge.mobile.revoke(device.id))
  }, [])

  /* ------------------------------------------------------------ the tunnel */

  // Both writes go two ways on purpose: patchSettings keeps the renderer's
  // settings copy honest (its debounced full-object save would otherwise
  // revert what main just wrote), and setTunnel makes main apply it now.
  const saveAuthtoken = useCallback(
    (next: string) => {
      const value = next.trim()
      if (!value) return
      actions.patchSettings({ mobileNgrokAuthtoken: value })
      void window.forge.mobile.setTunnel({ authtoken: value }).then(setStatus)
    },
    [actions]
  )

  const saveDomain = useCallback(
    (next: string) => {
      const value = normaliseNgrokDomain(next)
      setDomainError(
        next.trim() && !value ? 'That does not look like a domain — copy it exactly as the ngrok dashboard shows it.' : ''
      )
      actions.patchSettings({ mobileNgrokDomain: value })
      void window.forge.mobile.setTunnel({ domain: value }).then(setStatus)
    },
    [actions]
  )

  const toggleTunnel = useCallback(
    async (on: boolean) => {
      actions.patchSettings({ mobileTunnel: on ? 'ngrok' : 'off' })
      setStatus(on ? await window.forge.mobile.startTunnel() : await window.forge.mobile.stopTunnel())
    },
    [actions]
  )

  const buildTv = useCallback(async () => {
    setTv(await window.forge.mobile.tvBuild())
  }, [])

  const fetchTv = useCallback(async () => {
    setTv(await window.forge.mobile.tvFetch())
  }, [])

  const copyUrl = useCallback(async (url: string) => {
    await window.forge.clipboard.writeText(url)
    setCopied(url)
    setTimeout(() => setCopied(''), 1500)
  }, [])

  if (!status) {
    return (
      <Section title="Forge Mobile">
        <Card tone="quiet">Loading…</Card>
      </Section>
    )
  }

  const tone: ChipTone =
    status.state === 'listening' ? 'ok' : status.state === 'error' ? 'danger' : 'off'

  const authtoken = state.settings.mobileNgrokAuthtoken
  const domain = state.settings.mobileNgrokDomain
  const tunnel = status.tunnel
  const tunnelTone: ChipTone =
    tunnel.state === 'live' ? 'ok' : tunnel.state === 'error' ? 'danger' : tunnel.state === 'off' ? 'off' : 'warn'
  const tunnelOn = state.settings.mobileTunnel === 'ngrok'

  return (
    <Section
      title="Forge Mobile"
      blurb={
        <>
          Your real terminals, on your phone — see the tabs, open new ones, and type into any pane.
          Off until you switch it on: nothing binds a port or issues a credential before that.
          The full picture is in <code>docs/MOBILE.md</code>.
        </>
      }
    >
      <Card
        title="The link"
        actions={<StateChip tone={tone}>{status.state === 'listening' ? 'Listening' : status.state}</StateChip>}
        hint={
          status.detail ||
          'A phone that can reach this machine can type into your shells. Only pair one you trust, and revoke it below the moment you stop trusting it.'
        }
      >
        <Row
          label="Allow phones to connect"
          hint={busy ? 'Working…' : `Port ${status.port}`}
        >
          <Toggle checked={status.enabled} onChange={(on) => void toggle(on)} label="Enable Forge Mobile" />
        </Row>

        {/* "Desktop address" because that is what the phone's pairing form
            calls its field — one name on both screens, or it reads as two
            different questions. */}
        {status.state === 'listening' && (
          <Row
            label="Desktop address"
            hint={
              status.addresses.length > 1
                ? 'What the phone asks for. A 100.x address is your tailnet and works anywhere; the others are this network only.'
                : 'What the phone asks for — works while it is on this network.'
            }
          >
            <div className="mobile-addresses">
              {status.addresses.length === 0 ? (
                <span className="mobile-address is-empty">No network address — is this machine online?</span>
              ) : (
                status.addresses.map((address) => (
                  <code key={address} className="mobile-address">
                    {address}:{status.port}
                  </code>
                ))
              )}
            </div>
          </Row>
        )}
      </Card>

      <Card
        title="Reach it from anywhere"
        actions={<StateChip tone={tunnelTone}>{tunnel.state === 'live' ? 'Live' : tunnel.state}</StateChip>}
        hint={
          <>
            A permanent address over an ngrok tunnel: set it up once and the phone keeps the same URL forever,
            on any network. The free tier moves 1&nbsp;GB a month through it — terminal output counts, and a
            redrawing TUI or a long build log adds up, so it suits typing and reading more than tailing firehoses.
          </>
        }
      >
        <p className="scard__hint">First time with ngrok? Quick setup:</p>
        <ol className="scard__steps">
          <li>Create a free account at <span className="mono">ngrok.com</span>.</li>
          <li>
            Copy your authtoken from <span className="mono">dashboard.ngrok.com/get-started/your-authtoken</span>{' '}
            and paste it below.
          </li>
          <li>
            Claim your free static domain at <span className="mono">dashboard.ngrok.com/domains</span> and paste it
            below — copy it exactly, don’t invent one.
          </li>
        </ol>

        <Row
          label="ngrok authtoken"
          hint={
            authtoken
              ? `Saved (${maskKey(authtoken)}) — paste a new one to replace it.`
              : 'From the ngrok dashboard, under Your Authtoken.'
          }
        >
          {/* The field is write-only: the saved token is shown masked in the
              hint and never rendered back in full, revealable or otherwise. */}
          <TextField
            value=""
            password
            mono
            placeholder={authtoken ? 'paste to replace' : 'paste your authtoken'}
            onCommit={saveAuthtoken}
          />
        </Row>
        <Row
          label="Your ngrok domain"
          hint="Auto-assigned to your account — copy it from the dashboard, don’t invent one."
        >
          <TextField
            value={domain}
            mono
            placeholder="assigned-name.ngrok-free.dev"
            onCommit={saveDomain}
          />
        </Row>
        <Row
          label="Keep the tunnel up"
          hint="Starts with the phone link and restarts itself if it drops. Off closes the public address entirely."
        >
          <Toggle checked={tunnelOn} onChange={(on) => void toggleTunnel(on)} label="Enable the ngrok tunnel" />
        </Row>

        {tunnel.state === 'live' && (
          <Row
            label="Desktop address"
            hint="The phone's Desktop address, from anywhere in the world — the whole URL, no port on the end. It replaces the LAN address above."
          >
            <div className="mobile-tunnel-url">
              <code className="mobile-address">{tunnel.url}</code>
              <button type="button" className="sbtn" onClick={() => void copyUrl(tunnel.url)}>
                {copied === tunnel.url ? 'Copied' : 'Copy'}
              </button>
            </div>
          </Row>
        )}

        {domainError && <p className="mobile-error">{domainError}</p>}
        {tunnel.detail && <p className={tunnel.state === 'error' ? 'mobile-error' : 'scard__hint'}>{tunnel.detail}</p>}
        {tunnelOn && status.host !== '127.0.0.1' && (
          <p className="scard__hint">
            The bind host is <span className="mono">{status.host}</span>, so this network can still reach port{' '}
            {status.port} directly — convenient at home. To make the tunnel the only way in, set{' '}
            <span className="mono">mobileBindHost</span> to <span className="mono">127.0.0.1</span> in{' '}
            <span className="mono">settings.json</span>.
          </p>
        )}
      </Card>

      {status.state === 'listening' && (
        <Card
          title="Accept new phones"
          actions={
            /* The chip says "Accepting" and counts down — state carried in
               words and numbers, with the tone as reinforcement only. */
            <StateChip tone={armed ? 'ok' : 'off'}>
              {armed ? (
                <>
                  Accepting · <span className="mobile-accept__left">{countdown(secondsLeft(acceptUntil, now))}</span>
                </>
              ) : (
                'Off'
              )}
            </StateChip>
          }
          hint={
            armed
              ? 'Open the Forge app on the phone. It connects and shows two words; a prompt appears on this screen with the same words. Nothing pairs until you press Allow on that prompt.'
              : 'The no-typing way to pair. While this is on, a phone running the Forge app can ask to connect — each one still needs your Allow on a prompt here, so switching it on pairs nothing by itself.'
          }
        >
          <Row
            label="Accept new phones"
            hint={armed ? 'On — it switches itself off when the countdown ends.' : 'Arms for ten minutes, then switches itself off.'}
          >
            <Toggle checked={armed} onChange={(on) => void toggleAccept(on)} label="Accept new phones" />
          </Row>
        </Card>
      )}

      {status.state === 'listening' && (
        <Card
          title="Pair a phone"
          hint="The QR and the code under it are the same single-use credential, and it expires in five minutes. Anyone who can see this screen before then can pair a phone, so treat it like a password you are saying out loud."
          actions={
            offer ? (
              <button type="button" className="sbtn" onClick={() => void cancelPairing()}>
                Cancel
              </button>
            ) : (
              <button type="button" className="sbtn sbtn--go" onClick={() => void pair()}>
                Pair a phone
              </button>
            )
          }
        >
          {offer ? (
            <div className="mobile-pair">
              {/* The QR carries the whole handshake — address and code in one
                  forge://pair link, built in main by the same shared/mobile.ts
                  builder the phone parses with. The text below is the same two
                  values for a camera that will not cooperate, not a second
                  source of truth. */}
              {qr && <img className="mobile-pair__qr" src={qr} alt="Pairing QR code" width={256} height={256} />}
              <p className="mobile-pair__lead">
                Scan this from the Forge app on the phone — it carries the address and the code, so pairing is one scan.
              </p>
              <div className="mobile-pair__fallback">
                <p className="mobile-pair__lead">No camera? Type these into the phone instead:</p>
                <div className="mobile-pair__value">
                  <span className="mobile-pair__label">Desktop address</span>
                  <code className="mobile-address">{offer.url || `${offer.host}:${offer.port}`}</code>
                </div>
                <div className="mobile-pair__value">
                  <span className="mobile-pair__label">Pairing code</span>
                  <code className="mobile-pair__code">{offer.token}</code>
                </div>
              </div>
              <p className="mobile-pair__ttl">
                Expires in {secondsLeft(offer.expiresAt, now)}s
              </p>
            </div>
          ) : (
            <p className="scard__hint">
              Open Forge Mobile on the phone, then tap this — you get a QR to scan, and the address and code to type if you would rather.
            </p>
          )}
          {error && <p className="mobile-error">{error}</p>}
        </Card>
      )}

      <Card
        title="Paired phones"
        hint={
          status.devices.length > 0
            ? 'Removing a phone hangs up on it immediately and its token stops working. It would have to be paired again.'
            : undefined
        }
      >
        {status.devices.length === 0 ? (
          <p className="scard__hint">No phones paired.</p>
        ) : (
          <ul className="mobile-devices">
            {status.devices.map((device) => (
              <li key={device.id} className="mobile-device">
                <span className="mobile-device__name">{device.name}</span>
                <span className="mobile-device__seen">{lastSeen(device.lastSeenAt)}</span>
                <button type="button" className="sbtn sbtn--danger" onClick={() => void revoke(device)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {status.connected > 0 && (
          <p className="scard__hint">
            {status.connected} {status.connected === 1 ? 'phone is' : 'phones are'} connected right now.
            This machine will not sleep while that is true.
          </p>
        )}
      </Card>

      <ForgeTvCard
        tv={tv}
        copied={copied}
        control={state.settings.mobileControlEnabled}
        onControl={(on) => actions.patchSettings({ mobileControlEnabled: on })}
        audio={state.settings.mobileMirrorAudio}
        onAudio={(on) => actions.patchSettings({ mobileMirrorAudio: on })}
        onBuild={buildTv}
        onFetch={fetchTv}
        onCopy={copyUrl}
      />
    </Section>
  )
}

/**
 * Forge TV — the same app, on the television, installed without a cable.
 *
 * A Fire TV Stick has no file manager and no browser: the only way an APK gets
 * onto one is a URL typed into its Downloader app with a remote control, one
 * character at a time. So this card is two facts and a button — get the app,
 * then type this — and the URL never changes, because retyping it on a D-pad is
 * the expensive part.
 *
 * There are two ways to have an app, and the card says which one this is,
 * because they are not the same binary:
 *
 *  - **Downloaded.** The published build, signed once and fetched from the
 *    release feed. No address inside it: it asks the network which Forge is
 *    there (see the discovery block in shared/mobile.ts). Works on any machine
 *    — no Android SDK, no JDK, no keystore — and is the one worth sending to
 *    somebody else, because it is not addressed to this house.
 *  - **Built.** Assembled from a checkout with this desktop's LAN address baked
 *    in. Minutes of Vite and Gradle, and correct for exactly one network.
 *
 * The build reports its current line while it runs, which is the honest thing
 * to show for work that long: a spinner with no words looks identical to a hang.
 */
function ForgeTvCard({
  tv,
  copied,
  control,
  onControl,
  audio,
  onAudio,
  onBuild,
  onFetch,
  onCopy
}: {
  tv: ForgeTvStatus | null
  copied: string
  control: boolean
  onControl: (on: boolean) => void
  audio: boolean
  onAudio: (on: boolean) => void
  onBuild: () => Promise<void>
  onFetch: () => Promise<void>
  onCopy: (url: string) => Promise<void>
}): ReactNode {
  if (!tv) return null

  const building = tv.phase === 'building'
  const fetching = tv.phase === 'fetching'
  const busy = building || fetching
  const have = tv.sizeBytes > 0
  const tone: ChipTone = busy ? 'warn' : tv.phase === 'error' ? 'danger' : have ? 'ok' : 'off'
  const megabytes = (tv.sizeBytes / (1024 * 1024)).toFixed(1)

  return (
    <Card
      title="Forge TV"
      actions={
        <>
          <button type="button" className="sbtn sbtn--go" disabled={busy} onClick={() => void onFetch()}>
            {fetching ? 'Downloading…' : tv.source === 'downloaded' ? 'Check for a newer one' : 'Download the TV app'}
          </button>
          {/* Second, and only in a checkout: the built app is the specialist
              answer — this desktop's address, this network. Offering it first
              on a machine that can do both would put the slower, narrower
              route in front of the one that works everywhere. */}
          {tv.supported && (
            <button type="button" className="sbtn" disabled={busy} onClick={() => void onBuild()}>
              {building ? 'Building…' : 'Build one instead'}
            </button>
          )}
        </>
      }
      hint="The television downloads the app from this desktop over your wifi, so the link above has to be on. Installing it again over the top is the whole update mechanism — there is no store."
    >
      <Row
        label="The television app"
        hint={
          !have
            ? 'Nothing here yet. The download needs no Android tools and takes about twenty megabytes.'
            : tv.source === 'downloaded'
              ? `Downloaded ${lastSeen(tv.builtAt)} · ${megabytes} MB${tv.version ? ` · version ${tv.version}` : ''} · finds this desktop by itself, so it works on anybody’s network`
              : `Built here ${lastSeen(tv.builtAt)} · ${megabytes} MB · this desktop’s address is baked in, so rebuild if the router changes it`
        }
      >
        <StateChip tone={tone}>
          {fetching ? 'Downloading' : building ? 'Building' : tv.phase === 'error' ? 'Failed' : have ? 'Ready' : 'None'}
        </StateChip>
      </Row>

      {/* The address box on a TV is the one thing that has to be right, so it
          gets the same treatment as the phone's: shown as a whole URL, copyable
          in one press, and never abbreviated. */}
      {have && tv.url && (
        <Row
          label="Type this on the TV"
          hint="Open Downloader on the Fire TV and enter this. Installing again over the top is how it updates."
        >
          <div className="mobile-tunnel-url">
            <code className="mobile-address">{tv.url}</code>
            <button type="button" className="sbtn" onClick={() => void onCopy(tv.url)}>
              {copied === tv.url ? 'Copied' : 'Copy'}
            </button>
          </div>
        </Row>
      )}

      {/* The one switch on this page that reaches past Forge.
          Everything else the television can do ends inside this app — open a
          pane, watch a screen, play a video — and is bounded by what Forge
          itself can do. This hands a device in another room a real mouse on
          this machine, so it is worded as what it *is* rather than as a
          feature, and it sits below the install rows because nobody should
          meet it before they have a television at all. */}
      <Row
        label="Let the remote drive this desktop"
        hint={
          control
            ? 'On. While the television is watching the screen, OK picks up a pointer — the D-pad moves it, OK clicks. Windows still refuses anything asking for administrator rights, so a UAC prompt cannot be answered from the sofa.'
            : 'Off. The television can watch this screen but not touch it. Turning this on lets any paired device drive the mouse and keyboard while it is mirroring.'
        }
      >
        <Toggle checked={control} onChange={onControl} label="Let the remote drive this desktop" />
      </Row>

      {/* Sound, and the reason it is a switch rather than part of the mirror.
          What Windows shares is the system mix — there is no way to send one
          app's voice and nothing else — so turning this on sends every chime,
          call and video on this machine to a room this desktop cannot see. It
          exists because Forge's own voice agent speaks out of the desk's
          speakers, which is no use from a sofa. Worded as what leaves the
          machine, not as "enable audio". */}
      <Row
        label="Send this desktop's sound too"
        hint={
          audio
            ? 'On. The mirror carries the whole system mix, so the voice agent can be heard from the sofa — and so can every notification, call and video playing on this desktop.'
            : 'Off. The mirror is a picture and nothing else. Turn this on to hear the voice agent from the sofa, knowing it sends everything else this machine plays as well.'
        }
      >
        <Toggle checked={audio} onChange={onAudio} label="Send this desktop's sound too" />
      </Row>

      {tv.detail && <p className={tv.phase === 'error' ? 'mobile-error' : 'scard__hint'}>{tv.detail}</p>}
      {have && !tv.url && (
        <p className="scard__hint">
          Switch the link on above to get the address — the television downloads the app from this same server.
        </p>
      )}
    </Card>
  )
}

/** "2 minutes ago" is more use here than a timestamp nobody reads. */
function lastSeen(at: number): string {
  if (!at) return 'never connected'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { normaliseNgrokDomain } from '@shared/mobile'
import type { MobileDeviceRecord, MobilePairOffer, MobileStatus } from '@shared/types'
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
 *   3. Which phones?       the device list, and the button that removes one
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

export function MobileSection(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [offer, setOffer] = useState<Extract<MobilePairOffer, { ok: true }> | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [domainError, setDomainError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.forge.mobile.status().then(setStatus)
    return window.forge.mobile.onStatus(setStatus)
  }, [])

  // Only ticks while a code is on screen — there is nothing else on this page
  // that changes second by second.
  useEffect(() => {
    if (!offer) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [offer])

  // A code that has expired is worse than no code: it looks usable and is not.
  useEffect(() => {
    if (offer && secondsLeft(offer.expiresAt, now) === 0) setOffer(null)
  }, [offer, now])

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

  const copyTunnelUrl = useCallback(async (url: string) => {
    await window.forge.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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

        {status.state === 'listening' && (
          <Row
            label="Reach it at"
            hint={
              status.addresses.length > 1
                ? 'A 100.x address is your tailnet and works anywhere; the others are this network only.'
                : 'Type this into the phone app.'
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
            placeholder="assigned-name.ngrok-free.app"
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
          <Row label="Public address" hint="Paste this whole URL into the phone app — no port on the end.">
            <div className="mobile-tunnel-url">
              <code className="mobile-address">{tunnel.url}</code>
              <button type="button" className="sbtn" onClick={() => void copyTunnelUrl(tunnel.url)}>
                {copied ? 'Copied' : 'Copy'}
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
          title="Pair a phone"
          hint="The code is single-use and expires in five minutes. Anyone who can read it before then can pair a phone, so treat it like a password you are saying out loud."
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
              <p className="mobile-pair__lead">
                {tunnel.state === 'live'
                  ? 'In the phone app, enter the public tunnel address and this code:'
                  : 'In the phone app, enter the address above and this code:'}
              </p>
              <code className="mobile-pair__code">{offer.token}</code>
              <p className="mobile-pair__ttl">
                Expires in {secondsLeft(offer.expiresAt, now)}s
              </p>
            </div>
          ) : (
            <p className="scard__hint">
              Open Forge Mobile on the phone, then tap this to get a code.
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
    </Section>
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

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toDataURL } from 'qrcode'
import type { RemoteYesStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Card, Row, Section, StateChip, maskKey, type ChipTone } from './parts'

/**
 * Remote Yes — press the Windows admin box from your phone.
 *
 * Windows draws the UAC prompt on the secure desktop, where nothing Forge owns
 * can reach it: not the mirror, not the television's pointer, not a script.
 * The only thing that can is a remote-desktop tool running as a service in
 * session 0, so this panel installs one — RustDesk — pins it to the tailnet,
 * and thereafter tells the phone the moment a prompt goes up.
 *
 * Two things make this section different from every other one on the page, and
 * both are why the copy is as blunt as it is:
 *
 *  1. **It asks for administrator.** Forge has never done that before. The
 *     button therefore says what the click costs *before* it is pressed —
 *     one Windows admin box, on this PC, once — rather than after, in a dialog
 *     the person has already been startled by. A permission you only explain
 *     once it has appeared reads as something that was slipped past you.
 *  2. **It installs somebody else's software.** So the footer names RustDesk,
 *     says where the password comes from, and says that switching off leaves
 *     the program on the machine. "Off" that quietly uninstalls a service is a
 *     surprise; "off" that does not, and says so, is a fact.
 *
 * The listening rule is the thing that makes the rest safe, so it is stated
 * wherever it matters: RustDesk here is allowlisted to 100.64.0.0/10 — the
 * Tailscale range — which is why a tailnet is a precondition rather than a
 * suggestion, and why the panel refuses to offer the button without one.
 *
 * Status is main's to report, not this panel's to compute: `status()` on
 * arrival, an `onStatus` stream for the phases of a setup and for a UAC prompt
 * rising, and a slow poll behind both because the service can be stopped from
 * services.msc without anybody telling us. Every call is guarded, like the
 * watchdog's — a renderer running ahead of its preload would otherwise throw
 * here and unmount the app, which is exactly the situation this feature exists
 * to get you out of.
 */

function api() {
  return typeof window.forge?.remoteYes?.status === 'function' ? window.forge.remoteYes : null
}

function whenText(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/**
 * One name for what the card is showing, decided once. The chip, the line and
 * the buttons all read from it, so there is no way for the badge to say Ready
 * over a body that is still offering to install.
 */
type View = 'checking' | 'tailscale' | 'working' | 'error' | 'ready' | 'stopped' | 'off'

function viewOf(s: RemoteYesStatus | null): View {
  if (!s) return 'checking'
  if (!s.tailscale) return 'tailscale'
  if (s.phase === 'downloading' || s.phase === 'installing' || s.phase === 'configuring') return 'working'
  if (s.phase === 'error') return 'error'
  if (s.enabled && s.configured && s.serviceRunning) return 'ready'
  if (s.enabled && !s.serviceRunning) return 'stopped'
  return 'off'
}

export function RemoteYesSection(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<RemoteYesStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The phone has to be told the RustDesk password exactly once, by a human
  // typing it in. Masked until asked for, and never part of the QR or link.
  const [showPassword, setShowPassword] = useState(false)
  const password = state.settings.remoteYesPassword
  // What the last "show me the box" attempt reported, kept beside its button —
  // the answer to that press is a sentence, not a state change on the card.
  const [tested, setTested] = useState('')
  const [qr, setQr] = useState('')
  const supported = api() !== null

  const refresh = useCallback(async () => {
    const r = api()
    if (!r) return
    try {
      setStatus(await r.status())
    } catch (err) {
      setError(String(err))
    }
  }, [])

  // Read on arrival, then follow main's stream: a setup walks through four
  // phases and a UAC prompt goes up without warning, and neither is worth a
  // poll fast enough to catch it.
  useEffect(() => {
    const r = api()
    if (!r) return
    void refresh()
    return r.onStatus(setStatus)
  }, [refresh])

  // The slow poll underneath, for the things nothing broadcasts: the service
  // stopped from services.msc, Tailscale signed out, RustDesk uninstalled.
  useEffect(() => {
    if (!supported) return
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh, supported])

  // The phone opens RustDesk straight onto this PC from the deep link; no
  // password in it, because the app on the phone already has one and a QR is a
  // thing people photograph off a screen-share.
  const link = status?.address ? `rustdesk://connection/new/${status.address}` : ''
  useEffect(() => {
    if (!link) {
      setQr('')
      return
    }
    let stale = false
    toDataURL(link, {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 220,
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
  }, [link])

  const run = useCallback(
    async (what: 'setup' | 'disable') => {
      const r = api()
      if (!r) return
      setBusy(true)
      setError('')
      setTested('')
      try {
        const next = what === 'setup' ? await r.setup() : await r.disable()
        setStatus(next)
        // Mirror what main decided, so the section does not flick back to its
        // old shape while the debounced settings save is still in flight —
        // the same arrangement as the Always on switch.
        actions.patchSettings({ remoteYesEnabled: next.enabled })
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(false)
      }
    },
    [actions]
  )

  const showTheBox = useCallback(async () => {
    const r = api()
    if (!r) return
    setBusy(true)
    setError('')
    setTested('')
    try {
      const res = await r.test()
      setTested(res.detail || (res.ok ? 'Accepted.' : 'Nothing pressed it.'))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const blurb = 'Press the Windows admin box from your phone, wherever you are.'

  // The running copy is older than this section: every call below would throw.
  if (!supported) {
    return (
      <Section title="Remote Yes" blurb={blurb}>
        <Card tone="quiet" title="Press Yes from your phone">
          <p className="scard__hint">Restart Forge to pick this up — the running copy predates this section.</p>
        </Card>
      </Section>
    )
  }

  if (status && !status.supported) {
    return (
      <Section title="Remote Yes" blurb={blurb}>
        <Card tone="quiet" title="Press Yes from your phone">
          <p className="scard__hint">Windows only.</p>
        </Card>
      </Section>
    )
  }

  const s = status
  const view = viewOf(s)

  let tone: ChipTone = 'soon'
  let chip = 'Checking'
  let line = 'Checking Remote Yes…'
  let button = 'Set up Remote Yes'

  if (view === 'tailscale') {
    tone = 'warn'
    chip = 'Needs Tailscale'
    line =
      'Install and sign in to Tailscale on this PC and on your phone first. Remote Yes only ever listens on your tailnet.'
  } else if (view === 'working') {
    tone = 'soon'
    chip = s?.phase === 'downloading' ? 'Downloading…' : s?.phase === 'installing' ? 'Installing…' : 'Setting up…'
    button = chip
    line = s?.detail || 'Working…'
  } else if (view === 'error') {
    tone = 'danger'
    chip = 'Failed'
    button = 'Try again'
    line = s?.detail || 'Setup did not finish.'
  } else if (view === 'ready') {
    tone = 'ok'
    chip = 'Ready'
    const last = s?.lastUacAt ? whenText(s.lastUacAt) : ''
    line = last ? `On · last admin box ${last}` : 'On · nothing has asked for admin yet'
  } else if (view === 'stopped') {
    tone = 'warn'
    chip = 'Service stopped'
    button = 'Set up again'
    line = 'The RustDesk service is not running. Set up again to repair it.'
  } else if (view === 'off') {
    tone = 'off'
    chip = 'Off'
    line = 'Not set up. Windows still needs you at this desk to press Yes.'
  }

  // Only where the button actually does something: the note explains the one
  // admin prompt that click causes, and there is no sense promising a prompt
  // on a button that cannot be pressed.
  const warnFirst = view === 'off' || view === 'error' || view === 'stopped'
  const canPress = warnFirst && !busy

  return (
    <Section title="Remote Yes" blurb={blurb}>
      {/* Top of the page while it is happening, because this card is the whole
          point of the feature and the prompt only waits about two minutes. */}
      {s?.uacActive ? (
        <Card
          tone="warn"
          title="Windows is asking for admin right now"
          actions={<StateChip tone="warn">Waiting</StateChip>}
          hint={s.lastUacAt ? `It went up at ${whenText(s.lastUacAt)}. Windows gives it about two minutes.` : undefined}
        >
          <p className="scard__hint">
            On your phone, open Forge Mobile → Remote Yes, then press Yes in RustDesk.
          </p>
        </Card>
      ) : null}

      <Card
        title="Press Yes from your phone"
        hint="Forge installs RustDesk as a Windows service and keeps it on your tailnet. It is the only thing that can see the admin box, because Windows draws that on a desktop nothing else may touch."
        actions={<StateChip tone={tone}>{chip}</StateChip>}
      >
        {warnFirst ? (
          <p className="web-note">
            This installs RustDesk as a Windows service. Windows will ask you once, on this PC, with its admin Yes
            box. That is the only time Forge asks for admin. After that you can press that box from your phone.
          </p>
        ) : null}

        {view === 'ready' ? (
          <>
            <Row label="Remote Yes" hint={busy ? 'Working…' : line}>
              <button type="button" className="sbtn sbtn--danger" disabled={busy} onClick={() => void run('disable')}>
                Switch off
              </button>
            </Row>

            <Row label="This PC's address" hint="What the phone connects to. It only answers on your tailnet.">
              <code className="mono">{`${s?.address ?? ''}:${s?.port ?? 21118}`}</code>
            </Row>

            <Row label="RustDesk ID" hint="The same PC, the other way round — use it if the address will not do.">
              <code className="mono">{s?.rustdeskId || '—'}</code>
            </Row>

            <Row
              label="Password"
              hint="Type this into the RustDesk app on the phone once and tick Remember password. It never leaves this PC otherwise."
            >
              <code className="mono">{password ? (showPassword ? password : maskKey(password)) : 'not set'}</code>
              <button
                type="button"
                className="ghost-btn"
                disabled={!password}
                onClick={() => setShowPassword((v) => !v)}
                title={showPassword ? 'Hide' : 'Show'}
              >
                {showPassword ? 'hide' : 'show'}
              </button>
            </Row>

            {qr ? (
              <div className="ryes-scan">
                <img className="ryes-qr" src={qr} alt="RustDesk connection QR code" width={220} height={220} />
                <p className="scard__hint">
                  Scan this from the phone to open RustDesk straight onto this PC. The password is already on the
                  phone, so the link does not carry one.
                </p>
              </div>
            ) : null}

            <Row
              label="Check it works"
              hint={
                tested ||
                'Puts a harmless admin box on this screen so you can press it from the phone once, in your own time.'
              }
            >
              <button type="button" className="sbtn" disabled={busy} onClick={() => void showTheBox()}>
                {busy ? 'Working…' : 'Test: show the admin box'}
              </button>
            </Row>
          </>
        ) : (
          <Row label="Remote Yes" hint={busy ? 'Working…' : line}>
            <button
              type="button"
              className="sbtn sbtn--go"
              disabled={!canPress}
              onClick={() => void run('setup')}
            >
              {busy ? 'Working…' : button}
            </button>
          </Row>
        )}

        {error ? <p className="web-error">{error}</p> : null}
      </Card>

      <p className="web-note">
        RustDesk is a remote-desktop program, not part of Forge. Forge installs it as a Windows service, allows only
        Tailscale addresses (100.64.0.0/10) to connect, and gives it a password it generates itself and keeps
        encrypted in your settings — your phone is told that password once. Switching off stops Forge watching for
        admin boxes and leaves RustDesk installed; remove it from Windows Settings → Apps if you want it gone.
      </p>
    </Section>
  )
}

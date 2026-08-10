import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { normaliseNgrokDomain } from '@shared/mobile'
import type { WebDeviceRecord, WebStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Card, maskKey, Row, Section, StateChip, TextField, Toggle, type ChipTone } from './parts'

/**
 * Forge Web — the same terminals, in a browser tab, from anywhere.
 *
 * This is the only part of Forge Web a person can touch, and it is the one
 * screen in the app where the risk is legible rather than abstract: switching
 * the toggle below on puts a shell on this PC behind an address the whole
 * internet can dial. So the panel is written to answer, in order, the questions
 * somebody actually asks when they are deciding whether to do that:
 *
 *   1. What am I switching on?   the section blurb, and the three locks
 *   2. Is it on?                 the link card — off, on, or on and unable to
 *                                publish because nobody is signed in
 *   3. Who is allowed in?        the account card: the Firebase project, and
 *                                Forge Web's *own* sign-in
 *   4. How does anyone reach me? the tunnel card, and what got published
 *   5. Let a new browser ask     the accept window, armed for ten minutes
 *   6. Which browsers?           the list, and the two different ways to end one
 *
 * Three states, told apart deliberately, because they fail in different ways
 * and only one of them is a problem:
 *
 *  - **Signed out.** Forge Web can listen but cannot publish its address, so no
 *    browser can find this desktop. `WebStatus.session.detail` is a sentence
 *    written for exactly this moment; the panel shows it rather than inventing
 *    a shorter one.
 *  - **Signed in, switched off.** The resting state, and a fine one. Nothing is
 *    listening. The card says so without implying anything is broken.
 *  - **On.** Listening, published, with the address a browser dials.
 *
 * Signing in does not switch the link on, and the two are kept apart on purpose
 * — see `signIn` in electron/web-host.ts, which makes the same point from the
 * other side. Saying which account may reach these terminals is one decision;
 * putting a shell behind a public address is a second one, and it gets its own
 * switch and its own moment.
 *
 * The authtoken field is write-only, exactly as Forge Mobile's is: what was
 * saved is shown masked and never rendered back in full. The password is worse
 * than write-only — it lives in a `useState` for one HTTPS POST and is dropped,
 * never persisted, never pre-filled. What reaches settings.json is a refresh
 * token, and this panel never sees it.
 *
 * The tunnel fields are written with `patchSettings` and nothing else. Forge
 * Web has no `setTunnel` IPC the way Forge Mobile does, and does not need one:
 * main.ts's settings-write handler compares `webTunnel`, `webNgrokDomain` and
 * `webNgrokAuthtoken` and calls `applyWebSettings()` itself, so a pasted domain
 * starts an agent now rather than at the next launch.
 */

/** Seconds remaining until a ms-epoch deadline, floored at zero. */
function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/** `9:42` — the accept window is minutes long, so bare seconds would mislead. */
function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** "2 minutes ago" is more use in a device list than a timestamp nobody reads. */
function ago(at: number): string {
  if (!at) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function WebSection(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<WebStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [signInError, setSignInError] = useState('')
  const [created, setCreated] = useState(false)
  const [domainError, setDomainError] = useState('')
  const [copied, setCopied] = useState('')

  // Live rather than polled: main pushes a whole `WebStatus` on every change it
  // makes — a socket opening, a tunnel dying, an approval landing — and this
  // page is often left open while exactly those things happen.
  useEffect(() => {
    void window.forge.web.status().then(setStatus)
    return window.forge.web.onStatus(setStatus)
  }, [])

  const acceptUntil = status?.acceptUntil ?? 0
  const armed = acceptUntil > now

  // Only ticks while something on this page changes second by second.
  useEffect(() => {
    if (!armed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [armed])

  /*
   * `webEnabled` is written by main (`web:start` / `web:stop` persist it), but
   * unlike `webUid` and the device list it is *not* in main.ts's
   * MAIN_OWNED_SETTINGS, so the renderer's debounced whole-object save would
   * happily post its pre-toggle copy straight back. The symptom would be a link
   * that switches itself off 200ms after an unrelated settings change — a
   * theme, or the ngrok domain typed into the card below. Mirroring what main
   * reports costs one write of a value main already holds, and `applyWebSettings`
   * sees no change and does nothing.
   */
  useEffect(() => {
    if (status && state.settings.webEnabled !== status.enabled) {
      actions.patchSettings({ webEnabled: status.enabled })
    }
  }, [status, state.settings.webEnabled, actions])

  const toggle = useCallback(async (on: boolean) => {
    setBusy(true)
    try {
      setStatus(on ? await window.forge.web.start() : await window.forge.web.stop())
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleAccept = useCallback(async (on: boolean) => {
    setNow(Date.now())
    setStatus(await window.forge.web.setAccept(on))
  }, [])

  const revoke = useCallback(async (device: WebDeviceRecord) => {
    setStatus(await window.forge.web.revoke(device.id))
  }, [])

  const forget = useCallback(async (device: WebDeviceRecord) => {
    setStatus(await window.forge.web.forget(device.id))
  }, [])

  const copyUrl = useCallback(async (url: string) => {
    await window.forge.clipboard.writeText(url)
    setCopied(url)
    setTimeout(() => setCopied(''), 1500)
  }, [])

  /* --------------------------------------------------------- the account */

  const signIn = useCallback(async () => {
    setSignInError('')
    setCreated(false)
    setBusy(true)
    try {
      const result = await window.forge.web.signIn(email.trim(), password)
      if (!result.ok) {
        setSignInError(result.error)
        return
      }
      setCreated(result.created)
      // The password has done its one job. It never touched settings.json and
      // it does not linger in a React state either.
      setPassword('')
      setStatus(await window.forge.web.status())
    } finally {
      setBusy(false)
    }
  }, [email, password])

  const signOut = useCallback(async () => {
    setSignInError('')
    setCreated(false)
    setStatus(await window.forge.web.signOut())
  }, [])

  /* ---------------------------------------------------------- the tunnel */

  const saveAuthtoken = useCallback(
    (next: string) => {
      const value = next.trim()
      if (!value) return
      actions.patchSettings({ webNgrokAuthtoken: value })
    },
    [actions]
  )

  const saveDomain = useCallback(
    (next: string) => {
      const value = normaliseNgrokDomain(next)
      setDomainError(
        next.trim() && !value ? 'That does not look like a domain — copy it exactly as the ngrok dashboard shows it.' : ''
      )
      actions.patchSettings({ webNgrokDomain: value })
    },
    [actions]
  )

  if (!status) {
    return (
      <Section title="Forge Web">
        <Card tone="quiet">Loading…</Card>
      </Section>
    )
  }

  const session = status.session
  const tunnel = status.tunnel
  const settings = state.settings
  const authtoken = settings.webNgrokAuthtoken
  const tunnelOn = settings.webTunnel === 'ngrok'
  const listening = status.state === 'listening'

  const tone: ChipTone = listening ? 'ok' : status.state === 'error' ? 'danger' : 'off'
  const tunnelTone: ChipTone =
    tunnel.state === 'live'
      ? 'ok'
      : tunnel.state === 'error'
        ? 'danger'
        : tunnel.state === 'off'
          ? 'off'
          : tunnel.state === 'configured'
            ? 'soon'
            : 'warn'

  // The prefilled email survives a sign-out so the form is one field the second
  // time, exactly as `webEmail`'s doc comment promises. `emailTouched` keeps
  // that from stamping over what is being typed when a status push arrives.
  const emailValue = emailTouched ? email : session.email

  return (
    <Section
      title="Forge Web"
      blurb={
        <>
          Your real terminals, in a browser tab — the same projects, the same panes, from any machine you can sign in
          on. Read this bit once, because it is the whole of it: switching Forge Web on puts a shell on this PC behind
          an address anybody on the internet can reach. Three things stand in the way, and all three have to hold —
          a Firebase account you own, a browser this desktop has never seen being allowed by hand at this desk, and
          the switch below, which is off until you turn it on. Until then nothing binds a port, publishes an address
          or reads a credential. The full picture is in <code>docs/forge-web.md</code>.
        </>
      }
    >
      <Card
        title="The link"
        actions={<StateChip tone={tone}>{listening ? 'Listening' : status.state}</StateChip>}
        hint={
          status.detail ||
          'A browser that gets in can type into your shells as you. Approve one you are holding, and revoke it below the moment you stop trusting it.'
        }
      >
        {/*
          The three states, in a sentence, above the switch. The chip alone
          cannot carry this: "listening" and "listening but nobody can find us"
          are the same word, and the difference between them is the whole
          feature working or silently not.
        */}
        <p className="web-lede">
          {!session.signedIn ? (
            <>
              <strong>Signed out.</strong> {session.detail}
            </>
          ) : listening ? (
            <>
              <strong>On.</strong> Listening as <span className="mono">{session.email}</span>
              {status.url ? ' — a browser signed in to that account can reach this desk.' : '.'}
            </>
          ) : (
            <>
              <strong>Off.</strong> Signed in as <span className="mono">{session.email}</span>, and nothing is
              listening. This is the resting state — switch it on when you want the browser to work.
            </>
          )}
        </p>

        <Row
          label="Let browsers reach this desktop"
          hint={busy ? 'Working…' : `Port ${status.port}, bound to loopback — the tunnel below is the only way in from outside.`}
        >
          <Toggle checked={status.enabled} onChange={(on) => void toggle(on)} label="Enable Forge Web" />
        </Row>

        {listening &&
          (status.url ? (
            <Row
              label="This desktop's address"
              hint="What the browser dials once it has signed in. It finds this by itself, through your account — this row is here so you can see that it has one."
            >
              <div className="web-url">
                <code className="web-address">{status.url}</code>
                <button type="button" className="sbtn" onClick={() => void copyUrl(status.url)}>
                  {copied === status.url ? 'Copied' : 'Copy'}
                </button>
              </div>
            </Row>
          ) : (
            <p className="web-note">
              Listening, but with no address from outside — a browser has nothing to dial. Set the tunnel up below.
            </p>
          ))}
      </Card>

      <Card
        title="The account"
        actions={<StateChip tone={session.signedIn ? 'ok' : 'off'}>{session.signedIn ? 'Signed in' : 'Signed out'}</StateChip>}
        hint="One account, one machine. A perfectly valid token minted for any other account — or by any other Firebase project — is refused before it reaches a terminal."
      >
        <Row
          label="Firebase project"
          hint="The project whose sign-ins this desktop trusts, e.g. forge-sync. Every token is checked against it by name."
        >
          <TextField
            value={settings.webProjectId}
            mono
            placeholder="forge-sync"
            onCommit={(next) => actions.patchSettings({ webProjectId: next.trim() })}
          />
        </Row>
        <Row
          label="Web API key"
          hint="Firebase console › Project settings. Public by design: it names the project and authorises nothing."
        >
          <TextField
            value={settings.webApiKey}
            mono
            placeholder="from the Firebase console"
            onCommit={(next) => actions.patchSettings({ webApiKey: next.trim() })}
          />
        </Row>
        <Row
          label="Database URL"
          hint="The Realtime Database this desktop publishes its address into, so the browser can find it."
        >
          <TextField
            value={settings.webDatabaseURL}
            mono
            placeholder="https://…-default-rtdb.europe-west1.firebasedatabase.app"
            onCommit={(next) => actions.patchSettings({ webDatabaseURL: next.trim() })}
          />
        </Row>

        {session.signedIn ? (
          <Row label="Signed in as" hint={`Firebase uid ${session.uid}`}>
            <div className="web-url">
              <code className="web-address">{session.email}</code>
              <button type="button" className="sbtn sbtn--danger" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </Row>
        ) : (
          <div className="web-signin">
            {/*
              The password is typed here, posted once, and dropped. It is never
              written to settings.json — a refresh token is, and that is
              revocable from the Firebase console without touching a password
              used anywhere else. Nothing on this page ever renders either back.
            */}
            <SignInField
              id="web-signin-email"
              label="Email"
              type="email"
              value={emailValue}
              placeholder="you@example.com"
              onChange={(next) => {
                setEmailTouched(true)
                setEmail(next)
              }}
              onSubmit={() => void signIn()}
            />
            <SignInField
              id="web-signin-password"
              label="Password"
              type="password"
              value={password}
              placeholder="never saved"
              onChange={setPassword}
              onSubmit={() => void signIn()}
            />
            <button
              type="button"
              className="sbtn sbtn--go web-signin__go"
              disabled={busy || !emailValue.trim() || !password}
              onClick={() => void signIn()}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        )}

        {signInError && <p className="web-error">{signInError}</p>}
        {created && (
          <p className="web-note">
            That account did not exist, so signing in created it. If you meant to use an account you already had,
            check the address before you switch the link on — this is the account that will be allowed a shell.
          </p>
        )}
        {!session.signedIn && (
          <p className="scard__hint">
            Signing in does not switch the link on, deliberately. It says who may reach these terminals; the switch
            above is the separate act that lets them.
          </p>
        )}
      </Card>

      <Card
        title="Reach it from anywhere"
        actions={<StateChip tone={tunnelTone}>{tunnel.state === 'live' ? 'Live' : tunnel.state}</StateChip>}
        hint={
          <>
            The listener binds loopback, so on its own it is reachable from nothing. An ngrok tunnel is what gives it
            a permanent public address — set it up once and the browser keeps the same one forever. Forge Mobile’s
            domain cannot be reused: one domain forwards to one port, and both links want their own.
          </>
        }
      >
        {/* Above the fields rather than below them, unlike Forge Mobile's card.
            The sentences this renders are written in main and point *down* at
            the two fields ("paste the authtoken and the domain below first"),
            so a detail printed underneath them would be pointing at the wrong
            end of its own card. */}
        {tunnel.detail && <p className={tunnel.state === 'error' ? 'web-error' : 'scard__hint'}>{tunnel.detail}</p>}

        <Row
          label="ngrok authtoken"
          hint={
            authtoken
              ? `Saved (${maskKey(authtoken)}) — paste a new one to replace it.`
              : 'From the ngrok dashboard, under Your Authtoken.'
          }
        >
          {/* Write-only. The saved token is shown masked in the hint above and
              never rendered back in full, revealable or otherwise — a settings
              page is exactly where a screen-share lingers. */}
          <TextField
            value=""
            password
            mono
            placeholder={authtoken ? 'paste to replace' : 'paste your authtoken'}
            onCommit={saveAuthtoken}
          />
        </Row>
        <Row
          label="Forge Web’s ngrok domain"
          hint="A second reserved domain, not the one Forge Mobile uses. Copy it from the dashboard, don’t invent one."
        >
          <TextField
            value={settings.webNgrokDomain}
            mono
            placeholder="assigned-name.ngrok-free.dev"
            onCommit={saveDomain}
          />
        </Row>
        <Row
          label="Keep the tunnel up"
          hint="Starts with the link and restarts itself if it drops. Off takes the public address down and retracts what was published."
        >
          <Toggle
            checked={tunnelOn}
            onChange={(on) => actions.patchSettings({ webTunnel: on ? 'ngrok' : 'off' })}
            label="Enable the ngrok tunnel"
          />
        </Row>

        {tunnel.host && (
          <Row
            label="Public hostname"
            hint={
              tunnel.state === 'configured'
                ? 'From FORGE_WEB_HOSTNAME.'
                : 'What the browser is told to dial. It changes only if you change the domain.'
            }
          >
            <div className="web-url">
              <code className="web-address">{tunnel.host}</code>
              <button type="button" className="sbtn" onClick={() => void copyUrl(tunnel.host)}>
                {copied === tunnel.host ? 'Copied' : 'Copy'}
              </button>
            </div>
          </Row>
        )}

        {domainError && <p className="web-error">{domainError}</p>}

        {/* `configured` is not `live`, and saying so is the point of the word.
            Forge did not start that tunnel and cannot see the process, so it
            reports the address it was handed and claims nothing about it. */}
        {tunnel.state === 'configured' && (
          <p className="web-note">
            That hostname came from <span className="mono">FORGE_WEB_HOSTNAME</span> — a tunnel you run yourself.
            Forge never started it and cannot tell you whether it is up, so this says <span className="mono">configured</span> rather
            than live.
          </p>
        )}

        {/* Publishing is the half that decides whether a browser can find this
            desk at all, and it fails independently of the tunnel: a live agent
            with a signed-out session publishes nothing. */}
        <p className={status.rendezvous.detail ? 'web-error' : 'scard__hint'}>
          {status.rendezvous.detail
            ? `Could not publish this desktop's address: ${status.rendezvous.detail}`
            : status.rendezvous.published
              ? `Published as ${status.rendezvous.published}, last confirmed ${ago(status.rendezvous.at)}. That is how the browser finds this desk.`
              : 'Nothing published yet, so a browser has no way to find this desk.'}
        </p>
      </Card>

      {listening && (
        <Card
          title="Accept new browsers"
          actions={
            <StateChip tone={armed ? 'ok' : 'off'}>
              {armed ? (
                <>
                  Accepting · <span className="web-accept__left">{countdown(secondsLeft(acceptUntil, now))}</span>
                </>
              ) : (
                'Off'
              )}
            </StateChip>
          }
          hint={
            armed
              ? 'Open the page in the browser and sign in. It shows two words, and a prompt appears here with the same two. Nothing is approved until you press Allow on that prompt.'
              : 'A browser this desktop has never seen cannot even ask while this is off — it is refused before a prompt is raised. Arm it for the minute you are actually sitting down with a new browser, not permanently: this door faces the internet.'
          }
        >
          <Row
            label="Accept new browsers"
            hint={armed ? 'On — it switches itself off when the countdown ends.' : 'Arms for ten minutes, then switches itself off.'}
          >
            <Toggle checked={armed} onChange={(on) => void toggleAccept(on)} label="Accept new browsers" />
          </Row>
        </Card>
      )}

      <Card
        title="Approved browsers"
        hint={
          status.devices.length > 0
            ? 'Two different endings, and the difference matters. Revoke means not any more: the socket is dropped now, and that browser is turned away by name if it comes back — no prompt, nothing to press by mistake. Forget means start over: the row goes, and the browser becomes a stranger that may ask again the next time you are accepting.'
            : undefined
        }
      >
        {status.devices.length === 0 ? (
          <p className="scard__hint">No browsers approved.</p>
        ) : (
          <ul className="web-devices">
            {status.devices.map((device) => (
              <li key={device.id} className="web-device" data-revoked={device.revokedAt ? 'true' : undefined}>
                <div className="web-device__text">
                  {/* The name is whatever the browser called itself. Display
                      text and nothing more — never obeyed, never parsed. */}
                  <span className="web-device__name">{device.name}</span>
                  <span className="web-device__meta">
                    {device.revokedAt
                      ? `Revoked ${ago(device.revokedAt)} · approved ${ago(device.createdAt)}`
                      : `Approved ${ago(device.createdAt)} · last seen ${ago(device.lastSeenAt)}`}
                  </span>
                </div>
                <div className="web-device__actions">
                  {device.revokedAt ? (
                    <span className="web-device__badge">Revoked</span>
                  ) : (
                    <button type="button" className="sbtn sbtn--danger" onClick={() => void revoke(device)}>
                      Revoke
                    </button>
                  )}
                  <button type="button" className="sbtn" onClick={() => void forget(device)}>
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {status.connected > 0 && (
          <p className="scard__hint">
            {status.connected} {status.connected === 1 ? 'browser is' : 'browsers are'} connected right now.
          </p>
        )}
      </Card>
    </Section>
  )
}

/**
 * One line of the sign-in form.
 *
 * Its own small component rather than `TextField` because that one commits on
 * blur and tracks a stored value, and neither is right for a credential typed
 * once: there is nothing to track and nothing to commit to. The keydown is
 * stopped for the reason `TextField` stops it — the global shortcut map listens
 * in the capture phase and would otherwise read a typed "w" as close-pane.
 */
function SignInField({
  id,
  label,
  type,
  value,
  placeholder,
  onChange,
  onSubmit
}: {
  id: string
  label: string
  type: 'email' | 'password'
  value: string
  placeholder?: string
  onChange: (next: string) => void
  onSubmit: () => void
}): ReactNode {
  return (
    <div className="web-field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        type={type}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onSubmit()
        }}
      />
    </div>
  )
}

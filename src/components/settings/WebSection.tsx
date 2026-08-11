import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { normaliseNgrokDomain } from '@shared/mobile'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '@shared/web'
import type { WebStatus, WebTunnelMode } from '@shared/types'
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
 *   4. How careful do I want     the "Getting in" card: the unlock PIN, asked
 *      to be?                    of every browser on every sign-in
 *   5. Can it see this screen?   the "This screen" card: watching, driving and
 *                                sound — and whether one is happening now
 *   6. How does anyone reach me? the tunnel card, and what got published
 *   7. Which browsers?           the list, and the two different ways to end one
 *
 * Card 5 sits under card 4 rather than beside the link switch because the
 * desktop enforces exactly that order: driving this desk is refused outright
 * unless card 4's PIN is set, so the greyed switch in the middle of card 5 is
 * explained by the card immediately above it.
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
 *
 * The tunnel card is three choices rather than a switch, and the ngrok fields
 * only appear under the choice that reads them. That is not tidiness: the
 * default transport needs nothing pasted, and a card that showed two empty
 * credential boxes under it would be asking for a credential the feature does
 * not want. What the card must say out loud is the trade between the two, once,
 * without nagging — see `TUNNELS` below, where each option carries its own
 * sentence.
 */

/**
 * The three answers, with what each one costs written next to it rather than in
 * a paragraph above them. `cloudflared` is first because it is the default and
 * the one that works with nothing typed.
 */
const TUNNELS: Array<{ id: WebTunnelMode; label: string; hint: string }> = [
  {
    id: 'cloudflared',
    label: 'Cloudflare',
    hint: 'Needs nothing — no account, no token. A new address each start, which the browser finds anyway.'
  },
  {
    id: 'ngrok',
    label: 'ngrok',
    hint: 'One steady address, but the free plan allows a single tunnel per account — so it cannot run beside Forge Mobile.'
  },
  { id: 'off', label: 'None', hint: 'No way in from outside, unless you run a tunnel yourself.' }
]

/**
 * The Hosting site name inside a refused origin, or '' when there is not one.
 *
 * Only `*.web.app` and `*.firebaseapp.com` are read, because those are the two
 * addresses Firebase serves a site at and the only ones where the fix really is
 * "put this word in the Hosting site box". A refusal from anywhere else — a
 * custom domain, or a page with no business here at all — gets the sentence
 * without the instruction, because the instruction would be wrong.
 */
function refusedSite(origin: string): string {
  const match = /^https:\/\/([a-z0-9][a-z0-9-]{2,62})\.(?:web\.app|firebaseapp\.com)\/?$/.exec(
    origin.trim().toLowerCase()
  )
  return match?.[1] ?? ''
}

/** "2 minutes ago" is more use on a status line than a timestamp nobody reads. */
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
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [signInError, setSignInError] = useState('')
  const [created, setCreated] = useState(false)
  const [domainError, setDomainError] = useState('')
  const [copied, setCopied] = useState('')
  /*
   * The unlock PIN, typed here for as long as the form is open and nowhere
   * else. Only a hash of it is ever persisted — see `WebStatus.pinSet` — so
   * there is nothing to render back and nothing here survives a save.
   * `pinEditing` is what shows the two inputs at all once a PIN is already
   * set; with no PIN, the form is simply always there.
   */
  const [pinDraft, setPinDraft] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinEditing, setPinEditing] = useState(false)
  const [pinError, setPinError] = useState('')

  // Live rather than polled: main pushes a whole `WebStatus` on every change it
  // makes — a socket opening, a tunnel dying, a sign-in landing — and this
  // page is often left open while exactly those things happen.
  useEffect(() => {
    void window.forge.web.status().then(setStatus)
    return window.forge.web.onStatus(setStatus)
  }, [])

  /*
   * `webEnabled` is written by main (`web:start` / `web:stop` persist it), but
   * unlike `webUid` it is *not* in main.ts's
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

  /** Take the screen back. See `IPC.webMirrorEnd` — the watch ends at the socket. */
  const stopMirror = useCallback(async () => {
    setStatus(await window.forge.web.stopMirror())
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

  /* ---------------------------------------------------------------- the PIN */

  /**
   * Set or change the PIN. The server validates the digit count itself —
   * `PIN_MIN_DIGITS`/`PIN_MAX_DIGITS` here only keep the button from being
   * pressable on something that cannot possibly be right — so `{ error }` is
   * still the thing that actually decides whether this landed.
   */
  const submitPin = useCallback(async () => {
    setPinError('')
    setBusy(true)
    try {
      const result = await window.forge.web.setPin(pinDraft)
      if ('error' in result) {
        setPinError(result.error)
        return
      }
      setStatus(result)
      setPinDraft('')
      setPinConfirm('')
      setPinEditing(false)
    } finally {
      setBusy(false)
    }
  }, [pinDraft])

  const cancelPinEdit = useCallback(() => {
    setPinDraft('')
    setPinConfirm('')
    setPinError('')
    setPinEditing(false)
  }, [])

  /**
   * Remove the PIN. See `IPC.webClearPin` — this puts the account back to
   * being the whole key, and it turns screen control off, so the row beside
   * this button says exactly that rather than leaving it implied.
   */
  const removePin = useCallback(async () => {
    setPinError('')
    setBusy(true)
    try {
      setStatus(await window.forge.web.clearPin())
    } finally {
      setBusy(false)
    }
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
  const tunnelMode = settings.webTunnel
  const listening = status.state === 'listening'
  /**
   * Whether "let it move the mouse" could mean anything at all, mirroring the
   * escalation guard in electron/web-host.ts rather than guessing at it: control
   * is refused outright unless an unlock PIN is set, so a switch offered
   * without one would be a permission the desktop then ignores.
   *
   * `status.pinSet` rather than the settings copy, for the reason the whole
   * panel reads its picture from main: this is what the *door* is using, and a
   * card that drew this from a debounced renderer copy could offer the
   * control a moment before the desktop would.
   */
  const controlPossible = status.pinSet

  /* Whether the typed-in PIN could be submitted at all — the server still has
     the final word, via `pinError`, but there is no point pressing "Set PIN"
     on something it will only refuse. */
  const pinDigitsOk = /^\d+$/.test(pinDraft) && pinDraft.length >= PIN_MIN_DIGITS && pinDraft.length <= PIN_MAX_DIGITS
  const pinMismatch = pinConfirm.length > 0 && pinDraft !== pinConfirm
  const pinLocalError = pinDraft && !pinDigitsOk
    ? `${PIN_MIN_DIGITS}–${PIN_MAX_DIGITS} digits, numbers only.`
    : pinMismatch
      ? 'Those two do not match.'
      : ''
  const canSubmitPin = pinDigitsOk && pinConfirm.length > 0 && !pinMismatch

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
          an address anybody on the internet can reach. Two things stand in the way, and both have to hold — a
          Firebase account you own, and the switch below, which is off until you turn it on. Until then nothing binds
          a port, publishes an address or reads a credential. An unlock PIN is yours to set under
          <em> Getting in</em>, and every browser that gets in is listed at the bottom and can be thrown out from
          there. The full picture is in <code>docs/forge-web.md</code>.
        </>
      }
    >
      <Card
        title="The link"
        actions={<StateChip tone={tone}>{listening ? 'Listening' : status.state}</StateChip>}
        hint={
          status.detail ||
          'A browser that gets in can type into your shells as you. Every one of them is listed below, and revoking one drops its connection there and then.'
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

        {/*
          The one refusal a browser can never be shown. It happens during the
          WebSocket upgrade, so there is no socket to send it on: the page sees
          a handshake that failed, cannot tell that from a machine that is off,
          and reconnects for as long as anybody watches it. Said here, on the
          desktop, or said nowhere. See `WebStatus.refusal`.
        */}
        {status.refusal && (
          <p className="web-refusal">
            <strong>A browser was turned away.</strong> It was on{' '}
            <code className="mono">{status.refusal.origin || 'a page that sent no address'}</code>, which is not an
            address this desktop serves
            {status.refusal.allowed.length > 0 ? (
              <>
                {' '}
                — it serves <code className="mono">{status.refusal.allowed.join(', ')}</code>
              </>
            ) : (
              ' — it serves none at all yet'
            )}
            . That page is retrying and will keep saying <em>Reconnecting to the desktop</em> until the two agree.
            {/*
              The button, rather than only the sentence naming the value. The
              sentence shipped first and was not enough: it asks somebody who
              has just been told their browser does not work to read a
              hostname, find a text field further down the page, and retype
              part of it correctly. The desktop already knows the exact answer —
              it is the address it just refused — so the honest UI is one click
              at the place the problem is described. Only offered for an origin
              that parses as a Firebase Hosting site, because `webSiteId` is
              interpolated into an allowlist and must never be set from a string
              this desktop has not recognised the shape of.
            */}
            {refusedSite(status.refusal.origin) ? (
              <>
                {' '}
                It wants <strong>Hosting site</strong> set to{' '}
                <code className="mono">{refusedSite(status.refusal.origin)}</code>.
                {/*
                  `sbtn--go` and a line of its own, because the first cut of
                  this put a bare `sbtn` inline at the end of a paragraph, where
                  a 26px hairline border beside running text is indistinguishable
                  from the sentence around it. It was read as prose and not
                  clicked, and the person reading it went on believing there was
                  nothing here to press. A button nobody can see is a button
                  that does not exist.
                */}
                <button
                  type="button"
                  className="sbtn sbtn--go web-refusal__fix"
                  onClick={() => actions.patchSettings({ webSiteId: refusedSite(status.refusal!.origin) })}
                >
                  Serve this address
                </button>
              </>
            ) : null}
          </p>
        )}

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
          label="Hosting site"
          hint="The Firebase Hosting site the browser page is served from — the name in https://<site>.web.app. Leave it blank when it matches the project, which is Firebase's default; fill it in when the bundle went to a site of its own, as `firebase deploy --only hosting:web` does here. Nothing else uses it, and getting it wrong refuses every browser at the door."
        >
          <TextField
            value={settings.webSiteId}
            mono
            placeholder={settings.webProjectId || 'same as the project'}
            onCommit={(next) => actions.patchSettings({ webSiteId: next.trim() })}
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

      {/*
        The one lock, and it is a choice with weight rather than a toggle:
        unset, the Firebase account above is the whole key, from anywhere.
        Set, it is asked of every browser on every sign-in, and it is also
        what "This screen", below, needs before it will hand out control.
      */}
      <Card
        title="Getting in"
        actions={
          <StateChip tone={status.pinSet ? 'ok' : 'off'}>{status.pinSet ? 'Unlock PIN set' : 'Account only'}</StateChip>
        }
        hint="A PIN set here is asked of every browser, on every sign-in, on top of the account above — and it is the only thing that can turn on driving this desktop's screen, in the card below."
      >
        <p className="web-lede">
          {status.pinSet ? (
            <>
              <strong>Unlock PIN set.</strong> Every browser types it on every sign-in, and it also unlocks driving
              this desktop's screen, below.
            </>
          ) : (
            <>
              <strong>No unlock PIN</strong> — browsers signed in to your account get in with the password alone, and
              remote control of the screen stays off.
            </>
          )}
        </p>

        {status.pinSet && !pinEditing && (
          <Row
            label="Unlock PIN"
            hint="Removing it returns this desktop to account-only admission: any browser signed in to your account gets in with the password alone, and screen control turns off."
          >
            <div className="web-url">
              <button type="button" className="sbtn" onClick={() => setPinEditing(true)}>
                Change PIN
              </button>
              <button type="button" className="sbtn sbtn--danger" onClick={() => void removePin()}>
                Remove PIN
              </button>
            </div>
          </Row>
        )}

        {(!status.pinSet || pinEditing) && (
          <div className="web-signin">
            <SignInField
              id="web-pin"
              label={status.pinSet ? 'New PIN' : 'PIN'}
              type="password"
              inputMode="numeric"
              maxLength={PIN_MAX_DIGITS}
              value={pinDraft}
              placeholder={`${PIN_MIN_DIGITS}-${PIN_MAX_DIGITS} digits`}
              onChange={(next) => setPinDraft(next.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS))}
              onSubmit={() => void submitPin()}
            />
            <SignInField
              id="web-pin-confirm"
              label="Confirm"
              type="password"
              inputMode="numeric"
              maxLength={PIN_MAX_DIGITS}
              value={pinConfirm}
              placeholder="type it again"
              onChange={(next) => setPinConfirm(next.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS))}
              onSubmit={() => void submitPin()}
            />
            <button
              type="button"
              className="sbtn sbtn--go web-signin__go"
              disabled={busy || !canSubmitPin}
              onClick={() => void submitPin()}
            >
              {busy ? 'Saving…' : status.pinSet ? 'Change PIN' : 'Set PIN'}
            </button>
            {status.pinSet && (
              <button type="button" className="sbtn web-signin__go" onClick={cancelPinEdit}>
                Cancel
              </button>
            )}
          </div>
        )}

        {pinLocalError && <p className="web-error">{pinLocalError}</p>}
        {pinError && <p className="web-error">{pinError}</p>}
      </Card>

      {/*
        The screen itself, and it is deliberately *below* "Getting in" rather
        than beside the link switch. Reading top to bottom, the PIN is set
        first and this card then says what it unlocks — which is the order
        the escalation guard actually enforces, and the order somebody needs
        to meet the greyed-out control in the middle of it.
      */}
      <Card
        title="This screen"
        actions={
          <StateChip tone={status.mirroring ? 'warn' : settings.webMirrorEnabled ? 'ok' : 'off'}>
            {status.mirroring ? 'Being watched' : settings.webMirrorEnabled ? 'Allowed' : 'Off'}
          </StateChip>
        }
        hint="Watching this desktop is not the same as reaching its terminals, so it is a separate switch: what a browser would see is the whole display — every window, not just Forge. Driving it is a third thing again, and this desktop refuses that outright unless the unlock PIN above is set."
      >
        {/* Above the switches, because it is a statement about right now rather
            than about what is permitted, and because the button that ends it
            belongs beside the sentence that reports it. */}
        {status.mirroring && (
          <Row
            label="A browser is watching this screen"
            hint={
              controlPossible && settings.webControlEnabled
                ? 'It can also move the mouse and type on this machine.'
                : 'It can see this screen but cannot touch it.'
            }
          >
            <button type="button" className="sbtn sbtn--danger" onClick={() => void stopMirror()}>
              Stop
            </button>
          </Row>
        )}

        <Row
          label="Let a browser watch this screen"
          hint="Off by default. On, a browser signed in to your account can ask to see this display — the whole of it, not just Forge — and you are told here and by a notification each time one starts."
        >
          <Toggle
            checked={settings.webMirrorEnabled}
            onChange={(on) => actions.patchSettings({ webMirrorEnabled: on })}
            label="Let a browser watch this screen"
          />
        </Row>

        <Row
          label="Let it move the mouse and type"
          /* The greyed state's own sentence. It says what to do rather than
             what is wrong, because the fix is one switch away and on this very
             card's neighbour. */
          hint={
            controlPossible
              ? 'A real cursor and real keystrokes, on whatever window is under them — not just on Forge. Read per click, so switching this off stops the next one.'
              : 'Unavailable until you set an unlock PIN, above. A browser that can move the mouse could reach this very setting and switch the PIN off itself, so this desktop will not hand control to an account alone.'
          }
        >
          <Toggle
            checked={settings.webControlEnabled && controlPossible}
            disabled={!controlPossible}
            onChange={(on) => actions.patchSettings({ webControlEnabled: on })}
            label="Let a browser drive this desktop"
          />
        </Row>

        <Row
          label="Send this desktop's sound too"
          hint="Off by default. Windows shares the whole system mix, so this sends every notification, call and video playing on this machine — not just Forge's. It takes effect on the next watch, not the one happening now."
        >
          <Toggle
            checked={settings.webMirrorAudio}
            onChange={(on) => actions.patchSettings({ webMirrorAudio: on })}
            label="Send this desktop's sound too"
          />
        </Row>
      </Card>

      <Card
        title="Reach it from anywhere"
        actions={<StateChip tone={tunnelTone}>{tunnel.state === 'live' ? 'Live' : tunnel.state}</StateChip>}
        hint={
          <>
            The listener binds loopback, so on its own it is reachable from nothing. A tunnel is what gives it a public
            address, and there are two. <strong>Cloudflare</strong> is the one that needs nothing at all — no account,
            no token — and hands out a fresh address each time it starts, which costs nothing here because the browser
            reads this desktop’s current address out of your Firebase account before it dials. <strong>ngrok</strong>
            keeps the same address, but its free plan allows one tunnel per account, so choosing it means Forge Mobile
            has to stay switched off.
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
          label="How this desktop is reached"
          hint={TUNNELS.find((t) => t.id === tunnelMode)?.hint ?? ''}
        >
          <div className="seg" role="group" aria-label="Tunnel">
            {TUNNELS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="seg__btn"
                data-on={tunnelMode === t.id ? 'true' : undefined}
                aria-pressed={tunnelMode === t.id}
                title={t.hint}
                onClick={() => actions.patchSettings({ webTunnel: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Row>

        {/* Only under the choice that reads them. An authtoken box sitting under
            "Cloudflare" would be asking for a credential nothing would use. */}
        {tunnelMode === 'ngrok' && (
          <>
            <p className="scard__hint">First time with ngrok? Quick setup:</p>
            <ol className="scard__steps">
              <li>Create a free account at <span className="mono">ngrok.com</span>.</li>
              <li>
                Copy your authtoken from <span className="mono">dashboard.ngrok.com/get-started/your-authtoken</span>{' '}
                and paste it below.
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
              hint="Optional. Blank means ngrok picks an address each start, which the browser finds anyway. A reserved one keeps it steady — it must be a second domain, not the one Forge Mobile uses."
            >
              <TextField
                value={settings.webNgrokDomain}
                mono
                placeholder="assigned-name.ngrok-free.dev"
                onCommit={saveDomain}
              />
            </Row>
          </>
        )}

        {tunnel.host && (
          <Row
            label="Public hostname"
            hint={
              tunnel.state === 'configured'
                ? 'From FORGE_WEB_HOSTNAME.'
                : tunnelMode === 'ngrok'
                  ? 'What the browser is told to dial. It changes only if you change the domain.'
                  : 'What the browser is told to dial. Cloudflare hands out a new one each start, and the browser is told the new one before it dials.'
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

      {/* Live presence, and deliberately nothing more. There used to be a list
          of approved browsers here with a Revoke button on every row, and it
          was removed because it was never a gate: any browser holding a
          verified token for this account and the unlock PIN was admitted
          whether or not it was on the list, so the rows only implied a lock
          that was not there. What is left is the fact a person actually cannot
          get any other way — whether anybody is on this desk right now. The
          ways to end that are the PIN, and signing Forge Web out. */}
      <Card title="Connected browsers">
        <p className="scard__hint">
          {status.connected === 0
            ? 'No browser is connected right now.'
            : `${status.connected} ${status.connected === 1 ? 'browser is' : 'browsers are'} connected right now.`}
        </p>
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
  inputMode,
  maxLength,
  onChange,
  onSubmit
}: {
  id: string
  label: string
  type: 'email' | 'password' | 'text'
  value: string
  placeholder?: string
  inputMode?: 'numeric'
  maxLength?: number
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
        inputMode={inputMode}
        maxLength={maxLength}
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

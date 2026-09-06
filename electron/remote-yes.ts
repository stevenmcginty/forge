import { randomBytes } from 'node:crypto'

/**
 * Remote Yes — the Electron-free half.
 *
 * ## The problem
 *
 * Steve drives this PC from his phone. Everything works until Windows raises an
 * administrator prompt, and then nothing does: a UAC prompt is drawn on the
 * **secure desktop**, a separate desktop object that only processes running as
 * SYSTEM with the right privilege may draw on or read. Nothing in Steve's own
 * interactive session — not Forge, not a screen capture, not a synthesised
 * click, not any remote-control tool running as him — can see that prompt or
 * press anything on it. The screen simply goes dark for about two minutes and
 * the prompt then times out as a No.
 *
 * ## Why RustDesk, and why *as a service*
 *
 * RustDesk installed with `--silent-install` registers a Windows service that
 * runs as SYSTEM in session 0 and is allowed onto the secure desktop. That
 * service is the *only* component in this design that can show the UAC prompt
 * to a phone and deliver the click back. A portable RustDesk started by hand,
 * or any tool running in Steve's session, cannot — it is not a matter of
 * permissions to be granted, it is a different desktop.
 *
 * So the feature is the service install, and the service install needs
 * administrator rights. Forge has deliberately never asked for them. This is
 * the one exception: **exactly one** UAC prompt, at setup, raised by a
 * `Start-Process -Verb RunAs` the person just pressed a button to get. Nothing
 * afterwards is elevated — the watcher below runs as an ordinary process and
 * only ever reads a process list.
 *
 * ## Why the options go through `--option`
 *
 * The obvious way to configure RustDesk is to write
 * `%APPDATA%\RustDesk\config\RustDesk2.toml`. It does nothing. The service
 * keeps its own configuration under
 * `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\`,
 * which is the copy that matters and which an unelevated process cannot write.
 * The supported route is `rustdesk.exe --option <key> <value>` **run as
 * administrator**, which is why every option in `buildSetupScript` is set
 * inside the one elevated script rather than by editing a file afterwards, and
 * why the same script reads each one back: a silently-ignored option would
 * leave a desktop that answers to the whole LAN with no password.
 *
 * ## Shape
 *
 * Everything here is pure or injectable, the same split
 * `electron/mobile-tunnel.ts` and `electron/companion-sync.ts` use, so
 * `scripts/remote-yes-check.mjs` drives the real parsers and the real watcher
 * with a scripted `exec` and a scripted clock. `electron/remote-yes-host.ts`
 * owns the Electron wiring, the downloads and the one elevated call.
 */

/** Where `--silent-install` puts it. Not configurable — RustDesk's own path. */
export const RUSTDESK_EXE = 'C:\\Program Files\\RustDesk\\rustdesk.exe'

/** The Windows service `--silent-install` registers. The half that can reach
 *  the secure desktop; installed without it, RustDesk cannot help here. */
export const RUSTDESK_SERVICE = 'RustDesk'

/**
 * RustDesk's direct-access port. Fixed rather than settable: it is quoted in
 * the Settings copy, baked into the phone's card and written into the service's
 * own options, and three places that can disagree is three ways to end up with
 * a phone dialling a port nothing listens on.
 */
export const REMOTE_YES_PORT = 21118

/** GitHub's latest-release document for RustDesk. */
export const RUSTDESK_RELEASE_URL = 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest'

/**
 * The whole configuration, as one list, because the elevated script both
 * *writes* and *reads back* it and the two must be the same list.
 *
 *  - `direct-server Y` + `direct-access-port` — dial this machine's own address
 *    directly instead of going through RustDesk's public rendezvous servers.
 *    Nothing about this desktop is published to anyone else's infrastructure.
 *  - `whitelist 100.64.0.0/10` — Tailscale's CGNAT range and nothing else. This
 *    is the load-bearing one: it is what stops the direct port from being an
 *    open door to the LAN, the coffee shop, or a forwarded router port. It is
 *    never widened to a LAN range.
 *  - `verification-method use-permanent-password` + `approve-mode password` —
 *    the generated password is the only way in. No "ask the person at the desk"
 *    prompt, because when this feature matters there is nobody at the desk.
 *  - `enable-lan-discovery N` — this machine does not announce itself.
 */
export const RUSTDESK_OPTIONS: ReadonlyArray<readonly [key: string, value: string]> = [
  ['direct-server', 'Y'],
  ['direct-access-port', String(REMOTE_YES_PORT)],
  ['whitelist', '100.64.0.0/10'],
  ['verification-method', 'use-permanent-password'],
  ['approve-mode', 'password'],
  ['enable-lan-discovery', 'N']
]

/* ------------------------------------------------------------ pure parsers */

/** 100.64.0.0/10 — the CGNAT range Tailscale allocates from. */
const TAILNET_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/

/**
 * The first tailnet IPv4 in `tailscale ip -4` output, or ''.
 *
 * Shape-checked rather than "first non-empty line": the value ends up in the
 * phone's `rustdesk://` deep link and in a Settings line somebody reads out, so
 * an IPv6 address, an error sentence or an empty tailnet must all degrade to
 * '' — which is the state setup refuses to run in — rather than to a string
 * that looks like an address and reaches nothing.
 */
export function parseTailscaleIp(stdout: string): string {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const candidate = line.trim()
    if (TAILNET_IPV4.test(candidate)) return candidate
  }
  return ''
}

/**
 * Is a UAC prompt on screen, given `tasklist /FI "IMAGENAME eq consent.exe"
 * /NH /FO CSV`?
 *
 * `consent.exe` is the process Windows starts to draw the prompt, and tasklist
 * can see that it exists even though nothing in this session can see the window
 * it draws. With no prompt up, tasklist prints "INFO: No tasks are running
 * which match the specified criteria." — which contains neither a CSV row nor
 * the exe name, so a strict row match is also the safe answer for every kind of
 * junk: a false negative costs a notification, a false positive would cost a
 * card on the phone for a prompt that is not there.
 */
export function parseTasklistConsent(stdout: string): boolean {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (/^\s*"consent\.exe"\s*,/i.test(line)) return true
  }
  return false
}

/** The installer a GitHub latest-release document points at. */
export interface RustdeskRelease {
  /** The release tag as published, e.g. `1.4.9`. Display only. */
  version: string
  url: string
  /** Bytes, as GitHub reports them. Compared against what actually arrives. */
  size: number
}

/**
 * Pick the x86_64 installer out of GitHub's latest-release JSON, or null.
 *
 * Strict on purpose. A release carries a dozen assets — .deb, .rpm, .dmg, an
 * aarch64 .exe, .msi variants — and the one this module can run is exactly
 * `rustdesk-<version>-x86_64.exe`. Anything else (a rate-limit document, an
 * HTML error page, a release that has not published a Windows build yet) is
 * null, which the host turns into a sentence rather than a download.
 */
export function parseLatestRelease(json: string): RustdeskRelease | null {
  let doc: unknown
  try {
    doc = JSON.parse(String(json ?? ''))
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const release = doc as { tag_name?: unknown; name?: unknown; assets?: unknown }
  const assets = Array.isArray(release.assets) ? release.assets : []
  for (const raw of assets) {
    if (!raw || typeof raw !== 'object') continue
    const asset = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown }
    const name = typeof asset.name === 'string' ? asset.name : ''
    if (!/^rustdesk-.+-x86_64\.exe$/i.test(name)) continue
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!/^https:\/\/[\w.-]+\//.test(url)) continue
    const size = Number(asset.size)
    const tag = typeof release.tag_name === 'string' ? release.tag_name : typeof release.name === 'string' ? release.name : ''
    return {
      version: tag.replace(/^v/i, '').trim(),
      url,
      size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
    }
  }
  return null
}

/* -------------------------------------------------------------- the password */

/**
 * The alphabet: `a-k m-z A-H J-N P-Z 2-9`.
 *
 * No `l`, `I`, `O`, `0` or `1`. This password is generated on the desk and then
 * typed into a phone, sometimes read off a Settings line by somebody sitting on
 * a sofa, so the pairs that look alike in a sans-serif font are simply not in
 * it. 57 characters; 20 of them is about 116 bits, which is far past anything
 * a direct-access port on a tailnet will ever be worth attacking.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const PASSWORD_LENGTH = 20

/**
 * A fresh RustDesk permanent password.
 *
 * Rejection-sampled rather than `byte % 57`: the modulo would make the first 28
 * characters of the alphabet slightly likelier than the rest, which is a real
 * (if small) loss of entropy for no saving at all. `randomBytes`, never
 * `Math.random` — this is the only credential protecting a remote view of the
 * whole screen.
 */
export function generatePassword(length = PASSWORD_LENGTH): string {
  const n = PASSWORD_ALPHABET.length
  // The largest multiple of n that fits in a byte; anything above is redrawn.
  const limit = Math.floor(256 / n) * n
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue
      out += PASSWORD_ALPHABET[byte % n]
      if (out.length === length) break
    }
  }
  return out
}

/**
 * Strip the password out of anything on its way to a log line, a status detail
 * or an error sentence — the same rule, and the same reason, as
 * `redactAuthtoken` in electron/mobile-tunnel.ts. PowerShell echoes command
 * lines back in some failure messages, so redacting only strings this module
 * composed itself would not be enough: every emitted string passes through
 * here.
 */
export function redactPassword(text: string, password: string): string {
  if (!password) return text
  return String(text ?? '').split(password).join('[password]')
}

/* --------------------------------------------------------- the one elevated script */

/** Single-quote a value into a PowerShell string literal. The one escape rule
 *  (the same helper `electron/desktop-control.ts` uses, kept local so this file
 *  stays free of anything Electron-shaped). */
function psQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

export interface SetupScriptOptions {
  /** The verified installer on disk. Ignored when `alreadyInstalled`. */
  installerPath: string
  /** The permanent password to set. Never appears outside a single-quoted literal. */
  password: string
  /** Where the script drops its JSON verdict for the main process to read. */
  resultPath: string
  /** Skip the install half — RustDesk is already at `RUSTDESK_EXE`. */
  alreadyInstalled: boolean
}

/**
 * The whole elevated half of setup, as one PowerShell script.
 *
 * One script and not a series of elevated calls, because each `-Verb RunAs`
 * is one UAC prompt and the promise made in Settings is that there is exactly
 * one. Everything that needs administrator rights is in here: the silent
 * install, the six options, the password, the service restart, and the read-back
 * that proves all of it took.
 *
 * Two details worth knowing before editing it:
 *
 *  - **The installer does not return promptly.** `--silent-install` launches
 *    RustDesk's tray GUI on its way out, so waiting on the process can hang for
 *    as long as that window is open. It is run inside a job with a hard cap and
 *    then the *outcome* is polled for — the exe on disk and the service
 *    registered — which is the thing actually being waited for.
 *  - **Every value is read back.** An option RustDesk quietly ignored would
 *    leave, at worst, a password-less desktop answering the whole LAN. The main
 *    process compares each returned value and refuses to switch the feature on
 *    if any one of them disagrees.
 *
 * The password reaches the script exactly once, inside a single-quoted
 * PowerShell literal with `'` doubled: single quotes do not expand `$`,
 * backticks or subexpressions, so a generated password can never become part of
 * the command. The host deletes this script and the result file afterwards.
 */
export function buildSetupScript(opts: SetupScriptOptions): string {
  const lines: string[] = []
  lines.push("$ErrorActionPreference = 'Stop'")
  lines.push(`$exe = ${psQuote(RUSTDESK_EXE)}`)
  lines.push(`$svc = ${psQuote(RUSTDESK_SERVICE)}`)
  lines.push(`$resultPath = ${psQuote(opts.resultPath)}`)
  lines.push("$result = [ordered]@{ ok = $false; id = ''; options = [ordered]@{}; listening = $false; error = '' }")
  lines.push('try {')

  if (!opts.alreadyInstalled) {
    lines.push(`  $installer = ${psQuote(opts.installerPath)}`)
    lines.push('  if (-not (Test-Path -LiteralPath $installer)) { throw "The installer is not where Forge left it." }')
    // A job with a cap, because --silent-install launches the tray GUI and the
    // process it started may outlive the install by however long that window
    // stays open. Four minutes is far past any real install of a 24 MB package.
    lines.push('  $job = Start-Job -ScriptBlock { param($path) Start-Process -FilePath $path -ArgumentList \'--silent-install\' -Wait } -ArgumentList $installer')
    lines.push('  Wait-Job -Job $job -Timeout 240 | Out-Null')
    lines.push('  Stop-Job -Job $job -ErrorAction SilentlyContinue')
    lines.push('  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue')
    // What is actually being waited for: the exe on disk and the service
    // registered. Polled rather than assumed, because the job above may have
    // been capped rather than finished.
    lines.push('  $deadline = (Get-Date).AddSeconds(120)')
    lines.push('  while ((Get-Date) -lt $deadline) {')
    lines.push('    $found = Get-Service -Name $svc -ErrorAction SilentlyContinue')
    lines.push('    if ((Test-Path -LiteralPath $exe) -and $found) { break }')
    lines.push('    Start-Sleep -Seconds 2')
    lines.push('  }')
    lines.push('  if (-not (Test-Path -LiteralPath $exe)) { throw "RustDesk did not install — the exe never appeared." }')
    lines.push('  if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) { throw "RustDesk installed but registered no service, so it cannot reach the admin prompt." }')
  } else {
    lines.push('  if (-not (Test-Path -LiteralPath $exe)) { throw "RustDesk is not installed after all." }')
  }

  lines.push('  $wanted = [ordered]@{')
  lines.push(RUSTDESK_OPTIONS.map(([key, value]) => `    ${psQuote(key)} = ${psQuote(value)}`).join('\n'))
  lines.push('  }')
  lines.push('  foreach ($key in $wanted.Keys) { & $exe --option $key $wanted[$key] | Out-Null }')
  lines.push(`  & $exe --password ${psQuote(opts.password)} | Out-Null`)
  lines.push('  Restart-Service -Name $svc -Force')
  // The direct port comes up a few seconds after the service does; reading it
  // back immediately would report "not listening" on a perfectly good install.
  lines.push('  Start-Sleep -Seconds 10')
  lines.push('  foreach ($key in $wanted.Keys) { $result.options[$key] = ((& $exe --option $key | Out-String)).Trim() }')
  lines.push('  $result.id = ((& $exe --get-id | Out-String)).Trim()')
  lines.push(
    `  $result.listening = [bool]((Test-NetConnection -ComputerName '127.0.0.1' -Port ${REMOTE_YES_PORT} -WarningAction SilentlyContinue).TcpTestSucceeded)`
  )
  lines.push('  $result.ok = $true')
  lines.push('} catch {')
  lines.push('  $result.error = $_.Exception.Message')
  lines.push('}')
  // Written whatever happened: the main process reads this file, and a missing
  // one is indistinguishable from a UAC prompt somebody cancelled.
  lines.push('Set-Content -LiteralPath $resultPath -Value ($result | ConvertTo-Json -Depth 4) -Encoding UTF8')
  return lines.join('\n') + '\n'
}

/** What the elevated script writes to `resultPath`. */
export interface SetupResult {
  ok: boolean
  id: string
  options: Record<string, string>
  listening: boolean
  error: string
}

/** Read the script's verdict out of the JSON it wrote, or null for anything
 *  that is not one — a cancelled prompt leaves no file at all. */
export function parseSetupResult(json: string): SetupResult | null {
  let doc: unknown
  try {
    // Windows PowerShell's `Set-Content -Encoding UTF8` writes a byte-order
    // mark, and JSON.parse refuses a document that starts with one. Without
    // this line a perfect install reads as "no result".
    doc = JSON.parse(String(json ?? '').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const raw = doc as Partial<SetupResult> & { options?: unknown }
  const options: Record<string, string> = {}
  if (raw.options && typeof raw.options === 'object') {
    for (const [key, value] of Object.entries(raw.options as Record<string, unknown>)) {
      options[key] = String(value ?? '').trim()
    }
  }
  return {
    ok: raw.ok === true,
    id: String(raw.id ?? '').trim(),
    options,
    listening: raw.listening === true,
    error: String(raw.error ?? '').trim()
  }
}

/**
 * The first option whose read-back value is not what was asked for, or ''.
 *
 * A named key rather than a boolean, because "configuring RustDesk failed" is
 * unactionable and "whitelist did not take" says exactly which promise this
 * install cannot keep.
 */
export function firstOptionMismatch(options: Record<string, string>): string {
  for (const [key, value] of RUSTDESK_OPTIONS) {
    if ((options[key] ?? '').trim() !== value) return key
  }
  return ''
}

/* ------------------------------------------------------------- the watcher */

/** How often the process list is read while Remote Yes is on. */
export const UAC_POLL_MS = 1500

export interface UacWatcherHost {
  /** Runs the tasklist filter and hands back its stdout. Injectable for the check. */
  exec: () => Promise<string>
  /** Called only on a transition, never on every poll. */
  onChange: (active: boolean) => void
  log?: (line: string) => void
  /* Seams for scripts/remote-yes-check.mjs. Real implementations are the defaults. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * Polls for `consent.exe` and reports the edges.
 *
 * A poll and not an event, because Windows offers no notification that a UAC
 * prompt has appeared to a process that is not allowed to see it. 1.5 seconds
 * is chosen against the thing on the other end: the prompt waits about two
 * minutes, and the phone needs time to reconnect (RustDesk drops the session
 * for a few seconds when the secure desktop takes over), so a second and a half
 * of latency is invisible while a cheaper poll would not be.
 *
 * Two rules the check holds it to:
 *
 *  - **Edges only.** `onChange` fires on the rise and on the fall, never on the
 *    eighty polls in between. The notification and the phone's card are one
 *    event each, not one a second for two minutes.
 *  - **One bad exec does not stop the loop.** tasklist can fail transiently —
 *    a machine under load, a moment during logoff. Swallowing the error and
 *    polling again is right; a watcher that quietly stopped after one hiccup
 *    would leave the feature switched on in Settings and dead in fact.
 */
export class UacWatcher {
  private readonly host: UacWatcherHost
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly now: () => number
  private running = false
  private timer: unknown = null
  private last = false
  private riseAt = 0

  constructor(host: UacWatcherHost) {
    this.host = host
    this.setTimer = host.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = host.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.now = host.now ?? (() => Date.now())
  }

  /** Is a prompt up right now, as of the last poll that completed. */
  get active(): boolean {
    return this.last
  }

  /** ms epoch of the last rise, 0 if this watcher has never seen one. */
  get lastRiseAt(): number {
    return this.riseAt
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  /**
   * Stop polling. The remembered state goes with it: a watcher restarted later
   * must report the next prompt it sees as a rise, rather than assuming the one
   * it was watching when it stopped is somehow still on screen.
   */
  stop(): void {
    this.running = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.last = false
  }

  private schedule(): void {
    this.timer = this.setTimer(() => {
      void this.tick()
    }, UAC_POLL_MS)
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (!this.running) return
    try {
      const active = parseTasklistConsent(await this.host.exec())
      // The `running` re-check matters: stop() can land while the exec above is
      // still in flight, and a change reported after that is a card on a phone
      // for a feature somebody has switched off.
      if (this.running && active !== this.last) {
        this.last = active
        if (active) this.riseAt = this.now()
        this.host.onChange(active)
      }
    } catch (err) {
      this.host.log?.(`[remote-yes] tasklist failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.running) this.schedule()
  }
}

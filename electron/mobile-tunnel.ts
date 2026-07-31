import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { MobileTunnelStatus } from '@shared/types'

/**
 * The permanent way in from outside the house: a supervised ngrok agent.
 *
 * `npm run mobile:tunnel` (cloudflared quick tunnel) works, but its URL changes
 * every run — which means re-typing an address into the phone forever. An ngrok
 * account comes with one permanent dev domain (auto-assigned, visible on the
 * dashboard under Domains), so pairing the phone against `wss://<that-domain>`
 * is a one-and-done: whenever this module has the tunnel up and the phone has
 * internet, they find each other. See docs/MOBILE.md.
 *
 * ## Why a child process and not `@ngrok/ngrok`
 *
 * The SDK is a native module. Forge already ships exactly one of those
 * (`@lydell/node-pty`) and packaging a second through electron-builder's asar
 * is risk with no payoff — a spawned binary is inert, needs no rebuild against
 * Electron's ABI, and can be replaced by pointing FORGE_NGROK_EXE somewhere.
 *
 * ## Free-tier facts this module is shaped around
 *
 *  - **1 GB of data transfer a month.** Terminal bytes are the payload, and a
 *    redrawing TUI or a scrolling build log moves real megabytes. The Settings
 *    card says this out loud so Steve budgets it rather than discovering it.
 *  - **3 concurrent agent sessions.** A stranded ngrok.exe quietly holds one;
 *    strand enough and every later start fails with ERR_NGROK_108, which looks
 *    exactly like a bug in this feature. That is why stop() kills the process
 *    *tree* — see `killTreeWindows`.
 *  - The free-tier interstitial page only fronts HTML served to a browser. The
 *    WebSocket upgrade is unaffected, and so is the APK (it carries its own
 *    assets); only the phone-Chrome browser route sees the extra click.
 *
 * ## Shape
 *
 * Electron-free with everything injectable — the same split as
 * `electron/mobile/server.ts`, and for the same reason: `scripts/tunnel-check.mjs`
 * drives this exact class with a scripted fake process, because a supervisor
 * whose backoff and refusal rules have only ever run against the real ngrok is
 * a supervisor nobody has tested. `electron/mobile-host.ts` owns the wiring.
 */

/** The official Windows amd64 agent, from ngrok's own distribution host. */
export const NGROK_ZIP_URL = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip'

/**
 * Backoff for restarts after an unexpected exit: ~1s doubling to a 60s cap.
 * Exported as a pure function so the check can assert the whole schedule
 * without waiting a minute of wall-clock for it.
 */
export const BACKOFF_START_MS = 1000
export const BACKOFF_CAP_MS = 60_000

export function backoffDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  // 2**n overflows into Infinity long before n is large; cap the exponent too.
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(n, 6))
}

/**
 * A connection that stayed up this long was genuinely working, so the *next*
 * failure is a fresh incident, not attempt five of the last one — without this
 * a flaky evening would ratchet the delay to 60s and hold it there for good.
 */
export const HEALTHY_RESET_MS = 30_000

/* ------------------------------------------------------------ pure helpers */

/**
 * The agent's whole command line. JSON logs on stdout are the point: they are
 * how the URL, the errors and the well-known refusals are read, instead of
 * scraping the TUI ngrok draws by default. The authtoken travels as an
 * argument, never via a config file this module would have to write and could
 * then leak into a diff or a backup.
 */
export function ngrokArgs(port: number, domain: string, authtoken: string): string[] {
  return [
    'http',
    String(port),
    `--url=https://${domain}`,
    '--authtoken',
    authtoken,
    '--log=stdout',
    '--log-format=json'
  ]
}

/**
 * Strip the authtoken from anything on its way to a log line, a status field
 * or an error sentence. ngrok itself echoes the token back in some failure
 * messages ("Your authtoken: 2abc…"), so redacting only our own strings would
 * not be enough — every emitted string passes through here.
 */
export function redactAuthtoken(text: string, authtoken: string): string {
  if (!authtoken) return text
  return text.split(authtoken).join('[authtoken]')
}

/** One JSON log line off ngrok's stdout, or null for anything that is not one. */
export interface NgrokLogEvent {
  lvl: string
  msg: string
  url: string
  err: string
}

export function parseNgrokLine(line: string): NgrokLogEvent | null {
  const raw = line.trim()
  if (!raw.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (name: string): string => {
    const v = (value as Record<string, unknown>)[name]
    return typeof v === 'string' ? v : ''
  }
  return { lvl: field('lvl'), msg: field('msg'), url: field('url'), err: field('err') }
}

/**
 * The doors that will not open, matched by ngrok's error codes and the phrases
 * around them. Restarting into any of these buys nothing but a spent request
 * against the account — the same reason `mobile/src/lib/link.ts` refuses to
 * retry close codes 4001–4003. The returned sentences are fixed text, so a
 * refusal can never smuggle the authtoken (or anything else ngrok echoed) into
 * a status field.
 *
 * Codes 105/107/108 are stable and documented; the domain-ownership failures
 * are matched on phrasing because their codes have shifted between agent
 * versions and a missed match merely retries where it should stop.
 */
export function permanentRefusal(text: string): string | null {
  if (/ERR_NGROK_10[57]/.test(text) || /authtoken.+(is invalid|not look like)/i.test(text)) {
    return 'ngrok rejected the authtoken. Paste a fresh one from the ngrok dashboard into Settings › Forge Mobile.'
  }
  if (/ERR_NGROK_108/.test(text) || /limited to \d+ simultaneous ngrok agent session/i.test(text)) {
    return 'This ngrok account already has its full allowance of agent sessions running somewhere. Close the other ngrok agents (or stranded ngrok.exe processes) and switch the tunnel on again.'
  }
  if (/not reserved for your account/i.test(text) || /reserved for another account/i.test(text)) {
    return 'That domain does not belong to this ngrok account. Copy the domain assigned to you from the ngrok dashboard into Settings › Forge Mobile.'
  }
  return null
}

/**
 * What `IPC.mobilePair` should tell a phone to dial.
 *
 * With the tunnel live the answer is `wss://<domain>` and **nothing else** — no
 * port. `toOrigin` in mobile/src/lib/secure.ts keeps a secure URL port-less on
 * purpose (the tunnel listens on the implicit 443); appending the LAN's 8420
 * would produce an address nothing listens on, failing in a way that looks
 * like the desktop being down. `port: 0` in that case means "the scheme's
 * default", and the LAN pair keeps its explicit host:port exactly as before.
 */
export function pairEndpoint(
  tunnel: MobileTunnelStatus,
  lanHost: string,
  lanPort: number
): { host: string; port: number; url: string } {
  if (tunnel.state === 'live' && tunnel.url) {
    try {
      const host = new URL(tunnel.url).hostname
      if (host) return { host, port: 0, url: `wss://${host}` }
    } catch {
      /* an unparsable url falls through to the LAN answer */
    }
  }
  return { host: lanHost, port: lanPort, url: '' }
}

/* --------------------------------------------------------- finding ngrok */

export interface NgrokProbe {
  /** Usually process.env. FORGE_NGROK_EXE and PATH are read from it. */
  env: Record<string, string | undefined>
  /** %APPDATA%\Forge\bin — where a downloaded copy lives. */
  binDir: string
  exists?: (path: string) => boolean
}

/**
 * Where ngrok.exe already is, or '' if it is nowhere and must be fetched.
 *
 * Order matters: the explicit override first (it is the most specific request),
 * then our own bin dir (a copy this module fetched keeps winning over whatever
 * the machine acquires later), then PATH, then the two package managers'
 * shimless install spots that are *not* always on PATH.
 */
export function resolveNgrokExe(probe: NgrokProbe): string {
  const exists = probe.exists ?? existsSync
  const override = probe.env['FORGE_NGROK_EXE']?.trim()
  if (override && exists(override)) return override

  const candidates = [join(probe.binDir, 'ngrok.exe')]
  for (const dir of (probe.env['PATH'] ?? '').split(delimiter)) {
    if (dir.trim()) candidates.push(join(dir.trim(), 'ngrok.exe'))
  }
  const localAppData = probe.env['LOCALAPPDATA']?.trim()
  if (localAppData) candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ngrok.exe'))
  const programData = probe.env['ProgramData']?.trim()
  if (programData) candidates.push(join(programData, 'chocolatey', 'bin', 'ngrok.exe'))

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return ''
}

export interface FetchNgrokDeps {
  binDir: string
  url?: string
  /** The download itself. Injected so the check never fakes a network. */
  fetchBytes?: (url: string) => Promise<Buffer>
  extract?: (zipPath: string, intoDir: string) => Promise<boolean>
}

async function fetchBytesReal(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Windows has shipped bsdtar as System32\tar.exe since 2018, and bsdtar reads
 * zips — which is what lets this extract one file without a dependency.
 *
 * **Spelled absolutely, never as bare `tar`.** GNU tar cannot read a zip at
 * all, and a machine with Git, MSYS2, WSL shims or chocolatey on PATH may well
 * resolve `tar` to one of those instead: verified on this machine, where Git's
 * `/usr/bin/tar` wins and answers "This does not look like a tar archive". The
 * failure would land on first run, on the one path with no ngrok yet, and would
 * read as "the download is broken" rather than "the wrong tar answered".
 */
export function bsdtarPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function extractReal(zipPath: string, intoDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bsdtarPath(), ['-x', '-f', zipPath, '-C', intoDir, 'ngrok.exe'], {
      stdio: 'ignore'
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * Fetch the official agent into `binDir`. Every failure comes back as one
 * sentence a person can act on, because the person acting on it is standing in
 * Settings, not reading a stack trace in a terminal.
 */
export async function ensureNgrokExe(
  deps: FetchNgrokDeps
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const url = deps.url ?? NGROK_ZIP_URL
  const target = join(deps.binDir, 'ngrok.exe')
  let bytes: Buffer
  try {
    bytes = await (deps.fetchBytes ?? fetchBytesReal)(url)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Could not download ngrok (${reason}). Check the connection, or install ngrok yourself and set FORGE_NGROK_EXE to it.`
    }
  }
  // 'PK' — a real zip. A captive portal or a proxy error page is HTML, and
  // handing that to an extractor produces a failure far less legible than this.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return {
      ok: false,
      error: 'The ngrok download did not look like a zip — something on the network answered in its place. Try again, or install ngrok yourself and set FORGE_NGROK_EXE.'
    }
  }

  mkdirSync(deps.binDir, { recursive: true })
  const zipPath = join(deps.binDir, 'ngrok-download.zip')
  try {
    writeFileSync(zipPath, bytes)
    const extracted = await (deps.extract ?? extractReal)(zipPath, deps.binDir)
    if (!extracted || !existsSync(target)) {
      return {
        ok: false,
        error: `Downloaded ngrok but could not unzip it. Extract ngrok.exe from ${zipPath} into ${deps.binDir} by hand, or install ngrok and set FORGE_NGROK_EXE.`
      }
    }
  } finally {
    try {
      if (existsSync(target)) rmSync(zipPath, { force: true })
    } catch {
      /* a leftover zip is untidy, not a failure */
    }
  }
  return { ok: true, path: target }
}

/* ------------------------------------------------------------- supervisor */

/** The slice of ChildProcess the supervisor touches, so the check can fake it. */
export interface TunnelChild {
  pid?: number | undefined
  stdout: { on(event: 'data', cb: (chunk: unknown) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: unknown) => void): void } | null
  on(event: 'exit', cb: (code: number | null) => void): void
  kill(): void
}

export type SpawnTunnel = (exe: string, args: string[]) => TunnelChild

export interface NgrokTunnelHost {
  exe: string
  port: number
  domain: string
  authtoken: string
  /** Every state change, already redacted. mobile-host folds it into mobileStatus(). */
  onStatus: (status: MobileTunnelStatus) => void
  log?: (line: string) => void
  /* Seams for scripts/tunnel-check.mjs. Real implementations are the defaults. */
  spawn?: SpawnTunnel
  killTree?: (pid: number) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * Killing ngrok on Windows must actually kill it. `child.kill()` sends
 * TerminateProcess to the pid we spawned, but not to anything that pid
 * spawned — and a stranded ngrok agent keeps its dial-out to ngrok's edge
 * alive, holding one of the account's three concurrent sessions. Strand a few
 * across restarts and every later start fails with ERR_NGROK_108, which would
 * look exactly like a bug in this feature. `taskkill /T /F` takes the whole
 * tree down.
 */
function killTreeWindows(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      /* fall through to the plain kill */
    }
  }
  try {
    process.kill(pid)
  } catch {
    /* already gone */
  }
}

export class NgrokTunnel {
  private readonly host: NgrokTunnelHost
  private child: TunnelChild | null = null
  private timer: unknown = null
  private attempt = 0
  private liveSince = 0
  private refusal = ''
  private lastError = ''
  private stopped = false
  private current: MobileTunnelStatus = { state: 'off', url: '', detail: '' }

  constructor(host: NgrokTunnelHost) {
    this.host = host
  }

  /** How many restarts the current incident has cost. Read by the check. */
  get attempts(): number {
    return this.attempt
  }

  status(): MobileTunnelStatus {
    return this.current
  }

  start(): void {
    if (this.child || this.timer) return
    this.stopped = false
    this.attempt = 0
    this.refusal = ''
    this.spawnOnce()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      ;(this.host.clearTimer ?? clearTimeout)(this.timer as NodeJS.Timeout)
      this.timer = null
    }
    const child = this.child
    this.child = null
    if (child?.pid) (this.host.killTree ?? killTreeWindows)(child.pid)
    else child?.kill()
    this.report({ state: 'off', url: '', detail: '' })
  }

  /* ------------------------------------------------------------- internals */

  private spawnOnce(): void {
    if (this.stopped) return
    this.report({ state: 'starting', url: '', detail: this.attempt === 0 ? 'Starting ngrok…' : 'Starting ngrok again…' })

    let child: TunnelChild
    try {
      child = (this.host.spawn ?? ((exe, args) => spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })))(
        this.host.exe,
        ngrokArgs(this.host.port, this.host.domain, this.host.authtoken)
      )
    } catch (err) {
      // spawn() itself throwing means the exe is not runnable — retrying the
      // same path would throw the same way, so this is a permanent refusal.
      const reason = err instanceof Error ? err.message : String(err)
      this.report({ state: 'error', url: '', detail: this.redact(`Could not run ngrok: ${reason}`) })
      return
    }
    this.child = child

    // ngrok writes one JSON object per line, but a pipe delivers chunks, not
    // lines — the remainder is carried between chunks or a URL split across
    // two reads would never be seen.
    let carry = ''
    const onChunk = (chunk: unknown): void => {
      carry += String(chunk)
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) this.onLine(line)
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('exit', (code) => this.onExit(code))
  }

  private onLine(line: string): void {
    const event = parseNgrokLine(line)
    if (!event) return

    if (event.url.startsWith('https://')) {
      this.liveSince = (this.host.now ?? Date.now)()
      this.lastError = ''
      this.report({ state: 'live', url: event.url, detail: '' })
      this.host.log?.(`tunnel live at ${event.url}`)
      return
    }

    // ngrok spells it 'eror' and 'crit'. Everything else is routine chatter.
    if (event.lvl !== 'eror' && event.lvl !== 'crit' && !event.err) return
    const text = `${event.msg} ${event.err}`.trim()
    const refusal = permanentRefusal(text)
    if (refusal) this.refusal = refusal
    this.lastError = this.redact(text)
    this.host.log?.(`ngrok: ${this.lastError}`)
  }

  private onExit(code: number | null): void {
    this.child = null
    if (this.stopped) return

    // A door that will not open. Stop knocking — the sentence says which key
    // to go and fix, and switching the tunnel off and on retries deliberately.
    if (this.refusal) {
      this.report({ state: 'error', url: '', detail: this.refusal })
      return
    }

    const now = (this.host.now ?? Date.now)()
    if (this.liveSince && now - this.liveSince >= HEALTHY_RESET_MS) this.attempt = 0
    this.liveSince = 0

    const delay = backoffDelay(this.attempt)
    this.attempt += 1
    const why = this.lastError ? ` (${this.lastError})` : ''
    this.report({
      state: 'retrying',
      url: '',
      detail: `ngrok exited${code === null ? '' : ` (${code})`}${why} — retrying in ${Math.round(delay / 1000)}s.`
    })
    this.timer = (this.host.setTimer ?? setTimeout)(() => {
      this.timer = null
      this.spawnOnce()
    }, delay)
  }

  private redact(text: string): string {
    return redactAuthtoken(text, this.host.authtoken)
  }

  private report(status: MobileTunnelStatus): void {
    this.current = { ...status, detail: this.redact(status.detail) }
    this.host.onStatus(this.current)
  }
}

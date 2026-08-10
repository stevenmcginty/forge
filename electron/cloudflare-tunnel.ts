import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { TunnelStatus } from '@shared/types'
import type { SpawnTunnel, TunnelChild } from './mobile-tunnel'

/**
 * The second way in from outside: a supervised **cloudflared quick tunnel**.
 *
 * ## Why this file exists at all
 *
 * Forge Web used to share `electron/mobile-tunnel.ts`, on the reasoning that a
 * supervisor which already downloads, spawns, restarts and gives up was worth
 * more than a second one written from scratch. That reasoning was sound and its
 * premise was not: **ngrok's free plan allows one online endpoint per account.**
 * Forge Mobile holds it, so switching Forge Web on produced
 *
 *   failed to start tunnel: The endpoint '…' is already online … ERR_NGROK_334
 *
 * and the only way to read a browser link was to take the phone link down. Two
 * links that cannot be up at once is not two links.
 *
 * A cloudflared quick tunnel has no account, no authtoken, no reserved domain
 * and no per-account agent limit — `cloudflared tunnel --url http://127.0.0.1:N`
 * dials out and answers with a `*.trycloudflare.com` hostname. It is what
 * `scripts/mobile-tunnel.mjs` and `scripts/mobile-go.mjs` have always used to
 * put the phone link on the internet by hand; the argv and the URL match below
 * are theirs, unchanged, because they are known to work against the real binary.
 *
 * ## The one thing a quick tunnel costs, and why it costs nothing here
 *
 * The hostname is different on every start. For a phone that scanned a QR that
 * would be fatal — it keeps the address it was given — which is exactly why
 * **Forge Mobile stays on ngrok and this file is not for it.** For a browser it
 * is free: the rendezvous record in `shared/web.ts` exists precisely so the
 * desktop publishes wherever it landed and the browser reads that before it
 * dials. A tunnel that dies and returns on a new address simply republishes —
 * `web-host.ts`'s `setTunnelState` calls `rendezvous.refresh()` on every state
 * change for this case, and `scripts/web-check.mjs` asserts it happens.
 *
 * ## What is deliberately *not* here
 *
 * No authtoken, and therefore no `redactAuthtoken`, no token-shaped refusals,
 * and no "paste a fresh one into Settings" sentence. There is no credential to
 * leak or to get wrong. That absence is the feature, and it is why this class is
 * shorter than its twin rather than a copy of it.
 *
 * Everything else *is* the twin's, on purpose: the backoff schedule, the
 * healthy-reset rule, the refuse-don't-retry rule and the kill-the-whole-tree
 * stop. A supervisor whose restart logic differs between two links is a
 * supervisor with two behaviours to learn. Electron-free and injectable for the
 * same reason `mobile-tunnel.ts` is: `scripts/cf-tunnel-check.mjs` drives this
 * exact class against a scripted process, and `scripts/web-check.mjs` drives it
 * through the real `web-host.ts`.
 */

/**
 * The official Windows amd64 build, from Cloudflare's own GitHub releases.
 *
 * A plain `.exe` rather than ngrok's zip, so there is no extraction step and
 * therefore no repeat of the bsdtar-versus-GNU-tar trap `mobile-tunnel.ts`
 * documents. `latest/download` is a redirect GitHub maintains; `fetch` follows
 * it, and pinning a version here would mean a Forge that shipped in March
 * fetching a cloudflared that Cloudflare stopped serving in June.
 */
export const CLOUDFLARED_EXE_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

/**
 * Backoff for restarts after an unexpected exit: ~1s doubling to a 60s cap, and
 * the same schedule `electron/mobile-tunnel.ts` uses. Exported as a pure
 * function so the check can assert the whole schedule without waiting a minute
 * of wall-clock for it.
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
 * failure is a fresh incident rather than attempt five of the last one.
 */
export const HEALTHY_RESET_MS = 30_000

/* ------------------------------------------------------------ pure helpers */

/**
 * The whole command line, and it is short because a quick tunnel has nothing to
 * configure: no account, no domain, no token.
 *
 * `--no-autoupdate` matters more than it looks. Left off, cloudflared replaces
 * its own binary and restarts itself — under a supervisor that is watching for
 * the process to exit, which would read as a crash and start the backoff clock
 * on a tunnel that is merely upgrading. (On Windows it declines to self-update
 * anyway, and says so in its log; passing the flag means Forge does not depend
 * on that staying true.)
 *
 * Loopback, always, and spelled `127.0.0.1` rather than `localhost` — the
 * listener in `electron/web-host.ts` binds that exact address, and a name that
 * resolves to `::1` first is a tunnel onto a port nothing is on.
 */
export function cloudflaredArgs(port: number): string[] {
  return ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']
}

/**
 * The address a quick tunnel hands back, as it appears in cloudflared's output.
 *
 * Taken verbatim from `scripts/mobile-tunnel.mjs`, which has been reading it off
 * the real binary since Forge Mobile's first tunnel. cloudflared prints it
 * inside a box of `+---+` drawing characters in the middle of a wall of INF
 * lines — there is no structured field to read instead — so a match on the
 * shape of the URL is the parse, not a shortcut around one.
 */
export const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** One line off cloudflared's output, or null for anything unreadable. */
export interface CloudflaredLogEvent {
  /** `INF`, `WRN`, `ERR`, `FTL`, or '' for a line with no level at all. */
  level: string
  /** Everything after the level, or the whole line when there was none. */
  message: string
  /** The quick-tunnel URL, when this line carried one. */
  url: string
}

/**
 * cloudflared writes `2026-08-10T16:42:54Z INF <message>` to **stderr**, and
 * some failures — an unusable command line, printed by the flag parser before
 * the logger exists — arrive with no timestamp and no level at all. Both are
 * kept: a line this function threw away because it did not match the happy shape
 * is a line whose complaint never reaches the panel.
 */
export function parseCloudflaredLine(line: string): CloudflaredLogEvent | null {
  const raw = line.trim()
  if (!raw) return null
  const levelled = /^\S+\s+(INF|WRN|ERR|FTL|DBG|TRC)\s+(.*)$/.exec(raw)
  const level = levelled ? levelled[1] : ''
  const message = levelled ? levelled[2] : raw
  return { level, message, url: QUICK_TUNNEL_URL.exec(raw)?.[0] ?? '' }
}

/**
 * The doors that will not open — and unlike ngrok's, none of them is about a
 * credential, because there is not one.
 *
 * What is left is the command line itself. cloudflared refuses an argument it
 * does not understand (`Incorrect Usage. flag provided but not defined: …`) or
 * an origin URL it cannot parse (`ERR Couldn't start tunnel error="…"`), and it
 * refuses them identically every time — so restarting buys nothing but a log
 * full of the same sentence at sixty-second intervals. Both are Forge's fault
 * rather than Steve's, which is why the text is handed on verbatim instead of
 * being translated into an instruction he cannot act on.
 *
 * Everything else cloudflared complains about — a dropped edge connection, a
 * DNS wobble, `failed to request quick Tunnel` when Cloudflare is rate-limiting
 * anonymous tunnels — is worth retrying, and is not matched here.
 */
export function permanentRefusal(text: string): string | null {
  if (/Incorrect Usage/i.test(text) || /flag provided but not defined/i.test(text)) {
    return `cloudflared refused the command line Forge gave it: ${text.trim()}`
  }
  if (/Couldn't start tunnel/i.test(text)) {
    return `cloudflared could not start the tunnel: ${text.trim()}`
  }
  return null
}

/* -------------------------------------------------- finding cloudflared */

export interface CloudflaredProbe {
  /** Usually process.env. FORGE_CLOUDFLARED_EXE and PATH are read from it. */
  env: Record<string, string | undefined>
  /** %APPDATA%\Forge\bin — where a downloaded copy lives. */
  binDir: string
  exists?: (path: string) => boolean
}

/**
 * Where cloudflared.exe already is, or '' if it is nowhere and must be fetched.
 *
 * The same order `resolveNgrokExe` uses, and for the same reasons: the explicit
 * override first because it is the most specific request, then our own bin dir
 * so a copy Forge fetched keeps winning over whatever the machine acquires
 * later, then PATH, then the install spots that are *not* always on it.
 *
 * The two `Program Files` paths are the ones `scripts/mobile-tunnel.mjs` and
 * `scripts/mobile-go.mjs` have looked in since they were written — Cloudflare's
 * MSI (and winget, which installs it) puts the binary there, and the 32-bit
 * spelling first is not a typo: that is where it actually lands.
 */
export function resolveCloudflaredExe(probe: CloudflaredProbe): string {
  const exists = probe.exists ?? existsSync
  const override = probe.env['FORGE_CLOUDFLARED_EXE']?.trim()
  if (override && exists(override)) return override

  const candidates = [join(probe.binDir, 'cloudflared.exe')]
  for (const dir of (probe.env['PATH'] ?? '').split(delimiter)) {
    if (dir.trim()) candidates.push(join(dir.trim(), 'cloudflared.exe'))
  }
  candidates.push(
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe'
  )
  const localAppData = probe.env['LOCALAPPDATA']?.trim()
  if (localAppData) candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'))
  const programData = probe.env['ProgramData']?.trim()
  if (programData) candidates.push(join(programData, 'chocolatey', 'bin', 'cloudflared.exe'))

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return ''
}

export interface FetchCloudflaredDeps {
  binDir: string
  url?: string
  /** The download itself. Injected so the check never fakes a network. */
  fetchBytes?: (url: string) => Promise<Buffer>
}

async function fetchBytesReal(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Fetch the official binary into `binDir`. Every failure comes back as one
 * sentence a person can act on, because the person acting on it is standing in
 * Settings rather than reading a stack trace.
 *
 * It lands under a temporary name and is renamed into place, so a download that
 * dies halfway cannot leave a truncated `cloudflared.exe` for `resolveCloudflaredExe`
 * to find and hand to `spawn` on the next start.
 */
export async function ensureCloudflaredExe(
  deps: FetchCloudflaredDeps
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const url = deps.url ?? CLOUDFLARED_EXE_URL
  const target = join(deps.binDir, 'cloudflared.exe')
  let bytes: Buffer
  try {
    bytes = await (deps.fetchBytes ?? fetchBytesReal)(url)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Could not download cloudflared (${reason}). Check the connection, or install it yourself with "winget install --id Cloudflare.cloudflared".`
    }
  }
  // 'MZ' — a real Windows program. A captive portal or a proxy error page is
  // HTML, and spawning that produces a failure far less legible than this.
  if (bytes.length < 4 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return {
      ok: false,
      error: 'The cloudflared download did not look like a Windows program — something on the network answered in its place. Try again, or install it with "winget install --id Cloudflare.cloudflared".'
    }
  }

  const partial = join(deps.binDir, 'cloudflared-download.exe')
  try {
    mkdirSync(deps.binDir, { recursive: true })
    writeFileSync(partial, bytes)
    renameSync(partial, target)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    try {
      rmSync(partial, { force: true })
    } catch {
      /* a leftover part-file is untidy, not a failure */
    }
    return {
      ok: false,
      error: `Downloaded cloudflared but could not save it (${reason}). Install it with "winget install --id Cloudflare.cloudflared", or set FORGE_CLOUDFLARED_EXE to a copy.`
    }
  }
  return { ok: true, path: target }
}

/* ------------------------------------------------------------- supervisor */

export interface CloudflareTunnelHost {
  exe: string
  port: number
  /**
   * Every state change. `web-host.ts` folds it into `webStatus().tunnel` and
   * nudges the rendezvous, because for Forge Web this status *is* the address a
   * browser is about to be told to dial — and on this transport that address
   * changes every time the agent restarts.
   */
  onStatus: (status: TunnelStatus) => void
  log?: (line: string) => void
  /* Seams for the checks. Real implementations are the defaults. */
  spawn?: SpawnTunnel
  killTree?: (pid: number) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * The same reasoning as `killTreeWindows` in electron/mobile-tunnel.ts:
 * `child.kill()` terminates the pid we spawned and nothing that pid spawned, and
 * a stranded agent keeps its dial-out to the edge alive. It costs no account
 * allowance here — that is ngrok's problem, not Cloudflare's — but it does keep
 * a public address answering onto a port Steve believes he closed, which is
 * worse.
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

export class CloudflareTunnel {
  private readonly host: CloudflareTunnelHost
  private child: TunnelChild | null = null
  private timer: unknown = null
  private attempt = 0
  private liveSince = 0
  private refusal = ''
  private lastError = ''
  private stopped = false
  private current: TunnelStatus = { state: 'off', url: '', detail: '' }

  constructor(host: CloudflareTunnelHost) {
    this.host = host
  }

  /** How many restarts the current incident has cost. Read by the check. */
  get attempts(): number {
    return this.attempt
  }

  status(): TunnelStatus {
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
    this.report({
      state: 'starting',
      url: '',
      detail: this.attempt === 0 ? 'Starting cloudflared…' : 'Starting cloudflared again…'
    })

    let child: TunnelChild
    try {
      child = (this.host.spawn ?? ((exe, args) => spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })))(
        this.host.exe,
        cloudflaredArgs(this.host.port)
      )
    } catch (err) {
      // spawn() itself throwing means the exe is not runnable — retrying the
      // same path would throw the same way, so this is a permanent refusal.
      const reason = err instanceof Error ? err.message : String(err)
      this.report({ state: 'error', url: '', detail: `Could not run cloudflared: ${reason}` })
      return
    }
    this.child = child

    // cloudflared writes lines, but a pipe delivers chunks — the remainder is
    // carried between them or the URL, which arrives in the middle of a boxed
    // banner, would eventually be split across two reads and never seen. Both
    // pipes are read: the log is on stderr, and the flag parser's refusals are
    // on stdout.
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
    const event = parseCloudflaredLine(line)
    if (!event) return

    if (event.url) {
      this.liveSince = (this.host.now ?? Date.now)()
      this.lastError = ''
      this.report({ state: 'live', url: event.url, detail: '' })
      this.host.log?.(`tunnel live at ${event.url}`)
      return
    }

    // A refusal can arrive with no level on it at all, so the level is a filter
    // for the *chatter*, never a gate on the refusal check.
    const refusal = permanentRefusal(event.message)
    if (refusal) this.refusal = refusal
    if (!refusal && event.level !== 'ERR' && event.level !== 'FTL') return
    this.lastError = event.message
    this.host.log?.(`cloudflared: ${this.lastError}`)
  }

  private onExit(code: number | null): void {
    this.child = null
    if (this.stopped) return

    // A door that will not open. Stop knocking — switching the tunnel off and on
    // retries deliberately.
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
      detail: `cloudflared exited${code === null ? '' : ` (${code})`}${why} — retrying in ${Math.round(delay / 1000)}s.`
    })
    this.timer = (this.host.setTimer ?? setTimeout)(() => {
      this.timer = null
      this.spawnOnce()
    }, delay)
  }

  private report(status: TunnelStatus): void {
    this.current = status
    this.host.onStatus(this.current)
  }
}

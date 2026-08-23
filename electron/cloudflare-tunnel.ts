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

/**
 * The watchdog, and why a supervisor that only watches for *exit* is not
 * enough on this transport.
 *
 * A quick tunnel can die while cloudflared lives. Cloudflare deletes the
 * anonymous `*.trycloudflare.com` registration on its side — the hostname
 * drops out of DNS entirely — and cloudflared does not exit. It sits in a
 * reconnect loop printing `Serve tunnel error` / `control stream encountered a
 * failure while serving` forever, the supervisor sees a healthy child, the
 * rendezvous record keeps a fresh heartbeat on an address that answers for
 * nobody, and every browser in the world shows "desktop is asleep" while the
 * desktop is wide awake. That exact incident is in %APPDATA%\Forge\dev.log,
 * 636 error lines deep, from 2026-08-11.
 *
 * Two detectors, because each catches what the other cannot:
 *
 *  - **the log.** While live, consecutive `Serve tunnel error` lines are
 *    counted; `Registered tunnel connection` — cloudflared's own announcement
 *    that an edge link is re-established — resets the count. A genuine blip
 *    re-registers within a line or two; a deleted tunnel never does. At
 *    EDGE_FAILURE_LIMIT the child is killed.
 *  - **the probe.** Every PROBE_INTERVAL_MS the public URL is fetched over
 *    HTTPS, end to end through Cloudflare's edge and back into the loopback
 *    listener. Any HTTP status below 500 proves the path (our own server's
 *    404 included); Cloudflare answers 530 for a tunnel it no longer carries,
 *    and a hostname gone from DNS rejects outright. PROBE_STRIKES consecutive
 *    failures kill the child. This catches the death cloudflared never
 *    mentions at all.
 *
 * Killing the child is the whole cure: the ordinary exit path respawns it,
 * the quick tunnel comes back on a fresh hostname, `setTunnelState` fires and
 * `web-host.ts` republishes the rendezvous record, and the browser's next poll
 * finds the new address. A false positive still costs something, though — a
 * quick tunnel that reconnects *keeps* its hostname, and a killed one draws a
 * new address every browser has to re-find — so neither detector kills on its
 * own say-so:
 *
 *  - the log counter's verdict is confirmed by an immediate probe before it
 *    fires, so an edge that grumbles while the address still answers is left
 *    alone (cloudflared holds several edge connections, and one datacenter
 *    event can print a failure line for each of them);
 *  - a failed probe is confirmed against CONTROL_PROBE_URL, so this desktop's
 *    own connection being down — which fails *every* fetch — pauses the
 *    watchdog instead of forfeiting a hostname that would have survived.
 *
 * And because the cure is a kill, the kill itself cannot be trusted blindly:
 * if the child has not exited KILL_ESCALATE_MS after taskkill, the exit is
 * synthesised — a supervisor stuck at `retrying` with every detector disarmed
 * would be the original incident back again, minus the self-heal.
 *
 * **The newborn check.** A quick tunnel can be dead on arrival: cloudflared
 * prints the banner, the desktop publishes the hostname, and Cloudflare never
 * puts it into DNS at all (2026-08-23, dev-2.log — the browser showed "it
 * published an address a moment ago, but nothing is answering there" for four
 * minutes). On the 2-minute clock that costs PROBE_STRIKES × PROBE_INTERVAL_MS
 * before the restart, which is the whole outage. So a freshly announced
 * address is probed every BIRTH_PROBE_INTERVAL_MS until it answers *once*;
 * if BIRTH_PROBE_LIMIT probes in a row fail with the control probe passing,
 * the child is killed straight away and the next address is drawn. The banner
 * itself warns "it may take some time to be reachable", which is why one
 * failure is not a verdict and the limit is a minute's worth of tries.
 */
export const EDGE_FAILURE_LIMIT = 6
export const PROBE_INTERVAL_MS = 120_000
export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_STRIKES = 2
export const KILL_ESCALATE_MS = 10_000
export const BIRTH_PROBE_INTERVAL_MS = 5_000
export const BIRTH_PROBE_LIMIT = 12

/** cloudflared's serving-failure line — the signature of a dead quick tunnel. */
export const EDGE_FAILURE_LINE = /Serve tunnel error/i
/** cloudflared's edge-link-restored line, which forgives the failures before it. */
export const EDGE_RECOVERED_LINE = /Registered tunnel connection/i

/**
 * Cloudflare's own trace endpoint: the one host guaranteed to be reachable
 * whenever the *edge* is reachable, which is exactly the question the control
 * probe asks. Any HTTP answer at all counts — a 4xx proves the network path
 * as well as a 200 does.
 */
export const CONTROL_PROBE_URL = 'https://www.cloudflare.com/cdn-cgi/trace'

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
  /** The watchdog's end-to-end reachability check. True means the address answers. */
  probe?: (url: string) => Promise<boolean>
  /** The watchdog's is-the-internet-up check. True means this desktop is online. */
  probeControl?: () => Promise<boolean>
}

/**
 * The default probe: one HEAD request to the public URL, through the edge and
 * back into the loopback listener. Below 500 is alive — the desktop server's
 * own 404 for `/` proves the whole path just as well as a 200 would.
 * Cloudflare's 530 for a tunnel it no longer carries, and the outright
 * rejection of a hostname DNS has dropped, are the two shapes of dead.
 */
async function probeTunnelUrl(url: string): Promise<boolean> {
  try {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: control.signal })
      return res.status < 500
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/** The default control probe — see CONTROL_PROBE_URL for why any answer counts. */
async function probeControlUrl(): Promise<boolean> {
  try {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), PROBE_TIMEOUT_MS)
    try {
      await fetch(CONTROL_PROBE_URL, { method: 'HEAD', redirect: 'manual', signal: control.signal })
      return true
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
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
  private probeTimer: unknown = null
  private birthTimer: unknown = null
  private killTimer: unknown = null
  private attempt = 0
  private liveSince = 0
  private refusal = ''
  private lastError = ''
  private stopped = false
  private edgeFailures = 0
  private probeStrikes = 0
  private birthProbes = 0
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
    this.edgeFailures = 0
    this.probeStrikes = 0
    this.spawnOnce()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      ;(this.host.clearTimer ?? clearTimeout)(this.timer as NodeJS.Timeout)
      this.timer = null
    }
    this.clearProbe()
    this.clearBirthProbe()
    this.clearKillTimer()
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
    // The handler names its own child so a late exit — one arriving after the
    // watchdog synthesised it, or after stop()/start() replaced the process —
    // cannot clobber a successor's state.
    child.on('exit', (code) => this.onExit(child, code))
  }

  private onLine(line: string): void {
    const event = parseCloudflaredLine(line)
    if (!event) return

    if (event.url) {
      this.liveSince = (this.host.now ?? Date.now)()
      this.lastError = ''
      this.edgeFailures = 0
      this.probeStrikes = 0
      this.report({ state: 'live', url: event.url, detail: '' })
      this.host.log?.(`tunnel live at ${event.url}`)
      this.scheduleProbe()
      this.birthProbes = 0
      this.clearBirthProbe()
      this.scheduleBirthProbe()
      return
    }

    // An edge link coming back means the failures before it were a blip, not a
    // dead tunnel — the watchdog's count starts over.
    if (EDGE_RECOVERED_LINE.test(event.message)) {
      this.edgeFailures = 0
      return
    }

    // A refusal can arrive with no level on it at all, so the level is a filter
    // for the *chatter*, never a gate on the refusal check.
    const refusal = permanentRefusal(event.message)
    if (refusal) this.refusal = refusal
    if (!refusal && event.level !== 'ERR' && event.level !== 'FTL') return
    this.lastError = event.message
    this.host.log?.(`cloudflared: ${this.lastError}`)

    // The watchdog's first detector: serving failures while supposedly live,
    // with no re-registration between them. Failures during startup are the
    // backoff's business, not the watchdog's. The counter does not convict on
    // its own — it asks the probe to confirm, because cloudflared can print
    // one of these per edge connection over a single benign event.
    if (this.current.state === 'live' && EDGE_FAILURE_LINE.test(event.message)) {
      this.edgeFailures += 1
      if (this.edgeFailures >= EDGE_FAILURE_LIMIT) {
        this.edgeFailures = 0
        void this.verifyDead()
      }
    }
  }

  /* ------------------------------------------------------------ the watchdog */

  private clearProbe(): void {
    if (this.probeTimer !== null) {
      ;(this.host.clearTimer ?? clearTimeout)(this.probeTimer as NodeJS.Timeout)
      this.probeTimer = null
    }
  }

  private clearBirthProbe(): void {
    if (this.birthTimer !== null) {
      ;(this.host.clearTimer ?? clearTimeout)(this.birthTimer as NodeJS.Timeout)
      this.birthTimer = null
    }
  }

  private scheduleBirthProbe(): void {
    if (this.stopped || this.birthTimer !== null) return
    this.birthTimer = (this.host.setTimer ?? setTimeout)(() => {
      this.birthTimer = null
      void this.runBirthProbe()
    }, BIRTH_PROBE_INTERVAL_MS)
  }

  /**
   * The newborn check: the fresh address is dialled on a short clock until it
   * answers once, then this clock stops and the 2-minute probe carries on
   * alone. An address that never answers — with the internet demonstrably up —
   * is dead on arrival, and a minute of that is all it gets. The control probe
   * rules the same way it does for the scheduled one: an offline desktop
   * cannot convict anything, so the tries are not counted while it lasts.
   */
  private async runBirthProbe(): Promise<void> {
    if (this.stopped || this.current.state !== 'live' || !this.child) return
    const child = this.child
    const alive = await (this.host.probe ?? probeTunnelUrl)(this.current.url)
    if (this.staleSince(child)) return
    if (alive) {
      this.probeStrikes = 0
      this.edgeFailures = 0
      return
    }
    const online = await (this.host.probeControl ?? probeControlUrl)()
    if (this.staleSince(child)) return
    if (online) {
      this.birthProbes += 1
      if (this.birthProbes >= BIRTH_PROBE_LIMIT) {
        this.restartDead(`the new public address never answered (${this.birthProbes} probes since it was announced)`)
        return
      }
    }
    this.scheduleBirthProbe()
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      ;(this.host.clearTimer ?? clearTimeout)(this.killTimer as NodeJS.Timeout)
      this.killTimer = null
    }
  }

  private scheduleProbe(): void {
    if (this.stopped || this.probeTimer !== null) return
    this.probeTimer = (this.host.setTimer ?? setTimeout)(() => {
      this.probeTimer = null
      void this.runProbe()
    }, PROBE_INTERVAL_MS)
  }

  /**
   * True when the world moved during an await: a probe answered after the
   * child changed, the state changed or stop() ran proves nothing about the
   * current tunnel and must change nothing.
   */
  private staleSince(child: TunnelChild): boolean {
    return this.stopped || this.child !== child || this.current.state !== 'live'
  }

  /**
   * The second detector, on its 2-minute clock. A dead answer is confirmed
   * against the control probe first: when this desktop's own connection is
   * down, every fetch fails, and killing cloudflared then would trade a
   * hostname that survives a reconnect for a new one that cannot even be
   * published yet. A passing probe is ground truth the other way, and clears
   * the log counter's suspicions too.
   */
  private async runProbe(): Promise<void> {
    if (this.stopped || this.current.state !== 'live' || !this.child) return
    const child = this.child
    const alive = await (this.host.probe ?? probeTunnelUrl)(this.current.url)
    if (this.staleSince(child)) return
    if (alive) {
      this.probeStrikes = 0
      this.edgeFailures = 0
      this.scheduleProbe()
      return
    }
    const online = await (this.host.probeControl ?? probeControlUrl)()
    if (this.staleSince(child)) return
    if (!online) {
      this.probeStrikes = 0
      this.scheduleProbe()
      return
    }
    this.probeStrikes += 1
    if (this.probeStrikes >= PROBE_STRIKES) {
      this.restartDead(`the public address stopped answering (${this.probeStrikes} probes in a row)`)
      return
    }
    this.scheduleProbe()
  }

  /**
   * The log counter's confirmation step: an immediate out-of-schedule probe.
   * Edge failures with an address that still answers are grumbling, not
   * death; edge failures with a dead address and a working internet
   * connection are the incident, and one confirmed sighting is enough.
   */
  private async verifyDead(): Promise<void> {
    if (this.stopped || this.current.state !== 'live' || !this.child) return
    const child = this.child
    const alive = await (this.host.probe ?? probeTunnelUrl)(this.current.url)
    if (this.staleSince(child)) return
    if (alive) return
    const online = await (this.host.probeControl ?? probeControlUrl)()
    if (this.staleSince(child)) return
    if (!online) return
    this.restartDead('the edge connection kept failing and the public address stopped answering')
  }

  /**
   * The cure for a tunnel that died without its process dying: kill the
   * process and let the ordinary exit path respawn it. The quick tunnel comes
   * back on a fresh hostname and `onStatus` hands it on, which is what makes
   * the rendezvous record true again. The dead address is dropped *now*, not
   * at exit, so nothing republishes it in the meantime.
   *
   * The kill itself is watched: if the child has not exited KILL_ESCALATE_MS
   * later — taskkill refused, the process is stuck in a syscall — the exit is
   * synthesised. Without that, a kill that does not land leaves the
   * supervisor at `retrying` with no timer pending and both detectors
   * disarmed: wedged for good, which is the incident this watchdog exists to
   * end. A late real exit is harmless — onExit ignores a child that is no
   * longer the current one.
   */
  private restartDead(reason: string): void {
    if (this.stopped || !this.child) return
    this.lastError = reason
    this.edgeFailures = 0
    this.probeStrikes = 0
    this.clearProbe()
    this.clearBirthProbe()
    this.host.log?.(`cloudflared: ${reason} — restarting the tunnel for a fresh address`)
    this.report({ state: 'retrying', url: '', detail: 'The tunnel went dead — restarting cloudflared.' })
    const child = this.child
    if (child.pid) (this.host.killTree ?? killTreeWindows)(child.pid)
    else child.kill()
    this.killTimer = (this.host.setTimer ?? setTimeout)(() => {
      this.killTimer = null
      if (this.child !== child) return
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      this.onExit(child, null)
    }, KILL_ESCALATE_MS)
  }

  private onExit(child: TunnelChild, code: number | null): void {
    // A stale exit — the real one arriving after the watchdog synthesised it,
    // or a predecessor's after a restart — must not touch the current child.
    if (this.child !== child) return
    this.child = null
    this.clearKillTimer()
    // A probe armed for a tunnel that no longer exists proves nothing; the
    // next live banner arms a fresh one.
    this.clearProbe()
    this.clearBirthProbe()
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

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { stripAnsi } from '@shared/ansi'
import type { ForgeTvPhase, ForgeTvStatus } from '@shared/types'
import { TV_APK_NAME } from './mobile/server'

/**
 * Forge TV — building the Fire TV APK from the settings page.
 *
 * A television is the one device in the house with no cable, no file manager
 * and no browser worth the name: the only way to install an app on a Fire TV
 * Stick is to type a URL into its Downloader app with a remote control. So the
 * shape of this feature is fixed by the far end — press a button here, and the
 * APK appears at a fixed LAN URL the TV can be pointed at.
 *
 * The address is the reason it is a button rather than a one-off. The APK has
 * the desktop's LAN address baked into it (there is no tunnel on a TV: it is
 * three metres away on the same wifi), and a router hands out a new lease
 * whenever it feels like it. Rebuilding is how that gets corrected, so
 * rebuilding has to be as cheap as pressing a button.
 *
 * ## Why this is not `await`ed
 *
 * The build is Vite plus a full Gradle assemble — a minute and a half on this
 * machine, longer on a cold daemon-less run. `startTvBuild` returns as soon as
 * the child is spawned and every subsequent word arrives through
 * `onTvBuildChange`; an IPC handler that waited for it would hang the settings
 * page and, worse, look like a crash. Same shape as source-updater.ts: one
 * status object, broadcast on every change.
 *
 * ## What this file deliberately does not know
 *
 * The desktop's address. It builds whatever origin it is handed, because
 * working out which of this machine's IPv4 addresses a television can dial is
 * mobile-host's job — it already does it for pairing — and two answers to that
 * question is one too many. See `tvOrigin()` there.
 */

/** Long enough for a cold Gradle run, short enough that a wedged one ends. */
const BUILD_TIMEOUT_MS = 20 * 60 * 1000

/** A settings-page line, not a log: one sentence's worth. */
const MAX_DETAIL = 160

/** How much of the tail to keep, so a failure can name the line that broke. */
const TAIL_LINES = 15

let phase: ForgeTvPhase = 'idle'
let detail = ''
let child: ChildProcess | null = null
let timer: NodeJS.Timeout | null = null
let tail: string[] = []
let changed: (() => void) | null = null

/**
 * The checkout this Forge is running out of, or '' when there is not one.
 *
 * The same three candidates `mobileWebRoot()` tries, and for the same reason:
 * `app.getAppPath()` is the checkout root under a plain `electron .` but not
 * under electron-vite, where the main bundle lives in `out/main`. Guessing
 * wrong here would mean a button that reports "not supported" on a machine
 * that can build perfectly well.
 *
 * A packaged Forge has no checkout, no Android SDK and no JDK, so it answers
 * '' before looking — the panel then says so instead of offering a button whose
 * only possible outcome is an error.
 */
let cachedRoot: string | null = null
function repoRoot(): string {
  if (cachedRoot !== null) return cachedRoot
  if (app.isPackaged) {
    cachedRoot = ''
    return cachedRoot
  }
  for (const candidate of [app.getAppPath(), join(app.getAppPath(), '..'), process.cwd()]) {
    if (existsSync(join(candidate, 'scripts', 'apk-tv-build.mjs'))) {
      cachedRoot = candidate
      return cachedRoot
    }
  }
  cachedRoot = ''
  return cachedRoot
}

/**
 * Where the built APK is, whether or not it exists yet.
 *
 * Handed to the mobile server as a thunk rather than a string: a build finishes
 * while the server is running, and a path resolved once at start-up would go on
 * 404ing until the next restart.
 */
export function tvApkPath(): string {
  const root = repoRoot()
  return root ? join(root, 'dist-apk', TV_APK_NAME) : ''
}

/** Everything about the build except the address, which is mobile-host's. */
export function tvBuildState(): Omit<ForgeTvStatus, 'url'> {
  const apk = tvApkPath()
  // Read from disk rather than remembered, so an APK built in a previous run —
  // or deleted by hand — is reported honestly after a restart.
  const stats = apk && existsSync(apk) ? statSync(apk) : null
  return {
    supported: repoRoot() !== '',
    phase,
    detail,
    sizeBytes: stats ? stats.size : 0,
    builtAt: stats ? Math.round(stats.mtimeMs) : 0
  }
}

/** The one subscriber is mobile-host, which decorates and broadcasts. */
export function onTvBuildChange(cb: () => void): void {
  changed = cb
}

function report(nextPhase: ForgeTvPhase, nextDetail: string): void {
  phase = nextPhase
  detail = nextDetail
  changed?.()
}

/**
 * Refuse a build for a reason this file cannot work out for itself — today,
 * that the phone link is switched off, so there is no address to bake and
 * nothing for the television to download from. Stored rather than returned, so
 * the settings page sees the same sentence whether it read the answer or heard
 * the event.
 */
export function reportTvProblem(message: string): void {
  report('error', message)
}

/** Terminal noise into one legible line, or '' when there was nothing in it. */
function oneLine(raw: string): string {
  const clean = stripAnsi(raw).replace(/\s+/g, ' ').trim()
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean
}

/**
 * The line worth showing when a build fails.
 *
 * Gradle and Vite both end with pages of stack frames and a "problems report"
 * URL, and the last line is almost never the interesting one. Prefer the last
 * line that actually names a failure; fall back to the last line there was.
 */
function failingLine(): string {
  const named = [...tail].reverse().find((line) => /error|failure|failed|not recognized|cannot find/i.test(line))
  return named ?? tail[tail.length - 1] ?? 'The build failed without saying why.'
}

/**
 * Spawn the build. Returns immediately; watch `onTvBuildChange` for the rest.
 *
 * `origin` is the address that gets baked into the APK — `http://<lan>:<port>`
 * — and is also, with `/forge-tv.apk` on the end, the URL typed into the TV.
 * Handing the same string to both is what stops the app being built for one
 * address and downloaded from another.
 */
export function startTvBuild(origin: string): void {
  if (child) return

  const root = repoRoot()
  if (!root) {
    report('error', 'Forge TV can only be built from a Forge checkout — this build has no scripts folder.')
    return
  }

  tail = []
  report('building', 'Starting the build…')

  // `node` from PATH rather than this process: the script shells out to npx and
  // gradlew anyway, so a machine that cannot run it is a machine where this
  // feature was never going to work, and ENOENT below says exactly that.
  const proc = spawn('node', [join(root, 'scripts', 'apk-tv-build.mjs'), origin], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = proc

  let pending = ''
  const consume = (chunk: Buffer): void => {
    pending += chunk.toString('utf8')
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const shown = oneLine(line)
      if (!shown) continue
      tail.push(shown)
      if (tail.length > TAIL_LINES) tail.shift()
      // Only the current line is reported; the tail is kept for the epitaph.
      report('building', shown)
    }
  }
  proc.stdout?.on('data', consume)
  proc.stderr?.on('data', consume)

  // A spawn can end more than once — ENOENT raises `error` *and* `close`, and a
  // timeout kills a child that then closes on its own — so the ending is
  // settled exactly once. Without this the honest message ("node is not on the
  // PATH") would be overwritten a tick later by a generic one.
  let settled = false
  const settle = (nextPhase: ForgeTvPhase, nextDetail: string): void => {
    if (timer) clearTimeout(timer)
    timer = null
    child = null
    if (settled) return
    settled = true
    report(nextPhase, nextDetail)
  }

  timer = setTimeout(() => {
    // Killed, not left running: a wedged Gradle holds a lock that would make
    // the next attempt fail for a different and more confusing reason.
    settle('error', 'The build took more than 20 minutes and was stopped.')
    proc.kill()
  }, BUILD_TIMEOUT_MS)

  proc.on('error', (err) => {
    settle(
      'error',
      err.message.includes('ENOENT')
        ? 'Could not run Node — Forge TV builds need `node` on the PATH.'
        : `Could not start the build: ${err.message}`
    )
  })

  proc.on('close', (code) => {
    if (code === 0) settle('done', 'Built and ready to install.')
    else settle('error', failingLine())
  })
}

/** Kill a build in flight. Shutting down is not a reason to leave Gradle running. */
export function disposeTvBuild(): void {
  if (timer) clearTimeout(timer)
  timer = null
  child?.kill()
  child = null
  changed = null
}

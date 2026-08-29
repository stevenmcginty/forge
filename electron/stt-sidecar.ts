import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { SttErrorKind, SttMode, SttPhase, SttStartOptions, SttStatus } from '@shared/types'
import {
  AUTH_CONFIRM_MS,
  MAX_RAPID_RESTARTS,
  OFF_STATUS,
  RestartBudget,
  isStaleSidecarHelloError,
  isTransientSttError,
  pythonLooksMissing,
  reduceSttEvent,
  sttAuthLine,
  sttStatusEqual
} from './stt-protocol'
import { activeModelDir } from './stt-model'
import { getSettings } from './store'

/**
 * The dictation host: owns the STT sidecar and bridges its newline-JSON
 * protocol to the renderer.
 *
 * The sidecar is one of two things — the frozen `forge-stt.exe` we ship, or
 * stt/stt_service.py under a configured interpreter (see resolveLaunch). Both
 * speak the identical protocol, so everything below this point is the same
 * either way.
 *
 * Three things this file exists to get right:
 *
 *  - **Warm-start.** Loading Parakeet costs a few seconds and most of a gigabyte
 *    of RSS. By default we spawn shortly after the window is up, load the model
 *    and warm the ONNX session so the first real keypress just opens the mic.
 *    `sttWarmStart: false` restores the old lazy spawn for machines that never
 *    dictate.
 *
 *  - **Crashes.** A dead sidecar is restarted, but not forever — see
 *    RestartBudget in ./stt-protocol.
 *
 *  - **Degrading honestly.** A missing interpreter or an incomplete model is a
 *    *typed* error all the way to the UI, so the pill can offer to fix the path
 *    instead of just going dark.
 *
 * Plus one quiet rule: every sidecar launch mints a token, and the socket only
 * carries phrases and commands once the sidecar has seen it (see the handshake
 * in ./stt-protocol and stt_service.py). A sidecar too old to know the
 * handshake — a stale stt-dist — is tolerated with a warning rather than
 * breaking dictation.
 */

/** The sidecar binds its socket before printing the port — well inside this. */
const PORT_TIMEOUT_MS = 15_000
const CONNECT_RETRIES = 25
const CONNECT_RETRY_MS = 120
const RESTART_DELAY_MS = 400
const KILL_GRACE_MS = 800

type Json = Record<string, unknown>

let target: BrowserWindow | null = null
let child: ChildProcess | null = null
let sock: Socket | null = null
let port = 0

/**
 * Handshake token, freshly minted per sidecar launch. The sidecar refuses
 * every unproven socket while it is set, so no other local process that
 * stumbles on the port can read what is dictated or send commands.
 */
let authToken: string | null = null
/** True from hello until auth-ok / a refusal verdict / the window lapsing. */
let authPending = false
/** Set once a sidecar refused the handshake: every respawn goes tokenless. */
let authDisabled = false
/** One "predates the handshake" warning per sidecar launch, not per reconnect. */
let authWarned = false
let authTimer: NodeJS.Timeout | null = null

let status: SttStatus = { ...OFF_STATUS }
const budget = new RestartBudget()
/** A start() that arrived before the model was ready; fired on `ready`. */
let pendingStart = false
/**
 * A wake-mode capture() that arrived before the session was listening. Flushed
 * after the deferred start, so holding Right Ctrl during warmup still talks
 * to Jarvis instead of being eaten.
 */
let pendingCapture = false
let warmTimer: NodeJS.Timeout | null = null
/**
 * What the last start() asked for, so a start deferred until `ready` opens the
 * session the caller wanted rather than a plain one. Reset to `phrase` by every
 * start with no mode, which is what keeps dictation's behaviour untouched.
 */
let wantedMode: SttMode = 'phrase'
/**
 * Whether the last start() was a conversation (the agent) rather than
 * dictation. Read when the start is actually sent — including a start deferred
 * until the model is ready — and reset to false by any plain start, which is
 * what keeps the dictation hotkey's behaviour untouched.
 */
let wantedConversation = false
/** Set while we are deliberately tearing the sidecar down. */
let disposing = false
/** Set by disposeSttSidecar: the app is leaving, never respawn. */
let retired = false
let portTimer: NodeJS.Timeout | null = null
let stdoutBuf = ''
let lineBuf = ''

/* ------------------------------------------------------------------- wire */

export function setSttTarget(win: BrowserWindow | null): void {
  target = win
}

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

function patch(next: Partial<SttStatus>): void {
  const merged = { ...status, ...next }
  // Level moves 10x/s; everything else is rare. Suppressing no-op pushes keeps
  // an idle sidecar free for the renderer.
  if (sttStatusEqual(merged, status)) return
  status = merged
  send(IPC.sttStatusEvent, status)
}

function fail(kind: SttErrorKind, msg: string, phase: SttPhase = 'error'): void {
  console.error(`[stt] ${kind}: ${msg}`)
  patch({ phase, error: { kind, msg }, level: 0 })
}

/* -------------------------------------------------------------- discovery */

/**
 * Where stt_service.py lives. In dev the compiled main sits in `out/main`, so
 * the repo root is two levels up; a packaged build carries the folder as an
 * unpacked resource beside the app.
 */
function resolveScript(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'stt', 'stt_service.py'),
    join(app.getAppPath(), 'stt', 'stt_service.py'),
    join(app.getAppPath(), '..', 'stt', 'stt_service.py'),
    process.resourcesPath ? join(process.resourcesPath, 'stt', 'stt_service.py') : ''
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

/**
 * The frozen sidecar — stt/stt_service.py run through PyInstaller (see
 * scripts/build-stt.mjs), shipped as resources/stt-bin. Its whole point is that
 * a packaged Forge needs no Python on the target machine at all.
 */
function resolveFrozen(): string | null {
  const candidates = [
    // Packaged: extraResources puts the one-folder build here.
    process.resourcesPath ? join(process.resourcesPath, 'stt-bin', 'forge-stt.exe') : '',
    // Dev: whatever `node scripts/build-stt.mjs` last produced.
    join(__dirname, '..', '..', 'stt-dist', 'forge-stt', 'forge-stt.exe'),
    join(app.getAppPath(), 'stt-dist', 'forge-stt', 'forge-stt.exe')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

interface Launch {
  exe: string
  /** Everything before the sidecar's own flags. */
  lead: string[]
  frozen: boolean
}

/** The configured interpreter plus stt/stt_service.py, if both are usable. */
function resolveInterpreted(): Launch | null {
  const settings = getSettings()
  if (pythonLooksMissing(settings.sttPython, existsSync)) return null
  const script = resolveScript()
  if (!script) return null
  return { exe: settings.sttPython, lead: [script], frozen: false }
}

/**
 * How to start the sidecar.
 *
 * Packaged, the frozen exe wins: no interpreter needed, no version skew, and
 * the only thing a friend who has never installed Python is going to have. The
 * configured python + stt/stt_service.py is the fallback, for anyone whose own
 * venv is better than our freeze.
 *
 * In *development* the order flips, because `npm run dev` with a stale
 * stt-dist/ next door would otherwise silently run last week's frozen copy and
 * ignore every edit to stt_service.py. Set FORGE_STT_FROZEN=1 to test the
 * shipped path from a dev checkout.
 *
 * Returns null with the reason already reported when neither is available.
 */
function resolveLaunch(): Launch | null {
  const preferFrozen = app.isPackaged || process.env['FORGE_STT_FROZEN'] === '1'
  const frozen = resolveFrozen()

  if (preferFrozen && frozen) return { exe: frozen, lead: [], frozen: true }

  const interpreted = resolveInterpreted()
  if (interpreted) return interpreted
  if (frozen) return { exe: frozen, lead: [], frozen: true }

  // Neither route is open — say which one the user can do something about.
  const settings = getSettings()
  if (!resolveScript()) {
    fail('sidecar-missing', 'Neither the packaged speech engine nor stt_service.py could be found next to the app')
    return null
  }
  fail(
    'python-missing',
    settings.sttPython
      ? `No Python interpreter at ${settings.sttPython}`
      : 'Dictation needs either the packaged speech engine or a Python interpreter with onnx-asr installed'
  )
  return null
}

/* -------------------------------------------------------------- lifecycle */

function ensure(): void {
  if (child || disposing || retired) return

  const settings = getSettings()
  const launch = resolveLaunch()
  if (!launch) return

  const args = [
    ...launch.lead,
    // Empty is a legitimate answer — "nothing configured, nothing found" — and
    // the sidecar turns it into a clean model-missing rather than guessing.
    '--model-dir',
    activeModelDir(),
    '--auto-stop',
    String(settings.sttAutoStopSeconds)
  ]

  patch({ phase: 'starting', error: null, ready: false, level: 0 })
  stdoutBuf = ''
  lineBuf = ''
  port = 0
  authToken = authDisabled ? null : randomBytes(32).toString('hex')
  authPending = false
  authWarned = false
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }

  let proc: ChildProcess
  try {
    // The token rides the environment rather than argv: a command line is
    // readable by any local process listing commands, which is exactly the
    // audience it exists to keep out. A no-token spawn (the compat fallback)
    // simply inherits the parent environment.
    const authEnv = authToken
      ? { ...process.env, FORGE_STT_AUTH_TOKEN: authToken }
      : undefined
    proc = spawn(launch.exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(authEnv ? { env: authEnv } : {})
    })
  } catch (err) {
    fail(launch.frozen ? 'sidecar-missing' : 'python-missing', err instanceof Error ? err.message : String(err))
    return
  }
  child = proc

  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (proc !== child) return
    child = null
    if (err.code === 'ENOENT') {
      fail(
        launch.frozen ? 'sidecar-missing' : 'python-missing',
        `Could not launch ${launch.exe}`
      )
    } else fail('internal', err.message)
  })

  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    if (proc !== child || port) return
    stdoutBuf += chunk
    const m = /FORGE_STT_PORT=(\d+)/.exec(stdoutBuf)
    if (!m) return
    port = Number(m[1])
    if (portTimer) clearTimeout(portTimer)
    portTimer = null
    connect(proc, port, 0)
  })

  // The sidecar logs to stderr. Surface it in the dev terminal — a stalled
  // model load or a PortAudio complaint is exactly what you want to see there.
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) console.log(`[stt:py] ${line.trim()}`)
    }
  })

  proc.on('exit', (code, signal) => {
    if (proc !== child) return
    child = null
    dropSocket()
    if (portTimer) clearTimeout(portTimer)
    portTimer = null
    if (disposing || retired) {
      patch({ ...OFF_STATUS })
      return
    }
    console.error(`[stt] sidecar exited (code ${code}, signal ${signal ?? 'none'})`)
    onUnexpectedExit()
  })

  portTimer = setTimeout(() => {
    portTimer = null
    if (proc !== child || port) return
    fail('internal', 'The dictation sidecar never announced a port')
    proc.kill()
  }, PORT_TIMEOUT_MS)
}

function onUnexpectedExit(): void {
  if (budget.record()) {
    patch({ phase: 'starting', ready: false, level: 0 })
    setTimeout(() => {
      if (!disposing && !retired && !child) ensure()
    }, RESTART_DELAY_MS)
    return
  }
  pendingStart = false
  fail(
    'crash-loop',
    `The dictation sidecar crashed ${MAX_RAPID_RESTARTS + 1} times in a minute — giving up. Check the Python and model paths.`
  )
}

function connect(proc: ChildProcess, p: number, attempt: number): void {
  if (proc !== child || disposing || retired) return

  const s = createConnection({ host: '127.0.0.1', port: p })
  s.setNoDelay(true)
  s.setEncoding('utf8')

  s.on('connect', () => {
    if (proc !== child) {
      s.destroy()
      return
    }
    sock = s
    lineBuf = ''
    // The hello line goes out before anything else, so a token-checking
    // sidecar never sees so much as a `status` from an unproven socket.
    authPending = authToken !== null
    if (authToken) {
      try {
        s.write(sttAuthLine(authToken))
      } catch {
        /* the error/close handlers own a failed socket */
      }
      const attempt = s
      authTimer = setTimeout(() => {
        if (attempt !== sock) return
        // Neither a verdict nor the "unknown command" of a pre-handshake
        // sidecar. Carrying on is safe — the connection itself is ordinary —
        // but say so once instead of failing silently forever.
        authPending = false
        if (!authWarned) {
          authWarned = true
          console.warn(
            '[stt] the sidecar never confirmed the auth handshake — continuing without it; rebuild stt-dist with `node scripts/build-stt.mjs --force` if this keeps happening'
          )
        }
      }, AUTH_CONFIRM_MS)
    }
    write({ cmd: 'status' })
  })

  s.on('data', (chunk: string) => {
    if (s !== sock) return
    lineBuf += chunk
    let i: number
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i).trim()
      lineBuf = lineBuf.slice(i + 1)
      if (line) handleLine(line)
    }
  })

  const retry = (): void => {
    if (s === sock) sock = null
    if (proc !== child || disposing || retired) return
    // The socket is bound before the port is printed, so a refusal here is
    // transient. Keep trying briefly, then let the process die and take the
    // normal restart path.
    if (attempt < CONNECT_RETRIES) {
      setTimeout(() => connect(proc, p, attempt + 1), CONNECT_RETRY_MS)
    } else {
      fail('internal', 'Could not connect to the dictation sidecar')
      proc.kill()
    }
  }

  s.on('error', retry)
  s.on('close', () => {
    if (s !== sock) return
    sock = null
    // The process is still alive but hung up on us: reconnect rather than
    // restart, so a dropped socket never costs a model reload.
    if (proc === child && !disposing && !retired) {
      setTimeout(() => connect(proc, p, 0), CONNECT_RETRY_MS)
    }
  })
}

function dropSocket(): void {
  const s = sock
  sock = null
  authPending = false
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
  if (s) {
    s.removeAllListeners()
    s.destroy()
  }
}

function write(msg: Json): void {
  if (!sock || sock.destroyed) return
  try {
    sock.write(`${JSON.stringify(msg)}\n`)
  } catch (err) {
    console.error('[stt] write failed:', err)
  }
}

/**
 * The sidecar checked our token and said no — which cannot happen between the
 * process we spawned and the token we handed it unless the two halves of the
 * protocol have drifted (a stt-dist frozen from newer code than this file, or
 * a dev interpreter running something else on that port). Rather than loop on
 * refusals, drop auth for every respawn after this one: the token exists to
 * keep other local processes out, not to break dictation.
 */
function onAuthRejected(): void {
  console.error('[stt] the sidecar rejected the auth token — respawning it without auth')
  if (authDisabled) {
    kill()
    return
  }
  authDisabled = true
  reload(true)
}

/* ----------------------------------------------------------------- events */

function handleLine(line: string): void {
  let msg: Json
  try {
    msg = JSON.parse(line) as Json
  } catch {
    console.error(`[stt] unparseable line: ${line.slice(0, 120)}`)
    return
  }

  // Handshake bookkeeping, before anything is folded into the status: these
  // three are about the connection itself, not about dictation.
  if (msg['evt'] === 'auth-ok') {
    authPending = false
    if (authTimer) {
      clearTimeout(authTimer)
      authTimer = null
    }
    return
  }
  if (msg['evt'] === 'auth-rejected') {
    onAuthRejected()
    return
  }
  if (authPending && isStaleSidecarHelloError(msg)) {
    // A sidecar frozen before the handshake: it shrugged at the hello line
    // and kept talking. The socket works; only the token does not.
    authPending = false
    if (authTimer) {
      clearTimeout(authTimer)
      authTimer = null
    }
    if (!authWarned) {
      authWarned = true
      console.warn(
        '[stt] the dictation sidecar predates the auth handshake — dictation works, but any local process can still read it. Rebuild it with `node scripts/build-stt.mjs --force`.'
      )
    }
    return
  }

  const result = reduceSttEvent(status, msg)

  if (result.phrase) send(IPC.sttPhrase, { text: result.phrase })
  if (msg['evt'] === 'error') {
    console.error(`[stt] sidecar error (${String(msg['kind'])}): ${String(msg['msg'])}`)
    pendingStart = false
    pendingCapture = false
  }

  patch(result.status)

  if (result.becameReady) {
    // A successful load means whatever went wrong before is fixed; a crash next
    // week deserves its own three chances.
    budget.clear()
    if (pendingStart) {
      pendingStart = false
      sendStart()
    }
  }

  // Capture is flushed on listening, not only on ready: a warm sidecar that
  // just opened a wake session is already ready, and the PTT that arrived in
  // the same breath would otherwise sit queued forever.
  if (pendingCapture && status.phase === 'listening') {
    pendingCapture = false
    write({ cmd: 'capture' })
  }
}

/* ---------------------------------------------------------------- actions */

function startListening(options?: SttStartOptions): SttStatus {
  wantedMode = options?.mode === 'wake' ? 'wake' : 'phrase'
  wantedConversation = options?.conversation === true
  if (status.phase === 'error' && status.error && !isTransientSttError(status.error.kind)) {
    // A setup problem. Don't spawn again until the user fixes the path, which
    // routes through reload().
    return status
  }
  if (!child) {
    pendingStart = true
    ensure()
    return status
  }
  if (!status.ready) {
    pendingStart = true
    return status
  }
  sendStart()
  return status
}

/**
 * The silence timeout rides along with every start rather than only being an
 * argv flag: otherwise changing it in Settings would do nothing until the
 * sidecar happened to be respawned.
 *
 * `mode` is only ever *added*, never sent as `phrase`: an older sidecar has
 * never heard of it, and a start it does not recognise a key in is a start it
 * would otherwise refuse.
 */
function sendStart(): void {
  const msg: Json = { cmd: 'start', autoStop: getSettings().sttAutoStopSeconds }
  if (wantedMode === 'wake') msg['mode'] = 'wake'
  if (wantedConversation) msg['conversation'] = true
  write(msg)
}

function stopListening(): SttStatus {
  pendingStart = false
  pendingCapture = false
  wantedMode = 'phrase'
  wantedConversation = false
  if (child && status.ready) write({ cmd: 'stop' })
  return status
}

/**
 * Jump straight into capture inside an open wake session.
 *
 * If the sidecar is still loading, the capture is queued and fired the moment
 * the session is listening — holding the talk key during warmup must not be
 * a no-op. With no sidecar at all we still do not conjure a session; the
 * agent’s own start() is what opens one.
 */
function captureNow(): SttStatus {
  if (child && status.ready && status.phase === 'listening') {
    write({ cmd: 'capture' })
    return status
  }
  if (child) pendingCapture = true
  return status
}

/**
 * Wake mode: flush the current phrase and go back to monitoring, without
 * tearing the session down. Dictation’s PTT release uses stop(); Jarvis’s
 * uses this, so Right Ctrl does not kill an armed agent.
 */
function releaseCapture(): SttStatus {
  pendingCapture = false
  if (child && status.ready) write({ cmd: 'release' })
  return status
}

/**
 * How a corrected python/model path takes effect: drop the sidecar that is
 * holding the old ones.
 *
 * Only `force` (the setup card's "Retry") spawns a replacement right away.
 * Saving a path from the Settings popover must not conjure a 660 MB model load
 * out of an idle app — the next start() will pick the new paths up anyway.
 */
function reload(force: boolean): SttStatus {
  pendingStart = false
  pendingCapture = false
  budget.clear()
  const wasRunning = child !== null
  kill()
  patch({ ...OFF_STATUS })
  if (force || wasRunning) ensure()
  return status
}

function kill(): void {
  disposing = true
  if (portTimer) {
    clearTimeout(portTimer)
    portTimer = null
  }
  if (sock && !sock.destroyed) write({ cmd: 'shutdown' })
  dropSocket()
  const proc = child
  child = null
  if (proc) {
    // It leaves on `shutdown`, or when its stdin pipe closes with us. SIGTERM is
    // the third belt.
    try {
      proc.stdin?.end()
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill()
    }, KILL_GRACE_MS)
    proc.once('exit', () => clearTimeout(timer))
  }
  disposing = false
}

/* -------------------------------------------------------------------- ipc */

/**
 * Spawn the sidecar and load the model without opening the microphone.
 * Idempotent: a sidecar that is already up, or a process we are tearing
 * down, is left alone.
 */
export function warmStart(): SttStatus {
  if (retired || disposing || child) return status
  ensure()
  return status
}

/**
 * Warm-start after the window has painted, so the 660 MB map does not fight
 * the first frame. No-ops when the setting is off.
 */
export function scheduleWarmStart(delayMs = 400): void {
  if (warmTimer) clearTimeout(warmTimer)
  warmTimer = setTimeout(() => {
    warmTimer = null
    if (retired || disposing) return
    if (!getSettings().sttWarmStart) return
    warmStart()
  }, delayMs)
}

export function registerSttHandlers(): void {
  ipcMain.handle(IPC.sttStart, (_e, options?: SttStartOptions) => startListening(options))
  ipcMain.handle(IPC.sttStop, () => stopListening())
  ipcMain.handle(IPC.sttCapture, () => captureNow())
  ipcMain.handle(IPC.sttRelease, () => releaseCapture())
  ipcMain.handle(IPC.sttWarm, () => warmStart())
  ipcMain.handle(IPC.sttReload, (_e, force: boolean) => reload(force === true))
  ipcMain.handle(IPC.sttStatus, () => status)
}

export function disposeSttSidecar(): void {
  pendingStart = false
  pendingCapture = false
  if (warmTimer) {
    clearTimeout(warmTimer)
    warmTimer = null
  }
  kill()
  retired = true
  status = { ...OFF_STATUS }
}

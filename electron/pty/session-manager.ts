import { existsSync, statSync } from 'node:fs'
import * as pty from '@lydell/node-pty'

/**
 * PtySessionManager — the only place in Forge that talks to node-pty.
 *
 * Deliberately free of any Electron import so it can be exercised head-less
 * (see `scripts/pty-smoke.mjs`, which drives this exact class).
 *
 * Design notes
 *  - Every session is a real `pwsh.exe`. Agent profiles are *not* spawned
 *    directly: we spawn the shell, wait for its prompt, then WRITE the command
 *    (`claude\r`). When the agent exits, the shell — and the scrollback — is
 *    still there.
 *  - Sessions are capped (16 by default) because each ConPTY costs a real
 *    console host process.
 */

export interface SessionSpec {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Extra environment for this pane only (for example a profile's API key). */
  env?: Record<string, string>
  /** Written into the shell once it looks ready. Empty/undefined = nothing. */
  bootstrapCommand?: string
  /**
   * Painted into the pane at bootstrap time *instead of* running anything.
   *
   * For the one case where the honest thing to do is nothing: the command a
   * profile launches is not installed. Typing it would print the shell's
   * "not recognized" splat, which reads as Forge being broken; this says what
   * is actually wrong. It is written to the pane, never to the shell — see
   * runBootstrap.
   */
  bootstrapNotice?: string
}

export interface ManagerOptions {
  /** Shell executable. Defaults to `pwsh.exe`. */
  shell?: string
  /** Extra args. Defaults to `['-NoLogo']`. */
  shellArgs?: string[]
  /**
   * Variables added to every session's environment, after the denylist has run
   * and therefore able to set a name that would otherwise be stripped. Forge
   * uses it for `CLAUDE_CLIENT_PRESENCE_FILE` (see electron/presence.ts).
   */
  env?: Record<string, string>
  maxSessions?: number
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number, signal?: number) => void
  /**
   * A session's grid actually changed — after clamping, and never for a resize
   * that asked for the size it already had.
   *
   * Optional, because most consumers of this class only care about bytes. The
   * one that needs it is Forge Web: a browser is a second viewer of a grid it
   * does not own, so it has to be told when the desk moves one. See the
   * `onResize` sink in electron/web-host.ts.
   */
  onResize?: (id: string, cols: number, rows: number) => void
}

export interface SessionInfo {
  id: string
  pid: number
  cwd: string
  cols: number
  rows: number
  bootstrapCommand: string
  /** Shown in the pane in place of the command, when there is nothing to run. */
  bootstrapNotice: string
  bootstrapped: boolean
  startedAt: number
}

interface Session {
  info: SessionInfo
  proc: pty.IPty
  /** Timer that fires the bootstrap write once the prompt has settled. */
  bootstrapTimer?: NodeJS.Timeout
  bootstrapDeadline?: NodeJS.Timeout
  /**
   * A size wish that arrived while the agent command was still being typed.
   * Applied a quiet beat after the command is written — see `resize`.
   */
  pendingResize?: { cols: number; rows: number }
  /** Fires the deferred resize so a pane is never stuck at spawn size. */
  pendingResizeTimer?: NodeJS.Timeout
  disposed: boolean
}

export type CreateResult = { ok: true; id: string; pid: number } | { ok: false; id: string; error: string }

/** Quiet period after the last output chunk before we type the agent command. */
const BOOTSTRAP_QUIET_MS = 260
/** Type the command regardless after this long — never leave a pane empty. */
const BOOTSTRAP_MAX_WAIT_MS = 4000

export class PtySessionManager {
  private sessions = new Map<string, Session>()
  private readonly shell: string
  private readonly shellArgs: string[]
  private readonly extraEnv: Record<string, string>
  private readonly maxSessions: number
  private readonly onData: ManagerOptions['onData']
  private readonly onExit: ManagerOptions['onExit']
  private readonly onResize: ManagerOptions['onResize']

  constructor(options: ManagerOptions) {
    this.shell = options.shell || 'pwsh.exe'
    this.shellArgs = options.shellArgs ?? ['-NoLogo']
    this.extraEnv = options.env ?? {}
    this.maxSessions = options.maxSessions ?? 16
    this.onData = options.onData
    this.onExit = options.onExit
    this.onResize = options.onResize
  }

  get count(): number {
    return this.sessions.size
  }

  get limit(): number {
    return this.maxSessions
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  list(): SessionInfo[] {
    // Read the pid live: on Windows ConPTY only reports the shell's real pid
    // once the console host has connected, so it is 0 right after spawn.
    return [...this.sessions.values()].map((s) => ({ ...s.info, pid: s.proc.pid }))
  }

  pidOf(id: string): number {
    const s = this.sessions.get(id)
    return s ? s.proc.pid : 0
  }

  create(spec: SessionSpec): CreateResult {
    if (!spec.id) return { ok: false, id: spec.id, error: 'Missing session id' }
    if (this.sessions.has(spec.id)) {
      const existing = this.sessions.get(spec.id)!
      return { ok: true, id: spec.id, pid: existing.info.pid }
    }
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, id: spec.id, error: `Session limit reached (${this.maxSessions})` }
    }

    const cwd = resolveCwd(spec.cwd)
    if (!cwd) return { ok: false, id: spec.id, error: `Folder not found: ${spec.cwd}` }

    const cols = clampDim(spec.cols, 80)
    const rows = clampDim(spec.rows, 24)

    let proc: pty.IPty
    try {
      proc = pty.spawn(this.shell, this.shellArgs, {
        name: 'xterm-256color',
        cwd,
        cols,
        rows,
        // The conpty.dll shipped inside the node-pty package (from the Windows
        // Terminal project), not the OS-inbox one. The inbox ConPTY's resize
        // reflow is lossy — it re-emits the buffer with duplicated and
        // overlapped fragments, which is where "jumbled after a resize" comes
        // from. The bundled DLL reflows faithfully. It is loaded by path from
        // the package directory, which electron-builder already asar-unpacks.
        useConptyDll: true,
        env: buildEnv({ ...this.extraEnv, ...(spec.env ?? {}) })
      })
    } catch (err) {
      return { ok: false, id: spec.id, error: describe(err) }
    }

    const session: Session = {
      proc,
      disposed: false,
      info: {
        id: spec.id,
        pid: proc.pid,
        cwd,
        cols,
        rows,
        bootstrapCommand: spec.bootstrapCommand?.trim() ?? '',
        // Not trimmed: it is pre-formatted terminal output, leading blank line
        // and all.
        bootstrapNotice: spec.bootstrapNotice ?? '',
        bootstrapped: false,
        startedAt: Date.now()
      }
    }
    this.sessions.set(spec.id, session)

    proc.onData((data) => {
      if (session.disposed) return
      if (session.info.pid === 0) session.info.pid = proc.pid
      this.onData(spec.id, data)
      this.nudgeBootstrap(session)
    })

    proc.onExit(({ exitCode, signal }) => {
      this.clearBootstrapTimers(session)
      session.disposed = true
      this.sessions.delete(spec.id)
      this.onExit(spec.id, exitCode ?? 0, signal)
    })

    if (session.info.bootstrapCommand || session.info.bootstrapNotice) {
      // Hard deadline: even if the shell never emits (odd profiles, slow disk)
      // we still start the agent.
      session.bootstrapDeadline = setTimeout(() => this.runBootstrap(session), BOOTSTRAP_MAX_WAIT_MS)
      this.nudgeBootstrap(session)
    }

    return { ok: true, id: spec.id, pid: proc.pid }
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return false
    try {
      s.proc.write(data)
      return true
    } catch (err) {
      console.error(`[pty] write to ${id} failed:`, describe(err))
      return false
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return false
    const c = clampDim(cols, s.info.cols)
    const r = clampDim(rows, s.info.rows)
    if (c === s.info.cols && r === s.info.rows) {
      s.pendingResize = undefined
      return true
    }
    // A browser or phone attaching to a brand-new pane fits the PTY to its own
    // box in the same beat the shell is still coming up. ConPTY reflow during
    // that write is how the first character of the bootstrap command disappears
    // — `grok` becomes `rok`, and PowerShell's "not recognized" is the pane.
    // Hold the wish until the command has been typed; then apply it.
    if (!s.info.bootstrapped && (s.info.bootstrapCommand || s.info.bootstrapNotice)) {
      s.pendingResize = { cols: c, rows: r }
      return true
    }
    return this.applyResize(s, c, r)
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    this.clearBootstrapTimers(s)
    s.disposed = true
    this.sessions.delete(id)
    try {
      s.proc.kill()
    } catch (err) {
      console.error(`[pty] kill of ${id} failed:`, describe(err))
    }
    return true
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /* ------------------------------------------------------------- bootstrap */

  private nudgeBootstrap(session: Session): void {
    if (session.info.bootstrapped) return
    if (!session.info.bootstrapCommand && !session.info.bootstrapNotice) return
    if (session.bootstrapTimer) clearTimeout(session.bootstrapTimer)
    session.bootstrapTimer = setTimeout(() => this.runBootstrap(session), BOOTSTRAP_QUIET_MS)
  }

  private runBootstrap(session: Session): void {
    if (session.info.bootstrapped || session.disposed) return
    session.info.bootstrapped = true
    this.clearBootstrapTimers(session)
    try {
      if (session.info.bootstrapNotice) {
        // Painted into the pane, not typed into the shell: the whole point is
        // that nothing ran, so running something to say so would be a lie — and
        // would put a command nobody chose in the shell's history.
        this.onData(session.info.id, session.info.bootstrapNotice)
        // The notice landed where the prompt already was. An empty line brings
        // a fresh prompt back underneath it, ready to type in.
        session.proc.write('\r')
      } else {
        session.proc.write(`${session.info.bootstrapCommand}\r`)
      }
    } catch (err) {
      console.error(`[pty] bootstrap of ${session.info.id} failed:`, describe(err))
    }
    // Do not resize in this same turn. ConPTY reflow during the write is how
    // the first character of the command disappears (`grok` → `rok`, and the
    // same swallow on every other agent). The wish waits a quiet beat so the
    // shell has the line before the grid moves.
    if (session.pendingResize) {
      session.pendingResizeTimer = setTimeout(() => this.flushPendingResize(session), BOOTSTRAP_QUIET_MS)
    }
  }

  private flushPendingResize(session: Session): void {
    if (session.pendingResizeTimer) {
      clearTimeout(session.pendingResizeTimer)
      session.pendingResizeTimer = undefined
    }
    const next = session.pendingResize
    session.pendingResize = undefined
    if (!next || session.disposed) return
    this.applyResize(session, next.cols, next.rows)
  }

  private applyResize(session: Session, cols: number, rows: number): boolean {
    if (cols === session.info.cols && rows === session.info.rows) return true
    try {
      session.proc.resize(cols, rows)
      session.info.cols = cols
      session.info.rows = rows
      // After the ConPTY and after the record, so what a listener reads back
      // off `list()` is the size that actually took. Announced here rather than
      // at the call sites because there are four of them — the renderer, a
      // re-adoption, a phone and a browser — and a fifth would forget.
      this.onResize?.(session.info.id, cols, rows)
      return true
    } catch (err) {
      console.error(`[pty] resize of ${session.info.id} failed:`, describe(err))
      return false
    }
  }

  private clearBootstrapTimers(session: Session): void {
    if (session.bootstrapTimer) clearTimeout(session.bootstrapTimer)
    if (session.bootstrapDeadline) clearTimeout(session.bootstrapDeadline)
    if (session.pendingResizeTimer) clearTimeout(session.pendingResizeTimer)
    session.bootstrapTimer = undefined
    session.bootstrapDeadline = undefined
    session.pendingResizeTimer = undefined
  }
}

/* ----------------------------------------------------------------- helpers */

function clampDim(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.floor(n)))
}

function resolveCwd(cwd: string): string | null {
  if (!cwd) return null
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Names never passed down to a pane, whatever the parent process has set.
 *
 * Three groups, one rule — a pane is a *fresh* top-level agent session, not a
 * continuation of whatever launched Forge:
 *
 *  1. Claude session markers. Claude Code sets these on its own children to say
 *     "you are running inside an agent session". They are correct for the
 *     process Claude spawned and wrong for everything that process goes on to
 *     launch: start Forge from a Claude pane and every terminal in it inherits
 *     them, so a fresh `claude` in a Forge pane believes it is a child of a
 *     session that is nothing to do with it and turns transcript saving off
 *     ("⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
 *     marker").
 *
 *  2. Remote Control killers. `--remote-control` needs feature-flag evaluation
 *     and a claude.ai OAuth login talking to api.anthropic.com; each of these
 *     silently removes one of those, and Steve has DO_NOT_TRACK and friends set
 *     globally. Inheriting them would make the phone feature simply not appear,
 *     with no error to explain why. (Mirrors REMOTE_CONTROL_KILLERS in
 *     shared/remote.ts — duplicated rather than imported because this module is
 *     bundled stand-alone by scripts/pty-smoke.mjs.)
 *
 *     This group includes the authentication variables, which is a deliberate
 *     call and the one thing here a user could miss: **a Forge pane always
 *     authenticates with the claude.ai login**, never with an inherited API key
 *     or gateway URL. That is what Remote Control requires. A pane that needs a
 *     key should set it inside the pane, or via a wrapper the profile's command
 *     points at. See docs/REMOTE.md.
 *
 *  3. Electron's own injections, which confuse child Node processes — notably
 *     ELECTRON_RUN_AS_NODE, which would make `claude` boot as a bare script.
 */
export const ENV_DENYLIST: readonly string[] = [
  // 1. Claude session markers
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  // 2. Remote Control killers
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  // 3. Electron / Node injections
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_IS_DEV',
  'ELECTRON_ENABLE_LOGGING',
  // 4. This Forge's own identity.
  //
  // A pane is a place to work on Forge, so `npm run dev` and `Start Forge.cmd`
  // get run from inside one constantly — and every one of those is a *different*
  // Forge that must choose its own profile and its own binary. Inheriting these
  // hands it this one's.
  //
  // FORGE_DATA_DIR is the worse of the two, because it fails silently: the
  // second Forge adopts this one's data root, finds it already locked, focuses
  // this window and exits. Nothing opens, nothing is logged where anyone looks,
  // and the app appears to be broken. ELECTRON_EXEC_PATH is the same mistake
  // one level down — electron-vite prefers it over the checkout's own Electron,
  // so a pane-launched dev run boots the wrong binary and fails outright if that
  // checkout has moved.
  'FORGE_DATA_DIR',
  'FORGE_CHANNEL',
  'ELECTRON_EXEC_PATH'
]

const DENIED = new Set(ENV_DENYLIST)

/**
 * The environment every pane is spawned with: the parent's, minus everything on
 * ENV_DENYLIST, plus the usual terminal hints and whatever the caller adds.
 */
function buildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (DENIED.has(k)) continue
    // Forge is a truecolor terminal, so an inherited NO_COLOR is simply wrong
    // here — and Steve's is set globally, which was quietly draining the colour
    // out of every pane.
    if (k === 'NO_COLOR') continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORGE_TERMINAL = '1'
  // TUIs that cannot query the terminal for its background (Claude Code among
  // them) fall back to COLORFGBG, and without it they assume a light theme and
  // paint themselves white. 15;0 = light ink on a dark ground.
  if (!env.COLORFGBG) env.COLORFGBG = '15;0'
  if (!env.TERM_PROGRAM) env.TERM_PROGRAM = 'Forge'
  // Last, so a caller can deliberately set a name the denylist would have
  // stripped — and so an empty value means "leave it unset" rather than "".
  for (const [k, v] of Object.entries(extra)) {
    if (v) env[k] = v
  }
  return env
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

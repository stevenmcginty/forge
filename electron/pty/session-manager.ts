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
  /** Written into the shell once it looks ready. Empty/undefined = nothing. */
  bootstrapCommand?: string
}

export interface ManagerOptions {
  /** Shell executable. Defaults to `pwsh.exe`. */
  shell?: string
  /** Extra args. Defaults to `['-NoLogo']`. */
  shellArgs?: string[]
  maxSessions?: number
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number, signal?: number) => void
}

export interface SessionInfo {
  id: string
  pid: number
  cwd: string
  cols: number
  rows: number
  bootstrapCommand: string
  bootstrapped: boolean
  startedAt: number
}

interface Session {
  info: SessionInfo
  proc: pty.IPty
  /** Timer that fires the bootstrap write once the prompt has settled. */
  bootstrapTimer?: NodeJS.Timeout
  bootstrapDeadline?: NodeJS.Timeout
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
  private readonly maxSessions: number
  private readonly onData: ManagerOptions['onData']
  private readonly onExit: ManagerOptions['onExit']

  constructor(options: ManagerOptions) {
    this.shell = options.shell || 'pwsh.exe'
    this.shellArgs = options.shellArgs ?? ['-NoLogo']
    this.maxSessions = options.maxSessions ?? 16
    this.onData = options.onData
    this.onExit = options.onExit
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
        env: buildEnv()
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

    if (session.info.bootstrapCommand) {
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
    if (c === s.info.cols && r === s.info.rows) return true
    try {
      s.proc.resize(c, r)
      s.info.cols = c
      s.info.rows = r
      return true
    } catch (err) {
      console.error(`[pty] resize of ${id} failed:`, describe(err))
      return false
    }
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
    if (session.info.bootstrapped || !session.info.bootstrapCommand) return
    if (session.bootstrapTimer) clearTimeout(session.bootstrapTimer)
    session.bootstrapTimer = setTimeout(() => this.runBootstrap(session), BOOTSTRAP_QUIET_MS)
  }

  private runBootstrap(session: Session): void {
    if (session.info.bootstrapped || session.disposed) return
    session.info.bootstrapped = true
    this.clearBootstrapTimers(session)
    try {
      session.proc.write(`${session.info.bootstrapCommand}\r`)
    } catch (err) {
      console.error(`[pty] bootstrap of ${session.info.id} failed:`, describe(err))
    }
  }

  private clearBootstrapTimers(session: Session): void {
    if (session.bootstrapTimer) clearTimeout(session.bootstrapTimer)
    if (session.bootstrapDeadline) clearTimeout(session.bootstrapDeadline)
    session.bootstrapTimer = undefined
    session.bootstrapDeadline = undefined
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
 * Markers Claude Code sets on its own child processes to say "you are running
 * inside an agent session".
 *
 * They are correct for the process Claude spawned — and wrong for everything
 * that process goes on to launch. Start Forge from a Claude pane and every
 * terminal in it inherits them, so a fresh `claude` in one of Forge's panes
 * believes it is a child of a session that is nothing to do with it and turns
 * transcript saving off: "⚠ Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker".
 *
 * A pane is a new top-level shell, not a continuation of whatever launched
 * Forge, so the markers are dropped. Only these four, by name: authentication
 * (`CLAUDE_CODE_OAUTH_TOKEN` and friends) and any deliberate configuration the
 * user exported are left exactly as they are.
 */
const CLAUDE_SESSION_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT'
]

/**
 * Electron injects variables that confuse child Node processes (notably
 * ELECTRON_RUN_AS_NODE, which would make `claude` boot as a bare Node script).
 * Strip them and add the usual terminal hints.
 */
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE|IS_DEV|ENABLE_LOGGING)$/.test(k)) continue
    if (k === 'NODE_OPTIONS') continue
    if (CLAUDE_SESSION_MARKERS.includes(k)) continue
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
  return env
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

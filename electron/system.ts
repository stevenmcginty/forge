import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ClaudeCliState } from '@shared/types'
import { whichCommand } from './agent-probe'
import { hasTranscript, transcriptPath } from './bridge/claude-transcripts'

/**
 * Read-only probes of the machine, for the Settings page's Account section.
 *
 * Everything here answers a question the connected-accounts list asks — is the
 * Claude CLI actually on this PATH, what is this Windows account called.
 * Nothing installs, signs in, writes or phones home; the honest "not found" is
 * the whole point, because a chip that says "connected" without checking is
 * worse than no chip. (Reading a key off disk is next door, in voice-bridge's
 * `importKey`, which already knew how.)
 */

/** `claude --version` is fast, but a broken shim can hang. */
const PROBE_TIMEOUT_MS = 6000

export function windowsUserName(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/**
 * Run `claude --version`.
 *
 * Whether `claude` exists at all is not decided here: agent-probe.ts already
 * walks PATH for exactly that, and it is what the first-run welcome shows. Two
 * implementations of "is it installed" is two answers, and the one time they
 * disagreed the welcome said "installed" while Settings said "not found". So
 * this asks the probe first and only spawns a process to learn the *version*.
 *
 * It also spawns the exact file the probe found, rather than the name `claude`
 * through a shell. On Windows the CLI is usually a `.cmd` shim that
 * CreateProcess will not run directly, which used to mean `shell: true` — and
 * `shell: true` alongside an argument list is what Node warns about in DEP0190,
 * because the arguments go back through a command line to be re-parsed. Handing
 * cmd.exe the shim as an argv entry gets the shim run without ever building a
 * command string. On anything else the resolved path is executable as it is.
 */
export function claudeVersion(): Promise<ClaudeCliState> {
  const exe = whichCommand('claude')
  if (!exe) return Promise.resolve({ ok: false, error: 'not found on PATH' })

  // .cmd and .bat are scripts for the command interpreter, not images the OS
  // can load; everything else — claude.exe, or a real binary on macOS/Linux —
  // runs on its own.
  const viaCmd = /\.(cmd|bat)$/i.test(exe)
  const file = viaCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : exe
  const args = viaCmd ? ['/d', '/s', '/c', exe, '--version'] : ['--version']

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return resolve({ ok: false, error: 'not found on PATH' })
          const detail = (stderr || (err as Error).message || '').trim().split('\n')[0] ?? 'could not run'
          return resolve({ ok: false, error: detail.slice(0, 140) })
        }
        const text = `${stdout}`.trim().split('\n')[0]?.trim() ?? ''
        // `claude --version` prints e.g. "2.0.14 (Claude Code)".
        const version = /([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/.exec(text)?.[1] ?? text
        resolve(version ? { ok: true, version } : { ok: false, error: 'no version reported' })
      }
    )
  })
}

export function registerSystemHandlers(): void {
  ipcMain.handle(IPC.systemUserName, () => windowsUserName())
  ipcMain.handle(IPC.systemClaudeVersion, () => claudeVersion())
  // Both parts answered together: the renderer that is about to point one
  // agent at another's conversation needs the path AND whether it is real,
  // and asking twice would just be two chances for the answers to disagree.
  ipcMain.handle(IPC.claudeTranscript, (_e, cwd: string, sessionId: string) => ({
    path: transcriptPath(String(cwd), String(sessionId)),
    exists: hasTranscript(String(cwd), String(sessionId))
  }))
}

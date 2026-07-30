import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ClaudeCliState } from '@shared/types'

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
 * Run `claude --version`. On Windows the executable is usually a `.cmd` shim,
 * which CreateProcess will not run directly — hence `shell: true`, with a fixed
 * argument list that nothing user-supplied ever reaches.
 */
export function claudeVersion(): Promise<ClaudeCliState> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['--version'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
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
}

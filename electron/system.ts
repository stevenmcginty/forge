import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ClaudeCliState, ImportedKeyResult } from '@shared/types'

/**
 * Read-only probes of the machine, for the Settings page's Account section.
 *
 * Everything here answers a question the connected-accounts list asks — is the
 * Claude CLI actually on this PATH, what is this Windows account called, is
 * there an OpenRouter key sitting in the file `kimi` already uses. Nothing
 * installs, signs in, writes or phones home; the honest "not found" is the
 * whole point, because a chip that says "connected" without checking is worse
 * than no chip.
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

/**
 * Steve's OpenRouter key already lives in ~/.kimi-key, because that is where
 * the `kimi` launcher reads it from. Offer to reuse it rather than making him
 * find it again. Read-only, exactly like the Gemini import.
 */
export function importOpenRouterKey(): ImportedKeyResult {
  const candidates = [join(homedir(), '.kimi-key'), join(homedir(), '.openrouter-key')]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const key = readFileSync(path, 'utf8').trim()
      if (!key) return { ok: false, error: `${path} is empty` }
      if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(key)) {
        return { ok: false, error: `${path} does not look like an API key` }
      }
      return { ok: true, key, last4: key.slice(-4), source: path }
    } catch (err) {
      return { ok: false, error: `Could not read ${path}: ${(err as Error).message}` }
    }
  }
  return { ok: false, error: `No key file found (looked in ${candidates[0]})` }
}

export function registerSystemHandlers(): void {
  ipcMain.handle(IPC.systemUserName, () => windowsUserName())
  ipcMain.handle(IPC.systemClaudeVersion, () => claudeVersion())
  ipcMain.handle(IPC.systemImportOpenRouterKey, () => importOpenRouterKey())
}

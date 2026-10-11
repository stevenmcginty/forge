import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The updater's log — `<userData>\logs\updater.log`, shared with the apply
 * helper (scripts/apply-update.ps1), which appends to the same file.
 *
 * A packaged Forge has no console: `console.error` goes nowhere, so before this
 * file an update that failed left no trace at all. Every line is
 *
 *   2026-10-11T12:34:56.789Z [main] message
 *
 * appended as UTF-8 without a BOM (the helper writes `[helper]`). Main rotates
 * it once at startup when it passes 1 MB; the helper never rotates.
 *
 * Synchronous on purpose: the volume is a few lines a minute at most, and the
 * lines that matter most are written just before Forge quits.
 */

const ROTATE_AT_BYTES = 1024 * 1024

export function updateLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'updater.log')
}

/** At startup: over 1 MB → updater.old.log (replacing the previous old one). */
export function rotateUpdateLog(): void {
  try {
    const path = updateLogPath()
    if (!existsSync(path) || statSync(path).size <= ROTATE_AT_BYTES) return
    const old = join(dirname(path), 'updater.old.log')
    rmSync(old, { force: true })
    renameSync(path, old)
  } catch {
    // A log that cannot rotate keeps growing; that is not worth failing over.
  }
}

/** One line per message; a multi-line message (a stack) is folded onto it. */
export function logUpdate(message: string): void {
  try {
    const path = updateLogPath()
    mkdirSync(dirname(path), { recursive: true })
    const text = String(message).replace(/\r?\n+/g, ' | ').trim()
    appendFileSync(path, `${new Date().toISOString()} [main] ${text}\n`, 'utf8')
  } catch {
    // Logging must never be the thing that breaks an update.
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * electron-updater's logger, pointed at the file. Debug is dropped: it is the
 * per-chunk download chatter, and info/warn/error already say what happened.
 */
export const updaterLogger = {
  info: (message?: unknown): void => logUpdate(`electron-updater: ${describe(message)}`),
  warn: (message?: unknown): void => logUpdate(`electron-updater WARN: ${describe(message)}`),
  error: (message?: unknown): void => logUpdate(`electron-updater ERROR: ${describe(message)}`)
}

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { CommandPresence } from '@shared/types'

/**
 * "Is this command actually on the machine?" — the whole of it, and nothing
 * else.
 *
 * Deliberately free of any Electron import so it can be exercised head-less
 * (see `scripts/agents-check.mjs`) and imported from anywhere in main. Three
 * callers depend on it now: the first-run welcome's agent probe, the Agents
 * settings and the chooser, and the pane itself — which uses it to decide
 * whether typing the command would only produce `'codex' is not recognized`.
 *
 * Resolved by walking PATH ourselves rather than shelling out to `where`:
 * spawning a process to answer a question about the filesystem is wasteful, and
 * `where` behaves differently under a non-interactive shell. PATHEXT is
 * honoured, which is what finds `claude.cmd` (npm shims are batch files on
 * Windows, not .exe).
 */

function pathExtensions(): string[] {
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD'
  const list = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  // An empty entry stands for "the name exactly as written", which is how a
  // bare executable is found on the platforms that have them.
  return ['', ...list]
}

function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path of `command` on PATH, or null. */
export function whichCommand(command: string): string | null {
  const exe = command.trim().split(/\s+/)[0]
  if (!exe) return null

  if (isAbsolute(exe) || exe.includes('/') || exe.includes('\\')) {
    return existsSync(exe) && isRunnable(exe) ? exe : null
  }

  const exts = extname(exe) ? ['', ...pathExtensions()] : pathExtensions()
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    // PATH entries are frequently quoted on Windows, and just as frequently
    // stale — a missing folder is not an error, it is Tuesday.
    const clean = dir.replace(/^"|"$/g, '')
    if (!clean) continue
    for (const ext of exts) {
      const candidate = join(clean, exe + ext)
      if (isRunnable(candidate)) return candidate
    }
  }
  return null
}

/**
 * The program a command line launches, when that is a question PATH can answer.
 *
 * Null for anything that would need a shell to work out: a quoted path with
 * spaces, an environment variable, a pipeline, `conda activate x; claude`. Those
 * profiles may well work perfectly, and a confident "not installed" about one is
 * worse than saying nothing — so every caller treats null as "no answer" rather
 * than as "missing".
 */
export function checkableExe(command: string): string | null {
  const line = command.trim()
  if (!line) return null
  // More than one statement on the line, so the first word is not the whole
  // story: in `conda activate x; claude`, claude runs whether or not conda
  // exists, and suppressing the line because conda is missing would break a
  // profile that works. `&` is both the separator and PowerShell's call
  // operator, and both are reasons to stop.
  if (/[;|&\n\r]/.test(line)) return null
  const first = line.split(/\s+/)[0] ?? ''
  // Letters, digits, and the punctuation that appears in real program names and
  // paths. Anything else — a quote, a `$`, a parenthesis — is shell syntax.
  return /^[A-Za-z0-9_.:+\-\\/]+$/.test(first) ? first : null
}

/**
 * Is what these command lines launch actually on the machine? One answer per
 * line asked about, in the order asked.
 */
export function probeCommands(commands: readonly string[]): CommandPresence[] {
  return commands.map((raw) => {
    const command = String(raw ?? '')
    const exe = command.trim() ? checkableExe(command) : null
    if (!exe) return { command, exe: '', found: false, unknown: true }
    const resolved = whichCommand(exe)
    const presence: CommandPresence = { command, exe, found: resolved !== null, unknown: false }
    if (resolved) presence.path = resolved
    return presence
  })
}

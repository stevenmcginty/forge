import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { whichCommand } from './which'

/**
 * How to spawn an agent CLI without a shell — the fix for
 * `spawn C:\Users\steve\AppData\Roaming\npm\codex ENOENT`.
 *
 * On Windows an npm-installed CLI is three files in %APPDATA%\npm: `codex`
 * (a POSIX sh script for Git Bash), `codex.cmd` and `codex.ps1`. `whichCommand`
 * answers "is it installed?" and finds the extensionless one first, which is
 * right for that question and wrong for `spawn`: CreateProcess cannot run a sh
 * script, so the spawn dies with ENOENT (exit -4058) before a byte is read.
 *
 * So this resolves the *launch*, not the presence:
 *
 *  - An `.exe` on PATH is spawned as itself.
 *  - An npm `.cmd` shim is read, and the script it runs
 *    (`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`) is spawned with
 *    node directly — the shim's own node.exe when it has one, else `node` on
 *    PATH. No cmd.exe, so no second parse of any argument.
 *  - Any other `.cmd`/`.bat` goes through cmd.exe, and only with arguments
 *    `cmdSafe` passes: cmd.exe re-parses its line, so `&`, `|`, `%` or a quote
 *    in an argument would be interpreted. Callers put text on stdin, never on
 *    that line.
 *
 * Off Windows the name is spawned as it is. No Electron import, so
 * scripts/brain-adapters-check.mjs drives it against a temp PATH.
 */

export interface CliLaunch {
  /** What to hand `spawn` as the program. */
  file: string
  /** Arguments to put before the CLI's own. */
  prefix: string[]
  /** How it was resolved — `cmd` means every argument must pass `cmdSafe`. */
  via: 'exe' | 'node' | 'cmd' | 'posix'
  /** The file found on PATH, for messages. */
  found: string
}

/** Windows extensions CreateProcess (or cmd.exe) can actually run, best first. */
const RUNNABLE = ['.exe', '.cmd', '.bat', '.com']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The script an npm cmd-shim runs, or null. Handles both shim generations:
 * `"%dp0%\node_modules\…\cli.js" %*` (current) and `"%~dp0\node_modules\…"`.
 * Pure — the check script feeds it shim text.
 */
export function parseNpmShim(text: string): string | null {
  const m = /"%~?dp0%?\\([^"\r\n]+?)"\s+%\*/i.exec(text)
  return m ? m[1]! : null
}

/** Arguments cmd.exe would pass through untouched: no metacharacters, no quotes, no line breaks. */
export function cmdSafe(args: readonly string[]): boolean {
  return args.every((a) => !/["&|<>^%!\r\n]/.test(a))
}

/** The first runnable Windows file for `name` on PATH — never the extensionless sh shim. */
export function findWindowsLaunchable(name: string, pathValue = process.env['PATH'] ?? ''): string | null {
  if (isAbsolute(name) || name.includes('\\') || name.includes('/')) {
    if (RUNNABLE.includes(extname(name).toLowerCase()) && isFile(name)) return name
    for (const ext of RUNNABLE) if (isFile(name + ext)) return name + ext
    return null
  }
  const exts = RUNNABLE.includes(extname(name).toLowerCase()) ? [''] : RUNNABLE
  for (const raw of pathValue.split(delimiter)) {
    const dir = raw.replace(/^"|"$/g, '').trim()
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * How to launch `name` (an agent CLI: `codex`, `gemini`) with no shell, or null
 * when it is not installed. `pathValue` and `platform` exist for the check.
 */
export function resolveCliLaunch(
  name: string,
  pathValue = process.env['PATH'] ?? '',
  platform: NodeJS.Platform = process.platform
): CliLaunch | null {
  if (platform !== 'win32') {
    const found = whichCommand(name)
    return found ? { file: found, prefix: [], via: 'posix', found } : null
  }
  const found = findWindowsLaunchable(name, pathValue)
  if (!found) return null
  const ext = extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: found, prefix: [], via: 'exe', found }

  let text = ''
  try {
    text = readFileSync(found, 'utf8')
  } catch {
    /* unreadable: fall through to cmd.exe */
  }
  const target = parseNpmShim(text)
  if (target) {
    const script = resolve(dirname(found), target)
    if (existsSync(script)) {
      if (/\.exe$/i.test(script)) return { file: script, prefix: [], via: 'exe', found }
      if (/\.(c|m)?js$/i.test(script)) {
        const local = join(dirname(found), 'node.exe')
        const node = isFile(local) ? local : findWindowsLaunchable('node', pathValue)
        if (node) return { file: node, prefix: [script], via: 'node', found }
      }
    }
  }
  return { file: process.env['ComSpec'] ?? 'cmd.exe', prefix: ['/d', '/s', '/c', found], via: 'cmd', found }
}

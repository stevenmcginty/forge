import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { AgentPresence } from '@shared/types'

/**
 * Is the agent this profile launches actually installed?
 *
 * The first-run welcome shows found/not-found for every built-in that launches
 * something — `claude`, `kimi`, `gemini`, `opencode` — which is the difference
 * between "Forge is broken" and "you have not installed Claude Code yet", the
 * single most likely thing to go wrong for the first person handed a copy.
 *
 * Resolved by walking PATH ourselves rather than shelling out to `where`:
 * spawning three processes on startup to answer a question about the filesystem
 * is wasteful, and `where` behaves differently under a non-interactive shell.
 * PATHEXT is honoured, which is what finds `claude.cmd` (npm shims are batch
 * files on Windows, not .exe).
 */

/** Where to send someone who has not got it. */
const INSTALL_URLS: Record<string, string> = {
  claude: 'https://claude.com/claude-code',
  kimi: 'https://platform.moonshot.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  opencode: 'https://opencode.ai/docs/',
  // The DeepSeek profile *is* OpenCode with a model flag, so what has to be
  // installed — and therefore what the welcome card should link to — is OpenCode.
  deepseek: 'https://opencode.ai/docs/'
}

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
 * The built-in agent profiles that launch something, with whether that
 * something is here. Plain shells are skipped: there is nothing to install.
 */
export function probeAgents(): AgentPresence[] {
  return BUILTIN_AGENT_PROFILES.filter((p) => p.command.trim()).map((profile) => {
    const resolved = whichCommand(profile.command)
    const presence: AgentPresence = {
      id: profile.id,
      name: profile.name,
      command: profile.command,
      found: resolved !== null,
      installUrl: INSTALL_URLS[profile.id] ?? ''
    }
    if (resolved) presence.path = resolved
    return presence
  })
}

export function registerAgentProbeHandlers(): void {
  ipcMain.handle(IPC.agentsProbe, () => probeAgents())
}

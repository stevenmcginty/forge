import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { AgentPresence } from '@shared/types'
import { probeCommands, whichCommand } from './which'

// Re-exported because half of main asks this file the question — system.ts for
// `claude --version`, tools.ts for the catalogue probe — and moving the walk
// out from under them should not mean editing their imports.
export { whichCommand }

/**
 * Is the agent this profile launches actually installed?
 *
 * The first-run welcome shows found/not-found for every built-in that launches
 * something — `claude`, `codex`, `kimi`, `gemini`, `opencode` — which is the difference
 * between "Forge is broken" and "you have not installed Claude Code yet", the
 * single most likely thing to go wrong for the first person handed a copy.
 *
 * The PATH walk itself lives in ./which, which knows nothing about profiles and
 * nothing about Electron. This file is the part that knows the roster.
 */

/** Where to send someone who has not got it. */
const INSTALL_URLS: Record<string, string> = {
  claude: 'https://claude.com/claude-code',
  codex: 'https://developers.openai.com/codex/cli',
  kimi: 'https://platform.moonshot.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  opencode: 'https://opencode.ai/docs/',
  // The DeepSeek profile *is* OpenCode with a model flag, so what has to be
  // installed — and therefore what the welcome card should link to — is OpenCode.
  deepseek: 'https://opencode.ai/docs/'
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
  ipcMain.handle(IPC.agentsWhich, (_e, commands: unknown) =>
    probeCommands(Array.isArray(commands) ? commands.slice(0, 64).map((c) => String(c ?? '')) : [])
  )
}

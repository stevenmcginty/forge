import { existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { whichCommand } from '../which'
import { claudeExecutablePath } from '../voice-agent/host'

/**
 * The `claude` binary Claude Live's SDK sessions run.
 *
 * The CLI bundled with the Agent SDK lags the one Steve keeps updated, and
 * the 5.5 models need a newer one: measured 2026-11-04, the bundled 2.1.220
 * answers claude-opus-5-5 with "API Error: 400 Claude Code 2.1.220 does not
 * support this model; version 2.1.280 or newer is required", while the
 * `claude` on PATH (the one every Forge pane runs) was 2.1.318. So Live
 * prefers that one, as a real executable: an npm shim (claude.cmd) cannot be
 * spawned directly, so its package's own binary is used. Without one, the
 * voice agent's choice (the bundled CLI) stands.
 *
 * FORGE_VOICE_CLAUDE_PATH still wins, as it does for the voice agent.
 */
export function liveClaudeExecutable(): string | undefined {
  const pinned = process.env['FORGE_VOICE_CLAUDE_PATH']
  if (pinned) return pinned
  const onPath = whichCommand('claude')
  if (onPath) {
    if (process.platform !== 'win32' || extname(onPath).toLowerCase() === '.exe') return onPath
    // <npm>\claude.cmd → <npm>\node_modules\@anthropic-ai\claude-code\bin\claude.exe
    const exe = join(dirname(onPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
  }
  return claudeExecutablePath()
}

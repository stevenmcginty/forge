import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSessionId, transcriptDirName } from '@shared/session'

/**
 * Where Claude Code keeps its conversations, and whether a given one is there.
 *
 * Deliberately free of any Electron import — and of Forge's settings — so it can
 * be exercised head-less against a real directory tree (see
 * scripts/session-check.mjs). The path munging is the part of resume-on-restore
 * most able to be quietly wrong, so it is the part with a test that builds
 * actual folders and looks for actual files.
 */

/**
 * Claude Code's home: `~/.claude` unless CLAUDE_CONFIG_DIR moves it.
 *
 * Read from Forge's *own* environment rather than a pane's, because the pane
 * inherits ours — buildEnv in electron/pty/session-manager.ts strips Claude's
 * session markers but not this — so the two always agree.
 */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CLAUDE_CONFIG_DIR']
  return override && override.trim() ? override.trim() : join(homedir(), '.claude')
}

/** Where Claude Code would have filed this session's transcript. */
export function transcriptPath(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(claudeHome(env), 'projects', transcriptDirName(cwd), `${sessionId}.jsonl`)
}

/** Is there a conversation to go back to? */
export function hasTranscript(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): boolean {
  if (!cwd || !isSessionId(sessionId)) return false
  try {
    return existsSync(transcriptPath(cwd, sessionId, env))
  } catch {
    // An unreadable ~/.claude is not a reason to refuse to open a pane; it is a
    // reason to treat this as a first launch.
    return false
  }
}

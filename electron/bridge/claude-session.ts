import { composeSession, isSessionId, type SessionMode } from '@shared/session'
import { hasTranscript } from './claude-transcripts'
import { getSettings } from '../store'

/**
 * Resume-on-restore, Forge's half of it.
 *
 * shared/session.ts knows how to *write* the flag. This module answers the one
 * question it cannot: is there a conversation on disk to resume, or is this
 * pane's first ever launch?
 *
 * The answer is a file: Claude Code writes every session to a transcript whose
 * name is its id, so "has this pane got a past?" is an `existsSync` on a path
 * computed from two things we already have — the pane's cwd and the uuid saved
 * in its layout entry. No parsing of Claude's output, no state of our own to
 * keep in step. That lookup lives in ./claude-transcripts.ts, which is kept
 * Electron- and settings-free so scripts/session-check.mjs can drive it against
 * a real directory tree.
 *
 * Shaped like bridge/remote-control.ts and bridge/mcp-config.ts on purpose: one
 * transform, applied in the single place every pane's launch command passes
 * through (electron/pty-host.ts), resolving its settings here in the main
 * process rather than threading them through the renderer.
 *
 * If the guess is wrong the pane still opens — the shell is real either way, and
 * Claude prints its own error into it. The failure mode is a visible line in a
 * terminal, not a lost pane.
 */

export interface SessionContext {
  /** The uuid saved with the pane. Absent/invalid = nothing to manage. */
  sessionId?: string | undefined
  /** The pane's working directory, which is what Claude files transcripts by. */
  cwd: string
}

/**
 * The outcome of the transform: the command to run, plus whether Forge is
 * managing this pane's session identity at all.
 *
 * `managed` is what the quit confirmation reads to tell Steve which panes will
 * come back and which are about to be lost for good — see electron/main.ts.
 */
export interface SessionPlan {
  command: string
  managed: boolean
  mode: SessionMode | null
}

/**
 * Name this pane's Claude session, so that closing Forge stops being the end of
 * the conversation.
 *
 * First launch gets `--session-id <uuid>` — claiming the id we already saved.
 * Every launch after that gets `--resume <uuid>`, because the transcript is
 * there. The pane keeps one id for its whole life: `--fork-session` is opt-in,
 * so resuming does not mint a new one.
 *
 * Off entirely when `resumeSessions` is off, which is the escape hatch for a
 * Claude that ever disagrees with any of the above.
 */
export function applyClaudeSession(command: string, ctx: SessionContext): SessionPlan {
  const cmd = command.trim()
  const sessionId = ctx.sessionId ?? ''
  if (!cmd || !isSessionId(sessionId) || !getSettings().resumeSessions) {
    return { command, managed: false, mode: null }
  }

  const mode: SessionMode = hasTranscript(ctx.cwd, sessionId) ? 'resume' : 'new'
  const next = composeSession(cmd, sessionId, mode)
  // composeSession returns the command untouched for everything it refuses —
  // a shell, another tool, a one-shot `-p` run, a hand-written --resume. Those
  // panes are not managed, and the quit dialog must not claim they are.
  if (next === cmd) return { command, managed: false, mode: null }
  return { command: next, managed: true, mode }
}

/**
 * Claude Code session identity, as Forge composes it.
 *
 * The problem this solves: a pane's PTY dies when Forge closes, so a restored
 * layout used to bring back the *furniture* — the tabs, the splits, the colours
 * — and then start a brand new `claude` in each pane. The conversation you had
 * was still on disk (Claude Code writes every session to
 * `~/.claude/projects/<project>/<session-id>.jsonl`), but nothing in Forge knew
 * which file belonged to which pane, so there was no way back to it.
 *
 * So Forge names the session itself. Every pane is born with a UUID, kept in its
 * layout entry (`PaneLeaf.sessionId`) and therefore saved with the workspace.
 * The first launch says `--session-id <uuid>`, which tells Claude to *use* that
 * id; every launch after that says `--resume <uuid>`, which picks the
 * conversation back up. Which of the two is right is a question about the disk,
 * and is answered in electron/bridge/claude-session.ts — this module only knows
 * how to write the line.
 *
 * Deliberately dependency-free (no Electron, no Node), like shared/remote.ts:
 * the main process composes the bootstrap line with it, the renderer mints ids
 * with it, and scripts/session-check.mjs drives it head-less.
 *
 * Verified against Claude Code v2.1.220:
 *   --session-id <uuid>     Use a specific session ID for the conversation
 *   -r, --resume [value]    Resume a conversation by session ID, or ...
 *   --fork-session          When resuming, create a new session ID
 *
 * `--fork-session` being opt-in is what makes this stable: a resumed session
 * keeps its id, so one uuid stays valid for the life of the pane no matter how
 * many times Forge is closed and reopened.
 */
import { isClaudeCommand } from './agents'
import { isNonInteractive } from './remote'

/**
 * A canonical UUID, which is the only thing Claude Code accepts:
 *
 *   $ claude --session-id not-a-uuid -p "hi"
 *   Error: Invalid session ID. Must be a valid UUID.
 *
 * Everything here is validated against it rather than trusted, because a
 * session id read off disk ends up inside a command line that is *typed into a
 * live PowerShell*. A layout file is not a trusted input.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/**
 * A fresh session id for a new pane.
 *
 * `crypto.randomUUID` needs a secure context, which an Electron renderer is —
 * but the fallback costs six lines and means this module cannot be the reason a
 * pane fails to open somewhere unexpected (a plain http:// dev server, a
 * head-less bundle in a test script).
 */
export function newSessionId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Has the user already said something about sessions by hand?
 *
 * A profile rewritten to `claude --resume` or `claude -c` is somebody who has
 * decided how their panes should start, and Forge adding a second, contradictory
 * session flag to that line would be Forge overruling them. Those panes keep
 * today's behaviour: they run exactly the command that was typed.
 */
export function hasSessionFlag(command: string): boolean {
  return /(^|\s)(--session-id|--resume|-r|--continue|-c|--fork-session)(\s|=|$)/.test(command)
}

/**
 * `new`     first launch — claim the id, so we know it for next time.
 * `resume`  every launch after that — pick the conversation back up.
 */
export type SessionMode = 'new' | 'resume'

/**
 * Put the session flag on a Claude bootstrap command.
 *
 * Returns the command unchanged for everything that is not a fresh interactive
 * Claude launch: a plain shell, another tool, a one-shot `-p` pipe, a command
 * that already carries a session flag, or an id that is not a real UUID.
 *
 * Goes on before `--mcp-config` (see bridge/mcp-config.ts), whose value is
 * variadic and therefore has to stay last.
 */
export function composeSession(command: string, sessionId: string, mode: SessionMode): string {
  const cmd = command.trim()
  if (!cmd) return command
  if (!isClaudeCommand(cmd)) return cmd
  if (!isSessionId(sessionId)) return cmd
  if (hasSessionFlag(cmd) || isNonInteractive(cmd)) return cmd
  return mode === 'resume' ? `${cmd} --resume ${sessionId}` : `${cmd} --session-id ${sessionId}`
}

/**
 * The folder Claude Code files a project's transcripts under, relative to
 * `~/.claude/projects`.
 *
 * Claude replaces every character that is not a letter or a digit with a hyphen,
 * so `C:\Users\steve\Desktop\forge` becomes `C--Users-steve-Desktop-forge` —
 * the drive colon and the separator each contributing one. Confirmed against a
 * real `~/.claude/projects` listing, including the awkward ones
 * (`forge\.claude\worktrees\…` → `forge--claude-worktrees-…`).
 *
 * A trailing separator is dropped first: `…\forge\` and `…\forge` are the same
 * folder, and Claude only ever sees the resolved form without one.
 */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')
}

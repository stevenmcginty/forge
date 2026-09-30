import type { CreateSessionRequest } from '@shared/types'

/**
 * How Forge Brain's pane is launched, as the PTY host needs to know it.
 *
 * Kept apart from ./host.ts on purpose: electron/pty-host.ts imports this, and
 * ./host.ts imports pty-host, so the two halves would otherwise import each
 * other. Nothing here imports anything of Forge's.
 *
 * Main owns the brain pane's launch, not the renderer: the pane lives in a
 * hidden project the renderer never mounts. But a renderer or a browser that
 * attaches a terminal to it still goes through `pty:create` (re-adopting the
 * running session), and a relaunch from a view must launch the brain, not
 * whatever the view guessed — so `brainCreateRequest` overrides what the
 * request says for this one pane id.
 */

export interface BrainLaunch {
  paneId: string
  cwd: string
  /** The engine's command, before the PTY host's own transforms (session, bridge). */
  command: string
  /** Claude session uuid for claude; absent for the other engines. */
  sessionId?: string
  projectName: string
  paneTitle: string
  /** Appended after every other transform: `--mcp-config "<path>"` for Claude. Empty = nothing. */
  claudeMcpConfig: string
  /** Extra environment for the pane. */
  env: Record<string, string>
}

let current: BrainLaunch | null = null

/** Set by ./host.ts before it spawns the pane; null when the brain is stopped. */
export function setBrainLaunch(launch: BrainLaunch | null): void {
  current = launch
}

export function isBrainPane(id: string): boolean {
  return !!current && current.paneId === id
}

/** The request with the brain's own launch in place of the caller's, for the brain pane only. */
export function brainCreateRequest(req: CreateSessionRequest): CreateSessionRequest {
  if (!current || req?.id !== current.paneId) return req
  return {
    id: current.paneId,
    cwd: current.cwd,
    cols: Number(req.cols) || 120,
    rows: Number(req.rows) || 40,
    bootstrapCommand: current.command,
    projectName: current.projectName,
    paneTitle: current.paneTitle,
    ...(current.sessionId ? { sessionId: current.sessionId } : {}),
    // A Remote Control session writes no local transcript, and the brain's
    // chat views read its transcript.
    remoteControl: false
  }
}

/**
 * The brain's own MCP server for Claude, after every other transform — Claude's
 * `--mcp-config` is variadic and stays last, so a second config is one more
 * path on the same flag when the bridge already added it.
 */
export function applyBrainMcp(id: string, command: string): string {
  if (!current || id !== current.paneId || !current.claudeMcpConfig || !command.trim()) return command
  const path = `"${current.claudeMcpConfig}"`
  return /--mcp-config\b/.test(command) ? `${command} ${path}` : `${command} --mcp-config ${path}`
}

/** The brain pane's extra environment; empty for every other pane. */
export function brainEnv(id: string): Record<string, string> {
  return current && id === current.paneId ? current.env : {}
}

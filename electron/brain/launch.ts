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

/**
 * Claude's command for the brain pane, before the PTY host's transforms: a
 * pinned model at low effort, the home's own settings only, and no MCP server
 * but the ones Forge names. A bare `claude` loaded Steve's whole user config
 * (his CLAUDE.md, plugins, hooks, every MCP server) on whatever model his
 * default was. Measured on Claude Code 2.1.287 in a copy of the home, first
 * turn: about 37,000 tokens bare, about 20,000 like this with Forge's tools
 * connected. Flags checked against that version's `--help`.
 *
 * Forge's tools still sit behind ToolSearch (Claude Code defers MCP tools by
 * default). ENABLE_TOOL_SEARCH=false would load them up front, with every
 * built-in beside them: about 44,000 tokens a turn, so it is left alone.
 *
 * None of these is variadic, so the PTY host's `--disallowedTools` and
 * `--mcp-config` still come after them and `--mcp-config` stays last. The
 * model id is typed into a shell: anything that is not a plain id is left out.
 */
export function claudeBrainCommand(model: string): string {
  const pinned = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) ? ` --model ${model}` : ''
  return `claude${pinned} --effort low --setting-sources "project,local" --strict-mcp-config`
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

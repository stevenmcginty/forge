/**
 * Claude Code Remote Control, as Forge composes it.
 *
 * A Claude session launched with `--remote-control "<name>"` stays on this PC
 * but becomes viewable *and drivable* from the Claude mobile app (Code tab) and
 * claude.ai/code. Forge's job is only to compose the launch line: name the
 * session after the pane it lives in, and refuse to touch a command where the
 * flag would be wrong.
 *
 * Deliberately dependency-free (no Electron, no Node): the main process builds
 * the bootstrap line with it, the renderer shows the same name in the pane's
 * phone popover, and scripts/remote-check.mjs tests it head-less.
 *
 * Verified against Claude Code v2.1.220 `--help`:
 *   --remote-control [name]   Start an interactive session with Remote Control
 *                             enabled (optionally named)
 *   --rc                      alias (the CLI reads `remoteControl ?? rc`)
 */

/** The session list — where the popover's button goes before we know better. */
export const REMOTE_CONTROL_URL = 'https://claude.ai/code'

/**
 * The per-session URL Claude Code prints once Remote Control has connected:
 *
 *   /remote-control is active · Continue here, on your phone, or at
 *   https://claude.ai/code/session_01DVNvj8NnRwAL2C38MWhGcj
 *
 * Forge reads it straight out of the pane's own output (see TerminalHost in
 * src/lib/terminals.ts) rather than going anywhere near the user's hooks or
 * settings, and the pane's phone popover then deep-links to *this* session
 * instead of the list.
 */
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/

/** The session URL in a chunk of terminal output, or null. */
export function findRemoteSessionUrl(text: string): string | null {
  return SESSION_URL.exec(text)?.[0] ?? null
}

/**
 * Longest name we compose. The phone's session list is a narrow column, and a
 * 200-character name there is a scrollbar, not a label.
 */
export const REMOTE_NAME_MAX = 64

/** Control characters would end up in an argv the shell has to survive. */
function tidy(part: string): string {
  return part
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The name a pane's remote session appears under on the phone:
 * `"<project> — <pane title>"`, collapsing to whichever half exists.
 *
 * Kept as one function so the main process (which builds the command) and the
 * renderer (which tells Steve what to look for) can never disagree.
 */
export function remoteControlName(projectName: string, paneTitle: string): string {
  const project = tidy(projectName)
  const pane = tidy(paneTitle)
  const joined = project && pane && project !== pane ? `${project} — ${pane}` : project || pane
  const name = joined || 'Forge'
  return name.length > REMOTE_NAME_MAX ? tidy(name.slice(0, REMOTE_NAME_MAX)) : name
}

/** The executable a bootstrap command runs, lower-cased and de-suffixed. */
export function commandExe(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first
    .replace(/^.*[\\/]/, '')
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * Is this really Claude Code? A profile whose command Steve has rewritten to
 * `claude --resume` still is; one he has pointed at another tool is not, and
 * handing that tool an unknown flag would only break the pane.
 */
export function isClaudeCommand(command: string): boolean {
  return commandExe(command) === 'claude'
}

/** Already asked for Remote Control by hand — leave the command alone. */
export function hasRemoteControlFlag(command: string): boolean {
  return /(^|\s)--(remote-control|rc)(\s|=|$)/.test(command)
}

/** `-p` / `--print` is a one-shot pipe: there is no session to drive. */
export function isNonInteractive(command: string): boolean {
  return /(^|\s)(-p|--print)(\s|=|$)/.test(command)
}

/**
 * PowerShell single-quoting. Every Forge pane is a real pwsh session and the
 * bootstrap command is *typed* into it, so the name has to survive the shell
 * before it ever reaches Claude. Single quotes are the literal form in
 * PowerShell — `$`, backticks and spaces all pass through untouched — and the
 * only escape needed is a doubled quote.
 */
export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Append `--remote-control '<name>'` to a Claude bootstrap command.
 *
 * Returns the command unchanged for anything that is not an interactive Claude
 * launch. The flag goes on before `--mcp-config` (see bridge/mcp-config.ts),
 * whose value is variadic and therefore has to stay last.
 */
export function composeRemoteControl(command: string, name: string): string {
  const cmd = command.trim()
  if (!cmd) return command
  if (!isClaudeCommand(cmd)) return cmd
  if (hasRemoteControlFlag(cmd) || isNonInteractive(cmd)) return cmd
  const label = tidy(name)
  return label ? `${cmd} --remote-control ${quoteForShell(label)}` : `${cmd} --remote-control`
}

/**
 * Environment variables that switch Remote Control off, quietly.
 *
 * The first four disable the feature-flag evaluation that gates the research
 * preview; the last three change *how* Claude authenticates, and Remote Control
 * only exists for a claude.ai login talking to api.anthropic.com. All seven are
 * confirmed in the Remote Control docs, and Forge strips every one of them out
 * of a pane's environment (see buildEnv in electron/pty/session-manager.ts) so
 * an inherited value on Steve's machine cannot silently kill the feature.
 */
export const REMOTE_CONTROL_KILLERS = [
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL'
] as const

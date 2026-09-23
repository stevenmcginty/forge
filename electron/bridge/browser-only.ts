import { isClaudeCommand } from '@shared/agents'

/**
 * "Agents use Forge's browser only" (settings.agentsForgeBrowserOnly, on by
 * default): a Forge-launched Claude pane is started with the other browser
 * MCP servers denied, so a "use our browser" request can only land in
 * forge-bridge's browser_open.
 *
 * Why a flag and not a sentence: Steve's own Claude has Claude-in-Chrome and
 * the Playwright plugin, and a tool description does not reliably beat a
 * tool the model already knows. `--disallowedTools` (checked against the
 * installed `claude --help`: "Comma or space-separated list of tool names to
 * deny") takes an MCP server name as a prefix for all of its tools. It is per
 * launch — Steve's global config is never touched.
 *
 * Only Claude Code (and GLM, which is Claude Code) has such a flag. Codex,
 * Gemini CLI and the rest get the instructions line (cli-register.ts) only.
 *
 * The flag is variadic, like --mcp-config, so this runs BEFORE the bridge
 * transform: --mcp-config stays last on the line.
 */

/** The browser MCP servers a Forge pane must not reach for. */
export const OTHER_BROWSER_SERVERS: readonly string[] = [
  'mcp__claude-in-chrome',
  'mcp__plugin_playwright_playwright',
  'mcp__playwright',
  'mcp__puppeteer',
  'mcp__chrome-devtools',
  'mcp__browsermcp'
]

export function applyForgeBrowserOnly(command: string, on: boolean): string {
  const cmd = command.trim()
  if (!on || !cmd || !isClaudeCommand(cmd)) return command
  if (/--disallowed-?tools\b/i.test(cmd)) return command
  return `${cmd} --disallowedTools "${OTHER_BROWSER_SERVERS.join(',')}"`
}

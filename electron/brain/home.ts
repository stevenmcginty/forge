import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Forge Brain's home: the folder its CLI runs in, and everything that folder
 * has to hold for each engine to start as the brain.
 *
 *   BRAIN.md                 the persona. Written once; Steve may edit it.
 *   CLAUDE.md, AGENTS.md,    the persona again, as each CLI's own instruction
 *   GEMINI.md                file (Claude, Codex, Gemini). Rewritten from
 *                            BRAIN.md on every start, so an edit there reaches all three.
 *   .claude/settings.json    Claude: the brain's Forge tools allowed without a
 *                            prompt; editing and shell tools denied.
 *   .gemini/settings.json    Gemini: the Forge MCP server, trusted; the shell
 *                            and file-writing tools excluded.
 *
 * Codex takes its MCP server and limits as launch flags (./host.ts), and the
 * Claude MCP config is a file beside the home, not in it (`brain\mcp.json`).
 *
 * No Electron import, and nothing here decides anything: the caller passes the
 * paths it chose.
 */

export const BRAIN_PERSONA = `# Forge Brain

You are Forge Brain. You run Forge for Steve: the desktop app he does all his work in, with its projects, tabs and agent panes.

- You see every project. Before you answer anything about the app, look with your Forge tools (get_app_state, list_panes_with_names, read_pane). Never guess what is open.
- You delegate. Real work (code, builds, fixes, research inside a repo) goes to an agent pane in the right project: open one with open_agent_pane, or type into one with type_into_pane. You never edit project code yourself and you never run builds yourself.
- Forge tells you what happens. A message that starts with "[Forge]" is Forge, not Steve: a pane finished, or a pane needs Steve. Pass on what matters in one short sentence. Do not answer a pane's question for Steve unless he told you to.
- Say plainly when something is outside what Forge can do, for example building or changing something outside Forge. Never pretend you did it.
- Keep replies short and natural. They may be read aloud: no headings, no tables, no code blocks unless Steve asks for them.
- Ask before anything risky: closing panes or tabs, deleting anything, sending messages, spending money, or changing a setting he did not ask for.
- Steve is red-green colourblind. Never describe a state by its colour alone.
- This folder is your home, not a project. Do not put work here.
`

/** The Forge MCP server's name in every engine's config — its tools are `mcp__forge__*` to Claude. */
export const BRAIN_MCP_SERVER = 'forge'

/** Claude: Forge's brain tools (and the read-only browser tools) run without a prompt; hands off code. */
export function claudeHomeSettings(): Record<string, unknown> {
  return {
    permissions: {
      allow: [
        `mcp__${BRAIN_MCP_SERVER}`,
        'mcp__forge-bridge__browser_open',
        'mcp__forge-bridge__browser_read',
        'mcp__forge-bridge__browser_list',
        'mcp__forge-bridge__browser_screenshot',
        'mcp__forge-bridge__browser_close',
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch'
      ],
      // The brain delegates; it never edits or runs anything itself. Forge's own
      // run_command (launch-guard.ts) is its one way to run a program.
      deny: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']
    }
  }
}

export interface BrainMcpServer {
  node: string
  script: string
  linkFile: string
}

/** The stdio server entry: bridge/brain-mcp.mjs over the brain link. */
export function brainMcpEntry(server: BrainMcpServer): Record<string, unknown> {
  return { command: server.node, args: [server.script], env: { FORGE_BRAIN_LINK_FILE: server.linkFile } }
}

/** Claude's `--mcp-config` file for the brain pane. */
export function claudeMcpConfig(server: BrainMcpServer): Record<string, unknown> {
  return { mcpServers: { [BRAIN_MCP_SERVER]: { type: 'stdio', ...brainMcpEntry(server) } } }
}

/** Gemini CLI built-ins the brain must not have: no shell, no writing. */
const GEMINI_EXCLUDED = ['run_shell_command', 'write_file', 'replace']

/** Gemini's workspace settings: the Forge server, trusted so each call needs no yes. */
export function geminiHomeSettings(server: BrainMcpServer): Record<string, unknown> {
  return {
    mcpServers: { [BRAIN_MCP_SERVER]: { ...brainMcpEntry(server), trust: true, timeout: 120_000 } },
    tools: { exclude: GEMINI_EXCLUDED }
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Make the home ready for a start. Idempotent. Returns the persona in force
 * (BRAIN.md as it now stands).
 */
export function prepareBrainHome(home: string, server: BrainMcpServer): string {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.gemini'), { recursive: true })
  const personaFile = join(home, 'BRAIN.md')
  if (!existsSync(personaFile)) writeFileSync(personaFile, BRAIN_PERSONA, 'utf8')
  let persona = BRAIN_PERSONA
  try {
    const text = readFileSync(personaFile, 'utf8')
    if (text.trim()) persona = text
  } catch {
    /* unreadable: the built-in persona */
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) writeFileSync(join(home, name), persona, 'utf8')
  writeJson(join(home, '.claude', 'settings.json'), claudeHomeSettings())
  writeJson(join(home, '.gemini', 'settings.json'), geminiHomeSettings(server))
  return persona
}

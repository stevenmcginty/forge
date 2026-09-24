/**
 * The main agent's own tools — open an agent pane inside Forge, type into a
 * pane, help with a prompt, read a pane — in words and JSON Schema. ONE
 * definition for every Agent brain:
 *
 *  - realtime brains spread `MAIN_AGENT_TOOL_SPECS` into their function-tool
 *    list (src/lib/realtime/tools.ts);
 *  - the Claude session builds its MCP tools from the same specs
 *    (electron/brain-tools-mcp.ts turns each schema into a zod shape);
 *  - a CLI adapter (B8: gemini-cli, codex-cli) serves them from an MCP server
 *    as they are — `parameters` is already the MCP `inputSchema`.
 *
 * Every call is answered by the renderer, which owns the panes
 * (src/lib/realtime/tools-main.ts `runMainAgentTool`). The hub's four tools
 * (shared/hub-tools.ts) and the browser tools (shared/browser.ts) complete the
 * set; together they are what "the same tools on every brain" means.
 */

export const MAIN_AGENT_TOOL_NAMES = ['open_agent_pane', 'type_into_pane', 'help_prompt', 'read_pane'] as const

export type MainAgentToolName = (typeof MAIN_AGENT_TOOL_NAMES)[number]

export function isMainAgentTool(name: string): name is MainAgentToolName {
  return (MAIN_AGENT_TOOL_NAMES as readonly string[]).includes(name)
}

export interface BrainToolProperty {
  type: 'string' | 'integer' | 'boolean'
  description: string
  enum?: string[]
}

export interface BrainToolSpec {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, BrainToolProperty>; required: string[] }
}

/** The refusal every launch guard and persona uses, word for word. */
export const USE_OPEN_AGENT_PANE = 'Use open_agent_pane — agents open inside Forge.'

export const MAIN_AGENT_TOOL_SPECS: BrainToolSpec[] = [
  {
    name: 'open_agent_pane',
    description: [
      'Open a new coding-agent pane INSIDE Forge — the only way to start an agent. agent is who, in words: "claude", "codex", "gemini", "antigravity", "glm", "kimi", "opencode", "qwen", "grok", or a plain "shell".',
      'prompt is typed into the new pane once the agent is up (sent only when submit is true). name is the new terminal’s name, shown on its tab; omit it for the next free name.',
      'Never start an agent CLI any other way — no run_command, no open_desktop_app, no new console or terminal window. The answer says which pane opened, or why none did.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which agent, in words: "codex", "claude", "gemini"…' },
        prompt: { type: 'string', description: 'Optional: the first prompt to type into it' },
        name: {
          type: 'string',
          description: 'Name for the new terminal; shown on its tab and used by every tool. Omit to get the next free name.'
        },
        submit: { type: 'boolean', description: 'Optional: press Enter after the prompt. Default false.' }
      },
      required: ['agent']
    }
  },
  {
    name: 'type_into_pane',
    description: [
      'Type text straight into one pane, as keystrokes — what Steve means by "type this into Zeb" or "put this in the terminal". target is the terminal’s name ("Zeb"), or spoken: "the codex one", or "this" for the focused pane.',
      'Multi-line text is pasted. submit presses Enter afterwards; text "" with submit true presses Enter alone (to send what is already there). If two panes match, the answer lists them: ask which.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Which pane, in words' },
        text: { type: 'string', description: 'Exactly what to type' },
        submit: { type: 'boolean', description: 'Optional: press Enter afterwards. Default false.' }
      },
      required: ['target', 'text']
    }
  },
  {
    name: 'help_prompt',
    description: [
      'Help Steve with a prompt: write the better prompt yourself (goal, context, constraints, what done looks like), then call this to put it in front of him for approval — it is typed into the target pane WITHOUT pressing Enter and that pane is brought forward.',
      'Then tell him in one line it is ready and ask whether to send it. When he says yes, call type_into_pane with the same target, text "" and submit true. With no target it goes to the focused pane.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The finished prompt, in full' },
        target: { type: 'string', description: 'Optional: which pane, in words. Default: the focused pane' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'read_pane',
    description:
      'Read the recent screen text of one pane — what an agent has been saying or printing. target is the terminal’s name ("Zeb"), or spoken: "the claude one", "this" for the focused pane.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Which pane, in words' },
        lines: { type: 'integer', description: 'How many lines, default 40, at most 200' }
      },
      required: ['target']
    }
  }
]

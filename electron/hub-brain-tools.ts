import { z } from 'zod'
import { HUB_TOOL_NAMES, HUB_TOOL_SPECS, type HubToolName } from '@shared/hub-tools'

/**
 * The hub's four tools for the Claude brain (electron/voice-agent/host.ts), as
 * `{ name, description, shape, handler }` entries its `tool()` helper takes
 * unchanged. Words come from shared/hub-tools.ts, the same source the realtime
 * brains use; every call is answered by the renderer (it owns the panes), so
 * the handler is just the host's `askRenderer`.
 */

type Ask = (name: string, args: unknown) => Promise<string>
type ToolResult = { content: Array<{ type: 'text'; text: string }> }

function spec(name: HubToolName): { description: string; param: (key: string) => string } {
  const s = HUB_TOOL_SPECS.find((t) => t.name === name)!
  return { description: s.description, param: (key) => s.parameters.properties[key]?.description ?? key }
}

export interface BrainHubTool {
  name: HubToolName
  description: string
  shape: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

export function brainHubTools(ask: Ask): BrainHubTool[] {
  const call = async (name: HubToolName, args: unknown): Promise<ToolResult> => ({
    content: [{ type: 'text', text: await ask(name, args ?? {}) }]
  })
  const focus = spec('focus_pane_by_name')
  const list = spec('list_panes_with_names')
  const run = spec('run_saved_prompt')
  const show = spec('show_on_board')
  return [
    {
      name: 'focus_pane_by_name' as const,
      description: focus.description,
      shape: { name: z.string().describe(focus.param('name')) },
      handler: (args: Record<string, unknown>) => call('focus_pane_by_name', args)
    },
    {
      name: 'list_panes_with_names' as const,
      description: list.description,
      shape: {},
      handler: () => call('list_panes_with_names', {})
    },
    {
      name: 'run_saved_prompt' as const,
      description: run.description,
      shape: {
        prompt: z.string().optional().describe(run.param('prompt')),
        pane: z.string().optional().describe(run.param('pane')),
        target: z.enum(['active-pane', 'composer']).optional().describe(run.param('target'))
      },
      handler: (args: Record<string, unknown>) => call('run_saved_prompt', args)
    },
    {
      name: 'show_on_board' as const,
      description: show.description,
      shape: {
        path: z.string().optional().describe(show.param('path')),
        title: z.string().optional().describe(show.param('title'))
      },
      handler: (args: Record<string, unknown>) => call('show_on_board', args)
    }
  ]
}

/** The hub tools' pre-approval entries, for the Claude session's allowlist. */
export function brainHubAllowed(): string[] {
  return HUB_TOOL_NAMES.map((name) => `mcp__forge__${name}`)
}

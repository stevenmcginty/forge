import { z } from 'zod'
import { MAIN_AGENT_TOOL_SPECS, type BrainToolProperty, type BrainToolSpec } from '@shared/brain-tools'

/**
 * The main agent's tools for the Claude session (electron/voice-agent/host.ts),
 * generated from the ONE definition in shared/brain-tools.ts — the same specs
 * the realtime brains are handed as function tools. Nothing here is written by
 * hand per tool: add a spec there and it appears here, on every brain, the same
 * day. Every call is answered by the renderer (`askRenderer`), which owns the
 * panes; see src/lib/realtime/tools-main.ts.
 */

type Ask = (name: string, args: unknown) => Promise<string>
type ToolResult = { content: Array<{ type: 'text'; text: string }> }

export interface BrainSpecTool {
  name: string
  description: string
  shape: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

function zodFor(prop: BrainToolProperty): z.ZodTypeAny {
  const base =
    prop.type === 'integer'
      ? z.number().int()
      : prop.type === 'boolean'
        ? z.boolean()
        : prop.enum && prop.enum.length
          ? z.enum(prop.enum as [string, ...string[]])
          : z.string()
  return base.describe(prop.description)
}

/** A JSON-Schema object spec as the zod raw shape the SDK's `tool()` takes. */
export function zodShapeOf(spec: BrainToolSpec): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(spec.parameters.properties)) {
    const t = zodFor(prop)
    shape[key] = spec.parameters.required.includes(key) ? t : t.optional()
  }
  return shape
}

export function brainSpecTools(ask: Ask, specs: readonly BrainToolSpec[] = MAIN_AGENT_TOOL_SPECS): BrainSpecTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    shape: zodShapeOf(spec),
    handler: async (args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: await ask(spec.name, args ?? {}) }]
    })
  }))
}

/** `mcp__forge__<name>` for every generated tool — the host's allow list. */
export function brainSpecAllowed(specs: readonly BrainToolSpec[] = MAIN_AGENT_TOOL_SPECS): string[] {
  return specs.map((s) => `mcp__forge__${s.name}`)
}

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { BROWSER_PARAM_TEXT, BROWSER_TOOL_DESCRIPTIONS, type BrowserAgentReply, type BrowserToolName } from '@shared/browser'

/**
 * The seven browser tools for the Claude brain (electron/voice-agent/host.ts),
 * as `{ name, description, shape, handler }` entries its `tool()` helper takes
 * unchanged — so the host swaps its five chrome-control tools for these with a
 * one-line spread.
 *
 * No Electron import, like the host itself: the runner is injected by ./ipc.ts
 * when the browser service starts, and until then every call says so. The voice
 * brain is one owner ("Voice") with its own tabs, like any agent pane.
 */

type Runner = (op: BrowserToolName, args: Record<string, unknown>) => Promise<BrowserAgentReply>

let runner: Runner | null = null

export function setBrainBrowserRunner(run: Runner | null): void {
  runner = run
}

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }

async function call(op: BrowserToolName, args: Record<string, unknown>): Promise<ToolResult> {
  if (!runner) return { content: [{ type: 'text', text: "Forge's browser is not running yet." }] }
  const reply = await runner(op, args)
  const content: ToolResult['content'] = [{ type: 'text', text: reply.text }]
  if (reply.imagePath) {
    try {
      content.push({ type: 'image', data: readFileSync(reply.imagePath).toString('base64'), mimeType: 'image/png' })
    } catch {
      /* the path in the text is still the answer */
    }
  }
  return { content }
}

const id = z.string().optional().describe(BROWSER_PARAM_TEXT.id)

/** Typed like electron/hub-brain-tools.ts `BrainHubTool`, so the host's `tool()` map compiles. */
export interface BrainBrowserTool {
  name: BrowserToolName
  description: string
  shape: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

export function brainBrowserTools(): BrainBrowserTool[] {
  return [
    {
      name: 'browser_open',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_open,
      shape: {
        url: z.string().describe(BROWSER_PARAM_TEXT.url),
        title: z.string().optional().describe(BROWSER_PARAM_TEXT.title),
        id: z.string().optional().describe('Optional: one of your tab ids to navigate instead of opening a new tab.')
      },
      handler: (args: Record<string, unknown>) => call('browser_open', args)
    },
    {
      name: 'browser_list',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_list,
      shape: {},
      handler: () => call('browser_list', {})
    },
    {
      name: 'browser_read',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_read,
      shape: { id },
      handler: (args: Record<string, unknown>) => call('browser_read', args)
    },
    {
      name: 'browser_click',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_click,
      shape: { id, ref: z.number().describe(BROWSER_PARAM_TEXT.ref) },
      handler: (args: Record<string, unknown>) => call('browser_click', args)
    },
    {
      name: 'browser_type',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_type,
      shape: {
        id,
        ref: z.number().optional().describe(BROWSER_PARAM_TEXT.ref),
        text: z.string().describe(BROWSER_PARAM_TEXT.text),
        submit: z.boolean().optional().describe(BROWSER_PARAM_TEXT.submit)
      },
      handler: (args: Record<string, unknown>) => call('browser_type', args)
    },
    {
      name: 'browser_screenshot',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_screenshot,
      shape: { id },
      handler: (args: Record<string, unknown>) => call('browser_screenshot', args)
    },
    {
      name: 'browser_close',
      description: BROWSER_TOOL_DESCRIPTIONS.browser_close,
      shape: { id },
      handler: (args: Record<string, unknown>) => call('browser_close', args)
    }
  ]
}

/** For the host's allowedTools list. */
export const BRAIN_BROWSER_ALLOWED = [
  'mcp__forge__browser_open',
  'mcp__forge__browser_list',
  'mcp__forge__browser_read',
  'mcp__forge__browser_click',
  'mcp__forge__browser_type',
  'mcp__forge__browser_screenshot',
  'mcp__forge__browser_close'
]

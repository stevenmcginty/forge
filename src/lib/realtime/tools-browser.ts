import type { RealtimeToolSpec } from '@shared/realtime'
import { BROWSER_TOOL_DESCRIPTIONS, BROWSER_TOOL_NAMES, BROWSER_TOOL_PARAMS, type BrowserToolName } from '@shared/browser'
import { browserBridge } from '../../components/browser/bridge'

/**
 * The seven browser tools for the voice hub's realtime brains (Gemini Live and
 * OpenAI Realtime), shaped like B2's HUB_REALTIME_TOOLS: spread
 * `...BROWSER_REALTIME_TOOLS` into REALTIME_TOOLS, and call `runBrowserHubTool`
 * beside `runHubTool` — it answers null for any name that is not a browser tool.
 *
 * The hub is one owner, "Voice", with its own tabs like any agent pane — main
 * assigns that (BROWSER_IPC.agent); the renderer cannot claim to be a pane.
 * Words and schemas come from shared/browser.ts, the same source the Claude
 * brain and the CLI bridge use.
 */

export const BROWSER_REALTIME_TOOLS: RealtimeToolSpec[] = BROWSER_TOOL_NAMES.map((name) => ({
  name,
  description: BROWSER_TOOL_DESCRIPTIONS[name],
  parameters: BROWSER_TOOL_PARAMS[name] as unknown as Record<string, unknown>
}))

export function isBrowserTool(name: string): name is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name)
}

/** Run one call, or null when `name` is not a browser tool. Never rejects: a failure is an answer. */
export async function runBrowserHubTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string } | null> {
  if (!isBrowserTool(name)) return null
  const api = browserBridge()
  if (!api) return { ok: false, text: "FAILED: Forge's browser is not available until Forge is restarted." }
  try {
    const reply = await api.agent({ op: name, args: args ?? {} })
    return { ok: reply.ok, text: reply.ok ? reply.text : `FAILED: ${reply.text}` }
  } catch (err) {
    return { ok: false, text: `FAILED: the browser could not do that: ${err instanceof Error ? err.message : String(err)}` }
  }
}

import type { RealtimeToolSpec } from '@shared/realtime'
import { CHAT_TOOL_SPECS, isChatTool } from '@shared/chat-tools'
import { browserBridge } from '../../components/browser/bridge'

/**
 * chat_list, chat_send and chat_read for the voice hub's realtime brains
 * (Gemini Live and OpenAI Realtime), shaped like ./tools-browser.ts: spread
 * `...CHAT_REALTIME_TOOLS` into REALTIME_TOOLS, and call `runChatHubTool`
 * beside the others — it answers null for any name that is not a chat tool.
 *
 * Words and schemas are shared/chat-tools.ts, the same the Claude brain, the
 * CLI bridge and Foreman use. The call rides the browser's agent channel;
 * main routes it to electron/chat-panes/agent-ops.ts, in the project on screen.
 */

export const CHAT_REALTIME_TOOLS: RealtimeToolSpec[] = CHAT_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters as unknown as Record<string, unknown>
}))

/** Run one call, or null when `name` is not a chat tool. Never rejects: a failure is an answer. */
export async function runChatHubTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string } | null> {
  if (!isChatTool(name)) return null
  const api = browserBridge()
  if (!api) return { ok: false, text: "FAILED: Forge's chat tabs are not available until Forge is restarted." }
  try {
    const reply = await api.agent({ op: name, args: args ?? {} })
    return { ok: reply.ok, text: reply.ok ? reply.text : `FAILED: ${reply.text}` }
  } catch (err) {
    return { ok: false, text: `FAILED: the chat tab could not do that: ${err instanceof Error ? err.message : String(err)}` }
  }
}

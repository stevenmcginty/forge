import type { SavedPromptTarget } from '@shared/hub'
import { HUB_TOOL_SPECS, hubToolName, isHubTool } from '@shared/hub-tools'
import type { VoiceAgentToolDeps } from '../agenttools'
import {
  findSavedPrompt,
  focusNavTarget,
  getHubRuntime,
  goTo,
  listPanesWithNames,
  runSavedPrompt,
  showOnBoard,
  type NavViews
} from '../hubRuntime'

/**
 * The hub's voice tools for every brain. Spread `HUB_REALTIME_TOOLS` into the
 * realtime list (in place of the two TODO(B2) stubs), and hand any name for
 * which `isHubTool` is true to `runHubTool` — the Claude brain's renderer
 * bridge (src/lib/agenttools.ts) does the same, so a tool means the same thing
 * whichever brain called it. Never rejects; a failure is an answer.
 *
 * `show_on_canvas` (the Board tool's old name) is answered as `show_on_board`
 * but never listed. `deps` is the voice agent's: "go to the wall" switches the
 * view through its `set_view` action, the same one the Tabs | Wall switch uses.
 */

export const HUB_REALTIME_TOOLS = HUB_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters as unknown as Record<string, unknown>
}))

export { isHubTool }

function viewsFrom(deps: VoiceAgentToolDeps | null | undefined): NavViews | undefined {
  if (!deps) return undefined
  return {
    setViewMode: (mode) => {
      void Promise.resolve(deps.runAction({ kind: 'set_view', mode })).catch(() => {})
    }
  }
}

export async function runHubTool(
  name: string,
  args: Record<string, unknown>,
  deps?: VoiceAgentToolDeps | null
): Promise<{ ok: boolean; text: string } | null> {
  const tool = hubToolName(name)
  if (!tool) return null
  try {
    switch (tool) {
      case 'focus_pane_by_name': {
        const r = goTo(String(args?.['name'] ?? ''), 'voice', viewsFrom(deps))
        return { ok: r.ok, text: r.ok ? `OK: ${r.summary}` : `FAILED: ${r.summary}` }
      }
      case 'list_panes_with_names':
        return { ok: true, text: listPanesWithNames() }
      case 'run_saved_prompt': {
        const prompts = getHubRuntime()?.prompts() ?? []
        const query = String(args?.['prompt'] ?? '').trim()
        const list = prompts.map((p) => `"${p.title}"${p.hotkey ? ` (${p.hotkey})` : ''}`).join(', ')
        if (!query) return { ok: true, text: prompts.length ? `Saved prompts: ${list}.` : 'There are no saved prompts yet.' }
        const prompt = findSavedPrompt(query, prompts)
        if (!prompt) {
          return { ok: false, text: `FAILED: no saved prompt matches "${query}".${prompts.length ? ` Saved prompts: ${list}.` : ''}` }
        }
        const target = args?.['target'] === 'composer' || args?.['target'] === 'active-pane' ? (args['target'] as SavedPromptTarget) : undefined
        const pane = typeof args?.['pane'] === 'string' ? args['pane'] : undefined
        const r = runSavedPrompt(prompt, { source: 'voice', ...(target ? { target } : {}), ...(pane ? { paneTarget: pane } : {}) })
        return { ok: r.ok, text: r.ok ? `OK: ${r.summary}` : `FAILED: ${r.summary}` }
      }
      case 'show_on_board': {
        // B1's stub took `what`; a path in it is honoured too.
        const raw = String(args?.['path'] ?? args?.['what'] ?? '').trim()
        const title = typeof args?.['title'] === 'string' && args['title'].trim() ? args['title'].trim() : undefined
        if (!raw || !/^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(raw)) {
          focusNavTarget({ kind: 'canvas' }, 'voice')
          return { ok: true, text: raw ? `OK: showing the Board. (To post a file, pass its absolute path — "${raw}" is not one.)` : 'OK: showing the Board.' }
        }
        const r = await showOnBoard(raw, title, 'voice')
        return { ok: r.ok, text: r.ok ? `OK: ${r.summary}` : `FAILED: ${r.summary}` }
      }
    }
  } catch (err) {
    return { ok: false, text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }
  }
  return null
}

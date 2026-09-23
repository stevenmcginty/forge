import { isMainAgentTool, MAIN_AGENT_TOOL_SPECS } from '@shared/brain-tools'
import type { VoiceAgentToolDeps } from '../agenttools'
import { describeNavPane, resolveNavTarget, type NavPane } from '../hubnav'
import { getHubRuntime } from '../hubRuntime'
import type { RealtimeToolAnswer } from './session'

/**
 * The main agent's tools, answered — open_agent_pane, type_into_pane,
 * help_prompt, read_pane. The specs are shared/brain-tools.ts; this is the one
 * implementation every brain reaches: realtime brains through
 * `runRealtimeTool`, the Claude session (and B8's CLI brains) through the
 * renderer bridge in ../agenttools.ts, pane agents through main's bridge link.
 *
 * Opening a pane goes through the executor (`open_agent_pane` AppAction →
 * AppState openAgentPane), so it lands exactly where a click on "+" would:
 * a new tab inside Forge, never a window of its own. Never rejects.
 */

export const MAIN_REALTIME_TOOLS = MAIN_AGENT_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters as unknown as Record<string, unknown>
}))

export { isMainAgentTool }

type Resolved = { ok: true; pane: NavPane } | { ok: false; text: string }

/** A spoken target → one pane, with call-signs. Never guesses between two. */
function resolvePane(target: string): Resolved {
  const rt = getHubRuntime()
  if (!rt) return { ok: false, text: 'FAILED: Forge is still starting up.' }
  const said = String(target ?? '').trim() || 'this'
  const hit = resolveNavTarget(said, rt.panes(), rt.focusedPaneId())
  if (hit.kind === 'pane') return { ok: true, pane: hit.pane }
  if (hit.kind === 'ambiguous') {
    return { ok: false, text: `FAILED: more than one pane matches — ${hit.candidates.map(describeNavPane).join('; ')}. Ask which one.` }
  }
  if (hit.kind === 'canvas') return { ok: false, text: 'FAILED: the canvas is not a pane — name a pane.' }
  const list = hit.candidates.map(describeNavPane).join('; ')
  return { ok: false, text: list ? `FAILED: no pane matches "${said}". Open panes: ${list}.` : 'FAILED: no panes are open.' }
}

const label = (p: NavPane): string => (p.callSign ? `${p.callSign} (panel ${p.number})` : `panel ${p.number}`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Bring the pane forward and type into it. A pane in a background tab has no
 * terminal until its tab mounts, so the first attempts can miss; a few short
 * retries cover the mount without ever typing twice.
 */
async function typeInto(pane: NavPane, text: string, submit: boolean): Promise<boolean> {
  const rt = getHubRuntime()
  if (!rt) return false
  rt.revealPane(pane.paneId)
  for (let i = 0; i < 15; i++) {
    if (rt.typeIntoPane(pane.paneId, text, submit)) {
      rt.focusTerminal(pane.paneId)
      return true
    }
    await sleep(200)
  }
  return false
}

export async function runMainAgentTool(
  name: string,
  args: Record<string, unknown>,
  deps: VoiceAgentToolDeps | null
): Promise<RealtimeToolAnswer | null> {
  if (!isMainAgentTool(name)) return null
  try {
    switch (name) {
      case 'open_agent_pane': {
        if (!deps) return { ok: false, text: 'FAILED: Forge’s app tools are not ready yet — try again in a moment.' }
        const outcome = await deps.runAction({
          kind: 'open_agent_pane',
          agent: String(args['agent'] ?? ''),
          ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
          ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
          ...(args['submit'] === true ? { submit: true } : {})
        })
        return { ok: outcome.ok, text: `${outcome.ok ? 'OK' : 'FAILED'}: ${outcome.summary}` }
      }

      case 'type_into_pane':
      case 'help_prompt': {
        const help = name === 'help_prompt'
        const text = String((help ? args['prompt'] : args['text']) ?? '')
        const submit = !help && args['submit'] === true
        if (!text.trim() && !submit) return { ok: false, text: 'FAILED: there is nothing to type.' }
        const found = resolvePane(String(args['target'] ?? ''))
        if (!found.ok) return { ok: false, text: found.text }
        if (!(await typeInto(found.pane, help ? text.replace(/[\r\n]+$/, '') : text, submit))) {
          return { ok: false, text: `FAILED: ${label(found.pane)} has no live terminal, so nothing was typed.` }
        }
        if (help) {
          return {
            ok: true,
            text: `OK: the prompt is typed into ${label(found.pane)}, NOT sent. Ask him whether to send it; on yes call type_into_pane with target "${found.pane.callSign ?? `panel ${found.pane.number}`}", text "" and submit true.`
          }
        }
        if (!text.trim()) return { ok: true, text: `OK: pressed Enter in ${label(found.pane)}.` }
        return { ok: true, text: `OK: typed into ${label(found.pane)}${submit ? ' and pressed Enter' : ' (not sent)'}.` }
      }

      case 'read_pane': {
        if (!deps?.readPane) return { ok: false, text: 'FAILED: reading panes is not available in this build.' }
        // Call-signs are resolved here; the reader itself speaks "terminal N".
        const found = resolvePane(String(args['target'] ?? ''))
        const target = found.ok ? `terminal ${found.pane.number}` : String(args['target'] ?? '')
        if (!found.ok && /more than one/.test(found.text)) return { ok: false, text: found.text }
        const text = await deps.readPane(target, Number(args['lines'] ?? 40))
        return { ok: !text.startsWith('FAILED'), text }
      }
    }
  } catch (err) {
    return { ok: false, text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }
  }
  return null
}

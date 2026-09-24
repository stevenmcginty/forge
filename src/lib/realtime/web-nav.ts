import { hubToolName } from '@shared/hub-tools'
import type { WebVoiceNav, WebVoiceToolAnswer } from '@shared/web'
import type { VoiceAgentToolDeps } from '../agenttools'
import { matchProject } from '../appactions'
import { resolveNavTarget } from '../hubnav'
import { focusNavTarget, getHubRuntime, type HubRuntime } from '../hubRuntime'

/**
 * Navigation asked for by a browser's voice agent (web/src/deck/voiceAgent.ts),
 * answered here and performed there.
 *
 * Which view is on screen, which pane is in front and which project is showing
 * belong to the screen the user is looking at (web/src/deck/view.ts), so a
 * browser saying "show the Wall" must change the browser, not the desktop. The
 * targets are still resolved on this side, by the resolvers every other path
 * uses — `resolveNavTarget` for panes, `matchProject` for projects, the
 * executor's own tab list — and the answer carries a `WebVoiceNav` the page
 * applies to its own deck. Nothing here touches the desktop's view.
 *
 * Only reached when the page sent `WEB_VOICE_NAV_ARG`; every other tool, and
 * every tool from an older page, runs through `runRealtimeTool` as before.
 * The Board is the desktop's alone, so "the board" is left to it too.
 *
 * No React here, so scripts/realtime-check.mjs can import it.
 */

const HERE = 'in this browser'

function ok(text: string, nav: WebVoiceNav): WebVoiceToolAnswer {
  return { ok: true, text: `OK: ${text}`, nav }
}

function failed(text: string): WebVoiceToolAnswer {
  return { ok: false, text: `FAILED: ${text}` }
}

function viewWords(mode: 'tabs' | 'mosaic'): string {
  return mode === 'mosaic' ? `Showing the Wall ${HERE} — every terminal at once` : `Full screen ${HERE} — one terminal at a time`
}

/** A navigation tool, answered with where to go; null for anything that is not navigation. */
export function runWebNavTool(
  name: string,
  args: Record<string, unknown>,
  deps: VoiceAgentToolDeps | null,
  rt: HubRuntime | null = getHubRuntime()
): WebVoiceToolAnswer | null {
  if (name === 'run_app_action') {
    const kind = String(args['kind'] ?? '')
    if (kind === 'set_view') {
      const mode = String(args['mode'] ?? '').toLowerCase()
      if (mode !== 'tabs' && mode !== 'mosaic') return failed('mode must be "tabs" (Full screen) or "mosaic" (the Wall).')
      return ok(viewWords(mode), { view: mode })
    }
    if (kind !== 'switch_project' && kind !== 'focus_tab') return null
    const ctx = deps?.actionContext?.() ?? null
    if (!ctx) return failed('Forge’s app tools are not ready yet — try again in a moment.')
    if (kind === 'switch_project') {
      const said = String(args['name'] ?? '')
      const target = matchProject(ctx.projects, said)
      if (!target) return failed(`No project called “${said}”`)
      return ok(`Switched to ${target.name} ${HERE}`, { projectId: target.id })
    }
    const n = args['index']
    const index = typeof n === 'number' ? Math.floor(n) : Number.parseInt(String(n ?? ''), 10)
    const tab = Number.isFinite(index) && index >= 0 ? ctx.tabs[index] : undefined
    if (!tab) {
      return failed(ctx.tabs.length === 0 ? 'No tabs open' : `There is no tab ${index + 1} — ${ctx.tabs.length} open`)
    }
    return ok(`Switched to “${tab.title}” ${HERE}`, {
      ...(ctx.activeProjectId ? { projectId: ctx.activeProjectId } : {}),
      tabId: tab.id
    })
  }

  if (hubToolName(name) === 'focus_pane_by_name') {
    if (!rt) return failed('Forge is still starting up.')
    const target = resolveNavTarget(String(args['name'] ?? ''), rt.panes(), rt.focusedPaneId())
    if (target.kind === 'canvas') return null
    if (target.kind === 'wall') return ok(viewWords('mosaic'), { view: 'mosaic' })
    if (target.kind === 'pane') {
      const pane = target.pane
      const projectId = rt.activeProjectId()
      return ok(`Went to ${pane.name} ${HERE}.`, {
        ...(projectId ? { projectId } : {}),
        tabId: pane.tabId,
        paneId: pane.paneId
      })
    }
    // Ambiguous, no match, or "canvas": focusNavTarget only words these, and does nothing.
    return failed(focusNavTarget(target, 'voice').summary)
  }

  return null
}

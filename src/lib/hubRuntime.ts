import type { CanvasItem, SavedPrompt, SavedPromptTarget } from '@shared/hub'
import { listTerminals } from '@shared/terminal-names'
import { hubApi } from './hubApi'
import {
  describeNavPane,
  HUB_COMPOSER_EVENT,
  HUB_FOCUS_EVENT,
  resolveNavTarget,
  type HubComposerDetail,
  type HubFocusDetail,
  type HubFocusSource,
  type NavPane,
  type NavTarget
} from './hubnav'

/**
 * The hub's verbs — go to a pane, the Wall or the Board, run a saved prompt,
 * put a file on the Board — callable from anywhere: the keymap, the voice tools
 * (src/lib/realtime/tools-hub.ts), a button.
 *
 * They need the live app (panes, focus, the terminal host), which lives in
 * React. `useHubRuntime` (mounted once, from useShortcuts) registers a
 * snapshot provider here and keeps it current, so the verbs themselves take
 * plain arguments and no React.
 */

export interface HubRuntime {
  /** Every pane in the active project, in the manifest's order, each by its one name. */
  panes(): NavPane[]
  focusedPaneId(): string | null
  activeProjectId(): string | null
  prompts(): SavedPrompt[]
  /** Bring the pane's tab forward and make it the active pane. */
  revealPane(paneId: string): void
  /** Put keyboard focus in the pane's terminal (after it has mounted). */
  focusTerminal(paneId: string): void
  /** Type (or paste, for multi-line text) into a pane. False = the pane is not there. */
  typeIntoPane(paneId: string, text: string, submit: boolean): boolean
}

let runtime: HubRuntime | null = null

export function setHubRuntime(rt: HubRuntime | null): void {
  runtime = rt
}

export function getHubRuntime(): HubRuntime | null {
  return runtime
}

function emitFocus(detail: HubFocusDetail): void {
  window.dispatchEvent(new CustomEvent<HubFocusDetail>(HUB_FOCUS_EVENT, { detail }))
}

/**
 * How to switch the terminals between Full screen ('tabs') and the Wall
 * ('mosaic'). The voice tools pass one built on the voice agent's own
 * `set_view` action (tools-hub.ts), so a spoken "go to the wall" lands exactly
 * where the Wall button or Ctrl+G would.
 */
export interface NavViews {
  setViewMode(mode: 'tabs' | 'mosaic'): void
}

/** What "canvas" is answered with. The brain asks it; nothing is guessed. */
export const WALL_OR_BOARD =
  '"Canvas" could mean the Wall (every terminal at once) or the Board (agent images and artifacts). Ask him: the Wall or the Board?'

/** Perform a resolved target. Answers one sentence saying what happened. */
export function focusNavTarget(
  target: NavTarget,
  source: HubFocusSource,
  views?: NavViews
): { ok: boolean; summary: string } {
  const rt = runtime
  if (target.kind === 'canvas') {
    emitFocus({ kind: 'canvas', source })
    return { ok: true, summary: 'Showing the Board.' }
  }
  if (target.kind === 'wall') {
    if (!views) return { ok: false, summary: 'The Wall cannot be opened from here — press Ctrl+G or use the Wall button on the strip.' }
    views.setViewMode('mosaic')
    emitFocus({ kind: 'wall', source })
    return { ok: true, summary: 'Showing the Wall — every terminal at once.' }
  }
  if (target.kind === 'which_view') return { ok: false, summary: WALL_OR_BOARD }
  if (target.kind === 'ambiguous') {
    return { ok: false, summary: `More than one terminal matches: ${listTerminals(target.candidates)}. Which one?` }
  }
  if (target.kind === 'none') {
    const list = listTerminals(target.candidates)
    return { ok: false, summary: list ? `No terminal by that name. Open now: ${list}.` : 'No terminals are open.' }
  }
  if (!rt) return { ok: false, summary: 'Forge is still starting up.' }
  const pane = target.pane
  rt.revealPane(pane.paneId)
  // The tab may only now be mounting; give it a frame before focusing xterm.
  requestAnimationFrame(() => requestAnimationFrame(() => rt.focusTerminal(pane.paneId)))
  emitFocus({
    kind: 'pane',
    paneId: pane.paneId,
    tabId: pane.tabId,
    number: pane.number,
    name: pane.name,
    callSign: pane.name,
    source
  })
  return { ok: true, summary: `Went to ${pane.name}.` }
}

/** "Zeb", "panel 4", "the wall", "the board" → go there. */
export function goTo(spoken: string, source: HubFocusSource, views?: NavViews): { ok: boolean; summary: string } {
  const rt = runtime
  if (!rt) return { ok: false, summary: 'Forge is still starting up.' }
  return focusNavTarget(resolveNavTarget(spoken, rt.panes(), rt.focusedPaneId()), source, views)
}

export function listPanesWithNames(): string {
  const panes = runtime?.panes() ?? []
  if (panes.length === 0) return 'No panes are open in this project.'
  return panes.map(describeNavPane).join('\n')
}

/** Find a saved prompt by id or by (loose) title. */
export function findSavedPrompt(query: string, prompts: readonly SavedPrompt[]): SavedPrompt | null {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const byId = prompts.find((p) => p.id.toLowerCase() === q)
  if (byId) return byId
  const exact = prompts.filter((p) => p.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0]!
  const partial = prompts.filter((p) => p.title.toLowerCase().includes(q))
  return partial.length === 1 ? partial[0]! : null
}

/**
 * Run a saved prompt: type it into the focused pane (or `paneTarget`, spoken)
 * or hand it to the composer, as the prompt says unless `target` overrides.
 */
export function runSavedPrompt(
  prompt: SavedPrompt,
  opts: { target?: SavedPromptTarget; paneTarget?: string; source?: HubFocusSource } = {}
): { ok: boolean; summary: string } {
  const where = opts.target ?? prompt.target
  if (where === 'composer') {
    window.dispatchEvent(
      new CustomEvent<HubComposerDetail>(HUB_COMPOSER_EVENT, { detail: { text: prompt.text, submit: Boolean(prompt.submit) } })
    )
    return { ok: true, summary: `Put "${prompt.title}" in the composer.` }
  }
  const rt = runtime
  if (!rt) return { ok: false, summary: 'Forge is still starting up.' }
  let paneId = rt.focusedPaneId()
  let label = 'the focused pane'
  if (opts.paneTarget && opts.paneTarget.trim()) {
    const target = resolveNavTarget(opts.paneTarget, rt.panes(), paneId)
    if (target.kind !== 'pane') return focusNavTarget(target, opts.source ?? 'ui')
    paneId = target.pane.paneId
    label = target.pane.name
  }
  if (!paneId) return { ok: false, summary: 'No pane is focused to type it into.' }
  if (!rt.typeIntoPane(paneId, prompt.text, Boolean(prompt.submit))) {
    return { ok: false, summary: `${label} is not running, so "${prompt.title}" was not typed.` }
  }
  return { ok: true, summary: `Typed "${prompt.title}" into ${label}${prompt.submit ? ' and sent it' : ''}.` }
}

/** Copy a file onto the active project's board and show the board. */
export async function showOnBoard(
  path: string,
  title: string | undefined,
  source: HubFocusSource
): Promise<{ ok: true; item: CanvasItem; summary: string } | { ok: false; summary: string }> {
  const hub = hubApi()
  const projectId = runtime?.activeProjectId() ?? null
  if (!hub) return { ok: false, summary: 'The Board is not available in this build — restart Forge.' }
  if (!projectId) return { ok: false, summary: 'No project is open, so there is no board to put it on.' }
  const result = await hub.canvas.post(projectId, path, title)
  if (!result.ok) return { ok: false, summary: result.error }
  emitFocus({ kind: 'canvas', source })
  return { ok: true, item: result.item, summary: `"${result.item.title}" is on the Board.` }
}

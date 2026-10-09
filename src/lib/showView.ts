/**
 * show_view — switch what Forge's desktop shows (Agents, the Browser, the
 * Board), bring a browser tab to the front, and say in plain words what is on
 * screen now and which tabs are open.
 *
 * The one exception to "an agent never takes the screen from Steve" (see
 * src/components/reader/ReaderOpener.tsx, src/components/hub/BoardArrival.tsx):
 * it runs only when Steve asks to see something — his key (Ctrl+Shift+A,
 * src/components/browser/registerBrowser.tsx), or a brain or pane agent he
 * asked. Every way in goes through `runShowView`, so the words are the same.
 *
 * With view agents it also shows one pane full screen or the Wall, and can
 * maximise Forge's window. It is the only navigation tool that brings a
 * minimised Forge back: focus_pane_by_name, set_view and focus_tab leave it in
 * the mini bar (where "go to Viggo" re-targets the bar) and say so instead
 * (`AWAY_NOTE`).
 *
 * Two halves. `planShowView` is pure — a request and a snapshot in, what to do
 * and what to say out — so scripts/show-view-check.mjs holds every rule.
 * `runShowView` builds the snapshot from the live app, applies the plan and
 * brings Forge's window back if it was minimised. It loads the app on first
 * use rather than importing it: scripts/realtime-check.mjs imports the tool
 * modules headless.
 */

import { resolveTerminal } from '@shared/terminal-names'
import { resolveNavTarget, type NavPane } from './hubnav'

export type ShowViewName = 'agents' | 'browser' | 'board'

export interface ShowViewRequest {
  view?: unknown
  /** A browser tab id (browser_list / browser_open); implies view 'browser'. */
  tab?: unknown
  /** A pane, by name as focus_pane_by_name takes it; implies view 'agents'. */
  pane?: unknown
  /** 'full' (one pane full screen) or 'wall'; implies view 'agents'. */
  layout?: unknown
  /** Also maximise Forge's window. */
  maximise?: unknown
}

/** A pane as focus_pane_by_name resolves it, plus the project it is in. */
export type ShowViewPane = NavPane & { project: string }

export interface ShowViewTab {
  id: string
  /** '' = shown in every project. */
  project: string
  url: string
  title: string
  owner: { id: string; label: string }
  createdAt: number
}

export interface ShowViewSnapshot {
  /** The mode on screen: 'agents', or a registered surface id. */
  mode: string
  /** Every registered surface. */
  surfaces: Array<{ id: string; title: string }>
  /** The project on screen, or null. */
  project: { id: string; name: string } | null
  projects: Array<{ id: string; name: string }>
  /** Every browser tab in every project; null when the tab list could not be read. */
  tabs: ShowViewTab[] | null
  /** Why `tabs` is null, in a few words. */
  browserProblem?: string
  /** The tab last in front in the browser, if any. */
  front: string | null
  /** Every pane in every loaded project; each project's in its manifest order. */
  panes?: ShowViewPane[]
  /** The active pane of the project on screen — the one the mini bar talks to. */
  activePane?: string | null
  /** The project on screen's layout: 'tabs' (Full screen) or 'mosaic' (the Wall). */
  viewMode?: 'tabs' | 'mosaic'
}

/** Why nothing was switched — the key path words its notice from this. */
export type ShowViewReason =
  | 'no-tabs'
  | 'none-here'
  | 'no-such-tab'
  | 'unavailable'
  | 'unknown-view'
  | 'no-such-pane'
  | 'no-panes'
  | 'agents-only'
  | null

export interface ShowViewPlan {
  /** The mode to switch to; null to leave it. */
  switchTo: string | null
  /** The browser tab to bring to the front; null to leave it. */
  frontTab: string | null
  /** The project to switch to first; null to stay. */
  switchProject: string | null
  /** The pane to make active (in `switchProject`, if set); null to leave it. */
  revealPane: string | null
  /** The layout to set; null to leave it. */
  viewMode: 'tabs' | 'mosaic' | null
  /** Maximise Forge's window as well. */
  maximise: boolean
  ok: boolean
  text: string
  reason: ShowViewReason
}

/** At most this many tabs per group, then "+N more". */
export const SHOW_VIEW_LIST_MAX = 8
/** Tab titles are cut to about this many characters. */
export const SHOW_VIEW_TITLE_MAX = 60

const MODE_WORDS: Record<string, string> = { agents: 'Agents', browser: 'the Browser', board: 'the Board', read: 'the Read view' }

function modeWords(id: string, snap: ShowViewSnapshot): string {
  if (MODE_WORDS[id]) return MODE_WORDS[id]
  const title = snap.surfaces.find((s) => s.id === id)?.title
  return title ? `the ${title}` : 'Agents'
}

function clip(text: string, max = SHOW_VIEW_TITLE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const titleOf = (t: ShowViewTab): string => `"${clip(t.title) || '(untitled)'}"`
const whose = (t: ShowViewTab): string => (t.owner.id === 'user' ? 'yours' : `agent: ${t.owner.label || t.owner.id}`)

function listOf<T>(items: T[], words: (t: T) => string): string {
  const shown = items.slice(0, SHOW_VIEW_LIST_MAX).map(words)
  const more = items.length - shown.length
  return more > 0 ? `${shown.join(' · ')} · +${more} more` : shown.join(' · ')
}

function projectName(id: string, snap: ShowViewSnapshot): string {
  return snap.projects.find((p) => p.id === id)?.name ?? 'another project'
}

/** "Other projects: 2 tabs — [id] "title" in Forge · …." — or '' when there are none. */
function othersLine(others: ShowViewTab[], snap: ShowViewSnapshot): string {
  if (!others.length) return ''
  const n = `${others.length} tab${others.length === 1 ? '' : 's'}`
  return `Other projects: ${n} — ${listOf(others, (t) => `[${t.id}] ${titleOf(t)} in ${projectName(t.project, snap)}`)}.`
}

const join = (...parts: string[]): string => parts.filter(Boolean).join(' ')

export function planShowView(request: ShowViewRequest, snap: ShowViewSnapshot): ShowViewPlan {
  const tab = typeof request.tab === 'string' ? request.tab.trim() : ''
  const said = typeof request.view === 'string' ? request.view.trim() : ''
  const view = tab ? 'browser' : said.toLowerCase()
  const stays = `The desktop stays on ${modeWords(snap.mode, snap)}.`
  const has = (id: string): boolean => snap.surfaces.some((s) => s.id === id)
  const maximise = request.maximise === true
  const none = { switchTo: null, frontTab: null, switchProject: null, revealPane: null, viewMode: null, maximise: false }
  const refuse = (text: string, reason: ShowViewReason): ShowViewPlan => ({ ...none, ok: false, text, reason })

  // A pane or a layout is about the agent panes, so view agents (or none).
  const pane = typeof request.pane === 'string' ? request.pane.trim() : ''
  const layout = typeof request.layout === 'string' ? request.layout.trim().toLowerCase() : ''
  if (pane || layout) {
    if (tab || (view && view !== 'agents')) return refuse(join('Use view agents with pane or layout.', stays), 'agents-only')
    return planPane(pane, layout, maximise, snap, stays, refuse)
  }

  if (view === 'agents') {
    const already = snap.mode === 'agents'
    return { ...none, switchTo: already ? null : 'agents', maximise, ok: true, text: already ? 'Already showing Agents.' : 'Desktop now shows Agents.', reason: null }
  }

  if (view === 'board') {
    if (!has('board')) return refuse(join('The Board is not available in this Forge right now.', stays), 'unavailable')
    const already = snap.mode === 'board'
    return { ...none, switchTo: already ? null : 'board', maximise, ok: true, text: already ? 'Already showing the Board.' : 'Desktop now shows the Board.', reason: null }
  }

  if (view !== 'browser') return refuse(join(`Unknown view "${said}". Use agents, browser or board.`, stays), 'unknown-view')

  // The browser: it has to be there, and its tabs readable.
  const problem = !has('browser') ? 'the Browser view is not registered' : snap.tabs === null ? snap.browserProblem || 'the tab list could not be read' : ''
  if (problem || snap.tabs === null) {
    return refuse(join(`The Browser view is not available in this Forge right now (${problem}). A Forge restart usually fixes it.`, stays), 'unavailable')
  }

  const all = [...snap.tabs].sort((a, b) => a.createdAt - b.createdAt)
  if (!all.length) {
    return refuse(join('No browser tabs are open, so there is nothing to show.', stays, 'browser_open opens one.'), 'no-tabs')
  }

  const hereId = snap.project?.id ?? ''
  let projectId = hereId
  let switchProject: string | null = null
  let wanted: ShowViewTab | null = null

  if (tab) {
    wanted = all.find((t) => t.id === tab) ?? null
    if (!wanted) {
      const words = (t: ShowViewTab): string =>
        `[${t.id}] ${titleOf(t)}${t.project && t.project !== hereId ? ` in ${projectName(t.project, snap)}` : ''}`
      return refuse(join(`No tab ${tab}. Open tabs: ${listOf(all, words)}.`, stays), 'no-such-tab')
    }
    if (wanted.project && wanted.project !== hereId) {
      projectId = wanted.project
      switchProject = wanted.project
    }
  }

  const inProject = (t: ShowViewTab): boolean => !t.project || t.project === projectId
  const here = all.filter(inProject)
  const others = all.filter((t) => !inProject(t))

  if (!here.length) {
    const name = snap.project?.name ?? 'no project'
    return refuse(
      join(`No browser tabs in this project (${name}).`, stays, othersLine(others, snap), 'Call show_view with tab to show one.'),
      'none-here'
    )
  }

  const kept = snap.front ? here.find((t) => t.id === snap.front) ?? null : null
  const front = wanted ?? kept ?? here[here.length - 1]!
  const already = snap.mode === 'browser' && !switchProject && (!wanted || kept?.id === wanted.id)
  const lead = already
    ? 'Already showing the Browser.'
    : switchProject
      ? `Desktop now shows the Browser, in project ${projectName(switchProject, snap)}.`
      : 'Desktop now shows the Browser.'
  return {
    ...none,
    switchTo: snap.mode === 'browser' ? null : 'browser',
    frontTab: front.id,
    switchProject,
    maximise,
    ok: true,
    text: join(
      lead,
      `In front: [${front.id}] ${titleOf(front)} ${front.url} (${whose(front)}).`,
      `Open here: ${listOf(here, (t) => `[${t.id}] ${titleOf(t)} (${whose(t)})`)}.`,
      othersLine(others, snap)
    ),
    reason: null
  }
}

/**
 * view agents with a pane and/or a layout. The pane is found the way
 * focus_pane_by_name finds it (`resolveNavTarget` over the project on screen);
 * failing that, by name in the other open projects (`resolveTerminal`, the
 * name matcher underneath it), and Forge switches project to show it.
 */
function planPane(
  spoken: string,
  layoutSaid: string,
  maximise: boolean,
  snap: ShowViewSnapshot,
  stays: string,
  refuse: (text: string, reason: ShowViewReason) => ShowViewPlan
): ShowViewPlan {
  if (layoutSaid && layoutSaid !== 'full' && layoutSaid !== 'wall') {
    return refuse(join(`Unknown layout "${layoutSaid}". Use full or wall.`, stays), 'unknown-view')
  }
  const hereId = snap.project?.id ?? ''
  const all = snap.panes ?? []
  const here = all.filter((p) => p.project === hereId)
  const named = (p: ShowViewPane): string => (p.project === hereId ? p.name : `${p.name} in ${projectName(p.project, snap)}`)
  let wall = layoutSaid === 'wall'
  let target: ShowViewPane | null = null

  if (spoken) {
    const hit = resolveNavTarget(spoken, here, snap.activePane ?? null)
    if (hit.kind === 'pane') target = hit.pane as ShowViewPane
    else if (hit.kind === 'wall') wall = true
    else if (hit.kind === 'canvas' || hit.kind === 'which_view') {
      return refuse(join(`"${spoken}" is not a pane. For the Board, use view board.`, stays), 'no-such-pane')
    } else if (hit.kind === 'ambiguous') {
      return refuse(join(`More than one pane matches "${spoken}": ${hit.candidates.map((p) => p.name).join(', ')}. Which one?`, stays), 'no-such-pane')
    } else {
      const far = resolveTerminal(spoken, all.filter((p) => p.project !== hereId))
      if (far.kind === 'ambiguous') {
        return refuse(join(`More than one pane matches "${spoken}": ${far.matches.map(named).join(', ')}. Which one?`, stays), 'no-such-pane')
      }
      if (far.kind === 'none') {
        const list = all.length ? `Panes: ${listOf(all, named)}.` : 'No panes are open.'
        return refuse(join(`No pane called "${spoken}".`, list, stays), 'no-such-pane')
      }
      target = far.pane
    }
  }

  const projectId = target?.project ?? hereId
  const switchProject = projectId !== hereId ? projectId : null
  const inProject = all.filter((p) => p.project === projectId)
  if (!wall && !target) {
    // Full screen with no pane named: the active one, the one the mini bar talks to.
    target = here.find((p) => p.paneId === snap.activePane) ?? here[0] ?? null
    if (!target) return refuse(join('No agent panes are open, so there is nothing to show full screen.', stays), 'no-panes')
  }
  if (wall && !inProject.length) return refuse(join('No agent panes are open, so there is no Wall to show.', stays), 'no-panes')

  const mode = wall ? 'mosaic' : 'tabs'
  const where = switchProject ? `, in project ${projectName(switchProject, snap)}` : ''
  const n = `${inProject.length} pane${inProject.length === 1 ? '' : 's'}`
  return {
    switchTo: snap.mode === 'agents' ? null : 'agents',
    frontTab: null,
    switchProject,
    revealPane: target?.paneId ?? null,
    viewMode: switchProject || (snap.viewMode ?? 'tabs') !== mode ? mode : null,
    maximise,
    ok: true,
    text: wall ? `Showing the Wall (${n})${where}.` : `Showing ${target!.name} full screen${where}.`,
    reason: null
  }
}

/* ------------------------------------------------------------ the runner */

export interface ShowViewResult {
  ok: boolean
  text: string
}

/** The words Steve's own key shows when nothing was switched. */
function noticeFor(plan: ShowViewPlan, openKey: string | null): string {
  const opens = openKey ? `${openKey} opens one.` : '"Open a browser" in the command list opens one.'
  if (plan.reason === 'no-tabs') return `No browser tabs open. ${opens}`
  if (plan.reason === 'none-here') return `No browser tabs in this project. ${opens}`
  return plan.text
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Plan and apply one show_view. `notice` is for Steve's key: when nothing is
 * switched, the reason shows as a notice on screen (agents get the words only).
 * Never rejects.
 */
export async function runShowView(request: ShowViewRequest, opts: { notice?: boolean } = {}): Promise<ShowViewResult> {
  try {
    const [{ shellMode, surfacesNow }, { uiCommands }, { browserBridge }, { browserFront }, { readLiveApp }] = await Promise.all([
      import('./shellSlots'),
      import('./uiCommands'),
      import('../components/browser/bridge'),
      import('../components/browser/browserFront'),
      import('../state/AppState')
    ])
    const surfaces = surfacesNow().map((s) => ({ id: s.id, title: s.title }))
    const on = shellMode.get()
    const app = readLiveApp()
    const st = app?.get() ?? null
    const active = st?.activeProjectId ? (st.projects.find((p) => p.id === st.activeProjectId) ?? null) : null

    let tabs: ShowViewTab[] | null = null
    let browserProblem: string | undefined
    const tabAsked = typeof request.tab === 'string' && request.tab.trim() !== ''
    const view = typeof request.view === 'string' ? request.view.trim().toLowerCase() : ''
    if (tabAsked || view === 'browser') {
      const api = browserBridge()
      if (!api) browserProblem = 'its preload is older than the browser'
      else {
        try {
          tabs = (await api.list()).map((t) => ({
            id: t.id,
            project: t.project ?? '',
            url: t.url,
            title: t.title,
            owner: { id: t.owner.id, label: t.owner.label },
            createdAt: t.createdAt
          }))
        } catch (err) {
          browserProblem = `the tab list failed: ${errText(err)}`
        }
      }
    }

    // The panes, for a pane or a layout: every loaded project's, as the hub names them.
    let panes: ShowViewPane[] = []
    const ws = st?.activeProjectId ? st.workspaces[st.activeProjectId] : undefined
    const paneAsked = [request.pane, request.layout].some((v) => typeof v === 'string' && v.trim() !== '')
    if (paneAsked && st) {
      const { buildActionPanes } = await import('./actionPanes')
      panes = Object.entries(st.workspaces).flatMap(([project, w]) =>
        buildActionPanes(w, st.settings.agentProfiles).map((p) => ({ ...p, project }))
      )
    }

    const plan = planShowView(request, {
      mode: on && surfaces.some((s) => s.id === on) ? on : 'agents',
      surfaces,
      project: active ? { id: active.id, name: active.name } : null,
      projects: (st?.projects ?? []).map((p) => ({ id: p.id, name: p.name })),
      tabs,
      ...(browserProblem ? { browserProblem } : {}),
      front: browserFront.front(),
      panes,
      activePane: ws?.tabs.find((t) => t.id === ws.activeTabId)?.activePaneId ?? null,
      viewMode: ws?.viewMode ?? 'tabs'
    })

    if (!plan.ok) {
      if (opts.notice && app) {
        const [{ keyForCommand }, { formatCombo }] = await Promise.all([import('./keymapRegistry'), import('./keymap')])
        const key = keyForCommand('ui.open-browser')
        app.actions.setNotice(noticeFor(plan, key ? formatCombo(key) : null))
      }
      return { ok: false, text: plan.text }
    }

    if (plan.switchProject || plan.revealPane || plan.viewMode) {
      if (!app) return { ok: false, text: 'Forge is still starting up, so nothing was switched.' }
      // In this order, as the mini bar does it: the project, then the pane in it, then its layout.
      if (plan.switchProject) app.actions.selectProject(plan.switchProject)
      if (plan.revealPane) {
        app.actions.revealPane(plan.revealPane)
        app.actions.focusPane(plan.revealPane)
      }
      if (plan.viewMode) app.actions.setViewMode(plan.viewMode)
    }
    if (plan.frontTab) browserFront.request(plan.frontTab)
    if (plan.switchTo && !uiCommands.run('set-mode', plan.switchTo)) {
      return { ok: false, text: 'Forge’s desktop is still starting up, so nothing was switched.' }
    }

    // Steve asked to see it: a minimised (or mini bar) Forge comes back, and is
    // maximised if he said so. An older preload has no way to ask, and an older
    // main answers a bare boolean; the switch stands without the words.
    let back = false
    let maximised = false
    try {
      const r: unknown = await window.forge?.window?.revealIfAway?.({ maximise: plan.maximise })
      back = r === true || (typeof r === 'object' && r !== null && (r as { back?: unknown }).back === true)
      maximised = typeof r === 'object' && r !== null && (r as { maximised?: unknown }).maximised === true
    } catch {
      back = false
    }
    // Keyboard focus into the pane once the window is up, as goTo does; its tab may only now be mounting.
    const paneId = plan.revealPane
    if (paneId) {
      const { terminalHost } = await import('./terminals')
      requestAnimationFrame(() => requestAnimationFrame(() => terminalHost.focus(paneId)))
    }
    return {
      ok: true,
      text: join(plan.text, back ? 'Forge was minimised; it is back on screen.' : '', maximised ? "Forge's window is maximised." : '')
    }
  } catch (err) {
    return { ok: false, text: `Nothing was switched: ${errText(err)}` }
  }
}

/* ------------------------------------------------ is Forge minimised? */

/** What focus_pane_by_name, set_view and focus_tab add while Forge is minimised. */
export const AWAY_NOTE = 'Forge is minimised, so this is not on screen. Use show_view to bring it up.'

/**
 * Main's mini bar mode (electron/minibar-window.ts): on the moment the main
 * window is minimised, off the moment it is back. Not `document.visibilityState`:
 * the main window runs with backgroundThrottling off, which keeps the page
 * "visible" while minimised. Heard from module load, so a minimise before the
 * first tool call is not missed. Off with the mini bar setting off.
 */
let away = false
if (typeof window !== 'undefined') {
  window.forge?.minibarHost?.onMode?.((m) => {
    away = m?.on === true
  })
}

/** True while Forge's main window is minimised (to the mini bar). */
export function forgeIsAway(): boolean {
  return away
}

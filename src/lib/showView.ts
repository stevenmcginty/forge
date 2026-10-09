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
 * Two halves. `planShowView` is pure — a request and a snapshot in, what to do
 * and what to say out — so scripts/show-view-check.mjs holds every rule.
 * `runShowView` builds the snapshot from the live app, applies the plan and
 * brings Forge's window back if it was minimised. It loads the app on first
 * use rather than importing it: scripts/realtime-check.mjs imports the tool
 * modules headless.
 */

export type ShowViewName = 'agents' | 'browser' | 'board'

export interface ShowViewRequest {
  view?: unknown
  /** A browser tab id (browser_list / browser_open); implies view 'browser'. */
  tab?: unknown
}

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
}

/** Why nothing was switched — the key path words its notice from this. */
export type ShowViewReason = 'no-tabs' | 'none-here' | 'no-such-tab' | 'unavailable' | 'unknown-view' | null

export interface ShowViewPlan {
  /** The mode to switch to; null to leave it. */
  switchTo: string | null
  /** The browser tab to bring to the front; null to leave it. */
  frontTab: string | null
  /** The project to switch to first; null to stay. */
  switchProject: string | null
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

function listOf(tabs: ShowViewTab[], words: (t: ShowViewTab) => string): string {
  const shown = tabs.slice(0, SHOW_VIEW_LIST_MAX).map(words)
  const more = tabs.length - shown.length
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
  const none = { switchTo: null, frontTab: null, switchProject: null }
  const refuse = (text: string, reason: ShowViewReason): ShowViewPlan => ({ ...none, ok: false, text, reason })

  if (view === 'agents') {
    const already = snap.mode === 'agents'
    return { ...none, switchTo: already ? null : 'agents', ok: true, text: already ? 'Already showing Agents.' : 'Desktop now shows Agents.', reason: null }
  }

  if (view === 'board') {
    if (!has('board')) return refuse(join('The Board is not available in this Forge right now.', stays), 'unavailable')
    const already = snap.mode === 'board'
    return { ...none, switchTo: already ? null : 'board', ok: true, text: already ? 'Already showing the Board.' : 'Desktop now shows the Board.', reason: null }
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
    switchTo: snap.mode === 'browser' ? null : 'browser',
    frontTab: front.id,
    switchProject,
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

    const plan = planShowView(request, {
      mode: on && surfaces.some((s) => s.id === on) ? on : 'agents',
      surfaces,
      project: active ? { id: active.id, name: active.name } : null,
      projects: (st?.projects ?? []).map((p) => ({ id: p.id, name: p.name })),
      tabs,
      ...(browserProblem ? { browserProblem } : {}),
      front: browserFront.front()
    })

    if (!plan.ok) {
      if (opts.notice && app) {
        const [{ keyForCommand }, { formatCombo }] = await Promise.all([import('./keymapRegistry'), import('./keymap')])
        const key = keyForCommand('ui.open-browser')
        app.actions.setNotice(noticeFor(plan, key ? formatCombo(key) : null))
      }
      return { ok: false, text: plan.text }
    }

    if (plan.switchProject) {
      if (!app) return { ok: false, text: 'Forge is still starting up, so nothing was switched.' }
      app.actions.selectProject(plan.switchProject)
    }
    if (plan.frontTab) browserFront.request(plan.frontTab)
    if (plan.switchTo && !uiCommands.run('set-mode', plan.switchTo)) {
      return { ok: false, text: 'Forge’s desktop is still starting up, so nothing was switched.' }
    }

    // Steve asked to see it: a minimised (or mini bar) Forge comes back. An
    // older preload has no way to ask; the switch stands without the words.
    let back = false
    try {
      back = (await window.forge?.window?.revealIfAway?.()) === true
    } catch {
      back = false
    }
    return { ok: true, text: back ? `${plan.text} Forge was minimised; it is back on screen.` : plan.text }
  } catch (err) {
    return { ok: false, text: `Nothing was switched: ${errText(err)}` }
  }
}

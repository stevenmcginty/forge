import { useEffect, useRef, useState } from 'react'
import { isPermissionMode, permissionModes } from '@shared/agents'
import type { AgentProfile, ClaudePermissionMode, Project, TerminalTab } from '@shared/types'
import type { LinkPicture } from '../lib/link'
import { leavesOf } from './Browser'

/**
 * The wall's management menu — a visitor, not a resident.
 *
 * The watchroom's whole register is calm observation, so everything that
 * *changes* the desktop lives behind one burger at the top and arrives as a
 * modal walked entirely by D-pad: a stack of single lists, one decision per
 * screen, Back peeling one layer at a time. Four verbs and no settings sprawl:
 * new tab, new terminal, close terminal, close tab.
 *
 * Two rules carried over from the rest of the app:
 *
 *  - **The phone's choices, not a new set.** Picking an agent offers exactly
 *    what NewTab.tsx offers — the desktop's profiles, then the permission
 *    ladder only for agents that have one, preselected on what the profile
 *    would do anyway, bypass in red wherever it appears.
 *  - **Destruction gets one honest gate.** Closing a terminal or a tab lands on
 *    a confirm screen that names the thing, says in words whether it is working
 *    right now, and preselects Cancel — a remote misfire from the sofa must
 *    cost two deliberate presses, not none. Red is spent here and only here.
 *
 * The menu never mutates anything itself: every ending funnels into a callback
 * that TvDashboard turns into `op` frames, because the socket and the toast
 * belong to the wall.
 */

type Verb = 'new-tab' | 'new-pane' | 'close-pane' | 'close-tab'

interface Step {
  kind: 'root' | 'project' | 'tab' | 'pane' | 'agent' | 'mode' | 'confirm'
  verb?: Verb
  projectId?: string
  tabId?: string
  paneId?: string
  profileId?: string
  /** The roving selection, owned by the step so Back restores it. */
  index: number
}

/** One selectable line. `sub` is the dim right-hand meta, words not colour. */
interface MenuRow {
  id: string
  label: string
  sub?: string
  /** Agent badge chip, when the row is a profile. */
  badge?: string
  accent?: string
  /** Red treatment: bypass, and the final "Close it". */
  danger?: boolean
}

const VERB_LABEL: Record<Verb, string> = {
  'new-tab': 'New tab',
  'new-pane': 'New terminal',
  'close-pane': 'Close terminal',
  'close-tab': 'Close tab'
}

export interface TvMenuProps {
  picture: LinkPicture
  live: Set<string>
  workingOf: (id: string) => boolean
  onNewTab: (projectId: string, profileId: string, mode?: ClaudePermissionMode) => void
  onNewPane: (projectId: string, tabId: string, paneId: string, profileId: string, mode?: ClaudePermissionMode) => void
  onClosePane: (projectId: string, tabId: string, paneId: string) => void
  onCloseTab: (projectId: string, tabId: string, paneIds: string[]) => void
  onClose: () => void
}

export function TvMenu({
  picture,
  live,
  workingOf,
  onNewTab,
  onNewPane,
  onClosePane,
  onCloseTab,
  onClose
}: TvMenuProps): React.JSX.Element {
  const [steps, setSteps] = useState<Step[]>([{ kind: 'root', index: 0 }])
  const step = steps[steps.length - 1]!
  const listEl = useRef<HTMLDivElement | null>(null)

  /* ------------------------------------------------------------ the picture */

  const projectOf = (id?: string): Project | undefined => picture.projects.find((p) => p.id === id)
  const tabsOf = (projectId?: string): TerminalTab[] =>
    projectId ? (picture.workspaces[projectId]?.tabs ?? []) : []
  const tabOf = (projectId?: string, tabId?: string): TerminalTab | undefined =>
    tabsOf(projectId).find((t) => t.id === tabId)
  const profileOf = (id?: string): AgentProfile | undefined => picture.profiles.find((p) => p.id === id)

  const paneName = (projectId?: string, tabId?: string, paneId?: string): string => {
    const leaf = tabOf(projectId, tabId) && leavesOf(tabOf(projectId, tabId)!.root).find((l) => l.id === paneId)
    return leaf ? leaf.title || profileOf(leaf.profileId)?.name || 'Terminal' : 'Terminal'
  }

  const stateWord = (paneId: string): string =>
    workingOf(paneId) ? 'working' : live.has(paneId) ? 'quiet' : 'not running'

  /** The current step's list. Computed one way, used by paint and keys alike. */
  const rowsOf = (s: Step): MenuRow[] => {
    switch (s.kind) {
      case 'root':
        return (Object.keys(VERB_LABEL) as Verb[]).map((verb) => ({ id: verb, label: VERB_LABEL[verb] }))
      case 'project': {
        // A new tab can land anywhere; every other verb needs a tab to exist.
        const eligible =
          s.verb === 'new-tab'
            ? picture.projects
            : picture.projects.filter((p) => tabsOf(p.id).length > 0)
        return eligible.map((p) => {
          const tabs = tabsOf(p.id)
          const panes = tabs.flatMap((t) => leavesOf(t.root))
          const liveCount = panes.filter((l) => live.has(l.id)).length
          return {
            id: p.id,
            label: p.name,
            sub:
              liveCount > 0
                ? `${liveCount} live`
                : tabs.length > 0
                  ? `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`
                  : 'idle'
          }
        })
      }
      case 'tab':
        return tabsOf(s.projectId).map((t) => {
          const leaves = leavesOf(t.root)
          return {
            id: t.id,
            label: t.title || 'Tab',
            sub: `${leaves.length} ${leaves.length === 1 ? 'terminal' : 'terminals'}`
          }
        })
      case 'pane': {
        const tab = tabOf(s.projectId, s.tabId)
        return (tab ? leavesOf(tab.root) : []).map((leaf) => {
          const profile = profileOf(leaf.profileId)
          return {
            id: leaf.id,
            label: leaf.title || profile?.name || 'Terminal',
            sub: stateWord(leaf.id),
            badge: profile?.badge ?? '··',
            accent: profile?.accent ?? '#444'
          }
        })
      }
      case 'agent':
        return picture.profiles.map((p) => ({ id: p.id, label: p.name, badge: p.badge || '··', accent: p.accent }))
      case 'mode': {
        const profile = profileOf(s.profileId)
        return (profile ? permissionModes(profile.command) : []).map((m) => ({
          id: m.id,
          label: m.label,
          sub: m.note,
          danger: m.danger
        }))
      }
      case 'confirm':
        return [
          { id: 'cancel', label: 'Cancel' },
          {
            id: 'close',
            label: s.verb === 'close-tab' ? 'Close the tab' : 'Close it',
            danger: true
          }
        ]
    }
  }

  const rows = rowsOf(step)

  /* ---------------------------------------------------------------- walking */

  const push = (next: Omit<Step, 'index'>): void => setSteps((s) => [...s, { ...next, index: 0 }])
  const pop = (): void => {
    if (steps.length === 1) onClose()
    else setSteps((s) => s.slice(0, -1))
  }
  const move = (delta: number): void =>
    setSteps((s) => {
      const top = s[s.length - 1]!
      const count = rowsOf(top).length
      if (count === 0) return s
      const index = Math.max(0, Math.min(count - 1, top.index + delta))
      if (index === top.index) return s
      return [...s.slice(0, -1), { ...top, index }]
    })

  /**
   * The profile step is done — either straight to firing (no ladder) or one
   * more list for the permission mode, preselected on the mode the profile
   * would launch in anyway, exactly as the phone's sheet preselects it.
   */
  const chooseProfile = (s: Step, profileId: string): void => {
    const profile = profileOf(profileId)
    const ladder = profile ? permissionModes(profile.command) : []
    if (ladder.length === 0) {
      fire({ ...s, profileId })
      return
    }
    const preset = isPermissionMode(profile?.permissionMode) ? profile!.permissionMode! : 'default'
    const at = Math.max(0, ladder.findIndex((m) => m.id === preset))
    setSteps((prev) => [...prev, { kind: 'mode', verb: s.verb, projectId: s.projectId, tabId: s.tabId, profileId, index: at }])
  }

  /** Every flow's ending. Hands the decision up and closes the visit. */
  const fire = (s: Step, mode?: ClaudePermissionMode): void => {
    const tab = tabOf(s.projectId, s.tabId)
    if (s.verb === 'new-tab' && s.projectId && s.profileId) {
      onNewTab(s.projectId, s.profileId, mode)
    } else if (s.verb === 'new-pane' && s.projectId && tab && s.profileId) {
      // The pane named is the one the desktop splits; the tab's own active
      // pane is always a leaf of that tab, which is the whole requirement.
      onNewPane(s.projectId, tab.id, tab.activePaneId, s.profileId, mode)
    } else if (s.verb === 'close-pane' && s.projectId && tab && s.paneId) {
      onClosePane(s.projectId, tab.id, s.paneId)
    } else if (s.verb === 'close-tab' && s.projectId && tab) {
      onCloseTab(s.projectId, tab.id, leavesOf(tab.root).map((l) => l.id))
    }
    onClose()
  }

  const choose = (s: Step, row: MenuRow): void => {
    switch (s.kind) {
      case 'root': {
        const verb = row.id as Verb
        push({ kind: 'project', verb })
        return
      }
      case 'project':
        if (s.verb === 'new-tab') push({ kind: 'agent', verb: s.verb, projectId: row.id })
        else push({ kind: 'tab', verb: s.verb, projectId: row.id })
        return
      case 'tab':
        if (s.verb === 'new-pane') push({ kind: 'agent', verb: s.verb, projectId: s.projectId, tabId: row.id })
        else if (s.verb === 'close-pane') push({ kind: 'pane', verb: s.verb, projectId: s.projectId, tabId: row.id })
        else push({ kind: 'confirm', verb: s.verb, projectId: s.projectId, tabId: row.id })
        return
      case 'pane':
        push({ kind: 'confirm', verb: s.verb, projectId: s.projectId, tabId: s.tabId, paneId: row.id })
        return
      case 'agent':
        chooseProfile(s, row.id)
        return
      case 'mode':
        fire(s, isPermissionMode(row.id) ? row.id : undefined)
        return
      case 'confirm':
        if (row.id === 'close') fire(s)
        else pop()
        return
    }
  }

  // The remote, while the menu is up. The wall's own listener stands down for
  // the duration (TvDashboard checks the menu before moving its ring), so this
  // one owns every key it understands and lets the rest fall through.
  const stepRef = useRef(step)
  stepRef.current = step
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { key } = event
      if (key === 'Escape') {
        event.preventDefault()
        pop()
        return
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault()
        // The confirm's two buttons sit side by side, so sideways is how they
        // are walked; in the lists, Left is the breadcrumb's direction — back.
        if (stepRef.current.kind === 'confirm') move(key === 'ArrowLeft' ? -1 : 1)
        else if (key === 'ArrowLeft') pop()
        return
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault()
        move(key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (key === 'Enter') {
        event.preventDefault()
        const s = stepRef.current
        const row = rowsRef.current[s.index]
        if (row) choose(s, row)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps])

  // Long lists (fourteen projects) scroll inside the panel; the selection
  // brings the list with it, the same bargain the wall's ring makes.
  useEffect(() => {
    const list = listEl.current
    if (!list) return
    const el = list.children[step.index] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [step.index, step.kind])

  /* ---------------------------------------------------------------- painting */

  const crumbs: string[] = []
  if (step.verb) crumbs.push(VERB_LABEL[step.verb])
  const project = projectOf(step.projectId)
  if (project) crumbs.push(project.name)
  const tab = tabOf(step.projectId, step.tabId)
  if (tab && step.kind !== 'tab') crumbs.push(tab.title || 'Tab')

  const heading =
    step.kind === 'root'
      ? 'Manage'
      : step.kind === 'project'
        ? 'Which project?'
        : step.kind === 'tab'
          ? step.verb === 'close-tab'
            ? 'Which tab to close?'
            : 'Which tab?'
          : step.kind === 'pane'
            ? 'Which terminal?'
            : step.kind === 'agent'
              ? 'Which agent?'
              : step.kind === 'mode'
                ? 'Permissions'
                : step.verb === 'close-tab'
                  ? 'Close this tab?'
                  : 'Close this terminal?'

  // The confirm's honest sentences, spelled out rather than implied by red.
  let confirmName = ''
  let confirmLines: string[] = []
  if (step.kind === 'confirm' && project && tab) {
    if (step.verb === 'close-pane' && step.paneId) {
      const leaves = leavesOf(tab.root)
      confirmName = `${project.name} · ${tab.title || 'Tab'} · ${paneName(step.projectId, step.tabId, step.paneId)}`
      confirmLines = [
        workingOf(step.paneId)
          ? 'It is working right now.'
          : live.has(step.paneId)
            ? 'It is quiet, but its shell is running.'
            : 'It is not running.',
        ...(leaves.length === 1 ? ['It is the last terminal in its tab — the tab closes with it.'] : [])
      ]
    } else if (step.verb === 'close-tab') {
      const leaves = leavesOf(tab.root)
      const working = leaves.filter((l) => workingOf(l.id)).length
      const alive = leaves.filter((l) => live.has(l.id)).length
      confirmName = `${project.name} · ${tab.title || 'Tab'}`
      confirmLines = [
        `It holds ${leaves.length} ${leaves.length === 1 ? 'terminal' : 'terminals'}` +
          (working > 0 ? ` — ${working} working right now.` : alive > 0 ? ` — ${alive} running.` : ', none running.')
      ]
    }
  }

  return (
    <div className="tv-menu-scrim">
      <div
        className={`tv-menu${step.kind === 'confirm' ? ' is-confirm' : ''}`}
        role="dialog"
        aria-label={heading}
      >
        <div className="tv-menu-head">
          {crumbs.length > 0 && <span className="tv-menu-crumbs">{crumbs.join(' · ')}</span>}
          <strong className="tv-menu-title">{heading}</strong>
        </div>

        {step.kind === 'confirm' ? (
          <div className="tv-confirm">
            <span className="tv-confirm-name">{confirmName}</span>
            {confirmLines.map((line, at) => (
              <span key={at} className="tv-confirm-line">
                {line}
              </span>
            ))}
            <div className="tv-confirm-row">
              {rows.map((row, at) => (
                <button
                  key={row.id}
                  type="button"
                  className={`tv-menu-btn${at === step.index ? ' is-focus' : ''}${row.danger ? ' is-danger' : ''}`}
                  onClick={() => choose(step, row)}
                >
                  {row.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="tv-menu-list" ref={listEl} role="menu">
            {rows.map((row, at) => (
              <div
                key={row.id}
                role="menuitem"
                className={`tv-menu-row${at === step.index ? ' is-focus' : ''}${row.danger ? ' is-danger' : ''}`}
                onClick={() => choose(step, row)}
              >
                {row.badge !== undefined && (
                  <span className="tv-badge" style={{ background: row.accent }}>
                    {row.badge}
                  </span>
                )}
                <span className="tv-menu-name">{row.label}</span>
                {row.sub && <span className="tv-menu-sub">{row.sub}</span>}
              </div>
            ))}
            {rows.length === 0 && (
              <div className="tv-menu-empty">
                {step.kind === 'project' ? 'No project has a tab yet.' : 'Nothing here to choose.'}
              </div>
            )}
          </div>
        )}

        <div className="tv-menu-foot">
          {step.kind === 'confirm' ? 'OK chooses · Back goes back' : 'OK chooses · Back steps out'}
        </div>
      </div>
    </div>
  )
}

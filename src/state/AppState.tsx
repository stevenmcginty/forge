import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import type {
  AgentProfile,
  AppInfo,
  LayoutNode,
  Project,
  Settings,
  SplitDirection,
  TerminalTab,
  Workspace
} from '@shared/types'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import { ACCENT_PALETTE, DEFAULT_PROFILE_ID } from '@/lib/agents'
import { makeId } from '@/lib/ids'
import { basename } from '@/lib/paths'
import {
  collectLeaves,
  countLeaves,
  isValidLayout,
  makeLeaf,
  neighbourAfterClose,
  removeLeaf,
  setSplitRatio,
  splitLeaf,
  updateLeaf
} from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'

/* ------------------------------------------------------------------ state */

export interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: Settings
  projects: Project[]
  /** Only projects that have been visited are loaded. */
  workspaces: Record<string, Workspace>
  activeProjectId: string | null
  /** Panes removed from a layout whose shells still need killing. */
  pendingKills: string[]
  /** Last non-fatal problem worth showing in the status bar. */
  notice: string | null
}

const FALLBACK_SETTINGS: Settings = {
  agentProfiles: BUILTIN_AGENT_PROFILES,
  lastProjectId: null,
  railCollapsed: false,
  terminalFontSize: 13,
  terminalFontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  shell: 'pwsh.exe',
  window: { width: 1440, height: 900, maximized: false }
}

const INITIAL: AppState = {
  ready: false,
  info: null,
  settings: FALLBACK_SETTINGS,
  projects: [],
  workspaces: {},
  activeProjectId: null,
  pendingKills: [],
  notice: null
}

type Action =
  | { type: 'hydrate'; info: AppInfo; settings: Settings; projects: Project[]; activeProjectId: string | null }
  | { type: 'workspaceLoaded'; projectId: string; workspace: Workspace }
  | { type: 'selectProject'; projectId: string }
  | { type: 'addProject'; project: Project }
  | { type: 'updateProject'; id: string; patch: Partial<Project> }
  | { type: 'removeProject'; id: string }
  | { type: 'moveProject'; from: number; to: number }
  | { type: 'patchSettings'; patch: Partial<Settings> }
  | { type: 'saveProfile'; profile: AgentProfile }
  | { type: 'deleteProfile'; id: string }
  | { type: 'newTab'; profileId: string }
  | { type: 'closeTab'; tabId: string }
  | { type: 'selectTab'; tabId: string }
  | { type: 'renameTab'; tabId: string; title: string }
  | { type: 'moveTab'; from: number; to: number }
  | { type: 'splitPane'; paneId: string; direction: SplitDirection; profileId: string }
  | { type: 'closePane'; paneId: string }
  | { type: 'focusPane'; paneId: string }
  | { type: 'renamePane'; paneId: string; title: string }
  | { type: 'setRatio'; splitId: string; ratio: number }
  | { type: 'drainKills'; ids: string[] }
  | { type: 'notice'; message: string | null }

/* -------------------------------------------------------------- helpers */

const EMPTY_WORKSPACE: Workspace = { tabs: [], activeTabId: null }

function workspaceOf(state: AppState, projectId: string | null): Workspace {
  if (!projectId) return EMPTY_WORKSPACE
  return state.workspaces[projectId] ?? EMPTY_WORKSPACE
}

function totalPanes(state: AppState): number {
  let n = 0
  for (const ws of Object.values(state.workspaces)) {
    for (const tab of ws.tabs) n += countLeaves(tab.root)
  }
  return n
}

function makeTab(profileId: string, index: number): TerminalTab {
  const leaf = makeLeaf(profileId)
  return {
    id: makeId('tab'),
    title: `Tab ${index + 1}`,
    root: leaf,
    activePaneId: leaf.id
  }
}

/** Replace the active project's workspace through a mapper. */
function mapActiveWorkspace(state: AppState, fn: (ws: Workspace) => Workspace | null): AppState {
  const id = state.activeProjectId
  if (!id) return state
  const current = workspaceOf(state, id)
  const next = fn(current)
  if (!next || next === current) return state
  return { ...state, workspaces: { ...state.workspaces, [id]: next } }
}

function mapActiveTab(state: AppState, fn: (tab: TerminalTab) => TerminalTab | null): AppState {
  return mapActiveWorkspace(state, (ws) => {
    if (!ws.activeTabId) return null
    const idx = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
    if (idx < 0) return null
    const next = fn(ws.tabs[idx]!)
    if (!next || next === ws.tabs[idx]) return null
    const tabs = [...ws.tabs]
    tabs[idx] = next
    return { ...ws, tabs }
  })
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** Trust nothing that came off disk. */
function sanitiseWorkspace(ws: Workspace | null, profileIds: Set<string>): Workspace {
  if (!ws || !Array.isArray(ws.tabs)) return EMPTY_WORKSPACE
  const tabs: TerminalTab[] = []
  for (const tab of ws.tabs) {
    if (!tab || typeof tab.id !== 'string' || !isValidLayout(tab.root)) continue
    // Panes pointing at a profile the user deleted fall back to the default.
    let root: LayoutNode = tab.root
    for (const leaf of collectLeaves(root)) {
      if (!profileIds.has(leaf.profileId)) {
        root = updateLeaf(root, leaf.id, { profileId: DEFAULT_PROFILE_ID })
      }
    }
    const leaves = collectLeaves(root)
    if (leaves.length === 0 || leaves.length > MAX_PANES_PER_TAB) continue
    const activePaneId = leaves.some((l) => l.id === tab.activePaneId) ? tab.activePaneId : leaves[0]!.id
    tabs.push({ id: tab.id, title: typeof tab.title === 'string' ? tab.title : 'Tab', root, activePaneId })
  }
  const activeTabId = tabs.some((t) => t.id === ws.activeTabId) ? ws.activeTabId : (tabs[0]?.id ?? null)
  return { tabs, activeTabId }
}

/* ------------------------------------------------------------- reducer */

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'hydrate':
      return {
        ...state,
        ready: true,
        info: action.info,
        settings: action.settings,
        projects: action.projects,
        activeProjectId: action.activeProjectId
      }

    case 'workspaceLoaded':
      // If the user already opened a terminal while the disk read was in
      // flight, their live workspace wins — never clobber it.
      if (state.workspaces[action.projectId]) return state
      return { ...state, workspaces: { ...state.workspaces, [action.projectId]: action.workspace } }

    case 'selectProject': {
      if (state.activeProjectId === action.projectId) return state
      return {
        ...state,
        activeProjectId: action.projectId,
        settings: { ...state.settings, lastProjectId: action.projectId }
      }
    }

    case 'addProject':
      return {
        ...state,
        projects: [...state.projects, action.project],
        activeProjectId: action.project.id,
        workspaces: { ...state.workspaces, [action.project.id]: EMPTY_WORKSPACE },
        settings: { ...state.settings, lastProjectId: action.project.id }
      }

    case 'updateProject':
      return {
        ...state,
        projects: state.projects.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p))
      }

    case 'removeProject': {
      const ws = workspaceOf(state, action.id)
      const kills = ws.tabs.flatMap((t) => collectLeaves(t.root).map((l) => l.id))
      const projects = state.projects.filter((p) => p.id !== action.id)
      const workspaces = { ...state.workspaces }
      delete workspaces[action.id]
      const activeProjectId =
        state.activeProjectId === action.id ? (projects[0]?.id ?? null) : state.activeProjectId
      return {
        ...state,
        projects,
        workspaces,
        activeProjectId,
        pendingKills: [...state.pendingKills, ...kills],
        settings: { ...state.settings, lastProjectId: activeProjectId }
      }
    }

    case 'moveProject': {
      const projects = move(state.projects, action.from, action.to)
      return projects === state.projects ? state : { ...state, projects }
    }

    case 'patchSettings':
      return { ...state, settings: { ...state.settings, ...action.patch } }

    case 'saveProfile': {
      const exists = state.settings.agentProfiles.some((p) => p.id === action.profile.id)
      const agentProfiles = exists
        ? state.settings.agentProfiles.map((p) => (p.id === action.profile.id ? action.profile : p))
        : [...state.settings.agentProfiles, action.profile]
      return { ...state, settings: { ...state.settings, agentProfiles } }
    }

    case 'deleteProfile': {
      const target = state.settings.agentProfiles.find((p) => p.id === action.id)
      if (!target || target.builtin) return state
      return {
        ...state,
        settings: {
          ...state.settings,
          agentProfiles: state.settings.agentProfiles.filter((p) => p.id !== action.id)
        }
      }
    }

    case 'newTab': {
      if (totalPanes(state) >= MAX_SESSIONS) {
        return { ...state, notice: `Session limit reached (${MAX_SESSIONS})` }
      }
      return mapActiveWorkspace(state, (ws) => {
        const tab = makeTab(action.profileId, ws.tabs.length)
        return { tabs: [...ws.tabs, tab], activeTabId: tab.id }
      })
    }

    case 'closeTab': {
      const ws = workspaceOf(state, state.activeProjectId)
      const tab = ws.tabs.find((t) => t.id === action.tabId)
      if (!tab) return state
      const kills = collectLeaves(tab.root).map((l) => l.id)
      const next = mapActiveWorkspace(state, (current) => {
        const tabs = current.tabs.filter((t) => t.id !== action.tabId)
        const activeTabId =
          current.activeTabId === action.tabId
            ? (tabs[Math.max(0, current.tabs.findIndex((t) => t.id === action.tabId) - 1)]?.id ?? null)
            : current.activeTabId
        return { tabs, activeTabId }
      })
      return { ...next, pendingKills: [...next.pendingKills, ...kills] }
    }

    case 'selectTab':
      return mapActiveWorkspace(state, (ws) =>
        ws.activeTabId === action.tabId ? null : { ...ws, activeTabId: action.tabId }
      )

    case 'renameTab':
      return mapActiveWorkspace(state, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === action.tabId ? { ...t, title: action.title } : t))
      }))

    case 'moveTab':
      return mapActiveWorkspace(state, (ws) => {
        const tabs = move(ws.tabs, action.from, action.to)
        return tabs === ws.tabs ? null : { ...ws, tabs }
      })

    case 'splitPane': {
      if (totalPanes(state) >= MAX_SESSIONS) {
        return { ...state, notice: `Session limit reached (${MAX_SESSIONS})` }
      }
      const ws = workspaceOf(state, state.activeProjectId)
      const tab = ws.tabs.find((t) => t.id === ws.activeTabId)
      if (!tab) return state
      if (countLeaves(tab.root) >= MAX_PANES_PER_TAB) {
        return { ...state, notice: `A tab holds at most ${MAX_PANES_PER_TAB} panes` }
      }
      const leaf = makeLeaf(action.profileId)
      return mapActiveTab(state, (t) => ({
        ...t,
        root: splitLeaf(t.root, action.paneId, action.direction, leaf),
        activePaneId: leaf.id
      }))
    }

    case 'closePane': {
      const ws = workspaceOf(state, state.activeProjectId)
      const tab = ws.tabs.find((t) => t.id === ws.activeTabId)
      if (!tab) return state
      // Closing the last pane of a tab closes the tab.
      if (countLeaves(tab.root) === 1) {
        return reducer(state, { type: 'closeTab', tabId: tab.id })
      }
      const nextFocus = neighbourAfterClose(tab.root, action.paneId)
      const next = mapActiveTab(state, (t) => {
        const root = removeLeaf(t.root, action.paneId)
        if (!root) return null
        return { ...t, root, activePaneId: nextFocus ?? t.activePaneId }
      })
      if (next === state) return state
      return { ...next, pendingKills: [...next.pendingKills, action.paneId] }
    }

    case 'focusPane':
      return mapActiveTab(state, (t) => (t.activePaneId === action.paneId ? null : { ...t, activePaneId: action.paneId }))

    case 'renamePane':
      return mapActiveTab(state, (t) => ({ ...t, root: updateLeaf(t.root, action.paneId, { title: action.title }) }))

    case 'setRatio':
      return mapActiveTab(state, (t) => {
        const root = setSplitRatio(t.root, action.splitId, action.ratio)
        return root === t.root ? null : { ...t, root }
      })

    case 'drainKills': {
      const remaining = state.pendingKills.filter((id) => !action.ids.includes(id))
      return remaining.length === state.pendingKills.length ? state : { ...state, pendingKills: remaining }
    }

    case 'notice':
      return state.notice === action.message ? state : { ...state, notice: action.message }

    default:
      return state
  }
}

/* ------------------------------------------------------------- actions */

export interface AppActions {
  addProject(): Promise<void>
  updateProject(id: string, patch: Partial<Project>): void
  removeProject(id: string): void
  moveProject(from: number, to: number): void
  selectProject(id: string): void
  revealProject(id: string): void
  toggleRail(): void
  setFontSize(size: number): void
  saveProfile(profile: AgentProfile): void
  deleteProfile(id: string): void
  newTab(profileId?: string): void
  closeTab(tabId: string): void
  selectTab(tabId: string): void
  renameTab(tabId: string, title: string): void
  moveTab(from: number, to: number): void
  splitPane(paneId: string, direction: SplitDirection, profileId?: string): void
  closePane(paneId: string): void
  focusPane(paneId: string): void
  renamePane(paneId: string, title: string): void
  setRatio(splitId: string, ratio: number): void
  restartPane(paneId: string): void
  setNotice(message: string | null): void
  openDataDir(): void
}

interface Ctx {
  state: AppState
  actions: AppActions
}

const AppStateContext = createContext<Ctx | null>(null)

/* -------------------------------------------------------------- provider */

export function AppStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const loadingWorkspaces = useRef(new Set<string>())
  const persisted = useRef({
    settings: '' as string,
    projects: '' as string,
    workspaces: new Map<string, string>()
  })

  /* ------------------------------------------------------------ hydrate */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [info, snap] = await Promise.all([window.forge.info(), window.forge.store.snapshot()])
      if (cancelled) return
      const projects = snap.projects
      const wanted = snap.settings.lastProjectId
      const activeProjectId = projects.some((p) => p.id === wanted) ? wanted : (projects[0]?.id ?? null)
      dispatch({ type: 'hydrate', info, settings: snap.settings, projects, activeProjectId })
      persisted.current.settings = JSON.stringify(snap.settings)
      persisted.current.projects = JSON.stringify(projects)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* --------------------------------------------- lazy workspace loading */

  const activeProjectId = state.activeProjectId
  useEffect(() => {
    if (!state.ready || !activeProjectId) return
    if (state.workspaces[activeProjectId] || loadingWorkspaces.current.has(activeProjectId)) return
    loadingWorkspaces.current.add(activeProjectId)
    void (async () => {
      const raw = await window.forge.store.getWorkspace(activeProjectId)
      const profileIds = new Set(state.settings.agentProfiles.map((p) => p.id))
      const workspace = sanitiseWorkspace(raw, profileIds)
      persisted.current.workspaces.set(activeProjectId, JSON.stringify(workspace))
      dispatch({ type: 'workspaceLoaded', projectId: activeProjectId, workspace })
      loadingWorkspaces.current.delete(activeProjectId)
    })()
  }, [state.ready, activeProjectId, state.workspaces, state.settings.agentProfiles])

  /* ------------------------------------------------------- kill draining */

  useEffect(() => {
    if (state.pendingKills.length === 0) return
    const ids = state.pendingKills
    terminalHost.disposeAll(ids)
    dispatch({ type: 'drainKills', ids })
  }, [state.pendingKills])

  /* --------------------------------------------------------- persistence */

  useEffect(() => {
    if (!state.ready) return
    const json = JSON.stringify(state.settings)
    if (json === persisted.current.settings) return
    persisted.current.settings = json
    const t = setTimeout(() => void window.forge.store.setSettings(state.settings), 200)
    return () => clearTimeout(t)
  }, [state.ready, state.settings])

  useEffect(() => {
    if (!state.ready) return
    const json = JSON.stringify(state.projects)
    if (json === persisted.current.projects) return
    persisted.current.projects = json
    const t = setTimeout(() => void window.forge.store.setProjects(state.projects), 200)
    return () => clearTimeout(t)
  }, [state.ready, state.projects])

  useEffect(() => {
    if (!state.ready) return
    const dirty: Array<[string, Workspace, string]> = []
    for (const [projectId, ws] of Object.entries(state.workspaces)) {
      const json = JSON.stringify(ws)
      if (persisted.current.workspaces.get(projectId) !== json) dirty.push([projectId, ws, json])
    }
    if (dirty.length === 0) return
    const t = setTimeout(() => {
      for (const [projectId, ws, json] of dirty) {
        persisted.current.workspaces.set(projectId, json)
        void window.forge.store.setWorkspace(projectId, ws)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [state.ready, state.workspaces])

  /* ------------------------------------------------------- typography sync */

  useEffect(() => {
    if (!state.ready) return
    terminalHost.applyTypography(state.settings.terminalFontSize, state.settings.terminalFontFamily)
  }, [state.ready, state.settings.terminalFontSize, state.settings.terminalFontFamily])

  /* ------------------------------------------------------- notice timeout */

  useEffect(() => {
    if (!state.notice) return
    const t = setTimeout(() => dispatch({ type: 'notice', message: null }), 4200)
    return () => clearTimeout(t)
  }, [state.notice])

  /* -------------------------------------------------------------- actions */

  const defaultProfileFor = useCallback(
    (projectId: string | null): string => {
      const project = state.projects.find((p) => p.id === projectId)
      return project?.defaultProfileId ?? DEFAULT_PROFILE_ID
    },
    [state.projects]
  )

  const actions = useMemo<AppActions>(() => {
    return {
      async addProject() {
        const folder = await window.forge.pickFolder()
        if (!folder) return
        if (state.projects.some((p) => p.path.toLowerCase() === folder.toLowerCase())) {
          const existing = state.projects.find((p) => p.path.toLowerCase() === folder.toLowerCase())!
          dispatch({ type: 'selectProject', projectId: existing.id })
          dispatch({ type: 'notice', message: `${existing.name} is already in the rail` })
          return
        }
        const name = basename(folder)
        const color = ACCENT_PALETTE[state.projects.length % ACCENT_PALETTE.length]!
        dispatch({
          type: 'addProject',
          project: {
            id: makeId('proj'),
            name,
            path: folder,
            color,
            defaultProfileId: DEFAULT_PROFILE_ID,
            createdAt: Date.now()
          }
        })
      },
      updateProject: (id, patch) => dispatch({ type: 'updateProject', id, patch }),
      removeProject: (id) => {
        dispatch({ type: 'removeProject', id })
        void window.forge.store.deleteWorkspace(id)
        persisted.current.workspaces.delete(id)
      },
      moveProject: (from, to) => dispatch({ type: 'moveProject', from, to }),
      selectProject: (id) => dispatch({ type: 'selectProject', projectId: id }),
      revealProject: (id) => {
        const project = state.projects.find((p) => p.id === id)
        if (project) void window.forge.openPath(project.path)
      },
      toggleRail: () => dispatch({ type: 'patchSettings', patch: { railCollapsed: !state.settings.railCollapsed } }),
      setFontSize: (size) =>
        dispatch({ type: 'patchSettings', patch: { terminalFontSize: Math.min(24, Math.max(9, size)) } }),
      saveProfile: (profile) => dispatch({ type: 'saveProfile', profile }),
      deleteProfile: (id) => dispatch({ type: 'deleteProfile', id }),
      newTab: (profileId) => dispatch({ type: 'newTab', profileId: profileId ?? defaultProfileFor(activeProjectId) }),
      closeTab: (tabId) => dispatch({ type: 'closeTab', tabId }),
      selectTab: (tabId) => dispatch({ type: 'selectTab', tabId }),
      renameTab: (tabId, title) => dispatch({ type: 'renameTab', tabId, title }),
      moveTab: (from, to) => dispatch({ type: 'moveTab', from, to }),
      splitPane: (paneId, direction, profileId) =>
        dispatch({
          type: 'splitPane',
          paneId,
          direction,
          profileId: profileId ?? defaultProfileFor(activeProjectId)
        }),
      closePane: (paneId) => dispatch({ type: 'closePane', paneId }),
      focusPane: (paneId) => dispatch({ type: 'focusPane', paneId }),
      renamePane: (paneId, title) => dispatch({ type: 'renamePane', paneId, title }),
      setRatio: (splitId, ratio) => dispatch({ type: 'setRatio', splitId, ratio }),
      restartPane: (paneId) => void terminalHost.restart(paneId),
      setNotice: (message) => dispatch({ type: 'notice', message }),
      openDataDir: () => void window.forge.store.revealDataDir()
    }
  }, [activeProjectId, defaultProfileFor, state.projects, state.settings.railCollapsed])

  const value = useMemo<Ctx>(() => ({ state, actions }), [state, actions])

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

/* ------------------------------------------------------------- selectors */

export function useApp(): Ctx {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useApp must be used inside <AppStateProvider>')
  return ctx
}

export function useActiveProject(): Project | null {
  const { state } = useApp()
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null
}

export function useActiveWorkspace(): Workspace {
  const { state } = useApp()
  return workspaceOf(state, state.activeProjectId)
}

export function useActiveTab(): TerminalTab | null {
  const ws = useActiveWorkspace()
  return ws.tabs.find((t) => t.id === ws.activeTabId) ?? null
}

export function usePaneCount(): { used: number; max: number } {
  const { state } = useApp()
  return { used: totalPanes(state), max: MAX_SESSIONS }
}

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
  ClaudePermissionMode,
  LayoutNode,
  MosaicState,
  MosaicTextMode,
  MosaicTile,
  Project,
  Settings,
  SplitDirection,
  TerminalTab,
  ThemeCore,
  VoiceBrainId,
  VoiceHubPlacement,
  Workspace,
  WorkspaceViewMode
} from '@shared/types'
import {
  BUILTIN_AGENT_PROFILES,
  TAB_NAME_POOL,
  TAB_TEXT_PALETTE,
  isPermissionMode,
  isShellProfile
} from '@shared/agents'
import { isSessionId, newSessionId } from '@shared/session'
import { MOBILE_PORT } from '@shared/mobile'
import { ACCENT_PALETTE, DEFAULT_PROFILE_ID } from '@/lib/agents'
import { applyReducedMotion, applyTheme, findTheme } from '@/theme/themes'
import { makeId } from '@/lib/ids'
import { emptyMosaic, sanitiseMosaic } from '@/lib/mosaicLayout'
import { DEFAULT_HUB, nextHubMode } from '@/lib/voicehub'
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

/** The settings page's sections, in sidebar order. */
export type SettingsSection =
  | 'account'
  | 'agents'
  | 'models'
  | 'voice'
  | 'appearance'
  | 'screenshots'
  | 'mobile'
  | 'updates'
  | 'advanced'

/**
 * What the main area is showing. Settings is a *view*, not a modal: it takes
 * the terminal area over completely, because it is a place you go to work
 * rather than a dialog you dismiss. The terminals keep running behind it — see
 * terminalHost, which owns them independently of what React has mounted.
 */
export type MainView = 'terminals' | 'settings'

/**
 * A command waiting for the pane it was opened for.
 *
 * `openToolPane` creates a tab and the text to put in it in the same dispatch,
 * but the pane does not exist yet at that moment — TerminalGrid has to mount
 * and terminalHost has to spawn a shell first. So the text is parked here and
 * an effect delivers it when the pane comes alive, which is the same shape as
 * `pendingKills` and for the same reason: the reducer describes what should be
 * true, and an effect makes it true against the terminal host.
 */
interface PendingType {
  paneId: string
  text: string
  /** True presses Enter afterwards. See Settings › Updates & Tools. */
  submit: boolean
}

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
  /** Commands typed into panes that are still starting up. */
  pendingTypes: PendingType[]
  /**
   * The mosaic tile currently blown up to full size. Deliberately transient —
   * a peek is not something you want to still be inside after a restart.
   */
  mosaicZoom: string | null
  /**
   * True when the voice hub's mic is armed, i.e. dictated phrases are the
   * agent's rather than the focused pane's. Transient on purpose: booting with
   * the mic already pointed at the agent is not something anyone asked for.
   */
  agentListening: boolean
  /** Last non-fatal problem worth showing in the status bar. */
  notice: string | null
  /** Terminals, or the settings page. */
  view: MainView
  /** Which settings section is open. Remembered across a visit, not a restart. */
  settingsSection: SettingsSection
}

const FALLBACK_SETTINGS: Settings = {
  agentProfiles: BUILTIN_AGENT_PROFILES,
  lastProjectId: null,
  railCollapsed: false,
  terminalFontSize: 13,
  terminalFontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  mosaicText: 'lifesize',
  tabTextColours: true,
  shell: 'pwsh.exe',
  catchShots: true,
  shotsKeep: 12,
  window: { width: 1440, height: 900, maximized: false },
  // True until the real settings arrive, so the welcome overlay cannot flash up
  // for a second on every launch while the store is still being read.
  onboarded: true,
  sttPython: '',
  sttModelDir: '',
  sttAutoStopSeconds: 10,
  sttHotkey: 'ControlRight',
  voiceHub: DEFAULT_HUB,
  voiceOverlayWindow: true,
  voiceBargeIn: true,
  voiceBrain: 'gemini',
  anthropicKey: '',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  accountName: 'You',
  accountColor: '#C6FF4A',
  themeId: 'volt',
  customThemes: [],
  reducedMotion: false,
  themeBg: '#0b0c0e',
  themeInk: '#e8eaed',
  voiceAutoRelay: false,
  voiceRelayGraceMs: 2500,
  voiceReplyMode: 'both',
  voiceReplyVoice: '',
  // Neural speech is the default, and with no key the engine chain in
  // src/lib/tts.ts drops to the local voice on its own — so preferring the good
  // one here cannot leave a keyless install silent.
  voiceEngine: 'gemini',
  voiceTtsVoice: '',
  voiceTtsModel: '',
  voiceEarcons: true,
  projectsRoot: '',
  geminiImageModel: '',
  openrouterKey: '',
  openrouterModel: 'google/gemini-2.5-flash-lite',
  groqKey: '',
  groqModel: 'llama-3.3-70b-versatile',
  memoryLlmSummarize: false,
  // Filled in by the store on hydrate — main knows the real data root.
  skillsLibraryDir: '',
  skillsEnabled: [],
  remoteControlDefault: true,
  resumeSessions: true,
  confirmOnQuit: true,
  // Companion (M9): the phone link, off and unconfigured until Steve says
  // otherwise. This fallback is only ever used before the first snapshot
  // arrives, so "off" is also the only safe answer here.
  companionEnabled: false,
  companionApiKey: '',
  companionDatabaseURL: '',
  companionAuthBase: '',
  companionTokenBase: '',
  companionEmail: '',
  companionRefreshToken: '',
  companionUid: '',
  // Forge Mobile (M11) — off, unpaired, not listening. Mirrors defaultSettings()
  // in electron/store.ts; this fallback is only ever used before the real
  // settings have arrived from main.
  mobileEnabled: false,
  mobilePort: MOBILE_PORT,
  mobileBindHost: '0.0.0.0',
  mobileDevices: [],
  mobileAcceptUntil: 0,
  mobileTunnel: 'off',
  mobileNgrokAuthtoken: '',
  mobileNgrokDomain: '',
  customTools: [],
  updatesAutoRun: false,
  updateDismissedVersion: ''
}

const INITIAL: AppState = {
  ready: false,
  info: null,
  settings: FALLBACK_SETTINGS,
  projects: [],
  workspaces: {},
  activeProjectId: null,
  pendingKills: [],
  pendingTypes: [],
  mosaicZoom: null,
  agentListening: false,
  notice: null,
  view: 'terminals',
  settingsSection: 'account'
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
  | { type: 'newTab'; profileId: string; permissionMode?: ClaudePermissionMode }
  | { type: 'openToolPane'; profileId: string; title: string; text: string; submit: boolean }
  | { type: 'drainTypes'; paneIds: string[] }
  | { type: 'closeTab'; tabId: string }
  | { type: 'selectTab'; tabId: string }
  | { type: 'renameTab'; tabId: string; title: string }
  | { type: 'paintTab'; tabId: string; patch: TabPaint }
  | { type: 'moveTab'; from: number; to: number }
  | {
      type: 'splitPane'
      paneId: string
      direction: SplitDirection
      profileId: string
      permissionMode?: ClaudePermissionMode
    }
  | { type: 'closePane'; paneId: string }
  | { type: 'focusPane'; paneId: string }
  | { type: 'revealPane'; paneId: string }
  | { type: 'renamePane'; paneId: string; title: string }
  | { type: 'setRatio'; splitId: string; ratio: number }
  | { type: 'setViewMode'; mode: WorkspaceViewMode }
  | { type: 'toggleViewMode' }
  | { type: 'setMosaicZoom'; paneId: string | null }
  /**
   * Write boxes onto the freeform wall. `custom` flips the wall out of the auto
   * grid (the caller has just seeded every tile's current position, so nothing
   * visibly moves); `wallTab` marks a tab as having been dragged onto it.
   */
  | { type: 'mosaicTiles'; tiles: Record<string, MosaicTile>; custom?: boolean; wallTab?: string }
  | { type: 'mosaicFit'; paneId: string; fit: boolean }
  | { type: 'mosaicReset' }
  | { type: 'setAgentListening'; on: boolean }
  | { type: 'drainKills'; ids: string[] }
  | { type: 'notice'; message: string | null }
  | { type: 'openSettings'; section?: SettingsSection }
  | { type: 'closeSettings' }
  | { type: 'setSettingsSection'; section: SettingsSection }
  | { type: 'cacheThemeChrome'; bg: string; ink: string }

/* -------------------------------------------------------------- helpers */

const EMPTY_WORKSPACE: Workspace = { tabs: [], activeTabId: null, viewMode: 'tabs' }

function mosaicOf(ws: Workspace): MosaicState {
  return ws.mosaic ?? emptyMosaic()
}

/** Replace the active project's mosaic layout through a mapper. */
function mapMosaic(state: AppState, fn: (m: MosaicState) => MosaicState | null): AppState {
  return mapActiveWorkspace(state, (ws) => {
    const current = mosaicOf(ws)
    const next = fn(current)
    if (!next || next === current) return null
    return { ...ws, mosaic: next }
  })
}

/**
 * Drop wall boxes belonging to panes and tabs that have just been closed.
 *
 * Stale entries are invisible rather than harmful — nothing looks a box up by a
 * dead pane id — but a project worked in for a month would otherwise carry a
 * few hundred of them to disk forever. A wall left with nothing on it goes back
 * to the auto grid, which is the only honest thing an empty custom wall can be.
 */
function withPrunedMosaic(ws: Workspace): Workspace {
  const m = ws.mosaic
  if (!m) return ws
  const livePanes = new Set<string>()
  for (const t of ws.tabs) for (const l of collectLeaves(t.root)) livePanes.add(l.id)
  const liveTabs = new Set(ws.tabs.map((t) => t.id))

  const tiles: Record<string, MosaicTile> = {}
  for (const [id, rect] of Object.entries(m.tiles)) if (livePanes.has(id)) tiles[id] = rect
  const wallTabs = m.wallTabs.filter((id) => liveTabs.has(id))

  const same =
    Object.keys(tiles).length === Object.keys(m.tiles).length && wallTabs.length === m.wallTabs.length
  if (same) return ws
  if (Object.keys(tiles).length === 0) return { ...ws, mosaic: emptyMosaic() }
  return { ...ws, mosaic: { ...m, tiles, wallTabs } }
}

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

/**
 * The terminal-text colour a new tab is born with: the first one nobody in this
 * project is already using, cycling once they are all spoken for.
 *
 * Taken rather than random, because random hands you two near-identical blues
 * often enough to be annoying, and the point of the colour is that no two
 * terminals on the mosaic wall look alike. A tab whose colour the user cleared
 * counts as using none, so the colour it gave up is free again.
 */
function nextTextColor(tabs: TerminalTab[]): string {
  const taken = new Set(tabs.map((t) => t.textColor?.toLowerCase()).filter(Boolean))
  return (
    TAB_TEXT_PALETTE.find((c) => !taken.has(c.toLowerCase())) ??
    TAB_TEXT_PALETTE[tabs.length % TAB_TEXT_PALETTE.length]!
  )
}

/**
 * The name a new tab is born with, and where the project's cursor lands after
 * handing it out: the next name in the pool nobody in this project is already
 * wearing, wrapping when the hundred run out.
 *
 * The cursor only ever moves forward, so closing a tab does not put its name
 * back at the front of the queue — kill Otis and the next tab is whoever comes
 * after Otis, not Otis again. Names in use are skipped rather than duplicated,
 * which also covers the case where the user has renamed a tab by hand onto a
 * name the pool was about to reach.
 */
function nextTabName(tabs: TerminalTab[], cursor: number): { title: string; cursor: number } {
  const taken = new Set(tabs.map((t) => t.title.trim().toLowerCase()))
  const start = ((cursor % TAB_NAME_POOL.length) + TAB_NAME_POOL.length) % TAB_NAME_POOL.length
  for (let i = 0; i < TAB_NAME_POOL.length; i++) {
    const at = (start + i) % TAB_NAME_POOL.length
    const name = TAB_NAME_POOL[at]!
    if (!taken.has(name.toLowerCase())) return { title: name, cursor: at + 1 }
  }
  // A hundred open tabs is well past the session limit, but a name is not worth
  // crashing over: fall back to the next free numbered variant of the one due.
  const base = TAB_NAME_POOL[start]!
  let n = 2
  while (taken.has(`${base} ${n}`.toLowerCase())) n++
  return { title: `${base} ${n}`, cursor: start + 1 }
}

function makeTab(
  profileId: string,
  tabs: TerminalTab[],
  cursor: number,
  permissionMode?: ClaudePermissionMode
): { tab: TerminalTab; cursor: number } {
  const leaf = makeLeaf(profileId, '', permissionMode)
  const name = nextTabName(tabs, cursor)
  return {
    tab: {
      id: makeId('tab'),
      title: name.title,
      root: leaf,
      activePaneId: leaf.id,
      textColor: nextTextColor(tabs)
    },
    cursor: name.cursor
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

/**
 * A colour change to a tab. `null` means "take the colour off" — distinct from
 * `undefined`, which means "leave that one alone", so the two colours can be
 * set independently through one action.
 */
export interface TabPaint {
  color?: string | null
  textColor?: string | null
}

function painted(tab: TerminalTab, patch: TabPaint): TerminalTab {
  const next: TerminalTab = { ...tab }
  // Deleted rather than set to '' — an absent colour is what every reader
  // treats as "untinted", and a blank string would be a colour that paints
  // nothing.
  if (patch.color !== undefined) {
    if (patch.color) next.color = patch.color
    else delete next.color
  }
  if (patch.textColor !== undefined) {
    if (patch.textColor) next.textColor = patch.textColor
    else delete next.textColor
  }
  return next
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * A hex colour, and nothing else.
 *
 * xterm is handed these straight, and an unparseable theme colour throws inside
 * the renderer rather than being ignored — so the gate is on the way in, not at
 * the paint.
 */
function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())
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
      // A session id ends up on a command line typed into a live shell, so a
      // layout file does not get to put anything but a real uuid there. Panes
      // written before resume existed have none: they get one here and start
      // fresh that once, then resume like everything else.
      if (!isSessionId(leaf.sessionId)) {
        root = updateLeaf(root, leaf.id, { sessionId: newSessionId() })
      }
    }
    const leaves = collectLeaves(root)
    if (leaves.length === 0 || leaves.length > MAX_PANES_PER_TAB) continue
    const activePaneId = leaves.some((l) => l.id === tab.activePaneId) ? tab.activePaneId : leaves[0]!.id
    tabs.push({
      id: tab.id,
      title: typeof tab.title === 'string' ? tab.title : 'Tab',
      root,
      activePaneId,
      // Colours survive a restart, but only as colours: anything that is not a
      // CSS colour string is dropped rather than handed to xterm.
      ...(isColor(tab.color) ? { color: tab.color } : {}),
      ...(isColor(tab.textColor) ? { textColor: tab.textColor } : {})
    })
  }
  const activeTabId = tabs.some((t) => t.id === ws.activeTabId) ? ws.activeTabId : (tabs[0]?.id ?? null)
  const viewMode: WorkspaceViewMode = ws.viewMode === 'mosaic' ? 'mosaic' : 'tabs'
  const livePanes = new Set<string>()
  for (const t of tabs) for (const l of collectLeaves(t.root)) livePanes.add(l.id)
  const mosaic = sanitiseMosaic(ws.mosaic, livePanes, new Set(tabs.map((t) => t.id)))
  // Where the name pool had got to. Anything that is not a real position in it
  // starts the project back at the top of the list rather than off the end.
  const raw = ws.nameCursor
  const nameCursor =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) % TAB_NAME_POOL.length : 0
  return { tabs, activeTabId, viewMode, mosaic, nameCursor }
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
        // A zoomed tile belongs to the project you were looking at.
        mosaicZoom: null,
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
        const made = makeTab(action.profileId, ws.tabs, ws.nameCursor ?? 0, action.permissionMode)
        return { ...ws, tabs: [...ws.tabs, made.tab], activeTabId: made.tab.id, nameCursor: made.cursor }
      })
    }

    /**
     * A named tab with a command already in it, unsubmitted.
     *
     * Not `newTab` plus `renameTab` plus a type: the whole point is that the
     * pane's id, its title and the text destined for it are decided in one
     * atomic step. Doing it in three would mean knowing the id of a tab the
     * reducer has not created yet, which is exactly the sort of thing that
     * works until two clicks land in the same frame.
     */
    case 'openToolPane': {
      if (totalPanes(state) >= MAX_SESSIONS) {
        return { ...state, notice: `Session limit reached (${MAX_SESSIONS})` }
      }
      if (!state.activeProjectId) {
        return { ...state, notice: 'Open a project first — a command needs somewhere to run' }
      }
      const leaf = makeLeaf(action.profileId, '')
      const tab: TerminalTab = {
        id: makeId('tab'),
        title: action.title,
        root: leaf,
        activePaneId: leaf.id,
        textColor: nextTextColor(workspaceOf(state, state.activeProjectId).tabs)
      }
      const next = mapActiveWorkspace(state, (ws) => ({
        ...ws,
        tabs: [...ws.tabs, tab],
        activeTabId: tab.id
      }))
      return {
        ...next,
        pendingTypes: [...next.pendingTypes, { paneId: leaf.id, text: action.text, submit: action.submit }],
        // The command is in a terminal, and the terminal is not the page you
        // are looking at. Leaving settings open would hide the thing that just
        // happened behind the button that caused it.
        view: 'terminals'
      }
    }

    case 'drainTypes': {
      const remaining = state.pendingTypes.filter((p) => !action.paneIds.includes(p.paneId))
      return remaining.length === state.pendingTypes.length ? state : { ...state, pendingTypes: remaining }
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
        return withPrunedMosaic({ ...current, tabs, activeTabId })
      })
      return {
        ...next,
        pendingKills: [...next.pendingKills, ...kills],
        mosaicZoom: kills.includes(next.mosaicZoom ?? '') ? null : next.mosaicZoom
      }
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

    case 'paintTab':
      return mapActiveWorkspace(state, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === action.tabId ? painted(t, action.patch) : t))
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
      const leaf = makeLeaf(action.profileId, '', action.permissionMode)
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
      const pruned = mapActiveWorkspace(next, withPrunedMosaic)
      return {
        ...pruned,
        pendingKills: [...pruned.pendingKills, action.paneId],
        mosaicZoom: pruned.mosaicZoom === action.paneId ? null : pruned.mosaicZoom
      }
    }

    case 'focusPane':
      return mapActiveTab(state, (t) => (t.activePaneId === action.paneId ? null : { ...t, activePaneId: action.paneId }))

    /**
     * Make `paneId` the app's current pane wherever in the project it lives —
     * selecting its tab on the way. The mosaic spans every tab, so zooming or
     * opening a tile has to be able to reach across them; `focusPane` only ever
     * looks inside the tab that is already active.
     */
    case 'revealPane':
      return mapActiveWorkspace(state, (ws) => {
        const target = ws.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === action.paneId))
        if (!target) return null
        const samePane = target.activePaneId === action.paneId
        if (ws.activeTabId === target.id && samePane) return null
        const tabs = samePane
          ? ws.tabs
          : ws.tabs.map((t) => (t.id === target.id ? { ...t, activePaneId: action.paneId } : t))
        return { ...ws, tabs, activeTabId: target.id }
      })

    case 'renamePane':
      return mapActiveTab(state, (t) => ({ ...t, root: updateLeaf(t.root, action.paneId, { title: action.title }) }))

    case 'setRatio':
      return mapActiveTab(state, (t) => {
        const root = setSplitRatio(t.root, action.splitId, action.ratio)
        return root === t.root ? null : { ...t, root }
      })

    case 'setViewMode': {
      const next = mapActiveWorkspace(state, (ws) =>
        (ws.viewMode ?? 'tabs') === action.mode ? null : { ...ws, viewMode: action.mode }
      )
      // Leaving the mosaic always drops the zoom — there is nothing to be
      // zoomed *into* once the tiles are gone.
      if (action.mode === 'tabs' && next.mosaicZoom !== null) return { ...next, mosaicZoom: null }
      return next
    }

    case 'toggleViewMode': {
      const current = workspaceOf(state, state.activeProjectId).viewMode ?? 'tabs'
      return reducer(state, { type: 'setViewMode', mode: current === 'mosaic' ? 'tabs' : 'mosaic' })
    }

    case 'setMosaicZoom':
      return state.mosaicZoom === action.paneId ? state : { ...state, mosaicZoom: action.paneId }

    case 'mosaicTiles':
      return mapMosaic(state, (m) => {
        const wallTabs =
          action.wallTab && !m.wallTabs.includes(action.wallTab) ? [...m.wallTabs, action.wallTab] : m.wallTabs
        return {
          mode: action.custom ? 'custom' : m.mode,
          tiles: { ...m.tiles, ...action.tiles },
          wallTabs
        }
      })

    case 'mosaicFit':
      return mapMosaic(state, (m) => {
        const tile = m.tiles[action.paneId]
        if (!tile || (tile.fit ?? false) === action.fit) return null
        const next: MosaicTile = { x: tile.x, y: tile.y, w: tile.w, h: tile.h }
        if (action.fit) next.fit = true
        return { ...m, tiles: { ...m.tiles, [action.paneId]: next } }
      })

    case 'mosaicReset':
      return mapMosaic(state, (m) => (m.mode === 'auto' && m.wallTabs.length === 0 ? null : emptyMosaic()))

    case 'setAgentListening':
      return state.agentListening === action.on ? state : { ...state, agentListening: action.on }

    case 'drainKills': {
      const remaining = state.pendingKills.filter((id) => !action.ids.includes(id))
      return remaining.length === state.pendingKills.length ? state : { ...state, pendingKills: remaining }
    }

    case 'notice':
      return state.notice === action.message ? state : { ...state, notice: action.message }

    case 'openSettings':
      return {
        ...state,
        view: 'settings',
        settingsSection: action.section ?? state.settingsSection
      }

    case 'closeSettings':
      return state.view === 'terminals' ? state : { ...state, view: 'terminals' }

    case 'setSettingsSection':
      return state.settingsSection === action.section ? state : { ...state, settingsSection: action.section }

    case 'cacheThemeChrome':
      if (state.settings.themeBg === action.bg && state.settings.themeInk === action.ink) return state
      return { ...state, settings: { ...state.settings, themeBg: action.bg, themeInk: action.ink } }

    default:
      return state
  }
}

/* ------------------------------------------------------------- actions */

export interface AppActions {
  addProject(): Promise<void>
  /**
   * Add a folder that already exists, without a picker.
   *
   * The voice agent's `create_project` uses this: the main process has already
   * made the folder and checked it is somewhere Forge is allowed to write, so
   * all that is left is the same dispatch `addProject` does after the dialog.
   */
  addProjectPath(path: string, name?: string): void
  updateProject(id: string, patch: Partial<Project>): void
  removeProject(id: string): void
  moveProject(from: number, to: number): void
  selectProject(id: string): void
  revealProject(id: string): void
  toggleRail(): void
  /**
   * Move or resize the voice hub. A patch, because dragging writes only
   * `x`/`y`, a corner-drag writes only `w`/`h` and the mode buttons write only
   * `mode` — and two of those happen inside the same gesture when a drag ends
   * on the dock.
   */
  setVoiceHub(patch: Partial<VoiceHubPlacement>): void
  /**
   * Open the hub card, from wherever the hub happens to be — the titlebar
   * button and Ctrl+Shift+G. Pressed again on an open card it minimises, so one
   * key is the whole "show me the agent / put it away" gesture. This is what
   * `toggleVoicePanel` used to be, pointed at the thing that replaced the
   * panel.
   */
  toggleVoiceHubCard(): void
  /** Arm/disarm the voice hub's mic — see AppState.agentListening. */
  setAgentListening(on: boolean): void
  setVoiceBrain(id: VoiceBrainId): void
  setAnthropicKey(key: string): void
  setGeminiKey(key: string): void
  setGeminiModel(model: string): void
  setFontSize(size: number): void
  /** Life-size type on the mosaic wall, or scale models. Persisted, app-wide. */
  setMosaicText(mode: MosaicTextMode): void
  /**
   * Show or hide every tab's terminal text colour at once. The colours
   * themselves are untouched — this is a lens, not an eraser.
   */
  setTabTextColours(on: boolean): void
  setCatchShots(on: boolean): void
  setShotsKeep(keep: number): void
  /** Generic settings write — used by the dictation setup card. Persisted. */
  patchSettings(patch: Partial<Settings>): void
  saveProfile(profile: AgentProfile): void
  deleteProfile(id: string): void
  /** Duplicate a profile under a new id, ready to be edited. */
  duplicateProfile(id: string): void
  newTab(profileId?: string, permissionMode?: ClaudePermissionMode): void
  /**
   * Open a shell pane in the current project with `command` already typed into
   * it. Nothing is submitted unless `settings.updatesAutoRun` says so — see
   * Settings › Updates & Tools, which is the only caller.
   */
  openToolPane(title: string, command: string): void
  closeTab(tabId: string): void
  selectTab(tabId: string): void
  renameTab(tabId: string, title: string): void
  /** Recolour a tab's chip, its terminals' text, or both. `null` clears one. */
  paintTab(tabId: string, patch: TabPaint): void
  moveTab(from: number, to: number): void
  splitPane(
    paneId: string,
    direction: SplitDirection,
    profileId?: string,
    permissionMode?: ClaudePermissionMode
  ): void
  closePane(paneId: string): void
  focusPane(paneId: string): void
  /** Focus a pane anywhere in the project, selecting its tab too. */
  revealPane(paneId: string): void
  renamePane(paneId: string, title: string): void
  setRatio(splitId: string, ratio: number): void
  restartPane(paneId: string): void
  setViewMode(mode: WorkspaceViewMode): void
  toggleViewMode(): void
  setMosaicZoom(paneId: string | null): void
  /**
   * Write tile boxes onto the freeform wall.
   *
   * `custom` moves the wall off the auto grid — pass it only together with a
   * full set of seeded boxes, or tiles will jump. `wallTab` marks a tab as one
   * the user dragged onto the wall by hand.
   */
  setMosaicTiles(tiles: Record<string, MosaicTile>, opts?: { custom?: boolean; wallTab?: string }): void
  /** Opt a single tile in or out of refitting its PTY to its box. */
  setMosaicFit(paneId: string, fit: boolean): void
  /** Back to the auto grid, forgetting every hand-placed box. */
  resetMosaicLayout(): void
  setNotice(message: string | null): void
  openDataDir(): void

  /* ------------------------------------------------------- settings page */
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  setSettingsSection(section: SettingsSection): void

  /* ------------------------------------------------------------- themes */
  setTheme(id: string): void
  /** Insert or update a custom theme, then switch to it. */
  saveCustomTheme(theme: ThemeCore): void
  deleteCustomTheme(id: string): void
  setReducedMotion(on: boolean): void

  /* ------------------------------------------------------------ account */
  setAccountName(name: string): void
  setAccountColor(color: string): void
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

  /* ------------------------------------------------------- type draining
   *
   * Deliver each queued command once its pane has a live shell.
   *
   * Polled rather than subscribed because the pane does not exist yet when the
   * queue is written — there is nothing to subscribe *to* until TerminalGrid
   * has mounted it, so the first thing any listener would have to do is wait
   * for the entry to appear anyway.
   *
   * The settle beat after `live` is not superstition: conpty reports the child
   * as running before PowerShell has drawn its first prompt, and text written
   * into that window lands in the input buffer *before* the prompt and is
   * repainted over. A fifth of a second is the difference between a command
   * you can read and a smear.
   */
  useEffect(() => {
    if (state.pendingTypes.length === 0) return
    const queue = state.pendingTypes
    let cancelled = false
    const delivered: string[] = []
    // A pane that never comes up — a shell that failed to spawn — must not
    // leave an entry in the queue forever, re-running this effect on every
    // render for the rest of the session.
    const deadline = Date.now() + 30_000

    const tick = (): void => {
      if (cancelled) return
      for (const pending of queue) {
        if (delivered.includes(pending.paneId)) continue
        const runtime = terminalHost.runtime(pending.paneId)
        if (runtime.status === 'live') {
          delivered.push(pending.paneId)
          setTimeout(() => {
            if (cancelled) return
            if (!terminalHost.type(pending.paneId, pending.text)) return
            terminalHost.focus(pending.paneId)
            if (pending.submit) terminalHost.submit(pending.paneId)
          }, 220)
        } else if (runtime.status === 'exited' || runtime.status === 'error') {
          delivered.push(pending.paneId)
        }
      }
      if (delivered.length === queue.length || Date.now() > deadline) {
        clearInterval(timer)
        // Drained after the settle timeouts above have had their chance to
        // fire; dispatching immediately would re-render and cancel them.
        setTimeout(() => {
          if (!cancelled) dispatch({ type: 'drainTypes', paneIds: queue.map((p) => p.paneId) })
        }, 400)
      }
    }

    const timer = setInterval(tick, 120)
    tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [state.pendingTypes])

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

  /* ------------------------------------------------------------ theme sync
   *
   * One effect owns the entire look: it writes the resolved token set onto the
   * document and then tells the terminal host to repaint. The order matters —
   * terminals read their palette out of computed style, so they have to be
   * refreshed *after* the new tokens are on the root, never before.
   *
   * It runs before `ready` too, unlike the effects above: hydration brings the
   * saved theme with it, and a frame of Volt before Paper appears is a flash of
   * the wrong app.
   */

  const themeId = state.settings.themeId
  const customThemes = state.settings.customThemes
  useEffect(() => {
    const tokens = applyTheme(findTheme(themeId, customThemes))
    terminalHost.refreshTheme()
    // Windows paints the minimise/maximise/close buttons itself, into our
    // titlebar, out of reach of any stylesheet. Push the new colours at it or a
    // light theme keeps three near-black buttons in the corner.
    const bg = tokens['bg-base']
    const ink = tokens['text-primary']
    if (!bg || !ink) return
    window.forge.window.setTitlebar(bg, ink)
    // Remember them for the *next* launch, where main has to paint the window
    // before any of this has run. Only written when they actually change, so a
    // restart in the same theme is not a settings write.
    dispatch({ type: 'cacheThemeChrome', bg, ink })
  }, [themeId, customThemes])

  useEffect(() => {
    applyReducedMotion(state.settings.reducedMotion)
  }, [state.settings.reducedMotion])

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
      addProjectPath(path, name) {
        const existing = state.projects.find((p) => p.path.toLowerCase() === path.toLowerCase())
        if (existing) {
          dispatch({ type: 'selectProject', projectId: existing.id })
          return
        }
        dispatch({
          type: 'addProject',
          project: {
            id: makeId('proj'),
            name: name?.trim() || basename(path),
            path,
            color: ACCENT_PALETTE[state.projects.length % ACCENT_PALETTE.length]!,
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
      setVoiceHub: (patch) =>
        dispatch({
          type: 'patchSettings',
          patch: { voiceHub: { ...(state.settings.voiceHub ?? DEFAULT_HUB), ...patch } }
        }),
      toggleVoiceHubCard: () => {
        const hub = state.settings.voiceHub ?? DEFAULT_HUB
        // `expand` reaches the card from docked *and* from floating — one key,
        // one destination, wherever the hub was. See nextHubMode's table.
        const mode = nextHubMode(hub.mode, hub.mode === 'expanded' ? 'minimise' : 'expand')
        dispatch({ type: 'patchSettings', patch: { voiceHub: { ...hub, mode } } })
      },
      setAgentListening: (on) => dispatch({ type: 'setAgentListening', on }),
      setVoiceBrain: (id) => dispatch({ type: 'patchSettings', patch: { voiceBrain: id } }),
      setAnthropicKey: (key) => dispatch({ type: 'patchSettings', patch: { anthropicKey: key } }),
      setGeminiKey: (key) => dispatch({ type: 'patchSettings', patch: { geminiKey: key.trim() } }),
      setGeminiModel: (model) =>
        dispatch({ type: 'patchSettings', patch: { geminiModel: model.trim() || 'gemini-2.5-flash' } }),
      setFontSize: (size) =>
        dispatch({ type: 'patchSettings', patch: { terminalFontSize: Math.min(24, Math.max(9, size)) } }),
      setMosaicText: (mode) => dispatch({ type: 'patchSettings', patch: { mosaicText: mode } }),
      setTabTextColours: (on) => dispatch({ type: 'patchSettings', patch: { tabTextColours: on } }),
      setCatchShots: (on) => dispatch({ type: 'patchSettings', patch: { catchShots: on } }),
      setShotsKeep: (keep) =>
        dispatch({ type: 'patchSettings', patch: { shotsKeep: Math.min(60, Math.max(1, Math.round(keep))) } }),
      patchSettings: (patch) => dispatch({ type: 'patchSettings', patch }),
      saveProfile: (profile) => dispatch({ type: 'saveProfile', profile }),
      deleteProfile: (id) => dispatch({ type: 'deleteProfile', id }),
      duplicateProfile: (id) => {
        const source = state.settings.agentProfiles.find((p) => p.id === id)
        if (!source) return
        dispatch({
          type: 'saveProfile',
          profile: {
            ...source,
            id: makeId('agent'),
            name: `${source.name} copy`,
            // A copy is yours: it can be deleted, whatever it was cloned from.
            builtin: false
          }
        })
      },
      newTab: (profileId, permissionMode) =>
        dispatch({
          type: 'newTab',
          profileId: profileId ?? defaultProfileFor(activeProjectId),
          ...(permissionMode ? { permissionMode } : {})
        }),
      openToolPane: (title, command) => {
        // A plain shell, never an agent: `winget upgrade …` typed at a Claude
        // prompt would be a sentence asking Claude to do it, which is not what
        // the button says. The built-in pwsh profile is re-seeded by the store
        // if it is ever deleted, but a renamed or hand-edited settings.json is
        // still allowed to have moved it, so any shell profile will do.
        const shell =
          state.settings.agentProfiles.find((p) => p.id === 'pwsh') ??
          state.settings.agentProfiles.find((p) => isShellProfile(p))
        if (!shell) {
          dispatch({ type: 'notice', message: 'No shell profile to run that in' })
          return
        }
        dispatch({
          type: 'openToolPane',
          profileId: shell.id,
          title: title.slice(0, 40),
          text: command,
          submit: state.settings.updatesAutoRun
        })
      },
      closeTab: (tabId) => dispatch({ type: 'closeTab', tabId }),
      selectTab: (tabId) => dispatch({ type: 'selectTab', tabId }),
      renameTab: (tabId, title) => dispatch({ type: 'renameTab', tabId, title }),
      paintTab: (tabId, patch) => dispatch({ type: 'paintTab', tabId, patch }),
      moveTab: (from, to) => dispatch({ type: 'moveTab', from, to }),
      splitPane: (paneId, direction, profileId, permissionMode) =>
        dispatch({
          type: 'splitPane',
          paneId,
          direction,
          profileId: profileId ?? defaultProfileFor(activeProjectId),
          ...(permissionMode ? { permissionMode } : {})
        }),
      closePane: (paneId) => dispatch({ type: 'closePane', paneId }),
      focusPane: (paneId) => dispatch({ type: 'focusPane', paneId }),
      revealPane: (paneId) => dispatch({ type: 'revealPane', paneId }),
      renamePane: (paneId, title) => dispatch({ type: 'renamePane', paneId, title }),
      setRatio: (splitId, ratio) => dispatch({ type: 'setRatio', splitId, ratio }),
      restartPane: (paneId) => void terminalHost.restart(paneId),
      setViewMode: (mode) => dispatch({ type: 'setViewMode', mode }),
      toggleViewMode: () => dispatch({ type: 'toggleViewMode' }),
      setMosaicZoom: (paneId) => dispatch({ type: 'setMosaicZoom', paneId }),
      setMosaicTiles: (tiles, opts) =>
        dispatch({
          type: 'mosaicTiles',
          tiles,
          ...(opts?.custom ? { custom: true } : {}),
          ...(opts?.wallTab ? { wallTab: opts.wallTab } : {})
        }),
      setMosaicFit: (paneId, fit) => dispatch({ type: 'mosaicFit', paneId, fit }),
      resetMosaicLayout: () => dispatch({ type: 'mosaicReset' }),
      setNotice: (message) => dispatch({ type: 'notice', message }),
      openDataDir: () => void window.forge.store.revealDataDir(),

      openSettings: (section) => dispatch({ type: 'openSettings', ...(section ? { section } : {}) }),
      closeSettings: () => dispatch({ type: 'closeSettings' }),
      setSettingsSection: (section) => dispatch({ type: 'setSettingsSection', section }),

      setTheme: (id) => dispatch({ type: 'patchSettings', patch: { themeId: id } }),
      saveCustomTheme: (theme) => {
        const rest = state.settings.customThemes.filter((t) => t.id !== theme.id)
        dispatch({
          type: 'patchSettings',
          patch: { customThemes: [...rest, { ...theme, custom: true }], themeId: theme.id }
        })
      },
      deleteCustomTheme: (id) => {
        const customThemes = state.settings.customThemes.filter((t) => t.id !== id)
        // Deleting the theme you are wearing has to leave you wearing something.
        const themeId = state.settings.themeId === id ? 'volt' : state.settings.themeId
        dispatch({ type: 'patchSettings', patch: { customThemes, themeId } })
      },
      setReducedMotion: (on) => dispatch({ type: 'patchSettings', patch: { reducedMotion: on } }),

      setAccountName: (name) => dispatch({ type: 'patchSettings', patch: { accountName: name.trim().slice(0, 40) } }),
      setAccountColor: (color) => dispatch({ type: 'patchSettings', patch: { accountColor: color } })
    }
  }, [
    activeProjectId,
    defaultProfileFor,
    state.projects,
    state.settings.agentProfiles,
    state.settings.customThemes,
    state.settings.themeId,
    state.settings.railCollapsed,
    state.settings.voiceHub
  ])

  /* ------------------------------------------------- forge mobile commands
   *
   * A phone asked for a layout change. The renderer owns the split tree and
   * persists the workspace, so the phone joins *this* code path rather than a
   * parallel one in the main process that could disagree with it — an op ends
   * up dispatching exactly what a click on the same control dispatches.
   *
   * Note the deliberate side effect: an op naming a project that is not the
   * active one selects it first. Dispatches reach the reducer in order, so the
   * op that follows sees the newly selected project. It does mean a phone can
   * change what the desktop is showing — correct for "my computer is at home",
   * and documented in docs/MOBILE.md rather than hidden.
   */

  useEffect(() => {
    return window.forge.mobile.onCommand(({ requestId, op }) => {
      const answer = (error?: string): void => window.forge.mobile.commandResult(requestId, error)
      const project = state.projects.find((p) => p.id === op.projectId)
      if (!project) return answer('That project is no longer open on the desktop.')
      if (state.activeProjectId !== project.id) dispatch({ type: 'selectProject', projectId: project.id })

      // The cap is checked here as well as in the reducer, because the reducer
      // reports it by setting a `notice` on the desktop — which the phone
      // cannot see. Refusing here is what turns it into an answer.
      const atLimit = totalPanes(state) >= MAX_SESSIONS

      // The phone's chooser sends a permission mode alongside the profile. It
      // is wire data, so it is *checked*, never cast: anything that is not one
      // of the four modes falls back to undefined, which means "whatever the
      // profile says" — exactly what a phone that never sent the field gets.
      const mode = isPermissionMode(op.permissionMode) ? op.permissionMode : undefined

      switch (op.op) {
        case 'create-tab':
          if (atLimit) return answer(`Forge is at its ${MAX_SESSIONS}-session limit.`)
          actions.newTab(op.profileId ?? project.defaultProfileId, mode)
          return answer()
        case 'select-tab':
          if (!op.tabId) return answer('No tab named.')
          actions.selectTab(op.tabId)
          return answer()
        case 'create-pane': {
          if (atLimit) return answer(`Forge is at its ${MAX_SESSIONS}-session limit.`)
          const workspace = workspaceOf(state, project.id)
          const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
          const paneId = op.paneId ?? activeTab?.activePaneId
          if (!paneId) return answer('There is no pane open to split.')
          actions.splitPane(paneId, 'row', op.profileId ?? project.defaultProfileId, mode)
          return answer()
        }
        case 'close-pane':
          if (!op.paneId) return answer('No pane named.')
          actions.closePane(op.paneId)
          return answer()
        default:
          return answer('Forge does not know that command.')
      }
    })
  }, [actions, state])

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

export function useViewMode(): WorkspaceViewMode {
  return useActiveWorkspace().viewMode ?? 'tabs'
}

/** The active project's freeform wall — the auto grid until it has been moved. */
export function useMosaic(): MosaicState {
  return mosaicOf(useActiveWorkspace())
}

export function usePaneCount(): { used: number; max: number } {
  const { state } = useApp()
  return { used: totalPanes(state), max: MAX_SESSIONS }
}

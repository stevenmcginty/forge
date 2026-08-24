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
import {
  MAX_DEV_COMMAND,
  MAX_PANES_PER_TAB,
  MAX_SESSIONS,
  MAX_TABS_PER_PROJECT,
  MAX_TASK_CARDS,
  MAX_TASK_TEXT
} from '@shared/ipc'
import type {
  AgentProfile,
  AppInfo,
  ClaudePermissionMode,
  LayoutNode,
  MosaicState,
  MosaicTextMode,
  MosaicTile,
  Project,
  RailSectionId,
  Settings,
  SplitDirection,
  TaskCard,
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
  isPermissionMode,
  isShellProfile
} from '@shared/agents'
/*
 * How a tab is born, and what an empty workspace is. Imported rather than
 * written here since electron/layout-engine.ts started performing a phone's and
 * a browser's layout ops in the main process: a tab opened from away goes
 * through the same three functions this reducer does, so it comes out with the
 * same name, colour and shape.
 */
import { EMPTY_WORKSPACE, makeTab, nextTextColor, withPrunedMosaic } from '@shared/workspace'
import { DEFAULT_FOREMAN_BRIEF } from '@shared/foreman'
import { isSessionId, newSessionId } from '@shared/session'
import { MOBILE_PORT } from '@shared/mobile'
import { DEFAULT_RAIL_OPEN } from '@shared/rail'
import { ACCENT_PALETTE, DEFAULT_PROFILE_ID } from '@/lib/agents'
import { applyReducedMotion, applyTheme, findTheme } from '@/theme/themes'
import { makeId } from '@/lib/ids'
import { emptyMosaic, sanitiseMosaic } from '@/lib/mosaicLayout'
import { plannerPaneId } from '@/lib/planner'
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
import { handleSignal, startMirror, stopMirror } from '@/lib/mirror'
import { startWebMirror, stopWebMirror } from '@/lib/web-mirror'
import { terminalHost } from '@/lib/terminals'
import { confirmProjectServer } from '@/lib/devicePreview'
import { setLiveSettings } from '@/lib/livesettings'

/* ------------------------------------------------------------------ state */

/** The settings page's sections, in sidebar order. */
export type SettingsSection =
  | 'account'
  | 'agents'
  | 'terminal'
  | 'models'
  | 'voice'
  | 'foreman'
  | 'appearance'
  | 'screenshots'
  | 'mobile'
  | 'web'
  | 'updates'
  | 'advanced'

/**
 * What the main area is showing. Settings and Devices are *views*, not modals:
 * each takes the terminal area over completely, because it is a place you go to
 * work rather than a dialog you dismiss. The terminals keep running behind them
 * — see terminalHost, which owns them independently of what React has mounted.
 */
export type MainView = 'terminals' | 'settings' | 'devices'

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
  /**
   * Deliver as a bracketed paste rather than as typing.
   *
   * `type()` flattens newlines to spaces and charges the whole thing to the
   * take-back draft, which is right for a one-line command and wrong for a
   * multi-sentence brief — see the git section's handoff prompts, which are the
   * only caller. `paste()` keeps the shape of the text and is bracketed-paste
   * safe, which is why the tab handover already uses it for the same class of
   * thing. Never submitted either way.
   */
  paste?: boolean
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
   * The Tasks panel blown up to fill the main content area — the delegation
   * desk. Same shape as `mosaicZoom`, for the same reason: a viewing mode,
   * transient on purpose, because booting straight into a maximized panel is
   * not something anyone asked for. It survives a project switch — the desk
   * is per-app, its contents are per-project.
   */
  tasksMaximized: boolean
  /**
   * The rail section currently blown up into a panel over the app — Git or
   * Activity, one at a time, never both. Transient for the same reason as
   * `mosaicZoom` and `tasksMaximized`: it is a way of looking at the project
   * you are in, not a mode to boot back into a day later.
   *
   * The panel is *the same component* as the rail section, with its body
   * portalled out — so what it shows is whatever the active project's section
   * would have shown, and switching project switches the panel with it.
   */
  railExpanded: RailSectionId | null
  /**
   * True while the "what's new" card is open.
   *
   * Transient, and separate from the settings key that decides whether it opens
   * *by itself*: the card also has a button in Settings → Updates, which is the
   * only way to see it again once it has been dismissed — and the only way Steve
   * sees it at all, since a checkout's version never changes.
   */
  whatsNewOpen: boolean
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
  railBusyRing: true,
  railTasks: true,
  railGit: false,
  railActivity: false,
  railShare: false,
  shareTools: false,
  railOpen: [...DEFAULT_RAIL_OPEN],
  railHeights: {},
  shell: 'pwsh.exe',
  catchShots: true,
  shotsKeep: 12,
  window: { width: 1440, height: 900, maximized: false },
  // True until the real settings arrive, so the welcome overlay cannot flash up
  // for a second on every launch while the store is still being read.
  onboarded: true,
  webAccountPromptDismissed: true,
  sttPython: '',
  sttModelDir: '',
  sttAutoStopSeconds: 10,
  sttHotkey: 'ControlRight',
  voiceHub: DEFAULT_HUB,
  voiceOverlayWindow: true,
  voiceBargeIn: true,
  voiceBrain: 'gemini',
  anthropicKey: '',
  // Mirrors electron/store.ts. The Claude voice brain needs no key — it signs
  // in with the machine's own `claude` login — so this is the only knob it has.
  voiceClaudeModel: 'opus',
  // Mirrors electron/store.ts — off until the wake-word listener has earned
  // trust the way barge-in and earcons already have.
  voiceWakeWord: false,
  // Mirrors electron/store.ts. Foreman decides a whole job on Steve's behalf,
  // so it runs the same model the voice brain does, and needs no key either.
  foremanModel: 'opus',
  foremanBrief: DEFAULT_FOREMAN_BRIEF,
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  zaiKey: '',
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
  // Neural speech is the default — the Edge engine, which needs no key and has
  // no quota, so a keyless install gets the good voice and a keyed one cannot
  // swap to SAPI mid-reply. The chain in src/lib/tts.ts still drops to the
  // local voice on its own if the network is gone.
  voiceEngine: 'edge',
  voiceEdgeVoice: '',
  voiceTtsVoice: '',
  voiceTtsModel: '',
  voiceEarcons: true,
  terminalExitChime: true,
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
  gitShelfEnabled: true,
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
  mobileControlEnabled: false,
  mobileMirrorAudio: false,
  // Forge Web — off, unconfigured, admitting nobody. Same rule as the block
  // above: this mirrors defaultSettings() in electron/store.ts, and a fallback
  // that guessed "on" would be a fallback that opened a door for the second
  // before the real settings landed.
  webEnabled: false,
  webProjectId: '',
  webSiteId: '',
  webUid: '',
  // The unlock PIN, matching defaultSettings() in electron/store.ts. Blank is
  // the one fallback here that is *not* the locked-down guess, and it matches
  // the store on purpose: a panel that drew "a PIN is set" for a second and
  // then switched itself off would be a panel that lies about the door twice a
  // launch. Nothing here is ever the digits — see electron/web/pin.ts.
  webPin: '',
  // The screen, the mouse and the sound: off here for the ordinary reason the
  // rest of this object is conservative, and the real settings decide a moment
  // later. Nothing in the renderer acts on these anyway — main reads them at
  // the moment a browser asks, so a stale copy here cannot open a door.
  webMirrorEnabled: false,
  webControlEnabled: false,
  webMirrorAudio: false,
  // Forge Web's own Firebase session and its own tunnel — signed out, and no
  // way in from outside. Same rule as every other fallback here: the safe
  // answer before the real settings land.
  webApiKey: '',
  webDatabaseURL: '',
  webAuthBase: '',
  webTokenBase: '',
  webEmail: '',
  webRefreshToken: '',
  // 8421, as electron/store.ts spells it. Not imported, because that module is
  // main's and this fallback is only ever used for the instant before main's
  // real settings arrive.
  webPort: 8421,
  webTunnel: 'off',
  webNgrokAuthtoken: '',
  webNgrokDomain: '',
  customTools: [],
  updatesAutoRun: false,
  // Blank until the real settings arrive. The card checks `state.ready`, so it
  // cannot flash up against a fallback version.
  lastNotesVersion: '',
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
  tasksMaximized: false,
  railExpanded: null,
  whatsNewOpen: false,
  agentListening: false,
  notice: null,
  view: 'terminals',
  settingsSection: 'account'
}

type Action =
  | { type: 'hydrate'; info: AppInfo; settings: Settings; projects: Project[]; activeProjectId: string | null }
  | { type: 'workspaceLoaded'; projectId: string; workspace: Workspace }
  /**
   * Main changed this project's layout and this is what it now is. See
   * `IPC.workspaceReplaced` — unlike `workspaceLoaded`, a live workspace does
   * not win over it.
   */
  | { type: 'workspaceReplaced'; projectId: string; workspace: Workspace }
  | { type: 'selectProject'; projectId: string }
  | { type: 'addProject'; project: Project }
  | { type: 'updateProject'; id: string; patch: Partial<Project> }
  | { type: 'setProjectRepoUrl'; id: string; url: string }
  | { type: 'removeProject'; id: string }
  | { type: 'moveProject'; from: number; to: number }
  | { type: 'patchSettings'; patch: Partial<Settings> }
  | { type: 'setRailHeight'; id: RailSectionId; height: number }
  | { type: 'saveProfile'; profile: AgentProfile }
  | { type: 'deleteProfile'; id: string }
  | { type: 'newTab'; profileId: string; permissionMode?: ClaudePermissionMode }
  | { type: 'openToolPane'; profileId: string; title: string; text: string; submit: boolean; paste?: boolean }
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
  | { type: 'taskAdd'; text: string }
  | { type: 'taskRemove'; id: string }
  | { type: 'tasksMaximized'; on: boolean }
  | { type: 'railExpanded'; id: RailSectionId | null }
  | { type: 'whatsNewOpen'; on: boolean }
  /** Remember the planner terminal's Claude session id on the workspace. */
  | { type: 'plannerSession'; sessionId: string }
  /** A local dev-server URL just seen in one of a project's terminals. */
  | { type: 'noteDetectedUrl'; projectId: string; url: string; at: number }
  /** The Devices preview's hand-typed URL for a project; `''` clears it. */
  | { type: 'setPreviewUrl'; projectId: string; url: string }
  /** The Devices preview's hand-typed start command for a project; `''` clears it. */
  | { type: 'setDevCommand'; projectId: string; command: string }
  | { type: 'setAgentListening'; on: boolean }
  | { type: 'drainKills'; ids: string[] }
  | { type: 'notice'; message: string | null }
  | { type: 'openSettings'; section?: SettingsSection }
  | { type: 'closeSettings' }
  | { type: 'openDevices' }
  | { type: 'closeDevices' }
  | { type: 'setSettingsSection'; section: SettingsSection }
  | { type: 'cacheThemeChrome'; bg: string; ink: string }

/* -------------------------------------------------------------- helpers */

/**
 * Longest repo URL Forge will keep. The same 400 the store puts on a path — a
 * clone URL is a path with a host bolted on, and anything longer than that
 * arrived by accident (a pasted page, a stray transcript) rather than by
 * anyone typing it. Capping here rather than at the store keeps the value the
 * panes are handed identical to the one on disk.
 */
const MAX_REPO_URL = 400

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

function workspaceOf(state: AppState, projectId: string | null): Workspace {
  if (!projectId) return EMPTY_WORKSPACE
  return state.workspaces[projectId] ?? EMPTY_WORKSPACE
}

/** The project and tab a pane sits in, searched across every loaded workspace. */
function tabOwning(state: AppState, paneId: string): { projectId: string; tab: TerminalTab } | null {
  for (const [projectId, ws] of Object.entries(state.workspaces)) {
    for (const tab of ws.tabs) {
      if (collectLeaves(tab.root).some((leaf) => leaf.id === paneId)) return { projectId, tab }
    }
  }
  return null
}

function totalPanes(state: AppState): number {
  let n = 0
  for (const ws of Object.values(state.workspaces)) {
    for (const tab of ws.tabs) n += countLeaves(tab.root)
  }
  return n
}

/**
 * Replace a named project's workspace through a mapper.
 *
 * Only a workspace that is already *in* state can be mapped. An absent one is
 * not an empty one: it is a workspace still being read off disk, and writing a
 * fresh object under its id would make `workspaceLoaded` treat the read as
 * stale and drop every tab it was carrying. Callers here are all writing a
 * detail onto a project somebody is working in, so there is nothing to rescue
 * by relaxing that — the workspace is loaded long before either can fire.
 */
function mapWorkspace(
  state: AppState,
  projectId: string,
  fn: (ws: Workspace) => Workspace | null
): AppState {
  const current = state.workspaces[projectId]
  if (!current) return state
  const next = fn(current)
  if (!next || next === current) return state
  return { ...state, workspaces: { ...state.workspaces, [projectId]: next } }
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
/** A stored preview URL: a non-empty string of sane length, nothing more. */
function isPreviewUrlString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 2048
}

/** A stored start command: a non-empty string of one command line's length. */
function isDevCommandString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_DEV_COMMAND
}

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
  // Task cards are typed into live terminals, so a layout file only gets to
  // put strings of bounded size on the tray — and never more tray than the
  // reducer would have allowed it to accumulate.
  const tasks: TaskCard[] = []
  if (Array.isArray(ws.tasks)) {
    for (const t of ws.tasks) {
      if (!t || typeof t.id !== 'string' || typeof t.text !== 'string') continue
      const text = t.text.trim().slice(0, MAX_TASK_TEXT)
      if (!text) continue
      const createdAt = typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) ? t.createdAt : Date.now()
      tasks.push({ id: t.id, text, createdAt })
      if (tasks.length >= MAX_TASK_CARDS) break
    }
  }
  return {
    tabs,
    activeTabId,
    viewMode,
    mosaic,
    nameCursor,
    ...(tasks.length > 0 ? { tasks } : {}),
    // The planner terminal's session id ends up on a command line typed into a
    // live shell, so a layout file only gets to put a real uuid there — same
    // rule as the pane ids above. A bad one is dropped, and the panel simply
    // mints a fresh session on next use.
    ...(isSessionId(ws.plannerSessionId) ? { plannerSessionId: ws.plannerSessionId } : {}),
    // The Devices preview's URLs, remembered the way the copy promises. Bounded
    // strings only — they become an iframe src and a fetch target, and both go
    // back through their own gates on the way out (normalizePreviewUrl,
    // usableDetectedUrl), so the file gets to store a URL but never to smuggle
    // one past the rules that judge it.
    ...(isPreviewUrlString(ws.previewUrl) ? { previewUrl: ws.previewUrl.trim() } : {}),
    ...(isPreviewUrlString(ws.detectedUrl) ? { detectedUrl: ws.detectedUrl.trim() } : {}),
    ...(typeof ws.detectedUrlAt === 'number' && Number.isFinite(ws.detectedUrlAt)
      ? { detectedUrlAt: ws.detectedUrlAt }
      : {}),
    // The preview's Start command, remembered the same way and bounded the same
    // way. It is typed into a live shell when the button is pressed, so a layout
    // file gets to store one command line and nothing longer — and a person sees
    // it in the box before anything runs.
    ...(isDevCommandString(ws.devCommand) ? { devCommand: ws.devCommand.trim() } : {})
  }
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

    /**
     * Main performed a phone's or a browser's layout op and this is the result.
     *
     * The opposite posture to `workspaceLoaded` above: a live workspace does
     * *not* win. The op was applied to the authoritative layout in the main
     * process (electron/layout-engine.ts) and is already on disk, so anything
     * this window is holding that disagrees is by definition older than a
     * quarter of a second — the persistence debounce — and losing it is a much
     * smaller failure than a phone whose taps do nothing. Remote ops are rare;
     * a dropped moment of divider drag is the whole cost.
     *
     * Panes that vanished are queued for disposal exactly as `closePane` queues
     * them, because this window still holds their xterm and their PTY handle.
     * Main has already killed the process itself, and a kill of an id nobody
     * has is a no-op (`killPane` in electron/pty-host.ts), so the double is
     * cheap and the alternative — a live pane with nothing on screen — is not.
     */
    case 'workspaceReplaced': {
      const current = state.workspaces[action.projectId]
      const before = new Set<string>()
      if (current) for (const t of current.tabs) for (const l of collectLeaves(t.root)) before.add(l.id)
      const after = new Set<string>()
      for (const t of action.workspace.tabs) for (const l of collectLeaves(t.root)) after.add(l.id)
      const kills = [...before].filter((id) => !after.has(id))
      return {
        ...state,
        workspaces: { ...state.workspaces, [action.projectId]: action.workspace },
        pendingKills: kills.length === 0 ? state.pendingKills : [...state.pendingKills, ...kills],
        // A tile blown up on the mosaic wall cannot outlive the pane it is of.
        mosaicZoom: kills.includes(state.mosaicZoom ?? '') ? null : state.mosaicZoom
      }
    }

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

    /*
     * Set or clear one project's repo URL. Its own case rather than a
     * `updateProject` patch because clearing has to *remove* the field, not
     * park an empty string on it: `Project.repoUrl` is optional precisely so
     * "no remote yet" reads the same on a project saved last year as on one
     * saved today, and a pane asked to spawn with `repoUrl: ''` would end up
     * exporting an empty FORGE_REPO_URL instead of falling back to git.
     *
     * The no-change return matters more than it looks: the menu's auto-detect
     * writes the URL git just gave it, which on every open after the first is
     * the URL already stored. Returning `state` untouched keeps the projects
     * array identical, so the persistence effect never fires and opening a
     * menu costs no disk write.
     */
    case 'setProjectRepoUrl': {
      const url = action.url.trim().slice(0, MAX_REPO_URL)
      const before = state.projects.find((p) => p.id === action.id)
      if (!before || (before.repoUrl ?? '') === url) return state
      return {
        ...state,
        projects: state.projects.map((p) => {
          if (p.id !== action.id) return p
          const next = { ...p }
          if (url) next.repoUrl = url
          else delete next.repoUrl
          return next
        })
      }
    }

    case 'removeProject': {
      const ws = workspaceOf(state, action.id)
      // The project's layout panes, plus its planner terminal — the one pane
      // that lives outside the layout tree. Deleting the project is the single
      // moment the planner session is disposed rather than detached.
      const kills = [...ws.tabs.flatMap((t) => collectLeaves(t.root).map((l) => l.id)), plannerPaneId(action.id)]
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

    /*
     * One rail section's dragged height.
     *
     * Its own case rather than a patchSettings from the component because this
     * one arrives on every animation frame of a drag: merging a single key into
     * railHeights here is a two-object allocation, where building the merged map
     * in the caller would rebuild it on each frame as well. Returning `state`
     * unchanged when the number has not moved keeps a drag that has run out of
     * clamp from writing to disk sixty times a second.
     */
    case 'setRailHeight': {
      if (state.settings.railHeights[action.id] === action.height) return state
      const railHeights = { ...state.settings.railHeights, [action.id]: action.height }
      return { ...state, settings: { ...state.settings, railHeights } }
    }

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
      if (workspaceOf(state, state.activeProjectId).tabs.length >= MAX_TABS_PER_PROJECT) {
        return { ...state, notice: `A project holds at most ${MAX_TABS_PER_PROJECT} tabs` }
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
      if (workspaceOf(state, state.activeProjectId).tabs.length >= MAX_TABS_PER_PROJECT) {
        return { ...state, notice: `A project holds at most ${MAX_TABS_PER_PROJECT} tabs` }
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
        pendingTypes: [
          ...next.pendingTypes,
          { paneId: leaf.id, text: action.text, submit: action.submit, ...(action.paste ? { paste: true } : {}) }
        ],
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

    case 'selectTab': {
      const next = mapActiveWorkspace(state, (ws) =>
        ws.activeTabId === action.tabId ? null : { ...ws, activeTabId: action.tabId }
      )
      /*
       * The zoom follows the strip. A zoomed mosaic tile is looked up by pane
       * id, not by tab — so left alone, clicking another tab would highlight
       * it in the strip while the body kept showing the old pane: a click
       * that visibly does nothing. While a tile is blown up, picking a tab
       * means "show me that one", so the zoom moves to that tab's pane.
       */
      if (next === state || next.mosaicZoom === null || !next.activeProjectId) return next
      const ws = workspaceOf(next, next.activeProjectId)
      if (ws.viewMode !== 'mosaic') return next
      const tab = ws.tabs.find((t) => t.id === action.tabId)
      const paneId = tab ? (tab.activePaneId ?? collectLeaves(tab.root)[0]?.id) : undefined
      return paneId ? { ...next, mosaicZoom: paneId } : next
    }

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
      // The split lands beside the named pane wherever that pane lives — not
      // in whatever project happens to be on screen. Foreman hires from a pane
      // the human may have walked away from, and a hire that followed the
      // human's focus into another project was work leaking across folders.
      const home = tabOwning(state, action.paneId)
      if (!home) return state
      if (countLeaves(home.tab.root) >= MAX_PANES_PER_TAB) {
        return { ...state, notice: `A tab holds at most ${MAX_PANES_PER_TAB} panes` }
      }
      const leaf = makeLeaf(action.profileId, '', action.permissionMode)
      return mapWorkspace(state, home.projectId, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) =>
          t.id === home.tab.id
            ? { ...t, root: splitLeaf(t.root, action.paneId, action.direction, leaf), activePaneId: leaf.id }
            : t
        )
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

    case 'taskAdd': {
      const text = action.text.trim().slice(0, MAX_TASK_TEXT)
      if (!text) return state
      if ((workspaceOf(state, state.activeProjectId).tasks?.length ?? 0) >= MAX_TASK_CARDS) {
        return { ...state, notice: `The tray holds at most ${MAX_TASK_CARDS} tasks — deliver some first` }
      }
      const card: TaskCard = { id: crypto.randomUUID(), text, createdAt: Date.now() }
      // Newest first, same as the shots shelf: the card you just wrote is the
      // one you are about to drag.
      return mapActiveWorkspace(state, (ws) => ({ ...ws, tasks: [card, ...(ws.tasks ?? [])] }))
    }

    case 'taskRemove':
      return mapActiveWorkspace(state, (ws) => {
        const tasks = (ws.tasks ?? []).filter((t) => t.id !== action.id)
        return tasks.length === (ws.tasks?.length ?? 0) ? null : { ...ws, tasks }
      })

    case 'tasksMaximized':
      return state.tasksMaximized === action.on ? state : { ...state, tasksMaximized: action.on }

    case 'railExpanded':
      return state.railExpanded === action.id ? state : { ...state, railExpanded: action.id }

    case 'whatsNewOpen':
      return state.whatsNewOpen === action.on ? state : { ...state, whatsNewOpen: action.on }

    case 'plannerSession': {
      if (!isSessionId(action.sessionId)) return state
      return mapActiveWorkspace(state, (ws) =>
        ws.plannerSessionId === action.sessionId ? null : { ...ws, plannerSessionId: action.sessionId }
      )
    }

    /*
     * A dev server said where it is. Written on the project's own workspace, so
     * it rides the existing persistence differ to disk and is still there next
     * time Forge opens — and returning the workspace untouched when the URL has
     * not moved is what keeps that differ quiet, because this fires again every
     * time the same banner is reprinted.
     */
    case 'noteDetectedUrl':
      return mapWorkspace(state, action.projectId, (ws) =>
        ws.detectedUrl === action.url ? null : { ...ws, detectedUrl: action.url, detectedUrlAt: action.at }
      )

    case 'setPreviewUrl': {
      const url = action.url.trim()
      return mapWorkspace(state, action.projectId, (ws) => {
        if ((ws.previewUrl ?? '') === url) return null
        // Cleared rather than blanked: an empty string on disk would be a
        // choice, and "nothing typed" is the absence of one.
        if (!url) {
          const { previewUrl: _dropped, ...rest } = ws
          return rest
        }
        return { ...ws, previewUrl: url }
      })
    }

    /*
     * The command the preview's Start button runs here, typed by hand. Same
     * shape as `setPreviewUrl` above and for the same reasons: cleared rather
     * than blanked, because an empty string on disk would read as a choice and
     * "nothing typed" is the absence of one — and the absence is what hands the
     * decision back to the package.json sniff.
     */
    case 'setDevCommand': {
      const command = action.command.trim().slice(0, MAX_DEV_COMMAND)
      return mapWorkspace(state, action.projectId, (ws) => {
        if ((ws.devCommand ?? '') === command) return null
        if (!command) {
          const { devCommand: _dropped, ...rest } = ws
          return rest
        }
        return { ...ws, devCommand: command }
      })
    }

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

    case 'openDevices':
      return state.view === 'devices' ? state : { ...state, view: 'devices' }

    case 'closeDevices':
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
  /**
   * Record where a project pushes — see `Project.repoUrl`. Two callers, both in
   * the project menu: Steve typing a URL in, and the auto-detect that asks git
   * when the menu opens on a project that has none.
   *
   * Trimmed and capped on the way through, and an empty string clears the field
   * rather than storing one. Separate from `updateProject` because "clear it"
   * is not something a patch can say.
   */
  setProjectRepoUrl(id: string, url: string): void
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
  /** One rail section's body height, in px. Already clamped by the caller. */
  setRailHeight(id: RailSectionId, height: number): void
  saveProfile(profile: AgentProfile): void
  deleteProfile(id: string): void
  /** Duplicate a profile under a new id, ready to be edited. */
  duplicateProfile(id: string): void
  newTab(profileId?: string, permissionMode?: ClaudePermissionMode): void
  /**
   * Open a shell pane in the current project with `command` already typed into
   * it. Whether it also presses Enter is the caller's call: the update buttons
   * (Settings › Updates & Tools) leave `submit` unset and inherit
   * `settings.updatesAutoRun`; the Devices preview's Start button passes `true`,
   * because a button that says "Start the dev server" and then waits for an
   * Enter it never mentioned has not done what it said.
   */
  openToolPane(title: string, command: string, submit?: boolean): void
  /**
   * Open an agent pane in the current project with `prompt` already in it,
   * unsubmitted.
   *
   * A sibling of `openToolPane` rather than a flag on it, because they differ
   * twice over: a tool pane opens on a shell and may submit itself, an agent
   * pane opens on the project's own default agent and never does. The caller is
   * the git section, for the jobs Forge hands to an agent instead of doing.
   */
  openAgentPane(title: string, prompt: string): void
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

  /* ---------------------------------------------------- delegation panel */
  /** Put a task card on the tray, ready to be dragged onto an agent. */
  addTask(text: string): void
  /** Take a card off the tray — delivered or dismissed, same door. */
  removeTask(id: string): void
  /** Blow the Tasks panel up into the delegation desk, or dock it back. */
  setTasksMaximized(on: boolean): void
  /**
   * Blow one rail section — Git or Activity — up into a panel over the app,
   * or `null` to put it back in the rail. Only one at a time.
   */
  setRailExpanded(id: RailSectionId | null): void
  /** Open or close the "what's new" card. See src/components/WhatsNew.tsx. */
  setWhatsNewOpen(on: boolean): void
  /**
   * Remember the planner terminal's Claude session id on the active project's
   * workspace, so the same conversation resumes across restarts. Minted by the
   * panel on first use; validated by the reducer.
   */
  setPlannerSessionId(sessionId: string): void
  /**
   * Point the Devices preview at a URL by hand. An empty string hands the
   * decision back to whatever the project's terminals have been printing.
   */
  setPreviewUrl(projectId: string, url: string): void
  /**
   * Set the command the Devices preview's Start button runs for a project. An
   * empty string hands the decision back to the package.json sniff.
   */
  setDevCommand(projectId: string, command: string): void

  setNotice(message: string | null): void
  openDataDir(): void

  /* ------------------------------------------------------- settings page */
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  setSettingsSection(section: SettingsSection): void

  /* -------------------------------------------------------- devices page */
  /** Open the Devices preview — the phone-shaped view of Forge Mobile. */
  openDevices(): void
  closeDevices(): void

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
            // A pasted brief goes down whole; a typed command goes through the
            // draft so "Take back typed" can rescue it. See PendingType.paste.
            if (pending.paste) {
              // Focus, a frame, then the text — the DECSET 1004 race documented
              // on TerminalPane's file drop. An agent that has just been told
              // the terminal lost focus will drop the paste that follows it.
              terminalHost.focus(pending.paneId)
              requestAnimationFrame(() => {
                if (!cancelled) terminalHost.paste(pending.paneId, pending.text)
              })
              return
            }
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

  /* ---------------------------------------------------- dev-server URLs
   *
   * The Devices preview shows the project you are working on, and the one thing
   * it needs is where that project's site is being served. Nothing announces
   * that — but the dev server prints it, and Forge is the terminal. TerminalHost
   * watches every pane's output for a loopback URL (see scanForDevUrl) and says
   * which cwd it came from; a pane's cwd is its project's path, which is the
   * whole of the mapping. A folder nobody has in the rail is simply not ours.
   *
   * What a pane prints is only ever a claim about an *address*, though, and the
   * gap between the two is where this used to go wrong. Every pane's output is
   * scanned, agent panes included, so a URL merely *discussed* in a conversation
   * counted the same as one a server announced — and a loopback port is
   * machine-wide besides, so even a real banner can name a port a different
   * project got to first. A car-harness pane that said `localhost:3000` in
   * passing was enough to point both phones at a Remotion studio running out of
   * another folder, under a "Live" chip, and nothing in the picture was wrong
   * except all of it.
   *
   * So a detection is now checked before it is believed: main finds the process
   * listening on that port and asks whether it descends from one of this
   * project's panes, or names this project's folder in its command line
   * (`confirmProjectServer`). A stranger's server is dropped on the floor. The
   * check is deliberately generous about uncertainty — a probe that cannot run
   * confirms — because failing to show a project its own site is the worse of
   * the two mistakes.
   */
  useEffect(() => {
    let live = true
    const unsub = terminalHost.onDevUrl((cwd, url) => {
      const project = state.projects.find((p) => p.path === cwd)
      if (!project) return
      void (async () => {
        const ours = await confirmProjectServer(url, cwd, terminalHost.pidsForCwd(cwd))
        if (!ours || !live) return
        dispatch({ type: 'noteDetectedUrl', projectId: project.id, url, at: Date.now() })
      })()
    })
    return () => {
      live = false
      unsub()
    }
  }, [state.projects])

  /* ----------------------------------------------------- live settings */

  // The settings, mirrored for renderer modules that live outside the React
  // tree. The terminal host reads the exit-chime toggle back through this —
  // panes keep running with no component mounted, so a hook could never reach
  // them. Runs on every change, hydrate included.
  useEffect(() => {
    setLiveSettings(state.settings)
  }, [state.settings])

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
      setProjectRepoUrl: (id, url) => dispatch({ type: 'setProjectRepoUrl', id, url }),
      removeProject: (id) => {
        dispatch({ type: 'removeProject', id })
        // The reducer queues the project's planner pane for disposal; the
        // transcript watch is main-process state, so it is dropped here.
        window.forge.planner.unwatch(id)
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
      setRailHeight: (id, height) => dispatch({ type: 'setRailHeight', id, height }),
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
      openToolPane: (title, command, submit) => {
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
          // A caller that knows its own answer gives one; the update buttons
          // don't, and inherit the auto-run setting they have always had.
          submit: submit ?? state.settings.updatesAutoRun
        })
      },
      openAgentPane: (title, prompt) => {
        // The project's own default agent, not a shell and not a fixed profile:
        // a brief written for "an agent" belongs to whichever one this project
        // works with, and a Codex project should not have Claude opened at it.
        dispatch({
          type: 'openToolPane',
          profileId: defaultProfileFor(activeProjectId),
          title: title.slice(0, 40),
          text: prompt,
          // Typed, never submitted — the same contract dictation, task cards and
          // the tab handover all honour. Pasted rather than typed because these
          // are multi-sentence briefs; see PendingType.paste.
          submit: false,
          paste: true
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
      addTask: (text) => dispatch({ type: 'taskAdd', text }),
      removeTask: (id) => dispatch({ type: 'taskRemove', id }),
      setTasksMaximized: (on) => dispatch({ type: 'tasksMaximized', on }),
      setRailExpanded: (id) => dispatch({ type: 'railExpanded', id }),
      setWhatsNewOpen: (on) => dispatch({ type: 'whatsNewOpen', on }),
      setPlannerSessionId: (sessionId) => dispatch({ type: 'plannerSession', sessionId }),
      setPreviewUrl: (projectId, url) => dispatch({ type: 'setPreviewUrl', projectId, url }),
      setDevCommand: (projectId, command) => dispatch({ type: 'setDevCommand', projectId, command }),
      resetMosaicLayout: () => dispatch({ type: 'mosaicReset' }),
      setNotice: (message) => dispatch({ type: 'notice', message }),
      openDataDir: () => void window.forge.store.revealDataDir(),

      openSettings: (section) => dispatch({ type: 'openSettings', ...(section ? { section } : {}) }),
      closeSettings: () => dispatch({ type: 'closeSettings' }),
      setSettingsSection: (section) => dispatch({ type: 'setSettingsSection', section }),

      openDevices: () => dispatch({ type: 'openDevices' }),
      closeDevices: () => dispatch({ type: 'closeDevices' }),

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

  /**
   * Which panes a phone is reading, so the terminal host can label them. Ids
   * and no geometry: the desk keeps its own grid while it has a window and the
   * phone draws that grid scaled to its screen — see `setPhoneWatched`. Kept
   * next to the op handler because it is the same conversation — the phone's
   * half of a pane the desktop also has open — and separate from it because it
   * depends on nothing in the reducer.
   */
  useEffect(() => {
    return window.forge.mobile.onWatched(({ ids }) => {
      terminalHost.setPhoneWatched(Array.isArray(ids) ? ids : [])
    })
  }, [])

  /** And the same message for a browser on Forge Web — see `setBrowserWatched`. */
  useEffect(() => {
    return window.forge.web.onWatched(({ ids }) => {
      terminalHost.setBrowserWatched(Array.isArray(ids) ? ids : [])
    })
  }, [])

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
          if (workspaceOf(state, project.id).tabs.length >= MAX_TABS_PER_PROJECT)
            return answer(`That project already holds its ${MAX_TABS_PER_PROJECT} tabs.`)
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

  /**
   * The same conversation with a browser, and it has to exist separately.
   *
   * `WebLayoutOp` is not `OpFrame`: it carries `close-tab`, `focus-pane` and
   * `select-project`, which the phone has no gesture for, and a `direction` on
   * `create-pane` because a browser window is wide enough for the choice to
   * matter. Handling both in one effect would mean a union of two wires and a
   * cast per branch; two handlers over one set of actions is the cheaper honesty.
   *
   * Without this, everything below still existed and none of it worked. The
   * frame shipped, `electron/web-host.ts` forwarded it to this window, `shared/
   * api.ts` documented the pair, `electron/preload.ts` exposed it — and nothing
   * in the renderer ever subscribed, so every op a browser sent went unanswered
   * until `dispatchLayout`'s deadline turned it into "The desktop did not answer
   * in time". Adding a tab from the browser did nothing at all, and so did
   * closing one, splitting one, and switching project.
   */
  useEffect(() => {
    return window.forge.web.onCommand(({ requestId, op }) => {
      const answer = (error?: string): void => window.forge.web.commandResult(requestId, error)
      const project = state.projects.find((p) => p.id === op.projectId)
      if (!project) return answer('That project is no longer open on the desktop.')
      // Every op names its project, and acting on one that is not on screen
      // would mean opening a tab nobody at the desk can see. Selecting first is
      // also what makes `select-project` a real operation rather than a no-op.
      if (state.activeProjectId !== project.id) dispatch({ type: 'selectProject', projectId: project.id })
      if (op.op === 'select-project') return answer()

      // Checked here as well as in the reducer, because the reducer reports a
      // full Forge by setting a `notice` on the desktop — which the browser
      // cannot see. Refusing here is what turns it into an answer.
      const atLimit = totalPanes(state) >= MAX_SESSIONS

      // Wire data, so it is checked and never cast: anything that is not one of
      // the four modes becomes undefined, which means "whatever the profile
      // says" — exactly what a browser that never sent the field gets.
      const mode = isPermissionMode(op.permissionMode) ? op.permissionMode : undefined

      switch (op.op) {
        case 'create-tab':
          if (atLimit) return answer(`Forge is at its ${MAX_SESSIONS}-session limit.`)
          if (workspaceOf(state, project.id).tabs.length >= MAX_TABS_PER_PROJECT)
            return answer(`That project already holds its ${MAX_TABS_PER_PROJECT} tabs.`)
          actions.newTab(op.profileId ?? project.defaultProfileId, mode)
          return answer()
        case 'close-tab':
          if (!op.tabId) return answer('No tab named.')
          actions.closeTab(op.tabId)
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
          // The browser's own default when it sends nothing, matching the
          // desktop's split button rather than inventing a third answer.
          actions.splitPane(paneId, op.direction === 'column' ? 'column' : 'row', op.profileId ?? project.defaultProfileId, mode)
          return answer()
        }
        case 'close-pane':
          if (!op.paneId) return answer('No pane named.')
          actions.closePane(op.paneId)
          return answer()
        case 'focus-pane':
          if (!op.paneId) return answer('No pane named.')
          // `revealPane` rather than `focusPane`: a browser can name a pane in a
          // tab that is not the one on screen here, and moving the ring to a
          // pane nobody can see is a focus that is invisible at the desk.
          actions.revealPane(op.paneId)
          return answer()
        default:
          return answer('Forge does not know that command.')
      }
    })
  }, [actions, state])

  /**
   * The layout, as the main process has just changed it.
   *
   * This is the other half of electron/layout-engine.ts, and the reason the two
   * `onCommand` handlers above are now dead for every verb but
   * `select-project`. A phone's close-pane is performed in main, against the
   * authoritative workspace, and saved there; this window is *told*. Which is
   * the whole fix: a renderer that has crashed, hung or gone blank can no
   * longer strand somebody three hundred miles from the desk, because nothing
   * out there is waiting on it any more.
   *
   * Optional-chained the whole way down on purpose. A Forge that is already
   * running booted with the preload bundle it had at the time, and that one has
   * no `onWorkspaceReplaced` on it — a bare call would throw at mount and take
   * the window out, which is precisely the failure this path exists to survive.
   *
   * The empty dependency list is deliberate: this subscribes once and reads
   * nothing from render scope but the two stable refs.
   */
  useEffect(() => {
    return window.forge?.store?.onWorkspaceReplaced?.(({ projectId, workspace }) => {
      if (!projectId || !workspace || !Array.isArray(workspace.tabs)) return
      // Marked persisted *before* the dispatch, and this line is load-bearing:
      // main has already written this exact workspace to disk, so without it
      // the 250ms persistence effect would wake up, notice the copy in state is
      // not the one it last wrote, and push the window's stale idea straight
      // back over main's. The remote op would appear to work and then undo
      // itself half a second later.
      persisted.current.workspaces.set(projectId, JSON.stringify(workspace))
      dispatch({ type: 'workspaceReplaced', projectId, workspace })
      // And the desk follows, exactly as it did when the renderer performed
      // these ops itself: a tab opened from away into a project nobody here is
      // looking at is a tab nobody at the desk can see.
      dispatch({ type: 'selectProject', projectId })
    })
  }, [])

  /**
   * A folder somebody picked in a browser, on its way into the rail.
   *
   * The desktop's own Add project opens a native folder picker, which is a
   * window on a screen nobody three hundred miles away is sitting at — so Forge
   * Web browses this machine's folders in the page instead and ends here. What
   * arrives has already been checked on the main side (`dispatchProjectAdd`):
   * absolute, present, and a directory as of a moment ago.
   *
   * `actions.addProjectPath` and nothing else, because that is exactly what
   * `AddProjectMenu` calls after the native dialog. A browser therefore adds a
   * project the same way a click at the desk does — including landing on the
   * project it named if the rail already holds it — rather than through a
   * second route into the list that could drift from the first.
   */
  useEffect(() => {
    return window.forge.web.onProjectAdd(({ requestId, path }) => {
      const answer = (error?: string): void => window.forge.web.commandResult(requestId, error)
      const folder = String(path ?? '').trim()
      if (!folder) return answer('That request named no folder.')
      actions.addProjectPath(folder)
      return answer()
    })
  }, [actions])

  /**
   * The television asking to watch this desktop's screen.
   *
   * Thin on purpose, and depends on nothing in the reducer: the capture, the
   * peer connection and every way one of them can end live in src/lib/mirror.ts,
   * so this is only the wire between that module and the socket. There is no
   * control for it anywhere on the desktop — the sole trigger is the TV asking.
   */
  useEffect(() => {
    return window.forge.mobile.onMirror((event) => {
      if (event.kind === 'signal') return handleSignal(event.data)
      if (event.kind === 'stop') return stopMirror()
      void startMirror(
        event.audio,
        (data) => window.forge.mobile.mirrorSignal(data),
        (reason) => window.forge.mobile.mirrorStop(reason)
      ).then((error) => {
        // Refused before it began — the television is told why rather than
        // left watching a black screen for a stream that is never coming.
        if (error) window.forge.mobile.mirrorStop(error)
      })
    })
  }, [])

  /**
   * A browser asking to watch this desktop's screen.
   *
   * The same shape as the television's above and deliberately so, because it is
   * the same errand with a different pipe: the capture and every way an encoder
   * can die live in src/lib/web-mirror.ts, and this is only the wire between
   * that module and the socket. What differs is what comes back — encoded chunks
   * rather than an SDP, because WebRTC media never enters the tunnel a browser
   * reaches this desk through (see the screen-mirror block in shared/web.ts) —
   * and that there is no signalling half to answer.
   *
   * There is no control for this at the desk either. Whether a browser may watch
   * at all, whether it must spend a second factor first, and whether it may also
   * drive are settled in main before this ever fires; `Settings › Forge Web` is
   * where a watch in progress is seen and stopped.
   */
  useEffect(() => {
    return window.forge.web.onMirror((event) => {
      if (event.kind === 'stop') return stopWebMirror()
      void startWebMirror(event.audio, {
        ready: (config) => window.forge.web.mirrorReady(config),
        chunk: (chunk) => window.forge.web.mirrorChunk(chunk),
        closed: (reason) => window.forge.web.mirrorStop(reason)
      }).then((error) => {
        // Refused before it began — the browser is told why rather than left on
        // a spinner for a picture that is never coming.
        if (error) window.forge.web.mirrorStop(error)
      })
    })
  }, [])

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

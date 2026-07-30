/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this file dependency-free — it is imported from all three
 * contexts.
 */

/* ------------------------------------------------------------------ agents */

/**
 * An agent profile describes *what gets typed into a fresh shell*. Every pane
 * is a real pwsh session; a profile just decides whether we bootstrap it with
 * a command (`claude`, `kimi`, …) so that when the agent exits the prompt is
 * still there.
 */
export interface AgentProfile {
  id: string
  name: string
  /** Command written into the fresh shell. Empty string = plain shell. */
  command: string
  /** Accent colour used for the badge + pane focus ring. */
  accent: string
  /** Two-letter badge, e.g. "CC". */
  badge: string
  /** Built-ins ship with the app and cannot be deleted (only edited). */
  builtin?: boolean
}

/* ---------------------------------------------------------------- projects */

export interface Project {
  id: string
  name: string
  /** Absolute folder path — the cwd for every session in this workspace. */
  path: string
  /** Colour dot in the rail. */
  color: string
  /** Profile used when a pane is opened without an explicit choice. */
  defaultProfileId: string
  createdAt: number
}

/* ------------------------------------------------------------ pane layouts */

export type SplitDirection = 'row' | 'column'

/** A terminal pane. `id` doubles as the PTY session id. */
export interface PaneLeaf {
  type: 'leaf'
  id: string
  profileId: string
  /** User-editable title. Empty = derive from the profile name. */
  title: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  /** `row` = side by side, `column` = stacked. */
  direction: SplitDirection
  /** Fraction of the axis taken by `a` (0.1 – 0.9). */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = PaneLeaf | PaneSplit

export interface TerminalTab {
  id: string
  title: string
  root: LayoutNode
  activePaneId: string
}

/**
 * How a project's terminal workspace is presented.
 *
 * `tabs`   one tab at a time, its pane tree at full size — the working view.
 * `mosaic` every live pane in the project as a small live tile — the peek view.
 */
export type WorkspaceViewMode = 'tabs' | 'mosaic'

/** One project's terminal workspace. */
export interface Workspace {
  tabs: TerminalTab[]
  activeTabId: string | null
  /** Optional so workspaces written before the mosaic existed still load. */
  viewMode?: WorkspaceViewMode
}

/* ------------------------------------------------------------------- shots */

/**
 * One screenshot on the shelf, as the renderer sees it. The main process owns
 * the files (see electron/shots/shelf.ts) and hands over a thumbnail data URL
 * rather than a path, because a renderer cannot read `file://` under our CSP —
 * and because 12 full-size 4K PNGs decoded in the DOM is not a tray, it is a
 * memory leak with rounded corners.
 */
export interface Shot {
  /** The file name — stable identity for keys and delete calls. */
  id: string
  name: string
  path: string
  createdAt: number
  bytes: number
  /** Pixel size of the original image. */
  width: number
  height: number
  /** PNG data URL, scaled to fit the tray (and a hover preview). */
  thumb: string
}

/* ---------------------------------------------------------------- settings */

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface Settings {
  /** Editable in %APPDATA%\Forge\settings.json — built-ins are seeded here. */
  agentProfiles: AgentProfile[]
  lastProjectId: string | null
  railCollapsed: boolean
  terminalFontSize: number
  terminalFontFamily: string
  /** Shell executable. Defaults to pwsh.exe (PowerShell 7). */
  shell: string
  /** Watch the clipboard for screenshots and copied images. */
  catchShots: boolean
  /** How many shots the shelf keeps before pruning the oldest. */
  shotsKeep: number
  window: WindowBounds
}

/* -------------------------------------------------------------------- ipc */

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  dataDir: string
  maxSessions: number
  shell: string
}

export interface CreateSessionRequest {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Command written into the shell once it is ready. Empty = nothing. */
  bootstrapCommand?: string
}

export type CreateSessionResult =
  | {
      ok: true
      id: string
      pid: number
      /** True when an existing shell was re-adopted (renderer reload/crash). */
      restored?: boolean
    }
  | { ok: false; id: string; error: string }

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal?: number
}

export interface WindowStateEvent {
  maximized: boolean
  focused: boolean
}

export interface StoreSnapshot {
  settings: Settings
  projects: Project[]
}

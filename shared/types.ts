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

/** One project's terminal workspace. */
export interface Workspace {
  tabs: TerminalTab[]
  activeTabId: string | null
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
  window: WindowBounds

  /* ------------------------------------------------------ dictation (M3) */
  /** Python interpreter that can import onnx-asr + sounddevice. */
  sttPython: string
  /** Folder holding the Parakeet ONNX model files. */
  sttModelDir: string
  /** Stop listening after this many seconds of silence (0 = never). */
  sttAutoStopSeconds: number
  /** KeyboardEvent.code that toggles dictation while Forge is focused. */
  sttHotkey: string
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

/* -------------------------------------------------------------- dictation */

/**
 * The dictation sidecar's life in one word.
 *
 *   off        never started (it is spawned lazily, on first use)
 *   starting   process up, model loading — a few seconds
 *   idle       ready and waiting for the hotkey
 *   listening  mic open, `level` is live
 *   finishing  mic closed, the last phrase is still being transcribed
 *   error      see `error`; setup-shaped kinds need the user to fix a path
 */
export type SttPhase = 'off' | 'starting' | 'idle' | 'listening' | 'finishing' | 'error'

export type SttErrorKind =
  /** The configured interpreter is not there, or refused to launch. */
  | 'python-missing'
  /** stt_service.py could not be found next to the app. */
  | 'sidecar-missing'
  /** The model folder is absent, or its files are missing/truncated. */
  | 'model-missing'
  /** onnx-asr found the files but would not load them. */
  | 'model-load'
  /** The microphone could not be opened (in use, or no permission). */
  | 'audio'
  /** Asked to listen while the model was still loading. */
  | 'not-ready'
  /** Restarted too many times too quickly — we stopped trying. */
  | 'crash-loop'
  | 'internal'

export interface SttError {
  kind: SttErrorKind
  msg: string
}

export interface SttStatus {
  phase: SttPhase
  /** Smoothed 0..1 mic level. Only meaningful while listening. */
  level: number
  error: SttError | null
  /** True once the model has reported ready in the current sidecar process. */
  ready: boolean
}

export interface SttPhraseEvent {
  text: string
}

/**
 * Errors the user has to *fix something* about, rather than retry. These put
 * the pill in its amber state and open the setup card.
 */
export function isSttSetupError(kind: SttErrorKind): boolean {
  return (
    kind === 'python-missing' ||
    kind === 'sidecar-missing' ||
    kind === 'model-missing' ||
    kind === 'model-load' ||
    kind === 'crash-loop'
  )
}

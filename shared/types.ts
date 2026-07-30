/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this file dependency-free — it is imported from all three
 * contexts.
 */

/* ------------------------------------------------------------------ agents */

/**
 * What a profile *is*, which is not the same question as what it runs.
 *
 * `shell` a bare prompt. Neutral chrome: it is a tool, not a collaborator.
 * `agent` something that takes instructions — Claude, Kimi, Gemini, your own.
 *
 * The chooser and the profile editor group by this, so "give me a shell" is
 * never buried three rows down a list of agents.
 */
export type ProfileKind = 'shell' | 'agent'

/**
 * How much Claude Code is allowed to do without asking, chosen per profile and
 * overridable per pane.
 *
 *   default      Claude's own prompting — no flag
 *   acceptEdits  --permission-mode acceptEdits
 *   plan         --permission-mode plan
 *   bypass       --dangerously-skip-permissions
 *
 * `bypass` is exactly as advertised: the agent stops asking. Panes launched
 * with it are badged BYPASS in the header, because the one thing worse than a
 * dangerous mode is a dangerous mode you forgot you turned on.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

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
  /**
   * Register Forge's cross-agent bridge (the Gemini MCP server) with this
   * agent at launch. Only meaningful for agents that accept Claude Code's
   * `--mcp-config` flag. Set `false` explicitly to opt a built-in out.
   */
  mcpBridge?: boolean
  /**
   * Optional so profiles written before the split still load; the store fills
   * it in from the command (empty command = shell).
   */
  kind?: ProfileKind
  /** Default permission mode for claude-shaped commands. */
  permissionMode?: ClaudePermissionMode
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
  /**
   * Per-open override of the profile's Claude permission mode, chosen in the
   * chooser. Absent = whatever the profile says.
   */
  permissionMode?: ClaudePermissionMode
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

/**
 * Which interpreter the voice agent talks to. `gemini` is the live one;
 * `stub` is the offline fallback used whenever no key is set.
 */
export type VoiceBrainId = 'stub' | 'gemini' | 'claude' | 'openai'

/* ------------------------------------------------------- voice-agent ipc */

export interface GeminiCallRequest {
  key: string
  model: string
  system: string
  /** Oldest first. `model` is Gemini's own past replies. */
  turns: Array<{ role: 'user' | 'model'; text: string }>
  /** JSON schema handed to responseSchema, when the caller wants strict JSON. */
  schema?: unknown
  timeoutMs?: number
}

export type GeminiCallResult =
  | { ok: true; text: string; finishReason?: string; model?: string }
  | { ok: false; error: string; status?: number }

export type ImportedKeyResult =
  | { ok: true; key: string; last4: string; source: string }
  | { ok: false; error: string }

/* ------------------------------------------------------------------ themes */

/**
 * A theme is a *core* of eight-odd colours plus the sixteen terminal slots.
 * Everything else in tokens.css (sunken wells, hovers, hairlines, the accent
 * washes, muted ink) is derived from those by mixing — see src/theme/themes.ts.
 *
 * That is what makes the theme editor tractable: you pick a background, a panel,
 * an ink and an accent, and the other forty tokens follow without you having to
 * keep them in step by hand.
 */
export interface ThemeCore {
  id: string
  name: string
  /** Drives the derivation direction and any light-only CSS. */
  appearance: 'dark' | 'light'
  /** App background. */
  bg: string
  /** Rail, trays, status bar — the raised furniture. */
  panel: string
  /** Primary ink. */
  text: string
  /** The one loud colour: live / focused / go. */
  accent: string
  danger: string
  warn: string
  info: string
  ok: string
  /** xterm canvas — usually a shade off `bg`. */
  termBg: string
  termFg: string
  /**
   * The sixteen ANSI slots in the canonical order:
   * black red green yellow blue magenta cyan white, then the eight brights.
   */
  ansi: string[]
  /** Set on themes the user made, so they can be deleted. */
  custom?: boolean
  /** Which built-in this one started life as. */
  basedOn?: string
}

/* ------------------------------------------------------- speech engine (M6) */

/**
 * Where dictation's Parakeet model is coming from.
 *
 *   forge         downloaded into %APPDATA%\Forge\models — ours
 *   dictationmic  DictationMic already has one and we are pointed at it
 *   missing       nothing usable at the configured path
 */
export type EngineSource = 'forge' | 'dictationmic' | 'missing'

export interface EngineState {
  source: EngineSource
  /** The folder the sidecar will be given. */
  dir: string
  /** Total bytes of the model files actually present. */
  bytes: number
  /** Forge's own model folder, whether or not it is populated. */
  forgeDir: string
  /** Per-file presence, newest check. */
  files: Array<{ name: string; bytes: number; ok: boolean }>
  /** True while a download is running. */
  downloading: boolean
}

export interface EngineProgress {
  /** 0..1 over the whole download, or null before the first byte lands. */
  fraction: number | null
  /** Which file is in flight. */
  file: string
  receivedBytes: number
  totalBytes: number
  /** Set when the download finished, failed or was cancelled. */
  done?: 'ok' | 'error' | 'cancelled'
  error?: string
}

/* -------------------------------------------------------- system probes */

export type ClaudeCliState =
  | { ok: true; version: string }
  | { ok: false; error: string }

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

  /* ------------------------------------------------------ dictation (M3) */
  /** Python interpreter that can import onnx-asr + sounddevice. */
  sttPython: string
  /** Folder holding the Parakeet ONNX model files. */
  sttModelDir: string
  /** Stop listening after this many seconds of silence (0 = never). */
  sttAutoStopSeconds: number
  /** KeyboardEvent.code that toggles dictation while Forge is focused. */
  sttHotkey: string

  /* --------------------------------------------------- voice agent (M4) */
  /** Voice-agent panel: open state and width in px. */
  voicePanelOpen: boolean
  voicePanelWidth: number
  voiceBrain: VoiceBrainId
  /**
   * Anthropic key for the (unbuilt) ClaudeBrain. Stored here and used nowhere:
   * no code in Forge sends it anywhere.
   */
  anthropicKey: string
  /**
   * Google AI Studio key for GeminiBrain — the one brain that really talks to a
   * model. Sent only to generativelanguage.googleapis.com, only when Gemini is
   * the selected brain.
   */
  geminiKey: string
  geminiModel: string

  /* --------------------------------------------------- account + themes (M6) */
  /** Display name on the account chip. Seeded from the Windows username. */
  accountName: string
  /** Avatar colour. */
  accountColor: string
  /** Built-in or custom theme id. Falls back to `volt` if it has gone missing. */
  themeId: string
  /** Themes the user built in the theme editor. */
  customThemes: ThemeCore[]
  /** Force the reduced-motion behaviour on, regardless of the OS setting. */
  reducedMotion: boolean

  /* --------------------------------------------------------- keys (M6) */
  /**
   * OpenRouter key for the (unbuilt) Kimi brain. Like anthropicKey: stored
   * here and used nowhere.
   */
  openrouterKey: string

  /* -------------------------------------------------- voice relay (M6) */
  /**
   * Hand a finished agent turn straight back to the voice agent instead of
   * waiting to be asked. Stored here; the behaviour itself lives elsewhere.
   */
  voiceAutoRelay: boolean
  /** How long a pane must be quiet before a relay counts as "finished". */
  voiceRelayGraceMs: number
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

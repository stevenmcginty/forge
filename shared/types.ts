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
  /**
   * Register Forge's cross-agent bridge (the Gemini MCP server) with this
   * agent at launch. Only meaningful for agents that accept Claude Code's
   * `--mcp-config` flag. Set `false` explicitly to opt a built-in out.
   */
  mcpBridge?: boolean
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

/**
 * Which interpreter the voice agent talks to. `gemini` and `openrouter` are the
 * live ones; `stub` is the offline fallback used whenever no key is set.
 */
export type VoiceBrainId = 'stub' | 'gemini' | 'openrouter' | 'claude' | 'openai'

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

/**
 * OpenRouter's chat-completions call. Deliberately OpenAI-shaped, because that
 * is the API OpenRouter speaks — `system` is folded into the first message by
 * the main process rather than here.
 */
export interface OpenRouterCallRequest {
  key: string
  model: string
  system: string
  /** Oldest first. `assistant` is the model's own past replies. */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Ask for `response_format: { type: 'json_object' }`. */
  json?: boolean
  maxTokens?: number
  timeoutMs?: number
}

export type OpenRouterCallResult =
  | { ok: true; text: string; finishReason?: string; model?: string }
  | { ok: false; error: string; status?: number }

/** Which on-disk key a `voice:import-key` call is after. */
export type KeySource = 'gemini' | 'openrouter'

export type ImportedKeyResult =
  | { ok: true; key: string; last4: string; source: string }
  | { ok: false; error: string }

/* --------------------------------------------------------- media generation */

/**
 * Generate an image. `projectPath` decides where it lands: the current project's
 * `assets/generated/`, falling back to %APPDATA%\Forge\bridge-out when no
 * project is open. The key is read from settings in the main process — it never
 * travels from the renderer.
 */
export interface MakeImageRequest {
  description: string
  count?: number
  aspect?: string
  projectPath?: string
}

export interface EditImageRequest {
  path: string
  instruction: string
  projectPath?: string
}

export type MediaCallResult =
  | {
      ok: true
      /** Absolute paths of files actually written. Never empty. */
      paths: string[]
      model: string
      ms: number
      /** How many landed on the screenshot shelf. */
      adopted: number
      note?: string
    }
  | { ok: false; error: string; kind: string }

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
  /**
   * Image-generation model for `make_image` / `edit_image`. Empty means "use the
   * built-in default" (gemini-2.5-flash-image), which is also what the MCP
   * bridge falls back to, so the two cannot disagree by accident.
   */
  geminiImageModel: string
  /**
   * OpenRouter key for OpenRouterBrain. Sent only to openrouter.ai, only when
   * OpenRouter is the selected brain.
   */
  openrouterKey: string
  openrouterModel: string

  /* ------------------------------------------------- forge companion (M9)
   *
   * The phone link. Every field is inert until `companionEnabled` is true AND
   * a session has been signed in — nothing here causes a single network call
   * on its own. See companion/README.md and companion/GO-LIVE.md.
   */

  /** Master switch. False = the service never starts, never reads a token. */
  companionEnabled: boolean
  /**
   * Firebase Web API key of the companion project (`forge-sync`). Public by
   * design: it identifies the project, it does not authorise anything —
   * database.rules.json is what authorises.
   */
  companionApiKey: string
  /**
   * RTDB root, e.g. `https://forge-sync-default-rtdb.europe-west1.firebasedatabase.app`.
   * Against the emulator suite: `http://127.0.0.1:9000?ns=forge-sync-default-rtdb`
   * — any query string here is carried onto every request.
   */
  companionDatabaseURL: string
  /**
   * Identity Toolkit base. Blank = Google's real one. Set only to point the
   * whole link at the emulator, which serves the same REST API under a path
   * prefix: `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1`.
   */
  companionAuthBase: string
  /** Secure Token base. Blank = Google's. Emulator: same host, `/securetoken.googleapis.com/v1`. */
  companionTokenBase: string
  /** The signed-in account. Kept after sign-out so the form pre-fills. */
  companionEmail: string
  /**
   * The only credential stored on disk, and never the password: a Firebase
   * refresh token, revocable from the Firebase console without touching any
   * password Steve uses elsewhere.
   */
  companionRefreshToken: string
  companionUid: string
}

/* ---------------------------------------------------- companion ipc (M9) */

export type CompanionState = 'off' | 'signed-out' | 'connecting' | 'live' | 'offline' | 'error'

export interface CompanionStatus {
  enabled: boolean
  /** Has a key, a database and a restorable session. */
  configured: boolean
  state: CompanionState
  email: string
  uid: string
  /** A human sentence for the settings panel, or empty when there is nothing to say. */
  detail: string
  /** How many projects were last published. */
  projects: number
  /** Epoch ms of the last inbox item consumed. 0 = none this session. */
  lastInboxAt: number
}

/**
 * A message from the phone, on its way to the voice agent.
 *
 * THE contract for the voice hookup: subscribe with
 * `window.forge.companion.onUtterance(...)`, do whatever the voice pipeline
 * does with a transcript, then call `window.forge.companion.reply(itemId, text)`
 * to put the answer back on Steve's phone. `itemId` is opaque — pass back
 * exactly what you were given and the reply threads under the message.
 */
export interface CompanionUtteranceEvent {
  /** Forge's own project id, as in `Project.id`. */
  projectId: string
  projectName: string
  /** Opaque id of the inbox item. Hand it to `reply()` to thread the answer. */
  itemId: string
  text: string
}

export type CompanionSignInResult = { ok: true; uid: string; created: boolean } | { ok: false; error: string }

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

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
 * How much an agent is allowed to do without asking, chosen per profile and
 * overridable per pane.
 *
 * The four names are Claude Code's, because it got here first — but they are
 * rungs on a ladder, not Claude's flags, and every agent that has a comparable
 * ladder is mapped onto them. `shared/agents.ts` owns that mapping (see
 * PERMISSION_FAMILIES); today Claude Code and Codex both have one:
 *
 *                Claude Code                        Codex
 *   default      (no flag)                          (no flag)
 *   acceptEdits  --permission-mode acceptEdits      --full-auto
 *   plan         --permission-mode plan             --sandbox read-only
 *   bypass       --dangerously-skip-permissions     --dangerously-bypass-…
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
  /** Default permission mode, for commands that have one (see permissionFamily). */
  permissionMode?: ClaudePermissionMode
  /**
   * Launch this agent with Claude Code's Remote Control, so the session can be
   * watched and driven from Steve's phone (see docs/REMOTE.md). Only meaningful
   * for agents that accept `--remote-control`; set `false` to opt a built-in
   * out. Undefined means off, so a custom profile never gets a flag its tool
   * has never heard of.
   */
  remoteControl?: boolean
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
   * Per-open override of the profile's permission mode, chosen in the chooser.
   * Absent = whatever the profile says.
   */
  permissionMode?: ClaudePermissionMode
  /**
   * The Claude Code session this pane owns, as a uuid Forge minted when the
   * pane was created.
   *
   * This is the whole of resume-on-restore: because it is saved with the
   * layout, reopening Forge can hand the same id back to Claude and get the
   * same conversation, rather than the same empty box. Optional so panes
   * written before it existed still load — they are given one on load, and
   * simply start fresh that once. See shared/session.ts.
   */
  sessionId?: string
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
  /**
   * The tab's own colour in the strip. Optional so tabs written before colours
   * existed still load, and absent — not empty — when the tab is untinted.
   */
  color?: string
  /**
   * Terminal text colour for every pane in this tab: the default foreground
   * xterm paints uncoloured output in, which is most of what an agent prints.
   * Output that names its own ANSI colour keeps it — that is the point of it.
   */
  textColor?: string
}

/**
 * How a project's terminal workspace is presented.
 *
 * `tabs`   one tab at a time, its pane tree at full size — the working view.
 * `mosaic` every live pane in the project as a small live tile — the peek view.
 */
export type WorkspaceViewMode = 'tabs' | 'mosaic'

/* ------------------------------------------------------------ mosaic wall */

/** A tile's box on the freeform mosaic wall, in wall pixels from its top-left. */
export interface MosaicRect {
  x: number
  y: number
  w: number
  h: number
}

/** A tile's placement, plus how its terminal is shown inside it. */
export interface MosaicTile extends MosaicRect {
  /**
   * True once the user double-clicked the header: the PTY is refitted to the
   * box (real cols/rows, life-size type) instead of being scaled into it, and
   * follows the box from then on. Opt-in per tile — see MosaicView.
   */
  fit?: boolean
}

/**
 * How the wall arranges itself.
 *
 * `auto`   the uniform grid: Forge places every tile, nobody drags anything.
 * `custom` freeform: every tile has a box the user put it in.
 */
export type MosaicLayoutMode = 'auto' | 'custom'

/**
 * How the mosaic draws terminal text — the wall's one legibility decision.
 *
 * `lifesize` every tile refits its PTY to its own box, so the type is exactly
 *            the size it is in tab view no matter how many tiles are up. You
 *            trade columns for letters: eight tiles means eight narrow
 *            terminals, not eight unreadable ones.
 * `scaled`   every tile is a scale model — the PTY keeps the cols and rows it
 *            had in tab view and the whole picture is shrunk to fit, so a
 *            full-screen TUI never reflows. Truthful, and past four or five
 *            tiles, tiny.
 *
 * A tile the user double-clicked overrides this either way — see MosaicTile.
 */
export type MosaicTextMode = 'lifesize' | 'scaled'

/** A project's freeform wall. Absent until the user first moves a tile. */
export interface MosaicState {
  mode: MosaicLayoutMode
  /** paneId → box. Only read in `custom` mode. */
  tiles: Record<string, MosaicTile>
  /**
   * Tabs the user dragged out of the strip and onto the wall. Purely a marker:
   * the tab itself is untouched, and its panes were already on the wall — the
   * strip just says which ones you placed by hand.
   */
  wallTabs: string[]
}

/** One project's terminal workspace. */
/**
 * One task on the delegation tray: a prompt written once, waiting to be
 * dragged onto whichever agent should do it. The card *is* the delegation
 * mechanism — there is no queue engine behind it, deliberately.
 */
export interface TaskCard {
  id: string
  text: string
  createdAt: number
}

/** What the tray's Plan button gets back: briefs to become cards, or the reason not. */
export type TaskPlanResult = { ok: true; tasks: string[] } | { ok: false; error: string }

export interface Workspace {
  tabs: TerminalTab[]
  activeTabId: string | null
  /** The delegation tray. Optional so workspaces written before it existed still load. */
  tasks?: TaskCard[]
  /** Optional so workspaces written before the mosaic existed still load. */
  viewMode?: WorkspaceViewMode
  /** Optional so workspaces written before the freeform wall existed still load. */
  mosaic?: MosaicState
  /**
   * How far through TAB_NAME_POOL this project has got. Kept on the workspace
   * rather than recomputed from the open tabs so that closing a tab does not
   * hand its name straight back to the next one — the name you just killed
   * should not reappear on something else a second later.
   *
   * Optional so workspaces written before tabs had names still load.
   */
  nameCursor?: number
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
export type VoiceBrainId = 'stub' | 'gemini' | 'openrouter' | 'groq' | 'claude' | 'openai'

/**
 * How the voice agent answers.
 *
 *   text   written only — the panel as it has always been
 *   both   written and spoken (the default)
 *   voice  spoken only, and the panel collapses to the round button
 */
export type VoiceReplyMode = 'text' | 'both' | 'voice'

/**
 * Where the voice hub is, and how big.
 *
 *   docked    the pill lives in the status bar, as it always has
 *   floating  a bigger pill floating over the app, dragged anywhere
 *   expanded  the Voice Hub card — dial, conversation, composer
 *
 * These three are the *whole* of the voice agent's chrome now: the right-hand
 * panel it used to live in is gone, along with its `voicePanelOpen` and
 * `voicePanelWidth`. Steve's reason was the plain one — it was taking up all
 * that space to show what the hub already shows.
 *
 * `x`/`y` are the top-left of the floating thing in viewport pixels. They are
 * remembered while docked too, so dragging it out a second time puts it back
 * where he last had it rather than in the middle of his terminals. `w`/`h` are
 * the card's size after a corner-drag; 0 means "the default card", which is
 * what every install starts with.
 */
export type VoiceHubMode = 'docked' | 'floating' | 'expanded'

export interface VoiceHubPlacement {
  mode: VoiceHubMode
  x: number
  y: number
  w: number
  h: number
}

/** `create_project`, as it crosses to the main process. */
export interface MakeProjectFolderRequest {
  name: string
  /** 'desktop' | 'documents' | 'projectsroot', or an absolute allowed root. */
  parentDir?: string
}

export type MakeProjectFolderResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string; path?: string }

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

/**
 * Groq's call, which is the same call.
 *
 * Groq serves the OpenAI chat-completions API verbatim, so the wire shape is
 * byte-for-byte what OpenRouter takes — and these are aliases rather than a
 * second interface on purpose. One shape means one implementation in
 * electron/voice-bridge.ts (`callChat`), and a field added for one provider
 * cannot go missing for the other.
 */
export type GroqCallRequest = OpenRouterCallRequest
export type GroqCallResult = OpenRouterCallResult

/** Which on-disk key a `voice:import-key` call is after. */
export type KeySource = 'gemini' | 'openrouter' | 'groq'

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

/* -------------------------------------------------------- system probes */

export type ClaudeCliState =
  | { ok: true; version: string }
  | { ok: false; error: string }

/* ------------------------------------------------------ updates & tools */

/** The tools the Updates & Tools section reports on. See shared/tools.ts. */
/**
 * A tool's id.
 *
 * A plain string rather than a union of the five Forge shipped with, because the
 * catalogue is no longer fixed: a row can be one of ours or one that was added
 * in Settings, and a union would have made "the thing I use is not on this list"
 * a code change. Ids added by hand are prefixed `x:` by `sanitiseCustomTool`, so
 * a custom row can never collide with or shadow a built-in one.
 */
export type ToolId = string

/** Where "the latest version" comes from for a given tool. */
export type ToolLatestSource = 'npm' | 'winget' | 'local' | 'none'

export interface ToolSpec {
  id: ToolId
  name: string
  /** One line under the name, explaining what this thing is to Forge. */
  blurb: string
  /** The executable to look for on PATH. */
  command: string
  /** Arguments that make it print its version, or null to never spawn it. */
  versionArgs: string[] | null
  latest: {
    source: ToolLatestSource
    /** For `npm`. */
    npmPackage?: string
    /** For `winget`, tried in order until one is installed. */
    wingetIds?: string[]
  }
  /**
   * The command the Update button types into a pane, when the obvious one from
   * `latest.source` is wrong. Null is not "no update button": for an npm or
   * winget tool `updateCommandFor()` derives one. It means "nothing better than
   * the derived command" — and, when there is no source to derive from either,
   * that this is a local shim Forge has no business updating.
   */
  updateCommand: string | null
  /**
   * What to type when the tool is *not* installed. Same rule: usually derived
   * from the source, set here only when the obvious command is wrong.
   */
  installCommand?: string | null
  /** Added in Settings rather than shipped. Only these can be edited or removed. */
  custom?: boolean
}

/** What is on this machine right now. */
export interface ToolProbe {
  id: ToolId
  /** Resolved on PATH? */
  found: boolean
  /** Absolute path, when found. */
  path?: string
  /** Parsed installed version, when one could be read. */
  version?: string
  /** Why there is no version, when there is not. */
  error?: string
}

/** What the outside world says the latest version is. */
export interface ToolLatest {
  id: ToolId
  source: ToolLatestSource
  latest?: string
  /** winget only: the package id that actually answered. */
  via?: string
  /** Set when the check could not be made — offline, 404, no winget. */
  error?: string
  /** Epoch ms of the answer, so the UI can say how stale it is. */
  checkedAt: number
}

/* ------------------------------------------------------ forge self-update */

/**
 * The self-updater's whole visible state. `unsupported` is the honest answer in
 * a dev run and in any build with no publish feed behind it — it is not an
 * error, and the banner must never appear for it.
 */
export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** The version being offered, when there is one. */
  version?: string
  /** 0–100 while downloading. */
  percent?: number
  bytesPerSecond?: number
  error?: string
  /** True when this status came from FORGE_FAKE_UPDATE rather than a real feed. */
  simulated?: boolean
}

/** The two bundles a dev run rebuilds but cannot hot-reload into itself. */
export type StaleBundle = 'main' | 'preload'

/**
 * "The bundle on disk is newer than the one this process is running."
 *
 * The dev-run counterpart to UpdateStatus, and mutually exclusive with it: a
 * packaged build is always `{ stale: false }` because its bundles cannot change
 * underneath it, and a checkout is always `unsupported` for updates. See
 * electron/stale-watcher.ts.
 */
export interface StaleStatus {
  stale: boolean
  /** Which bundles changed since boot. Empty when the app is current. */
  changed: StaleBundle[]
  /** mtime of the newest rebuild, or null when nothing has changed. */
  at: number | null
}

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

export interface MakeVideoRequest {
  description: string
  /** `16:9` or `9:16` — Veo takes no other shape. */
  aspect?: string
  /** Seconds, 4–8. */
  duration?: number
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

/* ------------------------------------------------------------ neural speech */

/**
 * Which engine says the agent's replies out loud.
 *
 *   edge    Microsoft's neural voices, over the same endpoint Edge's own Read
 *           Aloud uses — a real voice, no key, and no meaningful quota. The
 *           default, because it is the only neural engine that cannot run out
 *           mid-conversation.
 *   gemini  Google's TTS models — a real voice, needs a key and the network,
 *           and a free key runs out after ~6 sentences a minute. Kept for the
 *           thirty prebuilt voices.
 *   local   Chromium's `speechSynthesis`, i.e. Windows SAPI — no key, no
 *           network, and the thing Steve called robotic
 *
 * `local` is not merely a choice: it is what speaks when every neural engine is
 * missing, refused or unreachable. Falling back is automatic and announced
 * once — dead air would be worse than a robot. What the fallback chain must
 * never do is swap voices casually: the quota-driven Gemini→SAPI swap mid-reply
 * is the exact bug that made the edge engine the default.
 */
export type VoiceEngine = 'edge' | 'gemini' | 'local'

export interface VoiceSpeakRequest {
  text: string
  /**
   * Which neural engine to ask. Empty means Gemini, because every caller
   * predates the edge engine and that is what they meant.
   */
  engine?: 'edge' | 'gemini'
  /**
   * A voice name the chosen engine knows — `Sulafat` for Gemini,
   * `en-GB-SoniaNeural` for edge. Empty means that engine's default.
   */
  voice?: string
  /** Gemini only. Empty means the model in settings, which defaults to 3.1 flash. */
  model?: string
  /**
   * Barge-in handle. Pass the same id to `voice:speak-cancel` to abort this
   * request mid-flight. Anything falsy simply cannot be cancelled.
   */
  requestId?: string
}

export type VoiceSpeakResult =
  | {
      ok: true
      /**
       * Base64 audio. For `format: 'pcm16'` it is raw PCM — signed 16-bit
       * little-endian, `channels` interleaved, no WAV header. For
       * `format: 'mp3'` it is an MP3 file the renderer decodes with
       * `decodeAudioData`. Base64 rather than a typed array because it is what
       * the API already returned and what survives contextBridge unambiguously.
       */
      audio: string
      /**
       * How `audio` is encoded. Absent means `pcm16` — the only format that
       * existed before the edge engine.
       */
      format?: 'pcm16' | 'mp3'
      /** The mime the provider sent, verbatim. Spellings differ between models. */
      mime: string
      /** For pcm16. An mp3 carries its own rate; the decoder finds it. */
      sampleRate: number
      channels: number
      /** The model that actually spoke, which is not always the one asked for. */
      model: string
      voice: string
      ms: number
      /** Said when a fallback model answered instead of the requested one. */
      note?: string
    }
  | { ok: false; error: string; kind: string }

/* ------------------------------------------------- the Claude voice brain */

/**
 * The persistent Claude Agent SDK session that lives in the main process.
 *
 * Everything below is the wire between it and the renderer. Two things about
 * the shape are deliberate:
 *
 *  - **Events go one way, tools go the other.** The brain streams its reply out
 *    on `voice-agent:event`; when it wants to *know* something about Forge it
 *    asks, on `voice-agent:tool-request`, and the renderer answers. Only the
 *    renderer knows what is on screen, so the main process never guesses.
 *
 *  - **No manifest.** The old brains posted ~3,000 tokens of app state as the
 *    system prompt on every turn. This one has a static persona and a
 *    `get_app_state` tool, which is why the prompt caches and why the session
 *    can stay open across turns for free.
 */

/**
 * One thing the brain has to say, in the order it happened.
 *
 * `delta` arrives many times a second while the model writes; the renderer
 * chunks it into sentences for speech. Everything else is once-per-event.
 */
export type VoiceAgentEvent =
  /** A fragment of the reply as it is generated. Order is guaranteed. */
  | { type: 'delta'; text: string }
  /** A whole assistant turn has landed. The authoritative text. */
  | { type: 'assistant'; text: string }
  /**
   * A tool call started or finished — the "thinking" affordance and the hub's
   * activity strip. `end` carries the name back (matched by tool_use id in the
   * host) and whether the call succeeded; `ok` is meaningless on `start`.
   */
  | { type: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  /** The turn is over. `text` is the SDK's own summary of the result. */
  | {
      type: 'result'
      ok: boolean
      text: string
      turns: number
      costUsd: number
      durationMs: number
    }
  /** Something went wrong. The session survives; the turn did not. */
  | { type: 'error'; message: string }

/** Starting the session. Everything here is optional. */
export interface VoiceAgentStartRequest {
  /**
   * The active project's folder, so `Read` and the bridge's tools resolve
   * relative paths where Steve is actually working. Falls back to home.
   */
  cwd?: string
}

/** What `voice-agent:start` / `stop` answer with. */
export interface VoiceAgentStatus {
  running: boolean
  /** The model the live session was started with — not the current setting. */
  model: string
  /** Set when the session gave up (crash loop, spawn failure, no login). */
  error: string | null
}

/**
 * The brain asking the renderer a question, on `voice-agent:tool-request`.
 * `id` is answered exactly once, with a `VoiceAgentToolResult`.
 */
export interface VoiceAgentToolRequest {
  id: string
  /** Bare tool name — `get_app_state`, not `mcp__forge__get_app_state`. */
  name: string
  args: unknown
}

/** The renderer's answer. An error is a *result*, never a rejection. */
export interface VoiceAgentToolResult {
  id: string
  ok: boolean
  /** Text the model sees. Stringified by the host if it is not already text. */
  result?: unknown
  error?: string
}

/* --------------------------------------------------------- agent memory */

/**
 * Which part of a project's memory an entry belongs to.
 *
 * These map one-for-one onto the `##` headings in
 * `%APPDATA%\Forge\memory\<projectId>.md`, which is a plain markdown file on
 * purpose: it is folded straight into the brain's system text, and Steve can
 * open it in Notepad and see exactly what Forge thinks it knows about him.
 *
 *   about        one rolling paragraph — what this project *is*
 *   decisions    choices that were made and should not be re-litigated
 *   preferences  standing instructions ("always use TypeScript strict mode")
 *   activity     a capped, timestamped list of what actually happened
 */
export type MemorySection = 'about' | 'decisions' | 'preferences' | 'activity'

export interface Settings {
  /** Editable in %APPDATA%\Forge\settings.json — built-ins are seeded here. */
  agentProfiles: AgentProfile[]
  lastProjectId: string | null
  railCollapsed: boolean
  terminalFontSize: number
  terminalFontFamily: string
  /** Life-size type on the mosaic wall, or scale models. See MosaicTextMode. */
  mosaicText: MosaicTextMode
  /**
   * Master switch for per-tab terminal text colours. Off prints every terminal
   * in the theme's default foreground; each tab keeps the colour it was given,
   * and gets it back the moment this goes on again.
   */
  tabTextColours: boolean
  /**
   * Ring the project's dot in the rail while any of its panes is working, so
   * "is the agent still going?" is answerable from a project you are not
   * looking at. Off leaves the rail perfectly still.
   */
  railBusyRing: boolean
  /** Shell executable. Defaults to pwsh.exe (PowerShell 7). */
  shell: string
  /** Watch the clipboard for screenshots and copied images. */
  catchShots: boolean
  /** How many shots the shelf keeps before pruning the oldest. */
  shotsKeep: number
  window: WindowBounds
  /**
   * Set once the first-run welcome has been dismissed. Absent (or false) in a
   * fresh data directory is exactly what "first run" means — see
   * src/components/Onboarding.tsx.
   */
  onboarded: boolean

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
  /**
   * The voice hub: docked in the status bar, floating as a pill, or expanded
   * into the hub card — and where it was left, and how big he made it.
   * Persisted, because a hub you have parked over the second monitor's terminal
   * is furniture, not a transient mode. See src/lib/voicehub.ts.
   *
   * This replaced `voicePanelOpen` / `voicePanelWidth` outright when the
   * right-hand panel was deleted. Both are dropped by the store's normaliser,
   * so an existing settings.json simply loses them on its next write.
   */
  voiceHub: VoiceHubPlacement
  /**
   * Does undocking the hub open a real Windows window, or a div inside Forge?
   *
   * On by default, because it is what was actually asked for: an undocked hub
   * that floats above Chrome and stays on screen while Forge is minimised. A
   * `<div>` cannot do either — it is inside the window Chrome is covering.
   * See electron/overlay-window.ts.
   *
   * The switch exists because a transparent always-on-top window depends on the
   * compositor behaving, and on a machine where it does not, the fix should be
   * a toggle rather than a downgrade. Off falls back to the in-window hub,
   * which is kept working for exactly that reason.
   */
  voiceOverlayWindow: boolean
  /**
   * Listen while speaking, so you can cut in mid-sentence.
   *
   * On by default. With it off the agent is half duplex — the microphone is
   * shut for the whole reply and the only way to interrupt is to click the
   * button, which is how Forge worked before and is still the right answer on a
   * machine with no working echo cancellation (a cheap USB speakerphone, an
   * HDMI monitor's speakers with the mic across the desk from them).
   *
   * When it is on, the reply ducks the instant it hears you and cancels once it
   * is sure. See src/lib/bargein.ts for why an open microphone here cannot
   * bring back the feedback loop the old rule existed to prevent.
   */
  voiceBargeIn: boolean
  voiceBrain: VoiceBrainId
  /**
   * Anthropic key for the (unbuilt) ClaudeBrain. Stored here and used nowhere:
   * no code in Forge sends it anywhere.
   */
  anthropicKey: string
  /**
   * Which model the Claude voice brain runs.
   *
   * Note what this is *not*: an API-key setting. The brain is a Claude Agent
   * SDK session, and it authenticates with the `claude` login already on this
   * machine — the same subscription every Forge pane uses. `anthropicKey`
   * above is untouched by it.
   *
   * An alias (`sonnet`, `opus`, `haiku`) rather than a pinned id, because the
   * CLI resolves aliases to whatever is current and a pinned id here would
   * quietly go stale. Changing it restarts the session on the next turn.
   */
  voiceClaudeModel: string
  /**
   * Keep the mic open at ~1% CPU and wake the agent on "hey Jarvis", instead of
   * only ever starting from the dictation hotkey.
   *
   * Off by default — opt-in until the wake-word model has proven itself the
   * way barge-in and earcons already have. Dictation and its hotkey are
   * unaffected either way; this only adds a second way in. See the STT
   * sidecar's openwakeword integration for the listener itself.
   */
  voiceWakeWord: boolean
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
  /**
   * A cache of the current theme's background and ink, written by the renderer
   * whenever the theme changes.
   *
   * It exists because two things are painted before any renderer code runs: the
   * window's own background colour, and the native window controls Windows draws
   * into our titlebar. Without this, launching in Paper means a near-black
   * window flashing white — so main needs to know the answer at construction
   * time, and the only place the answer exists is the renderer's theme table.
   */
  themeBg: string
  themeInk: string


  /* -------------------------------------------------- voice relay (M6) */
  /**
   * Hand a finished agent turn straight back to the voice agent instead of
   * waiting to be asked. Stored here; the behaviour itself lives elsewhere.
   */
  voiceAutoRelay: boolean
  /** How long a pane must be quiet before a relay counts as "finished". */
  voiceRelayGraceMs: number
  /**
   * Whether the agent answers in writing, out loud, or both.
   *
   * `voice` is not merely "also speak": it is a different panel. The log and
   * the text box are hidden, leaving the round button and one line of status,
   * because if you are talking to it you are not reading it — and Steve wants
   * that space back for terminals.
   */
  voiceReplyMode: VoiceReplyMode
  /**
   * `SpeechSynthesisVoice.name` for the LOCAL engine. Empty means "pick the
   * best installed voice", which is what `chooseVoice` in src/lib/speech.ts
   * does. Irrelevant while the Gemini engine is speaking.
   */
  voiceReplyVoice: string
  /**
   * Which engine says it. `edge` out of the box: it needs no key, and it is the
   * only neural engine with no per-minute quota — which is what stops the voice
   * swapping to SAPI mid-reply. If the network is down it degrades to `local`
   * by itself, so this can safely default to the good one.
   */
  voiceEngine: VoiceEngine
  /**
   * An Edge neural voice name. Empty means `DEFAULT_EDGE_VOICE` in
   * shared/tts.ts — en-GB-SoniaNeural, a warm British female voice.
   */
  voiceEdgeVoice: string
  /**
   * A prebuilt Gemini voice name. Empty means `DEFAULT_TTS_VOICE` in
   * electron/gemini-tts.ts — Sulafat, the one Google documents as "Warm".
   */
  voiceTtsVoice: string
  /**
   * Gemini TTS model id. Empty means the built-in default
   * (`gemini-3.1-flash-tts-preview`); the module falls across to the 2.5 flash
   * model by itself when that one is out of quota.
   */
  voiceTtsModel: string
  /**
   * A soft two-note blip when the agent goes back to listening.
   *
   * It replaces something worse. The agent used to *announce* that it was
   * listening again — a spoken sentence, identical every time, which is exactly
   * the "robotic" Steve complained about. 120 ms of quiet sine says the same
   * thing and never says it twice the same way you can get sick of.
   */
  voiceEarcons: boolean
  /**
   * A two-note blip when a terminal's process finishes — the same pair rising
   * for a clean exit (code 0), falling for anything else. Played only while
   * Forge is not the focused window, because a chime is only useful when you
   * were not going to see it anyway.
   */
  terminalExitChime: boolean
  /**
   * Where `create_project` puts a new folder when he does not say. Empty means
   * the Desktop. Only this, the Desktop and Documents are ever writable from a
   * spoken command — see the handler in electron/main.ts.
   */
  projectsRoot: string
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
  /**
   * Groq key for GroqBrain. Sent only to api.groq.com, only when Groq is the
   * selected brain.
   *
   * Groq is here for one reason: it is the cheapest way to keep the voice agent
   * talking. Its free tier costs nothing and needs no card, and its paid tier is
   * pennies a month at Forge's volume — against Gemini's free tier, which caps
   * at twenty requests a minute and takes the whole turn down with it when it
   * runs out. It is also the fastest thing available, which for a voice agent is
   * not a luxury: latency here is a pause in a conversation.
   */
  groqKey: string
  groqModel: string

  /* -------------------------------------------------------- agent memory */
  /**
   * Let the active brain rewrite the "About this project" summary every tenth
   * exchange. Off by default: the heuristic memory below costs nothing and is
   * predictable, whereas this is a real (if small) API call you did not ask for.
   */
  memoryLlmSummarize: boolean

  /* --------------------------------------------------- skills library (M8) */
  /**
   * Where the skills library lives. Defaults to %APPDATA%\Forge\skills; movable
   * by hand for anyone who would rather keep their skills in a repo.
   */
  skillsLibraryDir: string
  /**
   * Folder names of the skills currently synced into ~/.claude/skills, and so
   * visible to every claude and kimi session on this machine. The list is the
   * intent; electron/skills-store.ts reconciles the filesystem with it at
   * startup and after every toggle.
   */
  skillsEnabled: string[]

  /* ------------------------------------------------ remote control (M7) */
  /**
   * Master switch for Claude Code's Remote Control. On by default: Steve wants
   * to be able to pick a pane up on his phone. Turning it off suppresses the
   * flag for every pane regardless of the per-profile setting, which is the
   * switch you want when you are on a plan or a network where it cannot work.
   */
  remoteControlDefault: boolean

  /* ------------------------------------------------ closing and resuming */
  /**
   * Give every Claude pane a session id of Forge's own, so reopening a saved
   * layout resumes each conversation instead of starting a new one. On by
   * default — it is the difference between a restored workspace and a restored
   * *session*. See shared/session.ts.
   *
   * Turning it off is the escape hatch: panes launch exactly as they used to,
   * with no `--session-id` and no `--resume`.
   */
  resumeSessions: boolean
  /**
   * Ask before closing Forge while panes are still running. On by default, and
   * the backstop for everything `resumeSessions` cannot bring back — a build
   * halfway through, a shell with unsaved work, an agent that is not Claude.
   */
  confirmOnQuit: boolean

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

  /* --------------------------------------------------- forge mobile (M11)
   *
   * The phone's *terminal* link — a real socket carrying real PTY bytes, as
   * opposed to the Companion above, which carries discrete messages and images
   * over Firebase. The two are complements, not rivals: the Companion channel
   * is what tells the phone where to find this socket. See docs/MOBILE.md.
   *
   * Same posture as the Companion: inert until `mobileEnabled` is true. Nothing
   * here binds a port, mints a token or accepts a connection on its own.
   */

  /** Master switch. False = the server never listens and no token is minted. */
  mobileEnabled: boolean
  /** Listen port. */
  mobilePort: number
  /**
   * Interface to bind. `0.0.0.0` — the default — means "every interface", which
   * sounds alarming and is not: `isAllowedSource` in electron/mobile/server.ts
   * refuses every connection that is not loopback, LAN or tailnet, so binding
   * broadly is what makes the phone work on home wifi without also making a
   * forwarded router port into a public shell. Set to `127.0.0.1` to accept
   * only a local tunnel (cloudflared) and nothing else.
   */
  mobileBindHost: string
  /**
   * Paired phones. Each entry holds a SHA-256 of the device's token and never
   * the token itself — see electron/mobile/auth.ts, and the check in
   * scripts/mobile-auth-check.mjs that reads this file back to prove it.
   */
  mobileDevices: MobileDeviceRecord[]
  /**
   * When "Accept new phones" disarms itself — a ms-epoch timestamp, 0 when it
   * is not armed. A timestamp rather than a boolean on purpose: a boolean that
   * someone forgot to switch off would leave the desktop raising pairing
   * prompts for anyone on the internet who found the tunnel, forever. Written
   * as now + ACCEPT_WINDOW_MS when Steve arms it, zeroed when the window
   * lapses, and clamped by the store so a hand-edited file cannot arm it for a
   * week. See electron/mobile-host.ts.
   */
  mobileAcceptUntil: number
  /**
   * The permanent way in from outside the house. `'ngrok'` runs a supervised
   * ngrok agent against the account's permanent dev domain whenever the link
   * is up, so the phone keeps one address forever — see
   * electron/mobile-tunnel.ts. Off by default, like everything else here.
   */
  mobileTunnel: MobileTunnelMode
  /**
   * The ngrok authtoken, from the dashboard. Stored like the other keys in
   * this file (geminiKey, companionRefreshToken): plain, local, and revocable
   * at the far end. It is handed to ngrok as an argument — never written into
   * an ngrok config file — and redacted from every log line and status detail
   * this app emits.
   */
  mobileNgrokAuthtoken: string
  /**
   * The account's auto-assigned permanent domain (`<name>.ngrok-free.app`,
   * some accounts see `.ngrok-free.dev`), copied off the ngrok dashboard —
   * not invented. Normalised and shape-checked by the store, because it ends
   * up on a command line.
   */
  mobileNgrokDomain: string

  /* ------------------------------------------------ updates & tools (M10) */
  /**
   * What the Update button does with the command it puts in a pane.
   *
   * False — the default — types it and stops, leaving the cursor at the end of
   * an unsubmitted line. You read `winget upgrade Microsoft.PowerShell`, you
   * press Enter. True presses Enter for you.
   *
   * The default is the safe one because the alternative is a settings page
   * that can start installing software with one click on a button whose label
   * does not say "and run it now".
   */
  updatesAutoRun: boolean
  /**
   * The Forge version whose update banner has been dismissed. Per-version on
   * purpose: saying "not now" to 0.2.0 must not silence 0.3.0 as well.
   */
  updateDismissedVersion: string
  /**
   * Tools added by hand, alongside the built-in catalogue.
   *
   * The whole point: the list of things worth keeping up to date is not one
   * Forge gets to close. A CLI released next month, a shim of Steve's own, the
   * thing he installed yesterday — each is a row here, checked and updated by
   * exactly the same code path as PowerShell. Validated by `sanitiseCustomTool`
   * on the way in, because this is a file a person edits.
   */
  customTools: ToolSpec[]
}

/* ------------------------------------------------------ forge mobile (M11) */

/**
 * A paired phone, as persisted in settings.json.
 *
 * `tokenHash` is a SHA-256 hex digest. The raw token exists in exactly two
 * places: the phone's Keystore-backed storage, and the single `hello-ok` frame
 * that delivered it. Never here, and never in a log line.
 */
export interface MobileDeviceRecord {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
}

/**
 * A pairing offer, on its way to the QR in Settings.
 *
 * `token` is the only time a raw credential crosses an IPC boundary. It is
 * never persisted: what reaches settings.json is a SHA-256 of the *device*
 * token this one is exchanged for, and only once a phone has actually used it.
 */
export type MobilePairOffer =
  | {
      ok: true
      token: string
      expiresAt: number
      ttlMs: number
      host: string
      /**
       * 0 when `url` is a tunnel — meaning "the scheme's default port", never
       * "append 8420". See pairEndpoint in electron/mobile-tunnel.ts and
       * toOrigin in mobile/src/lib/secure.ts, which treat a port-less secure
       * URL as exactly that.
       */
      port: number
      /**
       * `wss://<domain>` when the tunnel is live, '' otherwise. When present it
       * is THE address to pair against — it works from anywhere, forever,
       * which is what makes pairing one-and-done.
       */
      url: string
      /**
       * The whole handshake as one `forge://pair?…` string — what the QR in
       * Settings encodes. Built by `pairLink` in shared/mobile.ts, parsed by
       * `toOrigin`/`pairTokenOf` on the phone; carrying it pre-built means the
       * renderer never assembles a link the phone might read differently.
       * Note it embeds `token`, so it is as much a credential as the token is.
       */
      link: string
    }
  | { ok: false; error: string }

/** A layout operation from a phone, on its way to the renderer that owns tabs. */
export interface MobileCommandEvent {
  requestId: string
  deviceName: string
  op: {
    op: 'create-tab' | 'create-pane' | 'close-pane' | 'select-tab'
    projectId: string
    profileId?: string
    /** Still a wire value at this point: the renderer checks it, never casts it. */
    permissionMode?: string
    tabId?: string
    paneId?: string
  }
}

export type MobileState = 'off' | 'starting' | 'listening' | 'error'

/* ------------------------------------------------------- the ngrok tunnel */

/** Which transport carries the link past the front door. See mobile-tunnel.ts. */
export type MobileTunnelMode = 'off' | 'ngrok'

export type MobileTunnelState = 'off' | 'starting' | 'live' | 'retrying' | 'error'

/**
 * The tunnel's slice of MobileStatus. `error` is terminal on purpose: it means
 * a door that will not open (bad authtoken, someone else's domain, no session
 * allowance left), where retrying buys nothing — `detail` says which key to go
 * and fix. Transient trouble shows as `retrying` and never needs Steve.
 */
export interface MobileTunnelStatus {
  state: MobileTunnelState
  /** The public https URL ngrok reported, while live. */
  url: string
  /** A human sentence, or empty when there is nothing to say. Never a token. */
  detail: string
}

/** What the Settings panel shows about the link. */
export interface MobileStatus {
  enabled: boolean
  state: MobileState
  /** Where it is actually listening, once it is. */
  host: string
  port: number
  /**
   * The addresses a phone can reach this machine on right now — LAN and
   * tailnet, worked out from the live interface list. The Settings panel shows
   * these because "it's listening" is not an answer to "what do I type".
   */
  addresses: string[]
  devices: MobileDeviceRecord[]
  /** Phones with a socket open this second. */
  connected: number
  /**
   * When "Accept new phones" disarms itself (ms epoch), or 0 while it is not
   * armed. Rides this status rather than a stream of its own, so the Settings
   * toggle and its countdown stay honest through the one broadcast the panel
   * already watches.
   */
  acceptUntil: number
  /** A human sentence, or empty when there is nothing to say. */
  detail: string
  /** The ngrok tunnel, when one is configured. `state: 'off'` otherwise. */
  tunnel: MobileTunnelStatus
}

/**
 * "A phone is asking to pair — put the question on screen."  Main → renderer.
 *
 * `open: true` raises the prompt; `open: false` withdraws it (the phone gave
 * up, the approval timed out, or another window already answered), because a
 * prompt that outlives its question is a prompt whose Allow lands on nothing —
 * or worse, on the next question. The renderer answers over
 * `mobileApprovalResult`, and silence is a deny: nothing anywhere in this flow
 * approves by default.
 */
export interface MobileApprovalEvent {
  requestId: string
  /** What the phone calls itself. Untrusted text — display it, never obey it. */
  deviceName: string
  /** The word pair both screens show, e.g. "OTTER RIVER". Empty on withdraw. */
  words: string
  open: boolean
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
  /**
   * Naming context for the bootstrap transforms. Only Remote Control uses it
   * today, to label the session Steve's phone will show — see
   * `remoteControlName` in shared/remote.ts.
   */
  projectName?: string
  paneTitle?: string
  /**
   * The pane's saved Claude session id. The main process decides what to do
   * with it — claim it on a first launch, resume it on every one after — in
   * electron/bridge/claude-session.ts.
   */
  sessionId?: string
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
  /**
   * The wake word cannot be heard — openWakeWord is not installed, or its
   * models could not be fetched. Dictation itself is unaffected: the sidecar
   * downgrades the session to ordinary phrase capture and carries on.
   */
  | 'wake-unavailable'
  /** Restarted too many times too quickly — we stopped trying. */
  | 'crash-loop'
  | 'internal'

export interface SttError {
  kind: SttErrorKind
  msg: string
}

/**
 * What kind of listening session the sidecar is in.
 *
 *   phrase   push-to-talk: the mic opens, phrases come back, silence ends it
 *   wake     always-listening: the mic stays open and only what follows
 *            "hey Jarvis" (or an explicit capture) is transcribed
 */
export type SttMode = 'phrase' | 'wake'

/**
 * How to open the microphone. Everything here is optional, and an absent (or
 * empty) request is exactly the push-to-talk start dictation has always made —
 * that is what keeps the hotkey's behaviour bit-for-bit unchanged.
 */
export interface SttStartOptions {
  /** Defaults to `phrase`. `wake` is the always-listening session. */
  mode?: SttMode
  /**
   * A conversation, not dictation: the sidecar waits out thinking pauses (a
   * few seconds of silence) before deciding a phrase is over, instead of
   * cutting at the ~1 s dictation gap that splits a long sentence into
   * fragments. The agent sets it; the dictation hotkey leaves it absent.
   */
  conversation?: boolean
}

export interface SttStatus {
  phase: SttPhase
  /** Smoothed 0..1 mic level. Only meaningful while listening. */
  level: number
  error: SttError | null
  /** True once the model has reported ready in the current sidecar process. */
  ready: boolean
  /**
   * The current session's mode. Absent from statuses built before wake mode
   * existed, where it always meant `phrase`.
   */
  mode?: SttMode
  /**
   * How many times the wake word has fired in this sidecar process. It only
   * ever goes up: a wake is detected by noticing that this number *changed*,
   * never by its value, because the event itself is instantaneous and there is
   * nothing else to latch onto.
   */
  wakeCount?: number
  /**
   * True while audio is actually on its way to the speech engine. Always true
   * in `phrase` mode while listening; in `wake` mode it is the difference
   * between idle monitoring and taking down what was just said.
   */
  capturing?: boolean
}

export interface SttPhraseEvent {
  text: string
}

/* --------------------------------------------------- speech model (M8) */

/**
 * Forge ships the dictation engine but not the 660 MB Parakeet model, which is
 * fetched on demand into %APPDATA%\Forge\models. This is that fetch, as the UI
 * sees it — one object covering both "what is on disk" and "how far along".
 *
 *   unknown      nobody has looked yet
 *   missing      not downloaded
 *   partial      a previous attempt left bytes behind; it will resume
 *   downloading  in flight, `fraction` is live
 *   ready        installed and big enough to be real
 */
export type SttModelStatus = 'unknown' | 'missing' | 'partial' | 'downloading' | 'ready'

/**
 * *Whose* model this is, which is a different question from whether it works.
 *
 *   forge         downloaded into %APPDATA%\Forge\models — ours to manage
 *   dictationmic  DictationMic already paid the 660 MB and we borrow it
 *   external      a folder the user typed in themselves
 *   none          nothing configured and nothing found
 *
 * It exists because the advice differs: only `none`/`external`-with-nothing-in-it
 * should ever be offered a download, and borrowing DictationMic's copy is a
 * *good* outcome that deserves saying out loud rather than an install prompt.
 */
export type SttModelSource = 'forge' | 'dictationmic' | 'external' | 'none'

/** One model file as found on disk. `ok` means "big enough to be real". */
export interface SttModelFile {
  name: string
  bytes: number
  ok: boolean
}

export interface SttModelState {
  status: SttModelStatus
  /** Where the bytes are coming from. */
  source: SttModelSource
  /** Folder the model is (or will be) in. Empty when nothing is configured. */
  dir: string
  /** Forge's own model folder, populated or not — where a download lands. */
  forgeDir: string
  /**
   * Per-file presence from the last look at the disk, so the settings card can
   * say *which* file is missing instead of just "not installed". Empty while a
   * download is in flight, when the interesting number is the progress bar.
   */
  files: SttModelFile[]
  bytes: number
  totalBytes: number
  /** 0..1 across the whole model. */
  fraction: number
  /** File currently being fetched, while downloading. */
  file: string
  /** One sentence fit to show the user, including the failure reason. */
  message: string
  /** e.g. "~660 MB" — what to warn about before they commit. */
  sizeHint: string
  /** Set when a download ended badly, so the card can show it in red. */
  error?: string
}

/* ------------------------------------------------------- agent detection */

/** One of the CLI agents Forge can launch, as found (or not) on PATH. */
export interface AgentPresence {
  /** Matches the built-in profile id: `claude`, `kimi`, `gemini`. */
  id: string
  name: string
  /** The command Forge would type into a shell. */
  command: string
  found: boolean
  /** Absolute path of the resolved executable, when we found one. */
  path?: string
  /** Where to go and get it. */
  installUrl: string
}

/**
 * What Forge can say about *any* command line without becoming a shell.
 *
 * `AgentPresence` answers for the built-ins the welcome card lists. This answers
 * for whatever a profile actually launches, including one typed in by hand, and
 * is what lets the chooser and the Agents settings say "not installed" on the
 * row you are about to click rather than in a pane three seconds later.
 *
 * `unknown` is the honest third state and matters more than it looks. A command
 * like `conda activate x; claude` or `& "C:\tools\my agent.exe"` cannot be
 * resolved by looking at PATH — answering "not installed" for it would be a
 * confident lie about a profile that works perfectly.
 */
export interface CommandPresence {
  /** The command line exactly as it was asked about. */
  command: string
  /** The program it launches — empty when the line is not a plain command. */
  exe: string
  /** True only when we looked and found it. */
  found: boolean
  /** True when nothing was looked up, because the line is not resolvable. */
  unknown: boolean
  /** Absolute path of what we found. */
  path?: string
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

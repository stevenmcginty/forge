import type {
  AgentPresence,
  AppInfo,
  ClaudeCliState,
  CompanionSignInResult,
  CompanionStatus,
  CompanionUtteranceEvent,
  CreateSessionRequest,
  CreateSessionResult,
  EditImageRequest,
  GeminiCallRequest,
  GeminiCallResult,
  ImportedKeyResult,
  KeySource,
  MakeImageRequest,
  MediaCallResult,
  OpenRouterCallRequest,
  OpenRouterCallResult,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  Settings,
  Shot,
  StoreSnapshot,
  SttModelState,
  SttPhraseEvent,
  SttStatus,
  WindowStateEvent,
  Workspace
} from './types'

/**
 * The whole surface the renderer is allowed to touch. Declared here (free of
 * any Electron import) so both the preload implementation and the renderer's
 * `window.forge` declaration are checked against the same contract.
 */
export interface ForgeApi {
  info(): Promise<AppInfo>

  pty: {
    create(req: CreateSessionRequest): Promise<CreateSessionResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<boolean>
    list(): Promise<Array<{ id: string; pid: number }>>
    /** Returns an unsubscribe function. */
    onData(cb: (e: PtyDataEvent) => void): () => void
    onExit(cb: (e: PtyExitEvent) => void): () => void
  }

  store: {
    snapshot(): Promise<StoreSnapshot>
    setSettings(patch: Partial<Settings>): Promise<Settings>
    setProjects(projects: Project[]): Promise<Project[]>
    getWorkspace(projectId: string): Promise<Workspace | null>
    setWorkspace(projectId: string, workspace: Workspace): Promise<void>
    deleteWorkspace(projectId: string): Promise<void>
    revealDataDir(): Promise<string>
  }

  /**
   * The main process's clipboard, not `navigator.clipboard` — the renderer one
   * needs a permission handler, can reject silently, and has no image support.
   */
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }

  shots: {
    list(): Promise<Shot[]>
    /** Deletes the PNG. Resolves with the shelf as it now stands. */
    remove(path: string): Promise<Shot[]>
    clear(): Promise<Shot[]>
    /** Puts the shot on the clipboard as an image *and* as its quoted path. */
    copy(path: string): Promise<boolean>
    /** Copy image files onto the shelf (drag-and-drop in). */
    adopt(paths: string[]): Promise<number>
    /** Begin a real OS file drag of this shot. Call from `dragstart`. */
    startDrag(path: string): void
    openFolder(): Promise<string>
    /** Returns an unsubscribe function. */
    onUpdated(cb: (shots: Shot[]) => void): () => void
  }

  /**
   * On-device dictation. The Python sidecar is spawned lazily by the first
   * start() — nobody who never dictates pays for loading a 660 MB model.
   */
  stt: {
    start(): Promise<SttStatus>
    stop(): Promise<SttStatus>
    /**
     * Drop the running sidecar so freshly saved python/model paths take effect.
     * `force` also starts a new one immediately — that is the setup card's
     * "Retry"; without it a sidecar that was never running stays that way, and
     * the new paths are simply used by the next start().
     */
    reload(force?: boolean): Promise<SttStatus>
    status(): Promise<SttStatus>
    onStatus(cb: (s: SttStatus) => void): () => void
    onPhrase(cb: (e: SttPhraseEvent) => void): () => void

    /**
     * Fetch the ~660 MB Parakeet model into %APPDATA%\Forge\models. Forge ships
     * the engine but not the model, so this is what turns dictation on for
     * somebody who was just handed a copy.
     *
     * The download is owned by the main process and resumes across restarts, so
     * calling this twice returns the running one rather than starting a second.
     * Resolves when it finishes (or fails) — watch onDownloadProgress for the
     * bar, which is the only sane way to render 660 MB.
     */
    downloadModel(): Promise<SttModelState>
    /** Stop, keeping the partial files so a later attempt resumes. */
    cancelDownload(): Promise<SttModelState>
    /** Look at the disk right now: is the model there, partial, or absent? */
    modelState(): Promise<SttModelState>
    onDownloadProgress(cb: (s: SttModelState) => void): () => void
    onDownloadDone(cb: (s: SttModelState) => void): () => void
    onDownloadError(cb: (s: SttModelState) => void): () => void
  }

  /**
   * The voice agent's outside world. Model calls live in the main process
   * because the renderer's CSP (rightly) refuses to talk to any external host —
   * and because a key is better off never reaching page script's network layer.
   */
  voice: {
    gemini(req: GeminiCallRequest): Promise<GeminiCallResult>
    /** OpenRouter's OpenAI-compatible chat completions, for OpenRouterBrain. */
    openrouter(req: OpenRouterCallRequest): Promise<OpenRouterCallResult>
    /**
     * Read a key Steve already has on disk — DictationMic's `gemini.key`, or
     * `~/.kimi-key` for OpenRouter. Read-only; never writes.
     */
    importKey(which?: KeySource): Promise<ImportedKeyResult>
    /**
     * Really generate images. They are written into the current project's
     * `assets/generated/` and adopted into the screenshot shelf, so they appear
     * in the tray straight away. The Gemini key is read in the main process.
     */
    makeImage(req: MakeImageRequest): Promise<MediaCallResult>
    /** Edit an existing image into a new file. The original is untouched. */
    editImage(req: EditImageRequest): Promise<MediaCallResult>
  }

  /**
   * Forge Companion — the phone link (M9). Off until switched on and signed in;
   * every method here is safe to call in that state and simply does nothing.
   */
  companion: {
    status(): Promise<CompanionStatus>
    /**
     * Sign in, creating the account if it is new. The password is used for one
     * HTTPS POST in the main process and never stored — what reaches disk is a
     * revocable refresh token.
     */
    signIn(email: string, password: string): Promise<CompanionSignInResult>
    signOut(): Promise<CompanionStatus>
    /** Republish the project list now (after adding/renaming/removing one). */
    publish(): Promise<number>
    /**
     * Send text back to the phone. `itemId` is the one from the utterance
     * event, which threads the reply under the message that asked for it;
     * `projectId` is only needed for an unprompted note.
     */
    reply(itemId: string, text: string, projectId?: string): Promise<boolean>
    onStatus(cb: (s: CompanionStatus) => void): () => void
    /** THE voice-pipeline hookup. Returns an unsubscribe function. */
    onUtterance(cb: (e: CompanionUtteranceEvent) => void): () => void
  }

  /**
   * Read-only probes of the machine, for the Account section's state chips.
   * Nothing here writes, installs or signs anything in.
   */
  system: {
    /** The Windows account name — the default display name. */
    userName(): Promise<string>
    /** `claude --version`, or why it could not be run. */
    claudeVersion(): Promise<ClaudeCliState>
  }

  /**
   * Which of the built-in CLI agents are on this machine's PATH. Used by the
   * first-run welcome to say "install Claude Code" instead of letting a pane
   * open onto `'claude' is not recognized`.
   */
  probeAgents(): Promise<AgentPresence[]>

  pickFolder(): Promise<string | null>
  openPath(target: string): Promise<string>

  /**
   * Absolute path of a dropped `File`. Typed as `unknown` because this contract
   * is compiled for the main process too, where the DOM `File` type does not
   * exist; the renderer always hands it a real File.
   */
  pathForFile(file: unknown): string

  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onState(cb: (e: WindowStateEvent) => void): () => void
    /**
     * Repaint the *native* minimise/maximise/close buttons, which Windows draws
     * into our titlebar and which therefore cannot be styled with CSS. Called
     * whenever the theme changes; without it a light theme has three dark
     * buttons welded into its top-right corner.
     */
    setTitlebar(color: string, symbolColor: string): void
  }
}

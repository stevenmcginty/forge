import type {
  AppInfo,
  ClaudeCliState,
  CreateSessionRequest,
  CreateSessionResult,
  EngineProgress,
  EngineState,
  GeminiCallRequest,
  GeminiCallResult,
  ImportedKeyResult,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  Settings,
  Shot,
  StoreSnapshot,
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
  }

  /**
   * The voice agent's outside world. Model calls live in the main process
   * because the renderer's CSP (rightly) refuses to talk to any external host —
   * and because a key is better off never reaching page script's network layer.
   */
  voice: {
    gemini(req: GeminiCallRequest): Promise<GeminiCallResult>
    /** Read Steve's own Gemini key off disk (DictationMic). Never writes. */
    importKey(): Promise<ImportedKeyResult>
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
    /** Read an OpenRouter key from ~/.kimi-key if it is there. Never writes. */
    importOpenRouterKey(): Promise<ImportedKeyResult>
  }

  /**
   * The dictation model. Forge can download Parakeet itself (into
   * %APPDATA%\Forge\models) for anyone who has not already got DictationMic's
   * copy — resumable, cancellable, and the only download Forge ever does.
   */
  models: {
    engineState(): Promise<EngineState>
    /** Resolves when the download ends, one way or another. */
    engineInstall(): Promise<EngineProgress>
    engineCancel(): Promise<void>
    onEngineProgress(cb: (p: EngineProgress) => void): () => void
  }

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

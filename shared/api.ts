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
  MakeProjectFolderRequest,
  MakeProjectFolderResult,
  MakeVideoRequest,
  MediaCallResult,
  MemorySection,
  MobileApprovalEvent,
  MobileCommandEvent,
  MobilePairOffer,
  MobileStatus,
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
  ToolId,
  ToolLatest,
  ToolProbe,
  StaleStatus,
  UpdateStatus,
  VoiceSpeakRequest,
  VoiceSpeakResult,
  WindowStateEvent,
  Workspace
} from './types'
import type { SkillSource, SkillsList } from './skills'
import type { CommandsFeed } from './commands'

/** What every skills mutation hands back: the outcome, and the fresh list. */
export interface SkillMutation extends SkillsList {
  ok: boolean
  /** The skill the call was about, when it got far enough to know. */
  name?: string
  error?: string
  /** True when the folder picker was dismissed — not a failure worth showing. */
  cancelled?: boolean
}

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
    /**
     * Really generate a short .mp4 (Veo). Same destination as the images —
     * the project's `assets/generated/` — but it takes one to three minutes,
     * so every caller must have said so before awaiting this. Videos are NOT
     * adopted into the screenshot shelf: it only holds still images.
     */
    makeVideo(req: MakeVideoRequest): Promise<MediaCallResult>
    /**
     * Say something in a real voice.
     *
     * Returns base64 raw PCM for the renderer to play through Web Audio; the
     * key is read in the main process and the bytes are never written to disk.
     * Pass `requestId` and barge-in can abort it with `cancelSpeak`.
     */
    speak(req: VoiceSpeakRequest): Promise<VoiceSpeakResult>
    /** Abort an in-flight `speak`. Unknown ids are a no-op, never an error. */
    cancelSpeak(requestId: string): Promise<boolean>
  }

  /**
   * Per-project agent memory: one markdown file per project, kept in
   * `%APPDATA%\Forge\memory`. The renderer reads it into the brain's system
   * text and appends to it after each exchange; nothing else touches it.
   *
   * `append` and `replaceSummary` resolve with the file as it now stands, so a
   * caller keeping a warm copy for the next prompt never needs a second read.
   */
  memory: {
    read(projectId: string): Promise<string>
    append(projectId: string, section: MemorySection, entry: string, at?: number): Promise<string>
    replaceSummary(projectId: string, text: string): Promise<string>
    /** True when the file is gone (including when there was none). */
    clear(projectId: string): Promise<boolean>
  }

  /**
   * The skills library: `%APPDATA%\Forge\skills\<name>\SKILL.md`.
   *
   * Enabling a skill junctions it into `~/.claude/skills`, which is machine-wide
   * — every `claude` and `kimi` session started from anywhere picks it up, not
   * just the panes Forge opened. That is the whole point of the feature, and
   * also why nothing here will overwrite a folder Forge did not create.
   *
   * Every mutation resolves with the fresh list alongside its result, so the
   * rail never has to ask twice.
   */
  skills: {
    /**
     * Both groups in one round trip: the library, and the skills already sitting
     * in `~/.claude/skills` that Forge did not put there (`machineSkills` —
     * read-only, no toggle, live in every session already).
     */
    list(): Promise<SkillsList>
    /** The raw SKILL.md — used for the preamble dropped on a non-Claude agent. */
    read(name: string, source?: SkillSource): Promise<string>
    create(name: string, description: string): Promise<SkillMutation>
    /** Omit `sourceDir` to open the native folder picker. */
    importFolder(sourceDir?: string): Promise<SkillMutation>
    remove(name: string): Promise<SkillMutation>
    /** Sync into (or out of) ~/.claude/skills, and record the choice. */
    setEnabled(name: string, on: boolean): Promise<SkillMutation>
    /**
     * Copy one of Steve's own machine skills into the library, so Forge may
     * edit it. A copy — the original in ~/.claude/skills is never touched.
     */
    copyToLibrary(name: string): Promise<SkillMutation>
    /** Reveal a skill's folder, or the library itself. Resolves with the path. */
    openFolder(name?: string, source?: SkillSource): Promise<string>
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
   * Forge Mobile — the phone's *terminal* link (M11). The Companion above
   * carries messages and images over Firebase; this carries real PTY bytes over
   * a real socket. Off until switched on; every method is safe to call in that
   * state. See docs/MOBILE.md.
   */
  mobile: {
    status(): Promise<MobileStatus>
    /** Bind the port and start listening. Persists `mobileEnabled: true`. */
    start(): Promise<MobileStatus>
    /** Stop listening and close every socket. Persists `mobileEnabled: false`. */
    stop(): Promise<MobileStatus>
    /**
     * Mint a single-use pairing token for the QR. The raw token crosses this
     * boundary exactly once and is never persisted — only its hash is, and only
     * after a phone has actually used it.
     */
    pair(): Promise<MobilePairOffer>
    pairCancel(): Promise<boolean>
    /**
     * Arm or disarm "Accept new phones" — the tap-to-pair window. While armed,
     * a phone with no credential may *ask* to connect, which raises the
     * approval prompt on this desktop; nothing is minted until Allow is
     * tapped. Arms for ACCEPT_WINDOW_MS and then disarms itself — the
     * countdown is `acceptUntil` on MobileStatus.
     */
    setAccept(on: boolean): Promise<MobileStatus>
    /** Drop a device. Its live socket is closed immediately, not next time. */
    revoke(deviceId: string): Promise<MobileStatus>
    /**
     * Save the ngrok authtoken and/or domain. Omitted fields are left alone.
     * A running tunnel is restarted under the new identity, so a corrected
     * token takes effect now rather than on the next launch.
     */
    setTunnel(config: { authtoken?: string; domain?: string }): Promise<MobileStatus>
    /** Persist `mobileTunnel: 'ngrok'` and bring the tunnel up. */
    startTunnel(): Promise<MobileStatus>
    /** Persist `mobileTunnel: 'off'` and take it down, killing the agent. */
    stopTunnel(): Promise<MobileStatus>
    onStatus(cb: (s: MobileStatus) => void): () => void
    /**
     * A layout operation arrived from a phone. The renderer owns tabs and panes,
     * so it performs the op and answers with `commandResult` — the phone takes
     * the same code path a local click takes.
     */
    onCommand(cb: (e: MobileCommandEvent) => void): () => void
    /** Answer an `onCommand`. `error` empty means it worked. */
    commandResult(requestId: string, error?: string): void
    /**
     * A phone is asking to pair. `open: true` raises the prompt (device name
     * and the word pair its screen is showing); `open: false` withdraws it.
     * Answer with `approvalResult` — an unanswered prompt times out on the
     * main side as a deny, never an allow.
     */
    onApproval(cb: (e: MobileApprovalEvent) => void): () => void
    /** The human's verdict on an `onApproval`. */
    approvalResult(requestId: string, allow: boolean): void
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
   * The Updates & Tools section's two questions. Both are read-only: nothing
   * here installs, upgrades or downloads. Running an update command is the
   * renderer's job, and it does it by typing into a real terminal pane.
   */
  tools: {
    /** What is on PATH and what version it reports. Cached for the session. */
    probe(refresh?: boolean): Promise<ToolProbe[]>
    /**
     * What winget and the npm registry say is available. Slow and network-bound,
     * so it is separate from probe() and cached for half an hour unless
     * `refresh` says otherwise.
     */
    latest(ids?: ToolId[] | null, refresh?: boolean): Promise<ToolLatest[]>
  }

  /**
   * The slash-command reference and the Claude Code changelog, as published.
   *
   * One call answers both, because the flyout shows both and the version
   * numbers they are read against are the same two numbers. Cached in the main
   * process and on disk; `refresh` forces the network and still falls back to
   * the last good answer if it cannot get through.
   */
  commands: {
    feed(refresh?: boolean): Promise<CommandsFeed>
  }

  /**
   * Forge updating itself. Packaged builds only — in a dev run every one of
   * these is safe to call and the status stays `unsupported`, which is what
   * keeps the banner off screen while you are working on the app.
   */
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    /** Start the download. Only ever called from the banner, by a click. */
    download(): Promise<UpdateStatus>
    /** Quit and run the installer. False when there is nothing ready. */
    install(): Promise<boolean>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }

  /**
   * The dev-run half of the same question: is the *running* app still the code
   * on disk? Safe to call in a packaged build, where the answer is always no.
   */
  dev: {
    staleStatus(): Promise<StaleStatus>
    onStale(cb: (s: StaleStatus) => void): () => void
    /** Quit and come back on the new bundle. Every pane dies — ask first. */
    restart(): Promise<boolean>
  }

  /**
   * Which of the built-in CLI agents are on this machine's PATH. Used by the
   * first-run welcome to say "install Claude Code" instead of letting a pane
   * open onto `'claude' is not recognized`.
   */
  probeAgents(): Promise<AgentPresence[]>

  pickFolder(): Promise<string | null>
  /** Create a project folder from a spoken name. Fenced hard — see main.ts. */
  makeProjectFolder(req: MakeProjectFolderRequest): Promise<MakeProjectFolderResult>
  openPath(target: string): Promise<string>
  /**
   * Open an http(s) URL in the default browser. Anything else is refused in the
   * main process — the renderer must never be able to hand the OS an arbitrary
   * scheme to launch.
   */
  openExternal(url: string): Promise<boolean>

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

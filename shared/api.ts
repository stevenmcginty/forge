import type {
  AgentPresence,
  AppInfo,
  ClaudeCliState,
  CommandPresence,
  CompanionSignInResult,
  CompanionStatus,
  CompanionUtteranceEvent,
  CreateSessionRequest,
  CreateSessionResult,
  EditImageRequest,
  ForgeTvStatus,
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
  MobileMirrorEvent,
  MobilePairOffer,
  MobileStatus,
  MobileWatchEvent,
  WebCommandEvent,
  WebMirrorEvent,
  WebProjectAddEvent,
  WebSignInResult,
  WebStatus,
  WebWatchEvent,
  OpenRouterCallRequest,
  OpenRouterCallResult,
  GroqCallRequest,
  GroqCallResult,
  ActivityPane,
  ActivitySnapshot,
  SharePane,
  ShareSlotBody,
  ShareSnapshot,
  ShareWriteRequest,
  ShareWriteResult,
  GhState,
  GitActionRequest,
  GitActionResult,
  GitBranch,
  GitBranchCompare,
  GitSnapshot,
  PlannerUpdate,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  PtyGeometryEvent,
  Settings,
  Shot,
  StoreSnapshot,
  SttModelState,
  SttPhraseEvent,
  SttStartOptions,
  SttStatus,
  ToolId,
  ToolLatest,
  ToolProbe,
  SourceUpdateStatus,
  StaleStatus,
  UpdateStatus,
  VoiceAgentEvent,
  VoiceAgentStartRequest,
  VoiceAgentStatus,
  VoiceAgentToolRequest,
  VoiceAgentToolResult,
  VoiceSpeakRequest,
  VoiceSpeakResult,
  WindowStateEvent,
  Workspace
} from './types'
/*
 * The two wire shapes the screen mirror hands straight through this bridge.
 * Declared in shared/web.ts because the browser on the far end is compiled
 * against that file; named here rather than re-described, so the renderer, main
 * and the tab cannot end up with three ideas of what configures a decoder.
 */
import type { WebMirrorChunk, WebMirrorConfig } from './web'
import type { SkillSource, SkillsList } from './skills'
import type { PackPlugin, SkillPack } from './skillpack'
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

/* ------------------------------------------------------------ skill packs */

/**
 * What a pack export reports back.
 *
 * `skipped` is never empty for form's sake and never silent: a skill that could
 * not be packed, a file too big, a symlink not followed. A pack that quietly
 * contained less than was asked for would be discovered by the recipient, not
 * the sender.
 */
export interface SkillPackExportResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  /** Where it was written. */
  path?: string
  bytes?: number
  skills?: number
  plugins?: number
  skipped: string[]
}

export interface SkillPackOpenResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  /** The file this pack was read from — pass it back to `install`. */
  path?: string
  pack?: SkillPack
  /** Entries the validator refused, each with a reason. Shown, never hidden. */
  dropped: string[]
}

export interface SkillPackInstallResult extends SkillsList {
  ok: boolean
  error?: string
  /** Names now in the library, disabled. */
  installed: string[]
  /** Names refused, each with a reason. */
  skipped: string[]
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
    /**
     * A pane's grid moved, or changed hands — including when the device that
     * moved it was somewhere else entirely. See `IPC.ptyGeometry`.
     */
    onGeometry(cb: (e: PtyGeometryEvent) => void): () => void
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
    /**
     * Open the microphone. With no options this is the push-to-talk session
     * dictation has always used; `{ mode: 'wake' }` opens the always-listening
     * one instead, which loops by itself until stop().
     */
    start(options?: SttStartOptions): Promise<SttStatus>
    stop(): Promise<SttStatus>
    /**
     * Wake mode only: take down what is said now, without "hey Jarvis" in front
     * of it — the hands-free follow-up after a reply. A capture that hears
     * nothing goes back to monitoring on its own, so this is never a loop.
     * Ignored (with a log line) when the session is not in wake mode.
     */
    capture(): Promise<SttStatus>
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
    /** Groq's, which is the same API on a different host. See GroqBrain. */
    groq(req: GroqCallRequest): Promise<GroqCallResult>
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
   * The Claude voice brain: one persistent Agent SDK session in the main
   * process, authenticated by the machine's own `claude` login.
   *
   * Unlike `voice` above, this is not a call per turn. `start` opens a session
   * that lives for as long as Forge does, `utterance` pushes into it, and the
   * reply streams back on `onEvent` a fragment at a time.
   *
   * `onToolRequest` is the half that makes the manifest unnecessary: the brain
   * asks the renderer for app state, or asks it to run an action, and the
   * renderer answers with `toolResult`. Exactly one answer per request id — and
   * an answer that says `ok: false` is still an answer. See src/lib/agenttools.ts.
   */
  voiceAgent: {
    /** Open the session. Safe to call again; also clears a crash-loop stop. */
    start(req?: VoiceAgentStartRequest): Promise<VoiceAgentStatus>
    stop(): Promise<VoiceAgentStatus>
    /** Say something. Opens the session first if it is not already running. */
    utterance(text: string): Promise<VoiceAgentStatus>
    /** Barge-in: end the turn. The session survives and resumes on the next. */
    interrupt(): Promise<boolean>
    onEvent(cb: (event: VoiceAgentEvent) => void): () => void
    onToolRequest(cb: (request: VoiceAgentToolRequest) => void): () => void
    toolResult(result: VoiceAgentToolResult): Promise<boolean>
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
   * Enabling a skill junctions it into the native Claude and Codex skill
   * folders, so sessions started inside or outside Forge can discover it.
   * Nothing here overwrites a folder Forge did not create.
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
    /** Sync into (or out of) the Claude and Codex skill folders, and record the choice. */
    setEnabled(name: string, on: boolean): Promise<SkillMutation>
    /**
     * Copy one of Steve's own machine skills into the library, so Forge may
     * edit it. A copy — the original in ~/.claude/skills is never touched.
     */
    copyToLibrary(name: string): Promise<SkillMutation>
    /** Reveal a skill's folder, or the library itself. Resolves with the path. */
    openFolder(name?: string, source?: SkillSource): Promise<string>

    /**
     * Skill packs — the `.forgepack` file you hand somebody else.
     *
     * Library skills travel as content; installed plugins travel as the
     * `/plugin` commands that reproduce them, never as copied files. See
     * shared/skillpack.ts for why those are two different problems.
     */
    pack: {
      /**
       * The plugin recipes this machine could contribute. Ones from a local
       * directory come back with `source.kind: 'local'` and no usable
       * commands — listed so the sender can see them, not hidden.
       */
      plugins(): Promise<PackPlugin[]>
      /** Build and save. Opens the save dialog; resolves `cancelled` if dismissed. */
      exportPack(skills: string[], includePlugins: boolean, note?: string): Promise<SkillPackExportResult>
      /**
       * The same skills as a plain zip of folders, plus a README saying where
       * to put them and a PLUGINS.md carrying the recipes.
       *
       * The route for a recipient who does not run Forge — they unzip into
       * `~/.claude/skills` and every `claude` session on that machine has
       * them. No preview, no install step, and nothing to validate on the way
       * in, because nothing on the far end is reading it.
       */
      exportZip(skills: string[], includePlugins: boolean, note?: string): Promise<SkillPackExportResult>
      /**
       * Read and validate a pack for preview. **Writes nothing** — this is the
       * call that lets somebody see what is in a pack before installing it.
       * Omit `path` to open the file picker.
       */
      open(path?: string): Promise<SkillPackOpenResult>
      /**
       * Install chosen skills from a pack on disk. Takes the *path*, not a pack
       * object: the file is re-read and re-validated, so what installs is the
       * bytes on disk rather than something that made a round trip through the
       * renderer.
       *
       * Never enables anything. An imported skill is inert until it is switched
       * on by hand.
       */
      install(path: string, skills?: string[]): Promise<SkillPackInstallResult>
    }
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
     * Which panes a phone has open. Ids and no geometry: one PTY cannot be two
     * widths, and while this desktop has a window open the desk is the one that
     * picks — so all the renderer does with this list is label the panes on it.
     * See `setPhoneWatched` in src/lib/terminals.ts.
     */
    onWatched(cb: (e: MobileWatchEvent) => void): () => void
    /**
     * A phone is asking to pair. `open: true` raises the prompt (device name
     * and the word pair its screen is showing); `open: false` withdraws it.
     * Answer with `approvalResult` — an unanswered prompt times out on the
     * main side as a deny, never an allow.
     */
    onApproval(cb: (e: MobileApprovalEvent) => void): () => void
    /** The human's verdict on an `onApproval`. */
    approvalResult(requestId: string, allow: boolean): void

    /* --------------------------------------------------------- Forge TV */

    /** What Settings shows about the Fire TV APK: is there one, and where. */
    tvStatus(): Promise<ForgeTvStatus>
    /**
     * Build the Fire TV APK against this machine's current LAN address.
     *
     * Returns as soon as the build has *started* — Vite and Gradle together
     * take minutes, and an IPC call that blocked for them would freeze the
     * settings page. Watch `onTvStatus` for the steps and the ending. Calling
     * it while a build is running is a no-op that returns the running status.
     */
    tvBuild(): Promise<ForgeTvStatus>
    /**
     * Download the published Fire TV app instead of building one.
     *
     * The route for every machine that is not this project's development box:
     * it needs no Android SDK, no JDK and no signing key, because the file is
     * built and signed once and published. The APK it fetches has no desktop
     * address inside it — it finds whichever Forge answers on the network it is
     * switched on in — which is what makes it the one to hand to somebody else.
     *
     * Returns immediately, like `tvBuild`; the steps and the ending arrive on
     * `onTvStatus`.
     */
    tvFetch(): Promise<ForgeTvStatus>
    onTvStatus(cb: (s: ForgeTvStatus) => void): () => void

    /* ------------------------------------------------- the screen mirror
     *
     * The television watching this desktop's screen, over WebRTC. The peer
     * connection lives here in the renderer because the main process has no
     * WebRTC stack to make an offer with; everything below is the wire between
     * it and the socket. There is no control for this on the desktop — the
     * only thing that ever starts one is the television asking. The
     * implementation is src/lib/mirror.ts.
     */

    /**
     * The television asked to start, sent a signalling payload, or stopped.
     * Answer `start` by capturing and offering; answer nothing else.
     */
    onMirror(cb: (e: MobileMirrorEvent) => void): () => void
    /**
     * The primary screen's `desktopCapturer` source id, for `getUserMedia`.
     * '' when there is no screen to name.
     */
    mirrorSource(): Promise<string>
    /** An SDP or ICE candidate for the television. Relayed unread. */
    mirrorSignal(data: string): void
    /**
     * End the mirror, with a sentence the television shows instead of black —
     * the capture was refused, Steve stopped sharing, the peer died.
     */
    mirrorStop(reason?: string): void
  }

  /**
   * Forge Web — the same terminals in a browser tab, behind a public address.
   *
   * Deliberately smaller than `mobile` above, and the missing member is the
   * point: there is no `pair`, because the credential is a Firebase ID token
   * the browser already holds and this desktop verifies against Google's keys
   * on every connection, so there is nothing for the desk to mint.
   *
   * There *is* a sign-in, and it is Forge Web's own — see `signIn` below and
   * the note on `webUid` in shared/types.ts. The tunnel has no control of its
   * own: it is settings (`webTunnel`, `webNgrokDomain`, `webNgrokAuthtoken`)
   * plus the link's own switch, and its state rides `WebStatus.tunnel`.
   *
   * See docs/forge-web.md and electron/web-host.ts.
   */
  web: {
    status(): Promise<WebStatus>
    /** Bind the port and start listening. Persists `webEnabled: true`. */
    start(): Promise<WebStatus>
    /**
     * Turn on browser access for the signed-in Forge account: enable the
     * listener and start a tunnel (cloudflared if none was chosen). Refuses
     * with a sentence on `WebStatus.detail` when nobody is signed in.
     */
    enable(): Promise<WebStatus>
    /**
     * Stop listening and close every socket, telling the browsers why first.
     * Retracts the rendezvous record and stops the tunnel. Persists
     * `webEnabled: false`.
     */
    stop(): Promise<WebStatus>
    /**
     * Sign Forge Web in to Firebase, creating the account if it is new.
     *
     * Its own session, sharing only a provider with `companion.signIn` — the
     * uid this returns is the one uid this desktop will admit and the one it
     * publishes its address under. The password is used for a single HTTPS POST
     * and then dropped; a refresh token is what reaches settings.json.
     *
     * Does **not** switch the link on. Signing in says who may reach this
     * desktop; `start()` is the separate, deliberate act that lets them.
     */
    signIn(email: string, password: string): Promise<WebSignInResult>
    /**
     * Sign out: the published address is retracted first, then the credential
     * and the uid are dropped. The email is kept so the form pre-fills. A
     * signed-out Forge Web admits nobody and publishes nothing, and says so in
     * `WebStatus.session.detail`.
     */
    signOut(): Promise<WebStatus>
    /**
     * Set the unlock PIN every browser has to present — 4 to 12 digits. The
     * digits are hashed in main and only the hash is stored; there is no call
     * that reads one back, because a panel that could render the PIN is a panel
     * a screen-share renders it on.
     *
     * Answers with the new status, or with a sentence when what was typed is
     * not a PIN.
     */
    setPin(pin: string): Promise<WebStatus | { error: string }>
    /**
     * Remove the PIN. Browsers are then admitted on the account alone, and
     * screen *control* is refused outright — see `webControlEnabled`.
     */
    clearPin(): Promise<WebStatus>
    onStatus(cb: (s: WebStatus) => void): () => void
    /**
     * A layout operation arrived from a browser. The renderer owns tabs and
     * panes, so it performs the op and answers with `commandResult` — the
     * browser takes the same code path a local click takes.
     */
    onCommand(cb: (e: WebCommandEvent) => void): () => void
    /**
     * A browser picked a folder on this machine and wants it in the rail. The
     * main side has already checked the folder is really there; the renderer
     * adds it with `addProjectPath`, which is the same function the desktop's
     * own Add project button reaches.
     */
    onProjectAdd(cb: (e: WebProjectAddEvent) => void): () => void
    /** Answer an `onCommand` or an `onProjectAdd`. `error` empty means it worked. */
    commandResult(requestId: string, error?: string): void
    /**
     * Which panes a browser has open, under exactly the rule `mobile.onWatched`
     * above states: ids, no geometry, a label and nothing more.
     *
     * A separate list from the phone's on purpose. Both can be reading the same
     * pane, and the pane header says which — see `setBrowserWatched` in
     * src/lib/terminals.ts.
     */
    onWatched(cb: (e: WebWatchEvent) => void): () => void

    /* --------------------------------------------------- the screen mirror
     *
     * A browser watching this desktop's screen. The capture and the encoder
     * live here in the renderer because the main process has no display to
     * open a stream onto; everything below is the wire between them and the
     * socket. There is no *start* here — the only thing that ever begins one is
     * a browser asking, and whether it may is decided in main. The
     * implementation is src/lib/mirror.ts.
     *
     * Unlike `mobile.onMirror` there is no signalling pair, because there is no
     * peer connection: the encoded chunks travel down the same WebSocket the
     * terminals do. See the screen-mirror block in shared/web.ts.
     */

    /** A browser asked to watch, or stopped. Answer `start` by capturing. */
    onMirror(cb: (e: WebMirrorEvent) => void): () => void
    /**
     * The capture is up: what the browser's decoder must be configured with.
     * Send this once, before the first chunk — a decoder handed a chunk it has
     * no configuration for cannot do anything with it.
     */
    mirrorReady(config: WebMirrorConfig): void
    /** One encoded chunk, base64. Held to MAX_MIRROR_CHUNK_BYTES by the server. */
    mirrorChunk(chunk: WebMirrorChunk): void
    /**
     * End the mirror, with a sentence the browser shows instead of a frozen
     * last frame — the capture was refused, Steve stopped sharing, the encoder
     * died.
     */
    mirrorStop(reason?: string): void
    /**
     * Take the screen back from the desk. The Settings card's Stop button, and
     * the reason `WebStatus.mirroring` exists: a capture in progress is
     * otherwise invisible from this machine.
     */
    stopMirror(): Promise<WebStatus>
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
    /**
     * Where Claude Code filed this session's transcript, and whether it is
     * really there yet. The handover door: drag a tab onto another agent's
     * pane and the target gets pointed at this file.
     */
    claudeTranscript(cwd: string, sessionId: string): Promise<{ path: string; exists: boolean }>
  }

  /**
   * The tasks panel's planning session, watched rather than driven.
   *
   * The panel runs a real, visible `claude` pane; the plan is whatever that
   * session writes into a ```tasks fence. Nothing here starts, prompts or stops
   * a terminal — it tails the transcript Claude Code is already keeping for that
   * session id and pushes each plan it finds. See electron/planner-watcher.ts.
   */
  planner: {
    watch(req: { projectId: string; cwd: string; sessionId: string }): Promise<{ ok: boolean; error?: string }>
    unwatch(projectId: string): void
    onUpdate(cb: (e: PlannerUpdate) => void): () => void
  }

  /**
   * Where the selected project stands, in git's terms.
   *
   * Only one project is ever watched — whichever is active — and only while the
   * GIT section is switched on. `watch` replaces any previous watch outright,
   * which is what makes switching project cheap: one call, and the old handles
   * and timers are gone.
   *
   * Read-mostly by design. `action` is the only thing here that can change a
   * repository, it takes a project id rather than a path so the renderer cannot
   * name an arbitrary folder, and the five things it will do are enumerated in
   * electron/git/git-actions.ts. Everything harder than those five is handed to
   * an agent as a prompt instead.
   */
  git: {
    watch(req: { projectId: string; cwd: string }): Promise<{ ok: boolean; error?: string }>
    /** send — teardown has nothing to await, same reason as planner.unwatch. */
    unwatch(projectId: string): void
    /** Re-read now, ignoring every throttle. Null when nothing is being watched. */
    refresh(projectId: string): Promise<GitSnapshot | null>
    action(req: GitActionRequest): Promise<GitActionResult>
    /** refs/remotes/*, fetched only when the Remote group is expanded. */
    remoteBranches(projectId: string): Promise<GitBranch[]>
    /**
     * How far a branch sits from HEAD, read when a row is armed to be switched
     * to. Null when the project is unknown or the name is not a local branch.
     */
    branchCompare(projectId: string, branch: string): Promise<GitBranchCompare | null>
    /** Ask gh again now — the button that also re-checks whether it is logged in. */
    ghRefresh(projectId: string): Promise<GhState>
    onSnapshot(cb: (s: GitSnapshot) => void): () => void
  }

  /**
   * Which agent is touching which file.
   *
   * `watch` is re-called whenever the pane set changes — a split, a closed tab —
   * and the watcher diffs the list rather than starting over, so opening a
   * second pane does not wipe the tree that is already there.
   *
   * `setBusy` is the renderer telling main that a pane started or stopped
   * working. That is the whole of inferred attribution: main cannot see a
   * terminal's output, and the renderer cannot see the filesystem, so each tells
   * the other the half it knows.
   */
  activity: {
    watch(req: { projectId: string; cwd: string; panes: ActivityPane[] }): Promise<{ ok: boolean; error?: string }>
    unwatch(projectId: string): void
    /** send — one call per busy edge, on a hot subscription. */
    setBusy(projectId: string, paneId: string, busy: boolean): void
    /** Forget everything recorded for this project. */
    clear(projectId: string): void
    onUpdate(cb: (s: ActivitySnapshot) => void): () => void
  }

  /**
   * The shared scratchpad: five markdown slots in `<project>\.forge\share`.
   *
   * The only write-capable surface in the rail, and the only part of Forge that
   * writes inside the user's project folder. Every method that names a slot names
   * it with an integer — there is deliberately no way to ask this API about a
   * path, which is what bounds it to five files per project.
   *
   * `watch` also creates the folder, the README and the `.git/info/exclude` line
   * on first call, so nothing exists on disk until the section is switched on.
   */
  share: {
    watch(req: { projectId: string; cwd: string }): Promise<{ ok: boolean; error?: string }>
    /** send — teardown has nothing to await, same reason as git.unwatch. */
    unwatch(projectId: string): void
    /** Re-read now, ignoring the throttle. Null when nothing is being watched. */
    refresh(projectId: string): Promise<ShareSnapshot | null>
    /** One slot's full body. Null for an empty slot or one that cannot be read. */
    read(projectId: string, index: number): Promise<ShareSlotBody | null>
    write(req: ShareWriteRequest & { projectId: string }): Promise<ShareWriteResult>
    clear(projectId: string, index: number): Promise<ShareWriteResult>
    /**
     * Capture a pane's tail into a slot from main's own replay buffer. Only for a
     * pane this renderer has no terminal for — everything else captures xterm's
     * parsed grid, which is the same output without the redraw artefacts.
     */
    capture(req: {
      projectId: string
      index: number
      paneId: string
      lines: number
      title: string
      author: string
    }): Promise<ShareWriteResult>
    /** send — on a debounced effect; nothing to await. */
    roster(projectId: string, panes: SharePane[]): void
    /** send — `null` reveals the folder itself. */
    reveal(projectId: string, index: number | null): void
    onSnapshot(cb: (s: ShareSnapshot) => void): () => void
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

    /** Where the stable checkout stands against origin. */
    sourceStatus(): Promise<SourceUpdateStatus>
    onSourceUpdate(cb: (s: SourceUpdateStatus) => void): () => void
    /** Pull, install if needed, restart. Every pane dies — ask first. */
    applySourceUpdate(): Promise<boolean>
  }

  /**
   * Which of the built-in CLI agents are on this machine's PATH. Used by the
   * first-run welcome to say "install Claude Code" instead of letting a pane
   * open onto `'claude' is not recognized`.
   */
  probeAgents(): Promise<AgentPresence[]>

  /**
   * The same question about whatever a profile launches — including a custom
   * one. One entry per command line asked about, in the order asked. Cheap: it
   * stats files along PATH and spawns nothing.
   */
  probeCommands(commands: string[]): Promise<CommandPresence[]>

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
   * `git remote get-url origin` in a folder, or null when there is no answer —
   * no git, not a repo, no origin. How a project's Repository URL fills itself
   * in once an agent has actually created the repo. Read-only: nothing here can
   * set a remote, only ask about one.
   */
  gitRemoteOrigin(dir: string): Promise<string | null>

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
    /**
     * Un-minimise Forge and raise it. Called from the overlay, which can be on
     * screen while the main window is minimised behind Chrome.
     */
    restoreAndFocus(): void
  }

  /**
   * The undocked voice hub, as its own always-on-top Windows window.
   *
   * Every method here is a relay, and the shape is deliberately lopsided: the
   * *host* (the main window, which owns the one and only voice agent) pushes
   * state out, and the *overlay* sends callbacks back. Neither side ever runs
   * the other's half — an overlay that subscribed to the transcript bus would
   * be a second agent, and two agents means two voices answering one sentence.
   *
   * The payloads are `unknown` on purpose. Both windows run the same renderer
   * bundle, so they share the precise types from src/lib/overlaystate.ts; the
   * main process in the middle is a wire and has no business knowing them.
   */
  overlay: {
    /** True in the overlay window, false in the main one. Read from the URL. */
    isOverlay(): boolean

    /* ------------------------------------------------------ host → main */
    /** Show it, at these screen-space bounds. Idempotent — also moves/resizes. */
    open(bounds: OverlayBounds): Promise<void>
    /** Destroy it. The hub went home, or Forge is shutting down. */
    close(): Promise<void>
    /** Move/resize it without a round trip through open(). */
    setBounds(bounds: OverlayBounds): void
    /** Push the mirrored snapshot. Called on change, not on a timer. */
    pushState(snapshot: unknown): void
    /** Push the mic level alone, so the ring animates without a re-render. */
    pushLevel(level: number): void
    /** A callback the overlay asked for, arriving at the real engine. */
    onCall(cb: (message: unknown) => void): () => void
    /** The user dragged or resized the overlay; persist it into settings. */
    onBounds(cb: (bounds: OverlayBounds) => void): () => void

    /* --------------------------------------------------- overlay → main */
    onState(cb: (snapshot: unknown) => void): () => void
    onLevel(cb: (level: number) => void): () => void
    /** Ask the host to run something on the real engine. Fire and forget. */
    call(message: unknown): void
  }
}

/**
 * Where the overlay sits, in *screen* pixels.
 *
 * Screen, not viewport — that is the whole point of the thing. The in-window
 * hub clamped itself to Forge's client area (src/lib/voicehub.ts); this one is
 * clamped to the work area of whichever display it was dropped on, which is
 * what lets it sit over Chrome on the second monitor.
 */
export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
  /** Expanded cards can be resized by their edge; pills cannot. */
  resizable?: boolean
}

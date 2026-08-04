/** Every IPC channel name in one place, so main and preload cannot drift. */
export const IPC = {
  // pty
  ptyCreate: 'pty:create',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyList: 'pty:list',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  // store
  storeSnapshot: 'store:snapshot',
  storeSetSettings: 'store:set-settings',
  storeSetProjects: 'store:set-projects',
  storeGetWorkspace: 'store:get-workspace',
  storeSetWorkspace: 'store:set-workspace',
  storeDeleteWorkspace: 'store:delete-workspace',
  storeReveal: 'store:reveal',

  // clipboard (the main-process module — navigator.clipboard needs a
  // permission handler and fails silently in a packaged app)
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text',

  // shots
  shotsList: 'shots:list',
  shotsUpdated: 'shots:updated',
  shotsRemove: 'shots:remove',
  shotsClear: 'shots:clear',
  shotsCopy: 'shots:copy',
  shotsAdopt: 'shots:adopt',
  shotsDrag: 'shots:drag',
  shotsOpenFolder: 'shots:open-folder',

  // dictation (stt sidecar)
  sttStart: 'stt:start',
  sttStop: 'stt:stop',
  /** Wake mode only: start taking a phrase down now, without the wake word. */
  sttCapture: 'stt:capture',
  sttReload: 'stt:reload',
  sttStatus: 'stt:status',
  sttStatusEvent: 'stt:status-event',
  sttPhrase: 'stt:phrase',

  // speech model download (main process owns it, so it survives the popover
  // that started it being closed)
  sttDownloadModel: 'stt:download-model',
  sttDownloadCancel: 'stt:download-cancel',
  sttDownloadState: 'stt:download-state',
  sttDownloadProgress: 'stt:download-progress',
  sttDownloadDone: 'stt:download-done',
  sttDownloadError: 'stt:download-error',

  // shell / dialogs
  pickFolder: 'dialog:pick-folder',
  makeProjectFolder: 'dialog:make-project-folder',
  openPath: 'shell:open-path',
  openExternal: 'shell:open-external',

  // onboarding — is `claude` / `kimi` / `gemini` on this machine's PATH?
  agentsProbe: 'agents:probe',
  // the same question about an arbitrary profile command, for the chooser and
  // the Agents settings, which have custom profiles to answer for too
  agentsWhich: 'agents:which',

  // window
  appInfo: 'app:info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  windowTitlebar: 'window:titlebar',
  /**
   * Un-minimise the main window and bring it to the front.
   *
   * For the overlay: it floats over Chrome while Forge is minimised, so a link
   * in it that opens Settings has to *show* Forge as well, or the click looks
   * like it did nothing at all.
   */
  windowRestoreFocus: 'window:restore-focus',

  // voice agent (M4)
  voiceGemini: 'voice:gemini',
  voiceOpenRouter: 'voice:openrouter',
  voiceGroq: 'voice:groq',
  voiceImportKey: 'voice:import-key',

  // media generation (M6) — the same REST calls the MCP bridge makes, so the
  // voice agent's executor can generate images too.
  voiceMakeImage: 'voice:make-image',
  voiceEditImage: 'voice:edit-image',
  /** Veo. Same door as the two above, but it takes minutes rather than seconds. */
  voiceMakeVideo: 'voice:make-video',

  /**
   * Neural speech (M10). Text in, raw PCM out — the renderer plays it through
   * Web Audio. The key never leaves the main process, same as the media calls.
   */
  voiceSpeak: 'voice:speak',
  /**
   * Barge-in: abort an in-flight `voice:speak`. Steve talking over the agent
   * must stop the request as well as the sound, or the quota is spent on words
   * nobody will ever hear.
   */
  voiceSpeakCancel: 'voice:speak-cancel',

  /* ------------------------------------------------------- claude voice brain
   *
   * The persistent Claude Agent SDK session in the main process — one session
   * for the life of the app, not a call per turn. See electron/voice-agent/.
   *
   * Two directions, and they are not symmetrical:
   *
   *   renderer --start/utterance/interrupt--> main      (invoke, R→M)
   *   main     --event-------------------->  renderer   (push,   M→R)
   *   main     --tool-request------------->  renderer   (push,   M→R)
   *   renderer --tool-result------------->   main       (invoke, R→M)
   *
   * The tool pair is the interesting one: only the renderer knows what is on
   * screen, so when the brain wants app state or wants to *do* something, it
   * asks and waits rather than the main process guessing.
   */
  voiceAgentStart: 'voice-agent:start',
  voiceAgentStop: 'voice-agent:stop',
  /** One thing Steve said. Lazily opens the session if it is not running. */
  voiceAgentUtterance: 'voice-agent:utterance',
  /** Barge-in. Ends the turn; the session itself survives. */
  voiceAgentInterrupt: 'voice-agent:interrupt',
  /**
   * The streaming channel — text deltas, tool starts and stops, the result.
   * Typed as VoiceAgentEvent in shared/types.ts.
   */
  voiceAgentEvent: 'voice-agent:event',
  /** The brain asking the renderer something. Answered exactly once. */
  voiceAgentToolRequest: 'voice-agent:tool-request',
  voiceAgentToolResult: 'voice-agent:tool-result',

  // per-project agent memory (M7) — one markdown file per project, read into
  // the brain's system text and written back after every exchange.
  memoryRead: 'memory:read',
  memoryAppend: 'memory:append',
  memoryReplaceSummary: 'memory:replace-summary',
  memoryClear: 'memory:clear',
  // forge companion — the phone link (M9)
  companionStatus: 'companion:status',
  companionStatusEvent: 'companion:status-event',
  companionSignIn: 'companion:sign-in',
  companionSignOut: 'companion:sign-out',
  companionPublish: 'companion:publish',
  companionReply: 'companion:reply',
  /**
   * A message arrived from the phone. THE hookup point for the voice pipeline —
   * see CompanionUtteranceEvent in shared/types.ts.
   */
  companionUtterance: 'companion:utterance',

  /* forge mobile (M11) — the phone's terminal link. The Companion above carries
   * messages and images over Firebase; this carries real PTY bytes over a real
   * socket. See docs/MOBILE.md. */
  mobileStatus: 'mobile:status',
  mobileStatusEvent: 'mobile:status-event',
  mobileStart: 'mobile:start',
  mobileStop: 'mobile:stop',
  /** Mint a single-use pairing token for the QR in Settings. */
  mobilePair: 'mobile:pair',
  mobilePairCancel: 'mobile:pair-cancel',
  mobileRevoke: 'mobile:revoke',
  /**
   * Arm or disarm "Accept new phones" — the tap-to-pair window. Arming writes
   * `mobileAcceptUntil` and the window closes itself; the resulting deadline
   * rides mobileStatusEvent like everything else here.
   */
  mobileAccept: 'mobile:accept',
  /**
   * A phone is asking to pair. Main → renderer, carrying the word pair the
   * phone is showing; the renderer raises the prompt and answers with
   * `mobileApprovalResult`. The prompt replaces the typing, not the
   * authorisation — nothing is minted until the answer says allow.
   */
  mobileApproval: 'mobile:approval',
  /** The renderer's verdict on a mobileApproval. Absence of an answer is a deny. */
  mobileApprovalResult: 'mobile:approval-result',
  /**
   * A layout operation arriving from a phone. Main → renderer, because the
   * renderer owns tabs and panes and persists them; the phone must take the
   * same code path a local click takes, not a second one that can disagree.
   */
  mobileCommand: 'mobile:command',
  /** The renderer's answer to a mobileCommand. */
  mobileCommandResult: 'mobile:command-result',
  /**
   * The ngrok tunnel — config, and its own on/off. Status rides the existing
   * mobileStatusEvent broadcast; there is no second event stream to subscribe
   * to and no second one to forget to.
   */
  mobileTunnelConfig: 'mobile:tunnel-config',
  mobileTunnelStart: 'mobile:tunnel-start',
  mobileTunnelStop: 'mobile:tunnel-stop',

  // skills library (M8) — %APPDATA%\Forge\skills, junctioned into
  // ~/.claude/skills so every claude and kimi session on the machine sees them.
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  skillsCreate: 'skills:create',
  skillsImport: 'skills:import',
  skillsRemove: 'skills:remove',
  skillsSetEnabled: 'skills:set-enabled',
  skillsOpenFolder: 'skills:open-folder',
  /** Copy one of Steve's own ~/.claude/skills into the library. Never a move. */
  skillsCopyToLibrary: 'skills:copy-to-library',

  // system probes (M6 settings page)
  systemUserName: 'system:user-name',
  systemClaudeVersion: 'system:claude-version',

  // updates & tools (M10) — what is installed, what is available
  toolsProbe: 'tools:probe',
  toolsLatest: 'tools:latest',

  // the slash-command reference and the Claude Code changelog, fetched from
  // the published docs and cached. Read-only; nothing here installs anything.
  commandsFeed: 'commands:feed',

  // forge self-update (M10). Packaged builds only; every one of these is safe
  // to call in a dev run and answers `unsupported`.
  updateStatus: 'update:status',
  updateStatusEvent: 'update:status-event',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  // dev-run staleness (the other half of the above). Checkouts only; in a
  // packaged build these are safe to call and answer "not stale", forever.
  staleStatus: 'stale:status',
  staleStatusEvent: 'stale:status-event',
  staleRestart: 'stale:restart',

  /* ----------------------------------------------------------- voice overlay
   *
   * The undocked voice hub, as a real Windows window rather than a div inside
   * Forge — always on top, above Chrome, still there when Forge is minimised.
   *
   * There is still exactly ONE voice agent, and it is the one in the main
   * window's renderer (src/state/VoiceAgent.tsx). The overlay is a *view* of it:
   * a second renderer that owns no subscription, no sidecar and no mouth. So
   * every channel below is a relay with the main process in the middle —
   *
   *   host renderer  --overlayState-->  main  --overlayState-->  overlay
   *   overlay        --overlayCall--->  main  --overlayCall--->  host renderer
   *
   * and the main process never interprets a payload, it only forwards it. That
   * is what keeps the two windows from becoming two agents talking over each
   * other, which is the exact failure the hub was built to avoid.
   */
  /** Show the overlay window (and move/resize it). Host renderer → main. */
  overlayOpen: 'overlay:open',
  /** Hide and destroy it — the hub was docked, or Forge is closing. */
  overlayClose: 'overlay:close',
  /** Screen-space bounds, both ways: main pushes after a user drag/resize. */
  overlaySetBounds: 'overlay:set-bounds',
  overlayBoundsEvent: 'overlay:bounds-event',
  /**
   * The whole mirrored snapshot — phase, turns, draft, brain status. Pushed by
   * the host on change and forwarded verbatim. Typed in the renderer only (see
   * src/lib/overlaystate.ts); main treats it as opaque.
   */
  overlayState: 'overlay:state',
  /**
   * The mic level on its own channel, ~15/s. Kept out of the snapshot so the
   * ring can breathe without re-rendering a conversation ten times a second.
   */
  overlayLevel: 'overlay:level',
  /** A callback invoked on the overlay, run against the real engine on the host. */
  overlayCall: 'overlay:call',

  // diagnostics
  rendererError: 'diag:renderer-error'
} as const

/**
 * App-wide backstop, not the working limit — the limit a user actually meets is
 * MAX_TABS_PER_PROJECT. This one exists because every pane is a real ConPTY
 * with a real console host process behind it, so "unlimited" has to stop
 * somewhere before the machine does.
 */
export const MAX_SESSIONS = 128
export const MAX_TABS_PER_PROJECT = 8
export const MAX_PANES_PER_TAB = 8

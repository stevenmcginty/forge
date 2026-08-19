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
  /**
   * A pane's grid moved, or changed hands. Main → renderer.
   *
   * The width follows the typist (see electron/pty/grid-owner.ts), so this desk
   * is a *follower* of any pane a phone or a browser last typed into: it has to
   * draw that pane at the grid the PTY really has, font-scaled into its own box,
   * exactly as the remote clients have always drawn the desk's. `deskOwns` is
   * which of the two this is, and it has to travel with the size because
   * changing hands is not always a resize — the new owner may already want the
   * shape the pane has.
   *
   * Coalesced in electron/pty-host.ts on the same 80ms the remote links use, so
   * a window drag or a split is one message rather than one per pane per frame.
   */
  ptyGeometry: 'pty:geometry',

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

  // git — "where does this folder push?", for the project menu's Repository URL
  gitRemoteOrigin: 'git:remote-origin',

  /**
   * "How does this project start its dev server?" — one read of the folder's
   * package.json, for the Devices preview's Start button.
   *
   * A sibling of `gitRemoteOrigin` above in every way that matters: it takes a
   * folder, it answers a question about that folder, and it is incapable of
   * doing anything else. It reads one file and never runs one — the command it
   * comes back with is typed into a terminal pane by the renderer, where a
   * person can see it before it goes anywhere.
   */
  previewDevCommand: 'preview:dev-command',

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
  /**
   * Mint a pairing code for the Devices preview — the same single-use machinery
   * as the QR, but pointed at loopback and without touching the Settings detail
   * line, because a preview frame reloading is not a pairing event anyone asked
   * to be told about. See docs/MOBILE.md's "Preview from the desk" section.
   */
  mobilePreviewPair: 'mobile:preview-pair',
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
   * Which panes a phone currently has open. Main → renderer, on every change.
   *
   * It used to carry a geometry too, and the renderer used to letterbox those
   * panes at it. It no longer does: plugging a phone in must not change the
   * resolution at the desk, so the desk keeps its grid and the phone draws that
   * grid scaled to its own screen. All the renderer does with this list is
   * label the panes on it — see the note above `watched` in
   * electron/mobile-host.ts, and `setPhoneWatched` in src/lib/terminals.ts.
   */
  mobileWatched: 'mobile:watched',
  /**
   * The ngrok tunnel — config, and its own on/off. Status rides the existing
   * mobileStatusEvent broadcast; there is no second event stream to subscribe
   * to and no second one to forget to.
   */
  mobileTunnelConfig: 'mobile:tunnel-config',
  mobileTunnelStart: 'mobile:tunnel-start',
  mobileTunnelStop: 'mobile:tunnel-stop',
  /**
   * Forge TV — the same mobile app as a Fire TV APK, built on demand.
   *
   * `mobileTvBuild` starts a build that takes minutes (Vite, then Gradle) and
   * returns immediately; progress and the ending arrive on
   * `mobileTvStatusEvent`, which is a stream of its own rather than a field on
   * mobileStatusEvent because it changes line by line while a build runs and
   * nothing else on that panel does.
   *
   * `mobileTvFetch` is the same feature for every machine that cannot build:
   * it downloads the published, address-less TV app instead of assembling one.
   * Same status stream, same ending — the difference is minutes of Gradle
   * against twenty megabytes of download, and an APK that works in one house
   * against one that works in anybody's.
   */
  mobileTvStatus: 'mobile:tv-status',
  mobileTvStatusEvent: 'mobile:tv-status-event',
  mobileTvBuild: 'mobile:tv-build',
  mobileTvFetch: 'mobile:tv-fetch',

  /* ------------------------------------------------------ forge tv mirror
   *
   * The television watching this desktop's actual screen, over WebRTC. The
   * peer connection lives in the *renderer*, because that is the only half of
   * Electron with a WebRTC stack — the main process can relay an SDP but
   * cannot make one — so every channel here is a pass-through:
   *
   *   TV --ws--> main --mobileMirror-------> renderer   (capture, then offer)
   *   renderer --mobileMirrorSignal--> main --ws--> TV  (offer, candidates)
   *
   * The signal payloads are opaque JSON strings on both sides of main; nothing
   * outside the renderer reads one. See the screen-mirror block in
   * shared/mobile.ts, and src/lib/mirror.ts for the half that decodes them.
   */
  /** Main → renderer: start, a signaling payload, or stop. MobileMirrorEvent. */
  mobileMirror: 'mobile:mirror',
  /** Renderer → main: an SDP or an ICE candidate, for the watching television. */
  mobileMirrorSignal: 'mobile:mirror-signal',
  /**
   * Renderer → main: the mirror is over, and why. Sent when the capture cannot
   * start, when Steve stops sharing at the OS level, and when the peer dies —
   * the reason is a sentence the television puts on screen instead of black.
   */
  mobileMirrorStop: 'mobile:mirror-stop',
  /**
   * The primary screen's `desktopCapturer` source id. Renderer → main invoke,
   * because `desktopCapturer` has been main-only since Electron 17 and that id
   * is the entire thing the renderer needs from it to open a stream onto the
   * desktop.
   */
  mobileMirrorSource: 'mobile:mirror-source',

  /* ------------------------------------------------------------- forge web
   *
   * Forge in a browser tab: the same terminals, mirrored, behind a public
   * address. See docs/forge-web.md and electron/web-host.ts.
   *
   * The naming follows the `mobile*` block above, and so does the shape of it:
   * one status invoke, one status *event* everything else rides, and a
   * request/response pair for each of the two questions main has to put to the
   * renderer. There is deliberately no second event stream — a panel that has
   * to subscribe to four things is a panel that forgets one.
   */
  webStatus: 'web:status',
  webStatusEvent: 'web:status-event',
  /** Bind the port and start listening. Persists `webEnabled: true`. */
  webStart: 'web:start',
  /**
   * The one-click friend path: sign-in must already have landed, then this
   * turns the link on *and* starts a tunnel (cloudflared if they had none).
   * Distinct from `webStart`, which honours `webTunnel: off`.
   */
  webEnable: 'web:enable',
  /** Stop listening, retract the rendezvous record. Persists `webEnabled: false`. */
  webStop: 'web:stop',
  /**
   * Forge Web's *own* Firebase sign-in — its own account, its own refresh
   * token, nothing to do with `companionSignIn` beyond sharing a provider.
   *
   * It exists because the alternative was discovered rather than designed: with
   * no session of its own, Forge Web published under the Companion's, which
   * made this door depend on another feature being signed in as the same
   * account and stop working silently when it was not. See the header of
   * electron/web-host.ts.
   *
   * The password is used for one HTTPS POST and dropped; what is persisted is a
   * refresh token. Signing in does **not** switch the link on — that is
   * `webStart`, deliberately separate, because this one puts a shell behind a
   * public address.
   */
  webSignIn: 'web:sign-in',
  /**
   * Sign out: the rendezvous record is retracted first, then the credential and
   * the uid are cleared. The email is kept so the form pre-fills.
   */
  webSignOut: 'web:sign-out',
  /**
   * Set the unlock PIN every browser has to present. The digits cross this
   * boundary once, are hashed in main by `electron/web/pin.ts`, and only the
   * hash reaches settings.json — the same rule the ngrok authtoken follows, and
   * for a sharper reason: this is the second half of the lock on a shell.
   *
   * Answered with the new status, or with a sentence when what was typed is not
   * a PIN. The validation is main's rather than the panel's, because a renderer
   * is not the thing that decides what opens this door.
   */
  webPinSet: 'web:pin-set',
  /**
   * Remove the unlock PIN. The desktop falls back to admitting a verified token
   * for the configured uid on the account alone, and refuses screen *control*
   * outright — see `canControl` in electron/web-host.ts.
   */
  webPinClear: 'web:pin-clear',
  /**
   * A layout operation arriving from a browser. Main → renderer, because the
   * renderer owns the split tree and persists it — the browser must take the
   * same code path a local click takes, not a second one that can disagree
   * (docs/forge-web.md, decision 5).
   */
  webCommand: 'web:command',
  /**
   * A browser asking for a folder to be added to the project rail. Main →
   * renderer, for the same reason `webCommand` is: the renderer owns the
   * project list and persists it, so the browser has to reach `addProjectPath`
   * — the very function the desktop's own button reaches — rather than a second
   * route into the rail that could disagree with it.
   *
   * A channel beside `webCommand` rather than a widening of it, and the reason
   * is the payload rather than tidiness. `WebCommandEvent.op` is a
   * `WebLayoutOp`: every field on it is optional except `projectId`, which is
   * required *because* every layout operation happens inside a project. Adding
   * a project happens inside no project and carries a path instead, so folding
   * it in would mean either a union the renderer has to narrow before its
   * switch, or a `projectId` that lies on one member. Two events, one *answer*
   * channel below, is the cheaper honesty — and it is the same judgement
   * src/state/AppState.tsx already made about handling the phone's `onCommand`
   * and the browser's separately.
   */
  webProjectAdd: 'web:project-add',
  /**
   * The renderer's answer to a `webCommand` or a `webProjectAdd`.
   *
   * One channel for both, deliberately: `requestId` is what the main side
   * matches on, both questions are answered with the same "an error sentence,
   * or nothing", and both are settled by the same pending map and the same
   * deadline. A second result channel would be a second timeout to get wrong.
   */
  webCommandResult: 'web:command-result',
  /**
   * Which panes a browser currently has open. Main → renderer, on every change.
   *
   * The message `mobileWatched` is, on the other link and for the same reason:
   * re-flowing the panes in front of somebody because a tab opened in another
   * town is the app rearranging their work. So this carries ids, the renderer
   * keeps drawing these panes at its own size, and all it does with the list is
   * label them — see `setBrowserWatched` in src/lib/terminals.ts.
   */
  webWatched: 'web:watched',

  /* ------------------------------------------------------ forge web mirror
   *
   * A browser watching this desktop's actual screen. The capture and the
   * encoder live in the *renderer*, because that is the half of Electron with
   * a display to open a stream onto and a `VideoEncoder` to hand it to, so
   * these are pass-throughs in both directions:
   *
   *   browser --ws--> main --webMirror-------------> renderer  (capture, encode)
   *   renderer --webMirrorReady/Chunk--> main --ws--> browser  (config, chunks)
   *
   * Unlike the Forge TV block above there is no signalling and no peer
   * connection: WebRTC media never enters the tunnel this link is reached
   * through, so the picture rides the socket that is already open. The
   * reasoning is set out in full in the screen-mirror block of shared/web.ts.
   *
   * There is deliberately no `webMirrorSource` beside these. The renderer needs
   * the primary display's `desktopCapturer` id and `mobileMirrorSource` already
   * hands it over — the id is a fact about this machine, not about which link
   * asked for it, and a second channel returning the same string would be a
   * second thing to keep in step with Electron's main-only `desktopCapturer`.
   */
  /** Main → renderer: start capturing (with or without sound), or stop. WebMirrorEvent. */
  webMirror: 'web:mirror',
  /**
   * Renderer → main: the capture is up, and here is what a decoder on the far
   * end has to be configured with. Sent once per watch, before any chunk —
   * `WebMirrorConfig` in shared/web.ts is the shape, carried through main
   * unchanged because main has no opinion about codecs.
   */
  webMirrorReady: 'web:mirror-ready',
  /** Renderer → main: one encoded chunk, base64. See `WebMirrorChunk`. */
  webMirrorChunk: 'web:mirror-chunk',
  /**
   * Renderer → main: the capture ended here, and why — it was refused, Steve
   * stopped sharing at the OS level, the encoder died. The sentence is what the
   * browser shows instead of a frozen last frame.
   */
  webMirrorStop: 'web:mirror-stop',
  /**
   * The person at the desk taking their screen back. Renderer → main *invoke*,
   * answered with the new `WebStatus`.
   *
   * A separate channel from `webMirrorStop` because they are opposite errands
   * that happen to end the same way: that one is the capture reporting its own
   * death, this one is a human ending a watch that is working perfectly. Only
   * one of the two is a button.
   */
  webMirrorEnd: 'web:mirror-end',

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

  // skill packs — the .forgepack file you hand somebody else. Library skills
  // travel as content; installed plugins travel as a `/plugin` recipe, never as
  // copied files. See shared/skillpack.ts.
  /** The plugin recipes this machine could contribute, for the export sheet. */
  skillsPackPlugins: 'skills:pack-plugins',
  /** Build a pack and write it wherever the save dialog says. */
  skillsPackExport: 'skills:pack-export',
  /** The same skills as a plain zip of folders, for people without Forge. */
  skillsPackExportZip: 'skills:pack-export-zip',
  /** Read and validate a pack for preview. Writes nothing. */
  skillsPackOpen: 'skills:pack-open',
  /** Install chosen skills from a pack already on disk, by path. */
  skillsPackInstall: 'skills:pack-install',

  // system probes (M6 settings page)
  systemUserName: 'system:user-name',
  systemClaudeVersion: 'system:claude-version',

  // where Claude Code filed a session's transcript — the handover door: drag a
  // tab onto another agent's pane and the target gets pointed at this file
  claudeTranscript: 'claude:transcript',

  // planner (tasks-panel planning session)
  plannerWatch: 'planner:watch',
  plannerUnwatch: 'planner:unwatch',
  plannerUpdate: 'planner:update',

  /*
   * git — the rail's GIT section.
   *
   * Read-mostly. `gitAction` is the only channel that can change a repository,
   * and the five things it will do are enumerated in electron/git/git-actions.ts;
   * nothing else in the app spawns a writing git. The existing
   * `gitRemoteOrigin` above is untouched and stays where it is — it answers one
   * question synchronously for the pty host and has nothing to do with this.
   */
  gitWatch: 'git:watch',
  gitUnwatch: 'git:unwatch',
  gitRefresh: 'git:refresh',
  gitSnapshot: 'git:snapshot',
  gitAction: 'git:action',
  gitRemoteBranches: 'git:remote-branches',
  /** Read-only: what switching to a branch would cost, asked before it is done. */
  gitBranchCompare: 'git:branch-compare',
  gitGhRefresh: 'git:gh-refresh',

  /*
   * activity — which agent is touching which file.
   *
   * `activityBusy` is a send rather than an invoke because it rides a hot
   * subscription: the renderer pushes a pane's busy edge as it happens, and
   * awaiting an answer per edge would be a round trip for nothing.
   */
  activityWatch: 'activity:watch',
  activityUnwatch: 'activity:unwatch',
  activityBusy: 'activity:busy',
  activityClear: 'activity:clear',
  activityUpdate: 'activity:update',

  /*
   * share — the rail's SHARE section: five markdown slots in
   * <project>\.forge\share that every agent in the project can read and write.
   *
   * Write-capable, unlike git's read-mostly surface. What makes that safe is the
   * shape of the arguments rather than a check inside the handlers: every channel
   * here takes a project id and, where it names a slot, an *integer*. No path
   * ever crosses this boundary, so the set of files the renderer can reach is
   * five per project and cannot be widened by getting a string wrong.
   *
   * `shareRoster` and `shareReveal` are sends: the roster rides a debounced
   * effect that fires on every pane open, close and rename, and revealing a file
   * in Explorer has nothing to answer with.
   */
  shareWatch: 'share:watch',
  shareUnwatch: 'share:unwatch',
  shareRefresh: 'share:refresh',
  shareSnapshot: 'share:snapshot',
  /** The full body of one slot, fetched only when a row is opened to be read. */
  shareRead: 'share:read',
  shareWrite: 'share:write',
  shareClear: 'share:clear',
  /**
   * Capture a pane's output into a slot from the *main* side, for a pane whose
   * terminal this renderer has never had. The normal route reads xterm's own
   * parsed grid instead — see src/lib/paneText.ts for why that is better.
   */
  shareCapture: 'share:capture',
  /** send — the pane roster, on a debounced effect. */
  shareRoster: 'share:roster',
  /** send — show a slot, or the folder, in Explorer. */
  shareReveal: 'share:reveal',

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

  // The stable checkout updating itself from origin (electron/source-updater.ts).
  // Unsupported everywhere else: packaged builds have the real updater, and the
  // dev checkout is where the commits come from in the first place.
  sourceUpdateStatus: 'srcupdate:status',
  sourceUpdateEvent: 'srcupdate:status-event',
  sourceUpdateCheck: 'srcupdate:check',
  sourceUpdateApply: 'srcupdate:apply',

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

/**
 * The delegation tray's backstops. A tray is a handful of things you are about
 * to do, not a backlog — 32 cards is already a smell — and a card's text is
 * typed into a real terminal, so it stops well short of "someone pasted a
 * novel".
 */
export const MAX_TASK_CARDS = 32
export const MAX_TASK_TEXT = 4000

/**
 * The Devices preview's hand-typed start command. One command line — `npx serve
 * .`, `python app.py` — and it ends up typed into a real shell, so it is bounded
 * on the way in and again on the way off disk.
 */
export const MAX_DEV_COMMAND = 512

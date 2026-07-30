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

  // window
  appInfo: 'app:info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  windowTitlebar: 'window:titlebar',

  // voice agent (M4)
  voiceGemini: 'voice:gemini',
  voiceOpenRouter: 'voice:openrouter',
  voiceImportKey: 'voice:import-key',

  // media generation (M6) — the same REST calls the MCP bridge makes, so the
  // voice agent's executor can generate images too.
  voiceMakeImage: 'voice:make-image',
  voiceEditImage: 'voice:edit-image',

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

  // system probes (M6 settings page)
  systemUserName: 'system:user-name',
  systemClaudeVersion: 'system:claude-version',

  // diagnostics
  rendererError: 'diag:renderer-error'
} as const

export const MAX_SESSIONS = 16
export const MAX_PANES_PER_TAB = 8

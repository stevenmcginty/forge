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

  // shell / dialogs
  pickFolder: 'dialog:pick-folder',
  openPath: 'shell:open-path',

  // window
  appInfo: 'app:info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',

  // diagnostics
  rendererError: 'diag:renderer-error'
} as const

export const MAX_SESSIONS = 16
export const MAX_PANES_PER_TAB = 8

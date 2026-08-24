/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type { ForgeApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ForgeApi = {
  info: () => ipcRenderer.invoke(IPC.appInfo),

  pty: {
    create: (req) => ipcRenderer.invoke(IPC.ptyCreate, req),
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    rename: (id, title) => ipcRenderer.send(IPC.ptyRename, id, title),
    kill: (id) => ipcRenderer.invoke(IPC.ptyKill, id),
    list: () => ipcRenderer.invoke(IPC.ptyList),
    onData: (cb) => subscribe(IPC.ptyData, cb),
    onExit: (cb) => subscribe(IPC.ptyExit, cb),
    onGeometry: (cb) => subscribe(IPC.ptyGeometry, cb)
  },

  store: {
    snapshot: () => ipcRenderer.invoke(IPC.storeSnapshot),
    setSettings: (patch) => ipcRenderer.invoke(IPC.storeSetSettings, patch),
    setProjects: (projects) => ipcRenderer.invoke(IPC.storeSetProjects, projects),
    getWorkspace: (projectId) => ipcRenderer.invoke(IPC.storeGetWorkspace, projectId),
    setWorkspace: (projectId, workspace) => ipcRenderer.invoke(IPC.storeSetWorkspace, projectId, workspace),
    deleteWorkspace: (projectId) => ipcRenderer.invoke(IPC.storeDeleteWorkspace, projectId),
    revealDataDir: () => ipcRenderer.invoke(IPC.storeReveal),
    onWorkspaceReplaced: (cb) => subscribe(IPC.workspaceReplaced, cb)
  },

  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardReadText),
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWriteText, text)
  },

  shots: {
    list: () => ipcRenderer.invoke(IPC.shotsList),
    remove: (path) => ipcRenderer.invoke(IPC.shotsRemove, path),
    clear: () => ipcRenderer.invoke(IPC.shotsClear),
    copy: (path) => ipcRenderer.invoke(IPC.shotsCopy, path),
    adopt: (paths) => ipcRenderer.invoke(IPC.shotsAdopt, paths),
    // send, not invoke: startDrag has to happen while the mouse button is
    // still down, so there is nothing useful to await.
    startDrag: (path) => ipcRenderer.send(IPC.shotsDrag, path),
    openFolder: () => ipcRenderer.invoke(IPC.shotsOpenFolder),
    onUpdated: (cb) => subscribe(IPC.shotsUpdated, cb)
  },

  stt: {
    // `?? {}` rather than passing undefined through: the handler treats an
    // empty request as the plain push-to-talk start, which is what an old
    // caller with no arguments means.
    start: (options) => ipcRenderer.invoke(IPC.sttStart, options ?? {}),
    stop: () => ipcRenderer.invoke(IPC.sttStop),
    capture: () => ipcRenderer.invoke(IPC.sttCapture),
    reload: (force) => ipcRenderer.invoke(IPC.sttReload, force === true),
    status: () => ipcRenderer.invoke(IPC.sttStatus),
    onStatus: (cb) => subscribe(IPC.sttStatusEvent, cb),
    onPhrase: (cb) => subscribe(IPC.sttPhrase, cb),

    downloadModel: () => ipcRenderer.invoke(IPC.sttDownloadModel),
    cancelDownload: () => ipcRenderer.invoke(IPC.sttDownloadCancel),
    modelState: () => ipcRenderer.invoke(IPC.sttDownloadState),
    onDownloadProgress: (cb) => subscribe(IPC.sttDownloadProgress, cb),
    onDownloadDone: (cb) => subscribe(IPC.sttDownloadDone, cb),
    onDownloadError: (cb) => subscribe(IPC.sttDownloadError, cb)
  },

  voice: {
    gemini: (req) => ipcRenderer.invoke(IPC.voiceGemini, req),
    openrouter: (req) => ipcRenderer.invoke(IPC.voiceOpenRouter, req),
    groq: (req) => ipcRenderer.invoke(IPC.voiceGroq, req),
    importKey: (which) => ipcRenderer.invoke(IPC.voiceImportKey, which ?? 'gemini'),
    makeImage: (req) => ipcRenderer.invoke(IPC.voiceMakeImage, req),
    editImage: (req) => ipcRenderer.invoke(IPC.voiceEditImage, req),
    makeVideo: (req) => ipcRenderer.invoke(IPC.voiceMakeVideo, req),
    speak: (req) => ipcRenderer.invoke(IPC.voiceSpeak, req),
    cancelSpeak: (requestId) => ipcRenderer.invoke(IPC.voiceSpeakCancel, requestId)
  },

  voiceAgent: {
    start: (req) => ipcRenderer.invoke(IPC.voiceAgentStart, req ?? {}),
    stop: () => ipcRenderer.invoke(IPC.voiceAgentStop),
    utterance: (text) => ipcRenderer.invoke(IPC.voiceAgentUtterance, String(text ?? '')),
    interrupt: () => ipcRenderer.invoke(IPC.voiceAgentInterrupt),
    onEvent: (cb) => subscribe(IPC.voiceAgentEvent, cb),
    onToolRequest: (cb) => subscribe(IPC.voiceAgentToolRequest, cb),
    toolResult: (result) => ipcRenderer.invoke(IPC.voiceAgentToolResult, result)
  },

  foreman: {
    start: (req) => ipcRenderer.invoke(IPC.foremanStart, req),
    stop: (paneId) => ipcRenderer.invoke(IPC.foremanStop, String(paneId ?? '')),
    list: () => ipcRenderer.invoke(IPC.foremanList),
    onState: (cb) => subscribe(IPC.foremanState, cb),
    onToolRequest: (cb) => subscribe(IPC.foremanToolRequest, cb),
    toolResult: (result) => ipcRenderer.invoke(IPC.foremanToolResult, result)
  },

  memory: {
    read: (projectId) => ipcRenderer.invoke(IPC.memoryRead, projectId),
    append: (projectId, section, entry, at) => ipcRenderer.invoke(IPC.memoryAppend, projectId, section, entry, at),
    replaceSummary: (projectId, text) => ipcRenderer.invoke(IPC.memoryReplaceSummary, projectId, text),
    clear: (projectId) => ipcRenderer.invoke(IPC.memoryClear, projectId)
  },

  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList),
    read: (name, source) => ipcRenderer.invoke(IPC.skillsRead, name, source ?? 'library'),
    create: (name, description) => ipcRenderer.invoke(IPC.skillsCreate, name, description),
    importFolder: (sourceDir) => ipcRenderer.invoke(IPC.skillsImport, sourceDir ?? ''),
    remove: (name) => ipcRenderer.invoke(IPC.skillsRemove, name),
    setEnabled: (name, on) => ipcRenderer.invoke(IPC.skillsSetEnabled, name, on === true),
    copyToLibrary: (name) => ipcRenderer.invoke(IPC.skillsCopyToLibrary, name),
    openFolder: (name, source) => ipcRenderer.invoke(IPC.skillsOpenFolder, name ?? '', source ?? 'library'),
    pack: {
      plugins: () => ipcRenderer.invoke(IPC.skillsPackPlugins),
      exportPack: (skills, includePlugins, note) =>
        ipcRenderer.invoke(IPC.skillsPackExport, skills, includePlugins === true, note ?? ''),
      exportZip: (skills, includePlugins, note) =>
        ipcRenderer.invoke(IPC.skillsPackExportZip, skills, includePlugins === true, note ?? ''),
      open: (path) => ipcRenderer.invoke(IPC.skillsPackOpen, path ?? ''),
      install: (path, skills) => ipcRenderer.invoke(IPC.skillsPackInstall, path, skills)
    }
  },

  companion: {
    status: () => ipcRenderer.invoke(IPC.companionStatus),
    signIn: (email, password) => ipcRenderer.invoke(IPC.companionSignIn, email, password),
    signOut: () => ipcRenderer.invoke(IPC.companionSignOut),
    publish: () => ipcRenderer.invoke(IPC.companionPublish),
    reply: (itemId, text, projectId) => ipcRenderer.invoke(IPC.companionReply, itemId, text, projectId),
    onStatus: (cb) => subscribe(IPC.companionStatusEvent, cb),
    onUtterance: (cb) => subscribe(IPC.companionUtterance, cb)
  },

  mobile: {
    status: () => ipcRenderer.invoke(IPC.mobileStatus),
    start: () => ipcRenderer.invoke(IPC.mobileStart),
    stop: () => ipcRenderer.invoke(IPC.mobileStop),
    pair: () => ipcRenderer.invoke(IPC.mobilePair),
    pairCancel: () => ipcRenderer.invoke(IPC.mobilePairCancel),
    previewPair: () => ipcRenderer.invoke(IPC.mobilePreviewPair),
    setAccept: (on) => ipcRenderer.invoke(IPC.mobileAccept, on === true),
    revoke: (deviceId) => ipcRenderer.invoke(IPC.mobileRevoke, deviceId ?? ''),
    setTunnel: (config) => ipcRenderer.invoke(IPC.mobileTunnelConfig, config ?? {}),
    startTunnel: () => ipcRenderer.invoke(IPC.mobileTunnelStart),
    stopTunnel: () => ipcRenderer.invoke(IPC.mobileTunnelStop),
    onStatus: (cb) => subscribe(IPC.mobileStatusEvent, cb),
    onCommand: (cb) => subscribe(IPC.mobileCommand, cb),
    commandResult: (requestId, error) =>
      ipcRenderer.send(IPC.mobileCommandResult, { requestId, error: error ?? '' }),
    onWatched: (cb) => subscribe(IPC.mobileWatched, cb),
    onApproval: (cb) => subscribe(IPC.mobileApproval, cb),
    // `=== true` so nothing short of an explicit allow crosses as one — a
    // truthy accident on this boundary would be a paired stranger.
    approvalResult: (requestId, allow) =>
      ipcRenderer.send(IPC.mobileApprovalResult, { requestId, allow: allow === true }),
    tvStatus: () => ipcRenderer.invoke(IPC.mobileTvStatus),
    tvBuild: () => ipcRenderer.invoke(IPC.mobileTvBuild),
    tvFetch: () => ipcRenderer.invoke(IPC.mobileTvFetch),
    onTvStatus: (cb) => subscribe(IPC.mobileTvStatusEvent, cb),
    onMirror: (cb) => subscribe(IPC.mobileMirror, cb),
    mirrorSource: () => ipcRenderer.invoke(IPC.mobileMirrorSource),
    mirrorSignal: (data) => ipcRenderer.send(IPC.mobileMirrorSignal, { data }),
    mirrorStop: (reason) => ipcRenderer.send(IPC.mobileMirrorStop, { reason: reason ?? '' })
  },

  web: {
    status: () => ipcRenderer.invoke(IPC.webStatus),
    start: () => ipcRenderer.invoke(IPC.webStart),
    enable: () => ipcRenderer.invoke(IPC.webEnable),
    stop: () => ipcRenderer.invoke(IPC.webStop),
    // Forge Web's own Firebase session — not the Companion's. The password
    // crosses this bridge once and is never stored; see IPC.webSignIn.
    signIn: (email, password) => ipcRenderer.invoke(IPC.webSignIn, email ?? '', password ?? ''),
    signOut: () => ipcRenderer.invoke(IPC.webSignOut),
    // The digits cross this bridge once and are hashed on the other side; main
    // decides what counts as a PIN, because this door faces the internet and a
    // renderer is not the thing that should be settling that.
    setPin: (pin) => ipcRenderer.invoke(IPC.webPinSet, pin ?? ''),
    clearPin: () => ipcRenderer.invoke(IPC.webPinClear),
    onStatus: (cb) => subscribe(IPC.webStatusEvent, cb),
    onCommand: (cb) => subscribe(IPC.webCommand, cb),
    onProjectAdd: (cb) => subscribe(IPC.webProjectAdd, cb),
    // One result channel for both questions — see `IPC.webCommandResult`.
    commandResult: (requestId, error) => ipcRenderer.send(IPC.webCommandResult, { requestId, error: error ?? '' }),
    onWatched: (cb) => subscribe(IPC.webWatched, cb),
    // The attention detector's news, going the other way to everything else in
    // this block: the buffer it reads is here and the socket it ends on is
    // there. One object, so main validates one payload rather than three
    // positional arguments it has to trust the order of.
    attention: (sessionId, state, prompt) =>
      ipcRenderer.send(IPC.webAttention, {
        sessionId: sessionId ?? '',
        state: state ?? 'idle',
        prompt: prompt ?? ''
      }),
    // The screen mirror. Sends rather than invokes, on the same reasoning the
    // mobile pair above uses: a chunk is a stream, and a stream that waited for
    // an answer per frame would be a stream with a round trip in it.
    onMirror: (cb) => subscribe(IPC.webMirror, cb),
    mirrorReady: (config) => ipcRenderer.send(IPC.webMirrorReady, config),
    mirrorChunk: (chunk) => ipcRenderer.send(IPC.webMirrorChunk, chunk),
    mirrorStop: (reason) => ipcRenderer.send(IPC.webMirrorStop, { reason: reason ?? '' }),
    // The desk taking its screen back — a button, so an invoke that answers
    // with the status the card redraws from.
    stopMirror: () => ipcRenderer.invoke(IPC.webMirrorEnd)
  },

  system: {
    userName: () => ipcRenderer.invoke(IPC.systemUserName),
    claudeVersion: () => ipcRenderer.invoke(IPC.systemClaudeVersion),
    claudeTranscript: (cwd, sessionId) => ipcRenderer.invoke(IPC.claudeTranscript, cwd, sessionId)
  },

  planner: {
    watch: (req) => ipcRenderer.invoke(IPC.plannerWatch, req),
    // send, not invoke: dropping a watch has no answer worth waiting for, and
    // it is called from teardown paths that cannot await anything.
    unwatch: (projectId) => ipcRenderer.send(IPC.plannerUnwatch, projectId),
    onUpdate: (cb) => subscribe(IPC.plannerUpdate, cb)
  },

  git: {
    watch: (req) => ipcRenderer.invoke(IPC.gitWatch, req),
    unwatch: (projectId) => ipcRenderer.send(IPC.gitUnwatch, projectId),
    refresh: (projectId) => ipcRenderer.invoke(IPC.gitRefresh, projectId),
    action: (req) => ipcRenderer.invoke(IPC.gitAction, req),
    remoteBranches: (projectId) => ipcRenderer.invoke(IPC.gitRemoteBranches, projectId),
    branchCompare: (projectId, branch) => ipcRenderer.invoke(IPC.gitBranchCompare, { projectId, branch }),
    ghRefresh: (projectId) => ipcRenderer.invoke(IPC.gitGhRefresh, projectId),
    onSnapshot: (cb) => subscribe(IPC.gitSnapshot, cb)
  },

  activity: {
    watch: (req) => ipcRenderer.invoke(IPC.activityWatch, req),
    unwatch: (projectId) => ipcRenderer.send(IPC.activityUnwatch, projectId),
    // send, and on a hot path: one call per pane busy edge.
    setBusy: (projectId, paneId, busy) => ipcRenderer.send(IPC.activityBusy, projectId, paneId, busy),
    clear: (projectId) => ipcRenderer.send(IPC.activityClear, projectId),
    onUpdate: (cb) => subscribe(IPC.activityUpdate, cb)
  },

  share: {
    watch: (req) => ipcRenderer.invoke(IPC.shareWatch, req),
    unwatch: (projectId) => ipcRenderer.send(IPC.shareUnwatch, projectId),
    refresh: (projectId) => ipcRenderer.invoke(IPC.shareRefresh, projectId),
    read: (projectId, index) => ipcRenderer.invoke(IPC.shareRead, { projectId, index }),
    write: (req) => ipcRenderer.invoke(IPC.shareWrite, req),
    clear: (projectId, index) => ipcRenderer.invoke(IPC.shareClear, { projectId, index }),
    capture: (req) => ipcRenderer.invoke(IPC.shareCapture, req),
    // send, and deliberately: this fires on every pane open, close and rename.
    roster: (projectId, panes) => ipcRenderer.send(IPC.shareRoster, projectId, panes),
    reveal: (projectId, index) => ipcRenderer.send(IPC.shareReveal, projectId, index),
    onSnapshot: (cb) => subscribe(IPC.shareSnapshot, cb)
  },

  tools: {
    probe: (refresh) => ipcRenderer.invoke(IPC.toolsProbe, refresh === true),
    latest: (ids, refresh) => ipcRenderer.invoke(IPC.toolsLatest, ids ?? null, refresh === true)
  },

  commands: {
    feed: (refresh) => ipcRenderer.invoke(IPC.commandsFeed, refresh === true)
  },

  updates: {
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (cb) => subscribe(IPC.updateStatusEvent, cb)
  },

  dev: {
    staleStatus: () => ipcRenderer.invoke(IPC.staleStatus),
    onStale: (cb) => subscribe(IPC.staleStatusEvent, cb),
    restart: () => ipcRenderer.invoke(IPC.staleRestart),
    sourceStatus: () => ipcRenderer.invoke(IPC.sourceUpdateStatus),
    onSourceUpdate: (cb) => subscribe(IPC.sourceUpdateEvent, cb),
    applySourceUpdate: () => ipcRenderer.invoke(IPC.sourceUpdateApply)
  },

  probeAgents: () => ipcRenderer.invoke(IPC.agentsProbe),
  probeCommands: (commands) => ipcRenderer.invoke(IPC.agentsWhich, commands),

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  makeProjectFolder: (req) => ipcRenderer.invoke(IPC.makeProjectFolder, req),
  openPath: (target) => ipcRenderer.invoke(IPC.openPath, target),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  gitRemoteOrigin: (dir) => ipcRenderer.invoke(IPC.gitRemoteOrigin, dir),

  preview: {
    devCommand: (dir) => ipcRenderer.invoke(IPC.previewDevCommand, dir ?? ''),
    portOwner: (query) => ipcRenderer.invoke(IPC.previewPortOwner, query)
  },

  // File.path was removed in Electron 32; webUtils is the sanctioned way and
  // it only works from the preload.
  pathForFile: (file) => webUtils.getPathForFile(file as File),

  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    onState: (cb) => subscribe(IPC.windowState, cb),
    setTitlebar: (color, symbolColor) => ipcRenderer.send(IPC.windowTitlebar, color, symbolColor),
    restoreAndFocus: () => ipcRenderer.send(IPC.windowRestoreFocus)
  },

  /**
   * The undocked voice hub's own window. A relay, both ways — see the header of
   * electron/overlay-window.ts for why the main process sits in the middle.
   *
   * `isOverlay` is read off the URL rather than fetched over IPC because
   * src/main.tsx has to decide which tree to render *before* it can await
   * anything: the alternative is the whole app mounting for a moment inside a
   * 180×56 pill.
   */
  renderer: {
    // No invoke, no await, no guard: the one call in this bridge that has to
    // survive a renderer where nothing else does. See IPC.rendererHeartbeat.
    heartbeat: (beat) => ipcRenderer.send(IPC.rendererHeartbeat, beat)
  },

  overlay: {
    isOverlay: () => location.hash === '#overlay',

    open: (bounds) => ipcRenderer.invoke(IPC.overlayOpen, bounds),
    close: () => ipcRenderer.invoke(IPC.overlayClose),
    setBounds: (bounds) => ipcRenderer.send(IPC.overlaySetBounds, bounds),
    pushState: (snapshot) => ipcRenderer.send(IPC.overlayState, snapshot),
    pushLevel: (level) => ipcRenderer.send(IPC.overlayLevel, level),
    onCall: (cb) => subscribe(IPC.overlayCall, cb),
    onBounds: (cb) => subscribe(IPC.overlayBoundsEvent, cb),

    onState: (cb) => subscribe(IPC.overlayState, cb),
    onLevel: (cb) => subscribe(IPC.overlayLevel, cb),
    call: (message) => ipcRenderer.send(IPC.overlayCall, message)
  }
}

contextBridge.exposeInMainWorld('forge', api)

/**
 * Anything that blows up in the renderer is reported to the main process, which
 * prints it in the terminal running `npm run dev`. Without this, a React crash
 * is invisible unless DevTools happens to be open.
 */
window.addEventListener('error', (e) => {
  ipcRenderer.send(IPC.rendererError, {
    kind: 'error',
    message: e.message,
    source: `${e.filename}:${e.lineno}:${e.colno}`,
    stack: e.error instanceof Error ? e.error.stack : undefined
  })
})

window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason
  ipcRenderer.send(IPC.rendererError, {
    kind: 'unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  })
})

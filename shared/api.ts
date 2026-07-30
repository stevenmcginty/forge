import type {
  AppInfo,
  CreateSessionRequest,
  CreateSessionResult,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  Settings,
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

  pickFolder(): Promise<string | null>
  openPath(target: string): Promise<string>

  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onState(cb: (e: WindowStateEvent) => void): () => void
  }
}

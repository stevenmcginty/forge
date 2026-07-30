import type {
  AppInfo,
  CreateSessionRequest,
  CreateSessionResult,
  GeminiCallRequest,
  GeminiCallResult,
  ImportedKeyResult,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  Settings,
  StoreSnapshot,
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
   * The voice agent's outside world. Model calls live in the main process
   * because the renderer's CSP (rightly) refuses to talk to any external host —
   * and because a key is better off never reaching page script's network layer.
   */
  voice: {
    gemini(req: GeminiCallRequest): Promise<GeminiCallResult>
    /** Read Steve's own Gemini key off disk (DictationMic). Never writes. */
    importKey(): Promise<ImportedKeyResult>
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

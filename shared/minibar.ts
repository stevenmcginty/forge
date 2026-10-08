/**
 * The mini bar contract: the shapes that pass between the mini bar view
 * (#minibar window), the shot card view (#shotcard window), the main-process
 * relay (electron/minibar-window.ts, electron/shot-card-window.ts) and the host
 * (the main window's renderer, src/state/MiniBarHost.tsx).
 *
 * Spec: docs/MINI-BAR.md, sections 4 and 5.3. The host is the only writer of
 * MiniBarState; the views only render it and send MiniBarCall.
 */
import type { Shot } from './types'

export type AgentStatus = 'starting' | 'working' | 'waiting' | 'asking' | 'idle' | 'done' | 'stopped'

export interface MiniBarAgent {
  projectId: string
  tabId: string
  paneId: string
  /** The pane's display name, e.g. "Jonah". */
  name: string
  /** Agent family for the brand logo: 'claude' | 'codex' | 'gemini' | 'shell' | other profile ids. */
  brand: string
  status: AgentStatus
  /** One sentence the agent last said (Claude: the last reply; others: the last non-empty screen line). */
  line?: string
}

export type MiniBarTarget = { kind: 'pane'; paneId: string } | { kind: 'forge' }

export interface MiniBarEvent {
  id: string
  at: number
  kind: 'done' | 'asking' | 'stopped'
  projectId: string
  paneId: string
  name: string
  brand: string
  /** How long the agent worked before this event. */
  workedMs?: number
  line?: string
  /** The one-line question, for 'asking'. */
  prompt?: string
}

export interface MiniBarChoice {
  id: string
  label: string
}

export interface MiniBarPeek {
  paneId: string
  /** 'reply' = the clean last reply (Markdown) from the session JSONL; 'screen' = raw screen lines. */
  source: 'reply' | 'screen'
  text: string
  at: number
  asking?: { prompt: string; choices: MiniBarChoice[] }
}

export interface MiniBarTurn {
  who: 'you' | 'forge'
  text: string
  at: number
}

export interface MiniBarState {
  rev: number
  /** Host clock (Date.now()) at publish; the view shows "Forge is not answering" after 6 s without a publish. */
  at: number
  /** data-* attributes of the host's <html> (theme and look), applied as-is to the view's <html>. */
  look: Record<string, string>
  project: { id: string; name: string } | null
  projects: { id: string; name: string; running: number }[]
  /** Every agent pane in every project; the view filters by project. */
  agents: MiniBarAgent[]
  target: MiniBarTarget
  /** Hand-off only: the big bar's text at minimise. The view owns its box afterwards and reports it with setDraft. */
  draft: string
  dictation: { phase: 'off' | 'listening' | 'writing' | 'sending'; level?: number; sendInMs?: number }
  listen: { on: boolean; speaking: boolean; muted: boolean }
  /** Shortcuts the mini bar honours while focused; chords in the keymap's own string format. */
  keymap: { command: string; chord: string; scope: 'run' | 'restore' }[]
  /** KeyboardEvent.code values of the configured Dictate and Listen keys. */
  talkKeys: { dictate: string; listen: string }
  /** Newest first, last 30. */
  events: MiniBarEvent[]
  unseen: number
  /** Event ids whose toast is on screen now (newest first, at most 3). */
  toasts: string[]
  peek: MiniBarPeek | null
  /** Last 10 turns with Forge. */
  thread: MiniBarTurn[]
  speakUpdates: boolean
  tucked: boolean
}

export type MiniBarCall =
  | { t: 'send'; text: string }
  | { t: 'setDraft'; text: string }
  | { t: 'target'; to: MiniBarTarget }
  | { t: 'project'; id: string }
  | { t: 'reveal'; projectId: string; tabId: string; paneId: string }
  | { t: 'newAgent' }
  | { t: 'stop'; paneId: string }
  | { t: 'dictate' }
  | { t: 'undoSend' }
  | { t: 'listen' }
  | { t: 'command'; id: string }
  | { t: 'talkKey'; code: string; phase: 'down' | 'up' }
  | { t: 'otherKey' }
  | { t: 'paths'; paths: string[] }
  | { t: 'peek'; paneId: string }
  | { t: 'closePeek' }
  | { t: 'reply'; paneId: string; text: string }
  | { t: 'answer'; paneId: string; choiceId: string }
  | { t: 'seen' }
  | { t: 'dismissToast'; id: string }
  | { t: 'speakUpdates'; on: boolean }
  | { t: 'tuck'; on: boolean }

export type RemoteKey =
  | { t: 'talkKey'; code: string; phase: 'down' | 'up' }
  | { t: 'otherKey' }
  | { t: 'summon' }

export interface MiniBarQuitInfo {
  /** True when confirmOnQuit is on and agents are running. */
  confirm: boolean
  running: number
  resume: number
  lost: number
}

/** window.forge.minibar in the #minibar window. */
export interface MiniBarViewApi {
  isMiniBar(): boolean
  onState(cb: (s: MiniBarState) => void): () => void
  call(c: MiniBarCall): void
  /** Height of the content (bar + stage); width only when the user drags an end. Main keeps the bottom edge fixed. */
  resize(size: { height: number; width?: number }): void
  openMain(maximised?: boolean): Promise<void>
  quitInfo(): Promise<MiniBarQuitInfo>
  quit(opts?: { dontAskAgain?: boolean }): Promise<void>
  /** File picker parented to the mini bar window. */
  pickFiles(): Promise<string[]>
}

/** window.forge.minibarHost in the main window. */
export interface MiniBarHostApi {
  publish(s: MiniBarState): void
  onMode(cb: (m: { on: boolean }) => void): () => void
  onCall(cb: (c: MiniBarCall) => void): () => void
  onRemoteKey(cb: (k: RemoteKey) => void): () => void
}

/** window.forge.shotCard in the #shotcard window. */
export interface ShotCardApi {
  isShotCard(): boolean
  onShow(cb: (shot: Shot) => void): () => void
  /** The card has faded out; main hides the window. */
  done(): void
  /** Click on the picture: add these paths to the mini bar's box (relayed to the host as { t: 'paths' }). */
  toMiniBar(paths: string[]): void
}

/** Settings added for the mini bar (live in shared/types.ts Settings). */
export interface MiniBarSettings {
  miniBar: boolean // default true
  miniGlobalKeys: boolean // default true
  shotsOnDesktop: boolean // default true
  miniSpeakUpdates: boolean // default true
  miniChime: boolean // default true
  miniBarBounds?: Record<string, { x: number; y: number; width: number }> // key = display id
  miniBarTucked?: boolean
}

/**
 * Forge Brain: the facts about the app-level agent that every surface has to
 * agree on.
 *
 * Forge Brain is one CLI agent for the whole app, off until Steve turns it on.
 * It runs in a pane of its own inside a hidden project (`kind: 'brain'` on
 * `Project`), in a Forge-owned home folder under the data dir, with Forge's
 * tools as an MCP server (bridge/brain-mcp.mjs over the brain link). It sees
 * every project, delegates real work to agent panes, and is told when a pane it
 * opened finishes or when any pane needs Steve.
 *
 * Three surfaces draw this — the desktop, Forge Web's phone face and the deck —
 * so the shapes live here. Plain JSON only, like shared/foreman.ts: these
 * objects cross IPC and the WebSocket unchanged.
 *
 * The main-process half is electron/brain/.
 */

import type { BrainEngine } from './types'

/** Defined in shared/types.ts (which stays import-free, and `Settings.brainEngine` needs it). */
export type { BrainEngine }

export const BRAIN_ENGINES: readonly BrainEngine[] = ['claude', 'codex', 'gemini', 'local']

export function isBrainEngine(value: unknown): value is BrainEngine {
  return value === 'claude' || value === 'codex' || value === 'gemini' || value === 'local'
}

/** The engine's name, in words. */
export const BRAIN_ENGINE_NAME: Record<BrainEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  local: 'Local model (Ollama)'
}

/** The hidden project's id. Fixed, so every surface can recognise it without a lookup. */
export const BRAIN_PROJECT_ID = 'forge-brain'

/** The hidden project's name, and the brain pane's title. */
export const BRAIN_PROJECT_NAME = 'Forge Brain'

/**
 * Is this the brain's hidden project? Every project list, order and picker
 * leaves it out. Takes `unknown` so a generic list helper can ask it.
 */
export function isBrainProject(project: unknown): boolean {
  if (!project || typeof project !== 'object') return false
  const p = project as { kind?: unknown; id?: unknown }
  return p.kind === 'brain' || p.id === BRAIN_PROJECT_ID
}

/**
 * Where the brain is.
 *
 *  - `off` — not enabled, or enabled but stopped.
 *  - `starting` — the pane is up; the CLI has not shown its prompt yet.
 *  - `idle` — ready for a message.
 *  - `busy` — working on a turn (its screen is moving).
 *  - `asking` — its screen is showing a question (a permission or trust prompt).
 *    Nothing Forge queued is typed while it is.
 *  - `error` — it could not start, or its process ended. `error` says why.
 */
export type BrainState = 'off' | 'starting' | 'idle' | 'busy' | 'asking' | 'error'

/** How dangerous a tool call the brain wants to make is. B2 decides; the UI words it. */
export type BrainRisk = 'low' | 'medium' | 'high'

/**
 * The brain wants to do something that needs Steve's yes first. Emitted by
 * main; carried in `BrainStatus.confirms` until answered or timed out.
 */
export interface BrainConfirmRequest {
  /** Unique; the answer names it. */
  id: string
  /** The Forge tool name, e.g. `run_app_action`. */
  tool: string
  /** A few plain words: what it will do ("close the tab Zeb"). */
  summary: string
  risk: BrainRisk
  /** `Date.now()` when it was asked. */
  at: number
}

/** Steve's answer to one `BrainConfirmRequest`. */
export interface BrainConfirmAnswer {
  id: string
  allow: boolean
}

/** The whole picture of the brain, pushed whenever any of it moves. */
export interface BrainStatus {
  enabled: boolean
  engine: BrainEngine
  state: BrainState
  /** The brain pane's PTY session id — the same id the terminal and chat views use. Null while off. */
  paneId: string | null
  /** Always `BRAIN_PROJECT_ID`. */
  projectId: string
  /**
   * The Claude session uuid the pane runs under (claude engine only), which
   * names its transcript. Null for the other engines, which keep none Forge reads.
   */
  sessionId: string | null
  /** Messages and notes waiting for the brain to be free. */
  queued: number
  /** Why `state` is `error`, or why the chosen engine cannot run. Null otherwise. */
  error: string | null
  /** Engines that cannot run on this PC, with the reason in words. Absent = can run. */
  unavailable: Partial<Record<BrainEngine, string>>
  /** Tool calls waiting for Steve's yes, oldest first. */
  confirms: BrainConfirmRequest[]
}

/** The answer to `send`. `queued` = the brain was busy; it is typed when it is free. */
export type BrainSendResult = { ok: true; queued: boolean } | { ok: false; error: string }

/** Forge Brain's own voice, until Steve picks another (`Settings.brainVoice`): Edge's calm British male. */
export const BRAIN_VOICE_DEFAULT = 'en-GB-RyanNeural'

/**
 * Where the brain's voice goes when its own will not answer: other British
 * neural voices, then silence — never the built-in SAPI voice (src/lib/tts.ts
 * `neuralOnly`).
 */
export const BRAIN_VOICE_FALLBACKS: readonly string[] = ['en-GB-ThomasNeural', 'en-GB-SoniaNeural']

/** Longest message `send` takes. Longer is refused, not cut. */
export const BRAIN_SEND_MAX = 4000

/**
 * The answer to `ask`: the brain's reply to that one message, or why there is
 * none. `late` = it took the message and is still working past the wait; it
 * reports back by itself (`say_to_voice_agent`).
 */
export type BrainAskResult = { ok: true; text: string } | { ok: false; error: string; late?: boolean }

/** How long `ask` waits for the brain's reply by default. */
export const BRAIN_ASK_WAIT_MS = 60_000

/**
 * A browser's wait, at most: its requests die at 30 s, and a browser voice
 * agent's tool call at 25 s (electron/web-host.ts VOICE_TOOL_MS).
 */
export const BRAIN_ASK_WAIT_WEB_MS = 20_000

/** The longest wait `ask` takes, so a stuck caller cannot hold one open for ever. */
export const BRAIN_ASK_WAIT_MAX_MS = 5 * 60_000

/**
 * The brain speaking through the voice agents: a line for whichever voice agent
 * is live to say aloud (`speak: true`) or to take as context (`speak: false`).
 * Emitted by main (electron/brain/host.ts `brainSays`); the desktop renderer
 * hears it on `onSays`, Forge Web as a `brain-says` frame. What a voice agent
 * does with it is the voice side's business.
 */
export interface BrainSaysEvent {
  id: string
  text: string
  speak: boolean
  /** `Date.now()` when it was said. */
  at: number
}

/**
 * IPC channel names. Spread into `IPC` in shared/ipc.ts.
 *
 *   renderer --status/enable/disable/set-engine/send/confirm-->  main (invoke)
 *   renderer --transcript-watch/transcript-stop------------->   main (invoke)
 *   main     --state (BrainStatus)-------------------------->   renderer (push)
 *   main     --transcript (ChatUpdate)---------------------->   renderer (push)
 */
export const BRAIN_IPC = {
  /** R→M invoke. Returns BrainStatus. */
  status: 'brain:status',
  /** R→M invoke. Turns the brain on (settings.brainEnabled = true) and starts it. Returns BrainStatus. */
  enable: 'brain:enable',
  /** R→M invoke. Turns it off and stops the pane. Returns BrainStatus. */
  disable: 'brain:disable',
  /** R→M invoke, (engine: BrainEngine). Saves settings.brainEngine; restarts a running brain. Returns BrainStatus. */
  setEngine: 'brain:set-engine',
  /** R→M invoke, (text: string). Types a message into the brain. Returns BrainSendResult. */
  send: 'brain:send',
  /** R→M invoke, (answer: BrainConfirmAnswer). True when that request was waiting. */
  confirm: 'brain:confirm',
  /** M→R push. One BrainStatus. */
  state: 'brain:state',
  /**
   * R→M invoke. Start pushing the brain pane's conversation on `transcript`.
   * True when there is one to read (claude engine, first message sent). Every
   * call re-seeds with a `reset` update; call again when `paneId` or `sessionId` changes.
   */
  transcriptWatch: 'brain:transcript-watch',
  /** R→M invoke. Stop pushing it. */
  transcriptStop: 'brain:transcript-stop',
  /** M→R push. One ChatUpdate (shared/chat.ts) for the brain pane. */
  transcript: 'brain:transcript',
  /** M→R push. One BrainSaysEvent: a line for the live voice agent. */
  says: 'brain:says',
  /**
   * R→M invoke, (text: string, timeoutMs?: number). Sends a message and waits
   * for the brain's reply to it. Returns BrainAskResult.
   */
  ask: 'brain:ask'
} as const

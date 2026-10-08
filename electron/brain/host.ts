import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  BRAIN_ASK_WAIT_MAX_MS,
  BRAIN_ASK_WAIT_MS,
  BRAIN_ENGINE_NAME,
  BRAIN_PROJECT_ID,
  BRAIN_PROJECT_NAME,
  BRAIN_SEND_MAX,
  type BrainAskResult,
  type BrainConfirmRequest,
  type BrainEngine,
  type BrainFreshStartResult,
  type BrainRisk,
  type BrainSaysEvent,
  type BrainSendResult,
  type BrainState,
  type BrainStatus,
  sanitiseBrainModel
} from '@shared/brain'
import type { ChatUpdate } from '@shared/chat'
import type { PaneLeaf, Workspace } from '@shared/types'
import { makeId } from '@shared/ids'
import { newSessionId } from '@shared/session'
import { stripAnsi } from '@shared/ansi'
import { onAttention, type AttentionEvent } from '../attention-bus'
import { addPtySink, createPaneSession, getManager, killPane, liveSessions } from '../pty-host'
import { getBrainProject, getDataDir, getProjects, getSettings, getWorkspace, setBrainProject, setWorkspace } from '../store'
import { resolveBridgeScript } from '../bridge/mcp-config'
import { tomlLiteralSafe } from '../bridge/cli-register'
import { claudeHome, transcriptPath } from '../bridge/claude-transcripts'
import { nudgeTranscript, stopTranscript, watchTranscript } from '../web/transcript-watcher'
import { findWindowsLaunchable } from '../cli-launch'
import { whichCommand } from '../which'
import type { BrowserLink } from '../browser-panes/link'
import { createBrainLink, type LinkToolHost } from '../voice-agent/brain-link'
import { brainToolHost } from '../voice-agent/ipc'
import {
  askingIsNoise,
  askingNote,
  claudeMcpConfig,
  isQuietReply,
  prepareBrainHome,
  statusLineFrom,
  stopIsNews,
  stopNote,
  BRAIN_MCP_SERVER,
  STOP_SETTLE_MS,
  type BrainMcpServer
} from './home'
import { claudeBrainCommand, setBrainLaunch, type BrainLaunch } from './launch'
import { paneTranscript, paneWords, readTail, type PanePlace } from '../pane-reply'

/**
 * Forge Brain, the main-process half: one CLI agent for the whole app, in a
 * pane of its own that main starts, watches and types into.
 *
 * ## Where it lives
 *
 * A hidden project (`kind: 'brain'`, id BRAIN_PROJECT_ID) whose folder is the
 * brain's home, `<data dir>\brain\home` (./home.ts), with one tab and one pane.
 * The project and its layout are saved like any other — which is exactly what
 * lets Forge Web's chat view (transcript) and terminal view reach the pane by
 * its id — but electron/store.ts's `getProjects` leaves it out, so no list ever
 * draws it. The renderer never mounts it; main spawns its PTY here through the
 * PTY host's own `createPaneSession`, and electron/brain/launch.ts makes sure
 * anything that later attaches to the pane id launches the brain, not a guess.
 *
 * ## Its tools
 *
 * bridge/brain-mcp.mjs, the same relay the CLI voice brains use, over a brain
 * link of its own (`<data dir>\brain\pane-link`). The link answers from the
 * desk's tool definitions (electron/voice-agent/host.ts `forgeToolDefs`), so the
 * brain has every Forge tool with the same guards; having its own link means
 * every call passes through `toolHost` below first — where the panes it opens
 * are noted, and where a confirm gate belongs (`requestConfirm`).
 *
 * ## What it starts with
 *
 * Claude starts slim (./launch.ts `claudeBrainCommand`): a pinned model
 * (`Settings.brainModel`) at low effort, the home's own settings and no others,
 * and only the MCP servers Forge names — not Steve's user config, which it
 * used to load whole, on whatever model his default was.
 *
 * ## Knowing when it can be typed into
 *
 * There is no API into a TUI, only its screen — and, for Claude, its
 * transcript. So: `starting` until the CLI's own prompt has been seen (never
 * type into the PowerShell underneath — it would run the text), `asking` while
 * it shows a numbered choice (a permission or trust prompt), `busy` while a
 * message is going in or a turn is open, `idle` otherwise. For Claude a turn is
 * the transcript's: open at the prompt record, closed at `turn_duration`; the
 * other engines only have the screen moving. A message goes in in steps, each
 * checked: the text, until it shows on screen (a CLI still starting drops
 * keys); Enter; and for Claude, its prompt in the transcript. Messages and
 * notes queue while it is not idle; notes that arrive together go in as one
 * line. The home folder's trust prompt is answered by Forge, because Forge owns
 * the folder; nothing else on the brain's screen ever is.
 *
 * ## Notes, and who hears the answer
 *
 * A "[Forge]" note is pane news: a pane asking for Steve, or a pane the brain
 * opened that has stopped — told only once it has stayed stopped for
 * `STOP_SETTLE_MS`, because a turn ending is not a job ending, and with the
 * pane's last words so the brain rarely has to go and read it. Nobody asked for
 * a note, so nobody is waiting for the reply: Forge reads Claude's reply to it
 * from the transcript when the turn ends and says it through the voice agents
 * (`brainSays`), unless the brain answered `[quiet]` or spoke for itself.
 */

/** No output for this long = the screen has settled. The TUIs animate a spinner while they work. */
const QUIET_MS = 1500
/** Typed text must show on screen within this long, or it was dropped (a CLI still starting) and is typed again. */
const ECHO_MS = 3000
/** Claude: after Enter, the prompt must reach the transcript within this long, or Enter is pressed again. */
const SUBMIT_MS = 5000
/** Tries at each step of a send before the message is given up on. */
const SEND_TRIES = 3
/**
 * Claude's turn closes on the transcript's `turn_duration` record. Backstops,
 * for a turn whose end was never written: its reply recorded (`end_turn`) and
 * the screen still this long; or, with no end recorded at all, the screen still
 * this much longer. Long, because a model thinking hard can leave the screen
 * still for many seconds mid-turn.
 */
const TURN_END_QUIET_MS = 5000
const TURN_STALE_MS = 180_000
/** The trust dialog is answered once its screen has been still this long, one key at a time this far apart. */
const DIALOG_SETTLE_MS = 800
const DIALOG_KEY_GAP_MS = 1500
/** Never type into a pane younger than this, whatever its screen says. */
const MIN_BOOT_MS = 2500
/** A start slower than this is told as slow in `error` (the brain keeps waiting for its prompt). */
const READY_TIMEOUT_MS = 120_000
/** Notes that arrive within this long of each other go in as one line. */
const NOTE_SETTLE_MS = 1200
/** Once noted, the same pane and state is not noted again for this long. */
const NOTE_REPEAT_MS = 20_000
/** A pane that spawns this soon after the brain asked for one is the brain's. */
const OPEN_WINDOW_MS = 15_000
/** How long a confirm request waits for Steve before it counts as a no. */
const CONFIRM_TIMEOUT_MS = 120_000
const TICK_MS = 400
const TAIL_MAX = 6000
const LOOKUP_TTL_MS = 60_000

/** The CLI is up and showing its own prompt. Tested against everything since the spawn. */
const READY_RE: Record<BrainEngine, RegExp> = {
  claude: /\? for shortcuts|Claude Code v?\d|Welcome to Claude/i,
  codex: /OpenAI Codex|context left|send a message/i,
  local: /OpenAI Codex|context left|send a message/i,
  gemini: /Type your message|Tips for getting started|GEMINI\.md/i
}
/**
 * A choice on screen: a permission, approval or trust prompt. A numbered option
 * under the cursor, or a dialog's own footer — never a bare "❯ yes", which is
 * also how Claude draws its suggested next prompt, nor "● No", which is how an
 * answer that starts with "No" is drawn.
 */
const ASK_RE = /(?:❯|›)[ \t]*\d\.[ \t]*(?:Yes|No|Allow|Trust)\b|Enter to confirm|Esc to cancel|Waiting for user confirmation/i
/**
 * The home folder's trust prompt, which Forge answers because Forge owns the
 * folder. Claude Code 2.1.285 words it "Quick safety check: Is this a project
 * you created or one you trust?", and because the home's .claude/settings.json
 * pre-approves the Forge tools, its default is "No, continue without these
 * permissions" — so the answer is chosen from the cursor line, never assumed.
 */
const TRUST_RE = /Quick safety check|Do you trust|trust this folder|trust the files in this folder|trust the contents of this directory|not version controlled/i
/** PowerShell's prompt as the last thing on screen: the CLI is not running any more. */
const SHELL_PROMPT_RE = /(?:^|\n)PS [A-Za-z]:\\[^\r\n>]*> ?$/

interface Running {
  engine: BrainEngine
  /** Claude: the model on its command line. Null for the other engines. */
  model: string | null
  paneId: string
  sessionId: string | null
  startedAt: number
  /** Everything printed since the spawn, stripped and capped — for the ready test. */
  boot: string
  ready: boolean
  /** What printed since the last quiet gap, stripped and capped. */
  burst: string
  lastOutputAt: number
  /** The trust dialog is on screen: seen, and the CLI's own prompt not seen since. */
  dialog: boolean
  /** Output since the dialog appeared — its cursor line is read from here. */
  dialogText: string
  dialogKeyAt: number
  dialogKeys: number
  /** A message on its way in: typed (waiting for its echo), then entered (waiting for the turn). */
  sending: Sending | null
  /** Output since the last key Forge pressed, stripped — for the echo check. */
  sinceWrite: string
  /** Why the last message did not go in, until the next one does. */
  notice: string | null
  /** Claude: a turn is open in the transcript — a prompt, and no end recorded yet. */
  turnOpen: boolean
  /** Claude: the open turn's reply has been recorded (`stop_reason: end_turn`). */
  turnReplied: boolean
  /** Claude: prompts the transcript has recorded since this start. */
  prompts: number
  transcriptOffset: number
  transcriptCarry: Buffer
  exited: boolean
}

interface Sending {
  text: string
  stage: 'typed' | 'entered'
  at: number
  tries: number
  /** `Running.prompts` when it was typed: one more means Claude took it. */
  prompts: number
}

/** `taken` (askBrain) is told the moment its message starts going in. */
type QueueItem = { kind: 'user' | 'note'; text: string; taken?: (r: Running) => void }

interface PendingConfirm {
  request: BrainConfirmRequest
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** Claude: the note that is in, from the moment it is typed until its turn is over. */
interface NoteTurn {
  r: Running
  /** `Running.prompts` and the transcript's size when it was typed: where its reply starts. */
  prompts: number
  offset: number
  /** The brain spoke for itself during the turn (say_to_voice_agent). */
  said: boolean
}

/**
 * One pane's work, from the renderer's busy light (`notePaneBusy`). A run that
 * picks up again within `STOP_SETTLE_MS` of stopping is the same run.
 */
interface PaneRun {
  startedAt: number
  endedAt: number
  busy: boolean
}

let running: Running | null = null
let state: BrainState = 'off'
let lastError: string | null = null
const queue: QueueItem[] = []
let lastNoteAt = 0
const noted = new Map<string, number>()
let noteTurn: NoteTurn | null = null
/** Panes the brain opened: their stopping is news to it. */
const opened = new Set<string>()
const runs = new Map<string, PaneRun>()
/** Stops waiting out `STOP_SETTLE_MS`, by pane. */
const stops = new Map<string, ReturnType<typeof setTimeout>>()
let openWindowUntil = 0
const confirms = new Map<string, PendingConfirm>()
const listeners = new Set<(status: BrainStatus) => void>()
let lastEmitted = ''
let tickTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeSink: (() => void) | null = null
let unsubscribeAttention: (() => void) | null = null
let link: BrowserLink | null = null
let linkReady: Promise<string> | null = null
let reconciling: Promise<void> = Promise.resolve()
let transcriptSink: ((update: ChatUpdate) => void) | null = null
let transcriptArmedFor: string | null = null
let unavailableCache: { at: number; value: Partial<Record<BrainEngine, string>> } | null = null

/* ------------------------------------------------------------------ paths */

/** Forge's docs folder beside the app's code (a checkout; a packaged build has none). */
function forgeDocsDir(): string | null {
  const dir = join(app.getAppPath(), 'docs')
  return existsSync(dir) ? dir : null
}

function brainDir(): string {
  return join(getDataDir(), 'brain')
}

/** The brain's home: its CLI's cwd, and the hidden project's path. */
export function brainHomeDir(): string {
  return join(brainDir(), 'home')
}

/* ------------------------------------------------------------ availability */

/** Engines that cannot run on this PC, and why, in words. Cached for a minute. */
export function unavailableEngines(): Partial<Record<BrainEngine, string>> {
  const now = Date.now()
  if (unavailableCache && now - unavailableCache.at < LOOKUP_TTL_MS) return unavailableCache.value
  const out: Partial<Record<BrainEngine, string>> = {}
  if (!whichCommand('claude')) out.claude = 'Claude Code is not installed on this PC (npm install -g @anthropic-ai/claude-code).'
  const codex = whichCommand('codex')
  if (!codex) out.codex = 'The Codex CLI is not installed on this PC (npm install -g @openai/codex).'
  if (!whichCommand('gemini')) out.gemini = 'The Gemini CLI is not installed on this PC (npm install -g @google/gemini-cli).'
  // `codex --oss --local-provider ollama` is the local road (checked against
  // codex-cli 0.157.1's --help). No Codex, no road; no Ollama, nothing to serve it.
  if (!codex) out.local = 'A local model runs through the Codex CLI (codex --oss), and Codex is not installed.'
  else if (!whichCommand('ollama')) {
    out.local = 'Ollama is not installed on this PC. Install it from ollama.com and pull a model (codex --oss uses gpt-oss:20b), then pick Local again.'
  }
  unavailableCache = { at: now, value: out }
  return out
}

/* ---------------------------------------------------------------- status */

/**
 * The panes the brain opened, for the mini bar's announcer: it leaves their
 * news to the brain rather than saying it twice. Empty while the brain is off.
 */
export function brainOpenedPanes(): string[] {
  return state === 'off' ? [] : [...opened]
}

export function brainStatus(): BrainStatus {
  const settings = getSettings()
  return {
    enabled: settings.brainEnabled,
    engine: settings.brainEngine,
    state,
    paneId: running?.paneId ?? null,
    projectId: BRAIN_PROJECT_ID,
    sessionId: running?.sessionId ?? null,
    queued: queue.length,
    error: lastError,
    unavailable: unavailableEngines(),
    confirms: [...confirms.values()].map((c) => c.request)
  }
}

/** Every status change. Returns the unsubscribe. */
export function onBrainStatus(listener: (status: BrainStatus) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  const status = brainStatus()
  const key = JSON.stringify(status)
  if (key === lastEmitted) return
  lastEmitted = key
  for (const listener of listeners) {
    try {
      listener(status)
    } catch (err) {
      console.error('[brain] status listener failed:', err)
    }
  }
}

function setState(next: BrainState, error: string | null = null): void {
  state = next
  lastError = error
  emit()
}

/* -------------------------------------------------------------- the link */

/**
 * The voice agents' way in to the brain (electron/voice-agent/host.ts). The
 * brain is not offered them: asking itself would wait on its own turn.
 */
const NOT_FOR_THE_BRAIN = new Set(['ask_brain', 'tell_brain'])

/**
 * The brain pane's tools: the desk host's, with every call seen first. Opening
 * a pane marks the next few seconds' spawns as the brain's, and the pane id in
 * the answer (appactions.ts says "pane id <id>") marks that one for certain.
 */
const toolHost: LinkToolHost = {
  listLinkTools: () => {
    const tools = brainToolHost().listLinkTools()
    return Array.isArray(tools) ? tools.filter((t: { name?: unknown }) => !NOT_FOR_THE_BRAIN.has(String(t?.name))) : tools
  },
  callLinkTool: async (name, args) => {
    if (NOT_FOR_THE_BRAIN.has(name)) {
      return { content: [{ type: 'text', text: `${name} is the voice agents' way to reach you; you are Forge Brain.` }], isError: true }
    }
    if (opensPane(name, args)) openWindowUntil = Date.now() + OPEN_WINDOW_MS
    // It spoke for itself in a note's turn: Forge does not say its reply as well.
    if (name === 'say_to_voice_agent' && noteTurn) noteTurn.said = true
    const result = (await brainToolHost().callLinkTool(name, args)) as CallToolResult
    for (const block of result?.content ?? []) {
      if (block.type !== 'text') continue
      for (const m of block.text.matchAll(/pane id ([A-Za-z0-9_-]+)/g)) opened.add(m[1]!)
    }
    return result
  }
}

function opensPane(name: string, args: unknown): boolean {
  if (name === 'open_agent_pane') return true
  if (name !== 'run_app_action') return false
  const kind = (args as { action?: { kind?: unknown } } | null)?.action?.kind
  return kind === 'open_tabs' || kind === 'open_panes'
}

async function ensureLink(): Promise<string> {
  link ??= createBrainLink(join(brainDir(), 'pane-link'), () => toolHost)
  linkReady ??= link.listen()
  try {
    await linkReady
  } catch (err) {
    linkReady = null
    throw err
  }
  return link.linkFile
}

/* ---------------------------------------------------------------- launch */

/** A `-c` fragment giving Codex the brain's server, or null when a path cannot be quoted safely. */
function codexFragment(server: BrainMcpServer): string | null {
  if (![server.node, server.script, server.linkFile].every(tomlLiteralSafe)) return null
  return (
    `-c "mcp_servers.${BRAIN_MCP_SERVER}={command='${server.node}',args=['${server.script}'],` +
    `env={FORGE_BRAIN_LINK_FILE='${server.linkFile}'},default_tools_approval_mode='approve',tool_timeout_sec=120}"`
  )
}

function buildLaunch(engine: BrainEngine, leaf: PaneLeaf, server: BrainMcpServer, model: string | null): BrainLaunch | string {
  const base = {
    paneId: leaf.id,
    cwd: brainHomeDir(),
    projectName: BRAIN_PROJECT_NAME,
    paneTitle: BRAIN_PROJECT_NAME,
    claudeMcpConfig: '',
    env: {} as Record<string, string>
  }
  if (engine === 'claude') {
    const config = join(brainDir(), 'mcp.json')
    writeFileSync(config, `${JSON.stringify(claudeMcpConfig(server), null, 2)}\n`, 'utf8')
    return { ...base, command: claudeBrainCommand(model ?? ''), ...(leaf.sessionId ? { sessionId: leaf.sessionId } : {}), claudeMcpConfig: config }
  }
  if (engine === 'gemini') {
    // The home's .gemini/settings.json is a workspace setting, read only in a
    // trusted folder; Forge owns this one.
    return { ...base, command: 'gemini', env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } }
  }
  const fragment = codexFragment(server)
  if (!fragment) return 'Forge is installed under a folder whose name Codex cannot be given (a quote or a $ in it).'
  // Read-only, never asking: the brain has no hands of its own, only Forge's tools.
  const oss = engine === 'local' ? ' --oss --local-provider ollama' : ''
  return { ...base, command: `codex${oss} -s read-only -a never ${fragment}` }
}

/** The leaf's profile, for the layout. `local` runs Codex. */
function profileFor(engine: BrainEngine): string {
  return engine === 'local' ? 'codex' : engine
}

/**
 * The brain's one pane, from its saved layout when it was running this engine
 * (so Claude resumes its conversation), else a new one saved in its place.
 * `fresh` always makes a new one: a new pane id and a new conversation.
 * `repane` keeps the saved conversation under a new pane id, for restarting a
 * pane that is still running: the PTY host reports the killed process's exit
 * by pane id, after the new session exists, and would take the new one down
 * with it.
 */
function ensureLeaf(engine: BrainEngine, fresh = false, repane = false): PaneLeaf {
  const title = BRAIN_ENGINE_NAME[engine]
  const saved = getWorkspace(BRAIN_PROJECT_ID)?.tabs[0]?.root
  const kept = !fresh && saved?.type === 'leaf' && saved.profileId === profileFor(engine) && saved.title === title && saved.sessionId ? saved : null
  if (kept && !repane) return kept
  const leaf: PaneLeaf = { type: 'leaf', id: makeId('pane'), profileId: profileFor(engine), title, sessionId: kept?.sessionId ?? newSessionId() }
  const tabId = makeId('tab')
  const workspace: Workspace = {
    tabs: [{ id: tabId, title: BRAIN_PROJECT_NAME, root: leaf, activePaneId: leaf.id }],
    activeTabId: tabId,
    viewMode: 'tabs'
  }
  setWorkspace(BRAIN_PROJECT_ID, workspace)
  return leaf
}

function ensureProject(): void {
  const home = brainHomeDir()
  const existing = getBrainProject()
  if (existing && existing.path === home && existing.kind === 'brain') return
  setBrainProject({
    id: BRAIN_PROJECT_ID,
    name: BRAIN_PROJECT_NAME,
    path: home,
    color: '#9b8cff',
    defaultProfileId: 'claude',
    createdAt: existing?.createdAt ?? Date.now(),
    kind: 'brain'
  })
}

function nodePath(): string {
  return (process.platform === 'win32' ? findWindowsLaunchable('node') : whichCommand('node')) ?? 'node'
}

/**
 * Start the brain's pane. `fresh` (a fresh start, `freshStartBrain`) starts a
 * new conversation in a new pane and keeps the panes it opened before: their
 * report-back is main's to remember, not the conversation's. `resumed` (a
 * model switch on a running brain) keeps them too, and keeps the conversation:
 * the same session, in a new pane (`ensureLeaf`).
 */
async function start(engine: BrainEngine, fresh = false, resumed = false): Promise<void> {
  const why = unavailableEngines()[engine]
  if (why) {
    setState('error', why)
    return
  }
  const script = resolveBridgeScript('brain-mcp.mjs')
  if (!script) {
    setState('error', 'Forge could not find bridge/brain-mcp.mjs, so the brain would have no tools.')
    return
  }
  let linkFile: string
  try {
    linkFile = await ensureLink()
  } catch (err) {
    setState('error', `The brain's link to Forge did not start: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const server: BrainMcpServer = { node: nodePath(), script, linkFile }
  mkdirSync(brainHomeDir(), { recursive: true })
  // The slim launch leaves Steve's user settings out, and his status line
  // command with them — which is what the context ring is drawn from.
  prepareBrainHome(brainHomeDir(), server, forgeDocsDir(), statusLineFrom(join(claudeHome(), 'settings.json')))
  ensureProject()
  const leaf = ensureLeaf(engine, fresh, resumed)
  const model =engine === 'claude' ? sanitiseBrainModel(getSettings().brainModel) : null
  const launch = buildLaunch(engine, leaf, server, model)
  if (typeof launch === 'string') {
    setState('error', launch)
    return
  }
  setBrainLaunch(launch)
  const now = Date.now()
  running = {
    engine,
    model,
    paneId: leaf.id,
    sessionId: engine === 'claude' ? leaf.sessionId ?? null : null,
    startedAt: now,
    boot: '',
    ready: false,
    burst: '',
    lastOutputAt: now,
    dialog: false,
    dialogText: '',
    dialogKeyAt: 0,
    dialogKeys: 0,
    sending: null,
    sinceWrite: '',
    notice: null,
    turnOpen: false,
    turnReplied: false,
    prompts: 0,
    // A resumed conversation's history is not news: only what is written from now on is read.
    transcriptOffset: transcriptSize(engine === 'claude' ? leaf.sessionId ?? null : null),
    transcriptCarry: Buffer.alloc(0),
    exited: false
  }
  if (!fresh && !resumed) opened.clear()
  setState('starting')
  const result = createPaneSession({ id: leaf.id, cwd: launch.cwd, cols: 120, rows: 40, bootstrapCommand: launch.command })
  if (!result.ok) {
    stop()
    setState('error', `The brain pane did not start: ${result.error}`)
    return
  }
  tickTimer ??= setInterval(tick, TICK_MS)
}

function stop(): void {
  const r = running
  running = null
  noteTurn = null
  setBrainLaunch(null)
  if (r) {
    if (transcriptSink && transcriptArmedFor === r.paneId) stopTranscript(r.paneId, transcriptSink)
    transcriptArmedFor = null
    killPane(r.paneId)
  }
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

/**
 * Bring the brain in line with settings: on or off, on the chosen engine, and
 * (Claude) on the chosen model. Serialised, so a double click cannot start two
 * panes. Also the way back from `error`: applying again restarts it.
 */
export function applyBrainSettings(): Promise<BrainStatus> {
  reconciling = reconciling
    .then(async () => {
      const settings = getSettings()
      if (!settings.brainEnabled) {
        stop()
        queue.length = 0
        forgetStops()
        for (const id of [...confirms.keys()]) answerConfirm({ id, allow: false })
        setState('off')
        return
      }
      const r = running
      const sameEngine = !!r && r.engine === settings.brainEngine
      const sameModel = !r || r.engine !== 'claude' || r.model === sanitiseBrainModel(settings.brainModel)
      if (sameEngine && sameModel && state !== 'error') return
      // A model switch alone resumes the same conversation, so the panes it
      // opened are still its own.
      const resumed = sameEngine && !sameModel && state !== 'error'
      stop()
      await start(settings.brainEngine, false, resumed)
    })
    .catch((err) => {
      console.error('[brain] could not apply the settings:', err)
      setState('error', `Forge Brain could not start: ${err instanceof Error ? err.message : String(err)}`)
    })
  return reconciling.then(() => brainStatus())
}

/* ------------------------------------------------------ watching the pane */

function appendCapped(text: string, more: string): string {
  const next = text + more
  return next.length > TAIL_MAX ? next.slice(next.length - TAIL_MAX) : next
}

/**
 * Terminal output as words. The TUIs move the cursor rather than print spaces
 * and newlines, so those moves become spaces and newlines first — otherwise
 * "Yes, I trust this folder" arrives as "Yes,Itrustthisfolder". A carriage
 * return becomes a line break too: `stripAnsi` applies it as an overwrite, and
 * a TUI that ends a line with `\r` and a cursor move would otherwise have the
 * words it just drew — a typed message's echo among them — thrown away.
 */
function screenText(data: string): string {
  return stripAnsi(
    data
      .replace(/\r/g, '\n')
      .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
      // Claude Code places each word with a column jump (CSI n G).
      .replace(/\x1b\[\d*G/g, ' ')
      .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, '\n')
      .replace(/\x1b\[\d*[BE]/g, '\n')
  )
}

/**
 * One key at the home folder's trust dialog, once its screen is still: down
 * when the cursor is on a "No", Enter when it is on anything else. Then the
 * next tick looks again — so a key the dialog was not ready for is simply
 * pressed again, and Enter is only ever pressed with the cursor seen on "Yes".
 */
function pressTrustKey(r: Running, now: number): void {
  if (now - r.dialogKeyAt < DIALOG_KEY_GAP_MS || r.dialogKeys >= 10) return
  const cursor = [...r.dialogText.matchAll(/(?:❯|›|●)([^\n]*)/g)].pop()?.[1] ?? ''
  r.dialogKeyAt = now
  r.dialogKeys += 1
  getManager().write(r.paneId, /\bNo\b/i.test(cursor) ? '\x1b[B' : '\r')
}

function onPaneData(id: string, data: string): void {
  const r = running
  if (!r || id !== r.paneId) return
  const now = Date.now()
  const text = screenText(data)
  if (now - r.lastOutputAt >= QUIET_MS) r.burst = ''
  r.burst = appendCapped(r.burst, text)
  r.sinceWrite = appendCapped(r.sinceWrite, text)
  r.lastOutputAt = now
  nudgeTranscript(id)
  if (r.ready) return
  r.boot = appendCapped(r.boot, text)
  // The home folder's trust prompt, which Forge answers (Forge owns the
  // folder) from `tick`, key by key.
  if (r.dialog) r.dialogText = appendCapped(r.dialogText, text)
  else if (TRUST_RE.test(r.burst)) {
    r.dialog = true
    // From the question on: a header drawn above it is not the prompt after it.
    r.dialogText = r.burst.slice(Math.max(0, r.burst.search(TRUST_RE)))
  }
}

function onPaneExit(id: string): void {
  const r = running
  if (r && id === r.paneId) {
    r.exited = true
    setState('error', 'The brain pane closed. Turn Forge Brain off and on again to restart it.')
    return
  }
  opened.delete(id)
  runs.delete(id)
  const pending = stops.get(id)
  if (pending) clearTimeout(pending)
  stops.delete(id)
}

function onPaneSpawn(id: string): void {
  const r = running
  if (r && id !== r.paneId && Date.now() < openWindowUntil) opened.add(id)
}

function tick(): void {
  const r = running
  if (!r || r.exited) return
  const now = Date.now()
  // The conversation file appears with the first turn, whatever the screen says.
  armTranscript()
  readTranscript(r)
  const quietFor = now - r.lastOutputAt
  if (!r.ready) {
    // The trust dialog is gone once the CLI's own prompt shows after it.
    if (r.dialog && READY_RE[r.engine].test(r.dialogText)) r.dialog = false
    if (r.dialog) {
      if (quietFor >= DIALOG_SETTLE_MS) pressTrustKey(r, now)
    } else if (now - r.startedAt >= MIN_BOOT_MS && quietFor >= QUIET_MS && READY_RE[r.engine].test(r.boot)) {
      r.ready = true
      r.boot = ''
      r.dialogText = ''
    }
    if (!r.ready) {
      // Slow is not dead: a loaded PC can take minutes to bring a shell and a
      // CLI up, and the prompt arriving late still makes the brain idle. The
      // wait only earns a sentence, and messages queue meanwhile.
      const slow = now - r.startedAt > READY_TIMEOUT_MS
        ? `${BRAIN_ENGINE_NAME[r.engine]} is taking a long time to start in the brain pane. Open its CLI view to see why.`
        : null
      if (state !== 'starting' || lastError !== slow) setState('starting', slow)
      return
    }
  }
  if (r.sending) {
    advanceSend(r, now)
    if (r.sending) {
      if (state !== 'busy') setState('busy')
      return
    }
  }
  if (quietFor >= QUIET_MS && SHELL_PROMPT_RE.test(r.burst.trimEnd())) {
    // The CLI ended and the shell underneath is showing. Nothing is typed into
    // a shell: it would run the text as a command.
    r.ready = false
    r.exited = true
    setState('error', `${BRAIN_ENGINE_NAME[r.engine]} is no longer running in the brain pane. Turn Forge Brain off and on again to restart it.`)
    return
  }
  if (quietFor >= QUIET_MS && ASK_RE.test(r.burst)) {
    if (state !== 'asking') setState('asking')
    return
  }
  // Claude's turn is the transcript's to open and close; the screen only backs
  // it up, for a turn whose end was never written.
  if (r.turnOpen && quietFor >= (r.turnReplied ? TURN_END_QUIET_MS : TURN_STALE_MS)) r.turnOpen = false
  if (r.turnOpen || quietFor < QUIET_MS) {
    if (state !== 'busy') setState('busy')
    return
  }
  if (state !== 'idle' || lastError !== r.notice) setState('idle', r.notice)
  // Before the next message goes in: a note's reply ends where the next prompt starts.
  speakNoteReply(r)
  flush(r, now)
}

/** Whitespace out: an echo is compared as characters, however the TUI wrapped or spaced it. */
function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

/** Has the typed text shown on screen? Claude collapses a long paste to "[Pasted text #1]". */
function echoed(r: Running, text: string): boolean {
  const screen = squash(r.sinceWrite)
  return screen.includes(squash(text).slice(-24)) || screen.includes('[Pastedtext')
}

function press(r: Running, keys: string): void {
  r.sinceWrite = ''
  getManager().write(r.paneId, keys)
}

/**
 * Walk a message in: its echo, then Enter, then — for Claude — its prompt in
 * the transcript. A step that does not land is tried again; a message that
 * never lands is given up on with a notice rather than typed for ever.
 */
function advanceSend(r: Running, now: number): void {
  const s = r.sending!
  const giveUp = (why: string): void => {
    r.sending = null
    r.notice = why
    console.error(`[brain] ${why}`)
  }
  if (s.stage === 'typed') {
    if (echoed(r, s.text)) {
      press(r, '\r')
      s.stage = 'entered'
      s.at = now
      s.tries = 1
    } else if (now - s.at >= ECHO_MS) {
      if (s.tries >= SEND_TRIES) giveUp('The brain did not show the message it was given, so it was not sent.')
      else {
        // Nothing of it reached the screen: the CLI dropped the keys. Type it again.
        press(r, s.text)
        s.at = now
        s.tries += 1
      }
    }
    return
  }
  // Entered. Only Claude keeps a transcript Forge reads; the others are taken at their Enter.
  if (r.engine !== 'claude' || !r.sessionId || r.prompts > s.prompts) {
    r.sending = null
    r.notice = null
    return
  }
  if (now - s.at < SUBMIT_MS) return
  if (s.tries >= SEND_TRIES) giveUp('The brain did not take the message it was given.')
  else {
    press(r, '\r')
    s.at = now
    s.tries += 1
  }
}

/* ------------------------------------------------- Claude's turns, from disk */

/** The transcript's size now, or 0: where reading starts, so a resumed history is not news. */
function transcriptSize(sessionId: string | null): number {
  if (!sessionId) return 0
  try {
    return statSync(transcriptPath(brainHomeDir(), sessionId)).size
  } catch {
    return 0
  }
}

/**
 * Read what Claude appended to the brain's transcript since the last tick. A
 * prompt (a user record with words, not a tool result) opens a turn; the
 * `turn_duration` record Claude Code writes when a turn is over closes it.
 */
function readTranscript(r: Running): void {
  if (r.engine !== 'claude' || !r.sessionId) return
  const file = transcriptPath(brainHomeDir(), r.sessionId)
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size < r.transcriptOffset) {
    r.transcriptOffset = 0
    r.transcriptCarry = Buffer.alloc(0)
  }
  if (size === r.transcriptOffset) return
  const length = Math.min(size - r.transcriptOffset, 4 * 1024 * 1024)
  const chunk = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, chunk, 0, length, r.transcriptOffset)
  } finally {
    closeSync(fd)
  }
  r.transcriptOffset += length
  const bytes = Buffer.concat([r.transcriptCarry, chunk])
  const end = bytes.lastIndexOf(0x0a)
  r.transcriptCarry = end < 0 ? bytes : bytes.subarray(end + 1)
  if (end < 0) return
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) noteRecord(r, line)
}

function noteRecord(r: Running, line: string): void {
  let record: { type?: unknown; subtype?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
  try {
    record = JSON.parse(line)
  } catch {
    return
  }
  if (record.isSidechain === true) return
  if (record.type === 'user' && record.isMeta !== true) {
    if (isPrompt(record.message?.content)) {
      r.prompts += 1
      r.turnOpen = true
      r.turnReplied = false
    }
    return
  }
  if (record.type === 'assistant') {
    const stop = (record.message as { stop_reason?: unknown } | undefined)?.stop_reason
    // A tool call means more of the same turn; the end of the reply means only hooks are left.
    r.turnReplied = stop === 'end_turn'
    return
  }
  if (record.type === 'system' && record.subtype === 'turn_duration') r.turnOpen = false
}

/** A user record's content is a prompt (words), not a tool result. */
function isPrompt(content: unknown): boolean {
  const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown }>) : []
  return typeof content === 'string' || (blocks.some((b) => b?.type === 'text') && !blocks.some((b) => b?.type === 'tool_result'))
}

/* ---------------------------------------------------------------- typing */

/** One line, no control characters: what goes into a TUI's composer. */
function clean(text: string): string {
  return stripAnsi(String(text ?? ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function flush(r: Running, now: number): void {
  const head = queue[0]
  if (!head) return
  let text: string
  let taken: QueueItem['taken']
  if (head.kind === 'note') {
    if (now - lastNoteAt < NOTE_SETTLE_MS) return
    const notes: string[] = []
    while (queue[0]?.kind === 'note') notes.push(queue.shift()!.text)
    text = `[Forge] ${notes.join(' ')}`
    // Only Claude's reply can be read back (`speakNoteReply`).
    if (r.engine === 'claude' && r.sessionId) noteTurn = { r, prompts: r.prompts, offset: transcriptSize(r.sessionId), said: false }
  } else {
    const item = queue.shift()!
    text = item.text
    taken = item.taken
  }
  // The text alone first; Enter only once it shows (`advanceSend`). A CLI that
  // is still starting drops keys, and a line typed into nothing would otherwise
  // be an Enter on an empty prompt and a message lost without a word.
  r.sending = { text, stage: 'typed', at: now, tries: 1, prompts: r.prompts }
  taken?.(r)
  press(r, text)
  r.burst = ''
  setState('busy')
}

/**
 * Type a message into the brain. Typed now when it is idle, otherwise queued
 * and typed when it is — the answer says which.
 */
export function sendToBrain(raw: string): BrainSendResult {
  return enqueue(raw)
}

function enqueue(raw: string, taken?: QueueItem['taken']): BrainSendResult {
  if (!getSettings().brainEnabled) return { ok: false, error: 'Forge Brain is off. Turn it on first.' }
  const text = clean(raw)
  if (!text) return { ok: false, error: 'Nothing to send.' }
  if (text.length > BRAIN_SEND_MAX) return { ok: false, error: `That message is ${text.length} characters; the brain takes ${BRAIN_SEND_MAX}.` }
  if (!running || running.exited || state === 'error') return { ok: false, error: lastError ?? 'Forge Brain is not running.' }
  const idleNow = state === 'idle' && queue.length === 0
  queue.push({ kind: 'user', text, taken })
  emit()
  if (idleNow) tick()
  return { ok: true, queued: queue.length > 0 }
}

/* -------------------------------------------------------------- ask + wait */

/** The other engines keep no transcript: their turn is over once the screen has settled after this long. */
const ASK_MIN_TURN_MS = 3000

/**
 * Send a message and wait for the brain's reply to it: the voice agents' way in
 * (Listen on "Forge Brain", `ask_brain`, Forge Web's `brain-ask`). Never
 * rejects; every answer is a sentence a voice can say.
 *
 * Claude's reply is read from its transcript, from the message's own prompt to
 * that turn's end: the words after its last tool call, which is the answer
 * rather than the narration before it. The other engines keep no transcript
 * Forge reads, so their turn ends when the screen settles, and the reply is
 * whatever they handed the voice agent meanwhile (`say_to_voice_agent`), or a
 * sentence pointing at the CLI view. Past `timeoutMs` the answer says it is
 * still working (`late`): the message is in, and the brain reports back.
 */
export function askBrain(raw: string, timeoutMs = BRAIN_ASK_WAIT_MS): Promise<BrainAskResult> {
  const wait = Math.min(Math.max(1000, Number.isFinite(timeoutMs) ? timeoutMs : BRAIN_ASK_WAIT_MS), BRAIN_ASK_WAIT_MAX_MS)
  return new Promise<BrainAskResult>((resolve) => {
    let start: { r: Running; prompts: number; offset: number; at: number } | null = null
    const said: string[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    const offSays = onBrainSays((event) => {
      if (start) said.push(event.text)
    })
    const finish = (result: BrainAskResult): void => {
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
      offSays()
      resolve(result)
    }
    const sent = enqueue(raw, (r) => {
      start = { r, prompts: r.prompts, offset: transcriptSize(r.sessionId), at: Date.now() }
    })
    if (!sent.ok) {
      finish({ ok: false, error: sent.error })
      return
    }
    timer = setTimeout(
      () => finish({ ok: false, late: true, error: 'Forge Brain is still working on that. It will report back when it is done.' }),
      wait
    )
    poll = setInterval(() => {
      const s = start
      if (!s) {
        // Still queued behind something else. A brain that stopped meanwhile never takes it.
        if (!running || running.exited || !getSettings().brainEnabled) finish({ ok: false, error: 'Forge Brain stopped before it read that.' })
        return
      }
      const r = s.r
      if (running !== r || r.exited) {
        finish({ ok: false, error: 'Forge Brain stopped before it answered.' })
        return
      }
      if (r.engine === 'claude' && r.sessionId) {
        if (r.prompts <= s.prompts) {
          // Not in the transcript yet. No longer sending means it was given up on.
          if (!r.sending) finish({ ok: false, error: r.notice ?? 'Forge Brain did not take that message.' })
          return
        }
        if (r.turnOpen) return
        const reply = replyAfter(r.sessionId, s.offset) || said.join(' ')
        finish(reply ? { ok: true, text: reply } : { ok: false, error: 'Forge Brain finished without saying anything.' })
        return
      }
      if (r.sending) return
      if (r.notice) {
        finish({ ok: false, error: r.notice })
        return
      }
      if (Date.now() - s.at < ASK_MIN_TURN_MS) return
      if (state === 'asking') {
        finish({ ok: false, error: 'Forge Brain is showing a question on its screen. Open its CLI view to answer it.' })
        return
      }
      if (state !== 'idle') return
      finish({
        ok: true,
        text: said.length
          ? said.join(' ')
          : `${BRAIN_ENGINE_NAME[r.engine]} has finished. Its answer is in Forge Brain's CLI view — only the Claude engine's replies can be read back.`
      })
    }, TICK_MS)
  })
}

/**
 * The brain's reply to the prompt that starts at `offset` in its transcript:
 * the text after the turn's last tool call (what it wrote before a tool is
 * narration), or all of its text when that is empty. Stops at the next prompt.
 */
function replyAfter(sessionId: string, offset: number): string {
  let body: string
  try {
    const file = transcriptPath(brainHomeDir(), sessionId)
    const size = statSync(file).size
    if (size <= offset) return ''
    const length = Math.min(size - offset, 4 * 1024 * 1024)
    const chunk = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, chunk, 0, length, offset)
    } finally {
      closeSync(fd)
    }
    body = chunk.toString('utf8')
  } catch {
    return ''
  }
  let prompted = false
  let all: string[] = []
  let last: string[] = []
  for (const line of body.split('\n')) {
    let record: { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.isSidechain === true) continue
    const content = record.message?.content
    if (record.type === 'user' && record.isMeta !== true) {
      if (isPrompt(content)) {
        if (prompted) break
        prompted = true
        all = []
        last = []
      } else last = []
      continue
    }
    if (record.type !== 'assistant' || !prompted) continue
    const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>) : []
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        all.push(b.text.trim())
        last.push(b.text.trim())
      } else if (b?.type === 'tool_use') last = []
    }
  }
  return (last.length ? last : all).join('\n\n').trim()
}

/* ------------------------------------------------------------ fresh start */

/** How long a fresh start waits for the brain's handoff note before Forge writes what it knows instead. */
const HANDOFF_WAIT_MS = 120_000

const HANDOFF_ASK =
  '[Forge] Fresh start: your context window is filling up, so Forge restarts you on a new conversation right after this reply. ' +
  'Reply with your handoff note and nothing else: what you are tracking for Steve, the panes you handed work to ' +
  '(name, project, pane id, what each is doing), and any open questions. Plain lines, under 250 words. ' +
  'Forge saves your reply as HANDOFF.md in your home, and your next conversation reads it first.'

const HANDOFF_READ = "[Forge] This is a fresh start. Read HANDOFF.md first, then say you're ready."

let freshStarting = false

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * What main knows, below the brain's own note: the panes it opened that are
 * still up (Forge keeps telling it when they stop), and the notes waiting
 * for it. Kept here, not in the conversation, so a fresh start loses neither.
 */
function forgeHandoff(): string {
  const live = new Set(liveSessions().map((s) => s.id))
  const panes = [...opened].filter((id) => live.has(id)).map((id) => `- ${paneLabel(id)} (pane id ${id})`)
  const notes = queue.filter((q) => q.kind === 'note').map((q) => `- ${q.text}`)
  return [
    `## From Forge (${new Date().toISOString()})`,
    '',
    'Panes you opened that are still up. Forge still tells you when they stop:',
    ...(panes.length ? panes : ['- none']),
    '',
    'Notes from Forge waiting for you:',
    ...(notes.length ? notes : ['- none']),
    ''
  ].join('\n')
}

/**
 * A fresh start: the brain is asked for its handoff note and its turn waited
 * out; the note goes into HANDOFF.md in its home (the brain's tools cannot
 * write files, so Forge saves its reply — and if it wrote the file itself,
 * that is kept), with what main knows added below. No note in time, or an
 * engine whose reply Forge cannot read: the file is what Forge knows alone.
 * Then the pane restarts on a new pane and a new conversation whose first
 * message tells it to read HANDOFF.md. The panes it opened stay tracked.
 */
export async function freshStartBrain(): Promise<BrainFreshStartResult> {
  const r = running
  if (!getSettings().brainEnabled || !r || r.exited || state === 'error') {
    return { ok: false, error: lastError ?? 'Forge Brain is not running.' }
  }
  if (freshStarting) return { ok: false, error: 'A fresh start is already under way.' }
  freshStarting = true
  try {
    const file = join(brainHomeDir(), 'HANDOFF.md')
    const before = mtimeOf(file)
    const answer = await askBrain(HANDOFF_ASK, HANDOFF_WAIT_MS)
    if (running !== r) return { ok: false, error: 'Forge Brain stopped or changed engine during the fresh start.' }
    const wroteItself = mtimeOf(file) > before
    const note = answer.ok && r.engine === 'claude' ? answer.text.trim() : ''
    let body: string
    if (wroteItself) body = `${readFileSync(file, 'utf8').trimEnd()}\n\n${forgeHandoff()}`
    else if (note) body = `# Handoff\n\n${note}\n\n${forgeHandoff()}`
    else body = `# Handoff\n\nForge Brain gave no handoff note before this fresh start. This is what Forge knows.\n\n${forgeHandoff()}`
    writeFileSync(file, body, 'utf8')
    const by: 'brain' | 'forge' = wroteItself || note ? 'brain' : 'forge'
    let restarted = false
    // In line with enable, disable and engine switches, so none of them lands halfway through.
    reconciling = reconciling
      .then(async () => {
        if (running !== r) return
        stop()
        await start(r.engine, true)
        if (!running) return
        restarted = true
        queue.unshift({ kind: 'user', text: HANDOFF_READ })
        emit()
      })
      .catch((err) => {
        console.error('[brain] fresh start failed:', err)
        setState('error', `Forge Brain could not start again: ${err instanceof Error ? err.message : String(err)}`)
      })
    await reconciling
    return restarted ? { ok: true, by } : { ok: false, error: lastError ?? 'Forge Brain did not start again.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    freshStarting = false
  }
}

/* ------------------------------------------------------------ report-back */

/** "Zeb in car-harness", from the PTY host's names and main's project list. */
function paneLabel(paneId: string, projectId?: string): string {
  const live = liveSessions().find((s) => s.id === paneId)
  const name = live?.name || live?.paneTitle || 'A pane'
  const project = (projectId && getProjects().find((p) => p.id === projectId)?.name) || live?.projectName || ''
  return project ? `${name} in ${project}` : name
}

function addNote(text: string): void {
  queue.push({ kind: 'note', text: clean(text) })
  lastNoteAt = Date.now()
  emit()
}

/** Once noted, the same pane and state is not noted again for `NOTE_REPEAT_MS`. True = go ahead. */
function noteOnce(paneId: string, kind: 'asking' | 'done'): boolean {
  const key = `${paneId}:${kind}`
  const now = Date.now()
  if (now - (noted.get(key) ?? 0) < NOTE_REPEAT_MS) return false
  noted.set(key, now)
  return true
}

/**
 * The renderer's busy light for one pane (`IPC.webBusy`, wired in ./ipc.ts).
 * Its two edges are how main knows how long a pane worked, when it stopped, and
 * whether it has gone back to work since.
 */
export function notePaneBusy(paneId: string, busy: boolean): void {
  const now = Date.now()
  const run = runs.get(paneId)
  if (busy) {
    if (run?.busy) return
    // Back at work before its stop was weighed: the same run, still going.
    const same = !!run && now - run.endedAt < STOP_SETTLE_MS
    runs.set(paneId, { startedAt: same ? run.startedAt : now, endedAt: 0, busy: true })
    dropStop(paneId)
    return
  }
  if (!run?.busy) return
  run.busy = false
  run.endedAt = now
  if (opened.has(paneId)) weighStopLater(paneId)
}

function dropStop(paneId: string): void {
  const pending = stops.get(paneId)
  if (pending) clearTimeout(pending)
  stops.delete(paneId)
}

function forgetStops(): void {
  for (const timer of stops.values()) clearTimeout(timer)
  stops.clear()
}

/** Where a stopped pane's transcript is looked for: every project's folder and saved layout, in turn. */
function* panePlaces(): Generator<PanePlace> {
  for (const project of getProjects()) yield { path: project.path, workspace: getWorkspace(project.id) }
}

/**
 * A pane the brain opened has stopped working. That is news only once it has
 * stayed stopped for `STOP_SETTLE_MS`: every turn of a long job ends in a
 * stop, and the brain used to be told "finished" for each one. Going back to
 * work drops the wait (`notePaneBusy`); a newer stop takes this one's place.
 * The note says how long it worked and, for a Claude pane, what it last said.
 */
function weighStopLater(paneId: string): void {
  dropStop(paneId)
  stops.set(
    paneId,
    setTimeout(() => {
      stops.delete(paneId)
      const run = runs.get(paneId)
      // No run on record: the renderer's `done` vouched for this stop instead.
      const workedMs = run ? run.endedAt - run.startedAt : null
      if (!stopIsNews(workedMs, run?.busy === true)) return
      if ((!running && !freshStarting) || !opened.has(paneId) || !noteOnce(paneId, 'done')) return
      const label = paneLabel(paneId)
      void (async () => {
        const file = await paneTranscript(paneId, panePlaces())
        addNote(stopNote(label, workedMs, file ? paneWords(await readTail(file)) : null))
      })()
    }, STOP_SETTLE_MS)
  )
}

/**
 * Pane news from the attention bus: a pane asking for Steve, anywhere. The
 * renderer takes any screen line ending in "?" for a question, so one that is
 * the pane's own input line, or a CLI's idle placeholder, is not passed on.
 *
 * A pane stopping is told from its busy light (`notePaneBusy`), not from
 * `done` — `done` fires at every turn end, and is never sent for a pane that
 * settled on something the renderer took for a question. It is only the way in
 * for a pane whose busy light main never saw.
 */
function onPaneAttention(event: AttentionEvent): void {
  const r = running
  if (!r || event.paneId === r.paneId || event.state === 'idle') return
  if (event.state === 'done') {
    if (opened.has(event.paneId) && !runs.has(event.paneId)) weighStopLater(event.paneId)
    return
  }
  const question = clean(String(event.prompt ?? '').split(/\r?\n/)[0] ?? '')
  if (askingIsNoise(question)) return
  // A real question is the news; "it stopped" as well would say it twice.
  dropStop(event.paneId)
  if (!noteOnce(event.paneId, 'asking')) return
  addNote(askingNote(paneLabel(event.paneId, event.projectId), question))
}

/**
 * A note's turn is over, and nobody asked for it, so nobody is waiting for the
 * reply: Forge says it to Steve through the voice agents. Not when the reply is
 * the silent marker, nor when the brain spoke for itself during the turn. Only
 * notes: a message from Steve or a voice agent has its own listener (`askBrain`).
 */
function speakNoteReply(r: Running): void {
  const turn = noteTurn
  if (!turn) return
  noteTurn = null
  // Never taken (the send was given up on), or typed into a pane since restarted: nothing to say.
  if (turn.r !== r || !r.sessionId || r.prompts <= turn.prompts || turn.said) return
  const reply = replyAfter(r.sessionId, turn.offset)
  if (reply && !isQuietReply(reply)) brainSays(reply, true)
}

/* --------------------------------------------------------------- confirms */

/**
 * Ask Steve before a risky tool call. Shown on every surface through
 * `BrainStatus.confirms`; resolves true on his yes, false on a no, on a
 * timeout, or when the brain is switched off. For B2's gate in `toolHost`.
 */
export function requestConfirm(tool: string, summary: string, risk: BrainRisk): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = randomUUID()
    const timer = setTimeout(() => answerConfirm({ id, allow: false }), CONFIRM_TIMEOUT_MS)
    confirms.set(id, { request: { id, tool, summary, risk, at: Date.now() }, resolve, timer })
    emit()
  })
}

/** Steve's answer. True when that request was waiting. */
export function answerConfirm(answer: { id: string; allow: boolean }): boolean {
  const pending = confirms.get(String(answer?.id ?? ''))
  if (!pending) return false
  confirms.delete(pending.request.id)
  clearTimeout(pending.timer)
  pending.resolve(answer.allow === true)
  emit()
  return true
}

/* -------------------------------------------------------- the voice agents */

const saysListeners = new Set<(event: BrainSaysEvent) => void>()

/** Every line the brain gives the voice agents. Returns the unsubscribe. */
export function onBrainSays(listener: (event: BrainSaysEvent) => void): () => void {
  saysListeners.add(listener)
  return () => {
    saysListeners.delete(listener)
  }
}

/**
 * Hand a line to whichever voice agent is live: to say aloud (`speak`) or to
 * take as context. The desktop renderer and every browser hear it; the tool that
 * calls this is the voice side's (B2/B5), not the core's.
 */
export function brainSays(text: string, speak = true): BrainSaysEvent | null {
  const line = clean(text)
  if (!line) return null
  const event: BrainSaysEvent = { id: randomUUID(), text: line.slice(0, BRAIN_SEND_MAX), speak, at: Date.now() }
  for (const listener of saysListeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[brain] says listener failed:', err)
    }
  }
  return event
}

/* ------------------------------------------------------------- transcript */

/** The brain pane's Claude transcript, when there is one yet. */
function transcriptFile(): string | null {
  const r = running
  if (!r?.sessionId) return null
  const file = transcriptPath(brainHomeDir(), r.sessionId)
  return existsSync(file) ? file : null
}

function armTranscript(): boolean {
  const r = running
  if (!transcriptSink || !r) return false
  if (transcriptArmedFor === r.paneId) return true
  const file = transcriptFile()
  if (!file) return false
  watchTranscript(r.paneId, file, transcriptSink)
  transcriptArmedFor = r.paneId
  return true
}

/**
 * Push the brain pane's conversation to `sink` (the renderer). True when there
 * is one now; otherwise it starts by itself once the first turn is on disk.
 * Every call re-seeds with a `reset`.
 */
export function watchBrainTranscript(sink: (update: ChatUpdate) => void): boolean {
  const r = running
  if (transcriptSink && r && transcriptArmedFor === r.paneId) stopTranscript(r.paneId, transcriptSink)
  transcriptSink = sink
  transcriptArmedFor = null
  return armTranscript()
}

export function stopBrainTranscript(): void {
  const r = running
  if (transcriptSink && r && transcriptArmedFor === r.paneId) stopTranscript(r.paneId, transcriptSink)
  transcriptSink = null
  transcriptArmedFor = null
}

/* ---------------------------------------------------------------- set-up */

/** Subscribe to the PTY host and the attention bus, then start the brain if it is on. */
export function initBrain(): void {
  unsubscribeSink ??= addPtySink({ onData: onPaneData, onExit: onPaneExit, onSpawn: onPaneSpawn })
  unsubscribeAttention ??= onAttention(onPaneAttention)
  void applyBrainSettings()
}

/** Quit: the PTY host kills the pane itself; this lets go of everything else. */
export function disposeBrain(): void {
  // Not `stop()`: killing the pane is the PTY host's own disposal, and asking
  // it to kill after that would bring a fresh session manager into being.
  running = null
  noteTurn = null
  setBrainLaunch(null)
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  forgetStops()
  runs.clear()
  for (const id of [...confirms.keys()]) answerConfirm({ id, allow: false })
  unsubscribeSink?.()
  unsubscribeSink = null
  unsubscribeAttention?.()
  unsubscribeAttention = null
  link?.close()
  link = null
  linkReady = null
  listeners.clear()
  saysListeners.clear()
}

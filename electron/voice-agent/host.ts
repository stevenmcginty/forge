import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
  VoiceAgentEvent,
  VoiceAgentStartRequest,
  VoiceAgentStatus,
  VoiceAgentToolResult
} from '@shared/types'
import { RestartBudget, MAX_RAPID_RESTARTS } from '../stt-protocol'
import { whichCommand } from '../which'
import { isCodexClaudeModel } from '@shared/agent-brain'
import { CLI_BRAIN_NAME, CliBrainRunner, isCliBrain, type CliBrainId, type CliBrainSetup } from './cli-brains'
import { claudeSdkExecutable } from '../claude-exe'
import {
  closeDesktopWindow,
  focusDesktopWindow,
  launchDesktopApp,
  listDesktopApps,
  listOpenWindows,
  openDesktopTarget,
  sendKeysToWindow
} from '../desktop-control'
import { closeBrowser } from './chrome-control'
import { defaultAssetsDir, listFiles, runCommand, saveAsset, writeTextFile } from './file-tools'
import { VOICE_PERSONA } from './persona'
import { brainHubTools } from '../hub-brain-tools'
import { brainSpecAllowed, brainSpecTools } from '../brain-tools-mcp'
import { refuseAppLaunch, refuseCommand, routeOpenTarget } from './launch-guard'
import { BRAIN_BROWSER_ALLOWED, brainBrowserTools } from '../browser-panes/brain'

/**
 * The voice brain: one persistent Claude Agent SDK session, living for as long
 * as Forge does.
 *
 * The thing to understand before changing anything here is *why it is one
 * session*. The brains it replaces (Gemini, OpenRouter, Groq) were per-turn
 * HTTP calls that re-sent a ~3,000-token capability manifest as the system
 * prompt every single time Steve opened his mouth. That is the token bill, the
 * latency, and the reason nothing ever cached. This is the opposite shape:
 *
 *  - **One session, many turns.** `query()` is handed an async generator of
 *    user messages rather than a string, so the session opens once and every
 *    later utterance is pushed into the same conversation. Spawn cost per turn
 *    is zero, and the model keeps the thread of the conversation for free.
 *  - **A static prompt.** `VOICE_PERSONA` never changes, so the prompt prefix
 *    caches across turns and across sessions.
 *  - **Tools instead of a manifest.** App state is *asked for* through
 *    `get_app_state` when the model actually needs it, rather than posted up
 *    front on the off-chance. See ./persona.ts.
 *
 * ## Deliberately Electron-free
 *
 * Nothing in this file imports `electron`. Everything the main process owns —
 * `ipcMain`, the window to push events at, `desktopCapturer`, the settings
 * store, the forge-bridge MCP config — arrives through `VoiceAgentDeps`. That
 * is what lets `scripts/voice-brain-smoke.mjs` drive the real SDK against the
 * real Claude login with no Electron in sight, which is the only way this file
 * is testable at all. `electron/voice-agent/ipc.ts` is the half that knows
 * about Electron; it is deliberately thin.
 *
 * ## Auth
 *
 * There is no API key here and there must never be one. The SDK resolves the
 * machine's existing `claude` subscription login by itself, which is the same
 * credential every Forge pane already runs on. `ANTHROPIC_API_KEY` is not set,
 * not read, and not forwarded.
 */

/* ------------------------------------------------------------------ config */

/** A tool round trip the renderer never answered. Never hang the session. */
const TOOL_TIMEOUT_MS = 15_000

/**
 * Generous rather than tight. A voice turn that has to look at the app, act on
 * it, and check what happened is several turns of tool use before a word is
 * spoken; a stingy cap here shows up as the agent going quiet mid-sentence.
 * Raised from 25 when the desktop tools landed: open-app, focus, screenshot,
 * type, screenshot again is ten calls before the first real step of a job.
 */
const MAX_TURNS = 50

/**
 * Matches every other model literal in Forge: an alias, not a pinned id.
 * Opus, deliberately — Steve chose intelligence over latency for the brain
 * (2026-08-02), and the header toggle makes dropping to Sonnet one click.
 */
export const DEFAULT_VOICE_CLAUDE_MODEL = 'opus'

/**
 * Models the Claude brain used to hand to the Codex CLI with no Forge tools.
 * A turn on one of these now runs on the codex-cli adapter (./cli-brains.ts),
 * with every Forge tool; settings migrate off it (shared/agent-brain.ts).
 */
export const CODEX_VOICE_MODELS = new Set(['gpt-5.6-luna'])

/* ------------------------------------------------------------------- deps */

/** A screenshot, already encoded. Null means "could not take one". */
export interface VoiceAgentShot {
  /** Base64 PNG, no data-url prefix — the MCP image block wants raw base64. */
  base64: string
  mime: string
}

/**
 * Everything the host cannot work out for itself. All of it is injected so the
 * headless smoke test can supply doubles.
 */
export interface VoiceAgentDeps {
  /** Push one event at the renderer. Must never throw. */
  sendEvent(event: VoiceAgentEvent): void
  /**
   * Ask the renderer a question. The host has already registered the pending
   * promise under `id` by the time this is called; the answer comes back
   * through `resolveTool`.
   */
  sendToolRequest(request: { id: string; name: string; args: unknown }): void
  /** `settings.voiceClaudeModel`. Read per session start, so it can change. */
  getModel(): string
  /**
   * `settings.agentBrain`. 'codex-cli' and 'gemini-cli' run on a hidden CLI
   * (./cli-brains.ts); anything else is this Claude session. Absent = Claude.
   */
  getBrain?(): string
  /**
   * How a CLI brain reaches the same Forge tools: the brain link
   * (bridge/brain-mcp.mjs relays to `callLinkTool`). Null = no tools, so no
   * CLI brain turn runs.
   */
  getCliSetup?(): Promise<CliBrainSetup | null>
  /**
   * The forge-bridge MCP server, so the voice agent gets make_image,
   * ask_gemini and friends — the same server Forge injects into Claude panes.
   * Null when the bridge script cannot be found, which is not an error.
   */
  getBridgeServer?(): McpServerConfig | null
  /** Grab the primary display. Absent means take_screenshot answers honestly. */
  captureScreen?(): Promise<VoiceAgentShot | null>
  /**
   * Where generated images and videos actually land — `<data dir>\bridge-out`,
   * the same value electron/bridge/mcp-config.ts puts in the bridge's env.
   * Absent (the headless smoke test), file-tools' `defaultAssetsDir()` guess is
   * used instead, which is only wrong under a non-default --data-dir.
   */
  getAssetsDir?(): string
  /**
   * Where Jarvis's own Chrome profile lives — `<data dir>\chrome-jarvis`. It is
   * a dedicated, persistent profile rather than Steve's daily browser, so the
   * sign-ins it accumulates survive Forge closing; see ../voice-agent/
   * chrome-control.ts for why it cannot be his own. Absent, chrome-control's
   * `defaultChromeProfileDir()` guess is used, on the same terms as the assets
   * dir above.
   */
  getChromeProfileDir?(): string
}

/* --------------------------------------------------------------- utilities */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What the model sees for a tool result.
 *
 * A string goes through untouched — the renderer's outcomes are already
 * written for a reader. Anything else is JSON, which is fine because the model
 * reads it and never speaks it.
 */
function asToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/* --------------------------------------------------------------- the host */

export class VoiceAgentHost {
  private readonly deps: VoiceAgentDeps

  /** The live session. Null whenever there is not one. */
  private session: Query | null = null

  /** The Codex / Gemini CLI brains: one headless run per turn, resumed. */
  private readonly cli: CliBrainRunner
  /** The last live-app block a turn carried, for a CLI conversation that starts later. */
  private lastContext = ''

  /** Utterances waiting to be pulled by the input generator. */
  private readonly inbox: SDKUserMessage[] = []
  /** Resolves the generator's current await, when it is parked. */
  private wake: (() => void) | null = null
  /** Set on stop/dispose so the generator returns instead of parking again. */
  private closing = false

  /** Tool round trips in flight, keyed by request id. */
  private readonly pending = new Map<
    string,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >()

  private readonly budget = new RestartBudget()
  /** Set once the budget is spent; only an explicit start() clears it. */
  private givenUp = false
  private lastError: string | null = null

  /** The model and cwd the *live* session was started with. */
  private model = ''
  private cwd = ''
  /** The cwd the next session should use, from the last start() request. */
  private wantedCwd = ''

  constructor(deps: VoiceAgentDeps) {
    this.deps = deps
    this.cli = new CliBrainRunner({
      sendEvent: (event) => {
        if (event.type === 'error') this.lastError = event.message
        if (event.type === 'result') this.lastError = null
        this.deps.sendEvent(event)
      },
      setup: async () => (this.deps.getCliSetup ? await this.deps.getCliSetup() : null),
      persona: VOICE_PERSONA
    })
  }

  /**
   * Who answers this turn: this Claude session, or a CLI brain. A Codex model
   * under the Claude brain (the old "GPT-5.6 Luna via Codex") is the codex-cli
   * adapter with that model, so it gets the Forge tools too.
   */
  private route(): { kind: 'claude'; model: string } | { kind: 'cli'; brain: CliBrainId; model: string | null } {
    const brain = this.deps.getBrain?.() ?? 'claude'
    if (isCliBrain(brain)) return { kind: 'cli', brain, model: null }
    const model = this.deps.getModel().trim() || DEFAULT_VOICE_CLAUDE_MODEL
    if (CODEX_VOICE_MODELS.has(model) || isCodexClaudeModel(model)) return { kind: 'cli', brain: 'codex-cli', model }
    return { kind: 'claude', model }
  }

  /* ------------------------------------------------------------- lifecycle */

  status(): VoiceAgentStatus {
    return { running: this.session !== null || this.cli.running, model: this.model, error: this.lastError }
  }

  /**
   * Open the session, or adopt a new cwd for the next one.
   *
   * Explicitly asking to start is also how you get a second chance after the
   * restart budget was spent — it is the only thing that clears `givenUp`,
   * because an automatic retry loop is exactly what the budget exists to stop.
   */
  start(request?: VoiceAgentStartRequest): VoiceAgentStatus {
    this.closing = false
    this.givenUp = false
    this.budget.clear()
    this.lastError = null
    const cwd = (request?.cwd ?? '').trim()
    if (cwd) this.wantedCwd = cwd
    this.ensure()
    return this.status()
  }

  /** Close the session. A later utterance opens a fresh one. */
  stop(): VoiceAgentStatus {
    this.teardown()
    return this.status()
  }

  /**
   * Stop the turn without ending the conversation.
   *
   * The session must survive this: barge-in happens mid-sentence and the next
   * thing Steve says is a continuation, not a new topic. `interrupt()` unwinds
   * the current turn and leaves the input generator parked, exactly as if the
   * model had finished.
   */
  async interrupt(): Promise<boolean> {
    if (this.cli.interrupt()) return true
    const q = this.session
    if (!q) return false
    try {
      await q.interrupt()
      return true
    } catch (err) {
      // A session that has already unwound is not a failure worth reporting —
      // the caller wanted it quiet, and it is.
      console.error('[voice-agent] interrupt failed:', errText(err))
      return false
    }
  }

  /**
   * Say something to the agent.
   *
   * Lazy: the first utterance opens the session if `start` never was called.
   * A model change since the session opened restarts it here rather than
   * mid-turn, which is why the check lives at the top of this method.
   */
  sendUtterance(text: string): VoiceAgentStatus {
    const say = String(text ?? '').trim()
    if (!say) return this.status()

    // The setting moved under a live session. Take the new model at the turn
    // boundary — the only safe place — rather than ignoring it until restart.
    const route = this.route()
    // The live-app block the renderer prepends when the app changed. Kept, so a
    // CLI conversation that starts after it was sent still hears it once.
    const block = /^\[[\s\S]*?\]\n\n/.exec(say)?.[0]
    if (block) this.lastContext = block

    if (route.kind === 'cli') {
      // A brain switch away from Claude: close that session at the boundary.
      if (this.session) this.teardown()
      this.closing = false
      this.lastError = null
      const cwd = this.wantedCwd || homedir()
      this.model = route.model ?? CLI_BRAIN_NAME[route.brain]
      this.cwd = cwd
      const text = !block && this.lastContext && !this.cli.hasSession(route.brain, cwd) ? `${this.lastContext}${say}` : say
      void this.cli.run({ brain: route.brain, text, cwd, model: route.model })
      return this.status()
    }

    this.cli.interrupt()
    if (this.session && route.model !== this.model) {
      this.teardown()
    }

    this.closing = false
    this.ensure()
    if (!this.session) return this.status()

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: say },
      parent_tool_use_id: null
    })
    this.flush()
    return this.status()
  }

  /**
   * Ask the renderer to run one Forge tool, exactly as the model would — the
   * route pane agents' open_agent_pane takes (electron/browser-panes/ipc.ts).
   * Resolves with the tool's sentence; never rejects.
   */
  askTool(name: string, args: unknown): Promise<string> {
    return this.askRenderer(name, args)
  }

  /** The renderer's answer to a `voice-agent:tool-request`. */
  resolveTool(result: VoiceAgentToolResult): void {
    const id = String(result?.id ?? '')
    const entry = this.pending.get(id)
    // Late, duplicate or invented — all three are the same non-event. The
    // timeout has already answered the model in the late case.
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(
      result.ok
        ? asToolText(result.result)
        : `That failed: ${result.error?.trim() || 'the app did not say why'}`
    )
  }

  /** App is quitting. Never respawn after this. */
  dispose(): void {
    this.teardown()
    this.closing = true
    this.givenUp = true
    // The browser is a window on the desktop rather than part of the
    // conversation, so nothing else ever closes it. Fire and forget: the app is
    // on its way out and a Chrome that will not go quietly is not worth waiting
    // for. The profile on disk survives either way, which is the point of it.
    void closeBrowser().catch(() => undefined)
  }

  /* ------------------------------------------------------------- internals */

  private teardown(): void {
    this.closing = true
    const q = this.session
    this.session = null
    this.inbox.length = 0
    this.model = ''

    this.cli.reset()

    // Unblock the generator so it can return and let the SDK close the
    // subprocess down cleanly.
    this.flush()

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve('Forge closed the voice session before this could be answered.')
    }
    this.pending.clear()

    if (q) {
      // The generator returning is the ordinary shutdown; return() is the
      // belt, and a rejection from an already-dead session is not news.
      void Promise.resolve(q.return(undefined)).catch(() => undefined)
    }
  }

  /** Wake the input generator if it is parked. */
  private flush(): void {
    const wake = this.wake
    this.wake = null
    if (wake) wake()
  }

  private fail(message: string): void {
    this.lastError = message
    console.error(`[voice-agent] ${message}`)
    this.deps.sendEvent({ type: 'error', message })
  }

  /**
   * The session's input side: an endless generator the SDK pulls from.
   *
   * Parking here rather than ending is the whole trick — an input generator
   * that returns ends the session, so it must stay alive and idle between
   * turns. It only returns when `closing` is set.
   */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.inbox.length) {
        if (this.closing) return
        yield this.inbox.shift() as SDKUserMessage
      }
      if (this.closing) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private ensure(): void {
    if (this.session || this.givenUp) return

    const route = this.route()
    // A CLI brain has no session to open: each turn is its own resumed run.
    if (route.kind === 'cli') {
      this.model = route.model ?? CLI_BRAIN_NAME[route.brain]
      return
    }
    const model = route.model
    const cwd = this.wantedCwd || homedir()

    let q: Query
    try {
      q = query({ prompt: this.input(), options: this.options(model, cwd) })
    } catch (err) {
      this.onDead(`The voice brain could not start: ${errText(err)}`)
      return
    }

    this.session = q
    this.model = model
    this.cwd = cwd
    this.lastError = null

    void this.consume(q)
  }

  /**
   * Drain the session's output for as long as it lives.
   *
   * One loop for the whole session, not one per turn: with streaming input the
   * generator spans every turn, so a `result` message is a turn boundary and
   * not the end of anything.
   */
  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (q !== this.session) return
        this.emit(message)
      }
      // The generator ended on its own. Either we asked it to (teardown) or
      // the subprocess went away under us.
      if (q === this.session) this.onDead('The voice brain closed unexpectedly')
    } catch (err) {
      if (q !== this.session) return
      this.onDead(`The voice brain failed: ${errText(err)}`)
    }
  }

  /** A dead session, with the restart budget deciding whether to try again. */
  private onDead(message: string): void {
    this.session = null
    this.model = ''
    // Whatever the model was mid-turn is gone; nothing can answer these now.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve('The voice session ended before this could be answered.')
    }
    this.pending.clear()

    if (this.closing) return

    if (this.budget.record()) {
      this.fail(message)
      // Deliberately no timer: the next utterance re-opens the session. A
      // voice agent nobody is talking to has no reason to hold a subprocess.
      return
    }
    this.givenUp = true
    this.fail(
      `The voice brain crashed ${MAX_RAPID_RESTARTS + 1} times in a minute — giving up. ` +
        `Check that \`claude\` is installed and logged in. (${message})`
    )
  }

  /* -------------------------------------------------------------- messages */

  /**
   * Tool calls in flight, tool_use id → short name, so the `end` event can say
   * which tool finished — the SDK's tool_result block carries only the id.
   */
  private toolCalls = new Map<string, string>()

  /** Turn one SDK message into zero or more renderer events. */
  private emit(message: SDKMessage): void {
    switch (message.type) {
      case 'stream_event': {
        const text = textDelta(message.event)
        if (text) this.deps.sendEvent({ type: 'delta', text })
        return
      }

      case 'assistant': {
        // Subagent chatter carries a parent id. Only the main thread is Steve's
        // conversation; forwarding the rest would speak two voices at once.
        // The Task tool in options() depends on this line: without it every
        // sentence the researcher thinks would be read out loud.
        if (message.parent_tool_use_id) return
        const parts: string[] = []
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) parts.push(block.text)
          if (block.type === 'tool_use') {
            const name = shortToolName(block.name)
            this.toolCalls.set(block.id, name)
            this.deps.sendEvent({ type: 'tool', name, phase: 'start' })
          }
        }
        if (parts.length) this.deps.sendEvent({ type: 'assistant', text: parts.join('\n') })
        return
      }

      case 'user': {
        if (message.parent_tool_use_id) return
        const content = message.message.content
        if (typeof content === 'string') return
        for (const block of content) {
          if (block.type === 'tool_result') {
            const name = this.toolCalls.get(block.tool_use_id) ?? ''
            this.toolCalls.delete(block.tool_use_id)
            this.deps.sendEvent({ type: 'tool', name, phase: 'end', ok: block.is_error !== true })
          }
        }
        return
      }

      case 'result': {
        this.deps.sendEvent({
          type: 'result',
          ok: !message.is_error,
          text: message.subtype === 'success' ? message.result : '',
          turns: message.num_turns,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms
        })
        // A turn that came back at all means the session works. Whatever went
        // wrong before is not evidence about the next crash.
        this.budget.clear()
        // An aborted turn can leave starts with no results; the ids are dead.
        this.toolCalls.clear()
        return
      }

      default:
        // Everything else the SDK emits — system init, status, hooks, task
        // notifications — is either noise for a voice agent or something a
        // later job will want. Silence is the right default, not a log line
        // per streamed token.
        return
    }
  }

  /* ----------------------------------------------------------------- tools */

  /**
   * Ask the renderer something and wait, but never for ever.
   *
   * A timeout resolves with an error *string* rather than rejecting: a
   * rejected MCP handler is an exception in the model's turn, whereas "the app
   * did not answer" is a fact it can tell Steve about and carry on from.
   */
  private askRenderer(name: string, args: unknown): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(`Forge did not answer ${name} within ${TOOL_TIMEOUT_MS / 1000} seconds.`)
      }, TOOL_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      try {
        this.deps.sendToolRequest({ id, name, args })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve(`Forge could not be reached: ${errText(err)}`)
      }
    })
  }

  /**
   * Forge's own tools, served in-process.
   *
   * These are the reason there is no manifest. Everything the old system
   * prompt carried up the wire every turn is available here on demand, and
   * `run_app_action`'s description carries the action vocabulary that used to
   * be a section of that prompt.
   */
  private forgeServer(): McpServerConfig {
    return createSdkMcpServer({
      name: 'forge',
      version: '1.0.0',
      // These are the app's eyes and hands. Deferring them behind tool search
      // would mean the agent occasionally answers about Forge without them.
      alwaysLoad: true,
      tools: this.forgeToolDefs()
    })
  }

  /* --------------------------------------------- the same tools, for CLIs */

  private linkTools: ForgeToolDef[] | null = null

  /**
   * Every Forge tool as MCP `tools/list` entries, for a CLI brain's
   * bridge/brain-mcp.mjs — the same definitions the Claude session gets, with
   * the zod shapes written out as JSON Schema.
   */
  listLinkTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    this.linkTools ??= this.forgeToolDefs()
    return this.linkTools.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: cleanSchema(z.toJSONSchema(z.object(def.inputSchema))) as Record<string, unknown>
    }))
  }

  /**
   * Run one Forge tool for a CLI brain, validated by the same zod shape the
   * Claude session's SDK checks. Answers in an MCP result; never rejects.
   */
  async callLinkTool(name: string, args: unknown): Promise<CallToolResult> {
    this.linkTools ??= this.forgeToolDefs()
    const def = this.linkTools.find((t) => t.name === name)
    if (!def) return { content: [{ type: 'text', text: `There is no Forge tool called ${name}.` }], isError: true }
    const parsed = z.object(def.inputSchema).safeParse(args ?? {})
    if (!parsed.success) {
      return { content: [{ type: 'text', text: `${name} was given the wrong arguments: ${parsed.error.message.slice(0, 400)}` }], isError: true }
    }
    try {
      return await def.handler(parsed.data as never, {})
    } catch (err) {
      return { content: [{ type: 'text', text: `${name} failed: ${errText(err)}` }], isError: true }
    }
  }

  /** The tool definitions themselves. One list, served in-process and over the brain link. */
  private forgeToolDefs(): ForgeToolDef[] {
    const text = (body: string): { content: Array<{ type: 'text'; text: string }> } => ({
      content: [{ type: 'text', text: body }]
    })

    return [
        tool(
          'get_app_state',
          'Read what is actually open in Forge right now: every project, the tabs and terminal panes in the active one, which pane is focused, and what each terminal is running. Call this before answering any question about the app, and again after run_app_action if you need to confirm what changed. Takes no arguments.',
          {},
          async () => text(await this.askRenderer('get_app_state', {}))
        ),

        tool(
          'run_app_action',
          [
            'Do something to Forge. Takes one argument, `action`, an object with a `kind` and that kind\'s fields.',
            '',
            'Layout:',
            '- {"kind":"open_tabs","profileId":"claude","count":3} — open N terminal tabs on a launch profile. N terminals is ONE action with count N, never N actions. Profile ids come from get_app_state; "pwsh" is a plain shell.',
            '- {"kind":"open_panes","profileId":"claude","count":1,"direction":"row"} — split the focused pane. row is side by side, column is stacked.',
            '- {"kind":"close_tab","which":"tab 1"} — close one tab and everything in it. DESTRUCTIVE: confirm first.',
            '- {"kind":"close_tabs","which":"all"} — close several. DESTRUCTIVE: confirm first.',
            '- {"kind":"close_pane","which":"terminal 3"} — close one pane. DESTRUCTIVE: confirm first.',
            '- {"kind":"focus_tab","index":2} — bring a tab forward. 1-based.',
            '- {"kind":"rename_tab","which":"tab 2","name":"notes"}',
            '- {"kind":"set_view","mode":"tabs"} — or "mosaic".',
            '',
            'Projects:',
            '- {"kind":"switch_project","name":"forge"} — make another project active.',
            '- {"kind":"create_project","name":"landing-page"} — make a folder and add it to the rail.',
            '- {"kind":"open_settings","section":"voice"}',
            '',
            'Work:',
            '- {"kind":"send_prompt","target":"terminal 2","text":"<the full brief>","submit":true} — hand a prompt to a terminal. `target` is spoken words: "terminal two", "the claude one", "this". Put the whole brief in `text`; never speak it aloud as well.',
            '- {"kind":"use_skill","name":"code-review","target":"terminal 1"} — type /name into a pane, unsubmitted.',
            '',
            'Media (these take seconds to minutes — say so before you start):',
            '- {"kind":"make_image","description":"...","count":1,"aspect":"16:9"}',
            '- {"kind":"edit_image","path":"...","instruction":"..."}',
            '- {"kind":"make_video","description":"...","aspect":"16:9","duration":6} — 4 to 8 seconds, and one to three minutes to make.',
            '',
            'The result tells you what actually happened, which is not always what you asked for — limits get hit and targets turn out to be ambiguous. Report the result, never the request.'
          ].join('\n'),
          {
            action: z
              .record(z.string(), z.unknown())
              .describe('The action object. Must have a "kind" field; see the tool description.')
          },
          async (args) => text(await this.askRenderer('run_app_action', args.action))
        ),

        tool(
          'get_project_memory',
          'Read what Forge has learned about the active project in earlier sessions — decisions made, standing preferences, what has been happening. Call this when the answer depends on history rather than on what is on screen. Takes no arguments.',
          {},
          async () => text(await this.askRenderer('get_project_memory', {}))
        ),

        tool(
          'remember',
          [
            'Write one fact into the active project’s memory, where the next session will read it back through get_project_memory.',
            'One plain fact per call, written for a session that saw none of this conversation: "Steve releases with the dist script, never electron-builder directly" — not "the thing we decided earlier".',
            'Use it when he says remember this, and whenever a decision or a standing preference surfaces that a later session would have to be told again. Never for chit-chat, and never for something get_app_state already shows — the memory is small and everything in it is read on every turn.'
          ].join('\n'),
          { note: z.string().describe('The fact, as one plain sentence') },
          async (args) => text(await this.askRenderer('remember', { note: args.note }))
        ),

        tool(
          'take_screenshot',
          'Look at the primary display as it is right now. Use this when Steve asks about something visible that is not app structure — a rendered page, an error on screen, a design he is pointing at — and to verify what a desktop action actually did. For questions about projects, tabs or panes use get_app_state instead; it is cheaper and exact.',
          {},
          async () => {
            if (!this.deps.captureScreen) {
              return text('Screen capture is not available in this build.')
            }
            try {
              const shot = await this.deps.captureScreen()
              if (!shot) return text('The screen could not be captured.')
              return {
                content: [{ type: 'image' as const, data: shot.base64, mimeType: shot.mime }]
              }
            } catch (err) {
              return text(`The screen could not be captured: ${errText(err)}`)
            }
          }
        ),

        /* ------------------------------------------------- the desktop (T2)
         *
         * Tier two: hands on the rest of the machine, not just Forge. Every
         * handler answers in a sentence — success or failure — because the
         * model reads it and then says it out loud; and every one catches its
         * own errors, because a rejected MCP handler is an exception in the
         * turn where "that failed because…" is a fact to carry on from.
         */

        tool(
          'list_desktop_apps',
          'Every application installed on this PC that the Start menu can launch — names to use with open_desktop_app. Call it when Steve asks what is installed or when open_desktop_app cannot find what he said. Takes no arguments.',
          {},
          async () => {
            try {
              const apps = await listDesktopApps()
              return text(apps.map((a) => a.name).join('\n') || 'No launchable apps were found.')
            } catch (err) {
              return text(`Could not list the installed apps: ${errText(err)}`)
            }
          }
        ),

        tool(
          'open_desktop_app',
          'Launch an installed application by name — "Spotify", "Google Chrome", "Notepad". Fuzzy: the spoken name is matched against what is installed, and the result says what actually launched, or lists the near-misses when nothing did. Report the result, not the request.',
          { name: z.string().describe('The app, as Steve said it') },
          async (args) => {
            // The hard guard: agents and consoles open inside Forge, never here.
            const refused = refuseAppLaunch(args.name)
            if (refused) return text(refused)
            try {
              return text(await launchDesktopApp(args.name))
            } catch (err) {
              return text(`Could not launch that: ${errText(err)}`)
            }
          }
        ),

        tool(
          'list_windows',
          'Every open window on the desktop right now — its title and the program it belongs to. Call this before focusing, typing into, or closing anything, and afterwards to confirm what changed. Takes no arguments.',
          {},
          async () => {
            try {
              const windows = await listOpenWindows()
              return text(
                windows.map((w) => `${w.title} — ${w.process}`).join('\n') || 'Nothing has a window open.'
              )
            } catch (err) {
              return text(`Could not list the windows: ${errText(err)}`)
            }
          }
        ),

        tool(
          'focus_window',
          'Bring an open window to the front, matched by its title or program name. Use list_windows first if unsure what is open.',
          { window: z.string().describe('Part of the window title or program name') },
          async (args) => {
            try {
              return text(await focusDesktopWindow(args.window))
            } catch (err) {
              return text(`Could not focus that window: ${errText(err)}`)
            }
          }
        ),

        tool(
          'type_into_window',
          [
            'Focus a window and type into it. `text` is typed literally, exactly as given. `keys` is for chords and special keys, in SendKeys syntax: {ENTER}, {TAB}, {ESC}, ^s is Ctrl+S, %{F4} is Alt+F4. Both may be given; text goes first.',
            'This presses real keys on the real desktop. Anything that could send a message, submit a form or discard work: say what you are about to type and get a yes before calling this.',
            'Afterwards, take_screenshot is how you check what actually happened.'
          ].join('\n'),
          {
            window: z.string().describe('Part of the window title or program name'),
            text: z.string().optional().describe('Literal text to type'),
            keys: z.string().optional().describe('Raw SendKeys sequence, e.g. {ENTER} or ^s')
          },
          async (args) => {
            try {
              return text(await sendKeysToWindow(args.window, args.text ?? '', args.keys ?? ''))
            } catch (err) {
              return text(`Could not type into that window: ${errText(err)}`)
            }
          }
        ),

        tool(
          'open_file_or_link',
          "Open a file or a folder with whatever Windows uses for it — a folder opens in Explorer. An http(s) link opens in Forge's built-in browser, never a desktop browser. Paths must exist; say so rather than inventing one.",
          { target: z.string().describe('An absolute path or an http(s) URL') },
          async (args) => {
            // Web pages go to Forge's browser; an agent or console is refused.
            const route = routeOpenTarget(args.target)
            if (route && 'refuse' in route) return text(route.refuse)
            if (route && 'web' in route) {
              const open = brainBrowserTools().find((t) => t.name === 'browser_open')
              if (!open) return text("Forge's browser is not available, so the link was not opened.")
              return open.handler({ url: route.web })
            }
            try {
              return text(await openDesktopTarget(args.target))
            } catch (err) {
              return text(`Could not open that: ${errText(err)}`)
            }
          }
        ),

        tool(
          'close_window',
          'Ask an open window to close — the same polite close the ✕ button sends, so unsaved work still prompts. DESTRUCTIVE: confirm with Steve before closing anything.',
          { window: z.string().describe('Part of the window title or program name') },
          async (args) => {
            try {
              return text(await closeDesktopWindow(args.window))
            } catch (err) {
              return text(`Could not close that window: ${errText(err)}`)
            }
          }
        ),

        /* ------------------------------- files, the machine, and itself (T3)
         *
         * Tier three: the join between the two above. The agent could ask the
         * bridge for an image and then had no way to say where it went, let
         * alone put it somewhere Steve would find it. See ./file-tools.ts —
         * every one of these answers in a sentence for the same reason the
         * desktop handlers do.
         */

        tool(
          'list_files',
          'See what is in a folder — with no argument, the folder where generated images and videos land. Returns absolute paths to hand to save_asset or open_file_or_link. Newest first, so the thing you just made is at the top.',
          { dir: z.string().optional().describe('An absolute folder path. Omit for the generated-media folder.') },
          async (args) => {
            try {
              // The default is resolved here, not in file-tools: only the host
              // knows the injected data dir, and under --data-dir the two differ.
              return text(await listFiles((args.dir ?? '').trim() || this.assetsDir()))
            } catch (err) {
              return text(`Could not read that folder: ${errText(err)}`)
            }
          }
        ),

        tool(
          'save_asset',
          [
            'Copy or move a file from one place to another. This is how a generated image or video gets out of the output folder and into a project, onto the Desktop, or anywhere else he asks for — make_image writes the file, list_files finds it, this puts it where he wanted it.',
            'Both paths must be absolute. `destination` may be a folder, in which case the file keeps its name, or the full path of the file to create. Missing folders are created.',
            'It will not land on top of an existing file: it says so instead. Only pass `overwrite` when Steve has actually said to overwrite it. `move` deletes the original, so ask before moving something he might want left where it is.'
          ].join('\n'),
          {
            source: z.string().describe('Absolute path of the file to copy or move'),
            destination: z.string().describe('Absolute path of the target folder, or of the file to create'),
            move: z.boolean().optional().describe('Move instead of copy — the original is gone afterwards'),
            overwrite: z.boolean().optional().describe('Replace an existing file. Only after Steve has said yes.')
          },
          async (args) => {
            try {
              return text(
                await saveAsset(args.source, args.destination, {
                  move: args.move ?? false,
                  overwrite: args.overwrite ?? false
                })
              )
            } catch (err) {
              return text(`Could not save that: ${errText(err)}`)
            }
          }
        ),

        tool(
          'write_file',
          [
            'Write a text file at an absolute path — a note, a brief, an answer from ask_gemini, a snippet he asked you to keep. Missing folders are created.',
            'Not for editing code inside a project a coding agent is working on. That is a job for send_prompt to a terminal, which has the context you do not.',
            'It will not land on top of an existing file: it says so instead. Only pass `overwrite` when Steve has actually said to overwrite it.'
          ].join('\n'),
          {
            path: z.string().describe('Absolute path of the file to write'),
            content: z.string().describe('The full text to write, UTF-8'),
            overwrite: z.boolean().optional().describe('Replace an existing file. Only after Steve has said yes.')
          },
          async (args) => {
            try {
              return text(await writeTextFile(args.path, args.content, { overwrite: args.overwrite ?? false }))
            } catch (err) {
              return text(`Could not write that file: ${errText(err)}`)
            }
          }
        ),

        tool(
          'run_command',
          [
            'Run one PowerShell command on this machine and read its output. For looking things up and small jobs a dedicated tool does not cover.',
            'Anything that deletes, installs, kills processes, or changes system state: say what you intend to run and get his yes first, every time.',
            'Never use it to bypass a refusal from another tool. It stops after thirty seconds and the output comes back truncated, so ask for something specific rather than everything.'
          ].join('\n'),
          {
            command: z.string().describe('One PowerShell command line'),
            cwd: z.string().optional().describe('Absolute folder to run it in. Must already exist.')
          },
          async (args) => {
            // The hard guard, in code rather than in the persona: no agent CLI,
            // no new console window, no web page in a desktop browser.
            const refused = refuseCommand(args.command)
            if (refused) return text(refused)
            try {
              return text(await runCommand(args.command, args.cwd))
            } catch (err) {
              return text(`Could not run that: ${errText(err)}`)
            }
          }
        ),

        tool(
          'describe_self',
          'What you actually are and what you can actually do, from live state rather than from memory. Call this whenever Steve asks what you are, what model you are running, or what you can do, and answer from what it says. Never guess at your own capabilities and never undersell them. Takes no arguments.',
          {},
          async () => text(this.selfDescription())
        ),

        ...brainBrowserTools().map((t) => tool(t.name, t.description, t.shape, t.handler)),
        // open_agent_pane, type_into_pane, help_prompt, read_pane — generated
        // from shared/brain-tools.ts, the same specs every brain gets.
        ...brainSpecTools((n, a) => this.askRenderer(n, a)).map((t) => tool(t.name, t.description, t.shape, t.handler)),
        ...brainHubTools((n, a) => this.askRenderer(n, a)).map((t) => tool(t.name, t.description, t.shape, t.handler))
    ] as ForgeToolDef[]
  }

  /**
   * The answer to "what are you".
   *
   * Built here rather than written into the persona because half of it is only
   * true of the live session — the model can change under a running app, and
   * the cwd comes from whichever project was active when the session opened.
   * Prose, no lists and no paths spoken as paths: the model reads this and then
   * has to say a version of it out loud.
   */
  /**
   * Where generated media really lands: the injected answer when Electron is
   * here to give one, file-tools' environment-based guess when it is not.
   */
  private assetsDir(): string {
    return this.deps.getAssetsDir?.() ?? defaultAssetsDir()
  }

  private selfDescription(): string {
    const route = this.route()
    const model = this.model || (route.kind === 'claude' ? route.model : route.model ?? CLI_BRAIN_NAME[route.brain])
    const cwd = this.cwd || this.wantedCwd || homedir()
    const engine =
      route.kind === 'claude'
        ? `one persistent Claude session running the ${model} model, living inside Forge's own main process rather than in a terminal, and authenticated by the claude login already on this machine — there is no API key anywhere in this`
        : route.brain === 'codex-cli'
          ? `one continuing Codex session${route.model ? ` on the ${route.model} model` : ''}, run hidden by Forge's main process rather than in a terminal, and signed in with the ChatGPT login Codex already has on this machine`
          : `one continuing Gemini CLI session, run hidden by Forge's main process rather than in a terminal, signed in with the Gemini CLI's own Google login, or with Forge's Gemini key when it has none`
    return [
      `You are Jarvis, the voice of Forge. You are ${engine}. The conversation is continuous: the same ` +
        `session hears every utterance until Forge closes. Your working directory is ${cwd}, and generated images ` +
        `and videos are saved to ${this.assetsDir()}.`,
      `Your tools, in groups. Forge itself: read the app's live state, act on tabs, panes, projects and prompts, ` +
        `read what the project remembers from earlier sessions and add to it, and take a screenshot of the screen. The desktop: ` +
        `list installed applications, launch one, list open windows, bring one to the front, type real keystrokes ` +
        `into it, open a file, folder or link, and close a window. Files: list what is in a folder, copy or move a ` +
        `file somewhere, write a text file, read a file, and find files by name or by what is inside them. The ` +
        `browser: a Chrome window of your own, with its own sign-ins — open a page, read it, click, type, and ` +
        `photograph it. The ` +
        `machine: run one PowerShell command and read what it printed. Media, through Gemini: make an image, edit ` +
        `an image, make a video, ask Gemini a question, and summarise a video. The web: search it, and fetch a page.`,
      `What you do not have: you cannot edit code directly. Changing a project is work for a coding agent in one of ` +
        `the terminals, which you brief with a prompt. New agents open inside Forge with open_agent_pane — never as a ` +
        `command or a window of their own.`
    ].join('\n\n')
  }

  /* --------------------------------------------------------------- options */

  /**
   * Everything the SDK needs to be a butler rather than a coding session.
   *
   * The permission posture is the part to read carefully. This agent runs
   * hands-free — there is nobody to answer a prompt, because the only
   * interface is a microphone — so "ask" must be impossible in both
   * directions:
   *
   *  - `tools` names the only built-ins that exist at all, and every one of
   *    them is read-only: Read, Glob, Grep, WebSearch, WebFetch. Bash, Edit and
   *    Write are not restricted, they are *absent*: the model cannot request
   *    what it was never given. Task (Agent) is the one addition, and it widens
   *    nothing: the only subagent it can reach is `researcher`, whose own tool
   *    list is those same five.
   *  - Writing files and running commands do exist — the agent would be useless
   *    without them — but only through our own tools: `write_file`,
   *    `save_asset` and `run_command`. That is a much narrower door than the
   *    built-ins. Each is one auditable function in ./file-tools.ts, each
   *    answers in a sentence rather than throwing, neither writer will land on
   *    an existing file unless it is told twice, and the confirm-first rules
   *    for anything destructive are written into the tool descriptions the
   *    model reads. There is still no Edit, no Write and no Bash.
   *  - `permissionMode: 'dontAsk'` denies anything not pre-approved instead of
   *    prompting. Not `bypassPermissions`, which would approve everything.
   *  - `allowedTools` is the pre-approval — our own MCP tools, the bridge's,
   *    and the read-only built-ins.
   *  - `canUseTool` denies the rest. Note the SDK warns that bare
   *    `allowedTools` entries auto-approve *before* this callback runs; that is
   *    the intended division of labour here. The allowlist says yes, the
   *    callback is the backstop that says no to everything else.
   */
  private options(model: string, cwd: string): Options {
    const servers: Record<string, McpServerConfig> = { forge: this.forgeServer() }
    // The same server every Claude pane gets, so the voice agent can generate
    // an image or ask Gemini without a second implementation of either.
    const bridge = this.deps.getBridgeServer?.() ?? null
    if (bridge) servers['forge-bridge'] = bridge

    const allowed = new Set([
      'Read',
      // Finding a file by its name or by what is in it, without a shell to do
      // it with. Both are read-only, which is why they are here and Bash is not.
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      // Delegation, under both of its names: the CLI calls this tool Agent and
      // keeps Task as a legacy alias for it. Naming both is cheap, and a
      // backstop that guessed the wrong one would deny the only tool that can
      // reach the researcher.
      'Task',
      'Agent',
      'mcp__forge__get_app_state',
      'mcp__forge__run_app_action',
      'mcp__forge__get_project_memory',
      'mcp__forge__remember',
      'mcp__forge__take_screenshot',
      'mcp__forge__focus_pane_by_name',
      'mcp__forge__list_panes_with_names',
      'mcp__forge__run_saved_prompt',
      'mcp__forge__show_on_canvas',
      'mcp__forge__list_desktop_apps',
      'mcp__forge__open_desktop_app',
      'mcp__forge__list_windows',
      'mcp__forge__focus_window',
      'mcp__forge__type_into_window',
      'mcp__forge__open_file_or_link',
      'mcp__forge__close_window',
      'mcp__forge__list_files',
      'mcp__forge__save_asset',
      'mcp__forge__write_file',
      'mcp__forge__run_command',
      'mcp__forge__describe_self',
      ...brainSpecAllowed(),
      ...BRAIN_BROWSER_ALLOWED,
      ...(bridge
        ? [
            'mcp__forge-bridge__make_image',
            'mcp__forge-bridge__edit_image',
            'mcp__forge-bridge__make_video',
            'mcp__forge-bridge__ask_gemini',
            'mcp__forge-bridge__summarize_video'
          ]
        : [])
    ])

    /**
     * The one subagent, and the reason Task is allowed at all.
     *
     * "What does this codebase do about X" is twenty greps and four long
     * reads — a minute of silence on a thread whose only interface is a
     * microphone. Handed to a subagent it costs one tool call, the
     * conversation stays live, and what comes back is the answer rather than
     * the search. Its own tools are the read-only five: a subagent has no
     * persona, no voice and nobody to ask, so it gets eyes and nothing else.
     */
    const agents: Record<string, AgentDefinition> = {
      researcher: {
        description:
          'Deep research and codebase reconnaissance — many searches and reads distilled into a short factual answer',
        prompt: [
          'You are the voice agent’s researcher. One question in, one answer out; there is no conversation here.',
          'Read and search as widely as the question needs. That breadth is the whole point of you: the thread that asked is talking to someone while you work.',
          'Answer in dense facts — paths, names, numbers, and what they mean — not in a description of how you looked. Markdown is fine; another agent reads this and nobody speaks it.',
          'Report only what you actually found. If the answer is not there, say so plainly: whatever you write will be repeated to a human as fact.',
          'You cannot change anything, and you are never being asked to.'
        ].join('\n'),
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
      }
    }

    const options: Options = {
      model,
      cwd,
      // A plain string, not the claude_code preset: this is a voice butler and
      // the preset is thousands of tokens of coding-agent instruction that
      // would fight every rule in the persona.
      systemPrompt: VOICE_PERSONA,
      // No CLAUDE.md, no settings.json, no project instructions. The prompt
      // stays lean and — because nothing machine-specific leaks in — cacheable.
      settingSources: [],
      maxTurns: MAX_TURNS,
      includePartialMessages: true,
      mcpServers: servers,
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Agent'],
      agents,
      allowedTools: [...allowed],
      permissionMode: 'dontAsk',
      canUseTool: async (name): Promise<PermissionResult> =>
        allowed.has(name)
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: `${name} is not available to the voice agent.` },
      stderr: (data: string) => {
        const line = data.trim()
        if (line) console.error(`[voice-agent:cli] ${line}`)
      }
    }

    // Normally unnecessary — the SDK ships its own CLI and resolves it fine on
    // Windows. This is the fallback for a machine where that lookup fails, and
    // it points at the same `claude` on PATH that every Forge pane runs.
    if (process.env['FORGE_VOICE_CLAUDE_PATH']) {
      options.pathToClaudeCodeExecutable = process.env['FORGE_VOICE_CLAUDE_PATH']
    } else if (process.env['FORGE_VOICE_CLAUDE_FROM_PATH'] === '1') {
      const exe = whichCommand('claude')
      if (exe) options.pathToClaudeCodeExecutable = exe
    }
    else {
      // An installed Forge's SDK lookup lands inside app.asar, which cannot be
      // executed; this is the same binary in app.asar.unpacked.
      const exe = claudeSdkExecutable()
      if (exe) options.pathToClaudeCodeExecutable = exe
    }

    return options
  }

  /** The cwd the live session is using. For diagnostics and the smoke test. */
  get sessionCwd(): string {
    return this.cwd
  }
}

/* ------------------------------------------------------------ link tools */

/** One tool as `tool()` makes it. The shapes differ per tool, so the list is loosely typed. */
type ForgeToolDef = SdkMcpToolDefinition<any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A zod-made JSON Schema, trimmed to what every CLI accepts: no `$schema`, and
 * no `propertyNames` (Gemini's function declarations reject it).
 */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '$schema' || k === 'propertyNames') continue
    out[k] = cleanSchema(v)
  }
  return out
}

/* ------------------------------------------------------------- narrowing */

/**
 * The text out of one streaming event, or ''.
 *
 * `BetaRawMessageStreamEvent` is a wide union owned by the API SDK, and only
 * one arm of it matters here. Narrowing structurally rather than importing the
 * whole beta type surface keeps this file's dependency on that package to the
 * shape it actually reads.
 */
function textDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const e = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } }
  if (e.type !== 'content_block_delta') return ''
  const delta = e.delta
  if (!delta || delta.type !== 'text_delta') return ''
  return typeof delta.text === 'string' ? delta.text : ''
}

/** `mcp__forge__run_app_action` → `run_app_action`. Nothing else changes. */
function shortToolName(name: string): string {
  const parts = name.split('__')
  return parts.length === 3 ? (parts[2] as string) : name
}

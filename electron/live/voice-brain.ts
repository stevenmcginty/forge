import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { createSdkMcpServer, query, tool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  clipLiveText,
  DEFAULT_LIVE_VOICE_MODEL,
  isLiveVoiceModel,
  liveJobStateWord,
  type LiveAskOpts,
  type LiveJobState
} from '@shared/live'
import { MAIN_AGENT_TOOL_SPECS } from '@shared/brain-tools'
import { zodShapeOf } from '../brain-tools-mcp'
import { capVoiceToolText } from '../voice-agent/host'
import {
  anthropicKeyOf,
  batchNewsText,
  ledgerNews,
  normaliseHistory,
  seenState,
  stateBlock,
  trimTurns,
  turnsWithoutThinking,
  voiceModelParams,
  voiceSdkThinking,
  type LiveNewsItem
} from './brain-helpers'
import { liveClaudeExecutable } from './claude-cli'
import type { LiveBrainContext, LiveVoiceBrain } from './types'

/**
 * Claude Live's quick voice brain (docs/live-agent-plan.md §2): it talks with
 * Steve, does only instant things itself, and hands real work to the
 * Conductor as ledger jobs.
 *
 * Two routes behind one `LiveVoiceBrain`, picked per turn by the key:
 *  - `ApiVoiceBrain` — the Messages API, streaming, with the Anthropic key
 *    from Settings. The persona and tools are a frozen, cached prefix; each
 *    turn's app state and ledger digest ride as a mid-conversation system
 *    message after his words, so the prefix never changes.
 *  - `SubscriptionVoiceBrain` — no key: one warm Agent SDK session on the
 *    claude login, the same model, the same tools. The state block goes in
 *    front of his words instead.
 *
 * Honesty is structural: the only way to "do" work is `delegate`, which
 * answers with the ledger job, and the persona forbids claiming anything the
 * ledger or a tool result does not show.
 *
 * News: the ledger is watched here. Needs-you goes out as a `news` event at
 * once; done and failed are gathered for a few seconds into one. The renderer
 * decides when to say them. Jobs on a pane are announced by the pane's
 * attention in ./index.ts, not here.
 */

/* ---------------------------------------------------------------- persona */

export const LIVE_VOICE_PERSONA = `You are Claude Live, the voice of Forge, a Windows app where Steve runs coding agents in terminals called panes. He talks, you answer out loud, and a speech synthesiser reads your words as you write them. He can talk over you; when he does, you stop.

# HOW YOU SOUND
- Warm, calm and plain, in British English, with contractions. Never stiff, never gushing.
- One or two short sentences unless he asks for more. Stop when you have answered.
- Open with a short clause of three to eight words; it is spoken while the rest is still being written.
- Never read a list, a table, a log, a path, a web address or code aloud. Give the one thing that matters and offer the rest.
- No markdown, no symbols, no headings. Say numbers and names the way a person would.
- Never say "certainly" or "of course", never repeat his words back, and never narrate yourself.
- If what he said was not meant for you, or nothing is worth saying, say nothing at all.

# WHAT YOU DO YOURSELF
Only instant things:
- get_app_state to see what is open, focus_pane to go to a pane, show_view to show him something he asked to see.
- pane_digest for a quick look at what a pane is saying.
- read_ledger for what the jobs are doing.
- delegate, steer and cancel to manage jobs.
Before any tool, say a short clause first, like "Sure, one sec." Then call it.

# WHAT THE CONDUCTOR DOES
Anything that takes real work goes to the Conductor with delegate: opening agents, writing or changing code, running tests, research, browsing, anything with more than a step or two. Write the brief properly, as if for a capable colleague who heard none of this: the goal, the project, what he said about it, constraints, and what done looks like. Then tell him in one line, like "I've asked the conductor to run the tests in koraos." The Conductor works in the background and its progress lands in the job ledger; you hear about it from there.
If he changes his mind about a job, use steer with that job. If he says stop, use cancel.
If he is clearly only thinking out loud, talk it through with him first; delegate when there is a job to do.

# THE LEDGER IS THE TRUTH
Turns may carry a FORGE RIGHT NOW block (the app) and a JOBS block (the ledger). The newest of each replaces any earlier one.
- Never say a job has started, finished, or that anything happened, unless the JOBS block, read_ledger or a tool result you have just received says so. After delegate returns OK, "I've asked the conductor" is true; "it's done" is true only when the ledger says Done.
- When he asks how something is going, answer from the ledger. If the ledger does not know, say so plainly.
- Call a job by its title, never by its id. Ids are for tools only.
- Never invent a project, a pane, a file or a job.

# SAFETY
You cannot type into panes, run commands, make projects or close anything yourself; those are the Conductor's, and Forge asks Steve on screen before anything risky. Never pretend otherwise.`

/* ------------------------------------------------------------------ setup */

type Ask = (name: string, args: unknown) => Promise<string>

/** What the voice brain needs from main. ./index.ts hands in the real ones; nothing here imports Electron. */
export interface VoiceBrainDeps {
  /** Run one Forge tool in the renderer: the voice agent's round trip (electron/voice-agent/ipc.ts). */
  askRenderer: Ask
  /** How long done news is gathered before it goes out. */
  newsWindowMs?: number
  /** How long a turn waits for a fresh app state before using the last one. */
  appStateWaitMs?: number
}

const NEWS_WINDOW_MS = 5000
const APP_STATE_WAIT_MS = 150
/** Tool rounds in one voice turn; instant tools need few. */
const MAX_ROUNDS = 6
const MAX_TOKENS = 2048
const TOOL_RESULT_MAX = 4000
const PANE_DIGEST_MAX_LINES = 40
/** A subscription turn with no result by now is ended, so every turn gets its one turn-end. */
const SUB_TURN_TIMEOUT_MS = 120_000

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The voice model from settings; anything unknown is the default. */
export function liveVoiceModelOf(ctx: LiveBrainContext): string {
  const m = ctx.settings().liveVoiceModel
  return isLiveVoiceModel(m) ? m : DEFAULT_LIVE_VOICE_MODEL
}

/* ------------------------------------------------------------------ tools */

interface LiveTool {
  name: string
  description: string
  shape: z.ZodRawShape
  run(args: Record<string, unknown>): Promise<string>
}

function jobDetail(ctx: LiveBrainContext, jobId: string): string {
  const job = ctx.ledger.get(jobId)
  if (!job) return `There is no job ${jobId}. read_ledger with no jobId lists them.`
  const where = [job.paneName ? `pane ${job.paneName}` : '', job.project ? `project ${job.project}` : ''].filter(Boolean).join(', ')
  return [
    `${job.title} — ${liveJobStateWord(job.state)}${where ? ` (${where})` : ''}${job.summary ? `: ${job.summary}` : ''}`,
    ...job.steps.slice(-8).map((s) => `- ${s.text}`)
  ].join('\n')
}

/** The instant tools, one list for both routes. Every answer is a sentence the model reads. */
function voiceTools(ctx: LiveBrainContext, ask: Ask): LiveTool[] {
  const showSpec = MAIN_AGENT_TOOL_SPECS.find((s) => s.name === 'show_view')
  const conductor = (): ReturnType<NonNullable<LiveBrainContext['conductor']>> => ctx.conductor?.() ?? null
  const tools: LiveTool[] = [
    {
      name: 'get_app_state',
      description:
        'What is open in Forge right now: every project, its terminals by name, what each runs and its state (working, needs you, done, idle). The FORGE RIGHT NOW block is usually enough; call this when you need it fresh. No arguments.',
      shape: {},
      run: async () => capVoiceToolText(await ask('get_app_state', {}), 'head')
    },
    {
      name: 'focus_pane',
      description: 'Go to one pane by its name ("Zeb"), or "the wall" or "the board". Only when he asks.',
      shape: { name: z.string().describe('The pane, by its name or as he said it') },
      run: async (a) => ask('focus_pane_by_name', { name: String(a['name'] ?? '') })
    },
    {
      name: 'read_ledger',
      description:
        'The job ledger: every job the Conductor and the panes are doing, needs-you first. With jobId, that one job and its latest steps.',
      shape: { jobId: z.string().optional().describe('Optional: one job, by id') },
      run: async (a) => {
        const id = typeof a['jobId'] === 'string' ? a['jobId'].trim() : ''
        return id ? jobDetail(ctx, id) : ctx.ledger.digest(3000)
      }
    },
    {
      name: 'pane_digest',
      description: `A quick look at one pane: its last lines (at most ${PANE_DIGEST_MAX_LINES}). For "what is Zeb saying". Never read it aloud; say what it means.`,
      shape: {
        target: z.string().describe('Which pane, by name or in words'),
        project: z.string().optional().describe('Optional: the project the pane is in, when it is not the one on screen'),
        lines: z.number().int().optional().describe(`How many lines, default 25, at most ${PANE_DIGEST_MAX_LINES}`)
      },
      run: async (a) => {
        const lines = Math.max(1, Math.min(PANE_DIGEST_MAX_LINES, Math.floor(Number(a['lines']) || 25)))
        const project = typeof a['project'] === 'string' && a['project'].trim() ? { project: a['project'] } : {}
        const text = await ask('read_pane', { target: String(a['target'] ?? ''), lines, ...project })
        return text.split('\n').slice(-(PANE_DIGEST_MAX_LINES + 1)).join('\n')
      }
    },
    {
      name: 'delegate',
      description:
        'Hand a job to the Conductor, which does it in the background and reports into the ledger. For anything that is more than an instant look. The answer says whether it took the job; it never means the job is done.',
      shape: {
        title: z.string().describe('A short title for the job, a few words, as he would call it'),
        brief: z.string().describe('The full brief: the goal, what he said, constraints, and what done looks like'),
        project: z.string().optional().describe('Optional: the project it is about, by name')
      },
      run: async (a) => {
        const c = conductor()
        if (!c) return 'FAILED: the Conductor is not running, so nothing was handed over.'
        const title = String(a['title'] ?? '').trim()
        const brief = String(a['brief'] ?? '').trim()
        if (!title || !brief) return 'FAILED: a job needs a title and a brief.'
        const project = typeof a['project'] === 'string' && a['project'].trim() ? a['project'].trim() : undefined
        const res = await c.delegate({ title, brief, ...(project ? { project } : {}), owner: 'conductor' })
        if (!res.ok || !res.jobId) return `FAILED: ${res.error ?? 'the Conductor did not take it.'}`
        const job = ctx.ledger.get(res.jobId)
        const waiting = job?.state === 'queued' ? ' It is waiting behind the job the Conductor is on now.' : ''
        return `OK: job ${res.jobId} "${title}" is with the Conductor.${waiting} It is not done; the ledger will say when it is.`
      }
    },
    {
      name: 'steer',
      description: 'Change a job that is under way: tell the Conductor what Steve wants different. jobId from the JOBS block or read_ledger.',
      shape: {
        jobId: z.string().describe('The job, by id'),
        text: z.string().describe('The change, in full')
      },
      run: async (a) => {
        const c = conductor()
        if (!c) return 'FAILED: the Conductor is not running.'
        const res = await c.steer(String(a['jobId'] ?? ''), String(a['text'] ?? ''))
        return res.ok ? 'OK: the Conductor has the change.' : `FAILED: ${res.error ?? 'it did not take it.'}`
      }
    },
    {
      name: 'cancel',
      description: 'Stop a job, when Steve says stop. jobId from the JOBS block or read_ledger.',
      shape: { jobId: z.string().describe('The job, by id') },
      run: async (a) => {
        const c = conductor()
        if (!c) return 'FAILED: the Conductor is not running.'
        const res = await c.cancel(String(a['jobId'] ?? ''))
        return res.ok ? 'OK: that job is stopped.' : `FAILED: ${res.error ?? 'it could not be stopped.'}`
      }
    }
  ]
  if (showSpec) {
    tools.splice(2, 0, {
      name: 'show_view',
      description: showSpec.description,
      shape: zodShapeOf(showSpec),
      run: async (a) => ask('show_view', a)
    })
  }
  return tools
}

/** A tool's answer, never empty and never longer than the voice budget. */
function toolText(text: string): string {
  const body = text.trim() ? text : 'Forge sent back no answer to that.'
  return body.length > TOOL_RESULT_MAX ? `${body.slice(0, TOOL_RESULT_MAX)}\n[Cut for length.]` : body
}

async function runLiveTool(tools: LiveTool[], name: string, input: unknown): Promise<{ text: string; error: boolean }> {
  const def = tools.find((t) => t.name === name)
  if (!def) return { text: `There is no tool called ${name}.`, error: true }
  const parsed = z.object(def.shape).safeParse(input ?? {})
  if (!parsed.success) return { text: `${name} was given the wrong arguments: ${parsed.error.message.slice(0, 300)}`, error: true }
  try {
    return { text: toolText(await def.run(parsed.data as Record<string, unknown>)), error: false }
  } catch (err) {
    return { text: `${name} failed: ${errText(err)}`, error: true }
  }
}

/* ----------------------------------------------------------- shared state */

/**
 * What both routes share: the context, the renderer round trip, the tools,
 * and the app state, fetched fresh each turn but never waited on for long —
 * a slow answer lands in the cache for the next turn.
 */
export class VoiceEnv {
  readonly ctx: LiveBrainContext
  readonly ask: Ask
  readonly tools: LiveTool[]
  private app = ''
  private readonly waitMs: number

  constructor(ctx: LiveBrainContext, deps: VoiceBrainDeps) {
    this.ctx = ctx
    this.ask = deps.askRenderer
    this.waitMs = deps.appStateWaitMs ?? APP_STATE_WAIT_MS
    this.tools = voiceTools(ctx, this.ask)
  }

  async state(): Promise<{ app: string; digest: string }> {
    const fresh = this.ask('get_app_state', {})
      .then((text) => {
        if (text.trim() && !/^Forge (did not answer|could not be reached)/.test(text)) this.app = text
      })
      .catch(() => undefined)
    await Promise.race([fresh, new Promise((resolve) => setTimeout(resolve, this.waitMs))])
    return { app: this.app, digest: this.ctx.ledger.digest(1500) }
  }

  emitSay(turnId: string, text: string, final: boolean): void {
    this.ctx.emit({ type: 'say', turnId, text, final })
  }

  emitEnd(turnId: string, ok: boolean, error?: string): void {
    this.ctx.emit({ type: 'turn-end', turnId, ok, ...(error ? { error } : {}) })
  }
}

/* -------------------------------------------------------------- API route */

type Msg = Anthropic.MessageParam

interface ApiTurn {
  turnId: string
  cancelled: boolean
  stream: { abort(): void } | null
  cancelled$: Promise<void>
  cancel(): void
  done: Promise<void>
  finish(): void
}

function newApiTurn(turnId: string): ApiTurn {
  let cancel = (): void => {}
  let finish = (): void => {}
  const cancelled$ = new Promise<void>((resolve) => (cancel = resolve))
  const done = new Promise<void>((resolve) => (finish = resolve))
  const turn: ApiTurn = {
    turnId,
    cancelled: false,
    stream: null,
    cancelled$,
    cancel: () => {
      turn.cancelled = true
      turn.stream?.abort()
      cancel()
    },
    done,
    finish
  }
  return turn
}

/** The Messages API route: streaming, cached prefix, append-only history. */
export class ApiVoiceBrain implements LiveVoiceBrain {
  private readonly env: VoiceEnv
  private client: Anthropic | null = null
  private clientKey = ''
  private turns: Msg[][] = []
  private seen = { app: '', digest: '' }
  private model = ''
  private active: ApiTurn | null = null
  /** A model that refused mid-conversation system messages: the block goes in front of his words instead. */
  private inlineState = false
  private readonly apiTools: Anthropic.Tool[]

  constructor(env: VoiceEnv) {
    this.env = env
    // Fixed order and fixed text: the tools are part of the cached prefix.
    this.apiTools = env.tools.map((t) => {
      const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>
      delete schema['$schema']
      return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool['input_schema'] }
    })
  }

  private clientFor(key: string): Anthropic {
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key })
      this.clientKey = key
    }
    return this.client
  }

  private system(): Anthropic.TextBlockParam[] {
    return [{ type: 'text', text: LIVE_VOICE_PERSONA, cache_control: { type: 'ephemeral' } }]
  }

  /** Write the persona and tools into the cache before the first turn (max_tokens 0, the documented pre-warm). */
  async start(): Promise<void> {
    const key = anthropicKeyOf(this.env.ctx.settings())
    if (!key) return
    const model = liveVoiceModelOf(this.env.ctx)
    try {
      await this.clientFor(key).messages.create({
        model,
        max_tokens: 0,
        system: this.system(),
        tools: this.apiTools,
        messages: [{ role: 'user', content: 'warmup' }],
        ...voiceModelParams(model)
      } as unknown as Anthropic.MessageCreateParamsNonStreaming)
    } catch (err) {
      console.error('[live] voice pre-warm failed:', errText(err))
    }
  }

  async stop(): Promise<void> {
    this.active?.cancel()
    this.turns = []
    this.seen = { app: '', digest: '' }
  }

  cancel(turnId: string): void {
    if (this.active && this.active.turnId === turnId) this.active.cancel()
  }

  /** True while a turn is in flight. */
  busy(): boolean {
    return this.active !== null
  }

  async ask(turnId: string, text: string, _opts: LiveAskOpts): Promise<void> {
    const prev = this.active
    if (prev) {
      prev.cancel()
      await prev.done
    }
    const turn = newApiTurn(turnId)
    this.active = turn
    try {
      await this.run(turn, text)
    } finally {
      if (this.active === turn) this.active = null
      turn.finish()
    }
  }

  private async run(turn: ApiTurn, text: string): Promise<void> {
    const { ctx } = this.env
    const key = anthropicKeyOf(ctx.settings())
    if (!key) {
      this.env.emitEnd(turn.turnId, false, 'There is no Anthropic key in Settings.')
      return
    }
    const model = liveVoiceModelOf(ctx)
    if (this.model && model !== this.model) {
      // Another model cannot use these thinking blocks; a leading run of them may go.
      this.turns = turnsWithoutThinking(this.turns)
    }
    this.model = model
    const client = this.clientFor(key)
    const sentAt = Date.now()
    const state = await this.env.state()
    const block = stateBlock(state.app, state.digest, this.seen)
    const added: Msg[] = []
    if (block && this.inlineState) added.push({ role: 'user', content: `[${block}]\n\n${text}` })
    else {
      added.push({ role: 'user', content: text })
      if (block) added.push({ role: 'system', content: block })
    }

    let said = false
    let first = 0
    let roundText = ''
    let ok = true
    let error: string | undefined
    try {
      for (let round = 0; round < MAX_ROUNDS && !turn.cancelled; round++) {
        roundText = ''
        const params = {
          model,
          max_tokens: MAX_TOKENS,
          system: this.system(),
          tools: this.apiTools,
          messages: normaliseHistory([...this.turns.flat(), ...added]),
          cache_control: { type: 'ephemeral' },
          ...voiceModelParams(model)
        }
        const stream = client.messages.stream(params as unknown as Anthropic.MessageStreamParams)
        turn.stream = stream
        stream.on('text', (delta: string) => {
          if (turn.cancelled || !delta) return
          // A new round after a tool: keep it apart from what was said before.
          const piece = !roundText && said && !/^\s/.test(delta) ? ` ${delta}` : delta
          roundText += delta
          if (!first) {
            first = Date.now()
            console.log(`[live] voice first-text ms=${first - sentAt} model=${model} route=api`)
          }
          said = true
          this.env.emitSay(turn.turnId, piece, false)
        })
        let message: Anthropic.Message
        try {
          message = await stream.finalMessage()
        } catch (err) {
          // Once, the first time: a model that will not take a system message mid-conversation.
          const refusedSystem =
            err instanceof Anthropic.BadRequestError && /role 'system'/i.test(err.message) && !this.inlineState && round === 0 && !said
          if (!refusedSystem) throw err
          this.inlineState = true
          const sys = added.findIndex((m) => m.role === 'system')
          if (sys >= 0) {
            added.splice(sys, 1)
            added[0] = { role: 'user', content: `[${block}]\n\n${text}` }
          }
          round--
          continue
        }
        turn.stream = null
        if (turn.cancelled) break
        const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        const runTools = message.stop_reason === 'tool_use' && uses.length > 0
        // A tool call cut off (max tokens, refusal) is never run, so it is never kept either.
        const content = runTools ? message.content : message.content.filter((b) => b.type !== 'tool_use')
        if (content.length) added.push({ role: 'assistant', content: content as Anthropic.ContentBlockParam[] })
        roundText = ''
        if (!runTools) break
        const results = await Promise.race([
          Promise.all(uses.map(async (u) => ({ u, r: await runLiveTool(this.env.tools, u.name, u.input) }))),
          turn.cancelled$.then(() => null)
        ])
        if (results === null) {
          // Every tool call keeps its result, or the next request is refused.
          added.push({
            role: 'user',
            content: uses.map((u) => ({
              type: 'tool_result' as const,
              tool_use_id: u.id,
              content: 'Steve talked over this before it came back; its outcome is unknown.'
            }))
          })
          break
        }
        added.push({
          role: 'user',
          content: results.map(({ u, r }) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: r.text, ...(r.error ? { is_error: true } : {}) }))
        })
      }
    } catch (err) {
      if (!turn.cancelled && !(err instanceof Anthropic.APIUserAbortError)) {
        ok = false
        error = errText(err)
        console.error('[live] voice turn failed:', error)
      }
    }
    // What he heard of a reply he talked over is what was said.
    if (roundText.trim()) added.push({ role: 'assistant', content: [{ type: 'text', text: roundText }] })
    this.record(added, state)
    if (said) this.env.emitSay(turn.turnId, '', true)
    this.env.emitEnd(turn.turnId, ok, error)
  }

  /** Keep the turn, append-only; a state block nobody answered goes, and is sent again next turn. */
  private record(added: Msg[], state: { app: string; digest: string }): void {
    const sys = added.findIndex((m) => m.role === 'system')
    if (sys >= 0 && added[sys + 1]?.role !== 'assistant') added.splice(sys, 1)
    else if (sys >= 0 || (this.inlineState && typeof added[0]?.content === 'string' && added[0].content.startsWith('[')))
      this.seen = seenState(state.app, state.digest)
    this.turns.push(added)
    const trimmed = trimTurns(this.turns)
    if (trimmed !== this.turns) {
      this.turns = trimmed
      this.seen = { app: '', digest: '' }
    }
  }
}

/* ------------------------------------------------------ subscription route */

interface SubTurn {
  turnId: string
  /** The user message's uuid; the result names it (`user_message_uuid`). */
  uuid: string
  ended: boolean
  timer: ReturnType<typeof setTimeout> | null
  said: boolean
  sentAt: number
  first: number
  resolve(): void
}

/**
 * No key: one warm Agent SDK session on the claude login, with the chosen
 * model and the same instant tools. Each user message carries a uuid and its
 * result names it, so a turn talked over is ended at once and its late
 * result is matched and swallowed rather than ending the next turn.
 */
export class SubscriptionVoiceBrain implements LiveVoiceBrain {
  private readonly env: VoiceEnv
  private session: Query | null = null
  private model = ''
  private readonly inbox: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closing = false
  private turns: SubTurn[] = []
  private seen = { app: '', digest: '' }

  constructor(env: VoiceEnv) {
    this.env = env
  }

  async start(): Promise<void> {
    this.ensure()
  }

  async stop(): Promise<void> {
    this.teardown('Claude Live stopped.')
  }

  busy(): boolean {
    return this.turns.some((t) => !t.ended)
  }

  cancel(turnId: string): void {
    const turn = this.turns.find((t) => t.turnId === turnId && !t.ended)
    if (!turn) return
    this.end(turn, true)
    void this.session?.interrupt().catch(() => undefined)
  }

  async ask(turnId: string, text: string, _opts: LiveAskOpts): Promise<void> {
    // A new turn talks over the one in flight.
    const live = this.turns.filter((t) => !t.ended)
    if (live.length) {
      for (const t of live) this.end(t, true)
      try {
        await this.session?.interrupt()
      } catch {
        /* already unwound */
      }
    }
    const model = liveVoiceModelOf(this.env.ctx)
    if (this.session && model !== this.model) this.teardown('The voice model changed.')
    this.ensure()
    if (!this.session) {
      this.env.emitEnd(turnId, false, 'The voice session could not start.')
      return
    }
    const state = await this.env.state()
    const block = stateBlock(state.app, state.digest, this.seen)
    this.seen = seenState(state.app, state.digest)
    await new Promise<void>((resolve) => {
      const uuid = randomUUID()
      const turn: SubTurn = { turnId, uuid, ended: false, timer: null, said: false, sentAt: Date.now(), first: 0, resolve }
      turn.timer = setTimeout(() => {
        if (turn.ended) return
        this.end(turn, false, 'The voice turn took too long.')
        void this.session?.interrupt().catch(() => undefined)
      }, SUB_TURN_TIMEOUT_MS)
      this.turns.push(turn)
      this.inbox.push({
        type: 'user',
        message: { role: 'user', content: block ? `[${block}]\n\n${text}` : text },
        parent_tool_use_id: null,
        uuid: uuid as SDKUserMessage['uuid']
      })
      this.flush()
    })
  }

  private end(turn: SubTurn, ok: boolean, error?: string): void {
    if (turn.ended) return
    turn.ended = true
    if (turn.timer) clearTimeout(turn.timer)
    turn.timer = null
    if (turn.said) this.env.emitSay(turn.turnId, '', true)
    this.env.emitEnd(turn.turnId, ok, error)
    turn.resolve()
  }

  private flush(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

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

  private teardown(why: string): void {
    this.closing = true
    const q = this.session
    this.session = null
    this.model = ''
    this.inbox.length = 0
    this.flush()
    for (const t of this.turns) this.end(t, false, why)
    this.turns = []
    this.seen = { app: '', digest: '' }
    if (q) void Promise.resolve(q.return(undefined)).catch(() => undefined)
  }

  private options(model: string): Options {
    const tools = this.env.tools
    const server = createSdkMcpServer({
      name: 'live',
      version: '1.0.0',
      alwaysLoad: true,
      tools: tools.map((t) =>
        tool(t.name, t.description, t.shape, async (args) => {
          const r = await runLiveTool(tools, t.name, args)
          return { content: [{ type: 'text' as const, text: r.text }], ...(r.error ? { isError: true } : {}) }
        })
      )
    })
    const allowed = new Set(tools.map((t) => `mcp__live__${t.name}`))
    const options: Options = {
      model,
      systemPrompt: LIVE_VOICE_PERSONA,
      settingSources: [],
      maxTurns: MAX_ROUNDS + 2,
      includePartialMessages: true,
      mcpServers: { live: server },
      tools: [],
      allowedTools: [...allowed],
      permissionMode: 'dontAsk',
      canUseTool: async (name) =>
        allowed.has(name) ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: `${name} is not available here.` },
      effort: 'low',
      stderr: (data: string) => {
        const line = data.trim()
        if (line) console.error(`[live:voice-cli] ${line}`)
      }
    }
    const thinking = voiceSdkThinking(model)
    if (thinking) options.thinking = thinking
    const exe = liveClaudeExecutable()
    if (exe) options.pathToClaudeCodeExecutable = exe
    return options
  }

  private ensure(): void {
    if (this.session) return
    const model = liveVoiceModelOf(this.env.ctx)
    this.closing = false
    let q: Query
    try {
      q = query({ prompt: this.input(), options: this.options(model) })
    } catch (err) {
      console.error('[live] the voice session could not start:', errText(err))
      return
    }
    this.session = q
    this.model = model
    void this.consume(q)
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (q !== this.session) return
        this.onMessage(message)
      }
      if (q === this.session) this.teardown('The voice session closed unexpectedly.')
    } catch (err) {
      if (q === this.session) this.teardown(`The voice session failed: ${errText(err)}`)
    }
  }

  /** The turn the session is answering now: the newest, since a new one always ends the one before. */
  private head(): SubTurn | undefined {
    const last = this.turns[this.turns.length - 1]
    return last && !last.ended ? last : undefined
  }

  private onMessage(message: SDKMessage): void {
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) return
      const e = message.event as { type?: string; delta?: { type?: string; text?: unknown } }
      if (e.type !== 'content_block_delta' || e.delta?.type !== 'text_delta' || typeof e.delta.text !== 'string') return
      const turn = this.head()
      if (!turn || !e.delta.text) return
      if (!turn.first) {
        turn.first = Date.now()
        console.log(`[live] voice first-text ms=${turn.first - turn.sentAt} model=${this.model} route=subscription`)
      }
      turn.said = true
      this.env.emitSay(turn.turnId, e.delta.text, false)
      return
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      // Text in one assistant message, then a tool: keep the next words apart.
      const turn = this.head()
      if (turn && turn.said && message.message.content.some((b) => b.type === 'tool_use')) {
        this.env.emitSay(turn.turnId, ' ', false)
      }
      return
    }
    if (message.type === 'result') {
      // By the uuid it names; an older CLI that names none answers in order.
      const named = (message as { user_message_uuid?: string }).user_message_uuid
      let at = named ? this.turns.findIndex((t) => t.uuid === named) : -1
      if (at < 0) at = this.turns.length ? 0 : -1
      if (at < 0) return
      const turn = this.turns[at]!
      for (const t of this.turns.splice(0, at + 1)) if (t !== turn) this.end(t, true)
      this.end(turn, !message.is_error, message.is_error ? `The voice turn ended with ${message.subtype}.` : undefined)
    }
  }
}

/* ------------------------------------------------------------------ news */

/**
 * Ledger changes Steve should hear (./brain-helpers.ts `ledgerNews`):
 * needs-you at once, done and failed gathered for a few seconds into one
 * `news` event. Speaking them is the renderer's call.
 */
export class LiveNewsQueue {
  private readonly ctx: LiveBrainContext
  private readonly windowMs: number
  private prev = new Map<string, LiveJobState>()
  private pending: LiveNewsItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private off: (() => void) | null = null
  private seq = 0

  constructor(ctx: LiveBrainContext, windowMs = NEWS_WINDOW_MS) {
    this.ctx = ctx
    this.windowMs = windowMs
  }

  start(): void {
    if (this.off) return
    this.prev = new Map(this.ctx.ledger.snapshot().jobs.map((j) => [j.id, j.state]))
    this.off = this.ctx.ledger.subscribe((snap) => {
      const { items, next } = ledgerNews(this.prev, snap)
      this.prev = next
      for (const item of items) this.push(item)
    })
  }

  stop(): void {
    this.off?.()
    this.off = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
  }

  private push(item: LiveNewsItem): void {
    if (item.urgency === 'needs-you') {
      this.ctx.emit({ type: 'news', id: `live-news-${++this.seq}`, jobId: item.jobId, text: item.text, urgency: 'needs-you' })
      return
    }
    this.pending.push(item)
    this.timer ??= setTimeout(() => this.flush(), this.windowMs)
  }

  private flush(): void {
    this.timer = null
    const items = this.pending
    this.pending = []
    if (!items.length) return
    const jobId = items.length === 1 ? items[0]!.jobId : undefined
    this.ctx.emit({
      type: 'news',
      id: `live-news-${++this.seq}`,
      ...(jobId ? { jobId } : {}),
      text: clipLiveText(batchNewsText(items), 600),
      urgency: 'done'
    })
  }
}

/* ---------------------------------------------------------------- the brain */

/**
 * The voice brain ./index.ts runs: the API route when Settings has an
 * Anthropic key, the subscription route when it does not — decided per turn,
 * so adding the key takes effect on the next thing he says.
 */
export function createVoiceBrain(ctx: LiveBrainContext, deps: VoiceBrainDeps): LiveVoiceBrain {
  const env = new VoiceEnv(ctx, deps)
  const api = new ApiVoiceBrain(env)
  const sub = new SubscriptionVoiceBrain(env)
  const news = new LiveNewsQueue(ctx, deps.newsWindowMs)
  news.start()
  const route = (): ApiVoiceBrain | SubscriptionVoiceBrain => (anthropicKeyOf(ctx.settings()) ? api : sub)
  return {
    async start() {
      news.start()
      await route().start()
    },
    async stop() {
      news.stop()
      await Promise.allSettled([api.stop(), sub.stop()])
    },
    async ask(turnId, text, opts) {
      const brain = route()
      const other = brain === api ? sub : api
      if (other.busy()) await other.stop()
      await brain.ask(turnId, text, opts)
    },
    cancel(turnId) {
      api.cancel(turnId)
      sub.cancel(turnId)
    }
  }
}


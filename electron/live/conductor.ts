import { tool, type HookCallback, type McpServerConfig, type PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DEFAULT_LIVE_CONDUCTOR_MODEL, isLiveConductorModel, isLiveJobFinished, type LiveActionResult } from '@shared/live'
import type { VoiceAgentEvent } from '@shared/types'
import { VoiceAgentHost, type ForgeToolDef, type VoiceAgentShot } from '../voice-agent/host'
import { CONDUCTOR_PERSONA } from '../voice-agent/persona'
import { liveClaudeExecutable } from './claude-cli'
import { conductorBrief, conductorSteer, describeToolStep, jobsLostInRestart, paneOpenedIn, toolResponseText } from './brain-helpers'
import type { LiveBrainContext, LiveConductor, LiveJobSpec } from './types'

/**
 * Claude Live's Conductor (docs/live-agent-plan.md §3): the deep worker. One
 * warm Agent SDK session — the voice agent's own host (../voice-agent/host.ts)
 * with a Conductor profile: its persona, the Live Conductor model at high
 * effort, every Forge tool and guard the voice agent has, plus `report`.
 *
 * Jobs come from the voice brain's `delegate`. Each is a ledger job first
 * (queued), then a user message tagged with its id; the session works one at
 * a time and the rest wait, saying so in the ledger. Progress reaches the
 * ledger two ways: `report` (the model's own words) and a PostToolUse hook
 * that writes one short step per tool call. A coding job is handed to an
 * agent pane: the hook records the pane on the job, and from then on the
 * pane's attention (./index.ts) moves it.
 *
 * Turn accounting: every message sent to the session is counted, every
 * result uncounted; the job's turn is over when the count is back to zero.
 * Steering a running job interrupts it and sends the change, so each message
 * has its own result.
 */

type Ask = (name: string, args: unknown) => Promise<string>

/**
 * Everything the Conductor cannot work out itself. ./index.ts hands in the
 * real ones; the smoke run hands in doubles. Nothing here imports Electron.
 */
export interface ConductorDeps {
  /** Run one Forge tool in the renderer: the voice agent's round trip (electron/voice-agent/ipc.ts). */
  askRenderer: Ask
  /** The forge-bridge MCP server, read at each session start. Absent or null = none. */
  bridgeServer?: () => McpServerConfig | null
  captureScreen?: () => Promise<VoiceAgentShot | null>
  getAssetsDir?: () => string
  getChromeProfileDir?: () => string
  isForgeMinimised?: () => boolean
  /** How long a stop waits for the interrupted turn's result before moving on. */
  stopGraceMs?: number
}

const STOP_GRACE_MS = 10_000
/** Agentic turns per message: a job is long work, not a voice reply. */
const CONDUCTOR_MAX_TURNS = 200
/** Tools the Conductor must not have: the voice assistant reads the ledger. */
const CONDUCTOR_DENY = ['say_to_voice_agent'] as const

interface QueuedTurn {
  jobId: string
  text: string
}

export class Conductor implements LiveConductor {
  private readonly ctx: LiveBrainContext
  private readonly host: VoiceAgentHost
  private readonly stopGraceMs: number
  /** Messages waiting for the session, oldest first. */
  private queue: QueuedTurn[] = []
  /** The job the session is working on now. */
  private current: string | null = null
  /** Messages sent for the current job whose result has not come back. */
  private outstanding = 0
  /** The session's last words on the current job: its summary when it ends without a report. */
  private lastText = ''
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private wasBusy = false

  constructor(ctx: LiveBrainContext, deps: ConductorDeps) {
    this.ctx = ctx
    this.stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS
    const ask = deps.askRenderer

    // A restart killed the old session: its own unfinished jobs are lost; pane jobs carry on.
    for (const id of jobsLostInRestart(ctx.ledger.snapshot())) {
      ctx.ledger.addStep(id, 'Forge restarted, so the Conductor lost this job')
      ctx.ledger.setState(id, 'failed', 'Forge restarted before it finished')
    }

    let host: VoiceAgentHost | null = null
    host = new VoiceAgentHost({
      sendEvent: (event) => this.onEvent(event),
      // The renderer answers through the voice agent's own channel; the answer comes back here.
      sendToolRequest: (request) => {
        void ask(request.name, request.args).then(
          (text) => host?.resolveTool({ id: request.id, ok: true, result: text }),
          (err: unknown) => host?.resolveTool({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
        )
      },
      getModel: () => this.model(),
      getBridgeServer: () => deps.bridgeServer?.() ?? null,
      ...(deps.captureScreen ? { captureScreen: deps.captureScreen } : {}),
      ...(deps.getAssetsDir ? { getAssetsDir: deps.getAssetsDir } : {}),
      ...(deps.getChromeProfileDir ? { getChromeProfileDir: deps.getChromeProfileDir } : {}),
      ...(deps.isForgeMinimised ? { isForgeMinimised: deps.isForgeMinimised } : {}),
      profile: {
        persona: CONDUCTOR_PERSONA,
        model: () => this.model(),
        effort: 'high',
        maxTurns: CONDUCTOR_MAX_TURNS,
        capResults: true,
        deny: CONDUCTOR_DENY,
        extraTools: [this.reportTool()],
        hooks: { PostToolUse: [{ hooks: [this.stepHook] }] },
        executable: liveClaudeExecutable
      }
    })
    this.host = host
  }

  private model(): string {
    const m = this.ctx.settings().liveConductorModel
    return isLiveConductorModel(m) ? m : DEFAULT_LIVE_CONDUCTOR_MODEL
  }

  /* -------------------------------------------------------------- the API */

  /** Open the session now, so the first job does not wait for it. */
  async start(): Promise<void> {
    this.host.start({})
  }

  async stop(): Promise<void> {
    for (const q of this.queue) this.close(q.jobId, 'stopped', 'Claude Live was turned off')
    this.queue = []
    if (this.current) this.close(this.current, 'stopped', 'Claude Live was turned off')
    this.current = null
    this.outstanding = 0
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.host.stop()
    this.busyChanged()
  }

  busy(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  async delegate(spec: LiveJobSpec): Promise<LiveActionResult & { jobId?: string }> {
    const title = String(spec.title ?? '').trim()
    const brief = String(spec.brief ?? '').trim()
    if (!title) return { ok: false, error: 'A job needs a title.' }
    const job = this.ctx.ledger.createJob({
      title,
      owner: spec.owner ?? 'conductor',
      state: 'queued',
      summary: 'Waiting for the Conductor',
      ...(spec.project ? { project: spec.project } : {}),
      ...(spec.paneId ? { paneId: spec.paneId } : {}),
      ...(spec.paneName ? { paneName: spec.paneName } : {})
    })
    if (!job) return { ok: false, error: 'The ledger would not take the job.' }
    this.enqueue({ jobId: job.id, text: conductorBrief(job, brief) })
    return { ok: true, jobId: job.id }
  }

  async steer(jobId: string, text: string): Promise<LiveActionResult> {
    const job = this.ctx.ledger.get(jobId)
    if (!job) return { ok: false, error: 'No such job.' }
    const change = String(text ?? '').trim()
    if (!change) return { ok: false, error: 'There was no change to pass on.' }
    if (isLiveJobFinished(job.state)) return { ok: false, error: `That job is ${job.state === 'done' ? 'already done' : job.state}.` }
    this.ctx.ledger.addStep(jobId, `Steve: ${change}`)
    const message = conductorSteer(job, change)
    if (jobId === this.current) {
      // Into the turn it is on: stop it there, then the change is the next message.
      this.outstanding++
      void this.host.interrupt().finally(() => this.host.sendUtterance(message))
      return { ok: true }
    }
    const waiting = this.queue.find((q) => q.jobId === jobId)
    if (waiting) {
      waiting.text = `${waiting.text}\n\nSteve has since added: ${change}`
      return { ok: true }
    }
    // A job handed to a pane, or waiting on Steve: a fresh turn for it.
    this.enqueue({ jobId, text: message })
    return { ok: true }
  }

  async cancel(jobId: string): Promise<LiveActionResult> {
    const job = this.ctx.ledger.get(jobId)
    if (!job) return { ok: false, error: 'No such job.' }
    this.queue = this.queue.filter((q) => q.jobId !== jobId)
    this.close(jobId, 'stopped', 'Stopped')
    if (jobId === this.current) {
      // The interrupted turn's result ends it; if none comes, move on anyway.
      void this.host.interrupt().then((ok) => {
        if (!ok) this.endTurn()
      })
      this.stopTimer ??= setTimeout(() => {
        this.stopTimer = null
        if (this.current === jobId) this.endTurn()
      }, this.stopGraceMs)
    }
    this.busyChanged()
    return { ok: true }
  }

  /* ------------------------------------------------------------ the queue */

  private enqueue(turn: QueuedTurn): void {
    this.queue.push(turn)
    if (this.current) {
      const now = this.ctx.ledger.get(this.current)
      const job = this.ctx.ledger.get(turn.jobId)
      if (job && job.state === 'queued') this.ctx.ledger.addStep(turn.jobId, `Waiting behind "${now?.title ?? 'another job'}"`)
    }
    this.pump()
    this.busyChanged()
  }

  /** Start the next waiting message, if the session is free. */
  private pump(): void {
    while (!this.current && this.queue.length) {
      const next = this.queue.shift()!
      const job = this.ctx.ledger.get(next.jobId)
      if (!job || job.state === 'stopped' || job.state === 'failed') continue
      this.current = job.id
      this.outstanding = 1
      this.lastText = ''
      if (job.state !== 'running') this.ctx.ledger.setState(job.id, 'running', 'The Conductor is on it')
      const status = this.host.sendUtterance(next.text)
      if (!status.running) {
        this.current = null
        this.outstanding = 0
        this.close(job.id, 'failed', status.error || 'The Conductor session could not start')
      }
    }
    this.busyChanged()
  }

  /** The current job's turn is over: settle the job if the model did not, then the next. */
  private endTurn(failure?: string): void {
    const id = this.current
    this.current = null
    this.outstanding = 0
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
    const job = id ? this.ctx.ledger.get(id) : null
    if (job && job.state === 'running') {
      const said = this.lastText.trim()
      if (failure) this.close(job.id, 'failed', failure)
      else if (job.paneId) {
        // Handed to a pane: it is still working, and the pane's attention will say when it stops.
        this.ctx.ledger.updateJob(job.id, { summary: `Working in ${job.paneName || 'its pane'}` })
      } else this.close(job.id, 'done', said || 'Finished')
    }
    this.pump()
  }

  /** A final state with its last step. Never moves a stopped job (the ledger refuses that anyway). */
  private close(jobId: string, state: 'done' | 'failed' | 'stopped', summary: string): void {
    const job = this.ctx.ledger.get(jobId)
    if (!job || isLiveJobFinished(job.state)) return
    this.ctx.ledger.addStep(jobId, summary)
    this.ctx.ledger.setState(jobId, state, summary)
  }

  private busyChanged(): void {
    const busy = this.busy()
    if (busy === this.wasBusy) return
    this.wasBusy = busy
    this.ctx.statusChanged?.()
  }

  /* ------------------------------------------------------- session events */

  private onEvent(event: VoiceAgentEvent): void {
    switch (event.type) {
      case 'assistant':
        if (this.current && event.text.trim()) this.lastText = event.text.trim().split('\n').pop() ?? ''
        return
      case 'result':
        if (!this.current) return
        this.outstanding = Math.max(0, this.outstanding - 1)
        if (this.outstanding === 0) this.endTurn(event.ok ? undefined : event.text?.trim() || 'The Conductor hit an error')
        return
      case 'error':
        console.error('[live] conductor:', event.message)
        // The session died under the job: it fails, and the next one reopens the session.
        if (this.current) this.endTurn(event.message)
        return
      default:
        return
    }
  }

  /* --------------------------------------------------------------- tools */

  private reportTool(): ForgeToolDef {
    return tool(
      'report',
      [
        'Write progress on a Claude Live job into the ledger, where Steve hears it. step is one short plain line.',
        'state ends or pauses the job: done, failed, or needs-you (you need Steve; say what in step). Omit state for progress.'
      ].join(' '),
      {
        jobId: z.string().describe('The job id from the [Job …] line'),
        step: z.string().describe('One short line: what happened, or what you need'),
        state: z.enum(['running', 'needs-you', 'done', 'failed']).optional().describe('Optional: the job’s new state')
      },
      async (args) => {
        const reply = (text: string): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text', text }] })
        const job = this.ctx.ledger.get(args.jobId)
        if (!job) return reply(`There is no job ${args.jobId}. Use the id from the [Job …] line.`)
        if (job.state === 'stopped') return reply('Steve stopped this job. Stop working on it now and end your turn.')
        this.ctx.ledger.addStep(job.id, args.step)
        if (args.state) this.ctx.ledger.setState(job.id, args.state, args.step)
        return reply(`OK: written to the ledger${args.state ? `; the job is ${args.state} now` : ''}.`)
      }
    ) as ForgeToolDef
  }

  /** One ledger step per main-thread tool call of the current job; an opened pane is recorded on the job. */
  private readonly stepHook: HookCallback = async (input) => {
    try {
      const post = input as PostToolUseHookInput
      if (post.hook_event_name !== 'PostToolUse' || post.agent_id || !this.current) return {}
      const id = this.current
      const step = describeToolStep(post.tool_name, post.tool_input)
      if (step) this.ctx.ledger.addStep(id, step)
      if (post.tool_name.endsWith('__open_agent_pane')) {
        const pane = paneOpenedIn(toolResponseText(post.tool_response))
        if (pane) this.ctx.ledger.updateJob(id, { paneId: pane.paneId, ...(pane.paneName ? { paneName: pane.paneName } : {}) })
      }
    } catch (err) {
      console.error('[live] conductor step hook failed:', err)
    }
    return {}
  }
}

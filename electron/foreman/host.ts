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
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  FOREMAN_LOG_MAX,
  FOREMAN_PLAN_MAX,
  FOREMAN_PLAN_MIN,
  FOREMAN_STEP_TITLE_MAX,
  type ForemanStep,
  FOREMAN_LOG_TEXT_MAX,
  FOREMAN_SEED_MAX,
  idleForemanState,
  type ForemanLogEntry,
  type ForemanSayRequest,
  type ForemanStartRequest,
  type ForemanState,
  type ForemanStatus
} from '@shared/foreman'
import type { AttentionEvent } from '../attention-bus'
import { FOREMAN_PERSONA } from './persona'

/**
 * Foreman: one Claude Agent SDK session per driven pane, whose only hands are
 * the pane's keyboard.
 *
 * The voice agent next door (../voice-agent/host.ts) is the pattern this
 * follows — a persistent `query()` fed by an async-generator inbox, in-process
 * MCP tools, no API key, injected deps so it can be driven head-less. What is
 * different is the shape of the conversation:
 *
 *  - **The turns are not a person's.** Nobody types at Foreman. A turn is
 *    pushed at it by an *event*: the seed that started the job, or the
 *    renderer noticing that the pane is asking a question or has gone quiet
 *    (see ../attention-bus.ts). Between those it sits with an open session and
 *    an empty inbox, which is why the inbox generator parks rather than ends.
 *
 *  - **One session per pane, not one per app.** Two panes being driven are two
 *    unrelated jobs; sharing a session would mean each turn arrived with the
 *    other job's context in front of it.
 *
 *  - **It changes the world through a terminal.** There is no Bash, no Write
 *    and no Edit here, and that is not a hedge: everything Foreman does lands
 *    as text typed into a real Claude Code pane, where a person can watch it,
 *    stop it and undo it. Take that away and Foreman becomes an unattended
 *    agent with a shell, which is a different and much worse product.
 *
 * ## The seam that makes this testable
 *
 * `callTool` is public. The MCP handlers below are one line each and all of
 * them delegate to it, so scripts/foreman-check.mjs can drive the whole loop —
 * answer a question, debounce an idle, finish a job — without an SDK
 * subprocess, and it is the same code path the real brain takes. `openQuery` is
 * the other half of that seam: pass one in and the check supplies a stub brain,
 * leave it out and it is `query()`.
 *
 * ## Auth
 *
 * No API key, here or anywhere below it. The SDK resolves the machine's
 * existing `claude` subscription login, the same credential the pane Foreman is
 * driving is already running on.
 */

/* ------------------------------------------------------------------ config */

/**
 * A job is long. The voice agent's 50 is a generous *utterance*; this is a
 * whole turn of a build — read the standing brief, read the pane, read the
 * transcript, think, type — and it happens hundreds of times over a job.
 */
const MAX_TURNS = 200

/** Matches every other model literal in Forge: an alias, not a pinned id. */
export const DEFAULT_FOREMAN_MODEL = 'opus'

/**
 * How much of a pane's screen goes into a turn.
 *
 * The replay buffer is up to 192 KB. All of it would be most of a context
 * window spent on a build log; the last few thousand characters are the
 * question, the menu and the error, which is the part that decides anything.
 */
const SCREEN_TAIL_MAX = 6000

/** How much recent assistant text `read_transcript` returns by default. */
const TRANSCRIPT_DEFAULT_MAX = 6000

/**
 * Quiet that arrives this soon after Foreman's own keystrokes is Foreman's own
 * echo, not the pane finishing.
 *
 * The renderer watches screen text: typing a line into a pane makes it print,
 * and a moment later stop printing, which looks exactly like a pane going
 * quiet. Acting on that would have Foreman answer its own message — the loop
 * that turns one instruction into forty. So a quiet transition inside this
 * window is dropped. A question (`asking`) is never dropped: the pane echoing
 * Foreman's text cannot produce one, and a menu that appeared this fast is a
 * real menu.
 */
export const OWN_SEND_QUIET_MS = 1500

/* ------------------------------------------------------------------- deps */

/** What Foreman can find out about a pane. See `liveSessions` in ../pty-host.ts. */
export interface ForemanPaneInfo {
  /** The PTY session id. */
  id: string
  /** The folder the pane launched in — where its Claude transcript is filed. */
  cwd: string
  projectName: string
  title: string
  /** The Claude session uuid Forge minted for this pane, or ''. */
  sessionId: string
  /** False for a plain shell — nothing was bootstrapped into it. */
  agent: boolean
}

/**
 * Everything the host cannot work out for itself. All of it is injected so
 * scripts/foreman-check.mjs can supply doubles.
 */
export interface ForemanDeps {
  /** Push one pane's state at whoever is drawing it. Must never throw. */
  sendState(state: ForemanState): void
  /**
   * Type into a pane. The text arrives exactly as given, Enter included — the
   * host appends the carriage return itself, because whether a message is
   * submitted is a decision (Escape is not) and decisions belong here.
   */
  writePane(paneId: string, data: string): boolean
  /** The pane's recent screen, as a person would see it. */
  readScreen(paneId: string): string
  /** Recent assistant text from the pane's Claude transcript. Best-effort: '' is fine. */
  readTranscript(paneId: string, maxChars: number): string
  /** Null for a pane that is not running. */
  paneInfo(paneId: string): ForemanPaneInfo | null
  /** `settings.foremanModel`. Read per session start, so it can change. */
  getModel(): string
  /** `settings.foremanBrief` — Steve's standing house rules. */
  getStandingBrief(): string
  /**
   * The same renderer round trip the voice agent uses for `run_app_action`.
   * Only the renderer knows what is open, so opening a pane is a question
   * asked of it rather than something main can do alone.
   */
  runAppAction(action: Record<string, unknown>): Promise<string>
  /**
   * Every pane in the app right now. Optional, and the reason it exists: a
   * hired agent lands in a pane whose id nobody has told Foreman, and
   * `open_agent_pane` answers with the list so the next `send_to_pane` has
   * something to aim at.
   */
  listPanes?(): ForemanPaneInfo[]
  /**
   * The forge-bridge MCP server — make_image, ask_gemini and friends, the same
   * server Forge injects into Claude panes. Null when the bridge script cannot
   * be found, which is not an error.
   */
  getBridgeServer?(): McpServerConfig | null
  /**
   * The brain. Absent (every real run) it is the SDK's `query()`; supplied, it
   * is whatever the check hands over. See the seam note at the top.
   */
  openQuery?(options: Options, prompt: AsyncGenerator<SDKUserMessage>): Query
}

/* --------------------------------------------------------------- utilities */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The last `max` characters of a screen or a transcript. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/* -------------------------------------------------------- one driven pane */

/**
 * The bookkeeping for a single job.
 *
 * `pending` is the coalescing rule in one field: while a turn is in flight the
 * pane may ask three more things, and pushing all three would have Foreman
 * answering a question that has already scrolled away. The latest trigger wins
 * and the rest are dropped, because the screen tail it carries describes the
 * pane as it is *now*.
 */
interface Driven {
  state: ForemanState
  session: Query | null
  /** Turns waiting to be pulled by the input generator. */
  inbox: SDKUserMessage[]
  /** Resolves the generator's current await, when it is parked. */
  wake: (() => void) | null
  /** Set on stop so the generator returns instead of parking again. */
  closing: boolean
  /** A turn is in flight — the brain has been handed something and has not answered. */
  inFlight: boolean
  /** At most one queued trigger, latest wins. See the note above. */
  pending: Trigger | null
  /**
   * What Steve said while a turn was in flight. Never coalesced and never
   * dropped, unlike `pending`: a screen tail goes stale, a sentence from the
   * person paying for the job does not. Drained, all of it, into the turn that
   * follows the one in flight — ahead of anything the pane was about to ask.
   */
  notes: string[]
  /** Why the turn in flight was pushed — what a `send_to_pane` in it means. */
  trigger: Trigger['kind']
  /** `Date.now()` of the last thing Foreman typed into the driven pane. */
  lastSendAt: number
}

/**
 * One pushed turn: the text the brain is handed, why, and the line the footer
 * should show while it is being worked on.
 */
interface Trigger {
  kind: 'seed' | 'asking' | 'quiet' | 'human'
  text: string
  line: string
}

/* --------------------------------------------------------------- the host */

export class ForemanHost {
  private readonly deps: ForemanDeps
  private readonly panes = new Map<string, Driven>()

  constructor(deps: ForemanDeps) {
    this.deps = deps
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Switch Foreman on for one pane.
   *
   * Starting a pane that is already being driven is a no-op that returns what
   * is there: the toggle is a toggle, and a second start must not throw a
   * running job away and re-seed it.
   */
  start(request: ForemanStartRequest): ForemanState {
    const paneId = String(request?.paneId ?? '').trim()
    const seed = String(request?.seed ?? '')
      .trim()
      .slice(0, FOREMAN_SEED_MAX)
    if (!paneId) return idleForemanState('')

    const existing = this.panes.get(paneId)
    if (existing && existing.session) return existing.state

    const driven: Driven = {
      state: { paneId, status: 'starting', line: 'Reading the pane and forming the concept', seed, log: [] },
      session: null,
      inbox: [],
      wake: null,
      closing: false,
      inFlight: false,
      pending: null,
      notes: [],
      trigger: 'seed',
      lastSendAt: 0
    }
    this.panes.set(paneId, driven)
    this.log(driven, 'seed', seed || '(no seed)')

    if (!this.open(driven)) return driven.state
    this.push(driven, this.seedTurn(seed))
    return driven.state
  }

  /**
   * Switch Foreman off. The human has the keyboard again from this line on.
   *
   * Deliberately abrupt: the session is aborted mid-turn if it is mid-turn.
   * There is no "let it finish what it was saying", because what it was saying
   * was about to be typed into a terminal somebody has just taken back.
   */
  stop(paneId: string): ForemanState {
    const driven = this.panes.get(paneId)
    if (!driven) return idleForemanState(paneId)
    this.teardown(driven)
    driven.state.status = 'off'
    driven.state.line = 'Stopped — you have the keyboard'
    this.log(driven, 'note', 'Foreman was switched off; the pane is yours.')
    return driven.state
  }

  /**
   * A word from Steve, mid-job.
   *
   * The third input, after the seed and the pane — and the only one that is
   * never coalesced. Idle, it is the next turn straight away; mid-turn it is
   * held in `notes` and goes in the moment the turn ends, ahead of whatever
   * the pane queued, because the pane can be re-read and Steve cannot.
   *
   * A pane nobody is driving (off, done, error) comes back unchanged: the
   * renderer treats that as "start a new job with this line", which is the
   * intuitive thing for a sentence typed at a finished Foreman to mean, and
   * `start` is the honest way to do it.
   */
  say(request: ForemanSayRequest): ForemanState {
    const paneId = String(request?.paneId ?? '').trim()
    const text = String(request?.text ?? '')
      .trim()
      .slice(0, FOREMAN_SEED_MAX)
    const driven = this.panes.get(paneId)
    if (!driven || !driven.session || driven.closing || !text) return this.stateOf(paneId)
    if (driven.state.status === 'done' || driven.state.status === 'error') return driven.state

    this.log(driven, 'you', text)
    if (driven.inFlight) {
      driven.notes.push(text)
      // Same status, new line: the footer has to say the message landed and
      // when it will be read, or the next thing typed is the same message.
      this.setStatus(driven, driven.state.status, `Got it — acting on that after this step: ${firstLine(text)}`)
      return driven.state
    }
    this.push(driven, this.humanTurn([text], paneId))
    return driven.state
  }

  /** Every pane main is holding state for, driven or finished. */
  list(): ForemanState[] {
    return [...this.panes.values()].map((d) => d.state)
  }

  /** One pane's state, or the resting state for a pane nobody has driven. */
  stateOf(paneId: string): ForemanState {
    return this.panes.get(paneId)?.state ?? idleForemanState(paneId)
  }

  /** App is quitting. Every session goes with it. */
  dispose(): void {
    for (const driven of this.panes.values()) this.teardown(driven)
    this.panes.clear()
  }

  /* --------------------------------------------------------- the trigger */

  /**
   * The renderer noticed a pane change state. Foreman's only other input.
   *
   * `now` is a parameter with a default for the same reason it is one in
   * ../share-link.ts: the debounce is a timing rule, and a check that had to
   * sleep through it would be a check nobody runs.
   */
  noteAttention(event: AttentionEvent, now: number = Date.now()): void {
    const driven = this.panes.get(event?.paneId ?? '')
    if (!driven || !driven.session || driven.closing) return
    // A finished or failed job is not listening. The pane carries on printing
    // — a shell prompt, a `git status` somebody ran by hand — and none of it is
    // Foreman's business any more.
    if (driven.state.status === 'done' || driven.state.status === 'error') return

    if (event.state === 'asking') {
      this.push(driven, this.askingTurn(event.prompt, driven.state.paneId))
      return
    }
    if (event.state !== 'done' && event.state !== 'idle') return
    // Foreman's own keystrokes, echoed back. See OWN_SEND_QUIET_MS.
    if (now - driven.lastSendAt < OWN_SEND_QUIET_MS) return
    this.push(driven, this.quietTurn(driven.state.paneId))
  }

  /* ------------------------------------------------------------- the turns
   *
   * Four of them: a job starts, the pane asks something, the pane stops, or
   * Steve says something. Written out here rather than composed at the call
   * site so what the brain is actually handed is readable in one place.
   */

  private seedTurn(seed: string): Trigger {
    return {
      kind: 'seed',
      line: 'Brief taken — reading the pane and planning (this can take a few minutes)',
      text: [
        `Seed: ${seed}`,
        '',
        'Read the standing brief, read the pane, form the concept, write and send the full brief',
        '(start it with /gaffer when it is a build), instruct plan mode.',
        'Every decision in this job is yours.'
      ].join('\n')
    }
  }

  private askingTurn(prompt: string, paneId: string): Trigger {
    return {
      kind: 'asking',
      line: prompt ? `Answering: ${firstLine(prompt)}` : 'Answering the pane',
      text: [
        `The pane is asking: ${prompt}`,
        'Screen:',
        tail(this.screen(paneId), SCREEN_TAIL_MAX),
        '',
        'Answer it via send_to_pane. All decisions are yours.'
      ].join('\n')
    }
  }

  private quietTurn(paneId: string): Trigger {
    return {
      kind: 'quiet',
      line: 'Working out the next step',
      text: [
        'The pane went quiet.',
        'Screen:',
        tail(this.screen(paneId), SCREEN_TAIL_MAX),
        '',
        'If the job is not finished, send the next step; if a suite failed, make it fix it;',
        'if everything is genuinely done and verified, call finish.'
      ].join('\n')
    }
  }

  private humanTurn(notes: string[], paneId: string): Trigger {
    const said = notes.length === 1 ? `Steve says: ${notes[0]}` : `Steve says:\n${notes.map((n) => `- ${n}`).join('\n')}`
    return {
      kind: 'human',
      line: `Acting on: ${firstLine(notes[notes.length - 1] ?? '')}`,
      text: [
        said,
        '',
        'This is from the person the job is for, and it overrides the seed and the standing brief wherever they disagree.',
        'Screen:',
        tail(this.screen(paneId), SCREEN_TAIL_MAX),
        '',
        'Act on it now: if it changes the work, tell the pane via send_to_pane (interrupt it with Escape first if it is mid-task and the change cannot wait);',
        'if it answers something you were unsure of, use it; if it is only information, note it and carry on.',
        'Every decision is still yours.'
      ].join('\n')
    }
  }

  private screen(paneId: string): string {
    try {
      return this.deps.readScreen(paneId) || '(the pane has printed nothing)'
    } catch (err) {
      return `(the screen could not be read: ${errText(err)})`
    }
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Hand the brain a turn, or queue it.
   *
   * The coalescing rule lives here and nowhere else: one turn in flight, at
   * most one waiting, latest wins.
   */
  private push(driven: Driven, turn: Trigger): void {
    if (driven.closing || !driven.session) return
    if (driven.inFlight) {
      driven.pending = turn
      return
    }
    driven.inFlight = true
    driven.trigger = turn.kind
    driven.inbox.push({
      type: 'user',
      message: { role: 'user', content: turn.text },
      parent_tool_use_id: null
    })
    this.setStatus(driven, 'driving', turn.line)
    this.flush(driven)
  }

  private open(driven: Driven): boolean {
    const paneId = driven.state.paneId
    const info = this.deps.paneInfo(paneId)
    const model = this.deps.getModel().trim() || DEFAULT_FOREMAN_MODEL
    const options = this.options(model, info?.cwd ?? '', paneId)

    try {
      const prompt = this.input(driven)
      driven.session = this.deps.openQuery
        ? this.deps.openQuery(options, prompt)
        : query({ prompt, options })
    } catch (err) {
      this.fail(driven, `Foreman could not start: ${errText(err)}`)
      return false
    }

    void this.consume(driven, driven.session)
    return true
  }

  /**
   * The session's input side: an endless generator the SDK pulls from.
   *
   * Parking rather than ending is the whole trick, exactly as in the voice
   * host — a generator that returns ends the session, and this one has to
   * survive minutes of silence between a pane's question and the next.
   */
  private async *input(driven: Driven): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (driven.inbox.length) {
        if (driven.closing) return
        yield driven.inbox.shift() as SDKUserMessage
      }
      if (driven.closing) return
      await new Promise<void>((resolve) => {
        driven.wake = resolve
      })
    }
  }

  /** Wake the input generator if it is parked. */
  private flush(driven: Driven): void {
    const wake = driven.wake
    driven.wake = null
    if (wake) wake()
  }

  /**
   * Drain the session's output for as long as it lives.
   *
   * One loop for the whole job, not one per turn: with streaming input a
   * `result` message is a turn boundary and not the end of anything.
   */
  private async consume(driven: Driven, q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (q !== driven.session) return
        this.emit(driven, message)
      }
      if (q === driven.session && !driven.closing) {
        this.fail(driven, 'Foreman closed unexpectedly')
      }
    } catch (err) {
      if (q !== driven.session || driven.closing) return
      this.fail(driven, `Foreman failed: ${errText(err)}`)
    }
  }

  /** Turn one SDK message into whatever it means for the job. */
  private emit(driven: Driven, message: SDKMessage): void {
    if (message.type === 'assistant') {
      this.narrate(driven, message)
      return
    }
    if (message.type !== 'result') return
    // A turn boundary. Whatever was queued while it ran goes in now, and if
    // nothing was, the job is waiting on the pane again.
    driven.inFlight = false
    const queued = driven.pending
    driven.pending = null
    if (driven.state.status === 'done' || driven.state.status === 'error') return
    // Steve first, then the pane: what the pane queued describes a screen that
    // can be read again, and it will be — the human turn carries a fresh tail
    // and the model reads the pane before it answers anyway.
    if (driven.notes.length) {
      driven.pending = queued
      this.push(driven, this.humanTurn(driven.notes.splice(0), driven.state.paneId))
      return
    }
    if (queued) {
      this.push(driven, queued)
      return
    }
    this.setStatus(driven, 'waiting', 'Waiting for the pane')
  }

  /**
   * Keep the footer moving while a turn runs.
   *
   * A seed turn is minutes of reading and planning before the first thing is
   * typed into the pane, and a footer that says the same sentence for all of
   * it reads as "nothing happened". Each assistant message becomes one line:
   * the tool it is about to use, or the first line of what it is thinking.
   */
  private narrate(driven: Driven, message: Extract<SDKMessage, { type: 'assistant' }>): void {
    if (driven.state.status !== 'driving') return
    const content = (message.message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    let line = ''
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_use') {
        const name = String(block['name'] ?? '').replace(/^mcp__[^_]+__/, '')
        const input = (block['input'] ?? {}) as Record<string, unknown>
        line =
          name === 'read_transcript' || name === 'read_pane'
            ? 'Reading the pane'
            : name === 'send_to_pane'
              ? `Sending: ${firstLine(String(input['text'] ?? ''))}`
              : name === 'open_agent_pane'
                ? `Hiring ${String(input['profileId'] ?? 'an agent')}`
                : name === 'set_plan'
                ? 'Updating the plan'
                : name === 'get_standing_brief'
                  ? 'Reading the standing brief'
                  : name === 'Task'
                    ? 'Researching before writing the brief'
                    : name
                      ? `Using ${name}`
                      : ''
      } else if (block['type'] === 'text' && !line) {
        const text = firstLine(String(block['text'] ?? ''))
        if (text) line = `Thinking: ${text}`
      }
    }
    if (line && line !== driven.state.line) this.setStatus(driven, 'driving', line)
  }

  private teardown(driven: Driven): void {
    driven.closing = true
    const q = driven.session
    driven.session = null
    driven.inbox.length = 0
    driven.pending = null
    driven.notes.length = 0
    driven.inFlight = false
    // Unblock the generator so it can return and let the SDK close the
    // subprocess down cleanly.
    this.flush(driven)
    if (q) {
      // Both, and in this order: interrupt unwinds a turn that is mid-tool-call,
      // return() ends the session. A rejection from an already-dead session is
      // not news.
      void Promise.resolve(q.interrupt?.()).catch(() => undefined)
      void Promise.resolve(q.return(undefined)).catch(() => undefined)
    }
  }

  /**
   * The job died. Deliberately no restart.
   *
   * The voice agent restarts on a budget because the cost of being wrong is a
   * missed sentence. Here it is a half-finished build with an agent typing into
   * it: a session that respawns and re-reads a screen it has already acted on
   * would answer the same menu twice. It stops, it says so, and Steve restarts
   * it when he has looked.
   */
  private fail(driven: Driven, message: string): void {
    driven.session = null
    driven.inFlight = false
    driven.pending = null
    driven.notes.length = 0
    console.error(`[foreman] ${message}`)
    driven.state.status = 'error'
    driven.state.line = message
    this.log(driven, 'error', message)
  }

  private setStatus(driven: Driven, status: ForemanStatus, line: string): void {
    driven.state.status = status
    driven.state.line = line
    this.send(driven)
  }

  /** One line into the account, and a push. The log is capped oldest-first. */
  private log(driven: Driven, kind: ForemanLogEntry['kind'], text: string): void {
    driven.state.log.push({ at: Date.now(), kind, text: String(text ?? '').slice(0, FOREMAN_LOG_TEXT_MAX) })
    if (driven.state.log.length > FOREMAN_LOG_MAX) {
      driven.state.log.splice(0, driven.state.log.length - FOREMAN_LOG_MAX)
    }
    this.send(driven)
  }

  private send(driven: Driven): void {
    try {
      this.deps.sendState(driven.state)
    } catch (err) {
      console.error('[foreman] sendState failed:', err)
    }
  }

  /* ----------------------------------------------------------------- tools
   *
   * Every MCP handler below is one line and delegates here, so the check drives
   * the same code the brain does. See the seam note at the top of the file.
   */

  /**
   * Run one of Foreman's tools on behalf of the session driving `paneId`.
   *
   * Answers in a sentence rather than throwing, always: a rejected MCP handler
   * is an exception in the model's turn, whereas "that pane is not running" is
   * a fact it can act on.
   */
  async callTool(paneId: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const driven = this.panes.get(paneId)
    if (!driven) return 'Foreman is not driving that pane any more.'
    try {
      return await this.dispatch(driven, name, args)
    } catch (err) {
      return `That failed: ${errText(err)}`
    }
  }

  private async dispatch(driven: Driven, name: string, args: Record<string, unknown>): Promise<string> {
    const paneId = driven.state.paneId
    switch (name) {
      case 'read_pane': {
        const target = String(args['pane'] ?? '').trim() || paneId
        if (target !== paneId && !this.deps.paneInfo(target)) {
          return `There is no running pane with id ${target}.${this.paneList()}`
        }
        return tail(this.screen(target), SCREEN_TAIL_MAX)
      }

      case 'send_to_pane': {
        const target = String(args['pane'] ?? '').trim() || paneId
        const text = String(args['text'] ?? '')
        if (!text) return 'Nothing was sent: `text` was empty.'
        const submit = args['submit'] === undefined ? true : args['submit'] === true
        if (target !== paneId && !this.deps.paneInfo(target)) {
          return `There is no running pane with id ${target}. Nothing was sent.${this.paneList()}`
        }
        // The carriage return, not a newline: a PTY is a keyboard, and Enter is
        // \r on the wire. \n would be a line feed the shell does not read as a
        // submit.
        const ok = this.deps.writePane(target, submit ? `${text}\r` : text)
        if (!ok) return `The pane refused the write. Nothing was sent to ${target}.`
        if (target === paneId) {
          // Only the driven pane starts the debounce clock: what Foreman types
          // into a hired pane cannot echo back as this pane going quiet.
          driven.lastSendAt = Date.now()
          this.log(driven, this.sendKind(driven), text)
          this.setStatus(driven, driven.state.status, `Sent: ${firstLine(text)}`)
        } else {
          this.log(driven, 'note', `To ${target}: ${text}`)
        }
        return submit ? 'Sent, and Enter pressed.' : 'Sent, without Enter.'
      }

      case 'read_transcript': {
        const target = String(args['pane'] ?? '').trim() || paneId
        const max = clamp(args['max_chars'], 500, 40_000, TRANSCRIPT_DEFAULT_MAX)
        const text = this.deps.readTranscript(target, max)
        return text.trim() || 'There is no transcript for that pane yet.'
      }

      case 'open_agent_pane': {
        const profileId = String(args['profileId'] ?? '').trim()
        if (!profileId) return 'Nothing was opened: `profileId` was empty.'
        const count = clamp(args['count'], 1, 4, 1)
        const summary = await this.deps.runAppAction({
          kind: 'open_panes',
          profileId,
          count,
          direction: 'row',
          // Beside the driven pane, in its project — never wherever the human
          // happens to be looking by now.
          anchorPaneId: paneId
        })
        this.log(driven, 'hire', `${profileId} × ${count} — ${summary}`)
        return `${summary}${this.paneList()}`
      }

      case 'set_plan': {
        const raw = Array.isArray(args['steps']) ? (args['steps'] as unknown[]) : []
        const steps: ForemanStep[] = []
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue
          const r = item as Record<string, unknown>
          const title = String(r['title'] ?? '').trim().slice(0, FOREMAN_STEP_TITLE_MAX)
          if (!title) continue
          const id = String(r['id'] ?? '').trim() || `s${steps.length + 1}`
          if (steps.some((s) => s.id === id)) continue
          const status = r['status']
          const step: ForemanStep = {
            id,
            title,
            status: status === 'done' || status === 'failed' || status === 'active' ? status : 'pending'
          }
          const note = String(r['note'] ?? '').trim()
          if (note) step.note = note.slice(0, FOREMAN_STEP_TITLE_MAX * 2)
          steps.push(step)
        }
        if (steps.length < FOREMAN_PLAN_MIN || steps.length > FOREMAN_PLAN_MAX) {
          return `Nothing changed: a plan is ${FOREMAN_PLAN_MIN} to ${FOREMAN_PLAN_MAX} steps, and you sent ${steps.length}.`
        }
        // `active` names one step; every other step that is not finished is pending.
        const active = String(args['active'] ?? '').trim()
        if (active && !steps.some((s) => s.id === active)) {
          return `Nothing changed: no step has id "${active}". Steps: ${steps.map((s) => s.id).join(', ')}.`
        }
        if (active) {
          for (const s of steps) {
            if (s.status === 'done' || s.status === 'failed') continue
            s.status = s.id === active ? 'active' : 'pending'
          }
        } else if (steps.filter((s) => s.status === 'active').length > 1) {
          return 'Nothing changed: only one step can be active. Pass `active` with its id.'
        }
        return this.applyPlan(driven, steps)
      }

      case 'get_standing_brief': {
        const brief = this.deps.getStandingBrief().trim()
        return brief || 'There is no standing brief set; use your own judgement.'
      }

      case 'note': {
        const text = String(args['text'] ?? '').trim()
        if (!text) return 'Nothing was logged: `text` was empty.'
        this.log(driven, 'note', text)
        return 'Noted.'
      }

      case 'finish': {
        const summary = String(args['summary'] ?? '').trim() || 'The job is finished.'
        // Finishing closes whatever step was open: the plan a person reads
        // afterwards should not say "active" about a job that ended.
        if (driven.state.plan) {
          const closed = driven.state.plan.map((s) => (s.status === 'active' ? { ...s, status: 'done' as const } : s))
          this.applyPlan(driven, closed)
        }
        this.log(driven, 'done', summary)
        driven.state.status = 'done'
        driven.state.line = firstLine(summary)
        this.send(driven)
        // Ends the session, but only after this handler's result has gone back
        // — teardown is scheduled, not run, so the model is not cut off
        // mid-answer by its own tool call.
        setTimeout(() => this.teardown(driven), 0)
        return 'Recorded. The job is closed and this session is ending.'
      }

      default:
        return `${name} is not a Foreman tool.`
    }
  }

  /**
   * Which kind of log line a send is.
   *
   * It follows the trigger that opened the turn, which is the honest answer:
   * a send during the seed turn is the brief, a send while the pane was asking
   * is an answer, and a send into a pane that went quiet is the next
   * instruction. Purely for the person reading the log afterwards; the loop
   * itself does not care.
   */
  private sendKind(driven: Driven): ForemanLogEntry['kind'] {
    if (driven.trigger === 'seed') return 'brief'
    // A send during a human turn is an instruction too: Steve's words, relayed.
    return driven.trigger === 'asking' ? 'answer' : 'instruction'
  }

  /**
   * Take a restated plan, and log only what changed.
   *
   * The model restates the whole list every time (one idempotent call beats
   * add/advance/complete drifting apart), so most calls change nothing and
   * must say nothing: a log line per restatement is the chatter this replaces.
   * What is worth a line: the plan appearing, a step finishing, a step
   * failing, the list changing length.
   */
  private applyPlan(driven: Driven, steps: ForemanStep[]): string {
    const before = driven.state.plan
    const same =
      !!before &&
      before.length === steps.length &&
      before.every((s, i) => {
        const n = steps[i]
        return s.id === n.id && s.title === n.title && s.status === n.status && (s.note ?? '') === (n.note ?? '')
      })
    if (same) return 'Plan unchanged.'
    driven.state.plan = steps
    const done = steps.filter((s) => s.status === 'done').length
    const active = steps.find((s) => s.status === 'active')
    const progress = `${done}/${steps.length}`
    if (!before) {
      this.log(driven, 'plan', `Plan (${steps.length} steps): ${steps.map((s) => s.title).join(' → ')}`)
    } else {
      const was = new Map(before.map((s) => [s.id, s.status]))
      for (const s of steps) {
        const prev = was.get(s.id)
        if (s.status === 'done' && prev !== 'done') this.log(driven, 'plan', `Done (${progress}): ${s.title}`)
        else if (s.status === 'failed' && prev !== 'failed') this.log(driven, 'plan', `Failed: ${s.title}${s.note ? ` — ${s.note}` : ''}`)
      }
      if (before.length !== steps.length) {
        this.log(driven, 'plan', `Plan is now ${steps.length} steps: ${steps.map((s) => s.title).join(' → ')}`)
      }
    }
    // The footer follows the plan: the active step's title is the truest
    // one-liner there is, and it stays put between turns.
    if (active && driven.state.status !== 'done' && driven.state.status !== 'error') {
      this.setStatus(driven, driven.state.status, `${progress} — ${active.title}`)
    } else {
      this.send(driven)
    }
    return `Plan recorded (${progress}${active ? `, active: ${active.title}` : ''}).`
  }

  /** The panes Foreman could aim at, when it has just asked for one it cannot. */
  private paneList(): string {
    const panes = this.deps.listPanes?.() ?? []
    if (!panes.length) return ''
    return `\n\nPanes open right now:\n${panes
      .map((p) => `- ${p.id} — ${p.projectName} / ${p.title}${p.agent ? '' : ' (plain shell)'}`)
      .join('\n')}`
  }

  /**
   * Foreman's own tools, served in-process.
   *
   * One server per driven pane, because every tool defaults to *that* pane and
   * the model must never have to carry an id it was told once, forty turns ago.
   */
  private foremanServer(paneId: string): McpServerConfig {
    const text = (body: string): { content: Array<{ type: 'text'; text: string }> } => ({
      content: [{ type: 'text', text: body }]
    })
    const run = async (name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> =>
      text(await this.callTool(paneId, name, args))

    return createSdkMcpServer({
      name: 'foreman',
      version: '1.0.0',
      // These are the job's eyes and hands. Deferring them behind tool search
      // would mean a turn occasionally passing without Foreman able to answer.
      alwaysLoad: true,
      tools: [
        tool(
          'read_pane',
          'Read a pane\'s recent screen, exactly as a person looking at it would. With no argument it is the pane you are driving, which is what you want almost every time. Call it before answering anything: the one-line prompt you were handed is a summary, and the menu, the error and the diff are on the screen.',
          { pane: z.string().optional().describe('A pane id. Omit for the pane you are driving.') },
          async (args) => run('read_pane', { pane: args.pane })
        ),

        tool(
          'send_to_pane',
          [
            'Type into a pane and press Enter. This is your only way of changing anything.',
            '',
            'Speak the terminal\'s language, not English, when it is asking something:',
            '- a numbered menu — send the number on its own, e.g. "2"',
            '- a yes/no — send "y" or "n"',
            '- Escape — send "\\x1b" with submit false',
            '- a free-text question — answer it in a sentence or two, as the person who decides',
            '',
            'For work, send the whole instruction in one message: the brief, the next step, the fix. It is typed, not spoken, so it can be as long as it needs to be. With no `pane` it goes to the pane you are driving; give a pane id from open_agent_pane to talk to an agent you hired.',
            '',
            'Never send twice in a row without reading the pane in between.'
          ].join('\n'),
          {
            text: z.string().describe('Exactly what to type'),
            pane: z.string().optional().describe('A pane id. Omit for the pane you are driving.'),
            submit: z.boolean().optional().describe('Press Enter afterwards. Default true; false for Escape and other bare keys.')
          },
          async (args) => run('send_to_pane', { text: args.text, pane: args.pane, submit: args.submit })
        ),

        tool(
          'read_transcript',
          'Read what the Claude session in a pane has actually been saying — its own words, out of the conversation on disk, rather than the screen. Richer than read_pane and the right first call when you have just been switched on over a session that was already running, or when the screen has scrolled past what you need.',
          {
            pane: z.string().optional().describe('A pane id. Omit for the pane you are driving.'),
            max_chars: z.number().optional().describe('How much of the recent conversation to read. Default 6000.')
          },
          async (args) => run('read_transcript', { pane: args.pane, max_chars: args.max_chars })
        ),

        tool(
          'open_agent_pane',
          [
            'Hire another agent: split a new pane beside the one you are driving and start it.',
            '',
            'Profile ids: "antigravity" for images and visual assets, "grok" for fast iteration, "glm" for heavy research. The result names the panes that are open afterwards, ids included — send_to_pane to that id is how you brief the one you just opened, and read_pane on it is how you collect what it produced.',
            '',
            'Hire when the job genuinely suits them, and always bring the result back into the pane you are driving. An agent whose output never reaches the main session was wasted.'
          ].join('\n'),
          {
            profileId: z.string().describe('The launch profile id — antigravity, grok, glm, claude, codex'),
            count: z.number().optional().describe('How many panes. Default 1.')
          },
          async (args) => run('open_agent_pane', { profileId: args.profileId, count: args.count })
        ),

        tool(
          'set_plan',
          [
            'Declare the plan for this job, or restate it when it moves. This is how Steve sees progress — "3/5, running the suite" — so call it right after you form the concept and before you send the brief, again as each step starts (pass its id as `active`), and again when a step is done.',
            '',
            'Always send the whole list: three to eight steps, each with a stable id. A step is `done` only when you have read the evidence on the screen — a green suite, a commit, a file you read back — never because you sent the instruction. Restating an unchanged plan is free and logs nothing; add steps late as the job reveals them.'
          ].join('\n'),
          {
            steps: z
              .array(
                z.object({
                  id: z.string().describe('Stable across calls, e.g. "tests"'),
                  title: z.string().describe('A few words, as a person would read them'),
                  status: z.enum(['pending', 'active', 'done', 'failed']).optional().describe('Default pending'),
                  note: z.string().optional().describe('One line: why it failed, or what was found')
                })
              )
              .describe('The whole plan, in order'),
            active: z.string().optional().describe('The id of the step you are on now')
          },
          async (args) => run('set_plan', { steps: args.steps, active: args.active })
        ),

        tool(
          'get_standing_brief',
          'Steve\'s standing house rules — the things that are already decided, whatever this job is: which backend, how work is planned, what has to be green before anything is finished, where the keys live. Read it at the start of every job, and follow it where it differs from your instincts. Takes no arguments.',
          {},
          async () => run('get_standing_brief', {})
        ),

        tool(
          'note',
          'Put one line into the account of this job that Steve reads afterwards. Use it for a decision worth explaining, or for what you found when you took over a session already in progress. It changes nothing and nobody answers it.',
          { text: z.string().describe('One plain sentence') },
          async (args) => run('note', { text: args.text })
        ),

        tool(
          'finish',
          'The job is done, verified, and you have seen it verified. This closes the job and ends your session, so it is the last thing you call and never a way of saying "I think that is probably it". If a suite is red, if a step is unconfirmed, if you are guessing — send another instruction instead.',
          { summary: z.string().describe('What was built and how you know it works') },
          async (args) => run('finish', { summary: args.summary })
        )
      ]
    })
  }

  /* --------------------------------------------------------------- options */

  /**
   * Everything the SDK needs to be a foreman rather than a coding session.
   *
   * The permission posture is the part to read carefully, and it is the voice
   * agent's with one difference: there are no writers here at all.
   *
   *  - `tools` names the only built-ins that exist, and every one is read-only:
   *    Read, Glob, Grep, WebSearch, WebFetch. Bash, Edit and Write are not
   *    restricted, they are *absent* — the model cannot request what it was
   *    never given. Task (Agent) is the one addition and it widens nothing: the
   *    only subagent it can reach is `researcher`, whose tools are those same
   *    five.
   *  - Everything that changes the world goes through `send_to_pane`, into a
   *    real terminal a person can watch and stop.
   *  - `permissionMode: 'dontAsk'` denies anything not pre-approved instead of
   *    prompting. There is nobody to prompt: that is the whole point of Foreman.
   *  - `allowedTools` is the pre-approval, `canUseTool` the backstop that
   *    denies everything else.
   */
  private options(model: string, cwd: string, paneId: string): Options {
    const servers: Record<string, McpServerConfig> = { foreman: this.foremanServer(paneId) }
    const bridge = this.deps.getBridgeServer?.() ?? null
    if (bridge) servers['forge-bridge'] = bridge

    const allowed = new Set([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      // Delegation, under both of its names: the CLI calls this tool Agent and
      // keeps Task as a legacy alias for it.
      'Task',
      'Agent',
      'mcp__foreman__read_pane',
      'mcp__foreman__send_to_pane',
      'mcp__foreman__read_transcript',
      'mcp__foreman__open_agent_pane',
      'mcp__foreman__get_standing_brief',
      'mcp__foreman__set_plan',
      'mcp__foreman__note',
      'mcp__foreman__finish',
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
     * The one subagent, and the reason Task is allowed at all. "What does this
     * library actually do about X" is twenty greps and four long reads, and the
     * pane is sitting at a prompt while they happen.
     */
    const agents: Record<string, AgentDefinition> = {
      researcher: {
        description:
          'Deep research and codebase reconnaissance — many searches and reads distilled into a short factual answer',
        prompt: [
          'You are Foreman’s researcher. One question in, one answer out; there is no conversation here.',
          'Read and search as widely as the question needs. That breadth is the point of you.',
          'Answer in dense facts — paths, names, numbers, and what they mean — not in a description of how you looked.',
          'Report only what you actually found. If the answer is not there, say so plainly: what you write is about to be typed into a terminal as fact.',
          'You cannot change anything, and you are never being asked to.'
        ].join('\n'),
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
      }
    }

    return {
      model,
      ...(cwd ? { cwd } : {}),
      // A plain string, not the claude_code preset: Foreman drives a coding
      // agent, it is not one, and the preset is thousands of tokens of
      // instruction that would fight every rule in the persona.
      systemPrompt: FOREMAN_PERSONA,
      // No CLAUDE.md, no settings.json, no project instructions. The prompt
      // stays lean and — because nothing machine-specific leaks in — cacheable.
      settingSources: [],
      maxTurns: MAX_TURNS,
      mcpServers: servers,
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Agent'],
      agents,
      allowedTools: [...allowed],
      permissionMode: 'dontAsk',
      canUseTool: async (name): Promise<PermissionResult> =>
        allowed.has(name)
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: `${name} is not available to Foreman.` },
      stderr: (data: string) => {
        const line = data.trim()
        if (line) console.error(`[foreman:cli] ${line}`)
      }
    }
  }
}

/* ------------------------------------------------------------- narrowing */

/** A number from the model, or the default. Models send strings for numbers. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** The footer gets one line, and a short one. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

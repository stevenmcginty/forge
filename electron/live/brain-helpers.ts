import { clipLiveText, isLiveJobFinished, type LiveJob, type LiveJobState, type LiveLedgerSnapshot, type LiveNewsUrgency } from '@shared/live'

/**
 * The pure parts of Claude Live's two brains (./voice-brain.ts,
 * ./conductor.ts): the per-model request settings, the history trim, the
 * per-turn state block, the news rules, the Conductor's brief and its ledger
 * steps. No IO, no Electron and no SDK here, so scripts/live-check.mjs can
 * drive every rule in plain Node.
 */

/* ------------------------------------------------------------- the key */

/**
 * The Anthropic key the voice brain may use, or ''. A value still wearing
 * the `enc:` marker is one the store could not decrypt — no key, not a key.
 */
export function anthropicKeyOf(settings: { anthropicKey?: string }): string {
  const key = String(settings.anthropicKey ?? '').trim()
  return key.startsWith('enc:') ? '' : key
}

/* ------------------------------------------------------ per-model params */

/**
 * What a voice turn sends besides the conversation, per model (Messages API).
 * Every model answers at low effort; thinking is as off as each one allows:
 *  - Opus 5.5: thinking cannot be turned off (`disabled` is a 400), so it is omitted.
 *  - Sonnet 5.5: `disabled` is a 400; `between_tools` is its lowest setting.
 *  - Haiku 5.5: `disabled` is accepted at effort high or below.
 */
export function voiceModelParams(model: string): { thinking?: { type: 'disabled' | 'between_tools' }; output_config: { effort: 'low' } } {
  const output_config = { effort: 'low' as const }
  if (model.startsWith('claude-haiku-5-5')) return { thinking: { type: 'disabled' }, output_config }
  if (model.startsWith('claude-sonnet-5-5')) return { thinking: { type: 'between_tools' }, output_config }
  return { output_config }
}

/** The same choice for an Agent SDK session (the no-key route): only Haiku takes `disabled`. */
export function voiceSdkThinking(model: string): { type: 'disabled' } | undefined {
  return model.startsWith('claude-haiku-5-5') ? { type: 'disabled' } : undefined
}

/* -------------------------------------------------------------- history */

/** One message as the Messages API takes it, loosely: the brains own the real types. */
export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<{ type: string }>
}

/** Over `max` turns the oldest go, down to `keep`. Between trims the history is append-only. */
export const HISTORY_MAX_TURNS = 30
export const HISTORY_KEEP_TURNS = 20

function withoutThinking(message: HistoryMessage): HistoryMessage {
  if (message.role !== 'assistant' || typeof message.content === 'string') return message
  const content = message.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
  return content.length === message.content.length ? message : { ...message, content }
}

/**
 * The turns to keep. Under `max` it is the same array (append-only, so the
 * cached prefix and every thinking block stay valid). Over it, the last
 * `keep` turns with every thinking block taken out: a retained block was made
 * with the dropped turns in front of it and would be refused, while text and
 * tool calls can stay (the API's keep-tail rule).
 */
export function trimTurns<T extends HistoryMessage>(turns: T[][], max = HISTORY_MAX_TURNS, keep = HISTORY_KEEP_TURNS): T[][] {
  if (turns.length <= max) return turns
  return turns.slice(-keep).map((turn) => turn.map((m) => withoutThinking(m) as T))
}

/** Every thinking block out (a model switch: another model cannot use them; a leading run may always go). */
export function turnsWithoutThinking<T extends HistoryMessage>(turns: T[][]): T[][] {
  return turns.map((turn) => turn.map((m) => withoutThinking(m) as T))
}

function hasContent(message: HistoryMessage): boolean {
  return typeof message.content === 'string' ? message.content.trim().length > 0 : message.content.length > 0
}

/**
 * Make a message list the API accepts, changing nothing that is already
 * valid: an empty message goes, and a mid-conversation system message stays
 * only where it is allowed — after a user message, and last or followed by
 * an assistant turn.
 */
export function normaliseHistory<T extends HistoryMessage>(messages: T[]): T[] {
  const kept = messages.filter(hasContent)
  const out: T[] = []
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i]!
    if (m.role === 'system') {
      const prev = out[out.length - 1]
      const next = kept[i + 1]
      if (!prev || prev.role !== 'user') continue
      if (next && next.role !== 'assistant') continue
    }
    out.push(m)
  }
  return out
}

/* ------------------------------------------------------- the state block */

/** The app state's share of a turn's system message. */
export const STATE_APP_MAX = 2500
/** The ledger digest's share. */
export const STATE_DIGEST_MAX = 1500

/**
 * The per-turn system message: the app state and the ledger digest, each only
 * when it changed since the last one the model saw. '' when neither did.
 */
export function stateBlock(app: string, digest: string, last: { app: string; digest: string }): string {
  const parts: string[] = []
  const a = app.trim().slice(0, STATE_APP_MAX)
  const d = digest.trim().slice(0, STATE_DIGEST_MAX)
  if (a && a !== last.app) parts.push(`# FORGE RIGHT NOW (live app state; it replaces any earlier one)\n${a}`)
  if (d && d !== last.digest) parts.push(`# JOBS (the ledger; it replaces any earlier one)\n${d}`)
  return parts.join('\n\n')
}

/** What `stateBlock` treats as already seen, once a block carrying them was kept. */
export function seenState(app: string, digest: string): { app: string; digest: string } {
  return { app: app.trim().slice(0, STATE_APP_MAX), digest: digest.trim().slice(0, STATE_DIGEST_MAX) }
}

/* ----------------------------------------------------------------- news */

export interface LiveNewsItem {
  jobId: string
  text: string
  urgency: Exclude<LiveNewsUrgency, 'info'>
}

/**
 * What changed in the ledger that Steve should hear, given each job's last
 * known state. A new job is not news (the voice brain made it). A job on a
 * pane is announced by the pane's attention (electron/live/index.ts), so only
 * paneless jobs get needs-you and done here; a failure is news for any job.
 * Stopped is never news: Steve did it.
 */
export function ledgerNews(
  prev: ReadonlyMap<string, LiveJobState>,
  snap: LiveLedgerSnapshot
): { items: LiveNewsItem[]; next: Map<string, LiveJobState> } {
  const next = new Map<string, LiveJobState>()
  const items: LiveNewsItem[] = []
  for (const job of snap.jobs) {
    next.set(job.id, job.state)
    const was = prev.get(job.id)
    if (was === undefined || was === job.state) continue
    const item = newsFor(job)
    if (item) items.push(item)
  }
  return { items, next }
}

function newsFor(job: LiveJob): LiveNewsItem | null {
  const why = job.summary && job.summary !== 'Finished' ? job.summary : ''
  if (job.state === 'failed') {
    return { jobId: job.id, urgency: 'done', text: clipLiveText(`${job.title} failed${why ? `: ${why}` : '.'}`) }
  }
  if (job.paneId) return null
  if (job.state === 'needs-you') {
    return { jobId: job.id, urgency: 'needs-you', text: clipLiveText(`${job.title} needs you${why ? `: ${why}` : '.'}`) }
  }
  if (job.state === 'done') {
    return { jobId: job.id, urgency: 'done', text: clipLiveText(`${job.title} is done${why ? `: ${why}` : '.'}`) }
  }
  return null
}

/** Done news gathered over the batch window, as one thing to say. */
export function batchNewsText(items: readonly LiveNewsItem[]): string {
  return items.map((i) => i.text.replace(/\s*$/, '')).map((t) => (/[.!?…]$/.test(t) ? t : `${t}.`)).join(' ')
}

/* ------------------------------------------------------------ Conductor */

/** The Conductor's message for a new job. */
export function conductorBrief(job: Pick<LiveJob, 'id' | 'title' | 'project'>, brief: string): string {
  const where = job.project ? `\nProject: ${job.project}.` : ''
  return [
    `[Job ${job.id}: ${job.title}]${where}`,
    brief.trim() || job.title,
    '',
    `Report progress with report, jobId "${job.id}". When it ends, report with state done, failed or needs-you.`
  ].join('\n')
}

/** The Conductor's message when Steve steers a job. */
export function conductorSteer(job: Pick<LiveJob, 'id' | 'title' | 'paneName'>, text: string): string {
  const pane = job.paneName ? ` It is running in ${job.paneName}; pass the change on to that pane if it needs it.` : ''
  return `[Job ${job.id}: ${job.title}] Steve changed it: ${text.trim()}${pane}\nCarry on with this in mind, and report as before.`
}

/**
 * The jobs to close after a restart: the Conductor's own, unfinished, with
 * no pane. Their session died with Forge; a pane-owned or pane-watched job
 * carries on through the pane's attention.
 */
export function jobsLostInRestart(snap: LiveLedgerSnapshot): string[] {
  return snap.jobs.filter((j) => j.owner === 'conductor' && !j.paneId && !isLiveJobFinished(j.state)).map((j) => j.id)
}

/** The pane an open_agent_pane answer names: "… opened Zeb (Claude) … (pane id abc) …". */
export function paneOpenedIn(text: string): { paneId: string; paneName?: string } | null {
  if (!/^OK/.test(text.trim())) return null
  const id = /\(pane id ([^\s);,]+)\)/.exec(text)?.[1]
  if (!id) return null
  const name = /\b[Oo]pened (\S+) \(/.exec(text)?.[1]
  return name ? { paneId: id, paneName: name } : { paneId: id }
}

/** Every string inside a tool response (an MCP result, its content array, or plain text), joined. */
export function toolResponseText(response: unknown): string {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) return response.map(toolResponseText).filter(Boolean).join('\n')
  if (response && typeof response === 'object') {
    const r = response as { text?: unknown; content?: unknown }
    if (typeof r.text === 'string') return r.text
    if (r.content !== undefined) return toolResponseText(r.content)
  }
  return ''
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * One ledger step for one Conductor tool call, in plain words: "opened a
 * claude pane (Kess)", "read Kess's pane". Null for calls that are not worth
 * a line (report itself, which writes its own).
 */
export function describeToolStep(fullName: string, input: unknown): string | null {
  const name = fullName.split('__').pop() ?? fullName
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const inProject = str(a['project']) ? ` in ${str(a['project'])}` : ''
  switch (name) {
    case 'report':
    case 'TodoWrite':
      return null
    case 'open_agent_pane':
      return `Opened a ${str(a['agent']) || 'new'} pane${str(a['name']) ? ` (${str(a['name'])})` : ''}${inProject}`
    case 'type_into_pane':
      return `Typed into ${str(a['target']) || 'a pane'}${inProject}`
    case 'read_pane':
      return `Read ${str(a['target']) || 'a pane'}'s screen${inProject}`
    case 'help_prompt':
      return `Put a prompt in ${str(a['target']) || 'the focused pane'}`
    case 'get_app_state':
      return 'Looked at the app'
    case 'list_panes_with_names':
      return `Listed the panes${inProject}`
    case 'focus_pane_by_name':
      return `Went to ${str(a['name']) || 'a pane'}`
    case 'show_view':
      return `Showed the ${str(a['view']) || 'view'}`
    case 'create_project':
      return `Made the project ${str(a['name'])}`
    case 'run_app_action': {
      const action = (a['action'] && typeof a['action'] === 'object' ? a['action'] : {}) as Record<string, unknown>
      const what = str(action['target']) || str(action['which']) || str(action['name'])
      return `App: ${str(action['kind']).replace(/_/g, ' ') || 'an action'}${what ? ` (${what})` : ''}`
    }
    case 'run_command':
      return `Ran: ${str(a['command'])}`
    case 'write_file':
      return `Wrote ${baseName(str(a['path']))}`
    case 'save_asset':
      return `Saved ${baseName(str(a['source']))}`
    case 'browser_open':
      return `Opened ${str(a['url']) || 'a browser tab'}`
    case 'Read':
      return `Read ${baseName(str(a['file_path']))}`
    case 'Glob':
    case 'Grep':
      return `Searched for ${str(a['pattern'])}`
    case 'WebSearch':
      return `Searched the web: ${str(a['query'])}`
    case 'WebFetch':
      return `Fetched ${str(a['url'])}`
    case 'Task':
    case 'Agent':
      return `Asked the researcher: ${str(a['description']) || 'a question'}`
    default:
      return `Used ${name.replace(/_/g, ' ')}`
  }
}

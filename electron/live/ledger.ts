import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttentionEvent } from '../attention-bus'
import {
  clipLiveText,
  isLiveJobFinished,
  LIVE_JOB_CAP,
  LIVE_JOB_STATES,
  LIVE_KEEP_MS,
  LIVE_STEP_MAX,
  LIVE_STEPS_PER_JOB,
  liveJobStateWord,
  type LiveEvent,
  type LiveJob,
  type LiveJobOwner,
  type LiveJobState,
  type LiveLedgerSnapshot
} from '@shared/live'

/**
 * Claude Live's job ledger: what the Conductor, the panes and the operator are
 * doing, in one place the voice brain, the UI and the spoken news all read.
 *
 * Two halves. `applyLedgerEvent` is a pure reducer (snapshot + event → next
 * snapshot) with every rule in it, so scripts/live-check.mjs can drive it in
 * plain Node. `LiveLedger` is the thin IO around it: an in-memory snapshot
 * and an append-only JSONL log at `<dataDir>/live/ledger.jsonl`, replayed on
 * start (the last 24 h) and compacted to one `put` line per job.
 *
 * No Electron here, on purpose. The attention feed comes in as plain
 * AttentionEvent objects (electron/attention-bus.ts); electron/live/index.ts
 * does the subscribing.
 */

/** What a new job starts from. `state` defaults to `queued`. */
export interface LiveJobInit {
  id: string
  title: string
  owner: LiveJobOwner
  project?: string
  paneId?: string
  paneName?: string
  state?: LiveJobState
  summary?: string
}

/** The fields `updateJob` may change. An empty string clears an optional field. */
export type LiveJobPatch = Partial<Pick<LiveJob, 'title' | 'project' | 'paneId' | 'paneName' | 'summary'>>

/** One line of the log. `put` is a whole job as it stood (compaction). */
export type LedgerEvent =
  | { t: 'create'; at: number; job: LiveJobInit }
  | { t: 'update'; at: number; id: string; patch: LiveJobPatch }
  | { t: 'step'; at: number; id: string; text: string }
  | { t: 'state'; at: number; id: string; state: LiveJobState; summary?: string }
  | { t: 'put'; job: LiveJob }

export type LiveNews = Extract<LiveEvent, { type: 'news' }>

const TITLE_MAX = 120
const NAME_MAX = 80
const OWNERS: readonly LiveJobOwner[] = ['conductor', 'pane', 'operator']

export const EMPTY_LEDGER: LiveLedgerSnapshot = { jobs: [], seq: 0 }

function isState(value: unknown): value is LiveJobState {
  return typeof value === 'string' && (LIVE_JOB_STATES as readonly string[]).includes(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** An optional short field: a non-empty clipped string, or absent. */
function optional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = clipLiveText(value, max)
  return text ? text : undefined
}

function withOptional<T extends object>(base: T, key: string, value: string | undefined): T {
  const next = { ...base } as Record<string, unknown>
  if (value === undefined) delete next[key]
  else next[key] = value
  return next as T
}

/** A job off disk (or from anywhere untrusted), cleaned; null when it is not one. */
export function sanitiseLiveJob(raw: unknown): LiveJob | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim().slice(0, 80) : ''
  const title = optional(r.title, TITLE_MAX)
  if (!id || !title) return null
  const owner = OWNERS.includes(r.owner as LiveJobOwner) ? (r.owner as LiveJobOwner) : 'conductor'
  const createdAt = isTime(r.createdAt) ? r.createdAt : 0
  const updatedAt = isTime(r.updatedAt) ? Math.max(r.updatedAt, createdAt) : createdAt
  const steps = Array.isArray(r.steps)
    ? r.steps
        .filter((s): s is { at: unknown; text: unknown } => !!s && typeof s === 'object')
        .map((s) => ({ at: isTime(s.at) ? s.at : updatedAt, text: clipLiveText(s.text, LIVE_STEP_MAX) }))
        .filter((s) => s.text)
        .slice(-LIVE_STEPS_PER_JOB)
    : []
  let job: LiveJob = { id, title, owner, state: isState(r.state) ? r.state : 'queued', steps, createdAt, updatedAt }
  job = withOptional(job, 'project', optional(r.project, NAME_MAX))
  job = withOptional(job, 'paneId', optional(r.paneId, NAME_MAX))
  job = withOptional(job, 'paneName', optional(r.paneName, NAME_MAX))
  job = withOptional(job, 'summary', optional(r.summary, LIVE_STEP_MAX))
  return job
}

/** Newest-created first; the order every reader gets. */
function sorted(jobs: LiveJob[]): LiveJob[] {
  return jobs.slice().sort((a, b) => b.createdAt - a.createdAt)
}

/** Over the cap: the oldest finished jobs go first, then the oldest of the rest. */
export function capLiveJobs(jobs: LiveJob[], cap = LIVE_JOB_CAP): LiveJob[] {
  if (jobs.length <= cap) return jobs
  const victims = jobs
    .slice()
    .sort((a, b) => Number(isLiveJobFinished(b.state)) - Number(isLiveJobFinished(a.state)) || a.updatedAt - b.updatedAt)
    .slice(0, jobs.length - cap)
  const drop = new Set(victims.map((j) => j.id))
  return jobs.filter((j) => !drop.has(j.id))
}

function replaceJob(snap: LiveLedgerSnapshot, job: LiveJob): LiveLedgerSnapshot {
  return { jobs: snap.jobs.map((j) => (j.id === job.id ? job : j)), seq: snap.seq + 1 }
}

/**
 * The reducer. Returns `snap` itself (same object) when the event changes
 * nothing — an unknown job, an empty step, a repeated state — so callers can
 * tell a no-op by identity. Rules:
 *  - `create` with an id already in the ledger is ignored (replay-safe).
 *  - a step is one line, cut to 200 characters; a job keeps its last 50.
 *  - `stopped` is final: Steve stopped it, so nothing moves it again. Every
 *    other state may move to any state (a done pane can ask again).
 *  - over 200 jobs, the oldest finished ones are dropped first.
 */
export function applyLedgerEvent(snap: LiveLedgerSnapshot, event: LedgerEvent): LiveLedgerSnapshot {
  if (!event || typeof event !== 'object') return snap
  switch (event.t) {
    case 'create': {
      const at = isTime(event.at) ? event.at : 0
      const job = sanitiseLiveJob({ ...event.job, steps: [], createdAt: at, updatedAt: at })
      if (!job || snap.jobs.some((j) => j.id === job.id)) return snap
      return { jobs: capLiveJobs(sorted([...snap.jobs, job])), seq: snap.seq + 1 }
    }
    case 'put': {
      const job = sanitiseLiveJob(event.job)
      if (!job) return snap
      const rest = snap.jobs.filter((j) => j.id !== job.id)
      return { jobs: capLiveJobs(sorted([...rest, job])), seq: snap.seq + 1 }
    }
    case 'update': {
      const job = snap.jobs.find((j) => j.id === event.id)
      if (!job || !event.patch || typeof event.patch !== 'object') return snap
      let next: LiveJob = job
      const p = event.patch
      const title = optional(p.title, TITLE_MAX)
      if (title && title !== job.title) next = { ...next, title }
      for (const [key, max] of [
        ['project', NAME_MAX],
        ['paneId', NAME_MAX],
        ['paneName', NAME_MAX],
        ['summary', LIVE_STEP_MAX]
      ] as const) {
        if (typeof p[key] !== 'string') continue
        const value = optional(p[key], max)
        if (value !== next[key]) next = withOptional(next, key, value)
      }
      if (next === job) return snap
      return replaceJob(snap, { ...next, updatedAt: Math.max(job.updatedAt, isTime(event.at) ? event.at : 0) })
    }
    case 'step': {
      const job = snap.jobs.find((j) => j.id === event.id)
      const text = clipLiveText(event.text, LIVE_STEP_MAX)
      if (!job || !text) return snap
      const at = isTime(event.at) ? event.at : job.updatedAt
      const steps = [...job.steps, { at, text }].slice(-LIVE_STEPS_PER_JOB)
      return replaceJob(snap, { ...job, steps, updatedAt: Math.max(job.updatedAt, at) })
    }
    case 'state': {
      const job = snap.jobs.find((j) => j.id === event.id)
      if (!job || !isState(event.state) || job.state === 'stopped') return snap
      const summary = optional(event.summary, LIVE_STEP_MAX)
      if (job.state === event.state && (summary === undefined || summary === job.summary)) return snap
      let next: LiveJob = { ...job, state: event.state }
      if (summary !== undefined) next = { ...next, summary }
      const at = isTime(event.at) ? event.at : job.updatedAt
      return replaceJob(snap, { ...next, updatedAt: Math.max(job.updatedAt, at) })
    }
    default:
      return snap
  }
}

/** Jobs last touched before `now - keepMs` are dropped (the 24 h reload rule). */
export function pruneLiveLedger(snap: LiveLedgerSnapshot, now: number, keepMs = LIVE_KEEP_MS): LiveLedgerSnapshot {
  const jobs = snap.jobs.filter((j) => j.updatedAt >= now - keepMs)
  return jobs.length === snap.jobs.length ? snap : { jobs, seq: snap.seq + 1 }
}

/* ------------------------------------------------------------- attention */

/** What a pane's attention change means for the ledger: the events to apply, and the news to speak. */
export interface AttentionOutcome {
  jobId: string
  events: LedgerEvent[]
  news: { text: string; urgency: 'needs-you' | 'done' } | null
}

/** The job watching this pane: the newest one on it that is not stopped. */
export function jobForPane(snap: LiveLedgerSnapshot, paneId: string): LiveJob | null {
  if (!paneId) return null
  let best: LiveJob | null = null
  for (const job of snap.jobs) {
    if (job.paneId !== paneId || job.state === 'stopped') continue
    if (!best || job.createdAt > best.createdAt) best = job
  }
  return best
}

/**
 * A pane went asking / done / idle. `asking` → needs-you with news (once per
 * question), `done` → done with news (once), `idle` after needs-you → running
 * again (answered), no news. A pane no job watches → null.
 */
export function attentionToLedger(snap: LiveLedgerSnapshot, event: AttentionEvent, now: number): AttentionOutcome | null {
  const job = jobForPane(snap, event?.paneId)
  if (!job) return null
  const name = job.paneName || job.title
  const prompt = clipLiveText(event.prompt, 160)
  if (event.state === 'asking') {
    const summary = prompt ? `Asking: ${prompt}` : 'Waiting for you'
    if (job.state === 'needs-you' && job.summary === clipLiveText(summary, LIVE_STEP_MAX)) return null
    const events: LedgerEvent[] = [{ t: 'state', at: now, id: job.id, state: 'needs-you', summary }]
    if (prompt) events.push({ t: 'step', at: now, id: job.id, text: `Asked: ${prompt}` })
    return { jobId: job.id, events, news: { text: prompt ? `${name} needs you: ${prompt}` : `${name} needs you.`, urgency: 'needs-you' } }
  }
  if (event.state === 'done') {
    if (job.state === 'done') return null
    return {
      jobId: job.id,
      events: [{ t: 'state', at: now, id: job.id, state: 'done', summary: 'Finished' }],
      news: { text: `${name} is done.`, urgency: 'done' }
    }
  }
  if (event.state === 'idle' && job.state === 'needs-you') {
    return { jobId: job.id, events: [{ t: 'state', at: now, id: job.id, state: 'running', summary: 'Answered, working again' }], news: null }
  }
  return null
}

/* ---------------------------------------------------------------- digest */

const GROUP_ORDER: Record<LiveJobState, number> = { 'needs-you': 0, running: 1, queued: 2, done: 3, failed: 3, stopped: 3 }
const FINISHED_IN_DIGEST = 5

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

/**
 * A short text of the ledger for the voice brain: needs-you first, then
 * working, waiting, and the last few finished; newest first in each group,
 * with the newest two steps under an unfinished job. Whole lines only, never
 * longer than `maxChars`.
 */
export function ledgerDigest(snap: LiveLedgerSnapshot, maxChars = 1500, now = Date.now()): string {
  const active = snap.jobs.filter((j) => !isLiveJobFinished(j.state))
  const finished = snap.jobs
    .filter((j) => isLiveJobFinished(j.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, FINISHED_IN_DIGEST)
  const jobs = [...active, ...finished].sort(
    (a, b) => GROUP_ORDER[a.state] - GROUP_ORDER[b.state] || b.updatedAt - a.updatedAt
  )
  if (jobs.length === 0) return clipLiveText('No jobs.', maxChars)
  const lines: string[] = []
  let used = 0
  let shown = 0
  const fits = (line: string): boolean => used + line.length + (lines.length ? 1 : 0) <= maxChars
  const push = (line: string): void => {
    used += line.length + (lines.length ? 1 : 0)
    lines.push(line)
  }
  for (const job of jobs) {
    const where = [job.paneName ? `pane ${job.paneName}` : '', job.project ? `project ${job.project}` : ''].filter(Boolean).join(', ')
    const head = `- ${liveJobStateWord(job.state)}: ${job.title}${where ? ` (${where})` : ''}${job.summary ? ` — ${job.summary}` : ''} [${ago(now - job.updatedAt)}]`
    const line = head.length > maxChars ? clipLiveText(head, maxChars) : head
    if (!fits(line)) break
    push(line)
    shown++
    if (isLiveJobFinished(job.state)) continue
    for (const step of job.steps.slice(-2).reverse()) {
      const stepLine = `    · ${step.text}`
      if (fits(stepLine)) push(stepLine)
    }
  }
  const more = jobs.length - shown
  if (more > 0) {
    const tail = `…and ${more} more`
    if (fits(tail)) push(tail)
  }
  return lines.join('\n')
}

/* -------------------------------------------------------------------- IO */

/** A log line off disk, or null when it is torn or not one of ours. */
export function parseLedgerLine(line: string): LedgerEvent | null {
  const text = line.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const t = (parsed as { t?: unknown }).t
    return t === 'create' || t === 'update' || t === 'step' || t === 'state' || t === 'put' ? (parsed as LedgerEvent) : null
  } catch {
    return null
  }
}

export interface LiveLedgerOptions {
  /** The JSONL log. Null keeps the ledger in memory only (tests). */
  file: string | null
  now?: () => number
  newId?: () => string
}

type Listener = (snapshot: LiveLedgerSnapshot) => void

export class LiveLedger {
  private snap: LiveLedgerSnapshot = EMPTY_LEDGER
  private readonly listeners = new Set<Listener>()
  private readonly file: string | null
  private readonly now: () => number
  private readonly newId: () => string

  constructor(opts: LiveLedgerOptions) {
    this.file = opts.file
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => `job-${randomUUID().slice(0, 8)}`)
  }

  /**
   * Replay the log, keep the last 24 h, and rewrite it as one `put` per job,
   * so the file never grows past the ledger it holds. A torn last line (a
   * crash mid-append) is skipped. Never throws: a ledger that cannot load
   * starts empty.
   */
  load(): void {
    if (!this.file) return
    let snap = EMPTY_LEDGER
    try {
      if (existsSync(this.file)) {
        for (const line of readFileSync(this.file, 'utf8').split('\n')) {
          const event = parseLedgerLine(line)
          if (event) snap = applyLedgerEvent(snap, event)
        }
      }
    } catch (err) {
      console.error('[live] ledger could not be read:', err)
    }
    this.snap = pruneLiveLedger(snap, this.now())
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const body = this.snap.jobs
        .slice()
        .reverse()
        .map((job) => JSON.stringify({ t: 'put', job } satisfies LedgerEvent))
        .join('\n')
      writeFileSync(tmp, body ? `${body}\n` : '', 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[live] ledger could not be compacted:', err)
    }
  }

  snapshot(): LiveLedgerSnapshot {
    return this.snap
  }

  get(id: string): LiveJob | null {
    return this.snap.jobs.find((j) => j.id === id) ?? null
  }

  createJob(init: Omit<LiveJobInit, 'id'> & { id?: string }): LiveJob | null {
    const id = init.id?.trim() || this.newId()
    this.apply({ t: 'create', at: this.now(), job: { ...init, id } })
    return this.get(id)
  }

  /** Null when there is no such job. */
  updateJob(id: string, patch: LiveJobPatch): LiveJob | null {
    this.apply({ t: 'update', at: this.now(), id, patch })
    return this.get(id)
  }

  addStep(id: string, text: string): LiveJob | null {
    this.apply({ t: 'step', at: this.now(), id, text })
    return this.get(id)
  }

  setState(id: string, state: LiveJobState, summary?: string): LiveJob | null {
    this.apply({ t: 'state', at: this.now(), id, state, ...(summary !== undefined ? { summary } : {}) })
    return this.get(id)
  }

  digest(maxChars = 1500): string {
    return ledgerDigest(this.snap, maxChars, this.now())
  }

  /** Apply a pane's attention change; the news to speak, if any. */
  handleAttention(event: AttentionEvent): LiveNews | null {
    const outcome = attentionToLedger(this.snap, event, this.now())
    if (!outcome) return null
    for (const e of outcome.events) this.apply(e)
    if (!outcome.news) return null
    return { type: 'news', id: `news-${this.snap.seq}`, jobId: outcome.jobId, text: outcome.news.text, urgency: outcome.news.urgency }
  }

  /** Every change, as the whole snapshot. Returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private apply(event: LedgerEvent): void {
    const next = applyLedgerEvent(this.snap, event)
    if (next === this.snap) return
    this.snap = next
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8')
      } catch (err) {
        console.error('[live] ledger could not be written:', err)
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (err) {
        console.error('[live] ledger listener failed:', err)
      }
    }
  }
}

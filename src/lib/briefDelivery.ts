/**
 * The decisions behind AppState's type drain — which queued command or brief
 * goes into its new pane, when, and which is given up on — kept out of the
 * effect so a plain node check can hold them to account.
 *
 * Two rules the effect alone could not keep:
 *
 *  1. A brief goes in once. The effect re-runs every time the queue changes,
 *     and a "delivered" list local to one run forgot every paste the run
 *     before it made — so an agent opened while another's brief was queued got
 *     that brief pasted (and, with submit on, sent) a second time. Delivery is
 *     recorded here, per queued entry, and this object outlives the runs.
 *
 *  2. A brief is never pasted into a shell. A pane whose agent CLI never came
 *     up (not installed, crashed, still loading) is a live PowerShell prompt,
 *     and a multi-line paste there runs every line. So a brief whose pane has
 *     not printed an agent's banner by the deadline is refused, not pasted.
 *
 * The deadline runs from the moment the pane starts, not from when the entry
 * was queued: a pane opened into a project nobody is looking at does not start
 * until that project is opened, and its brief waits for it.
 */

/** A pane as the drain sees it this tick. */
export interface BriefProbe {
  /** terminalHost.runtime(paneId).status — 'idle' until the pane is mounted. */
  status: 'idle' | 'starting' | 'live' | 'exited' | 'error'
  /** terminalHost.readiness(paneId). */
  outputBytes: number
  quietForMs: number
  /** False once the pane is in no workspace at all — its tab was closed. */
  exists: boolean
}

/**
 * What to do with one entry this tick.
 *
 *   skip     already delivered or given up on — never again
 *   wait     not yet
 *   deliver  type or paste it now
 *   drop     give up quietly: the pane is gone, dead, or never started
 *   refuse   give up and say so: a brief whose agent never came up
 */
export type BriefStep = 'skip' | 'wait' | 'deliver' | 'drop' | 'refuse'

/**
 * When a new agent pane counts as ready for a pasted brief: it has printed at
 * least this much since spawn (a PowerShell prompt plus an echoed command is
 * well under 1 KiB; every agent's welcome banner is several) and has then
 * been silent this long (longer than the busy heuristic's own quiet, so a
 * banner still being drawn does not count as finished).
 */
export const BRIEF_READY_BYTES = 1500
export const BRIEF_READY_QUIET_MS = 1500

/** How long a started pane gets to become deliverable. */
export const BRIEF_DEADLINE_MS = 30_000

export class BriefDelivery<T extends object> {
  private readonly done = new WeakSet<T>()
  private readonly startedAt = new WeakMap<T, number>()

  private readonly deadlineMs: number

  constructor(deadlineMs: number = BRIEF_DEADLINE_MS) {
    this.deadlineMs = deadlineMs
  }

  /** Delivered, or given up on. */
  isDone(entry: T): boolean {
    return this.done.has(entry)
  }

  /** Record that `entry` went in (or was given up on). Call it the moment it is typed. */
  markDone(entry: T): void {
    this.done.add(entry)
  }

  step(entry: T, paste: boolean, probe: BriefProbe, now: number): BriefStep {
    if (this.done.has(entry)) return 'skip'
    if (!probe.exists) return 'drop'
    if (probe.status === 'exited' || probe.status === 'error') return 'drop'
    // Not mounted yet: its project is not on screen, or the first frame has not
    // drawn it. No clock runs for a pane that has not been asked to start.
    if (probe.status === 'idle') return 'wait'
    let started = this.startedAt.get(entry)
    if (started === undefined) {
      started = now
      this.startedAt.set(entry, now)
    }
    const late = now - started > this.deadlineMs
    if (probe.status === 'live') {
      // A typed command is for a shell, and a live shell is ready for it.
      if (!paste) return 'deliver'
      if (probe.outputBytes >= BRIEF_READY_BYTES && probe.quietForMs >= BRIEF_READY_QUIET_MS) return 'deliver'
    }
    if (!late) return 'wait'
    return paste ? 'refuse' : 'drop'
  }
}

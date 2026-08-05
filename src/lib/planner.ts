import type { PlannerUpdate, Project, Settings } from '@shared/types'
import { isClaudeCommand } from '@shared/agents'
import { quoteForShell } from '@shared/remote'
import { MAX_TASK_CARDS, MAX_TASK_TEXT } from '@shared/ipc'
import { terminalHost, type TerminalSpec } from './terminals'

/**
 * The tasks panel's planning session — the renderer-side machinery.
 *
 * The planner is a real `claude` pane: pane id `planner:<projectId>`, cwd at
 * the project, one per project, never part of the split-tree or the mosaic.
 * Forge does not read its answers out of a pipe — the main process tails the
 * session's transcript (electron/planner-watcher.ts) and pushes every plan the
 * model fences in a ```tasks block. This module owns the three renderer jobs
 * around that:
 *
 *  - composing the launch command, with the standing instruction that makes
 *    plans arrive machine-readably;
 *  - delivering a stated goal into the pane *safely* — a fresh pane spends its
 *    first seconds as bare PowerShell waiting for `claude` to boot, and a goal
 *    typed into that window would run as a shell command;
 *  - holding the current proposal per project, deduplicated against transcript
 *    replays, so pruning a brief survives a project switch and a dealt or
 *    discarded plan does not resurrect on restart.
 */

/* ------------------------------------------------------------ identity */

/** One planner pane per project, outside the layout tree by construction. */
export function plannerPaneId(projectId: string): string {
  return `planner:${projectId}`
}

/**
 * The standing instruction, appended as a system prompt at launch so every
 * plan the session ever writes ends in the ```tasks fence the watcher reads.
 * Single-quoted for pwsh — the text deliberately contains no apostrophes, and
 * the double quotes inside are literal inside single quotes.
 */
export const PLANNER_INSTRUCTION =
  'You are the planning terminal of Forge, a delegation app. When the user states a goal, reply with a short plan in prose, then end the reply with a fenced code block opened by three backticks and the word tasks, containing JSON of the shape {"plan": "...", "tasks": ["...", "..."]} where each task is a self-contained brief, written as a direct instruction to a separate coding agent working in this same repository which will see only that text. 2 to 8 tasks; fewer, bigger tasks beat slivers. When the user is conversing rather than stating a goal, answer normally and send no tasks block.'

/**
 * The spec the planner pane launches with. Base command comes off the Claude
 * profile (so a machine where `claude` lives behind a hand-edited command
 * still works); the instruction rides `--append-system-prompt`, which the pty
 * bootstrap types verbatim into a real pwsh — quoteForShell is the same
 * single-quoting Remote Control's session names already survive with. The
 * sessionId goes on the spec, and the main process decides `--session-id`
 * versus `--resume` (electron/bridge/claude-session.ts), which is the whole of
 * resume-across-restarts.
 */
export function plannerSpec(project: Project, settings: Settings, sessionId: string): TerminalSpec {
  const profile =
    settings.agentProfiles.find((p) => p.id === 'claude' && isClaudeCommand(p.command)) ??
    settings.agentProfiles.find((p) => isClaudeCommand(p.command))
  const base = profile?.command.trim() || 'claude'
  return {
    cwd: project.path,
    bootstrapCommand: `${base} --append-system-prompt ${quoteForShell(PLANNER_INSTRUCTION)}`,
    fontSize: settings.terminalFontSize,
    fontFamily: settings.terminalFontFamily,
    accent: profile?.accent ?? '#C6FF4A',
    projectName: project.name,
    paneTitle: 'Planner',
    sessionId,
    // Never Remote Control: a bridged session sends the conversation through
    // claude.ai and writes no messages to the local transcript — the exact
    // file the plan watcher tails. The planner would look alive and never
    // produce a single card.
    remoteControl: false
  }
}

/**
 * Attach (creating on first call) the planner pane into `container`. Safe to
 * call repeatedly — attach moves the live terminal rather than remaking it.
 * Callers detach on unmount and NEVER dispose: the session must survive every
 * dock/maximize/project-switch; only deleting the project kills it (see the
 * removeProject reducer in AppState).
 */
export function ensurePlannerPane(
  container: HTMLElement,
  project: Project,
  settings: Settings,
  sessionId: string
): string {
  const paneId = plannerPaneId(project.id)
  terminalHost.attach(paneId, container, plannerSpec(project, settings, sessionId))
  watchReadiness(paneId)
  return paneId
}

/* ----------------------------------------------------------- goal delivery */

/**
 * Why goals are not typed straight in: a brand-new pane is PowerShell for its
 * first seconds — the bootstrap types `claude …` only after the prompt has
 * settled, and Claude then takes a few more to boot. Text sent during that
 * window lands in the *shell*, and the submit would run it as a command. So a
 * goal waits for the pane to be live, past a minimum boot age, and quiet for a
 * beat — the same "the program has drawn its prompt and stopped talking"
 * heuristic the busy light uses — and only then is typed and submitted. Once a
 * pane has proven ready, later goals go straight through.
 */
const DELIVER_MIN_BOOT_MS = 2500
const DELIVER_QUIET_MS = 900
const DELIVER_TICK_MS = 200
const DELIVER_GIVE_UP_MS = 45_000

interface Delivery {
  goals: string[]
  timer: number
  createdAt: number
  lastOutput: number
  unsubscribe: () => void
  onFail: (message: string) => void
}

const deliveries = new Map<string, Delivery>()
/** Panes whose Claude has booted in the current shell process. */
const readyPanes = new Set<string>()
/** Panes whose runtime we already watch for the ready flag's honesty. */
const watched = new Set<string>()

/** A relaunched shell re-runs the bootstrap, so "ready" must not survive it. */
function watchReadiness(paneId: string): void {
  if (watched.has(paneId)) return
  watched.add(paneId)
  terminalHost.subscribeRuntime(paneId, (r) => {
    if (r.status === 'exited' || r.status === 'error' || r.status === 'starting') readyPanes.delete(paneId)
  })
}

function typeAndSubmit(paneId: string, goals: string[], onFail: (message: string) => void): void {
  for (const goal of goals) {
    if (!terminalHost.type(paneId, goal)) {
      onFail('The planner has no live shell — press Enter in its terminal to relaunch it')
      return
    }
    terminalHost.submit(paneId)
  }
}

function endDelivery(paneId: string): void {
  const d = deliveries.get(paneId)
  if (!d) return
  deliveries.delete(paneId)
  clearInterval(d.timer)
  d.unsubscribe()
}

/**
 * Hand a goal to the planner pane: immediately when its Claude is already up,
 * otherwise queued until the boot settles. `onFail` gets one human sentence
 * when the goal could not be delivered at all.
 */
export function sendGoal(paneId: string, goal: string, onFail: (message: string) => void): void {
  watchReadiness(paneId)

  if (readyPanes.has(paneId)) {
    const r = terminalHost.runtime(paneId)
    if (r.status === 'live') {
      typeAndSubmit(paneId, [goal], onFail)
      return
    }
    // Exited or relaunching — fall through to the queued path, which watches.
    readyPanes.delete(paneId)
  }

  const existing = deliveries.get(paneId)
  if (existing) {
    existing.goals.push(goal)
    existing.onFail = onFail
    return
  }

  const d: Delivery = {
    goals: [goal],
    createdAt: performance.now(),
    lastOutput: performance.now(),
    unsubscribe: terminalHost.subscribeActivity(paneId, () => {
      const live = deliveries.get(paneId)
      if (live) live.lastOutput = performance.now()
    }),
    onFail,
    timer: 0
  }

  d.timer = window.setInterval(() => {
    const now = performance.now()
    const r = terminalHost.runtime(paneId)
    if (r.status === 'exited' || r.status === 'error') {
      endDelivery(paneId)
      d.onFail('The planner session ended before the goal could be sent — press Enter in its terminal to relaunch')
      return
    }
    if (r.status === 'live' && now - d.createdAt >= DELIVER_MIN_BOOT_MS && now - d.lastOutput >= DELIVER_QUIET_MS) {
      readyPanes.add(paneId)
      const goals = d.goals
      endDelivery(paneId)
      typeAndSubmit(paneId, goals, d.onFail)
      return
    }
    if (now - d.createdAt > DELIVER_GIVE_UP_MS) {
      endDelivery(paneId)
      d.onFail('The planner is still starting — click into its terminal to see why, then send the goal again')
    }
  }, DELIVER_TICK_MS)

  deliveries.set(paneId, d)
}

/* ---------------------------------------------------------- proposal store */

/**
 * A plan under review: prose plus prunable briefs. Local, renderer-side state
 * on purpose — an unapproved plan is a conversation, not data — but held in a
 * module singleton (the terminalHost pattern) rather than component state, so
 * the dock and the maximized desk are always looking at the same proposal.
 *
 * `signature` is what keeps the store honest against transcript replays: a
 * re-watch (project switch, restart) drains the whole transcript again and
 * re-pushes the last plan. Same signature = same plan, so a replay neither
 * clobbers your pruning nor resurrects a plan you dealt or discarded.
 */
export interface PlannerProposal {
  plan: string | null
  tasks: string[]
  signature: string
}

/** Dealt/discarded signatures survive a restart — pure UI memory, like the dock height. */
const DISMISS_KEY = 'forge:plannerDismissed'

function loadDismissed(): Map<string, string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return new Map()
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return new Map()
    const out = new Map<string, string>()
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out.set(k, v)
    return out
  } catch {
    return new Map()
  }
}

class PlannerStore {
  private proposals = new Map<string, PlannerProposal>()
  private dismissed = loadDismissed()
  private listeners = new Set<() => void>()
  private lastSeq = new Map<string, number>()
  private wired = false

  /** Subscribe once to the main-process watcher, lazily on first use. */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    window.forge.planner.onUpdate((u) => this.receive(u))
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }

  private persistDismissed(): void {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(this.dismissed)))
    } catch {
      /* a full quota loses nothing that matters */
    }
  }

  private receive(u: PlannerUpdate): void {
    if (!u.projectId) return
    // Within one watch the sequence is monotonic; a smaller seq means the
    // watch was replaced (project switch, restart) and the counter restarted.
    const last = this.lastSeq.get(u.projectId) ?? 0
    if (u.seq > 1 && u.seq <= last) return
    this.lastSeq.set(u.projectId, u.seq)

    const tasks = u.tasks
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().slice(0, MAX_TASK_TEXT))
      .filter((t) => t.length > 0)
      .slice(0, MAX_TASK_CARDS)
    if (tasks.length === 0) return

    const signature = JSON.stringify([u.plan, tasks])
    if (this.dismissed.get(u.projectId) === signature) return
    const current = this.proposals.get(u.projectId)
    // A replay of the proposal already on screen — keep it, prunes and all.
    if (current && current.signature === signature) return

    this.proposals.set(u.projectId, { plan: u.plan, tasks, signature })
    this.emit()
  }

  /**
   * Start listening to the main-process watcher without subscribing to
   * renders. The panel calls this once on mount: plans must be collected even
   * while the rail is collapsed and no board is mounted to subscribe.
   */
  prime = (): void => {
    this.wire()
  }

  subscribe = (cb: () => void): (() => void) => {
    this.wire()
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  proposal = (projectId: string | null): PlannerProposal | null => {
    return projectId ? (this.proposals.get(projectId) ?? null) : null
  }

  /** Drop one brief from the plan under review. Pruning the last one discards. */
  prune(projectId: string, index: number): void {
    const current = this.proposals.get(projectId)
    if (!current) return
    const tasks = current.tasks.filter((_, i) => i !== index)
    if (tasks.length === 0) {
      this.discard(projectId)
      return
    }
    this.proposals.set(projectId, { ...current, tasks })
    this.emit()
  }

  /**
   * The plan is settled — dealt into cards, or refused. Either way it leaves
   * the review stage and must not come back on the next transcript replay.
   */
  discard(projectId: string): void {
    const current = this.proposals.get(projectId)
    if (!current) return
    this.dismissed.set(projectId, current.signature)
    this.persistDismissed()
    this.proposals.delete(projectId)
    this.emit()
  }
}

export const plannerStore = new PlannerStore()

/**
 * Foreman: the facts about a driven pane that every surface has to agree on.
 *
 * Foreman is a per-pane toggle. Switched on, it takes a one-line seed from
 * Steve — "website for a sweet shop" — forms its *own* full concept, writes the
 * brief into the pane's Claude session, and then drives that session to the
 * end: it answers every question and permission prompt the terminal comes back
 * with, hires other agent panes when a job suits them, and stops only when it
 * judges the work genuinely finished. Every decision in that loop is Foreman's.
 * Switching it off hands the keyboard straight back to the human.
 *
 * Three surfaces will draw this state — the desktop footer, Forge Web and Forge
 * Mobile — so the shape lives here rather than in any one of them, the way
 * shared/activity.ts holds the activity tracker's. Everything below is plain
 * JSON on purpose: no Dates, no Maps, no class instances, nothing that survives
 * a `structuredClone` but not a `JSON.stringify`. The next job puts these
 * objects on a WebSocket unchanged.
 *
 * The main-process half is electron/foreman/ — `host.ts` holds the session and
 * the loop and imports no Electron at all, `ipc.ts` is the thin Electron glue.
 */

/**
 * Where a driven pane is in the job.
 *
 *  - `off` — nobody is driving. The only status a pane that was never started
 *    reports, and the one `stop` returns it to.
 *  - `starting` — the seed is in, the session is opening, no brief written yet.
 *  - `driving` — a turn is in flight. Foreman is reading, thinking or typing.
 *  - `waiting` — the turn ended and nothing is pending. Foreman is waiting for
 *    the pane to ask something or go quiet. This is the resting state of a
 *    healthy job, not an idle one.
 *  - `done` — Foreman called `finish`. The job is finished and verified as far
 *    as Foreman is concerned; the session is closed.
 *  - `error` — the brain died or could not start. `line` says what happened.
 */
export type ForemanStatus = 'off' | 'starting' | 'driving' | 'waiting' | 'done' | 'error'

/**
 * One line in the account of what Foreman did.
 *
 * Written for a human reading back afterwards, not for a machine: the log is
 * the only record of *why* a pane got the answer it got, because the reasoning
 * itself lives in a session nobody watches.
 *
 *  - `seed` — what Steve typed to start it.
 *  - `brief` — the full concept Foreman wrote and sent into the pane.
 *  - `answer` — a reply to a question or a permission prompt.
 *  - `instruction` — the next piece of work, sent into a quiet pane.
 *  - `hire` — another agent pane opened for a job that suited it.
 *  - `note` — Foreman's own aside about the job.
 *  - `done` — the finishing summary.
 *  - `error` — something went wrong.
 */
export interface ForemanLogEntry {
  /** `Date.now()` when it happened. A number, so it survives the wire. */
  at: number
  kind: 'seed' | 'brief' | 'answer' | 'instruction' | 'hire' | 'note' | 'done' | 'error'
  text: string
}

/** Everything a surface needs to draw one driven pane. */
export interface ForemanState {
  /** The pane being driven — a PTY session id, the same one the layout uses. */
  paneId: string
  status: ForemanStatus
  /**
   * One line for the footer: what Foreman is doing right now, in words a person
   * reads at a glance. "Writing the brief", "Answering: overwrite index.html?",
   * "Waiting for the pane". Never a path, never an id.
   */
  line: string
  /** The seed Steve started it with. Kept so the UI can show what was asked. */
  seed: string
  /** Oldest first, capped at FOREMAN_LOG_MAX — the oldest entries fall off. */
  log: ForemanLogEntry[]
}

/** Switch Foreman on for one pane. */
export interface ForemanStartRequest {
  paneId: string
  /** Steve's one line. Foreman forms the actual concept from this itself. */
  seed: string
}

/**
 * Foreman asking the app for something only the renderer can do.
 *
 * Today that is one thing — opening a pane for a hired agent — so `args` is an
 * app action in the shape src/lib/appactions.ts parses, the same vocabulary the
 * voice agent's `run_app_action` uses.
 */
export interface ForemanToolRequest {
  /** Answer exactly this id, exactly once. */
  id: string
  name: 'run_app_action'
  args: unknown
}

/** The renderer's answer. `ok: false` with a reason is still an answer. */
export interface ForemanToolResult {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * The channels, defined here rather than inline in shared/ipc.ts so the wire
 * job that follows has the whole vocabulary in one file. `IPC` re-exports each
 * of them by name, which is how the preload and the renderer reach them.
 */
export const FOREMAN_IPC = {
  /** renderer → main, invoke. Takes a ForemanStartRequest, returns ForemanState. */
  start: 'foreman:start',
  /** renderer → main, invoke. Takes a paneId, returns the pane's ForemanState. */
  stop: 'foreman:stop',
  /** renderer → main, invoke. Returns every ForemanState main is holding. */
  list: 'foreman:list',
  /** main → renderer, push. One ForemanState, whenever anything about it moves. */
  state: 'foreman:state',
  /**
   * main → renderer, push. Foreman asking the app to do something — opening a
   * pane for a hired agent is the only one so far, and only the renderer knows
   * what is open. Answered exactly once, on `result`.
   *
   * Its own pair rather than the voice agent's: `voice-agent:tool-request` is
   * consumed by src/state/VoiceAgent.tsx and answered on
   * `voice-agent:tool-result`, and two hosts sharing one channel would have
   * each other's answers resolving their promises.
   */
  toolRequest: 'foreman:tool-request',
  /** renderer → main, invoke. The answer to one `toolRequest`, by id. */
  toolResult: 'foreman:tool-result'
} as const

/**
 * How many log entries one pane keeps.
 *
 * A long job is hundreds of answers, and the whole state object is pushed at
 * the renderer on every change — so this is a push-size limit as much as a
 * memory one. The oldest lines go first: what Foreman just did is what a
 * person is reading.
 */
export const FOREMAN_LOG_MAX = 200

/**
 * The longest standing brief Forge will keep — `settings.foremanBrief`.
 *
 * It is read back to Foreman through a tool on a session that may run for
 * hours, so it is house rules rather than a document. 8 KB is several pages,
 * which is already more than anyone should have to hold in their head.
 */
export const FOREMAN_BRIEF_MAX = 8 * 1024

/**
 * The standing brief a fresh install starts with.
 *
 * Steve's own defaults, written as instructions to Foreman rather than as
 * documentation about him — it is read by a model that is about to make
 * decisions, not by a person browsing settings. Editable in Settings, and an
 * empty one is a valid answer that means "use your judgement".
 */
export const DEFAULT_FOREMAN_BRIEF = `Backend: Supabase for anything new that needs one. Firebase only where the project already lives on it — never migrate a working backend as part of another job.

House rules:
- Plan before building. Have the pane produce a plan you can read, then correct it in one message rather than unpicking a half-built wrong thing.
- Anything non-trivial starts with /gaffer, and the loop is /fable-method.
- Every suite stays green. A red test is the only job until it is not red.
- Commit small and often, with real messages. Never one commit at the end.
- Verify by observation, never by assumption: read the output back before you believe it.

Keys and credentials live in Forge's own Settings, under Models & APIs. Never put one in a file, a commit or a prompt.`

/** The longest one log line may be. Screen tails and briefs are long. */
export const FOREMAN_LOG_TEXT_MAX = 2000

/** The longest seed Foreman accepts. It is one line, not a brief. */
export const FOREMAN_SEED_MAX = 2000

/** The starting state for a pane nobody has driven. */
export function idleForemanState(paneId: string): ForemanState {
  return { paneId, status: 'off', line: '', seed: '', log: [] }
}

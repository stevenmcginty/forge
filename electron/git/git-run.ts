import { execFile } from 'node:child_process'
import { whichCommand } from '../which'

/**
 * The only place in Forge that spawns git for a *project* folder.
 *
 * There are two other git call sites and neither is this one's business.
 * electron/git-remote.ts answers "where does this folder push?" synchronously,
 * because one of its callers sits inside the synchronous `pty:create` handler
 * and has no business becoming async for it. electron/source-updater.ts drives
 * Forge's own checkout. Both stay exactly as they are; everything the rail asks
 * about a project comes through here, so there is one env, one timeout policy
 * and one place to look when git starts behaving strangely.
 *
 * ## The environment is the load-bearing part
 *
 * A background process asking git about a folder can, if you let it, take a lock
 * the agent in the next pane needs, or raise a Windows dialog over Forge asking
 * for a password nobody typed a command to be asked for. Every variable below is
 * there to stop one specific version of that.
 *
 * `GIT_OPTIONAL_LOCKS=0` is the one that matters most. A plain `git status`
 * refreshes and rewrites the index, which means it takes `index.lock` — and it
 * will happily take it out from under an agent that is mid-commit. With optional
 * locks off, status is a pure read and the two never meet.
 *
 * `GIT_TERMINAL_PROMPT=0` closes the terminal door on credential prompts. It does
 * *not* close the GUI one: Git Credential Manager on Windows will raise a modal
 * from a background fetch, over Forge, with nothing on screen explaining what
 * asked for it. `GCM_INTERACTIVE=never` and the two empty askpass variables close
 * the rest. Three variables, and they are the difference between a quiet feature
 * and the worst bug in it.
 */

/** Local reads — status, branches, rev-parse. Generous; git is usually instant. */
export const GIT_TIMEOUT_MS = 6_000

/** Anything that touches the network. Fetch over a slow VPN is not a fault. */
export const GIT_NET_TIMEOUT_MS = 30_000

/**
 * How many git processes Forge will run at once, across every project.
 *
 * Three, because the read path is three processes deep and one project mid-read
 * should not be able to starve a second one that Steve has just clicked on.
 * Above that they queue. Without a cap, a burst of watcher events during a
 * rebase queues a dozen `git status` calls and the machine notices.
 */
const MAX_CONCURRENT = 3

export interface GitResult {
  ok: boolean
  code: number
  out: string
  err: string
  /** Wall-clock ms. The status reader uses this to decide a repo is slow. */
  ms: number
}

/* --------------------------------------------------------------- availability */

let cachedGit: string | null | undefined

/**
 * Is git on the machine at all?
 *
 * Cached, because the answer changes about once a year and `whichCommand` walks
 * PATH on every call. Every trigger in the watcher gates on this first: without
 * it, a machine with no git spawns a process that fails several times a minute
 * for as long as the rail is open.
 */
export function gitAvailable(): boolean {
  if (cachedGit === undefined) cachedGit = whichCommand('git')
  return cachedGit !== null
}

/** Forget the cached answer. Only the explicit refresh button calls this. */
export function invalidateGitAvailable(): void {
  cachedGit = undefined
}

/* ------------------------------------------------------------------ the gate */

/**
 * One queue per repository root, plus a global count.
 *
 * Two calls against the same folder are serialised outright — git is perfectly
 * capable of running them in parallel, but the second one is nearly always about
 * to be made stale by the first, and a status read racing a commit is how you
 * get an answer that never existed.
 */
const perRepo = new Map<string, Promise<unknown>>()
let running = 0
const waiting: Array<() => void> = []

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running++
      resolve()
    })
  })
}

function release(): void {
  running--
  const next = waiting.shift()
  if (next) next()
}

/* --------------------------------------------------------------------- env */

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // See the block comment above. Each of these is closing one door.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // Anything we parse has to come back in a language we parse. `git status
    // --porcelain` is stable by contract, but error text is not, and
    // gitFailureReason() reads error text.
    LC_ALL: 'C',
    NO_COLOR: '1',
    // A pager on a background process is a process that never exits.
    GIT_PAGER: 'cat',
    PAGER: 'cat'
  }
}

/* -------------------------------------------------------------------- run */

/**
 * Run one git command in one folder.
 *
 * Never rejects. A git that fails, times out, or cannot be spawned at all comes
 * back as `ok: false` with whatever it managed to say, because every caller here
 * has a sensible answer for "git could not tell me" and none of them has one for
 * an exception. `code` is -1 when there was no exit code to have — a spawn
 * failure or a timeout.
 *
 * `execFile`, never `exec`. Nothing here goes near a shell, so a branch name
 * with a semicolon in it is a branch name with a semicolon in it.
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; repoKey?: string }
): Promise<GitResult> {
  if (!gitAvailable()) return { ok: false, code: -1, out: '', err: 'git is not installed', ms: 0 }

  const key = (opts?.repoKey ?? cwd).toLowerCase()
  const prior = perRepo.get(key) ?? Promise.resolve()

  /*
   * `link` — not the call itself — is what the next caller waits on, and what
   * the cleanup below compares against. They have to be the same object: a
   * `.catch()` returns a *new* promise, so building one at compare time would
   * never match what was stored and the map would grow one entry per project
   * forever. It is a small leak and an easy one to write twice, hence the note.
   *
   * The catch is belt and braces — exec() never rejects — but a queue that can
   * be broken by one rejection is a queue that deadlocks a project until
   * restart, which is not a failure mode worth leaving open.
   */
  const call = prior.then(() => exec(cwd, args, opts?.timeoutMs ?? GIT_TIMEOUT_MS))
  const link: Promise<unknown> = call.catch(() => undefined)
  perRepo.set(key, link)

  const result = await call
  // Only the tail of the queue clears the key, so a project nobody looks at
  // again does not keep a settled promise alive for the life of the process.
  if (perRepo.get(key) === link) perRepo.delete(key)
  return result
}

function exec(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    void acquire().then(() => {
      const started = Date.now()
      execFile(
        'git',
        args,
        {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'buffer',
          // A status on a repository whose first commit swept in node_modules is
          // megabytes of paths. 8MB is far more than the 500-file cap upstream
          // will keep, and still bounded.
          maxBuffer: 8 * 1024 * 1024,
          env: gitEnv()
        },
        (error, stdout, stderr) => {
          release()
          const out = bufferToString(stdout)
          const err = bufferToString(stderr)
          const ms = Date.now() - started
          if (!error) {
            resolve({ ok: true, code: 0, out, err, ms })
            return
          }
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
          resolve({ ok: false, code, out, err: err || error.message, ms })
        }
      )
    })
  })
}

/**
 * Bytes to text, without letting a decode failure lose the whole answer.
 *
 * git speaks UTF-8 for paths under `-z`, but a repository can contain a filename
 * that is not valid UTF-8 in any encoding — Windows filesystems will hold one
 * quite happily. Node replaces those bytes rather than throwing, which is the
 * behaviour we want: one unreadable filename should cost that row, not the
 * status of the whole project.
 */
function bufferToString(value: Buffer | string | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : value.toString('utf8')
}

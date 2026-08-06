import { gitFailureReason } from '@shared/tools'
import type { GitActionKind, GitActionRequest, GitActionResult, GitSnapshot, GitUpstreamState } from '@shared/types'
import { getProjects } from '../store'
import { GIT_NET_TIMEOUT_MS, runGit } from './git-run'
import { readStatus } from './git-status'

/**
 * The only place in Forge that runs a git command which changes a repository —
 * and it will only ever run five of them.
 *
 * The rule the whole rail is built on is that Forge shows you where you stand
 * and does the small safe things, and everything with a judgement in it goes to
 * an agent as a pre-written prompt you read before pressing Enter. So: fetch,
 * fast-forward pull, push, switch, and stage-everything-then-commit. No rebase,
 * no merge, no reset, no discard, no branch deletion, no remote creation. Those
 * are not missing features; they are the other half of the design.
 *
 * ## Safety, in layers, because one layer is a promise rather than a mechanism
 *
 * **The request carries a project id, never a path.** Main resolves it against
 * its own project list, so a renderer — or anything that ever manages to talk to
 * one — cannot ask Forge to run git in a folder of its choosing.
 *
 * **argv, never a shell.** Every command goes to `execFile` as an array. The
 * commit message is one array element, so there is no quoting surface and
 * nothing to inject; a message containing a semicolon, a backtick and a newline
 * is a message containing a semicolon, a backtick and a newline. The next person
 * here will be tempted by `exec` and a template string. Do not.
 *
 * **A switch with no default.** An action this module does not know is refused
 * before anything is spawned rather than falling through to something adjacent.
 *
 * **The dangerous flags are not in this file.** Not guarded against, not
 * conditional — absent, and `npm run git:check` reads the source to prove it and
 * walks every argv `argvFor` can produce to prove it again.
 *
 * **Argv is rebuilt from a fresh status read.** The renderer's snapshot is a
 * moment old and an agent in the pane next door may have switched branch inside
 * that moment, so nothing the renderer holds is used to decide what to run. Push
 * in particular is never handed a branch name from outside.
 */

/** A commit message longer than this is a paste accident, not a message. */
export const COMMIT_MESSAGE_MAX = 500

/**
 * The staging step of a commit, kept beside `argvFor` rather than inside it.
 *
 * A commit is two commands and `argvFor` answers with one, so the pair are
 * exported separately and asserted separately. Everything the working tree has —
 * modifications, additions, deletions, untracked files — goes in: the button
 * says "commit everything" and a partial commit is a decision the panel does not
 * have the surface to express honestly.
 */
export const STAGE_ALL_ARGV: readonly string[] = ['add', '--all']

/** Everything `argvFor` needs, and nothing that would let it read a path. */
export interface ActionContext {
  /** The branch as of the fresh read. Null when detached or before the first commit. */
  branch: string | null
  state: GitUpstreamState
  /** switch only — the branch to move to. */
  target?: string
  /** commit only. */
  message?: string
}

/**
 * The exact command for one action.
 *
 * Pure, and exported so `npm run git:check` can hold every branch of it to the
 * five lines above without a repository, a spawn or a temporary folder. The
 * check walks each action in each precondition and asserts the argv element by
 * element, which is the only way a table like this stays the table it says it is.
 */
export function argvFor(action: GitActionKind, ctx: ActionContext): string[] {
  switch (action) {
    case 'fetch':
      // --prune, because a branch list still showing remote branches that were
      // tidied up when their pull requests merged is a list that lies quietly.
      return ['fetch', '--prune', 'origin']

    case 'pull':
      // Fast-forward or nothing. A pull that can merge is a pull that can leave
      // a conflicted tree behind a button press, and resolving a conflict is
      // exactly the kind of judgement this module hands to an agent instead.
      return ['pull', '--ff-only']

    case 'push':
      // A branch that has never been published needs the upstream setting in the
      // same breath, or the push succeeds and the panel still says unpublished.
      // The branch name comes from the fresh read, never from the renderer.
      return ctx.state === 'unpublished' && ctx.branch
        ? ['push', '--set-upstream', 'origin', ctx.branch]
        : ['push']

    case 'switch':
      // --no-guess is the important half. Without it, a mistyped branch name
      // that happens to match a remote branch silently creates a new local one
      // tracking it, and you are somewhere you did not ask to be.
      return ['switch', '--no-guess', ctx.target ?? '']

    case 'commit':
      // One element for the message. See the note about `exec` above.
      return ['commit', '-m', ctx.message ?? '']
  }

  /*
   * Unreachable for a real GitActionKind, and never reached at runtime either:
   * runGitAction refuses an unknown action before it gets here. An empty argv
   * rather than a throw so that a future caller which skips that gate spawns
   * nothing rather than spawning something adjacent.
   */
  return []
}

/** Actions that leave the machine, and therefore get the network timeout. */
function isNetworkAction(action: GitActionKind): boolean {
  return action === 'fetch' || action === 'pull' || action === 'push'
}

function isActionKind(value: unknown): value is GitActionKind {
  return value === 'fetch' || value === 'pull' || value === 'push' || value === 'switch' || value === 'commit'
}

/**
 * Why this action must not run, in one sentence, or null if it may.
 *
 * Checked against the **fresh** snapshot rather than the one the button was
 * drawn from. Every sentence here is written to be shown to a person: a button
 * that refuses silently is worse than one that is greyed out, and a button that
 * refuses with git's own words is worse than both.
 */
export function refusalFor(action: GitActionKind, snap: GitSnapshot, req: GitActionRequest): string | null {
  if (snap.conflicted > 0 && (action === 'switch' || action === 'commit')) {
    return `${snap.conflicted} file${snap.conflicted === 1 ? ' is' : 's are'} conflicted — hand that to an agent first`
  }

  switch (action) {
    case 'fetch':
      if (!snap.remoteUrl) return 'This repository has no origin to fetch from'
      return null

    case 'pull':
      if (snap.unborn) return 'There are no commits here yet — nothing to pull onto'
      if (snap.detached) return 'HEAD is detached — switch to a branch before pulling'
      if (!snap.remoteUrl) return 'This repository has no origin to pull from'
      if (snap.state === 'unpublished') return `${snap.branch ?? 'This branch'} has no upstream to pull from`
      return null

    case 'push':
      if (snap.unborn) return 'There are no commits here yet — make the first one before pushing'
      if (snap.detached) return 'HEAD is detached — switch to a branch before pushing'
      if (!snap.remoteUrl) return 'This repository has no origin to push to'
      if (!snap.branch) return 'There is no branch here to push'
      return null

    case 'switch': {
      const target = (req.branch ?? '').trim()
      if (!target) return 'No branch was named'
      /*
       * A name beginning with a hyphen would sit where git expects an option
       * and be read as one. git itself refuses to create such a ref, and the
       * next test refuses anything not in the live branch list — so this can
       * only ever fire on something deliberately malformed. It is here anyway,
       * because "that could not happen" is how the argv-not-a-shell guarantee
       * gets quietly downgraded to a convention.
       */
      if (target.startsWith('-')) return 'A branch name cannot begin with a hyphen'
      // The live list, not the one the button was drawn from: a branch an agent
      // deleted thirty seconds ago must not still be switchable to.
      if (!snap.branches.some((b) => b.name === target)) return `There is no local branch called ${target}`
      return null
    }

    case 'commit': {
      const message = (req.message ?? '').trim()
      if (!message) return 'A commit needs a message'
      if (message.length > COMMIT_MESSAGE_MAX) return `That message is longer than ${COMMIT_MESSAGE_MAX} characters`
      if (snap.changed === 0) return 'Nothing has changed here to commit'
      return null
    }
  }

  return 'That is not something Forge runs'
}

/* ------------------------------------------------------------- the running */

/**
 * One git command at a time per project.
 *
 * Not for git's sake — it copes — but for the panel's: two pushes queued behind
 * one double-click both report success, and the second one reports it against a
 * repository the first one already changed.
 */
const inFlight = new Set<string>()

/**
 * Run one of the five, and answer with what the repository looks like afterwards.
 *
 * The snapshot handed back always comes from a read taken *after* the command,
 * whether it worked or not, so there is no arrangement of clicks that leaves the
 * panel showing a state that predates the button. Its `seq` is a placeholder:
 * the watcher owns the monotonic counter and stamps the snapshot on its way out,
 * because two independent sources of sequence numbers is precisely the bug `seq`
 * exists to prevent.
 */
export async function runGitAction(req: GitActionRequest): Promise<GitActionResult> {
  const action = req?.action
  if (!isActionKind(action)) return { ok: false, error: 'That is not something Forge runs' }

  const projectId = String(req?.projectId ?? '')
  const project = getProjects().find((p) => p.id === projectId)
  if (!project) return { ok: false, error: 'Forge does not know that project any more' }

  if (inFlight.has(projectId)) return { ok: false, error: 'A git command is already running for this project' }
  inFlight.add(projectId)

  try {
    const before = await readStatus(projectId, project.path, null, 0)
    if (before.presence !== 'ok') {
      return { ok: false, error: before.error ?? 'There is no repository here to work on', snapshot: before }
    }

    const refusal = refusalFor(action, before, req)
    if (refusal) return { ok: false, error: refusal, snapshot: before }

    const repoKey = before.repoRoot ?? project.path
    const timeoutMs = isNetworkAction(action) ? GIT_NET_TIMEOUT_MS : undefined

    // Staging is its own command and its own failure. A commit that reports the
    // message as the problem when it was the staging step is a commit nobody can
    // debug from the sentence they were shown.
    if (action === 'commit') {
      const staged = await runGit(project.path, [...STAGE_ALL_ARGV], { repoKey })
      if (!staged.ok) {
        const after = await readStatus(projectId, project.path, null, 0)
        return { ok: false, error: gitFailureReason(staged.err, staged.out), snapshot: after }
      }
    }

    const ctx: ActionContext = {
      branch: before.branch,
      state: before.state,
      ...(req.branch ? { target: req.branch.trim() } : {}),
      ...(req.message ? { message: req.message.trim() } : {})
    }
    const result = await runGit(project.path, argvFor(action, ctx), { repoKey, ...(timeoutMs ? { timeoutMs } : {}) })

    const after = await readStatus(projectId, project.path, null, 0)
    if (!result.ok) return { ok: false, error: gitFailureReason(result.err, result.out), snapshot: after }
    return { ok: true, snapshot: after }
  } finally {
    inFlight.delete(projectId)
  }
}

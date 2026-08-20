import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { GIT_NET_TIMEOUT_MS, runGit } from './git-run'

/**
 * Keep GitHub current, so that the browser has something worth reading when
 * this machine is not reachable.
 *
 * docs/GITHUB-FALLBACK-PLAN.md, Phase A. Forge Web's GitHub mode reads the
 * repository from GitHub when the desktop is asleep — and until this module
 * existed, GitHub held whatever was last pushed by hand, which could be days
 * behind the working tree an agent has been editing all afternoon. This is the
 * other half of that feature: the desktop's side of "GitHub is the durable
 * place".
 *
 * Two things happen, both after a pane goes idle and settles, never on a timer:
 *
 *  1. **The branch is pushed** when it is ahead of its upstream and not behind
 *     it. Ordinary `git push`, nothing clever. Skipped when there is no upstream
 *     — publishing a branch is a decision, and the shelf below carries the
 *     commits anyway.
 *
 *  2. **The working tree is shelved.** Index plus working tree, respecting
 *     .gitignore, written as a commit whose parent is HEAD — built in a
 *     *temporary index*, so the real index, the branch and the working tree are
 *     untouched — and force-pushed to `refs/heads/forge-wip/<machine>/<branch>`.
 *     Force is correct: the shelf is a mirror of one machine's tree at one
 *     moment, not history, and the previous mirror has no value once there is a
 *     newer one. Because its parent is HEAD, the shelf also carries every local
 *     commit, published or not.
 *
 * What is deliberately *not* done:
 *
 *  - No commit on the real branch. The working tree is Steve's and the agent's;
 *    a background process that commits for them would be a background process
 *    that writes history nobody asked for.
 *  - No shelf while a merge, rebase or cherry-pick is in progress. Half a merge
 *    is not a state worth mirroring, and `git add -A` in the middle of one
 *    resolves conflicts by declaring them resolved.
 *  - No shelf on a detached HEAD or an unborn branch. There is no branch name to
 *    file it under, and a detached HEAD is usually somebody looking, not working.
 *  - Nothing pushed that has not changed: the shelf remembers the tree it last
 *    pushed per repository and stays quiet while it is the same tree.
 *
 * The trigger is the renderer's `activity:busy` edge — the same one the ACTIVITY
 * section and the GIT section already ride — fed in by `noteBusy` from
 * git-watcher.ts's neighbour. A pane going busy cancels a pending shelf for its
 * project; a pane going idle arms one, SHELF_SETTLE_MS later, so an agent that
 * pauses for a second between two tool calls does not cost a push each time.
 * Quitting flushes whatever is armed, best effort, without holding the app open.
 *
 * Credentials are git's own. `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`
 * in git-run.ts mean a push that needs a login fails quietly rather than
 * hanging a hidden process on a prompt, and the failure is reported once per
 * repository through `shelfState` rather than on every idle edge.
 */

/** Everything the plan calls the shelf prefix. Shared with the web client by name. */
export const SHELF_PREFIX = 'forge-wip/'

/** An idle pane has to stay idle this long before its project is shelved. */
export const SHELF_SETTLE_MS = 20_000

/** Never shelve one repository more often than this, whatever the panes do. */
const SHELF_MIN_GAP_MS = 60_000

/** How many recent outcomes to keep per repository, for the settings card. */
export interface ShelfOutcome {
  at: number
  repoRoot: string
  branch: string
  /** What happened. `quiet` is "nothing changed since the last shelf". */
  kind: 'shelved' | 'pushed' | 'quiet' | 'skipped' | 'failed'
  detail: string
}

export interface ShelfState {
  enabled: boolean
  machine: string
  last: ShelfOutcome | null
  /** Projects with an armed timer right now. */
  pending: string[]
}

type Deps = {
  enabled: () => boolean
  /** The folder for a project id, resolved in main. Null when unknown. */
  pathFor: (projectId: string) => string | null
  onOutcome?: (outcome: ShelfOutcome) => void
}

let deps: Deps | null = null
const timers = new Map<string, NodeJS.Timeout>()
const lastTree = new Map<string, string>()
const lastRun = new Map<string, number>()
const inFlight = new Set<string>()
let last: ShelfOutcome | null = null

/**
 * The machine's name as a ref component. Hostnames can carry characters a ref
 * cannot (spaces, on a Mac; anything, on Windows), so everything outside the
 * safe set becomes a hyphen and an empty result falls back to a constant.
 */
export function machineRefName(raw = hostname()): string {
  const safe = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/\.lock$/i, '')
  return safe || 'forge'
}

/** The full ref the shelf for `branch` on this machine is pushed to. */
export function shelfRef(branch: string, machine = machineRefName()): string {
  return `refs/heads/${SHELF_PREFIX}${machine}/${branch}`
}

export function configureShelf(next: Deps): void {
  deps = next
}

export function shelfState(): ShelfState {
  return {
    enabled: deps?.enabled() ?? false,
    machine: machineRefName(),
    last,
    pending: [...timers.keys()]
  }
}

/**
 * A pane's busy edge. Busy cancels; idle arms.
 *
 * Called for every pane of every project, not only the watched one — the
 * whole point is that the project you were working on an hour ago is on GitHub
 * when the lid closes, whether or not the rail is still looking at it.
 */
export function noteBusy(projectId: string, busy: boolean): void {
  if (!deps || !projectId) return
  const armed = timers.get(projectId)
  if (armed) {
    clearTimeout(armed)
    timers.delete(projectId)
  }
  if (busy || !deps.enabled()) return
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId)
      void shelfProject(projectId)
    }, SHELF_SETTLE_MS)
  )
}

/** Quit: fire every armed shelf now. Not awaited — the app is leaving. */
export function flushShelves(): void {
  for (const [projectId, timer] of timers) {
    clearTimeout(timer)
    void shelfProject(projectId, { force: true })
  }
  timers.clear()
}

/** Disarm every timer. `deps` stays, so a flush already in flight can finish. */
export function disposeShelf(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

async function shelfProject(projectId: string, opts?: { force?: boolean }): Promise<ShelfOutcome | null> {
  if (!deps || !deps.enabled()) return null
  const cwd = deps.pathFor(projectId)
  if (!cwd) return null
  return shelfFolder(cwd, opts)
}

/**
 * Shelve one folder. Exported for the smoke test, which has a scratch
 * repository and a bare remote and no renderer to send busy edges.
 */
export async function shelfFolder(cwd: string, opts?: { force?: boolean; machine?: string }): Promise<ShelfOutcome> {
  const machine = opts?.machine ?? machineRefName()
  const report = (outcome: ShelfOutcome): ShelfOutcome => {
    last = outcome
    try {
      deps?.onOutcome?.(outcome)
    } catch {
      /* a listener must not break the shelf */
    }
    if (outcome.kind === 'failed') console.warn(`[shelf] ${outcome.branch} in ${outcome.repoRoot}: ${outcome.detail}`)
    return outcome
  }
  const skipped = (repoRoot: string, branch: string, detail: string): ShelfOutcome =>
    report({ at: Date.now(), repoRoot, branch, kind: 'skipped', detail })

  const top = await runGit(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
  if (!top.ok) return skipped(cwd, '', 'not a git repository')
  const [repoRootRaw, gitDirRaw] = top.out.trim().split(/\r?\n/)
  const repoRoot = native(repoRootRaw ?? cwd)
  const gitDir = native(gitDirRaw ?? join(repoRoot, '.git'))
  const key = repoRoot.toLowerCase()

  if (inFlight.has(key)) return skipped(repoRoot, '', 'already shelving')
  const since = Date.now() - (lastRun.get(key) ?? 0)
  if (!opts?.force && since < SHELF_MIN_GAP_MS) return skipped(repoRoot, '', 'shelved less than a minute ago')

  inFlight.add(key)
  lastRun.set(key, Date.now())
  try {
    const head = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (!head.ok) return skipped(repoRoot, '', 'detached HEAD')
    const branch = head.out.trim()
    if (!branch) return skipped(repoRoot, '', 'detached HEAD')
    if (branch.startsWith(SHELF_PREFIX)) return skipped(repoRoot, branch, 'that is a shelf branch itself')

    const born = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    if (!born.ok) return skipped(repoRoot, branch, 'no commits yet')
    const headSha = born.out.trim()

    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
      if (existsSync(join(gitDir, marker))) return skipped(repoRoot, branch, `${marker.replace(/[-_]/g, ' ').toLowerCase()} in progress`)
    }

    const origin = await runGit(repoRoot, ['remote', 'get-url', 'origin'])
    if (!origin.ok || !origin.out.trim()) return skipped(repoRoot, branch, 'no origin')

    /* ------------------------------------------------ 1. push the branch */

    let pushed: string | null = null
    const drift = await runGit(repoRoot, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    if (drift.ok) {
      const [behindRaw, aheadRaw] = drift.out.trim().split(/\s+/)
      const behind = Number.parseInt(behindRaw ?? '', 10)
      const ahead = Number.parseInt(aheadRaw ?? '', 10)
      if (ahead > 0 && behind === 0) {
        const push = await runGit(repoRoot, ['push', '--quiet'], { timeoutMs: GIT_NET_TIMEOUT_MS, repoKey: repoRoot })
        if (!push.ok) {
          return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `push: ${firstLine(push.err)}` })
        }
        pushed = `${ahead} commit${ahead === 1 ? '' : 's'}`
      }
    }

    /* ------------------------------------------------ 2. shelve the tree */

    const tmpIndex = join(gitDir, 'forge-wip.index')
    const env = { GIT_INDEX_FILE: tmpIndex }
    // Start the temporary index from HEAD rather than from the real index: the
    // real one may be mid-`git add -p`, and a shelf is "what is on disk", not
    // "what is staged".
    const seed = await runGit(repoRoot, ['read-tree', headSha], { env })
    if (!seed.ok) return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `read-tree: ${firstLine(seed.err)}` })
    const add = await runGit(repoRoot, ['add', '-A', '--', '.'], { env, timeoutMs: GIT_NET_TIMEOUT_MS })
    if (!add.ok) return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `add: ${firstLine(add.err)}` })
    const tree = await runGit(repoRoot, ['write-tree'], { env })
    if (!tree.ok) return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `write-tree: ${firstLine(tree.err)}` })
    const treeSha = tree.out.trim()

    const headTree = await runGit(repoRoot, ['rev-parse', `${headSha}^{tree}`])
    const clean = headTree.ok && headTree.out.trim() === treeSha

    if (clean) {
      /*
       * Nothing uncommitted. A shelf from earlier would now be *older* than the
       * branch, and a browser preferring it would read stale code — so it is
       * retracted. Only when this process knows it pushed one: deleting a ref
       * that was never there is a round trip for nothing, and deleting one
       * another Forge on the same machine name pushed is not this process's
       * call.
       */
      if (lastTree.has(key)) {
        await runGit(repoRoot, ['push', '--quiet', 'origin', `:${shelfRef(branch, machine)}`], {
          timeoutMs: GIT_NET_TIMEOUT_MS,
          repoKey: repoRoot
        })
        lastTree.delete(key)
      }
      return report({
        at: Date.now(),
        repoRoot,
        branch,
        kind: pushed ? 'pushed' : 'quiet',
        detail: pushed ? `pushed ${pushed}; working tree clean` : 'working tree clean, nothing to shelve'
      })
    }

    if (lastTree.get(key) === treeSha) {
      return report({ at: Date.now(), repoRoot, branch, kind: 'quiet', detail: 'unchanged since the last shelf' })
    }

    const when = new Date().toISOString()
    const message = `forge wip: ${branch} on ${machine} at ${when}\n\nUncommitted working tree, shelved by Forge so GitHub holds it while this machine is unreachable. Not history: this ref is force-pushed and will be replaced.\n`
    const commit = await runGit(repoRoot, ['commit-tree', treeSha, '-p', headSha, '-m', message], {
      env: {
        // A commit needs an identity even on a machine where git was never told
        // one; the real branch is not touched, so a fallback here harms nothing.
        GIT_AUTHOR_NAME: 'Forge',
        GIT_AUTHOR_EMAIL: 'forge@localhost',
        GIT_COMMITTER_NAME: 'Forge',
        GIT_COMMITTER_EMAIL: 'forge@localhost'
      }
    })
    if (!commit.ok) return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `commit-tree: ${firstLine(commit.err)}` })
    const commitSha = commit.out.trim()

    const ref = shelfRef(branch, machine)
    const push = await runGit(repoRoot, ['push', '--quiet', '--force', '--no-verify', 'origin', `${commitSha}:${ref}`], {
      timeoutMs: GIT_NET_TIMEOUT_MS,
      repoKey: repoRoot
    })
    if (!push.ok) return report({ at: Date.now(), repoRoot, branch, kind: 'failed', detail: `push shelf: ${firstLine(push.err)}` })

    lastTree.set(key, treeSha)
    return report({
      at: Date.now(),
      repoRoot,
      branch,
      kind: 'shelved',
      detail: `${pushed ? `pushed ${pushed}; ` : ''}shelved to ${ref.replace(/^refs\/heads\//, '')}`
    })
  } finally {
    inFlight.delete(key)
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(remote:|To )/.test(l))[0] ?? text.trim().split(/\r?\n/)[0] ?? 'unknown error'
  )
}

function native(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\') : p
}

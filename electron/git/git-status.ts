import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gitFailureReason } from '@shared/tools'
import type { GhState, GitBranch, GitSnapshot } from '@shared/types'
import { stripRemoteCredentials } from '../git-remote'
import { gitAvailable, runGit } from './git-run'
import {
  FOR_EACH_REF_FORMAT,
  parseForEachRef,
  parseGithubSlug,
  parsePorcelainV2,
  upstreamState
} from './porcelain'

/**
 * "Where does this project stand?" — asked of git, once, cheaply.
 *
 * Three processes and a stat, in an order chosen so that the common negative
 * answers cost nothing at all. No git on the machine and a folder that has been
 * deleted are both settled before anything is spawned; a folder that is not a
 * repository costs one `rev-parse` that exits 128, which is the cheapest thing
 * git does.
 *
 * Every unhappy answer here is a *state*, not an error. A folder with no
 * repository is what most folders are, and the section that renders this says so
 * in those words rather than showing a failure. `presence: 'error'` is reserved
 * for git running and genuinely failing, and even then the message comes through
 * `gitFailureReason()` — which already turns git's stderr into English about
 * index locks, credentials and divergence — rather than as raw stderr.
 */

/** Past this, a repository is treated as slow and the watcher backs off. */
export const GIT_SLOW_MS = 1_500

/**
 * The most changed files a snapshot will carry.
 *
 * A first commit that swept in `node_modules` is forty thousand paths, and that
 * is not a payload to push across the preload boundary twice a second. The
 * counts are computed before the cut, so "500 shown" never becomes "500
 * changed" — the header still tells the truth.
 */
export const GIT_MAX_FILES = 500

/** How many branches the list carries. Sorted newest-commit-first, so this is the tail. */
export const GIT_MAX_BRANCHES = 50

/** The gh half of a snapshot before anything has asked gh anything. */
export const GH_UNKNOWN: GhState = { status: 'absent', login: null, currentPr: null, checkedAt: null }

function blank(projectId: string, seq: number): GitSnapshot {
  return {
    projectId,
    seq,
    at: Date.now(),
    presence: 'ok',
    repoRoot: null,
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    state: 'unknown',
    remoteUrl: null,
    slug: null,
    files: [],
    filesTruncated: false,
    changed: 0,
    staged: 0,
    conflicted: 0,
    branches: [],
    fetchedAt: null,
    slow: false,
    gh: GH_UNKNOWN
  }
}

/**
 * Read one project's git state.
 *
 * `prev` is the last snapshot for this project, used for two things only: to
 * carry `slow` forward (a repository that was slow once stays slow — the whole
 * point is not to re-measure it at full cost), and to skip re-asking for the
 * remote URL, which changes about once in a project's life. Everything else is
 * read fresh, because a snapshot that is partly stale is worse than one that is
 * simply a moment old.
 */
export async function readStatus(
  projectId: string,
  cwd: string,
  prev: GitSnapshot | null,
  seq: number
): Promise<GitSnapshot> {
  const snap = blank(projectId, seq)

  // 1 — no spawn. Cached in git-run, so this is a map lookup after the first ask.
  if (!gitAvailable()) return { ...snap, presence: 'no-git' }

  /*
   * 2 — no spawn, and it has to come before one. On Windows, execFile with a
   * cwd that does not exist fails with an ENOENT that reads exactly like the
   * binary being missing, so a deleted project folder would otherwise be
   * reported as "git is not installed" — a wrong answer that sends Steve to the
   * wrong settings page.
   */
  if (!existsSync(cwd)) return { ...snap, presence: 'no-folder' }

  /*
   * 3 — where is the repository, and where is its git directory?
   *
   * The git dir is asked for at the same time because the watcher needs it and
   * because `.git` is not always a folder: in a submodule or a linked worktree
   * it is a file containing `gitdir: …`. A watcher pointed at `<cwd>/.git`
   * instead of the resolved answer simply never fires for those projects.
   */
  const roots = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir'])
  if (!roots.ok) {
    // 128 is git's "this is not a repository", which is the expected answer for
    // most folders and must never be dressed up as a failure.
    if (roots.code === 128 || /not a git repository/i.test(roots.err)) {
      return { ...snap, presence: 'no-repo' }
    }
    return { ...snap, presence: 'error', error: gitFailureReason(roots.err, roots.out) }
  }

  const [topLevel = '', gitDirRaw = ''] = roots.out.trim().split(/\r?\n/)
  const repoRoot = toNativePath(topLevel)
  const gitDir = toNativePath(gitDirRaw)
  if (!repoRoot) return { ...snap, presence: 'no-repo' }

  /* 4 — the status itself. */
  const status = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], {
    repoKey: repoRoot
  })
  if (!status.ok) {
    return { ...snap, presence: 'error', repoRoot, error: gitFailureReason(status.err, status.out) }
  }

  const parsed = parsePorcelainV2(status.out, repoRoot, join)

  /*
   * A branch could legitimately be called `(detached)`, so porcelain's literal
   * is cross-checked against the thing that cannot lie: on a real detached HEAD,
   * `symbolic-ref -q HEAD` exits non-zero. Only asked when the literal appeared,
   * so the overwhelmingly common case costs nothing.
   */
  let detached = parsed.detached
  if (detached) {
    const sym = await runGit(cwd, ['symbolic-ref', '-q', 'HEAD'], { repoKey: repoRoot })
    if (sym.ok && sym.out.trim()) {
      detached = false
      parsed.branch = sym.out.trim().replace(/^refs\/heads\//, '')
    }
  }

  /*
   * 5 — the branch list. Skipped when unborn, because there are no refs to list
   * yet: `for-each-ref refs/heads` on a repository before its first commit
   * returns nothing at all, while `branch.head` above has already given us a
   * perfectly real branch name. The section renders the current branch whether
   * or not it appears in this list, precisely so a fresh `git init` does not say
   * "no branches" next to the name of the branch it is on.
   */
  let branches: GitBranch[] = []
  if (!parsed.unborn) {
    const refs = await runGit(
      cwd,
      [
        'for-each-ref',
        '--sort=-committerdate',
        `--count=${GIT_MAX_BRANCHES}`,
        `--format=${FOR_EACH_REF_FORMAT}`,
        'refs/heads'
      ],
      { repoKey: repoRoot }
    )
    branches = refs.ok ? parseForEachRef(refs.out) : []
  }

  /*
   * 6 — the remote. Carried from the previous snapshot when there was one: a
   * project's origin changes about once, and this is a whole process to ask.
   * The watcher's `.git` handle sees config change, and the explicit refresh
   * passes prev as null, so a remote an agent adds is still picked up promptly.
   */
  let remoteUrl = prev?.remoteUrl ?? null
  if (!remoteUrl) {
    const remote = await runGit(cwd, ['remote', 'get-url', 'origin'], { repoKey: repoRoot })
    remoteUrl = remote.ok ? remote.out.trim() || null : null
  }
  // This snapshot is broadcast to every authenticated browser peer, so a PAT
  // embedded in the origin URL must not survive into it — not from git now,
  // and not from a previous snapshot taken before this rule existed.
  remoteUrl = remoteUrl ? stripRemoteCredentials(remoteUrl) || null : null

  /* 7 — when was this last fetched? A stat, not a process. */
  const fetchedAt = fetchHeadMtime(gitDir)

  /* ------------------------------------------------------------ assemble */

  const changed = parsed.files.length
  const staged = parsed.files.filter((f) => f.staged).length
  const conflicted = parsed.files.filter((f) => f.conflicted).length
  const files = parsed.files.slice(0, GIT_MAX_FILES)

  const hasUpstream = Boolean(parsed.upstream)
  /*
   * An upstream that is configured but has no ahead/behind count is one git
   * cannot find — the remote branch was deleted, usually by a merged pull
   * request that GitHub tidied up. See ParsedStatus.hasAheadBehind for why the
   * absence of a header is the signal rather than a zero count.
   *
   * Not applied while unborn: a repository before its first commit has no
   * counts for a much more innocent reason.
   */
  const gone = hasUpstream && !parsed.hasAheadBehind && !parsed.unborn

  return {
    ...snap,
    presence: 'ok',
    repoRoot,
    branch: parsed.branch,
    detached,
    unborn: parsed.unborn,
    head: parsed.head,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    // Detached and unborn are both honestly 'unknown': there is no branch to be
    // ahead or behind with. Only a real branch gets a real answer.
    state: detached || parsed.unborn ? 'unknown' : upstreamState(hasUpstream, parsed.ahead, parsed.behind, gone),
    remoteUrl,
    slug: remoteUrl ? parseGithubSlug(remoteUrl) : null,
    files,
    filesTruncated: changed > files.length,
    changed,
    staged,
    conflicted,
    branches,
    fetchedAt,
    // Once slow, always slow. Re-measuring costs exactly the thing being avoided.
    slow: Boolean(prev?.slow) || status.ms > GIT_SLOW_MS,
    gh: prev?.gh ?? GH_UNKNOWN
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * FETCH_HEAD's mtime, or null.
 *
 * Read off disk rather than remembered in memory on purpose: a fetch an agent
 * ran in a pane counts exactly as much as one Forge ran, and the answer survives
 * a restart. A repository that has never fetched has no FETCH_HEAD at all, and
 * that is null rather than zero — "never" and "at the epoch" render differently.
 */
function fetchHeadMtime(gitDir: string): number | null {
  if (!gitDir) return null
  try {
    return statSync(join(gitDir, 'FETCH_HEAD')).mtimeMs
  } catch {
    return null
  }
}

/**
 * `--path-format=absolute` gives forward slashes even on Windows. Everything
 * downstream — the absolute paths handed to a drag, the folder the watcher
 * opens — wants the native shape, so the conversion happens once, here, rather
 * than at each of the six places that would otherwise have to remember.
 */
function toNativePath(p: string): string {
  const trimmed = p.trim()
  if (!trimmed) return ''
  return process.platform === 'win32' ? trimmed.replace(/\//g, '\\') : trimmed
}

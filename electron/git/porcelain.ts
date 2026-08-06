import type { GitBranch, GitFileChange, GitUpstreamState } from '@shared/types'

/**
 * Everything Forge reads out of git's output, and no I/O whatsoever.
 *
 * Kept pure so `npm run git:check` can feed it recorded fixtures — a clean tree,
 * a rename with a space in the filename, an unmerged file, a repository with no
 * commits — and assert every field, without a repository, a spawn, or a
 * temporary folder in sight. Parsing is the part of this feature most able to be
 * quietly wrong for months, so it is the part with the test that runs in
 * milliseconds and therefore actually gets run.
 *
 * ## Why porcelain v2
 *
 * v1's `--branch` header is one human-shaped line — `## main...origin/main
 * [ahead 2, behind 1]` — that has to be regex'd out of a format git has never
 * promised to keep stable. v2 emits four separate machine-only headers which are
 * individually parseable and individually *absent* when they do not apply.
 *
 * More importantly, the two hardest states announce themselves rather than
 * having to be inferred. `# branch.oid (initial)` **is** "no commits yet".
 * `# branch.head (detached)` **is** a detached HEAD. Under v1 both require a
 * second `rev-parse` that fails — and reading an error to learn a fact is how
 * you end up showing "error" to somebody who has simply not committed anything.
 *
 * v2 records are typed by their first field (`1` ordinary, `2` rename/copy, `u`
 * unmerged, `?` untracked, `!` ignored) rather than by positional guessing, and
 * carry an explicit submodule field, so a submodule is one row and is never
 * recursed into.
 *
 * ## Why -z
 *
 * With `-z`, paths are raw NUL-terminated bytes. Without it, git C-quotes
 * anything containing a space, a quote or a non-ASCII byte (`core.quotepath`),
 * and correctly un-quoting octal escapes is a bug farm nobody should have to
 * maintain.
 *
 * The one subtlety, and the single most likely thing here to be wrong: under
 * `-z` a `2` (rename or copy) record is **two** NUL-separated fields for one
 * record — the new path, then the original path. A parser that treats every NUL
 * field as a record will read the original path as a mangled record of its own
 * and every field after a rename will be off by one. `parsePorcelainV2` consumes
 * the second field explicitly, and `git:check` has a named fixture for it.
 */

export interface ParsedStatus {
  /** Null when detached or unborn. */
  branch: string | null
  detached: boolean
  unborn: boolean
  /** Short sha, or null when unborn. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /**
   * Did git emit a `# branch.ab` header?
   *
   * This is how porcelain says "the upstream is gone". When a branch has an
   * upstream configured but the remote-tracking ref has been deleted, git prints
   * `# branch.upstream` and then cannot print an ahead/behind count, so it omits
   * the header entirely. Without this flag the absence is indistinguishable from
   * `+0 -0`, and a branch whose upstream has been deleted on GitHub renders as
   * "up to date" — the single most dangerous wrong answer this panel could give.
   */
  hasAheadBehind: boolean
  files: GitFileChange[]
}

/* ------------------------------------------------------------------ status */

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * `join` is passed in rather than imported so this file stays free of node:path
 * and can be exercised anywhere. It builds the absolute path for a repo-relative
 * one, which is what a drag onto a pane needs.
 */
export function parsePorcelainV2(
  stdout: string,
  repoRoot: string,
  join: (root: string, rel: string) => string = defaultJoin
): ParsedStatus {
  const out: ParsedStatus = {
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasAheadBehind: false,
    files: []
  }

  // A trailing NUL leaves an empty final field; anything else empty is noise.
  const fields = stdout.split('\0')

  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]
    if (!line) continue

    /* ----------------------------------------------------------- headers */

    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      switch (key) {
        case 'branch.oid':
          // The literal string `(initial)` is git telling us there is no commit
          // to have a sha. Not an error, not an empty repo — a repo before its
          // first commit, which is a state every project passes through.
          if (value === '(initial)') out.unborn = true
          else out.head = value.slice(0, 7)
          break
        case 'branch.head':
          /*
           * `(detached)` is a literal, and a branch could in principle be named
           * that — `git branch '(detached)'` is legal. The caller cross-checks
           * with `symbolic-ref -q HEAD` failing before it trusts this, because a
           * branch that disables Push for its owner would be a strange bug to
           * have to explain.
           */
          if (value === '(detached)') out.detached = true
          else out.branch = value
          break
        case 'branch.upstream':
          out.upstream = value || null
          break
        case 'branch.ab': {
          // `+2 -1`, always both, always signed.
          const m = /^\+(\d+)\s+-(\d+)$/.exec(value)
          if (m) {
            out.ahead = Number(m[1])
            out.behind = Number(m[2])
            out.hasAheadBehind = true
          }
          break
        }
        default:
          break
      }
      continue
    }

    /* ----------------------------------------------------------- records */

    const kind = line[0]

    if (kind === '1') {
      const rec = ordinary(line)
      if (rec) out.files.push(toChange(rec.xy, rec.path, repoRoot, join, rec.submodule))
      continue
    }

    if (kind === '2') {
      /*
       * Rename or copy. Two NUL fields for one record: this line, then the
       * original path as the very next field. Consuming it here — and stepping
       * `i` past it — is what keeps every subsequent record aligned.
       */
      const rec = ordinary(line)
      const from = fields[i + 1] ?? ''
      i++
      if (rec) {
        const change = toChange(rec.xy, rec.path, repoRoot, join, rec.submodule)
        if (from) change.from = from
        out.files.push(change)
      }
      continue
    }

    if (kind === 'u') {
      // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      const parts = line.split(' ')
      const xy = parts[1] ?? 'UU'
      const sub = parts[2] ?? 'N...'
      const path = parts.slice(10).join(' ')
      if (path) out.files.push(toChange(xy, path, repoRoot, join, sub.startsWith('S')))
      continue
    }

    if (kind === '?') {
      // `? <path>` — no status columns of its own, so it wears '??' like v1.
      const path = line.slice(2)
      if (path) out.files.push(toChange('??', path, repoRoot, join, false))
      continue
    }

    // `!` is an ignored file. We never ask for those (--untracked-files=normal
    // does not list them), and if one appears it is not news.
  }

  return out
}

/**
 * The shared head of a `1` or `2` record.
 *
 * `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 * `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
 *
 * The path is everything after the fixed fields, rejoined — a path cannot
 * contain a NUL, and under `-z` it is the rest of the field, but it can
 * certainly contain spaces.
 */
function ordinary(line: string): { xy: string; path: string; submodule: boolean } | null {
  const parts = line.split(' ')
  if (parts.length < 9) return null
  const xy = parts[1] ?? ''
  const sub = parts[2] ?? 'N...'
  const fixed = parts[0] === '2' ? 9 : 8
  const path = parts.slice(fixed).join(' ')
  if (!path) return null
  return { xy, path, submodule: sub.startsWith('S') }
}

function toChange(
  xy: string,
  path: string,
  repoRoot: string,
  join: (root: string, rel: string) => string,
  submodule: boolean
): GitFileChange {
  const untracked = xy === '??'
  // Porcelain marks a conflict by having a letter in both columns from the
  // unmerged set. `u` records are the only ones that produce these, so the
  // simple test is enough and does not need to know the seven combinations.
  const conflicted = !untracked && CONFLICT_XY.has(xy)
  const staged = !untracked && !conflicted && xy[0] !== '.' && xy[0] !== undefined
  const unstaged = !untracked && !conflicted && xy[1] !== '.' && xy[1] !== undefined
  return {
    path,
    absPath: join(repoRoot, path),
    xy,
    staged,
    unstaged,
    untracked,
    conflicted,
    submodule
  }
}

/** The seven states `git status` calls unmerged. */
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Windows-flavoured join, used when the caller does not pass node:path's. */
function defaultJoin(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return `${base}\\${rel.replace(/\//g, '\\')}`
}

/** The one letter that stands for a file's state in a list. */
export function statusLetter(xy: string): string {
  if (xy === '??') return '?'
  if (CONFLICT_XY.has(xy)) return 'U'
  // The staged column wins when both are set: "added, then edited again" is
  // still fundamentally an addition, and a single letter has to pick one.
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  const c = x !== '.' ? x : y
  return c === '.' ? 'M' : c
}

/* ---------------------------------------------------------------- upstream */

/**
 * `%(upstream:track)` from for-each-ref, which is exactly one of five forms:
 * empty, `[ahead 2]`, `[behind 1]`, `[ahead 2, behind 1]`, `[gone]`.
 */
export function parseUpstreamTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const t = (track ?? '').trim()
  if (!t) return { ahead: 0, behind: 0, gone: false }
  if (t === '[gone]') return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/.exec(t)
  const behind = /behind (\d+)/.exec(t)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false
  }
}

/**
 * The one word for where a branch stands.
 *
 * `hasUpstream: false` is 'unpublished' rather than 'synced', and the difference
 * is the whole point: a branch that exists only on this machine has nothing to
 * be in sync *with*, and calling that "up to date" is the single most misleading
 * thing a git UI can say.
 */
export function upstreamState(hasUpstream: boolean, ahead: number, behind: number, gone: boolean): GitUpstreamState {
  if (gone) return 'gone'
  if (!hasUpstream) return 'unpublished'
  if (ahead > 0 && behind > 0) return 'diverged'
  if (ahead > 0) return 'ahead'
  if (behind > 0) return 'behind'
  return 'synced'
}

/* ---------------------------------------------------------------- branches */

/** The format string parseForEachRef expects. Kept beside its parser on purpose. */
export const FOR_EACH_REF_FORMAT =
  '%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(HEAD)%09%(contents:subject)'

/**
 * Parse `git for-each-ref --format=FOR_EACH_REF_FORMAT`.
 *
 * Tab-separated because a commit subject can contain very nearly anything but
 * not a tab, and it is the last field anyway — so even a subject that somehow
 * had one would only corrupt itself.
 */
export function parseForEachRef(stdout: string, remote = false): GitBranch[] {
  const branches: GitBranch[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue
    const [name, upstream, track, date, head, ...subject] = line.split('\t')
    if (!name) continue
    const { ahead, behind, gone } = parseUpstreamTrack(track ?? '')
    const hasUpstream = Boolean(upstream)
    branches.push({
      name,
      current: head === '*',
      remote,
      upstream: upstream || null,
      ahead,
      behind,
      // A remote-tracking ref has no upstream of its own and is not "unpublished"
      // — it is, definitionally, published. Saying nothing is the honest answer.
      state: remote ? 'unknown' : upstreamState(hasUpstream, ahead, behind, gone),
      lastCommitAt: Number(date) > 0 ? Number(date) * 1000 : 0,
      lastSubject: subject.join('\t')
    })
  }
  return branches
}

/* -------------------------------------------------------------------- slug */

/**
 * `owner/repo` for a github.com remote, or null for anything else.
 *
 * Null is the gate on every `gh` call in the app: a GitLab, Azure, Codeberg or
 * bare-path remote gets no gh process spawned and no message about pull
 * requests, which is right — Forge has nothing useful to say about them and
 * saying it anyway would just be noise on somebody else's workflow.
 *
 * Enterprise GitHub hosts are deliberately out too. `gh` can be configured for
 * them, but the host would have to come from config Forge does not read, and a
 * confident wrong answer about where a PR lives is worse than no answer.
 */
export function parseGithubSlug(remoteUrl: string): string | null {
  const url = (remoteUrl ?? '').trim()
  if (!url) return null

  // scp-style: git@github.com:owner/repo.git
  const scp = /^[\w.-]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url)
  if (scp) return `${scp[1]}/${scp[2]}`

  // https://, http://, ssh://, git://, with or without credentials in the URL.
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(
    url
  )
  if (proto) return `${proto[1]}/${proto[2]}`

  return null
}

/**
 * GitHub over `fetch`, and nothing else.
 *
 * This is the whole of decision 9 in docs/forge-web.md on the browser's side:
 * with the desktop off, "the browser reads and writes GitHub directly,
 * committing to a `forge-web/*` branch". GitHub is the durable place, so this
 * module talks to it and to nothing in between — no relay, no server of Forge
 * Web's own, and no SDK.
 *
 * **No Octokit**, for the same reason web/src/lib/auth.ts refuses the Firebase
 * SDK: it is a large dependency to make six `fetch` calls, and every byte of the
 * path that reaches somebody's repository with a write token is a byte that has
 * to be readable when it misbehaves. The six calls are below, each named after
 * the endpoint it is.
 *
 * ## The branch rule is enforced here, not asked for here
 *
 * `assertWebBranch` runs inside `createBranch` and `putFile` rather than at the
 * call sites. A commit to `master` from a browser tab is the one thing this mode
 * must never be able to do — decision 9 is what makes the desktop's reconcile an
 * ordinary `git pull` — and a rule that lives in the UI is a rule one careless
 * component can walk around. Passing a branch that does not begin `forge-web/`
 * is a programming error and throws before any request is built.
 *
 * ## Failures are a vocabulary, not a string
 *
 * The same standard web/src/components/Connection.tsx holds the socket to: rate
 * limited, gone, not yours, empty, moved-under-you and "the network is down" are
 * six different sentences with six different things to do next, so they are six
 * values rather than one `error`. `GitHubError` carries one of them; the screens
 * write the recovery.
 *
 * ## The token is never in here twice
 *
 * It arrives as a constructor argument, goes into one `authorization` header,
 * and appears in no message this module builds. Every sentence below is written
 * from a status code and a header, so a failure can be shown, logged or pasted
 * into a bug report without leaking a credential — see web/src/lib/repo.tsx for
 * where it is kept and how it is forgotten.
 */

/** Where the REST API lives. Overridable so a check can serve its own stub. */
export const GITHUB_API_BASE = 'https://api.github.com'

/**
 * Every branch this client is allowed to write. Decision 9, as a string.
 *
 * The trailing slash is part of it: `forge-web` on its own is a branch name a
 * desktop would have to special-case, and `forge-web/2026-08-10` reads as what
 * it is in `git branch` output on the machine that has to pull it.
 */
export const BRANCH_PREFIX = 'forge-web/'

/** The version this client was written against. Sent on every request. */
const API_VERSION = '2022-11-28'

/* ---------------------------------------------------------------- failures */

export type GitHubFailure =
  /** 401. The token is gone, revoked, or was never a token. */
  | { kind: 'signed-out'; message: string }
  /** 403 with quota left, or 404 on a private repo the token cannot see. */
  | { kind: 'forbidden'; message: string }
  /** 403/429 with the quota spent. `resetAt` is ms epoch, from the header. */
  | { kind: 'rate-limited'; message: string; resetAt: number }
  /** 404 where the thing genuinely is not there. */
  | { kind: 'missing'; message: string }
  /** A repository with no commits yet. 409 from trees and refs. */
  | { kind: 'empty-repo'; message: string }
  /** 409. Something moved underneath this request. */
  | { kind: 'conflict'; message: string }
  /** 422. GitHub understood it and would not do it. */
  | { kind: 'refused'; message: string }
  /** The request never arrived. No status, so nothing to interpret. */
  | { kind: 'offline'; message: string }
  /** 5xx, or an answer that was not the shape this endpoint promises. */
  | { kind: 'broken'; message: string }

export class GitHubError extends Error {
  readonly failure: GitHubFailure

  constructor(failure: GitHubFailure) {
    super(failure.message)
    this.name = 'GitHubError'
    this.failure = failure
  }
}

export function asFailure(err: unknown): GitHubFailure {
  if (err instanceof GitHubError) return err.failure
  return { kind: 'broken', message: err instanceof Error ? err.message : String(err) }
}

/* ------------------------------------------------------------------ shapes */

/** One row of a recursive tree read. Blobs only — see `tree()`. */
export interface TreeEntry {
  path: string
  /** Bytes, when GitHub reported it. Absent for very large blobs. */
  size: number
  sha: string
}

export interface RepoInfo {
  slug: string
  defaultBranch: string
  private: boolean
  /** What this token may do here, as GitHub itself describes it. */
  canPush: boolean
}

export interface FileContent {
  path: string
  /** The decoded text. */
  text: string
  /** The blob sha, which is what a later write has to name to be safe. */
  sha: string
  /** True when GitHub returned no content because the blob is too large. */
  tooLarge: boolean
}

/* ------------------------------------------------------------------ client */

export class GitHub {
  private readonly token: string
  private readonly base: string

  constructor(options: { token: string; apiBase?: string }) {
    this.token = options.token
    this.base = (options.apiBase || GITHUB_API_BASE).replace(/\/+$/, '')
  }

  /** The repository itself: which branch is default, and what this token may do. */
  async repo(slug: string): Promise<RepoInfo> {
    const body = await this.get(`/repos/${slugPath(slug)}`)
    const value = body as { default_branch?: unknown; private?: unknown; permissions?: { push?: unknown } }
    const defaultBranch = typeof value.default_branch === 'string' ? value.default_branch : ''
    if (!defaultBranch) {
      throw new GitHubError({ kind: 'broken', message: `GitHub described ${slug} without naming a default branch.` })
    }
    return {
      slug,
      defaultBranch,
      private: value.private === true,
      canPush: value.permissions?.push === true
    }
  }

  /**
   * The commit a branch points at, or null when there is no such branch.
   *
   * Null rather than a throw, because "that branch does not exist yet" is the
   * ordinary case the first time somebody commits from a browser — it is the
   * cue to create it, not a failure to report.
   *
   * `matching-refs` and not `git/ref/heads/…`, and the difference is a 404. The
   * single-ref endpoint answers 404 for a branch that is not there, which is a
   * correct answer and an ugly one: a browser logs every non-2xx fetch to the
   * console itself, before any of this code runs, so the ordinary first read of
   * every repository would print a red line nobody can act on. `matching-refs`
   * answers 200 with an empty array. It matches by *prefix* — GitHub's own
   * documentation warns that asking for `feature` can return `featureA` — so the
   * comparison below is against the full ref and not against the array being
   * non-empty.
   */
  async head(slug: string, branch: string): Promise<string | null> {
    const body = await this.get(`/repos/${slugPath(slug)}/git/matching-refs/heads/${refPath(branch)}`)
    if (!Array.isArray(body)) {
      throw new GitHubError({ kind: 'broken', message: `GitHub answered for ${branch} with something that is not a list of refs.` })
    }
    const wanted = `refs/heads/${branch}`
    const match = (body as Array<{ ref?: unknown; object?: { sha?: unknown } }>).find((row) => row?.ref === wanted)
    if (!match) return null
    const sha = match.object?.sha
    if (typeof sha !== 'string' || !sha) {
      throw new GitHubError({ kind: 'broken', message: `GitHub answered for ${branch} without a commit sha.` })
    }
    return sha
  }

  /**
   * Every file in the repository at one ref, in one request.
   *
   * `recursive=1` because a tree walked a directory at a time is one round trip
   * per folder over somebody's mobile connection, and this mode exists for the
   * case where the network is the only thing there is. GitHub truncates the
   * array at 100,000 entries or 7MB and says so in `truncated`; that flag is
   * passed on rather than swallowed, because a file tree missing its tail
   * without saying so is a file tree that lies.
   *
   * Trees (`type: 'tree'`) are dropped: the browser builds its folders from the
   * blob paths, so a directory row that leads nowhere cannot appear.
   */
  async tree(slug: string, ref: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const body = await this.get(`/repos/${slugPath(slug)}/git/trees/${refPath(ref)}?recursive=1`)
    const value = body as { tree?: unknown; truncated?: unknown }
    if (!Array.isArray(value.tree)) {
      throw new GitHubError({ kind: 'broken', message: `GitHub answered for ${slug} without a tree.` })
    }
    const entries: TreeEntry[] = []
    for (const row of value.tree as Array<Record<string, unknown>>) {
      if (row?.type !== 'blob') continue
      const path = typeof row.path === 'string' ? row.path : ''
      const sha = typeof row.sha === 'string' ? row.sha : ''
      if (!path || !sha) continue
      entries.push({ path, sha, size: typeof row.size === 'number' ? row.size : 0 })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return { entries, truncated: value.truncated === true }
  }

  /** One file's text at one ref, with the blob sha a later write has to name. */
  async file(slug: string, path: string, ref: string): Promise<FileContent> {
    const body = await this.get(`/repos/${slugPath(slug)}/contents/${filePath(path)}?ref=${encodeURIComponent(ref)}`)
    const value = body as { content?: unknown; encoding?: unknown; sha?: unknown; type?: unknown }
    if (value.type !== 'file') {
      throw new GitHubError({ kind: 'missing', message: `${path} is not a file in this repository.` })
    }
    const sha = typeof value.sha === 'string' ? value.sha : ''
    const encoded = typeof value.content === 'string' ? value.content : ''
    // "For files between 1-100 MB, only raw or object media types work, with the
    // `content` field returning an empty string." A blob that came back with no
    // content is not a blank file, and must not be offered as one to edit.
    if (!encoded && value.encoding !== 'base64') {
      return { path, text: '', sha, tooLarge: true }
    }
    return { path, text: decodeBase64(encoded), sha, tooLarge: false }
  }

  /** A new branch at `sha`. Refuses anything outside `forge-web/`. */
  async createBranch(slug: string, branch: string, sha: string): Promise<void> {
    assertWebBranch(branch)
    await this.send('POST', `/repos/${slugPath(slug)}/git/refs`, { ref: `refs/heads/${branch}`, sha })
  }

  /**
   * Write one file and commit it, on a `forge-web/*` branch and no other.
   *
   * `sha` is the blob this edit was made against — omitted for a file that does
   * not exist on that branch yet. GitHub answers 409 when it does not match what
   * is there, which is precisely "the branch moved under you", and that answer
   * is passed up rather than retried: decision 9 makes the desktop's `git pull`
   * the reconciler, so a browser that silently overwrote somebody's commit would
   * be a second source of truth wearing a merge's clothes.
   */
  async putFile(
    slug: string,
    file: { path: string; branch: string; message: string; text: string; sha?: string }
  ): Promise<{ commitSha: string; blobSha: string }> {
    assertWebBranch(file.branch)
    const body = await this.send('PUT', `/repos/${slugPath(slug)}/contents/${filePath(file.path)}`, {
      message: file.message,
      content: encodeBase64(file.text),
      branch: file.branch,
      ...(file.sha ? { sha: file.sha } : {})
    })
    const value = body as { commit?: { sha?: unknown }; content?: { sha?: unknown } }
    // The new blob's sha, and it is not a nicety: it is what the *next* edit of
    // this file is against. Without carrying it back, a second commit in the
    // same sitting names the blob the first one replaced and GitHub answers 409
    // — a conflict the person did not cause and cannot resolve.
    return {
      commitSha: typeof value.commit?.sha === 'string' ? value.commit.sha : '',
      blobSha: typeof value.content?.sha === 'string' ? value.content.sha : ''
    }
  }

  /* --------------------------------------------------------------- transport */

  private get(path: string): Promise<unknown> {
    return this.send('GET', path)
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch {
      throw new GitHubError({
        kind: 'offline',
        message: 'The request to GitHub never left this browser — the connection is down.'
      })
    }

    const text = await response.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }

    if (response.ok) return parsed
    throw new GitHubError(interpret(response, parsed))
  }
}

/* ------------------------------------------------------------ the failures */

/**
 * A status code and two headers, turned into the one sentence that is true.
 *
 * The split that matters is inside 403: GitHub uses it both for "you have spent
 * your hour" and for "that repository is not yours to touch", and they are
 * opposite news — one is a clock, the other is a token that needs replacing.
 * `x-ratelimit-remaining` is what tells them apart, exactly as the rate-limit
 * documentation says it does.
 *
 * GitHub's own `message` field is deliberately *not* used as the sentence. It is
 * written for an API consumer ("Bad credentials", "Git Repository is empty") and
 * this is the only screen the person has; the codes are stable enough to write
 * proper prose from, and prose written here can name what Forge Web was doing.
 */
function interpret(response: Response, body: unknown): GitHubFailure {
  const status = response.status
  const remaining = response.headers.get('x-ratelimit-remaining')
  const resetHeader = Number(response.headers.get('x-ratelimit-reset') ?? '')
  const retryAfter = Number(response.headers.get('retry-after') ?? '')
  const detail = String((body as { message?: unknown } | null)?.message ?? '')

  if (status === 401) {
    return {
      kind: 'signed-out',
      message: 'GitHub did not accept that token. It has expired, been revoked, or was never a token.'
    }
  }

  if (status === 429 || (status === 403 && remaining === '0')) {
    const resetAt = Number.isFinite(resetHeader) && resetHeader > 0
      ? resetHeader * 1000
      : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000)
    return {
      kind: 'rate-limited',
      resetAt,
      message: `GitHub is rate limiting this token. It will answer again ${clock(resetAt)}.`
    }
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      message: 'That token cannot reach this repository. A fine-grained token has to list the repository itself, not only the account.'
    }
  }

  if (status === 404) {
    // A private repository a token cannot see is 404, not 403 — GitHub does not
    // confirm that something exists to somebody who may not look at it. So this
    // says both things, because from here they are genuinely indistinguishable.
    return {
      kind: 'missing',
      message: 'GitHub has nothing there — either it does not exist, or this token is not allowed to know that it does.'
    }
  }

  if (status === 409) {
    if (/empty/i.test(detail)) {
      return { kind: 'empty-repo', message: 'That repository has no commits yet, so there is nothing to read and no branch to start from.' }
    }
    return { kind: 'conflict', message: 'That branch moved on GitHub after this page read it.' }
  }

  if (status === 422) {
    return {
      kind: 'refused',
      message: detail
        ? `GitHub refused the change: ${detail}`
        : 'GitHub understood the change and refused it.'
    }
  }

  if (status >= 500) {
    return { kind: 'broken', message: `GitHub answered ${status}. That is GitHub's end, not this page's.` }
  }

  return { kind: 'broken', message: `GitHub answered ${status}${detail ? ` — ${detail}` : ''}.` }
}

/** "at 14:05", or "in a moment" when the reset is already behind us. */
function clock(at: number): string {
  if (at <= Date.now()) return 'in a moment'
  const when = new Date(at)
  return `at ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ guards */

/** True for `owner/repo`, which is the only shape `GitSnapshot.slug` ever holds. */
export function isSlug(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/**
 * The one rule this whole mode rests on.
 *
 * A throw rather than a returned failure: every path that reaches it has already
 * been given a branch name by this client's own code, so a name outside
 * `forge-web/` is a bug in Forge Web rather than something a person did, and it
 * must be loud in development rather than a sentence on a screen in production.
 */
export function assertWebBranch(branch: string): void {
  if (!branch.startsWith(BRANCH_PREFIX) || branch.length <= BRANCH_PREFIX.length) {
    throw new Error(`refusing to write to "${branch}" — Forge Web only ever commits to ${BRANCH_PREFIX}*`)
  }
  if (/\.\.|[\s~^:?*[\\]|@\{/.test(branch) || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`"${branch}" is not a name git would accept for a branch`)
  }
}

/** Today's `forge-web/` branch: one per day, so a day's edits arrive together. */
export function defaultWebBranch(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${BRANCH_PREFIX}${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/* ------------------------------------------------------------------ paths */

function slugPath(slug: string): string {
  if (!isSlug(slug)) throw new Error(`"${slug}" is not an owner/repo slug`)
  const [owner, repo] = slug.split('/')
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

/** A ref or branch, whose slashes are part of the path rather than escaped. */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

/** Same for a file path: `src/lib/x.ts` is three segments, not one. */
function filePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/* ----------------------------------------------------------------- base64
 *
 * `btoa` and `atob` are latin1, and a repository is full of files that are not:
 * an em dash in a comment would come back mangled, and a commit that mangled one
 * would be a browser tab quietly corrupting somebody's source. So the bytes go
 * through TextEncoder/TextDecoder, which is what makes this UTF-8 safe.
 */

export function decodeBase64(value: string): string {
  const clean = value.replace(/\s+/g, '')
  if (!clean) return ''
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  // In chunks, because `String.fromCharCode(...bytes)` on a large file is an
  // argument list long enough to blow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

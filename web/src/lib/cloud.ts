/**
 * Claude Code in the cloud (claude.ai/code): the link that opens it with a
 * repository and a task filled in.
 *
 * There is no API a page can call to start a cloud session, so this only
 * builds the link; the person presses Send inside Claude. The two query
 * parameters are the documented pre-fill ones — see
 * https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions — and both
 * are optional.
 */

export const CLOUD_URL = 'https://claude.ai/code'

/** One owner or repository name, as GitHub allows them. */
const PART = /^[A-Za-z0-9_.-]+$/

/**
 * `owner/repo` for a GitHub remote, in any of the shapes `git remote get-url`
 * hands back — https with or without `.git` or a trailing slash, the scp-style
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`. Null for a remote
 * on another host, or none.
 */
export function githubSlug(repoUrl?: string | null): string | null {
  const raw = repoUrl?.trim()
  if (!raw) return null
  let path: string
  const scp = /^[^@/\s]+@github\.com:(.+)$/i.exec(raw)
  if (scp) {
    path = scp[1]
  } else {
    let url: URL
    try {
      url = new URL(/^(?:www\.)?github\.com\//i.test(raw) ? `https://${raw}` : raw)
    } catch {
      return null
    }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null
    path = url.pathname
  }
  const [owner, repo] = path.replace(/^\/+/, '').split('/')
  const name = repo?.replace(/\.git$/i, '')
  if (!owner || !name || !PART.test(owner) || !PART.test(name)) return null
  return `${owner}/${name}`
}

/**
 * The claude.ai/code link with the task and the repository filled in. A blank
 * task and a null repository are left off, so Claude asks for them itself.
 * The slash in `owner/repo` stays a slash, as in the docs' own example.
 */
export function cloudSessionUrl({ prompt, repo }: { prompt?: string; repo?: string | null }): string {
  const params: string[] = []
  const text = prompt?.trim()
  if (text) params.push(`prompt=${encodeURIComponent(text)}`)
  if (repo) params.push(`repositories=${repo.split('/').map(encodeURIComponent).join('/')}`)
  return params.length ? `${CLOUD_URL}?${params.join('&')}` : CLOUD_URL
}

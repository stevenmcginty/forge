import { execFileSync } from 'node:child_process'

/**
 * A remote URL minus its embedded credentials, because everywhere Forge repeats
 * one — the Repository URL field, `FORGE_REPO_URL`, git snapshots broadcast to
 * browsers — it is naming a place, not authenticating to it. A user who pasted
 * `https://steve:ghp_…@github.com/…` into a clone command has a PAT sitting in
 * `.git/config`; every copy Forge makes of that URL must drop it, or the next
 * prompt that says "run `Get-ChildItem env:FORGE_REPO_URL`" exfiltrates it.
 * Git's own credential helper still authenticates pushes against the bare URL.
 */
export function stripRemoteCredentials(url: string): string {
  // userinfo@ after a scheme — `https://user:token@host`, `https://:token@host`,
  // `https://token@host`. The ssh form (`git@host:path`) carries no secret: the
  // "user" there is literally `git` and the auth lives in a key elsewhere.
  return `${url}`.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s]+)@/, '$1')
}

/**
 * "Where does this folder push?" — asked of git, in one line.
 *
 * Two callers, one question. The project menu asks it when it opens, so a
 * project whose repo an agent created five minutes ago fills its Repository URL
 * in without Steve typing anything; the PTY host asks it at every pane spawn as
 * the fallback for `FORGE_REPO_URL`, so the answer stays right even when the
 * remote appeared after the project was added.
 *
 * Synchronous on purpose. `remote get-url` is answered out of .git/config
 * without touching the network, so it costs a process spawn and a file read —
 * and the pane-spawn caller sits in a synchronous IPC handler that has no
 * business becoming async for this. The timeout bounds the pathological case (a
 * hung git, a network drive that has gone away) rather than the normal one.
 *
 * Every failure is the same answer: null. No git, not a repo, no origin, a
 * timeout — none of them are errors here, they are just "this project has no
 * remote yet", which is a perfectly ordinary state for a folder to be in.
 */
export function gitRemoteOrigin(dir: string): string | null {
  const cwd = (dir ?? '').trim()
  if (!cwd) return null
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 1500,
      encoding: 'utf8',
      windowsHide: true,
      // execFileSync lets the child's stderr through to ours by default, and
      // "not a git repository" is the expected case here, not a fault worth
      // printing into Forge's log every time a pane opens.
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return stripRemoteCredentials(`${out}`.trim()) || null
  } catch {
    return null
  }
}

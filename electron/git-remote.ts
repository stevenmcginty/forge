import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

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
 * Remembered per folder for REMOTE_TTL_MS, null answers included. That process
 * spawn is ~150ms on Steve's PC, all of it on the main thread with the whole app
 * frozen, and opening a layout spawns several panes in the same folder at once.
 * The price is that a remote added this second shows up within half a minute
 * rather than at once, which both callers can live with.
 *
 * Every failure is the same answer: null. No git, not a repo, no origin, a
 * timeout — none of them are errors here, they are just "this project has no
 * remote yet", which is a perfectly ordinary state for a folder to be in.
 */
export function gitRemoteOrigin(dir: string): string | null {
  const cwd = (dir ?? '').trim()
  if (!cwd) return null
  const key = folderKey(cwd)
  const now = Date.now()
  const hit = remotes.get(key)
  if (hit && now - hit.at < REMOTE_TTL_MS) return hit.url
  const url = askGit(cwd)
  for (const [k, v] of remotes) if (now - v.at >= REMOTE_TTL_MS) remotes.delete(k)
  remotes.set(key, { url, at: now })
  return url
}

const REMOTE_TTL_MS = 30_000

/** gitRemoteOrigin's answers, by folderKey. */
const remotes = new Map<string, { url: string | null; at: number }>()

/** One folder, however it was spelled: resolved, no trailing slash, case-folded on Windows. */
function folderKey(dir: string): string {
  const full = resolve(dir).replace(/[\\/]+$/, '') || resolve(dir)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function askGit(cwd: string): string | null {
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

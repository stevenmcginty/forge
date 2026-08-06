import { execFileSync } from 'node:child_process'

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
    return `${out}`.trim() || null
  } catch {
    return null
  }
}

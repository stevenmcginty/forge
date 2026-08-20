/**
 * Who is actually listening on a local port.
 *
 * The Devices preview learns where a project is served by reading the project's
 * own terminal (`findDevServerUrl` in shared/devserver.ts), and for a long time
 * that was the whole story: a URL was noticed, a URL was framed. The gap in it
 * is that a URL is not a server. `http://localhost:3000` names a *port*, ports
 * are first-come-first-served across the whole machine, and the thing answering
 * on one is very often somebody else's — a second project's dev server, a
 * Remotion studio, a container. The preview would frame it, the liveness probe
 * would see a socket accept and say "Live", and two phones would confidently
 * show a different project's app.
 *
 * So this module asks the question the probe cannot: not "is anything there?"
 * but "is it *yours*?". It finds the process listening on the port and looks for
 * either of the two things that make it this project's:
 *
 *  1. **Descent.** The listener is a child (or grandchild, or deeper) of one of
 *     the project's own terminal panes. This is the ordinary case — the Start
 *     button ran `npm run dev` in a pane, and everything that command spawned
 *     hangs off that pane's PTY.
 *
 *  2. **Address.** The listener's command line names the project's folder. This
 *     is the case descent cannot see: a dev server started in an external
 *     terminal, from an IDE, or by a supervisor that reparented it. Almost every
 *     dev server is launched by a path inside the tree it serves, and that path
 *     is right there in the command line.
 *
 * Either is enough. Neither means the port belongs to a stranger, and a stranger
 * is exactly what the preview must refuse to frame.
 *
 * Everything here is read-only and spawns nothing that outlives the call: one
 * listing of TCP listeners, one listing of the process table. Both are cached
 * for a breath, because the liveness probe asks on a timer and a process table
 * does not change meaningfully between two ticks of it.
 */

import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import type { PortOwnerQuery, PortOwnerResult } from '@shared/types'

/** One process, reduced to the three things this question needs. */
interface ProcRow {
  pid: number
  ppid: number
  /** The full command line where the platform gives us one, else the image name. */
  command: string
}

/* ------------------------------------------------------------- plumbing */

const CACHE_MS = 2000

function run(file: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // A non-zero exit is an answer too — `lsof` exits 1 when nothing matches,
      // and an empty string is exactly the right reading of that.
      done(err && !stdout ? '' : String(stdout ?? ''))
    })
  })
}

/**
 * A value recomputed only once it has gone stale, and never remembered as a
 * failure: a probe that threw drops the cache on its way out so the next caller
 * gets a fresh attempt rather than the last one's bad luck.
 */
function memo<T>(ttlMs: number, compute: () => Promise<T>): () => Promise<T> {
  let at = 0
  let pending: Promise<T> | null = null
  return () => {
    const now = Date.now()
    if (pending && now - at < ttlMs) return pending
    at = now
    const attempt = compute().catch((e: unknown) => {
      if (pending === attempt) {
        at = 0
        pending = null
      }
      throw e
    })
    pending = attempt
    return attempt
  }
}

const IS_WINDOWS = process.platform === 'win32'

/* ------------------------------------------------------- listening ports */

/**
 * Every listening TCP port on this machine, mapped to the pid holding it.
 *
 * `netstat -ano` on Windows because it is the one listing that is present on
 * every install, needs no elevation and no PowerShell start-up; `lsof` on the
 * rest. Both are read whole and cached, because the caller asks about one port
 * on a timer and the parse is far cheaper than the spawn.
 */
const listeners = memo<Map<number, number>>(CACHE_MS, async () => {
  const map = new Map<number, number>()
  if (IS_WINDOWS) {
    const out = await run('netstat', ['-ano', '-p', 'TCP'])
    for (const line of out.split(/\r?\n/)) {
      // "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    8232"
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
      if (!m) continue
      const port = Number(m[2])
      const pid = Number(m[3])
      // First writer wins: a server bound to both stacks lists twice (0.0.0.0
      // and [::]) with the same pid, so the second line is never news.
      if (port && pid && !map.has(port)) map.set(port, pid)
    }
    return map
  }
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
  // lsof -F emits one field per line: `p<pid>` opens a process, `n<addr>` names
  // each of its files, so the pid in force is the last one seen.
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1)) || 0
      continue
    }
    if (!line.startsWith('n') || !pid) continue
    const port = Number(/:(\d+)$/.exec(line)?.[1])
    if (port && !map.has(port)) map.set(port, pid)
  }
  return map
})

/* --------------------------------------------------------- process table */

/**
 * The process table, as pid → row.
 *
 * Windows has no `ps` and no `wmic` any more, so this is CIM through
 * PowerShell — one call taken whole, rather than a walk that spawns a shell per
 * ancestor. `-NoProfile` because a user profile is free to print a banner into
 * stdout and would corrupt the JSON.
 */
const processes = memo<Map<number, ProcRow>>(CACHE_MS, async () => {
  const map = new Map<number, ProcRow>()
  if (IS_WINDOWS) {
    const script =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ' +
      'ConvertTo-Json -Compress -Depth 2'
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15000)
    let rows: unknown
    try {
      rows = JSON.parse(out)
    } catch {
      return map
    }
    // A single process comes back as an object rather than a one-item array.
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const r = row as { ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string } | null
      const pid = Number(r?.ProcessId)
      if (!pid) continue
      map.set(pid, {
        pid,
        ppid: Number(r?.ParentProcessId) || 0,
        command: String(r?.CommandLine || r?.Name || '')
      })
    }
    return map
  }
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,args='])
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! })
  }
  return map
})

/* ------------------------------------------------------------ the tests */

/**
 * Is `pid` one of `roots`, or descended from any of them?
 *
 * Walks parents rather than children because the chain up is single and short
 * while the tree down is neither. `seen` is a cycle guard: a table read while
 * processes are exiting can name a parent whose pid has already been recycled,
 * and a loop here would hang the preview.
 */
function descendsFrom(pid: number, roots: Set<number>, table: Map<number, ProcRow>): boolean {
  const seen = new Set<number>()
  let cursor = pid
  while (cursor > 0 && !seen.has(cursor)) {
    if (roots.has(cursor)) return true
    seen.add(cursor)
    cursor = table.get(cursor)?.ppid ?? 0
  }
  return false
}

/**
 * Does this command line name the project's folder?
 *
 * Case-insensitively, because Windows paths compare that way and a match here is
 * a safety latch rather than a lookup. Tested against the resolved path so `..`
 * and a trailing separator cannot make a real match miss, and with the separator
 * appended first so `C:\dev\app` does not match a command line that only
 * mentions `C:\dev\app-legacy`.
 */
function namesProject(command: string, projectPath: string): boolean {
  if (!command || !projectPath) return false
  const root = resolve(projectPath)
  const inside = (root.endsWith(sep) ? root : root + sep).toLowerCase()
  const hay = command.toLowerCase()
  // A path *into* the tree is what a `node_modules/.bin` launcher looks like;
  // the bare root is what a `cd` or a `--prefix` naming the folder looks like.
  // The bare form is only accepted at a boundary, which is what `inside` tests
  // for the other case and what these two checks do for this one.
  if (hay.includes(inside)) return true
  const at = hay.indexOf(root.toLowerCase())
  if (at < 0) return false
  const after = hay[at + root.length]
  return after === undefined || after === '"' || after === "'" || after === ' ' || after === sep.toLowerCase()
}

/**
 * Who holds the port, and is it the asking project's?
 *
 * Never throws: every failure below — no netstat, an unparseable table, a
 * process that exited between the two listings — comes back `owned: true` with
 * reason `unknown`, which the renderer reads as "cannot tell, do not block".
 * Refusing to frame a project's own site because a probe failed would be a worse
 * bug than the one this exists to fix, so uncertainty always resolves in favour
 * of showing the site.
 */
export async function portOwner(query: PortOwnerQuery): Promise<PortOwnerResult> {
  const port = Number(query?.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { pid: null, command: null, owned: true, reason: 'unknown' }
  }
  let ports: Map<number, number>
  try {
    ports = await listeners()
  } catch {
    return { pid: null, command: null, owned: true, reason: 'unknown' }
  }
  const pid = ports.get(port) ?? null
  if (!pid) return { pid: null, command: null, owned: false, reason: 'closed' }

  let table: Map<number, ProcRow>
  try {
    table = await processes()
  } catch {
    return { pid, command: null, owned: true, reason: 'unknown' }
  }
  // An empty table means the listing failed rather than that nothing is running,
  // and a failed listing is not evidence of a stranger.
  if (table.size === 0) return { pid, command: null, owned: true, reason: 'unknown' }
  const command = table.get(pid)?.command ?? null

  const roots = new Set((query.pids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))
  if (roots.size > 0 && descendsFrom(pid, roots, table)) {
    return { pid, command, owned: true, reason: 'descent' }
  }
  if (namesProject(command ?? '', String(query.path ?? ''))) {
    return { pid, command, owned: true, reason: 'address' }
  }
  return { pid, command, owned: false, reason: 'unowned' }
}

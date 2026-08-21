import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GitInbound, GitInboundKind } from '@shared/types'
import { getDataDir } from '../store'
import { runGit } from './git-run'
import { machineRefName, SHELF_PREFIX } from './git-shelf'
import { FOR_EACH_REF_FORMAT, parseForEachRef } from './porcelain'

/**
 * Work that arrived on GitHub while this machine was not the one doing it.
 *
 * docs/GITHUB-FALLBACK-PLAN.md, Phase C. Three places it comes from, told apart
 * by the branch prefix and nothing else:
 *
 *  - `forge-web/*`  — an edit committed from Forge Web's GitHub mode.
 *  - `claude/*`     — a Claude Code cloud session, which names its own branches.
 *  - `forge-wip/*`  — another machine's shelf (electron/git/git-shelf.ts). This
 *                     machine's own shelves are *not* inbound: they are a mirror
 *                     of the tree that is already here, and listing them would
 *                     nag about every idle pane.
 *
 * "Inbound" means the remote-tracking ref has commits HEAD does not. Measured
 * against `refs/remotes/origin/…` as last fetched — this module never fetches;
 * the watcher's one automatic fetch and the Fetch button are what move those
 * refs, same as ahead/behind.
 *
 * A branch can be dismissed ("Keep the branch"). That is remembered by tip sha
 * in a small JSON file under the data dir, so it comes back only when the tip
 * moves — new commits are new news. Dismissing is not deleting: the branch
 * stays on GitHub exactly as it was.
 */

export const INBOUND_PREFIXES: readonly string[] = ['forge-web/', 'claude/', SHELF_PREFIX]

/** Enough to be useful, few enough that the rev-list per ref stays cheap. */
export const INBOUND_MAX = 12

export function inboundKind(name: string): GitInboundKind | null {
  if (name.startsWith('forge-web/')) return 'web'
  if (name.startsWith('claude/')) return 'cloud'
  if (name.startsWith(SHELF_PREFIX)) return 'shelf'
  return null
}

/** `forge-wip/<machine>/<of>` taken apart, or null. */
export function shelfParts(name: string): { machine: string; of: string } | null {
  if (!name.startsWith(SHELF_PREFIX)) return null
  const rest = name.slice(SHELF_PREFIX.length)
  const cut = rest.indexOf('/')
  if (cut <= 0 || cut === rest.length - 1) return null
  return { machine: rest.slice(0, cut), of: rest.slice(cut + 1) }
}

/* --------------------------------------------------------------- dismissed */

type Dismissed = Record<string, string>

let dismissed: Dismissed | null = null

function dismissPath(): string {
  return join(getDataDir(), 'git-inbound-dismissed.json')
}

function loadDismissed(): Dismissed {
  if (dismissed) return dismissed
  try {
    const raw = readFileSync(dismissPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    dismissed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Dismissed) : {}
  } catch {
    dismissed = {}
  }
  return dismissed
}

function saveDismissed(): void {
  if (!dismissed) return
  try {
    const path = dismissPath()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(dismissed, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.warn('[git] could not save dismissed inbound branches:', err)
  }
}

function dismissKey(repoRoot: string, name: string): string {
  return `${repoRoot.toLowerCase()}\0${name}`
}

/** "Keep the branch": stop listing `name` until its tip is no longer `sha`. */
export function dismissInbound(repoRoot: string, name: string, sha: string): void {
  if (!repoRoot || !name || !sha) return
  const store = loadDismissed()
  store[dismissKey(repoRoot, name)] = sha
  saveDismissed()
}

export function isDismissed(repoRoot: string, name: string, sha: string): boolean {
  return loadDismissed()[dismissKey(repoRoot, name)] === sha
}

/** Test seam: point the store at a throwaway file and forget what it held. */
export function resetDismissedForTests(): void {
  dismissed = null
}

/* ----------------------------------------------------------------- reading */

/**
 * The inbound branches of one repository, newest first. Never throws; a git
 * that cannot answer is an empty list, because the GIT section must work
 * without this.
 */
export async function readInbound(cwd: string, repoRoot: string, machine = machineRefName()): Promise<GitInbound[]> {
  const refs = await runGit(
    cwd,
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--count=${INBOUND_MAX * 2}`,
      `--format=${FOR_EACH_REF_FORMAT}%09%(objectname)`,
      ...INBOUND_PREFIXES.map((p) => `refs/remotes/origin/${p}`)
    ],
    { repoKey: repoRoot }
  )
  if (!refs.ok || !refs.out.trim()) return []

  // The sha rides as one extra tab-separated field after the subject. The
  // subject is the last field the shared format knows about, so it is split off
  // here before the shared parser sees the line.
  const shaByLine = new Map<string, string>()
  const stripped: string[] = []
  for (const raw of refs.out.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue
    const cut = line.lastIndexOf('\t')
    if (cut < 0) continue
    const sha = line.slice(cut + 1).trim()
    const rest = line.slice(0, cut)
    stripped.push(rest)
    const name = rest.split('\t')[0] ?? ''
    if (name && /^[0-9a-f]{40}$/i.test(sha)) shaByLine.set(name, sha)
  }

  const parsed = parseForEachRef(stripped.join('\n'), true)
  const out: GitInbound[] = []

  for (const b of parsed) {
    if (out.length >= INBOUND_MAX) break
    const name = b.name.replace(/^origin\//, '')
    const kind = inboundKind(name)
    if (!kind) continue
    const sha = shaByLine.get(b.name)
    if (!sha) continue

    const shelf = kind === 'shelf' ? shelfParts(name) : null
    if (kind === 'shelf' && (!shelf || shelf.machine.toLowerCase() === machine.toLowerCase())) continue

    const count = await runGit(cwd, ['rev-list', '--count', `HEAD..refs/remotes/origin/${name}`], { repoKey: repoRoot })
    if (!count.ok) continue
    const commits = Number.parseInt(count.out.trim(), 10)
    if (!Number.isFinite(commits) || commits <= 0) continue

    out.push({
      name,
      kind,
      sha,
      commits,
      lastCommitAt: b.lastCommitAt,
      lastSubject: b.lastSubject,
      dismissed: isDismissed(repoRoot, name, sha),
      ...(shelf ? { machine: shelf.machine, of: shelf.of } : {})
    })
  }

  return out
}

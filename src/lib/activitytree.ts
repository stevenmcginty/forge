import type { ActivityEntry } from '@shared/types'

/**
 * Turning a flat list of touched files into something that fits in a 240px rail.
 *
 * Pure on purpose, and separate from the components that draw it, because the
 * two rules that make this readable are both easy to get subtly wrong and
 * impossible to check by looking at a screenshot: which rows a chain of
 * single-child folders collapses into, and what order things come out in.
 * scripts/activity-check.mjs holds them to it.
 */

export interface ActivityFileNode {
  kind: 'file'
  /** The leaf name — what the row actually shows. */
  name: string
  /** Project-relative, forward slashes. The row's title attribute. */
  path: string
  absPath: string
  at: number
  /**
   * One per pane that touched this file, newest first. Two panes editing the
   * same file is not a bug to be deduped away — it is the most interesting thing
   * the panel can tell you, and it is why a row carries a stack of dots.
   */
  entries: ActivityEntry[]
  /** True when at least one of those entries came out of a transcript. */
  exact: boolean
}

export interface ActivityDirNode {
  kind: 'dir'
  /** Possibly a collapsed chain: `src/components/rail` is one row, not three. */
  name: string
  path: string
  at: number
  children: ActivityNode[]
}

export type ActivityNode = ActivityDirNode | ActivityFileNode

/** `◆` we were told, `◇` we worked it out. */
export const EXACT_GLYPH = '◆'
export const INFERRED_GLYPH = '◇'

/* --------------------------------------------------------------------- tree */

type Building = {
  name: string
  path: string
  dirs: Map<string, Building>
  files: Map<string, ActivityFileNode>
}

function emptyDir(name: string, path: string): Building {
  return { name, path, dirs: new Map(), files: new Map() }
}

/**
 * The folder tree behind a set of entries.
 *
 * **Single-child chains collapse.** A project whose only touched file is
 * `src/components/rail/ActivitySection.tsx` has four nested rows to show one
 * file, and each of them costs an indent the next one cannot afford. Folding
 * them into one `src/components/rail` row is what VS Code's explorer does, and
 * in a rail this narrow it is the difference between a tree that fits and one
 * that scrolls sideways.
 *
 * **Directories first, then most recent.** Recency is the whole point of the
 * panel — the file an agent touched a moment ago should be near the top — but
 * mixing folders and files by time makes the shape of the tree jump about
 * between snapshots, so the two kinds are kept apart and sorted within.
 */
export function buildActivityTree(entries: ActivityEntry[]): ActivityNode[] {
  const root = emptyDir('', '')

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const name = segments[segments.length - 1] as string

    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] as string
      const key = segment.toLowerCase()
      let next = node.dirs.get(key)
      if (!next) {
        next = emptyDir(segment, node.path ? `${node.path}/${segment}` : segment)
        node.dirs.set(key, next)
      }
      node = next
    }

    // Keyed lower-case: NTFS is case-insensitive, and the same file reached
    // through a transcript and through the folder watcher can arrive with two
    // different casings. One row, whichever spelling got there first.
    const fileKey = name.toLowerCase()
    const existing = node.files.get(fileKey)
    if (existing) {
      existing.entries.push(entry)
      existing.at = Math.max(existing.at, entry.at)
      existing.exact = existing.exact || entry.exactness === 'exact'
      continue
    }
    node.files.set(fileKey, {
      kind: 'file',
      name,
      path: entry.path,
      absPath: entry.absPath,
      at: entry.at,
      entries: [entry],
      exact: entry.exactness === 'exact'
    })
  }

  return finish(root).children
}

function finish(node: Building): ActivityDirNode {
  const children: ActivityNode[] = []

  for (const dir of node.dirs.values()) {
    let built = finish(dir)
    // Collapse while this folder holds exactly one thing and that thing is a
    // folder. Not when it holds one file: `src/App.tsx` as a single row would
    // hide the file's own name behind its folder's.
    while (built.children.length === 1 && built.children[0]?.kind === 'dir') {
      const only = built.children[0] as ActivityDirNode
      built = { ...only, name: `${built.name}/${only.name}` }
    }
    children.push(built)
  }

  for (const file of node.files.values()) {
    file.entries.sort((a, b) => b.at - a.at)
    children.push(file)
  }

  children.sort(byKindThenRecency)

  const at = children.reduce((newest, child) => Math.max(newest, child.at), 0)
  return { kind: 'dir', name: node.name, path: node.path, at, children }
}

function byKindThenRecency(a: ActivityNode, b: ActivityNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  if (b.at !== a.at) return b.at - a.at
  return a.name.localeCompare(b.name)
}

/** Every file in a subtree, in the order the tree shows them. */
export function collectFiles(nodes: ActivityNode[], out: ActivityFileNode[] = []): ActivityFileNode[] {
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node)
    else collectFiles(node.children, out)
  }
  return out
}

/* -------------------------------------------------------------------- agents */

export interface ActivityGroup {
  /** '' is the honest blank — rendered under "Unattributed". */
  paneId: string
  profileId: string
  at: number
  entries: ActivityEntry[]
}

/**
 * The same entries, asked the other question: not "what changed" but "who has
 * been busy". Unattributed always comes last — it is the group you look at when
 * the others have not answered your question, never the one you meet first.
 */
export function groupByAgent(entries: ActivityEntry[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>()
  for (const entry of entries) {
    const existing = groups.get(entry.paneId)
    if (existing) {
      existing.entries.push(entry)
      existing.at = Math.max(existing.at, entry.at)
      if (!existing.profileId) existing.profileId = entry.profileId
      continue
    }
    groups.set(entry.paneId, {
      paneId: entry.paneId,
      profileId: entry.profileId,
      at: entry.at,
      entries: [entry]
    })
  }

  const out = [...groups.values()]
  for (const group of out) group.entries.sort((a, b) => b.at - a.at)
  out.sort((a, b) => {
    if (!a.paneId !== !b.paneId) return a.paneId ? -1 : 1
    return b.at - a.at
  })
  return out
}

/* ---------------------------------------------------------------------- time */

/**
 * A relative time short enough for a right-aligned column beside a filename.
 *
 * shared/tools.ts already has `relativeTime`, and it says "2 minutes ago" —
 * right for a settings line, three times too wide for this. Same idea, terser.
 */
export function activityAge(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

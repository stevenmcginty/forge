import { join, resolve, sep } from 'node:path'

/**
 * Where a spoken "create a project called Tester Tester" is allowed to land.
 *
 * Pulled out of the IPC handler and kept pure so it can be tested properly. It
 * is the only place in Forge where something Steve *said* turns into a path on
 * disk, and the failure modes are not theoretical: a name is a string a speech
 * model produced, so it may contain separators, dots, drive letters, control
 * characters, or the word "Windows". The rules are therefore:
 *
 *   1. The leaf is one sanitised segment. Separators, the characters NTFS
 *      forbids and any control characters become spaces; leading and trailing
 *      dots go; reserved device names (CON, NUL, COM1…) are refused outright,
 *      because Windows fails on those in a confusing way rather than a clear one.
 *   2. The parent is chosen from an allow-list, never taken verbatim.
 *   3. The resolved path is checked to be *strictly inside* one of those roots
 *      after resolution — which is what makes traversal impossible rather than
 *      merely unlikely.
 *
 * Whether the folder already exists is deliberately not decided here: that is a
 * disk question, and this stays pure.
 */

export interface FolderRoot {
  /** How it is named out loud: 'desktop', 'documents', 'projectsroot'. */
  key: string
  path: string
}

export type FolderPlan =
  | { ok: true; path: string; leaf: string; root: FolderRoot }
  | { ok: false; error: string }

/** Windows' reserved device names. A folder called NUL is not a folder. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Characters that may not appear in a Windows path segment. */
const FORBIDDEN = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g')

export function sanitiseFolderName(raw: string): string {
  return (raw ?? '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
}

export function planProjectFolder(input: { name: string; parentDir?: string; roots: FolderRoot[] }): FolderPlan {
  const raw = (input.name ?? '').trim()
  if (!raw) return { ok: false, error: 'No name given' }

  const leaf = sanitiseFolderName(raw)
  if (!leaf) return { ok: false, error: `“${raw}” is not a usable folder name` }
  if (leaf.length > 64) return { ok: false, error: 'That name is too long for a folder' }
  if (RESERVED.test(leaf)) return { ok: false, error: `Windows will not allow a folder called “${leaf}”` }

  const roots = (input.roots ?? []).filter((r) => r.path.trim())
  if (roots.length === 0) return { ok: false, error: 'Nowhere to create it' }

  const asked = (input.parentDir ?? '').trim().toLowerCase()
  const named = asked ? roots.find((r) => r.key === asked) : undefined
  const literal = asked ? roots.find((r) => resolve(r.path).toLowerCase() === resolve(asked).toLowerCase()) : undefined
  const root = named ?? literal ?? roots[0]!

  const target = resolve(join(root.path, leaf))
  const inside = roots.some((r) => {
    const base = resolve(r.path)
    return target !== base && (target + sep).startsWith(base + sep)
  })
  if (!inside) return { ok: false, error: 'That is outside the folders Forge may create projects in' }

  return { ok: true, path: target, leaf, root }
}
